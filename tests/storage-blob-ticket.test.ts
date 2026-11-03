import test from "node:test";
import assert from "node:assert/strict";
import { createBlobPutTicket } from "../src/lib/blob-put-ticket.ts";

const now = 1_000_000;
const reservation = {
  objectKey: "teams/team-a/cvs/candidate/upload/random.pdf",
  storeId: "store_synthetic",
  originalName: "example.pdf",
  mimeType: "application/pdf",
  sizeBytes: 24,
  expiresAt: now + 600_000,
};
const expectedOrigin = "https://vercel.com";
const secret = "synthetic-signing-secret";
function delegation(
  validUntil: number,
  override: Record<string, unknown> = {},
) {
  return (
    Buffer.from(
      JSON.stringify({
        storeId: "synthetic",
        pathname: reservation.objectKey,
        operations: ["put"],
        validUntil,
        maximumSizeInBytes: reservation.sizeBytes,
        allowedContentTypes: [reservation.mimeType],
        ...override,
      }),
    ).toString("base64url") + ".synthetic_hmac"
  );
}
function fakeUrl(token: string, path = reservation.objectKey) {
  const url = new URL(`${expectedOrigin}/api/blob/`);
  for (const [key, value] of Object.entries({
    pathname: path,
    "vercel-blob-delegation": token,
    "vercel-blob-signature": "synthetic_signature_0001",
    "vercel-blob-allowed-content-types": reservation.mimeType,
    "vercel-blob-maximum-size-in-bytes": String(reservation.sizeBytes),
    "vercel-blob-add-random-suffix": "false",
    "vercel-blob-allow-overwrite": "false",
  }))
    url.searchParams.set(key, value);
  return url.toString();
}
const tokenFor = (
  validUntil: number,
  override: Record<string, unknown> = {},
) => ({
  delegationToken: delegation(validUntil, override),
  clientSigningToken: secret,
  validUntil,
});

test("signs only a private exact-path limited PUT and never returns signing material", async () => {
  let issued: Record<string, unknown> | undefined;
  let signed: Record<string, unknown> | undefined;
  const token = tokenFor(now + 300_000);
  const ticket = await createBlobPutTicket(
    reservation,
    expectedOrigin,
    {
      async issueSignedToken(options) {
        issued = options;
        return token;
      },
      async presignUrl(_token, options) {
        signed = options;
        return { presignedUrl: fakeUrl(token.delegationToken) };
      },
    },
    () => now,
  );
  assert.deepEqual(ticket, {
    method: "PUT",
    url: fakeUrl(token.delegationToken),
    contentType: "application/pdf",
    expiresAt: now + 300_000,
  });
  assert.equal(JSON.stringify(ticket).includes(secret), false);
  assert.deepEqual(issued?.operations, ["put"]);
  assert.equal(issued?.pathname, reservation.objectKey);
  assert.deepEqual(issued?.allowedContentTypes, [reservation.mimeType]);
  assert.equal(issued?.maximumSizeInBytes, reservation.sizeBytes);
  assert.equal(issued?.validUntil, now + 300_000);
  assert.ok(issued?.abortSignal instanceof AbortSignal);
  assert.equal(signed?.operation, "put");
  assert.equal(signed?.pathname, reservation.objectKey);
  assert.equal(signed?.access, "private");
  assert.equal(signed?.validUntil, now + 300_000);
  assert.equal(signed?.allowOverwrite, false);
  assert.equal(signed?.addRandomSuffix, false);
  assert.deepEqual(signed?.allowedContentTypes, [reservation.mimeType]);
  assert.equal(signed?.maximumSizeInBytes, reservation.sizeBytes);
});

test("refuses invalid or expired reservations before calling the signer", async () => {
  const badRows = [
    { ...reservation, expiresAt: now },
    { ...reservation, sizeBytes: 0 },
    { ...reservation, mimeType: "text/plain" },
    { ...reservation, storeId: "" },
    { ...reservation, objectKey: "../candidate.pdf" },
    { ...reservation, objectKey: "teams/x/cvs/../other.pdf" },
    { ...reservation, objectKey: "https://elsewhere.test/x" },
  ];
  for (const row of badRows) {
    let invoked = false;
    await assert.rejects(
      createBlobPutTicket(
        row,
        expectedOrigin,
        {
          async issueSignedToken() {
            invoked = true;
            throw new Error("should not run");
          },
          async presignUrl() {
            throw new Error("should not run");
          },
        },
        () => now,
      ),
    );
    assert.equal(invoked, false);
  }
});

test("refuses an untrusted API origin before requesting signing material", async () => {
  let invoked = false;
  await assert.rejects(
    createBlobPutTicket(
      reservation,
      "https://attacker.example",
      {
        async issueSignedToken() {
          invoked = true;
          throw new Error("must not run");
        },
        async presignUrl() {
          throw new Error("must not sign");
        },
      },
      () => now,
    ),
  );
  assert.equal(invoked, false);
});

