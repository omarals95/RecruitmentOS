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
import { sql } from "drizzle-orm";

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
import {
  beginCvUpload,
  completeCvUpload,
  getCvChunk,
  getCvDownload,
  getCvManifest,
  listCandidateCvs,
  listCandidateCvsPage,
} from "@/lib/cvs";
import { createConfigDraft, publishConfigVersion } from "@/lib/config-store";
import { withTeam } from "@/lib/db-team";
import { assignMemberRole } from "@/lib/member-roles";
import {
  beginRecordFileUpload,
  completeRecordFileUpload,
  getRecordFileChunk,
  getRecordFileManifest,
} from "@/lib/record-files";
import { createRecord, updateRecord } from "@/lib/records";
import type { Principal } from "@/lib/principal";
import type { StorageBinding, StorageGateway } from "@/lib/storage";
import { downloadVerifiedCv } from "@/components/cv-transfer";
import { POST as reserveRoute } from "@/app/api/v1/candidates/[id]/cvs/uploads/route";
import { POST as completeRoute } from "@/app/api/v1/cvs/uploads/[id]/complete/route";
import { GET as listRoute } from "@/app/api/v1/candidates/[id]/cvs/route";
import { GET as downloadRoute } from "@/app/api/v1/cvs/[id]/download/route";
import { GET as manifestRoute } from "@/app/api/v1/cvs/[id]/manifest/route";
import { GET as chunkRoute } from "@/app/api/v1/cvs/[id]/chunks/route";
import { GET as fileManifestRoute } from "@/app/api/v1/record-files/[id]/manifest/route";
import { GET as fileChunkRoute } from "@/app/api/v1/record-files/[id]/chunks/route";
import { RECRUITER_ROLE } from "@/domain/config-defaults";
import type { RoleBody } from "@/domain/config";
import { docxWithText } from "./helpers/cv-fixtures";
import {
  customField,
  insertKindSchema,
  kindBody,
} from "./helpers/kind-schemas";
import { createTestDb, seedIdentity } from "./helpers/db";
import { stubLocalAuthReadiness } from "./helpers/readiness";
import {
  blobBinding,
  fakeBlob,
  signingSecret,
  type StoredObject,
} from "./helpers/fake-blob";

