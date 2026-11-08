import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));
// The route gets the fake Blob gateway through the storage module; nothing else builds one.
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

import { getVerifiedSession } from "@/lib/auth-session";
import { createToken } from "@/lib/api-tokens";
import { reconcileBlobStorage } from "@/lib/blob-reconcile";
import { beginCvUpload, completeCvUpload } from "@/lib/cvs";
import { createRecord } from "@/lib/records";
import type { Principal } from "@/lib/principal";
import { POST as reconcileRoute } from "@/app/api/v1/cvs/storage-reconciliation/route";
import { createTestDb, enforceTestRls, seedIdentity } from "./helpers/db";
import { stubLocalAuthReadiness } from "./helpers/readiness";
import { blobBinding, fakeBlob } from "./helpers/fake-blob";

// Fictional teams, people and synthetic PDF bytes only; the fake Blob client stores nothing remote.
const ORIGIN = "http://localhost:3000";
const MINUTE = 60_000;
function fictionalPdf(size: number) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251;
  bytes.write("%PDF-1.7\nfictional cleanup CV\n");
  return bytes;
}
const pdf = fictionalPdf(1000);
const metadata = () => ({
  originalName: "fictional-cv.pdf",
  mimeType: "application/pdf",
  sizeBytes: pdf.length,
  clientUploadId: randomUUID(),
});
const fullSweep = {
  maxRows: 50,
  maxDeletes: 100,
  maxPages: 3,
  budgetMs: 20_000,
};
type Fake = ReturnType<typeof fakeBlob>;

