import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));

import type { TeamTx } from "@/db";
import { storageUsage, uploads } from "@/db/schema";
import {
  dataRoleBoundaryQuery,
  dataRoleHelpers,
} from "@/db/connection-boundary";
import { withTeam } from "@/lib/db-team";
import { beginCvUpload, completeCvUpload } from "@/lib/cvs";
import { createRecord } from "@/lib/records";
import type { Principal } from "@/lib/principal";
import type { StorageBinding, StorageGateway } from "@/lib/storage";
import { createSplitRoleDb, seedIdentity, splitRoles } from "./helpers/db";

// Fictional data only: one team per scenario so store and team counters stay independent.
const pdf = Buffer.from("%PDF-1.7\nfictional ledger CV");
const later = () => new Date(Date.now() + 3_600_000);
const counters =
  "used_bytes::int,reserved_bytes::int,retained_bytes::int,used_files,reserved_files,retained_files";
const empty = {
  used_bytes: 0,
  reserved_bytes: 0,
  retained_bytes: 0,
  used_files: 0,
  reserved_files: 0,
  retained_files: 0,
};
function fakeStorage(binding: StorageBinding) {
  const calls: string[] = [];
  const gateway: StorageGateway = {
    binding,
    async assertVersioning() {},
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
  return { gateway, calls };
}
const s3 = (store: string): StorageBinding => ({
  provider: "s3",
  environment: "development",
  store,
});
function metadata() {
  return {
    originalName: "fictional.pdf",
    mimeType: "application/pdf",
    sizeBytes: pdf.length,
    clientUploadId: randomUUID(),
  };
}

describe("store-wide CV allocation ledger under the split data role", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  type Team = { p: Principal; candidateId: string };

  async function team(label: string): Promise<Team> {
    const db = await harness.asOwner();
    const p = await seedIdentity(db, {
      userId: `ledger-owner-${label}`,
      teamId: `ledger-${label}`,
    });
    const candidate = await createRecord(p, "candidates", {
      data: { name: `Fictional ${label} Candidate` },
    });
    return { p, candidateId: candidate.id };
  }
  /** PGlite's bootstrap superuser bypasses RLS; it only inspects outcomes. */
  async function inspect(query: string, params: unknown[] = []) {
    await harness.asSuperuser();
    return (await harness.client.query(query, params)).rows;
  }
  async function asOwner(query: string, params: unknown[] = []) {
    await harness.asOwner();
    return (await harness.client.query(query, params)).rows;
  }
  const storeCounters = (provider: string, store: string) =>
    inspect(
      `SELECT ${counters} FROM storage_ledger.stores WHERE provider=$1 AND store=$2`,
      [provider, store],
    );
  const teamCounters = (t: Team) =>
    inspect(`SELECT ${counters} FROM app.storage_usage WHERE team_id=$1`, [
      t.p.teamId,
    ]);
  const lock = (tx: TeamTx, b: StorageBinding) =>
    tx.execute(
      sql`SELECT tenant_context.lock_storage_allocation(${b.provider}, ${b.environment}, ${b.store})`,
    );
  async function insertUpload(
    tx: TeamTx,
    t: Team,
    b: StorageBinding,
    values: Partial<typeof uploads.$inferInsert> = {},
  ) {
    const [row] = await tx
      .insert(uploads)
      .values({
        teamId: t.p.teamId,
        candidateId: t.candidateId,
        originalName: "fictional.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1000,
        objectKey: `fictional/${randomUUID()}`,
        storageProvider: b.provider,
        storageEnvironment: b.environment,
        storageStore: b.store,
        createdBy: t.p.userId,
        expiresAt: later(),
        ...values,
      })
      .returning();
    return row;
  }
  async function withBudget<T>(
    environment: string,
    limits: { bytes: number; files: number },
    work: () => Promise<T>,
  ) {
    const [saved] = await asOwner(
      "SELECT max_bytes::bigint::text AS bytes, max_files FROM storage_ledger.budgets WHERE environment=$1",
      [environment],
    );
    await asOwner(
      "UPDATE storage_ledger.budgets SET max_bytes=$2, max_files=$3 WHERE environment=$1",
      [environment, limits.bytes, limits.files],
    );
    try {
      return await work();
    } finally {
      await asOwner(
        "UPDATE storage_ledger.budgets SET max_bytes=$2::bigint, max_files=$3 WHERE environment=$1",
        [
          environment,
          (saved as { bytes: string }).bytes,
          (saved as { max_files: number }).max_files,
        ],
      );
    }
  }

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
  });
  afterAll(async () => harness?.close());

  it("seeds exactly the approved budgets, readable only by the owner", async () => {
    expect(
      await asOwner(
        "SELECT environment, max_bytes::int, max_files FROM storage_ledger.budgets ORDER BY environment",
      ),
    ).toEqual([
      { environment: "development", max_bytes: 200000000, max_files: 500 },
      { environment: "preview", max_bytes: 200000000, max_files: 500 },
      { environment: "production", max_bytes: 600000000, max_files: 2000 },
    ]);
    expect(
      await inspect(
        "SELECT table_name, column_default FROM information_schema.columns WHERE table_schema='app' AND table_name='storage_usage' AND column_name IN ('max_bytes','max_files') ORDER BY column_name",
      ),
    ).toEqual([
      { table_name: "storage_usage", column_default: null },
      { table_name: "storage_usage", column_default: null },
    ]);
  });

  it("enforces typed provider references and the per-file bound as table constraints", async () => {
    const t = await team("checks");
    const insert = `INSERT INTO app.uploads(team_id,candidate_id,original_name,mime_type,size_bytes,status,object_key,storage_provider,storage_environment,storage_store,s3_version_id,blob_sha256,blob_size_bytes,completed_at,created_by,expires_at)
      VALUES($1,$2,'fictional.pdf','application/pdf',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()+interval '1 hour')`;
    const sha = "a".repeat(64);
    const cases: Array<[string, unknown[]]> = [
      [
        "uploads_provider_reference_check",
        [
          1000,
          "pending",
          "s3",
          "development",
          "fictional-checks",
          null,
          sha,
          null,
          null,
        ],
      ],
      [
        "uploads_provider_reference_check",
        [
          1000,
          "pending",
          "blob",
          "preview",
          "store_fictional",
          "fictional-v1",
          null,
          null,
          null,
        ],
      ],
      [
        "uploads_blob_store_check",
        [
          1000,
          "pending",
          "blob",
          "preview",
          "fictional-bucket",
          null,
          null,
          null,
          null,
        ],
      ],
      [
        "uploads_ready_check",
        [
          1000,
          "ready",
          "blob",
          "preview",
          "store_fictional",
          null,
          sha,
          1001,
          new Date(),
        ],
      ],
      [
        "uploads_size_bytes_check",
        [
          10485761,
          "pending",
          "s3",
          "development",
          "fictional-checks",
          null,
          null,
          null,
          null,
        ],
      ],
    ];
    await inspect("SELECT 1");
    // Disable triggers so each insert reaches only the table's own constraints.
    await harness.client.exec("SET session_replication_role = replica");
    try {
      for (const [constraint, [size, status, ...rest]] of cases)
        await expect(
          harness.client.query(insert, [
            t.p.teamId,
            t.candidateId,
            size,
            status,
            `fictional/${randomUUID()}`,
            ...rest,
            t.p.userId,
          ]),
          constraint,
        ).rejects.toMatchObject({ code: "23514", constraint });
    } finally {
      await harness.client.exec("SET session_replication_role = DEFAULT");
    }
  });

  it("creates a team row with null limits that inherits the store budget", async () => {
    const t = await team("inherit");
    const b = s3("fictional-inherit");
    await withTeam(t.p, (tx) => lock(tx, b));
    expect(
      await inspect(
        "SELECT max_bytes, max_files FROM app.storage_usage WHERE team_id=$1",
        [t.p.teamId],
      ),
    ).toEqual([{ max_bytes: null, max_files: null }]);
    await withBudget("development", { bytes: 999, files: 500 }, async () => {
      await expect(
        withTeam(t.p, async (tx) => {
          await lock(tx, b);
          await insertUpload(tx, t, b);
        }),
      ).rejects.toMatchObject({ cause: { code: "RQ001" } });
    });
    expect(await teamCounters(t)).toEqual([empty]);
    expect(await storeCounters("s3", b.store)).toEqual([empty]);
  });

  it("applies one store budget across teams and refuses the second team with no counter change", async () => {
    const a = await team("shared-a");
    const b = await team("shared-b");
    const binding = s3("fictional-shared");
    await withBudget(
      "development",
      { bytes: 200000000, files: 1 },
      async () => {
        await beginCvUpload(
          a.p,
          a.candidateId,
          metadata(),
          fakeStorage(binding).gateway,
        );
        const storeBefore = await storeCounters("s3", binding.store);
        const refused = fakeStorage(binding);
        await expect(
          beginCvUpload(b.p, b.candidateId, metadata(), refused.gateway),
        ).rejects.toMatchObject({
          status: 409,
          code: "STORAGE_QUOTA_EXCEEDED",
        });
        expect(refused.calls).toEqual([]);
        expect(await storeCounters("s3", binding.store)).toEqual(storeBefore);
      },
    );
    expect(await storeCounters("s3", binding.store)).toEqual([
      { ...empty, reserved_bytes: pdf.length, reserved_files: 1 },
    ]);
    expect(await teamCounters(b)).toEqual([empty]);
    expect(await teamCounters(a)).toEqual([
      { ...empty, reserved_bytes: pdf.length, reserved_files: 1 },
    ]);
  });

  it("retains a rejected Blob charge on store and team, but releases a rejected S3 charge", async () => {
    const t = await team("retained");
    const blob: StorageBinding = {
      provider: "blob",
      environment: "preview",
      store: "store_fictional",
    };
    await withTeam(t.p, async (tx) => {
      await lock(tx, blob);
      const row = await insertUpload(tx, t, blob);
      await tx
        .update(uploads)
        .set({ status: "rejected" })
        .where(eq(uploads.id, row.id));
    });
    const retained = { ...empty, retained_bytes: 1000, retained_files: 1 };
    expect(await storeCounters("blob", blob.store)).toEqual([retained]);
    expect(await teamCounters(t)).toEqual([retained]);
    // The new ticket fits only if the retained charge had been released.
    await withBudget("preview", { bytes: 1500, files: 500 }, async () => {
      await expect(
        withTeam(t.p, async (tx) => {
          await lock(tx, blob);
          await insertUpload(tx, t, blob);
        }),
      ).rejects.toMatchObject({ cause: { code: "RQ001" } });
    });
    expect(await storeCounters("blob", blob.store)).toEqual([retained]);

    const other = await team("released");
    const bucket = s3("fictional-released");
    await withTeam(other.p, async (tx) => {
      await lock(tx, bucket);
      const row = await insertUpload(tx, other, bucket);
      await tx
        .update(uploads)
        .set({ status: "rejected" })
        .where(eq(uploads.id, row.id));
    });
    expect(await storeCounters("s3", bucket.store)).toEqual([empty]);
    expect(await teamCounters(other)).toEqual([empty]);
  });

  it("charges each upload once, settles it once and never reuses its path", async () => {
    const t = await team("once");
    const binding = s3("fictional-once");
    const { gateway } = fakeStorage(binding);
    const ticket = await beginCvUpload(t.p, t.candidateId, metadata(), gateway);
    await completeCvUpload(t.p, ticket.data.id, gateway);
    const settled = { ...empty, used_bytes: pdf.length, used_files: 1 };
    expect(await storeCounters("s3", binding.store)).toEqual([settled]);
    expect(await teamCounters(t)).toEqual([settled]);
    await withTeam(t.p, (tx) =>
      tx
        .update(uploads)
        .set({ status: "ready" })
        .where(eq(uploads.id, ticket.data.id)),
    );
    await completeCvUpload(t.p, ticket.data.id, gateway);
    const [{ object_key }] = (await inspect(
      "SELECT object_key FROM app.uploads WHERE id=$1",
      [ticket.data.id],
    )) as Array<{ object_key: string }>;
    await expect(
      withTeam(t.p, async (tx) => {
        await lock(tx, binding);
        await insertUpload(tx, t, binding, { objectKey: object_key });
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    // A row skipped by ON CONFLICT is never charged.
    await withTeam(t.p, async (tx) => {
      await lock(tx, binding);
      await tx
        .insert(uploads)
        .values({
          teamId: t.p.teamId,
          candidateId: t.candidateId,
          originalName: "fictional.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1000,
          objectKey: object_key,
          storageProvider: "s3",
          storageEnvironment: "development",
          storageStore: binding.store,
          createdBy: t.p.userId,
          expiresAt: later(),
        })
        .onConflictDoNothing();
    });
    expect(await storeCounters("s3", binding.store)).toEqual([settled]);
    expect(await teamCounters(t)).toEqual([settled]);
  });

  it("refuses status reversals, reference rewrites, deletes and unbound or settled inserts", async () => {
    const t = await team("transitions");
    const binding = s3("fictional-transitions");
    const ids = await withTeam(t.p, async (tx) => {
      await lock(tx, binding);
      const ready = await insertUpload(tx, t, binding);
      const rejected = await insertUpload(tx, t, binding);
      const pending = await insertUpload(tx, t, binding);
      await tx
        .update(uploads)
        .set({
          status: "ready",
          s3VersionId: "fictional-v1",
          completedAt: new Date(),
        })
        .where(eq(uploads.id, ready.id));
      await tx
        .update(uploads)
        .set({ status: "rejected" })
        .where(eq(uploads.id, rejected.id));
      return { ready: ready.id, rejected: rejected.id, pending: pending.id };
    });
    const snapshot = () =>
      inspect("SELECT * FROM app.uploads WHERE team_id=$1 ORDER BY id", [
        t.p.teamId,
      ]);
    const before = await snapshot();
    const ledgerBefore = [
      await storeCounters("s3", binding.store),
      await teamCounters(t),
    ];
    const other = await team("transitions-other");
    const attempts: Array<[string, (tx: TeamTx) => Promise<unknown>, string]> =
      [
        [
          "ready to pending",
          (tx) =>
            tx
              .update(uploads)
              .set({ status: "pending" })
              .where(eq(uploads.id, ids.ready)),
          "23514",
        ],
        [
          "rejected to ready",
          (tx) =>
            tx
              .update(uploads)
              .set({
                status: "ready",
                s3VersionId: "fictional-v2",
                completedAt: new Date(),
              })
              .where(eq(uploads.id, ids.rejected)),
          "23514",
        ],
        [
          "rejected to pending",
          (tx) =>
            tx
              .update(uploads)
              .set({ status: "pending" })
              .where(eq(uploads.id, ids.rejected)),
          "23514",
        ],
        [
          "size",
          (tx) =>
            tx
              .update(uploads)
              .set({ sizeBytes: 1 })
              .where(eq(uploads.id, ids.pending)),
          "23514",
        ],
        [
          "key",
          (tx) =>
            tx
              .update(uploads)
              .set({ objectKey: "fictional/rewritten" })
              .where(eq(uploads.id, ids.pending)),
          "23514",
        ],
        [
          "store",
          (tx) =>
            tx
              .update(uploads)
              .set({ storageStore: "fictional-elsewhere" })
              .where(eq(uploads.id, ids.pending)),
          "23514",
        ],
        [
          "team",
          (tx) =>
            tx
              .update(uploads)
              .set({ teamId: other.p.teamId })
              .where(eq(uploads.id, ids.pending)),
          "23514",
        ],
        [
          "version",
          (tx) =>
            tx
              .update(uploads)
              .set({ s3VersionId: "fictional-v2" })
              .where(eq(uploads.id, ids.ready)),
          "23514",
        ],
        [
          "delete",
          (tx) => tx.delete(uploads).where(eq(uploads.id, ids.rejected)),
          "42501",
        ],
        [
          "ready insert",
          async (tx) => {
            await lock(tx, binding);
            await insertUpload(tx, t, binding, {
              status: "ready",
              s3VersionId: "fictional-v1",
              completedAt: new Date(),
            });
          },
          "42501",
        ],
        [
          "unbound insert",
          async (tx) => {
            await lock(tx, binding);
            await insertUpload(tx, t, binding, {
              storageEnvironment: null,
              storageStore: null,
            });
          },
          "42501",
        ],
      ];
    for (const [label, attempt, code] of attempts)
      await expect(withTeam(t.p, attempt), label).rejects.toMatchObject({
        cause: { code },
      });
    expect(await snapshot()).toEqual(before);
    expect([
      await storeCounters("s3", binding.store),
      await teamCounters(t),
    ]).toEqual(ledgerBefore);
  });

  it("keeps both ledgers owner-only while a team can still read its own usage row", async () => {
    const t = await team("owner-only");
    const binding = s3("fictional-owner-only");
    await withTeam(t.p, (tx) => lock(tx, binding));
    const writes: Array<[string, (tx: TeamTx) => Promise<unknown>]> = [
      [
        "insert",
        (tx) =>
          tx
            .insert(storageUsage)
            .values({ teamId: t.p.teamId })
            .onConflictDoNothing(),
      ],
      [
        "update",
        (tx) =>
          tx
            .update(storageUsage)
            .set({ reservedFiles: 0 })
            .where(eq(storageUsage.teamId, t.p.teamId)),
      ],
      [
        "delete",
        (tx) =>
          tx.delete(storageUsage).where(eq(storageUsage.teamId, t.p.teamId)),
      ],
      [
        "read stores",
        (tx) => tx.execute(sql`SELECT * FROM storage_ledger.stores`),
      ],
      [
        "read budgets",
        (tx) => tx.execute(sql`SELECT * FROM storage_ledger.budgets`),
      ],
      [
        "write stores",
        (tx) =>
          tx.execute(sql`UPDATE storage_ledger.stores SET reserved_files = 0`),
      ],
    ];
    for (const [label, write] of writes)
      await expect(withTeam(t.p, write), label).rejects.toMatchObject({
        cause: { code: "42501" },
      });
    expect(
      await withTeam(t.p, (tx) => tx.select().from(storageUsage)),
    ).toMatchObject([{ teamId: t.p.teamId, maxBytes: null, maxFiles: null }]);
    await harness.identityDb();
    for (const statement of [
      "SELECT * FROM storage_ledger.stores",
      "SELECT * FROM storage_ledger.budgets",
    ])
      await expect(
        harness.client.query(statement),
        statement,
      ).rejects.toMatchObject({
        code: "42501",
      });
    await harness.dataDb();
    await expect(
      harness.client.query(
        "SELECT tenant_context.lock_storage_allocation('s3','development','fictional-owner-only')",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const db = await harness.asOwner();
    const viewer = await seedIdentity(db, {
      userId: "ledger-viewer",
      teamId: t.p.teamId,
      role: "viewer",
    });
    await expect(
      withTeam(viewer, (tx) => lock(tx, binding)),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("fixes a store's environment at its first lock and refuses a later mismatch", async () => {
    const t = await team("fixed");
    const store = "store_fictional";
    await withTeam(t.p, (tx) =>
      lock(tx, { provider: "blob", environment: "preview", store }),
    );
    await expect(
      withTeam(t.p, (tx) =>
        lock(tx, { provider: "blob", environment: "production", store }),
      ),
    ).rejects.toMatchObject({ cause: { code: "RQ002" } });
    const moved = fakeStorage({
      provider: "blob",
      environment: "production",
      store,
    });
    await expect(
      beginCvUpload(t.p, t.candidateId, metadata(), moved.gateway),
    ).rejects.toMatchObject({ status: 503, code: "STORAGE_SETUP_REQUIRED" });
    expect(moved.calls).toEqual([]);
    expect(
      await inspect(
        "SELECT environment FROM storage_ledger.stores WHERE provider='blob' AND store=$1",
        [store],
      ),
    ).toEqual([{ environment: "preview" }]);
  });

  it("allowlists only the reviewed lock helper and keeps every new definer function owner-only", async () => {
    expect(dataRoleHelpers).toContain(
      "tenant_context.lock_storage_allocation(text,text,text)",
    );
    const client = await harness.dataDb().then(() => harness.client);
    expect(
      (await client.query<{ unsafe: boolean }>(dataRoleBoundaryQuery)).rows[0]
        .unsafe,
    ).toBe(false);
    expect(
      await inspect(
        `SELECT n.nspname || '.' || p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
           EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prosecdef AND n.nspname IN ('storage_ledger','tenant_context')
           AND p.proname IN ('charge_upload','settle_upload','lock_storage_allocation') ORDER BY 1`,
      ),
    ).toEqual(
      [
        "storage_ledger.charge_upload",
        "storage_ledger.settle_upload",
        "tenant_context.lock_storage_allocation",
      ].map((name) => ({
        name,
        owner: splitRoles.owner,
        proconfig: ["search_path=pg_catalog, pg_temp"],
        public: false,
      })),
    );
  });
});
