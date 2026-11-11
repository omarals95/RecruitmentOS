import { waitUntil } from "@vercel/functions";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { recordFiles, uploads } from "@/db/schema";
import type { BlobGateway } from "@/lib/blob-storage";
import {
  BLOB_RESERVATION_MS,
  blobGateway,
  expireCvReservations,
  storageBinding,
  storageClient,
} from "@/lib/cvs";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import { requireScope } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import { expireRecordFileReservations } from "@/lib/record-files";
import type { StorageGateway } from "@/lib/storage";

/** No ticket for a pathname is valid after its row's expires_at; this grace covers in-flight PUTs. */
export const DELETE_GRACE_MS = 10 * 60 * 1000;
const MAX_CALL_MS = 5000;
const LIST_PAGE_SIZE = 1000;

export type BlobReconciliation = {
  expiredReservations: number;
  chargesReleased: number;
  objectsChecked: number;
  objectsDeleted: number;
  failures: number;
  complete: boolean;
};

/** A provider call's timeout: the remaining budget, at most 5 s; 0 once the budget is spent. */
function callTimeout(deadline: number) {
  return Math.min(MAX_CALL_MS, Math.floor(deadline - Date.now()));
}

function assertSweep(p: Principal, gateway: BlobGateway) {
  requireScope(p, "cvs:write");
  if (gateway.binding.provider !== "blob")
    throw new Error("Blob cleanup needs a Blob storage binding.");
}

/**
 * Row pass. Each rejected Blob upload or record file of the team on this store whose last ticket
 * expired at least 10 minutes ago is deleted, then confirmed missing by head, and only then has its
 * retained charge released by the owner-run helper. A failed delete or head, or an object still
 * present, keeps the charge; a later run repeats the deletion. Pathnames, IDs and provider errors are
 * never returned. erasureId limits the pass to the files of one candidate erasure. Both tables share
 * the maxRows bound, oldest expiry first.
 */
export async function releaseRetainedBlobCharges(
  p: Principal,
  gateway: BlobGateway,
  options: { maxRows: number; deadline: number; now: Date; erasureId?: string },
) {
  assertSweep(p, gateway);
  const { store } = gateway.binding;
  const cutoff = new Date(options.now.getTime() - DELETE_GRACE_MS);
  const rows = await withTeam(p, async (tx) => {
    const found = [];
    for (const table of [uploads, recordFiles])
      found.push(
        ...(await tx
          .select({
            id: table.id,
            objectKey: table.objectKey,
            expiresAt: table.expiresAt,
          })
          .from(table)
          .where(
            and(
              eq(table.teamId, p.teamId),
              eq(table.storageProvider, "blob"),
              eq(table.storageStore, store),
              eq(table.status, "rejected"),
              isNull(table.blobDeletedAt),
              lte(table.expiresAt, cutoff),
              ...(options.erasureId
                ? [eq(table.erasureId, options.erasureId)]
                : []),
            ),
          )
          .orderBy(asc(table.expiresAt), asc(table.id))
          .limit(options.maxRows + 1)),
      );
    return found
      .sort(
        (a, b) =>
          a.expiresAt.getTime() - b.expiresAt.getTime() ||
          (a.id < b.id ? -1 : 1),
      )
      .slice(0, options.maxRows + 1);
  });
  let chargesReleased = 0,
    failures = 0,
    complete = rows.length <= options.maxRows;
  for (const row of rows.slice(0, options.maxRows)) {
    if (callTimeout(options.deadline) < 1) {
      complete = false;
      break;
    }
    try {
      await gateway.deleteObject(row.objectKey, callTimeout(options.deadline));
      const timeout = callTimeout(options.deadline);
      if (timeout < 1) {
        complete = false;
        break;
      }
      if (await gateway.headObject(row.objectKey, timeout)) {
        failures++;
        continue;
      }
      const released = await withTeam(p, async (tx) => {
        const { rows: result } = await tx.execute<{ released: boolean }>(
          sql`select tenant_context.release_blob_charge(${store}, ${row.id}::uuid) as released`,
        );
        return result[0]?.released === true;
      });
      if (released) chargesReleased++;
    } catch {
      failures++;
    }
  }
  return { chargesReleased, failures, complete };
}

/**
 * One bounded, idempotent sweep of the team's own Blob prefix on this store. It expires the team's
 * old CV and record file tickets, releases retained charges whose objects are confirmed deleted (row pass), then lists
 * teams/<team>/cvs/ and deletes objects with no upload row once older than any ticket could be,
 * and objects whose row expired at least 10 minutes ago unless it is ready with a matching size
 * (list pass), counting a deletion only once head confirms the object missing. Pending unexpired
 * and matching ready objects are never deleted, and charges are released only in the row pass. It
 * reports counts only.
 */
