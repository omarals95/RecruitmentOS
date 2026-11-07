import { readBlobSnapshot } from "./blob-integrity.ts";
import {
  CvValidationError,
  validateCvBytes,
  validateCvMetadata,
} from "./storage-format.ts";

/** Validates and hashes the same full snapshot; no digest is returned for rejected uploads. */
export async function inspectBlobUpload(
  reservation: { originalName: string; mimeType: string; sizeBytes: number },
  observed: { mimeType: string; sizeBytes: number },
  stream: AsyncIterable<Uint8Array>,
  options?: { controller?: AbortController; timeoutMs?: number },
): Promise<{ sha256: string }> {
  try {
    const expected = validateCvMetadata(
      reservation.originalName,
      reservation.mimeType,
      reservation.sizeBytes,
    );
    if (
      reservation.originalName !== expected.originalName ||
      reservation.mimeType !== expected.mimeType ||
      observed.mimeType !== expected.mimeType ||
      observed.sizeBytes !== expected.sizeBytes
    )
      throw new CvValidationError(
        "Stored document differs from its reservation.",
      );

    const snapshot = await readBlobSnapshot(
      stream,
      expected.sizeBytes,
      options,
    );
    validateCvBytes(expected.originalName, expected.mimeType, snapshot.bytes);
    return { sha256: snapshot.sha256 };
  } catch (error) {
    options?.controller?.abort();
    throw error;
  }
}
