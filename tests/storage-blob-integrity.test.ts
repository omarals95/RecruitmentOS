import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readBlobSnapshot,
  readVerifiedBlobSlice,
  MAX_BLOB_DOWNLOAD_SLICE_BYTES,
} from "../src/lib/blob-integrity.ts";
import { MAX_CV_BYTES } from "../src/lib/storage-format.ts";

const document = Buffer.from("%PDF-1.7\nsynthetic only\n%%EOF");
const digest = createHash("sha256").update(document).digest("hex");
async function* chunks(...parts: Uint8Array[]) {
  for (const part of parts) yield part;
}

test("reads a complete bounded stream and hashes every byte", async () => {
  const result = await readBlobSnapshot(
    chunks(document.subarray(0, 5), document.subarray(5)),
    document.length,
  );
  assert.deepEqual(result.bytes, document);
  assert.equal(result.sha256, digest);
});

test("returns a bounded slice only after verifying the whole document", async () => {
  const result = await readVerifiedBlobSlice(
    chunks(document.subarray(0, 4), document.subarray(4)),
    document.length,
    digest,
    2,
    5,
  );
  assert.deepEqual(result, document.subarray(2, 7));
  const modified = Buffer.from(document);
  modified[modified.length - 1] ^= 1;
  await assert.rejects(
    readVerifiedBlobSlice(chunks(modified), document.length, digest, 0, 2),
    /integrity/i,
  );
});

test("rejects invalid byte counts, empty and incomplete streams, and oversized data", async () => {
  for (const length of [
    0,
    -1,
    1.5,
    MAX_CV_BYTES + 1,
    Number.MAX_SAFE_INTEGER,
  ]) {
    await assert.rejects(readBlobSnapshot(chunks(document), length));
  }
  await assert.rejects(readBlobSnapshot(chunks(), document.length));
  await assert.rejects(
    readBlobSnapshot(chunks(document.subarray(0, -1)), document.length),
  );
  await assert.rejects(
    readBlobSnapshot(chunks(document, Buffer.from("x")), document.length),
  );
  await assert.rejects(readBlobSnapshot(chunks(new Uint8Array()), 1));
  await assert.rejects(
    readBlobSnapshot(chunks("bad" as unknown as Uint8Array), 3),
  );
});

test("rejects malformed digests and unsafe slice boundaries before yielding bytes", async () => {
  for (const badDigest of ["", "00", "z".repeat(64), digest.toUpperCase()]) {
    await assert.rejects(
      readVerifiedBlobSlice(chunks(document), document.length, badDigest, 0, 1),
    );
  }
  for (const [start, length] of [
    [-1, 1],
    [0, 0],
    [0.5, 1],
    [0, 1.5],
    [document.length, 1],
    [document.length - 1, 2],
    [0, MAX_BLOB_DOWNLOAD_SLICE_BYTES + 1],
  ]) {
    await assert.rejects(
      readVerifiedBlobSlice(
        chunks(document),
        document.length,
        digest,
        start,
        length,
      ),
    );
  }
});

test("propagates stream errors without returning a partial slice", async () => {
  async function* interrupted() {
    yield document.subarray(0, 4);
    throw new Error("synthetic stream interrupted");
  }
  await assert.rejects(
    readVerifiedBlobSlice(interrupted(), document.length, digest, 0, 2),
    /interrupted/,
  );
});

test("copies chunks as they arrive so a producer cannot change earlier bytes", async () => {
  const mutable = Buffer.from("hello");
  async function* reused() {
    yield mutable;
    mutable.fill(0);
    yield Buffer.from("!");
  }
  const result = await readBlobSnapshot(reused(), 6);
  assert.equal(result.bytes.toString(), "hello!");
});

test("aborts a stalled snapshot without returning any bytes", async () => {
  const controller = new AbortController();
  let closed = false;
  let nextCalled = false;
  const stalled: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          nextCalled = true;
          return new Promise<IteratorResult<Uint8Array>>(() => {});
        },
        return: async () => {
          closed = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const result = readBlobSnapshot(stalled, document.length, {
    controller,
  }).then(
    () => "returned bytes",
    () => "aborted",
  );
  controller.abort();
  const outcome = await Promise.race([
    result,
    new Promise<string>((resolve) => setTimeout(() => resolve("stalled"), 100)),
  ]);
  assert.equal(outcome, "aborted");
  assert.equal(closed, true);
  assert.equal(nextCalled, false);
});

test("deadline aborts the provider's shared controller and closes the iterator", async () => {
  const controller = new AbortController();
  let closed = false;
  let providerAborted = false;
  controller.signal.addEventListener("abort", () => {
    providerAborted = true;
  });
  const stalled: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
        return: async () => {
          closed = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  await assert.rejects(
    readBlobSnapshot(stalled, document.length, { controller, timeoutMs: 10 }),
    /cancelled/,
  );
  assert.equal(providerAborted, true);
  assert.equal(closed, true);
});

test("invalid stream data aborts the provider without waiting for stalled cleanup", async () => {
  const controller = new AbortController();
  const invalid: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: false, value: new Uint8Array() }),
        return: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
      };
    },
  };
  const outcome = await Promise.race([
    readBlobSnapshot(invalid, document.length, { controller }).then(
      () => "returned bytes",
      () => "rejected",
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("stalled"), 100)),
  ]);
  assert.equal(outcome, "rejected");
  assert.equal(controller.signal.aborted, true);
});

test("invalid snapshot metadata aborts the provider request before reading", async () => {
  const controller = new AbortController();
  await assert.rejects(readBlobSnapshot(chunks(document), 0, { controller }));
  assert.equal(controller.signal.aborted, true);
});

test("invalid slice metadata aborts the provider request before reading", async () => {
  const controller = new AbortController();
  await assert.rejects(
    readVerifiedBlobSlice(chunks(document), document.length, "bad", 0, 1, {
      controller,
    }),
  );
  assert.equal(controller.signal.aborted, true);
});
