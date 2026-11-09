import { DrizzleQueryError, sql } from "drizzle-orm";
import { z } from "zod";
import type { TeamTx } from "@/db";
import {
  CONFIG_TYPES,
  CONFIG_TYPE_AREAS,
  configBodySchemas,
  configHelpText,
  configKey,
  kindSchemaBodySchema,
  type ConfigType,
  type ConfigurableKind,
  type KindSchemaBody,
} from "@/domain/config";
import { DEFAULT_KIND_SCHEMAS } from "@/domain/config-defaults";
import type { ConfigDocument } from "@/lib/config-cache";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";
import type { TenantAccess } from "@/lib/tenant-context";

// The instance body cache lives in its own module, so tenant-context.ts imports it without a cycle.
export {
  CONFIG_CACHE_BYTES,
  ConfigBodyCache,
  configBodyCache,
  type ConfigDocument,
  type ConfigDocumentRow,
} from "@/lib/config-cache";

/** The bound the database enforces on bodies (54000) and layouts, in bytes of JSON text. */
const MAX_BYTES = 524_288;

export type ConfigVersion = {
  id: string;
  number: number | null;
  state: "draft" | "published" | "retired";
  body: Record<string, unknown>;
  bodySha256: string;
  note: string | null;
  createdAt: string;
  publishedAt: string | null;
};
export type ConfigObject = {
  id: string;
  type: ConfigType;
  key: string;
  createdAt: string;
  archivedAt: string | null;
  current: ConfigVersion | null;
  draft: ConfigVersion | null;
};
export type ConfigHistoryRow = {
  occurredAt: string;
  action: string;
  objectType: string;
  objectKey: string;
  versionNumber: number | null;
  fromVersionNumber: number | null;
  actorName: string | null;
};

const forbidden = () =>
  new ApiError(
    403,
    "config_forbidden",
    "You do not have company authority to change this configuration.",
  );
const notFound = () =>
  new ApiError(404, "not_found", "Configuration not found.");
const stateConflict = () =>
  new ApiError(
    409,
    "config_state_conflict",
    "This configuration is not in a state that allows this change. Reload it and try again.",
  );

const draftInput = z
  .object({
    type: z.enum(CONFIG_TYPES),
    key: configKey,
    body: z.unknown(),
    note: configHelpText.optional(),
  })
  .strict();
const editInput = z
  .object({ body: z.unknown(), note: configHelpText.optional() })
  .strict();
const layoutInput = z.record(z.string(), z.json());
const historyInput = z
  .object({
    objectId: z.uuid().optional(),
    before: z.date().optional(),
    pageSize: z.number().int().min(1).max(100).default(50),
  })
  .strict();

const tooLarge = () =>
  new ApiError(
    413,
    "config_too_large",
    "This configuration is larger than 512 KiB.",
  );

/** Larger input is refused before it is parsed; the database refuses it again. */
function assertSize(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value ?? null), "utf8") > MAX_BYTES)
    throw tooLarge();
}

/**
 * tenant_context.allows_workspace for write, read from the access state install returned: a session,
 * and company authority for the type's area, or for a task board the team owner or admin role.
 */
function requireWrite(p: Principal, access: TenantAccess, type: ConfigType) {
  const area = CONFIG_TYPE_AREAS[type];
  const allowed =
    p.authType === "session" &&
    (area === "task-board"
      ? access.memberRole === "owner" || access.memberRole === "admin"
      : access.companyLevel === "owner" ||
        (area !== "roles" && access.companyAreas.includes(area)));
  if (!allowed) throw forbidden();
}

