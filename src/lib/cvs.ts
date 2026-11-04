import { createHash, randomUUID } from "node:crypto";
import {
  and,
  count,
  desc,
  DrizzleQueryError,
  eq,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { activity, idempotency, records, uploads } from "@/db/schema";
import type { TeamTx } from "@/db";
import { ApiError } from "@/lib/errors";
import { withTeam } from "@/lib/db-team";
import type { Principal } from "@/lib/principal";
import {
  CvValidationError,
  cvExtension,
  validateCvMetadata,
  containsControlCharacters,
} from "@/lib/storage-format";
import {
  getStorage,
  inspectStoredCv,
  resolveStorageBinding,
  storageConfigured,
  StorageConfigurationError,
  type StorageBinding,
  type StorageGateway,
} from "@/lib/storage";

const reservationMs = 60 * 60 * 1000;
export const cvUploadSchema = z
  .object({
    originalName: z.string().trim().min(1).max(180),
    mimeType: z.string().trim().max(150),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024),
    clientUploadId: z.string().uuid(),
    legacySourceId: z.string().trim().min(1).max(180).optional(),
    sourcePath: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .refine(
        (path) =>
          !/^[\\/]|^[a-z]:/i.test(path) &&
          !path.replace(/\\/g, "/").split("/").includes("..") &&
          !containsControlCharacters(path),
        "Source path must be relative metadata within the legacy import root.",
      )
      .optional(),
  })
  .strict();
export type CvUploadInput = z.infer<typeof cvUploadSchema>;
type UploadRow = typeof uploads.$inferSelect;
export type CvDto = ReturnType<typeof cvDto>;
function cvDto(row: UploadRow) {
  return {
    id: row.id,
    candidateId: row.candidateId,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    legacySourceId: row.legacySourceId,
    sourcePath: row.sourcePath,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}
function validId(id: string) {
  if (!z.string().uuid().safeParse(id).success)
    throw new ApiError(
      400,
      "INVALID_ID",
      "A valid candidate or CV identifier is required.",
    );
}
function actorKey(p: Principal) {
  return `${p.authType}:${p.tokenId ?? p.userId}`;
}
function storageFailure(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof StorageConfigurationError)
    throw new ApiError(503, "STORAGE_SETUP_REQUIRED", error.message);
  if (error instanceof CvValidationError)
    throw new ApiError(400, "INVALID_CV", error.message);
  throw new ApiError(
    503,
    "STORAGE_UNAVAILABLE",
    "Private storage could not complete this request. Retry shortly; your upload reference is retained.",
  );
}
async function storageClient(): Promise<StorageGateway> {
  try {
    return await getStorage();
  } catch (error) {
    return storageFailure(error);
  }
}
/** The injected gateway's binding, or the configured one; resolving it contacts no provider. */
function storageBinding(storage?: StorageGateway): StorageBinding {
  try {
    return storage ? storage.binding : resolveStorageBinding();
  } catch (error) {
    return storageFailure(error);
  }
}
/** Legacy unbound references never match, so they are refused until re-bound. */
function assertBinding(row: UploadRow, binding: StorageBinding) {
  if (
    row.storageProvider !== binding.provider ||
    row.storageEnvironment !== binding.environment ||
    row.storageStore !== binding.store
  )
    throw new ApiError(
      409,
      "CV_STORAGE_BINDING_MISMATCH",
      "This CV belongs to a different storage configuration. Ask the administrator to review it.",
    );
}
/** Maps ledger refusals by SQLSTATE; database message text never reaches the client. */
function ledgerFailure(error: unknown): never {
  const cause = error instanceof DrizzleQueryError ? error.cause : error;
  const code = (cause as { code?: unknown } | undefined)?.code;
  if (code === "RQ001")
    throw new ApiError(
      409,
      "STORAGE_QUOTA_EXCEEDED",
      "The CV storage allowance has been reached, including pending uploads.",
    );
  if (code === "RQ002")
    throw new ApiError(
      503,
      "STORAGE_SETUP_REQUIRED",
      "The configured CV storage does not match its recorded environment or budget.",
    );
  throw error;
}
async function assertCandidate(
  tx: TeamTx,
  p: Principal,
  id: string,
  allowArchived = false,
) {
  const [candidate] = await tx
    .select({ id: records.id, archivedAt: records.archivedAt })
    .from(records)
    .where(
      and(
        eq(records.teamId, p.teamId),
        eq(records.id, id),
        eq(records.kind, "candidate"),
      ),
    )
    .limit(1);
  if (!candidate || (!allowArchived && candidate.archivedAt))
    throw new ApiError(
      404,
      "CANDIDATE_NOT_FOUND",
      "This candidate is not available in the selected team.",
    );
}
async function audit(
  tx: TeamTx,
  p: Principal,
  candidateId: string,
  action: string,
  metadata: Record<string, unknown>,
) {
  await tx.insert(activity).values({
    id: randomUUID(),
    teamId: p.teamId,
    recordId: candidateId,
    actorId: p.userId,
    actorType: p.authType,
    tokenId: p.tokenId ?? null,
    action,
    kind: "cv",
    summary:
      action === "cv.uploaded"
        ? "CV uploaded and format validated"
        : "CV upload rejected",
    metadata,
  });
}

