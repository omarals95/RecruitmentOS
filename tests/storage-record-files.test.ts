import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createBlobPutTicket } from "../src/lib/blob-put-ticket.ts";
import { inspectBlobUpload } from "../src/lib/blob-upload-validation.ts";
import { docxWithText } from "./helpers/cv-fixtures.ts";

// File fields (R2b-06) reuse the CV ticket, magic-byte and digest checks for a record file's
// reservation, whose object key sits under teams/<team>/files/. Synthetic files only.
const now = 1_000_000;
const objectKey = "teams/team-a/files/record-a/file-a/random.pdf";
const secret = "synthetic-signing-secret";
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function* stream(bytes: Uint8Array) {
  yield bytes.subarray(0, 4);
  yield bytes.subarray(4);
}

test("issues a record file's PUT ticket for exactly its files path, without signing material", async () => {
  const reservation = {
    objectKey,
    storeId: "store_synthetic",
    originalName: "certificate.pdf",
    mimeType: "application/pdf",
    sizeBytes: 24,
    expiresAt: now + 900_000,
  };
  let issued: Record<string, unknown> | undefined;
  let signed: Record<string, unknown> | undefined;
  const validUntil = now + 300_000;
  // The delegation scope and URL the provider would return, which the ticket checks structurally.
  const delegationToken = `${Buffer.from(
    JSON.stringify({
      storeId: "synthetic",
      pathname: objectKey,
      operations: ["put"],
      validUntil,
      maximumSizeInBytes: 24,
      allowedContentTypes: ["application/pdf"],
    }),
  ).toString("base64url")}.synthetic_hmac`;
  const url = new URL("https://vercel.com/api/blob/");
  for (const [key, value] of Object.entries({
    pathname: objectKey,
    "vercel-blob-delegation": delegationToken,
    "vercel-blob-signature": "synthetic_signature_0001",
    "vercel-blob-allowed-content-types": "application/pdf",
    "vercel-blob-maximum-size-in-bytes": "24",
    "vercel-blob-add-random-suffix": "false",
    "vercel-blob-allow-overwrite": "false",
  }))
    url.searchParams.set(key, value);
  const ticket = await createBlobPutTicket(
    reservation,
    "https://vercel.com",
    {
      async issueSignedToken(options) {
        issued = options;
        return { delegationToken, clientSigningToken: secret, validUntil };
      },
      async presignUrl(_token, options) {
        signed = options;
        return { presignedUrl: url.toString() };
      },
    },
    () => now,
  );
  assert.deepEqual(ticket, {
    method: "PUT",
    url: url.toString(),
    contentType: "application/pdf",
    expiresAt: validUntil,
  });
  assert.equal(JSON.stringify(ticket).includes(secret), false);
  assert.equal(issued?.pathname, objectKey);
  assert.deepEqual(issued?.allowedContentTypes, ["application/pdf"]);
  assert.equal(issued?.maximumSizeInBytes, 24);
  assert.equal(signed?.pathname, objectKey);
  assert.equal(signed?.access, "private");
  assert.equal(signed?.allowOverwrite, false);
  assert.equal(signed?.addRandomSuffix, false);
});

const files: [string, string, Buffer][] = [
  [
    "certificate.pdf",
    "application/pdf",
    Buffer.from("%PDF-1.7\nsynthetic record file\n%%EOF"),
  ],
  [
    "certificate.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    docxWithText(["Synthetic record file"]),
  ],
  [
    "photo.png",
    "image/png",
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]),
  ],
  [
    "photo.jpg",
    "image/jpeg",
    Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]),
  ],
];

for (const [originalName, mimeType, bytes] of files)
  test(`accepts a ${mimeType} record file with its server-computed SHA-256`, async () => {
    const result = await inspectBlobUpload(
      { originalName, mimeType, sizeBytes: bytes.length },
      { mimeType, sizeBytes: bytes.length },
      stream(bytes),
    );
    assert.deepEqual(result, { sha256: sha256(bytes) });
  });

test("refuses a record file with a wrong signature or a size that differs from its reservation", async () => {
  for (const [originalName, mimeType, bytes] of files) {
    const wrong = Buffer.alloc(bytes.length, 0x41);
    await assert.rejects(
      inspectBlobUpload(
        { originalName, mimeType, sizeBytes: wrong.length },
        { mimeType, sizeBytes: wrong.length },
        stream(wrong),
      ),
      originalName,
    );
    for (const sizeBytes of [bytes.length - 1, bytes.length + 1]) {
      let read = false;
      async function* source() {
        read = true;
        yield bytes;
      }
      await assert.rejects(
        inspectBlobUpload(
          { originalName, mimeType, sizeBytes: bytes.length },
          { mimeType, sizeBytes },
          source(),
        ),
        `${originalName} ${sizeBytes}`,
      );
      assert.equal(read, false);
    }
    // A stream longer than the reservation is refused as well.
    await assert.rejects(
      inspectBlobUpload(
        { originalName, mimeType, sizeBytes: bytes.length },
        { mimeType, sizeBytes: bytes.length },
        stream(Buffer.concat([bytes, Buffer.from("extra")])),
      ),
    );
  }
});