describe("Blob storage cleanup after ticket expiry", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal, recruiter: Principal, other: Principal;
  let candidateId: string, otherCandidateId: string;
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
  const retained = async (teamId = owner.teamId) => ({
    store: await asOwner(
      "SELECT retained_bytes::int AS bytes, retained_files AS files FROM storage_ledger.stores WHERE provider='blob' AND store=$1",
      [blobBinding.store],
    ),
    team: await asOwner(
      "SELECT retained_bytes::int AS bytes, retained_files AS files FROM app.storage_usage WHERE team_id=$1",
      [teamId],
    ),
  });
  const held = (files: number) => ({
    store: [{ bytes: files * pdf.length, files }],
    team: [{ bytes: files * pdf.length, files }],
  });
  const deletedAt = async (id: string) =>
    (
      await asOwner<{ blob_deleted_at: Date | null }>(
        "SELECT blob_deleted_at FROM app.uploads WHERE id=$1",
        [id],
      )
    )[0].blob_deleted_at;
  /** A pending Blob reservation; its object is stored unless told otherwise. */
  async function pending(
    fake: Fake,
    who: Principal = owner,
    candidate: string = candidateId,
    stored = true,
  ) {
    const reserved = await beginCvUpload(
      who,
      candidate,
      metadata(),
      fake.gateway,
    );
    const [{ object_key: key }] = await asOwner<{ object_key: string }>(
      "SELECT object_key FROM app.uploads WHERE id=$1",
      [reserved.data.id],
    );
    if (stored)
      fake.objects.set(key, { bytes: pdf, mimeType: "application/pdf" });
    return { id: reserved.data.id, key };
  }
  /** A rejected Blob upload whose reservation expired the given minutes ago; its charge is retained. */
  async function rejected(fake: Fake, minutesAgo: number) {
    const upload = await pending(fake);
    await asOwner(
      "UPDATE app.uploads SET status='rejected', expires_at=now()-make_interval(mins=>$2) WHERE id=$1",
      [upload.id, minutesAgo],
    );
    return upload;
  }
  /** Holds the team's cleanup cooldown, so fixture completions start no automatic sweep. */
  const holdCooldown = (teamId = owner.teamId) =>
    asOwner(
      `INSERT INTO storage_ledger.blob_reconciliation_claims(store,team_id,claimed_at) VALUES($1,$2,now())
       ON CONFLICT (store,team_id) DO UPDATE SET claimed_at=now()`,
      [blobBinding.store, teamId],
    );
  /** Moves the team's last claim back past the 10-minute cooldown. */
  const ageCooldown = (teamId = owner.teamId) =>
    asOwner(
      "UPDATE storage_ledger.blob_reconciliation_claims SET claimed_at=now()-interval '11 minutes' WHERE team_id=$1",
      [teamId],
    );
  const sweeps = (fake: Fake) =>
    fake.state.calls.filter((call) => call.startsWith("list:")).length;
  async function ready(fake: Fake, minutesAgo: number) {
    const upload = await pending(fake);
    expect(
      (await completeCvUpload(owner, upload.id, fake.gateway)).status,
    ).toBe("ready");
    await asOwner(
      "UPDATE app.uploads SET expires_at=now()-make_interval(mins=>$2) WHERE id=$1",
      [upload.id, minutesAgo],
    );
    return upload;
  }

  beforeAll(async () => {
    stubLocalAuthReadiness();
    vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db, {
      userId: "cleanup-owner",
      teamId: "cleanup-team",
    });
    recruiter = await seedIdentity(fixture.db, {
      userId: "cleanup-recruiter",
      teamId: "cleanup-team",
      role: "recruiter",
    });
    other = await seedIdentity(fixture.db, {
      userId: "cleanup-other",
      teamId: "cleanup-other-team",
    });
    await enforceTestRls(fixture.db);
    candidateId = (
      await createRecord(owner, "candidates", {
        data: { name: "Fictional Cleanup Candidate" },
      })
    ).id;
    otherCandidateId = (
      await createRecord(other, "candidates", {
        data: { name: "Fictional Other Cleanup Candidate" },
      })
    ).id;
  });
  beforeEach(async () => {
    configured.current = undefined;
    await fixture.client.exec("RESET ROLE");
    await fixture.client.exec(
      "DELETE FROM app.uploads; DELETE FROM app.idempotency; DELETE FROM app.storage_usage; DELETE FROM storage_ledger.blob_read_leases; DELETE FROM storage_ledger.blob_reconciliation_claims; DELETE FROM storage_ledger.stores; SET ROLE recruitment_test_runtime;",
    );
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await fixture?.close();
  });

  describe("post-expiry deletion ordering", () => {
    it("waits 10 minutes after expiry, then deletes, confirms by head and only then releases the charge", async () => {
      const fake = fakeBlob();
      const { id, key } = await rejected(fake, 9);
      expect(await retained()).toEqual(held(1));
      fake.state.calls = [];
      const early = await reconcileBlobStorage(owner, fake.gateway, fullSweep);
      expect(early).toMatchObject({ chargesReleased: 0, objectsDeleted: 0 });
      expect(fake.state.calls).toEqual([`list:teams/${owner.teamId}/cvs/`]);
      expect(fake.objects.has(key)).toBe(true);
      expect(await retained()).toEqual(held(1));
      expect(await deletedAt(id)).toBeNull();

      await asOwner(
        "UPDATE app.uploads SET expires_at=now()-interval '10 minutes' WHERE id=$1",
        [id],
      );
      fake.state.calls = [];
      // The charge is still held when the provider is asked to delete and when head confirms it.
      const seen: unknown[] = [];
      fake.state.beforeCall = async (call) => {
        if (!call.startsWith("list:")) seen.push([call, await retained()]);
      };
      const swept = await reconcileBlobStorage(owner, fake.gateway, fullSweep);
      fake.state.beforeCall = undefined;
      expect(seen).toEqual([
        [`delete:${key}`, held(1)],
        [`head:${key}`, held(1)],
      ]);
      expect(fake.state.calls).toEqual([
        `delete:${key}`,
        `head:${key}`,
        `list:teams/${owner.teamId}/cvs/`,
      ]);
      expect(swept).toMatchObject({ chargesReleased: 1, failures: 0 });
      expect(await retained()).toEqual(held(0));
      expect(await deletedAt(id)).toBeInstanceOf(Date);

      fake.state.calls = [];
      const again = await reconcileBlobStorage(owner, fake.gateway, fullSweep);
      expect(again).toEqual({
        expiredReservations: 0,
        chargesReleased: 0,
        objectsChecked: 0,
        objectsDeleted: 0,
        failures: 0,
        complete: true,
      });
      expect(fake.state.calls).toEqual([`list:teams/${owner.teamId}/cvs/`]);
      expect(await retained()).toEqual(held(0));
    });

    for (const [label, fail] of [
      ["the delete throws", (fake: Fake) => (fake.state.failDelete = true)],
      [
        "head still finds the object",
        (fake: Fake) => (fake.state.keepOnDelete = true),
      ],
    ] as const)
      it(`keeps the charge retained when ${label}, and a later run releases it`, async () => {
        const fake = fakeBlob();
        const { id, key } = await rejected(fake, 11);
        fail(fake);
        const failed = await reconcileBlobStorage(owner, fake.gateway, {
          ...fullSweep,
          maxPages: 0,
        });
        expect(failed).toMatchObject({ chargesReleased: 0, failures: 1 });
        expect(await retained()).toEqual(held(1));
        expect(await deletedAt(id)).toBeNull();
        fake.state.failDelete = false;
        fake.state.keepOnDelete = false;
        const later = await reconcileBlobStorage(
          owner,
          fake.gateway,
          fullSweep,
        );
        expect(later).toMatchObject({ chargesReleased: 1, failures: 0 });
        expect(fake.objects.has(key)).toBe(false);
        expect(await retained()).toEqual(held(0));
      });

    it("expires the team's old tickets first and counts them", async () => {
      const fake = fakeBlob();
      const { id } = await pending(fake);
      await asOwner(
        "UPDATE app.uploads SET expires_at=now()-interval '1 minute' WHERE id=$1",
        [id],
      );
      const swept = await reconcileBlobStorage(owner, fake.gateway, fullSweep);
      expect(swept).toMatchObject({
        expiredReservations: 1,
        chargesReleased: 0,
      });
      expect(await retained()).toEqual(held(1));
    });
  });

  describe("list pass", () => {
    it("deletes stale, oversized and rejected objects and keeps pending and matching ready ones", async () => {
      const fake = fakeBlob();
      await holdCooldown();
      const prefix = `teams/${owner.teamId}/cvs/`;
      const now = Date.now();
      const oldOrphan = `${prefix}${randomUUID()}/${randomUUID()}.pdf`;
      const youngOrphan = `${prefix}${randomUUID()}/${randomUUID()}.pdf`;
      fake.objects.set(oldOrphan, {
        bytes: pdf,
        mimeType: "application/pdf",
        uploadedAt: new Date(now - 26 * MINUTE),
      });
      fake.objects.set(youngOrphan, {
        bytes: pdf,
        mimeType: "application/pdf",
        uploadedAt: new Date(now - 24 * MINUTE),
      });
      const live = await pending(fake);
      const matching = await ready(fake, 60);
      const oversized = await ready(fake, 11);
      fake.objects.set(oversized.key, {
        bytes: pdf,
        mimeType: "application/pdf",
        headSize: 11 * 1024 * 1024,
      });
      // A released row whose object came back, as a still-valid ticket could do.
      const recreated = await rejected(fake, 11);
      expect(
        await reconcileBlobStorage(owner, fake.gateway, {
          ...fullSweep,
          maxPages: 0,
        }),
      ).toMatchObject({ chargesReleased: 1 });
      fake.objects.set(recreated.key, {
        bytes: pdf,
        mimeType: "application/pdf",
      });
      // Another team's old orphan stays: the sweep never lists another team's prefix.
      const foreign = `teams/${other.teamId}/cvs/${randomUUID()}/${randomUUID()}.pdf`;
      fake.objects.set(foreign, {
        bytes: pdf,
        mimeType: "application/pdf",
        uploadedAt: new Date(now - 60 * MINUTE),
      });
      fake.state.calls = [];
      const swept = await reconcileBlobStorage(owner, fake.gateway, fullSweep);
      expect(swept).toEqual({
        expiredReservations: 0,
        chargesReleased: 0,
        objectsChecked: 6,
        objectsDeleted: 3,
        failures: 0,
        complete: true,
      });
      for (const key of [oldOrphan, oversized.key, recreated.key])
        expect(fake.objects.has(key), key).toBe(false);
      for (const key of [youngOrphan, live.key, matching.key, foreign])
        expect(fake.objects.has(key), key).toBe(true);
      expect(
        fake.state.calls.filter((call) => call.startsWith("list:")),
      ).toEqual([`list:${prefix}`]);
      expect(fake.state.calls.some((call) => call.includes(other.teamId))).toBe(
        false,
      );
    });

    it("stops at the delete, page and time caps and reports the run incomplete", async () => {
      const fake = fakeBlob();
      const prefix = `teams/${owner.teamId}/cvs/`;
      const old = new Date(Date.now() - 60 * MINUTE);
      for (let n = 0; n < 3; n++)
        fake.objects.set(`${prefix}stale-${n}.pdf`, {
          bytes: pdf,
          mimeType: "application/pdf",
          uploadedAt: old,
        });
      const capped = await reconcileBlobStorage(owner, fake.gateway, {
        ...fullSweep,
        maxDeletes: 1,
      });
      expect(capped).toMatchObject({ objectsDeleted: 1, complete: false });
      expect(fake.objects.size).toBe(2);
      fake.objects.clear();
      // 1001 young objects span two list pages of 1000.
      for (let n = 0; n < 1001; n++)
        fake.objects.set(`${prefix}young-${String(n).padStart(4, "0")}.pdf`, {
          bytes: pdf,
          mimeType: "application/pdf",
        });
      expect(
        await reconcileBlobStorage(owner, fake.gateway, {
          ...fullSweep,
          maxPages: 1,
        }),
      ).toMatchObject({
        objectsChecked: 1000,
        objectsDeleted: 0,
        complete: false,
      });
      expect(
        await reconcileBlobStorage(owner, fake.gateway, {
          ...fullSweep,
          maxPages: 2,
        }),
      ).toMatchObject({
        objectsChecked: 1001,
        objectsDeleted: 0,
        complete: true,
      });
      // A spent budget starts no provider call.
      fake.state.calls = [];
      const timed = await reconcileBlobStorage(owner, fake.gateway, {
        ...fullSweep,
        budgetMs: 1,
      });
      expect(timed).toMatchObject({ objectsChecked: 0, complete: false });
      expect(fake.state.calls).toEqual([]);
      // A slow provider uses up the budget part way.
      fake.state.beforeCall = () => new Promise((done) => setTimeout(done, 60));
      const slow = await reconcileBlobStorage(owner, fake.gateway, {
        ...fullSweep,
        budgetMs: 100,
      });
      fake.state.beforeCall = undefined;
      expect(slow.complete).toBe(false);
    });

    it("returns counts only and logs no pathname or ID", async () => {
      const fake = fakeBlob();
      const { id, key } = await rejected(fake, 11);
      const orphan = `teams/${owner.teamId}/cvs/${randomUUID()}/${randomUUID()}.pdf`;
      fake.objects.set(orphan, {
        bytes: pdf,
        mimeType: "application/pdf",
        uploadedAt: new Date(Date.now() - 60 * MINUTE),
      });
      const output: unknown[] = [];
      const spies = (["log", "info", "warn", "error", "debug"] as const).map(
        (method) =>
          vi
            .spyOn(console, method)
            .mockImplementation((...args) => void output.push(...args)),
      );
      fake.state.failList = true;
      let failed;
      try {
        failed = await reconcileBlobStorage(owner, fake.gateway, fullSweep);
        fake.state.failList = false;
        const result = await reconcileBlobStorage(
          owner,
          fake.gateway,
          fullSweep,
        );
        expect(Object.keys(result).sort()).toEqual([
          "chargesReleased",
          "complete",
          "expiredReservations",
          "failures",
          "objectsChecked",
          "objectsDeleted",
        ]);
        expect(result).toMatchObject({ objectsDeleted: 1, complete: true });
        for (const secret of [
          id,
          key,
          orphan,
          owner.teamId,
          "provider refused",
        ])
          expect(JSON.stringify([failed, result, output])).not.toContain(
            secret,
          );
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      expect(failed).toMatchObject({
        chargesReleased: 1,
        failures: 1,
        complete: false,
      });
    });
  });

  describe("server trigger in a new Blob reservation", () => {
    it("releases at most five eligible charges before reserving", async () => {
      const fake = fakeBlob();
      // Reserved first, then expired together: each reservation would release earlier ones.
      for (let n = 0; n < 6; n++) await pending(fake);
      await asOwner(
        "UPDATE app.uploads SET status='rejected', expires_at=now()-interval '11 minutes' WHERE team_id=$1",
        [owner.teamId],
      );
      expect(await retained()).toEqual(held(6));
      fake.state.calls = [];
      const reserved = await beginCvUpload(
        owner,
        candidateId,
        metadata(),
        fake.gateway,
      );
      expect(reserved.upload?.protocol).toBe("blob-put-v1");
      expect(await retained()).toEqual(held(1));
      expect(
        fake.state.calls.filter((call) => call.startsWith("delete:")),
      ).toHaveLength(5);
      expect(fake.state.calls.some((call) => call.startsWith("list:"))).toBe(
        false,
      );
    });

    it("still returns its ticket when the delete throws", async () => {
      const fake = fakeBlob();
      await rejected(fake, 11);
      fake.state.failDelete = true;
      const reserved = await beginCvUpload(
        owner,
        candidateId,
        metadata(),
        fake.gateway,
      );
      expect(reserved.upload?.protocol).toBe("blob-put-v1");
      expect(await retained()).toEqual(held(1));
    });

    it("makes no provider call when nothing is eligible", async () => {
      const fake = fakeBlob();
      await rejected(fake, 9);
      fake.state.calls = [];
      await beginCvUpload(owner, candidateId, metadata(), fake.gateway);
      expect(fake.state.calls).toEqual([]);
      expect(fake.state.reads).toBe(0);
    });
  });

  describe("objects the provider let through", () => {
    for (const [label, stored] of [
      [
        "a multipart upload larger than its reservation",
        { headSize: 11 * 1024 * 1024 },
      ],
      [
        "an upload with a different content type",
        { headMimeType: "image/png" },
      ],
    ] as const)
      it(`rejects ${label} at completion and deletes it only 10 minutes after expiry`, async () => {
        const fake = fakeBlob();
        const { id, key } = await pending(fake);
        fake.objects.set(key, {
          bytes: pdf,
          mimeType: "application/pdf",
          ...stored,
        });
        await expect(
          completeCvUpload(owner, id, fake.gateway),
        ).rejects.toMatchObject({ status: 400, code: "INVALID_CV" });
        expect(
          (
            await asOwner<{ status: string }>(
              "SELECT status FROM app.uploads WHERE id=$1",
              [id],
            )
          )[0].status,
        ).toBe("rejected");
        expect(await retained()).toEqual(held(1));
        // The completion's automatic sweep ran and left the object alone.
        expect(sweeps(fake)).toBe(1);
        const deletes = () =>
          fake.state.calls.filter((call) => call.startsWith("delete:"));
        expect(deletes()).toEqual([]);
        await asOwner(
          "UPDATE app.uploads SET expires_at=now()-interval '9 minutes' WHERE id=$1",
          [id],
        );
        expect(
          await reconcileBlobStorage(owner, fake.gateway, fullSweep),
        ).toMatchObject({ chargesReleased: 0, objectsDeleted: 0 });
        expect(deletes()).toEqual([]);
        expect(fake.objects.has(key)).toBe(true);
        await asOwner(
          "UPDATE app.uploads SET expires_at=now()-interval '11 minutes' WHERE id=$1",
          [id],
        );
        fake.state.calls = [];
        expect(
          await reconcileBlobStorage(owner, fake.gateway, fullSweep),
        ).toMatchObject({ chargesReleased: 1, failures: 0 });
        expect(fake.state.calls.slice(0, 2)).toEqual([
          `delete:${key}`,
          `head:${key}`,
        ]);
        expect(fake.objects.has(key)).toBe(false);
        expect(await retained()).toEqual(held(0));
        expect(await deletedAt(id)).toBeInstanceOf(Date);
      });

    it("keeps the charge while a deleted object keeps coming back, counts each failure, and releases once it is gone", async () => {
      const fake = fakeBlob();
      const young = await rejected(fake, 9);
      const { id, key } = await rejected(fake, 11);
      const orphan = `teams/${owner.teamId}/cvs/${randomUUID()}/${randomUUID()}.pdf`;
      fake.objects.set(orphan, {
        bytes: pdf,
        mimeType: "application/pdf",
        uploadedAt: new Date(Date.now() - 60 * MINUTE),
      });
      // A delete that does not take: the row pass and the list pass's re-check both count it.
      fake.state.keepOnDelete = true;
      fake.state.calls = [];
      expect(
        await reconcileBlobStorage(owner, fake.gateway, fullSweep),
      ).toMatchObject({ chargesReleased: 0, objectsDeleted: 0, failures: 3 });
      expect(fake.state.calls).toContain(`head:${orphan}`);
      expect(await retained()).toEqual(held(2));
      expect(await deletedAt(id)).toBeNull();
      // A replayed ticket re-puts the object between the delete and the head.
      fake.state.keepOnDelete = false;
      fake.state.beforeCall = async (call) => {
        if (call === `head:${key}`)
          fake.objects.set(key, { bytes: pdf, mimeType: "application/pdf" });
      };
      expect(
        await reconcileBlobStorage(owner, fake.gateway, {
          ...fullSweep,
          maxPages: 0,
        }),
      ).toMatchObject({ chargesReleased: 0, failures: 1 });
      expect(await retained()).toEqual(held(2));
      fake.state.beforeCall = undefined;
      fake.state.calls = [];
      expect(
        await reconcileBlobStorage(owner, fake.gateway, fullSweep),
      ).toMatchObject({ chargesReleased: 1, objectsDeleted: 1, failures: 0 });
      for (const gone of [key, orphan])
        expect(fake.objects.has(gone), gone).toBe(false);
      expect(await retained()).toEqual(held(1));
      // The row inside its grace period was never deleted by any of the runs.
      expect(fake.objects.has(young.key)).toBe(true);
      expect(fake.state.calls).not.toContain(`delete:${young.key}`);
      expect(await deletedAt(young.id)).toBeNull();
    });
  });

  describe("automatic sweep after a Blob upload settles", () => {
    it("runs one sweep after a ready and after a rejected completion, and none inside the cooldown", async () => {
      const fake = fakeBlob();
      const first = await pending(fake);
      fake.state.calls = [];
      expect(
        (await completeCvUpload(owner, first.id, fake.gateway)).status,
      ).toBe("ready");
      expect(sweeps(fake)).toBe(1);
      const second = await pending(fake);
      fake.state.calls = [];
      await completeCvUpload(owner, second.id, fake.gateway);
      expect(sweeps(fake)).toBe(0);
      // A replay of a settled row never sweeps, even after the cooldown.
      await ageCooldown();
      fake.state.calls = [];
      await completeCvUpload(owner, second.id, fake.gateway);
      expect(sweeps(fake)).toBe(0);
      const refused = await pending(fake);
      fake.objects.set(refused.key, {
        bytes: pdf,
        mimeType: "application/pdf",
        headMimeType: "image/png",
      });
      fake.state.calls = [];
      await expect(
        completeCvUpload(owner, refused.id, fake.gateway),
      ).rejects.toMatchObject({ code: "INVALID_CV" });
      expect(sweeps(fake)).toBe(1);
    });

    it("returns the same completion whether or not the sweep fails, and logs only fixed text", async () => {
      const outcome = async (failSweep: boolean) => {
        await asOwner("DELETE FROM storage_ledger.blob_reconciliation_claims");
        if (failSweep)
          await asOwner(
            "REVOKE EXECUTE ON FUNCTION tenant_context.claim_blob_reconciliation(text) FROM recruitment_test_runtime",
          );
        const fake = fakeBlob();
        const good = await pending(fake);
        const bad = await pending(fake);
        fake.objects.set(bad.key, {
          bytes: pdf,
          mimeType: "application/pdf",
          headSize: 11 * 1024 * 1024,
        });
        const output: unknown[] = [];
        const spy = vi
          .spyOn(console, "error")
          .mockImplementation((...args) => void output.push(...args));
        try {
          const ready = await completeCvUpload(owner, good.id, fake.gateway);
          await asOwner(
            "DELETE FROM storage_ledger.blob_reconciliation_claims",
          );
          const rejection = await completeCvUpload(
            owner,
            bad.id,
            fake.gateway,
          ).catch(
            (error: { status: number; code: string; message: string }) => ({
              status: error.status,
              code: error.code,
              message: error.message,
            }),
          );
          const { id, createdAt, completedAt, expiresAt, ...shape } = ready;
          expect([id, createdAt, completedAt, expiresAt]).not.toContain(
            undefined,
          );
          return { shape, rejection, output, swept: sweeps(fake) };
        } finally {
          spy.mockRestore();
          if (failSweep)
            await asOwner(
              "GRANT EXECUTE ON FUNCTION tenant_context.claim_blob_reconciliation(text) TO recruitment_test_runtime",
            );
        }
      };
      const working = await outcome(false);
      const failing = await outcome(true);
      expect(working.swept).toBe(2);
      expect(failing.swept).toBe(0);
      expect(failing.shape).toEqual(working.shape);
      expect(failing.rejection).toEqual(working.rejection);
      expect(working.rejection).toMatchObject({
        status: 400,
        code: "INVALID_CV",
      });
      expect(working.output).toEqual([]);
      expect(failing.output).toEqual([
        "Automatic CV storage cleanup failed; the next upload retries.",
        "Automatic CV storage cleanup failed; the next upload retries.",
      ]);
    });
  });

  describe("early upload rate check", () => {
    it("refuses an over-rate new reservation before the row pass makes any provider call", async () => {
      const fake = fakeBlob();
      await rejected(fake, 11);
      await asOwner(
        "UPDATE app.uploads SET created_at=now()-interval '30 minutes' WHERE team_id=$1",
        [owner.teamId],
      );
      await asOwner(
        "UPDATE app.storage_usage SET upload_requests_per_minute=1 WHERE team_id=$1",
        [owner.teamId],
      );
      // The first new reservation is allowed; its row pass fails, so the old row stays eligible.
      fake.state.failDelete = true;
      const input = metadata();
      const first = await beginCvUpload(
        owner,
        candidateId,
        input,
        fake.gateway,
      );
      expect(first.upload?.protocol).toBe("blob-put-v1");
      fake.state.failDelete = false;
      fake.state.calls = [];
      const signs = fake.state.signs;
      await expect(
        beginCvUpload(owner, candidateId, metadata(), fake.gateway),
      ).rejects.toMatchObject({ status: 429, code: "CV_UPLOAD_RATE_LIMITED" });
      expect(fake.state.calls).toEqual([]);
      expect(fake.state.signs).toBe(signs);
      // A replay of the existing reservation is never refused by the rate.
      expect(
        (await beginCvUpload(owner, candidateId, input, fake.gateway)).data.id,
      ).toBe(first.data.id);
    });
  });

  describe("POST /api/v1/cvs/storage-reconciliation", () => {
    const post = async (headers: Record<string, string>) => {
      const response = await reconcileRoute(
        new Request(`${ORIGIN}/api/v1/cvs/storage-reconciliation`, {
          method: "POST",
          headers,
        }),
      );
      return {
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        body: await response.json(),
      };
    };
    const signIn = (p: Principal) =>
      vi.mocked(getVerifiedSession).mockResolvedValue({
        user: { id: p.userId, twoFactorEnabled: true },
        session: { activeOrganizationId: p.teamId },
      } as never);

    it("runs one sweep for an owner session and an owner's cvs:write token, and refuses a recruiter", async () => {
      const fake = fakeBlob();
      configured.current = { binding: blobBinding, gateway: fake.gateway };
      await rejected(fake, 11);
      // A recruiter's refusal comes before the cooldown claim, so it does not hold the cooldown.
      signIn(recruiter);
      const refused = await post({ origin: ORIGIN });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe("storage_reconciliation_forbidden");
      signIn(owner);
      const session = await post({ origin: ORIGIN });
      expect(session).toEqual({
        status: 200,
        retryAfter: null,
        body: {
          data: {
            expiredReservations: 0,
            chargesReleased: 1,
            objectsChecked: 0,
            objectsDeleted: 0,
            failures: 0,
            complete: true,
          },
        },
      });
      await ageCooldown();
      const { token } = await createToken(owner, {
        name: "Fictional cleanup token",
        scopes: ["cvs:write"],
      });
      const bearer = await post({ authorization: `Bearer ${token}` });
      expect(bearer.status).toBe(200);
      expect(bearer.body.data).toMatchObject({
        chargesReleased: 0,
        complete: true,
      });
    });

    it("answers a second run within 10 minutes with 429 and Retry-After, makes no provider call, and runs again after the cooldown", async () => {
      const fake = fakeBlob();
      configured.current = { binding: blobBinding, gateway: fake.gateway };
      signIn(owner);
      expect((await post({ origin: ORIGIN })).status).toBe(200);
      await rejected(fake, 11);
      fake.state.calls = [];
      const cooling = await post({ origin: ORIGIN });
      expect(cooling.status).toBe(429);
      expect(cooling.body.error.code).toBe("STORAGE_RECONCILIATION_COOLDOWN");
      const seconds = Number(cooling.retryAfter);
      expect(Number.isInteger(seconds)).toBe(true);
      expect(seconds).toBeGreaterThanOrEqual(1);
      expect(seconds).toBeLessThanOrEqual(600);
      expect(fake.state.calls).toEqual([]);
      expect(await retained()).toEqual(held(1));
      // Another team keeps its own cooldown.
      signIn(other);
      expect((await post({ origin: ORIGIN })).status).toBe(200);
      signIn(owner);
      await ageCooldown();
      const again = await post({ origin: ORIGIN });
      expect(again.status).toBe(200);
      expect(again.body.data).toMatchObject({ chargesReleased: 1 });
      expect(await retained()).toEqual(held(0));
    });

    it("refuses S3 storage with 409 and missing Blob setup with 503", async () => {
      configured.current = {
        binding: {
          provider: "s3",
          environment: "development",
          store: "fictional-s3",
        },
        gateway: undefined,
      };
      signIn(owner);
      const s3 = await post({ origin: ORIGIN });
      expect(s3.status).toBe(409);
      expect(s3.body.error).toMatchObject({
        code: "STORAGE_RECONCILIATION_UNSUPPORTED",
        message: "CV storage cleanup applies only to Vercel Blob storage.",
      });
      configured.current = undefined;
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const missing = await post({ origin: ORIGIN });
        expect(missing.status).toBe(503);
        expect(missing.body.error.code).toBe("STORAGE_SETUP_REQUIRED");
      } finally {
        logged.mockRestore();
      }
      // Neither refusal claimed the cooldown.
      expect(
        await asOwner(
          "SELECT 1 FROM storage_ledger.blob_reconciliation_claims",
        ),
      ).toEqual([]);
      const fake = fakeBlob();
      configured.current = { binding: blobBinding, gateway: fake.gateway };
      expect((await post({ origin: ORIGIN })).status).toBe(200);
    });
  });

  it("never touches another team's rows", async () => {
    const fake = fakeBlob();
    await pending(fake, other, otherCandidateId);
    const [{ id }] = await asOwner<{ id: string }>(
      "SELECT id FROM app.uploads WHERE team_id=$1",
      [other.teamId],
    );
    await asOwner(
      "UPDATE app.uploads SET status='rejected', expires_at=now()-interval '11 minutes' WHERE id=$1",
      [id],
    );
    await reconcileBlobStorage(owner, fake.gateway, fullSweep);
    expect(await retained(other.teamId)).toMatchObject({
      team: [{ bytes: pdf.length, files: 1 }],
    });
    expect(await deletedAt(id)).toBeNull();
  });
});
