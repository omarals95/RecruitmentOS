import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requests pick the pool by role, as on a split-role deployment: the identity role reads the
// membership, the data role runs withTeam. Only one PGlite role is active at a time.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));

import { sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import type { RoleBody } from "@/domain/config";
import { RECRUITER_ROLE } from "@/domain/config-defaults";
import { requireVerifiedIdentity } from "@/lib/auth-policy";
import { getVerifiedSession } from "@/lib/auth-session";
import {
  archiveConfigObject,
  createConfigDraft,
  publishConfigVersion,
} from "@/lib/config-store";
import { withTeam } from "@/lib/db-team";
import type { Principal } from "@/lib/principal";
import { createRecord } from "@/lib/records";
import { GET as usersRoute } from "@/app/api/v1/admin/users/route";
import { GET as personRoute } from "@/app/api/v1/admin/users/[user]/route";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace with fictional teams, people and invitations, and a
// second workspace the owner role inserts (ADM-07, job 073).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const SECOND = "00000000-0000-4000-a000-000000000073";
const ORIGIN = "http://localhost:3000";
const HELPER_KEYS = [
  "user_id",
  "name",
  "email",
  "teams",
  "company_level",
  "status",
  "last_sign_in",
  "two_step",
  "sort_key",
  "row_key",
];
const ROW_KEYS = [
  "companyLevel",
  "email",
  "lastSignInAt",
  "name",
  "status",
  "teams",
  "twoStep",
  "userId",
].sort();
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Team = {
  team: string;
  teamRole: string | null;
  configuredRole: string | null;
};
type Row = {
  userId: string | null;
  name: string | null;
  email: string;
  teams: Team[];
  companyLevel: string | null;
  status: string;
  lastSignInAt: string | null;
  twoStep: boolean;
};
type Page = {
  data: Row[];
  roles: { key: string; name: string }[];
  pagination: { pageSize: number; hasMore: boolean; nextCursor: string | null };
};

const signIn = (p: { userId: string; teamId: string }) =>
  vi.mocked(getVerifiedSession).mockResolvedValue({
    user: { id: p.userId, twoFactorEnabled: true },
    session: { activeOrganizationId: p.teamId },
  } as never);
/** GET /api/v1/admin/users as a signed-in member, a Bearer token or nobody. */
async function get(
  as: Principal | "bearer" | "anonymous",
  query = "",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; text: string; body: any }> {
  if (as === "anonymous")
    vi.mocked(getVerifiedSession).mockImplementation(
      async () => requireVerifiedIdentity(null) as never,
    );
  else if (as !== "bearer") signIn(as);
  const response = await usersRoute(
    new Request(`${ORIGIN}/api/v1/admin/users${query}`, {
      headers: {
        origin: ORIGIN,
        ...(as === "bearer"
          ? { authorization: "Bearer fictional-users-token" }
          : as === "anonymous"
            ? {}
            : { "x-team-id": as.teamId }),
      },
    }),
  );
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}
/** Every page for these filters, following nextCursor; checks the page sizes on the way. */
async function walk(p: Principal, filters: Record<string, string> = {}) {
  const rows: Row[] = [];
  let cursor: string | null = null;
  for (;;) {
    const params = new URLSearchParams(filters);
    if (cursor) params.set("cursor", cursor);
    const query = params.size ? `?${params}` : "";
    const { status, body } = await get(p, query);
    expect(status, query).toBe(200);
    const page = body as Page;
    expect(page.pagination.pageSize).toBe(25);
    rows.push(...page.data);
    if (!page.pagination.hasMore) {
      expect(page.data.length).toBeLessThanOrEqual(25);
      expect(page.pagination.nextCursor).toBeNull();
      return rows;
    }
    expect(page.data).toHaveLength(25);
    cursor = page.pagination.nextCursor;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  }
}
/** Publishes one company role as the company owner. */
async function publishRole(
  harness: Harness,
  owner: Principal,
  key: string,
  name: string,
) {
  await harness.dataDb();
  const { objectId, versionId } = await createConfigDraft(owner, {
    type: "role",
    key,
    body: { ...structuredClone(RECRUITER_ROLE.body as RoleBody), name },
  });
  await harness.dataDb();
  await publishConfigVersion(owner, versionId);
  return objectId;
}

describe("the workspace people list under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, peopleAdmin: Principal, fieldsAdmin: Principal;
  let teamOwnerB: Principal, recruiter: Principal, viewer: Principal;
  let ownerD: Principal;
  let leaks: string[];

  /** Raw statements as the PGlite superuser, which bypasses RLS; only to arrange or inspect. */
  const superuser = async <T>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  /** The helper itself, called on the data role in the principal's installed context. */
  const helper = async (
    p: Principal,
    args: (string | null)[] = [null, null, null, null, null, null],
  ) => {
    await harness.dataDb();
    return withTeam(
      p,
      async (tx) =>
        (
          await tx.execute<Record<string, unknown>>(
            sql`select * from tenant_context.workspace_people(${args[0]}::text, ${args[1]}::text, ${args[2]}::text, ${args[3]}::text, ${args[4]}::text, ${args[5]}::text)`,
          )
        ).rows,
    );
  };
  const expectRefused = async (p: Principal) =>
    expect(helper(p), p.userId).rejects.toMatchObject({
      cause: { code: "42501" },
    });

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, {
      userId: "people-owner",
      teamId: "people-team-a",
    });
    peopleAdmin = await seedIdentity(db, {
      userId: "people-admin",
      teamId: "people-team-a",
      role: "recruiter",
      twoFactorEnabled: false,
    });
    fieldsAdmin = await seedIdentity(db, {
      userId: "people-fields-admin",
      teamId: "people-team-a",
      role: "recruiter",
    });
    recruiter = await seedIdentity(db, {
      userId: "people-recruiter",
      teamId: "people-team-a",
      role: "recruiter",
    });
    viewer = await seedIdentity(db, {
      userId: "people-viewer",
      teamId: "people-team-a",
      role: "viewer",
    });
    // A team-only owner, who is also a viewer in team A.
    teamOwnerB = await seedIdentity(db, {
      userId: "people-owner-b",
      teamId: "people-team-b",
    });
    await seedIdentity(db, {
      userId: "people-owner-b",
      teamId: "people-team-a",
      role: "viewer",
    });
    // A team none of the callers belong to.
    await seedIdentity(db, {
      userId: "people-owner-c",
      teamId: "people-team-c",
    });
    // Created while one workspace exists, then moved to a second one by the owner role, with a
    // person who is in team A as well.
    ownerD = await seedIdentity(db, {
      userId: "people-owner-d",
      teamId: "people-team-d",
    });
    await seedIdentity(db, {
      userId: "people-both",
      teamId: "people-team-a",
      role: "recruiter",
    });
    await seedIdentity(db, {
      userId: "people-both",
      teamId: "people-team-d",
      role: "admin",
    });
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${COMPANY}','people-admin','admin','{people}');
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${COMPANY}','people-fields-admin','admin','{fields}');
      INSERT INTO app.workspaces(id,name) VALUES ('${SECOND}','Fictional Second Company');
      UPDATE app.workspace_teams SET workspace_id = '${SECOND}' WHERE team_id = 'people-team-d';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${SECOND}','people-owner-d','owner','{}');`);
    // A configured role for the recruiter in team A, and a candidate record and a token in team A.
    const sourcer = await publishRole(
      harness,
      owner,
      "fictional-sourcer",
      "Fictional Sourcer",
    );
    await harness.asSuperuser();
    await harness.client.query(
      "INSERT INTO app.member_roles(team_id, user_id, role_object_id) VALUES ('people-team-a', 'people-recruiter', $1)",
      [sourcer],
    );
    await harness.dataDb();
    const candidate = await createRecord(owner, "candidates", {
      data: { name: "Fictional Leak Candidate" },
    });
    const token = await seedApiToken(await harness.asOwner(), owner);
    // Names that differ from every id, invitations and sessions.
    await harness.asSuperuser();
    await harness.client.exec(`
      UPDATE auth.organization SET name = 'Fictional ' || upper(split_part(id, '-', 3)) || ' Team',
        slug = 'fictional-' || split_part(id, '-', 3) WHERE id LIKE 'people-team-%';
      UPDATE auth."user" SET name = 'Fictional ' || initcap(replace(id, '-', ' ')) WHERE id LIKE 'people-%';
      INSERT INTO auth.session(id, expires_at, token, created_at, updated_at, user_id, ip_address, user_agent) VALUES
        ('people-session-1', now() + interval '1 day', 'fictional-session-token-1', '2026-11-01T09:00:00Z', now(), 'people-owner', '192.0.2.10', 'Fictional Agent'),
        ('people-session-2', now() + interval '1 day', 'fictional-session-token-2', '2026-11-05T10:30:00Z', now(), 'people-owner', '192.0.2.11', 'Fictional Agent');
      INSERT INTO auth.invitation(id, organization_id, email, role, status, expires_at, inviter_id) VALUES
        ('people-invite-1', 'people-team-a', 'people-invitee@example.test', 'recruiter', 'pending', now() + interval '1 day', 'people-owner'),
        ('people-invite-2', 'people-team-c', 'People-Invitee@Example.test', 'viewer', 'pending', now() + interval '1 day', 'people-owner-c'),
        ('people-invite-3', 'people-team-a', 'people-expired@example.test', 'viewer', 'pending', now() - interval '1 minute', 'people-owner'),
        ('people-invite-4', 'people-team-a', 'people-accepted@example.test', 'viewer', 'accepted', now() + interval '1 day', 'people-owner'),
        ('people-invite-5', 'people-team-a', 'people-cancelled@example.test', 'viewer', 'canceled', now() + interval '1 day', 'people-owner'),
        ('people-invite-6', 'people-team-c', 'PEOPLE-RECRUITER@example.test', 'viewer', 'pending', now() + interval '1 day', 'people-owner-c'),
        ('people-invite-7', 'people-team-b', 'people-unrecorded@example.test', NULL, 'pending', now() + interval '1 day', 'people-owner-b'),
        ('people-invite-8', 'people-team-d', 'people-second-invitee@example.test', 'viewer', 'pending', now() + interval '1 day', 'people-owner-d');`);
    leaks = [
      candidate.id,
      "Fictional Leak Candidate",
      token.tokenId!,
      "ros_live_fiction",
      "people-session-",
      "fictional-session-token",
      "192.0.2.",
      "Fictional Agent",
      "people-team-",
      sourcer,
      ...(
        await superuser<{ id: string }>(
          "SELECT id::text FROM app.activity UNION SELECT token_hash FROM auth.api_tokens",
        )
      ).map((row) => row.id),
    ];
  });
  afterAll(async () => harness?.close());

  it("returns the people and invitations of every workspace team to a company owner and a people admin, with the documented columns", async () => {
    for (const p of [owner, peopleAdmin]) {
      const rows = await helper(p);
      for (const row of rows)
        expect(Object.keys(row), p.userId).toEqual(HELPER_KEYS);
      expect(
        rows.map((row) => [row.email, row.status]),
        p.userId,
      ).toEqual([
        ["people-admin@example.test", "active"],
        ["people-both@example.test", "active"],
        ["people-fields-admin@example.test", "active"],
        ["people-owner@example.test", "active"],
        ["people-owner-b@example.test", "active"],
        ["people-owner-c@example.test", "active"],
        ["people-recruiter@example.test", "active"],
        ["people-viewer@example.test", "active"],
        ["people-invitee@example.test", "invited"],
        ["people-unrecorded@example.test", "invited"],
      ]);
      const byEmail = new Map(rows.map((row) => [row.email, row]));
      expect(byEmail.get("people-owner@example.test")).toMatchObject({
        user_id: "people-owner",
        name: "Fictional People Owner",
        company_level: "owner",
        two_step: true,
        teams: [
          { team: "Fictional A Team", teamRole: "owner", configuredRole: null },
        ],
        sort_key: "fictional people owner",
        row_key: "people-owner",
      });
      expect(
        new Date(
          byEmail.get("people-owner@example.test")!.last_sign_in as string,
        ).toISOString(),
      ).toBe("2026-11-05T10:30:00.000Z");
      expect(byEmail.get("people-admin@example.test")).toMatchObject({
        company_level: "admin",
        two_step: false,
        last_sign_in: null,
      });
      expect(byEmail.get("people-owner-b@example.test")).toMatchObject({
        company_level: null,
        teams: [
          {
            team: "Fictional A Team",
            teamRole: "viewer",
            configuredRole: null,
          },
          { team: "Fictional B Team", teamRole: "owner", configuredRole: null },
        ],
      });
      expect(byEmail.get("people-recruiter@example.test")!.teams).toEqual([
        {
          team: "Fictional A Team",
          teamRole: "recruiter",
          configuredRole: "Fictional Sourcer",
        },
      ]);
      expect(byEmail.get("people-invitee@example.test")).toEqual({
        user_id: null,
        name: null,
        email: "people-invitee@example.test",
        teams: [
          {
            team: "Fictional A Team",
            teamRole: "recruiter",
            configuredRole: null,
          },
          {
            team: "Fictional C Team",
            teamRole: "viewer",
            configuredRole: null,
          },
        ],
        company_level: null,
        status: "invited",
        last_sign_in: null,
        two_step: false,
        sort_key: "people-invitee@example.test",
        row_key: "invitation:people-invitee@example.test",
      });
      expect(byEmail.get("people-unrecorded@example.test")!.teams).toEqual([
        { team: "Fictional B Team", teamRole: null, configuredRole: null },
      ]);
    }
  });

  it("lists the eight documented keys through the route, with the role choices and one page", async () => {
    for (const p of [owner, peopleAdmin]) {
      const { status, body, text } = await get(p);
      expect(status, p.userId).toBe(200);
      expect(Object.keys(body).sort()).toEqual(["data", "pagination", "roles"]);
      for (const row of body.data)
        expect(Object.keys(row).sort(), p.userId).toEqual(ROW_KEYS);
      expect(body.data).toHaveLength(10);
      expect(body.pagination).toEqual({
        pageSize: 25,
        hasMore: false,
        nextCursor: null,
      });
      expect(body.roles).toEqual([
        { key: "fictional-sourcer", name: "Fictional Sourcer" },
      ]);
      expect(
        body.data.find((row: Row) => row.userId === "people-owner"),
      ).toEqual({
        userId: "people-owner",
        name: "Fictional People Owner",
        email: "people-owner@example.test",
        teams: [
          { team: "Fictional A Team", teamRole: "owner", configuredRole: null },
        ],
        companyLevel: "owner",
        status: "active",
        lastSignInAt: "2026-11-05T10:30:00.000Z",
        twoStep: true,
      });
      // No record, candidate, activity, token, session or team id value anywhere in the body.
      for (const leak of leaks)
        expect(text, `${p.userId}: ${leak}`).not.toContain(leak);
    }
  });

  it("leaves out expired, accepted and cancelled invitations and invitations to a member's email", async () => {
    const emails = (await helper(owner)).map((row) => row.email);
    for (const email of [
      "people-expired@example.test",
      "people-accepted@example.test",
      "people-cancelled@example.test",
    ])
      expect(emails).not.toContain(email);
    expect(
      emails.filter(
        (email) =>
          String(email).toLowerCase() === "people-recruiter@example.test",
      ),
    ).toEqual(["people-recruiter@example.test"]);
    expect(
      emails.filter((email) => email === "people-invitee@example.test"),
    ).toHaveLength(1);
  });

  it("refuses a company admin without people, a team-only owner, a recruiter, a viewer and a token context", async () => {
    for (const p of [fieldsAdmin, teamOwnerB, recruiter, viewer]) {
      await expectRefused(p);
      const { status, body } = await get(p);
      expect(status, p.userId).toBe(403);
      expect(body.error.code, p.userId).toBe("people_forbidden");
      expect(body.error.message).toBe(
        "Only a company owner, or a company admin with the People area, can see the users list.",
      );
    }
    await expectRefused(await seedApiToken(await harness.asOwner(), owner));
    const calls = pools.data.mock.calls.length;
    const bearer = await get("bearer");
    expect(bearer.status).toBe(403);
    expect(bearer.body.error.code).toBe("session_required");
    expect(pools.data.mock.calls.length).toBe(calls);
    expect((await get("anonymous")).status).toBe(401);
  });

  it("refuses bad helper arguments with 22023", async () => {
    for (const args of [
      [null, "suspended", null, null, null, null],
      [null, null, "member", null, null, null],
      [null, null, null, null, "fictional", null],
      [null, null, null, null, null, "fictional"],
    ])
      await expect(helper(owner, args)).rejects.toMatchObject({
        cause: { code: "22023" },
      });
  });

  it("never lists a team, person or invitation of another workspace, in either direction", async () => {
    for (const p of [owner, peopleAdmin]) {
      const { status, text, body } = await get(p);
      expect(status).toBe(200);
      for (const leak of [
        "people-owner-d",
        "Fictional D Team",
        "fictional-d",
        "people-second-invitee",
        SECOND,
      ])
        expect(text, `${p.userId}: ${leak}`).not.toContain(leak);
      expect(
        body.data.find((row: Row) => row.userId === "people-both").teams,
      ).toEqual([
        {
          team: "Fictional A Team",
          teamRole: "recruiter",
          configuredRole: null,
        },
      ]);
    }
    const { body, text } = await get(ownerD);
    expect(body.data.map((row: Row) => [row.email, row.teams])).toEqual([
      [
        "people-both@example.test",
        [{ team: "Fictional D Team", teamRole: "admin", configuredRole: null }],
      ],
      [
        "people-owner-d@example.test",
        [{ team: "Fictional D Team", teamRole: "owner", configuredRole: null }],
      ],
      [
        "people-second-invitee@example.test",
        [
          {
            team: "Fictional D Team",
            teamRole: "viewer",
            configuredRole: null,
          },
        ],
      ],
    ]);
    expect(body.roles).toEqual([]);
    for (const leak of ["Fictional A Team", "people-invitee", "people-owner@"])
      expect(text, leak).not.toContain(leak);
  });

  it("refuses an unknown key, a bad value and a malformed cursor with 400 and no helper call", async () => {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const query of [
      "?search=fictional",
      "?status=suspended",
      "?level=member",
      "?team=Fictional%20Team",
      "?role=Not%20A%20Key",
      "?cursor=not%20base64!",
      `?cursor=${Buffer.from("not json").toString("base64url")}`,
      `?cursor=${encode(["only one"])}`,
      `?cursor=${encode(["a", "b", "c"])}`,
      `?cursor=${encode(["a", 1])}`,
      `?cursor=${encode({ sort: "a", key: "b" })}`,
      `?cursor=${"a".repeat(2049)}`,
    ]) {
      const calls = pools.data.mock.calls.length;
      const { status, body } = await get(owner, query);
      expect(status, query).toBe(400);
      expect(body.error.code, query).toBe("invalid_input");
      expect(pools.data.mock.calls.length, query).toBe(calls);
    }
  });
});

