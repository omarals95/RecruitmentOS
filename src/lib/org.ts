import { DrizzleQueryError, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { TeamTx } from "@/db";
import {
  orgLevelInput,
  orgMove,
  orgRename,
  orgUnitInput,
  orgUnitListQuery,
} from "@/domain/org";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";
import type { TenantAccess } from "@/lib/tenant-context";

export type OrgLevel = {
  id: string;
  name: string;
  depth: number;
  archivedAt: string | null;
};
export type OrgUnit = {
  id: string;
  parentId: string | null;
  levelId: string;
  name: string;
  code: string;
  validFrom: string;
  archivedAt: string | null;
  hasChildren: boolean;
};

const forbidden = () =>
  new ApiError(
    403,
    "org_forbidden",
    "Changing the organisation needs a company owner, or a company admin with the organisation area, signed in.",
  );
const ownerRequired = () =>
  new ApiError(
    403,
    "org_owner_required",
    "Only a company owner can move or archive a unit, because it changes who can see the records under it.",
  );
const notFound = () =>
  new ApiError(404, "not_found", "Organisation level or unit not found.");
const stateConflict = () =>
  new ApiError(
    409,
    "org_state_conflict",
    "The level or unit is archived, or still has current units below it. Reload the organisation and try again.",
  );

/** The database refusals by SQLSTATE and constraint (drizzle/0033_org_levels_units.sql). */
const refusals: Record<string, () => ApiError> = {
  RQ008: () =>
    new ApiError(
      409,
      "org_level_order",
      "A unit's level must be below its parent's level. Choose a parent on a higher level.",
    ),
  RQ009: () =>
    new ApiError(
      409,
      "org_cycle",
      "A unit cannot be moved under itself or under a unit below it.",
    ),
  RQ010: stateConflict,
  org_units_current_code: () =>
    new ApiError(
      409,
      "org_code_exists",
      "Another current unit already uses this code. Choose a different code.",
    ),
  org_levels_depth_unique: () =>
    new ApiError(
      409,
      "org_level_exists",
      "A level already exists at this depth. Rename that level or choose another depth.",
    ),
  org_units_level_fkey: notFound,
  org_units_parent_fkey: notFound,
};

/**
 * tenant_context.allows_workspace for write on the organisation area, read from the access state
 * install returned: a session with company owner authority or the organisation area. Moves and
 * archives of units also need a company owner, as app.guard_scope_sources does.
 */
function requireWrite(p: Principal, access: TenantAccess, ownerOnly = false) {
  if (
    p.authType !== "session" ||
    (access.companyLevel !== "owner" &&
      !access.companyAreas.includes("organisation"))
  )
    throw forbidden();
  if (ownerOnly && access.companyLevel !== "owner") throw ownerRequired();
}

/** One withTeam transaction; the database stays authoritative and its refusals map to API errors. */
async function inOrg<T>(
  p: Principal,
  work: (tx: TeamTx, access: TenantAccess) => Promise<T>,
): Promise<T> {
  try {
    return await withTeam(p, work);
  } catch (error) {
    const cause = (error instanceof DrizzleQueryError ? error.cause : error) as
      { code?: unknown; constraint?: unknown } | undefined;
    if (cause?.code === "42501") throw forbidden();
    const refusal =
      cause?.code === "23505" || cause?.code === "23503"
        ? refusals[String(cause.constraint)]
        : refusals[String(cause?.code)];
    if (refusal) throw refusal();
    throw error;
  }
}

const levelJson = sql.raw(
  `jsonb_build_object('id', l.id, 'name', l.name, 'depth', l.depth, 'archivedAt', l.archived_at)`,
);
const unitJson =
  sql.raw(`jsonb_build_object('id', u.id, 'parentId', u.parent_id, 'levelId', u.level_id, 'name', u.name,
  'code', u.code, 'validFrom', u.valid_from, 'archivedAt', u.archived_at, 'hasChildren', exists (select 1 from app.org_units c
  where c.workspace_id = u.workspace_id and c.parent_id = u.id and c.valid_to is null and c.archived_at is null))`);

/** The changed row, or 409 for an archived or closed row the update skipped, or 404. */
async function changed<T>(
  tx: TeamTx,
  table: "org_levels" | "org_units",
  id: string,
  access: TenantAccess,
  rows: T[],
): Promise<T> {
  if (rows[0]) return rows[0];
  const { rows: found } = await tx.execute(
    sql`select 1 from app.${sql.raw(table)} where id = ${id}::uuid and workspace_id = ${access.workspaceId}::uuid`,
  );
  throw found[0] ? stateConflict() : notFound();
}

/** Every level of the context's workspace, top first, archived ones included. */
export async function listOrgLevels(p: Principal): Promise<OrgLevel[]> {
  return inOrg(p, async (tx, access) => {
    const { rows } = await tx.execute<{ level: OrgLevel }>(
      sql`select ${levelJson} as level from app.org_levels l where l.workspace_id = ${access.workspaceId}::uuid order by l.depth`,
    );
    return rows.map((row) => row.level);
  });
}

export async function createOrgLevel(
  p: Principal,
  input: { name: string; depth: number },
): Promise<OrgLevel> {
  const { name, depth } = orgLevelInput.parse(input);
  return inOrg(p, async (tx, access) => {
    requireWrite(p, access);
    const { rows } = await tx.execute<{ level: OrgLevel }>(
      sql`insert into app.org_levels as l (workspace_id, name, depth) values (${access.workspaceId}::uuid, ${name}, ${depth}) returning ${levelJson} as level`,
    );
    return rows[0].level;
  });
}

export async function renameOrgLevel(
  p: Principal,
  levelId: string,
  input: { name: string },
): Promise<OrgLevel> {
  const id = z.uuid().parse(levelId);
  const { name } = orgRename.parse(input);
  return inOrg(p, async (tx, access) => {
    requireWrite(p, access);
    const { rows } = await tx.execute<{ level: OrgLevel }>(
      sql`update app.org_levels l set name = ${name} where l.id = ${id}::uuid and l.workspace_id = ${access.workspaceId}::uuid and l.archived_at is null returning ${levelJson} as level`,
    );
    return (await changed(tx, "org_levels", id, access, rows)).level;
  });
}

/** Archives a level for good; refused while any current unit is on it. */
export async function archiveOrgLevel(
  p: Principal,
  levelId: string,
): Promise<OrgLevel> {
  const id = z.uuid().parse(levelId);
  return inOrg(p, async (tx, access) => {
    requireWrite(p, access);
    const { rows } = await tx.execute<{ level: OrgLevel }>(
      sql`update app.org_levels l set archived_at = now() where l.id = ${id}::uuid and l.workspace_id = ${access.workspaceId}::uuid and l.archived_at is null returning ${levelJson} as level`,
    );
    return (await changed(tx, "org_levels", id, access, rows)).level;
  });
}

/**
 * One chart level: the current, non-archived children of parentId, or the top-level units, by
 * name then id, in one statement. 404 when parentId is not a unit of the context's workspace.
 */
export async function listOrgUnits(
  p: Principal,
  options: z.input<typeof orgUnitListQuery> = {},
): Promise<{
  data: OrgUnit[];
  pagination: { page: number; pageSize: number; hasMore: boolean };
}> {
  const { parentId, page, pageSize } = orgUnitListQuery.parse(options);
  return inOrg(p, async (tx, access) => {
    const found = parentId
      ? sql`exists (select 1 from app.org_units p where p.id = ${parentId}::uuid and p.workspace_id = ${access.workspaceId}::uuid)`
      : sql`true`;
    const parent = parentId
      ? sql`u.parent_id = ${parentId}::uuid`
      : sql`u.parent_id is null`;
    const { rows } = await tx.execute<{ found: boolean; units: OrgUnit[] }>(
      sql`select ${found} as found, coalesce((select jsonb_agg(page.unit order by page.name, page.id) from (select ${unitJson} as unit, u.name, u.id from app.org_units u where u.workspace_id = ${access.workspaceId}::uuid and ${parent} and u.valid_to is null and u.archived_at is null order by u.name, u.id limit ${pageSize + 1} offset ${(page - 1) * pageSize}) page), '[]'::jsonb) as units`,
    );
    if (!rows[0].found) throw notFound();
    return {
      data: rows[0].units.slice(0, pageSize),
      pagination: {
        page,
        pageSize,
        hasMore: rows[0].units.length > pageSize,
      },
    };
  });
}

/** Creates a unit at the top level or under a current parent on a higher level. */
export async function createOrgUnit(
  p: Principal,
  input: {
    name: string;
    code: string;
    levelId: string;
    parentId?: string | null;
  },
): Promise<OrgUnit> {
  const { name, code, levelId, parentId } = orgUnitInput.parse(input);
  return inOrg(p, async (tx, access) => {
    requireWrite(p, access);
    const { rows } = await tx.execute<{ unit: OrgUnit }>(
      sql`insert into app.org_units as u (workspace_id, parent_id, level_id, name, code) values (${access.workspaceId}::uuid, ${parentId ?? null}::uuid, ${levelId}::uuid, ${name}, ${code}) returning ${unitJson} as unit`,
    );
    return rows[0].unit;
  });
}

const updateUnit = (
  p: Principal,
  unitId: string,
  ownerOnly: boolean,
  change: SQL,
) => {
  const id = z.uuid().parse(unitId);
  return inOrg(p, async (tx, access) => {
    requireWrite(p, access, ownerOnly);
    const { rows } = await tx.execute<{ unit: OrgUnit }>(
      sql`update app.org_units u set ${change} where u.id = ${id}::uuid and u.workspace_id = ${access.workspaceId}::uuid and u.valid_to is null and u.archived_at is null returning ${unitJson} as unit`,
    );
    return (await changed(tx, "org_units", id, access, rows)).unit;
  });
};

/** Renames the current row in place; the id, code, level and closure stay as they are. */
export async function renameOrgUnit(
  p: Principal,
  unitId: string,
  input: { name: string },
): Promise<OrgUnit> {
  const { name } = orgRename.parse(input);
  return updateUnit(p, unitId, false, sql`name = ${name}`);
}

/** Company owners only: moves the unit and everything below it; null is the top level. */
export async function moveOrgUnit(
  p: Principal,
  unitId: string,
  input: { parentId: string | null },
): Promise<OrgUnit> {
  const { parentId } = orgMove.parse(input);
  return updateUnit(p, unitId, true, sql`parent_id = ${parentId}::uuid`);
}

/** Company owners only: archives a unit with no current units below it, for good. */
export async function archiveOrgUnit(
  p: Principal,
  unitId: string,
): Promise<OrgUnit> {
  return updateUnit(p, unitId, true, sql`archived_at = now()`);
}
