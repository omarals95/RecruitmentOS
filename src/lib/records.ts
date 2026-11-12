import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  DrizzleQueryError,
  eq,
  getTableColumns,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import {
  activity,
  candidateStates,
  idempotency,
  recordAssignments,
  recordFiles,
  records,
} from "@/db/schema";
import { getIdentityDb, type TeamTx } from "@/db";
import { member } from "@/db/auth-schema";
import {
  accessContext,
  anyRecordScopeRule,
  authorize,
  checkFieldWrite,
  decide,
  hiddenKeys,
  readOnlyKeys,
  recordScopeRule,
  redact,
  scopeFilter,
  type AccessContext,
} from "@/lib/authz";
import { assignmentRefusal } from "@/lib/assignments";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";
import {
  CANDIDATE_DUPLICATE_LIMIT,
  REVIEW_STATUSES,
  TASK_LINK_KINDS,
  bulkApplicationsSchema,
  candidateStateSchema,
  createRecordSchemas,
  dubaiToday,
  kindToResource,
  recordDataSchemas,
  referenceFields,
  referencesByKind,
  resourceToKind,
  searchTerms,
  updateRecordSchemas,
  uuidSchema,
  type RecordDto,
  type RecordKind,
  type ReferenceField,
  type RecordReferences,
  type ResourceName,
} from "@/domain/records";
import {
  CONFIGURABLE_KINDS,
  type ConfigurableKind,
  type KindSchemaBody,
  type TaskBoardBody,
} from "@/domain/config";
import { EXPORT_RESOURCES, type ExportResource } from "@/domain/export";
import {
  TASK_FIELD_TYPE_MAP,
  compileKindSchema,
  fieldValueSchema,
  type CustomField,
} from "@/domain/field-types";
import { screenFor, shownKeys } from "@/domain/screens";
import { kindSchemaFor } from "@/lib/config-store";
import { requireJobTitle } from "@/lib/job-architecture";
import { publishedTaskBoards } from "@/lib/task-boards";

type DbRecord = typeof records.$inferSelect;
/** A task's linked record as the caller may see it (parentLink). */
type ParentLink = { kind: RecordKind; label: string };
/**
 * A row read with its vacancy unit's label, a task's assignees and a task's linked record in the same
 * statement (recordColumns, readColumns).
 */
type LabelledRecord = DbRecord & {
  orgUnitLabel?: string | null;
  assigneeIds?: string[] | null;
  parentLink?: ParentLink | null;
};
type Data = Record<string, unknown>;
type WriteInput = Partial<RecordReferences> & {
  data: Data;
  version?: number;
  legacyId?: string;
  importMeta?: Data;
  archived?: boolean;
  moveToBucketId?: string;
  orgUnitId?: string | null;
};
/**
 * A column of the row a statement returns, qualified: an insert's or update's RETURNING names its
 * columns without the table, which a subquery over another records row would otherwise shadow.
 */
const outer = (column: string) => sql.raw(`"records".${column}`);
/**
 * Every column plus a vacancy's org unit as "Name (CODE)", null for other kinds and no unit, and a
 * task's assignees: the user ids of its assignee rows in code-point order, null for other kinds.
 */
const recordColumns = {
  ...getTableColumns(records),
  orgUnitLabel: sql<
    string | null
  >`case when ${records.kind}='vacancy' then (select u.name || ' (' || u.code || ')' from app.org_units u where u.id=${records.orgUnitId}) end`,
  assigneeIds: sql<
    string[] | null
  >`case when ${records.kind}='task' then coalesce((select jsonb_agg(a.user_id order by a.user_id collate "C") from ${recordAssignments} a where a.team_id=${outer("team_id")} and a.record_id=${outer("id")} and a.relation='assignee'), '[]'::jsonb) end`,
};
/**
 * A task's linked record as the caller may see it, or null: a kind of TASK_LINK_KINDS the caller may
 * view, in their record scope, labelled as decorate() labels references, from its name or title
 * unless the role hides that field on the parent's kind.
 */
function parentLink(ctx: AccessContext): SQL<ParentLink | null> {
  const branches = TASK_LINK_KINDS.filter((kind) =>
    decide(ctx, { resource: kindToResource[kind], action: "view" }),
  ).map((kind) => {
    const hidden = hiddenKeys(ctx, kind);
    const names = ["name", "title"]
      .filter(
        (key) =>
          Object.hasOwn(recordDataSchemas[kind].shape, key) && !hidden.has(key),
      )
      .map(
        (key) =>
          `nullif(case when jsonb_typeof(parent.data->'${key}')='string' then parent.data->>'${key}' end, '')`,
      );
    return {
      kind,
      rule: recordScopeRule(ctx, kind, "parent"),
      label: sql.raw(
        `coalesce(${[...names, `'Untitled ${kind}'`].join(", ")})`,
      ),
    };
  });
  if (!branches.length) return sql`null`;
  return sql`case when ${records.kind}='task' and ${records.parentRecordId} is not null then (select jsonb_build_object('kind', parent.kind, 'label', (case ${sql.join(
    branches.map(
      (branch) => sql`when parent.kind=${branch.kind} then ${branch.label}`,
    ),
    sql` `,
  )} end) || case when parent.archived_at is not null then ' (archived)' else '' end) from ${records} parent where parent.team_id=${outer("team_id")} and parent.id=${outer("parent_record_id")} and (${sql.join(
    branches.map(
      (branch) =>
        sql`(parent.kind=${branch.kind}${branch.rule ? sql` and ${branch.rule}` : sql``})`,
    ),
    sql` or `,
  )})) end`;
}
/** recordColumns plus a task's linked record, for every statement that returns records. */
function readColumns(ctx: AccessContext) {
  return { ...recordColumns, parentLink: parentLink(ctx) };
}
/**
 * Maps app.maintain_record_scope()'s refusal of a vacancy's unit (RQ012) to a reference error, and
 * the record-scope policy's refusal of a row outside the caller's scope (42501, 0038) to a plain 403
 * for a caller whose record scope is not all in every group; anything else is re-thrown unchanged.
 */
async function unitChecked<T>(
  ctx: AccessContext,
  statement: PromiseLike<T>,
): Promise<T> {
  try {
    return await statement;
  } catch (error) {
    const cause = error instanceof DrizzleQueryError ? error.cause : error;
    const { code } = (cause as { code?: unknown } | undefined) ?? {};
    if (code === "RQ012")
      throw new ApiError(
        400,
        "invalid_reference",
        "orgUnitId does not reference a current unit of this company.",
      );
    // No rule for any kind means a record scope of all in every group.
    if (code === "42501" && anyRecordScopeRule(ctx, "records") !== null)
      throw new ApiError(
        403,
        "record_out_of_scope",
        "This change would put the record outside the records you can see.",
      );
    throw error;
  }
}
function kindOf(resource: ResourceName): RecordKind {
  if (!Object.hasOwn(resourceToKind, resource))
    throw new ApiError(404, "not_found", "Unknown resource.");
  return resourceToKind[resource];
}
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      "invalid_input",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .slice(0, 8)
        .join("; "),
    );
  return parsed.data;
}
function id(value: unknown) {
  return parse(uuidSchema, value);
}
type KindSchema = { versionId: string; body: KindSchemaBody };
/**
 * The kind schema version a create or update of this kind is validated against and pins
 * (architecture 1.3): the current published kind schema from the install result, else the fixed
 * default version; null for a kind without a kind schema. It runs no statement, and an access state
 * without documents or an invalid published body throws rather than pinning the default.
 */
function kindSchemaOf(ctx: AccessContext, kind: RecordKind): KindSchema | null {
  return (CONFIGURABLE_KINDS as readonly RecordKind[]).includes(kind)
    ? kindSchemaFor(ctx.access, kind as ConfigurableKind)
    : null;
}
/**
 * The response shape. A vacancy with a unit read through recordColumns adds orgUnitId and
 * orgUnitLabel, and a task read through it adds data.assigneeIds and, with a visible linked record,
 * parentKind and parentLabel; every other row keeps exactly its earlier keys, and exports never read
 * them.
 */
