import {
  cvExtension,
  MAX_CV_BYTES,
  CvValidationError,
  validateCvBytes,
  containsControlCharacters,
} from "./storage-format.ts";
import { ApiError } from "./errors.ts";
import type { BlobGateway } from "./blob-storage.ts";

/**
 * A fixed code per setup cause, lowercase letters and underscores only. Only the code is logged,
 * because the messages name settings.
 */
export type StorageConfigurationReason =
  | "unspecified"
  | "provider_unsupported"
  | "hosted_environment_invalid"
  | "not_configured"
  | "oidc_not_hosted"
  | "oidc_missing"
  | "oidc_malformed"
  | "oidc_expired"
  | "oidc_context_changed"
  | "aws_versioning_disabled"
  | "aws_upload_unversioned"
  | "aws_version_missing"
  | "blob_client_invalid"
  | "blob_token_present"
  | "blob_protocol_mismatch"
  | "aws_protocol_mismatch";
export class StorageConfigurationError extends Error {
  readonly reason: StorageConfigurationReason;
  constructor(
    message: string,
    reason: StorageConfigurationReason = "unspecified",
  ) {
    super(message);
    this.reason = reason;
  }
}
/** The only text users see for any storage setup refusal; it names no provider or setting. */
export const STORAGE_SETUP_REQUIRED_MESSAGE =
  "CV storage is not set up yet. Ask an administrator to finish setting it up, then try again.";
/**
 * Logs one safe line for operators (correlation ID and reason code only, never the message, stack
 * or settings) and returns the generic 503 whose body carries the same correlation ID.
 */
export function storageSetupRequired(
  error: StorageConfigurationError,
): ApiError {
  const correlationId = crypto.randomUUID();
  console.error(
    `storage_configuration_error correlationId=${correlationId} code=STORAGE_SETUP_REQUIRED reason=${error.reason}`,
  );
  return new ApiError(
    503,
    "STORAGE_SETUP_REQUIRED",
    STORAGE_SETUP_REQUIRED_MESSAGE,
    correlationId,
  );
}
/** The provider, environment and store every CV reference is bound to. */
export type StorageBinding = {
  provider: "s3" | "blob";
  environment: "development" | "preview" | "production";
  store: string;
};
export interface StorageGateway {
  readonly binding: StorageBinding;
  assertVersioning(): Promise<void>;
  presignPost(
    key: string,
    mimeType: string,
    sizeBytes: number,
    expiresSeconds: number,
  ): Promise<{ url: string; fields: Record<string, string> }>;
  head(
    key: string,
  ): Promise<{ sizeBytes: number; mimeType: string; version?: string }>;
  readRange(
    key: string,
    version: string,
    start: number,
    end: number,
  ): Promise<Buffer>;
  signDownload(key: string, version: string, name: string): Promise<string>;
}

/** Unset or empty selects Blob; s3 stays only as the dormant legacy option. */
function selectedProvider(env: Record<string, string | undefined>) {
  const provider = env.CV_STORAGE_PROVIDER?.trim().toLowerCase() || "blob";
  return provider === "vercel-blob" ? "blob" : provider;
}
const BLOB_STORE_PATTERN = /^store_[A-Za-z0-9]{1,128}$/;

/**
 * Blob reads as set up only in a hosted Vercel environment without a static token: there the
 * gateway can use the request's OIDC token. Locally no Blob gateway can be built.
 */
export function storageConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const provider = selectedProvider(env);
  if (provider === "blob")
    return (
      BLOB_STORE_PATTERN.test(env.BLOB_STORE_ID?.trim() ?? "") &&
      env.VERCEL === "1" &&
      (env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "production") &&
      env.BLOB_READ_WRITE_TOKEN === undefined
    );
  // Do not silently fall back to S3 when a different provider was requested.
  if (provider !== "s3") return false;
  return Boolean(
    env.S3_BUCKET_NAME?.trim() &&
    env.AWS_REGION?.trim() &&
    (env.AWS_ROLE_ARN?.trim() ||
      (env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim())),
  );
}

const providerUnsupported = () =>
  new StorageConfigurationError(
    "The configured CV storage provider is not supported.",
    "provider_unsupported",
  );

