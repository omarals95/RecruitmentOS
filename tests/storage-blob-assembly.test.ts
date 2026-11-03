import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assembleVerifiedBlobChunks } from "../src/lib/blob-assembly.ts";

const data = new TextEncoder().encode("synthetic private CV");
const reference = {
  uploadId: "fixture-upload",
  sha256: createHash("sha256").update(data).digest("hex"),
  sizeBytes: data.length,
};
async function* parts(
  ...items: Array<{
    uploadId: string;
    sha256: string;
    sizeBytes: number;
    offset: number;
    bytes: Uint8Array;
  }>
) {
  yield* items;
}
function part(offset: number, bytes: Uint8Array) {
  return { ...reference, offset, bytes };
}

test("assembles ordered chunks only after checking the entire digest", async () => {
  const assembled = await assembleVerifiedBlobChunks(
    reference,
    parts(part(0, data.subarray(0, 8)), part(8, data.subarray(8))),
  );
  assert.deepEqual(assembled, data);
});

test("rejects a changed version, size, upload ID or malformed reference", async () => {
  for (const change of [
    { uploadId: "other" },
    { sha256: "0".repeat(64) },
    { sizeBytes: data.length + 1 },
  ]) {
    await assert.rejects(
      assembleVerifiedBlobChunks(
        reference,
        parts({ ...part(0, data), ...change }),
      ),
    );
  }
  await assert.rejects(
    assembleVerifiedBlobChunks(
      { ...reference, sha256: "bad" },
      parts(part(0, data)),
    ),
  );
});

test("rejects missing, overlapping, repeated or excessive chunks", async () => {
  await assert.rejects(
    assembleVerifiedBlobChunks(reference, parts(part(0, data.subarray(0, 8)))),
  );
  await assert.rejects(
    assembleVerifiedBlobChunks(
      reference,
      parts(part(8, data.subarray(8)), part(0, data.subarray(0, 8))),
    ),
  );
  await assert.rejects(
    assembleVerifiedBlobChunks(reference, parts(part(0, data), part(0, data))),
  );
  await assert.rejects(
    assembleVerifiedBlobChunks(
      reference,
      parts(part(0, new Uint8Array(data.length + 1))),
    ),
  );
  await assert.rejects(
    assembleVerifiedBlobChunks(reference, parts(part(0, new Uint8Array()))),
  );
});

test("rejects changed bytes even when metadata matches and never returns partial data", async () => {
  const changed = data.slice();
  changed[changed.length - 1] ^= 1;
  await assert.rejects(
    assembleVerifiedBlobChunks(reference, parts(part(0, changed))),
  );
  async function* interrupted() {
    yield part(0, data.subarray(0, 8));
    throw new Error("interrupted");
  }
  await assert.rejects(
    assembleVerifiedBlobChunks(reference, interrupted()),
    /interrupted/,
  );
});

test("copies chunk bytes before the producer may reuse its buffer", async () => {
  const first = data.slice(0, 8);
  async function* reused() {
    yield part(0, first);
    first.fill(0);
    yield part(8, data.subarray(8));
  }
  assert.deepEqual(await assembleVerifiedBlobChunks(reference, reused()), data);
});

test("does not let a producer replace the trusted digest during assembly", async () => {
  const trusted = { ...reference };
  const substituted = data.slice();
  substituted[0] ^= 1;
  async function* attacker() {
    trusted.sha256 = createHash("sha256").update(substituted).digest("hex");
    yield { ...trusted, offset: 0, bytes: substituted };
  }
  await assert.rejects(assembleVerifiedBlobChunks(trusted, attacker()));
});

test("assembles a 10 MiB file from bounded chunks and rejects a larger chunk", async () => {
  const large = new Uint8Array(10 * 1024 * 1024);
  large[large.length - 1] = 42;
  const ref = {
    uploadId: "large-fixture",
    sha256: createHash("sha256").update(large).digest("hex"),
    sizeBytes: large.length,
  };
  const chunkSize = 4 * 1024 * 1024;
  async function* bounded() {
    for (let offset = 0; offset < large.length; offset += chunkSize)
      yield {
        ...ref,
        offset,
        bytes: large.subarray(offset, offset + chunkSize),
      };
  }
  assert.deepEqual(await assembleVerifiedBlobChunks(ref, bounded()), large);
  async function* excessive() {
    yield { ...ref, offset: 0, bytes: large.subarray(0, chunkSize + 1) };
  }
  await assert.rejects(assembleVerifiedBlobChunks(ref, excessive()));
});
