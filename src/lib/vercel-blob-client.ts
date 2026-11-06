import { get, issueSignedToken, presignUrl } from "@vercel/blob";
import type { BlobClient } from "./blob-storage.ts";
import { StorageConfigurationError } from "./storage.ts";

/**
 * The real Vercel Blob client behind the provider-neutral seam. Only tests and the live
 * verification script build it; getStorage still refuses Blob. Every SDK call passes the
 * explicit token, so no BLOB_READ_WRITE_TOKEN, VERCEL_OIDC_TOKEN or BLOB_STORE_ID default
 * is used. Provider errors stay inside: the gateway replaces their text.
 */
export function createVercelBlobClient({
  storeId,
  token,
}: {
  storeId: string;
  token: string;
}): BlobClient {
  // The SDK reaches whichever store the read-write token names, so the token must name
  // exactly this store; otherwise the store id would be a check in name only. The SDK sends
  // its proxy header whenever either proxy variable is present, even empty, so presence refuses.
  if (
    typeof storeId !== "string" ||
    !/^store_[A-Za-z0-9]{1,128}$/.test(storeId) ||
    typeof token !== "string" ||
    !token.startsWith("vercel_blob_rw_") ||
    token.split("_")[3] !== storeId.slice("store_".length) ||
    process.env.VERCEL_BLOB_API_URL ||
    process.env.NEXT_PUBLIC_VERCEL_BLOB_API_URL ||
    process.env.VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API !== undefined ||
    process.env.NEXT_PUBLIC_VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API !==
      undefined
  )
    throw new StorageConfigurationError(
      "The storage client needs a valid store id, a read-write token for that store and the standard endpoint.",
      "blob_client_invalid",
    );
  return {
    signer: {
      issueSignedToken: ({
        pathname,
        operations,
        allowedContentTypes,
        maximumSizeInBytes,
        validUntil,
        abortSignal,
      }) =>
        issueSignedToken({
          pathname,
          operations,
          allowedContentTypes,
          maximumSizeInBytes,
          validUntil,
          abortSignal,
          token,
        }),
      // Local HMAC only; it makes no network call.
      presignUrl: (signedToken, options) => presignUrl(signedToken, options),
    },
    async open(pathname, { cache, signal }) {
      if (cache !== "no-store")
        throw new Error("Private Blob reads must bypass the cache.");
      const result = await get(pathname, {
        access: "private",
        useCache: false,
        abortSignal: signal,
        token,
      });
      if (!result) return null;
      if (
        result.statusCode === 200 &&
        result.stream &&
        result.blob.pathname === pathname &&
        Number.isSafeInteger(result.blob.size)
      )
        return {
          sizeBytes: result.blob.size,
          mimeType: result.blob.contentType,
          stream: result.stream,
        };
      const stream: ReadableStream<Uint8Array> | null = result.stream;
      // Fire-and-forget: a provider that ignores cancellation is never awaited.
      if (stream)
        void Promise.resolve()
          .then(() => stream.cancel())
          .catch(() => {});
      throw new Error("Private Blob object response was not usable.");
    },
  };
}
