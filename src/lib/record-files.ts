import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { idempotency, recordFiles, records } from "@/db/schema";
import type { TeamTx } from "@/db";
import { ApiError } from "@/lib/errors";
import {
  accessContext,
  anyRecordScopeRule,
  authorize,
  decide,
  hiddenKeys,
  type AccessContext,
} from "@/lib/authz";
import type { BlobGateway } from "@/lib/blob-storage";
import { MAX_BLOB_DOWNLOAD_SLICE_BYTES } from "@/lib/blob-integrity";
import {
  BLOB_RESERVATION_MS,
  blobGateway,
  cvUploadSchema,
  isUploadReplay,
  ledgerFailure,
  lockAllocation,
  storageBinding,
  storageClient,
  storageFailure,
  uploadRateRefusal,
  withBlobReadLease,
} from "@/lib/cvs";
import { withTeam } from "@/lib/db-team";
import { requireScope } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import { idempotencyActorKey } from "@/lib/records";
import {
  CvValidationError,
  cvExtension,
  validateCvMetadata,
} from "@/lib/storage-format";
import {
  getStorage,
  storageConfigured,
  type StorageBinding,
  type StorageGateway,
} from "@/lib/storage";
import { CONFIGURABLE_KINDS } from "@/domain/field-types";
import { kindToResource, type RecordKind } from "@/domain/records";

// Files of custom file fields (R2b-06, architecture 7.5): the CV storage path for one record's
// files. Blob only: the same tickets, size cap, magic bytes, digest, read leases and ledger as CVs.

/** The CV upload body without the legacy import fields, naming the record instead of a candidate. */
export const recordFileUploadSchema = cvUploadSchema
  .omit({ legacySourceId: true, sourcePath: true })
  .extend({ recordId: z.string().uuid() })
  .strict();
export type RecordFileUploadInput = z.infer<typeof recordFileUploadSchema>;
type RecordFileRow = typeof recordFiles.$inferSelect;
/** A row its record still owns; only an erased file has no record and no file name. */
type LiveRecordFile = RecordFileRow & {
  recordId: string;
  originalName: string;
};
function live(row: RecordFileRow | undefined): row is LiveRecordFile {
  return !!row && row.erasureId === null;
}
type FileStorage = StorageGateway | BlobGateway;
export type RecordFileDto = ReturnType<typeof recordFileDto>;
/** Never an object key, store, URL or digest. */
function recordFileDto(row: LiveRecordFile) {
  return {
    id: row.id,
    recordId: row.recordId,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    downloadProtocol:
      row.status === "ready" ? ("blob-chunks-v1" as const) : null,
  };
}
/** PUT tickets per reservation, the first included; 0049 holds the same cap. */
const PUT_TICKET_LIMIT = 5;

function validId(id: string) {
  if (!z.string().uuid().safeParse(id).success)
    throw new ApiError(
      400,
      "INVALID_ID",
      "A valid record or file identifier is required.",
    );
}
const recordNotFound = () =>
  new ApiError(
    404,
    "RECORD_NOT_FOUND",
    "This record is not available in the selected team.",
  );
/** One body for every reason a file is not served, so a refusal tells nothing about the file. */
const fileNotFound = () =>
  new ApiError(
    404,
    "FILE_NOT_FOUND",
    "This file is not available in the selected team.",
  );
const integrityFailure = () =>
  new ApiError(
    409,
    "FILE_INTEGRITY_FAILED",
    "This file no longer matches its validated copy. Ask the administrator to review it.",
  );
const uploadRejected = () =>
  new ApiError(
    409,
    "FILE_UPLOAD_REJECTED",
    "This file upload was rejected or expired. Select the file again to start a new upload.",
  );
function invalidFile(error: unknown): never {
  if (error instanceof CvValidationError)
    throw new ApiError(400, "INVALID_FILE", error.message);
  throw error;
}
/** Record files live only in private Blob storage; nothing falls back to S3. */
function assertBlob(binding: StorageBinding) {
  if (binding.provider !== "blob")
    throw new ApiError(
      409,
      "FILE_STORAGE_UNSUPPORTED",
      "File fields need private Vercel Blob storage, which this deployment does not use.",
    );
}
function sameBinding(row: RecordFileRow, binding: StorageBinding) {
  return (
    row.storageProvider === binding.provider &&
    row.storageEnvironment === binding.environment &&
    row.storageStore === binding.store
  );
}
const bindingMismatch = () =>
  new ApiError(
    409,
    "FILE_STORAGE_BINDING_MISMATCH",
    "This file belongs to a different storage configuration. Ask the administrator to review it.",
  );

