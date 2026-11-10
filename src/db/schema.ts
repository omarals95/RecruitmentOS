import {
  pgSchema,
  text,
  uuid,
  jsonb,
  integer,
  timestamp,
  boolean,
  bigint,
  primaryKey,
  unique,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization, user } from "./auth-schema";
export const appSchema = pgSchema("app");
const time = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });
export const records = appSchema.table(
  "records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id),
    kind: text("kind").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    version: integer("version").notNull().default(1),
    legacyId: text("legacy_id"),
    candidateId: uuid("candidate_id"),
    vacancyId: uuid("vacancy_id"),
    applicationId: uuid("application_id"),
    onboardingId: uuid("onboarding_id"),
    bucketId: uuid("bucket_id"),
    jobRoleId: uuid("job_role_id"),
    parentRecordId: uuid("parent_record_id"),
    privateOwnerId: text("private_owner_id").references(() => user.id),
    importMeta: jsonb("import_meta")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
    archivedAt: time("archived_at"),
    /** A vacancy's org unit, copied down its pipeline by app.maintain_record_scope() (0037). */
    orgUnitId: uuid("org_unit_id"),
    /** Set only by the trigger: the vacancy and application a pipeline row or comment belongs to. */
    scopeVacancyId: uuid("scope_vacancy_id"),
    scopeApplicationId: uuid("scope_application_id"),
    /** The kind schema version of the last create or update; null = the built-in default version. */
    schemaVersionId: uuid("schema_version_id"),
    /** The record's type; never written until type assignment (R2b-11). */
    typeId: uuid("type_id"),
  },
  (t) => [
    unique("records_team_id_id_key").on(t.teamId, t.id),
    index("records_team_kind_idx").on(t.teamId, t.kind),
    index("records_team_updated_idx").on(t.teamId, t.updatedAt),
    index("records_application_candidate_idx")
      .on(t.teamId, t.candidateId)
      .where(sql`${t.kind} = 'application'`),
    index("records_candidate_id_idx")
      .on(t.teamId, t.id)
      .where(sql`${t.kind} = 'candidate'`),
  ],
);
/**
 * Who is assigned to a record (0037). Read-only for the data role: written only through
 * tenant_context.add_assignment and remove_assignment.
 */
