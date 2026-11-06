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
import { createRecord } from "@/lib/records";
import type { Principal } from "@/lib/principal";
import { uploadCandidateCv } from "@/components/cv-upload";
import { POST as reserveRoute } from "@/app/api/v1/candidates/[id]/cvs/uploads/route";
import { POST as completeRoute } from "@/app/api/v1/cvs/uploads/[id]/complete/route";
import { createTestDb, enforceTestRls, seedIdentity } from "./helpers/db";
import { stubLocalAuthReadiness } from "./helpers/readiness";
import { blobBinding, fakeBlob } from "./helpers/fake-blob";

// Fictional people, synthetic PDF bytes and the shared fake Blob client only.
function fictionalPdf(size: number, seed = 11) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) % 251;
  bytes.write("%PDF-1.7\nfictional single Blob CV\n");
  return bytes;
}
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const pdf = fictionalPdf(300_000);

describe("single CV upload over the private Blob protocol", () => {
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

  beforeAll(async () => {
    stubLocalAuthReadiness();
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db, {
      userId: "single-blob-owner",
      teamId: "single-blob-team",
    });
    await enforceTestRls(fixture.db);
    configured.current = { binding: blobBinding, gateway: fake.gateway };
    bearer = (
      await createToken(owner, {
        name: "Fictional single Blob",
        scopes: ["candidates:read", "cvs:read", "cvs:write"],
      })
    ).token;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await fixture?.close();
  });

  it("completes the retry after a lost PUT response, though Blob refuses the replayed PUT", async () => {
    const candidate = await createRecord(owner, "candidates", {
      data: { name: "Fictional Single Retry" },
    });
    const file = new File([pdf], "fictional-cv.pdf", {
      type: "application/pdf",
    });
    const clientUploadId = randomUUID();
    const reserved: { id: string; pathname: string | null }[] = [];
    const storageStatuses: number[] = [];
    let attempt = 0;
    /** Sends the API paths to the real route handlers and plays storage for each attempt. */
    const routeFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input), "http://localhost:3000");
      if (url.origin !== "http://localhost:3000") {
        const pathname = url.searchParams.get("pathname")!;
        if (attempt === 1) {
          // Storage keeps the bytes, then the response is lost.
          fake.objects.set(pathname, {
            bytes: Buffer.from(await (init?.body as Blob).arrayBuffer()),
            mimeType: "application/pdf",
          });
          throw new TypeError("fetch failed");
        }
        // Blob never overwrites: the replayed PUT to the same pathname is refused.
        const status = fake.objects.has(pathname) ? 409 : 200;
        storageStatuses.push(status);
        return new Response(null, { status });
      }
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${bearer}`);
      const routed = new Request(url, {
        method: init?.method,
        headers,
        body: init?.body,
      });
      const reserve = /^\/api\/v1\/candidates\/([^/]+)\/cvs\/uploads$/.exec(
        url.pathname,
      );
      if (reserve) {
        const response = await reserveRoute(routed, {
          params: Promise.resolve({ id: reserve[1] }),
        });
        const body = await response.clone().json();
        reserved.push({
          id: body.data.id,
          pathname: new URL(body.upload.url).searchParams.get("pathname"),
        });
        return response;
      }
      const complete = /^\/api\/v1\/cvs\/uploads\/([^/]+)\/complete$/.exec(
        url.pathname,
      );
      if (!complete) throw new Error("Unexpected request");
      return completeRoute(routed, {
        params: Promise.resolve({ id: complete[1] }),
      });
    };
    const send = () =>
      uploadCandidateCv({
        teamId: owner.teamId,
        candidateId: candidate.id,
        file,
        clientUploadId,
        onPhase: () => {},
        fetchImpl: routeFetch,
      });
    const row = async (id: string) =>
      (
        await asOwner<{ status: string; blob_sha256: string | null }>(
          "SELECT status, blob_sha256 FROM app.uploads WHERE id=$1",
          [id],
        )
      )[0];

    attempt = 1;
    await expect(send()).rejects.toThrow(
      "Private storage could not be reached. Check your connection and try again.",
    );
    expect(reserved).toHaveLength(1);
    expect(fake.objects.get(reserved[0].pathname!)?.bytes.equals(pdf)).toBe(
      true,
    );
    expect((await row(reserved[0].id)).status).toBe("pending");

    attempt = 2;
    await expect(send()).resolves.toBeUndefined();
    expect(reserved).toHaveLength(2);
    expect(reserved[1]).toEqual(reserved[0]);
    expect(storageStatuses).toEqual([409]);
    expect(await row(reserved[0].id)).toEqual({
      status: "ready",
      blob_sha256: sha256(pdf),
    });
    expect(
      await asOwner("SELECT id FROM app.uploads WHERE candidate_id=$1", [
        candidate.id,
      ]),
    ).toHaveLength(1);
  });
});
