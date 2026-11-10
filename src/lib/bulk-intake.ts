import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { bulkIntakeBatches, bulkIntakeItems, uploads } from "@/db/schema";
import type { TeamTx } from "@/db";
import { accessContext } from "@/lib/authz";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";
import { aiReviewEvidence, aiReviewSchema } from "@/lib/ai-extraction";
import { beginCvUpload } from "@/lib/cvs";
import { createInside, lockTeam, matchCandidateContacts } from "@/lib/records";
import {
  CvValidationError,
  MAX_CV_BYTES,
  validateCvMetadata,
} from "@/lib/storage-format";
import {
  storageConfigured,
  STORAGE_SETUP_REQUIRED_MESSAGE,
} from "@/lib/storage";
import {
  BULK_INTAKE_MAX_FILES,
  BULK_INTAKE_RECOVERY_HOURS,
  CANDIDATE_DUPLICATE_LIMIT,
  recordDataSchemas,
  uuidSchema,
} from "@/domain/records";

type ItemRow = typeof bulkIntakeItems.$inferSelect;
export type BulkItemOutcome =
  "not-imported" | "cv-pending" | "imported" | "cv-rejected";

// Source fields stay with the legacy importer; bulk intake takes only reviewed candidate details,
// and no custom values.
const bulkCandidateData = recordDataSchemas.candidate.omit({
  rawSource: true,
  evidence: true,
  sourceReviews: true,
  customValues: true,
});
export const bulkItemSchema = z
  .object({
    file: z
      .object({
        originalName: z.string().trim().min(1).max(180),
        mimeType: z.string().trim().max(150),
        sizeBytes: z.number().int().min(1).max(MAX_CV_BYTES),
      })
      .strict(),
    data: bulkCandidateData,
    factsReviewed: z.boolean().optional(),
    duplicatesReviewed: z.boolean().optional(),
    acknowledgedDuplicateIds: z
      .array(uuidSchema)
      .max(CANDIDATE_DUPLICATE_LIMIT)
      .default([]),
    aiReview: aiReviewSchema.optional(),
  })
  .strict();
export type BulkItemInput = z.infer<typeof bulkItemSchema>;

const notFound = () =>
  new ApiError(
    404,
    "not_found",
    "This import item is not available in the selected team.",
  );
const batchNotFound = () =>
  new ApiError(
    404,
    "not_found",
    "This import is not available in the selected team.",
  );
/** A tombstoned item: its candidate was erased, so a retry must never create it again. */
const erased = () =>
  new ApiError(
    409,
    "bulk_item_erased",
    "This candidate was permanently erased by a team owner. It cannot be imported again from this batch.",
  );
const expired = () =>
  new ApiError(
    409,
    "bulk_batch_expired",
    `This import is more than ${BULK_INTAKE_RECOVERY_HOURS} hours old. Check the candidate directory before importing these CVs again.`,
  );