/**
 * The record a file belongs to, as the caller may see it, or null: a record of the team in the
 * caller's record scope, of a configurable kind the caller may view (a candidate also needs
 * candidates:read). With its archive state and its custom values.
 */
async function visibleRecord(tx: TeamTx, ctx: AccessContext, recordId: string) {
  const inScope = anyRecordScopeRule(ctx, "records");
  const [row] = await tx
    .select({
      kind: records.kind,
      archivedAt: records.archivedAt,
      customValues: sql<Record<
        string,
        unknown
      > | null>`${records.data}->'customValues'`,
    })
    .from(records)
    .where(
      and(
        eq(records.teamId, ctx.principal.teamId),
        eq(records.id, recordId),
        ...(inScope ? [inScope] : []),
      ),
    )
    .limit(1);
  const kind = row?.kind as RecordKind | undefined;
  if (
    !row ||
    !kind ||
    !(CONFIGURABLE_KINDS as readonly string[]).includes(kind) ||
    (kind === "candidate" && !ctx.scopes.includes("candidates:read")) ||
    !decide(ctx, { resource: kindToResource[kind], action: "view" })
  )
    return null;
  return { ...row, kind };
}
/** An active record the caller may edit; any record it may not see answers as missing. */
async function assertEditableRecord(
  tx: TeamTx,
  ctx: AccessContext,
  recordId: string,
) {
  const record = await visibleRecord(tx, ctx, recordId);
  if (!record || record.archivedAt) throw recordNotFound();
  authorize(ctx, { resource: kindToResource[record.kind], action: "edit" });
}

/**
 * Expires the team's pending record file reservations on this binding whose ticket window ended.
 * The settle trigger keeps each charge as retained until the cleanup confirms the object deleted.
 * Store, then team, then the rows. Returns how many it expired.
 */
export async function expireRecordFileReservations(
  tx: TeamTx,
  teamId: string,
  binding: StorageBinding,
  now: Date,
): Promise<number> {
  await lockAllocation(tx, binding);
  const expired = await tx
    .select({ id: recordFiles.id })
    .from(recordFiles)
    .where(
      and(
        eq(recordFiles.teamId, teamId),
        eq(recordFiles.status, "pending"),
        lte(recordFiles.expiresAt, now),
        eq(recordFiles.storageProvider, binding.provider),
        eq(recordFiles.storageEnvironment, binding.environment),
        eq(recordFiles.storageStore, binding.store),
      ),
    )
    .limit(100)
    .for("update");
  if (expired.length)
    await tx
      .update(recordFiles)
      .set({ status: "rejected" })
      .where(
        and(
          eq(recordFiles.teamId, teamId),
          inArray(
            recordFiles.id,
            expired.map((row) => row.id),
          ),
          eq(recordFiles.status, "pending"),
        ),
      );
  return expired.length;
}

/**
 * Reserves one file for a record the caller may edit and issues a blob-put-v1 ticket, as
 * beginCvUpload does for a Blob CV. The field value is set afterwards by a record update.
 */