describe("paging and filters over a few hundred fictional people", () => {
  let harness: Harness;
  let owner: Principal;
  type Person = {
    email: string;
    name: string;
    status: "active" | "invited";
    level: "owner" | "admin" | null;
    teams: Map<string, { role: string | null; configured: string | null }>;
  };
  const people: Person[] = [];
  const LETTERS = ["e", "f", "g"];
  const pad = (i: number) => String(i).padStart(3, "0");
  const keysOf = (rows: Row[]) => rows.map((row) => row.email).sort();
  const expected = (keep: (person: Person) => boolean) =>
    people
      .filter(keep)
      .map((person) => person.email)
      .sort();

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    for (const letter of LETTERS)
      owner = await seedIdentity(db, {
        userId: "bulk-owner",
        teamId: `bulk-team-${letter}`,
      });
    const sourcer = await publishRole(
      harness,
      owner,
      "bulk-sourcer",
      "Fictional Bulk Sourcer",
    );
    const screener = await publishRole(
      harness,
      owner,
      "bulk-screener",
      "Fictional Bulk Screener",
    );
    // Archived and draft-only roles are no filter choice.
    const archived = await publishRole(
      harness,
      owner,
      "bulk-archived",
      "Fictional Archived Role",
    );
    await harness.dataDb();
    await archiveConfigObject(owner, archived);
    await harness.dataDb();
    await createConfigDraft(owner, {
      type: "role",
      key: "bulk-draft",
      body: {
        ...structuredClone(RECRUITER_ROLE.body as RoleBody),
        name: "Fictional Draft Role",
      },
    });
    await harness.asSuperuser();
    await harness.client.exec(`
      UPDATE auth.organization SET name = 'Fictional ' || upper(split_part(id, '-', 3)) || ' Team',
        slug = 'fictional-' || split_part(id, '-', 3) WHERE id LIKE 'bulk-team-%';
      UPDATE auth."user" SET name = 'Fictional Bulk Owner' WHERE id = 'bulk-owner';
      INSERT INTO auth."user"(id, name, email, email_verified, two_factor_enabled)
        SELECT 'bulk-' || lpad(i::text, 3, '0'), 'Fictional Person ' || lpad(i::text, 3, '0'),
          'bulk-' || lpad(i::text, 3, '0') || '@example.test', true, i % 4 <> 0
        FROM generate_series(1, 300) i;
      INSERT INTO auth.member(id, organization_id, user_id, role)
        SELECT 'bulk-m-' || i, 'bulk-team-' || (ARRAY['e','f','g'])[i % 3 + 1], 'bulk-' || lpad(i::text, 3, '0'),
          CASE WHEN i % 5 = 0 THEN 'viewer' ELSE 'recruiter' END
        FROM generate_series(1, 300) i;
      INSERT INTO auth.member(id, organization_id, user_id, role)
        SELECT 'bulk-x-' || i, 'bulk-team-e', 'bulk-' || lpad(i::text, 3, '0'), 'viewer'
        FROM generate_series(1, 300) i WHERE i % 7 = 0 AND i % 3 <> 0;
      INSERT INTO app.workspace_admins(workspace_id, user_id, level, areas)
        SELECT '${COMPANY}', 'bulk-' || lpad(i::text, 3, '0'), 'admin',
          CASE WHEN i % 50 = 1 THEN '{people}'::text[] ELSE '{fields}'::text[] END
        FROM generate_series(1, 300) i WHERE i % 50 IN (1, 2);
      INSERT INTO app.workspace_admins(workspace_id, user_id, level, areas) VALUES ('${COMPANY}', 'bulk-003', 'owner', '{}');
      INSERT INTO auth.invitation(id, organization_id, email, role, status, expires_at, inviter_id)
        SELECT 'bulk-invite-' || i, CASE WHEN i % 2 = 1 THEN 'bulk-team-e' ELSE 'bulk-team-f' END,
          'bulk-invite-' || lpad(i::text, 3, '0') || '@example.test', 'recruiter',
          CASE WHEN i <= 40 THEN 'pending' ELSE 'canceled' END, now() + interval '1 day', 'bulk-owner'
        FROM generate_series(1, 45) i;`);
    for (let i = 1; i <= 300; i++) {
      const primary = LETTERS[i % 3];
      const role = i % 11 === 0 ? sourcer : i % 13 === 0 ? screener : null;
      if (role)
        await harness.client.query(
          "INSERT INTO app.member_roles(team_id, user_id, role_object_id) VALUES ($1, $2, $3)",
          [`bulk-team-${primary}`, `bulk-${pad(i)}`, role],
        );
      const extra = i % 7 === 0 && i % 3 !== 0;
      if (extra && i % 2 === 0)
        await harness.client.query(
          "INSERT INTO app.member_roles(team_id, user_id, role_object_id) VALUES ('bulk-team-e', $1, $2)",
          [`bulk-${pad(i)}`, screener],
        );
      const teams: Person["teams"] = new Map([
        [
          primary,
          {
            role: i % 5 === 0 ? "viewer" : "recruiter",
            configured:
              role === sourcer
                ? "Fictional Bulk Sourcer"
                : role === screener
                  ? "Fictional Bulk Screener"
                  : null,
          },
        ],
      ]);
      if (extra)
        teams.set("e", {
          role: "viewer",
          configured: i % 2 === 0 ? "Fictional Bulk Screener" : null,
        });
      people.push({
        email: `bulk-${pad(i)}@example.test`,
        name: `Fictional Person ${pad(i)}`,
        status: "active",
        level:
          i === 3 ? "owner" : i % 50 === 1 || i % 50 === 2 ? "admin" : null,
        teams,
      });
    }
    people.push({
      email: "bulk-owner@example.test",
      name: "Fictional Bulk Owner",
      status: "active",
      level: "owner",
      teams: new Map(
        LETTERS.map((letter) => [letter, { role: "owner", configured: null }]),
      ),
    });
    for (let i = 1; i <= 40; i++)
      people.push({
        email: `bulk-invite-${pad(i)}@example.test`,
        name: "",
        status: "invited",
        level: null,
        teams: new Map([
          [i % 2 === 1 ? "e" : "f", { role: "recruiter", configured: null }],
        ]),
      });
  });
  afterAll(async () => harness?.close());

  it("walks every page of 25 with no row repeated or missed, in the same order twice", async () => {
    const first = await walk(owner);
    expect(first).toHaveLength(341);
    expect(new Set(first.map((row) => row.email)).size).toBe(341);
    expect(keysOf(first)).toEqual(expected(() => true));
    expect(await walk(owner)).toEqual(first);
    // Invited rows sort by email, people by name: both runs are in their own order.
    const invited = first.filter((row) => row.status === "invited");
    expect(invited.map((row) => row.email)).toEqual(
      invited.map((row) => row.email).sort(),
    );
    const named = first
      .filter((row) => row.name?.startsWith("Fictional Person"))
      .map((row) => row.name);
    expect(named).toEqual([...named].sort());
    const one = first.find((row) => row.email === "bulk-022@example.test")!;
    expect(one).toEqual({
      userId: "bulk-022",
      name: "Fictional Person 022",
      email: "bulk-022@example.test",
      teams: [
        {
          team: "Fictional F Team",
          teamRole: "recruiter",
          configuredRole: "Fictional Bulk Sourcer",
        },
      ],
      companyLevel: null,
      status: "active",
      lastSignInAt: null,
      twoStep: true,
    });
    // Two teams, ordered by team name.
    expect(
      first.find((row) => row.email === "bulk-014@example.test")!.teams,
    ).toEqual([
      {
        team: "Fictional E Team",
        teamRole: "viewer",
        configuredRole: "Fictional Bulk Screener",
      },
      { team: "Fictional G Team", teamRole: "recruiter", configuredRole: null },
    ]);
  });

  it("offers the published, unarchived roles by name", async () => {
    const { body } = await get(owner);
    expect(body.roles).toEqual([
      { key: "bulk-screener", name: "Fictional Bulk Screener" },
      { key: "bulk-sourcer", name: "Fictional Bulk Sourcer" },
    ]);
  });

  it("filters by team, status, company level and configured role, alone and combined", async () => {
    const inTeam = (letter: string) => (person: Person) =>
      person.teams.has(letter);
    const holds = (name: string, letter?: string) => (person: Person) =>
      [...person.teams].some(
        ([team, value]) =>
          value.configured === name &&
          (letter === undefined || team === letter),
      );
    for (const [filters, keep] of [
      [{ team: "fictional-e" }, inTeam("e")],
      [{ team: "fictional-g" }, inTeam("g")],
      [{ status: "active" }, (person: Person) => person.status === "active"],
      [{ status: "invited" }, (person: Person) => person.status === "invited"],
      [{ level: "owner" }, (person: Person) => person.level === "owner"],
      [{ level: "admin" }, (person: Person) => person.level === "admin"],
      [{ level: "none" }, (person: Person) => person.level === null],
      [{ role: "bulk-sourcer" }, holds("Fictional Bulk Sourcer")],
      [{ role: "bulk-screener" }, holds("Fictional Bulk Screener")],
      [
        { team: "fictional-e", role: "bulk-screener" },
        holds("Fictional Bulk Screener", "e"),
      ],
      [
        { team: "fictional-f", status: "invited" },
        (person: Person) => person.status === "invited" && inTeam("f")(person),
      ],
      [
        { team: "fictional-e", level: "admin", status: "active" },
        (person: Person) => person.level === "admin" && inTeam("e")(person),
      ],
    ] as [Record<string, string>, (person: Person) => boolean][]) {
      const want = expected(keep);
      expect(want.length, JSON.stringify(filters)).toBeGreaterThan(0);
      expect(
        keysOf(await walk(owner, filters)),
        JSON.stringify(filters),
      ).toEqual(want);
    }
    for (const filters of [
      { team: "fictional-unknown" },
      { role: "bulk-unknown" },
      { role: "bulk-archived" },
      { role: "bulk-sourcer", status: "invited" },
    ] as Record<string, string>[])
      expect(await walk(owner, filters), JSON.stringify(filters)).toEqual([]);
  });
});

