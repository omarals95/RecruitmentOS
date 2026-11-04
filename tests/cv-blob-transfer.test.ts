import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Route handlers get the fake gateway through the storage module; nothing else builds one.
const configured = vi.hoisted(() => ({
  current: undefined as undefined | { binding: unknown; gateway: unknown },
}));
vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...original,
    storageConfigured: () => true,
    resolveStorageBinding: () => {
      if (!configured.current)
        throw new original.StorageConfigurationError("No fake storage.");
      return configured.current.binding;
    },
    getStorage: async () => configured.current?.gateway,
  };
});

import { createToken, revokeToken } from "@/lib/api-tokens";
import { createBlobGateway, type BlobClient } from "@/lib/blob-storage";
import type { BlobTicketSigner } from "@/lib/blob-put-ticket";
import {
  beginCvUpload,
  completeCvUpload,
  getCvChunk,
  getCvDownload,
  getCvManifest,
} from "@/lib/cvs";
import { createRecord } from "@/lib/records";
import type { Principal } from "@/lib/principal";
import type { StorageBinding, StorageGateway } from "@/lib/storage";
import { downloadVerifiedCv } from "@/components/cv-transfer";
import { POST as reserveRoute } from "@/app/api/v1/candidates/[id]/cvs/uploads/route";
import { POST as completeRoute } from "@/app/api/v1/cvs/uploads/[id]/complete/route";
import { GET as downloadRoute } from "@/app/api/v1/cvs/[id]/download/route";
import { GET as manifestRoute } from "@/app/api/v1/cvs/[id]/manifest/route";
import { GET as chunkRoute } from "@/app/api/v1/cvs/[id]/chunks/route";
import { createTestDb, seedIdentity } from "./helpers/db";

// Fictional data only: synthetic PDFs, a synthetic signer and an in-memory object map.
const blobBinding: StorageBinding = {
  provider: "blob",
  environment: "development",
  store: "store_fictional",
};
const s3Binding: StorageBinding = {
  provider: "s3",
  environment: "development",
  store: "fictional-s3",
};
const signingSecret = "fictional-client-signing-secret";
const MiB = 1024 * 1024;
function fictionalPdf(size: number, seed = 7) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) % 251;
  bytes.write("%PDF-1.7\nfictional CV\n");
  return bytes;
}
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

type StoredObject = {
  bytes: Buffer;
  mimeType: string;
  reportedSize?: number;
  stall?: boolean;
};
function fakeBlob(binding: StorageBinding = blobBinding) {
  const objects = new Map<string, StoredObject>();
  const state = {
    signs: 0,
    reads: 0,
    signals: [] as AbortSignal[],
    failSigner: false,
    hangOpen: false,
  };
  const signer: BlobTicketSigner = {
    async issueSignedToken(options) {
      state.signs++;
      if (state.failSigner)
        throw new Error(`provider refused ${signingSecret}`);
      const scope = {
        storeId: binding.store.slice(6),
        pathname: options.pathname,
        operations: options.operations,
        validUntil: options.validUntil,
        maximumSizeInBytes: options.maximumSizeInBytes,
        allowedContentTypes: options.allowedContentTypes,
      };
      return {
        delegationToken: `${Buffer.from(JSON.stringify(scope)).toString("base64url")}.fictional_hmac`,
        clientSigningToken: signingSecret,
        validUntil: options.validUntil,
      };
    },
    async presignUrl(token, options) {
      const url = new URL("https://vercel.com/api/blob/");
      for (const [key, value] of Object.entries({
        pathname: options.pathname,
        "vercel-blob-delegation": token.delegationToken,
        "vercel-blob-signature": "fictional_signature_0001",
        "vercel-blob-allowed-content-types": options.allowedContentTypes[0],
        "vercel-blob-maximum-size-in-bytes": String(options.maximumSizeInBytes),
        "vercel-blob-add-random-suffix": "false",
        "vercel-blob-allow-overwrite": "false",
        "vercel-blob-valid-until": String(options.validUntil),
      }))
        url.searchParams.set(key, value);
      return { presignedUrl: url.toString() };
    },
  };
  const client: BlobClient = {
    signer,
    async open(pathname, { cache, signal }) {
      state.reads++;
      state.signals.push(signal);
      expect(cache).toBe("no-store");
      if (state.hangOpen) return new Promise(() => {});
      const object = objects.get(pathname);
      if (!object) return null;
      const bytes = object.bytes;
      return {
        sizeBytes: object.reportedSize ?? bytes.length,
        mimeType: object.mimeType,
        stream: (async function* () {
          if (object.stall) await new Promise(() => {});
          for (let i = 0; i < bytes.length; i += 65536)
            yield new Uint8Array(bytes.subarray(i, i + 65536));
        })(),
      };
    },
  };
  return { gateway: createBlobGateway(binding, client), objects, state };
}
function fakeS3(binding: StorageBinding = s3Binding) {
  const calls: string[] = [];
  const pdf = fictionalPdf(200);
  const gateway: StorageGateway = {
    binding,
    async assertVersioning() {
      calls.push("assertVersioning");
    },
    async presignPost(key) {
      calls.push("presignPost");
      return { url: "https://example.invalid/upload", fields: { key } };
    },
    async head() {
      calls.push("head");
      return {
        sizeBytes: pdf.length,
        mimeType: "application/pdf",
        version: "fictional-v1",
      };
    },
    async readRange() {
      calls.push("readRange");
      return pdf;
    },
    async signDownload() {
      calls.push("signDownload");
      return "https://example.invalid/download";
    },
  };
  return { gateway, calls, size: pdf.length };
}
function metadata(sizeBytes: number, extra: Record<string, unknown> = {}) {
  return {
    originalName: "fictional-cv.pdf",
    mimeType: "application/pdf",
    sizeBytes,
    clientUploadId: randomUUID(),
    ...extra,
  };
}

