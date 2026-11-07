import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// Fictional data only. The stub provider replaces the SDK network calls; the SDK's
// real presignUrl (local HMAC, no network) stays in place.
const provider = vi.hoisted(() => ({
  objects: new Map<
    string,
    { bytes: Buffer; contentType: string; uploadedAt: Date }
  >(),
  failWith: undefined as string | undefined,
  override: undefined as undefined | ((pathname: string) => unknown),
}));
vi.mock("@vercel/blob", async (importOriginal) => {
  const original = await importOriginal<typeof import("@vercel/blob")>();
  return {
    ...original,
    issueSignedToken: vi.fn(
      async (options: {
        pathname: string;
        operations: string[];
        validUntil: number;
        maximumSizeInBytes: number;
        allowedContentTypes: string[];
      }) => {
        if (provider.failWith) throw new Error(provider.failWith);
        const scope = {
          storeId: "fictional",
          pathname: options.pathname,
          operations: options.operations,
          validUntil: options.validUntil,
          maximumSizeInBytes: options.maximumSizeInBytes,
          allowedContentTypes: options.allowedContentTypes,
        };
        return {
          delegationToken: `${Buffer.from(JSON.stringify(scope)).toString("base64url")}.fictional_store_hmac`,
          clientSigningToken: "fictional-real-client-signing-key",
          validUntil: options.validUntil,
        };
      },
    ),
    get: vi.fn(async (pathname: string) => {
      if (provider.failWith) throw new Error(provider.failWith);
      if (provider.override) return provider.override(pathname);
      const object = provider.objects.get(pathname);
      if (!object) return null;
      return {
        statusCode: 200,
        stream: streamOf(object.bytes),
        headers: new Headers(),
        blob: {
          pathname,
          size: object.bytes.length,
          contentType: object.contentType,
        },
      };
    }),
    head: vi.fn(async (pathname: string) => {
      if (provider.failWith) throw new Error(provider.failWith);
      const object = provider.objects.get(pathname);
      if (!object) throw new original.BlobNotFoundError();
      return {
        pathname,
        size: object.bytes.length,
        contentType: object.contentType,
        uploadedAt: object.uploadedAt,
      };
    }),
    del: vi.fn(async (pathname: string) => {
      if (provider.failWith) throw new Error(provider.failWith);
      provider.objects.delete(pathname);
    }),
    list: vi.fn(
      async (options: { prefix: string; cursor?: string; limit: number }) => {
        if (provider.failWith) throw new Error(provider.failWith);
        const matching = [...provider.objects.keys()]
          .filter((pathname) => pathname.startsWith(options.prefix))
          .sort();
        const start = options.cursor ? Number(options.cursor) : 0;
        const end = start + options.limit;
        return {
          blobs: matching.slice(start, end).map((pathname) => ({
            pathname,
            size: provider.objects.get(pathname)!.bytes.length,
            uploadedAt: provider.objects.get(pathname)!.uploadedAt,
          })),
          hasMore: end < matching.length,
          cursor: end < matching.length ? String(end) : undefined,
        };
      },
    ),
  };
});

import { del, get, head, issueSignedToken, list } from "@vercel/blob";
import { createBlobGateway, type BlobGateway } from "@/lib/blob-storage";
import { StorageConfigurationError } from "@/lib/storage";
import { createVercelBlobClient } from "@/lib/vercel-blob-client";
import { blobBinding, fakeBlob, signingSecret } from "./helpers/fake-blob";

const MiB = 1024 * 1024;
const token = "vercel_blob_rw_fictional_0000000000000000";
/** A fictional request OIDC token source that counts its reads. */
const oidc = { reads: 0, token: "e30.e30.fictional_oidc_signature" };
const oidcToken = () => {
  oidc.reads++;
  return oidc.token;
};
const secret = "fictional-provider-secret-0001";
function streamOf(bytes: Buffer) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 65536)
        controller.enqueue(new Uint8Array(bytes.subarray(i, i + 65536)));
      controller.close();
    },
  });
}
function fictionalPdf(size: number) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251;
  bytes.write("%PDF-1.7\nfictional contract CV\n");
  return bytes;
}
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function reservation(sizeBytes: number) {
  return {
    teamId: "fictional-team",
    objectKey: `teams/fictional-team/cvs/${randomUUID()}.pdf`,
    originalName: "fictional-cv.pdf",
    mimeType: "application/pdf",
    sizeBytes,
    expiresAt: new Date(Date.now() + 300_000),
  };
}

