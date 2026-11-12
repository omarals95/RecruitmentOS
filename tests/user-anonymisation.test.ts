import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requests pick the pool by role, as on a split-role deployment: the identity role reads the
// membership and runs Better Auth, the data role runs withTeam and the anonymisation helper. Only
// one PGlite role is active at a time.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));

import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import type { RoleBody } from "@/domain/config";
import { RECRUITER_ROLE } from "@/domain/config-defaults";
import { addAssignment } from "@/lib/assignments";
import { getVerifiedSession } from "@/lib/auth-session";
import { createConfigDraft, publishConfigVersion } from "@/lib/config-store";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import { SCOPES } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import { createRecord } from "@/lib/records";
import { setUserActive } from "@/lib/user-account";
import {
  anonymiseUser,
  userAnonymisationError,
} from "@/lib/user-anonymisation";
import { GET as usersRoute } from "@/app/api/v1/admin/users/route";
import { POST as anonymiseRoute } from "@/app/api/v1/admin/users/[user]/anonymise/route";
import {
  authCaller,
  createTestAuth,
  PASSWORD,
  type Mail,
} from "./helpers/auth";
import {
  createSplitRoleDb,
  seedApiToken,
  seedIdentity,
  splitRoles,
} from "./helpers/db";

// Fictional data only: one company workspace with fictional teams and people, and a second
// workspace the owner role inserts (ADM-10, job 085).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const SECOND = "00000000-0000-4000-a000-000000000085";
const ORIGIN = "http://localhost:3000";
const REDACTED = "Details removed by user anonymisation";
const FORBIDDEN =
  "Only a company owner, signed in, can anonymise a user account.";
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Row = Record<string, unknown>;
type Activity = {
  id: string;
  team_id: string;
  record_id: string | null;
  actor_id: string;
  actor_type: string;
  token_id: string | null;
  action: string;
  kind: string;
  summary: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  erasure_id: string | null;
  employee_erasure_id: string | null;
  user_anonymisation_id: string | null;
};
const COUNTS = [
  "memberships",
  "sessions",
  "apiTokens",
  "twoStep",
  "configuredRoles",
  "recordAssignments",
  "companyAuthority",
  "invitations",
  "activityRedacted",
];

/** The SQLSTATE of a refused helper call, the code of a refused service call, or ok. */
const outcome = (work: Promise<unknown>) =>
  work.then(
    () => "ok",
    (error: { code?: string; cause?: { code?: string } }) =>
      error.cause?.code ?? error.code,
  );
const nameOf = (id: string) =>
  `Fictional ${id.replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase())}`;
const emailOf = (id: string) => `${id}@example.test`;