/**
 * Locks the store ledger row, then the context team's row, before any upload row, so reservation,
 * completion and expiry share one lock order: store, then team, then ticket.
 */
async function lockAllocation(tx: TeamTx, binding: StorageBinding) {
  try {
    await tx.execute(
      sql`select tenant_context.lock_storage_allocation(${binding.provider}, ${binding.environment}, ${binding.store})`,
    );
  } catch (error) {
    return ledgerFailure(error);
  }
}

/**
 * Bounded cleanup of expired tickets for the current binding and legacy unbound rows. The database
 * settles each charge: S3 and legacy rows release it, Blob rows keep it as retained.
 */
export async function expireCvReservations(
  tx: TeamTx,
  teamId: string,
  binding: StorageBinding,
  now: Date,
) {
  await lockAllocation(tx, binding);
  const expired = await tx
    .select()
    .from(uploads)
    .where(
      and(
        eq(uploads.teamId, teamId),
        eq(uploads.status, "pending"),
        lte(uploads.expiresAt, now),
        or(
          and(
            eq(uploads.storageProvider, binding.provider),
            eq(uploads.storageEnvironment, binding.environment),
            eq(uploads.storageStore, binding.store),
          ),
          isNull(uploads.storageStore),
        ),
      ),
    )
    .limit(100)
    .for("update");
  for (const row of expired)
    await tx
      .update(uploads)
      .set({ status: "rejected" })
      .where(
        and(
          eq(uploads.teamId, teamId),
          eq(uploads.id, row.id),
          eq(uploads.status, "pending"),
        ),
      );
}

const cvPaginationSchema = z
  .object({
    page: z.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.number().int().min(1).max(100).default(30),
  })
  .strict();
export function parseCvListQuery(query: URLSearchParams) {
  const values: { page?: number; pageSize?: number } = {};
  for (const key of query.keys()) {
    if (!["page", "pageSize"].includes(key) || query.getAll(key).length !== 1)
      throw new ApiError(
        400,
        "INVALID_CV_PAGINATION",
        "Use only one page and pageSize parameter.",
      );
    const value = query.get(key)!;
    if (!/^[1-9]\d*$/.test(value))
      throw new ApiError(
        400,
        "INVALID_CV_PAGINATION",
        "CV pagination values must be positive whole decimal numbers.",
      );
    values[key as "page" | "pageSize"] = Number(value);
  }
  const parsed = cvPaginationSchema.safeParse(values);
  if (!parsed.success)
    throw new ApiError(
      400,
      "INVALID_CV_PAGINATION",
      "Use a page from 1 to 1000000 and a page size from 1 to 100.",
    );
  return parsed.data;
}