// ADM-08 (job 076): one person through tenant_context.workspace_person and its route.
describe("one workspace person under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, peopleAdmin: Principal, fieldsAdmin: Principal;
  let teamOwnerB: Principal, recruiter: Principal, viewer: Principal;
  let ownerD: Principal;
  let leaks: string[];
  const PERSON_HELPER_KEYS = [
    "user_id",
    "name",
    "email",
    "last_sign_in",
    "two_step",
    "signed_in_devices",
    "teams",
    "company_level",
    "company_areas",
    "plan_access",
    "authority_suspended",
    "authority_since",
    "events",
  ];
  const PERSON_KEYS = [
    "userId",
    "name",
    "email",
    "status",
    "lastSignInAt",
    "twoStep",
    "signedInDevices",
    "teams",
    "companyLevel",
    "companyAreas",
    "planAccess",
    "authoritySuspended",
    "authoritySince",
    "events",
  ].sort();
  const TEAM_KEYS = ["configuredRole", "slug", "team", "teamRole"];
  const EVENT_KEYS = [
    "action",
    "actorId",
    "actorName",
    "objectKey",
    "objectType",
    "occurredAt",
    "roleName",
  ];

  /** The helper itself, called on the data role in the principal's installed context. */
  const helper = async (p: Principal, target: string | null) => {
    await harness.dataDb();
    return withTeam(
      p,
      async (tx) =>
        (
          await tx.execute<Record<string, unknown>>(
            sql`select * from tenant_context.workspace_person(${target}::text)`,
          )
        ).rows,
    );
  };
  /** GET /api/v1/admin/users/<id> as a signed-in member, a Bearer token or nobody. */
  async function getPerson(
    as: Principal | "bearer" | "anonymous",
    id: string,
    query = "",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; text: string; body: any }> {
    if (as === "anonymous")
      vi.mocked(getVerifiedSession).mockImplementation(
        async () => requireVerifiedIdentity(null) as never,
      );
    else if (as !== "bearer") signIn(as);
    const response = await personRoute(
      new Request(
        `${ORIGIN}/api/v1/admin/users/${encodeURIComponent(id)}${query}`,
        {
          headers: {
            origin: ORIGIN,
            ...(as === "bearer"
              ? { authorization: "Bearer fictional-users-token" }
              : as === "anonymous"
                ? {}
                : { "x-team-id": as.teamId }),
          },
        },
      ),
      { params: Promise.resolve({ user: id }) },
    );
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  }
  /** One app.activity row as the owner would write it, at a fixed time. */
  const event = (
    team: string,
    actor: string,
    action: string,
    kind: string,
    metadata: Record<string, unknown>,
    at: string,
  ) =>
    `('${team}', '${actor}', 'session', '${action}', '${kind}', 'Fictional summary ${action}', '${JSON.stringify(metadata)}'::jsonb, '${at}')`;
  const config = (workspace: string, type: string, key: string) => ({
    workspaceId: workspace,
    type,
    key,
    number: 1,
    objectId: "00000000-0000-4000-a000-0000000000c0",
  });

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    owner = await seedIdentity(db, {
      userId: "person-owner",
      teamId: "person-team-a",
    });
    peopleAdmin = await seedIdentity(db, {
      userId: "person-people-admin",
      teamId: "person-team-a",
      role: "recruiter",
    });
    fieldsAdmin = await seedIdentity(db, {
      userId: "person-fields-admin",
      teamId: "person-team-a",
      role: "recruiter",
    });
    recruiter = await seedIdentity(db, {
      userId: "person-recruiter",
      teamId: "person-team-a",
      role: "recruiter",
    });
    viewer = await seedIdentity(db, {
      userId: "person-viewer",
      teamId: "person-team-a",
      role: "viewer",
    });
    // A team-only owner of team B.
    teamOwnerB = await seedIdentity(db, {
      userId: "person-owner-b",
      teamId: "person-team-b",
    });
    // The person the page opens: a recruiter in team A, a viewer in team B, and an admin in team
    // D, which moves to a second workspace below.
    await seedIdentity(db, {
      userId: "person-subject",
      teamId: "person-team-a",
      role: "recruiter",
    });
    await seedIdentity(db, {
      userId: "person-subject",
      teamId: "person-team-b",
      role: "viewer",
    });
    ownerD = await seedIdentity(db, {
      userId: "person-owner-d",
      teamId: "person-team-d",
    });
    await seedIdentity(db, {
      userId: "person-subject",
      teamId: "person-team-d",
      role: "admin",
    });
    // Someone only in the second workspace, and someone with two-step off and no authority.
    await seedIdentity(db, {
      userId: "person-only-d",
      teamId: "person-team-d",
      role: "recruiter",
    });
    await seedIdentity(db, {
      userId: "person-plain",
      teamId: "person-team-b",
      role: "recruiter",
      twoFactorEnabled: false,
    });
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${COMPANY}','person-people-admin','admin','{people}');
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${COMPANY}','person-fields-admin','admin','{fields}');
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas,plan_access,granted_at,suspended_at) VALUES
        ('${COMPANY}','person-subject','admin','{fields,organisation}',true,'2026-10-01T08:00:00Z','2026-10-20T08:00:00Z');
      INSERT INTO app.workspaces(id,name) VALUES ('${SECOND}','Fictional Second Company');
      UPDATE app.workspace_teams SET workspace_id = '${SECOND}' WHERE team_id = 'person-team-d';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${SECOND}','person-owner-d','owner','{}');
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas,plan_access) VALUES ('${SECOND}','person-subject','admin','{people}',false);`);
    const sourcer = await publishRole(
      harness,
      owner,
      "person-sourcer",
      "Fictional Person Sourcer",
    );
    await harness.asSuperuser();
    const [{ version }] = (
      await harness.client.query<{ version: string }>(
        "SELECT current_version_id::text AS version FROM app.config_objects WHERE id = $1",
        [sourcer],
      )
    ).rows;
    await harness.client.query(
      "INSERT INTO app.member_roles(team_id, user_id, role_object_id) VALUES ('person-team-a', 'person-subject', $1)",
      [sourcer],
    );
    await harness.dataDb();
    const candidate = await createRecord(owner, "candidates", {
      data: { name: "Fictional Person Leak Candidate" },
    });
    const token = await seedApiToken(await harness.asOwner(), owner);
    await harness.asSuperuser();
    const rows = [
      // In: configuration the person made in this workspace; a task board of the caller's team A.
      event(
        "person-team-a",
        "person-subject",
        "config.draft_created",
        "config",
        config(COMPANY, "workflow", "fictional-flow"),
        "2026-10-02T08:00:00Z",
      ),
      event(
        "person-team-a",
        "person-subject",
        "config.published",
        "config",
        config(COMPANY, "task-board", "fictional-board-a"),
        "2026-10-03T08:00:00Z",
      ),
      // In: access changes made to the person.
      event(
        "person-team-a",
        "person-owner",
        "role.assigned",
        "role-assignment",
        {
          workspaceId: COMPANY,
          affectedUserId: "person-subject",
          roleObjectId: sourcer,
          roleVersionId: version,
        },
        "2026-10-04T08:00:00Z",
      ),
      event(
        "person-team-a",
        "person-owner",
        "role.cleared",
        "role-assignment",
        {
          workspaceId: COMPANY,
          affectedUserId: "person-subject",
          roleObjectId: sourcer,
          roleVersionId: null,
        },
        "2026-10-05T08:00:00Z",
      ),
      event(
        "person-team-a",
        "person-owner",
        "scope.home_units_changed",
        "scope",
        {
          workspaceId: COMPANY,
          affectedUserIds: ["person-recruiter", "person-subject"],
          unitIds: ["00000000-0000-4000-a000-0000000000a1"],
        },
        "2026-10-06T08:00:00Z",
      ),
      event(
        "person-team-a",
        "person-owner",
        "workspace_authority.changed",
        "workspace-authority",
        {
          targetUserId: "person-subject",
          before: null,
          after: { level: "admin" },
        },
        "2026-10-07T08:00:00Z",
      ),
      event(
        "person-team-b",
        "person-owner-b",
        "two_step.reset",
        "account-security",
        { targetUserId: "person-subject" },
        "2026-10-08T08:00:00Z",
      ),
      // Out: another team's task board, someone else's configuration, another workspace's rows.
      event(
        "person-team-b",
        "person-subject",
        "config.published",
        "config",
        config(COMPANY, "task-board", "fictional-board-b"),
        "2026-10-09T08:00:00Z",
      ),
      event(
        "person-team-a",
        "person-owner",
        "config.published",
        "config",
        config(COMPANY, "workflow", "fictional-owner-flow"),
        "2026-10-10T08:00:00Z",
      ),
      event(
        "person-team-d",
        "person-subject",
        "config.published",
        "config",
        config(SECOND, "workflow", "fictional-second-flow"),
        "2026-10-11T08:00:00Z",
      ),
      event(
        "person-team-d",
        "person-owner-d",
        "role.assigned",
        "role-assignment",
        {
          workspaceId: SECOND,
          affectedUserId: "person-subject",
          roleObjectId: sourcer,
          roleVersionId: version,
        },
        "2026-10-12T08:00:00Z",
      ),
      event(
        "person-team-d",
        "person-owner-d",
        "scope.home_units_changed",
        "scope",
        { workspaceId: SECOND, affectedUserIds: ["person-subject"] },
        "2026-10-13T08:00:00Z",
      ),
      event(
        "person-team-d",
        "person-owner-d",
        "workspace_authority.changed",
        "workspace-authority",
        { targetUserId: "person-subject" },
        "2026-10-14T08:00:00Z",
      ),
      event(
        "person-team-d",
        "person-owner-d",
        "two_step.reset",
        "account-security",
        { targetUserId: "person-subject" },
        "2026-10-15T08:00:00Z",
      ),
      // Out: rows about other people, the person's own changes to others, a team archive row (job
      // 078) and a record row.
      event(
        "person-team-a",
        "person-owner",
        "role.assigned",
        "role-assignment",
        {
          workspaceId: COMPANY,
          affectedUserId: "person-recruiter",
          roleObjectId: sourcer,
          roleVersionId: version,
        },
        "2026-10-16T08:00:00Z",
      ),
      event(
        "person-team-a",
        "person-owner",
        "scope.home_units_changed",
        "scope",
        { workspaceId: COMPANY, affectedUserIds: ["person-recruiter"] },
        "2026-10-17T08:00:00Z",
      ),
      event(
        "person-team-a",
        "person-owner",
        "workspace_authority.changed",
        "workspace-authority",
        { targetUserId: "person-people-admin" },
        "2026-10-18T08:00:00Z",
      ),
      event(
        "person-team-a",
        "person-subject",
        "two_step.reset",
        "account-security",
        { targetUserId: "person-recruiter" },
        "2026-10-19T08:00:00Z",
      ),
      event(
        "person-team-a",
        "person-subject",
        "team.archived",
        "team-archive",
        {},
        "2026-10-20T08:00:00Z",
      ),
      event(
        "person-team-a",
        "person-subject",
        "record.created",
        "candidate",
        { workspaceId: COMPANY },
        "2026-10-21T08:00:00Z",
      ),
    ];
    await harness.client.exec(`
      UPDATE auth.organization SET name = 'Fictional ' || upper(split_part(id, '-', 3)) || ' Team',
        slug = 'fictional-' || split_part(id, '-', 3) WHERE id LIKE 'person-team-%';
      UPDATE auth."user" SET name = 'Fictional ' || initcap(replace(id, '-', ' ')) WHERE id LIKE 'person-%';
      INSERT INTO auth.session(id, expires_at, token, created_at, updated_at, user_id, ip_address, user_agent) VALUES
        ('person-session-1', now() + interval '1 day', 'fictional-person-token-1', '2026-11-01T09:00:00Z', now(), 'person-subject', '192.0.2.20', 'Fictional Person Agent'),
        ('person-session-2', now() + interval '2 days', 'fictional-person-token-2', '2026-11-03T09:00:00Z', now(), 'person-subject', '192.0.2.21', 'Fictional Person Agent'),
        ('person-session-3', now() - interval '1 minute', 'fictional-person-token-3', '2026-11-06T09:00:00Z', now(), 'person-subject', '192.0.2.22', 'Fictional Person Agent'),
        ('person-session-4', now() + interval '1 day', 'fictional-person-token-4', '2026-11-07T09:00:00Z', now(), 'person-owner', '192.0.2.23', 'Fictional Person Agent');
      INSERT INTO app.activity(team_id, actor_id, actor_type, action, kind, summary, metadata, created_at) VALUES
        ${rows.join(",\n        ")};`);
    leaks = [
      candidate.id,
      "Fictional Person Leak Candidate",
      token.tokenId!,
      "ros_live_fiction",
      "person-session-",
      "fictional-person-token",
      "192.0.2.",
      "Fictional Person Agent",
      "person-team-",
      "Fictional summary",
      "00000000-0000-4000-a000-0000000000a1",
      "00000000-0000-4000-a000-0000000000c0",
      sourcer,
      version,
      COMPANY,
      ...(
        await harness.client.query<{ id: string }>(
          "SELECT id::text FROM app.activity UNION SELECT token_hash FROM auth.api_tokens",
        )
      ).rows.map((row) => row.id),
    ];
  });
  afterAll(async () => harness?.close());

  it("returns one row with exactly the documented columns to a company owner and a people admin", async () => {
    for (const p of [owner, peopleAdmin]) {
      const rows = await helper(p, "person-subject");
      expect(rows, p.userId).toHaveLength(1);
      const [row] = rows;
      expect(Object.keys(row), p.userId).toEqual(PERSON_HELPER_KEYS);
      expect(row, p.userId).toMatchObject({
        user_id: "person-subject",
        name: "Fictional Person Subject",
        email: "person-subject@example.test",
        two_step: true,
        // Two sessions have not expired; the expired one still counts for the last sign-in.
        signed_in_devices: 2,
        teams: [
          {
            team: "Fictional A Team",
            slug: "fictional-a",
            teamRole: "recruiter",
            configuredRole: "Fictional Person Sourcer",
          },
          {
            team: "Fictional B Team",
            slug: "fictional-b",
            teamRole: "viewer",
            configuredRole: null,
          },
        ],
        company_level: "admin",
        company_areas: ["fields", "organisation"],
        plan_access: true,
        authority_suspended: true,
      });
      expect(new Date(row.last_sign_in as string).toISOString()).toBe(
        "2026-11-06T09:00:00.000Z",
      );
      expect(new Date(row.authority_since as string).toISOString()).toBe(
        "2026-10-01T08:00:00.000Z",
      );
      for (const team of row.teams as Record<string, unknown>[])
        expect(Object.keys(team).sort()).toEqual(TEAM_KEYS);
    }
    // Without company authority the five authority columns are null; two-step off, no session.
    const [plain] = await helper(owner, "person-plain");
    expect(plain).toMatchObject({
      two_step: false,
      signed_in_devices: 0,
      last_sign_in: null,
      company_level: null,
      company_areas: null,
      plan_access: null,
      authority_suspended: null,
      authority_since: null,
      events: [],
    });
  });

  it("lists only the person's configuration changes and the access changes made to them, newest first", async () => {
    const actor = (id: string, name: string) => ({
      actorId: id,
      actorName: name,
    });
    const access = { objectType: null, objectKey: null, roleName: null };
    for (const p of [owner, peopleAdmin]) {
      const [row] = await helper(p, "person-subject");
      const events = row.events as Record<string, unknown>[];
      for (const item of events)
        expect(Object.keys(item).sort(), p.userId).toEqual(EVENT_KEYS);
      expect(
        events.map((item) => ({
          ...item,
          occurredAt: new Date(item.occurredAt as string).toISOString(),
        })),
        p.userId,
      ).toEqual([
        {
          occurredAt: "2026-10-08T08:00:00.000Z",
          action: "two_step.reset",
          ...actor("person-owner-b", "Fictional Person Owner B"),
          ...access,
        },
        {
          occurredAt: "2026-10-07T08:00:00.000Z",
          action: "workspace_authority.changed",
          ...actor("person-owner", "Fictional Person Owner"),
          ...access,
        },
        {
          occurredAt: "2026-10-06T08:00:00.000Z",
          action: "scope.home_units_changed",
          ...actor("person-owner", "Fictional Person Owner"),
          ...access,
        },
        {
          occurredAt: "2026-10-05T08:00:00.000Z",
          action: "role.cleared",
          ...actor("person-owner", "Fictional Person Owner"),
          ...access,
        },
        {
          occurredAt: "2026-10-04T08:00:00.000Z",
          action: "role.assigned",
          ...actor("person-owner", "Fictional Person Owner"),
          ...access,
          roleName: "Fictional Person Sourcer",
        },
        {
          occurredAt: "2026-10-03T08:00:00.000Z",
          action: "config.published",
          ...actor("person-subject", "Fictional Person Subject"),
          objectType: "task-board",
          objectKey: "fictional-board-a",
          roleName: null,
        },
        {
          occurredAt: "2026-10-02T08:00:00.000Z",
          action: "config.draft_created",
          ...actor("person-subject", "Fictional Person Subject"),
          objectType: "workflow",
          objectKey: "fictional-flow",
          roleName: null,
        },
      ]);
    }
  });

  it("returns at most 50 events, the newest", async () => {
    await harness.asSuperuser();
    await harness.client.exec(`
      INSERT INTO app.activity(team_id, actor_id, actor_type, action, kind, summary, metadata, created_at)
        SELECT 'person-team-b', 'person-plain', 'session', 'config.draft_created', 'config', 'Fictional summary',
          jsonb_build_object('workspaceId', '${COMPANY}', 'type', 'workflow', 'key', 'fictional-many-' || lpad(i::text, 2, '0'), 'number', 1),
          '2026-09-01T00:00:00Z'::timestamptz + i * interval '1 hour'
        FROM generate_series(1, 55) i;`);
    const [row] = await helper(owner, "person-plain");
    const events = row.events as { objectKey: string }[];
    expect(events).toHaveLength(50);
    expect(events.map((item) => item.objectKey)).toEqual(
      Array.from(
        { length: 50 },
        (_, i) => `fictional-many-${String(55 - i).padStart(2, "0")}`,
      ),
    );
    const { body } = await getPerson(owner, "person-plain");
    expect(body.data.events).toHaveLength(50);
    expect(body.data.events[0].objectKey).toBe("fictional-many-55");
  });

  it("refuses a company admin without people, a team-only owner, a recruiter, a viewer and a token context", async () => {
    for (const p of [fieldsAdmin, teamOwnerB, recruiter, viewer]) {
      await expect(helper(p, "person-subject"), p.userId).rejects.toMatchObject(
        { cause: { code: "42501" } },
      );
      const { status, body } = await getPerson(p, "person-subject");
      expect(status, p.userId).toBe(403);
      expect(body.error.code, p.userId).toBe("people_forbidden");
    }
    await expect(
      helper(
        await seedApiToken(await harness.asOwner(), owner),
        "person-subject",
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    const calls = pools.data.mock.calls.length;
    const bearer = await getPerson("bearer", "person-subject");
    expect(bearer.status).toBe(403);
    expect(bearer.body.error.code).toBe("session_required");
    expect(pools.data.mock.calls.length).toBe(calls);
    expect((await getPerson("anonymous", "person-subject")).status).toBe(401);
  });

  it("refuses a null, empty or 129-character id with 22023", async () => {
    for (const target of [null, "", "a".repeat(129)])
      await expect(
        helper(owner, target),
        String(target?.length),
      ).rejects.toMatchObject({ cause: { code: "22023" } });
    expect(await helper(owner, "a".repeat(128))).toEqual([]);
  });

  it("answers a person only in another workspace and an unknown id with no row and 404", async () => {
    for (const target of ["person-only-d", "person-unknown"]) {
      expect(await helper(owner, target), target).toEqual([]);
      const { status, body, text } = await getPerson(peopleAdmin, target);
      expect(status, target).toBe(404);
      expect(body.error.code, target).toBe("user_not_found");
      expect(body.error.message).toBe(
        "This person is not in any team of your company.",
      );
      expect(text).not.toContain("Fictional Person Only D");
    }
    // The second workspace's owner sees the shared person with that workspace's team, authority
    // and events only.
    const [row] = await helper(ownerD, "person-subject");
    expect(row).toMatchObject({
      teams: [
        {
          team: "Fictional D Team",
          slug: "fictional-d",
          teamRole: "admin",
          configuredRole: null,
        },
      ],
      company_level: "admin",
      company_areas: ["people"],
      plan_access: false,
      authority_suspended: false,
    });
    expect(
      (row.events as { action: string; objectKey: string | null }[]).map(
        (item) => [item.action, item.objectKey],
      ),
    ).toEqual([
      ["two_step.reset", null],
      ["workspace_authority.changed", null],
      ["scope.home_units_changed", null],
      ["role.assigned", null],
      ["config.published", "fictional-second-flow"],
    ]);
    expect(await helper(ownerD, "person-owner")).toEqual([]);
  });

  it("answers the route with exactly the documented keys and nothing of records, tokens, sessions or team ids", async () => {
    for (const p of [owner, peopleAdmin]) {
      const { status, body, text } = await getPerson(p, "person-subject");
      expect(status, p.userId).toBe(200);
      expect(Object.keys(body)).toEqual(["data"]);
      expect(Object.keys(body.data).sort()).toEqual(PERSON_KEYS);
      expect(body.data).toMatchObject({
        userId: "person-subject",
        status: "active",
        lastSignInAt: "2026-11-06T09:00:00.000Z",
        twoStep: true,
        signedInDevices: 2,
        companyLevel: "admin",
        companyAreas: ["fields", "organisation"],
        planAccess: true,
        authoritySuspended: true,
        authoritySince: "2026-10-01T08:00:00.000Z",
      });
      for (const team of body.data.teams)
        expect(Object.keys(team).sort()).toEqual(TEAM_KEYS);
      expect(body.data.events).toHaveLength(7);
      for (const item of body.data.events)
        expect(Object.keys(item).sort()).toEqual(EVENT_KEYS);
      expect(body.data.events[0].occurredAt).toBe("2026-10-08T08:00:00.000Z");
      for (const leak of [...leaks, SECOND, "Fictional D Team", "fictional-d"])
        expect(text, `${p.userId}: ${leak}`).not.toContain(leak);
    }
  });

  it("refuses an unknown query parameter and an over-long id with 400 and no helper call", async () => {
    for (const [id, query] of [
      ["person-subject", "?tab=security"],
      ["person-subject", "?userId=person-owner"],
      ["a".repeat(129), ""],
    ]) {
      const calls = pools.data.mock.calls.length;
      const { status, body } = await getPerson(owner, id, query);
      expect(status, query || String(id.length)).toBe(400);
      expect(body.error.code).toBe("invalid_input");
      expect(pools.data.mock.calls.length).toBe(calls);
    }
  });
});
