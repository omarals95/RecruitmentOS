import { createHash, createHmac, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));

import {
  activity,
  bulkIntakeBatches,
  bulkIntakeItems,
  candidateStates,
  idempotency,
  notificationReads,
  records,
  storageUsage,
  uploads,
} from "@/db/schema";
import { member, user } from "@/db/auth-schema";
import {
  dataRoleBoundaryQuery,
  identityRoleBoundaryQuery,
} from "@/db/connection-boundary";
import { withTeam } from "@/lib/db-team";
import {
  authenticateApiToken,
  createToken,
  revokeToken,
} from "@/lib/api-tokens";
import { beginCvUpload } from "@/lib/cvs";
import { analytics, listActivity, overview } from "@/lib/insights";
import { createRecord, getRecord } from "@/lib/records";
import type { Principal } from "@/lib/principal";
import type { TeamTx } from "@/db";
import type { StorageGateway } from "@/lib/storage";
import {
  createSplitRoleDb,
  seedApiToken,
  seedIdentity,
  splitRoles,
} from "./helpers/db";
import { CLIENT_IP, stubLocalAuthReadiness } from "./helpers/readiness";

// Fictional data only: two teams, two users per team, one API token.
const TABLES = [
  "records",
  "candidate_states",
  "activity",
  "uploads",
  "storage_usage",
  "idempotency",
  "notification_reads",
  "bulk_intake_batches",
  "bulk_intake_items",
] as const;
const AUDIENCE = "recruitmentos-tenant-context-v1";
const testKey = () =>
  Buffer.from(process.env.TENANT_CONTEXT_SIGNING_KEY!, "base64url");
const keyId = (key: Buffer) =>
  createHash("sha256").update(key).digest("hex").slice(0, 16);
function pads(key: Buffer) {
  const block = Buffer.alloc(64);
  key.copy(block);
  return [0x36, 0x5c].map((byte) =>
    Buffer.from(block.map((value) => value ^ byte)).toString("hex"),
  );
}
type Claim = {
  aud: string;
  kid: string;
  env: string;
  pid: number;
  xid: string;
  team: string;
  actor: string;
  auth: "session" | "token";
  token: string | null;
  scopes: string[];
  exp: number;
};

