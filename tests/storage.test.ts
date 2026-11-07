import test from "node:test";
import assert from "node:assert/strict";
import {
  storageConfigured,
  inspectStoredCv,
  attachmentDisposition,
  getStorage,
  assertHostedOidcToken,
  resolveStorageBinding,
  StorageConfigurationError,
  type StorageGateway,
} from "../src/lib/storage.ts";

const pdf = Buffer.from("%PDF-1.7\nfictional test");
function fake(overrides: Partial<StorageGateway> = {}): StorageGateway {
  return {
    binding: {
      provider: "s3",
      environment: "development",
      store: "fictional-private-cvs",
    },
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

test("S3 storage is unconfigured without bucket, region and explicit credentials", () => {
  assert.equal(storageConfigured({}), false);
  assert.equal(
    storageConfigured({
      CV_STORAGE_PROVIDER: "s3",
      AWS_REGION: "me-central-1",
      S3_BUCKET_NAME: "private-cvs",
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/recruitment",
    }),
    true,
  );
  assert.equal(
    storageConfigured({
      CV_STORAGE_PROVIDER: "s3",
      AWS_REGION: "me-central-1",
      S3_BUCKET_NAME: "private-cvs",
      AWS_ACCESS_KEY_ID: "id",
    }),
    false,
  );
});
const hostedBlob = {
  BLOB_STORE_ID: "store_fictional",
  VERCEL: "1",
  VERCEL_ENV: "preview",
};
test("Blob is the default and reads as set up only when hosted with a valid store and no static token", () => {
  for (const provider of [
    undefined,
    "",
    "blob",
    "vercel-blob",
    " Vercel-Blob ",
  ]) {
    const env = { ...hostedBlob, CV_STORAGE_PROVIDER: provider };
    assert.equal(storageConfigured(env), true, String(provider));
    assert.deepEqual(resolveStorageBinding(env), {
      provider: "blob",
      environment: "preview",
      store: "store_fictional",
    });
  }
  assert.equal(
    storageConfigured({ ...hostedBlob, VERCEL_ENV: "production" }),
    true,
  );
  const refused: [string, Record<string, string | undefined>][] = [
    ["off Vercel", { ...hostedBlob, VERCEL: undefined }],
    ["no Vercel environment", { ...hostedBlob, VERCEL_ENV: undefined }],
    ["missing store", { ...hostedBlob, BLOB_STORE_ID: undefined }],
    ["store without prefix", { ...hostedBlob, BLOB_STORE_ID: "fictional" }],
    ["store characters", { ...hostedBlob, BLOB_STORE_ID: "store_a/b" }],
    [
      "token",
      { ...hostedBlob, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_fictional_x" },
    ],
    ["empty token", { ...hostedBlob, BLOB_READ_WRITE_TOKEN: "" }],
    ["unexpected", { ...hostedBlob, CV_STORAGE_PROVIDER: "unexpected" }],
  ];
  for (const [label, env] of refused)
    assert.equal(storageConfigured(env), false, label);
  // Off Vercel the binding still resolves as development, but no gateway can be built.
  assert.deepEqual(
    resolveStorageBinding({ BLOB_STORE_ID: "store_fictional" }),
    {
      provider: "blob",
      environment: "development",
      store: "store_fictional",
    },
  );
  for (const store of [undefined, "", "fictional", "store_a/b"])
    assert.throws(
      () => resolveStorageBinding({ ...hostedBlob, BLOB_STORE_ID: store }),
      (error: unknown) =>
        error instanceof StorageConfigurationError &&
        error.reason === "not_configured",
    );
  assert.throws(
    () =>
      resolveStorageBinding({ ...hostedBlob, CV_STORAGE_PROVIDER: "other" }),
    (error: unknown) =>
      error instanceof StorageConfigurationError &&
      error.reason === "provider_unsupported",
  );
});
test("an unknown provider fails closed even when S3 credentials exist", async () => {
  const fictional = {
    AWS_REGION: "me-central-1",
    S3_BUCKET_NAME: "fictional-private-cvs",
    AWS_ACCESS_KEY_ID: "fictional-access-key",
    AWS_SECRET_ACCESS_KEY: "fictional-secret-key",
  };
  assert.equal(
    storageConfigured({ ...fictional, CV_STORAGE_PROVIDER: "unexpected" }),
    false,
  );
  // Without a provider the S3 settings are ignored: Blob is the default.
  assert.equal(storageConfigured(fictional), false);
  const saved = process.env.CV_STORAGE_PROVIDER;
  try {
    process.env.CV_STORAGE_PROVIDER = "unexpected";
    await assert.rejects(getStorage(), /not supported/i);
  } finally {
    if (saved === undefined) delete process.env.CV_STORAGE_PROVIDER;
    else process.env.CV_STORAGE_PROVIDER = saved;
  }
  assert.equal(
    storageConfigured({ ...fictional, CV_STORAGE_PROVIDER: "s3" }),
    true,
  );
});
test("the storage binding names the provider, the Vercel environment and the bucket without a provider call", () => {
  const bucket = {
    CV_STORAGE_PROVIDER: "s3",
    S3_BUCKET_NAME: "fictional-private-cvs",
  };
  assert.deepEqual(resolveStorageBinding(bucket), {
    provider: "s3",
    environment: "development",
    store: "fictional-private-cvs",
  });
  for (const environment of ["preview", "production"])
    assert.deepEqual(
      resolveStorageBinding({
        ...bucket,
        VERCEL: "1",
        VERCEL_ENV: environment,
      }),
      { provider: "s3", environment, store: "fictional-private-cvs" },
    );
  for (const hosted of [
    { VERCEL: "1" },
    { VERCEL: "1", VERCEL_ENV: "development" },
  ])
    assert.throws(
      () => resolveStorageBinding({ ...bucket, ...hosted }),
      StorageConfigurationError,
    );
  assert.throws(
    () => resolveStorageBinding({ CV_STORAGE_PROVIDER: "s3" }),
    StorageConfigurationError,
  );
  assert.throws(() => resolveStorageBinding({}), StorageConfigurationError);
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
    "CV_STORAGE_PROVIDER",
    "AWS_REGION",
    "S3_BUCKET_NAME",
    "AWS_ROLE_ARN",
    "VERCEL",
    "VERCEL_OIDC_TOKEN",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.CV_STORAGE_PROVIDER = "s3";
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
    "CV_STORAGE_PROVIDER",
    "AWS_REGION",
    "S3_BUCKET_NAME",
    "AWS_ROLE_ARN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "VERCEL",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.CV_STORAGE_PROVIDER = "s3";
    process.env.AWS_REGION = "us-east-1";
    process.env.S3_BUCKET_NAME = "fictional-storage-test";
    delete process.env.AWS_ROLE_ARN;
    delete process.env.VERCEL;
    process.env.AWS_ACCESS_KEY_ID = "FAKE_TEST_ONLY_ACCESS";
    process.env.AWS_SECRET_ACCESS_KEY = "fake-test-only-secret-not-a-real-key";
    delete process.env.AWS_SESSION_TOKEN;
    const storage = await getStorage();
    if ("readVerifiedSlice" in storage) throw new Error("Expected S3.");
    assert.deepEqual(storage.binding, {
      provider: "s3",
      environment: "development",
      store: "fictional-storage-test",
    });
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

/** Installs a fictional Vercel request context; each read returns the next token, then the last. */
function requestContext(...tokens: (string | undefined)[]) {
  const symbol = Symbol.for("@vercel/request-context");
  const holder = globalThis as unknown as Record<symbol, unknown>;
  let reads = 0;
  holder[symbol] = {
    get: () => ({
      headers: {
        "x-vercel-oidc-token": tokens[Math.min(reads++, tokens.length - 1)],
      },
    }),
  };
  return () => delete holder[symbol];
}
const oidcJwt = (exp: number) =>
  `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.fictional`;
const reason = (expected: string) => (error: unknown) =>
  error instanceof StorageConfigurationError && error.reason === expected;

test("the hosted Blob gateway takes only the fresh request OIDC token and refuses a static token", async () => {
  const keys = [
    "CV_STORAGE_PROVIDER",
    "BLOB_STORE_ID",
    "BLOB_READ_WRITE_TOKEN",
    "VERCEL",
    "VERCEL_ENV",
    "VERCEL_OIDC_TOKEN",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const fresh = oidcJwt(Math.floor(Date.now() / 1000) + 600);
  let clear = () => true;
  try {
    for (const key of keys) delete process.env[key];
    process.env.BLOB_STORE_ID = "store_fictional";
    // Off Vercel nothing is read from a request or the environment.
    process.env.VERCEL_OIDC_TOKEN = fresh;
    clear = requestContext(fresh);
    await assert.rejects(getStorage(), reason("oidc_not_hosted"));
    clear();
    delete process.env.VERCEL_OIDC_TOKEN;
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    for (const value of ["vercel_blob_rw_fictional_0000000000000000", ""]) {
      process.env.BLOB_READ_WRITE_TOKEN = value;
      clear = requestContext(fresh);
      await assert.rejects(getStorage(), reason("blob_token_present"));
      clear();
    }
    delete process.env.BLOB_READ_WRITE_TOKEN;
    for (const [token, expected] of [
      [undefined, "oidc_missing"],
      ["not-a-jwt", "oidc_missing"],
      ["e30.%%%.fictional", "oidc_malformed"],
      [oidcJwt(Math.floor(Date.now() / 1000) + 30), "oidc_expired"],
    ] as const) {
      clear = requestContext(token);
      await assert.rejects(getStorage(), reason(expected), expected);
      clear();
    }
    // The sync helper sees a different token than the request context did.
    clear = requestContext(fresh, oidcJwt(Math.floor(Date.now() / 1000) + 900));
    await assert.rejects(getStorage(), reason("oidc_context_changed"));
    clear();
    clear = requestContext(fresh);
    const storage = await getStorage();
    assert.ok("readVerifiedSlice" in storage);
    assert.deepEqual(storage.binding, {
      provider: "blob",
      environment: "preview",
      store: "store_fictional",
    });
    process.env.BLOB_STORE_ID = "fictional";
    await assert.rejects(getStorage(), reason("not_configured"));
  } finally {
    clear();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
