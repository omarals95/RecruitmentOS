import { readVerifiedBlobSlice } from "./blob-integrity.ts";
import {
  createBlobPutTicket,
  type BlobTicketSigner,
} from "./blob-put-ticket.ts";
import { inspectBlobUpload } from "./blob-upload-validation.ts";
import { CvValidationError } from "./storage-format.ts";
import type { StorageBinding } from "./storage.ts";

const BLOB_API_ORIGIN = "https://vercel.com";
const MAX_BLOB_READ_MS = 15_000;

export type BlobObject = {
  sizeBytes: number;
  mimeType: string;
  stream: AsyncIterable<Uint8Array>;
};
/** Provider-neutral seam; only tests and the live verification script build a real client. */
export interface BlobClient {
  readonly signer: BlobTicketSigner;
  /** Opens a private object by pathname, uncached; resolves null when it does not exist. */
  open(
    pathname: string,
    options: { cache: "no-store"; signal: AbortSignal },
  ): Promise<BlobObject | null>;
}
type BlobReservation = {
  teamId: string;
  objectKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: Date;
};
type BlobReference = {
  teamId: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};
/**
 * Missing objects resolve null. Content failures throw CvValidationError; a deadline or
 * provider failure throws a plain Error, so callers can keep the reference retryable.
 * The gateway does not limit reads; callers take a cross-instance read lease first.
 */
export interface BlobGateway {
  readonly binding: StorageBinding;
  issuePutTicket(
    reservation: BlobReservation,
  ): Promise<{ url: string; expiresAt: number }>;
  inspectUpload(
    reservation: BlobReservation,
    timeoutMs?: number,
  ): Promise<{ sha256: string } | null>;
  readVerifiedSlice(
    reference: BlobReference,
    offset: number,
    length: number,
    timeoutMs?: number,
  ): Promise<Buffer | null>;
}

/** Fire-and-forget: a provider that ignores cancellation is never awaited. */
function closeObject(object: BlobObject): void {
  try {
    void Promise.resolve(
      object.stream[Symbol.asyncIterator]().return?.(),
    ).catch(() => {});
  } catch {
    // A stream that is already locked or closed needs nothing more.
  }
}

/**
 * One request-scoped controller and deadline cover opening the object and reading it.
 * Every opened stream is read to the end or closed, including one that opens late.
 */
async function withObject<T>(
  client: BlobClient,
  pathname: string,
  timeoutMs: number,
  read: (object: BlobObject, controller: AbortController) => Promise<T>,
): Promise<T | null> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_BLOB_READ_MS
  )
    throw new Error("Invalid private Blob read deadline.");
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  try {
    const object = await new Promise<BlobObject | null>((resolve, reject) => {
      const onAbort = () =>
        reject(new Error("Private Blob read was cancelled."));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() =>
          client.open(pathname, {
            cache: "no-store",
            signal: controller.signal,
          }),
        )
        .then(
          (value) => {
            controller.signal.removeEventListener("abort", onAbort);
            // The deadline already rejected this read; nobody will consume the stream.
            if (value && controller.signal.aborted) closeObject(value);
            resolve(value);
          },
          () => {
            controller.signal.removeEventListener("abort", onAbort);
            // Provider errors can contain capabilities; never pass their text on.
            reject(new Error("Private Blob object could not be opened."));
          },
        );
    });
    if (!object) return null;
    try {
      // The read gets the full deadline; the outer timer always fires first and marks expiry.
      return await read(object, controller);
    } catch (error) {
      // Covers metadata mismatches that throw before the stream is read.
      closeObject(object);
      throw error;
    }
  } catch (error) {
    controller.abort();
    // A cancelled read is a transport failure, never a content rejection.
    if (expired || Date.now() >= deadline)
      throw new Error("Private Blob read exceeded its deadline.", {
        cause: error,
      });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Built only by tests and the live verification script; getStorage never returns a Blob gateway. */
export function createBlobGateway(
  binding: StorageBinding,
  client: BlobClient,
): BlobGateway {
  if (binding.provider !== "blob")
    throw new Error("A Blob gateway needs a Blob storage binding.");
  return {
    binding,
    async issuePutTicket(reservation) {
      try {
        const ticket = await createBlobPutTicket(
          {
            objectKey: reservation.objectKey,
            storeId: binding.store,
            originalName: reservation.originalName,
            mimeType: reservation.mimeType,
            sizeBytes: reservation.sizeBytes,
            expiresAt: reservation.expiresAt.getTime(),
          },
          BLOB_API_ORIGIN,
          client.signer,
        );
        return { url: ticket.url, expiresAt: ticket.expiresAt };
      } catch {
        throw new Error("Private Blob upload ticket could not be issued.");
      }
    },
    inspectUpload(reservation, timeoutMs = MAX_BLOB_READ_MS) {
      return withObject(
        client,
        reservation.objectKey,
        timeoutMs,
        (object, controller) =>
          inspectBlobUpload(
            reservation,
            { mimeType: object.mimeType, sizeBytes: object.sizeBytes },
            object.stream,
            { controller, timeoutMs },
          ),
      );
    },
    readVerifiedSlice(reference, offset, length, timeoutMs = MAX_BLOB_READ_MS) {
      return withObject(
        client,
        reference.objectKey,
        timeoutMs,
        async (object, controller) => {
          if (
            object.sizeBytes !== reference.sizeBytes ||
            object.mimeType !== reference.mimeType
          )
            throw new CvValidationError(
              "Stored document differs from its validated reference.",
            );
          return readVerifiedBlobSlice(
            object.stream,
            reference.sizeBytes,
            reference.sha256,
            offset,
            length,
            { controller, timeoutMs },
          );
        },
      );
    },
  };
}