export async function beginRecordFileUpload(
  p: Principal,
  input: RecordFileUploadInput,
  storage?: FileStorage,
) {
  requireScope(p, "cvs:write");
  const { recordId } = input;
  validId(recordId);
  // Resolve configuration errors before reserving quota, without contacting a provider.
  if (!storage && !storageConfigured()) await storageClient();
  const binding = storageBinding(storage);
  assertBlob(binding);
  let metadata;
  try {
    metadata = validateCvMetadata(
      input.originalName,
      input.mimeType,
      input.sizeBytes,
    );
  } catch (error) {
    return invalidFile(error);
  }
  const now = new Date(),
    operation = `record-file-upload:${recordId}`;
  const hash = createHash("sha256")
    .update(JSON.stringify({ recordId, ...metadata }))
    .digest("hex");
  // Expiry commits independently, even if the following reservation is refused or a retry conflicts.
  const overRate = await withTeam(p, async (tx, access) => {
    await assertEditableRecord(tx, accessContext(p, access), recordId);
    await expireRecordFileReservations(tx, p.teamId, binding, now);
    // Early, so an over-rate request makes no provider call; the locked check below stays authoritative.
    const refusal = await uploadRateRefusal(tx, p, now);
    return refusal && !(await isUploadReplay(tx, p, operation, input))
      ? refusal
      : null;
  });
  if (overRate) throw overRate;
  let client = storage;
  try {
    // Best effort, as for CVs: frees a few retained charges whose objects are confirmed deleted.
    client ??= await getStorage();
    const { releaseRetainedBlobCharges } = await import("@/lib/blob-reconcile");
    await releaseRetainedBlobCharges(p, blobGateway(client), {
      maxRows: 5,
      deadline: Date.now() + 5000,
      now: new Date(),
    });
  } catch {
    // Swallowed: the next upload or an owner's cleanup call retries.
  }
  const row = await withTeam(p, async (tx, access): Promise<LiveRecordFile> => {
    await assertEditableRecord(tx, accessContext(p, access), recordId);
    await lockAllocation(tx, binding);
    const [previous] = await tx
      .select()
      .from(idempotency)
      .where(
        and(
          eq(idempotency.teamId, p.teamId),
          eq(idempotency.actorKey, idempotencyActorKey(p)),
          eq(idempotency.operation, operation),
          eq(idempotency.key, input.clientUploadId),
        ),
      )
      .limit(1);
    if (previous && previous.payloadHash !== hash)
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "This upload identifier was already used with different file details.",
      );
    const previousId =
      previous?.response &&
      typeof previous.response === "object" &&
      "uploadId" in previous.response
        ? String(previous.response.uploadId)
        : undefined;
    const [existing] = previousId
      ? await tx
          .select()
          .from(recordFiles)
          .where(
            and(
              eq(recordFiles.teamId, p.teamId),
              eq(recordFiles.id, previousId),
            ),
          )
          .for("update")
      : [];
    if (existing) {
      if (
        !live(existing) ||
        existing.recordId !== recordId ||
        existing.originalName !== metadata.originalName ||
        existing.mimeType !== metadata.mimeType ||
        existing.sizeBytes !== metadata.sizeBytes
      )
        throw new ApiError(
          409,
          "FILE_UPLOAD_CONFLICT",
          "This upload identifier already refers to a different file.",
        );
      if (!sameBinding(existing, binding)) throw bindingMismatch();
      if (existing.status === "ready") return existing;
      if (existing.status !== "pending") throw uploadRejected();
      // Counted under the row lock before the ticket is issued; the guard allows only +1.
      if (existing.putTicketsIssued >= PUT_TICKET_LIMIT)
        throw new ApiError(
          409,
          "FILE_UPLOAD_TICKET_LIMIT",
          "This upload has used all of its upload links. Try again after its reservation expires, within 15 minutes, by selecting the file again.",
        );
      const [counted] = await tx
        .update(recordFiles)
        .set({
          putTicketsIssued: sql`${recordFiles.putTicketsIssued} + 1`,
        })
        .where(
          and(
            eq(recordFiles.teamId, p.teamId),
            eq(recordFiles.id, existing.id),
          ),
        )
        .returning();
      return counted as LiveRecordFile;
    }
    // Only a new reservation counts against the team's rate; the ledger lock above serializes it.
    const refusal = await uploadRateRefusal(tx, p, now);
    if (refusal) throw refusal;
    const id = randomUUID();
    // The insert trigger charges the store and team ledgers or refuses over either budget.
    const [created] = await tx
      .insert(recordFiles)
      .values({
        id,
        teamId: p.teamId,
        recordId,
        ...metadata,
        status: "pending",
        objectKey: `teams/${p.teamId}/files/${recordId}/${id}/${randomUUID()}.${cvExtension(metadata.originalName)}`,
        storageProvider: binding.provider,
        storageEnvironment: binding.environment,
        storageStore: binding.store,
        createdBy: p.userId,
        // The first ticket is issued below and counts against the reservation's cap.
        putTicketsIssued: 1,
        createdAt: now,
        expiresAt: new Date(now.getTime() + BLOB_RESERVATION_MS),
      })
      .returning()
      .catch(ledgerFailure);
    await tx.insert(idempotency).values({
      teamId: p.teamId,
      actorKey: idempotencyActorKey(p),
      operation,
      key: input.clientUploadId,
      payloadHash: hash,
      response: { uploadId: id },
      roleVersionId: access.roleVersionId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 7 * 86400_000),
    });
    return created as LiveRecordFile;
  });
  if (row.status === "ready") return { data: recordFileDto(row), upload: null };
  client ??= await storageClient();
  try {
    if (row.expiresAt.getTime() - Date.now() < 1000)
      throw new ApiError(
        409,
        "FILE_UPLOAD_EXPIRED",
        "The upload reservation expired. Select the file again to start a new upload.",
      );
    // The charge is committed; a failed issuance keeps it and a replay reuses the path.
    const ticket = await blobGateway(client).issuePutTicket(row);
    return {
      data: recordFileDto(row),
      upload: {
        protocol: "blob-put-v1" as const,
        method: "PUT" as const,
        url: ticket.url,
        headers: { "content-type": row.mimeType },
        expiresAt: new Date(ticket.expiresAt).toISOString(),
        maxBytes: row.sizeBytes,
      },
    };
  } catch (error) {
    return storageFailure(error);
  }
}

