import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Route handlers get the fake Blob gateway through the storage module; nothing else builds one.
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

import { createToken } from "@/lib/api-tokens";
import type { Principal } from "@/lib/principal";
import { downloadVerifiedCv } from "@/components/cv-transfer";
import { GET as listRoute } from "@/app/api/v1/cvs/bulk-batches/route";
import { POST as itemRoute } from "@/app/api/v1/cvs/bulk-batches/[batchId]/items/[itemId]/route";
import { POST as uploadRoute } from "@/app/api/v1/cvs/bulk-batches/[batchId]/items/[itemId]/upload/route";
import { POST as completeRoute } from "@/app/api/v1/cvs/uploads/[id]/complete/route";
import { GET as downloadRoute } from "@/app/api/v1/cvs/[id]/download/route";
import { GET as manifestRoute } from "@/app/api/v1/cvs/[id]/manifest/route";
import { GET as chunkRoute } from "@/app/api/v1/cvs/[id]/chunks/route";
import { createTestDb, enforceTestRls, seedIdentity } from "./helpers/db";
import { stubLocalAuthReadiness } from "./helpers/readiness";
import { blobBinding, fakeBlob, signingSecret } from "./helpers/fake-blob";

// Fictional people, synthetic PDF bytes and the shared fake Blob client only.
function fictionalPdf(size: number, seed = 7) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) % 251;
  bytes.write("%PDF-1.7\nfictional bulk Blob CV\n");
  return bytes;
}
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const pdf = fictionalPdf(300_000);
const file = {
  originalName: "fictional-cv.pdf",
  mimeType: "application/pdf",
  sizeBytes: pdf.length,
};