function dto(row: LabelledRecord): RecordDto {
  return {
    id: row.id,
    kind: row.kind as RecordKind,
    data: (row.kind === "task" && row.assigneeIds !== undefined
      ? { ...row.data, assigneeIds: row.assigneeIds ?? [] }
      : row.data) as RecordDto["data"],
    version: row.version,
    legacyId: row.legacyId,
    createdBy: row.createdBy,
    privateOwnerId: row.privateOwnerId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    candidateId: row.candidateId,
    vacancyId: row.vacancyId,
    applicationId: row.applicationId,
    onboardingId: row.onboardingId,
    bucketId: row.bucketId,
    jobRoleId: row.jobRoleId,
    parentRecordId: row.parentRecordId,
    ...(row.importMeta && Object.keys(row.importMeta).length
      ? { importMeta: row.importMeta }
      : {}),
    ...(row.kind === "vacancy" &&
    row.orgUnitId &&
    row.orgUnitLabel !== undefined
      ? { orgUnitId: row.orgUnitId, orgUnitLabel: row.orgUnitLabel }
      : {}),
    ...(row.kind === "task" && row.parentLink
      ? { parentKind: row.parentLink.kind, parentLabel: row.parentLink.label }
      : {}),
  };
}
async function decorate(
  tx: TeamTx,
  ctx: AccessContext,
  rows: RecordDto[],
): Promise<RecordDto[]> {
  const { principal: p } = ctx;
  const commentIds = rows
    .filter((row) => row.kind === "comment")
    .map((row) => row.id);
  if (commentIds.length) {
    // The accessor names only readable events; imported comments have no 'created' event.
    const authors = await tx
      .select({
        recordId: activity.recordId,
        name: sql<
          string | null
        >`tenant_context.activity_actor_name(${activity.id})`,
      })
      .from(activity)
      .where(
        and(
          eq(activity.teamId, p.teamId),
          eq(activity.kind, "comment"),
          eq(activity.action, "created"),
          inArray(activity.recordId, commentIds),
        ),
      );
    const names = new Map(authors.map((row) => [row.recordId, row.name]));
    rows = rows.map((row) =>
      row.kind === "comment"
        ? { ...row, authorName: names.get(row.id) ?? null }
        : row,
    );
  }
  if (
    !ctx.scopes.includes("recruitment:read") ||
    !rows.some((row) => ["application", "onboarding"].includes(row.kind))
  )
    return rows;
  const candidates = ctx.scopes.includes("candidates:read");
  const applications = new Map(
    rows
      .filter((row) => row.kind === "application")
      .map((row) => [
        row.id,
        { id: row.id, candidateId: row.candidateId, vacancyId: row.vacancyId },
      ]),
  );
  const parentIds = [
    ...new Set(
      rows
        .filter((row) => row.kind === "onboarding" && row.applicationId)
        .map((row) => row.applicationId!),
    ),
  ].filter((key) => !applications.has(key));
  if (parentIds.length) {
    const parents = await tx
      .select({
        id: records.id,
        candidateId: records.candidateId,
        vacancyId: records.vacancyId,
      })
      .from(records)
      .where(
        and(...scopeFilter(ctx, "application"), inArray(records.id, parentIds)),
      );
    for (const parent of parents) applications.set(parent.id, parent);
  }
  const parentRefs = [
    ...new Set(
      [...applications.values()]
        .flatMap((row) => [
          row.vacancyId,
          ...(candidates ? [row.candidateId] : []),
        ])
        .filter((value): value is string => !!value),
    ),
  ];
  const labels = new Map<string, string>();
  // The candidate and vacancy names an application card shows, as referenceText() in the client
  // words them; a candidate is only present with candidates:read.
  const references = new Map<string, string>();
  if (parentRefs.length) {
    const parents = await tx
      .select({
        ...getTableColumns(records),
        // Only the label fields, so a card label never loads a candidate's full data.
        data: sql<
          DbRecord["data"]
        >`jsonb_build_object('name', ${records.data}->'name', 'title', ${records.data}->'title')`,
      })
      .from(records)
      .where(
        and(
          inArray(records.id, parentRefs),
          or(
            and(...scopeFilter(ctx, "vacancy")),
            ...(candidates ? [and(...scopeFilter(ctx, "candidate"))] : []),
          ),
        ),
      );
    for (const parent of parents) {
      // Labels come only from fields the caller may see; a hidden one reads as an empty name.
      const data: Data = redact(ctx, dto(parent)).data;
      const value = parent.kind === "candidate" ? data.name : data.title;
      const name = typeof value === "string" ? value : "";
      labels.set(parent.id, name);
      references.set(
        parent.id,
        `${name || `Untitled ${parent.kind}`}${parent.archivedAt ? " (archived)" : ""}`,
      );
    }
  }
  const referenceLabels = (row: RecordDto) => {
    const candidateLabel = row.candidateId && references.get(row.candidateId);
    const vacancyLabel = row.vacancyId && references.get(row.vacancyId);
    return {
      ...(candidateLabel ? { candidateLabel } : {}),
      ...(vacancyLabel ? { vacancyLabel } : {}),
    };
  };
  const applicationLabel = (recordId: string) => {
    const application = applications.get(recordId);
    if (!application) return `Application ${recordId.slice(-8)}`;
    return (
      [
        application.candidateId && labels.get(application.candidateId),
        application.vacancyId && labels.get(application.vacancyId),
      ]
        .filter(Boolean)
        .join(" · ") || `Application ${recordId.slice(-8)}`
    );
  };
  return rows.map((row) =>
    row.kind === "application"
      ? { ...row, label: applicationLabel(row.id), ...referenceLabels(row) }
      : row.kind === "onboarding" && row.applicationId
        ? {
            ...row,
            label: `Onboarding · ${applicationLabel(row.applicationId)}`,
          }
        : row,
  );
}
async function find(
  tx: TeamTx,
  ctx: AccessContext,
  kind: RecordKind,
  recordId: string,
  lock = false,
): Promise<LabelledRecord> {
  const query = tx
    .select(readColumns(ctx))
    .from(records)
    .where(and(...scopeFilter(ctx, kind), eq(records.id, recordId)))
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  if (!rows[0])
    throw new ApiError(404, "not_found", "Record not found in this team.");
  return rows[0];
}
export async function lockTeam(tx: TeamTx, p: Principal) {
  // A transaction-scoped lock also serializes empty-set and cross-record invariants.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`recruitment-records:${p.teamId}`}, 0))`,
  );
}
async function audit(
  tx: TeamTx,
  p: Principal,
  row: DbRecord,
  action: string,
  metadata: Data = {},
  imported = false,
) {
  await tx.insert(activity).values({
    id: randomUUID(),
    teamId: p.teamId,
    recordId: row.id,
    actorId: p.userId,
    actorType: imported ? "import" : p.authType,
    tokenId: p.tokenId ?? null,
    action,
    kind: row.kind,
    summary: `${imported ? "Imported" : action === "created" ? "Created" : action === "archived" ? "Archived" : action === "restored" ? "Restored" : "Updated"} ${row.kind}`,
    metadata,
    createdAt: new Date(),
  });
}
function importedInput(
  ctx: AccessContext,
  resource: ResourceName,
  kind: RecordKind,
  input: WriteInput,
  submittedData: Data = input.data,
): boolean {
  const sourceFields =
    kind === "candidate" &&
    ["rawSource", "evidence", "sourceReviews"].some((key) =>
      Object.hasOwn(submittedData, key),
    );
  const imported =
    input.legacyId !== undefined ||
    input.importMeta !== undefined ||
    (kind === "comment" && submittedData.legacyAuthorLabel !== undefined) ||
    sourceFields;
  if (imported || (input.archived === true && input.version === undefined))
    authorize(ctx, { resource, action: "import" });
  return imported;
}
async function checkReferences(
  tx: TeamTx,
  ctx: AccessContext,
  kind: RecordKind,
  input: Partial<RecordReferences>,
  existing?: DbRecord,
  allowArchived = false,
  restoring = false,
) {
  const allowed = referencesByKind[kind];
  for (const key of referenceFields) {
    const value =
      input[key] === undefined ? (existing?.[key] ?? null) : input[key];
    const config = allowed[key];
    if (!config && input[key] !== undefined && value !== null)
      throw new ApiError(
        400,
        "invalid_reference",
        `${key} is not valid for ${kind}.`,
      );
    if (config?.required && !value)
      throw new ApiError(400, "missing_reference", `${key} is required.`);
    if (
      existing &&
      config?.immutable &&
      input[key] !== undefined &&
      value !== existing[key]
    )
      throw new ApiError(
        400,
        "immutable_reference",
        `${key} cannot be changed.`,
      );
    if (!value || (!restoring && existing && value === existing[key])) continue;
    await referencedRecord(tx, ctx, kind, key, value, {
      existing,
      allowArchived,
    });
  }
}
/**
 * The record one reference of a `kind` record names, or the refusal checkReferences gives. `name`,
 * the key by default, is the input key the errors name.
 */
async function referencedRecord(
  tx: TeamTx,
  ctx: AccessContext,
  kind: RecordKind,
  key: ReferenceField,
  value: string,
  options: { existing?: DbRecord; allowArchived?: boolean; name?: string } = {},
): Promise<DbRecord> {
  const { principal: p } = ctx;
  const { existing, allowArchived = false, name = key } = options;
  const config = referencesByKind[kind][key];
  // A parent of a named kind is looked up in the caller's scope; any kind is matched by id, in
  // the caller's record scope for the kind it turns out to be.
  const anyKind = anyRecordScopeRule(ctx, "records");
  const [parent] = await tx
    .select()
    .from(records)
    .where(
      config && config.kind !== "*"
        ? and(...scopeFilter(ctx, config.kind), eq(records.id, value))
        : and(
            eq(records.teamId, p.teamId),
            eq(records.id, value),
            ...(anyKind ? [anyKind] : []),
          ),
    )
    .limit(1);
  // A candidate the caller cannot read is answered exactly as a missing parent.
  const candidateComment = kind === "comment" && parent?.kind === "candidate";
  // So is a task's link to a kind outside TASK_LINK_KINDS, a kind the caller may not view, or itself.
  const taskLink = kind === "task" && key === "parentRecordId";
  if (
    !parent ||
    (config?.kind !== "*" && parent.kind !== config?.kind) ||
    (parent.kind === "saved-view" && parent.privateOwnerId !== p.userId) ||
    (candidateComment && !ctx.scopes.includes("candidates:read")) ||
    (taskLink &&
      (!TASK_LINK_KINDS.includes(parent.kind as RecordKind) ||
        parent.id === existing?.id ||
        !decide(ctx, {
          resource: kindToResource[parent.kind as RecordKind],
          action: "view",
        })))
  )
    throw missingReference(name);
  if (candidateComment)
    authorize(ctx, { resource: "candidates", action: "comment" });
  if (parent.archivedAt && !allowArchived)
    throw new ApiError(
      400,
      "archived_reference",
      `${name} references an archived record.`,
    );
  return parent;
}
const missingReference = (name: string) =>
  new ApiError(
    400,
    "invalid_reference",
    `${name} does not reference the expected record in this team.`,
  );
/**
 * The records a task board body names, checked inside the caller's transaction as the same
 * references of a task are: each column an active bucket of the team, a vacancy filter an active
 * vacancy in the caller's scope, a linked-record filter an active record of TASK_LINK_KINDS the
 * caller may view and is in scope for, and a field filter an active Dropdown task field of the team
 * with the value among its options. A record of another team or out of scope reads as missing.
 */
export async function checkTaskBoardReferences(
  tx: TeamTx,
  ctx: AccessContext,
  body: TaskBoardBody,
) {
  for (const [index, column] of body.columns.entries())
    await referencedRecord(tx, ctx, "task", "bucketId", column, {
      name: `columns.${index}`,
    });
  const { filter } = body;
  if (filter?.by === "vacancy")
    await referencedRecord(tx, ctx, "task", "vacancyId", filter.vacancyId, {
      name: "filter.vacancyId",
    });
  if (filter?.by === "linked-record")
    await referencedRecord(tx, ctx, "task", "parentRecordId", filter.recordId, {
      name: "filter.recordId",
    });
  if (filter?.by === "field") {
    // A task field is one of TASK_LINK_KINDS, so the linked-record lookup finds it.
    const field = await referencedRecord(
      tx,
      ctx,
      "task",
      "parentRecordId",
      filter.fieldId,
      { name: "filter.fieldId" },
    );
    if (field.kind !== "task-field" || field.data.type !== "Dropdown")
      throw missingReference("filter.fieldId");
    if (!(field.data.options as string[]).includes(filter.value))
      throw new ApiError(
        400,
        "invalid_reference",
        "filter.value is not an option of this field.",
      );
  }
}
function validateRelations(kind: RecordKind, data: Data) {
  if (
    kind === "offer" &&
    data.sentDate &&
    data.expiryDate &&
    String(data.expiryDate) < String(data.sentDate)
  )
    throw new ApiError(
      400,
      "invalid_dates",
      "Offer expiry cannot be before its sent date.",
    );
  if (kind === "task-field") {
    const options = data.options as string[];
    if (
      new Set(options.map((value) => value.toLocaleLowerCase())).size !==
      options.length
    )
      throw new ApiError(
        400,
        "duplicate_options",
        "Dropdown options must be unique.",
      );
    if (data.type === "Dropdown" && options.length === 0)
      throw new ApiError(
        400,
        "missing_options",
        "A dropdown field requires at least one option.",
      );
    if (data.type !== "Dropdown" && options.length > 0)
      throw new ApiError(
        400,
        "invalid_options",
        "Only dropdown fields may have options.",
      );
  }
}
/**
 * The custom values an update merges in place of the sent map: the sent map plus the stored value
 * of each custom field of the kind schema that the edit screen for the record's type does not show
 * and the map leaves out, so a value the editor never showed is never lost (R2b-07), and of each
 * custom id in `locked` (the ones the role hides or makes read-only) the map leaves out. Sent values,
 * null and "" included, and a task's other team task-field keys are taken as sent.
 */
function keptCustomValues(
  schema: KindSchema,
  existing: Pick<DbRecord, "data" | "typeId">,
  sent: Data,
  locked: ReadonlySet<string>,
): Data {
  const shown = new Set(
    shownKeys(screenFor(schema.body, existing.typeId, "edit")),
  );
  const stored = (existing.data.customValues ?? {}) as Data;
  const kept = [
    ...schema.body.fields.flatMap((field) =>
      !field.system &&
      !shown.has(field.key) &&
      !Object.hasOwn(sent, field.key) &&
      Object.hasOwn(stored, field.key)
        ? [[field.key, stored[field.key]]]
        : [],
    ),
    // A custom field the role hides or makes read-only, a team task field included (R2b-08).
    ...Object.keys(stored).flatMap((key) =>
      locked.has(key) && !Object.hasOwn(sent, key) ? [[key, stored[key]]] : [],
    ),
  ];
  return kept.length ? { ...sent, ...Object.fromEntries(kept) } : sent;
}
/**
 * The field keys a write names (R2b-08): the keys of data, the custom field ids of
 * data.customValues and legacyId and importMeta when sent. Schema defaults are never named.
 */