type Harness = {
  gateway: BlobGateway;
  clientSigningToken: string;
  store(pathname: string, bytes: Buffer, uploadedAt?: Date): void;
  has(pathname: string): boolean;
  failWith(message: string): void;
};
const stubProvider = (): Omit<Harness, "gateway"> => ({
  clientSigningToken: "fictional-real-client-signing-key",
  store: (pathname, bytes, uploadedAt = new Date()) =>
    provider.objects.set(pathname, {
      bytes,
      contentType: "application/pdf",
      uploadedAt,
    }),
  has: (pathname) => provider.objects.has(pathname),
  failWith: (message) => (provider.failWith = message),
});
const harnesses: [string, () => Harness][] = [
  [
    "fake client",
    () => {
      const fake = fakeBlob();
      return {
        gateway: fake.gateway,
        clientSigningToken: signingSecret,
        store: (pathname, bytes, uploadedAt) =>
          fake.objects.set(pathname, {
            bytes,
            mimeType: "application/pdf",
            uploadedAt,
          }),
        has: (pathname) => fake.objects.has(pathname),
        failWith: () => {
          fake.state.failSigner = true;
          fake.state.failHead = true;
          fake.state.failDelete = true;
          fake.state.failList = true;
        },
      };
    },
  ],
  [
    "real @vercel/blob client with a stub provider",
    () => ({
      gateway: createBlobGateway(
        blobBinding,
        createVercelBlobClient({ storeId: "store_fictional", token }),
      ),
      ...stubProvider(),
    }),
  ],
  [
    "real @vercel/blob client in OIDC mode with a stub provider",
    () => ({
      gateway: createBlobGateway(
        blobBinding,
        createVercelBlobClient({ storeId: "store_fictional", oidcToken }),
      ),
      ...stubProvider(),
    }),
  ],
];