describe("signed tenant context under separate nonowner data and identity roles", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  let ownerA: Principal, memberA: Principal, leaverA: Principal;
  let ownerB: Principal, memberB: Principal;
  let candidateA: string, candidateB: string, vacancyB: string;

  async function asData() {
    await harness.dataDb();
    return harness.client;
  }
  /** Runs raw SQL in one data-role transaction, always rolled back. */
  async function dataTransaction<T>(work: () => Promise<T>): Promise<T> {
    const client = await asData();
    await client.exec("BEGIN");
    try {
      return await work();
    } finally {
      await client.exec("ROLLBACK");
    }
  }
  type Executor = Pick<TeamTx, "execute">;
  /** Inside withTeam, SQL must go through its transaction; PGlite has one connection. */
  const on = (tx?: Executor): Executor => tx ?? harness.db;
  async function claimFor(
    p: Principal,
    overrides: Partial<Claim> = {},
    tx?: Executor,
  ): Promise<Claim> {
    const { rows } = await on(tx).execute<{
      pid: number;
      xid: string;
      env: string;
      now: string;
    }>(
      sql`SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid, (SELECT id::text FROM db_boundary.connection_marker) AS env, floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS now`,
    );
    return {
      aud: AUDIENCE,
      kid: keyId(testKey()),
      env: rows[0].env,
      pid: Number(rows[0].pid),
      xid: rows[0].xid,
      team: p.teamId,
      actor: p.userId,
      auth: p.authType,
      token: p.authType === "token" ? (p.tokenId ?? null) : null,
      scopes: [...p.scopes],
      exp: Number(rows[0].now) + 30_000,
      ...overrides,
    };
  }
  const sign = (payload: string, key = testKey()) =>
    createHmac("sha256", key).update(payload).digest("hex");
  async function install(
    claim: Claim | string,
    signature?: string,
    tx?: Executor,
  ) {
    const payload = typeof claim === "string" ? claim : JSON.stringify(claim);
    try {
      await on(tx).execute(
        sql`SELECT tenant_context.install(${payload},${signature ?? sign(payload)})`,
      );
    } catch (error) {
      throw (error as Error).cause ?? error;
    }
  }
  async function visibleTeams(table: string, tx?: Executor) {
    const { rows } = await on(tx).execute<{ team_id: string }>(
      sql.raw(`SELECT DISTINCT team_id FROM app.${table} ORDER BY team_id`),
    );
    return rows.map((row) => row.team_id);
  }
  const denied = { code: "42501", message: "Tenant context rejected" };

  beforeAll(async () => {
    stubLocalAuthReadiness();
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db = await harness.asOwner();
    ownerA = await seedIdentity(db, { userId: "ctx-owner-a", teamId: "ctx-a" });
    memberA = await seedIdentity(db, {
      userId: "ctx-member-a",
      teamId: "ctx-a",
      role: "recruiter",
    });
    leaverA = await seedIdentity(db, {
      userId: "ctx-leaver-a",
      teamId: "ctx-a",
      role: "recruiter",
    });
    ownerB = await seedIdentity(db, { userId: "ctx-owner-b", teamId: "ctx-b" });
    memberB = await seedIdentity(db, {
      userId: "ctx-member-b",
      teamId: "ctx-b",
      role: "recruiter",
    });
    async function seedRows(p: Principal, label: string) {
      const person = await createRecord(p, "candidates", {
        data: { name: `Fictional ${label} Candidate` },
      });
      const job = await createRecord(p, "vacancies", {
        data: { title: `Fictional ${label} vacancy`, status: "Open" },
      });
      await withTeam(p, async (tx) => {
        await tx.insert(records).values({
          teamId: p.teamId,
          kind: "saved-view",
          data: { name: `Fictional ${label} private view` },
          privateOwnerId: p.userId,
          createdBy: p.userId,
        });
        await tx.insert(candidateStates).values({
          teamId: p.teamId,
          userId: p.userId,
          candidateId: person.id,
          note: `Fictional ${label} private note`,
        });
        // Usage rows are owner-only; the lock helper creates the team row before the charge.
        await tx.execute(
          sql`SELECT tenant_context.lock_storage_allocation('s3','development','fictional-tenant-bucket')`,
        );
        await tx.insert(uploads).values({
          teamId: p.teamId,
          candidateId: person.id,
          originalName: `fictional-${label}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 10,
          objectKey: `teams/${p.teamId}/cvs/fictional-${label}`,
          storageProvider: "s3",
          storageEnvironment: "development",
          storageStore: "fictional-tenant-bucket",
          legacySourceId: `fictional-legacy-${label}`,
          createdBy: p.userId,
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        await tx.insert(idempotency).values({
          teamId: p.teamId,
          actorKey: `${p.userId}:session:session`,
          operation: "fictional",
          key: `fictional-${label}`,
          payloadHash: "0".repeat(64),
          response: {},
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        await tx.insert(notificationReads).values({
          teamId: p.teamId,
          userId: p.userId,
          key: `fictional-${label}`,
        });
        const batchId = randomUUID();
        const now = new Date();
        await tx.insert(bulkIntakeBatches).values({
          id: batchId,
          teamId: p.teamId,
          createdBy: p.userId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 3_600_000),
        });
        await tx.insert(bulkIntakeItems).values({
          id: randomUUID(),
          teamId: p.teamId,
          batchId,
          createdBy: p.userId,
          originalName: `fictional-${label}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 10,
          payloadHash: "0".repeat(64),
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(activity).values([
          {
            teamId: p.teamId,
            recordId: person.id,
            actorId: p.userId,
            actorType: "session",
            action: "personal_state_updated",
            kind: "candidate",
            summary: `Fictional ${label} personal event`,
          },
          {
            teamId: p.teamId,
            actorId: p.userId,
            actorType: "session",
            action: "created",
            kind: "saved-view",
            summary: `Fictional ${label} saved view event`,
          },
        ]);
      });
      return { person, job };
    }
    candidateA = (await seedRows(ownerA, "owner-a")).person.id;
    await seedRows(memberA, "member-a");
    const seededB = await seedRows(ownerB, "owner-b");
    candidateB = seededB.person.id;
    vacancyB = seededB.job.id;
    await seedRows(memberB, "member-b");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness?.close();
  });

  it("runs as nonowner roles that pass their boundary checks and cannot assume each other", async () => {
    const client = await asData();
    expect(
      (await client.query<{ role: string }>("SELECT current_user AS role"))
        .rows[0].role,
    ).toBe(splitRoles.data);
    expect(
      (await client.query<{ unsafe: boolean }>(dataRoleBoundaryQuery)).rows[0]
        .unsafe,
    ).toBe(false);
    await harness.identityDb();
    expect(
      (await client.query<{ unsafe: boolean }>(identityRoleBoundaryQuery))
        .rows[0].unsafe,
    ).toBe(false);
    const flags = await client.query<{ bypass: boolean; superuser: boolean }>(
      `SELECT bool_or(rolbypassrls) AS bypass, bool_or(rolsuper) AS superuser FROM pg_roles WHERE rolname IN ('${splitRoles.owner}','${splitRoles.data}','${splitRoles.identity}')`,
    );
    expect(flags.rows[0]).toEqual({ bypass: false, superuser: false });
  });

  it("ignores forged team and user settings without a signed context", async () => {
    await dataTransaction(async () => {
      await harness.client.query(
        "SELECT set_config('app.team_id',$1,true), set_config('app.user_id',$2,true)",
        [ownerA.teamId, ownerA.userId],
      );
      for (const table of TABLES)
        expect(await visibleTeams(table), table).toEqual([]);
      await expect(
        harness.client.query(
          "INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary) VALUES($1,$2,'session','created','task','Forged event')",
          [ownerA.teamId, ownerA.userId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("keeps a valid context on its own team and actor when settings name another", async () => {
    await withTeam(ownerA, async (tx) => {
      await tx.execute(
        sql`select set_config('app.team_id',${ownerB.teamId},true), set_config('app.user_id',${memberA.userId},true)`,
      );
      for (const table of TABLES)
        expect(await visibleTeams(table, tx), table).toEqual([ownerA.teamId]);
      const states = await tx.select().from(candidateStates);
      expect(states.map((row) => row.userId)).toEqual([ownerA.userId]);
      const reads = await tx.select().from(notificationReads);
      expect(reads.map((row) => row.userId)).toEqual([ownerA.userId]);
      const batches = await tx.select().from(bulkIntakeBatches);
      expect(batches.map((row) => row.createdBy)).toEqual([ownerA.userId]);
      const items = await tx.select().from(bulkIntakeItems);
      expect(items.map((row) => row.createdBy)).toEqual([ownerA.userId]);
      const views = await tx
        .select()
        .from(records)
        .where(eq(records.kind, "saved-view"));
      expect(views.map((row) => row.privateOwnerId)).toEqual([ownerA.userId]);
    });
  });

  it("hides another member's private rows from an owner while keeping their own writable", async () => {
    await withTeam(ownerA, async (tx) => {
      expect(
        await tx
          .select()
          .from(candidateStates)
          .where(eq(candidateStates.userId, memberA.userId)),
      ).toEqual([]);
      expect(
        await tx
          .update(candidateStates)
          .set({ note: "Overwritten by owner" })
          .where(eq(candidateStates.userId, memberA.userId))
          .returning(),
      ).toEqual([]);
      expect(
        await tx
          .select()
          .from(notificationReads)
          .where(eq(notificationReads.userId, memberA.userId)),
      ).toEqual([]);
      expect(
        await tx
          .delete(notificationReads)
          .where(eq(notificationReads.userId, memberA.userId))
          .returning(),
      ).toEqual([]);
      expect(
        await tx
          .select()
          .from(records)
          .where(eq(records.privateOwnerId, memberA.userId)),
      ).toEqual([]);
      expect(
        await tx
          .update(records)
          .set({ data: { name: "Overwritten view" } })
          .where(eq(records.privateOwnerId, memberA.userId))
          .returning(),
      ).toEqual([]);
      expect(
        await tx
          .update(bulkIntakeItems)
          .set({ originalName: "overwritten.pdf" })
          .where(eq(bulkIntakeItems.createdBy, memberA.userId))
          .returning(),
      ).toEqual([]);
      expect(
        await tx
          .delete(bulkIntakeBatches)
          .where(eq(bulkIntakeBatches.createdBy, memberA.userId))
          .returning(),
      ).toEqual([]);
      const events = await tx
        .select()
        .from(activity)
        .where(eq(activity.actorId, memberA.userId));
      expect(
        events.filter(
          (row) =>
            row.action === "personal_state_updated" ||
            row.kind === "saved-view",
        ),
      ).toEqual([]);
      expect(events.length).toBeGreaterThan(0);
      expect(
        await tx
          .update(candidateStates)
          .set({ note: "Fictional owner note edit" })
          .where(eq(candidateStates.userId, ownerA.userId))
          .returning(),
      ).toHaveLength(1);
      expect(
        await tx
          .update(records)
          .set({ data: { name: "Fictional owner view edit" } })
          .where(eq(records.privateOwnerId, ownerA.userId))
          .returning(),
      ).toHaveLength(1);
      expect(
        await tx
          .select()
          .from(notificationReads)
          .where(eq(notificationReads.userId, ownerA.userId)),
      ).toHaveLength(1);
      expect(
        (
          await tx
            .select()
            .from(activity)
            .where(
              and(
                eq(activity.actorId, ownerA.userId),
                eq(activity.action, "personal_state_updated"),
              ),
            )
        ).length,
      ).toBeGreaterThan(0);
    });
    await expect(
      withTeam(ownerA, (tx) =>
        tx.insert(candidateStates).values({
          teamId: ownerA.teamId,
          userId: memberA.userId,
          candidateId: candidateA,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("returns no other-team rows from any protected table and rejects other-team inserts", async () => {
    await withTeam(ownerA, async (tx) => {
      const foreign = await Promise.all([
        tx.select().from(records).where(eq(records.teamId, ownerB.teamId)),
        tx
          .select()
          .from(candidateStates)
          .where(eq(candidateStates.teamId, ownerB.teamId)),
        tx.select().from(activity).where(eq(activity.teamId, ownerB.teamId)),
        tx.select().from(uploads).where(eq(uploads.teamId, ownerB.teamId)),
        tx
          .select()
          .from(storageUsage)
          .where(eq(storageUsage.teamId, ownerB.teamId)),
        tx
          .select()
          .from(idempotency)
          .where(eq(idempotency.teamId, ownerB.teamId)),
        tx
          .select()
          .from(notificationReads)
          .where(eq(notificationReads.teamId, ownerB.teamId)),
        tx
          .select()
          .from(bulkIntakeBatches)
          .where(eq(bulkIntakeBatches.teamId, ownerB.teamId)),
        tx
          .select()
          .from(bulkIntakeItems)
          .where(eq(bulkIntakeItems.teamId, ownerB.teamId)),
      ]);
      expect(foreign.map((rows) => rows.length)).toEqual([
        0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]);
      const own = await tx.select().from(uploads);
      expect(own.map((row) => row.legacySourceId)).toEqual([
        "fictional-legacy-owner-a",
        "fictional-legacy-member-a",
      ]);
      expect(
        (await tx.select({ meta: records.importMeta }).from(records)).length,
      ).toBeGreaterThan(0);
    });
    const later = new Date(Date.now() + 3_600_000);
    const inserts = [
      (tx: TeamTx) =>
        tx.insert(records).values({
          teamId: ownerB.teamId,
          kind: "candidate",
          data: { name: "Forged" },
          createdBy: ownerA.userId,
        }),
      (tx: TeamTx) =>
        tx.insert(candidateStates).values({
          teamId: ownerB.teamId,
          userId: ownerA.userId,
          candidateId: candidateB,
        }),
      (tx: TeamTx) =>
        tx.insert(activity).values({
          teamId: ownerB.teamId,
          actorId: ownerA.userId,
          actorType: "session",
          action: "created",
          kind: "task",
          summary: "Forged",
        }),
      (tx: TeamTx) =>
        tx.insert(uploads).values({
          teamId: ownerB.teamId,
          candidateId: candidateB,
          originalName: "forged.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1,
          objectKey: "forged",
          storageProvider: "s3",
          storageEnvironment: "development",
          storageStore: "fictional-tenant-bucket",
          createdBy: ownerA.userId,
          expiresAt: later,
        }),
      (tx: TeamTx) =>
        tx
          .insert(storageUsage)
          .values({ teamId: ownerB.teamId })
          .onConflictDoNothing(),
      (tx: TeamTx) =>
        tx.insert(idempotency).values({
          teamId: ownerB.teamId,
          actorKey: "forged",
          operation: "forged",
          key: "forged",
          payloadHash: "0".repeat(64),
          response: {},
          expiresAt: later,
        }),
      (tx: TeamTx) =>
        tx.insert(notificationReads).values({
          teamId: ownerB.teamId,
          userId: ownerA.userId,
          key: "forged",
        }),
      (tx: TeamTx) =>
        tx.insert(bulkIntakeBatches).values({
          id: randomUUID(),
          teamId: ownerB.teamId,
          createdBy: ownerA.userId,
          createdAt: new Date(),
          expiresAt: later,
        }),
      (tx: TeamTx) =>
        tx.insert(bulkIntakeItems).values({
          id: randomUUID(),
          teamId: ownerB.teamId,
          batchId: randomUUID(),
          createdBy: ownerA.userId,
          originalName: "forged.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1,
          payloadHash: "0".repeat(64),
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
    ];
    for (const [index, insert] of inserts.entries())
      await expect(
        withTeam(ownerA, insert),
        TABLES[index],
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    const a = await overview(ownerA);
    const b = await overview(ownerB);
    expect(a.counts.candidates).toBe(2);
    expect(b.counts.candidates).toBe(2);
    expect(JSON.stringify(a)).not.toContain("owner-b");
    const analyticsA = await analytics(ownerA, new URLSearchParams());
    expect(analyticsA.counts.candidates).toBe(2);
    expect(analyticsA.counts.vacancies).toBe(2);
    expect(JSON.stringify(analyticsA)).not.toContain("owner-b");
  });

  it("rejects other-team identifiers in applications, CV reservations and reads", async () => {
    await expect(
      createRecord(ownerA, "applications", {
        candidateId: candidateA,
        vacancyId: vacancyB,
        data: {},
      }),
    ).rejects.toMatchObject({ status: expect.any(Number) });
    const unused = new Proxy({} as StorageGateway, {
      get: () => () => {
        throw new Error("Storage must not be reached");
      },
    });
    await expect(
      beginCvUpload(
        ownerA,
        candidateB,
        {
          originalName: "fictional.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
          clientUploadId: randomUUID(),
        },
        unused,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      getRecord(ownerA, "candidates", candidateB),
    ).rejects.toMatchObject({ status: 404 });
    await withTeam(ownerB, async (tx) => {
      const applications = await tx
        .select()
        .from(records)
        .where(eq(records.kind, "application"));
      expect(applications).toEqual([]);
    });
  });

  it("rejects tampered, misbound, expired and over-long assertions with one generic error", async () => {
    const other = Buffer.from(
      "OtherFictionalTenantContextKeyForTestsOnly00",
      "base64url",
    );
    const retired = Buffer.from(
      "RetiredFictionalTenantContextKeyForTests0000",
      "base64url",
    );
    await harness.asOwner();
    const [inner, outer] = pads(retired);
    await harness.client.query(
      "INSERT INTO tenant_context.keys(id,inner_pad,outer_pad,retired_at) VALUES($1,decode($2,'hex'),decode($3,'hex'),now())",
      [keyId(retired), inner, outer],
    );
    await dataTransaction(async () => {
      await install(await claimFor(ownerA));
      expect(await visibleTeams("records")).toEqual([ownerA.teamId]);
    });
    const cases: Array<[string, () => Promise<void>]> = [
      [
        "altered field",
        async () => {
          const claim = await claimFor(ownerA);
          await install(
            { ...claim, team: ownerB.teamId, actor: ownerB.userId },
            sign(JSON.stringify(claim)),
          );
        },
      ],
      [
        "wrong key",
        async () => {
          const payload = JSON.stringify(await claimFor(ownerA));
          await install(payload, sign(payload, other));
        },
      ],
      [
        "retired key",
        async () => {
          const payload = JSON.stringify(
            await claimFor(ownerA, { kid: keyId(retired) }),
          );
          await install(payload, sign(payload, retired));
        },
      ],
      [
        "wrong environment",
        async () => install(await claimFor(ownerA, { env: randomUUID() })),
      ],
      [
        "other backend",
        async () => {
          const claim = await claimFor(ownerA);
          await install({ ...claim, pid: claim.pid + 1 });
        },
      ],
      [
        "other transaction",
        async () => {
          const claim = await claimFor(ownerA);
          await install({ ...claim, xid: String(Number(claim.xid) + 1) });
        },
      ],
      [
        "past expiry",
        async () => {
          const claim = await claimFor(ownerA);
          await install({ ...claim, exp: claim.exp - 31_000 });
        },
      ],
      [
        "expiry over 60 seconds",
        async () => {
          const claim = await claimFor(ownerA);
          await install({ ...claim, exp: claim.exp + 31_000 });
        },
      ],
      [
        "non-canonical encoding",
        async () => {
          const claim = await claimFor(ownerA);
          await install(JSON.stringify(claim, null, 1));
        },
      ],
      [
        "unknown scope",
        async () => install(await claimFor(ownerA, { scopes: ["admin:all"] })),
      ],
    ];
    for (const [label, attempt] of cases)
      await dataTransaction(async () => {
        await expect(attempt(), label).rejects.toMatchObject(denied);
      });
  });

  it("stops granting access when an assertion expires mid-transaction", async () => {
    await dataTransaction(async () => {
      const claim = await claimFor(ownerA);
      await install({ ...claim, exp: claim.exp - 28_500 });
      expect(await visibleTeams("records")).toEqual([ownerA.teamId]);
      await harness.client.query("SELECT pg_sleep(1.6)");
      expect(await visibleTeams("records")).toEqual([]);
      await expect(
        harness.client.query(
          "SELECT tenant_context.activity_actor_name(id) FROM app.activity",
        ),
      ).resolves.toMatchObject({ rows: [] });
    });
  });

  it("gives a committed assertion no effect in the next transaction on the same connection", async () => {
    const client = await asData();
    await client.exec("BEGIN");
    const claim = await claimFor(ownerA);
    await install(claim);
    await client.exec("COMMIT");
    await dataTransaction(async () => {
      for (const table of TABLES)
        expect(await visibleTeams(table), table).toEqual([]);
      await expect(install(claim)).rejects.toMatchObject(denied);
    });
  });

  it("keeps the first context after savepoint rollback and rejects a second or repeated assertion", async () => {
    await withTeam(ownerA, async (tx) => {
      await tx.execute(sql`savepoint s`);
      await tx.execute(sql`select count(*) from app.records`);
      await tx.execute(sql`rollback to savepoint s`);
      for (const table of TABLES)
        expect(await visibleTeams(table, tx), table).toEqual([ownerA.teamId]);
      await tx.execute(sql`savepoint switch`);
      await expect(
        install(await claimFor(ownerB, {}, tx), undefined, tx),
      ).rejects.toMatchObject(denied);
      await tx.execute(sql`rollback to savepoint switch`);
      expect(await visibleTeams("records", tx)).toEqual([ownerA.teamId]);
    });
    await dataTransaction(async () => {
      const claim = await claimFor(ownerA);
      await install(claim);
      await harness.client.exec("SAVEPOINT again");
      await expect(install(claim)).rejects.toMatchObject(denied);
      await harness.client.exec("ROLLBACK TO SAVEPOINT again");
      expect(await visibleTeams("records")).toEqual([ownerA.teamId]);
    });
  });

  it("rejects contexts for revoked tokens, missing token scopes and removed members", async () => {
    const created = await createToken(ownerA, {
      name: "Fictional context token",
      scopes: ["candidates:read", "recruitment:read"],
    });
    const token = await authenticateApiToken(created.token, CLIENT_IP);
    expect(
      await withTeam(
        token,
        async (tx) => (await tx.select().from(records)).length,
      ),
    ).toBeGreaterThan(0);
    await expect(
      withTeam(
        { ...token, scopes: [...token.scopes, "candidates:write"] },
        () => Promise.resolve(),
      ),
    ).rejects.toMatchObject({ status: 403, code: "tenant_context_denied" });
    await revokeToken(ownerA, created.data.id);
    await expect(
      authenticateApiToken(created.token, CLIENT_IP),
    ).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      withTeam(token, () => Promise.resolve()),
    ).rejects.toMatchObject({ status: 403, code: "tenant_context_denied" });
    await withTeam(leaverA, () => Promise.resolve());
    const owner = await harness.asOwner();
    await owner
      .delete(member)
      .where(
        and(
          eq(member.organizationId, leaverA.teamId),
          eq(member.userId, leaverA.userId),
        ),
      );
    await expect(
      withTeam(leaverA, () => Promise.resolve()),
    ).rejects.toMatchObject({ status: 403, code: "tenant_context_denied" });
  });

  it("keeps token audit rows out of the data role's reach so revocation cannot be blocked", async () => {
    const created = await createToken(ownerA, {
      name: "Fictional unblockable token",
      scopes: ["candidates:read"],
    });
    for (const action of ["token.revoked", "token.created"])
      await expect(
        withTeam(ownerA, (tx) =>
          tx.insert(activity).values({
            teamId: ownerA.teamId,
            actorId: memberA.userId,
            actorType: "session",
            action,
            kind: "api-token",
            summary: "Forged token event",
            metadata: { tokenId: created.data.id },
          }),
        ),
        action,
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    await revokeToken(ownerA, created.data.id);
    await expect(
      authenticateApiToken(created.token, CLIENT_IP),
    ).rejects.toMatchObject({
      status: 401,
    });
    const events = await withTeam(ownerA, (tx) =>
      tx.select().from(activity).where(eq(activity.kind, "api-token")),
    );
    expect(
      events
        .filter((row) => row.metadata.tokenId === created.data.id)
        .map((row) => [row.action, row.actorId])
        .sort(),
    ).toEqual([
      ["token.created", ownerA.userId],
      ["token.revoked", ownerA.userId],
    ]);
  });

  it("binds new activity rows to the context actor, its own token and the import scope", async () => {
    type Event = typeof activity.$inferInsert;
    const event = (p: Principal, overrides: Partial<Event> = {}): Event => ({
      teamId: p.teamId,
      actorId: p.userId,
      actorType: p.authType,
      tokenId: p.tokenId ?? null,
      action: "created",
      kind: "task",
      summary: "Fictional bound event",
      ...overrides,
    });
    const owner = await harness.asOwner();
    const write = ["candidates:read", "candidates:write"] as const;
    const token = await seedApiToken(owner, ownerA, [...write]);
    const otherToken = await seedApiToken(owner, ownerA, [...write]);
    const importToken = await seedApiToken(owner, ownerA, [
      ...write,
      "imports:write",
    ]);
    const rejected: Array<[string, Principal, Partial<Event>]> = [
      ["same-team member as actor", ownerA, { actorId: memberA.userId }],
      ["other-team user as actor", ownerA, { actorId: ownerB.userId }],
      ["session row naming a token", ownerA, { tokenId: token.tokenId }],
      ["session row typed as token", ownerA, { actorType: "token" }],
      ["another token's id", token, { tokenId: otherToken.tokenId }],
      ["token row without its id", token, { tokenId: null }],
      ["token row typed as session", token, { actorType: "session" }],
      ["token row naming a colleague", token, { actorId: memberA.userId }],
      ["import without imports:write", memberA, { actorType: "import" }],
      ["token import without imports:write", token, { actorType: "import" }],
    ];
    for (const [label, p, overrides] of rejected)
      await expect(
        withTeam(p, (tx) => tx.insert(activity).values(event(p, overrides))),
        label,
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    const accepted: Array<[Principal, Partial<Event>]> = [
      [ownerA, {}],
      [memberA, {}],
      [token, {}],
      [ownerA, { actorType: "import" }],
      [importToken, { actorType: "import" }],
    ];
    for (const [p, overrides] of accepted)
      await withTeam(p, (tx) =>
        tx.insert(activity).values(event(p, overrides)),
      );
  });

  it("cannot plant an event under another user's id to read that user's name", async () => {
    const quiet = await seedIdentity(await harness.asOwner(), {
      userId: "ctx-quiet-a",
      teamId: "ctx-a",
      role: "recruiter",
    });
    const superuser = await harness.asSuperuser();
    for (const [target, name] of [
      [quiet, "Fictional Quiet Colleague"],
      [ownerB, "Fictional Other Team Owner"],
    ] as const)
      await superuser
        .update(user)
        .set({ name })
        .where(eq(user.id, target.userId));
    try {
      for (const target of [quiet, ownerB]) {
        const id = randomUUID();
        await expect(
          withTeam(ownerA, (tx) =>
            tx.insert(activity).values({
              id,
              teamId: ownerA.teamId,
              actorId: target.userId,
              actorType: "session",
              action: "created",
              kind: "task",
              summary: "Forged name probe",
            }),
          ),
          target.userId,
        ).rejects.toMatchObject({ cause: { code: "42501" } });
        const resolved = await withTeam(ownerA, async (tx) => {
          const { rows } = await tx.execute<{ name: string | null }>(
            sql`select tenant_context.activity_actor_name(${id}::uuid) as name`,
          );
          return rows[0].name;
        });
        expect(resolved, target.userId).toBeNull();
      }
      const listed = await listActivity(
        ownerA,
        new URLSearchParams({ pageSize: "100" }),
      );
      expect(JSON.stringify(listed)).not.toMatch(/Quiet Colleague|Other Team/);
      for (const search of ["Quiet Colleague", "Other Team Owner"])
        expect(
          (await listActivity(ownerA, new URLSearchParams({ search })))
            .pagination.total,
          search,
        ).toBe(0);
    } finally {
      await (
        await harness.asSuperuser()
      )
        .update(user)
        .set({ name: "Fictional Test User" })
        .where(eq(user.id, ownerB.userId));
    }
  });

  it("denies the data role the key, context and identity tables and the identity role", async () => {
    const client = await asData();
    for (const statement of [
      "SELECT * FROM tenant_context.keys",
      "SELECT * FROM tenant_context.contexts",
      `INSERT INTO tenant_context.contexts VALUES(pg_backend_pid(),pg_current_xact_id(),'ctx-b','ctx-owner-b','session',NULL,'{}',now()+interval '1 minute')`,
      "DELETE FROM tenant_context.contexts",
      'SELECT * FROM auth."user"',
      "SELECT * FROM auth.api_tokens",
      `UPDATE auth.member SET role='owner'`,
      `SELECT tenant_context.audit_token('x','token.created')`,
      `SET ROLE ${splitRoles.identity}`,
    ])
      await expect(client.query(statement), statement).rejects.toMatchObject({
        code: "42501",
      });
  });

  it("keeps the key, pads, payload and signature out of settings, errors and audit", async () => {
    const fragment = process.env.TENANT_CONTEXT_SIGNING_KEY!.slice(0, 24);
    const secrets = [fragment, ...pads(testKey()), AUDIENCE];
    const signatureShape = /[0-9a-f]{64}/;
    async function settings(tx?: Executor) {
      const { rows } = await on(tx).execute<{ value: string }>(
        sql`SELECT coalesce(setting,'') AS value FROM pg_settings UNION ALL SELECT coalesce(current_setting(name,true),'') FROM pg_settings WHERE name LIKE 'app.%'`,
      );
      return rows.map((row) => row.value).join("\n");
    }
    const inside = await withTeam(ownerA, (tx) => settings(tx));
    const after = await settings();
    let rejection: unknown;
    await withTeam(leaverA, () => Promise.resolve()).catch((error) => {
      rejection = error;
    });
    expect(rejection).toMatchObject({ code: "tenant_context_denied" });
    const afterRejection = await settings();
    const thrown = [
      (rejection as Error).message,
      inspect((rejection as Error).cause),
      inspect(rejection, { depth: 5 }),
      JSON.stringify(rejection),
    ].join("\n");
    const audit = await withTeam(ownerA, async (tx) =>
      JSON.stringify(await tx.select().from(activity)),
    );
    for (const [label, text] of Object.entries({
      inside,
      after,
      afterRejection,
      thrown,
      audit,
    })) {
      for (const secret of secrets)
        expect(text.includes(secret), `${label} contains secret`).toBe(false);
      expect(text, label).not.toMatch(signatureShape);
    }
  });

  it("fails closed with 503 before any database call when the key is missing", async () => {
    vi.stubEnv("TENANT_CONTEXT_SIGNING_KEY", undefined);
    const calls = pools.data.mock.calls.length;
    try {
      await expect(
        withTeam(ownerA, () => Promise.resolve()),
      ).rejects.toMatchObject({
        status: 503,
        code: "tenant_context_unavailable",
      });
      vi.stubEnv("TENANT_CONTEXT_SIGNING_KEY", "too-short");
      await expect(
        withTeam(ownerA, () => Promise.resolve()),
      ).rejects.toMatchObject({
        status: 503,
        code: "tenant_context_unavailable",
      });
      expect(pools.data.mock.calls.length).toBe(calls);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("shows only own-team names and private events in the activity list", async () => {
    const events = await listActivity(
      ownerA,
      new URLSearchParams({ pageSize: "100" }),
    );
    expect(events.data.length).toBeGreaterThan(0);
    expect(
      events.data.every((row) =>
        [ownerA.userId, memberA.userId].includes(row.actorId),
      ),
    ).toBe(true);
    expect(
      events.data.filter(
        (row) =>
          row.actorId === memberA.userId &&
          (row.action === "personal_state_updated" ||
            row.kind === "saved-view"),
      ),
    ).toEqual([]);
    expect(
      events.data.every((row) => row.actorName === "Fictional Test User"),
    ).toBe(true);
  });

  it("purges expired bulk batches of every user and team only through the owner-run helper", async () => {
    const expiredBatch = async (p: Principal) => {
      const id = randomUUID();
      const created = new Date(Date.now() - 2 * 86_400_000);
      await withTeam(p, async (tx) => {
        await tx.insert(bulkIntakeBatches).values({
          id,
          teamId: p.teamId,
          createdBy: p.userId,
          createdAt: created,
          expiresAt: new Date(created.getTime() + 86_400_000),
        });
        await tx.insert(bulkIntakeItems).values({
          id: randomUUID(),
          teamId: p.teamId,
          batchId: id,
          createdBy: p.userId,
          originalName: "fictional-expired.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
          payloadHash: "0".repeat(64),
          createdAt: created,
          updatedAt: created,
        });
      });
      return id;
    };
    const kept = await expiredBatch(ownerA);
    const purged = [
      await expiredBatch(memberA),
      await expiredBatch(ownerB),
      await expiredBatch(memberB),
    ];
    /** Each batch ID with whether it is purged, and the batch ID of every item. */
    const remaining = async () => {
      const superuser = await harness.asSuperuser();
      return {
        batches: Object.fromEntries(
          (await superuser.select().from(bulkIntakeBatches)).map((row) => [
            row.id,
            row.purgedAt !== null,
          ]),
        ),
        items: (await superuser.select().from(bulkIntakeItems)).map(
          (row) => row.batchId,
        ),
      };
    };
    const before = await remaining();
    for (const id of [kept, ...purged]) {
      expect(before.batches[id]).toBe(false);
      expect(before.items).toContain(id);
    }
    const client = await asData();
    await expect(
      client.query("SELECT tenant_context.purge_bulk_intake(NULL)"),
    ).rejects.toMatchObject({ code: "42501" });
    // A context without cvs:write is refused as well.
    await expect(
      withTeam({ ...memberB, scopes: ["candidates:read"] }, (tx) =>
        tx.execute(sql`select tenant_context.purge_bulk_intake(null::uuid)`),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    // The runtime role alone sees and deletes only its own rows.
    await withTeam(memberB, async (tx) => {
      expect(
        await tx
          .delete(bulkIntakeBatches)
          .where(eq(bulkIntakeBatches.id, purged[1]))
          .returning(),
      ).toEqual([]);
    });
    expect(await remaining()).toEqual(before);
    await withTeam(memberB, (tx) =>
      tx.execute(sql`select tenant_context.purge_bulk_intake(${kept}::uuid)`),
    );
    const after = await remaining();
    // Other users' and teams' expired batches stay as tombstones without items.
    for (const id of purged) {
      expect(after.batches[id]).toBe(true);
      expect(after.items).not.toContain(id);
    }
    expect(after.batches[kept]).toBe(false);
    expect(after.items).toContain(kept);
    // No batch row is deleted, and every unexpired seeded batch and its items are untouched.
    expect(after.batches).toEqual({
      ...before.batches,
      ...Object.fromEntries(purged.map((id) => [id, true])),
    });
    expect(after.items).toHaveLength(before.items.length - 3);
  });

  it("lets the data role reach the storage settings and Blob release helpers only through their checks", async () => {
    const denied = { cause: { code: "42501" } };
    const setLimits = (
      p: Principal,
      bytes: number | null,
      files: number | null,
      perMinute: number | null,
    ) =>
      withTeam(p, async (tx) => {
        const { rows } = await tx.execute<{ changed: boolean }>(
          sql`select tenant_context.set_storage_limits(${bytes}::bigint, ${files}::integer, ${perMinute}::integer) as changed`,
        );
        return rows[0].changed;
      });
    await expect(setLimits(memberA, null, null, 5)).rejects.toMatchObject(
      denied,
    );
    await expect(
      setLimits(ownerA, 2_000_000, null, null),
    ).rejects.toMatchObject({ cause: { code: "22023" } });
    expect(await setLimits(ownerA, null, null, 5)).toBe(true);
    expect(await setLimits(ownerA, null, null, 5)).toBe(false);
    expect(await setLimits(ownerA, null, null, null)).toBe(true);
    const client = await asData();
    for (const query of [
      "SELECT tenant_context.set_storage_limits(NULL, NULL, NULL)",
      `SELECT tenant_context.release_blob_charge('store_fictional', '${randomUUID()}')`,
    ])
      await expect(client.query(query)).rejects.toMatchObject({
        code: "42501",
      });
    const release = (p: Principal, store: string) =>
      withTeam(p, (tx) =>
        tx.execute(
          sql`select tenant_context.release_blob_charge(${store}, ${randomUUID()}::uuid)`,
        ),
      );
    await expect(
      release({ ...memberB, scopes: ["candidates:read"] }, "store_fictional"),
    ).rejects.toMatchObject(denied);
    // A store the ledger has never seen is a binding error, not a release.
    await expect(release(memberB, "store_fictional")).rejects.toMatchObject({
      cause: { code: "RQ002" },
    });
    await expect(
      withTeam(ownerA, (tx) =>
        tx
          .update(uploads)
          .set({ blobDeletedAt: new Date() })
          .where(eq(uploads.teamId, ownerA.teamId)),
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      withTeam(ownerA, (tx) =>
        tx.insert(activity).values({
          id: randomUUID(),
          teamId: ownerA.teamId,
          actorId: ownerA.userId,
          actorType: "session",
          action: "storage.settings_updated",
          kind: "storage-settings",
          summary: "Updated CV storage settings",
          metadata: {},
        }),
      ),
    ).rejects.toMatchObject(denied);
  });

  it("claims a team's Blob cleanup once per 10 minutes only through the cooldown helper", async () => {
    const claim = (p: Principal, store = "store_fictional") =>
      withTeam(p, async (tx) => {
        const { rows } = await tx.execute<{ remaining: number }>(
          sql`select tenant_context.claim_blob_reconciliation(${store}) as remaining`,
        );
        return Number(rows[0].remaining);
      });
    const client = await asData();
    for (const query of [
      "SELECT tenant_context.claim_blob_reconciliation('store_fictional')",
      "SELECT * FROM storage_ledger.blob_reconciliation_claims",
      "INSERT INTO storage_ledger.blob_reconciliation_claims(store,team_id,claimed_at) VALUES ('store_fictional','team-b',now())",
      "UPDATE storage_ledger.blob_reconciliation_claims SET claimed_at=now()-interval '1 hour'",
      "DELETE FROM storage_ledger.blob_reconciliation_claims",
    ])
      await expect(client.query(query), query).rejects.toMatchObject({
        code: "42501",
      });
    await expect(
      claim({ ...memberB, scopes: ["candidates:read", "cvs:read"] }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(claim(memberB, "not-a-store")).rejects.toMatchObject({
      cause: { code: "RQ002" },
    });
    expect(await claim(memberB)).toBe(0);
    const remaining = await claim(memberB);
    expect(remaining).toBeGreaterThanOrEqual(1);
    expect(remaining).toBeLessThanOrEqual(600);
    // Another team and another store each keep their own claim.
    expect(await claim(ownerA)).toBe(0);
    expect(await claim(memberB, "store_fictionalother")).toBe(0);
    await harness.asSuperuser();
    await harness.client.query(
      "UPDATE storage_ledger.blob_reconciliation_claims SET claimed_at=now()-interval '10 minutes 1 second' WHERE team_id=$1 AND store='store_fictional'",
      [memberB.teamId],
    );
    expect(await claim(memberB)).toBe(0);
    expect(await claim(memberB)).toBeGreaterThan(0);
  });
});