function sentKeys(raw: unknown): string[] {
  const input = raw as {
    data?: Data;
    legacyId?: unknown;
    importMeta?: unknown;
  };
  const data = input.data ?? {};
  const custom = data.customValues;
  return [
    ...Object.keys(data),
    ...(custom && typeof custom === "object" ? Object.keys(custom) : []),
    ...(["legacyId", "importMeta"] as const).filter(
      (key) => input[key] !== undefined,
    ),
  ];
}
// Empty for a mandatory rule (architecture 1.5 item 5); false is a value.
const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);
/**
 * Checks the custom values of a configurable kind against the kind schema version the write pins
 * (architecture 1.5), after the strict parse. Only an added or changed value is checked, so a value
 * carried over unchanged never blocks an unrelated edit; an archived field's value can be neither
 * changed nor removed unless the write is imported. Then the mandatory rules: a create needs every
 * mandatory field of the default create screen (records get no type on create until R2b-11), and an
 * edit may not empty a filled one of the edit screen for the stored record's type. A task's team
 * task-field keys are left to checkCustomValues. It runs no statement and returns the added or
 * changed values for checkFieldReferences.
 */
function checkKindValues(
  schema: KindSchema,
  data: Data,
  existing: Pick<DbRecord, "data" | "typeId"> | undefined,
  importing: boolean,
  teamFields: ReadonlySet<string> = new Set(),
): Data {
  const compiled = compileKindSchema(schema);
  const fields = new Map(schema.body.fields.map((field) => [field.key, field]));
  const own = (map: Data | undefined) =>
    Object.fromEntries(
      Object.entries((map?.customValues ?? {}) as Data).filter(
        ([key]) => !teamFields.has(key),
      ),
    );
  const values = own(data);
  const oldValues = own(existing?.data);
  const archived = new Set(compiled.archived);
  const changed = Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) =>
        JSON.stringify(oldValues[key]) !== JSON.stringify(value),
    ),
  );
  for (const key of Object.keys(changed)) {
    if (fields.get(key)?.system !== false)
      throw new ApiError(
        400,
        "unknown_custom_field",
        "A custom field is not available in this team.",
      );
    if (!importing && archived.has(key))
      throw new ApiError(
        400,
        "archived_custom_field",
        "Archived custom field values must be preserved unchanged.",
      );
  }
  const parsed = compiled.customValues.safeParse(changed);
  if (!parsed.success)
    throw new ApiError(
      400,
      "invalid_custom_value",
      `Invalid value for ${fields.get(String(parsed.error.issues[0].path[0]))!.label}.`,
    );
  for (const key of Object.keys(oldValues))
    if (!importing && archived.has(key) && !Object.hasOwn(values, key))
      throw new ApiError(
        400,
        "archived_custom_field",
        "Archived field values cannot be removed.",
      );
  // A custom key is looked up in customValues and a system key in data.
  const valueOf = (map: Data, custom: Data, key: string) =>
    fields.get(key)?.system ? map[key] : custom[key];
  const mandatory = existing
    ? compiled
        .mandatoryFor(existing.typeId, "edit")
        .filter(
          (key) =>
            !isEmpty(valueOf(existing.data, oldValues, key)) &&
            isEmpty(valueOf(data, values, key)),
        )
    : compiled
        .mandatoryFor(null, "create")
        .filter((key) => isEmpty(valueOf(data, values, key)));
  if (mandatory.length) {
    const field = fields.get(mandatory[0])!;
    throw field.system
      ? new ApiError(
          400,
          "invalid_input",
          `${field.key}: ${field.label} is required.`,
        )
      : new ApiError(
          400,
          "required_custom_field",
          `A valid value for ${field.label} is required.`,
        );
  }
  return changed;
}
/**
 * The person values a write may store: the ids confirmed as members of the team through the
 * identity pool, or "ask" on the first attempt of createRecord and updateRecord.
 */
type Members = ReadonlySet<string> | "ask";
/**
 * Thrown by a first attempt that meets a changed person value. It rolls back the transaction, and
 * withMembers reads those ids through the identity pool and runs the work again; never a response.
 */
class MembersNeeded extends Error {
  userIds: string[];
  constructor(userIds: string[]) {
    super("Team membership is read before this write.");
    this.userIds = userIds;
  }
}
/**
 * Runs `work` once with "ask". When it needs membership, reads in one identity query, outside any
 * data transaction, which of the person ids are members of the team, and runs `work` exactly once
 * more with them; the data role never reads auth.member.
 */
async function withMembers<T>(
  p: Principal,
  work: (members: Members) => Promise<T>,
): Promise<T> {
  try {
    return await work("ask");
  } catch (error) {
    if (!(error instanceof MembersNeeded)) throw error;
    const db = await getIdentityDb();
    const rows = await db
      .select({ userId: member.userId })
      .from(member)
      .where(
        and(
          eq(member.organizationId, p.teamId),
          inArray(member.userId, error.userIds),
        ),
      );
    return work(new Set(rows.map((row) => row.userId)));
  }
}
/**
 * Checks the references of the added or changed values checkKindValues returned (architecture 1.5
 * item 7): each non-empty value of an active person, org unit, lookup or file field. A person must
 * be in `members`; with "ask" it throws MembersNeeded before any statement. Org units, lookups and
 * files are read together in at most one statement: a current unit of the caller's company, a
 * record of the field's target kind in the caller's team and record scope, and a ready, unerased
 * file of the record being written (`recordId`, R2b-06). A lookup to anything else, or to a kind the
 * caller may not view, and any other file are refused exactly as a missing parent; on a create there
 * is no record yet, so every file value is refused without a statement.
 */
async function checkFieldReferences(
  tx: TeamTx,
  ctx: AccessContext,
  schema: KindSchema,
  changed: Data,
  members: Members,
  allowArchived: boolean,
  recordId?: string,
) {
  const values = schema.body.fields.flatMap((field) =>
    !field.system &&
    !field.archived &&
    (field.type === "person" ||
      field.type === "org-unit" ||
      field.type === "lookup" ||
      field.type === "file") &&
    !isEmpty(changed[field.key])
      ? [{ field, value: changed[field.key] as string }]
      : [],
  );
  const files = values.flatMap(({ field, value }) =>
    field.type === "file" ? [value] : [],
  );
  if (files.length && !recordId)
    throw missingReference(
      values.find(({ field }) => field.type === "file")!.field.label,
    );
  const people = values.filter(({ field }) => field.type === "person");
  if (people.length && members === "ask")
    throw new MembersNeeded([...new Set(people.map(({ value }) => value))]);
  for (const { field, value } of people)
    if (!(members as ReadonlySet<string>).has(value))
      throw new ApiError(
        400,
        "invalid_reference",
        `${field.label} must be a member of this team.`,
      );
  const units = values.flatMap(({ field, value }) =>
    field.type === "org-unit" ? [value] : [],
  );
  const lookups = values.flatMap(({ field, value }) =>
    field.type === "lookup" ? [{ target: field.target, value }] : [],
  );
  // As in referencedRecord: a kind the caller may not view, and candidates without candidates:read,
  // are never read, so their records answer as missing.
  const targets = [...new Set(lookups.map(({ target }) => target))].filter(
    (target) =>
      (target !== "candidate" || ctx.scopes.includes("candidates:read")) &&
      decide(ctx, { resource: kindToResource[target], action: "view" }),
  );
  const parts = [
    ...(units.length
      ? [
          sql`select u.id::text as id, 'org-unit'::text as kind, false as archived from app.org_units u where u.workspace_id = ${ctx.access.workspaceId}::uuid and u.valid_to is null and u.archived_at is null and u.id = any(${sql.param(units)}::uuid[])`,
        ]
      : []),
    ...targets.map(
      (target) =>
        sql`select ${records.id}::text as id, ${records.kind} as kind, ${records.archivedAt} is not null as archived from ${records} where ${and(
          ...scopeFilter(ctx, target),
          inArray(
            records.id,
            lookups.flatMap((lookup) =>
              lookup.target === target ? [lookup.value] : [],
            ),
          ),
        )}`,
    ),
    ...(files.length
      ? [
          sql`select f.id::text as id, 'file'::text as kind, false as archived from ${recordFiles} f where f.team_id = ${ctx.principal.teamId} and f.record_id = ${recordId}::uuid and f.status = 'ready' and f.erasure_id is null and f.id = any(${sql.param(files)}::uuid[])`,
        ]
      : []),
  ];
  const found = new Map(
    parts.length
      ? (
          await tx.execute<{ id: string; kind: string; archived: boolean }>(
            sql.join(parts, sql` union all `),
          )
        ).rows.map((row): [string, boolean] => [
          `${row.kind}:${row.id}`,
          row.archived,
        ])
      : [],
  );
  for (const { field, value } of values) {
    if (field.type === "org-unit" && !found.has(`org-unit:${value}`))
      throw new ApiError(
        400,
        "invalid_reference",
        `${field.label} does not reference a current unit of this company.`,
      );
    if (field.type === "file" && !found.has(`file:${value}`))
      throw missingReference(field.label);
    if (field.type !== "lookup") continue;
    const archived = found.get(`${field.target}:${value}`);
    if (archived === undefined) throw missingReference(field.label);
    if (archived && !allowArchived)
      throw new ApiError(
        400,
        "archived_reference",
        `${field.label} references an archived record.`,
      );
  }
}
/**
 * The check of one team task field's values on the field type engine (TASK_FIELD_TYPE_MAP, options
 * as their own ids): "", null and a missing value are valid only when the field is optional.
 */
function validCustomValue(field: DbRecord): (value: unknown) => boolean {
  const type = field.data.type as keyof typeof TASK_FIELD_TYPE_MAP;
  const schema = fieldValueSchema({
    key: field.id,
    system: false,
    label: String(field.data.name),
    type: TASK_FIELD_TYPE_MAP[type],
    required: !!field.data.required,
    ...(type === "Dropdown"
      ? {
          options: (field.data.options as string[]).map((option) => ({
            id: option,
            label: option,
          })),
        }
      : {}),
  } as CustomField);
  return (value) =>
    value === "" || value === null || value === undefined
      ? !field.data.required
      : schema.safeParse(value).success;
}
/**
 * A task's custom values: the team's task-field keys as today, every other key through
 * checkKindValues against the task kind schema, whose changed values it returns.
 */
