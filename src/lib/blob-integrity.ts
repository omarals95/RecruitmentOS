import { createHash, timingSafeEqual } from "node:crypto";
import { CvValidationError, MAX_CV_BYTES } from "./storage-format.ts";

export const MAX_BLOB_DOWNLOAD_SLICE_BYTES = 4 * 1024 * 1024;
const MAX_BLOB_READ_MS = 15_000;
type BlobReadOptions = { controller?: AbortController; timeoutMs?: number };

function assertExpectedSize(sizeBytes: number): void {
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > MAX_CV_BYTES
  )
    throw new CvValidationError("Invalid stored document size.");
}

/**
 * Use one request-scoped controller when opening the provider request and reading.
 * Cancellation depends on provider cooperation; a blocked event loop delays the deadline.
 */
export async function readBlobSnapshot(
  stream: AsyncIterable<Uint8Array>,
  expectedSize: number,
  options?: BlobReadOptions,
): Promise<{ bytes: Buffer; sha256: string }> {
  const controller = options?.controller ?? new AbortController();
  const timeoutMs = options?.timeoutMs ?? MAX_BLOB_READ_MS;
  try {
    assertExpectedSize(expectedSize);
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_BLOB_READ_MS
    )
      throw new CvValidationError("Invalid document read deadline.");
  } catch (error) {
    controller.abort();
    throw error;
  }
  const bytes = Buffer.alloc(expectedSize);
  let received = 0;
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  let iterator: AsyncIterator<Uint8Array> | undefined;
  try {
    iterator = stream[Symbol.asyncIterator]();
    const activeIterator = iterator;
    while (true) {
      const next = await new Promise<IteratorResult<Uint8Array>>(
        (resolve, reject) => {
          const onAbort = () => {
            controller.signal.removeEventListener("abort", onAbort);
            reject(
              new CvValidationError("Stored document read was cancelled."),
            );
          };
          if (controller.signal.aborted) return onAbort();
          controller.signal.addEventListener("abort", onAbort, { once: true });
          Promise.resolve()
            .then(() => {
              if (controller.signal.aborted)
                throw new CvValidationError(
                  "Stored document read was cancelled.",
                );
              return activeIterator.next();
            })
            .then(
              (result) => {
                controller.signal.removeEventListener("abort", onAbort);
                resolve(result);
              },
              (error) => {
                controller.signal.removeEventListener("abort", onAbort);
                reject(error);
              },
            );
        },
      );
      if (controller.signal.aborted)
        throw new CvValidationError("Stored document read was cancelled.");
      if (next.done) break;
      const part = next.value;
      if (!(part instanceof Uint8Array) || part.byteLength === 0)
        throw new CvValidationError("Invalid stored document stream.");
      if (part.byteLength > expectedSize - received)
        throw new CvValidationError(
          "Stored document exceeds its expected size.",
        );
      bytes.set(part, received);
      received += part.byteLength;
    }
    if (received !== expectedSize)
      throw new CvValidationError("Stored document is truncated.");
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    controller.abort();
    try {
      // A provider may ignore cancellation; never wait on its cleanup indefinitely.
      void Promise.resolve(iterator?.return?.()).catch(() => {});
    } catch {
      // Preserve the original validation or transport error.
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Never release a byte until the entire retrieved snapshot matches its stored digest. */
export async function readVerifiedBlobSlice(
  stream: AsyncIterable<Uint8Array>,
  expectedSize: number,
  expectedSha256: string,
  offset: number,
  length: number,
  options?: BlobReadOptions,
): Promise<Buffer> {
  try {
    assertExpectedSize(expectedSize);
    if (
      typeof expectedSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(expectedSha256)
    )
      throw new CvValidationError("Invalid stored document digest.");
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 1 ||
      length > MAX_BLOB_DOWNLOAD_SLICE_BYTES ||
      length > expectedSize ||
      offset > expectedSize - length
    )
      throw new CvValidationError("Invalid document slice.");
    const snapshot = await readBlobSnapshot(stream, expectedSize, options);
    if (
      !timingSafeEqual(
        Buffer.from(snapshot.sha256, "hex"),
        Buffer.from(expectedSha256, "hex"),
      )
    )
      throw new CvValidationError("Stored document integrity check failed.");
    return Buffer.from(snapshot.bytes.subarray(offset, offset + length));
  } catch (error) {
    options?.controller?.abort();
    throw error;
  }
}
