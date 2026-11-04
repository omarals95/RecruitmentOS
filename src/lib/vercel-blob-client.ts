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
  if (
    typeof storeId !== "string" ||
    !/^store_[A-Za-z0-9]{1,128}$/.test(storeId) ||
    typeof token !== "string" ||
    !token ||
    process.env.VERCEL_BLOB_API_URL ||
    process.env.NEXT_PUBLIC_VERCEL_BLOB_API_URL
  )
    throw new StorageConfigurationError(
      "The Vercel Blob client needs a valid store id, a token and the standard API endpoint.",
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