function ids(batchId: string, itemId?: string) {
  if (
    !uuidSchema.safeParse(batchId).success ||
    (itemId !== undefined && !uuidSchema.safeParse(itemId).success)
  )
    throw notFound();
}
/** The same environment-only readiness single CV upload uses; it contacts no provider. */
function requireUploads() {
  if (!storageConfigured())
    throw new ApiError(
      503,
      "STORAGE_SETUP_REQUIRED",
      STORAGE_SETUP_REQUIRED_MESSAGE,
    );
}
function itemDto(row: ItemRow, expiresAt: Date) {
  return {
    id: row.id,
    batchId: row.batchId,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    candidateId: row.candidateId,
    uploadId: row.uploadId,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    possibleDuplicates: row.possibleDuplicates,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}
const own = (p: Principal) => [
  eq(bulkIntakeBatches.teamId, p.teamId),
  eq(bulkIntakeBatches.createdBy, p.userId),
];
async function lockBatch(tx: TeamTx, p: Principal, batchId: string) {
  const [batch] = await tx
    .select()
    .from(bulkIntakeBatches)
    .where(and(...own(p), eq(bulkIntakeBatches.id, batchId)))
    .for("update");
  return batch;
}
/**
 * Deletes the items of up to 100 expired batches of any team and user and marks those batches
 * purged, in its own committed transaction. The batch row stays as a tombstone, so its ID is never
 * recreated. The owner-run helper returns nothing, so no other team's count is revealed.
 */
async function purgeExpired(p: Principal, keepBatch: string | null) {
  await withTeam(p, (tx) =>
    tx.execute(
      sql`select tenant_context.purge_bulk_intake(${keepBatch}::uuid)`,
    ),
  );
}

/**
 * Creates the candidate for one reviewed bulk item. Review and duplicate acknowledgement are
 * checked by the server, which re-runs the contact match in the same transaction and records
 * the evidence on the candidate's created event. A repeat of a created item returns it unchanged.
 */
export async function createBulkItem(
  p: Principal,
  batchId: string,
  itemId: string,
  input: BulkItemInput,
) {
  ids(batchId, itemId);
  let file;
  try {
    file = validateCvMetadata(
      input.file.originalName,
      input.file.mimeType,
      input.file.sizeBytes,
    );
  } catch (error) {
    if (error instanceof CvValidationError)
      throw new ApiError(400, "INVALID_CV", error.message);
    throw error;
  }
  const data = recordDataSchemas.candidate.parse({
    ...input.data,
    reviewStatus: "Reviewed",
  });
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(data))
    .digest("hex");
  requireUploads();
  // The requested batch is kept so an expired one is refused below, not recreated.
  await purgeExpired(p, batchId);
  return withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    await lockTeam(tx, p);
    const now = new Date();
    await tx
      .insert(bulkIntakeBatches)
      .values({
        id: batchId,
        teamId: p.teamId,
        createdBy: p.userId,
        createdAt: now,
        expiresAt: new Date(
          now.getTime() + BULK_INTAKE_RECOVERY_HOURS * 3_600_000,
        ),
      })
      .onConflictDoNothing();
    // Another user's or team's batch id conflicts invisibly and reads as not found.
    const batch = await lockBatch(tx, p, batchId);
    if (!batch) throw notFound();
    // A purged batch is refused even if its expiry reads as later on this server's clock.
    if (batch.purgedAt || batch.expiresAt <= now) throw expired();
    let [item] = await tx
      .select()
      .from(bulkIntakeItems)
      .where(
        and(
          eq(bulkIntakeItems.teamId, p.teamId),
          eq(bulkIntakeItems.createdBy, p.userId),
          eq(bulkIntakeItems.id, itemId),
        ),
      );
    if (item?.erasedAt) throw erased();
    // AI review provenance is checked before anything is created; a replay ignores it.
    const aiReview =
      input.aiReview && !item?.candidateId
        ? await aiReviewEvidence(tx, p, input.aiReview, file)
        : undefined;
    if (!item) {
      const [{ total }] = await tx
        .select({ total: count() })
        .from(bulkIntakeItems)
        .where(
          and(
            eq(bulkIntakeItems.teamId, p.teamId),
            eq(bulkIntakeItems.batchId, batchId),
          ),
        );
      if (total >= BULK_INTAKE_MAX_FILES)
        throw new ApiError(
          400,
          "bulk_batch_limit",
          `A batch can include up to ${BULK_INTAKE_MAX_FILES} files. Start a new import for the rest.`,
        );
      [item] = await tx
        .insert(bulkIntakeItems)
        .values({
          id: itemId,
          teamId: p.teamId,
          batchId,
          createdBy: p.userId,
          ...file,
          payloadHash,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!item) throw notFound();
    } else if (
      item.batchId !== batchId ||
      item.originalName !== file.originalName ||
      item.mimeType !== file.mimeType ||
      item.sizeBytes !== file.sizeBytes ||
      item.payloadHash !== payloadHash
    )
      throw new ApiError(
        409,
        "bulk_item_conflict",
        "This import item was already sent with a different file or different details. Check the candidate directory before importing it again.",
      );
    // A lost response is replayed from the stored item; nothing is created again.
    if (item.candidateId) return itemDto(item, batch.expiresAt);
    if (input.factsReviewed !== true || input.duplicatesReviewed !== true)
      throw new ApiError(
        400,
        "bulk_review_required",
        "Review the details against the CV and the possible duplicates before importing.",
      );
    const matches = await matchCandidateContacts(tx, ctx, data);
    const acknowledged = new Set(input.acknowledgedDuplicateIds);
    if (matches.data.some((match) => !acknowledged.has(match.id)))
      throw new ApiError(
        409,
        "bulk_duplicates_changed",
        "The possible duplicates for this candidate have changed. Check for possible duplicates again and review them before importing.",
      );
    const candidate = await createInside(
      tx,
      ctx,
      "candidate",
      { data },
      false,
      {
        bulkIntake: {
          batchId,
          itemId,
          factsReviewed: true,
          duplicatesReviewed: true,
          possibleDuplicates: matches.data.length,
          limited: matches.limited,
        },
        ...(aiReview ? { aiReview } : {}),
      },
    );
    const [updated] = await tx
      .update(bulkIntakeItems)
      .set({
        payloadHash,
        reviewedAt: now,
        possibleDuplicates: matches.data.length,
        candidateId: candidate.id,
        updatedAt: now,
      })
      .where(
        and(
          eq(bulkIntakeItems.teamId, p.teamId),
          eq(bulkIntakeItems.id, itemId),
        ),
      )
      .returning();
    return itemDto(updated, batch.expiresAt);
  });
}