afterEach(() => {
  provider.objects.clear();
  provider.failWith = undefined;
  provider.override = undefined;
  oidc.reads = 0;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

for (const [name, harness] of harnesses)
  describe(`Blob gateway contract: ${name}`, () => {
    it("issues a no-overwrite PUT ticket that the strict ticket checks accept", async () => {
      const { gateway, clientSigningToken } = harness();
      const input = reservation(1000);
      const ticket = await gateway.issuePutTicket(input);
      const url = new URL(ticket.url);
      expect(url.origin).toBe("https://vercel.com");
      expect(url.pathname).toBe("/api/blob/");
      expect(url.searchParams.get("pathname")).toBe(input.objectKey);
      expect(url.searchParams.get("vercel-blob-allow-overwrite")).toBe("false");
      expect(url.searchParams.get("vercel-blob-add-random-suffix")).toBe(
        "false",
      );
      expect(url.searchParams.get("vercel-blob-maximum-size-in-bytes")).toBe(
        "1000",
      );
      expect(url.searchParams.get("vercel-blob-allowed-content-types")).toBe(
        "application/pdf",
      );
      expect(ticket.url).not.toContain(clientSigningToken);
      expect(decodeURIComponent(ticket.url)).not.toContain(clientSigningToken);
      expect(ticket.expiresAt).toBeGreaterThan(Date.now());
    });

    it("inspects a stored fictional PDF and returns its SHA-256", async () => {
      const { gateway, store } = harness();
      const input = reservation(1000);
      const bytes = fictionalPdf(1000);
      store(input.objectKey, bytes);
      expect(await gateway.inspectUpload(input)).toEqual({
        sha256: sha256(bytes),
      });
    });

    it("resolves a missing object to null", async () => {
      const { gateway } = harness();
      expect(await gateway.inspectUpload(reservation(1000))).toBeNull();
    });

    it("returns the first and last chunk of a 5 MiB fictional PDF", async () => {
      const { gateway, store } = harness();
      const bytes = fictionalPdf(5 * MiB);
      const input = reservation(bytes.length);
      store(input.objectKey, bytes);
      const reference = {
        teamId: input.teamId,
        objectKey: input.objectKey,
        mimeType: input.mimeType,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
      };
      const first = await gateway.readVerifiedSlice(reference, 0, 4 * MiB);
      expect(first?.equals(bytes.subarray(0, 4 * MiB))).toBe(true);
      const last = await gateway.readVerifiedSlice(reference, 4 * MiB, MiB);
      expect(last?.equals(bytes.subarray(4 * MiB))).toBe(true);
    });

    it("never passes provider error text on", async () => {
      const { gateway, failWith } = harness();
      failWith(`provider refused ${secret}`);
      const failures = await Promise.all(
        [
          gateway.issuePutTicket(reservation(1000)),
          gateway.inspectUpload(reservation(1000)),
          gateway.headObject("teams/fictional-team/cvs/a.pdf", 1000),
          gateway.deleteObject("teams/fictional-team/cvs/a.pdf", 1000),
          gateway.listObjects(
            { prefix: "teams/fictional-team/cvs/", cursor: null, limit: 10 },
            1000,
          ),
        ].map((call) => call.catch((error: unknown) => error)),
      );
      for (const failure of failures) {
        expect(failure).toBeInstanceOf(Error);
        expect(String((failure as Error).message)).not.toContain(secret);
        expect(String((failure as Error).message)).not.toContain(signingSecret);
        expect((failure as Error).cause).toBeUndefined();
      }
    });

    it("heads an object and reports a missing one as null", async () => {
      const { gateway, store } = harness();
      const input = reservation(1000);
      const uploadedAt = new Date("2030-01-01T09:00:00.000Z");
      store(input.objectKey, fictionalPdf(1000), uploadedAt);
      expect(await gateway.headObject(input.objectKey, 1000)).toEqual({
        sizeBytes: 1000,
        mimeType: "application/pdf",
        uploadedAt,
      });
      expect(await gateway.headObject(`${input.objectKey}.other`, 1000)).toBe(
        null,
      );
    });

    it("deletes an object and accepts a delete of a missing one", async () => {
      const { gateway, store, has } = harness();
      const input = reservation(1000);
      store(input.objectKey, fictionalPdf(1000));
      await gateway.deleteObject(input.objectKey, 1000);
      expect(has(input.objectKey)).toBe(false);
      expect(await gateway.headObject(input.objectKey, 1000)).toBeNull();
      await expect(
        gateway.deleteObject(input.objectKey, 1000),
      ).resolves.toBeUndefined();
    });

    it("lists only under the prefix, page by page, to the end", async () => {
      const { gateway, store } = harness();
      const uploadedAt = new Date("2030-01-01T09:00:00.000Z");
      const prefix = "teams/fictional-team/cvs/";
      const names = ["a", "b", "c"].map((name) => `${prefix}${name}.pdf`);
      for (const name of names) store(name, fictionalPdf(100), uploadedAt);
      store("teams/other-team/cvs/x.pdf", fictionalPdf(100), uploadedAt);
      const first = await gateway.listObjects(
        { prefix, cursor: null, limit: 2 },
        1000,
      );
      expect(first.objects).toEqual(
        names
          .slice(0, 2)
          .map((pathname) => ({ pathname, sizeBytes: 100, uploadedAt })),
      );
      expect(first.cursor).toEqual(expect.any(String));
      const last = await gateway.listObjects(
        { prefix, cursor: first.cursor, limit: 2 },
        1000,
      );
      expect(last).toEqual({
        objects: [{ pathname: names[2], sizeBytes: 100, uploadedAt }],
        cursor: null,
      });
    });
  });

describe("real @vercel/blob client in OIDC mode", () => {
  const gateway = () =>
    createBlobGateway(
      blobBinding,
      createVercelBlobClient({ storeId: blobBinding.store, oidcToken }),
    );

  it("sends the current OIDC token and the binding's store on every SDK call, and never a read-write token", async () => {
    const input = reservation(1000);
    const blob = gateway();
    await blob.issuePutTicket(input);
    provider.objects.set(input.objectKey, {
      bytes: fictionalPdf(1000),
      contentType: "application/pdf",
      uploadedAt: new Date(),
    });
    await blob.inspectUpload(input);
    await blob.listObjects(
      { prefix: "teams/fictional-team/cvs/", cursor: null, limit: 10 },
      1000,
    );
    await blob.deleteObject(input.objectKey, 1000);
    await blob.headObject(input.objectKey, 1000);
    const calls = [
      ...vi.mocked(issueSignedToken).mock.calls.map(([options]) => options),
      ...vi.mocked(get).mock.calls.map(([, options]) => options),
      ...vi.mocked(head).mock.calls.map(([, options]) => options),
      ...vi.mocked(del).mock.calls.map(([, options]) => options),
      ...vi.mocked(list).mock.calls.map(([options]) => options),
    ] as Record<string, unknown>[];
    // issueSignedToken, get, head twice (inspection and the last call), delete and list.
    expect(calls).toHaveLength(6);
    for (const options of calls) {
      expect(options).toMatchObject({
        oidcToken: oidc.token,
        storeId: blobBinding.store,
        abortSignal: expect.any(AbortSignal),
      });
      expect(options).not.toHaveProperty("token");
    }
    expect(oidc.reads).toBe(6);
  });

  it("refuses a read-write token in its environment, even an empty one, and the endpoint overrides", () => {
    for (const [name, value, reason] of [
      ["BLOB_READ_WRITE_TOKEN", token, "blob_token_present"],
      ["BLOB_READ_WRITE_TOKEN", "", "blob_token_present"],
      ["VERCEL_BLOB_API_URL", "https://example.invalid", "blob_client_invalid"],
      ["VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API", "", "blob_client_invalid"],
    ] as const) {
      vi.stubEnv(name, value);
      let failure: unknown;
      try {
        createVercelBlobClient({ storeId: "store_fictional", oidcToken });
      } catch (error) {
        failure = error;
      } finally {
        vi.unstubAllEnvs();
      }
      expect(failure, name).toBeInstanceOf(StorageConfigurationError);
      expect((failure as StorageConfigurationError).reason, name).toBe(reason);
      expect(String((failure as Error).message)).not.toContain(token);
    }
    for (const storeId of ["fictional", "store_a/b", ""])
      expect(() => createVercelBlobClient({ storeId, oidcToken })).toThrow(
        StorageConfigurationError,
      );
    expect(oidc.reads).toBe(0);
  });
});

describe("real @vercel/blob client only", () => {
  const gateway = () =>
    createBlobGateway(
      blobBinding,
      createVercelBlobClient({ storeId: "store_fictional", token }),
    );

  it("asks the SDK for a scoped PUT token with exactly the expected options and the explicit token", async () => {
    const input = reservation(1000);
    await gateway().issuePutTicket(input);
    expect(vi.mocked(issueSignedToken)).toHaveBeenCalledTimes(1);
    const [options] = vi.mocked(issueSignedToken).mock.calls[0];
    expect(Object.keys(options).sort()).toEqual(
      [
        "abortSignal",
        "allowedContentTypes",
        "maximumSizeInBytes",
        "operations",
        "pathname",
        "token",
        "validUntil",
      ].sort(),
    );
    expect(options).toEqual({
      pathname: input.objectKey,
      operations: ["put"],
      allowedContentTypes: ["application/pdf"],
      maximumSizeInBytes: 1000,
      validUntil: expect.any(Number),
      abortSignal: expect.any(AbortSignal),
      token,
    });
  });

  it("reads privately, uncached, with an abort signal and the explicit token", async () => {
    const input = reservation(1000);
    provider.objects.set(input.objectKey, {
      bytes: fictionalPdf(1000),
      contentType: "application/pdf",
      uploadedAt: new Date(),
    });
    await gateway().inspectUpload(input);
    expect(vi.mocked(get)).toHaveBeenCalledTimes(1);
    const [pathname, options] = vi.mocked(get).mock.calls[0];
    expect(pathname).toBe(input.objectKey);
    expect(Object.keys(options).sort()).toEqual(
      ["abortSignal", "access", "token", "useCache"].sort(),
    );
    expect(options).toEqual({
      access: "private",
      useCache: false,
      abortSignal: expect.any(AbortSignal),
      token,
    });
  });

  it("refuses a 304 result and a pathname mismatch, closing any stream it received", async () => {
    const input = reservation(1000);
    const bytes = fictionalPdf(1000);
    // Head finds the reserved object; only the read response is wrong.
    provider.objects.set(input.objectKey, {
      bytes,
      contentType: "application/pdf",
      uploadedAt: new Date(),
    });
    provider.override = (pathname) => ({
      statusCode: 304,
      stream: null,
      headers: new Headers(),
      blob: { pathname, size: null, contentType: null },
    });
    await expect(gateway().inspectUpload(input)).rejects.toThrow(
      "Private Blob object could not be opened.",
    );
    let cancelled = false;
    provider.override = () => ({
      statusCode: 200,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
        },
        cancel() {
          cancelled = true;
        },
      }),
      headers: new Headers(),
      blob: {
        pathname: `${input.objectKey}.other`,
        size: bytes.length,
        contentType: "application/pdf",
      },
    });
    await expect(gateway().inspectUpload(input)).rejects.toThrow(
      "Private Blob object could not be opened.",
    );
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("keeps provider read error text inside the gateway", async () => {
    provider.failWith = `read refused ${secret}`;
    const failure = await gateway()
      .inspectUpload(reservation(1000))
      .catch((error: unknown) => error);
    expect(String((failure as Error).message)).not.toContain(secret);
    expect((failure as Error).cause).toBeUndefined();
  });

  it("refuses a bad store id, a token for another store, a non-read-write token, an API endpoint override and the proxy flag", () => {
    const otherStoreToken = "vercel_blob_rw_other_1111111111111111";
    const clientToken = "vercel_blob_client_fictional_2222222222222222";
    const refusals: [string, () => unknown][] = [
      [
        "store id",
        () => createVercelBlobClient({ storeId: "fictional", token }),
      ],
      [
        "store id characters",
        () => createVercelBlobClient({ storeId: "store_a/b", token }),
      ],
      [
        "token",
        () => createVercelBlobClient({ storeId: "store_fictional", token: "" }),
      ],
      [
        "token for another store",
        () =>
          createVercelBlobClient({
            storeId: "store_fictional",
            token: otherStoreToken,
          }),
      ],
      [
        "store id of another token",
        () => createVercelBlobClient({ storeId: "store_other", token }),
      ],
      [
        "non-read-write token",
        () =>
          createVercelBlobClient({
            storeId: "store_fictional",
            token: clientToken,
          }),
      ],
      [
        "override",
        () => {
          vi.stubEnv("VERCEL_BLOB_API_URL", "https://example.invalid");
          return createVercelBlobClient({ storeId: "store_fictional", token });
        },
      ],
      ...(
        [
          ["VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API", "1"],
          ["VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API", ""],
          ["NEXT_PUBLIC_VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API", "1"],
        ] as const
      ).map(([name, value]): [string, () => unknown] => [
        `proxy flag ${name}=${JSON.stringify(value)}`,
        () => {
          vi.stubEnv(name, value);
          return createVercelBlobClient({ storeId: "store_fictional", token });
        },
      ]),
    ];
    for (const [label, create] of refusals) {
      let failure: unknown;
      try {
        create();
      } catch (error) {
        failure = error;
      } finally {
        // Each case refuses on its own setting, never on one left by an earlier case.
        vi.unstubAllEnvs();
      }
      expect(failure, label).toBeInstanceOf(StorageConfigurationError);
      for (const secret of [token, otherStoreToken, clientToken, "fictional"])
        expect(String((failure as Error).message), label).not.toContain(secret);
    }
    expect(vi.mocked(issueSignedToken)).not.toHaveBeenCalled();
    expect(vi.mocked(get)).not.toHaveBeenCalled();
  });
});
