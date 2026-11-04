import { assembleVerifiedBlobChunks } from "@/lib/blob-assembly";

// Browser-safe: no Node imports. The server tags each protocol; a hostname never decides it.
export type UploadTicket =
  | {
      protocol: "s3-form-v1";
      method: "POST";
      url: string;
      fields: Record<string, string>;
      expiresAt: string;
      maxBytes: number;
    }
  | {
      protocol: "blob-put-v1";
      method: "PUT";
      url: string;
      headers: Record<string, string>;
      expiresAt: string;
      maxBytes: number;
    };
type Fetch = typeof fetch;
const browserFetch: Fetch = (input, init) => fetch(input, init);
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CV_BYTES = 10 * 1024 * 1024;
const REVOKE_OBJECT_URL_MS = 40_000;
type SaveEnv = {
  document: { body: { append(node: HTMLElement): void } } & Pick<
    Document,
    "createElement"
  >;
  URL: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  setTimeout: (callback: () => void, ms: number) => unknown;
};

/**
 * Sends the bytes to private storage with only what the ticket names: no cookies, token or
 * team header. Resolves the storage response; error messages never include the upload URL.
 */
export async function sendCvBytes(
  upload: UploadTicket,
  file: Blob,
  signal?: AbortSignal,
  fetchImpl: Fetch = browserFetch,
): Promise<Response> {
  let init: RequestInit;
  if (upload?.protocol === "s3-form-v1" && upload.method === "POST") {
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.fields))
      form.append(key, value);
    form.append("file", file);
    init = { method: "POST", body: form };
  } else if (upload?.protocol === "blob-put-v1" && upload.method === "PUT")
    init = { method: "PUT", body: file, headers: { ...upload.headers } };
  else
    throw new Error(
      "The server returned an upload method this page does not support. Refresh the page and try again.",
    );
  try {
    return await fetchImpl(upload.url, {
      ...init,
      signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch {
    // A transport error can echo the capability URL; keep none of it.
    if (signal?.aborted) throw signal.reason;
    throw new Error(
      "Private storage could not be reached. Check your connection and try again.",
    );
  }
}

async function failure(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null);
  const message = body?.error?.message;
  return new Error(
    typeof message === "string" && message
      ? message
      : `The CV could not be downloaded (HTTP ${response.status}).`,
  );
}
/** Strict decimal header values; a missing or malformed header never reads as zero. */
function whole(value: string | null): number {
  return value !== null && /^(?:0|[1-9]\d{0,8})$/.test(value)
    ? Number(value)
    : NaN;
}

/**
 * Downloads a blob-chunks-v1 CV one reauthorized chunk at a time and returns the bytes only
 * after every chunk matches the manifest and the whole file matches its SHA-256.
 */
export async function downloadVerifiedCv(
  teamId: string,
  cvId: string,
  fetchImpl: Fetch = browserFetch,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; originalName: string }> {
  const base = `/api/v1/cvs/${encodeURIComponent(cvId)}`;
  const init: RequestInit = {
    headers: { "X-Team-Id": teamId },
    credentials: "same-origin",
    cache: "no-store",
  };
  const response = await fetchImpl(`${base}/manifest`, init);
  if (!response.ok) throw await failure(response);
  const manifest = (await response.json().catch(() => null))?.data;
  if (
    !manifest ||
    manifest.protocol !== "blob-chunks-v1" ||
    manifest.uploadId !== cvId ||
    typeof manifest.originalName !== "string" ||
    typeof manifest.sha256 !== "string" ||
    !Number.isSafeInteger(manifest.sizeBytes) ||
    manifest.sizeBytes < 1 ||
    manifest.sizeBytes > MAX_CV_BYTES ||
    manifest.chunkSize !== CHUNK_BYTES ||
    manifest.chunkCount !== Math.ceil(manifest.sizeBytes / CHUNK_BYTES)
  )
    throw new Error("The CV download manifest is invalid.");
  const { uploadId, sha256, sizeBytes, chunkCount, originalName } = manifest;
  async function* chunks() {
    for (let index = 0; index < chunkCount; index++) {
      const chunk = await fetchImpl(`${base}/chunks?index=${index}`, init);
      if (!chunk.ok) throw await failure(chunk);
      if (whole(chunk.headers.get("X-CV-Chunk-Index")) !== index)
        throw new Error("The CV download returned the wrong chunk.");
      yield {
        uploadId: chunk.headers.get("X-CV-Upload-Id") ?? "",
        sha256: chunk.headers.get("X-CV-SHA256") ?? "",
        sizeBytes: whole(chunk.headers.get("X-CV-Size-Bytes")),
        offset: whole(chunk.headers.get("X-CV-Chunk-Offset")),
        bytes: new Uint8Array(await chunk.arrayBuffer()),
      };
    }
  }
  const bytes = await assembleVerifiedBlobChunks(
    { uploadId, sha256, sizeBytes },
    chunks(),
  );
  return { bytes, originalName };
}

/**
 * Saves verified bytes through an anchor attached to the document. Some Firefox versions
 * ignore a detached anchor or cancel a download whose object URL is revoked at once.
 */
export function saveCvBytes(
  bytes: Uint8Array<ArrayBuffer>,
  name: string,
  env: SaveEnv = {
    document,
    URL,
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  },
): void {
  const url = env.URL.createObjectURL(
    new Blob([bytes], { type: "application/octet-stream" }),
  );
  const anchor = env.document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  try {
    env.document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    env.setTimeout(() => env.URL.revokeObjectURL(url), REVOKE_OBJECT_URL_MS);
  }
}
