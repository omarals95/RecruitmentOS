import { CvValidationError, validateCvMetadata } from "./storage-format.ts";

type Reservation = {
  objectKey: string;
  storeId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: number;
};

type ScopedToken = {
  delegationToken: string;
  clientSigningToken: string;
  validUntil: number;
};

type TokenOptions = {
  pathname: string;
  operations: ["put"];
  allowedContentTypes: string[];
  maximumSizeInBytes: number;
  validUntil: number;
  abortSignal: AbortSignal;
};

type UrlOptions = {
  operation: "put";
  pathname: string;
  access: "private";
  allowedContentTypes: string[];
  maximumSizeInBytes: number;
  validUntil: number;
  addRandomSuffix: false;
  allowOverwrite: false;
};

export type BlobTicketSigner = {
  issueSignedToken(options: TokenOptions): Promise<ScopedToken>;
  presignUrl(
    token: ScopedToken,
    options: UrlOptions,
  ): Promise<{ presignedUrl: string }>;
};

/**
 * Caller must authorize and commit the durable reservation, independently verify
 * the private store and credentials. Delegation scope inspection is structural;
 * the provider authenticates its signature. Only the standard Vercel API origin
 * is accepted until a different endpoint receives separate security review.
 */
export async function createBlobPutTicket(
  reservation: Reservation,
  expectedOrigin: string,
  signer: BlobTicketSigner,
  clock: () => number = Date.now,
): Promise<{
  method: "PUT";
  url: string;
  contentType: string;
  expiresAt: number;
}> {
  const {
    objectKey,
    storeId,
    originalName,
    mimeType,
    sizeBytes,
    expiresAt: reservationExpiry,
  } = reservation;
  const expected = validateCvMetadata(originalName, mimeType, sizeBytes);
  const start = clock();
  if (
    expected.originalName !== originalName ||
    expected.mimeType !== mimeType ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(reservationExpiry) ||
    reservationExpiry <= start ||
    typeof storeId !== "string" ||
    !/^store_[A-Za-z0-9]{1,128}$/.test(storeId) ||
    typeof objectKey !== "string" ||
    objectKey.length > 1024 ||
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(objectKey) ||
    objectKey.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new CvValidationError("Invalid Blob upload reservation.");
  let origin: URL;
  try {
    origin = new URL(expectedOrigin);
    if (
      origin.origin !== "https://vercel.com" ||
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.origin !== expectedOrigin
    )
      throw new Error("Invalid origin");
  } catch {
    throw new CvValidationError("Invalid Blob upload origin.");
  }
  if (
    process.env.VERCEL_BLOB_API_URL ||
    process.env.NEXT_PUBLIC_VERCEL_BLOB_API_URL
  )
    throw new CvValidationError(
      "Blob API endpoint overrides are not supported.",
    );
  const requestedExpiry = Math.min(reservationExpiry, start + 300_000);
  try {
    const scoped = await signer.issueSignedToken({
      pathname: objectKey,
      operations: ["put"],
      allowedContentTypes: [expected.mimeType],
      maximumSizeInBytes: expected.sizeBytes,
      validUntil: requestedExpiry,
      abortSignal: AbortSignal.timeout(15_000),
    });
    if (
      !scoped ||
      typeof scoped.delegationToken !== "string" ||
      !scoped.delegationToken ||
      typeof scoped.clientSigningToken !== "string" ||
      scoped.clientSigningToken.length < 16 ||
      !Number.isSafeInteger(scoped.validUntil)
    )
      throw new Error("Invalid signer response");
    const { delegationToken, clientSigningToken, validUntil } = scoped;
    if (
      delegationToken.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(delegationToken)
    )
      throw new Error("Invalid delegation");
    const segment = delegationToken.split(".")[0];
    const decoded = Buffer.from(segment, "base64url");
    if (decoded.toString("base64url") !== segment)
      throw new Error("Invalid delegation");
    const scope = JSON.parse(decoded.toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      !scope ||
      typeof scope !== "object" ||
      (scope.storeId !== storeId && scope.storeId !== storeId.slice(6)) ||
      scope.pathname !== objectKey ||
      !Array.isArray(scope.operations) ||
      scope.operations.length !== 1 ||
      scope.operations[0] !== "put" ||
      scope.validUntil !== validUntil ||
      scope.maximumSizeInBytes !== expected.sizeBytes ||
      !Array.isArray(scope.allowedContentTypes) ||
      scope.allowedContentTypes.length !== 1 ||
      scope.allowedContentTypes[0] !== expected.mimeType
    )
      throw new Error("Invalid delegation scope");
    const expiresAt = Math.min(requestedExpiry, validUntil);
    if (expiresAt <= clock()) throw new Error("Expired signer response");
    const signed = await signer.presignUrl(
      { delegationToken, clientSigningToken, validUntil },
      {
        operation: "put",
        pathname: objectKey,
        access: "private",
        allowedContentTypes: [expected.mimeType],
        maximumSizeInBytes: expected.sizeBytes,
        validUntil: expiresAt,
        addRandomSuffix: false,
        allowOverwrite: false,
      },
    );
    const signedUrl = signed.presignedUrl;
    const url = new URL(signedUrl);
    const required = new Map([
      ["pathname", objectKey],
      ["vercel-blob-delegation", delegationToken],
      ["vercel-blob-allowed-content-types", expected.mimeType],
      ["vercel-blob-maximum-size-in-bytes", String(expected.sizeBytes)],
      ["vercel-blob-add-random-suffix", "false"],
      ["vercel-blob-allow-overwrite", "false"],
    ]);
    const signature = url.searchParams.getAll("vercel-blob-signature");
    const expiryValues = url.searchParams.getAll("vercel-blob-valid-until");
    const allowed = new Set([
      ...required.keys(),
      "vercel-blob-signature",
      "vercel-blob-valid-until",
    ]);
    if (
      url.origin !== origin.origin ||
      url.pathname !== "/api/blob/" ||
      [...url.searchParams.keys()].some((key) => !allowed.has(key)) ||
      [...required].some(
        ([key, value]) =>
          url.searchParams.getAll(key).length !== 1 ||
          url.searchParams.get(key) !== value,
      ) ||
      signature.length !== 1 ||
      !/^[A-Za-z0-9_-]{20,128}$/.test(signature[0]) ||
      expiryValues.length > 1 ||
      (expiryValues.length === 1 && expiryValues[0] !== String(expiresAt)) ||
      (expiresAt < validUntil && expiryValues.length !== 1) ||
      signedUrl.length > 16_384 ||
      url.username ||
      url.password ||
      url.hash ||
      expiresAt <= clock() ||
      decodeURIComponent(signedUrl).includes(clientSigningToken)
    )
      throw new Error("Invalid signer response");
    return {
      method: "PUT",
      url: signedUrl,
      contentType: expected.mimeType,
      expiresAt,
    };
  } catch {
    // Provider errors can contain capabilities or credential material.
    throw new Error("Private Blob upload ticket could not be issued.");
  }
}