/**
 * Reserves the CV upload for an item's candidate, idempotent per attempt; completion is unchanged.
 * A live or ready attempt is returned again. A rejected or expired one is replaced once by a new
 * attempt for the same file under a new server-chosen clientUploadId.
 */
export async function beginBulkItemUpload(
  p: Principal,
  batchId: string,
  itemId: string,
) {
  ids(batchId, itemId);
  requireUploads();
  const item = await withTeam(p, async (tx) => {
    // The caller's own expired or purged batch is refused as too old, even once its items are gone.
    const [batch] = await tx
      .select()
      .from(bulkIntakeBatches)
      .where(and(...own(p), eq(bulkIntakeBatches.id, batchId)));
    if (!batch) throw notFound();
    if (batch.purgedAt || batch.expiresAt <= new Date()) throw expired();
    const [row] = await tx
      .select()
      .from(bulkIntakeItems)
      .where(
        and(
          eq(bulkIntakeItems.teamId, p.teamId),
          eq(bulkIntakeItems.createdBy, p.userId),
          eq(bulkIntakeItems.id, itemId),
          eq(bulkIntakeItems.batchId, batchId),
        ),
      );
    if (!row) throw notFound();
    if (row.erasedAt) throw erased();
    if (!row.candidateId)
      throw new ApiError(
        409,
        "bulk_candidate_required",
        "Import the candidate for this CV before uploading it.",
      );
    // Only an erased item has no file values, and it was refused above.
    return {
      ...row,
      candidateId: row.candidateId,
      originalName: row.originalName!,
      mimeType: row.mimeType!,
      sizeBytes: row.sizeBytes!,
    };
  });
  // The stored file metadata is reused for every attempt; the client chooses neither it nor the key.
  const attempt = (clientUploadId: string) =>
    beginCvUpload(p, item.candidateId, {
      originalName: item.originalName,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      clientUploadId,
    });
  const thisItem = and(
    eq(bulkIntakeItems.teamId, p.teamId),
    eq(bulkIntakeItems.id, item.id),
  );
  const currentKey = sql<string>`coalesce(${bulkIntakeItems.uploadKey}, ${bulkIntakeItems.id})`;
  let key = item.uploadKey ?? item.id;
  let result: Awaited<ReturnType<typeof beginCvUpload>>;
  try {
    result = await attempt(key);
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      (error.code !== "CV_UPLOAD_REJECTED" &&
        error.code !== "CV_UPLOAD_EXPIRED")
    )
      throw error;
    // A dead attempt gets a new server-chosen key. Only a call that still finds the dead key
    // rotates it, so overlapping calls share one new attempt.
    const dead = key,
      next = randomUUID();
    key = await withTeam(p, async (tx) => {
      const [rotated] = await tx
        .update(bulkIntakeItems)
        .set({ uploadKey: next, updatedAt: new Date() })
        .where(and(thisItem, sql`${currentKey} = ${dead}`))
        .returning({ id: bulkIntakeItems.id });
      if (rotated) return next;
      const [row] = await tx
        .select({ key: currentKey })
        .from(bulkIntakeItems)
        .where(thisItem);
      if (!row) throw notFound();
      return row.key;
    });
    result = await attempt(key);
  }
  const reserved = result.data.id;
  await withTeam(p, (tx) =>
    tx
      .update(bulkIntakeItems)
      .set({ uploadId: reserved, updatedAt: new Date() })
      .where(and(thisItem, sql`${currentKey} = ${key}`)),
  );
  return result;
}

function outcome(
  candidateId: string | null,
  status: string | null,
): BulkItemOutcome {
  if (!candidateId) return "not-imported";
  if (status === "ready") return "imported";
  return status === "rejected" ? "cv-rejected" : "cv-pending";
}