/**
 * Validates the uploaded object (size, type, magic bytes, server-computed SHA-256) and settles the
 * reservation ready or rejected, as completeCvUpload does for a Blob CV. A missing object or a
 * transport failure leaves it pending. No activity row: the record update that stores the file's id
 * is the audited change. readTimeoutMs is internal (tests).
 */
export async function completeRecordFileUpload(
  p: Principal,
  id: string,
  storage?: FileStorage,
  options: { readTimeoutMs?: number } = {},
): Promise<RecordFileDto> {
  requireScope(p, "cvs:write");
  validId(id);
  const initial = await withTeam(p, async (tx, access) => {
    const [row] = await tx
      .select()
      .from(recordFiles)
      .where(and(eq(recordFiles.teamId, p.teamId), eq(recordFiles.id, id)))
      .limit(1);
    if (!live(row)) throw fileNotFound();
    await assertEditableRecord(tx, accessContext(p, access), row.recordId);
    return row;
  });
  const binding = storageBinding(storage);
  assertBlob(binding);
  if (!sameBinding(initial, binding)) throw bindingMismatch();
  if (initial.status === "ready") return recordFileDto(initial);
  if (initial.status === "rejected") throw uploadRejected();
  let sha256: string | undefined, rejection: CvValidationError | undefined;
  if (initial.expiresAt.getTime() > Date.now()) {
    try {
      const gateway = blobGateway(storage ?? (await storageClient()));
      // A missing object or transport failure stays pending: a rejection burns the path.
      const inspected = await withBlobReadLease(p, binding.store, () =>
        gateway.inspectUpload(initial, options.readTimeoutMs),
      );
      if (!inspected)
        throw new Error("The uploaded file is not in private storage yet.");
      sha256 = inspected.sha256;
    } catch (error) {
      if (error instanceof CvValidationError) rejection = error;
      else return storageFailure(error);
    }
  }
  const result = await withTeam(p, async (tx, access) => {
    await lockAllocation(tx, binding);
    const [row] = await tx
      .select()
      .from(recordFiles)
      .where(and(eq(recordFiles.teamId, p.teamId), eq(recordFiles.id, id)))
      .for("update");
    if (!live(row)) throw fileNotFound();
    if (row.status === "ready") return { row, rejected: false, settled: false };
    if (row.status === "rejected")
      return { row, rejected: true, settled: false };
    await assertEditableRecord(tx, accessContext(p, access), row.recordId);
    const now = new Date(),
      reject = Boolean(
        rejection || !sha256 || row.expiresAt.getTime() <= now.getTime(),
      );
    // The status trigger settles the insert-time charge exactly once.
    const [updated] = await tx
      .update(recordFiles)
      .set({
        status: reject ? "rejected" : "ready",
        blobSha256: reject ? null : sha256,
        blobSizeBytes: reject ? null : row.sizeBytes,
        completedAt: reject ? null : now,
      })
      .where(and(eq(recordFiles.teamId, p.teamId), eq(recordFiles.id, id)))
      .returning();
    return { row: updated as LiveRecordFile, rejected: reject, settled: true };
  });
  // This call settled the upload: one cooldown-gated cleanup sweep, which never alters the response.
  if (result.settled) {
    const { sweepAfterBlobUpload } = await import("@/lib/blob-reconcile");
    await sweepAfterBlobUpload(p, storage);
  }
  if (result.rejected)
    throw new ApiError(
      400,
      "INVALID_FILE",
      rejection?.message ??
        "This upload expired or was rejected. Start a new upload.",
    );
  return recordFileDto(result.row);
}

