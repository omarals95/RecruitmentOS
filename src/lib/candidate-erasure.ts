import { and, DrizzleQueryError, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordFiles, uploads } from "@/db/schema";
import type { BlobGateway } from "@/lib/blob-storage";
import {
  DELETE_GRACE_MS,
  releaseRetainedBlobCharges,
} from "@/lib/blob-reconcile";
import { blobGateway, storageBinding, storageClient } from "@/lib/cvs";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";
import { storageConfigured, type StorageGateway } from "@/lib/storage";
import { uuidSchema } from "@/domain/records";

export const candidateErasureSchema = z
  .object({ confirmName: z.string().min(1).max(300) })
  .strict();
export type CandidateErasureInput = z.infer<typeof candidateErasureSchema>;
/** What tenant_context.erase_candidate removed, unlinked or redacted, in its audit order; counts only. */
export const ERASURE_COUNTS = [
  "applications",
  "interviews",
  "offers",
  "onboarding",
  "checklistItems",
  "comments",
  "followUpStates",
  "tasksUnlinked",
  "savedViewsCleared",
  "bulkItems",
  "cvFiles",
  "recordFiles",
  "activityRedacted",
  "notificationReads",
  "idempotencyKeys",
] as const;
export type ErasureCounts = Record<(typeof ERASURE_COUNTS)[number], number>;
export type CandidateErasure = {
  erasureId: string;
  alreadyErased: boolean;
  erasedAt: string;
  /** Null when the candidate was already erased by an earlier call. */
  removed: ErasureCounts | null;
  /**
   * This erasure's Blob CV files and record files together: deleted, still waiting, and when the
   * last waiting one may go.
   */
  cvStorage: { deleted: number; waiting: number; deleteAfter: string | null };
};
type HelperResult = {
  erasureId: string;
  alreadyErased: boolean;
  erasedAt: string;
  removed?: ErasureCounts;
};

const forbidden = () =>
  new ApiError(
    403,
    "erasure_forbidden",
    "Only a team owner can permanently erase a candidate.",
  );
/**
 * The ledger trigger refused to move a CV's charge (its store or team usage row is missing). Logs
 * one safe line with the correlation ID the response carries; the transaction rolls back.
 */
function settlementFailed() {
  const correlationId = crypto.randomUUID();
  console.error(
    `erasure_storage_settlement_failed correlationId=${correlationId}`,
  );
  return new ApiError(
    500,
    "erasure_storage_settlement_failed",
    "The candidate could not be erased because the team's CV storage records need checking. Nothing was changed.",
    correlationId,
  );
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

/**
 * The deletion pass for this erasure's Blob CVs and record files, after the erasure committed:
 * delete, confirm by head, then release, each only once the file's last ticket expired at least
 * 10 minutes ago.
 * No Blob gateway (another provider or no setup) skips it; a failure leaves the files for a later
 * cleanup. Neither changes the erasure's outcome.
 */
async function deleteErasedCvs(
  p: Principal,
  erasureId: string,
  storage?: StorageGateway | BlobGateway,
) {
  // Without storage settings (local runs, the script outside Vercel) there is nothing to build.
  if (!storage && !storageConfigured()) return;
  let gateway: BlobGateway;
  try {
    if (storageBinding(storage).provider !== "blob") return;
    gateway = blobGateway(storage ?? (await storageClient()));
  } catch {
    return;
  }
  try {
    await releaseRetainedBlobCharges(p, gateway, {
      maxRows: 50,
      deadline: Date.now() + 10_000,
      now: new Date(),
      erasureId,
    });
  } catch {
    console.error(
      "Candidate erasure CV cleanup did not finish; a later CV storage cleanup retries.",
    );
  }
}

/** One statement over both tables: the erasure's Blob CV files and its record files. */
async function cvStorageOf(
  p: Principal,
  erasureId: string,
): Promise<CandidateErasure["cvStorage"]> {
  const files = sql`(select ${uploads.blobDeletedAt} as deleted_at, ${uploads.expiresAt} as expires_at from ${uploads} where ${and(
    eq(uploads.teamId, p.teamId),
    eq(uploads.erasureId, erasureId),
    eq(uploads.storageProvider, "blob"),
  )} union all select ${recordFiles.blobDeletedAt}, ${recordFiles.expiresAt} from ${recordFiles} where ${and(
    eq(recordFiles.teamId, p.teamId),
    eq(recordFiles.erasureId, erasureId),
  )})`;
  const {
    rows: [row],
  } = await withTeam(p, (tx) =>
    tx.execute<{
      deleted: number | string;
      waiting: number | string;
      lastExpiry: Date | string | null;
    }>(
      sql`select count(*) filter (where f.deleted_at is not null) as deleted, count(*) filter (where f.deleted_at is null) as waiting, max(f.expires_at) filter (where f.deleted_at is null) as "lastExpiry" from ${files} f`,
    ),
  );
  const lastExpiry = row?.lastExpiry ? new Date(row.lastExpiry) : null;
  return {
    deleted: Number(row?.deleted ?? 0),
    waiting: Number(row?.waiting ?? 0),
    deleteAfter: lastExpiry
      ? new Date(lastExpiry.getTime() + DELETE_GRACE_MS).toISOString()
      : null,
  };
}

/**
 * Permanently erases one candidate of the principal's team through the owner-run helper, for
 * data-protection requests only: session owners, after the typed name matches. A retry for an
 * erased candidate returns the earlier erasure and repeats the CV deletion pass. Counts only;
 * no candidate value is returned or logged.
 */
export async function eraseCandidate(
  p: Principal,
  candidateId: string,
  input: unknown,
  options: {
    source?: "app" | "script";
    storage?: StorageGateway | BlobGateway;
  } = {},
): Promise<CandidateErasure> {
  if (p.role !== "owner" || p.authType !== "session") throw forbidden();
  parse(uuidSchema, candidateId);
  const { confirmName } = parse(candidateErasureSchema, input);
  const result = await withTeam(p, async (tx) => {
    try {
      const { rows } = await tx.execute<{ result: HelperResult | null }>(
        sql`select tenant_context.erase_candidate(${candidateId}::uuid, ${confirmName}, ${options.source ?? "app"}) as result`,
      );
      return rows[0]?.result ?? null;
    } catch (error) {
      const cause = error instanceof DrizzleQueryError ? error.cause : error;
      const { code, message } =
        (cause as { code?: unknown; message?: unknown } | undefined) ?? {};
      if (code === "RQ003")
        throw new ApiError(
          400,
          "erasure_confirmation_mismatch",
          "Type the candidate's name exactly as shown to confirm.",
        );
      if (code === "42501" && message === "Storage settlement rejected")
        throw settlementFailed();
      if (code === "42501") throw forbidden();
      throw error;
    }
  });
  if (!result)
    throw new ApiError(404, "not_found", "Record not found in this team.");
  await deleteErasedCvs(p, result.erasureId, options.storage);
  return {
    erasureId: result.erasureId,
    alreadyErased: result.alreadyErased,
    erasedAt: new Date(result.erasedAt).toISOString(),
    removed: result.alreadyErased ? null : (result.removed ?? null),
    cvStorage: await cvStorageOf(p, result.erasureId),
  };
}