// Fictional data only: synthetic PDFs and the shared fake Blob client.
const s3Binding: StorageBinding = {
  provider: "s3",
  environment: "development",
  store: "fictional-s3",
};
const MiB = 1024 * 1024;
function fictionalPdf(size: number, seed = 7) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) % 251;
  bytes.write("%PDF-1.7\nfictional CV\n");
  return bytes;
}
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

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
  /** Further fictional teams, each with one candidate, for the store-wide read cap. */
  const teams: { principal: Principal; candidateId: string }[] = [];
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
    scopes: Principal["scopes"] = ["candidates:read", "cvs:read", "cvs:write"],
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
  async function readyBlobCv(
    fake: ReturnType<typeof fakeBlob>,
    bytes: Buffer,
    who: Principal = owner,
    candidate: string = candidateId,
  ) {
    const reserved = await beginCvUpload(
      who,
      candidate,
      metadata(bytes.length),
      fake.gateway,
    );
    fake.objects.set(await objectKey(reserved.data.id), {
      bytes,
      mimeType: "application/pdf",
    });
    const ready = await completeCvUpload(who, reserved.data.id, fake.gateway);
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
    stubLocalAuthReadiness();
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
    for (const n of [3, 4, 5]) {
      const principal = await seedIdentity(fixture.db, {
        userId: `blob-user-${n}`,
        teamId: `blob-team-${n}`,
      });
      const created = await createRecord(principal, "candidates", {
        data: { name: `Fictional Candidate ${n}` },
      });
      teams.push({ principal, candidateId: created.id });
    }
  });
  beforeEach(async () => {
    configured.current = undefined;
    await fixture.client.exec(
      "TRUNCATE app.activity; DELETE FROM app.uploads; DELETE FROM app.record_files; DELETE FROM app.idempotency; DELETE FROM app.storage_usage; DELETE FROM storage_ledger.blob_read_leases; DELETE FROM storage_ledger.blob_reconciliation_claims; DELETE FROM storage_ledger.stores; DELETE FROM auth.api_tokens; DELETE FROM auth.api_rate_limits;",
    );
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await fixture?.close();
  });

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

    it("reserves Blob uploads for 15 minutes and S3 uploads for 60, with tickets inside both", async () => {
      const fake = fakeBlob();
      const input = metadata(1000);
      const blob = await beginCvUpload(owner, candidateId, input, fake.gateway);
      const created = Date.parse(blob.data.createdAt);
      const blobExpiry = Date.parse(blob.data.expiresAt);
      expect(blobExpiry - created).toBe(15 * 60_000);
      const ticketExpiry = Date.parse(blob.upload!.expiresAt);
      expect(ticketExpiry).toBeLessThanOrEqual(Date.now() + 300_000);
      expect(ticketExpiry).toBeLessThanOrEqual(blobExpiry);
      // A replay never issues a ticket past the reservation's expiry.
      await rows(
        "UPDATE app.uploads SET expires_at=now()+interval '2 minutes' WHERE id=$1",
        [blob.data.id],
      );
      const replay = await beginCvUpload(
        owner,
        candidateId,
        input,
        fake.gateway,
      );
      expect(replay.data.id).toBe(blob.data.id);
      expect(Date.parse(replay.upload!.expiresAt)).toBeLessThanOrEqual(
        Date.parse(replay.data.expiresAt),
      );
      expect(Date.parse(replay.upload!.expiresAt)).toBeLessThan(
        Date.now() + 121_000,
      );
      const s3 = await beginCvUpload(
        owner,
        candidateId,
        metadata(200),
        fakeS3().gateway,
      );
      expect(
        Date.parse(s3.data.expiresAt) - Date.parse(s3.data.createdAt),
      ).toBe(60 * 60_000);
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

    it("issues at most five PUT tickets per Blob reservation, then refuses without a signer call", async () => {
      const fake = fakeBlob();
      const input = metadata(1000);
      const first = await beginCvUpload(
        owner,
        candidateId,
        input,
        fake.gateway,
      );
      for (let replay = 1; replay <= 4; replay++) {
        const again = await beginCvUpload(
          owner,
          candidateId,
          input,
          fake.gateway,
        );
        expect(again.data.id, `replay ${replay}`).toBe(first.data.id);
        expect(again.upload?.protocol).toBe("blob-put-v1");
      }
      expect(fake.state.signs).toBe(5);
      const tickets = async () =>
        (
          (await rows(
            "SELECT put_tickets_issued AS issued FROM app.uploads WHERE id=$1",
            [first.data.id],
          )) as { issued: number }[]
        )[0].issued;
      expect(await tickets()).toBe(5);
      const before = await counters();
      expect(before).toEqual(ledger(0, 1, 0));
      const refused = await beginCvUpload(
        owner,
        candidateId,
        input,
        fake.gateway,
      ).catch((error: unknown) => error);
      expect(refused).toMatchObject({
        status: 409,
        code: "CV_UPLOAD_TICKET_LIMIT",
      });
      expect((refused as Error).message).toMatch(/15 minutes/);
      expect(fake.state.signs).toBe(5);
      expect(await tickets()).toBe(5);
      expect(await counters()).toEqual(before);
      // A new reservation gets its own five.
      expect(
        (await beginCvUpload(owner, candidateId, metadata(1000), fake.gateway))
          .upload?.protocol,
      ).toBe("blob-put-v1");
    });

    it("leaves S3 reservations uncounted and lets the ticket count only grow by one on a pending Blob row", async () => {
      const s3 = fakeS3();
      configured.current = { binding: s3Binding, gateway: s3.gateway };
      const input = metadata(200);
      for (let call = 0; call < 7; call++)
        expect(
          (await beginCvUpload(owner, candidateId, input, s3.gateway)).upload
            ?.protocol,
        ).toBe("s3-form-v1");
      const [s3Row] = (await rows(
        "SELECT id, put_tickets_issued AS issued FROM app.uploads WHERE storage_provider='s3'",
      )) as { id: string; issued: number }[];
      expect(s3Row.issued).toBe(0);
      const fake = fakeBlob();
      const blob = await beginCvUpload(
        owner,
        candidateId,
        metadata(1000),
        fake.gateway,
      );
      const set = (id: string, value: number) =>
        withTeam(owner, (tx) =>
          tx.execute(
            sql`update app.uploads set put_tickets_issued=${value} where id=${id}::uuid`,
          ),
        );
      for (const [id, value] of [
        [blob.data.id, 3],
        [blob.data.id, 0],
        [s3Row.id, 1],
      ] as const)
        await expect(set(id, value), `${id} ${value}`).rejects.toMatchObject({
          cause: { code: "23514", message: "Upload reference is immutable" },
        });
      await set(blob.data.id, 2);
      await rows("UPDATE app.uploads SET status='rejected' WHERE id=$1", [
        blob.data.id,
      ]);
      await expect(set(blob.data.id, 3)).rejects.toMatchObject({
        cause: { code: "23514" },
      });
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

    // The provider let these through (multipart past the size limit, a wrong content type).
    const providerMismatches: [string, Partial<StoredObject>, number][] = [
      ["a head size over the reservation", { headSize: 1001 }, 0],
      ["a head size over 10 MiB", { headSize: 11 * MiB }, 0],
      ["a head content type", { headMimeType: "text/html" }, 0],
      [
        "a read content type",
        { mimeType: "image/png", headMimeType: "application/pdf" },
        1,
      ],
    ];
    for (const [label, stored, opens] of providerMismatches)
      it(`rejects ${label} that differs from the reservation and retains the charge`, async () => {
        const fake = fakeBlob();
        const { id, key } = await pendingBlob(fake);
        fake.objects.set(key, {
          bytes: fictionalPdf(1000),
          mimeType: "application/pdf",
          ...stored,
        });
        expect(await counters()).toEqual(ledger(0, 1, 0));
        await expect(
          completeCvUpload(owner, id, fake.gateway),
        ).rejects.toMatchObject({ status: 400, code: "INVALID_CV" });
        expect(await status(id)).toBe("rejected");
        expect(await counters()).toEqual(ledger(0, 0, 1));
        // The automatic sweep lists the prefix and deletes nothing inside the grace period.
        expect(fake.state.calls).toEqual([
          `head:${key}`,
          `list:teams/${owner.teamId}/cvs/`,
        ]);
        expect(fake.objects.has(key)).toBe(true);
        // A head mismatch never opens the object.
        expect(fake.state.reads).toBe(opens);
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
      const { id, key } = await pendingBlob(fake);
      fake.objects.set(key, {
        bytes: fictionalPdf(1000),
        mimeType: "application/pdf",
      });
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

    it("refuses every CV read to a cvs:read token without candidates:read before any storage call", async () => {
      const fake = fakeBlob();
      configured.current = { binding: blobBinding, gateway: fake.gateway };
      const id = await readyBlobCv(fake, fictionalPdf(1000));
      const { token } = await bearer(["cvs:read"]);
      const before = {
        reads: fake.state.reads,
        signs: fake.state.signs,
        calls: fake.state.calls.length,
      };
      for (const response of [
        await listRoute(
          request(`/api/v1/candidates/${candidateId}/cvs`, token),
          params(candidateId),
        ),
        await downloadRoute(
          request(`/api/v1/cvs/${id}/download`, token),
          params(id),
        ),
        await manifestRoute(
          request(`/api/v1/cvs/${id}/manifest`, token),
          params(id),
        ),
        await chunkRoute(
          request(`/api/v1/cvs/${id}/chunks?index=0`, token),
          params(id),
        ),
      ]) {
        expect(response.status).toBe(403);
        expect((await response.json()).error.code).toBe("scope_required");
      }
      const reader = { ...owner, scopes: ["cvs:read"] } as Principal;
      for (const read of [
        () => listCandidateCvs(reader, candidateId),
        () => listCandidateCvsPage(reader, candidateId),
        () => getCvDownload(reader, id, fake.gateway),
        () => getCvManifest(reader, id, fake.gateway),
        () => getCvChunk(reader, id, 0, fake.gateway),
      ])
        await expect(read()).rejects.toMatchObject({
          status: 403,
          code: "scope_required",
        });
      expect({
        reads: fake.state.reads,
        signs: fake.state.signs,
        calls: fake.state.calls.length,
      }).toEqual(before);
    });

    it("returns a manifest with no provider call, URL or pathname", async () => {
      const fake = fakeBlob();
      configured.current = { binding: blobBinding, gateway: fake.gateway };
      const { token } = await bearer(["candidates:read", "cvs:read"]);
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
      const { token } = await bearer(["candidates:read", "cvs:read"]);
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
      const { token } = await bearer(["candidates:read", "cvs:read"]);
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
      const { token } = await bearer(["candidates:read", "cvs:read"]);
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
      const first = await bearer(["candidates:read", "cvs:read"]);
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

      const second = await bearer(["candidates:read", "cvs:read"]);
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

  describe("bounded provider reads", () => {
    const small = fictionalPdf(1000);
    const unavailable = { status: 503, code: "STORAGE_UNAVAILABLE" };
    async function pendingWithObject(
      fake: ReturnType<typeof fakeBlob>,
      stored: Partial<StoredObject> = {},
    ) {
      const reserved = await beginCvUpload(
        owner,
        candidateId,
        metadata(small.length),
        fake.gateway,
      );
      const id = reserved.data.id;
      fake.objects.set(await objectKey(id), {
        bytes: small,
        mimeType: "application/pdf",
        ...stored,
      });
      return id;
    }

    it("refuses a third concurrent read for one team before opening it, while other teams still read", async () => {
      const fake = fakeBlob();
      const id = await readyBlobCv(fake, small);
      const otherId = await readyBlobCv(fake, small, other, otherCandidateId);
      const key = await objectKey(id);
      const release = fake.hold((pathname) => pathname === key);
      const reads = fake.state.reads;
      const inFlight = [0, 1].map(() => getCvChunk(owner, id, 0, fake.gateway));
      await vi.waitFor(() => expect(fake.state.reads).toBe(reads + 2));
      await expect(
        getCvChunk(owner, id, 0, fake.gateway),
      ).rejects.toMatchObject(unavailable);
      expect(fake.state.reads).toBe(reads + 2);
      const otherTeam = await getCvChunk(other, otherId, 0, fake.gateway);
      expect(otherTeam.bytes.equals(small)).toBe(true);
      release();
      for (const chunk of await Promise.all(inFlight))
        expect(chunk.bytes.equals(small)).toBe(true);
      const after = await getCvChunk(owner, id, 0, fake.gateway);
      expect(after.bytes.equals(small)).toBe(true);
    });

    it("refuses a read for a new team once eight reads hold the store", async () => {
      const fake = fakeBlob();
      const holders = [
        { principal: owner, candidateId },
        { principal: other, candidateId: otherCandidateId },
        ...teams.slice(0, 2),
      ];
      const ready: { principal: Principal; id: string }[] = [];
      for (const holder of holders)
        ready.push({
          principal: holder.principal,
          id: await readyBlobCv(
            fake,
            small,
            holder.principal,
            holder.candidateId,
          ),
        });
      const last = teams[2];
      const lastId = await readyBlobCv(
        fake,
        small,
        last.principal,
        last.candidateId,
      );
      const release = fake.hold();
      const reads = fake.state.reads;
      const inFlight = ready.flatMap(({ principal, id }) =>
        [0, 1].map(() => getCvChunk(principal, id, 0, fake.gateway)),
      );
      await vi.waitFor(() => expect(fake.state.reads).toBe(reads + 8));
      await expect(
        getCvChunk(last.principal, lastId, 0, fake.gateway),
      ).rejects.toMatchObject(unavailable);
      expect(fake.state.reads).toBe(reads + 8);
      release();
      expect(await Promise.all(inFlight)).toHaveLength(8);
      const after = await getCvChunk(last.principal, lastId, 0, fake.gateway);
      expect(after.bytes.equals(small)).toBe(true);
    });

    it("keeps a completion refused by the read cap pending", async () => {
      const fake = fakeBlob();
      const readyId = await readyBlobCv(fake, small);
      const pendingId = await pendingWithObject(fake);
      const readyKey = await objectKey(readyId);
      const release = fake.hold((pathname) => pathname === readyKey);
      const reads = fake.state.reads;
      const inFlight = [0, 1].map(() =>
        getCvChunk(owner, readyId, 0, fake.gateway),
      );
      await vi.waitFor(() => expect(fake.state.reads).toBe(reads + 2));
      await expect(
        completeCvUpload(owner, pendingId, fake.gateway),
      ).rejects.toMatchObject(unavailable);
      expect(fake.state.reads).toBe(reads + 2);
      expect(await status(pendingId)).toBe("pending");
      expect(await counters()).toEqual(ledger(1, 1, 0));
      release();
      await Promise.all(inFlight);
      expect(
        (await completeCvUpload(owner, pendingId, fake.gateway)).status,
      ).toBe("ready");
    });

    it("closes a stream that opens after the deadline and keeps the upload pending", async () => {
      const fake = fakeBlob();
      const id = await pendingWithObject(fake);
      fake.state.openDelayMs = 150;
      const started = Date.now();
      await expect(
        completeCvUpload(owner, id, fake.gateway, { readTimeoutMs: 50 }),
      ).rejects.toMatchObject(unavailable);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await status(id)).toBe("pending");
      await vi.waitFor(() =>
        expect(fake.state.streams).toEqual([
          { pathname: expect.any(String), closed: true },
        ]),
      );
      expect(fake.state.signals.at(-1)?.aborted).toBe(true);
    });

    it("closes the unread stream when a chunk read finds a different size", async () => {
      const fake = fakeBlob();
      const id = await readyBlobCv(fake, small);
      fake.objects.set(await objectKey(id), {
        bytes: small,
        mimeType: "application/pdf",
        reportedSize: small.length + 1,
      });
      const opened = fake.state.streams.length;
      await expect(
        getCvChunk(owner, id, 0, fake.gateway),
      ).rejects.toMatchObject({ status: 409, code: "CV_INTEGRITY_FAILED" });
      expect(fake.state.streams.slice(opened)).toEqual([
        { pathname: await objectKey(id), closed: true },
      ]);
    });

    it("closes the unread stream when the read finds a different MIME type than head", async () => {
      const fake = fakeBlob();
      const id = await pendingWithObject(fake, {
        mimeType: "image/png",
        headMimeType: "application/pdf",
      });
      await expect(
        completeCvUpload(owner, id, fake.gateway),
      ).rejects.toMatchObject({ status: 400, code: "INVALID_CV" });
      expect(await status(id)).toBe("rejected");
      expect(fake.state.streams).toEqual([
        { pathname: await objectKey(id), closed: true },
      ]);
    });

    describe("leases held by another server instance", () => {
      // Taken straight through the database helper in committed transactions, with no gateway
      // or in-process state, so they stand for reads running on another instance.
      async function takeLease(who: Principal) {
        const { rows: taken } = await withTeam(who, (tx) =>
          tx.execute<{ lease: string | null }>(
            sql`select tenant_context.acquire_blob_read(${blobBinding.store}) as lease`,
          ),
        );
        expect(taken[0].lease).toEqual(expect.any(String));
        return taken[0].lease!;
      }
      const dropLease = (who: Principal, lease: string) =>
        withTeam(who, (tx) =>
          tx.execute(sql`select tenant_context.release_blob_read(${lease})`),
        );
      const leaseCount = async () =>
        (
          (await rows(
            "SELECT count(*)::int AS count FROM storage_ledger.blob_read_leases",
          )) as { count: number }[]
        )[0].count;

      it("refuses a team holding two leases elsewhere until they are released, while another team reads", async () => {
        const fake = fakeBlob();
        const id = await readyBlobCv(fake, small);
        const otherId = await readyBlobCv(fake, small, other, otherCandidateId);
        const held = [await takeLease(owner), await takeLease(owner)];
        const reads = fake.state.reads;
        await expect(
          getCvChunk(owner, id, 0, fake.gateway),
        ).rejects.toMatchObject(unavailable);
        expect(fake.state.reads).toBe(reads);
        const otherTeam = await getCvChunk(other, otherId, 0, fake.gateway);
        expect(otherTeam.bytes.equals(small)).toBe(true);
        for (const lease of held) await dropLease(owner, lease);
        const after = await getCvChunk(owner, id, 0, fake.gateway);
        expect(after.bytes.equals(small)).toBe(true);
      });

      it("refuses a fifth team once four teams hold eight leases elsewhere", async () => {
        const fake = fakeBlob();
        const last = teams[2];
        const lastId = await readyBlobCv(
          fake,
          small,
          last.principal,
          last.candidateId,
        );
        const holders = [
          owner,
          other,
          ...teams.slice(0, 2).map((t) => t.principal),
        ];
        for (const holder of holders)
          for (let n = 0; n < 2; n++) await takeLease(holder);
        expect(await leaseCount()).toBe(8);
        const reads = fake.state.reads;
        await expect(
          getCvChunk(last.principal, lastId, 0, fake.gateway),
        ).rejects.toMatchObject(unavailable);
        expect(fake.state.reads).toBe(reads);
      });

      it("keeps a completion refused by leases held elsewhere pending", async () => {
        const fake = fakeBlob();
        const pendingId = await pendingWithObject(fake);
        await takeLease(owner);
        await takeLease(owner);
        const reads = fake.state.reads;
        await expect(
          completeCvUpload(owner, pendingId, fake.gateway),
        ).rejects.toMatchObject(unavailable);
        expect(fake.state.reads).toBe(reads);
        expect(await status(pendingId)).toBe("pending");
      });

      it("no longer counts a lease whose expiry has passed", async () => {
        const fake = fakeBlob();
        const id = await readyBlobCv(fake, small);
        const expired = await takeLease(owner);
        await takeLease(owner);
        await rows(
          "UPDATE storage_ledger.blob_read_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
          [expired],
        );
        const chunk = await getCvChunk(owner, id, 0, fake.gateway);
        expect(chunk.bytes.equals(small)).toBe(true);
      });

      it("ignores another team's attempt to release a lease", async () => {
        const fake = fakeBlob();
        const id = await readyBlobCv(fake, small);
        const held = [await takeLease(owner), await takeLease(owner)];
        for (const lease of held) await dropLease(other, lease);
        expect(
          await rows(
            "SELECT id FROM storage_ledger.blob_read_leases ORDER BY id",
          ),
        ).toEqual(held.sort().map((lease) => ({ id: lease })));
        const reads = fake.state.reads;
        await expect(
          getCvChunk(owner, id, 0, fake.gateway),
        ).rejects.toMatchObject(unavailable);
        expect(fake.state.reads).toBe(reads);
      });

      it("releases the lease after a successful read and after an integrity failure", async () => {
        const fake = fakeBlob();
        const id = await readyBlobCv(fake, small);
        expect(await leaseCount()).toBe(0);
        const chunk = await getCvChunk(owner, id, 0, fake.gateway);
        expect(chunk.bytes.equals(small)).toBe(true);
        expect(await leaseCount()).toBe(0);
        fake.objects.set(await objectKey(id), {
          bytes: fictionalPdf(small.length, 9),
          mimeType: "application/pdf",
        });
        await expect(
          getCvChunk(owner, id, 0, fake.gateway),
        ).rejects.toMatchObject({ status: 409, code: "CV_INTEGRITY_FAILED" });
        expect(await leaseCount()).toBe(0);
      });
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
      const { token } = await bearer(["candidates:read", "cvs:read"]);

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
  // File fields (R2b-06): a record file goes through the same tickets, checks, digest, ledger and
  // read leases as a Blob CV, and is served only while a visible custom value of its record holds it.
  describe("record files of file fields", () => {
    const field = customField("Fictional certificate", "file");
    let hidden: Principal, scoped: Principal;
    const fileInput = (
      sizeBytes: number,
      extra: Record<string, unknown> = {},
    ) => ({
      recordId: candidateId,
      originalName: "fictional-certificate.pdf",
      mimeType: "application/pdf",
      sizeBytes,
      clientUploadId: randomUUID(),
      ...extra,
    });
    const fileRow = async (id: string) =>
      (
        (await rows(
          "SELECT object_key, status, blob_sha256, blob_size_bytes::int, put_tickets_issued FROM app.record_files WHERE id=$1",
          [id],
        )) as {
          object_key: string;
          status: string;
          blob_sha256: string | null;
          blob_size_bytes: number | null;
          put_tickets_issued: number;
        }[]
      )[0];
    /** A ready record file of the candidate whose validated bytes sit in the fake store. */
    async function readyFile(
      fake: ReturnType<typeof fakeBlob>,
      bytes: Buffer,
      extra: Record<string, unknown> = {},
    ) {
      const input = fileInput(bytes.length, extra);
      const reserved = await beginRecordFileUpload(owner, input, fake.gateway);
      fake.objects.set((await fileRow(reserved.data.id)).object_key, {
        bytes,
        mimeType: input.mimeType,
      });
      const ready = await completeRecordFileUpload(
        owner,
        reserved.data.id,
        fake.gateway,
      );
      expect(ready.status).toBe("ready");
      return ready.id;
    }
    /** Stores the file's id as the candidate's file field value through a record update. */
    async function setValue(fileId: string) {
      const [{ version }] = (await rows(
        "SELECT version FROM app.records WHERE id=$1",
        [candidateId],
      )) as { version: number }[];
      await updateRecord(owner, "candidates", candidateId, {
        version,
        data: { customValues: { [field.key]: fileId } },
      });
    }
    async function role(key: string, body: RoleBody, member: Principal) {
      const { objectId, versionId } = await createConfigDraft(owner, {
        type: "role",
        key,
        body,
      });
      await publishConfigVersion(owner, versionId);
      await assignMemberRole(
        owner,
        { userId: member.userId, roleObjectId: objectId },
        new Headers(),
      );
    }

    beforeAll(async () => {
      await insertKindSchema(
        fixture.client,
        owner.userId,
        kindBody("candidate", [field]),
      );
      hidden = await seedIdentity(fixture.db, {
        userId: "blob-hidden-member",
        teamId: "blob-team",
        role: "recruiter",
      });
      scoped = await seedIdentity(fixture.db, {
        userId: "blob-scoped-member",
        teamId: "blob-team",
        role: "recruiter",
      });
      // Custom values readable, the file field itself hidden.
      await role(
        "blob-file-hidden",
        {
          ...structuredClone(RECRUITER_ROLE.body),
          name: "Fictional file-hidden recruiter",
          fields: {
            candidate: { customValues: "read", [field.key]: "hidden" },
          },
        } as RoleBody,
        hidden,
      );
      // A unit scope with no home unit: no candidate is in scope.
      await role(
        "blob-file-scoped",
        {
          ...structuredClone(RECRUITER_ROLE.body),
          name: "Fictional unit recruiter without a home",
          recordScope: { pipeline: "unit", candidates: "unit", tasks: "unit" },
        } as RoleBody,
        scoped,
      );
    });

    it("issues a blob-put-v1 ticket under the record's files path without signing material, at most five per reservation", async () => {
      const fake = fakeBlob();
      const input = fileInput(1000);
      const first = await beginRecordFileUpload(owner, input, fake.gateway);
      const upload = first.upload!;
      expect(upload).toMatchObject({
        protocol: "blob-put-v1",
        method: "PUT",
        headers: { "content-type": "application/pdf" },
        maxBytes: 1000,
      });
      const key = (await fileRow(first.data.id)).object_key;
      expect(key).toMatch(
        new RegExp(
          `^teams/${owner.teamId}/files/${candidateId}/${first.data.id}/[0-9a-f-]{36}\\.pdf$`,
        ),
      );
      expect(new URL(upload.url).searchParams.get("pathname")).toBe(key);
      expect(Object.keys(first.data).sort()).toEqual(
        [
          "completedAt",
          "createdAt",
          "downloadProtocol",
          "expiresAt",
          "id",
          "mimeType",
          "originalName",
          "recordId",
          "sizeBytes",
          "status",
        ].sort(),
      );
      expect(JSON.stringify(first.data)).not.toContain(key);
      expect(JSON.stringify(first)).not.toContain(signingSecret);
      expect(await counters()).toEqual(ledger(0, 1, 0));
      for (let replay = 1; replay <= 4; replay++) {
        const again = await beginRecordFileUpload(owner, input, fake.gateway);
        expect(again.data.id, `replay ${replay}`).toBe(first.data.id);
        expect(again.upload?.protocol).toBe("blob-put-v1");
      }
      expect(fake.state.signs).toBe(5);
      expect((await fileRow(first.data.id)).put_tickets_issued).toBe(5);
      await expect(
        beginRecordFileUpload(owner, input, fake.gateway),
      ).rejects.toMatchObject({
        status: 409,
        code: "FILE_UPLOAD_TICKET_LIMIT",
      });
      expect(fake.state.signs).toBe(5);
      expect(await counters()).toEqual(ledger(0, 1, 0));
      // The upload rate counts CV and record file reservations together; a replay is exempt.
      await rows(
        "UPDATE app.storage_usage SET upload_requests_per_minute=2 WHERE team_id=$1",
        [owner.teamId],
      );
      await beginCvUpload(owner, candidateId, metadata(1000), fake.gateway);
      await expect(
        beginRecordFileUpload(owner, fileInput(1000), fake.gateway),
      ).rejects.toMatchObject({ status: 429, code: "CV_UPLOAD_RATE_LIMITED" });
      await expect(
        beginCvUpload(owner, candidateId, metadata(1000), fake.gateway),
      ).rejects.toMatchObject({ status: 429, code: "CV_UPLOAD_RATE_LIMITED" });
    });

    it("refuses an S3 binding with 409 FILE_STORAGE_UNSUPPORTED before any row or provider call", async () => {
      const s3 = fakeS3();
      await expect(
        beginRecordFileUpload(owner, fileInput(s3.size), s3.gateway),
      ).rejects.toMatchObject({
        status: 409,
        code: "FILE_STORAGE_UNSUPPORTED",
      });
      expect(s3.calls).toEqual([]);
      expect(
        await rows("SELECT count(*)::int AS n FROM app.record_files"),
      ).toEqual([{ n: 0 }]);
      expect(await counters()).toEqual({ store: [], team: [] });
    });

    it("refuses a record the caller cannot see, an archived record and invalid file details before any signer call", async () => {
      const fake = fakeBlob();
      for (const [who, recordId] of [
        [owner, archivedCandidateId],
        [owner, randomUUID()],
        [other, candidateId],
        [scoped, candidateId],
      ] as const)
        await expect(
          beginRecordFileUpload(
            who,
            fileInput(1000, { recordId }),
            fake.gateway,
          ),
        ).rejects.toMatchObject({
          status: 404,
          code: "RECORD_NOT_FOUND",
          message: "This record is not available in the selected team.",
        });
      for (const extra of [
        { originalName: "fictional.exe" },
        { mimeType: "image/png" },
      ])
        await expect(
          beginRecordFileUpload(owner, fileInput(1000, extra), fake.gateway),
        ).rejects.toMatchObject({ status: 400, code: "INVALID_FILE" });
      expect(fake.state.signs).toBe(0);
      expect(
        await rows("SELECT count(*)::int AS n FROM app.record_files"),
      ).toEqual([{ n: 0 }]);
    });

    it("refuses a reservation over the team limit with 409 STORAGE_QUOTA_EXCEEDED and changes no counter", async () => {
      const fake = fakeBlob();
      await beginRecordFileUpload(owner, fileInput(1000), fake.gateway);
      await rows(
        "UPDATE app.storage_usage SET max_bytes=1000000, max_files=1 WHERE team_id=$1",
        [owner.teamId],
      );
      const signs = fake.state.signs;
      await expect(
        beginRecordFileUpload(owner, fileInput(1000), fake.gateway),
      ).rejects.toMatchObject({ status: 409, code: "STORAGE_QUOTA_EXCEEDED" });
      expect(fake.state.signs).toBe(signs);
      expect(await counters()).toEqual(ledger(0, 1, 0));
      expect(
        await rows("SELECT count(*)::int AS n FROM app.record_files"),
      ).toEqual([{ n: 1 }]);
    });

    it("completes PDF, DOCX, PNG and JPEG files with the server-computed digest and moves the charge to used", async () => {
      const fake = fakeBlob();
      const files: [string, string, Buffer][] = [
        ["fictional-certificate.pdf", "application/pdf", fictionalPdf(1000)],
        [
          "fictional-certificate.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          docxWithText(["Fictional certificate"]),
        ],
        [
          "fictional-photo.png",
          "image/png",
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]),
        ],
        [
          "fictional-photo.jpg",
          "image/jpeg",
          Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]),
        ],
      ];
      for (const [originalName, mimeType, bytes] of files) {
        const id = await readyFile(fake, bytes, { originalName, mimeType });
        expect(await fileRow(id), originalName).toMatchObject({
          status: "ready",
          blob_sha256: sha256(bytes),
          blob_size_bytes: bytes.length,
        });
      }
      expect(await counters()).toEqual(ledger(4, 0, 0));
      // No activity row: the record update storing the id is the audited change.
      expect(await rows("SELECT action FROM app.activity")).toEqual([]);
    });

    it("rejects a wrong magic byte, a mismatched size and an expired reservation with the charge retained", async () => {
      const fake = fakeBlob();
      const reserve = async () => {
        const reserved = await beginRecordFileUpload(
          owner,
          fileInput(1000),
          fake.gateway,
        );
        return {
          id: reserved.data.id,
          key: (await fileRow(reserved.data.id)).object_key,
        };
      };
      const wrongMagic = await reserve();
      fake.objects.set(wrongMagic.key, {
        bytes: Buffer.alloc(1000, "x"),
        mimeType: "application/pdf",
      });
      const wrongSize = await reserve();
      fake.objects.set(wrongSize.key, {
        bytes: fictionalPdf(1000),
        mimeType: "application/pdf",
        reportedSize: 1001,
      });
      const expired = await reserve();
      fake.objects.set(expired.key, {
        bytes: fictionalPdf(1000),
        mimeType: "application/pdf",
      });
      await rows(
        "UPDATE app.record_files SET expires_at=now()-interval '1 minute' WHERE id=$1",
        [expired.id],
      );
      expect(await counters()).toEqual(ledger(0, 3, 0));
      const reads = fake.state.reads;
      // The expired one first: the cleanup sweep after a settled upload expires it as well.
      for (const { id } of [expired, wrongMagic, wrongSize])
        await expect(
          completeRecordFileUpload(owner, id, fake.gateway),
        ).rejects.toMatchObject({ status: 400, code: "INVALID_FILE" });
      // The expired reservation is rejected without reading its object.
      expect(fake.state.reads).toBe(reads + 1);
      for (const { id } of [wrongMagic, wrongSize, expired])
        expect((await fileRow(id)).status).toBe("rejected");
      expect(await counters()).toEqual(ledger(0, 0, 3));
      await expect(
        completeRecordFileUpload(owner, expired.id, fake.gateway),
      ).rejects.toMatchObject({ status: 409, code: "FILE_UPLOAD_REJECTED" });
    });

    it("serves the manifest and chunks of a referenced file with the CV chunk headers, as an attachment", async () => {
      const fake = fakeBlob();
      configured.current = { binding: blobBinding, gateway: fake.gateway };
      const bytes = fictionalPdf(1000);
      const id = await readyFile(fake, bytes);
      await setValue(id);
      const { token } = await bearer(["candidates:read", "cvs:read"]);
      const reads = fake.state.reads;
      const manifest = await fileManifestRoute(
        request(`/api/v1/record-files/${id}/manifest`, token),
        params(id),
      );
      expect(manifest.status).toBe(200);
      const text = await manifest.text();
      expect(JSON.parse(text)).toEqual({
        data: {
          protocol: "blob-chunks-v1",
          uploadId: id,
          originalName: "fictional-certificate.pdf",
          contentType: "application/pdf",
          sizeBytes: 1000,
          sha256: sha256(bytes),
          chunkSize: 4194304,
          chunkCount: 1,
        },
      });
      expect(text).not.toContain((await fileRow(id)).object_key);
      expect(fake.state.reads).toBe(reads);
      const chunk = await fileChunkRoute(
        request(`/api/v1/record-files/${id}/chunks?index=0`, token),
        params(id),
      );
      expect(chunk.status).toBe(200);
      const body = Buffer.from(await chunk.arrayBuffer());
      expect(body.equals(bytes)).toBe(true);
      expect(Object.fromEntries(chunk.headers)).toMatchObject({
        "content-type": "application/octet-stream",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-length": "1000",
        "x-cv-upload-id": id,
        "x-cv-chunk-index": "0",
        "x-cv-chunk-offset": "0",
        "x-cv-size-bytes": "1000",
        "x-cv-sha256": sha256(bytes),
      });
      expect(chunk.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(chunk.headers.get("content-disposition")).not.toMatch(/inline/i);
      expect(fake.state.reads).toBe(reads + 1);
    });

    it("answers one identical 404 FILE_NOT_FOUND for an unreferenced file, a hidden field, a record out of scope and another team", async () => {
      const fake = fakeBlob();
      const unreferenced = await readyFile(fake, fictionalPdf(1000));
      const referenced = await readyFile(fake, fictionalPdf(1000, 3));
      await setValue(referenced);
      // The positive control: the owner reads the referenced file.
      await expect(
        getRecordFileManifest(owner, referenced, fake.gateway),
      ).resolves.toMatchObject({ uploadId: referenced });
      const reads = fake.state.reads;
      const refusals = [];
      for (const [who, id] of [
        [owner, unreferenced],
        [hidden, referenced],
        [scoped, referenced],
        [other, referenced],
        [owner, randomUUID()],
      ] as const)
        for (const read of [
          () => getRecordFileManifest(who, id, fake.gateway),
          () => getRecordFileChunk(who, id, 0, fake.gateway),
        ])
          refusals.push(
            await read().then(
              () => expect.fail(`${who.userId} read ${id}`),
              (error: { status: number; code: string; message: string }) => ({
                status: error.status,
                code: error.code,
                message: error.message,
              }),
            ),
          );
      expect(refusals).toEqual(
        Array(10).fill({
          status: 404,
          code: "FILE_NOT_FOUND",
          message: "This file is not available in the selected team.",
        }),
      );
      expect(fake.state.reads).toBe(reads);
    });
  });
});
