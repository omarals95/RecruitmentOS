import test from "node:test";
import assert from "node:assert/strict";
import {
  storageConfigured,
  inspectStoredCv,
  attachmentDisposition,
  getStorage,
  assertHostedOidcToken,
  type StorageGateway,
} from "../src/lib/storage.ts";

const pdf = Buffer.from("%PDF-1.7\nfictional test");
function fake(overrides: Partial<StorageGateway> = {}): StorageGateway {
  return {
    async assertVersioning() {},
    async presignPost() {
      return { url: "https://example.invalid", fields: {} };
    },
    async head() {
      return {
        sizeBytes: pdf.length,
        mimeType: "application/pdf",
        version: "immutable-v1",
      };
    },
    async readRange(_key, version) {
      assert.equal(version, "immutable-v1");
      return pdf;
    },
    async signDownload() {
      return "https://example.invalid/download";
    },
    ...overrides,
  };
}
const cv = {
  objectKey: "teams/t/cvs/c/u/random.pdf",
  originalName: "cv.pdf",
  mimeType: "application/pdf",
  sizeBytes: pdf.length,
};

test("storage is unconfigured without bucket, region and explicit credentials", () => {
  assert.equal(storageConfigured({}), false);
  assert.equal(
    storageConfigured({
      AWS_REGION: "me-central-1",
      S3_BUCKET_NAME: "private-cvs",
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/recruitment",
    }),
    true,
  );
  assert.equal(
    storageConfigured({
      AWS_REGION: "me-central-1",
      S3_BUCKET_NAME: "private-cvs",
      AWS_ACCESS_KEY_ID: "id",
    }),
    false,
  );
});
test("Blob and unknown provider selections fail closed even when S3 credentials exist", async () => {
  const fictional = {
    AWS_REGION: "me-central-1",
    S3_BUCKET_NAME: "fictional-private-cvs",
    AWS_ACCESS_KEY_ID: "fictional-access-key",
    AWS_SECRET_ACCESS_KEY: "fictional-secret-key",
  };
  for (const provider of ["blob", "vercel-blob", "unexpected"]) {
    assert.equal(
      storageConfigured({ ...fictional, CV_STORAGE_PROVIDER: provider }),
      false,
    );
    const saved = process.env.CV_STORAGE_PROVIDER;
    try {
      process.env.CV_STORAGE_PROVIDER = provider;
      await assert.rejects(getStorage(), /disabled|not supported/i);
    } finally {
      if (saved === undefined) delete process.env.CV_STORAGE_PROVIDER;
      else process.env.CV_STORAGE_PROVIDER = saved;
    }
  }
  assert.equal(
    storageConfigured({ ...fictional, CV_STORAGE_PROVIDER: "s3" }),
    true,
  );
});
test("OIDC accepts only a fresh hosted request token and never substitutes local environment tokens", () => {
  const now = Date.now();
  const token = (exp: number) =>
    `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.fictional`;
  const fresh = token(Math.floor(now / 1000) + 300);
  assert.equal(assertHostedOidcToken({ VERCEL: "1" }, fresh, now), fresh);
  assert.throws(() => assertHostedOidcToken({}, fresh, now));
  assert.throws(() =>
    assertHostedOidcToken(
      { VERCEL: "1", VERCEL_OIDC_TOKEN: fresh },
      undefined,
      now,
    ),
  );
  assert.throws(() =>
    assertHostedOidcToken(
      { VERCEL: "1" },
      token(Math.floor(now / 1000) - 1),
      now,
    ),
  );
  assert.throws(() =>
    assertHostedOidcToken(
      { VERCEL: "1" },
      token(Math.floor(now / 1000) + 30),
      now,
    ),
  );
  assert.throws(() => assertHostedOidcToken({ VERCEL: "1" }, "not-a-jwt", now));
});
test("configured OIDC outside hosted context fails before STS or any local CLI fallback", async () => {
  const keys = [
    "AWS_REGION",
    "S3_BUCKET_NAME",
    "AWS_ROLE_ARN",
    "VERCEL",
    "VERCEL_OIDC_TOKEN",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.AWS_REGION = "us-east-1";
    process.env.S3_BUCKET_NAME = "fictional-storage-test";
    process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/fictional";
    delete process.env.VERCEL;
    await assert.rejects(getStorage(), /hosted Vercel request/);
    process.env.VERCEL = "1";
    delete process.env.VERCEL_OIDC_TOKEN;
    await assert.rejects(getStorage(), /request-context OIDC token/);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
test("completion validates the exact immutable version even if latest changes", async () => {
  const result = await inspectStoredCv(fake(), cv);
  assert.equal(result, "immutable-v1");
});
test("completion refuses unversioned, oversized and MIME-mismatched objects", async () => {
  for (const head of [
    { sizeBytes: 24, mimeType: "application/pdf", version: undefined },
    { sizeBytes: 11 * 1024 * 1024, mimeType: "application/pdf", version: "v" },
    { sizeBytes: 24, mimeType: "image/png", version: "v" },
  ])
    await assert.rejects(
      inspectStoredCv(
        fake({
          async head() {
            return head;
          },
        }),
        cv,
      ),
    );
});
test("a spoofed PDF remains rejected after S3 metadata checks pass", async () => {
  await assert.rejects(
    inspectStoredCv(
      fake({
        async readRange() {
          return Buffer.from("MZ executable");
        },
      }),
      cv,
    ),
  );
});
test("Content-Disposition removes header controls and encodes international filenames", () => {
  const header = attachmentDisposition("سيرة ذاتية\r\n.pdf");
  assert.ok(header.startsWith("attachment;"));
  assert.ok(header.includes("filename*=UTF-8''"));
  assert.equal(/[\r\n]/.test(header), false);
});

test("AWS SDK signs version-pinned attachment downloads and constrained POST policies locally", async () => {
  const keys = [
    "AWS_REGION",
    "S3_BUCKET_NAME",
    "AWS_ROLE_ARN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.AWS_REGION = "us-east-1";
    process.env.S3_BUCKET_NAME = "fictional-storage-test";
    delete process.env.AWS_ROLE_ARN;
    process.env.AWS_ACCESS_KEY_ID = "FAKE_TEST_ONLY_ACCESS";
    process.env.AWS_SECRET_ACCESS_KEY = "fake-test-only-secret-not-a-real-key";
    delete process.env.AWS_SESSION_TOKEN;
    const storage = await getStorage();
    // Signing with explicit fictional credentials is local; no S3 send/HEAD/versioning request occurs.
    const url = new URL(
      await storage.signDownload(
        "teams/fictional/cvs/test.pdf",
        "fixed-v1",
        "test.pdf",
      ),
    );
    assert.equal(url.searchParams.get("versionId"), "fixed-v1");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "60");
    assert.ok(
      url.searchParams
        .get("response-content-disposition")
        ?.startsWith("attachment;"),
    );
    const post = await storage.presignPost(
      "teams/fictional/cvs/test.pdf",
      "application/pdf",
      1000,
      300,
    );
    const policy = JSON.parse(
      Buffer.from(post.fields.Policy, "base64").toString("utf8"),
    );
    assert.ok(
      policy.conditions.some(
        (item: unknown) =>
          JSON.stringify(item) ===
          JSON.stringify(["content-length-range", 1000, 1000]),
      ),
    );
    assert.equal(post.fields["x-amz-server-side-encryption"], "AES256");
    assert.equal(post.fields["Content-Type"], "application/pdf");
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