async function checkCustomValues(
  tx: TeamTx,
  ctx: AccessContext,
  schema: KindSchema,
  data: Data,
  existing?: DbRecord,
  importing = false,
): Promise<Data> {
  const fields = await tx
    .select()
    .from(records)
    .where(and(...scopeFilter(ctx, "task-field")));
  const changed = checkKindValues(
    schema,
    data,
    existing,
    importing,
    new Set(fields.map((field) => field.id)),
  );
  const values = data.customValues as Data;
  const oldValues = (existing?.data.customValues ?? {}) as Data;
  const byId = new Map(fields.map((field) => [field.id, field]));
  const valid = new Map(
    fields.map((field) => [field.id, validCustomValue(field)]),
  );
  for (const [key, value] of Object.entries(values)) {
    const field = byId.get(key);
    if (!field) continue;
    if (field.archivedAt) {
      if (
        !importing &&
        JSON.stringify(oldValues[key]) !== JSON.stringify(value)
      )
        throw new ApiError(
          400,
          "archived_custom_field",
          "Archived custom field values must be preserved unchanged.",
        );
    } else if (!valid.get(key)!(value))
      throw new ApiError(
        400,
        "invalid_custom_value",
        `Invalid value for ${field.data.name}.`,
      );
  }
  for (const field of fields.filter((item) => !item.archivedAt)) {
    if (!valid.get(field.id)!(values[field.id]))
      throw new ApiError(
        400,
        "required_custom_field",
        `A valid value for ${field.data.name} is required.`,
      );
  }
  for (const field of fields.filter((item) => item.archivedAt)) {
    if (
      !importing &&
      Object.hasOwn(oldValues, field.id) &&
      !Object.hasOwn(values, field.id)
    )
      throw new ApiError(
        400,
        "archived_custom_field",
        "Archived field values cannot be removed.",
      );
  }
  return changed;
}
async function checkFieldCompatibility(
  tx: TeamTx,
  ctx: AccessContext,
  existing: DbRecord | undefined,
  data: Data,
  archived: boolean,
) {
  if (archived) return;
  // Every task of the team holds values of the field, whoever's record scope it is in.
  const tasks = await tx
    .select()
    .from(records)
    .where(
      and(eq(records.teamId, ctx.principal.teamId), eq(records.kind, "task")),
    );
  const valid = validCustomValue({ ...existing, data } as DbRecord);
  for (const task of tasks) {
    const values = (task.data.customValues ?? {}) as Data;
    const value = existing ? values[existing.id] : undefined;
    if (
      (value !== undefined && !valid(value)) ||
      (!task.archivedAt && !valid(value))
    )
      throw new ApiError(
        409,
        "incompatible_custom_field",
        "This field change conflicts with saved tasks. Preserve existing values or make the field optional.",
      );
  }
}
async function uniqueChecks(
  tx: TeamTx,
  ctx: AccessContext,
  kind: RecordKind,
  data: Data,
  refs: Partial<RecordReferences>,
  existing?: DbRecord,
  archived = false,
) {
  // Team-wide like the unique indexes they mirror, so a conflict outside the caller's record scope
  // is still answered as a conflict.
  const conditions: SQL[] = [
    eq(records.teamId, ctx.principal.teamId),
    eq(records.kind, kind),
  ];
  if (existing) conditions.push(sql`${records.id} <> ${existing.id}`);
  let relevant = false;
  if (kind === "application" && !archived) {
    conditions.push(
      eq(records.candidateId, refs.candidateId!),
      eq(records.vacancyId, refs.vacancyId!),
      isNull(records.archivedAt),
    );
    relevant = true;
  }
  if (kind === "onboarding" && !archived) {
    conditions.push(
      eq(records.applicationId, refs.applicationId!),
      isNull(records.archivedAt),
    );
    relevant = true;
  }
  if (kind === "vacancy" && data.requisitionId) {
    conditions.push(
      sql`lower(${records.data}->>'requisitionId') = lower(${String(data.requisitionId)})`,
    );
    relevant = true;
  }
  if (["bucket", "task-field"].includes(kind) && !archived) {
    conditions.push(
      sql`lower(${records.data}->>'name') = lower(${String(data.name)})`,
      isNull(records.archivedAt),
    );
    relevant = true;
  }
  if (
    relevant &&
    (
      await tx
        .select({ id: records.id })
        .from(records)
        .where(and(...conditions))
        .limit(1)
    ).length
  )
    throw new ApiError(
      409,
      "duplicate_record",
      "A conflicting record already exists.",
    );
}
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}
/**
 * The owner of a stored idempotent response: tenant_context.context_actor_key() builds the same key
 * from the verified context, and the app.idempotency policy shows a context only its own rows.
 */
export function idempotencyActorKey(p: Principal) {
  return `${p.userId}:${p.authType}:${p.tokenId ?? "session"}`;
}
/**
 * Keys are never reused for different content, even after expiry. An expired
 * same-payload retry, or one under another role version than the response was
 * composed under, runs `reconcile` (or `work` when it cannot duplicate) and
 * renews the stored result in place. Every cached response returned passes
 * through `replay`, and every result is stored as `stored` shapes it.
 */
export async function idempotent<T>(
  tx: TeamTx,
  actor: Pick<AccessContext, "principal" | "access">,
  operation: string,
  key: string | undefined,
  payload: unknown,
  work: () => Promise<T>,
  reconcile?: (previous: unknown) => Promise<T>,
  replay?: (cached: T) => T | Promise<T>,
  stored: (result: T) => unknown = (result) => result,
): Promise<T> {
  if (!key) return work();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key))
    throw new ApiError(
      400,
      "invalid_idempotency_key",
      "Use an Idempotency-Key of 1–128 letters, digits, dots, underscores, colons or hyphens.",
    );
  const { principal: p } = actor;
  const roleVersionId = actor.access.roleVersionId ?? null;
  const actorKey = idempotencyActorKey(p);
  const payloadHash = createHash("sha256")
    .update(canonical(payload))
    .digest("hex");
  const where = and(
    eq(idempotency.teamId, p.teamId),
    eq(idempotency.actorKey, actorKey),
    eq(idempotency.operation, operation),
    eq(idempotency.key, key),
  );
  const [previous] = await tx.select().from(idempotency).where(where).limit(1);
  if (previous) {
    if (previous.payloadHash !== payloadHash)
      throw new ApiError(
        409,
        "idempotency_mismatch",
        "This Idempotency-Key was used with different content.",
      );
    // A row written before role versions were stored (null) counts as another version.
    if (
      previous.expiresAt > new Date() &&
      previous.roleVersionId !== null &&
      previous.roleVersionId === roleVersionId
    ) {
      const cached = previous.response as T;
      return replay ? replay(cached) : cached;
    }
    const result = reconcile
      ? await reconcile(previous.response)
      : await work();
    await tx
      .update(idempotency)
      .set({
        response: stored(result),
        roleVersionId,
        expiresAt: new Date(Date.now() + 7 * 86400000),
      })
      .where(where);
    return result;
  }
  const result = await work();
  await tx.insert(idempotency).values({
    teamId: p.teamId,
    actorKey,
    operation,
    key,
    payloadHash,
    response: stored(result),
    roleVersionId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 7 * 86400000),
  });
  return result;
}
function refsFor(
  input: Partial<RecordReferences>,
  existing?: DbRecord,
): RecordReferences {
  return Object.fromEntries(
    referenceFields.map((key) => [
      key,
      input[key] === undefined ? (existing?.[key] ?? null) : input[key],
    ]),
  ) as RecordReferences;
}

export async function getRecord(
  p: Principal,
  resource: ResourceName,
  recordId: string,
): Promise<RecordDto> {
  const kind = kindOf(resource);
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    authorize(ctx, { resource, action: "view" });
    id(recordId);
    return redact(
      ctx,
      (await decorate(tx, ctx, [dto(await find(tx, ctx, kind, recordId))]))[0],
    );
  });
}

/**
 * Kind and archive state of a record the caller can see in its team, for checks before a write.
 * A candidate is visible only with candidates:read, and a record outside the caller's record scope
 * for its kind not at all; otherwise it is answered as missing.
 */
export async function recordKindOf(
  p: Principal,
  recordId: string,
): Promise<{ kind: RecordKind; archived: boolean }> {
  id(recordId);
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    const inScope = anyRecordScopeRule(ctx, "records");
    const [row] = await tx
      .select({
        kind: records.kind,
        privateOwnerId: records.privateOwnerId,
        archivedAt: records.archivedAt,
      })
      .from(records)
      .where(
        and(
          eq(records.teamId, p.teamId),
          eq(records.id, recordId),
          ...(inScope ? [inScope] : []),
        ),
      )
      .limit(1);
    if (
      !row ||
      (row.kind === "saved-view" && row.privateOwnerId !== p.userId) ||
      (row.kind === "candidate" && !ctx.scopes.includes("candidates:read"))
    )
      throw new ApiError(404, "not_found", "Record not found in this team.");
    return { kind: row.kind as RecordKind, archived: !!row.archivedAt };
  });
}

export const candidateDuplicateQuerySchema = z
  .object({
    email: z.string().trim().max(320).optional(),
    phone: z.string().trim().max(100).optional(),
  })
  .strict()
  .refine(
    ({ email, phone }) =>
      Boolean(email || (phone || "").replace(/\D/g, "").length >= 7),
    "Enter an email or a phone number with at least seven digits.",
  );

/** Contact matches are possible duplicates for review, never an identity decision. */
export async function findCandidateDuplicates(p: Principal, input: unknown) {
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    authorize(ctx, { resource: "candidates", action: "view" });
    const query = parse(candidateDuplicateQuerySchema, input);
    // A hidden contact field is neither matched on nor returned.
    const hidden = hiddenKeys(ctx, "candidate");
    for (const key of ["email", "phone"] as const)
      if (query[key] && hidden.has(key))
        throw new ApiError(
          400,
          "invalid_query",
          `Your role cannot see ${key}, so you cannot filter by it.`,
        );
    const result = await matchCandidateContacts(tx, ctx, query);
    return {
      ...result,
      data: result.data.map(({ id, matches, ...contact }) => ({
        id,
        ...(Object.fromEntries(
          Object.entries(contact).filter(([key]) => !hidden.has(key)),
        ) as Partial<typeof contact>),
        matches: matches.filter((key) => !hidden.has(key)),
      })),
    };
  });
}

/** Most suggestions per field. */
export const CANDIDATE_SUGGESTION_LIMIT = 200;
/**
 * The team's skill and certification values on active candidates, for the filter inputs. Values
 * that differ only in case or surrounding spaces are one entry shown in their most common spelling
 * (ties: the alphabetically first), ordered by how many candidates hold them. Aggregated in
 * PostgreSQL; no other candidate field is read.
 */
export async function candidateSuggestions(
  p: Principal,
  query: URLSearchParams,
): Promise<{ skills: string[]; certifications: string[] }> {
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    authorize(ctx, { resource: "candidates", action: "view" });
    if ([...query.keys()].length)
      throw new ApiError(
        400,
        "invalid_query",
        "Suggestions take no query parameters.",
      );
    const result = await tx.execute<{ field: string; label: string }>(
      sql`with tags as(select distinct f.field, ${records.id} as id, btrim(tag.value) as spelling from ${records}
        cross join (values ('skills'), ('certifications')) f(field)
        cross join lateral jsonb_array_elements_text(case when jsonb_typeof(${records.data}->f.field)='array' then ${records.data}->f.field else '[]'::jsonb end) tag(value)
        where ${and(...scopeFilter(ctx, "candidate", { once: true }))} and ${records.archivedAt} is null and btrim(tag.value)<>''),
      spellings as(select field, lower(spelling) as value, spelling, count(*) as holders from tags group by field, lower(spelling), spelling),
      labels as(select distinct on (field, value) field, value, spelling as label from spellings order by field, value, holders desc, spelling collate "C"),
      totals as(select field, lower(spelling) as value, count(distinct id) as holders from tags group by field, lower(spelling)),
      ranked as(select l.field, l.label, row_number() over(partition by l.field order by t.holders desc, lower(l.label), l.label collate "C") as position from labels l join totals t on t.field=l.field and t.value=l.value)
      select field, label from ranked where position<=${CANDIDATE_SUGGESTION_LIMIT} order by field, position`,
    );
    // A field the caller may not see suggests nothing.
    const hidden = hiddenKeys(ctx, "candidate");
    const values = (field: string) =>
      hidden.has(field)
        ? []
        : result.rows
            .filter((row) => row.field === field)
            .map((row) => row.label);
    return {
      skills: values("skills"),
      certifications: values("certifications"),
    };
  });
}