export const recordAssignments = appSchema.table(
  "record_assignments",
  {
    teamId: text("team_id").notNull(),
    recordId: uuid("record_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    relation: text("relation")
      .$type<
        "recruiter" | "hiring-manager" | "interviewer" | "assignee" | "approver"
      >()
      .notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.recordId, t.userId, t.relation] }),
    index("record_assignments_user_idx").on(t.teamId, t.userId),
  ],
);
export const candidateStates = appSchema.table(
  "candidate_states",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    candidateId: uuid("candidate_id").notNull(),
    shortlisted: boolean("shortlisted").notNull().default(false),
    status: text("status").notNull().default("New"),
    note: text("note").notNull().default(""),
    version: integer("version").notNull().default(1),
    importMeta: jsonb("import_meta")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId, t.candidateId] })],
);
export const activity = appSchema.table(
  "activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id),
    recordId: uuid("record_id"),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id),
    actorType: text("actor_type").notNull(),
    tokenId: uuid("token_id"),
    action: text("action").notNull(),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: time("created_at").notNull().defaultNow(),
    /** Set once by the erasure helper, which also clears recordId and redacts summary and metadata. */
    erasureId: uuid("erasure_id"),
    /** Set once by the employee erasure helper, which also redacts summary and metadata (0036). */
    employeeErasureId: uuid("employee_erasure_id").references(
      () => employeeErasures.id,
    ),
  },
  (t) => [
    index("activity_team_created_idx").on(t.teamId, t.createdAt),
    index("activity_erasure_idx")
      .on(t.teamId, t.erasureId)
      .where(sql`${t.erasureId} IS NOT NULL`),
    index("activity_employee_erasure_idx")
      .on(t.employeeErasureId)
      .where(sql`${t.employeeErasureId} IS NOT NULL`),
  ],
);
export const uploads = appSchema.table(
  "uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id),
    /** Null only on an erased row, as is originalName. */
    candidateId: uuid("candidate_id"),
    originalName: text("original_name"),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    status: text("status").notNull().default("pending"),
    objectKey: text("object_key").notNull(),
    s3VersionId: text("s3_version_id"),
    legacySourceId: text("legacy_source_id"),
    sourcePath: text("source_path"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: time("created_at").notNull().defaultNow(),
    completedAt: time("completed_at"),
    expiresAt: time("expires_at").notNull(),
    storageProvider: text("storage_provider").notNull(),
    storageEnvironment: text("storage_environment"),
    storageStore: text("storage_store"),
    blobSha256: text("blob_sha256"),
    blobSizeBytes: bigint("blob_size_bytes", { mode: "number" }),
    blobDeletedAt: time("blob_deleted_at"),
    putTicketsIssued: integer("put_tickets_issued").notNull().default(0),
    /** The candidate erasure that made this row rejected and nameless; set once. */
    erasureId: uuid("erasure_id"),
  },
  (t) => [
    unique("uploads_team_id_id_key").on(t.teamId, t.id),
    index("uploads_team_candidate_idx").on(t.teamId, t.candidateId),
    uniqueIndex("uploads_provider_object_key_unique").on(
      t.storageProvider,
      t.objectKey,
    ),
    index("uploads_pending_s3_expiry_idx")
      .on(t.storageStore, t.expiresAt)
      .where(sql`${t.storageProvider} = 's3' AND ${t.status} = 'pending'`),
    index("uploads_team_created_idx").on(t.teamId, t.createdAt),
    index("uploads_blob_cleanup_idx")
      .on(t.teamId, t.storageStore, t.expiresAt)
      .where(
        sql`${t.storageProvider} = 'blob' AND ${t.status} = 'rejected' AND ${t.blobDeletedAt} IS NULL`,
      ),
    index("uploads_erasure_idx")
      .on(t.teamId, t.erasureId)
      .where(sql`${t.erasureId} IS NOT NULL`),
  ],
);
export const storageUsage = appSchema.table("storage_usage", {
  teamId: text("team_id")
    .primaryKey()
    .references(() => organization.id),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
  reservedBytes: bigint("reserved_bytes", { mode: "number" })
    .notNull()
    .default(0),
  usedFiles: integer("used_files").notNull().default(0),
  reservedFiles: integer("reserved_files").notNull().default(0),
  maxBytes: bigint("max_bytes", { mode: "number" }),
  maxFiles: integer("max_files"),
  updatedAt: time("updated_at").notNull().defaultNow(),
  retainedBytes: bigint("retained_bytes", { mode: "number" })
    .notNull()
    .default(0),
  retainedFiles: integer("retained_files").notNull().default(0),
  uploadRequestsPerMinute: integer("upload_requests_per_minute"),
  /** "Connected AI apps can read CV contents"; set only by tenant_context.set_mcp_cv_text_access. */
  mcpCvTextEnabled: boolean("mcp_cv_text_enabled").notNull().default(true),
});
export const idempotency = appSchema.table(
  "idempotency",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id),
    actorKey: text("actor_key").notNull(),
    operation: text("operation").notNull(),
    key: text("key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    response: jsonb("response").notNull(),
    expiresAt: time("expires_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    /** The role version the response was composed under; a replay under another is recomposed. */
    roleVersionId: uuid("role_version_id"),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.actorKey, t.operation, t.key] })],
);
export const notificationReads = appSchema.table(
  "notification_reads",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    key: text("key").notNull(),
    readAt: time("read_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId, t.key] })],
);
/** Private bulk CV intake recovery rows; file metadata and review evidence, no candidate values. */
export const bulkIntakeBatches = appSchema.table(
  "bulk_intake_batches",
  {
    id: uuid("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: time("created_at").notNull(),
    expiresAt: time("expires_at").notNull(),
    /** Set by the purge, which deletes the items; the row stays so its ID is never reused. */
    purgedAt: time("purged_at"),
  },
  (t) => [
    unique("bulk_intake_batches_team_id_id_created_by_key").on(
      t.teamId,
      t.id,
      t.createdBy,
    ),
    index("bulk_intake_batches_owner_idx").on(
      t.teamId,
      t.createdBy,
      t.expiresAt,
    ),
    index("bulk_intake_batches_purge_idx")
      .on(t.expiresAt, t.id)
      .where(sql`${t.purgedAt} IS NULL`),
  ],
);
export const bulkIntakeItems = appSchema.table(
  "bulk_intake_items",
  {
    id: uuid("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id),
    batchId: uuid("batch_id").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    /** The four file and hash values are null only on an erased item. */
    originalName: text("original_name"),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    payloadHash: text("payload_hash"),
    reviewedAt: time("reviewed_at"),
    possibleDuplicates: integer("possible_duplicates"),
    candidateId: uuid("candidate_id"),
    uploadId: uuid("upload_id"),
    /** The current CV upload attempt's clientUploadId; null means the item ID. */
    uploadKey: uuid("upload_key"),
    createdAt: time("created_at").notNull(),
    updatedAt: time("updated_at").notNull(),
    /** Set by the candidate erasure helper, which clears every value column; the row stays as a tombstone. */
    erasedAt: time("erased_at"),
  },
  (t) => [
    index("bulk_intake_items_batch_idx").on(t.teamId, t.batchId, t.createdBy),
  ],
);
/** Candidate erasure tombstones (0021): ids, team, erasing owner and time only. Owner-only table. */
export const candidateErasures = appSchema.table(
  "candidate_erasures",
  {
    id: uuid("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id),
    candidateId: uuid("candidate_id").notNull(),
    erasedBy: text("erased_by")
      .notNull()
      .references(() => user.id),
    erasedAt: time("erased_at").notNull(),
  },
  (t) => [
    unique("candidate_erasures_team_id_candidate_id_key").on(
      t.teamId,
      t.candidateId,
    ),
    unique("candidate_erasures_team_id_id_key").on(t.teamId, t.id),
  ],
);
/**
 * Employee erasure tombstones (0036): ids, workspace, erasing owner, time and source only.
 * Owner-only table; workspace_id references app.workspaces, which is raw SQL only.
 */
export const employeeErasures = appSchema.table(
  "employee_erasures",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    employeeId: uuid("employee_id").notNull(),
    erasedBy: text("erased_by")
      .notNull()
      .references(() => user.id),
    erasedAt: time("erased_at").notNull(),
    erasureSource: text("erasure_source").$type<"app" | "script">().notNull(),
  },
  (t) => [
    unique("employee_erasures_workspace_id_employee_id_key").on(
      t.workspaceId,
      t.employeeId,
    ),
  ],
);
/** Speed log (0020): action and route timings per team, never ids, names or content; 30 days. */
export const speedSamples = appSchema.table(
  "speed_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id),
    kind: text("kind").$type<"action" | "route">().notNull(),
    name: text("name").notNull(),
    durationMs: integer("duration_ms").notNull(),
    dbMs: integer("db_ms"),
    recordedAt: time("recorded_at")
      .notNull()
      .default(sql`date_trunc('hour', now())`),
  },
  (t) => [index("speed_samples_team_recorded_idx").on(t.teamId, t.recordedAt)],
);
/** Speed sample budgets (0027): one row per member and team, the samples stored this clock hour. */
export const speedSampleBudgets = appSchema.table(
  "speed_sample_budgets",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    windowStart: time("window_start").notNull(),
    rowCount: integer("row_count").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);
