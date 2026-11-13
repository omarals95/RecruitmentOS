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

/** Validates the read before anything is allocated; a refused read aborts the provider request. */
function readControl(expectedSize: number, options?: BlobReadOptions) {
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
  return { controller, timeoutMs };
}

/**
 * The shared abort-aware read loop. It hashes every byte as it arrives and hands each
 * part to `keep` before the next read, so a producer cannot change bytes already seen.
 * Cancellation depends on provider cooperation; a blocked event loop delays the deadline.
 */
async function readBoundedStream(
  stream: AsyncIterable<Uint8Array>,
  expectedSize: number,
  { controller, timeoutMs }: { controller: AbortController; timeoutMs: number },
  keep: (part: Uint8Array, offset: number) => void,
): Promise<string> {
  const hash = createHash("sha256");
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
      hash.update(part);
      keep(part, received);
      received += part.byteLength;
    }
    if (received !== expectedSize)
      throw new CvValidationError("Stored document is truncated.");
    return hash.digest("hex");
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

/** Use one request-scoped controller when opening the provider request and reading. */
export async function readBlobSnapshot(
  stream: AsyncIterable<Uint8Array>,
  expectedSize: number,
  options?: BlobReadOptions,
): Promise<{ bytes: Buffer; sha256: string }> {
  const control = readControl(expectedSize, options);
  const bytes = Buffer.alloc(expectedSize);
  const sha256 = await readBoundedStream(
    stream,
    expectedSize,
    control,
    (part, offset) => bytes.set(part, offset),
  );
  return { bytes, sha256 };
}

function assertDigest(expectedSha256: string): void {
  if (
    typeof expectedSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(expectedSha256)
  )
    throw new CvValidationError("Invalid stored document digest.");
}
function assertMatches(sha256: string, expectedSha256: string): void {
  if (
    !timingSafeEqual(
      Buffer.from(sha256, "hex"),
      Buffer.from(expectedSha256, "hex"),
    )
  )
    throw new CvValidationError("Stored document integrity check failed.");
}

/** The whole object, released only when it matches its stored digest. */
export async function readVerifiedBlob(
  stream: AsyncIterable<Uint8Array>,
  expectedSize: number,
  expectedSha256: string,
  options?: BlobReadOptions,
): Promise<Buffer> {
  try {
    assertDigest(expectedSha256);
    const { bytes, sha256 } = await readBlobSnapshot(
      stream,
      expectedSize,
      options,
    );
    assertMatches(sha256, expectedSha256);
    return bytes;
  } catch (error) {
    options?.controller?.abort();
    throw error;
  }
}

/**
 * Never release a byte until the entire retrieved object matches its stored digest.
 * The whole object is stream-hashed; only the requested slice is retained.
 */
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
    assertDigest(expectedSha256);
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
    const control = readControl(expectedSize, options);
    const slice = Buffer.alloc(length);
    const end = offset + length;
    const sha256 = await readBoundedStream(
      stream,
      expectedSize,
      control,
      (part, at) => {
        const from = Math.max(offset, at);
        const to = Math.min(end, at + part.byteLength);
        if (from < to)
          slice.set(part.subarray(from - at, to - at), from - offset);
      },
    );
    assertMatches(sha256, expectedSha256);
    return slice;
  } catch (error) {
    options?.controller?.abort();
    throw error;
  }
}
