import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspectBlobUpload } from "../src/lib/blob-upload-validation.ts";
import { MAX_CV_BYTES } from "../src/lib/storage-format.ts";

const pdf = Buffer.from("%PDF-1.7\nsynthetic only\n%%EOF");
const reservation = {
  originalName: "example.pdf",
  mimeType: "application/pdf",
  sizeBytes: pdf.length,
};
const observed = { mimeType: "application/pdf", sizeBytes: pdf.length };
async function* stream(...parts: Uint8Array[]) {
  for (const part of parts) yield part;
}

test("completion hashes the exact validated full snapshot", async () => {
  const result = await inspectBlobUpload(
    reservation,
    observed,
    stream(pdf.subarray(0, 8), pdf.subarray(8)),
  );
  assert.deepEqual(result, {
    sha256: createHash("sha256").update(pdf).digest("hex"),
  });
});

test("completion supports the entire 10 MiB limit without hashing only a prefix", async () => {
  const large = Buffer.alloc(MAX_CV_BYTES, 0x41);
  large.write("%PDF-1.7");
  const result = await inspectBlobUpload(
    { ...reservation, sizeBytes: large.length },
    { ...observed, sizeBytes: large.length },
    stream(large.subarray(0, 8192), large.subarray(8192)),
  );
  assert.equal(result.sha256, createHash("sha256").update(large).digest("hex"));
  assert.notEqual(
    result.sha256,
    createHash("sha256").update(large.subarray(0, 8192)).digest("hex"),
  );
});

test("completion rejects metadata mismatch and unsafe reservations before reading", async () => {
  for (const metadata of [
    { ...observed, mimeType: "text/plain" },
    { ...observed, sizeBytes: pdf.length - 1 },
    { ...observed, sizeBytes: pdf.length + 1 },
  ]) {
    let read = false;
    async function* source() {
      read = true;
      yield pdf;
    }
    await assert.rejects(inspectBlobUpload(reservation, metadata, source()));
    assert.equal(read, false);
  }
  await assert.rejects(
    inspectBlobUpload(
      { ...reservation, originalName: "../example.pdf" },
      observed,
      stream(pdf),
    ),
  );
});

test("completion rejects spoofed, truncated, and oversized content", async () => {
  const spoofed = Buffer.alloc(pdf.length, 0x41);
  for (const contents of [
    spoofed,
    pdf.subarray(0, -1),
    Buffer.concat([pdf, pdf]),
  ]) {
    await assert.rejects(
      inspectBlobUpload(reservation, observed, stream(contents)),
    );
  }
});

test("completion does not validate one object and hash another after mutation", async () => {
  const mutable = Buffer.from(pdf);
  async function* source() {
    yield mutable.subarray(0, 8);
    mutable.fill(0, 0, 8);
    yield mutable.subarray(8);
  }
  const result = await inspectBlobUpload(reservation, observed, source());
  assert.equal(result.sha256, createHash("sha256").update(pdf).digest("hex"));
});

test("completion releases no digest after an interrupted read", async () => {
  async function* interrupted() {
    yield pdf.subarray(0, 8);
    throw new Error("synthetic provider failure");
  }
  await assert.rejects(
    inspectBlobUpload(reservation, observed, interrupted()),
    /synthetic provider failure/,
  );
});