/** One withTeam transaction; the database stays authoritative and its refusals map to API errors. */
async function inStore<T>(
  p: Principal,
  work: (tx: TeamTx, access: TenantAccess) => Promise<T>,
): Promise<T> {
  try {
    return await withTeam(p, work);
  } catch (error) {
    const cause = (error instanceof DrizzleQueryError ? error.cause : error) as
      { code?: unknown; constraint?: unknown } | undefined;
    if (cause?.code === "42501") throw forbidden();
    if (cause?.code === "RQ007") throw stateConflict();
    if (cause?.code === "54000") throw tooLarge();
    if (
      cause?.code === "23505" &&
      (cause.constraint === "config_versions_one_draft" ||
        cause.constraint === "config_objects_key_unique")
    )
      throw new ApiError(
        409,
        "config_draft_exists",
        "This configuration already has a draft.",
      );
    throw error;
  }
}

type VersionTarget = {
  versionId: string;
  type: ConfigType;
  state: ConfigVersion["state"];
};

/** The version and its object as visible to this context; a type, when given, must be the object's. */
async function findVersion(
  tx: TeamTx,
  versionId: string,
  type?: ConfigType,
): Promise<VersionTarget> {
  const { rows } = await tx.execute<VersionTarget>(
    sql`select v.id as "versionId", o.type, v.state from app.config_versions v join app.config_objects o on o.id = v.object_id where v.id = ${z.uuid().parse(versionId)}::uuid`,
  );
  if (!rows[0] || (type !== undefined && rows[0].type !== type))
    throw notFound();
  return rows[0];
}

const audit = (tx: TeamTx, versionId: string, action: string) =>
  tx.execute(
    sql`select tenant_context.audit_config(${versionId}::uuid, ${action})`,
  );

const versionJson = (column: string) =>
  sql.raw(`(select jsonb_build_object('id', v.id, 'number', v.number, 'state', v.state, 'body', v.body,
    'bodySha256', v.body_sha256, 'note', v.note, 'createdAt', v.created_at, 'publishedAt', v.published_at)
    from app.config_versions v where v.id = o.${column})`);

/**
 * Creates the object when it does not exist (a task board in the caller's team) and its one draft
 * with the given body, and audits config.draft_created. An archived object takes no new draft.
 */
export async function createConfigDraft(
  p: Principal,
  input: { type: ConfigType; key: string; body: unknown; note?: string },
): Promise<{ objectId: string; versionId: string }> {
  assertSize(input.body);
  const { type, key, body, note } = draftInput.parse(input);
  return inStore(p, async (tx, access) => {
    requireWrite(p, access, type);
    const parsed = configBodySchemas[type].parse(body);
    const teamId = type === "task-board" ? p.teamId : null;
    let [object] = (
      await tx.execute<{ id: string; archived: boolean }>(
        sql`select id, archived_at is not null as archived from app.config_objects where workspace_id = ${access.workspaceId}::uuid and team_id is not distinct from ${teamId}::text and type = ${type} and key = ${key}`,
      )
    ).rows;
    object ??= (
      await tx.execute<{ id: string; archived: boolean }>(
        sql`insert into app.config_objects(workspace_id, team_id, type, key) values (${access.workspaceId}::uuid, ${teamId}::text, ${type}, ${key}) returning id, false as archived`,
      )
    ).rows[0];
    if (object.archived) throw stateConflict();
    const [version] = (
      await tx.execute<{ id: string }>(
        sql`insert into app.config_versions(object_id, workspace_id, body, note) values (${object.id}::uuid, ${access.workspaceId}::uuid, ${JSON.stringify(parsed)}::jsonb, ${note ?? null}::text) returning id`,
      )
    ).rows;
    await tx.execute(
      sql`update app.config_objects set draft_version_id = ${version.id}::uuid where id = ${object.id}::uuid`,
    );
    await audit(tx, version.id, "config.draft_created");
    return { objectId: object.id, versionId: version.id };
  });
}

/**
 * Replaces the draft's body and, when given, its note; a published version cannot be edited. With
 * options.type, a version of another type is not found.
 */
