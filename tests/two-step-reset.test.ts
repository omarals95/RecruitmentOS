import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));

import { sql } from "drizzle-orm";
import { getVerifiedSession } from "@/lib/auth-session";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import { installTenantContext } from "../src/lib/tenant-context";
import { resetMemberTwoStep } from "../src/lib/two-step";
import type { Principal } from "../src/lib/principal";
import { POST as resetRoute } from "../src/app/api/v1/teams/two-step-reset/route";
import { resetTwoStepByEmail } from "../scripts/reset-two-step";
import {
  createSplitRoleDb,
  createTestDb,
  seedIdentity,
  splitRoles,
} from "./helpers/db";
import { stubLocalAuthReadiness } from "./helpers/readiness";

const ORIGIN = "http://localhost:3000";

describe("an owner resets a member's two-step sign-in under the split identity role", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  let owner: Principal, admin: Principal;
  const query = async <T>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  const count = async (text: string, params: unknown[] = []) =>
    Number((await query<{ count: number }>(text, params))[0].count);
  const audits = () =>
    query<{
      team_id: string;
      actor_id: string;
      actor_type: string;
      action: string;
      kind: string;
      summary: string;
      metadata: Record<string, unknown>;
    }>(
      "SELECT team_id, actor_id, actor_type, action, kind, summary, metadata FROM app.activity WHERE kind = 'account-security'",
    );
  /** Gives a fictional member two-step sign-in, two sessions, a trusted device and a pending challenge. */
  async function armTwoStep(userId: string) {
    await query(
      `UPDATE auth."user" SET two_factor_enabled = true WHERE id = $1`,
      [userId],
    );
    await query(
      `INSERT INTO auth.two_factor(user_id, secret, backup_codes) VALUES ($1, 'fictional-encrypted-secret', 'fictional-encrypted-codes')
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    for (const n of [1, 2])
      await query(
        `INSERT INTO auth.session(expires_at, token, user_id) VALUES (now() + interval '1 day', $1, $2)`,
        [`fictional-session-${userId}-${n}`, userId],
      );
    for (const identifier of [
      `trust-device-fictional-${userId}`,
      `2fa-fictional-${userId}`,
    ])
      await query(
        `INSERT INTO auth.verification(identifier, value, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
        [identifier, userId],
      );
  }
  const state = async (userId: string) => ({
    enabled: (
      await query<{ two_factor_enabled: boolean }>(
        `SELECT two_factor_enabled FROM auth."user" WHERE id = $1`,
        [userId],
      )
    )[0].two_factor_enabled,
    secrets: await count(
      "SELECT count(*)::int AS count FROM auth.two_factor WHERE user_id = $1",
      [userId],
    ),
    sessions: await count(
      "SELECT count(*)::int AS count FROM auth.session WHERE user_id = $1",
      [userId],
    ),
    challenges: await count(
      "SELECT count(*)::int AS count FROM auth.verification WHERE value = $1",
      [userId],
    ),
  });

  beforeAll(async () => {
    stubLocalAuthReadiness();
    harness = await createSplitRoleDb();
    pools.identity.mockImplementation(harness.identityDb);
    pools.data.mockRejectedValue(
      new Error("Two-step reset must not use the data pool."),
    );
    const db = await harness.asOwner();
    owner = await seedIdentity(db, { userId: "owner", teamId: "team" });
    admin = await seedIdentity(db, {
      userId: "admin",
      teamId: "team",
      role: "admin",
    });
    for (const userId of ["member", "plain", "second-owner"])
      await seedIdentity(db, {
        userId,
        teamId: "team",
        role: userId === "second-owner" ? "owner" : "recruiter",
        twoFactorEnabled: false,
      });
    await seedIdentity(db, {
      userId: "outsider",
      teamId: "other-team",
      twoFactorEnabled: false,
    });
    await armTwoStep("member");
    await armTwoStep("outsider");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness?.close();
  });

  it("removes the member's secret, flag, sessions and trusted devices and writes exactly one audit row", async () => {
    expect(await state("member")).toEqual({
      enabled: true,
      secrets: 1,
      sessions: 2,
      challenges: 2,
    });
    await resetMemberTwoStep(owner, "member");
    expect(await state("member")).toEqual({
      enabled: false,
      secrets: 0,
      sessions: 0,
      challenges: 0,
    });
    expect(await audits()).toEqual([
      {
        team_id: "team",
        actor_id: "owner",
        actor_type: "session",
        action: "two_step.reset",
        kind: "account-security",
        summary: "Reset a member's two-step sign-in",
        metadata: { targetUserId: "member" },
      },
    ]);
    expect(pools.data).not.toHaveBeenCalled();
  });

  it("refuses admins, self, non-members and members with nothing to reset without writing anything", async () => {
    await armTwoStep("member");
    const before = await audits();
    for (const [principal, target, status, code] of [
      [admin, "member", 403, "owner_required"],
      [owner, "owner", 400, "cannot_reset_self"],
      [owner, "outsider", 404, "member_not_found"],
      [owner, "nobody", 404, "member_not_found"],
      [owner, "plain", 409, "two_step_not_enabled"],
    ] as const)
      await expect(
        resetMemberTwoStep(principal, target),
        `${principal.userId} -> ${target}`,
      ).rejects.toMatchObject({ status, code });
    expect(await audits()).toEqual(before);
    expect(await state("member")).toMatchObject({ enabled: true, secrets: 1 });
    expect(await state("outsider")).toMatchObject({
      enabled: true,
      secrets: 1,
    });
  });

  it("refuses a member who also belongs to a team the owner does not own, in the app and in the helper", async () => {
    await query(
      `INSERT INTO auth.member(id,organization_id,user_id,role) VALUES('member:other-team','other-team','member','recruiter')`,
    );
    try {
      const before = await audits();
      await expect(resetMemberTwoStep(owner, "member")).rejects.toMatchObject({
        status: 409,
        code: "member_in_other_team",
      });
      // The helper refuses on its own too, even when called directly under a valid owner context.
      const identity = await harness.identityDb();
      await expect(
        withDeadlinesAndSnapshot(identity, async (tx, snapshot) => {
          await installTenantContext(tx, owner, snapshot);
          await tx.execute(sql`select tenant_context.reset_two_step('member')`);
        }),
      ).rejects.toMatchObject({ cause: { code: "RQ004" } });
      expect(await audits()).toEqual(before);
      expect(await state("member")).toEqual({
        enabled: true,
        secrets: 1,
        sessions: 2,
        challenges: 2,
      });
    } finally {
      await query(`DELETE FROM auth.member WHERE id='member:other-team'`);
    }
  });

  it("answers the session-only route with {data:{reset:true}} and refuses Bearer tokens", async () => {
    await armTwoStep("second-owner");
    vi.mocked(getVerifiedSession).mockResolvedValue({
      user: { id: "owner", emailVerified: true, twoFactorEnabled: true },
      session: { activeOrganizationId: "team", createdAt: new Date() },
    } as never);
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      resetRoute(
        new Request(`${ORIGIN}/api/v1/teams/two-step-reset`, {
          method: "POST",
          headers: {
            origin: ORIGIN,
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify(body),
        }),
      );
    const reset = await post({ userId: "second-owner" });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ data: { reset: true } });
    expect(await state("second-owner")).toMatchObject({
      enabled: false,
      secrets: 0,
    });
    const again = await post({ userId: "second-owner" });
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("two_step_not_enabled");
    const bearer = await post(
      { userId: "member" },
      { authorization: "Bearer ros_live_fictional" },
    );
    expect(bearer.status).toBe(403);
    expect((await bearer.json()).error.code).toBe("session_required");
    expect((await post({ userId: "member", extra: true })).status).toBe(400);
  });

  it("keeps the helper and account-security rows out of the data role's reach", async () => {
    await harness.dataDb();
    await expect(
      harness.client.query("SELECT tenant_context.reset_two_step('member')"),
    ).rejects.toMatchObject({ code: "42501" });
    for (const role of ["dataDb", "identityDb"] as const) {
      await harness[role]();
      await expect(
        harness.client.query(
          "INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary,metadata) VALUES('team','owner','session','two_step.reset','account-security','Forged','{}')",
        ),
        role,
      ).rejects.toMatchObject({ code: "42501" });
    }
    // Without a verified context the identity role's helper call is refused.
    await harness.identityDb();
    await expect(
      harness.client.query("SELECT tenant_context.reset_two_step('member')"),
    ).rejects.toMatchObject({ code: "42501" });
    await harness.asSuperuser();
    expect(
      (
        await harness.client.query<{ identity: boolean; data: boolean }>(
          `SELECT has_function_privilege('${splitRoles.identity}','tenant_context.reset_two_step(text)','EXECUTE') AS identity,
            has_function_privilege('${splitRoles.data}','tenant_context.reset_two_step(text)','EXECUTE') AS data`,
        )
      ).rows,
    ).toEqual([{ identity: true, data: false }]);
  });

  it("lets the database owner's recovery script reset the last owner with one audit row per team", async () => {
    const db = await harness.asOwner();
    await harness.client.exec(
      `INSERT INTO auth.member(id,organization_id,user_id,role) VALUES('owner:other-team','other-team','owner','admin')`,
    );
    await armTwoStep("owner");
    expect(
      await resetTwoStepByEmail(await harness.asOwner(), "OWNER@example.test"),
    ).toBe(true);
    expect(await state("owner")).toEqual({
      enabled: false,
      secrets: 0,
      sessions: 0,
      challenges: 0,
    });
    const rows = (await audits()).filter((row) => row.actor_id === "owner");
    const scripted = rows.filter(
      (row) => row.summary === "Two-step sign-in reset by the database owner",
    );
    expect(scripted.map((row) => row.team_id).sort()).toEqual([
      "other-team",
      "team",
    ]);
    for (const row of scripted)
      expect(row).toMatchObject({
        actor_type: "session",
        action: "two_step.reset",
        kind: "account-security",
        metadata: { targetUserId: "owner", method: "owner-script" },
      });
    expect(await resetTwoStepByEmail(db, "nobody@example.test")).toBe(false);
  });
});

describe("the recovery script on a plain local PGlite database", () => {
  it("resets a fictional owner and reports an unknown address", async () => {
    const fixture = await createTestDb();
    try {
      await seedIdentity(fixture.db, { userId: "solo", teamId: "solo-team" });
      expect(await resetTwoStepByEmail(fixture.db, "solo@example.test")).toBe(
        true,
      );
      expect(
        (
          await fixture.client.query(
            `SELECT two_factor_enabled FROM auth."user" WHERE id='solo'`,
          )
        ).rows,
      ).toEqual([{ two_factor_enabled: false }]);
      expect(
        (
          await fixture.client.query(
            "SELECT team_id FROM app.activity WHERE kind='account-security'",
          )
        ).rows,
      ).toEqual([{ team_id: "solo-team" }]);
      expect(
        await resetTwoStepByEmail(fixture.db, "unknown@example.test"),
      ).toBe(false);
    } finally {
      await fixture.close();
    }
  });
});
