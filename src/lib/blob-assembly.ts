type BlobReference = { uploadId: string; sha256: string; sizeBytes: number };
type BlobChunk = BlobReference & { offset: number; bytes: Uint8Array };

// Browser-safe limits matching the server's 10 MiB CV and 4 MiB slice bounds.
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_SLICE_BYTES = 4 * 1024 * 1024;

/** Returns a complete file only after matching the trusted reference and full digest. */
export async function assembleVerifiedBlobChunks(
  reference: BlobReference,
  chunks: AsyncIterable<BlobChunk>,
): Promise<Uint8Array<ArrayBuffer>> {
  // Snapshot the trusted reference before an asynchronous producer can mutate it.
  const uploadId = reference?.uploadId;
  const sha256 = reference?.sha256;
  const sizeBytes = reference?.sizeBytes;
  if (
    typeof uploadId !== "string" ||
    uploadId.length < 1 ||
    uploadId.length > 256 ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > MAX_DOCUMENT_BYTES
  )
    throw new Error("Invalid document reference.");

  const result = new Uint8Array(sizeBytes);
  let offset = 0;
  for await (const chunk of chunks) {
    if (
      !chunk ||
      chunk.uploadId !== uploadId ||
      chunk.sha256 !== sha256 ||
      chunk.sizeBytes !== sizeBytes ||
      chunk.offset !== offset ||
      !(chunk.bytes instanceof Uint8Array) ||
      chunk.bytes.byteLength < 1 ||
      chunk.bytes.byteLength > MAX_SLICE_BYTES ||
      chunk.bytes.byteLength > sizeBytes - offset
    )
      throw new Error("Invalid document chunk.");
    result.set(chunk.bytes, offset);
    offset += chunk.bytes.byteLength;
  }
  if (offset !== sizeBytes) throw new Error("Incomplete document.");
  const digest = await crypto.subtle.digest("SHA-256", result);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hex !== sha256) throw new Error("Document integrity check failed.");
  return result;
}