type BatchRow = typeof bulkIntakeBatches.$inferSelect;
/** Each batch with all its items (at most BULK_INTAKE_MAX_FILES) and each item's outcome. */
async function batchEntries(tx: TeamTx, p: Principal, batches: BatchRow[]) {
  const items = batches.length
    ? await tx
        .select({
          id: bulkIntakeItems.id,
          batchId: bulkIntakeItems.batchId,
          originalName: bulkIntakeItems.originalName,
          sizeBytes: bulkIntakeItems.sizeBytes,
          candidateId: bulkIntakeItems.candidateId,
          possibleDuplicates: bulkIntakeItems.possibleDuplicates,
          status: uploads.status,
        })
        .from(bulkIntakeItems)
        .leftJoin(
          uploads,
          and(
            eq(uploads.teamId, bulkIntakeItems.teamId),
            eq(uploads.id, bulkIntakeItems.uploadId),
          ),
        )
        .where(
          and(
            eq(bulkIntakeItems.teamId, p.teamId),
            eq(bulkIntakeItems.createdBy, p.userId),
            inArray(
              bulkIntakeItems.batchId,
              batches.map((batch) => batch.id),
            ),
            isNull(bulkIntakeItems.erasedAt),
          ),
        )
        .orderBy(asc(bulkIntakeItems.createdAt), asc(bulkIntakeItems.id))
    : [];
  return batches.map((batch) => ({
    id: batch.id,
    createdAt: batch.createdAt.toISOString(),
    expiresAt: batch.expiresAt.toISOString(),
    items: items
      .filter((item) => item.batchId === batch.id)
      .map((item) => ({
        id: item.id,
        originalName: item.originalName,
        sizeBytes: item.sizeBytes,
        candidateId: item.candidateId,
        possibleDuplicates: item.possibleDuplicates,
        outcome: outcome(item.candidateId, item.status),
      })),
  }));
}

const batchPageSchema = z
  .object({
    page: z.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.number().int().min(1).max(20).default(10),
  })
  .strict();
const invalidQuery = (message: string) =>
  new ApiError(400, "invalid_query", message);
export function parseBulkBatchQuery(query: URLSearchParams) {
  const values: { page?: number; pageSize?: number } = {};
  for (const key of query.keys()) {
    if (!["page", "pageSize"].includes(key) || query.getAll(key).length !== 1)
      throw invalidQuery("Use only one page and pageSize parameter.");
    const value = query.get(key)!;
    if (!/^[1-9]\d*$/.test(value))
      throw invalidQuery(
        "Import pagination values must be positive whole decimal numbers.",
      );
    values[key as "page" | "pageSize"] = Number(value);
  }
  const parsed = batchPageSchema.safeParse(values);
  if (!parsed.success)
    throw invalidQuery(
      "Use a page from 1 to 1000000 and a page size from 1 to 20.",
    );
  return parsed.data;
}

/** One page of the caller's unexpired, unpurged batches in the selected team, newest first. */
export async function listBulkBatches(
  p: Principal,
  options: { page: number; pageSize: number },
) {
  const { page, pageSize } = options;
  await purgeExpired(p, null);
  return withTeam(p, async (tx) => {
    const where = and(
      ...own(p),
      gt(bulkIntakeBatches.expiresAt, new Date()),
      isNull(bulkIntakeBatches.purgedAt),
    );
    const [{ total }] = await tx
      .select({ total: count() })
      .from(bulkIntakeBatches)
      .where(where);
    const batches = await tx
      .select()
      .from(bulkIntakeBatches)
      .where(where)
      .orderBy(desc(bulkIntakeBatches.createdAt), desc(bulkIntakeBatches.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      data: await batchEntries(tx, p, batches),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  });
}

/** The caller's own unexpired, unpurged batch; any other ID reads as not found. It does not purge. */
export async function getBulkBatch(p: Principal, batchId: string) {
  if (!uuidSchema.safeParse(batchId).success) throw batchNotFound();
  return withTeam(p, async (tx) => {
    const [batch] = await tx
      .select()
      .from(bulkIntakeBatches)
      .where(
        and(
          ...own(p),
          eq(bulkIntakeBatches.id, batchId),
          gt(bulkIntakeBatches.expiresAt, new Date()),
          isNull(bulkIntakeBatches.purgedAt),
        ),
      );
    if (!batch) throw batchNotFound();
    const [entry] = await batchEntries(tx, p, [batch]);
    return entry;
  });
}
