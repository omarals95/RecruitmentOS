import { DrizzleQueryError, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { TeamTx } from "@/db";
import type { Action, RoleBody } from "@/domain/config";
import {
  employeeFacts,
  employeeInput,
  employeeLink,
  employeeListQuery,
  employeePositionsInput,
  positionFacts,
  positionInput,
  positionListQuery,
  positionMove,
  retentionReviewQuery,
  type EMPLOYEE_RETENTION_CLASSES,
} from "@/domain/directory";
import { accessContext, authorize, type AccessContext } from "@/lib/authz";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";
import type { TenantAccess } from "@/lib/tenant-context";

export type Position = {
  id: string;
  orgUnitId: string;
  title: string;
  code: string;
  isManager: boolean;
  /** Only for contexts of the team that owns the job role; null otherwise. */
  jobRoleId: string | null;
  validFrom: string;
  archivedAt: string | null;
};
export type EmployeePosition = {
  positionId: string;
  title: string;
  orgUnitId: string;
  primary: boolean;
  validFrom: string;
};
export type Employee = {
  id: string;
  displayName: string;
  employeeNumber: string;
  status: "active" | "left";
  /** Every response includes it; optional so rows built before R2a-15 still type-check. */
  retentionClass?: (typeof EMPLOYEE_RETENTION_CLASSES)[number];
  source: "app" | "excel";
  userId: string | null;
  /** Left out for a role whose directory rule is basic. */
  workEmail?: string | null;
  workPhone?: string | null;
  positions: EmployeePosition[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};
/** One row of the company owners' retention review: no contact fields, user or positions. */
export type RetentionReviewRow = {
  id: string;
  displayName: string;
  employeeNumber: string;
  /** When the status became left; for rows that left before R2a-15, their last update. */
  leftAt: string;
  retentionClass: (typeof EMPLOYEE_RETENTION_CLASSES)[number];
  archivedAt: string | null;
};
export type HomeUnitChange = {
  occurredAt: string;
  action: string;
  affectedUserIds: string[];
  actorName: string | null;
};
type Page<T> = {
  data: T[];
  pagination: { page: number; pageSize: number; hasMore: boolean };
};

// The org.ts wording, so position writes read like unit writes.
const orgForbidden = () =>
  new ApiError(
    403,
    "org_forbidden",
    "Changing the organisation needs a company owner, or a company admin with the organisation area, signed in.",
  );
const directoryForbidden = () =>
  new ApiError(
    403,
    "directory_forbidden",
    "Your role does not include this directory access.",
  );
export const ownerRequired = () =>
  new ApiError(
    403,
    "directory_owner_required",
    "Only a company owner can link an employee to a user, change a linked employee's positions, or move or archive a position a linked employee holds, because these set who can see which records.",
  );
const retentionReviewForbidden = () =>
  new ApiError(
    403,
    "retention_review_forbidden",
    "Only a company owner can see the retention review.",
  );
const notFound = () =>
  new ApiError(
    404,
    "not_found",
    "Position, employee, unit, level, job role or user not found.",
  );
export const stateConflict = () =>
  new ApiError(
    409,
    "directory_state_conflict",
    "The position, employee or unit is archived or closed, or changed meanwhile. Reload and try again.",
  );

/** The database refusals by constraint (drizzle/0034_positions_employees.sql). */
const refusals: Record<string, () => ApiError> = {
  positions_current_code: () =>
    new ApiError(
      409,
      "position_code_exists",
      "Another current position already uses this code. Choose a different code.",
    ),
  employees_number_unique: () =>
    new ApiError(
      409,
      "employee_number_exists",
      "Another employee already has this employee number.",
    ),
  employees_user_link: () =>
    new ApiError(
      409,
      "employee_user_linked",
      "This user is already linked to another employee.",
    ),
  employee_positions_current: stateConflict,
  employee_positions_primary: stateConflict,
  positions_unit_fkey: notFound,
  positions_job_role_fkey: notFound,
  employees_user_fkey: notFound,
  employee_positions_employee_fkey: notFound,
  employee_positions_position_fkey: notFound,
};

/**
 * One withTeam transaction; the database stays authoritative and its refusals map to API errors.
 * A 42501 is the refusal the operation's own guard gives.
 */
export async function inDirectory<T>(
  p: Principal,
  refused: () => ApiError,
  work: (tx: TeamTx, access: TenantAccess) => Promise<T>,
): Promise<T> {
  try {
    return await withTeam(p, work);
  } catch (error) {
    const cause = (error instanceof DrizzleQueryError ? error.cause : error) as
      { code?: unknown; constraint?: unknown } | undefined;
    if (cause?.code === "42501") throw refused();
    const refusal =
      cause?.code === "23505" || cause?.code === "23503"
        ? refusals[String(cause.constraint)]
        : undefined;
    if (refusal) throw refusal();
    throw error;
  }
}

/** A session with company owner authority or the organisation area (allows_workspace write). */
function requireOrgWrite(p: Principal, access: TenantAccess) {
  try {
    authorize(accessContext(p, access), {
      adminArea: "organisation",
      action: "edit",
    });
  } catch (error) {
    if (error instanceof ApiError) throw orgForbidden();
    throw error;
  }
}

/** directory:read to view, a session with directory:write to change (allows_directory). */
export function requireDirectory(
  p: Principal,
  access: TenantAccess,
  action: Extract<Action, "view" | "create" | "edit" | "archive">,
): AccessContext {
  const ctx = accessContext(p, access);
  try {
    authorize(ctx, { resource: "directory", action });
  } catch (error) {
    if (error instanceof ApiError) throw directoryForbidden();
    throw error;
  }
  return ctx;
}

/** The facts that set home units need a company owner signed in, as app.guard_scope_sources does. */
function requireOwner(p: Principal, access: TenantAccess) {
  if (p.authType !== "session" || access.companyLevel !== "owner")
    throw ownerRequired();
}

/**
 * The service-layer contact rule (D16): without directoryRule full, an employee carries no work
 * email or phone key. Row access stays with the database.
 */
export function directoryView(
  role: Pick<RoleBody, "directoryRule"> | null,
  row: Employee,
): Employee {
  if (role?.directoryRule === "full") return row;
  const { workEmail: _email, workPhone: _phone, ...basic } = row;
  return basic;
}

const positionJson = (p: Principal) =>
  sql`jsonb_build_object('id', p.id, 'orgUnitId', p.org_unit_id, 'title', p.title, 'code', p.code, 'isManager', p.is_manager, 'jobRoleId', case when p.job_role_team_id = ${p.teamId} then p.job_role_id end, 'validFrom', p.valid_from, 'archivedAt', p.archived_at)`;
// The employee's current position rows, primary first, then by title and id.
const employeeJson =
  sql.raw(`jsonb_build_object('id', e.id, 'displayName', e.display_name, 'employeeNumber', e.employee_number,
  'status', e.status, 'retentionClass', e.retention_class, 'source', e.source, 'userId', e.user_id,
  'workEmail', e.work_email, 'workPhone', e.work_phone,
  'positions', coalesce((select jsonb_agg(jsonb_build_object('positionId', ep.position_id, 'title', h.title,
    'orgUnitId', h.org_unit_id, 'primary', ep."primary", 'validFrom', ep.valid_from) order by ep."primary" desc, h.title, h.id)
    from app.employee_positions ep join app.positions h on h.id = ep.position_id and h.workspace_id = ep.workspace_id
    where ep.employee_id = e.id and ep.workspace_id = e.workspace_id and ep.valid_to is null), '[]'::jsonb),
  'createdAt', e.created_at, 'updatedAt', e.updated_at, 'archivedAt', e.archived_at)`);

/** The changed row, or 409 for an archived or closed row the update skipped, or 404. */
async function changed<T>(
  tx: TeamTx,
  table: "positions" | "employees",
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

/** 404 unless the job role is a non-archived job-role record of the caller's team, read under team RLS. */
async function requireJobRole(tx: TeamTx, p: Principal, jobRoleId: string) {
  const { rows } = await tx.execute(
    sql`select 1 from app.records r where r.team_id = ${p.teamId} and r.id = ${jobRoleId}::uuid and r.kind = 'job-role' and r.archived_at is null`,
  );
  if (!rows[0]) throw notFound();
}

/** 404 for a unit outside the workspace, 409 for an archived or closed one. */
async function unitConflict(tx: TeamTx, access: TenantAccess, unitId: string) {
  const { rows } = await tx.execute<{ current: boolean }>(
    sql`select u.valid_to is null and u.archived_at is null as current from app.org_units u where u.id = ${unitId}::uuid and u.workspace_id = ${access.workspaceId}::uuid`,
  );
  return rows[0] ? stateConflict() : notFound();
}

/**
 * The current, non-archived positions of the workspace, or of one unit, by title then id, in one
 * statement. Any session of the workspace reads, like units. 404 for a unit outside the workspace.
 */
export async function listPositions(
  p: Principal,
  options: z.input<typeof positionListQuery> = {},
): Promise<Page<Position>> {
  const { unitId, page, pageSize } = positionListQuery.parse(options);
  return inDirectory(p, orgForbidden, async (tx, access) => {
    const found = unitId
      ? sql`exists (select 1 from app.org_units u where u.id = ${unitId}::uuid and u.workspace_id = ${access.workspaceId}::uuid)`
      : sql`true`;
    const unit = unitId ? sql`and p.org_unit_id = ${unitId}::uuid` : sql``;
    const { rows } = await tx.execute<{
      found: boolean;
      positions: Position[];
    }>(
      sql`select ${found} as found, coalesce((select jsonb_agg(page.position order by page.title, page.id) from (select ${positionJson(p)} as position, p.title, p.id from app.positions p where p.workspace_id = ${access.workspaceId}::uuid ${unit} and p.valid_to is null and p.archived_at is null order by p.title, p.id limit ${pageSize + 1} offset ${(page - 1) * pageSize}) page), '[]'::jsonb) as positions`,
    );
    if (!rows[0].found) throw notFound();
    return {
      data: rows[0].positions.slice(0, pageSize),
      pagination: {
        page,
        pageSize,
        hasMore: rows[0].positions.length > pageSize,
      },
    };
  });
}

/** Creates a position in a current unit; a job role must be one of the caller's team. */
export async function createPosition(
  p: Principal,
  input: z.input<typeof positionInput>,
): Promise<Position> {
  const { title, code, orgUnitId, isManager, jobRoleId } =
    positionInput.parse(input);
  // Past the write check, a 42501 is app.guard_scope_sources: a held position's code to a new unit.
  return inDirectory(p, ownerRequired, async (tx, access) => {
    requireOrgWrite(p, access);
    if (jobRoleId) await requireJobRole(tx, p, jobRoleId);
    const { rows } = await tx.execute<{ position: Position }>(
      sql`insert into app.positions as p (workspace_id, org_unit_id, title, code, is_manager, job_role_team_id, job_role_id) select u.workspace_id, u.id, ${title}, ${code}, ${isManager ?? false}, ${jobRoleId ? p.teamId : null}, ${jobRoleId ?? null}::uuid from app.org_units u where u.id = ${orgUnitId}::uuid and u.workspace_id = ${access.workspaceId}::uuid and u.valid_to is null and u.archived_at is null returning ${positionJson(p)} as position`,
    );
    if (!rows[0]) throw await unitConflict(tx, access, orgUnitId);
    return rows[0].position;
  });
}

const updatePositionRow = (
  p: Principal,
  positionId: string,
  refused: () => ApiError,
  change: (tx: TeamTx, access: TenantAccess) => Promise<SQL>,
) => {
  const id = z.uuid().parse(positionId);
  return inDirectory(p, refused, async (tx, access) => {
    requireOrgWrite(p, access);
    const set = await change(tx, access);
    const { rows } = await tx.execute<{ position: Position }>(
      sql`update app.positions p set ${set} where p.id = ${id}::uuid and p.workspace_id = ${access.workspaceId}::uuid and p.valid_to is null and p.archived_at is null returning ${positionJson(p)} as position`,
    );
    return (await changed(tx, "positions", id, access, rows)).position;
  });
};

/** Changes the title, manager flag or job role of the current row in place; null clears the job role. */
export async function updatePosition(
  p: Principal,
  positionId: string,
  input: z.input<typeof positionFacts>,
): Promise<Position> {
  const { title, isManager, jobRoleId } = positionFacts.parse(input);
  return updatePositionRow(p, positionId, orgForbidden, async (tx) => {
    if (jobRoleId) await requireJobRole(tx, p, jobRoleId);
    return sql.join(
      [
        ...(title !== undefined ? [sql`title = ${title}`] : []),
        ...(isManager !== undefined ? [sql`is_manager = ${isManager}`] : []),
        ...(jobRoleId !== undefined
          ? [
              sql`job_role_team_id = ${jobRoleId ? p.teamId : null}, job_role_id = ${jobRoleId}::uuid`,
            ]
          : []),
      ],
      sql`, `,
    );
  });
}

/**
 * Moves the position to another current unit. A position a linked employee holds moves their home
 * unit, so it needs a company owner (403 directory_owner_required, from app.guard_scope_sources).
 */
export async function movePosition(
  p: Principal,
  positionId: string,
  input: z.input<typeof positionMove>,
): Promise<Position> {
  const { orgUnitId } = positionMove.parse(input);
  return updatePositionRow(p, positionId, ownerRequired, async (tx, access) => {
    const { rows } = await tx.execute(
      sql`select 1 from app.org_units u where u.id = ${orgUnitId}::uuid and u.workspace_id = ${access.workspaceId}::uuid and u.valid_to is null and u.archived_at is null`,
    );
    if (!rows[0]) throw await unitConflict(tx, access, orgUnitId);
    return sql`org_unit_id = ${orgUnitId}::uuid`;
  });
}

/** Archives the position for good; one a linked employee holds needs a company owner. */
export async function archivePosition(
  p: Principal,
  positionId: string,
): Promise<Position> {
  return updatePositionRow(
    p,
    positionId,
    ownerRequired,
    async () => sql`archived_at = now()`,
  );
}

/**
 * One directory page: current, non-archived employees by display name then id, in one statement.
 * unitId matches a current position in the unit or any unit below it, levelId the level of a
 * current position's unit, positionId a holder of the position; 404 for an id outside the workspace.
 * search matches part of the display name or employee number, ignoring case; includeArchived adds
 * archived employees.
 */
export async function listEmployees(
  p: Principal,
  options: z.input<typeof employeeListQuery> = {},
): Promise<Page<Employee>> {
  const {
    unitId,
    levelId,
    positionId,
    status,
    search,
    includeArchived,
    page,
    pageSize,
  } = employeeListQuery.parse(options);
  return inDirectory(p, directoryForbidden, async (tx, access) => {
    const ctx = requireDirectory(p, access, "view");
    const workspace = sql`${access.workspaceId}::uuid`;
    const found = sql.join(
      [
        sql`true`,
        ...(unitId
          ? [
              sql`exists (select 1 from app.org_units u where u.id = ${unitId}::uuid and u.workspace_id = ${workspace})`,
            ]
          : []),
        ...(levelId
          ? [
              sql`exists (select 1 from app.org_levels l where l.id = ${levelId}::uuid and l.workspace_id = ${workspace})`,
            ]
          : []),
        ...(positionId
          ? [
              sql`exists (select 1 from app.positions h where h.id = ${positionId}::uuid and h.workspace_id = ${workspace})`,
            ]
          : []),
      ],
      sql` and `,
    );
    const holding =
      unitId || levelId || positionId
        ? sql`and exists (select 1 from app.employee_positions ep join app.positions h on h.id = ep.position_id and h.workspace_id = ep.workspace_id join app.org_units u on u.id = h.org_unit_id and u.workspace_id = h.workspace_id where ep.employee_id = e.id and ep.workspace_id = e.workspace_id and ep.valid_to is null and h.valid_to is null and h.archived_at is null ${unitId ? sql`and h.org_unit_id in (select c.descendant_id from app.org_unit_closure c where c.workspace_id = ${workspace} and c.ancestor_id = ${unitId}::uuid)` : sql``} ${levelId ? sql`and u.level_id = ${levelId}::uuid` : sql``} ${positionId ? sql`and ep.position_id = ${positionId}::uuid` : sql``})`
        : sql``;
    // strpos, never a LIKE pattern built from the input.
    const matching = search
      ? sql`and (strpos(lower(e.display_name), lower(${search})) > 0 or strpos(lower(e.employee_number), lower(${search})) > 0)`
      : sql``;
    const { rows } = await tx.execute<{
      found: boolean;
      employees: Employee[];
    }>(
      sql`select ${found} as found, coalesce((select jsonb_agg(page.employee order by page.display_name, page.id) from (select ${employeeJson} as employee, e.display_name, e.id from app.employees e where e.workspace_id = ${workspace} ${includeArchived ? sql`` : sql`and e.archived_at is null`} ${status ? sql`and e.status = ${status}` : sql``} ${matching} ${holding} order by e.display_name, e.id limit ${pageSize + 1} offset ${(page - 1) * pageSize}) page), '[]'::jsonb) as employees`,
    );
    if (!rows[0].found) throw notFound();
    return {
      data: rows[0].employees
        .slice(0, pageSize)
        .map((row) => directoryView(ctx.role, row)),
      pagination: {
        page,
        pageSize,
        hasMore: rows[0].employees.length > pageSize,
      },
    };
  });
}

/** Creates an employee; one already linked to a user needs a company owner. A left one leaves now. */
export async function createEmployee(
  p: Principal,
  input: z.input<typeof employeeInput>,
): Promise<Employee> {
  const body = employeeInput.parse(input);
  return inDirectory(
    p,
    body.userId === undefined ? directoryForbidden : ownerRequired,
    async (tx, access) => {
      const ctx = requireDirectory(p, access, "create");
      if (body.userId !== undefined) requireOwner(p, access);
      const { rows } = await tx.execute<{ employee: Employee }>(
        sql`insert into app.employees as e (workspace_id, display_name, employee_number, work_email, work_phone, status, retention_class, left_at, user_id) values (${access.workspaceId}::uuid, ${body.displayName}, ${body.employeeNumber}, ${body.workEmail ?? null}, ${body.workPhone ?? null}, ${body.status ?? "active"}, ${body.retentionClass ?? "standard"}, ${body.status === "left" ? sql`now()` : null}, ${body.userId ?? null}) returning ${employeeJson} as employee`,
      );
      return directoryView(ctx.role, rows[0].employee);
    },
  );
}

/**
 * When the employee left: set on becoming left, kept while left, cleared on becoming active. A left
 * row without it (written before R2a-15) first takes its previous updated_at, so an edit never moves
 * its review date.
 */
export const leftAt = (status?: "active" | "left") =>
  status === "active"
    ? sql`left_at = null`
    : sql`left_at = case when e.status = 'left' then coalesce(e.left_at, e.updated_at) else ${status === "left" ? sql`now()` : sql`e.left_at`} end`;

const updateEmployeeRow = (
  p: Principal,
  employeeId: string,
  action: "edit" | "archive",
  ownerOnly: boolean,
  set: SQL,
  status?: "active" | "left",
) => {
  const id = z.uuid().parse(employeeId);
  return inDirectory(
    p,
    ownerOnly ? ownerRequired : directoryForbidden,
    async (tx, access) => {
      const ctx = requireDirectory(p, access, action);
      if (ownerOnly) requireOwner(p, access);
      const { rows } = await tx.execute<{ employee: Employee }>(
        sql`update app.employees e set ${set}, ${leftAt(status)} where e.id = ${id}::uuid and e.workspace_id = ${access.workspaceId}::uuid and e.archived_at is null returning ${employeeJson} as employee`,
      );
      const { employee } = await changed(tx, "employees", id, access, rows);
      return directoryView(ctx.role, employee);
    },
  );
};

/** Changes an employee's work facts; the user link and positions have their own operations. */
export async function updateEmployee(
  p: Principal,
  employeeId: string,
  input: z.input<typeof employeeFacts>,
): Promise<Employee> {
  const body = employeeFacts.parse(input);
  const columns = {
    displayName: "display_name",
    employeeNumber: "employee_number",
    workEmail: "work_email",
    workPhone: "work_phone",
    status: "status",
    retentionClass: "retention_class",
  } as const;
  return updateEmployeeRow(
    p,
    employeeId,
    "edit",
    false,
    sql.join(
      (Object.keys(columns) as (keyof typeof columns)[])
        .filter((key) => body[key] !== undefined)
        .map((key) => sql`${sql.raw(columns[key])} = ${body[key]}`),
      sql`, `,
    ),
    body.status,
  );
}

/** Company owners only: links the employee to a user, or unlinks it with null. */
export async function linkEmployeeUser(
  p: Principal,
  employeeId: string,
  input: z.input<typeof employeeLink>,
): Promise<Employee> {
  const { userId } = employeeLink.parse(input);
  return updateEmployeeRow(
    p,
    employeeId,
    "edit",
    true,
    sql`user_id = ${userId}`,
  );
}

/** Archives the employee for good; the user link and position rows stay as they are. */
export async function archiveEmployee(
  p: Principal,
  employeeId: string,
): Promise<Employee> {
  return updateEmployeeRow(
    p,
    employeeId,
    "archive",
    false,
    sql`archived_at = now()`,
  );
}

/**
 * Replaces the employee's current positions with the given set in one transaction: removed rows
 * end, primary flags change in place and added positions start now. Each requested position must be
 * current (409 otherwise). A linked employee's positions set their home units, so they need a
 * company owner.
 */
export async function setEmployeePositions(
  p: Principal,
  employeeId: string,
  input: z.input<typeof employeePositionsInput>,
): Promise<Employee> {
  const id = z.uuid().parse(employeeId);
  const { positions } = employeePositionsInput.parse(input);
  const requested = positions.map((entry) => entry.positionId);
  return inDirectory(p, ownerRequired, async (tx, access) => {
    const ctx = requireDirectory(p, access, "edit");
    const workspace = sql`${access.workspaceId}::uuid`;
    const { rows } = await tx.execute<{
      employee: { linked: boolean; archived: boolean } | null;
      found: { id: string; current: boolean }[];
      held: { positionId: string; primary: boolean }[];
    }>(
      sql`select (select jsonb_build_object('linked', e.user_id is not null, 'archived', e.archived_at is not null) from app.employees e where e.id = ${id}::uuid and e.workspace_id = ${workspace}) as employee,
        coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'current', h.valid_to is null and h.archived_at is null)) from app.positions h where h.workspace_id = ${workspace} and h.id = any(${`{${requested.join(",")}}`}::uuid[])), '[]'::jsonb) as found,
        coalesce((select jsonb_agg(jsonb_build_object('positionId', ep.position_id, 'primary', ep."primary")) from app.employee_positions ep where ep.employee_id = ${id}::uuid and ep.workspace_id = ${workspace} and ep.valid_to is null), '[]'::jsonb) as held`,
    );
    const { employee, found, held } = rows[0];
    if (!employee || found.length < requested.length) throw notFound();
    if (employee.archived || found.some((row) => !row.current))
      throw stateConflict();
    if (employee.linked) requireOwner(p, access);
    const wanted = new Map(
      positions.map((entry) => [entry.positionId, entry.primary]),
    );
    const removed = held.filter((row) => !wanted.has(row.positionId));
    const kept = held.filter((row) => wanted.has(row.positionId));
    const unset = kept.filter(
      (row) => row.primary && !wanted.get(row.positionId),
    );
    const promoted = kept.filter(
      (row) => !row.primary && wanted.get(row.positionId),
    );
    const added = positions.filter(
      (entry) => !held.some((row) => row.positionId === entry.positionId),
    );
    const rowsOf = (list: { positionId: string }[]) =>
      sql`ep.employee_id = ${id}::uuid and ep.workspace_id = ${workspace} and ep.valid_to is null and ep.position_id = any(${`{${list.map((row) => row.positionId).join(",")}}`}::uuid[])`;
    // Ends and demotions run before promotions and inserts, so the one-primary index holds per row.
    if (removed.length)
      await tx.execute(
        sql`update app.employee_positions ep set valid_to = now() where ${rowsOf(removed)}`,
      );
    if (unset.length)
      await tx.execute(
        sql`update app.employee_positions ep set "primary" = false where ${rowsOf(unset)}`,
      );
    if (promoted.length)
      await tx.execute(
        sql`update app.employee_positions ep set "primary" = true where ${rowsOf(promoted)}`,
      );
    if (added.length)
      await tx.execute(
        sql`insert into app.employee_positions (employee_id, position_id, workspace_id, "primary") values ${sql.join(
          added.map(
            (entry) =>
              sql`(${id}::uuid, ${entry.positionId}::uuid, ${workspace}, ${entry.primary})`,
          ),
          sql`, `,
        )}`,
      );
    const { rows: result } = await tx.execute<{ employee: Employee }>(
      sql`select ${employeeJson} as employee from app.employees e where e.id = ${id}::uuid and e.workspace_id = ${workspace}`,
    );
    return directoryView(ctx.role, result[0].employee);
  });
}

const homeUnitInput = z
  .object({
    before: z.date().optional(),
    pageSize: z.number().int().min(1).max(100).default(50),
  })
  .strict();

/**
 * Company owners only: the home-unit changes of every team in the workspace, newest first, for the
 * owners' home screen (R2a-10 and R2a-11 add the screen). Action, time, user ids and actor name only.
 */
export async function listHomeUnitChanges(
  p: Principal,
  options: z.input<typeof homeUnitInput> = {},
): Promise<HomeUnitChange[]> {
  const { before, pageSize } = homeUnitInput.parse(options);
  return inDirectory(p, ownerRequired, async (tx, access) => {
    requireOwner(p, access);
    const { rows } = await tx.execute<HomeUnitChange>(
      sql`select occurred_at as "occurredAt", action, affected_user_ids as "affectedUserIds", actor_name as "actorName" from tenant_context.home_unit_changes(${before?.toISOString() ?? null}::timestamptz, ${pageSize}::integer)`,
    );
    return rows;
  });
}

/**
 * Company owners only, signed in (D11): the employees whose status has been left for 12 months or
 * more, archived ones included, oldest first, for the owner's review. Read only; nothing is erased
 * automatically. A row that left before R2a-15 has no left_at and reads as its last update.
 */
export async function listRetentionReview(
  p: Principal,
  options: z.input<typeof retentionReviewQuery> = {},
): Promise<Page<RetentionReviewRow>> {
  const { page, pageSize } = retentionReviewQuery.parse(options);
  return inDirectory(p, directoryForbidden, async (tx, access) => {
    if (p.authType !== "session" || access.companyLevel !== "owner")
      throw retentionReviewForbidden();
    requireDirectory(p, access, "view");
    const { rows } = await tx.execute<{ employees: RetentionReviewRow[] }>(
      sql`select coalesce((select jsonb_agg(jsonb_build_object('id', page.id, 'displayName', page.display_name, 'employeeNumber', page.employee_number, 'leftAt', page.left_on, 'retentionClass', page.retention_class, 'archivedAt', page.archived_at) order by page.left_on, page.id) from (select e.id, e.display_name, e.employee_number, coalesce(e.left_at, e.updated_at) as left_on, e.retention_class, e.archived_at from app.employees e where e.workspace_id = ${access.workspaceId}::uuid and e.status = 'left' and coalesce(e.left_at, e.updated_at) <= now() - interval '12 months' order by left_on, e.id limit ${pageSize + 1} offset ${(page - 1) * pageSize}) page), '[]'::jsonb) as employees`,
    );
    return {
      data: rows[0].employees.slice(0, pageSize),
      pagination: {
        page,
        pageSize,
        hasMore: rows[0].employees.length > pageSize,
      },
    };
  });
}