export async function listCandidateCvsPage(
  p: Principal,
  candidateId: string,
  options: { page?: number; pageSize?: number } = {},
) {
  validId(candidateId);
  const parsed = cvPaginationSchema.safeParse(options);
  if (!parsed.success)
    throw new ApiError(
      400,
      "INVALID_CV_PAGINATION",
      "Use a page from 1 to 1000000 and a page size from 1 to 100.",
    );
  const { page, pageSize } = parsed.data;
  return withTeam(p, async (tx) => {
    await assertCandidate(tx, p, candidateId, true);
    const where = and(
      eq(uploads.teamId, p.teamId),
      eq(uploads.candidateId, candidateId),
    );
    const [{ total }] = await tx
      .select({ total: count() })
      .from(uploads)
      .where(where);
    const rows = await tx
      .select()
      .from(uploads)
      .where(where)
      .orderBy(desc(uploads.createdAt), desc(uploads.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      data: rows.map(cvDto),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  });
}

/** Internal array form; HTTP callers use listCandidateCvsPage to keep responses bounded. */
export async function listCandidateCvs(
  p: Principal,
  candidateId: string,
): Promise<CvDto[]> {
  validId(candidateId);
  return withTeam(p, async (tx) => {
    await assertCandidate(tx, p, candidateId, true);
    const rows = await tx
      .select()
      .from(uploads)
      .where(
        and(eq(uploads.teamId, p.teamId), eq(uploads.candidateId, candidateId)),
      )
      .orderBy(desc(uploads.createdAt), desc(uploads.id));
    return rows.map(cvDto);
  });
}

export async function beginCvUpload(
  p: Principal,
  candidateId: string,
  input: CvUploadInput,
  storage?: StorageGateway,
) {
  validId(candidateId);
  // Resolve configuration errors before reserving quota, without contacting a provider.
  if (!storage && !storageConfigured()) await storageClient();
  const binding = storageBinding(storage);
  if (
    (input.legacySourceId || input.sourcePath) &&
    !p.scopes.includes("imports:write")
  )
    throw new ApiError(
      403,
      "IMPORT_PERMISSION_REQUIRED",
      "Legacy CV source metadata requires import permission.",
    );
  let metadata;
  try {
    metadata = validateCvMetadata(
      input.originalName,
      input.mimeType,
      input.sizeBytes,
    );
  } catch (error) {
    return storageFailure(error);
  }
  const now = new Date(),
    operation = `cv-upload:${candidateId}`;
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        candidateId,
        ...metadata,
        legacySourceId: input.legacySourceId ?? null,
        sourcePath: input.sourcePath ?? null,
      }),
    )
    .digest("hex");
  // Expiry commits independently, even if the following reservation is refused or a retry conflicts.
  await withTeam(p, async (tx) => {
    await assertCandidate(tx, p, candidateId);
    await expireCvReservations(tx, p.teamId, binding, now);
  });
  const row = await withTeam(p, async (tx) => {
    await assertCandidate(tx, p, candidateId);
    await lockAllocation(tx, binding);
    const [previous] = await tx
      .select()
      .from(idempotency)
      .where(
        and(
          eq(idempotency.teamId, p.teamId),
          eq(idempotency.actorKey, actorKey(p)),
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
          .from(uploads)
          .where(and(eq(uploads.teamId, p.teamId), eq(uploads.id, previousId)))
          .for("update")
      : input.legacySourceId
        ? await tx
            .select()
            .from(uploads)
            .where(
              and(
                eq(uploads.teamId, p.teamId),
                eq(uploads.legacySourceId, input.legacySourceId),
              ),
            )
            .for("update")
        : [];
    if (existing) {
      if (
        existing.candidateId !== candidateId ||
        existing.originalName !== metadata.originalName ||
        existing.mimeType !== metadata.mimeType ||
        existing.sizeBytes !== metadata.sizeBytes ||
        existing.sourcePath !== (input.sourcePath ?? null)
      )
        throw new ApiError(
          409,
          "CV_SOURCE_CONFLICT",
          "This legacy source or upload identifier already refers to a different CV.",
        );
      assertBinding(existing, binding);
      if (existing.status === "ready" || existing.status === "pending")
        return existing;
      throw new ApiError(
        409,
        "CV_UPLOAD_REJECTED",
        "This CV upload was rejected or expired. Select the file again to create a new upload; imported rejected sources require review.",
      );
    }
    const id = randomUUID();
    // The insert trigger charges the store and team ledgers or refuses over either budget.
    const [created] = await tx
      .insert(uploads)
      .values({
        id,
        teamId: p.teamId,
        candidateId,
        ...metadata,
        status: "pending",
        objectKey: `teams/${p.teamId}/cvs/${candidateId}/${id}/${randomUUID()}.${cvExtension(metadata.originalName)}`,
        storageProvider: binding.provider,
        storageEnvironment: binding.environment,
        storageStore: binding.store,
        createdBy: p.userId,
        legacySourceId: input.legacySourceId ?? null,
        sourcePath: input.sourcePath ?? null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + reservationMs),
      })
      .returning()
      .catch(ledgerFailure);
    await tx.insert(idempotency).values({
      teamId: p.teamId,
      actorKey: actorKey(p),
      operation,
      key: input.clientUploadId,
      payloadHash: hash,
      response: { uploadId: id },
      createdAt: now,
      expiresAt: new Date(now.getTime() + 7 * 86400_000),
    });
    return created;
  });
  if (row.status === "ready") return { data: cvDto(row), upload: null };
  const client = storage ?? (await storageClient());
  try {
    await client.assertVersioning();
    const expiresSeconds = Math.min(
      300,
      Math.floor((row.expiresAt.getTime() - Date.now()) / 1000),
    );
    if (expiresSeconds < 1)
      throw new ApiError(
        409,
        "CV_UPLOAD_EXPIRED",
        "The upload reservation expired. Select the file again to start a new upload.",
      );
    const ticket = await client.presignPost(
      row.objectKey,
      row.mimeType,
      row.sizeBytes,
      expiresSeconds,
    );
    return {
      data: cvDto(row),
      upload: {
        ...ticket,
        expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString(),
      },
    };
  } catch (error) {
    return storageFailure(error);
  }
}