export async function updateConfigDraft(
  p: Principal,
  versionId: string,
  input: { body: unknown; note?: string },
  options: { type?: ConfigType } = {},
): Promise<void> {
  assertSize(input.body);
  const { body, note } = editInput.parse(input);
  return inStore(p, async (tx, access) => {
    const target = await findVersion(tx, versionId, options.type);
    requireWrite(p, access, target.type);
    if (target.state !== "draft") throw stateConflict();
    const parsed = configBodySchemas[target.type].parse(body);
    await tx.execute(
      sql`update app.config_versions set body = ${JSON.stringify(parsed)}::jsonb, note = coalesce(${note ?? null}::text, note) where id = ${target.versionId}::uuid`,
    );
  });
}

/**
 * Publishes the object's draft through the owner-run helper, which audits it; returns its number.
 * With options.type, a version of another type is not found.
 */
export async function publishConfigVersion(
  p: Principal,
  versionId: string,
  options: { type?: ConfigType } = {},
): Promise<number> {
  return inStore(p, async (tx, access) => {
    const target = await findVersion(tx, versionId, options.type);
    requireWrite(p, access, target.type);
    const { rows } = await tx.execute<{ number: number }>(
      sql`select tenant_context.publish_config_version(${target.versionId}::uuid) as number`,
    );
    return rows[0].number;
  });
}

/** Retires a published version that is no longer current, through the owner-run helper. */
export async function retireConfigVersion(
  p: Principal,
  versionId: string,
): Promise<void> {
  return inStore(p, async (tx, access) => {
    const target = await findVersion(tx, versionId);
    requireWrite(p, access, target.type);
    await tx.execute(
      sql`select tenant_context.retire_config_version(${target.versionId}::uuid)`,
    );
  });
}

/** Archives the object for good and audits it with its current version, or its draft. */
export async function archiveConfigObject(
  p: Principal,
  objectId: string,
): Promise<void> {
  const id = z.uuid().parse(objectId);
  return inStore(p, async (tx, access) => {
    const [object] = (
      await tx.execute<{
        type: ConfigType;
        archived: boolean;
        versionId: string | null;
      }>(
        sql`select type, archived_at is not null as archived, coalesce(current_version_id, draft_version_id) as "versionId" from app.config_objects where id = ${id}::uuid`,
      )
    ).rows;
    if (!object) throw notFound();
    requireWrite(p, access, object.type);
    if (object.archived || !object.versionId) throw stateConflict();
    await tx.execute(
      sql`update app.config_objects set archived_at = now() where id = ${id}::uuid`,
    );
    await audit(tx, object.versionId, "config.archived");
  });
}

/** Saves the editor-only layout of a version and audits config.layout_changed. */
export async function saveConfigLayout(
  p: Principal,
  versionId: string,
  layout: Record<string, unknown>,
): Promise<void> {
  assertSize(layout);
  const parsed = layoutInput.parse(layout);
  return inStore(p, async (tx, access) => {
    const target = await findVersion(tx, versionId);
    requireWrite(p, access, target.type);
    await tx.execute(
      sql`insert into app.config_layouts(version_id, workspace_id, layout) values (${target.versionId}::uuid, ${access.workspaceId}::uuid, ${JSON.stringify(parsed)}::jsonb) on conflict (version_id) do update set layout = excluded.layout, updated_at = now()`,
    );
    await audit(tx, target.versionId, "config.layout_changed");
  });
}

/** The object of this type and key with its current and draft versions, or null when none is visible. */
export async function getConfigObject(
  p: Principal,
  type: ConfigType,
  key: string,
): Promise<ConfigObject | null> {
  const parsedType = z.enum(CONFIG_TYPES).parse(type);
  const parsedKey = configKey.parse(key);
  return inStore(p, async (tx, access) => {
    const teamId = parsedType === "task-board" ? p.teamId : null;
    const { rows } = await tx.execute<{ object: ConfigObject }>(
      sql`select jsonb_build_object('id', o.id, 'type', o.type, 'key', o.key, 'createdAt', o.created_at, 'archivedAt', o.archived_at, 'current', ${versionJson("current_version_id")}, 'draft', ${versionJson("draft_version_id")}) as object from app.config_objects o where o.workspace_id = ${access.workspaceId}::uuid and o.team_id is not distinct from ${teamId}::text and o.type = ${parsedType} and o.key = ${parsedKey}`,
    );
    return rows[0]?.object ?? null;
  });
}