/**
 * The contact match behind findCandidateDuplicates, inside the caller's transaction: lower-cased
 * email or digits-only phone of at least seven digits. Without either it matches nothing.
 */
export async function matchCandidateContacts(
  tx: TeamTx,
  ctx: AccessContext,
  query: { email?: string; phone?: string },
) {
  const email = query.email?.toLowerCase() || "";
  const phone = (query.phone || "").replace(/\D/g, "");
  const predicates: SQL[] = [];
  if (email)
    predicates.push(sql`lower(trim(${records.data}->>'email')) = ${email}`);
  if (phone.length >= 7)
    predicates.push(
      sql`regexp_replace(coalesce(${records.data}->>'phone', ''), '[^0-9]', '', 'g') = ${phone}`,
    );
  if (!predicates.length) return { data: [], limited: false };
  const rows = await tx
    .select({ id: records.id, data: records.data })
    .from(records)
    .where(and(...scopeFilter(ctx, "candidate"), or(...predicates)))
    .orderBy(asc(records.id))
    .limit(CANDIDATE_DUPLICATE_LIMIT + 1);
  const data = rows.slice(0, CANDIDATE_DUPLICATE_LIMIT).map((row) => {
    const storedEmail =
      typeof row.data.email === "string" ? row.data.email : "";
    const storedPhone =
      typeof row.data.phone === "string" ? row.data.phone : "";
    return {
      id: row.id,
      name: typeof row.data.name === "string" ? row.data.name : "",
      email: storedEmail,
      phone: storedPhone,
      matches: [
        ...(email && storedEmail.trim().toLowerCase() === email
          ? ["email"]
          : []),
        ...(phone.length >= 7 && storedPhone.replace(/\D/g, "") === phone
          ? ["phone"]
          : []),
      ],
    };
  });
  return { data, limited: rows.length > CANDIDATE_DUPLICATE_LIMIT };
}

/** Every list query key; an export takes the filter keys plus sort and direction. */
const LIST_QUERY_KEYS = [
  "page",
  "pageSize",
  "search",
  "includeArchived",
  "archived",
  "legacyId",
  "sort",
  "direction",
  "shortlisted",
  "needsReview",
  "categories",
  "skills",
  "certifications",
  "education",
  "minYearsExperience",
  "maxYearsExperience",
  "startFrom",
  "startTo",
  ...referenceFields,
  "applicationCandidateId",
  "status",
  "stage",
  "department",
  "residenceEmirate",
  "folderCategory",
  "owner",
  "priority",
  "type",
  "category",
  "reviewStatus",
  "degreeLevel",
  "employmentType",
  "workMode",
  "area",
  "assignedToMe",
  "board",
] as const;
/**
 * Keep in step with the key list in tenant_context.audit_export (drizzle/0013_export_audit.sql).
 * assignedToMe and board are list-only, so an export refuses them as unsupported filters.
 */
export const EXPORT_FILTER_KEYS: readonly string[] = LIST_QUERY_KEYS.filter(
  (key) =>
    ![
      "page",
      "pageSize",
      "sort",
      "direction",
      "assignedToMe",
      "board",
    ].includes(key),
);
/**
 * Filters on the exporter's own private state, left out of the team-visible export audit so it
 * never shows that someone filtered by them: `shortlisted` is always the caller's personal
 * shortlist, and on candidates `status` is the caller's personal follow-up status. They still
 * filter the rows; on every other resource `status` is a shared field and stays audited.
 */
export const PRIVATE_EXPORT_FILTER_KEYS: Readonly<
  Record<"all" | "candidates", readonly string[]>
> = { all: ["shortlisted"], candidates: ["shortlisted", "status"] };
/** Most rows one export may hold; a larger match is refused, never cut short. */
export const EXPORT_LIMIT = 100000;
/**
 * The fields each list filter reads, so a filter on a field the caller may not see is refused
 * (R2b-08). status on candidates is the caller's private follow-up state and reads no field.
 */
const FILTER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(
    [
      "status",
      "stage",
      "department",
      "residenceEmirate",
      "owner",
      "priority",
      "type",
      "category",
      "reviewStatus",
      "degreeLevel",
      "employmentType",
      "workMode",
      "area",
      "skills",
      "certifications",
    ].map((key) => [key, [key]]),
  ),
  needsReview: ["reviewStatus"],
  folderCategory: ["folderCategories"],
  categories: ["folderCategories"],
  education: ["degreeName", "major", "university"],
  minYearsExperience: ["yearsExperience"],
  maxYearsExperience: ["yearsExperience"],
  startFrom: ["startAt"],
  startTo: ["startAt"],
  legacyId: ["legacyId"],
};
/** The default sort of each kind when the query names none. */
const defaultSort = (kind: RecordKind) =>
  kind === "candidate"
    ? "name"
    : ["bucket", "task-field"].includes(kind)
      ? "position"
      : "createdAt";