/** Reads only the environment; it never contacts a provider. Off Vercel is development. */
export function resolveStorageBinding(
  env: Record<string, string | undefined> = process.env,
): StorageBinding {
  let environment: StorageBinding["environment"] = "development";
  if (env.VERCEL) {
    if (
      env.VERCEL !== "1" ||
      (env.VERCEL_ENV !== "production" && env.VERCEL_ENV !== "preview")
    )
      throw new StorageConfigurationError(
        "Hosted CV storage needs VERCEL_ENV set to production or preview.",
        "hosted_environment_invalid",
      );
    environment = env.VERCEL_ENV;
  }
  const provider = selectedProvider(env);
  if (provider !== "s3" && provider !== "blob") throw providerUnsupported();
  const store = (
    provider === "blob" ? env.BLOB_STORE_ID : env.S3_BUCKET_NAME
  )?.trim();
  if (!store || (provider === "blob" && !BLOB_STORE_PATTERN.test(store)))
    throw new StorageConfigurationError(
      STORAGE_SETUP_REQUIRED_MESSAGE,
      "not_configured",
    );
  return { provider, environment, store };
}

/** This is a freshness gate only. AWS STS or the Blob API verifies the token signature and trust. */
export function assertHostedOidcToken(
  env: Record<string, string | undefined>,
  requestToken: unknown,
  now = Date.now(),
): string {
  if (env.VERCEL !== "1")
    throw new StorageConfigurationError(
      "OIDC storage authentication requires a hosted Vercel request. Use explicit test credentials for local development.",
      "oidc_not_hosted",
    );
  if (
    typeof requestToken !== "string" ||
    requestToken.length > 16_384 ||
    requestToken.split(".").length !== 3
  )
    throw new StorageConfigurationError(
      "A hosted request-context OIDC token is required. Local Vercel CLI credentials and token files are not used.",
      "oidc_missing",
    );
  let expiry: unknown;
  try {
    expiry = (
      JSON.parse(
        Buffer.from(requestToken.split(".")[1], "base64url").toString("utf8"),
      ) as { exp?: unknown }
    ).exp;
  } catch {
    throw new StorageConfigurationError(
      "The hosted request-context OIDC token is malformed.",
      "oidc_malformed",
    );
  }
  if (
    typeof expiry !== "number" ||
    !Number.isSafeInteger(expiry) ||
    expiry * 1000 <= now + 60_000
  )
    throw new StorageConfigurationError(
      "The hosted request-context OIDC token is expired or near expiry. Retry with a fresh request.",
      "oidc_expired",
    );
  return requestToken;
}