export async function reconcileBlobStorage(
  p: Principal,
  gateway: BlobGateway,
  options: {
    maxRows: number;
    maxDeletes: number;
    maxPages: number;
    budgetMs: number;
    now?: Date;
  },
): Promise<BlobReconciliation> {
  assertSweep(p, gateway);
  const { binding } = gateway;
  const now = options.now ?? new Date();
  const deadline = Date.now() + options.budgetMs;
  const expiredReservations = await withTeam(
    p,
    async (tx) =>
      (await expireCvReservations(tx, p.teamId, binding, now)) +
      (await expireRecordFileReservations(tx, p.teamId, binding, now)),
  );
  const released = await releaseRetainedBlobCharges(p, gateway, {
    maxRows: options.maxRows,
    deadline,
    now,
  });
  let objectsChecked = 0,
    objectsDeleted = 0,
    failures = released.failures,
    reachedEnd = false,
    stopped = !released.complete;
  const rowCutoff = now.getTime() - DELETE_GRACE_MS;
  const orphanCutoff = now.getTime() - BLOB_RESERVATION_MS - DELETE_GRACE_MS;
  const prefix = `teams/${p.teamId}/cvs/`;
  let cursor: string | null = null;
  pages: for (let page = 0; page < options.maxPages; page++) {
    const timeout = callTimeout(deadline);
    if (timeout < 1) {
      stopped = true;
      break;
    }
    let listing;
    try {
      listing = await gateway.listObjects(
        { prefix, cursor, limit: LIST_PAGE_SIZE },
        timeout,
      );
    } catch {
      failures++;
      stopped = true;
      break;
    }
    const keys = listing.objects.map((object) => object.pathname);
    const rows = keys.length
      ? await withTeam(p, (tx) =>
          tx
            .select({
              objectKey: uploads.objectKey,
              status: uploads.status,
              blobSizeBytes: uploads.blobSizeBytes,
              expiresAt: uploads.expiresAt,
            })
            .from(uploads)
            .where(
              and(
                eq(uploads.teamId, p.teamId),
                eq(uploads.storageProvider, "blob"),
                eq(uploads.storageStore, binding.store),
                inArray(uploads.objectKey, keys),
              ),
            ),
        )
      : [];
    const byKey = new Map(rows.map((row) => [row.objectKey, row]));
    for (const object of listing.objects) {
      objectsChecked++;
      const row = byKey.get(object.pathname);
      const stale = row
        ? row.expiresAt.getTime() <= rowCutoff &&
          !(row.status === "ready" && object.sizeBytes === row.blobSizeBytes)
        : object.uploadedAt.getTime() <= orphanCutoff;
      if (!stale) continue;
      const deleteTimeout = callTimeout(deadline);
      if (objectsDeleted >= options.maxDeletes || deleteTimeout < 1) {
        stopped = true;
        break pages;
      }
      try {
        await gateway.deleteObject(object.pathname, deleteTimeout);
        // A replayed ticket or a delete that did not take leaves the object: confirm it is gone.
        const headTimeout = callTimeout(deadline);
        if (headTimeout < 1) {
          failures++;
          stopped = true;
          break pages;
        }
        if (await gateway.headObject(object.pathname, headTimeout)) failures++;
        else objectsDeleted++;
      } catch {
        failures++;
      }
    }
    cursor = listing.cursor;
    if (!cursor) {
      reachedEnd = true;
      break;
    }
  }
  return {
    expiredReservations,
    chargesReleased: released.chargesReleased,
    objectsChecked,
    objectsDeleted,
    failures,
    complete: reachedEnd && !stopped,
  };
}

/**
 * Claims the team's sweep on this store through the owner-run helper: at most one sweep per
 * 10 minutes across instances, whatever triggers it. Returns 0 when claimed, else the seconds left.
 */
async function claimSweep(p: Principal, store: string): Promise<number> {
  return withTeam(p, async (tx) => {
    const { rows } = await tx.execute<{ remaining: number }>(
      sql`select tenant_context.claim_blob_reconciliation(${store}) as remaining`,
    );
    return Number(rows[0]?.remaining ?? 600);
  });
}

/**
 * The owner or admin cleanup call: one full sweep, inside the route's 30 s limit. Role and provider
 * refusals come first and do not use the team's cooldown. The injected gateway (tests) is used
 * when given.
 */
export async function runStorageReconciliation(
  p: Principal,
  storage?: StorageGateway | BlobGateway,
): Promise<BlobReconciliation> {
  if (p.role !== "owner" && p.role !== "admin")
    throw new ApiError(
      403,
      "storage_reconciliation_forbidden",
      "Only team owners and admins can run CV storage cleanup.",
    );
  if (storageBinding(storage).provider !== "blob")
    throw new ApiError(
      409,
      "STORAGE_RECONCILIATION_UNSUPPORTED",
      "CV storage cleanup applies only to Vercel Blob storage.",
    );
  const gateway = blobGateway(storage ?? (await storageClient()));
  requireScope(p, "cvs:write");
  const remaining = await claimSweep(p, gateway.binding.store);
  if (remaining > 0) {
    const cooldown = new ApiError(
      429,
      "STORAGE_RECONCILIATION_COOLDOWN",
      "CV storage cleanup ran for this team in the last 10 minutes. Try again after Retry-After seconds.",
    );
    cooldown.retryAfter = remaining;
    throw cooldown;
  }
  return reconcileBlobStorage(p, gateway, {
    maxRows: 50,
    maxDeletes: 100,
    maxPages: 3,
    budgetMs: 20_000,
  });
}

/**
 * The sweep after this request settled a Blob upload ready or rejected, as the uploading principal:
 * claimed under the shared team cooldown, within the manual caps and a 10 s budget, so completion
 * and sweep fit the route's 30 s. On Vercel it runs after the response through waitUntil; elsewhere
 * it is awaited. It never throws and never changes the completion response.
 */
export async function sweepAfterBlobUpload(
  p: Principal,
  storage?: StorageGateway | BlobGateway,
): Promise<void> {
  const work = (async () => {
    const gateway = blobGateway(storage ?? (await storageClient()));
    if ((await claimSweep(p, gateway.binding.store)) > 0) return;
    await reconcileBlobStorage(p, gateway, {
      maxRows: 50,
      maxDeletes: 100,
      maxPages: 3,
      budgetMs: 10_000,
    });
  })().catch(() => {
    console.error(
      "Automatic CV storage cleanup failed; the next upload retries.",
    );
  });
  if (process.env.VERCEL) {
    waitUntil(work);
    return;
  }
  await work;
}