describe("bulk CV intake over the private Blob protocol", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal;
  let bearer: string;
  const fake = fakeBlob();

  /** Raw SQL through the PGlite owner, outside the runtime role and its policies. */
  async function asOwner<T = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    await fixture.client.exec("RESET ROLE");
    try {
      return (await fixture.client.query<T>(query, params)).rows;
    } finally {
      await fixture.client.exec("SET ROLE recruitment_test_runtime");
    }
  }
  const upload = async (id: string) =>
    (
      await asOwner<{
        status: string;
        object_key: string;
        blob_sha256: string | null;
      }>(
        "SELECT status, object_key, blob_sha256 FROM app.uploads WHERE id=$1",
        [id],
      )
    )[0];
  const ledger = async () => ({
    store: await asOwner(
      "SELECT used_files,reserved_files,retained_files FROM storage_ledger.stores WHERE provider='blob' AND store=$1",
      [blobBinding.store],
    ),
    team: await asOwner(
      "SELECT used_files,reserved_files,retained_files FROM app.storage_usage WHERE team_id=$1",
      [owner.teamId],
    ),
  });
  const counted = (used: number, reserved: number, retained: number) => {
    const row = {
      used_files: used,
      reserved_files: reserved,
      retained_files: retained,
    };
    return { store: [row], team: [row] };
  };
  const call = (url: string, method = "GET", json?: unknown) =>
    new Request(`http://localhost:3000${url}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(json === undefined ? {} : { "content-type": "application/json" }),
      },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  const result = async (response: Response) => ({
    status: response.status,
    body: await response.json(),
  });
  const createItem = (batchId: string, itemId: string, name: string) =>
    itemRoute(
      call(`/api/v1/cvs/bulk-batches/${batchId}/items/${itemId}`, "POST", {
        file,
        data: { name },
        factsReviewed: true,
        duplicatesReviewed: true,
        acknowledgedDuplicateIds: [],
      }),
      { params: Promise.resolve({ batchId, itemId }) },
    ).then(result);
  const reserve = (batchId: string, itemId: string) =>
    uploadRoute(
      call(
        `/api/v1/cvs/bulk-batches/${batchId}/items/${itemId}/upload`,
        "POST",
      ),
      { params: Promise.resolve({ batchId, itemId }) },
    ).then(result);
  const complete = (id: string) =>
    completeRoute(call(`/api/v1/cvs/uploads/${id}/complete`, "POST"), {
      params: Promise.resolve({ id }),
    }).then(result);
  const outcome = async (batchId: string, itemId: string) => {
    const listed = await result(
      await listRoute(call("/api/v1/cvs/bulk-batches?pageSize=20")),
    );
    return listed.body.data
      .find((entry: { id: string }) => entry.id === batchId)
      .items.find((entry: { id: string }) => entry.id === itemId).outcome;
  };
  const pathname = (ticket: { url: string }) =>
    new URL(ticket.url).searchParams.get("pathname");
  /** A fetch that dispatches downloadVerifiedCv's requests to the real route handlers. */
  const routeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost:3000");
    const match = /^\/api\/v1\/cvs\/([^/]+)\/(manifest|chunks)$/.exec(
      url.pathname,
    );
    if (!match) throw new Error("Unexpected request");
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${bearer}`);
    const routed = new Request(url, { headers });
    const params = { params: Promise.resolve({ id: match[1] }) };
    return match[2] === "manifest"
      ? manifestRoute(routed, params)
      : chunkRoute(routed, params);
  };

  beforeAll(async () => {
    stubLocalAuthReadiness();
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db, {
      userId: "bulk-blob-owner",
      teamId: "bulk-blob-team",
    });
    await enforceTestRls(fixture.db);
    configured.current = { binding: blobBinding, gateway: fake.gateway };
    bearer = (
      await createToken(owner, {
        name: "Fictional bulk Blob",
        scopes: [
          "candidates:read",
          "candidates:write",
          "cvs:read",
          "cvs:write",
        ],
      })
    ).token;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await fixture?.close();
  });

  it("(a-e) reserves a blob-put-v1 ticket, completes after the PUT and serves verified chunks", async () => {
    const batchId = randomUUID(),
      itemId = randomUUID();
    expect(
      (await createItem(batchId, itemId, "Fictional Blob Import")).status,
    ).toBe(201);
    const reserved = await reserve(batchId, itemId);
    expect(reserved.status).toBe(201);
    expect(reserved.body.upload).toMatchObject({
      protocol: "blob-put-v1",
      method: "PUT",
      headers: { "content-type": "application/pdf" },
      maxBytes: pdf.length,
    });
    const id = reserved.body.data.id;
    const objectKey = (await upload(id)).object_key;
    expect(pathname(reserved.body.upload)).toBe(objectKey);
    expect(JSON.stringify(reserved.body)).not.toContain(signingSecret);

    const replay = await reserve(batchId, itemId);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(id);
    expect(pathname(replay.body.upload)).toBe(objectKey);
    expect(await ledger()).toEqual(counted(0, 1, 0));

    const early = await complete(id);
    expect(early.status).toBe(503);
    expect(early.body.error.code).toBe("STORAGE_UNAVAILABLE");
    expect((await upload(id)).status).toBe("pending");
    expect(await outcome(batchId, itemId)).toBe("cv-pending");

    fake.objects.set(objectKey, { bytes: pdf, mimeType: "application/pdf" });
    const done = await complete(id);
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe("ready");
    expect((await upload(id)).blob_sha256).toBe(sha256(pdf));
    expect(await outcome(batchId, itemId)).toBe("imported");
    expect(await ledger()).toEqual(counted(1, 0, 0));

    const verified = await downloadVerifiedCv(owner.teamId, id, routeFetch);
    expect(Buffer.from(verified.bytes).equals(pdf)).toBe(true);
    const download = await result(
      await downloadRoute(call(`/api/v1/cvs/${id}/download`), {
        params: Promise.resolve({ id }),
      }),
    );
    expect(download.status).toBe(409);
    expect(download.body.error.code).toBe("CV_DOWNLOAD_PROTOCOL_MISMATCH");
  });

  it("(4a) re-uploads after Blob rejects the bytes, under a new path and a retained charge", async () => {
    const batchId = randomUUID(),
      itemId = randomUUID();
    expect(
      (await createItem(batchId, itemId, "Fictional Blob Retry")).status,
    ).toBe(201);
    const before = await ledger();
    const first = await reserve(batchId, itemId);
    const firstId = first.body.data.id;
    const firstPath = pathname(first.body.upload);
    // Same size and type as the reviewed file, but not a PDF.
    fake.objects.set(firstPath!, {
      bytes: Buffer.alloc(pdf.length, 0x41),
      mimeType: "application/pdf",
    });
    const rejected = await complete(firstId);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe("INVALID_CV");
    expect((await upload(firstId)).status).toBe("rejected");
    expect(await outcome(batchId, itemId)).toBe("cv-rejected");

    const second = await reserve(batchId, itemId);
    expect(second.status).toBe(201);
    expect(second.body.upload.protocol).toBe("blob-put-v1");
    const secondId = second.body.data.id;
    const secondPath = pathname(second.body.upload);
    expect(secondId).not.toBe(firstId);
    expect(secondPath).not.toBe(firstPath);
    expect(secondPath).toBe((await upload(secondId)).object_key);
    const repeat = await reserve(batchId, itemId);
    expect(repeat.body.data.id).toBe(secondId);
    expect(pathname(repeat.body.upload)).toBe(secondPath);
    // The rejected attempt keeps its retained charge; the new one is reserved.
    const used = before.store[0]?.used_files as number;
    expect(await ledger()).toEqual(counted(used, 1, 1));

    fake.objects.set(secondPath!, { bytes: pdf, mimeType: "application/pdf" });
    const done = await complete(secondId);
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe("ready");
    expect(await outcome(batchId, itemId)).toBe("imported");
    expect(await ledger()).toEqual(counted(used + 1, 0, 1));
    const [row] = await asOwner<{ upload_id: string }>(
      "SELECT upload_id FROM app.bulk_intake_items WHERE id=$1",
      [itemId],
    );
    expect(row.upload_id).toBe(secondId);
  });
});
