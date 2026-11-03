import { createHash, timingSafeEqual } from "node:crypto";
import { CvValidationError, MAX_CV_BYTES } from "./storage-format.ts";

export const MAX_BLOB_DOWNLOAD_SLICE_BYTES = 4 * 1024 * 1024;

function assertExpectedSize(sizeBytes: number): void {
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > MAX_CV_BYTES
  )
    throw new CvValidationError("Invalid stored document size.");
}

/** A single copied snapshot keeps validation and hashing bound to the same bytes. */
export async function readBlobSnapshot(
  stream: AsyncIterable<Uint8Array>,
  expectedSize: number,
): Promise<{ bytes: Buffer; sha256: string }> {
  assertExpectedSize(expectedSize);
  const bytes = Buffer.alloc(expectedSize);
  let received = 0;
  for await (const part of stream) {
    if (!(part instanceof Uint8Array) || part.byteLength === 0)
      throw new CvValidationError("Invalid stored document stream.");
    if (part.byteLength > expectedSize - received)
      throw new CvValidationError("Stored document exceeds its expected size.");
    bytes.set(part, received);
    received += part.byteLength;
  }
  if (received !== expectedSize)
    throw new CvValidationError("Stored document is truncated.");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Never release a byte until the entire retrieved snapshot matches its stored digest. */
export async function readVerifiedBlobSlice(
  stream: AsyncIterable<Uint8Array>,
  expectedSize: number,
  expectedSha256: string,
  offset: number,
  length: number,
): Promise<Buffer> {
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
  const snapshot = await readBlobSnapshot(stream, expectedSize);
  if (
    !timingSafeEqual(
      Buffer.from(snapshot.sha256, "hex"),
      Buffer.from(expectedSha256, "hex"),
    )
  )
    throw new CvValidationError("Stored document integrity check failed.");
  return Buffer.from(snapshot.bytes.subarray(offset, offset + length));
}
