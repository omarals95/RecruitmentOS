import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import { activity, candidateStates, idempotency, records } from "@/db/schema";
import type { TeamTx } from "@/db";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";
import {
  CANDIDATE_DUPLICATE_LIMIT,
  bulkApplicationsSchema,
  candidateStateSchema,
  createRecordSchemas,
  daySchema,
  dubaiToday,
  recordDataSchemas,
  referenceFields,
  referencesByKind,
  resourceToKind,
  searchTerms,
  updateRecordSchemas,
  uuidSchema,
  type RecordDto,
  type RecordKind,
  type RecordReferences,
  type ResourceName,
} from "@/domain/records";

type DbRecord = typeof records.$inferSelect;
type Data = Record<string, unknown>;
type WriteInput = Partial<RecordReferences> & {
  data: Data;
  version?: number;
  legacyId?: string;
  importMeta?: Data;
  archived?: boolean;
  moveToBucketId?: string;
};
const knownRoles = new Set(["owner", "admin", "recruiter", "viewer"]);
function permission(p: Principal, resource: ResourceName, write = false) {
  const scope = `${resource === "candidates" ? "candidates" : "recruitment"}:${write ? "write" : "read"}`;
  if (
    !knownRoles.has(p.role) ||
    (write && p.role === "viewer") ||
    !p.scopes.includes(scope as Principal["scopes"][number])
  )
    throw new ApiError(
      403,
      "forbidden",
      "You do not have permission for this action.",
    );
}
function importPermission(p: Principal) {
  if (
    !["owner", "admin"].includes(p.role) ||
    !p.scopes.includes("imports:write")
  )
    throw new ApiError(
      403,
      "import_forbidden",
      "Legacy source fields require an owner or admin import token.",
    );
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
function dto(row: DbRecord): RecordDto {
  return {
    id: row.id,
    kind: row.kind as RecordKind,
    data: row.data as RecordDto["data"],
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
  };
}
async function decorate(
  tx: TeamTx,
  p: Principal,
  rows: RecordDto[],
): Promise<RecordDto[]> {
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
    !p.scopes.includes("recruitment:read") ||
    !rows.some((row) => ["application", "onboarding"].includes(row.kind))
  )
    return rows;
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
        and(
          eq(records.teamId, p.teamId),
          eq(records.kind, "application"),
          inArray(records.id, parentIds),
        ),
      );
    for (const parent of parents) applications.set(parent.id, parent);
  }
  const parentRefs = [
    ...new Set(
      [...applications.values()]
        .flatMap((row) => [
          row.vacancyId,
          ...(p.scopes.includes("candidates:read") ? [row.candidateId] : []),
        ])
        .filter((value): value is string => !!value),
    ),
  ];
  const labels = new Map<string, string>();
  if (parentRefs.length) {
    const parents = await tx
      .select({
        id: records.id,
        kind: records.kind,
        name: sql<string>`${records.data}->>'name'`,
        title: sql<string>`${records.data}->>'title'`,
      })
      .from(records)
      .where(
        and(
          eq(records.teamId, p.teamId),
          inArray(records.id, parentRefs),
          inArray(
            records.kind,
            p.scopes.includes("candidates:read")
              ? ["candidate", "vacancy"]
              : ["vacancy"],
          ),
        ),
      );
    for (const parent of parents)
      labels.set(
        parent.id,
        parent.kind === "candidate" ? parent.name : parent.title,
      );
  }
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
      ? { ...row, label: applicationLabel(row.id) }
      : row.kind === "onboarding" && row.applicationId
        ? {
            ...row,
            label: `Onboarding · ${applicationLabel(row.applicationId)}`,
          }
        : row,
  );
}
function owned(p: Principal, kind: RecordKind): SQL[] {
  return [
    eq(records.teamId, p.teamId),
    eq(records.kind, kind),
    ...(kind === "saved-view" ? [eq(records.privateOwnerId, p.userId)] : []),
  ];
}
async function find(
  tx: TeamTx,
  p: Principal,
  kind: RecordKind,
  recordId: string,
  lock = false,
): Promise<DbRecord> {
  const query = tx
    .select()
    .from(records)
    .where(and(...owned(p, kind), eq(records.id, recordId)))
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  if (!rows[0])
    throw new ApiError(404, "not_found", "Record not found in this team.");
  return rows[0];
}
async function lockTeam(tx: TeamTx, p: Principal) {
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
  p: Principal,
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
    importPermission(p);
  return imported;
}
async function checkReferences(
  tx: TeamTx,
  p: Principal,
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
    const [parent] = await tx
      .select()
      .from(records)
      .where(and(eq(records.teamId, p.teamId), eq(records.id, value)))
      .limit(1);
    if (
      !parent ||
      (config?.kind !== "*" && parent.kind !== config?.kind) ||
      (parent.kind === "saved-view" && parent.privateOwnerId !== p.userId)
    )
      throw new ApiError(
        400,
        "invalid_reference",
        `${key} does not reference the expected record in this team.`,
      );
    if (parent.archivedAt && !allowArchived)
      throw new ApiError(
        400,
        "archived_reference",
        `${key} references an archived record.`,
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
function validCustomValue(field: DbRecord, value: unknown): boolean {
  if (value === "" || value === null || value === undefined)
    return !field.data.required;
  switch (field.data.type) {
    case "Text":
      return typeof value === "string" && value.length <= 4000;
    case "Number":
      return typeof value === "number" && Number.isFinite(value);
    case "Date":
      return typeof value === "string" && daySchema.safeParse(value).success;
    case "Dropdown":
      return (
        typeof value === "string" &&
        (field.data.options as string[]).includes(value)
      );
    case "Checkbox":
      return typeof value === "boolean";
    default:
      return false;
  }
}
async function checkCustomValues(
  tx: TeamTx,
  p: Principal,
  data: Data,
  existing?: DbRecord,
  importing = false,
) {
  const fields = await tx
    .select()
    .from(records)
    .where(and(...owned(p, "task-field")));
  const values = data.customValues as Data;
  const oldValues = (existing?.data.customValues ?? {}) as Data;
  const byId = new Map(fields.map((field) => [field.id, field]));
  for (const [key, value] of Object.entries(values)) {
    const field = byId.get(key);
    if (!field)
      throw new ApiError(
        400,
        "unknown_custom_field",
        "A custom field is not available in this team.",
      );
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
    } else if (!validCustomValue(field, value))
      throw new ApiError(
        400,
        "invalid_custom_value",
        `Invalid value for ${field.data.name}.`,
      );
  }
  for (const field of fields.filter((item) => !item.archivedAt)) {
    if (!validCustomValue(field, values[field.id]))
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
}
async function checkFieldCompatibility(
  tx: TeamTx,
  p: Principal,
  existing: DbRecord | undefined,
  data: Data,
  archived: boolean,
) {
  if (archived) return;
  const tasks = await tx
    .select()
    .from(records)
    .where(and(...owned(p, "task")));
  const proposed = { ...existing, data } as DbRecord;
  for (const task of tasks) {
    const values = (task.data.customValues ?? {}) as Data;
    const value = existing ? values[existing.id] : undefined;
    if (
      (value !== undefined && !validCustomValue(proposed, value)) ||
      (!task.archivedAt && !validCustomValue(proposed, value))
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
  p: Principal,
  kind: RecordKind,
  data: Data,
  refs: Partial<RecordReferences>,
  existing?: DbRecord,
  archived = false,
) {
  const conditions: SQL[] = [...owned(p, kind)];
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
 * Keys are never reused for different content, even after expiry. An expired
 * same-payload retry runs `reconcile` (or `work` when it cannot duplicate) and
 * renews the stored result in place.
 */
async function idempotent<T>(
  tx: TeamTx,
  p: Principal,
  operation: string,
  key: string | undefined,
  payload: unknown,
  work: () => Promise<T>,
  reconcile?: (previous: unknown) => Promise<T>,
): Promise<T> {
  if (!key) return work();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key))
    throw new ApiError(
      400,
      "invalid_idempotency_key",
      "Use an Idempotency-Key of 1–128 letters, digits, dots, underscores, colons or hyphens.",
    );
  const actorKey = `${p.userId}:${p.authType}:${p.tokenId ?? "session"}`;
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
    if (previous.expiresAt > new Date()) return previous.response as T;
    const result = reconcile
      ? await reconcile(previous.response)
      : await work();
    await tx
      .update(idempotency)
      .set({
        response: result,
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
    response: result,
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
  permission(p, resource);
  id(recordId);
  return withTeam(
    p,
    async (tx) =>
      (await decorate(tx, p, [dto(await find(tx, p, kind, recordId))]))[0],
  );
}

/** Kind and archive state of a record the caller can see in its team, for checks before a write. */
export async function recordKindOf(
  p: Principal,
  recordId: string,
): Promise<{ kind: RecordKind; archived: boolean }> {
  id(recordId);
  return withTeam(p, async (tx) => {
    const [row] = await tx
      .select({
        kind: records.kind,
        privateOwnerId: records.privateOwnerId,
        archivedAt: records.archivedAt,
      })
      .from(records)
      .where(and(eq(records.teamId, p.teamId), eq(records.id, recordId)))
      .limit(1);
    if (!row || (row.kind === "saved-view" && row.privateOwnerId !== p.userId))
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
  permission(p, "candidates");
  const query = parse(candidateDuplicateQuerySchema, input);
  const email = query.email?.toLowerCase() || "";
  const phone = (query.phone || "").replace(/\D/g, "");
  const predicates: SQL[] = [];
  if (email)
    predicates.push(sql`lower(trim(${records.data}->>'email')) = ${email}`);
  if (phone.length >= 7)
    predicates.push(
      sql`regexp_replace(coalesce(${records.data}->>'phone', ''), '[^0-9]', '', 'g') = ${phone}`,
    );
  return withTeam(p, async (tx) => {
    const rows = await tx
      .select({ id: records.id, data: records.data })
      .from(records)
      .where(and(...owned(p, "candidate"), or(...predicates)))
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
  });
}

export async function listRecords(
  p: Principal,
  resource: ResourceName,
  query: URLSearchParams,
  options: { omitFromSearch?: readonly string[] } = {},
) {
  const kind = kindOf(resource);
  permission(p, resource);
  const validKeys = new Set([
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
  ]);
  for (const key of query.keys())
    if (!validKeys.has(key) || query.getAll(key).length > 1)
      throw new ApiError(
        400,
        "invalid_query",
        `Unsupported or repeated filter: ${key}.`,
      );
  const page = parse(
    z.coerce.number().int().min(1).max(1000000),
    query.get("page") || 1,
  );
  const pageSize = parse(
    z.coerce.number().int().min(1).max(100),
    query.get("pageSize") || 30,
  );
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
    query.get("sort") ||
      (kind === "candidate"
        ? "name"
        : ["bucket", "task-field"].includes(kind)
          ? "position"
          : "createdAt"),
  );
  return withTeam(p, async (tx) => {
    const where: SQL[] = owned(p, kind);
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
        if (values.length && (key === "skills" || key === "certifications"))
          where.push(
            sql`(${records.data}->${key}) @> ${JSON.stringify(values)}::jsonb`,
          );
        if (values.length && key === "categories")
          where.push(
            sql`exists(select 1 from jsonb_array_elements_text(${records.data}->'folderCategories') category(value) where ${inArray(sql`category.value`, values)})`,
          );
      }
    // jsonpath extracts scalar values only. JSON property names are never searchable candidate facts.
    // Top-level keys in omitFromSearch are removed first, so words neither match nor exclude on them.
    const omitted = options.omitFromSearch ?? [];
    const searched = omitted.length
      ? sql`(${records.data} - array[${sql.join(
          omitted.map((key) => sql`${key}`),
          sql`, `,
        )}]::text[])`
      : records.data;
    const ownFacts = sql`jsonb_path_query_array(${searched}, '$.** ? (@.type() == "string" || @.type() == "number" || @.type() == "boolean")')::text`;
    const factual =
      kind === "application"
        ? sql`concat_ws(' ',${ownFacts},
      (select concat_ws(' ',v.data->>'title',v.data->>'department') from ${records} v where v.team_id=${p.teamId} and v.kind='vacancy' and v.id=${records.vacancyId}),
      ${p.scopes.includes("candidates:read") ? sql`(select concat_ws(' ',c.data->>'name',c.data->>'email',c.data->>'jobTitle') from ${records} c where c.team_id=${p.teamId} and c.kind='candidate' and c.id=${records.candidateId})` : sql`''`})`
        : ownFacts;
    for (const term of searchTerms(search)) {
      const position = sql`strpos(lower(${factual}),lower(${term.value}))`;
      where.push(term.excluded ? sql`${position}=0` : sql`${position}>0`);
    }
    const condition = and(...where);
    const [{ total }] = await tx
      .select({ total: count() })
      .from(records)
      .where(condition);
    const expression = ["createdAt", "updatedAt"].includes(sort)
      ? records[sort as "createdAt" | "updatedAt"]
      : ["yearsExperience", "position"].includes(sort)
        ? sql`nullif(${records.data}->>${sort}, '')::numeric`
        : sql`lower(${records.data}->>${sort})`;
    const rows = await tx
      .select()
      .from(records)
      .where(condition)
      .orderBy(
        order === "asc" ? asc(expression) : desc(expression),
        asc(records.id),
      )
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      data: await decorate(tx, p, rows.map(dto)),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  });
}

async function createInside(
  tx: TeamTx,
  p: Principal,
  kind: RecordKind,
  input: WriteInput,
  imported: boolean,
): Promise<RecordDto> {
  validateRelations(kind, input.data);
  await checkReferences(
    tx,
    p,
    kind,
    input,
    undefined,
    imported && (input.archived === true || kind === "comment"),
  );
  const refs = refsFor(input);
  await uniqueChecks(
    tx,
    p,
    kind,
    input.data,
    refs,
    undefined,
    !!input.archived,
  );
  if (kind === "task")
    await checkCustomValues(tx, p, input.data, undefined, imported);
  if (kind === "task-field")
    await checkFieldCompatibility(
      tx,
      p,
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
  const now = new Date();
  const [row] = await tx
    .insert(records)
    .values({
      id: randomUUID(),
      teamId: p.teamId,
      kind,
      data: input.data,
      ...refs,
      version: 1,
      legacyId: input.legacyId ?? null,
      importMeta: input.importMeta ?? {},
      privateOwnerId: kind === "saved-view" ? p.userId : null,
      createdBy: p.userId,
      createdAt: now,
      updatedAt: now,
      archivedAt: input.archived ? now : null,
    })
    .returning();
  await audit(
    tx,
    p,
    row,
    imported ? "imported" : "created",
    kind === "application" && !imported
      ? { fromStage: null, toStage: input.data.stage }
      : {},
    imported,
  );
  return dto(row);
}

export async function createRecord(
  p: Principal,
  resource: ResourceName,
  raw: unknown,
  idempotencyKey?: string,
): Promise<RecordDto> {
  const kind = kindOf(resource);
  permission(p, resource, true);
  const input = parse(createRecordSchemas[kind], raw) as WriteInput;
  const imported = importedInput(p, kind, input, (raw as { data: Data }).data);
  return withTeam(p, async (tx) => {
    await lockTeam(tx, p);
    return idempotent(
      tx,
      p,
      `create:${resource}`,
      idempotencyKey,
      input,
      async () =>
        (
          await decorate(tx, p, [
            await createInside(tx, p, kind, input, imported),
          ])
        )[0],
      async (previous) => {
        // Return the record's current state, including archived records; never create again.
        const recordId = (previous as { id?: unknown } | null)?.id;
        const [row] = uuidSchema.safeParse(recordId).success
          ? await tx
              .select()
              .from(records)
              .where(and(...owned(p, kind), eq(records.id, recordId as string)))
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
          !p.scopes.includes(
            resource === "candidates" ? "candidates:read" : "recruitment:read",
          )
        )
          return previous as RecordDto;
        return (await decorate(tx, p, [dto(row)]))[0];
      },
    );
  });
}

export async function updateRecord(
  p: Principal,
  resource: ResourceName,
  recordId: string,
  raw: unknown,
): Promise<RecordDto> {
  const kind = kindOf(resource);
  permission(p, resource, true);
  id(recordId);
  if (kind === "comment")
    throw new ApiError(
      405,
      "append_only",
      "Comments are append-only. Add a new comment instead.",
    );
  const patch = parse(updateRecordSchemas[kind], raw) as Partial<WriteInput> & {
    version: number;
  };
  if (patch.moveToBucketId && !(kind === "bucket" && patch.archived === true))
    throw new ApiError(
      400,
      "invalid_move",
      "A destination is only valid when archiving a bucket.",
    );
  return withTeam(p, async (tx) => {
    await lockTeam(tx, p);
    const existing = await find(tx, p, kind, recordId, true);
    if (existing.version !== patch.version)
      throw new ApiError(
        409,
        "version_conflict",
        "This record changed. Refresh it and review your draft before saving.",
      );
    const data = parse(recordDataSchemas[kind], {
      ...existing.data,
      ...patch.data,
    }) as Data;
    const input = { ...patch, data };
    const imported = importedInput(p, kind, input, patch.data ?? {});
    const archived = patch.archived ?? !!existing.archivedAt;
    const restoring = !!existing.archivedAt && !archived;
    validateRelations(kind, data);
    await checkReferences(
      tx,
      p,
      kind,
      patch,
      existing,
      imported && archived,
      restoring,
    );
    const refs = refsFor(patch, existing);
    await uniqueChecks(tx, p, kind, data, refs, existing, archived);
    if (kind === "task")
      await checkCustomValues(tx, p, data, existing, imported);
    if (kind === "task-field")
      await checkFieldCompatibility(tx, p, existing, data, archived);
    const now = new Date();
    if (kind === "bucket" && !existing.archivedAt && archived) {
      const active = await tx
        .select()
        .from(records)
        .where(and(...owned(p, "bucket"), isNull(records.archivedAt)));
      if (active.length < 2)
        throw new ApiError(
          409,
          "last_bucket",
          "Keep at least one active workflow bucket.",
        );
      const tasks = await tx
        .select()
        .from(records)
        .where(
          and(
            ...owned(p, "task"),
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
        const target = await find(tx, p, "bucket", patch.moveToBucketId);
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
              ...owned(p, "task"),
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
    const [row] = await tx
      .update(records)
      .set({
        data,
        ...refs,
        archivedAt,
        importMeta: patch.importMeta ?? existing.importMeta,
        version: existing.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          ...owned(p, kind),
          eq(records.id, recordId),
          eq(records.version, patch.version),
        ),
      )
      .returning();
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
        : {};
    await audit(tx, p, row, action, metadata, imported);
    return (await decorate(tx, p, [dto(row)]))[0];
  });
}

export async function bulkApplications(
  p: Principal,
  raw: unknown,
  idempotencyKey?: string,
) {
  permission(p, "applications", true);
  permission(p, "candidates");
  const input = parse(bulkApplicationsSchema, raw);
  const candidateIds = [...new Set(input.candidateIds)];
  return withTeam(p, async (tx) => {
    await lockTeam(tx, p);
    // Expired keys re-run: existing active pairs are reported, never duplicated.
    return idempotent(
      tx,
      p,
      "bulk:applications",
      idempotencyKey,
      input,
      async () => {
        const vacancy = await find(tx, p, "vacancy", input.vacancyId);
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
              ...owned(p, "candidate"),
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
              ...owned(p, "application"),
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
                p,
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
          data: await decorate(tx, p, created),
          // Other users' application contents require recruitment:read; otherwise report references only.
          existing: p.scopes.includes("recruitment:read")
            ? await decorate(tx, p, existing.map(dto))
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
  permission(p, "buckets", true);
  return withTeam(p, async (tx) => {
    await lockTeam(tx, p);
    const existing = await tx
      .select()
      .from(records)
      .where(and(...owned(p, "bucket")));
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
          p,
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
  permission(p, "candidates");
  id(candidateId);
  return withTeam(p, async (tx) => {
    await find(tx, p, "candidate", candidateId);
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
  permission(p, "candidates", true);
  id(candidateId);
  const input = parse(candidateStateSchema, raw);
  if (input.importMeta !== undefined) importPermission(p);
  return withTeam(p, async (tx) => {
    await lockTeam(tx, p);
    const candidate = await find(tx, p, "candidate", candidateId);
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