/**
 * The non-archived objects of this type with their current and draft versions, ordered by key, at
 * most 100: the caller's workspace, or for a task board the caller's team. Write access to the type
 * is required, as for its drafts.
 */
export async function listConfigObjects(
  p: Principal,
  type: ConfigType,
): Promise<ConfigObject[]> {
  const parsedType = z.enum(CONFIG_TYPES).parse(type);
  return inStore(p, async (tx, access) => {
    requireWrite(p, access, parsedType);
    const teamId = parsedType === "task-board" ? p.teamId : null;
    const { rows } = await tx.execute<{ object: ConfigObject }>(
      sql`select jsonb_build_object('id', o.id, 'type', o.type, 'key', o.key, 'createdAt', o.created_at, 'archivedAt', o.archived_at, 'current', ${versionJson("current_version_id")}, 'draft', ${versionJson("draft_version_id")}) as object from app.config_objects o where o.workspace_id = ${access.workspaceId}::uuid and o.team_id is not distinct from ${teamId}::text and o.type = ${parsedType} and o.archived_at is null order by o.key limit 100`,
    );
    return rows.map((row) => row.object);
  });
}

/**
 * The current published body of the object with this type and key, read from the access state
 * install returned; it runs no statement. Null when the object has no current version, is archived
 * or is not visible to the context (another workspace, or another team's task board).
 */
export function currentConfigBody(
  access: TenantAccess,
  type: ConfigType,
  key: string,
): Pick<ConfigDocument, "versionId" | "number" | "body"> | null {
  const document = Object.values(access.documents).find(
    (candidate) => candidate.type === type && candidate.key === key,
  );
  return document
    ? {
        versionId: document.versionId,
        number: document.number,
        body: document.body,
      }
    : null;
}

/**
 * The kind schema in force for a kind: the workspace's current published version, else the compiled
 * default (version 1). It runs no statement. A published body that is not a valid kind schema of
 * this kind throws rather than falling back to the default.
 */
export function kindSchemaFor(
  access: TenantAccess,
  kind: ConfigurableKind,
): { versionId: string; number: number; body: KindSchemaBody } {
  const current = currentConfigBody(access, "kind-schema", kind);
  if (!current) {
    const { versionId, body } = DEFAULT_KIND_SCHEMAS[kind];
    return { versionId, number: 1, body };
  }
  const parsed = kindSchemaBodySchema.safeParse(current.body);
  if (!parsed.success || parsed.data.kind !== kind)
    throw new Error(
      `The published ${kind} kind schema ${current.versionId} is not valid.`,
    );
  return {
    versionId: current.versionId,
    number: current.number,
    body: parsed.data,
  };
}

/** Company owners and admins only: config events of every team in the workspace, newest first. */
export async function listConfigHistory(
  p: Principal,
  options: { objectId?: string; before?: Date; pageSize?: number } = {},
): Promise<ConfigHistoryRow[]> {
  const { objectId, before, pageSize } = historyInput.parse(options);
  return inStore(p, async (tx, access) => {
    if (p.authType !== "session" || access.companyLevel === null)
      throw forbidden();
    const { rows } = await tx.execute<ConfigHistoryRow>(
      sql`select occurred_at as "occurredAt", action, object_type as "objectType", object_key as "objectKey", version_number as "versionNumber", from_version_number as "fromVersionNumber", actor_name as "actorName" from tenant_context.config_history(${objectId ?? null}::uuid, ${before?.toISOString() ?? null}::timestamptz, ${pageSize}::integer)`,
    );
    return rows;
  });
}