export async function completeCvUpload(
  p: Principal,
  id: string,
  storage?: StorageGateway,
): Promise<CvDto> {
  validId(id);
  const initial = await withTeam(p, async (tx) => {
    const [row] = await tx
      .select()
      .from(uploads)
      .where(and(eq(uploads.teamId, p.teamId), eq(uploads.id, id)))
      .limit(1);
    if (!row)
      throw new ApiError(
        404,
        "CV_NOT_FOUND",
        "This CV is not available in the selected team.",
      );
    await assertCandidate(tx, p, row.candidateId);
    return row;
  });
  const binding = storageBinding(storage);
  assertBinding(initial, binding);
  if (initial.status === "ready") return cvDto(initial);
  if (initial.status === "rejected")
    throw new ApiError(
      409,
      "CV_UPLOAD_REJECTED",
      "This upload was rejected or expired. Start a new upload.",
    );
  let version: string | undefined, rejection: CvValidationError | undefined;
  if (initial.expiresAt.getTime() > Date.now()) {
    try {
      version = await inspectStoredCv(
        storage ?? (await storageClient()),
        initial,
      );
    } catch (error) {
      if (error instanceof CvValidationError) rejection = error;
      else return storageFailure(error);
    }
  }
  const result = await withTeam(p, async (tx) => {
    await lockAllocation(tx, binding);
    const [row] = await tx
      .select()
      .from(uploads)
      .where(and(eq(uploads.teamId, p.teamId), eq(uploads.id, id)))
      .for("update");
    if (!row)
      throw new ApiError(
        404,
        "CV_NOT_FOUND",
        "This CV is no longer available.",
      );
    if (row.status === "ready") return { row, rejected: false };
    if (row.status === "rejected") return { row, rejected: true };
    await assertCandidate(tx, p, row.candidateId);
    const now = new Date(),
      reject = Boolean(
        rejection || !version || row.expiresAt.getTime() <= now.getTime(),
      );
    // The status trigger settles the insert-time charge exactly once.
    const [updated] = await tx
      .update(uploads)
      .set({
        status: reject ? "rejected" : "ready",
        s3VersionId: reject ? null : version,
        completedAt: reject ? null : now,
      })
      .where(and(eq(uploads.teamId, p.teamId), eq(uploads.id, id)))
      .returning();
    await audit(
      tx,
      p,
      row.candidateId,
      reject ? "cv.rejected" : "cv.uploaded",
      { uploadId: id, sizeBytes: row.sizeBytes, mimeType: row.mimeType },
    );
    return { row: updated, rejected: reject };
  });
  if (result.rejected)
    throw new ApiError(
      400,
      "INVALID_CV",
      rejection?.message ??
        "This upload expired or was rejected. Start a new upload.",
    );
  return cvDto(result.row);
}

export async function getCvDownload(
  p: Principal,
  id: string,
  storage?: StorageGateway,
) {
  validId(id);
  const row = await withTeam(p, async (tx) => {
    const [cv] = await tx
      .select()
      .from(uploads)
      .where(and(eq(uploads.teamId, p.teamId), eq(uploads.id, id)))
      .limit(1);
    if (!cv || cv.status !== "ready")
      throw new ApiError(
        404,
        "CV_NOT_FOUND",
        "This CV is not available in the selected team.",
      );
    await assertCandidate(tx, p, cv.candidateId, true);
    return cv;
  });
  assertBinding(row, storageBinding(storage));
  if (!row.s3VersionId)
    throw new ApiError(
      409,
      "CV_VERSION_MISSING",
      "This CV has no validated private storage version. Ask the administrator to review it.",
    );
  try {
    return {
      url: await (storage ?? (await storageClient())).signDownload(
        row.objectKey,
        row.s3VersionId,
        row.originalName,
      ),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  } catch (error) {
    return storageFailure(error);
  }
}