test("refuses an SDK endpoint override before requesting signing material", async () => {
  const previous = process.env.VERCEL_BLOB_API_URL;
  process.env.VERCEL_BLOB_API_URL = "https://attacker.example/api/blob";
  let invoked = false;
  try {
    await assert.rejects(
      createBlobPutTicket(
        reservation,
        expectedOrigin,
        {
          async issueSignedToken() {
            invoked = true;
            throw new Error("must not run");
          },
          async presignUrl() {
            throw new Error("must not sign");
          },
        },
        () => now,
      ),
    );
    assert.equal(invoked, false);
  } finally {
    if (previous === undefined) delete process.env.VERCEL_BLOB_API_URL;
    else process.env.VERCEL_BLOB_API_URL = previous;
  }
});

test("caps the capability to the reservation and provider's shorter expiry", async () => {
  let signedExpiry: unknown;
  const token = tokenFor(now + 20_000);
  const ticket = await createBlobPutTicket(
    { ...reservation, expiresAt: now + 45_000 },
    expectedOrigin,
    {
      async issueSignedToken() {
        return token;
      },
      async presignUrl(_token, options) {
        signedExpiry = options.validUntil;
        return { presignedUrl: fakeUrl(token.delegationToken) };
      },
    },
    () => now,
  );
  assert.equal(signedExpiry, now + 20_000);
  assert.equal(ticket.expiresAt, now + 20_000);
});

test("requires a signed expiry if the delegation outlives the reservation", async () => {
  const token = tokenFor(now + 120_000);
  const request = { ...reservation, expiresAt: now + 30_000 };
  const sdk = {
    async issueSignedToken() {
      return token;
    },
    async presignUrl() {
      return { presignedUrl: fakeUrl(token.delegationToken) };
    },
  };
  await assert.rejects(
    createBlobPutTicket(request, expectedOrigin, sdk, () => now),
  );
  const ticket = await createBlobPutTicket(
    request,
    expectedOrigin,
    {
      ...sdk,
      async presignUrl() {
        return {
          presignedUrl: `${fakeUrl(token.delegationToken)}&vercel-blob-valid-until=${now + 30_000}`,
        };
      },
    },
    () => now,
  );
  assert.equal(ticket.expiresAt, now + 30_000);
});

test("pins the authorized object path, store and expiry if the reservation changes during signing", async () => {
  const row = { ...reservation, expiresAt: now + 60_000 };
  const token = tokenFor(now + 60_000);
  let signedPath: string | undefined;
  const ticket = await createBlobPutTicket(
    row,
    expectedOrigin,
    {
      async issueSignedToken() {
        row.objectKey = "teams/other/cvs/attacker.pdf";
        row.storeId = "store_other";
        row.expiresAt = now + 3_600_000;
        return token;
      },
      async presignUrl(_token, options) {
        signedPath = options.pathname;
        return { presignedUrl: fakeUrl(token.delegationToken) };
      },
    },
    () => now,
  );
  assert.equal(signedPath, reservation.objectKey);
  assert.equal(ticket.expiresAt, now + 60_000);
});

test("rejects a delegation with a different store, path, scope, size, type or expiry", async () => {
  const overrides = [
    { storeId: "other" },
    { pathname: "teams/other/file.pdf" },
    { operations: ["put", "delete"] },
    { maximumSizeInBytes: 25 },
    { allowedContentTypes: ["application/pdf", "text/plain"] },
    { validUntil: now + 500_000 },
  ];
  for (const changed of overrides) {
    let signed = false;
    await assert.rejects(
      createBlobPutTicket(
        reservation,
        expectedOrigin,
        {
          async issueSignedToken() {
            return tokenFor(now + 60_000, changed);
          },
          async presignUrl() {
            signed = true;
            throw new Error("must not sign");
          },
        },
        () => now,
      ),
    );
    assert.equal(signed, false);
  }
});

test("rejects unsafe URLs, expired tickets and provider errors without leaking signing material", async () => {
  const token = tokenFor(now + 60_000);
  const urls = [
    "https://attacker.example/upload",
    `${expectedOrigin}/other?pathname=${encodeURIComponent(reservation.objectKey)}`,
    fakeUrl(token.delegationToken, "teams/other/cvs/other.pdf"),
    `${fakeUrl(token.delegationToken)}&pathname=other`,
    fakeUrl(token.delegationToken).replace(
      "vercel-blob-allow-overwrite=false",
      "vercel-blob-allow-overwrite=true",
    ),
    `${fakeUrl(token.delegationToken)}&vercel-blob-maximum-size-in-bytes=99999`,
    `${fakeUrl(token.delegationToken)}&key=${secret}`,
  ];
  for (const url of urls)
    await assert.rejects(
      createBlobPutTicket(
        reservation,
        expectedOrigin,
        {
          async issueSignedToken() {
            return token;
          },
          async presignUrl() {
            return { presignedUrl: url };
          },
        },
        () => now,
      ),
    );
  await assert.rejects(
    createBlobPutTicket(
      reservation,
      expectedOrigin,
      {
        async issueSignedToken() {
          throw new Error(`leak ${secret}`);
        },
        async presignUrl() {
          throw new Error("must not sign");
        },
      },
      () => now,
    ),
    (error: Error) => !error.message.includes(secret),
  );
  await assert.rejects(
    createBlobPutTicket(
      reservation,
      expectedOrigin,
      {
        async issueSignedToken() {
          return tokenFor(now);
        },
        async presignUrl() {
          throw new Error("must not sign");
        },
      },
      () => now,
    ),
  );
});
