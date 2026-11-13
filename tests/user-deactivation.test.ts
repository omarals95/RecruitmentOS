import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requests pick the pool by role, as on a split-role deployment: the identity role reads the
// membership and runs Sign out everywhere and Clear lockout, the data role runs withTeam. Only one
// PGlite role is active at a time.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));

import { sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import type { RoleBody } from "@/domain/config";
import { RECRUITER_ROLE } from "@/domain/config-defaults";
import { getVerifiedSession } from "@/lib/auth-session";
import { signInBackoffKey } from "@/lib/client-ip";
import { createConfigDraft, publishConfigVersion } from "@/lib/config-store";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import { SCOPES } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import { createRecord } from "@/lib/records";
import { installTenantContext } from "@/lib/tenant-context";
import { setUserActive, userAccountError } from "@/lib/user-account";
import { GET as usersRoute } from "@/app/api/v1/admin/users/route";
import { GET as personRoute } from "@/app/api/v1/admin/users/[user]/route";
import { PUT as statusRoute } from "@/app/api/v1/admin/users/[user]/status/route";
import { POST as signOutRoute } from "@/app/api/v1/admin/users/[user]/sign-out/route";
import { POST as clearLockoutRoute } from "@/app/api/v1/admin/users/[user]/clear-lockout/route";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace with fictional teams and people, and a second
// workspace the owner role inserts (ADM-09, job 082).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const SECOND = "00000000-0000-4000-a000-000000000082";
const ORIGIN = "http://localhost:3000";
const SECRET = "fictional-deactivation-test-secret-0123456789";
const DEACTIVATED_MESSAGE =
  "Your account has been deactivated. Ask a company owner or admin to reactivate it.";
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Action = "status" | "sign-out" | "clear-lockout";
const ACTIONS: Action[] = ["status", "sign-out", "clear-lockout"];
const routes = {
  status: statusRoute,
  "sign-out": signOutRoute,
  "clear-lockout": clearLockoutRoute,
};

/** The SQLSTATE of a refused helper call, the code of a refused service call, or ok. */
const outcome = (work: Promise<unknown>) =>
  work.then(
    () => "ok",
    (error: { code?: string; cause?: { code?: string } }) =>
      error.cause?.code ?? error.code,
  );

describe("company-level deactivation, sign out everywhere and clear lockout", () => {
  let harness: Harness;
  let owner: Principal, owner2: Principal, peopleAdmin: Principal;
  let peopleAdmin2: Principal, fieldsAdmin: Principal, suspended: Principal;
  let teamOwnerB: Principal, recruiter: Principal, member: Principal;
  let other: Principal, outsider: Principal;
  let memberToken: Principal, memberGrant: Principal, ownerToken: Principal;

  /** Raw statements as the PGlite superuser, which bypasses RLS; only to arrange or inspect. */
  const superuser = async <T>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  const signIn = (p: Principal, fresh = true) =>
    vi.mocked(getVerifiedSession).mockResolvedValue({
      user: { id: p.userId, twoFactorEnabled: true },
      session: {
        activeOrganizationId: p.teamId,
        // ADM-06: younger than 15 minutes, or a stale one.
        createdAt: new Date(Date.now() - (fresh ? 1_000 : 16 * 60_000)),
      },
    } as never);
  /** One of the three routes as a signed-in member or a Bearer token. */
  async function call(
    as: Principal | "bearer",
    action: Action,
    target: string,
    options: {
      active?: boolean;
      body?: string;
      query?: string;
      stale?: boolean;
    } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; text: string; body: any }> {
    if (as !== "bearer") signIn(as, !options.stale);
    const headers: Record<string, string> = {
      origin: ORIGIN,
      ...(as === "bearer"
        ? { authorization: "Bearer fictional-account-token" }
        : { "x-team-id": as.teamId }),
    };
    const url = `${ORIGIN}/api/v1/admin/users/${encodeURIComponent(target)}/${action}${options.query ?? ""}`;
    const request =
      action === "status"
        ? new Request(url, {
            method: "PUT",
            headers: { ...headers, "content-type": "application/json" },
            body: options.body ?? JSON.stringify({ active: options.active }),
          })
        : new Request(url, { method: "POST", headers });
    const response = await routes[action](request, {
      params: Promise.resolve({ user: target }),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  }
  /** The Users list or one person, as a signed-in member. */
  async function read(p: Principal, path: string) {
    signIn(p);
    const url = new URL(`${ORIGIN}/api/v1/admin/users${path}`);
    const request = new Request(url, {
      headers: { origin: ORIGIN, "x-team-id": p.teamId },
    });
    const target = /^\/([^/?]+)/.exec(path)?.[1];
    const response = target
      ? await personRoute(request, {
          params: Promise.resolve({ user: decodeURIComponent(target) }),
        })
      : await usersRoute(request);
    return {
      status: response.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (await response.json()) as any,
    };
  }
  /** tenant_context.set_user_active on the data role, in the principal's installed context. */
  const setActive = (p: Principal, target: string | null, active: unknown) =>
    withTeam(
      p,
      async (tx) =>
        (
          await tx.execute<{ changed: boolean }>(
            sql`select tenant_context.set_user_active(${target}::text, ${active}::boolean) as changed`,
          )
        ).rows[0].changed,
    );
  /** tenant_context.user_account_action on the identity role, as the services call it. */
  const accountAction = async (
    p: Principal,
    target: string | null,
    action: string | null,
  ) =>
    withDeadlinesAndSnapshot(
      await harness.identityDb(),
      async (tx, snapshot) => {
        await installTenantContext(tx, p, snapshot);
        await tx.execute(
          sql`select tenant_context.user_account_action(${target}::text, ${action}::text)`,
        );
      },
    );
  /** A tenant_context.install signed in the test, sent as plain SQL by the data role. */
  async function directInstall(p: Principal) {
    const key = Buffer.from(
      process.env.TENANT_CONTEXT_SIGNING_KEY!,
      "base64url",
    );
    return withDeadlinesAndSnapshot(
      await harness.dataDb(),
      async (tx, snapshot) => {
        const payload = JSON.stringify({
          aud: "recruitmentos-tenant-context-v1",
          kid: createHash("sha256").update(key).digest("hex").slice(0, 16),
          env: snapshot.env,
          pid: Number(snapshot.pid),
          xid: snapshot.xid,
          team: p.teamId,
          actor: p.userId,
          auth: p.authType,
          token: p.authType === "token" ? p.tokenId : null,
          scopes: SCOPES.filter((scope) => p.scopes.includes(scope)),
          exp: Number(snapshot.now) + 30_000,
        });
        const signature = createHmac("sha256", key)
          .update(payload)
          .digest("hex");
        await tx.execute(
          sql`select tenant_context.install(${payload}, ${signature}, '{}'::text[])`,
        );
      },
    );
  }
  const access = (p: Principal) =>
    withTeam({ ...p, scopes: [...p.scopes] }, (_tx, state) =>
      Promise.resolve(state),
    );
  /** Everything deactivation must leave alone, byte for byte. */
  const preserved = async () => ({
    members: await superuser(
      "SELECT id, organization_id, user_id, role, created_at FROM auth.member ORDER BY id",
    ),
    roles: await superuser(
      "SELECT * FROM app.member_roles ORDER BY team_id, user_id",
    ),
    assignments: await superuser(
      "SELECT * FROM app.record_assignments ORDER BY record_id, user_id, relation",
    ),
    admins: await superuser(
      "SELECT * FROM app.workspace_admins ORDER BY workspace_id, user_id",
    ),
    tokens: await superuser("SELECT * FROM auth.api_tokens ORDER BY id"),
    sessions: await superuser("SELECT * FROM auth.session ORDER BY id"),
    history: await superuser(
      "SELECT * FROM app.activity WHERE kind <> 'user-account' ORDER BY id",
    ),
  });
  const auditRows = () =>
    superuser<Record<string, unknown>>(
      "SELECT team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata FROM app.activity WHERE kind = 'user-account' ORDER BY created_at, id",
    );
  const deactivationRows = () =>
    superuser<Record<string, unknown>>(
      "SELECT workspace_id::text, user_id, deactivated_at IS NOT NULL AS deactivated, deactivated_by FROM app.workspace_users ORDER BY user_id",
    );
  const sessionsOf = async (userId: string) =>
    (
      await superuser<{ id: string }>(
        "SELECT id FROM auth.session WHERE user_id = $1 ORDER BY id",
        [userId],
      )
    ).map((row) => row.id);
  const backoffKeys = async () =>
    (
      await superuser<{ key: string }>(
        "SELECT key FROM auth.api_rate_limits ORDER BY key",
      )
    ).map((row) => row.key);
  const emailOf = (p: Principal) => `${p.userId}@example.test`;

  beforeAll(async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, {
      userId: "deact-owner",
      teamId: "deact-team-a",
    });
    owner2 = await seedIdentity(db, {
      userId: "deact-owner-2",
      teamId: "deact-team-a",
      role: "admin",
    });
    peopleAdmin = await seedIdentity(db, {
      userId: "deact-people-admin",
      teamId: "deact-team-a",
      role: "recruiter",
    });
    peopleAdmin2 = await seedIdentity(db, {
      userId: "deact-people-admin-2",
      teamId: "deact-team-a",
      role: "recruiter",
    });
    fieldsAdmin = await seedIdentity(db, {
      userId: "deact-fields-admin",
      teamId: "deact-team-a",
      role: "recruiter",
    });
    suspended = await seedIdentity(db, {
      userId: "deact-suspended",
      teamId: "deact-team-a",
      role: "viewer",
    });
    recruiter = await seedIdentity(db, {
      userId: "deact-recruiter",
      teamId: "deact-team-a",
      role: "recruiter",
    });
    // The main target: a recruiter in team A and a viewer in team B, with a configured role, a
    // record assignment, an API token, an OAuth grant, sessions and a sign-in backoff.
    member = await seedIdentity(db, {
      userId: "deact-member",
      teamId: "deact-team-a",
      role: "recruiter",
    });
    other = await seedIdentity(db, {
      userId: "deact-other",
      teamId: "deact-team-a",
      role: "viewer",
    });
    // A team-only owner of team B.
    teamOwnerB = await seedIdentity(db, {
      userId: "deact-team-owner-b",
      teamId: "deact-team-b",
    });
    await seedIdentity(db, {
      userId: "deact-member",
      teamId: "deact-team-b",
      role: "viewer",
    });
    // Someone only in a team of a second workspace.
    outsider = await seedIdentity(db, {
      userId: "deact-outsider",
      teamId: "deact-team-d",
    });
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','deact-owner-2','owner','{}'),
        ('${COMPANY}','deact-people-admin','admin','{people}'),
        ('${COMPANY}','deact-people-admin-2','admin','{people,fields}'),
        ('${COMPANY}','deact-fields-admin','admin','{fields}');
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas,suspended_at) VALUES
        ('${COMPANY}','deact-suspended','admin','{fields}',now());
      INSERT INTO app.workspaces(id,name) VALUES ('${SECOND}','Fictional Second Company');
      UPDATE app.workspace_teams SET workspace_id = '${SECOND}' WHERE team_id = 'deact-team-d';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${SECOND}','deact-outsider','owner','{}');`);
    // A configured role for the member, published by the company owner.
    await harness.dataDb();
    const { versionId } = await createConfigDraft(owner, {
      type: "role",
      key: "fictional-deactivation-sourcer",
      body: {
        ...structuredClone(RECRUITER_ROLE.body as RoleBody),
        name: "Fictional Deactivation Sourcer",
      },
    });
    await harness.dataDb();
    await publishConfigVersion(owner, versionId);
    const [{ id: roleObjectId }] = await superuser<{ id: string }>(
      "SELECT object_id::text AS id FROM app.config_versions WHERE id = $1",
      [versionId],
    );
    await superuser(
      "INSERT INTO app.member_roles(team_id, user_id, role_object_id) VALUES ('deact-team-a', 'deact-member', $1)",
      [roleObjectId],
    );
    await harness.dataDb();
    const candidate = await createRecord(owner, "candidates", {
      data: { name: "Fictional Deactivation Candidate" },
    });
    memberToken = await seedApiToken(await harness.asOwner(), member, [
      "candidates:read",
    ]);
    ownerToken = await seedApiToken(await harness.asOwner(), owner);
    const clientId = `ros_client_${randomBytes(16).toString("base64url")}`;
    const grantId = randomUUID();
    await superuser(
      `INSERT INTO auth.oauth_clients(id,name,redirect_uris) VALUES($1,'Fictional Connector','["https://claude.ai/api/mcp/auth_callback"]')`,
      [clientId],
    );
    await superuser(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at,oauth_client_id)
        VALUES($1,'deact-team-a','deact-member','Fictional grant',$2,'ros_oat_fiction','["candidates:read"]',now()+interval '1 day',$3)`,
      [grantId, randomBytes(32).toString("hex"), clientId],
    );
    memberGrant = {
      ...member,
      scopes: ["candidates:read"],
      authType: "token",
      tokenId: grantId,
      oauthClientId: clientId,
    };
    await superuser(
      "INSERT INTO app.record_assignments(team_id, record_id, user_id, relation, created_by) VALUES ('deact-team-a', $1, 'deact-member', 'recruiter', 'deact-owner')",
      [candidate.id],
    );
    // Names that differ from every id; the member's earlier activity, sessions and backoff rows.
    await harness.asSuperuser();
    await harness.client.exec(`
      UPDATE auth."user" SET name = 'Fictional ' || initcap(replace(id, '-', ' ')) WHERE id LIKE 'deact-%';
      INSERT INTO app.activity(team_id, actor_id, actor_type, action, kind, summary, metadata) VALUES
        ('deact-team-a', 'deact-member', 'session', 'personal_state_updated', 'candidate', 'Fictional earlier event', '{}');`);
    for (const [index, p] of [member, member, other, owner].entries())
      await superuser(
        "INSERT INTO auth.session(id, expires_at, token, created_at, updated_at, user_id) VALUES ($1, now() + interval '1 day', $2, now(), now(), $3)",
        [`deact-session-${index}`, `fictional-deact-token-${index}`, p.userId],
      );
    for (const p of [member, other])
      await superuser(
        "INSERT INTO auth.api_rate_limits(key, window_start, count) VALUES ($1, now(), 7)",
        [signInBackoffKey(emailOf(p), SECRET)],
      );
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness?.close();
  });

  it("lets a company owner change a member, a company admin and another company owner", async () => {
    for (const target of [member, peopleAdmin2, owner2]) {
      const label = target.userId;
      expect(
        (await call(owner, "status", target.userId, { active: false })).body,
        label,
      ).toEqual({ data: { active: false, changed: true } });
      expect(
        (await read(owner, `/${target.userId}`)).body.data.status,
        label,
      ).toBe("deactivated");
      expect(
        (await call(owner, "status", target.userId, { active: true })).body,
        label,
      ).toEqual({ data: { active: true, changed: true } });
      expect(
        (await call(owner, "sign-out", target.userId)).body,
        label,
      ).toEqual({ data: { signedOut: true } });
      expect(
        (await call(owner, "clear-lockout", target.userId)).body,
        label,
      ).toEqual({ data: { cleared: true } });
      // The helpers themselves, on the data and identity roles.
      expect(await setActive(owner, target.userId, false), label).toBe(true);
      expect(await setActive(owner, target.userId, true), label).toBe(true);
      for (const action of ["sign_out", "clear_lockout"])
        expect(
          await outcome(accountAction(owner, target.userId, action)),
          label,
        ).toBe("ok");
    }
    expect(await deactivationRows()).toEqual(
      [member, owner2, peopleAdmin2]
        .map((p) => ({
          workspace_id: COMPANY,
          user_id: p.userId,
          deactivated: false,
          deactivated_by: null,
        }))
        .sort((a, b) => a.user_id.localeCompare(b.user_id)),
    );
  });

  it("lets a company admin with people change a member without company authority", async () => {
    expect(
      (await call(peopleAdmin, "status", member.userId, { active: false }))
        .body,
    ).toEqual({ data: { active: false, changed: true } });
    expect(
      (await call(peopleAdmin, "status", member.userId, { active: true })).body,
    ).toEqual({ data: { active: true, changed: true } });
    expect((await call(peopleAdmin, "sign-out", member.userId)).status).toBe(
      200,
    );
    expect(
      (await call(peopleAdmin, "clear-lockout", member.userId)).status,
    ).toBe(200);
    expect(await setActive(peopleAdmin, member.userId, false)).toBe(true);
    expect(await setActive(peopleAdmin, member.userId, true)).toBe(true);
    // A team-only owner has no company authority either.
    expect(await setActive(peopleAdmin, teamOwnerB.userId, false)).toBe(true);
    expect(await setActive(peopleAdmin, teamOwnerB.userId, true)).toBe(true);
    for (const action of ["sign_out", "clear_lockout"])
      expect(
        await outcome(accountAction(peopleAdmin, member.userId, action)),
      ).toBe("ok");
  });

  it("refuses a company admin with people on a company admin, an owner and a suspended authority holder", async () => {
    const before = { audit: await auditRows(), rows: await deactivationRows() };
    for (const target of [peopleAdmin2, owner, owner2, suspended]) {
      const label = target.userId;
      for (const action of ACTIONS) {
        const { status, body } = await call(
          peopleAdmin,
          action,
          target.userId,
          { active: false },
        );
        expect(status, `${label} ${action}`).toBe(403);
        expect(body.error, `${label} ${action}`).toMatchObject({
          code: "company_owner_required",
          message: "Only a company owner can change a company owner or admin.",
        });
      }
      expect(await outcome(setActive(peopleAdmin, target.userId, false))).toBe(
        "42501",
      );
      for (const action of ["sign_out", "clear_lockout"])
        expect(
          await outcome(accountAction(peopleAdmin, target.userId, action)),
          label,
        ).toBe("42501");
    }
    expect(await auditRows()).toEqual(before.audit);
    expect(await deactivationRows()).toEqual(before.rows);
  });

  it("refuses a company admin without people, a team-only owner, a recruiter and token contexts", async () => {
    const before = { audit: await auditRows(), rows: await deactivationRows() };
    for (const p of [fieldsAdmin, teamOwnerB, recruiter]) {
      for (const action of ACTIONS) {
        const { status, body } = await call(p, action, other.userId, {
          active: false,
        });
        expect(status, `${p.userId} ${action}`).toBe(403);
        expect(body.error.code, `${p.userId} ${action}`).toBe(
          "people_forbidden",
        );
      }
      expect(await outcome(setActive(p, other.userId, false)), p.userId).toBe(
        "42501",
      );
      for (const action of ["sign_out", "clear_lockout"])
        expect(
          await outcome(accountAction(p, other.userId, action)),
          p.userId,
        ).toBe("42501");
    }
    // A company owner's API token: the helpers need a session context.
    expect(await outcome(setActive(ownerToken, other.userId, false))).toBe(
      "42501",
    );
    expect(
      await outcome(accountAction(ownerToken, other.userId, "sign_out")),
    ).toBe("42501");
    // The service refuses a token before any database call.
    const calls = [
      pools.data.mock.calls.length,
      pools.identity.mock.calls.length,
    ];
    await expect(
      setUserActive(ownerToken, other.userId, false),
    ).rejects.toMatchObject({ status: 403, code: "people_forbidden" });
    expect([
      pools.data.mock.calls.length,
      pools.identity.mock.calls.length,
    ]).toEqual(calls);
    expect(await auditRows()).toEqual(before.audit);
    expect(await deactivationRows()).toEqual(before.rows);
  });

  it("refuses a Bearer token on every route with session_required and no database call", async () => {
    for (const action of ACTIONS) {
      const calls = [
        pools.data.mock.calls.length,
        pools.identity.mock.calls.length,
      ];
      const { status, body } = await call("bearer", action, member.userId, {
        active: false,
      });
      expect(status, action).toBe(403);
      expect(body.error.code, action).toBe("session_required");
      expect(
        [pools.data.mock.calls.length, pools.identity.mock.calls.length],
        action,
      ).toEqual(calls);
    }
  });

  it("refuses the caller's own account in the service and in the helpers", async () => {
    for (const action of ACTIONS) {
      const calls = [
        pools.data.mock.calls.length,
        pools.identity.mock.calls.length,
      ];
      const { status, body } = await call(owner, action, owner.userId, {
        active: false,
      });
      expect(status, action).toBe(400);
      expect(body.error, action).toMatchObject({
        code: "cannot_change_self",
        message: "You cannot change your own account here.",
      });
      // Only the session's membership lookup ran.
      expect(
        [pools.data.mock.calls.length, pools.identity.mock.calls.length],
        action,
      ).toEqual([calls[0], calls[1] + 1]);
    }
    // Another active owner exists, so the self check answers.
    expect(await outcome(setActive(owner2, owner2.userId, false))).toBe(
      "RQ018",
    );
    for (const action of ["sign_out", "clear_lockout"])
      expect(await outcome(accountAction(owner, owner.userId, action))).toBe(
        "RQ018",
      );
  });

  it("refuses the last active company owner, and two owners deactivating each other leave one", async () => {
    // The owner deactivates the second owner; the second owner is then refused everywhere.
    expect(
      (await call(owner, "status", owner2.userId, { active: false })).body,
    ).toEqual({ data: { active: false, changed: true } });
    const refused = await call(owner2, "status", owner.userId, {
      active: false,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toEqual({
      code: "account_deactivated",
      message: DEACTIVATED_MESSAGE,
      correlationId: expect.any(String),
    });
    expect(await outcome(setActive(owner2, owner.userId, false))).toBe(
      "account_deactivated",
    );
    // The sole active owner cannot deactivate themselves: the last-owner check comes first.
    expect(await outcome(setActive(owner, owner.userId, false))).toBe("RQ005");
    // Nor remove their own company authority while the other owner is deactivated.
    const admins = await superuser(
      "SELECT * FROM app.workspace_admins ORDER BY user_id",
    );
    expect(
      await outcome(
        withTeam(owner, (tx) =>
          tx.execute(
            sql`select tenant_context.set_workspace_authority(${owner.userId}, NULL, NULL, NULL)`,
          ),
        ),
      ),
    ).toBe("RQ005");
    expect(
      await superuser("SELECT * FROM app.workspace_admins ORDER BY user_id"),
    ).toEqual(admins);
    expect(
      (await call(owner, "status", owner2.userId, { active: true })).body.data,
    ).toEqual({ active: true, changed: true });
    // Both act at once: the second owner installed a context before the first's deactivation of
    // them committed. The recheck under the workspace lock refuses it, and nothing is written.
    await expect(
      withTeam(owner2, async (tx) => {
        await tx.execute(sql.raw("SET SESSION AUTHORIZATION postgres"));
        await tx.execute(
          sql`UPDATE app.workspace_users SET deactivated_at = now(), deactivated_by = ${owner.userId} WHERE user_id = ${owner2.userId}`,
        );
        await tx.execute(
          sql.raw("SET SESSION AUTHORIZATION recruitmentos_data"),
        );
        await tx.execute(
          sql`select tenant_context.set_user_active(${owner.userId}::text, false)`,
        );
      }),
    ).rejects.toMatchObject({
      cause: { code: "42501", message: "User account change rejected" },
    });
    const { body } = await read(owner, "?level=owner");
    expect(
      body.data.map((row: { userId: string; status: string }) => [
        row.userId,
        row.status,
      ]),
    ).toEqual([
      [owner.userId, "active"],
      [owner2.userId, "active"],
    ]);
  });

  it("answers user_not_found for a person outside the company and an unknown id", async () => {
    for (const target of [outsider.userId, "deact-unknown"]) {
      for (const action of ACTIONS) {
        const { status, body, text } = await call(owner, action, target, {
          active: false,
        });
        expect(status, `${target} ${action}`).toBe(404);
        expect(body.error).toMatchObject({
          code: "user_not_found",
          message: "This person is not in any team of your company.",
        });
        expect(text).not.toContain("Fictional Deact Outsider");
      }
      expect(await outcome(setActive(owner, target, false))).toBe("RQ006");
      expect(await outcome(accountAction(owner, target, "sign_out"))).toBe(
        "RQ006",
      );
    }
  });

  it("refuses the deactivated person's session, API token, OAuth grant and a direct install, and reactivation restores the same access", async () => {
    const before = await access(member);
    const tokenBefore = await access(memberToken);
    const state = await preserved();
    expect(state.roles).toHaveLength(1);
    expect(state.assignments).toHaveLength(1);
    expect(
      (await call(peopleAdmin, "status", member.userId, { active: false }))
        .status,
    ).toBe(200);
    for (const p of [member, memberToken, memberGrant])
      await expect(
        withTeam(p, () => Promise.resolve()),
        p.authType,
      ).rejects.toMatchObject({
        status: 403,
        code: "account_deactivated",
        message: DEACTIVATED_MESSAGE,
      });
    // Plain SQL by the data role, in a new transaction after the change committed.
    await expect(directInstall(member)).rejects.toMatchObject({
      cause: { code: "42501", message: "Account deactivated" },
    });
    // Every route answers the same, before any other check.
    const listed = await read(member, "");
    expect(listed.status).toBe(403);
    expect(listed.body.error.code).toBe("account_deactivated");
    // Nothing else changed: memberships, roles, assignments, authority, tokens, sessions, history.
    expect(await preserved()).toEqual(state);
    expect(
      (await call(peopleAdmin, "status", member.userId, { active: true }))
        .status,
    ).toBe(200);
    expect(await access(member)).toEqual(before);
    expect(await access(memberToken)).toEqual(tokenBefore);
    expect((await access(memberGrant)).scopes).toEqual(["candidates:read"]);
    expect(before).toMatchObject({
      memberRole: "recruiter",
      companyLevel: null,
      roleVersionId: expect.any(String),
    });
    expect(before.roleVersionId).not.toBe(
      "00000000-0000-4000-8000-000000000103",
    );
    await directInstall(member);
    expect(await preserved()).toEqual(state);
  });

  it("writes exactly one ids-only audit row per change and none for a repeat", async () => {
    const start = (await auditRows()).length;
    const added = async () => (await auditRows()).slice(start);
    const row = (action: string) => ({
      team_id: owner.teamId,
      record_id: null,
      actor_id: owner.userId,
      actor_type: "session",
      token_id: null,
      action,
      kind: "user-account",
      summary: expect.any(String),
      metadata: { targetUserId: member.userId },
    });
    const steps: [Action, boolean | undefined, boolean | null][] = [
      ["status", false, true],
      ["status", false, false],
      ["status", true, true],
      ["status", true, false],
      ["sign-out", undefined, null],
      ["sign-out", undefined, null],
      ["clear-lockout", undefined, null],
    ];
    for (const [action, active, changed] of steps) {
      const { status, body } = await call(owner, action, member.userId, {
        active,
      });
      expect(status, action).toBe(200);
      if (changed !== null) expect(body.data.changed, action).toBe(changed);
    }
    const rows = await added();
    expect(rows).toEqual([
      row("user.deactivated"),
      row("user.reactivated"),
      row("user.signed_out_everywhere"),
      row("user.signed_out_everywhere"),
      row("user.lockout_cleared"),
    ]);
    for (const item of rows) {
      expect(Object.keys(item.metadata as object)).toEqual(["targetUserId"]);
      expect(item.summary).not.toMatch(/Fictional|@example|deact-/);
    }
  });

  it("signs out only the target and clears only the target's backoff row", async () => {
    // The earlier tests already signed the member out and cleared their backoff; arrange again.
    await superuser(
      "INSERT INTO auth.session(id, expires_at, token, created_at, updated_at, user_id) VALUES ('deact-session-again', now() + interval '1 day', 'fictional-deact-token-again', now(), now(), 'deact-member')",
    );
    await superuser(
      "INSERT INTO auth.api_rate_limits(key, window_start, count) VALUES ($1, now(), 7)",
      [signInBackoffKey(emailOf(member), SECRET)],
    );
    const others = {
      other: await sessionsOf(other.userId),
      owner: await sessionsOf(owner.userId),
    };
    expect(others.other).toEqual(["deact-session-2"]);
    expect(others.owner).toEqual(["deact-session-3"]);
    expect(await sessionsOf(member.userId)).toEqual(["deact-session-again"]);
    expect((await call(peopleAdmin, "sign-out", member.userId)).status).toBe(
      200,
    );
    expect(await sessionsOf(member.userId)).toEqual([]);
    expect({
      other: await sessionsOf(other.userId),
      owner: await sessionsOf(owner.userId),
    }).toEqual(others);
    const keys = await backoffKeys();
    expect(keys).toContain(signInBackoffKey(emailOf(member), SECRET));
    expect(keys).toContain(signInBackoffKey(emailOf(other), SECRET));
    expect(
      (await call(peopleAdmin, "clear-lockout", member.userId)).status,
    ).toBe(200);
    expect(await backoffKeys()).toEqual(
      keys.filter((key) => key !== signInBackoffKey(emailOf(member), SECRET)),
    );
  });

  it("refuses a stale session on every route with SESSION_NOT_FRESH before any helper runs", async () => {
    const before = { audit: await auditRows(), rows: await deactivationRows() };
    for (const action of ACTIONS) {
      const calls = [
        pools.data.mock.calls.length,
        pools.identity.mock.calls.length,
      ];
      const { status, body } = await call(owner, action, member.userId, {
        active: false,
        stale: true,
      });
      expect(status, action).toBe(403);
      expect(body.error.code, action).toBe("SESSION_NOT_FRESH");
      // Only the session's membership lookup ran.
      expect(
        [pools.data.mock.calls.length, pools.identity.mock.calls.length],
        action,
      ).toEqual([calls[0], calls[1] + 1]);
    }
    expect(await auditRows()).toEqual(before.audit);
    expect(await deactivationRows()).toEqual(before.rows);
  });

  it("refuses bad input with 400 invalid_input and no helper call", async () => {
    const cases: [Action, string, Parameters<typeof call>[3]][] = [
      ["status", member.userId, { body: JSON.stringify({ active: "no" }) }],
      [
        "status",
        member.userId,
        { body: JSON.stringify({ active: false, userId: other.userId }) },
      ],
      ["status", member.userId, { active: false, query: "?active=false" }],
      ["sign-out", member.userId, { query: "?all=true" }],
      ["clear-lockout", "a".repeat(129), {}],
    ];
    for (const [action, target, options] of cases) {
      const calls = pools.data.mock.calls.length;
      const { status, body } = await call(owner, action, target, options);
      expect(status, `${action} ${JSON.stringify(options)}`).toBe(400);
      expect(body.error.code).toBe("invalid_input");
      expect(pools.data.mock.calls.length).toBe(calls);
    }
    const large = await call(owner, "status", member.userId, {
      body: JSON.stringify({ active: false, pad: "x".repeat(1100) }),
    });
    expect(large.status).toBe(413);
    // The helpers' own argument checks.
    for (const [target, active] of [
      [member.userId, null],
      [null, false],
      ["", false],
      ["a".repeat(129), false],
    ] as const)
      expect(await outcome(setActive(owner, target, active))).toBe("22023");
    for (const [target, action] of [
      [member.userId, "sign-in"],
      [member.userId, null],
      [null, "sign_out"],
    ] as const)
      expect(await outcome(accountAction(owner, target, action))).toBe("22023");
  });

  it("maps every helper refusal once the service allowed the caller", () => {
    const refusal = (code: string) =>
      userAccountError(
        Object.assign(new Error("Fictional refusal"), { code }),
      ) as ApiError;
    expect(refusal("42501")).toMatchObject({
      status: 403,
      code: "company_owner_required",
    });
    expect(refusal("RQ006")).toMatchObject({
      status: 404,
      code: "user_not_found",
    });
    expect(refusal("RQ005")).toMatchObject({
      status: 409,
      code: "last_company_owner",
      message:
        "The last active company owner cannot be deactivated. Make someone else a company owner first.",
    });
    expect(refusal("RQ018")).toMatchObject({
      status: 400,
      code: "cannot_change_self",
    });
    expect(refusal("22023")).toMatchObject({
      status: 400,
      code: "invalid_input",
    });
    const unexpected = Object.assign(new Error("Fictional"), { code: "XX000" });
    expect(userAccountError(unexpected)).toBe(unexpected);
  });

  it("keeps app.workspace_users closed to direct writes and open to company authority only", async () => {
    for (const statement of [
      `INSERT INTO app.workspace_users(workspace_id, user_id, deactivated_at, deactivated_by) VALUES ('${COMPANY}', 'deact-other', now(), 'deact-owner')`,
      "UPDATE app.workspace_users SET deactivated_at = now(), deactivated_by = 'deact-owner'",
      "DELETE FROM app.workspace_users",
    ]) {
      await harness.dataDb();
      await expect(
        harness.client.query(statement),
        statement,
      ).rejects.toMatchObject({ code: "42501" });
      expect(
        await outcome(withTeam(owner, (tx) => tx.execute(sql.raw(statement)))),
        statement,
      ).toBe("42501");
    }
    const visible = (p: Principal) =>
      withTeam(p, async (tx) =>
        (
          await tx.execute<{ user_id: string }>(
            sql`select user_id from app.workspace_users order by user_id`,
          )
        ).rows.map((row) => row.user_id),
      );
    const all = (await deactivationRows()).map((row) => row.user_id);
    expect(all).toContain(member.userId);
    expect(await visible(owner)).toEqual(all);
    expect(await visible(peopleAdmin)).toEqual(all);
    // A member without authority sees their own row only.
    expect(await visible(member)).toEqual([member.userId]);
    expect(await visible(recruiter)).toEqual([]);
  });

  it("shows the status in the Users list and its filter, and the person's status and new events", async () => {
    expect(
      (await call(owner, "status", member.userId, { active: false })).status,
    ).toBe(200);
    try {
      const rows = async (query: string) =>
        (await read(peopleAdmin, query)).body.data.map(
          (row: { userId: string | null; status: string }) => [
            row.userId,
            row.status,
          ],
        );
      expect(await rows("?status=deactivated")).toEqual([
        [member.userId, "deactivated"],
      ]);
      expect(await rows("?status=active")).not.toContainEqual([
        member.userId,
        "deactivated",
      ]);
      expect(
        (await rows("?status=active")).map(([id]: string[]) => id),
      ).not.toContain(member.userId);
      expect(await rows("")).toContainEqual([member.userId, "deactivated"]);
      const { status, body } = await read(peopleAdmin, `/${member.userId}`);
      expect(status).toBe(200);
      expect(body.data.status).toBe("deactivated");
      const actions = body.data.events.map(
        (event: { action: string }) => event.action,
      );
      expect(actions[0]).toBe("user.deactivated");
      for (const action of [
        "user.reactivated",
        "user.signed_out_everywhere",
        "user.lockout_cleared",
      ])
        expect(actions).toContain(action);
      expect(body.data.events[0]).toEqual({
        occurredAt: expect.any(String),
        action: "user.deactivated",
        actorId: owner.userId,
        actorName: "Fictional Deact Owner",
        objectType: null,
        objectKey: null,
        roleName: null,
      });
      // Another person's page shows none of the member's account events.
      expect(
        (await read(peopleAdmin, `/${other.userId}`)).body.data.events,
      ).toEqual([]);
    } finally {
      await call(owner, "status", member.userId, { active: true });
    }
    expect((await read(owner, `/${member.userId}`)).body.data.status).toBe(
      "active",
    );
  });
});