/**
 * Reauthorizes every download request (architecture 3.4 and 3.5): a ready, unerased file on this
 * binding, of a record in the caller's team and record scope whose kind the caller may view, whose
 * customValues hold the file's id under a key the caller may see. Anything else is FILE_NOT_FOUND.
 * Archived records' files stay readable. The trusted reference only; no provider call.
 */
async function blobReference(p: Principal, id: string, storage?: FileStorage) {
  requireScope(p, "cvs:read");
  validId(id);
  const binding = storageBinding(storage);
  const row = await withTeam(p, async (tx, access) => {
    const ctx = accessContext(p, access);
    const [file] = await tx
      .select()
      .from(recordFiles)
      .where(and(eq(recordFiles.teamId, p.teamId), eq(recordFiles.id, id)))
      .limit(1);
    if (!live(file) || file.status !== "ready" || !sameBinding(file, binding))
      throw fileNotFound();
    const record = await visibleRecord(tx, ctx, file.recordId);
    const hidden = record ? hiddenKeys(ctx, record.kind) : null;
    if (
      !record ||
      !hidden ||
      hidden.has("customValues") ||
      !Object.entries(record.customValues ?? {}).some(
        ([key, value]) => value === file.id && !hidden.has(key),
      )
    )
      throw fileNotFound();
    return file;
  });
  if (!row.blobSha256 || row.blobSizeBytes !== row.sizeBytes)
    throw integrityFailure();
  return {
    row,
    store: binding.store,
    manifest: {
      protocol: "blob-chunks-v1" as const,
      uploadId: row.id,
      originalName: row.originalName,
      contentType: row.mimeType,
      sizeBytes: row.blobSizeBytes,
      sha256: row.blobSha256,
      chunkSize: MAX_BLOB_DOWNLOAD_SLICE_BYTES,
      chunkCount: Math.ceil(row.blobSizeBytes / MAX_BLOB_DOWNLOAD_SLICE_BYTES),
    },
  };
}

/** The manifest grants nothing by itself; every chunk is authorized again. */
export async function getRecordFileManifest(
  p: Principal,
  id: string,
  storage?: FileStorage,
) {
  return (await blobReference(p, id, storage)).manifest;
}

/** Releases one slice only after the whole object matches its validated digest. */
export async function getRecordFileChunk(
  p: Principal,
  id: string,
  index: number,
  storage?: FileStorage,
  options: { readTimeoutMs?: number } = {},
) {
  const { row, store, manifest } = await blobReference(p, id, storage);
  if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.chunkCount)
    throw new ApiError(
      400,
      "INVALID_CV_CHUNK",
      "This file has no chunk with that index.",
    );
  const offset = index * manifest.chunkSize;
  let bytes: Buffer | null;
  try {
    const gateway = blobGateway(storage ?? (await storageClient()));
    bytes = await withBlobReadLease(p, store, () =>
      gateway.readVerifiedSlice(
        {
          teamId: row.teamId,
          objectKey: row.objectKey,
          mimeType: row.mimeType,
          sizeBytes: manifest.sizeBytes,
          sha256: manifest.sha256,
        },
        offset,
        Math.min(manifest.chunkSize, manifest.sizeBytes - offset),
        options.readTimeoutMs,
      ),
    );
  } catch (error) {
    if (error instanceof CvValidationError) throw integrityFailure();
    return storageFailure(error);
  }
  if (!bytes) throw integrityFailure();
  return { ...manifest, index, offset, bytes };
}