export function attachmentDisposition(name: string): string {
  const clean =
    Array.from(name)
      .filter(
        (char) =>
          !containsControlCharacters(char) && char !== "/" && char !== "\\",
      )
      .join("")
      .slice(0, 180) || "resume";
  const ascii = clean.replace(/[^\x20-\x7e]|[";\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export async function inspectStoredCv(
  storage: StorageGateway,
  cv: {
    objectKey: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
  },
): Promise<string> {
  const head = await storage.head(cv.objectKey);
  if (!head.version || head.version === "null")
    throw new StorageConfigurationError(
      "S3 bucket versioning must be Enabled before CV uploads can be completed.",
      "aws_upload_unversioned",
    );
  if (
    head.sizeBytes !== cv.sizeBytes ||
    head.sizeBytes < 1 ||
    head.sizeBytes > MAX_CV_BYTES ||
    head.mimeType !== cv.mimeType
  )
    throw new CvValidationError(
      "Uploaded size or file type differs from the reserved CV upload.",
    );
  const fullDocument = ["doc", "docx", "pages"].includes(
    cvExtension(cv.originalName),
  );
  const length = fullDocument ? head.sizeBytes : Math.min(head.sizeBytes, 8192);
  const bytes = await storage.readRange(
    cv.objectKey,
    head.version,
    0,
    length - 1,
  );
  if (bytes.length !== length)
    throw new CvValidationError("The uploaded document is truncated.");
  validateCvBytes(cv.originalName, cv.mimeType, bytes);
  return head.version;
}

/**
 * The current request's OIDC token, checked once now and again on every later call. It is read
 * from the request context only; the async Vercel helper, which can refresh via local CLI
 * config, is never called.
 */
async function requestOidcToken(): Promise<() => string> {
  const { getContext, getVercelOidcTokenSync } = await import("@vercel/oidc");
  const currentToken = () => {
    const requestToken = assertHostedOidcToken(
      process.env,
      getContext().headers?.["x-vercel-oidc-token"],
    );
    if (getVercelOidcTokenSync() !== requestToken)
      throw new StorageConfigurationError(
        "The hosted request OIDC context changed. Retry the request.",
        "oidc_context_changed",
      );
    return requestToken;
  };
  currentToken();
  return currentToken;
}

/** Created within an authenticated request with explicit credentials; no CLI credential refresh. */
export async function getStorage(): Promise<StorageGateway | BlobGateway> {
  const provider = selectedProvider(process.env);
  if (provider === "blob") {
    if (process.env.VERCEL !== "1")
      assertHostedOidcToken(process.env, undefined);
    // Presence refuses, even empty: hosted Blob uses only the request's OIDC token.
    if (process.env.BLOB_READ_WRITE_TOKEN !== undefined)
      throw new StorageConfigurationError(
        "Hosted Blob CV storage refuses a static read-write token. Remove BLOB_READ_WRITE_TOKEN.",
        "blob_token_present",
      );
    const binding = resolveStorageBinding();
    const currentToken = await requestOidcToken();
    // Dynamic imports keep this module free of an import cycle with the Blob modules.
    const { createBlobGateway } = await import("./blob-storage.ts");
    const { createVercelBlobClient } = await import("./vercel-blob-client.ts");
    return createBlobGateway(
      binding,
      createVercelBlobClient({ storeId: binding.store, oidcToken: currentToken }),
    );
  }
  if (provider !== "s3") throw providerUnsupported();
  if (!storageConfigured())
    throw new StorageConfigurationError(
      STORAGE_SETUP_REQUIRED_MESSAGE,
      "not_configured",
    );
  let credentials;
  if (process.env.AWS_ROLE_ARN) {
    if (process.env.VERCEL !== "1")
      assertHostedOidcToken(process.env, undefined);
    const currentToken = await requestOidcToken();
    const { fromWebToken } =
      await import("@aws-sdk/credential-provider-web-identity");
    const roleArn = process.env.AWS_ROLE_ARN;
    credentials = async () =>
      fromWebToken({
        roleArn,
        webIdentityToken: currentToken(),
        clientConfig: { region: process.env.AWS_REGION },
      })();
  } else {
    credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
    };
  }
  const {
    S3Client,
    GetBucketVersioningCommand,
    HeadObjectCommand,
    GetObjectCommand,
  } = await import("@aws-sdk/client-s3");
  const { createPresignedPost } = await import("@aws-sdk/s3-presigned-post");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const binding = resolveStorageBinding();
  const bucket = binding.store;
  const client = new S3Client({
    region: process.env.AWS_REGION,
    credentials,
    maxAttempts: 2,
  });
  return {
    binding,
    async assertVersioning() {
      const result = await client.send(
        new GetBucketVersioningCommand({ Bucket: bucket }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
      if (result.Status !== "Enabled")
        throw new StorageConfigurationError(
          "Enable versioning on the private S3 bucket before uploading CVs.",
          "aws_versioning_disabled",
        );
    },
    async presignPost(key, mimeType, sizeBytes, expiresSeconds) {
      return createPresignedPost(client, {
        Bucket: bucket,
        Key: key,
        Expires: Math.max(1, Math.min(300, expiresSeconds)),
        Fields: {
          "Content-Type": mimeType,
          "x-amz-server-side-encryption": "AES256",
          success_action_status: "204",
        },
        Conditions: [
          ["content-length-range", sizeBytes, sizeBytes],
          { "Content-Type": mimeType },
          { "x-amz-server-side-encryption": "AES256" },
          { success_action_status: "204" },
        ],
      });
    },
    async head(key) {
      const result = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
      return {
        sizeBytes: result.ContentLength ?? -1,
        mimeType: result.ContentType ?? "",
        version: result.VersionId,
      };
    },
    async readRange(key, version, start, end) {
      if (
        !version ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end - start + 1 > MAX_CV_BYTES
      )
        throw new CvValidationError("Invalid document read range.");
      const result = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          VersionId: version,
          Range: `bytes=${start}-${end}`,
        }),
        { abortSignal: AbortSignal.timeout(15_000) },
      );
      if (!result.Body)
        throw new CvValidationError(
          "The uploaded object has no document body.",
        );
      const parts: Buffer[] = [];
      let size = 0;
      for await (const part of result.Body as AsyncIterable<Uint8Array>) {
        size += part.length;
        if (size > end - start + 1)
          throw new CvValidationError(
            "Document read exceeded its bounded range.",
          );
        parts.push(Buffer.from(part));
      }
      return Buffer.concat(parts);
    },
    async signDownload(key, version, name) {
      if (!version || version === "null")
        throw new StorageConfigurationError(
          "This CV has no immutable S3 version reference.",
          "aws_version_missing",
        );
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          VersionId: version,
          ResponseContentDisposition: attachmentDisposition(name),
          ResponseContentType: "application/octet-stream",
          ResponseCacheControl: "private, no-store",
        }),
        { expiresIn: 60 },
      );
    },
  };
}