describe("user account anonymisation under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, owner2: Principal, peopleAdmin: Principal;
  let teamOwnerB: Principal, teamAdmin: Principal, recruiter: Principal;
  let viewer: Principal, subject: Principal, kept: Principal;
  let shared: Principal, outsider: Principal, soleOwner: Principal;
  let archivedOwner: Principal, bystander: Principal;
  let ownerToken: Principal, ownerGrant: Principal;
  let vacancy: string;

  /** Raw statements as the PGlite superuser, which bypasses RLS; only to arrange or inspect. */
  const superuser = async <T = Row>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  const activity = () =>
    superuser<Activity>("SELECT * FROM app.activity ORDER BY created_at, id");
  /** Every row the anonymisation could touch, in both workspaces. */
  const world = async () => ({
    users: await superuser('SELECT * FROM auth."user" ORDER BY id'),
    members: await superuser("SELECT * FROM auth.member ORDER BY id"),
    sessions: await superuser("SELECT * FROM auth.session ORDER BY id"),
    accounts: await superuser("SELECT * FROM auth.account ORDER BY id"),
    twoFactor: await superuser("SELECT * FROM auth.two_factor ORDER BY id"),
    verification: await superuser(
      "SELECT * FROM auth.verification ORDER BY id",
    ),
    invitations: await superuser("SELECT * FROM auth.invitation ORDER BY id"),
    tokens: await superuser("SELECT * FROM auth.api_tokens ORDER BY id"),
    oauthCodes: await superuser(
      "SELECT * FROM auth.oauth_codes ORDER BY code_hash",
    ),
    oauthTokens: await superuser("SELECT * FROM auth.oauth_tokens ORDER BY id"),
    roles: await superuser(
      "SELECT * FROM app.member_roles ORDER BY team_id, user_id",
    ),
    assignments: await superuser(
      "SELECT * FROM app.record_assignments ORDER BY record_id, user_id, relation",
    ),
    admins: await superuser(
      "SELECT * FROM app.workspace_admins ORDER BY workspace_id, user_id",
    ),
    deactivations: await superuser(
      "SELECT * FROM app.workspace_users ORDER BY workspace_id, user_id",
    ),
    activity: await activity(),
    tombstones: await superuser(
      "SELECT * FROM app.user_anonymisations ORDER BY id",
    ),
    idempotency: await superuser(
      "SELECT * FROM app.idempotency ORDER BY team_id, actor_key, operation, key",
    ),
    records: await superuser("SELECT * FROM app.records ORDER BY id"),
    states: await superuser(
      "SELECT * FROM app.candidate_states ORDER BY team_id, user_id, candidate_id",
    ),
    employees: await superuser("SELECT * FROM app.employees ORDER BY id"),
    teams: await superuser(
      "SELECT * FROM app.workspace_teams ORDER BY team_id",
    ),
  });
  const signIn = (p: Principal, fresh = true) =>
    vi.mocked(getVerifiedSession).mockResolvedValue({
      user: { id: p.userId, twoFactorEnabled: true },
      session: {
        activeOrganizationId: p.teamId,
        // ADM-06: younger than 15 minutes, or a stale one.
        createdAt: new Date(Date.now() - (fresh ? 1_000 : 16 * 60_000)),
      },
    } as never);
  /** POST /api/v1/admin/users/<target>/anonymise as a signed-in member or a Bearer token. */
  async function call(
    as: Principal | "bearer",
    target: string,
    options: {
      body?: unknown;
      raw?: string;
      query?: string;
      stale?: boolean;
      key?: string;
    } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; text: string; body: any }> {
    if (as !== "bearer") signIn(as, !options.stale);
    const response = await anonymiseRoute(
      new Request(
        `${ORIGIN}/api/v1/admin/users/${encodeURIComponent(target)}/anonymise${options.query ?? ""}`,
        {
          method: "POST",
          headers: {
            origin: ORIGIN,
            "content-type": "application/json",
            ...(as === "bearer"
              ? { authorization: "Bearer fictional-anonymisation-token" }
              : { "x-team-id": as.teamId }),
            ...(options.key ? { "idempotency-key": options.key } : {}),
          },
          body:
            options.raw ??
            JSON.stringify(options.body ?? { confirmName: nameOf(target) }),
        },
      ),
      { params: Promise.resolve({ user: target }) },
    );
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  }
  /** tenant_context.anonymise_user on the data role, in the principal's installed context. */
  const helper = (
    p: Principal,
    target: string | null,
    name: string | null,
    source: string | null = "app",
  ) =>
    withTeam(
      p,
      async (tx) =>
        (
          await tx.execute<{ result: Row | null }>(
            sql`select tenant_context.anonymise_user(${target}::text, ${name}::text, ${source}::text) as result`,
          )
        ).rows[0].result,
    );
  /** Runs the call and expects one SQLSTATE or API code, with no row changed anywhere. */
  async function refused(work: () => Promise<unknown>, code: string) {
    const before = await world();
    expect(await outcome(work())).toBe(code);
    expect(await world()).toEqual(before);
  }
  /** A tenant_context.install signed in the test, sent as plain SQL by the given role. */
  async function directInstall(p: Principal, db: AppDb) {
    const key = Buffer.from(
      process.env.TENANT_CONTEXT_SIGNING_KEY!,
      "base64url",
    );
    return withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
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
      const signature = createHmac("sha256", key).update(payload).digest("hex");
      await tx.execute(
        sql`select tenant_context.install(${payload}, ${signature}, '{}'::text[])`,
      );
    });
  }
  const insertActivity = (
    team: string,
    actor: string,
    action: string,
    kind: string,
    summary: string,
    metadata: Row,
    record: string | null = null,
  ) =>
    superuser(
      "INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, action, kind, summary, metadata) VALUES ($1, $2, $3, 'session', $4, $5, $6, $7) RETURNING id",
      [team, record, actor, action, kind, summary, JSON.stringify(metadata)],
    ).then((rows) => (rows[0] as { id: string }).id);

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, {
      userId: "anon-owner",
      teamId: "anon-team-a",
    });
    owner2 = await seedIdentity(db, {
      userId: "anon-owner-2",
      teamId: "anon-team-a",
      role: "admin",
    });
    peopleAdmin = await seedIdentity(db, {
      userId: "anon-people-admin",
      teamId: "anon-team-a",
      role: "recruiter",
    });
    teamOwnerB = await seedIdentity(db, {
      userId: "anon-team-owner-b",
      teamId: "anon-team-b",
    });
    teamAdmin = await seedIdentity(db, {
      userId: "anon-team-admin",
      teamId: "anon-team-a",
      role: "admin",
    });
    recruiter = await seedIdentity(db, {
      userId: "anon-recruiter",
      teamId: "anon-team-a",
      role: "recruiter",
    });
    viewer = await seedIdentity(db, {
      userId: "anon-viewer",
      teamId: "anon-team-a",
      role: "viewer",
    });
    // The main subject: a recruiter in team A and a viewer in team B.
    subject = await seedIdentity(db, {
      userId: "anon-subject",
      teamId: "anon-team-a",
      role: "recruiter",
    });
    await seedIdentity(db, {
      userId: "anon-subject",
      teamId: "anon-team-b",
      role: "viewer",
    });
    // Someone the refusals aim at, who is never anonymised, and someone rows also name.
    kept = await seedIdentity(db, {
      userId: "anon-kept",
      teamId: "anon-team-a",
      role: "viewer",
    });
    bystander = await seedIdentity(db, {
      userId: "anon-bystander",
      teamId: "anon-team-a",
      role: "viewer",
    });
    // The sole owners of team E and of team F, archived below; both also in team A.
    soleOwner = await seedIdentity(db, {
      userId: "anon-sole-owner",
      teamId: "anon-team-e",
    });
    await seedIdentity(db, {
      userId: "anon-sole-owner",
      teamId: "anon-team-a",
      role: "viewer",
    });
    archivedOwner = await seedIdentity(db, {
      userId: "anon-archived-owner",
      teamId: "anon-team-f",
    });
    // The owner of team D, which moves to the second workspace, and a member of teams A and D.
    outsider = await seedIdentity(db, {
      userId: "anon-outsider",
      teamId: "anon-team-d",
    });
    shared = await seedIdentity(db, {
      userId: "anon-shared",
      teamId: "anon-team-a",
      role: "viewer",
    });
    await seedIdentity(db, {
      userId: "anon-shared",
      teamId: "anon-team-d",
      role: "viewer",
    });
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','anon-owner-2','owner','{}'),
        ('${COMPANY}','anon-people-admin','admin','{people,fields}');
      UPDATE app.workspace_teams SET archived_at = now(), archived_by = 'anon-owner' WHERE team_id = 'anon-team-f';
      INSERT INTO app.workspaces(id,name) VALUES ('${SECOND}','Fictional Second Company');
      UPDATE app.workspace_teams SET workspace_id = '${SECOND}' WHERE team_id = 'anon-team-d';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${SECOND}','anon-outsider','owner','{}');`);
    ownerToken = await seedApiToken(await harness.asOwner(), owner);
    ownerGrant = {
      ...(await seedApiToken(await harness.asOwner(), owner)),
      oauthClientId: "fictional-oauth-client",
    };
    // Names that differ from every id.
    await superuser(
      `UPDATE auth."user" SET name = 'Fictional ' || initcap(replace(id, '-', ' ')) WHERE id LIKE 'anon-%'`,
    );
    expect(nameOf(subject.userId)).toBe("Fictional Anon Subject");

    // The subject's sign-in: a password, two-step sign-in and trusted-device and challenge rows,
    // one keyed by the address in another case; and the same for the bystander, who keeps them.
    for (const id of [subject.userId, bystander.userId]) {
      await superuser(
        "INSERT INTO auth.account(id, account_id, provider_id, user_id, password) VALUES ($1, $2, 'credential', $2, $3)",
        [randomUUID(), id, await hashPassword(PASSWORD)],
      );
      await superuser(
        "INSERT INTO auth.two_factor(user_id, secret, backup_codes) VALUES ($1, 'fictional-encrypted-secret', 'fictional-encrypted-codes')",
        [id],
      );
      await superuser(
        "INSERT INTO auth.verification(id, identifier, value, expires_at) VALUES ($1, $2, $3, now() + interval '1 day'), ($4, $5, $3, now() + interval '1 day'), ($6, $7, 'fictional-value', now() + interval '1 day')",
        [
          randomUUID(),
          `trust-device-${randomUUID()}`,
          id,
          randomUUID(),
          `2fa-${randomUUID()}`,
          randomUUID(),
          emailOf(id).toUpperCase(),
        ],
      );
      for (const index of [1, 2])
        await superuser(
          "INSERT INTO auth.session(id, expires_at, token, created_at, updated_at, user_id) VALUES ($1, now() + interval '1 day', $2, now(), now(), $3)",
          [`${id}-session-${index}`, `fictional-${id}-token-${index}`, id],
        );
    }
    // A personal API token and an MCP OAuth grant with its code and token.
    await seedApiToken(await harness.asOwner(), subject, ["candidates:read"]);
    const clientId = `ros_client_${randomBytes(16).toString("base64url")}`;
    const grantId = randomUUID();
    await superuser(
      `INSERT INTO auth.oauth_clients(id,name,redirect_uris) VALUES($1,'Fictional Connector','["https://claude.ai/api/mcp/auth_callback"]')`,
      [clientId],
    );
    await superuser(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at,oauth_client_id)
        VALUES($1,'anon-team-a','anon-subject','Fictional grant',$2,'ros_oat_fiction','["candidates:read"]',now()+interval '1 day',$3)`,
      [grantId, randomBytes(32).toString("hex"), clientId],
    );
    await superuser(
      `INSERT INTO auth.oauth_codes(code_hash,grant_id,client_id,redirect_uri,code_challenge,expires_at)
        VALUES($1,$2,$3,'https://claude.ai/api/mcp/auth_callback',$4,now()+interval '1 minute')`,
      [randomBytes(32).toString("hex"), grantId, clientId, "a".repeat(43)],
    );
    await superuser(
      `INSERT INTO auth.oauth_tokens(grant_id,kind,token_hash,audience,expires_at)
        VALUES($1,'access',$2,'https://fictional.example.test/mcp',now()+interval '1 hour')`,
      [grantId, randomBytes(32).toString("hex")],
    );
    // Invitations to the subject's address in teams A and B, and one to someone else that stays.
    await superuser(
      `INSERT INTO auth.invitation(id, organization_id, email, role, status, expires_at, inviter_id) VALUES
        ($1, 'anon-team-a', 'Anon-Subject@Example.test', 'viewer', 'pending', now() + interval '2 days', 'anon-owner'),
        ($2, 'anon-team-b', 'anon-subject@example.test', 'viewer', 'canceled', now() - interval '2 days', 'anon-team-owner-b'),
        ($3, 'anon-team-a', 'anon-invitee@example.test', 'viewer', 'pending', now() + interval '2 days', 'anon-owner')`,
      [randomUUID(), randomUUID(), randomUUID()],
    );
    // A configured role in team A, published by the company owner.
    await harness.dataDb();
    const { versionId } = await createConfigDraft(owner, {
      type: "role",
      key: "fictional-anonymisation-sourcer",
      body: {
        ...structuredClone(RECRUITER_ROLE.body as RoleBody),
        name: "Fictional Anonymisation Sourcer",
      },
    });
    await publishConfigVersion(owner, versionId);
    const [{ id: roleObjectId }] = await superuser<{ id: string }>(
      "SELECT object_id::text AS id FROM app.config_versions WHERE id = $1",
      [versionId],
    );
    await superuser(
      "INSERT INTO app.member_roles(team_id, user_id, role_object_id) VALUES ('anon-team-a', 'anon-subject', $1), ('anon-team-a', 'anon-bystander', $1)",
      [roleObjectId],
    );
    // A vacancy both are assigned to, through the owner-run helper (assignment.added rows).
    [{ id: vacancy }] = (await withTeam(
      owner,
      async (tx) =>
        (
          await tx.execute(
            sql.raw(
              `INSERT INTO app.records(team_id,kind,data,created_by) VALUES ('anon-team-a','vacancy','{"title":"Fictional anonymisation vacancy"}','anon-owner') RETURNING id::text AS id`,
            ),
          )
        ).rows,
    )) as { id: string }[];
    await createRecord(owner, "candidates", {
      data: { name: "Fictional Anonymisation Candidate" },
    });
    for (const userId of [subject.userId, bystander.userId])
      expect(
        await addAssignment(owner, {
          recordId: vacancy,
          userId,
          relation: "recruiter",
        }),
      ).toEqual({ changed: true });
    // Company authority for the subject (workspace_authority.changed through the helper).
    await withTeam(owner, (tx) =>
      tx.execute(
        sql`select tenant_context.set_workspace_authority('anon-subject', 'admin', '{fields}', false)`,
      ),
    );
    // The other rows that name the subject, in teams A and B, and rows that must stay as they are.
    await insertActivity(
      "anon-team-a",
      "anon-owner",
      "two_step.reset",
      "account-security",
      "Reset a member's two-step sign-in",
      { targetUserId: "anon-subject" },
    );
    await insertActivity(
      "anon-team-a",
      "anon-owner",
      "role.assigned",
      "role-assignment",
      "Assigned a configured role to a member",
      {
        workspaceId: COMPANY,
        affectedUserId: "anon-subject",
        roleObjectId,
        roleVersionId: versionId,
      },
    );
    await insertActivity(
      "anon-team-a",
      "anon-owner",
      "scope.home_units_changed",
      "scope",
      "Changed the employee facts that set home units",
      {
        workspaceId: COMPANY,
        affectedUserIds: ["anon-bystander", "anon-subject"],
      },
    );
    await insertActivity(
      "anon-team-b",
      "anon-team-owner-b",
      "user.signed_out_everywhere",
      "user-account",
      "Signed a member out everywhere",
      { targetUserId: "anon-subject" },
    );
    await insertActivity(
      "anon-team-a",
      "anon-owner",
      "role.assigned",
      "role-assignment",
      "Assigned a configured role to a member",
      { workspaceId: COMPANY, affectedUserId: "anon-bystander" },
    );
    // A userId outside an assignment row, and the subject named in the second workspace: kept.
    await insertActivity(
      "anon-team-a",
      "anon-owner",
      "updated",
      "candidate",
      "Fictional unrelated change",
      { userId: "anon-subject" },
    );
    await insertActivity(
      "anon-team-d",
      "anon-outsider",
      "user.deactivated",
      "user-account",
      "Deactivated a member's account",
      { targetUserId: "anon-subject" },
    );
    // Rows the subject only acted in.
    await insertActivity(
      "anon-team-a",
      "anon-subject",
      "created",
      "candidate",
      "Created candidate",
      {},
    );
    await insertActivity(
      "anon-team-b",
      "anon-subject",
      "updated",
      "candidate",
      "Updated candidate",
      {},
    );
  });
  afterAll(async () => harness?.close());

  it("keeps the tombstone owner-only under FORCE RLS, with no name or email column", async () => {
    expect(
      await superuser(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'app.user_anonymisations'::regclass",
      ),
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    expect(
      (
        await superuser<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'user_anonymisations' ORDER BY ordinal_position",
        )
      ).map((row) => row.column_name),
    ).toEqual([
      "id",
      "workspace_id",
      "user_id",
      "anonymised_by",
      "anonymised_at",
      "erasure_source",
    ]);
    for (const role of [splitRoles.data, splitRoles.identity, "public"])
      expect(
        await superuser(
          "SELECT has_table_privilege($1, 'app.user_anonymisations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS any",
          [role],
        ),
        role,
      ).toEqual([{ any: false }]);
    const statements = [
      "SELECT * FROM app.user_anonymisations",
      `INSERT INTO app.user_anonymisations(id,workspace_id,user_id,anonymised_by,anonymised_at,erasure_source) VALUES (gen_random_uuid(),'${COMPANY}','anon-kept','anon-owner',now(),'app')`,
      "UPDATE app.user_anonymisations SET anonymised_at = now()",
      "DELETE FROM app.user_anonymisations",
    ];
    for (const role of ["dataDb", "identityDb"] as const) {
      await harness[role]();
      for (const statement of statements)
        await expect(
          harness.client.query(statement),
          `${role} ${statement}`,
        ).rejects.toMatchObject({ code: "42501" });
    }
    // Not even under a company owner's context.
    for (const statement of statements)
      await refused(
        () => withTeam(owner, (tx) => tx.execute(sql.raw(statement))),
        "42501",
      );
  });

  describe("refusals", () => {
    it("refuses a company admin with people, a team owner, a team admin, a recruiter and a viewer in the service, the route and the helper", async () => {
      for (const p of [peopleAdmin, teamOwnerB, teamAdmin, recruiter, viewer]) {
        await refused(
          () =>
            anonymiseUser(p, kept.userId, { confirmName: nameOf(kept.userId) }),
          "anonymisation_forbidden",
        );
        // The company owner check comes before the body is validated.
        await refused(
          () => anonymiseUser(p, kept.userId, { wrong: true }),
          "anonymisation_forbidden",
        );
        const before = await world();
        const { status, body } = await call(p, kept.userId);
        expect([status, body.error.code, body.error.message], p.userId).toEqual(
          [403, "anonymisation_forbidden", FORBIDDEN],
        );
        expect(await world()).toEqual(before);
        await refused(
          () => helper(p, kept.userId, nameOf(kept.userId)),
          "42501",
        );
      }
    });

    it("refuses API and MCP OAuth tokens in the service and the helper, and Bearer requests on the route with no data-pool call", async () => {
      for (const p of [ownerToken, ownerGrant]) {
        const calls = pools.data.mock.calls.length;
        await refused(
          () =>
            anonymiseUser(p, kept.userId, { confirmName: nameOf(kept.userId) }),
          "anonymisation_forbidden",
        );
        expect(pools.data.mock.calls.length).toBe(calls);
        await refused(
          () => helper(p, kept.userId, nameOf(kept.userId)),
          "42501",
        );
      }
      const before = await world();
      const calls = [
        pools.data.mock.calls.length,
        pools.identity.mock.calls.length,
      ];
      const { status, body } = await call("bearer", kept.userId);
      expect([status, body.error.code]).toEqual([403, "session_required"]);
      expect(pools.data.mock.calls.length).toBe(calls[0]);
      expect(await world()).toEqual(before);
    });

    it("refuses a stale session with SESSION_NOT_FRESH before any helper runs", async () => {
      const before = await world();
      const calls = [
        pools.data.mock.calls.length,
        pools.identity.mock.calls.length,
      ];
      const { status, body } = await call(owner, kept.userId, { stale: true });
      expect([status, body.error.code]).toEqual([403, "SESSION_NOT_FRESH"]);
      // Only the session's membership lookup ran.
      expect([
        pools.data.mock.calls.length,
        pools.identity.mock.calls.length,
      ]).toEqual([calls[0], calls[1] + 1]);
      expect(await world()).toEqual(before);
    });

    it("refuses the caller's own account in the service with no helper call, and in the helper for a second owner", async () => {
      const before = await world();
      const calls = [
        pools.data.mock.calls.length,
        pools.identity.mock.calls.length,
      ];
      const { status, body } = await call(owner, owner.userId);
      expect([status, body.error.code, body.error.message]).toEqual([
        400,
        "cannot_change_self",
        "You cannot change your own account here.",
      ]);
      expect([
        pools.data.mock.calls.length,
        pools.identity.mock.calls.length,
      ]).toEqual([calls[0], calls[1] + 1]);
      expect(await world()).toEqual(before);
      // Another active company owner exists and owner 2 is no team's last owner: the self check.
      await refused(
        () => helper(owner2, owner2.userId, nameOf(owner2.userId)),
        "RQ018",
      );
    });

    it("refuses the last owner of a team, archived or not, with 409 last_team_owner and RQ019", async () => {
      for (const p of [soleOwner, archivedOwner]) {
        const before = await world();
        const { status, body } = await call(owner, p.userId);
        expect([status, body.error.code, body.error.message]).toEqual([
          409,
          "last_team_owner",
          "This person is the last owner of a team. Make someone else that team's owner first.",
        ]);
        expect(await world()).toEqual(before);
        await refused(() => helper(owner, p.userId, nameOf(p.userId)), "RQ019");
      }
    });

    it("refuses the sole active company owner on themselves with RQ005, before the self check", async () => {
      // Owner 2 becomes a second owner of team A, so the owner is no team's last owner, and is
      // deactivated, so the owner is the only active company owner.
      await superuser(
        "UPDATE auth.member SET role = 'owner' WHERE id = 'anon-owner-2:anon-team-a'",
      );
      await superuser(
        `INSERT INTO app.workspace_users(workspace_id, user_id, deactivated_at, deactivated_by) VALUES ('${COMPANY}', 'anon-owner-2', now(), 'anon-owner')`,
      );
      try {
        await refused(
          () => helper(owner, owner.userId, nameOf(owner.userId)),
          "RQ005",
        );
      } finally {
        await superuser(
          "DELETE FROM app.workspace_users WHERE user_id = 'anon-owner-2'",
        );
        await superuser(
          "UPDATE auth.member SET role = 'admin' WHERE id = 'anon-owner-2:anon-team-a'",
        );
      }
    });

    it("refuses a person also in another company's team with 409 member_of_other_company and RQ020", async () => {
      const before = await world();
      const { status, body } = await call(owner, shared.userId);
      expect([status, body.error.code, body.error.message]).toEqual([
        409,
        "member_of_other_company",
        "This person is also in a team outside your company, so their account cannot be anonymised here.",
      ]);
      expect(await world()).toEqual(before);
      await refused(
        () => helper(owner, shared.userId, nameOf(shared.userId)),
        "RQ020",
      );
    });

    it("answers 404 user_not_found and null for a person only in another company and an unknown id", async () => {
      for (const target of [outsider.userId, "anon-unknown"]) {
        const before = await world();
        const { status, body, text } = await call(owner, target);
        expect([status, body.error.code], target).toEqual([
          404,
          "user_not_found",
        ]);
        expect(text).not.toContain("Fictional Anon Outsider");
        expect(await world()).toEqual(before);
        expect(await helper(owner, target, nameOf(target))).toBeNull();
      }
      // The other company's owner cannot reach this company's people either.
      await refused(
        () =>
          anonymiseUser(outsider, kept.userId, {
            confirmName: nameOf(kept.userId),
          }),
        "user_not_found",
      );
      expect(await helper(outsider, kept.userId, nameOf(kept.userId))).toBe(
        null,
      );
    });

    it("refuses bad input with 400, 413 or 22023, and a wrong name with 409, changing nothing", async () => {
      const cases: [string, Parameters<typeof call>[2], number, string][] = [
        [kept.userId, { body: { confirmName: "" } }, 400, "invalid_input"],
        [
          kept.userId,
          { body: { confirmName: "x".repeat(301) } },
          400,
          "invalid_input",
        ],
        [
          kept.userId,
          { body: { confirmName: nameOf(kept.userId), userId: "anon-owner" } },
          400,
          "invalid_input",
        ],
        [
          kept.userId,
          { body: { name: nameOf(kept.userId) } },
          400,
          "invalid_input",
        ],
        [kept.userId, { query: "?confirm=true" }, 400, "invalid_input"],
        ["a".repeat(129), {}, 400, "invalid_input"],
        [kept.userId, { raw: "{" }, 400, "invalid_json"],
        [
          kept.userId,
          {
            body: { confirmName: nameOf(kept.userId), pad: "x".repeat(1100) },
          },
          413,
          "body_too_large",
        ],
        [kept.userId, { key: "not a key!" }, 400, "invalid_idempotency_key"],
      ];
      for (const [target, options, status, code] of cases) {
        const before = await world();
        const response = await call(owner, target, options);
        expect(
          [response.status, response.body.error.code],
          JSON.stringify(options),
        ).toEqual([status, code]);
        expect(await world()).toEqual(before);
      }
      for (const confirmName of [
        "Fictional Someone Else",
        nameOf(kept.userId).toUpperCase(),
        nameOf(kept.userId).toLowerCase(),
        "   ",
      ]) {
        const before = await world();
        const { status, body } = await call(owner, kept.userId, {
          body: { confirmName },
          key: "anon-wrong-name",
        });
        expect([status, body.error.code, body.error.message]).toEqual([
          409,
          "anonymisation_confirmation_mismatch",
          "Type the person's name exactly as shown to confirm.",
        ]);
        expect(await world()).toEqual(before);
        await refused(() => helper(owner, kept.userId, confirmName), "RQ003");
      }
      await refused(() => helper(owner, kept.userId, ""), "RQ003");
      await refused(() => helper(owner, kept.userId, null), "RQ003");
      for (const [target, source] of [
        [null, "app"],
        ["", "app"],
        ["a".repeat(129), "app"],
        [kept.userId, "import"],
        [kept.userId, null],
      ] as const)
        await refused(
          () => helper(owner, target, nameOf(kept.userId), source),
          "22023",
        );
    });

    it("maps every helper refusal once the service allowed the caller", () => {
      const refusal = (code: string) =>
        userAnonymisationError(
          Object.assign(new Error("Fictional refusal"), { code }),
        ) as ApiError;
      expect(refusal("RQ003")).toMatchObject({
        status: 409,
        code: "anonymisation_confirmation_mismatch",
      });
      expect(refusal("RQ019")).toMatchObject({
        status: 409,
        code: "last_team_owner",
      });
      expect(refusal("RQ005")).toMatchObject({
        status: 409,
        code: "last_company_owner",
        message:
          "The last company owner cannot be anonymised. Make someone else a company owner first.",
      });
      expect(refusal("RQ020")).toMatchObject({
        status: 409,
        code: "member_of_other_company",
      });
      expect(refusal("RQ018")).toMatchObject({
        status: 400,
        code: "cannot_change_self",
      });
      expect(refusal("42501")).toMatchObject({
        status: 403,
        code: "anonymisation_forbidden",
        message: FORBIDDEN,
      });
      expect(refusal("22023")).toMatchObject({
        status: 400,
        code: "invalid_input",
      });
      const unexpected = Object.assign(new Error("Fictional"), {
        code: "XX000",
      });
      expect(userAnonymisationError(unexpected)).toBe(unexpected);
    });
  });

  describe("anonymisation by a company owner", () => {
    const mail: Mail[] = [];
    let caller: ReturnType<typeof authCaller>;
    let first: { status: number; body: { data: Row } };
    let before: Awaited<ReturnType<typeof world>>;
    let about: Activity[];
    let acted: Activity[];
    let tombstone: string;
    const signInStatus = async () => {
      await harness.identityDb();
      return caller.post("sign-in/email", {
        email: emailOf(subject.userId),
        password: PASSWORD,
      });
    };
    const names = (row: Activity) =>
      row.metadata.targetUserId === subject.userId ||
      row.metadata.affectedUserId === subject.userId ||
      (row.kind === "assignment" && row.metadata.userId === subject.userId) ||
      (Array.isArray(row.metadata.affectedUserIds) &&
        row.metadata.affectedUserIds.includes(subject.userId));

    beforeAll(async () => {
      caller = authCaller(createTestAuth(await harness.identityDb(), mail));
      // The password works before: Better Auth asks for the two-step code.
      const signedIn = await signInStatus();
      expect(signedIn.status).toBe(200);
      expect(await signedIn.json()).toMatchObject({ twoFactorRedirect: true });
      // A deactivated person can be anonymised; their deactivation row is kept.
      await setUserActive(owner, subject.userId, false);
      before = await world();
      const inWorkspace = new Set(["anon-team-a", "anon-team-b"]);
      about = before.activity.filter(
        (row) => inWorkspace.has(row.team_id) && names(row),
      );
      acted = before.activity.filter((row) => row.actor_id === subject.userId);
      first = await call(owner, subject.userId, {
        body: { confirmName: `  ${nameOf(subject.userId)} ` },
        key: "anon-key-1",
      });
      tombstone = first.body.data?.anonymisationId as string;
    });

    it("answers 200 with the tombstone, the time and the nine counts only", () => {
      expect(first.status).toBe(200);
      expect(first.body.data).toEqual({
        anonymisationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        ),
        alreadyAnonymised: false,
        anonymisedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
        removed: {
          memberships: 2,
          sessions: 2,
          apiTokens: 2,
          twoStep: 1,
          configuredRoles: 1,
          recordAssignments: 1,
          companyAuthority: 1,
          invitations: 2,
          // Every earlier row about the subject and the role.cleared row the deletion wrote.
          activityRedacted: about.length + 1,
        },
      });
      expect(Object.keys(first.body.data.removed as Row)).toEqual(COUNTS);
      expect([...new Set(about.map((row) => row.action))].sort()).toEqual([
        "assignment.added",
        "role.assigned",
        "scope.home_units_changed",
        "two_step.reset",
        "user.deactivated",
        "user.signed_out_everywhere",
        "workspace_authority.changed",
      ]);
    });

    it("removes every access row of the subject and of nobody else", async () => {
      const after = await world();
      const of = (rows: Row[], key = "user_id") =>
        rows.filter((row) => row[key] === subject.userId);
      const others = (rows: Row[], key = "user_id") =>
        rows.filter((row) => row[key] !== subject.userId);
      for (const table of [
        "members",
        "sessions",
        "accounts",
        "twoFactor",
        "tokens",
        "roles",
        "assignments",
        "admins",
      ] as const) {
        expect(of(before[table]).length, table).toBeGreaterThan(0);
        expect(of(after[table]), table).toEqual([]);
        expect(others(after[table]), table).toEqual(others(before[table]));
      }
      // The OAuth grant's code and token cascade; trusted devices, challenges and the
      // address-keyed row go; the bystander keeps theirs.
      expect(after.oauthCodes).toEqual([]);
      expect(after.oauthTokens).toEqual([]);
      expect(before.oauthCodes).toHaveLength(1);
      const verificationOf = (rows: Row[], id: string) =>
        rows.filter(
          (row) =>
            row.value === id ||
            String(row.identifier).toLowerCase() === emailOf(id),
        );
      // The three seeded rows and the challenge of the sign-in before.
      expect(verificationOf(before.verification, subject.userId)).toHaveLength(
        4,
      );
      expect(verificationOf(after.verification, subject.userId)).toEqual([]);
      expect(after.verification).toEqual(
        before.verification.filter(
          (row) => !verificationOf([row], subject.userId).length,
        ),
      );
      expect(verificationOf(after.verification, bystander.userId)).toHaveLength(
        3,
      );
      // Invitations to the old address in the company's teams; another person's stays.
      expect(
        after.invitations.map((row) => (row.email as string).toLowerCase()),
      ).toEqual(["anon-invitee@example.test"]);
      // The deactivation row and every record, state, employee and team row are kept.
      for (const table of [
        "deactivations",
        "records",
        "states",
        "employees",
        "teams",
      ] as const)
        expect(after[table], table).toEqual(before[table]);
      expect(of(after.deactivations)).toHaveLength(1);
      // Other people's user rows are unchanged.
      expect(others(after.users, "id")).toEqual(others(before.users, "id"));
    });

    it("renames the account to the placeholder and turns off verification and two-step", async () => {
      const [row] = await superuser(
        'SELECT name, email, email_verified, two_factor_enabled, image FROM auth."user" WHERE id = $1',
        [subject.userId],
      );
      expect(row).toEqual({
        name: `Former user ${tombstone.replaceAll("-", "").slice(0, 8)}`,
        email: `anonymised-${tombstone}@invalid`,
        email_verified: false,
        two_factor_enabled: false,
        image: null,
      });
    });

    it("writes one tombstone with ids, owner, time and source only", async () => {
      expect(
        await superuser(
          "SELECT * FROM app.user_anonymisations WHERE user_id = $1",
          [subject.userId],
        ),
      ).toEqual([
        {
          id: tombstone,
          workspace_id: COMPANY,
          user_id: subject.userId,
          anonymised_by: owner.userId,
          anonymised_at: new Date(first.body.data.anonymisedAt as string),
          erasure_source: "app",
        },
      ]);
      expect(
        await superuser("SELECT * FROM app.user_anonymisations"),
      ).toHaveLength(1);
    });

    it("redacts every row about the subject to type, time and actor, keeps the rows they acted in and leaves everyone else's", async () => {
      const after = await activity();
      const now = new Map(after.map((row) => [row.id, row] as const));
      for (const row of about)
        expect(now.get(row.id), row.action).toEqual({
          ...row,
          summary: REDACTED,
          metadata: {},
          user_anonymisation_id: tombstone,
        });
      const known = new Set(before.activity.map((row) => row.id));
      const added = after.filter((row) => !known.has(row.id));
      expect(added.map((row) => row.action)).toEqual([
        "role.cleared",
        "user.anonymised",
      ]);
      expect(added[0]).toMatchObject({
        team_id: owner.teamId,
        actor_id: owner.userId,
        kind: "role-assignment",
        summary: REDACTED,
        metadata: {},
        user_anonymisation_id: tombstone,
      });
      const [anonymised] = added.slice(1);
      expect(anonymised).toEqual({
        id: expect.any(String),
        team_id: owner.teamId,
        record_id: null,
        actor_id: owner.userId,
        actor_type: "session",
        token_id: null,
        action: "user.anonymised",
        kind: "user-anonymisation",
        summary: "Anonymised a user account",
        metadata: {
          source: "app",
          workspaceId: COMPANY,
          ...(first.body.data.removed as Row),
        },
        created_at: new Date(first.body.data.anonymisedAt as string),
        erasure_id: null,
        employee_erasure_id: null,
        user_anonymisation_id: tombstone,
      });
      expect(Object.keys(anonymised.metadata).sort()).toEqual(
        ["source", "workspaceId", ...COUNTS].sort(),
      );
      expect(
        after.filter((row) => row.kind === "user-anonymisation"),
      ).toHaveLength(1);
      // Every other earlier row, the subject's own actions and the second company's included.
      const redacted = new Set(about.map((row) => row.id));
      expect(
        after.filter((row) => known.has(row.id) && !redacted.has(row.id)),
      ).toEqual(before.activity.filter((row) => !redacted.has(row.id)));
      expect(acted.map((row) => row.summary).sort()).toEqual([
        "Created candidate",
        "Updated candidate",
      ]);
      expect(
        await superuser(
          'SELECT DISTINCT u.name FROM app.activity a JOIN auth."user" u ON u.id = a.actor_id WHERE a.actor_id = $1',
          [subject.userId],
        ),
      ).toEqual([
        { name: `Former user ${tombstone.replaceAll("-", "").slice(0, 8)}` },
      ]);
    });

    it("leaves the old name and email nowhere it searched", async () => {
      const texts = [
        ...(await superuser<{ text: string }>(
          'SELECT row_to_json(u)::text AS text FROM auth."user" u',
        )),
        ...(await superuser<{ text: string }>(
          "SELECT row_to_json(i)::text AS text FROM auth.invitation i",
        )),
        ...(await superuser<{ text: string }>(
          "SELECT row_to_json(v)::text AS text FROM auth.verification v",
        )),
        ...(await superuser<{ text: string }>(
          "SELECT a.summary || ' ' || a.metadata::text AS text FROM app.activity a",
        )),
        ...(await superuser<{ text: string }>(
          "SELECT row_to_json(x)::text AS text FROM app.user_anonymisations x",
        )),
        ...(await superuser<{ text: string }>(
          "SELECT row_to_json(i)::text AS text FROM app.idempotency i",
        )),
      ].map((row) => row.text.toLowerCase());
      expect(texts.length).toBeGreaterThan(0);
      for (const value of [nameOf(subject.userId), emailOf(subject.userId)])
        for (const text of texts)
          expect(text).not.toContain(value.toLowerCase());
    });

    it("returns the earlier result on a retry by key, by a new key and by the helper, changing nothing", async () => {
      const settled = await world();
      const expected = { ...first.body.data, alreadyAnonymised: true };
      const again = await call(owner, subject.userId, {
        key: "anon-key-1",
        body: { confirmName: "Any name at all" },
      });
      expect(again).toMatchObject({ status: 200, body: { data: expected } });
      expect(await world()).toEqual(settled);
      const repeated = await call(owner, subject.userId, {
        key: "anon-key-2",
        body: { confirmName: "Any name at all" },
      });
      expect(repeated).toMatchObject({ status: 200, body: { data: expected } });
      const direct = await helper(owner, subject.userId, "Anything");
      expect({
        ...direct,
        anonymisedAt: new Date(direct!.anonymisedAt as string).toISOString(),
      }).toEqual(expected);
      // The new key stores its response; nothing else changes.
      const after = await world();
      expect({ ...after, idempotency: [] }).toEqual({
        ...settled,
        idempotency: [],
      });
      expect(after.idempotency).toHaveLength(settled.idempotency.length + 1);
      // The first key for another person is refused.
      const mismatch = await call(owner, kept.userId, { key: "anon-key-1" });
      expect([mismatch.status, mismatch.body.error.code]).toEqual([
        409,
        "idempotency_mismatch",
      ]);
      expect(await world()).toEqual(after);
    });

    it("refuses every context signed for the subject at install, on both roles, and the old email and password", async () => {
      for (const db of [harness.dataDb, harness.identityDb])
        await expect(directInstall(subject, await db())).rejects.toMatchObject({
          cause: { code: "42501", message: "Tenant context rejected" },
        });
      expect(await outcome(withTeam(subject, () => Promise.resolve()))).toBe(
        "tenant_context_denied",
      );
      const sessions = await superuser("SELECT * FROM auth.session");
      const response = await signInStatus();
      expect(response.status).toBe(401);
      expect(await superuser("SELECT * FROM auth.session")).toEqual(sessions);
      expect(
        await superuser("SELECT 1 FROM auth.session WHERE user_id = $1", [
          subject.userId,
        ]),
      ).toEqual([]);
    });

    it("drops the subject from the Users list and its own page", async () => {
      signIn(owner);
      const response = await usersRoute(
        new Request(`${ORIGIN}/api/v1/admin/users`, {
          headers: { origin: ORIGIN, "x-team-id": owner.teamId },
        }),
      );
      const { data } = (await response.json()) as {
        data: { userId: string | null; email: string }[];
      };
      expect(data.map((row) => row.userId)).not.toContain(subject.userId);
      expect(data.map((row) => row.email)).not.toContain(
        emailOf(subject.userId),
      );
    });
  });
});
