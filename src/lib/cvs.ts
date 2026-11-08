import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  DrizzleQueryError,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  activity,
  idempotency,
  records,
  storageUsage,
  uploads,
} from "@/db/schema";
import type { TeamTx } from "@/db";
import { ApiError } from "@/lib/errors";
import { withTeam } from "@/lib/db-team";
import { requireScope } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import type { BlobGateway } from "@/lib/blob-storage";
import { MAX_BLOB_DOWNLOAD_SLICE_BYTES } from "@/lib/blob-integrity";
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
  storageSetupRequired,
  type StorageBinding,
  type StorageGateway,
} from "@/lib/storage";

const S3_RESERVATION_MS = 60 * 60 * 1000;
/**
 * Kept short because a still-valid Blob ticket can recreate a deleted object; cleanup waits for
 * the last ticket of a pathname to expire. Tickets stay capped at 300 s inside it.
 */
export const BLOB_RESERVATION_MS = 15 * 60 * 1000;
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
/** A row a candidate still owns; only an erased upload has no candidate and no file name. */
type LiveUpload = UploadRow & { candidateId: string; originalName: string };
function live(row: UploadRow | undefined): row is LiveUpload {
  return !!row && row.erasureId === null;
}
type CvStorage = StorageGateway | BlobGateway;
export type CvDto = ReturnType<typeof cvDto>;
/** Clients choose the download protocol from the reference, never from a hostname. */
function downloadProtocol(row: UploadRow) {
  if (row.status !== "ready") return null;
  if (row.storageProvider === "blob") return "blob-chunks-v1" as const;
  return row.storageProvider === "s3" ? ("s3-url-v1" as const) : null;
}
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
    downloadProtocol: downloadProtocol(row),
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
/** Setup refusals all show one plain message; their own text can name a provider or setting. */
function storageFailure(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof StorageConfigurationError)
    throw storageSetupRequired(error);
  if (error instanceof CvValidationError)
    throw new ApiError(400, "INVALID_CV", error.message);
  throw new ApiError(
    503,
    "STORAGE_UNAVAILABLE",
    "Private storage could not complete this request. Retry shortly; your upload reference is retained.",
  );
}
export async function storageClient(): Promise<CvStorage> {
  try {
    return await getStorage();
  } catch (error) {
    return storageFailure(error);
  }
}
/** The injected gateway's binding, or the configured one; resolving it contacts no provider. */
export function storageBinding(storage?: CvStorage): StorageBinding {
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
/** After assertBinding the gateway must also speak the row's protocol; nothing falls back. */
export function blobGateway(storage: CvStorage): BlobGateway {
  if (!("readVerifiedSlice" in storage))
    throw new StorageConfigurationError(
      "The configured CV storage cannot serve Blob references.",
      "blob_protocol_mismatch",
    );
  return storage;
}
function s3Gateway(storage: CvStorage): StorageGateway {
  if ("readVerifiedSlice" in storage)
    throw new StorageConfigurationError(
      "The configured CV storage cannot serve S3 references.",
      "aws_protocol_mismatch",
    );
  return storage;
}
const integrityFailure = () =>
  new ApiError(
    409,
    "CV_INTEGRITY_FAILED",
    "This CV no longer matches its validated copy. Ask the administrator to review it.",
  );
const protocolMismatch = () =>
  new ApiError(
    409,
    "CV_DOWNLOAD_PROTOCOL_MISMATCH",
    "This CV uses a different download method. Refresh the CV list and try again.",
  );
/** Maps ledger refusals by SQLSTATE; database message text never reaches the client. */
function ledgerFailure(error: unknown): never {
  const cause = error instanceof DrizzleQueryError ? error.cause : error;
  const code = (cause as { code?: unknown } | undefined)?.code;
  if (code === "RQ001")
    throw new ApiError(
      409,
      "STORAGE_QUOTA_EXCEEDED",
      "The CV storage limit has been reached, including pending uploads and files waiting for cleanup. Ask a team owner or admin to review the team's storage settings.",
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
 * Locks the store ledger row, then team rows, before any upload row, so reservation, completion
 * and expiry share one lock order: store, then team, then ticket. The helper also releases the
 * store's expired S3 reservations for every team before any new charge is checked.
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
 * Caps Blob provider reads across server instances (2 per team, 8 per store, fixed in the database
 * helper). The lease commits before the read and fails fast over a cap instead of queueing. Release
 * is best effort: a lease left behind by a crash or a failed release expires on its own after 30 s.
 */
async function withBlobReadLease<T>(
  p: Principal,
  store: string,
  read: () => Promise<T>,
): Promise<T> {
  const lease = await withTeam(p, async (tx) => {
    try {
      const { rows } = await tx.execute<{ lease: string | null }>(
        sql`select tenant_context.acquire_blob_read(${store}) as lease`,
      );
      return rows[0]?.lease ?? null;
    } catch (error) {
      return ledgerFailure(error);
    }
  });
  if (!lease)
    return storageFailure(
      new Error("Too many private Blob reads are in progress."),
    );
  try {
    return await read();
  } finally {
    await withTeam(p, (tx) =>
      tx.execute(sql`select tenant_context.release_blob_read(${lease})`),
    ).catch(() => {});
  }
}

/**
 * Bounded cleanup of expired tickets for the current binding and legacy unbound rows. The database
 * settles each charge: S3 and legacy rows release it, Blob rows keep it as retained until cleanup
 * confirms the object deleted. Returns how many reservations it expired.
 */
export async function expireCvReservations(
  tx: TeamTx,
  teamId: string,
  binding: StorageBinding,
  now: Date,
): Promise<number> {
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
  return expired.length;
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

/** Exactly one decimal index without leading zeros, and nothing else. */
export function parseCvChunkQuery(query: URLSearchParams): number {
  const keys = [...query.keys()];
  const value = query.get("index") ?? "";
  if (
    keys.length !== 1 ||
    keys[0] !== "index" ||
    !/^(?:0|[1-9]\d{0,8})$/.test(value)
  )
    throw new ApiError(
      400,
      "INVALID_CV_CHUNK",
      "Request one chunk with a single whole decimal index parameter.",
    );
  return Number(value);
}

/** A CV is the candidate's personal data, so every CV read also needs candidates:read. */
function requireCandidateRead(p: Principal) {
  requireScope(p, "candidates:read");
}

export async function listCandidateCvsPage(
  p: Principal,
  candidateId: string,
  options: { page?: number; pageSize?: number } = {},
) {
  requireCandidateRead(p);
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
  requireCandidateRead(p);
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

/** PUT tickets per Blob reservation, the first included; 0019 holds the same cap. */
const BLOB_PUT_TICKET_LIMIT = 5;

/** The refusal for one more new reservation under the team's upload rate, or null when it is off. */
async function uploadRateRefusal(tx: TeamTx, p: Principal, now: Date) {
  const [usage] = await tx
    .select({ rate: storageUsage.uploadRequestsPerMinute })
    .from(storageUsage)
    .where(eq(storageUsage.teamId, p.teamId));
  if (!usage?.rate) return null;
  const [{ recent }] = await tx
    .select({ recent: count() })
    .from(uploads)
    .where(
      and(
        eq(uploads.teamId, p.teamId),
        gt(uploads.createdAt, new Date(now.getTime() - 60_000)),
      ),
    );
  return recent >= usage.rate
    ? new ApiError(
        429,
        "CV_UPLOAD_RATE_LIMITED",
        `Your team allows ${usage.rate} new CV uploads per minute. Wait a minute, then try again.`,
      )
    : null;
}

/** Whether the request names an existing reservation, which the upload rate never refuses. */
async function isUploadReplay(
  tx: TeamTx,
  p: Principal,
  operation: string,
  input: CvUploadInput,
) {
  const [previous] = await tx
    .select({ key: idempotency.key })
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
  if (previous) return true;
  if (!input.legacySourceId) return false;
  const [existing] = await tx
    .select({ id: uploads.id })
    .from(uploads)
    .where(
      and(
        eq(uploads.teamId, p.teamId),
        eq(uploads.legacySourceId, input.legacySourceId),
      ),
    )
    .limit(1);
  return Boolean(existing);
}

export async function beginCvUpload(
  p: Principal,
  candidateId: string,
  input: CvUploadInput,
  storage?: CvStorage,
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
  const overRate = await withTeam(p, async (tx) => {
    await assertCandidate(tx, p, candidateId);
    await expireCvReservations(tx, p.teamId, binding, now);
    // Early, so an over-rate request makes no provider call; the locked check below stays authoritative.
    const refusal = await uploadRateRefusal(tx, p, now);
    return refusal && !(await isUploadReplay(tx, p, operation, input))
      ? refusal
      : null;
  });
  if (overRate) throw overRate;
  let client = storage;
  if (binding.provider === "blob")
    try {
      // Best effort: frees a few retained charges whose objects are confirmed deleted. Its outcome
      // never changes the reservation; a setup failure is reported again when the ticket is issued.
      client ??= await getStorage();
      const { releaseRetainedBlobCharges } =
        await import("@/lib/blob-reconcile");
      await releaseRetainedBlobCharges(p, blobGateway(client), {
        maxRows: 5,
        deadline: Date.now() + 5000,
        now: new Date(),
      });
    } catch {
      // Swallowed: the next upload or an owner's cleanup call retries.
    }
  const row = await withTeam(p, async (tx): Promise<LiveUpload> => {
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
        !live(existing) ||
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
      if (existing.status === "ready") return existing;
      if (existing.status === "pending") {
        if (existing.storageProvider !== "blob") return existing;
        // Counted under the row lock before the ticket is issued; the guard allows only +1.
        if (existing.putTicketsIssued >= BLOB_PUT_TICKET_LIMIT)
          throw new ApiError(
            409,
            "CV_UPLOAD_TICKET_LIMIT",
            "This upload has used all of its upload links. Try again after its reservation expires, within 15 minutes, by selecting the file again.",
          );
        const [counted] = await tx
          .update(uploads)
          .set({ putTicketsIssued: sql`${uploads.putTicketsIssued} + 1` })
          .where(and(eq(uploads.teamId, p.teamId), eq(uploads.id, existing.id)))
          .returning();
        return counted as LiveUpload;
      }
      throw new ApiError(
        409,
        "CV_UPLOAD_REJECTED",
        "This CV upload was rejected or expired. Select the file again to create a new upload; imported rejected sources require review.",
      );
    }
    // Only a new reservation counts against the team's rate; the ledger lock above serializes it.
    const refusal = await uploadRateRefusal(tx, p, now);
    if (refusal) throw refusal;
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
        // The first Blob ticket is issued below and counts against the reservation's cap.
        putTicketsIssued: binding.provider === "blob" ? 1 : 0,
        createdAt: now,
        expiresAt: new Date(
          now.getTime() +
            (binding.provider === "blob"
              ? BLOB_RESERVATION_MS
              : S3_RESERVATION_MS),
        ),
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
    // Reserved above for this candidate and file name.
    return created as LiveUpload;
  });
  if (row.status === "ready") return { data: cvDto(row), upload: null };
  client ??= await storageClient();
  const expired = () =>
    new ApiError(
      409,
      "CV_UPLOAD_EXPIRED",
      "The upload reservation expired. Select the file again to start a new upload.",
    );
  try {
    if (row.storageProvider === "blob") {
      if (row.expiresAt.getTime() - Date.now() < 1000) throw expired();
      // The charge is committed; a failed issuance keeps it and a replay reuses the path.
      const ticket = await blobGateway(client).issuePutTicket(row);
      return {
        data: cvDto(row),
        upload: {
          protocol: "blob-put-v1" as const,
          method: "PUT" as const,
          url: ticket.url,
          headers: { "content-type": row.mimeType },
          expiresAt: new Date(ticket.expiresAt).toISOString(),
          maxBytes: row.sizeBytes,
        },
      };
    }
    const s3 = s3Gateway(client);
    await s3.assertVersioning();
    const expiresSeconds = Math.min(
      300,
      Math.floor((row.expiresAt.getTime() - Date.now()) / 1000),
    );
    if (expiresSeconds < 1) throw expired();
    const ticket = await s3.presignPost(
      row.objectKey,
      row.mimeType,
      row.sizeBytes,
      expiresSeconds,
    );
    return {
      data: cvDto(row),
      upload: {
        protocol: "s3-form-v1" as const,
        method: "POST" as const,
        ...ticket,
        expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString(),
        maxBytes: row.sizeBytes,
      },
    };
  } catch (error) {
    return storageFailure(error);
  }
}

/** readTimeoutMs is internal (tests); routes never pass it and it is capped at 15 s. */
export async function completeCvUpload(
  p: Principal,
  id: string,
  storage?: CvStorage,
  options: { readTimeoutMs?: number } = {},
): Promise<CvDto> {
  validId(id);
  const initial = await withTeam(p, async (tx) => {
    const [row] = await tx
      .select()
      .from(uploads)
      .where(and(eq(uploads.teamId, p.teamId), eq(uploads.id, id)))
      .limit(1);
    // An erased upload reads as missing; completing it changes nothing and writes no activity.
    if (!live(row))
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
  let version: string | undefined,
    sha256: string | undefined,
    rejection: CvValidationError | undefined;
  if (initial.expiresAt.getTime() > Date.now()) {
    try {
      const client = storage ?? (await storageClient());
      if (initial.storageProvider === "blob") {
        const gateway = blobGateway(client);
        // A missing object or transport failure stays pending: a Blob rejection burns the path.
        const inspected = await withBlobReadLease(p, binding.store, () =>
          gateway.inspectUpload(initial, options.readTimeoutMs),
        );
        if (!inspected)
          throw new Error("The uploaded CV is not in private storage yet.");
        sha256 = inspected.sha256;
      } else version = await inspectStoredCv(s3Gateway(client), initial);
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
    if (!live(row))
      throw new ApiError(
        404,
        "CV_NOT_FOUND",
        "This CV is no longer available.",
      );
    if (row.status === "ready") return { row, rejected: false, settled: false };
    if (row.status === "rejected")
      return { row, rejected: true, settled: false };
    await assertCandidate(tx, p, row.candidateId);
    const now = new Date(),
      reject = Boolean(
        rejection ||
        !(version || sha256) ||
        row.expiresAt.getTime() <= now.getTime(),
      );
    // The status trigger settles the insert-time charge exactly once.
    const [updated] = await tx
      .update(uploads)
      .set({
        status: reject ? "rejected" : "ready",
        s3VersionId: reject ? null : (version ?? null),
        blobSha256: reject ? null : (sha256 ?? null),
        blobSizeBytes: reject || !sha256 ? null : row.sizeBytes,
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
    return { row: updated, rejected: reject, settled: true };
  });
  // This call settled a Blob upload: one cooldown-gated cleanup sweep, which never alters the response.
  if (result.settled && result.row.storageProvider === "blob") {
    const { sweepAfterBlobUpload } = await import("@/lib/blob-reconcile");
    await sweepAfterBlobUpload(p, storage);
  }
  if (result.rejected)
    throw new ApiError(
      400,
      "INVALID_CV",
      rejection?.message ??
        "This upload expired or was rejected. Start a new upload.",
    );
  return cvDto(result.row);
}

/** Reauthorizes every download request; archived candidates' CVs stay readable. */
export async function readyCv(p: Principal, id: string) {
  requireCandidateRead(p);
  validId(id);
  return withTeam(p, async (tx) => {
    const [cv] = await tx
      .select()
      .from(uploads)
      .where(and(eq(uploads.teamId, p.teamId), eq(uploads.id, id)))
      .limit(1);
    if (!live(cv) || cv.status !== "ready")
      throw new ApiError(
        404,
        "CV_NOT_FOUND",
        "This CV is not available in the selected team.",
      );
    await assertCandidate(tx, p, cv.candidateId, true);
    return cv;
  });
}

export async function getCvDownload(
  p: Principal,
  id: string,
  storage?: CvStorage,
) {
  const row = await readyCv(p, id);
  if (row.storageProvider === "blob") throw protocolMismatch();
  assertBinding(row, storageBinding(storage));
  if (!row.s3VersionId)
    throw new ApiError(
      409,
      "CV_VERSION_MISSING",
      "This CV has no validated private storage version. Ask the administrator to review it.",
    );
  try {
    return {
      url: await s3Gateway(storage ?? (await storageClient())).signDownload(
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

/** The trusted Blob reference; no provider call, URL or pathname. */
async function blobReference(p: Principal, id: string, storage?: CvStorage) {
  const row = await readyCv(p, id);
  if (row.storageProvider !== "blob") throw protocolMismatch();
  const binding = storageBinding(storage);
  assertBinding(row, binding);
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
export async function getCvManifest(
  p: Principal,
  id: string,
  storage?: CvStorage,
) {
  return (await blobReference(p, id, storage)).manifest;
}

/** Releases one slice only after the whole object matches its validated digest. */
export async function getCvChunk(
  p: Principal,
  id: string,
  index: number,
  storage?: CvStorage,
  options: { readTimeoutMs?: number } = {},
) {
  const { row, store, manifest } = await blobReference(p, id, storage);
  if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.chunkCount)
    throw new ApiError(
      400,
      "INVALID_CV_CHUNK",
      "This CV has no chunk with that index.",
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

/**
 * Each listed candidate of the team (archived ones included) with its ready CVs, oldest completed
 * first. A candidate the team does not have is left out.
 */
export async function readyCvsOf(p: Principal, candidateIds: string[]) {
  requireCandidateRead(p);
  for (const id of candidateIds) validId(id);
  return withTeam(p, async (tx) => {
    const found = await tx
      .select({ id: records.id })
      .from(records)
      .where(
        and(
          eq(records.teamId, p.teamId),
          eq(records.kind, "candidate"),
          inArray(records.id, candidateIds),
        ),
      );
    const rows = await tx
      .select({
        id: uploads.id,
        candidateId: uploads.candidateId,
        originalName: uploads.originalName,
        mimeType: uploads.mimeType,
        completedAt: uploads.completedAt,
      })
      .from(uploads)
      .where(
        and(
          eq(uploads.teamId, p.teamId),
          inArray(uploads.candidateId, candidateIds),
          eq(uploads.status, "ready"),
          isNull(uploads.erasureId),
        ),
      )
      .orderBy(asc(uploads.completedAt), asc(uploads.id));
    return new Map(
      found.map(({ id }) => [
        id,
        rows
          .filter((row) => row.candidateId === id)
          .map((row) => ({
            id: row.id,
            candidateId: id,
            originalName: row.originalName!,
            mimeType: row.mimeType,
            completedAt: row.completedAt!.toISOString(),
          })),
      ]),
    );
  });
}

/**
 * The whole verified object of a CV readyCv authorized, for server-side text extraction only; it is
 * never returned to a client. Read under the Blob read lease and released only when it matches the
 * validated digest. Null for a legacy S3 reference, which is not read this way.
 */
export async function readVerifiedCv(
  p: Principal,
  row: UploadRow,
  timeoutMs: number,
  storage?: CvStorage,
): Promise<Buffer | null> {
  if (row.storageProvider !== "blob") return null;
  const binding = storageBinding(storage);
  assertBinding(row, binding);
  if (!row.blobSha256 || row.blobSizeBytes !== row.sizeBytes)
    throw integrityFailure();
  let bytes: Buffer | null;
  try {
    const gateway = blobGateway(storage ?? (await storageClient()));
    bytes = await withBlobReadLease(p, binding.store, () =>
      gateway.readVerifiedObject(
        {
          teamId: row.teamId,
          objectKey: row.objectKey,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          sha256: row.blobSha256!,
        },
        timeoutMs,
      ),
    );
  } catch (error) {
    if (error instanceof CvValidationError) throw integrityFailure();
    return storageFailure(error);
  }
  if (!bytes) throw integrityFailure();
  return bytes;
}

/**
 * Writes the exact bytes of a pending Blob reservation from the server, for uploads sent inside an
 * MCP request. completeCvUpload then verifies them as for any upload; an object already at the path,
 * for example after a lost response, is left for completion to judge. Anything not pending is left
 * to completion as well.
 */
export async function putCvBytes(
  p: Principal,
  id: string,
  bytes: Buffer,
  storage?: CvStorage,
): Promise<void> {
  validId(id);
  const row = await withTeam(p, async (tx) => {
    const [row] = await tx
      .select()
      .from(uploads)
      .where(and(eq(uploads.teamId, p.teamId), eq(uploads.id, id)))
      .limit(1);
    if (!live(row))
      throw new ApiError(
        404,
        "CV_NOT_FOUND",
        "This CV is not available in the selected team.",
      );
    await assertCandidate(tx, p, row.candidateId);
    return row;
  });
  if (row.status !== "pending") return;
  assertBinding(row, storageBinding(storage));
  try {
    await blobGateway(storage ?? (await storageClient())).putReservedObject(
      row,
      bytes,
    );
  } catch (error) {
    return storageFailure(error);
  }
}
