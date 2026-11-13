import {
  BlobError,
  BlobNotFoundError,
  del,
  get,
  head,
  issueSignedToken,
  list,
  presignUrl,
  put,
} from "@vercel/blob";
import type { BlobClient } from "./blob-storage.ts";
import { StorageConfigurationError } from "./storage.ts";

/**
 * The real Vercel Blob client behind the provider-neutral seam. getStorage builds it in OIDC mode
 * with the request's token; tests and the live verification script also build the read-write
 * token mode. Every SDK call passes explicit credentials, so no BLOB_READ_WRITE_TOKEN,
 * VERCEL_OIDC_TOKEN or BLOB_STORE_ID default is used. Provider errors stay inside: the gateway
 * replaces their text.
 */
export function createVercelBlobClient(
  options:
    | { storeId: string; token: string }
    | { storeId: string; oidcToken: () => string },
): BlobClient {
  const { storeId } = options;
  const token = "token" in options ? options.token : undefined;
  const oidcToken = "oidcToken" in options ? options.oidcToken : undefined;
  // OIDC mode must never meet a static token: the SDK would prefer it wherever a call omits ours.
  if (oidcToken && process.env.BLOB_READ_WRITE_TOKEN !== undefined)
    throw new StorageConfigurationError(
      "The OIDC storage client refuses a static read-write token in its environment.",
      "blob_token_present",
    );
  // The SDK reaches whichever store the read-write token names, so the token must name
  // exactly this store; otherwise the store id would be a check in name only. The SDK sends
  // its proxy header whenever either proxy variable is present, even empty, so presence refuses.
  if (
    typeof storeId !== "string" ||
    !/^store_[A-Za-z0-9]{1,128}$/.test(storeId) ||
    (oidcToken
      ? typeof oidcToken !== "function"
      : typeof token !== "string" ||
        !token.startsWith("vercel_blob_rw_") ||
        token.split("_")[3] !== storeId.slice("store_".length)) ||
    process.env.VERCEL_BLOB_API_URL ||
    process.env.NEXT_PUBLIC_VERCEL_BLOB_API_URL ||
    process.env.VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API !== undefined ||
    process.env.NEXT_PUBLIC_VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API !==
      undefined
  )
    throw new StorageConfigurationError(
      "The storage client needs a valid store id, a read-write token for that store or an OIDC token source, and the standard endpoint.",
      "blob_client_invalid",
    );
  // Read before every SDK call, so each one carries the current, rechecked request token.
  const credentials = () =>
    oidcToken ? { oidcToken: oidcToken(), storeId } : { token: token! };
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
          ...credentials(),
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
        ...credentials(),
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
    async head(pathname, { signal }) {
      let result;
      try {
        result = await head(pathname, {
          abortSignal: signal,
          ...credentials(),
        });
      } catch (error) {
        if (error instanceof BlobNotFoundError) return null;
        throw error;
      }
      if (
        result.pathname !== pathname ||
        !Number.isSafeInteger(result.size) ||
        Number.isNaN(result.uploadedAt.getTime())
      )
        throw new Error("Private Blob metadata response was not usable.");
      return {
        sizeBytes: result.size,
        mimeType: result.contentType,
        uploadedAt: result.uploadedAt,
      };
    },
    async put(pathname, bytes, { contentType, signal }) {
      let result;
      try {
        result = await put(pathname, bytes, {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType,
          abortSignal: signal,
          ...credentials(),
        });
      } catch (error) {
        // A no-overwrite refusal: the object is already there, for example from a lost response.
        if (error instanceof BlobError && /already exists/i.test(error.message))
          return "exists";
        throw error;
      }
      if (result.pathname !== pathname)
        throw new Error("Private Blob upload response was not usable.");
      return "stored";
    },
    async delete(pathname, { signal }) {
      try {
        await del(pathname, { abortSignal: signal, ...credentials() });
      } catch (error) {
        // A missing object is already deleted.
        if (!(error instanceof BlobNotFoundError)) throw error;
      }
    },
    async list({ prefix, cursor, limit, signal }) {
      const result = await list({
        prefix,
        cursor: cursor ?? undefined,
        limit,
        abortSignal: signal,
        ...credentials(),
      });
      return {
        objects: result.blobs.map((blob) => {
          if (
            !blob.pathname.startsWith(prefix) ||
            !Number.isSafeInteger(blob.size) ||
            Number.isNaN(blob.uploadedAt.getTime())
          )
            throw new Error("Private Blob list response was not usable.");
          return {
            pathname: blob.pathname,
            sizeBytes: blob.size,
            uploadedAt: blob.uploadedAt,
          };
        }),
        cursor: result.hasMore && result.cursor ? result.cursor : null,
      };
    },
  };
}