describe("private Blob CV transfer behind a fake client", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal;
  let other: Principal;
  let candidateId: string;
  let otherCandidateId: string;
  let archivedCandidateId: string;
  const rows = async (query: string, params: unknown[] = []) =>
    (await fixture.client.query(query, params)).rows;
  const objectKey = async (id: string) =>
    (
      (await rows("SELECT object_key FROM app.uploads WHERE id=$1", [id])) as {
        object_key: string;
      }[]
    )[0].object_key;
  const status = async (id: string) =>
    (
      (await rows("SELECT status FROM app.uploads WHERE id=$1", [id])) as {
        status: string;
      }[]
    )[0].status;
  const counters = async () => ({
    store: await rows(
      "SELECT used_files,reserved_files,retained_files FROM storage_ledger.stores WHERE provider='blob' AND store='store_fictional'",
    ),
    team: await rows(
      "SELECT used_files,reserved_files,retained_files FROM app.storage_usage WHERE team_id=$1",
      [owner.teamId],
    ),
  });
  const ledger = (used: number, reserved: number, retained: number) => {
    const row = {
      used_files: used,
      reserved_files: reserved,
      retained_files: retained,
    };
    return { store: [row], team: [row] };
  };
  async function bearer(
    scopes: Principal["scopes"] = ["cvs:read", "cvs:write"],
  ) {
    const created = await createToken(owner, {
      name: `Fictional Blob test ${randomUUID().slice(0, 8)}`,
      scopes,
    });
    return { token: created.token, id: created.data.id };
  }
  const request = (
    url: string,
    token: string,
    init: { method?: string; body?: unknown } = {},
  ) =>
    new Request(`http://localhost:3000${url}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  /** A ready Blob CV whose validated bytes sit in the fake store. */
  async function readyBlobCv(fake: ReturnType<typeof fakeBlob>, bytes: Buffer) {
    const reserved = await beginCvUpload(
      owner,
      candidateId,
      metadata(bytes.length),
      fake.gateway,
    );
    fake.objects.set(await objectKey(reserved.data.id), {
      bytes,
      mimeType: "application/pdf",
    });
    const ready = await completeCvUpload(owner, reserved.data.id, fake.gateway);
    expect(ready.status).toBe("ready");
    return ready.id;
  }
  /** A fetch that dispatches downloadVerifiedCv's requests to the real route handlers. */
  function routeFetch(
    token: string,
    afterChunk?: (index: number) => Promise<void>,
  ): typeof fetch {
    return async (input, init) => {
      const url = new URL(String(input), "http://localhost:3000");
      const match = /^\/api\/v1\/cvs\/([^/]+)\/(manifest|chunks)$/.exec(
        url.pathname,
      );
      if (!match) throw new Error("Unexpected request");
      const headers = new Headers(init?.headers);
      expect(init?.credentials).toBe("same-origin");
      headers.set("authorization", `Bearer ${token}`);
      const routed = new Request(url, { headers });
      if (match[2] === "manifest")
        return manifestRoute(routed, params(match[1]));
      const response = await chunkRoute(routed, params(match[1]));
      await afterChunk?.(Number(url.searchParams.get("index")));
      return response;
    };
  }

  beforeAll(async () => {
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db, {
      userId: "blob-owner",
      teamId: "blob-team",
    });
    other = await seedIdentity(fixture.db, {
      userId: "blob-other",
      teamId: "blob-other-team",
    });
    candidateId = (
      await createRecord(owner, "candidates", {
        data: { name: "Fictional Blob Candidate" },
      })
    ).id;
    archivedCandidateId = (
      await createRecord(owner, "candidates", {
        data: { name: "Fictional Archived Candidate" },
      })
    ).id;
    await rows("UPDATE app.records SET archived_at=now() WHERE id=$1", [
      archivedCandidateId,
    ]);
    otherCandidateId = (
      await createRecord(other, "candidates", {
        data: { name: "Fictional Other Candidate" },
      })
    ).id;
  });
  beforeEach(async () => {
    configured.current = undefined;
    await fixture.client.exec(
      "TRUNCATE app.activity; DELETE FROM app.uploads; DELETE FROM app.idempotency; DELETE FROM app.storage_usage; DELETE FROM storage_ledger.stores; DELETE FROM auth.api_tokens; DELETE FROM auth.api_rate_limits;",
    );
  });
  afterAll(async () => fixture?.close());

  describe("reservation", () => {
    it("returns a blob-put-v1 ticket built from the stored row without signing material", async () => {
      const fake = fakeBlob();
      const before = Date.now();
      const response = await beginCvUpload(
        owner,
        candidateId,
        metadata(1000),
        fake.gateway,
      );
      const upload = response.upload!;
      expect(upload).toMatchObject({
        protocol: "blob-put-v1",
        method: "PUT",
        headers: { "content-type": "application/pdf" },
        maxBytes: 1000,
      });
      expect(Object.keys(upload).sort()).toEqual(
        [
          "expiresAt",
          "headers",
          "maxBytes",
          "method",
          "protocol",
          "url",
        ].sort(),
      );
      if (upload.protocol !== "blob-put-v1") throw new Error("Wrong protocol");
      expect(Date.parse(upload.expiresAt)).toBeGreaterThan(before);
      expect(Date.parse(upload.expiresAt)).toBeLessThanOrEqual(
        Date.now() + 300_000,
      );
      const url = new URL(upload.url);
      expect(url.origin).toBe("https://vercel.com");
      expect(url.searchParams.get("pathname")).toBe(
        await objectKey(response.data.id),
      );
      expect(
        await rows(
          "SELECT storage_provider,storage_environment,storage_store,status FROM app.uploads WHERE id=$1",
          [response.data.id],
        ),
      ).toEqual([
        {
          storage_provider: "blob",
          storage_environment: "development",
          storage_store: "store_fictional",
          status: "pending",
        },
      ]);
      expect(JSON.stringify(response)).not.toContain(signingSecret);
      expect(response.data.downloadProtocol).toBeNull();
      expect(fake.state.signs).toBe(1);
      expect(fake.state.reads).toBe(0);
    });

    it("refuses invalid metadata, sources, candidates and permissions before any signer call", async () => {
      const fake = fakeBlob();
      configured.current = { binding: blobBinding, gateway: fake.gateway };
      const { token } = await bearer([
        "cvs:read",
        "cvs:write",
        "imports:write",
      ]);
      const withoutImport = await bearer(["cvs:read", "cvs:write"]);
      const cases: [string, string, unknown, number, string][] = [
        [
          "extension",
          candidateId,
          metadata(1000, { originalName: "fictional-cv.exe" }),
          400,
          "INVALID_CV",
        ],
        [
          "mime",
          candidateId,
          metadata(1000, { mimeType: "text/html" }),
          400,
          "INVALID_CV",
        ],
        ["oversize", candidateId, metadata(10 * MiB + 1), 400, "invalid_input"],
        [
          "traversal",
          candidateId,
          metadata(1000, { legacySourceId: "s-1", sourcePath: "a/../b.pdf" }),
          400,
          "invalid_input",
        ],
        [
          "control",
          candidateId,
          metadata(1000, {
            legacySourceId: "s-2",
            sourcePath: "a/b\u0007.pdf",
          }),
          400,
          "invalid_input",
        ],
        [
          "other team",
          otherCandidateId,
          metadata(1000),
          404,
          "CANDIDATE_NOT_FOUND",
        ],
        [
          "archived",
          archivedCandidateId,
          metadata(1000),
          404,
          "CANDIDATE_NOT_FOUND",
        ],
      ];
      for (const [label, candidate, body, code, error] of cases) {
        const response = await reserveRoute(
          request(`/api/v1/candidates/${candidate}/cvs/uploads`, token, {
            method: "POST",
            body,
          }),
          params(candidate),
        );
        expect(response.status, label).toBe(code);
        expect((await response.json()).error.code, label).toBe(error);
      }
      const denied = await reserveRoute(
        request(
          `/api/v1/candidates/${candidateId}/cvs/uploads`,
          withoutImport.token,
          {
            method: "POST",
            body: metadata(1000, { legacySourceId: "s-3" }),
          },
        ),
        params(candidateId),
      );
      expect(denied.status).toBe(403);
      expect((await denied.json()).error.code).toBe(
        "IMPORT_PERMISSION_REQUIRED",
      );
      expect(fake.state.signs).toBe(0);
      expect(await rows("SELECT id FROM app.uploads")).toEqual([]);
    });

    it("keeps the charge when issuance fails and reuses the path on replay", async () => {
      const fake = fakeBlob();
      fake.state.failSigner = true;
      const input = metadata(1000);
      const failed = await beginCvUpload(
        owner,
        candidateId,
        input,
        fake.gateway,
      ).catch((error: unknown) => error);
      expect(failed).toMatchObject({
        status: 503,
        code: "STORAGE_UNAVAILABLE",
      });
      expect(JSON.stringify(failed)).not.toContain(signingSecret);
      expect(String((failed as Error).message)).not.toContain(signingSecret);
      const [pending] = (await rows(
        "SELECT id,status,object_key FROM app.uploads",
      )) as { id: string; status: string; object_key: string }[];
      expect(pending.status).toBe("pending");
      expect(await counters()).toEqual(ledger(0, 1, 0));
      fake.state.failSigner = false;
      const replay = await beginCvUpload(
        owner,
        candidateId,
        input,
        fake.gateway,
      );
      expect(replay.data.id).toBe(pending.id);
      expect(new URL(replay.upload!.url).searchParams.get("pathname")).toBe(
        pending.object_key,
      );
      expect(await counters()).toEqual(ledger(0, 1, 0));
      expect(JSON.stringify(replay)).not.toContain(signingSecret);
    });
  });

  describe("completion", () => {
    async function pendingBlob(fake: ReturnType<typeof fakeBlob>, size = 1000) {
      const reserved = await beginCvUpload(
        owner,
        candidateId,
        metadata(size),
        fake.gateway,
      );
      return { id: reserved.data.id, key: await objectKey(reserved.data.id) };
    }

    it("records the server-computed digest and exact size once the object validates", async () => {
      const fake = fakeBlob(),
        bytes = fictionalPdf(1000);
      const { id, key } = await pendingBlob(fake);
      fake.objects.set(key, { bytes, mimeType: "application/pdf" });
      const ready = await completeCvUpload(owner, id, fake.gateway);
      expect(ready).toMatchObject({
        id,
        status: "ready",
        downloadProtocol: "blob-chunks-v1",
      });
      expect(JSON.stringify(ready)).not.toContain(key);
      expect(JSON.stringify(ready)).not.toContain(sha256(bytes));
      expect(
        await rows(
          "SELECT blob_sha256,blob_size_bytes::int,size_bytes::int,s3_version_id FROM app.uploads WHERE id=$1",
          [id],
        ),
      ).toEqual([
        {
          blob_sha256: sha256(bytes),
          blob_size_bytes: 1000,
          size_bytes: 1000,
          s3_version_id: null,
        },
      ]);
      expect(await counters()).toEqual(ledger(1, 0, 0));
    });

    const rejections: [string, (bytes: Buffer) => StoredObject][] = [
      [
        "truncated bytes",
        (bytes) => ({
          bytes: bytes.subarray(0, 900),
          mimeType: "application/pdf",
          reportedSize: 1000,
        }),
      ],
      [
        "a different reported size",
        (bytes) => ({
          bytes,
          mimeType: "application/pdf",
          reportedSize: 1001,
        }),
      ],
      ["a different MIME type", (bytes) => ({ bytes, mimeType: "image/png" })],
      [
        "an oversized stream",
        (bytes) => ({
          bytes: Buffer.concat([bytes, Buffer.from("extra")]),
          mimeType: "application/pdf",
          reportedSize: 1000,
        }),
      ],
      [
        "non-PDF bytes",
        () => ({ bytes: Buffer.alloc(1000, "x"), mimeType: "application/pdf" }),
      ],
    ];
    for (const [label, stored] of rejections)
      it(`rejects ${label} and retains the Blob charge`, async () => {
        const fake = fakeBlob();
        const { id, key } = await pendingBlob(fake);
        fake.objects.set(key, stored(fictionalPdf(1000)));
        await expect(
          completeCvUpload(owner, id, fake.gateway),
        ).rejects.toMatchObject({ status: 400, code: "INVALID_CV" });
        expect(await status(id)).toBe("rejected");
        expect(await counters()).toEqual(ledger(0, 0, 1));
        expect(
          await rows("SELECT action FROM app.activity WHERE record_id=$1", [
            candidateId,
          ]),
        ).toEqual([{ action: "cv.rejected" }]);
      });

    it("keeps a reservation pending when the object is missing", async () => {
      const fake = fakeBlob();
      const { id } = await pendingBlob(fake);
      await expect(
        completeCvUpload(owner, id, fake.gateway),
      ).rejects.toMatchObject({ status: 503, code: "STORAGE_UNAVAILABLE" });
      expect(await status(id)).toBe("pending");
      expect(await counters()).toEqual(ledger(0, 1, 0));
    });

    it("keeps a reservation pending when the read stalls past the deadline", async () => {
      const fake = fakeBlob();
      const { id, key } = await pendingBlob(fake);
      fake.objects.set(key, {
        bytes: fictionalPdf(1000),
        mimeType: "application/pdf",
        stall: true,
      });
      const started = Date.now();
      await expect(
        completeCvUpload(owner, id, fake.gateway, { readTimeoutMs: 50 }),
      ).rejects.toMatchObject({ status: 503, code: "STORAGE_UNAVAILABLE" });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(fake.state.signals.at(-1)?.aborted).toBe(true);
      expect(await status(id)).toBe("pending");
      expect(await counters()).toEqual(ledger(0, 1, 0));
    });

    it("keeps a reservation pending when opening the object never resolves", async () => {
      const fake = fakeBlob();
      const { id } = await pendingBlob(fake);
      fake.state.hangOpen = true;
      const started = Date.now();
      await expect(
        completeCvUpload(owner, id, fake.gateway, { readTimeoutMs: 50 }),
      ).rejects.toMatchObject({ status: 503, code: "STORAGE_UNAVAILABLE" });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(fake.state.signals.at(-1)?.aborted).toBe(true);
      expect(await status(id)).toBe("pending");
    });

    it("rejects an expired reservation without reading the object", async () => {
      const fake = fakeBlob();
      const { id, key } = await pendingBlob(fake);
      fake.objects.set(key, {
        bytes: fictionalPdf(1000),
        mimeType: "application/pdf",
      });
      await rows(
        "UPDATE app.uploads SET expires_at=now()-interval '1 minute' WHERE id=$1",
        [id],
      );
      await expect(
        completeCvUpload(owner, id, fake.gateway),
      ).rejects.toMatchObject({ status: 400, code: "INVALID_CV" });
      expect(fake.state.reads).toBe(0);
      expect(await status(id)).toBe("rejected");
      await expect(
        completeCvUpload(owner, id, fake.gateway),
      ).rejects.toMatchObject({ status: 409, code: "CV_UPLOAD_REJECTED" });
      expect(fake.state.reads).toBe(0);
    });

    it("settles simultaneous completions once and replays without a provider read", async () => {
      const fake = fakeBlob();
      const { id, key } = await pendingBlob(fake);
      fake.objects.set(key, {
        bytes: fictionalPdf(1000),
        mimeType: "application/pdf",
      });
      const [first, second] = await Promise.all([
        completeCvUpload(owner, id, fake.gateway),
        completeCvUpload(owner, id, fake.gateway),
      ]);
      expect(first).toEqual(second);
      expect(first.status).toBe("ready");
      expect(
        await rows(
          "SELECT action FROM app.activity WHERE action='cv.uploaded'",
        ),
      ).toHaveLength(1);
      expect(await counters()).toEqual(ledger(1, 0, 0));
      const reads = fake.state.reads;
      expect(await completeCvUpload(owner, id, fake.gateway)).toEqual(first);
      expect(fake.state.reads).toBe(reads);
    });

    it("ignores a client-supplied digest sent to the real completion route", async () => {
      const fake = fakeBlob(),
        bytes = fictionalPdf(1000);
      configured.current = { binding: blobBinding, gateway: fake.gateway };
      const { token } = await bearer();
      const { id, key } = await pendingBlob(fake);
      fake.objects.set(key, { bytes, mimeType: "application/pdf" });
      const forged = {
        sha256: "f".repeat(64),
        sizeBytes: 999,
        mimeType: "image/png",
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await completeRoute(
          request(`/api/v1/cvs/uploads/${id}/complete`, token, {
            method: "POST",
            body: forged,
          }),
          params(id),
        );
        expect(response.status).toBe(200);
        expect((await response.json()).data.status).toBe("ready");
      }
      expect(
        await rows(
          "SELECT blob_sha256,blob_size_bytes::int FROM app.uploads WHERE id=$1",
          [id],
        ),
      ).toEqual([{ blob_sha256: sha256(bytes), blob_size_bytes: 1000 }]);
    });
  });

  describe("download", () => {
    const large = fictionalPdf(5 * MiB, 11);

    it("returns a manifest with no provider call, URL or pathname", async () => {
      const fake = fakeBlob();
      configured.current = { binding: blobBinding, gateway: fake.gateway };
      const { token } = await bearer(["cvs:read"]);
      const small = fictionalPdf(1000);
      for (const [bytes, chunkCount] of [
        [large, 2],
        [small, 1],
      ] as const) {
        const id = await readyBlobCv(fake, bytes);
        const reads = fake.state.reads;
        const response = await manifestRoute(
          request(`/api/v1/cvs/${id}/manifest`, token),
          params(id),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const text = await response.text();
        expect(JSON.parse(text)).toEqual({
          data: {
            protocol: "blob-chunks-v1",
            uploadId: id,
            originalName: "fictional-cv.pdf",
            contentType: "application/pdf",
            sizeBytes: bytes.length,
            sha256: sha256(bytes),
            chunkSize: 4194304,
            chunkCount,
          },
        });
        expect(text).not.toContain("https://");
        expect(text).not.toContain(await objectKey(id));
        expect(fake.state.reads).toBe(reads);
      }
    });

    it("serves each chunk from one full verified read with trusted headers", async () => {
      const fake = fakeBlob();
      configured.current = { binding: blobBinding, gateway: fake.gateway };
      const { token } = await bearer(["cvs:read"]);
      const id = await readyBlobCv(fake, large);
      const parts: Buffer[] = [];
      for (const index of [0, 1]) {
        const reads = fake.state.reads;
        const response = await chunkRoute(
          request(`/api/v1/cvs/${id}/chunks?index=${index}`, token),
          params(id),
        );
        expect(response.status).toBe(200);
        expect(fake.state.reads).toBe(reads + 1);
        const body = Buffer.from(await response.arrayBuffer());
        const offset = index * 4194304;
        expect(Object.fromEntries(response.headers)).toMatchObject({
          "content-type": "application/octet-stream",
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-length": String(body.length),
          "x-cv-upload-id": id,
          "x-cv-chunk-index": String(index),
          "x-cv-chunk-offset": String(offset),
          "x-cv-size-bytes": String(large.length),
          "x-cv-sha256": sha256(large),
        });
        expect(response.headers.get("content-disposition")).toMatch(
          /^attachment;/,
        );
        expect(body.length).toBe(Math.min(4194304, large.length - offset));
        parts.push(body);
      }
      expect(Buffer.concat(parts).equals(large)).toBe(true);
      const verified = await downloadVerifiedCv(
        owner.teamId,
        id,
        routeFetch(token),
      );
      expect(Buffer.from(verified.bytes).equals(large)).toBe(true);
      expect(verified.originalName).toBe("fictional-cv.pdf");
    });

    it("refuses malformed or out-of-range chunk indexes before any provider read", async () => {
      const fake = fakeBlob();
      configured.current = { binding: blobBinding, gateway: fake.gateway };
      const { token } = await bearer(["cvs:read"]);
      const id = await readyBlobCv(fake, large);
      const reads = fake.state.reads;
      for (const query of [
        "",
        "?index=0&index=1",
        "?index=-1",
        "?index=01",
        "?index=1.0",
        "?index=2",
        "?index=0&extra=1",
        "?index=",
        "?index=1e0",
      ]) {
        const response = await chunkRoute(
          request(`/api/v1/cvs/${id}/chunks${query}`, token),
          params(id),
        );
        expect(response.status, query).toBe(400);
        expect(response.headers.get("content-type"), query).toMatch(
          /application\/json/,
        );
        expect((await response.json()).error.code, query).toBe(
          "INVALID_CV_CHUNK",
        );
      }
      expect(fake.state.reads).toBe(reads);
    });

    it("fails closed when the object is replaced or deleted between chunks", async () => {
      const fake = fakeBlob();
      configured.current = { binding: blobBinding, gateway: fake.gateway };
      const { token } = await bearer(["cvs:read"]);
      const id = await readyBlobCv(fake, large);
      const key = await objectKey(id);
      const chunk = (index: number) =>
        chunkRoute(
          request(`/api/v1/cvs/${id}/chunks?index=${index}`, token),
          params(id),
        );
      for (const change of [
        () =>
          fake.objects.set(key, {
            bytes: fictionalPdf(large.length, 99),
            mimeType: "application/pdf",
          }),
        () => fake.objects.delete(key),
      ]) {
        fake.objects.set(key, { bytes: large, mimeType: "application/pdf" });
        expect((await chunk(0)).status).toBe(200);
        change();
        const response = await chunk(1);
        expect(response.status).toBe(409);
        expect(response.headers.get("content-type")).toMatch(
          /application\/json/,
        );
        const text = await response.text();
        expect(JSON.parse(text).error.code).toBe("CV_INTEGRITY_FAILED");
        expect(text).not.toContain("%PDF");
      }
      fake.objects.set(key, { bytes: large, mimeType: "application/pdf" });
      let returned: unknown;
      await expect(
        downloadVerifiedCv(
          owner.teamId,
          id,
          routeFetch(token, async (index) => {
            if (index === 0)
              fake.objects.set(key, {
                bytes: fictionalPdf(large.length, 99),
                mimeType: "application/pdf",
              });
          }),
        ).then((value) => (returned = value)),
      ).rejects.toThrow();
      expect(returned).toBeUndefined();
    });

    it("stops a download when the token is revoked between chunks", async () => {
      const fake = fakeBlob();
      configured.current = { binding: blobBinding, gateway: fake.gateway };
      const id = await readyBlobCv(fake, large);
      const first = await bearer(["cvs:read"]);
      const chunk = (index: number) =>
        chunkRoute(
          request(`/api/v1/cvs/${id}/chunks?index=${index}`, first.token),
          params(id),
        );
      expect((await chunk(0)).status).toBe(200);
      await revokeToken(owner, first.id);
      const reads = fake.state.reads;
      const refused = await chunk(1);
      expect(refused.status).toBe(401);
      expect(fake.state.reads).toBe(reads);

      const second = await bearer(["cvs:read"]);
      let returned: unknown;
      await expect(
        downloadVerifiedCv(
          owner.teamId,
          id,
          routeFetch(second.token, async (index) => {
            if (index === 0) await revokeToken(owner, second.id);
          }),
        ).then((value) => (returned = value)),
      ).rejects.toThrow();
      expect(returned).toBeUndefined();
    });
  });

  describe("protocol and binding separation", () => {
    it("refuses the S3 download for Blob rows and Blob reads for S3 rows before any storage call", async () => {
      const blob = fakeBlob(),
        s3 = fakeS3();
      const blobId = await readyBlobCv(blob, fictionalPdf(1000));
      const s3Ready = await beginCvUpload(
        owner,
        candidateId,
        metadata(s3.size),
        s3.gateway,
      );
      await completeCvUpload(owner, s3Ready.data.id, s3.gateway);
      const blobReads = blob.state.reads,
        s3Calls = s3.calls.length;
      const { token } = await bearer(["cvs:read"]);

      configured.current = { binding: blobBinding, gateway: blob.gateway };
      const download = await downloadRoute(
        request(`/api/v1/cvs/${blobId}/download`, token),
        params(blobId),
      );
      expect(download.status).toBe(409);
      expect((await download.json()).error.code).toBe(
        "CV_DOWNLOAD_PROTOCOL_MISMATCH",
      );

      configured.current = { binding: s3Binding, gateway: s3.gateway };
      const s3Id = s3Ready.data.id;
      for (const response of [
        await manifestRoute(
          request(`/api/v1/cvs/${s3Id}/manifest`, token),
          params(s3Id),
        ),
        await chunkRoute(
          request(`/api/v1/cvs/${s3Id}/chunks?index=0`, token),
          params(s3Id),
        ),
      ]) {
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe(
          "CV_DOWNLOAD_PROTOCOL_MISMATCH",
        );
      }
      expect(blob.state.reads).toBe(blobReads);
      expect(blob.state.signs).toBe(1);
      expect(s3.calls).toHaveLength(s3Calls);
    });

    it("never operates on a reference through the other provider's gateway", async () => {
      const blob = fakeBlob(),
        s3 = fakeS3();
      const blobPendingInput = metadata(1000);
      const blobPending = await beginCvUpload(
        owner,
        candidateId,
        blobPendingInput,
        blob.gateway,
      );
      const blobReady = await readyBlobCv(blob, fictionalPdf(1000));
      const s3PendingInput = metadata(s3.size);
      const s3Pending = await beginCvUpload(
        owner,
        candidateId,
        s3PendingInput,
        s3.gateway,
      );
      const s3Ready = await beginCvUpload(
        owner,
        candidateId,
        metadata(s3.size),
        s3.gateway,
      );
      await completeCvUpload(owner, s3Ready.data.id, s3.gateway);

      const otherS3 = fakeS3(),
        otherBlob = fakeBlob();
      const mismatch = {
        status: 409,
        code: "CV_STORAGE_BINDING_MISMATCH",
      };
      await expect(
        completeCvUpload(owner, blobPending.data.id, otherS3.gateway),
      ).rejects.toMatchObject(mismatch);
      await expect(
        beginCvUpload(owner, candidateId, blobPendingInput, otherS3.gateway),
      ).rejects.toMatchObject(mismatch);
      await expect(
        getCvManifest(owner, blobReady, otherS3.gateway),
      ).rejects.toMatchObject(mismatch);
      await expect(
        getCvChunk(owner, blobReady, 0, otherS3.gateway),
      ).rejects.toMatchObject(mismatch);
      await expect(
        completeCvUpload(owner, s3Pending.data.id, otherBlob.gateway),
      ).rejects.toMatchObject(mismatch);
      await expect(
        beginCvUpload(owner, candidateId, s3PendingInput, otherBlob.gateway),
      ).rejects.toMatchObject(mismatch);
      await expect(
        getCvDownload(owner, s3Ready.data.id, otherBlob.gateway),
      ).rejects.toMatchObject(mismatch);
      expect(otherS3.calls).toEqual([]);
      expect(otherBlob.state).toMatchObject({ signs: 0, reads: 0 });
    });
  });
});
