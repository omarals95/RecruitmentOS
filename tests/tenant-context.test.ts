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
  speedSampleBudgets,
  speedSamples,
  storageUsage,
  uploads,
} from "@/db/schema";
import { member, user } from "@/db/auth-schema";
import {
  dataRoleBoundaryQuery,
  identityRoleBoundaryQuery,
} from "@/db/connection-boundary";
import {
  withDeadlinesAndSnapshot,
  type TransactionSnapshot,
} from "@/db/deadlines";
import { withTeam } from "@/lib/db-team";
import { installTenantContext } from "@/lib/tenant-context";
import { SCOPES, roleScopes } from "@/lib/permissions";
import { ADMIN_ROLE, RECRUITER_ROLE } from "@/domain/config-defaults";
import { createConfigDraft, publishConfigVersion } from "@/lib/config-store";
import {
  authenticateApiToken,
  createToken,
  revokeToken,
} from "@/lib/api-tokens";
import { beginCvUpload } from "@/lib/cvs";
import { analytics, listActivity, overview } from "@/lib/insights";
import { createRecord, getRecord, idempotencyActorKey } from "@/lib/records";
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
  "speed_samples",
  "speed_sample_budgets",
] as const;
const AUDIENCE = "recruitmentos-tenant-context-v1";
const COMPANY = "00000000-0000-4000-a000-000000000001";
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
        sql`SELECT tenant_context.install(${payload},${signature ?? sign(payload)},'{}'::text[])`,
      );
    } catch (error) {
      throw (error as Error).cause ?? error;
    }
  }
  /** A validly signed direct install with the given unsigned cache hint; returns the access state. */
  async function installed(claim: Claim | string, cached: string | null) {
    const payload = typeof claim === "string" ? claim : JSON.stringify(claim);
    try {
      const { rows } = await harness.db.execute<{ access: unknown }>(
        sql`SELECT tenant_context.install(${payload},${sign(payload)},${cached}::text[]) AS access`,
      );
      return rows[0].access;
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
  // ownerA is the first seeded user, so the initial administrator and company owner (0028).
  const ownerAccess = {
    scopes: [...SCOPES],
    workspaceId: COMPANY,
    memberRole: "owner",
    companyLevel: "owner",
    companyAreas: [],
    versions: {},
    documents: {},
    roleVersionId: "00000000-0000-4000-8000-000000000101",
    recordScope: { pipeline: "all", candidates: "all", tasks: "all" },
    homeUnits: [],
    teamArchived: false,
  };

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
        // Speed rows keep recorded_at at its default, the current clock hour.
        await tx.insert(speedSamples).values({
          teamId: p.teamId,
          kind: "action",
          name: "task.move",
          durationMs: 10,
        });
        await tx.insert(speedSampleBudgets).values({
          teamId: p.teamId,
          userId: p.userId,
          windowStart: sql`date_trunc('hour', now())`,
          rowCount: 1,
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

  it("rejects an app-signed context whose snapshot names another backend or transaction or has expired", async () => {
    const attempt = async (change: (snapshot: TransactionSnapshot) => object) =>
      withDeadlinesAndSnapshot(await harness.dataDb(), (tx, snapshot) =>
        installTenantContext(tx, ownerA, {
          ...snapshot,
          ...change(snapshot),
        } as TransactionSnapshot),
      );
    await expect(attempt(() => ({}))).resolves.toEqual(ownerAccess);
    for (const change of [
      (s: TransactionSnapshot) => ({ pid: Number(s.pid) + 1 }),
      (s: TransactionSnapshot) => ({ xid: String(Number(s.xid) + 1) }),
      (s: TransactionSnapshot) => ({ now: String(Number(s.now) - 61_000) }),
    ])
      await expect(attempt(change)).rejects.toMatchObject({
        status: 403,
        code: "tenant_context_denied",
      });
    const key = process.env.TENANT_CONTEXT_SIGNING_KEY!;
    vi.stubEnv(
      "TENANT_CONTEXT_SIGNING_KEY",
      "OtherFictionalTenantContextKeyForTestsOnly00",
    );
    try {
      await expect(attempt(() => ({}))).rejects.toMatchObject({
        status: 403,
        code: "tenant_context_denied",
      });
    } finally {
      vi.stubEnv("TENANT_CONTEXT_SIGNING_KEY", key);
    }
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

  const memberAccess = () => ({
    scopes: [...memberA.scopes],
    workspaceId: COMPANY,
    memberRole: "recruiter",
    companyLevel: null,
    companyAreas: [],
    versions: {},
    documents: {},
    roleVersionId: "00000000-0000-4000-8000-000000000103",
    recordScope: { pipeline: "all", candidates: "all", tasks: "all" },
    homeUnits: [],
    teamArchived: false,
  });

  it("passes the access state install derived to withTeam's work", async () => {
    expect(
      await withTeam(ownerA, (tx, access) => Promise.resolve(access)),
    ).toEqual(ownerAccess);
    expect(
      await withTeam(memberA, (tx, access) => Promise.resolve(access)),
    ).toEqual(memberAccess());
  });

  // ADM-05 (job 078): an active team stores every asserted scope and returns teamArchived false; an
  // archived team stores only the read scopes, in order, for every context of that team.
  it("stores every asserted scope for an active team and only the read scopes for an archived one", async () => {
    const archive = (archived: boolean) =>
      harness
        .asOwner()
        .then((db) =>
          db.execute(
            sql`UPDATE app.workspace_teams SET archived_at = ${archived ? sql`now()` : null}, archived_by = ${archived ? ownerA.userId : null} WHERE team_id = ${ownerA.teamId}`,
          ),
        );
    const stored = async (p: Principal) => {
      const access = await withTeam(
        { ...p, scopes: [...p.scopes] },
        (_tx, state) => Promise.resolve(state),
      );
      return { scopes: access.scopes, teamArchived: access.teamArchived };
    };
    expect(await stored(ownerA)).toEqual({
      scopes: [...SCOPES],
      teamArchived: false,
    });
    expect(await stored(memberA)).toEqual({
      scopes: [...memberA.scopes],
      teamArchived: false,
    });
    await archive(true);
    try {
      expect(await stored(ownerA)).toEqual({
        scopes: [
          "candidates:read",
          "recruitment:read",
          "cvs:read",
          "directory:read",
          "plans:read",
        ],
        teamArchived: true,
      });
      expect(await stored(memberA)).toEqual({
        scopes: ["candidates:read", "recruitment:read", "cvs:read"],
        teamArchived: true,
      });
      // Another team of the same workspace is unaffected.
      expect(await stored(ownerB)).toMatchObject({ teamArchived: false });
    } finally {
      await archive(false);
    }
    expect(await stored(memberA)).toEqual({
      scopes: [...memberA.scopes],
      teamArchived: false,
    });
  });

  it("rejects a context for a team with no workspace mapping", async () => {
    await (
      await harness.asOwner()
    ).execute(
      sql`DELETE FROM app.workspace_teams WHERE team_id = ${ownerB.teamId}`,
    );
    try {
      await dataTransaction(async () => {
        await expect(install(await claimFor(ownerB))).rejects.toMatchObject(
          denied,
        );
      });
      await expect(
        withTeam(ownerB, () => Promise.resolve()),
      ).rejects.toMatchObject({ status: 403, code: "tenant_context_denied" });
    } finally {
      await (
        await harness.asOwner()
      ).execute(
        sql`INSERT INTO app.workspace_teams(team_id, workspace_id) VALUES (${ownerB.teamId}, ${COMPANY}::uuid)`,
      );
    }
    expect(
      await withTeam(ownerB, (tx, access) =>
        Promise.resolve(access.workspaceId),
      ),
    ).toBe(COMPANY);
  });

  it("rejects a validly signed payload that adds a workspace or company field", async () => {
    for (const extra of [
      { workspace: COMPANY },
      { workspaceId: COMPANY },
      { companyLevel: "owner" },
      { companyAreas: ["fields"] },
    ])
      await dataTransaction(async () => {
        await expect(
          install({ ...(await claimFor(memberA)), ...extra }),
          JSON.stringify(extra),
        ).rejects.toMatchObject(denied);
      });
  });

  it("gives the same checks, stored row and result for every cached hint", async () => {
    const client = await asData();
    const xids: string[] = [];
    const results: unknown[] = [];
    for (const cached of [
      null,
      "{}",
      "{fictional-version-1,fictional-version-2}",
    ]) {
      await client.exec("BEGIN");
      try {
        const claim = await claimFor(memberA);
        results.push(await installed(claim, cached));
        xids.push(claim.xid);
        await client.exec("COMMIT");
      } catch (error) {
        await client.exec("ROLLBACK");
        throw error;
      }
      await dataTransaction(async () => {
        const claim = await claimFor(memberA);
        await expect(
          installed({ ...claim, exp: claim.exp - 31_000 }, cached),
          String(cached),
        ).rejects.toMatchObject(denied);
      });
    }
    // A direct call returns the documents as install's JSON array.
    const direct = { ...memberAccess(), documents: [] };
    expect(results).toEqual([direct, direct, direct]);
    await harness.asSuperuser();
    const { rows } = await harness.client.query(
      "SELECT team_id, actor_id, auth_type, token_id, scopes, workspace_id, member_role, company_level, company_areas, plan_access FROM tenant_context.contexts WHERE xid::text IN ($1, $2, $3)",
      xids,
    );
    const stored = {
      team_id: memberA.teamId,
      actor_id: memberA.userId,
      auth_type: "session",
      token_id: null,
      scopes: [...memberA.scopes],
      workspace_id: COMPANY,
      member_role: "recruiter",
      company_level: null,
      company_areas: [],
      plan_access: false,
    };
    expect(rows).toEqual([stored, stored, stored]);
  });

  it("gives the same checks, stored row and result for cached hints with NULL elements and duplicates (0032)", async () => {
    // A published company object, so a hint that dropped every body, or raised, would show.
    await harness.asOwner();
    const objectId = (
      await harness.client.query<{ id: string }>(
        `INSERT INTO app.config_objects(workspace_id, type, key) VALUES ('${COMPANY}', 'workflow', 'ctx-hint') RETURNING id`,
      )
    ).rows[0].id;
    const version = (
      await harness.client.query<{ id: string; sha: string; text: string }>(
        `INSERT INTO app.config_versions(object_id, workspace_id, state, number, body, published_at) VALUES ('${objectId}', '${COMPANY}', 'published', 1, '{"label":"Fictional hint workflow"}', now()) RETURNING id, body_sha256 AS sha, body::text AS text`,
      )
    ).rows[0];
    await harness.client.query(
      `UPDATE app.config_objects SET current_version_id = '${version.id}' WHERE id = '${objectId}'`,
    );
    try {
      const client = await asData();
      const xids: string[] = [];
      const results: unknown[] = [];
      const hints = [
        "{}",
        "{NULL}",
        "{NULL,NULL,fictional-version-1,fictional-version-1}",
        `{${version.id},NULL,${version.id}}`,
      ];
      for (const cached of hints) {
        await client.exec("BEGIN");
        try {
          const claim = await claimFor(memberA);
          results.push(await installed(claim, cached));
          xids.push(claim.xid);
          await client.exec("COMMIT");
        } catch (error) {
          await client.exec("ROLLBACK");
          throw error;
        }
        await dataTransaction(async () => {
          const claim = await claimFor(memberA);
          await expect(
            installed({ ...claim, exp: claim.exp - 31_000 }, cached),
            cached,
          ).rejects.toMatchObject(denied);
        });
      }
      const listed = {
        ...memberAccess(),
        versions: { [objectId]: version.id },
      };
      const document = {
        versionId: version.id,
        objectId,
        type: "workflow",
        key: "ctx-hint",
        number: 1,
        bodySha256: version.sha,
        body: version.text,
      };
      expect(results).toEqual([
        { ...listed, documents: [document] },
        { ...listed, documents: [document] },
        { ...listed, documents: [document] },
        { ...listed, documents: [] },
      ]);
      await harness.asSuperuser();
      const { rows } = await harness.client.query(
        "SELECT team_id, actor_id, auth_type, token_id, scopes, workspace_id, member_role, company_level, company_areas, plan_access FROM tenant_context.contexts WHERE xid::text = ANY($1::text[])",
        [xids],
      );
      expect(rows).toEqual(
        hints.map(() => ({
          team_id: memberA.teamId,
          actor_id: memberA.userId,
          auth_type: "session",
          token_id: null,
          scopes: [...memberA.scopes],
          workspace_id: COMPANY,
          member_role: "recruiter",
          company_level: null,
          company_areas: [],
          plan_access: false,
        })),
      );
    } finally {
      await harness.asOwner();
      await harness.client.query(
        `DELETE FROM app.config_objects WHERE id = '${objectId}'`,
      );
    }
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

  it("records MCP CV text reads only through audit_mcp_cv_read and its checks (0026)", async () => {
    const superuser = await harness.asSuperuser();
    const upload = async (
      teamId: string,
      candidateId: string,
      ready: boolean,
    ) => {
      const [{ id }] = (
        await superuser.execute<{ id: string }>(
          sql`INSERT INTO app.uploads(team_id,candidate_id,original_name,mime_type,size_bytes,object_key,storage_provider,storage_environment,storage_store,created_by,expires_at)
            VALUES (${teamId}, ${candidateId}::uuid, 'fictional-audit-name.pdf', 'application/pdf', 10, ${`teams/${teamId}/cvs/${randomUUID()}`}, 's3', 'development', 'fictional-tenant-bucket', ${teamId === ownerA.teamId ? ownerA.userId : ownerB.userId}, now() + interval '1 hour') RETURNING id`,
        )
      ).rows;
      if (ready)
        await superuser.execute(
          sql`UPDATE app.uploads SET status='ready', s3_version_id='fictional-v1', completed_at=now() WHERE id=${id}::uuid`,
        );
      return id;
    };
    const readyA = await upload(ownerA.teamId, candidateA, true);
    const pendingA = await upload(ownerA.teamId, candidateA, false);
    const readyB = await upload(ownerB.teamId, candidateB, true);
    const reader = await seedApiToken(await harness.asOwner(), memberA, [
      "cvs:read",
      "candidates:read",
    ]);
    const noCandidates = await seedApiToken(await harness.asOwner(), memberA, [
      "cvs:read",
      "recruitment:read",
    ]);
    const read = (p: Principal, tool: string, id: string) =>
      withTeam(p, async (tx) => {
        const { rows } = await tx.execute<{ candidate: string }>(
          sql`select tenant_context.audit_mcp_cv_read(${tool}, ${id}::uuid) as candidate`,
        );
        return rows[0].candidate;
      });
    const rows = async () =>
      (
        await (
          await harness.asSuperuser()
        ).execute<{
          record_id: string;
          actor_type: string;
          token_id: string;
          summary: string;
          metadata: unknown;
        }>(
          sql`select record_id, actor_type, token_id, summary, metadata from app.activity where action='mcp.cv_text_read' order by created_at, id`,
        )
      ).rows;
    const refused = { cause: { code: "42501" } };
    for (const [p, tool, id] of [
      [memberA, "get_cv_text", readyA],
      [
        { ...memberA, scopes: ["cvs:read", "candidates:read"] },
        "get_cv_text",
        readyA,
      ],
      [reader, "get_cv_text", readyB],
      [reader, "get_cv_text", pendingA],
      [reader, "get_cv_text", randomUUID()],
      [reader, "get_candidate", readyA],
      [reader, "fetch_cv", readyA],
      [noCandidates, "get_cv_text", readyA],
    ] as const)
      await expect(
        read(p as Principal, tool, id),
        `${p.authType} ${tool}`,
      ).rejects.toMatchObject(refused);
    await expect(
      (await asData()).query(
        `SELECT tenant_context.audit_mcp_cv_read('get_cv_text', '${readyA}')`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await rows()).toEqual([]);
    expect(await read(reader, "get_cv_texts", readyA)).toBe(candidateA);
    expect(await rows()).toEqual([
      {
        record_id: candidateA,
        actor_type: "token",
        token_id: reader.tokenId,
        summary: "MCP tool get_cv_texts read a CV's text",
        metadata: {
          tool: "get_cv_texts",
          uploadId: readyA,
          candidateId: candidateA,
          oauthClientId: null,
        },
      },
    ]);
    // The team setting off refuses with RQ003 and records nothing.
    await withTeam(ownerA, (tx) =>
      tx.execute(sql`select tenant_context.set_mcp_cv_text_access(false)`),
    );
    await expect(read(reader, "get_cv_text", readyA)).rejects.toMatchObject({
      cause: { code: "RQ003" },
    });
    await withTeam(ownerA, (tx) =>
      tx.execute(sql`select tenant_context.set_mcp_cv_text_access(true)`),
    );
    expect(await rows()).toHaveLength(1);
    // No runtime role writes the row itself.
    await expect(
      withTeam(reader, (tx) =>
        tx.insert(activity).values({
          teamId: reader.teamId,
          recordId: candidateA,
          actorId: reader.userId,
          actorType: "token",
          tokenId: reader.tokenId,
          action: "mcp.cv_text_read",
          kind: "mcp-tool",
          summary: "Forged CV text read",
        }),
      ),
    ).rejects.toMatchObject(refused);
    await expect(
      withTeam(
        { ...memberA, scopes: ["candidates:write", "cvs:write"] },
        (tx) =>
          tx.insert(activity).values({
            teamId: memberA.teamId,
            recordId: candidateA,
            actorId: memberA.userId,
            actorType: "session",
            action: "mcp.cv_text_read",
            kind: "mcp-tool",
            summary: "Forged CV text read",
          }),
      ),
    ).rejects.toMatchObject(refused);
    expect(await rows()).toHaveLength(1);
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

  it("caps the directory and plan scopes at the owner and admin team roles (0031)", async () => {
    const added = [
      "directory:read",
      "directory:write",
      "plans:read",
      "plans:write",
    ] as const;
    const db = await harness.asOwner();
    const seed = (role: Principal["role"]) =>
      seedIdentity(db, {
        userId: `ctx-ceiling-${role}`,
        teamId: "ctx-ceiling",
        role,
      });
    const teamOwner = await seed("owner");
    const teamAdmin = await seed("admin");
    const recruiter = await seed("recruiter");
    const viewer = await seed("viewer");
    for (const p of [recruiter, viewer]) {
      await dataTransaction(async () => {
        await install(await claimFor(p));
      });
      for (const scope of added) {
        const label = `${p.role} ${scope}`;
        await dataTransaction(async () => {
          await expect(
            install(await claimFor(p, { scopes: [...p.scopes, scope] })),
            label,
          ).rejects.toMatchObject(denied);
        });
        await expect(
          withTeam({ ...p, scopes: [...p.scopes, scope] }, () =>
            Promise.resolve(),
          ),
          label,
        ).rejects.toMatchObject({ status: 403, code: "tenant_context_denied" });
      }
    }
    for (const p of [teamOwner, teamAdmin]) {
      expect(p.scopes).toEqual([...SCOPES]);
      await dataTransaction(async () => {
        expect(
          await installed(await claimFor(p, { scopes: [...SCOPES] }), "{}"),
          p.role,
        ).toMatchObject({ scopes: [...SCOPES], memberRole: p.role });
      });
      expect(
        await withTeam(p, (tx, access) => Promise.resolve(access.scopes)),
        p.role,
      ).toEqual([...SCOPES]);
    }
    await dataTransaction(async () => {
      await expect(
        install(
          await claimFor(teamOwner, {
            scopes: ["plans:read", "directory:read"],
          }),
        ),
      ).rejects.toMatchObject(denied);
    });
  });

  // Configured roles (R2a-10, 0035): install narrows the asserted scopes to the assigned role's,
  // never widens them, and keeps every existing rejection above.
  describe("narrowing to an assigned configured role", () => {
    let assigned: Principal, plain: Principal, mismatched: Principal;
    let moved: Principal;
    let narrowRole: { objectId: string; versionId: string };
    let adminRole: { objectId: string; versionId: string };
    const OTHER = "00000000-0000-4000-a000-000000000002";
    const narrowScopes = roleScopes("recruiter").filter(
      (scope) => scope !== "cvs:write",
    );
    async function publish(key: string, body: unknown) {
      const { objectId, versionId } = await createConfigDraft(ownerA, {
        type: "role",
        key,
        body,
      });
      await publishConfigVersion(ownerA, versionId);
      return { objectId, versionId };
    }
    /** The company owner's own session writes the row, as the service does. */
    const assign = (p: Principal, objectId: string) =>
      withTeam({ ...ownerA, teamId: p.teamId }, (tx) =>
        tx.execute(
          sql`INSERT INTO app.member_roles(team_id, user_id, role_object_id) VALUES (${p.teamId}, ${p.userId}, ${objectId}::uuid)`,
        ),
      );
    /** A committed direct install; returns its result and the stored row. */
    async function direct(p: Principal, overrides: Partial<Claim> = {}) {
      const client = await asData();
      await client.exec("BEGIN");
      let result: unknown, xid: string;
      try {
        const claim = await claimFor(p, overrides);
        xid = claim.xid;
        result = await installed(claim, "{}");
        await client.exec("COMMIT");
      } catch (error) {
        await client.exec("ROLLBACK");
        throw error;
      }
      await harness.asSuperuser();
      const { rows } = await harness.client.query(
        "SELECT scopes, role_version_id FROM tenant_context.contexts WHERE xid::text = $1",
        [xid],
      );
      return { result: result as Record<string, unknown>, stored: rows[0] };
    }

    beforeAll(async () => {
      const db = await harness.asOwner();
      const seed = (userId: string, teamId = "ctx-a") =>
        seedIdentity(db, { userId, teamId, role: "recruiter" });
      assigned = await seed("ctx-role-assigned");
      plain = await seed("ctx-role-plain");
      mismatched = await seed("ctx-role-mismatch");
      // A team of its own, which a case moves to another workspace.
      moved = await seed("ctx-role-moved", "ctx-role-team");
      await seedIdentity(db, {
        userId: ownerA.userId,
        teamId: "ctx-role-team",
        role: "admin",
      });
      narrowRole = await publish("ctx-narrow", {
        ...structuredClone(RECRUITER_ROLE.body),
        name: "Fictional narrowed recruiter",
        scopes: narrowScopes,
      });
      // An admin-membership role holds scopes above the recruiter ceiling.
      adminRole = await publish("ctx-admin", {
        ...structuredClone(ADMIN_ROLE.body),
        name: "Fictional admin role",
      });
      await assign(assigned, narrowRole.objectId);
      await assign(mismatched, adminRole.objectId);
      await assign(moved, narrowRole.objectId);
    });

    it("stores and returns the asserted scopes intersected with the role's, and its version", async () => {
      const { result, stored } = await direct(assigned);
      expect(result).toMatchObject({
        scopes: narrowScopes,
        memberRole: "recruiter",
        roleVersionId: narrowRole.versionId,
      });
      expect(stored).toEqual({
        scopes: narrowScopes,
        role_version_id: narrowRole.versionId,
      });
      // A token of the member is narrowed the same way.
      const token = await seedApiToken(await harness.asOwner(), assigned);
      expect(
        await withTeam(token, (tx, access) => Promise.resolve(access)),
      ).toMatchObject({
        scopes: narrowScopes,
        roleVersionId: narrowRole.versionId,
      });
    });

    it("keeps a member without a row on the asserted scopes and the built-in version", async () => {
      const { result, stored } = await direct(plain);
      expect(result).toMatchObject({
        scopes: roleScopes("recruiter"),
        roleVersionId: RECRUITER_ROLE.versionId,
      });
      expect(stored).toEqual({
        scopes: roleScopes("recruiter"),
        role_version_id: RECRUITER_ROLE.versionId,
      });
    });

    it("stores a context asserting a scope the role lacks without it, and never widens", async () => {
      const { result, stored } = await direct(assigned, {
        scopes: ["candidates:read", "cvs:write"],
      });
      expect(result).toMatchObject({ scopes: ["candidates:read"] });
      expect(stored).toMatchObject({ scopes: ["candidates:read"] });
      // A role above the recruiter ceiling adds nothing: the stored scopes stay the asserted ones.
      const mismatch = await direct(mismatched);
      expect(mismatch.result).toMatchObject({
        scopes: roleScopes("recruiter"),
        roleVersionId: adminRole.versionId,
      });
      expect(mismatch.stored).toMatchObject({
        scopes: roleScopes("recruiter"),
      });
      // A scope outside the membership ceiling is still rejected, as before.
      for (const scope of ["imports:write", "directory:read"] as const) {
        await dataTransaction(async () => {
          await expect(
            install(
              await claimFor(mismatched, {
                scopes: SCOPES.filter(
                  (known) =>
                    known === scope || roleScopes("recruiter").includes(known),
                ),
              }),
            ),
            scope,
          ).rejects.toMatchObject(denied);
        });
      }
      await expect(
        withTeam({ ...mismatched, scopes: [...SCOPES] }, () =>
          Promise.resolve(),
        ),
      ).rejects.toMatchObject({ status: 403, code: "tenant_context_denied" });
    });

    it("fails closed for a role of another workspace than the context's", async () => {
      const db = await harness.asOwner();
      await db.execute(
        sql`INSERT INTO app.workspaces(id, name) VALUES (${OTHER}::uuid, 'Fictional Other Company')`,
      );
      await db.execute(
        sql`UPDATE app.workspace_teams SET workspace_id = ${OTHER}::uuid WHERE team_id = ${moved.teamId}`,
      );
      try {
        const { result, stored } = await direct(moved);
        expect(result).toMatchObject({
          scopes: [],
          workspaceId: OTHER,
          roleVersionId: null,
        });
        expect(stored).toEqual({ scopes: [], role_version_id: null });
      } finally {
        const owner = await harness.asOwner();
        await owner.execute(
          sql`UPDATE app.workspace_teams SET workspace_id = ${COMPANY}::uuid WHERE team_id = ${moved.teamId}`,
        );
        await owner.execute(
          sql`DELETE FROM app.workspaces WHERE id = ${OTHER}::uuid`,
        );
      }
      expect((await direct(moved)).stored).toEqual({
        scopes: narrowScopes,
        role_version_id: narrowRole.versionId,
      });
    });

    // R2a-18 (job 060): the record scope and the home units come back in the same statement.
    describe("record scope and home units (0037)", () => {
      let scoped: Principal, failing: Principal;
      let scopedRole: { objectId: string; versionId: string };
      let units: string[];
      const recordScope = {
        pipeline: "unit",
        candidates: "assigned",
        tasks: "all",
      } as const;
      /** The stored record scope and home units of the principal's committed install. */
      async function derived(p: Principal) {
        const client = await asData();
        await client.exec("BEGIN");
        let result: Record<string, unknown>, xid: string;
        try {
          const claim = await claimFor(p);
          xid = claim.xid;
          result = (await installed(claim, "{}")) as Record<string, unknown>;
          await client.exec("COMMIT");
        } catch (error) {
          await client.exec("ROLLBACK");
          throw error;
        }
        await harness.asSuperuser();
        const { rows } = await harness.client.query<Record<string, unknown>>(
          "SELECT scopes, role_version_id, record_scope, home_units FROM tenant_context.contexts WHERE xid::text = $1",
          [xid],
        );
        return { result, stored: rows[0] };
      }
      /** As the owner: the role object's current version, archive time or body changed in place. */
      const asOwnerSql = async (statement: string) => {
        await harness.asOwner();
        await harness.client.exec(statement);
      };

      beforeAll(async () => {
        const db = await harness.asOwner();
        scoped = await seedIdentity(db, {
          userId: "ctx-scope-member",
          teamId: "ctx-a",
          role: "recruiter",
        });
        failing = await seedIdentity(db, {
          userId: "ctx-scope-failing",
          teamId: "ctx-a",
          role: "recruiter",
        });
        scopedRole = await publish("ctx-scoped", {
          ...structuredClone(RECRUITER_ROLE.body),
          name: "Fictional scoped recruiter",
          recordScope,
        });
        await assign(scoped, scopedRole.objectId);
        await assign(failing, scopedRole.objectId);
        // Two units held through two current positions, a third through an ended one, and a fourth
        // through an archived position: only the first two are home units.
        units = await withTeam(ownerA, async (tx, access) => {
          const level = await tx.execute<{ id: string }>(
            sql`insert into app.org_levels(workspace_id, name, depth) values (${access.workspaceId}::uuid, 'Fictional scope level', 0) returning id`,
          );
          const { rows } = await tx.execute<{ id: string }>(
            sql`insert into app.org_units(workspace_id, level_id, name, code)
              select ${access.workspaceId}::uuid, ${level.rows[0].id}::uuid, 'Fictional scope unit ' || g, 'CTX-SCOPE-' || g
              from generate_series(1, 4) g order by g returning id`,
          );
          return rows.map((row) => row.id);
        });
        await withTeam(ownerA, async (tx, access) => {
          const positions = await tx.execute<{ id: string }>(
            sql`insert into app.positions(workspace_id, org_unit_id, title, code)
              select ${access.workspaceId}::uuid, u, 'Fictional scope desk ' || n, 'CTX-DESK-' || n
              from unnest(${`{${units.join(",")}}`}::uuid[]) with ordinality t(u, n) order by n returning id`,
          );
          const [employee] = (
            await tx.execute<{ id: string }>(
              sql`insert into app.employees(workspace_id, display_name, employee_number, user_id) values (${access.workspaceId}::uuid, 'Fictional Scope Member', 'CTX-EMP-1', ${scoped.userId}) returning id`,
            )
          ).rows;
          const desks = positions.rows.map((row) => row.id);
          await tx.execute(
            sql`insert into app.employee_positions(employee_id, position_id, workspace_id, "primary")
              select ${employee.id}::uuid, p, ${access.workspaceId}::uuid, n = 1
              from unnest(${`{${desks.join(",")}}`}::uuid[]) with ordinality t(p, n)`,
          );
          await tx.execute(
            sql`update app.employee_positions set valid_to = now() where employee_id = ${employee.id}::uuid and position_id = ${desks[2]}::uuid`,
          );
          await tx.execute(
            sql`update app.positions set archived_at = now() where id = ${desks[3]}::uuid`,
          );
        });
      });

      it("returns and stores a scoped role's record scope and the sorted home units, never failing it closed", async () => {
        const home = [...units.slice(0, 2)].sort();
        const { result, stored } = await derived(scoped);
        expect(result).toMatchObject({
          scopes: roleScopes("recruiter"),
          roleVersionId: scopedRole.versionId,
          recordScope,
          homeUnits: home,
        });
        expect(stored).toEqual({
          scopes: roleScopes("recruiter"),
          role_version_id: scopedRole.versionId,
          record_scope: recordScope,
          home_units: home,
        });
        // withTeam passes both to the work, for sessions and tokens alike.
        const token = await seedApiToken(await harness.asOwner(), scoped);
        for (const p of [scoped, token])
          expect(
            await withTeam(p, (tx, access) => Promise.resolve(access)),
            p.authType,
          ).toMatchObject({ recordScope, homeUnits: home });
        // A member without a row: all in every group, and no linked employee means no home units.
        expect((await derived(plain)).stored).toEqual({
          scopes: roleScopes("recruiter"),
          role_version_id: RECRUITER_ROLE.versionId,
          record_scope: { pipeline: "all", candidates: "all", tasks: "all" },
          home_units: [],
        });
      });

      it("still fails closed for an unpublished, malformed or archived role, with no record scope", async () => {
        const closed = {
          scopes: [],
          role_version_id: null,
          record_scope: null,
          home_units: [],
        };
        const { objectId, versionId } = scopedRole;
        // Unpublished: the object names no current version.
        await asOwnerSql(
          `UPDATE app.config_objects SET current_version_id = NULL WHERE id = '${objectId}'`,
        );
        expect((await derived(failing)).stored, "unpublished").toEqual(closed);
        expect((await derived(failing)).result).toMatchObject({
          scopes: [],
          roleVersionId: null,
          recordScope: null,
          homeUnits: [],
        });
        // Malformed: a published body whose record scope or scopes install cannot use.
        await asOwnerSql(
          `UPDATE app.config_objects SET current_version_id = '${versionId}' WHERE id = '${objectId}'`,
        );
        for (const [label, change] of [
          [
            "record scope",
            `jsonb_set(body, '{recordScope,pipeline}', '"team"')`,
          ],
          ["record scope type", `jsonb_set(body, '{recordScope}', '"unit"')`],
          ["scopes", `jsonb_set(body, '{scopes}', '"candidates:read"')`],
        ]) {
          await asOwnerSql(
            `ALTER TABLE app.config_versions DISABLE TRIGGER USER; UPDATE app.config_versions SET body = ${change} WHERE id = '${versionId}'; ALTER TABLE app.config_versions ENABLE TRIGGER USER`,
          );
          try {
            expect((await derived(failing)).stored, label).toEqual(closed);
          } finally {
            await asOwnerSql(
              `ALTER TABLE app.config_versions DISABLE TRIGGER USER; UPDATE app.config_versions SET body = '${JSON.stringify({ ...RECRUITER_ROLE.body, name: "Fictional scoped recruiter", recordScope })}' WHERE id = '${versionId}'; ALTER TABLE app.config_versions ENABLE TRIGGER USER`,
            );
          }
        }
        expect((await derived(failing)).stored.record_scope).toEqual(
          recordScope,
        );
        // Archived, last: an archived object stays archived.
        await asOwnerSql(
          `UPDATE app.config_objects SET archived_at = now() WHERE id = '${objectId}'`,
        );
        expect((await derived(failing)).stored, "archived").toEqual(closed);
      });

      // R2a-19 (job 061): the two helpers the new policies call read the verified context only.
      it("answers scope_is_all and context_actor_key per context kind, false and null without one (0038)", async () => {
        const answers = (p: Principal) =>
          withTeam(p, async (tx) => {
            const { rows } = await tx.execute<{
              everything: boolean;
              key: string | null;
            }>(
              sql`select tenant_context.scope_is_all() as everything, tenant_context.context_actor_key() as key`,
            );
            return rows[0];
          });
        const token = await seedApiToken(await harness.asOwner(), plain);
        expect(await answers(ownerA)).toEqual({
          everything: true,
          key: idempotencyActorKey(ownerA),
        });
        expect(await answers(plain)).toEqual({
          everything: true,
          key: `${plain.userId}:session:session`,
        });
        expect(await answers(token)).toEqual({
          everything: true,
          key: `${plain.userId}:token:${token.tokenId}`,
        });
        // A partial record scope and a role that failed closed (archived above) are not all.
        expect(await answers(scoped)).toEqual({
          everything: false,
          key: idempotencyActorKey(scoped),
        });
        expect((await derived(failing)).stored.record_scope).toBeNull();
        expect(await answers(failing)).toEqual({
          everything: false,
          key: idempotencyActorKey(failing),
        });
        const client = await asData();
        expect(
          (
            await client.query(
              "SELECT tenant_context.scope_is_all() AS everything, tenant_context.context_actor_key() AS key",
            )
          ).rows,
        ).toEqual([{ everything: false, key: null }]);
      });
    });
  });
});
