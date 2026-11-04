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
  },
  (t) => [
    unique("records_team_id_id_key").on(t.teamId, t.id),
    index("records_team_kind_idx").on(t.teamId, t.kind),
    index("records_team_updated_idx").on(t.teamId, t.updatedAt),
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
  },
  (t) => [index("activity_team_created_idx").on(t.teamId, t.createdAt)],
);
export const uploads = appSchema.table(
  "uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id),
    candidateId: uuid("candidate_id").notNull(),
    originalName: text("original_name").notNull(),
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
  },
  (t) => [
    index("uploads_team_candidate_idx").on(t.teamId, t.candidateId),
    uniqueIndex("uploads_provider_object_key_unique").on(
      t.storageProvider,
      t.objectKey,
    ),
    index("uploads_pending_s3_expiry_idx")
      .on(t.storageStore, t.expiresAt)
      .where(sql`${t.storageProvider} = 's3' AND ${t.status} = 'pending'`),
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