/** Validates a list or export query and builds its filter and order, so both share one filter SQL. */
function recordQuery(
  ctx: AccessContext,
  kind: RecordKind,
  query: URLSearchParams,
  allowed: readonly string[],
  options: { omitFromSearch?: readonly string[] } = {},
) {
  const { principal: p } = ctx;
  for (const key of query.keys())
    if (!allowed.includes(key) || query.getAll(key).length > 1)
      throw new ApiError(
        400,
        "invalid_query",
        `Unsupported or repeated filter: ${key}.`,
      );
  // A filter or sort that reads a field the caller may not see is refused before any other check.
  const hidden = hiddenKeys(ctx, kind);
  for (const [key, value] of query.entries()) {
    const field = Object.hasOwn(FILTER_FIELDS, key)
      ? FILTER_FIELDS[key].find((name) => hidden.has(name))
      : undefined;
    if (
      field &&
      !(kind === "candidate" && key === "status") &&
      !["", "[]"].includes(value.trim())
    )
      throw new ApiError(
        400,
        "invalid_query",
        `Your role cannot see ${field}, so you cannot filter by it.`,
      );
  }
  const search = parse(z.string().trim().max(500), query.get("search") ?? "");
  const order = parse(z.enum(["asc", "desc"]), query.get("direction") || "asc");
  const sort = parse(
    z.enum([
      "name",
      "title",
      "createdAt",
      "updatedAt",
      "yearsExperience",
      "position",
    ]),
    // Without a sort, a default key the caller may not see gives way to createdAt.
    query.get("sort") ||
      (hidden.has(defaultSort(kind)) ? "createdAt" : defaultSort(kind)),
  );
  if (hidden.has(sort))
    throw new ApiError(
      400,
      "invalid_query",
      `Your role cannot see ${sort}, so you cannot sort by it.`,
    );
  const where: SQL[] = scopeFilter(ctx, kind, { once: true });
  if (query.has("includeArchived"))
    parse(z.enum(["true", "false"]), query.get("includeArchived"));
  if (query.has("archived")) {
    const archived = parse(z.enum(["true", "false"]), query.get("archived"));
    where.push(
      archived === "true"
        ? sql`${records.archivedAt} is not null`
        : isNull(records.archivedAt),
    );
  } else if (query.get("includeArchived") !== "true")
    where.push(isNull(records.archivedAt));
  for (const key of referenceFields)
    if (query.get(key)) where.push(eq(records[key], id(query.get(key))));
  if (query.has("applicationCandidateId")) {
    if (!["interview", "offer", "onboarding"].includes(kind))
      throw new ApiError(
        400,
        "invalid_query",
        "applicationCandidateId applies only to interviews, offers and onboarding.",
      );
    const candidateId = query.get("applicationCandidateId");
    if (!uuidSchema.safeParse(candidateId).success)
      throw new ApiError(
        400,
        "invalid_query",
        "applicationCandidateId must be a record ID.",
      );
    where.push(
      sql`exists (select 1 from ${records} a where a.team_id = ${p.teamId} and a.kind = 'application' and a.id = ${records.applicationId} and a.candidate_id = ${candidateId})`,
    );
  }
  if (query.get("legacyId"))
    where.push(
      eq(records.legacyId, parse(z.string().max(200), query.get("legacyId"))),
    );
  if (query.has("startFrom") || query.has("startTo")) {
    if (kind !== "interview")
      throw new ApiError(
        400,
        "invalid_query",
        "Start-time ranges apply only to interviews.",
      );
    const from = query.has("startFrom")
      ? parse(z.iso.datetime({ offset: true }), query.get("startFrom"))
      : null;
    const to = query.has("startTo")
      ? parse(z.iso.datetime({ offset: true }), query.get("startTo"))
      : null;
    if (from && to && new Date(from) > new Date(to))
      throw new ApiError(
        400,
        "invalid_query",
        "Range start must precede its end.",
      );
    if (from)
      where.push(
        sql`(${records.data}->>'startAt')::timestamptz >= ${from}::timestamptz`,
      );
    if (to)
      where.push(
        sql`(${records.data}->>'startAt')::timestamptz < ${to}::timestamptz`,
      );
  }
  if (query.has("shortlisted")) {
    if (kind !== "candidate")
      throw new ApiError(
        400,
        "invalid_query",
        "Shortlist is a personal candidate filter.",
      );
    const selected =
      parse(z.enum(["true", "false"]), query.get("shortlisted")) === "true";
    const matching = sql`exists (select 1 from ${candidateStates} where ${candidateStates.teamId} = ${p.teamId} and ${candidateStates.userId} = ${p.userId} and ${candidateStates.candidateId} = ${records.id} and ${candidateStates.shortlisted} = true)`;
    where.push(selected ? matching : sql`not (${matching})`);
  }
  if (query.has("assignedToMe")) {
    const value = query.get("assignedToMe");
    if (kind !== "task" || (value !== "true" && value !== "false"))
      throw new ApiError(
        400,
        "invalid_query",
        "assignedToMe applies only to tasks and takes true or false.",
      );
    const assigned = sql`exists (select 1 from ${recordAssignments} where ${recordAssignments.teamId} = ${p.teamId} and ${recordAssignments.recordId} = ${records.id} and ${recordAssignments.userId} = ${p.userId} and ${recordAssignments.relation} = 'assignee')`;
    where.push(value === "true" ? assigned : sql`not (${assigned})`);
  }
  // A task board of the caller's team, from the documents install returned: its columns and filter
  // join the conditions above, record scope included.
  if (query.has("board")) {
    const board =
      kind === "task"
        ? publishedTaskBoards(ctx).find(
            (item) => item.id === query.get("board"),
          )
        : undefined;
    if (!board)
      throw new ApiError(
        400,
        "invalid_query",
        "board must name a current task board of this team, on tasks only.",
      );
    where.push(inArray(records.bucketId, board.columns));
    const { filter } = board;
    if (filter?.by === "vacancy")
      where.push(eq(records.vacancyId, filter.vacancyId));
    if (filter?.by === "linked-record")
      where.push(eq(records.parentRecordId, filter.recordId));
    if (filter?.by === "field")
      where.push(
        sql`${records.data}->'customValues'->>${filter.fieldId} = ${filter.value}`,
      );
  }
  if (query.has("needsReview")) {
    if (kind !== "candidate")
      throw new ApiError(
        400,
        "invalid_query",
        "Review filters apply only to candidates.",
      );
    const needsReview =
      parse(z.enum(["true", "false"]), query.get("needsReview")) === "true";
    const reviewed = sql`coalesce(${records.data}->>'reviewStatus','') ~* '^(verified|reviewed|complete|completed)$'`;
    where.push(needsReview ? sql`not (${reviewed})` : reviewed);
  }
  if (
    query.get("reviewStatus") &&
    !z.enum(REVIEW_STATUSES).safeParse(query.get("reviewStatus")).success
  )
    throw new ApiError(
      400,
      "invalid_query",
      `reviewStatus must be ${REVIEW_STATUSES.map((value) => `"${value}"`).join(" or ")}.`,
    );
  for (const key of [
    "status",
    "stage",
    "department",
    "residenceEmirate",
    "owner",
    "priority",
    "type",
    "category",
    "reviewStatus",
    "degreeLevel",
    "employmentType",
    "workMode",
    "area",
  ]) {
    if (query.get(key)) {
      const value = parse(z.string().trim().max(300), query.get(key));
      if (kind === "candidate" && key === "status") {
        where.push(
          sql`coalesce((select ${candidateStates.status} from ${candidateStates} where ${candidateStates.teamId} = ${p.teamId} and ${candidateStates.userId} = ${p.userId} and ${candidateStates.candidateId} = ${records.id}), 'New') = ${value}`,
        );
      } else where.push(sql`${records.data}->>${key} = ${value}`);
    }
  }
  if (query.get("folderCategory"))
    where.push(
      sql`(${records.data}->'folderCategories') @> ${JSON.stringify([parse(z.string().max(200), query.get("folderCategory"))])}::jsonb`,
    );
  for (const key of [
    "education",
    "minYearsExperience",
    "maxYearsExperience",
  ] as const)
    if (query.has(key) && kind !== "candidate")
      throw new ApiError(
        400,
        "invalid_query",
        "Education and experience filters apply only to candidates.",
      );
  if (query.has("education")) {
    const value = parse(z.string().trim().max(300), query.get("education"));
    if (value)
      where.push(
        or(
          ...["degreeName", "major", "university"].map(
            (field) =>
              sql`strpos(lower(coalesce(${records.data}->>${field}, '')), lower(${value})) > 0`,
          ),
        )!,
      );
  }
  // Only a stated JSON number is in range; missing experience never matches.
  const years = (key: string) => {
    const raw = query.get(key);
    if (raw === null) return null;
    const value = Number(raw);
    if (!raw.trim() || !Number.isFinite(value) || value < 0 || value > 100)
      throw new ApiError(
        400,
        "invalid_query",
        `${key} must be a number from 0 to 100.`,
      );
    return value;
  };
  const minYears = years("minYearsExperience");
  const maxYears = years("maxYearsExperience");
  if (minYears !== null && maxYears !== null && minYears > maxYears)
    throw new ApiError(
      400,
      "invalid_query",
      "minYearsExperience must not exceed maxYearsExperience.",
    );
  const stated = sql`(case when jsonb_typeof(${records.data}->'yearsExperience') = 'number' then (${records.data}->>'yearsExperience')::numeric end)`;
  if (minYears !== null) where.push(sql`${stated} >= ${minYears}::numeric`);
  if (maxYears !== null) where.push(sql`${stated} <= ${maxYears}::numeric`);
  for (const key of ["categories", "skills", "certifications"] as const)
    if (query.has(key)) {
      if (kind !== "candidate")
        throw new ApiError(
          400,
          "invalid_query",
          "Skill, certification and folder category filters apply only to candidates.",
        );
      let value: unknown;
      try {
        value = JSON.parse(query.get(key)!);
      } catch {
        throw new ApiError(
          400,
          "invalid_query",
          `${key} must be a JSON array.`,
        );
      }
      const values = parse(
        z.array(z.string().trim().min(1).max(200)).max(100),
        value,
      );
      // All of these values, each equal to a stored value after trimming and ignoring case. A
      // missing or non-array field reads as an empty list, so it never matches and never errors.
      if (values.length && (key === "skills" || key === "certifications"))
        where.push(
          sql`not exists(select 1 from jsonb_array_elements_text(${JSON.stringify(values)}::jsonb) wanted(value) where not exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(${records.data}->${key})='array' then ${records.data}->${key} else '[]'::jsonb end) stored(value) where lower(btrim(stored.value))=lower(wanted.value)))`,
        );
      if (values.length && key === "categories")
        where.push(
          sql`exists(select 1 from jsonb_array_elements_text(${records.data}->'folderCategories') category(value) where ${inArray(sql`category.value`, values)})`,
        );
    }
  // jsonpath extracts scalar values only. JSON property names are never searchable candidate facts.
  // Top-level keys in omitFromSearch and the keys the caller may not see are removed first, so words
  // neither match nor exclude on them; a hidden custom field id removes its customValues entry.
  const hiddenCustom = [...hidden].filter(
    (key) => uuidSchema.safeParse(key).success,
  );
  const omitted = [
    ...new Set([
      ...(options.omitFromSearch ?? []),
      ...[...hidden].filter((key) => !hiddenCustom.includes(key)),
    ]),
  ];
  let searched: SQL = omitted.length
    ? sql`(${records.data} - array[${sql.join(
        omitted.map((key) => sql`${key}`),
        sql`, `,
      )}]::text[])`
    : sql`${records.data}`;
  for (const key of hiddenCustom)
    searched = sql`(${searched} #- ${`{customValues,${key}}`}::text[])`;
  const ownFacts = sql`jsonb_path_query_array(${searched}, '$.** ? (@.type() == "string" || @.type() == "number" || @.type() == "boolean")')::text`;
  // A parent's facts are only the fields of its kind the caller may see.
  const facts = (alias: string, parent: RecordKind, keys: string[]) => {
    const parentHidden = hiddenKeys(ctx, parent);
    const visible = keys.filter((key) => !parentHidden.has(key));
    return visible.length
      ? sql.raw(
          `concat_ws(' ',${visible.map((key) => `${alias}.data->>'${key}'`).join(",")})`,
        )
      : sql`''`;
  };
  // The application search reads a parent's facts only where the caller may view that kind and the
  // parent is in their record scope.
  const parentFacts = (
    alias: string,
    parent: "vacancy" | "candidate",
    keys: string[],
    reference: SQL,
  ) => {
    if (
      !decide(ctx, {
        resource: parent === "vacancy" ? "vacancies" : "candidates",
        action: "view",
      })
    )
      return sql`''`;
    const rule = recordScopeRule(ctx, parent, alias);
    return sql`(select ${facts(alias, parent, keys)} from ${records} ${sql.raw(alias)} where ${sql.raw(`${alias}.team_id`)}=${p.teamId} and ${sql.raw(`${alias}.kind='${parent}' and ${alias}.id`)}=${reference}${rule ? sql` and ${rule}` : sql``})`;
  };
  const factual =
    kind === "application"
      ? sql`concat_ws(' ',${ownFacts},
      ${parentFacts("v", "vacancy", ["title", "department"], sql`${records.vacancyId}`)},
      ${parentFacts("c", "candidate", ["name", "email", "jobTitle"], sql`${records.candidateId}`)})`
      : ownFacts;
  for (const term of searchTerms(search)) {
    const position = sql`strpos(lower(${factual}),lower(${term.value}))`;
    where.push(term.excluded ? sql`${position}=0` : sql`${position}>0`);
  }
  const expression = ["createdAt", "updatedAt"].includes(sort)
    ? records[sort as "createdAt" | "updatedAt"]
    : ["yearsExperience", "position"].includes(sort)
      ? sql`nullif(${records.data}->>${sort}, '')::numeric`
      : sql`lower(${records.data}->>${sort})`;
  return {
    condition: and(...where),
    orderBy: [
      order === "asc" ? asc(expression) : desc(expression),
      asc(records.id),
    ],
  };
}

export async function listRecords(
  p: Principal,
  resource: ResourceName,
  query: URLSearchParams,
  options: { omitFromSearch?: readonly string[] } = {},
) {
  kindOf(resource);
  return withTeam(p, (tx, access) =>
    listInside(tx, accessContext(p, access), resource, query, options),
  );
}

