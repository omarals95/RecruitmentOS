import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, lte, ne } from "drizzle-orm";
import { z } from "zod";
import { bulkIntakeBatches, bulkIntakeItems, uploads } from "@/db/schema";
import type { TeamTx } from "@/db";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";
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

// Source fields stay with the legacy importer; bulk intake takes only reviewed candidate details.
const bulkCandidateData = recordDataSchemas.candidate.omit({
  rawSource: true,
  evidence: true,
  sourceReviews: true,
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
  })
  .strict();
export type BulkItemInput = z.infer<typeof bulkItemSchema>;

const notFound = () =>
  new ApiError(
    404,
    "not_found",
    "This import item is not available in the selected team.",
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
  return withTeam(p, async (tx) => {
    await lockTeam(tx, p);
    const now = new Date();
    // Expired batches go when their user next imports; the requested one is refused below.
    await tx
      .delete(bulkIntakeBatches)
      .where(
        and(
          ...own(p),
          lte(bulkIntakeBatches.expiresAt, now),
          ne(bulkIntakeBatches.id, batchId),
        ),
      );
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
    if (batch.expiresAt <= now) throw expired();
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
    const matches = await matchCandidateContacts(tx, p, data);
    const acknowledged = new Set(input.acknowledgedDuplicateIds);
    if (matches.data.some((match) => !acknowledged.has(match.id)))
      throw new ApiError(
        409,
        "bulk_duplicates_changed",
        "The possible duplicates for this candidate have changed. Check for possible duplicates again and review them before importing.",
      );
    const candidate = await createInside(tx, p, "candidate", { data }, false, {
      bulkIntake: {
        batchId,
        itemId,
        factsReviewed: true,
        duplicatesReviewed: true,
        possibleDuplicates: matches.data.length,
        limited: matches.limited,
      },
    });
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

/** Reserves the CV upload for an item's candidate, idempotent per item; completion is unchanged. */
export async function beginBulkItemUpload(
  p: Principal,
  batchId: string,
  itemId: string,
) {
  ids(batchId, itemId);
  requireUploads();
  const item = await withTeam(p, async (tx) => {
    const [row] = await tx
      .select({ item: bulkIntakeItems, expiresAt: bulkIntakeBatches.expiresAt })
      .from(bulkIntakeItems)
      .innerJoin(
        bulkIntakeBatches,
        and(
          eq(bulkIntakeBatches.teamId, bulkIntakeItems.teamId),
          eq(bulkIntakeBatches.id, bulkIntakeItems.batchId),
        ),
      )
      .where(
        and(
          ...own(p),
          eq(bulkIntakeItems.id, itemId),
          eq(bulkIntakeItems.batchId, batchId),
        ),
      );
    if (!row) throw notFound();
    if (row.expiresAt <= new Date()) throw expired();
    if (!row.item.candidateId)
      throw new ApiError(
        409,
        "bulk_candidate_required",
        "Import the candidate for this CV before uploading it.",
      );
    return { ...row.item, candidateId: row.item.candidateId };
  });
  const result = await beginCvUpload(p, item.candidateId, {
    originalName: item.originalName,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    clientUploadId: item.id,
  });
  await withTeam(p, (tx) =>
    tx
      .update(bulkIntakeItems)
      .set({ uploadId: result.data.id, updatedAt: new Date() })
      .where(
        and(
          eq(bulkIntakeItems.teamId, p.teamId),
          eq(bulkIntakeItems.id, item.id),
        ),
      ),
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

/** The caller's unexpired batches in the selected team, newest first, with each item's outcome. */
export async function listBulkBatches(p: Principal) {
  return withTeam(p, async (tx) => {
    const batches = await tx
      .select()
      .from(bulkIntakeBatches)
      .where(and(...own(p), gt(bulkIntakeBatches.expiresAt, new Date())))
      .orderBy(desc(bulkIntakeBatches.createdAt), desc(bulkIntakeBatches.id));
    const items = batches.length
      ? await tx
          .select({
            id: bulkIntakeItems.id,
            batchId: bulkIntakeItems.batchId,
            originalName: bulkIntakeItems.originalName,
            sizeBytes: bulkIntakeItems.sizeBytes,
            candidateId: bulkIntakeItems.candidateId,
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
          outcome: outcome(item.candidateId, item.status),
        })),
    }));
  });
}