/** One list page inside the caller's transaction, so several lists can share it (search). */
export async function listInside(
  tx: TeamTx,
  ctx: AccessContext,
  resource: ResourceName,
  query: URLSearchParams,
  options: { omitFromSearch?: readonly string[] } = {},
) {
  const kind = kindOf(resource);
  authorize(ctx, { resource, action: "view" });
  const { condition, orderBy } = recordQuery(
    ctx,
    kind,
    query,
    LIST_QUERY_KEYS,
    options,
  );
  const page = parse(
    z.coerce.number().int().min(1).max(1000000),
    query.get("page") || 1,
  );
  const pageSize = parse(
    z.coerce.number().int().min(1).max(100),
    query.get("pageSize") || 30,
  );
  // The page carries the matching total; only an empty page past the first needs its own count.
  const rows = await tx
    .select({
      record: readColumns(ctx),
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(records)
    .where(condition)
    .orderBy(...orderBy)
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const total =
    rows[0]?.total ??
    (page > 1
      ? (await tx.select({ total: count() }).from(records).where(condition))[0]
          .total
      : 0);
  return {
    data: (
      await decorate(
        tx,
        ctx,
        rows.map((row) => dto(row.record)),
      )
    ).map((row) => redact(ctx, row)),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

/**
 * Every matching record and one audit row, in one transaction. A count bounded at EXPORT_LIMIT + 1
 * refuses an oversized match before any row is loaded. Rows and total then come from one statement,
 * so the file and its Rows count agree; its recheck catches rows added between the two statements.
 * The audit names applied filter keys, never values, and leaves out PRIVATE_EXPORT_FILTER_KEYS.
 * Rows are redacted, and `hidden` names the keys of the kind the caller may not see, so the file
 * leaves out their columns; `schema` is the kind schema body in force, whose fields the columns
 * follow.
 */
export async function exportRecords(
  p: Principal,
  resource: string,
  query: URLSearchParams,
): Promise<{
  resource: ExportResource;
  rows: RecordDto[];
  total: number;
  hidden: Set<string>;
  schema: KindSchemaBody;
}> {
  if (!(EXPORT_RESOURCES as readonly string[]).includes(resource))
    throw new ApiError(404, "not_found", "Unknown resource.");
  const name = resource as ExportResource;
  const kind = kindOf(name);
  const privateKeys =
    PRIVATE_EXPORT_FILTER_KEYS[name === "candidates" ? "candidates" : "all"];
  const filters = [...query.entries()]
    .filter(
      ([key, value]) =>
        EXPORT_FILTER_KEYS.includes(key) &&
        !privateKeys.includes(key) &&
        !["", "[]"].includes(value.trim()),
    )
    .map(([key]) => key)
    .sort();
  const tooLarge = () =>
    new ApiError(
      400,
      "export_too_large",
      "This export is too large. Narrow your filters.",
    );
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    authorize(ctx, { page: name, resource: name, action: "export" });
    if (query.has("page") || query.has("pageSize"))
      throw new ApiError(
        400,
        "invalid_query",
        "An export covers every matching record; remove page and pageSize.",
      );
    const { condition, orderBy } = recordQuery(ctx, kind, query, [
      ...EXPORT_FILTER_KEYS,
      "sort",
      "direction",
    ]);
    const [matching] = await tx.select({ total: count() }).from(
      tx
        .select({ id: records.id })
        .from(records)
        .where(condition)
        .limit(EXPORT_LIMIT + 1)
        .as("matching"),
    );
    if ((matching?.total ?? 0) > EXPORT_LIMIT) throw tooLarge();
    const rows = await tx
      .select({
        record: records,
        total: sql<number>`count(*) over ()`.mapWith(Number),
      })
      .from(records)
      .where(condition)
      .orderBy(...orderBy)
      .limit(EXPORT_LIMIT);
    const total = rows[0]?.total ?? 0;
    if (total > EXPORT_LIMIT) throw tooLarge();
    await tx.execute(
      sql`select tenant_context.audit_export(${name}::text, ${total}::integer, array[${sql.join(
        filters.map((key) => sql`${key}`),
        sql`, `,
      )}]::text[])`,
    );
    return {
      resource: name,
      rows: rows.map((row) => redact(ctx, dto(row.record))),
      total,
      hidden: hiddenKeys(ctx, kind),
      // Every export resource is a configurable kind.
      schema: kindSchemaOf(ctx, kind)!.body,
    };
  });
}

/** A task's assigneeIds apart from the data it stores, which never holds the key. */
function withoutAssignees(input: Data): {
  data: Data;
  assigneeIds?: string[];
} {
  const { assigneeIds, ...data } = input;
  return { data, assigneeIds: assigneeIds as string[] | undefined };
}
/**
 * Applies a task's assignee changes in one statement through the job 060 helpers, which check the
 * write context, the record scope, team membership and self-assignment again and write one activity
 * row per change. Only the assignee relation is touched; a refusal rolls back the whole write and
 * names assigneeIds.
 */
async function changeAssignees(
  tx: TeamTx,
  recordId: string,
  before: string[],
  after: string[],
) {
  const removed = before.filter((userId) => !after.includes(userId));
  const added = after.filter((userId) => !before.includes(userId));
  if (!removed.length && !added.length) return;
  try {
    await tx.execute(
      sql`select tenant_context.remove_assignment(${recordId}::uuid, u, 'assignee') from unnest(${sql.param(removed)}::text[]) u union all select tenant_context.add_assignment(${recordId}::uuid, u, 'assignee') from unnest(${sql.param(added)}::text[]) u`,
    );
  } catch (error) {
    assignmentRefusal(error, "assigneeIds");
  }
}

/**
 * `auditMetadata` joins the created event's metadata, for evidence such as bulk intake review.
 * `members` are the person values confirmed as team members (withMembers); without them, any added
 * person value is refused, so a caller inside another transaction never reads the identity pool.
 */
export async function createInside(
  tx: TeamTx,
  ctx: AccessContext,
  kind: RecordKind,
  input: WriteInput,
  imported: boolean,
  auditMetadata: Data = {},
  members: Members = new Set(),
): Promise<RecordDto> {
  const { principal: p } = ctx;
  validateRelations(kind, input.data);
  if (kind === "vacancy" && input.data.jobTitleKey !== undefined)
    requireJobTitle(ctx.access, String(input.data.jobTitleKey));
  const allowArchived =
    imported && (input.archived === true || kind === "comment");
  await checkReferences(tx, ctx, kind, input, undefined, allowArchived);
  const refs = refsFor(input);
  await uniqueChecks(
    tx,
    ctx,
    kind,
    input.data,
    refs,
    undefined,
    !!input.archived,
  );
  const schema = kindSchemaOf(ctx, kind);
  const changed =
    kind === "task"
      ? await checkCustomValues(
          tx,
          ctx,
          schema!,
          input.data,
          undefined,
          imported,
        )
      : schema && checkKindValues(schema, input.data, undefined, imported);
  if (changed)
    await checkFieldReferences(
      tx,
      ctx,
      schema!,
      changed,
      members,
      allowArchived,
    );
  if (kind === "task-field")
    await checkFieldCompatibility(
      tx,
      ctx,
      undefined,
      input.data,
      !!input.archived,
    );
  if (
    input.legacyId &&
    (
      await tx
        .select({ id: records.id })
        .from(records)
        .where(
          and(
            eq(records.teamId, p.teamId),
            eq(records.kind, kind),
            eq(records.legacyId, input.legacyId),
          ),
        )
        .limit(1)
    ).length
  )
    throw new ApiError(
      409,
      "duplicate_legacy_id",
      "This source record was already imported.",
    );
  if (kind === "application" && !input.data.appliedDate && !imported)
    input.data.appliedDate = dubaiToday();
  const { data, assigneeIds } = withoutAssignees(input.data);
  const now = new Date();
  const [row] = await unitChecked(
    ctx,
    tx
      .insert(records)
      .values({
        id: randomUUID(),
        teamId: p.teamId,
        kind,
        data,
        ...refs,
        version: 1,
        legacyId: input.legacyId ?? null,
        importMeta: input.importMeta ?? {},
        privateOwnerId: kind === "saved-view" ? p.userId : null,
        createdBy: p.userId,
        createdAt: now,
        updatedAt: now,
        archivedAt: input.archived ? now : null,
        orgUnitId: input.orgUnitId ?? null,
        schemaVersionId: schema?.versionId ?? null,
        // An offer for a vacancy with a job title keeps the bracket version published when it
        // was made, in this statement; tenant_context.published_bracket_version returns an id only.
        payBracketVersionId:
          kind === "offer" && !imported
            ? sql`(select tenant_context.published_bracket_version() from ${records} a join ${records} v on v.team_id = a.team_id and v.id = a.vacancy_id where a.team_id = ${p.teamId} and a.id = ${refs.applicationId}::uuid and v.data->>'jobTitleKey' is not null)`
            : null,
      })
      .returning(readColumns(ctx)),
  );
  await audit(
    tx,
    p,
    row,
    imported ? "imported" : "created",
    {
      ...(kind === "application" && !imported
        ? { fromStage: null, toStage: input.data.stage }
        : kind === "offer" && !imported
          ? { fromStatus: null, toStatus: input.data.status }
          : {}),
      ...auditMetadata,
    },
    imported,
  );
  if (assigneeIds === undefined) return dto(row);
  await changeAssignees(tx, row.id, [], assigneeIds);
  return dto({ ...row, assigneeIds: [...assigneeIds].sort() });
}

export function createRecord(
  p: Principal,
  resource: ResourceName,
  raw: unknown,
  idempotencyKey?: string,
): Promise<RecordDto> {
  return withMembers(p, (members) =>
    createOnce(p, resource, raw, idempotencyKey, members),
  );
}
/** One attempt of createRecord, with the members withMembers confirmed or "ask". */
async function createOnce(
  p: Principal,
  resource: ResourceName,
  raw: unknown,
  idempotencyKey: string | undefined,
  members: Members,
): Promise<RecordDto> {
  const kind = kindOf(resource);
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    authorize(ctx, { resource, action: "create" });
    const input = parse(createRecordSchemas[kind], raw) as WriteInput;
    // A field the role hides or makes read-only is refused before any statement; with an
    // Idempotency-Key only when the create runs, so a retry of a create made under an earlier role
    // still answers with its record.
    const checkFields = () => checkFieldWrite(ctx, kind, sentKeys(raw));
    if (!idempotencyKey) checkFields();
    const imported = importedInput(
      ctx,
      resource,
      kind,
      input,
      (raw as { data: Data }).data,
    );
    await lockTeam(tx, p);
    // The record's current state, including archived records; never a second create.
    const current = async (previous: unknown) => {
      const recordId = (previous as { id?: unknown } | null)?.id;
      const [row] = uuidSchema.safeParse(recordId).success
        ? await tx
            .select(readColumns(ctx))
            .from(records)
            .where(
              and(
                ...scopeFilter(ctx, kind),
                eq(records.id, recordId as string),
              ),
            )
            .limit(1)
        : [];
      if (!row)
        throw new ApiError(
          409,
          "idempotency_expired",
          "This Idempotency-Key has expired and its original record is no longer available. Search for the record before creating it again.",
        );
      // Without the read scope, return the original snapshot rather than later edits.
      if (
        !ctx.scopes.includes(
          resource === "candidates" ? "candidates:read" : "recruitment:read",
        )
      )
        return redact(ctx, previous as RecordDto);
      return redact(ctx, (await decorate(tx, ctx, [dto(row)]))[0]);
    };
    return idempotent(
      tx,
      ctx,
      `create:${resource}`,
      idempotencyKey,
      input,
      async () => {
        if (idempotencyKey) checkFields();
        return redact(
          ctx,
          (
            await decorate(tx, ctx, [
              await createInside(tx, ctx, kind, input, imported, {}, members),
            ])
          )[0],
        );
      },
      current,
      // A linked record's label is never kept: erasure may scrub it (a task title naming an erased
      // candidate) with no erased id beside it in the cached response, so a replay of a linked
      // task is recomposed from the current state instead.
      (cached) =>
        kind === "task" && cached.parentRecordId
          ? current(cached)
          : redact(ctx, cached),
      ({ parentKind: _kind, parentLabel: _label, ...kept }) => kept,
    );
  });
}

/**
 * `options.comment` appends a comment on the record in the same transaction, after the update and
 * its audit row; if the comment cannot be written, nothing changes. REST and the UI never pass it.
 */
export function updateRecord(
  p: Principal,
  resource: ResourceName,
  recordId: string,
  raw: unknown,
  options: { comment?: string } = {},
): Promise<RecordDto & { commentId?: string }> {
  return withMembers(p, (members) =>
    updateOnce(p, resource, recordId, raw, options, members),
  );
}
/** One attempt of updateRecord, with the members withMembers confirmed or "ask". */
async function updateOnce(
  p: Principal,
  resource: ResourceName,
  recordId: string,
  raw: unknown,
  options: { comment?: string },
  members: Members,
): Promise<RecordDto & { commentId?: string }> {
  const kind = kindOf(resource);
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    authorize(ctx, { resource, action: "edit" });
    id(recordId);
    if (kind === "comment")
      throw new ApiError(
        405,
        "append_only",
        "Comments are append-only. Add a new comment instead.",
      );
    const patch = parse(
      updateRecordSchemas[kind],
      raw,
    ) as Partial<WriteInput> & {
      version: number;
    };
    checkFieldWrite(ctx, kind, sentKeys(raw));
    if (patch.moveToBucketId && !(kind === "bucket" && patch.archived === true))
      throw new ApiError(
        400,
        "invalid_move",
        "A destination is only valid when archiving a bucket.",
      );
    await lockTeam(tx, p);
    const existing = await find(tx, ctx, kind, recordId, true);
    if (existing.version !== patch.version)
      throw new ApiError(
        409,
        "version_conflict",
        "This record changed. Refresh it and review your draft before saving.",
      );
    const schema = kindSchemaOf(ctx, kind);
    const sent = patch.data?.customValues as Data | undefined;
    const data = parse(recordDataSchemas[kind], {
      ...existing.data,
      ...patch.data,
      ...(schema && sent
        ? {
            customValues: keptCustomValues(
              schema,
              existing,
              sent,
              new Set([...hiddenKeys(ctx, kind), ...readOnlyKeys(ctx, kind)]),
            ),
          }
        : {}),
    }) as Data;
    const input = { ...patch, data };
    const imported = importedInput(
      ctx,
      resource,
      kind,
      input,
      patch.data ?? {},
    );
    const archived = patch.archived ?? !!existing.archivedAt;
    const restoring = !!existing.archivedAt && !archived;
    validateRelations(kind, data);
    // Only a changed key, so a title removed by a later publish never blocks an unrelated edit.
    if (
      kind === "vacancy" &&
      data.jobTitleKey !== undefined &&
      data.jobTitleKey !== existing.data.jobTitleKey
    )
      requireJobTitle(ctx.access, String(data.jobTitleKey));
    await checkReferences(
      tx,
      ctx,
      kind,
      patch,
      existing,
      imported && archived,
      restoring,
    );
    const refs = refsFor(patch, existing);
    await uniqueChecks(tx, ctx, kind, data, refs, existing, archived);
    const changed =
      kind === "task"
        ? await checkCustomValues(tx, ctx, schema!, data, existing, imported)
        : schema && checkKindValues(schema, data, existing, imported);
    if (changed)
      await checkFieldReferences(
        tx,
        ctx,
        schema!,
        changed,
        members,
        imported && archived,
        existing.id,
      );
    if (kind === "task-field")
      await checkFieldCompatibility(tx, ctx, existing, data, archived);
    const now = new Date();
    if (kind === "bucket" && !existing.archivedAt && archived) {
      // Row-level security (0038) hides other members' tasks from a caller whose task scope is not
      // all, so such a caller could leave tasks it cannot see in the archived bucket. It is refused
      // before any task is read, so the refusal says nothing about the bucket's tasks.
      if (recordScopeRule(ctx, "task", "records"))
        throw new ApiError(
          403,
          "forbidden",
          "Your role sees only some tasks, so you cannot archive a bucket. Ask a colleague who sees all tasks.",
        );
      const active = await tx
        .select()
        .from(records)
        .where(and(...scopeFilter(ctx, "bucket"), isNull(records.archivedAt)));
      if (active.length < 2)
        throw new ApiError(
          409,
          "last_bucket",
          "Keep at least one active workflow bucket.",
        );
      // Team-wide like uniqueChecks: every active task of the bucket moves, whoever's it is.
      const tasks = await tx
        .select()
        .from(records)
        .where(
          and(
            eq(records.teamId, p.teamId),
            eq(records.kind, "task"),
            eq(records.bucketId, existing.id),
            isNull(records.archivedAt),
          ),
        );
      if (patch.moveToBucketId === existing.id)
        throw new ApiError(
          400,
          "invalid_move",
          "Choose another active bucket.",
        );
      if (patch.moveToBucketId) {
        const target = await find(tx, ctx, "bucket", patch.moveToBucketId);
        if (target.archivedAt)
          throw new ApiError(
            400,
            "invalid_move",
            "Choose an active destination bucket.",
          );
      }
      if (tasks.length && !patch.moveToBucketId)
        throw new ApiError(
          409,
          "bucket_not_empty",
          "Choose a destination for the active tasks in this bucket.",
        );
      for (const task of tasks) {
        const [moved] = await tx
          .update(records)
          .set({
            bucketId: patch.moveToBucketId!,
            version: task.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(records.teamId, p.teamId),
              eq(records.kind, "task"),
              eq(records.id, task.id),
              eq(records.version, task.version),
            ),
          )
          .returning();
        await audit(tx, p, moved, "updated", {
          fromBucketId: existing.id,
          toBucketId: patch.moveToBucketId,
        });
      }
    }
    const archivedAt = archived ? (existing.archivedAt ?? now) : null;
    const { data: stored, assigneeIds } = withoutAssignees(data);
    const [row] = await unitChecked(
      ctx,
      tx
        .update(records)
        .set({
          data: stored,
          ...refs,
          archivedAt,
          importMeta: patch.importMeta ?? existing.importMeta,
          ...(patch.orgUnitId !== undefined
            ? { orgUnitId: patch.orgUnitId }
            : {}),
          version: existing.version + 1,
          updatedAt: now,
          schemaVersionId: schema?.versionId ?? null,
        })
        .where(
          and(
            ...scopeFilter(ctx, kind),
            eq(records.id, recordId),
            eq(records.version, patch.version),
          ),
        )
        .returning(readColumns(ctx)),
    );
    if (!row)
      throw new ApiError(
        409,
        "version_conflict",
        "This record changed. Review your draft before saving.",
      );
    const action = imported
      ? "imported"
      : !!existing.archivedAt !== archived
        ? archived
          ? "archived"
          : "restored"
        : "updated";
    const metadata =
      kind === "application" && !imported && existing.data.stage !== data.stage
        ? { fromStage: existing.data.stage, toStage: data.stage }
        : kind === "offer" && !imported && existing.data.status !== data.status
          ? { fromStatus: existing.data.status, toStatus: data.status }
          : {};
    await audit(tx, p, row, action, metadata, imported);
    // The response's assignees are the ones find read plus the changes applied here.
    if (assigneeIds !== undefined) {
      await changeAssignees(
        tx,
        recordId,
        existing.assigneeIds ?? [],
        assigneeIds,
      );
      row.assigneeIds = [...assigneeIds].sort();
    }
    const updated = redact(ctx, (await decorate(tx, ctx, [dto(row)]))[0]);
    if (options.comment === undefined) return updated;
    const comment = await createInside(
      tx,
      ctx,
      "comment",
      {
        parentRecordId: recordId,
        data: parse(recordDataSchemas.comment, { body: options.comment }),
      },
      false,
    );
    return { ...updated, commentId: comment.id };
  });
}

export async function bulkApplications(
  p: Principal,
  raw: unknown,
  idempotencyKey?: string,
) {
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    authorize(ctx, { resource: "applications", action: "create" });
    authorize(ctx, { resource: "candidates", action: "view" });
    const input = parse(bulkApplicationsSchema, raw);
    // Only the application fields sent: a defaulted stage or date is the server's.
    checkFieldWrite(
      ctx,
      "application",
      ["stage", "owner", "source", "appliedDate"].filter((key) =>
        Object.hasOwn(raw as Data, key),
      ),
    );
    const candidateIds = [...new Set(input.candidateIds)];
    await lockTeam(tx, p);
    // Expired keys re-run: existing active pairs are reported, never duplicated.
    return idempotent(
      tx,
      ctx,
      "bulk:applications",
      idempotencyKey,
      input,
      async () => {
        const vacancy = await find(tx, ctx, "vacancy", input.vacancyId);
        if (vacancy.archivedAt)
          throw new ApiError(
            400,
            "archived_reference",
            "Choose an active vacancy.",
          );
        const candidates = await tx
          .select()
          .from(records)
          .where(
            and(
              ...scopeFilter(ctx, "candidate"),
              inArray(records.id, candidateIds),
              isNull(records.archivedAt),
            ),
          );
        if (candidates.length !== candidateIds.length)
          throw new ApiError(
            400,
            "invalid_reference",
            "Every candidate must be active and in this team. No applications were created.",
          );
        const existing = await tx
          .select()
          .from(records)
          .where(
            and(
              ...scopeFilter(ctx, "application"),
              eq(records.vacancyId, input.vacancyId),
              inArray(records.candidateId, candidateIds),
              isNull(records.archivedAt),
            ),
          )
          .orderBy(asc(records.createdAt), asc(records.id));
        const skip = new Set(existing.map((row) => row.candidateId));
        const created: RecordDto[] = [];
        for (const candidateId of candidateIds)
          if (!skip.has(candidateId))
            created.push(
              await createInside(
                tx,
                ctx,
                "application",
                {
                  candidateId,
                  vacancyId: input.vacancyId,
                  data: parse(recordDataSchemas.application, {
                    stage: input.stage,
                    owner: input.owner,
                    source: input.source,
                    appliedDate: input.appliedDate,
                  }) as Data,
                },
                false,
              ),
            );
        return {
          data: (await decorate(tx, ctx, created)).map((row) =>
            redact(ctx, row),
          ),
          // Other users' application contents require recruitment:read; otherwise report references only.
          existing: ctx.scopes.includes("recruitment:read")
            ? (await decorate(tx, ctx, existing.map(dto))).map((row) =>
                redact(ctx, row),
              )
            : existing.map((row) => ({
                id: row.id,
                kind: row.kind as RecordKind,
                candidateId: row.candidateId,
                vacancyId: row.vacancyId,
              })),
          created: created.length,
          skipped: existing.length,
        };
      },
      undefined,
      // Each cached record under the current role; reference-only rows hold no field.
      (cached) => ({
        ...cached,
        data: cached.data.map((row) => redact(ctx, row)),
        existing: cached.existing.map((row) =>
          "data" in row ? redact(ctx, row as RecordDto) : row,
        ),
      }),
    );
  });
}

export async function bootstrapTeam(p: Principal) {
  if (p.authType !== "session" || !["owner", "admin"].includes(p.role))
    throw new ApiError(
      403,
      "forbidden",
      "A team owner or admin can initialize its workflow.",
    );
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    authorize(ctx, { resource: "buckets", action: "create" });
    await lockTeam(tx, p);
    const existing = await tx
      .select()
      .from(records)
      .where(and(...scopeFilter(ctx, "bucket")));
    if (existing.length) return { data: existing.map(dto), created: 0 };
    const data: RecordDto[] = [];
    for (const [position, name] of [
      "To do",
      "In progress",
      "Waiting",
      "Done",
    ].entries())
      data.push(
        await createInside(
          tx,
          ctx,
          "bucket",
          {
            data: parse(recordDataSchemas.bucket, {
              name,
              position,
              color: ["#64748B", "#4338CA", "#D97706", "#059669"][position],
              completed: name === "Done",
            }),
          },
          false,
        ),
      );
    return { data, created: data.length };
  });
}

export async function getCandidateState(p: Principal, candidateId: string) {
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    authorize(ctx, { resource: "candidates", action: "view" });
    id(candidateId);
    await find(tx, ctx, "candidate", candidateId);
    const [state] = await tx
      .select()
      .from(candidateStates)
      .where(
        and(
          eq(candidateStates.teamId, p.teamId),
          eq(candidateStates.userId, p.userId),
          eq(candidateStates.candidateId, candidateId),
        ),
      )
      .limit(1);
    return state
      ? {
          candidateId,
          shortlisted: state.shortlisted,
          status: state.status,
          note: state.note,
          importMeta: state.importMeta,
          version: state.version,
          updatedAt: state.updatedAt.toISOString(),
        }
      : {
          candidateId,
          shortlisted: false,
          status: "New",
          note: "",
          importMeta: {},
          version: 0,
          updatedAt: null,
        };
  });
}

export async function updateCandidateState(
  p: Principal,
  candidateId: string,
  raw: unknown,
) {
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    authorize(ctx, { resource: "candidates", action: "edit" });
    id(candidateId);
    const input = parse(candidateStateSchema, raw);
    if (input.importMeta !== undefined)
      authorize(ctx, { resource: "candidates", action: "import" });
    await lockTeam(tx, p);
    const candidate = await find(tx, ctx, "candidate", candidateId);
    const where = and(
      eq(candidateStates.teamId, p.teamId),
      eq(candidateStates.userId, p.userId),
      eq(candidateStates.candidateId, candidateId),
    );
    const [previous] = await tx
      .select()
      .from(candidateStates)
      .where(where)
      .limit(1);
    if ((previous?.version ?? 0) !== input.version)
      throw new ApiError(
        409,
        "version_conflict",
        "Your candidate notes changed. Review your draft before saving.",
      );
    const data = {
      shortlisted: input.shortlisted ?? previous?.shortlisted ?? false,
      status: input.status ?? previous?.status ?? "New",
      note: input.note ?? previous?.note ?? "",
      importMeta: input.importMeta ?? previous?.importMeta ?? {},
      version: input.version + 1,
      updatedAt: new Date(),
    };
    if (previous) await tx.update(candidateStates).set(data).where(where);
    else
      await tx
        .insert(candidateStates)
        .values({ teamId: p.teamId, userId: p.userId, candidateId, ...data });
    await audit(
      tx,
      p,
      candidate,
      "personal_state_updated",
      {
        shortlistChanged: input.shortlisted !== undefined,
        followupChanged: input.status !== undefined,
        noteChanged: input.note !== undefined,
      },
      input.importMeta !== undefined,
    );
    return { candidateId, ...data, updatedAt: data.updatedAt.toISOString() };
  });
}
