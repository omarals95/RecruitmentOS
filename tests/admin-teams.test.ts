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
import { requireVerifiedIdentity } from "@/lib/auth-policy";
import { getVerifiedSession } from "@/lib/auth-session";
import { withTeam } from "@/lib/db-team";
import type { Principal } from "@/lib/principal";
import { GET as teamsRoute } from "@/app/api/v1/teams/route";
import {
  addMember,
  authCaller,
  createTestAuth,
  setUpAdmin,
  type Mail,
} from "./helpers/auth";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace with three fictional teams, and a second workspace
// the owner role inserts, with one more (ADM-02, job 069).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const SECOND = "00000000-0000-4000-a000-000000000069";
const ORIGIN = "http://localhost:3000";
const ROW_KEYS = [
  "createdAt",
  "current",
  "name",
  "slug",
  "teamId",
  "teamRole",
].sort();
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Row = {
  teamId: string | null;
  name: string;
  slug: string;
  createdAt: string;
  teamRole: string | null;
  current: boolean;
};

const signIn = (p: { userId: string; teamId: string }) =>
  vi.mocked(getVerifiedSession).mockResolvedValue({
    user: { id: p.userId, twoFactorEnabled: true },
    session: { activeOrganizationId: p.teamId },
  } as never);
/** GET /api/v1/teams as a signed-in member, a Bearer token or nobody. */
async function get(
  as: Principal | "bearer" | "anonymous",
  path = "/api/v1/teams",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; text: string; body: any }> {
  if (as === "anonymous")
    vi.mocked(getVerifiedSession).mockImplementation(
      async () => requireVerifiedIdentity(null) as never,
    );
  else if (as !== "bearer") signIn(as);
  const response = await teamsRoute(
    new Request(`${ORIGIN}${path}`, {
      headers: {
        origin: ORIGIN,
        ...(as === "bearer"
          ? { authorization: "Bearer fictional-teams-token" }
          : as === "anonymous"
            ? {}
            : { "x-team-id": as.teamId }),
      },
    }),
  );
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

describe("the workspace team list under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, companyAdmin: Principal, teamOwnerB: Principal;
  let recruiter: Principal, viewer: Principal, ownerD: Principal;
  let created: Record<string, string>;

  /** Raw statements as the PGlite superuser, which bypasses RLS; only to arrange or inspect. */
  const superuser = async <T>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  /** The helper itself, called on the data role in the principal's installed context. */
  const helper = async (p: Principal) => {
    await harness.dataDb();
    return withTeam(
      p,
      async (tx) =>
        (
          await tx.execute(
            sql`select * from tenant_context.workspace_team_list()`,
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
      userId: "teams-owner",
      teamId: "teams-team-a",
    });
    companyAdmin = await seedIdentity(db, {
      userId: "teams-company-admin",
      teamId: "teams-team-a",
      role: "recruiter",
    });
    recruiter = await seedIdentity(db, {
      userId: "teams-recruiter",
      teamId: "teams-team-a",
      role: "recruiter",
    });
    viewer = await seedIdentity(db, {
      userId: "teams-viewer",
      teamId: "teams-team-a",
      role: "viewer",
    });
    // A team-only owner, who is also a recruiter in team A.
    teamOwnerB = await seedIdentity(db, {
      userId: "teams-owner-b",
      teamId: "teams-team-b",
    });
    await seedIdentity(db, {
      userId: "teams-owner-b",
      teamId: "teams-team-a",
      role: "recruiter",
    });
    // A team none of the callers belong to.
    await seedIdentity(db, { userId: "teams-owner-c", teamId: "teams-team-c" });
    // Created while one workspace exists, then moved to a second one by the owner role.
    ownerD = await seedIdentity(db, {
      userId: "teams-owner-d",
      teamId: "teams-team-d",
    });
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${COMPANY}','teams-company-admin','admin','{}');
      INSERT INTO app.workspaces(id,name) VALUES ('${SECOND}','Fictional Second Company');
      UPDATE app.workspace_teams SET workspace_id = '${SECOND}' WHERE team_id = 'teams-team-d';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${SECOND}','teams-owner-d','owner','{}');`);
    // Names, slugs and member names that differ from every id, so a leak is visible.
    await harness.asSuperuser();
    await harness.client.exec(`
      UPDATE auth.organization SET name = 'Fictional ' || initcap(split_part(id, '-', 3)) || ' Team',
        slug = 'fictional-' || split_part(id, '-', 3) WHERE id LIKE 'teams-team-%';
      UPDATE auth."user" SET name = 'Fictional Member ' || id WHERE id LIKE 'teams-%'`);
    created = Object.fromEntries(
      (
        await superuser<{ id: string; created_at: Date }>(
          "SELECT id, created_at FROM auth.organization",
        )
      ).map((row) => [row.id, new Date(row.created_at).toISOString()]),
    );
  });
  afterAll(async () => harness?.close());

  it("returns id, name, slug and created date of every team of the context's workspace to a company owner and admin", async () => {
    for (const p of [owner, companyAdmin]) {
      const rows = (await helper(p)) as Record<string, unknown>[];
      expect(
        rows.map((row) => Object.keys(row)),
        p.userId,
      ).toEqual(rows.map(() => ["id", "name", "slug", "created_at"]));
      expect(
        rows.map((row) => ({
          ...row,
          created_at: new Date(row.created_at as string).toISOString(),
        })),
        p.userId,
      ).toEqual(
        ["a", "b", "c"].map((letter) => ({
          id: `teams-team-${letter}`,
          name: `Fictional ${letter.toUpperCase()} Team`,
          slug: `fictional-${letter}`,
          created_at: created[`teams-team-${letter}`],
        })),
      );
    }
  });

  it("refuses a team-only owner, a recruiter, a viewer and a token context of the company owner", async () => {
    for (const p of [teamOwnerB, recruiter, viewer]) await expectRefused(p);
    await expectRefused(await seedApiToken(await harness.asOwner(), owner));
  });

  it("never returns a team mapped to another workspace, in either direction", async () => {
    for (const p of [owner, companyAdmin])
      expect(
        ((await helper(p)) as { id: string }[]).map((row) => row.id),
      ).not.toContain("teams-team-d");
    // The second workspace's own company owner sees only its team.
    expect(
      ((await helper(ownerD)) as { id: string }[]).map((row) => row.id),
    ).toEqual(["teams-team-d"]);
    for (const p of [owner, companyAdmin]) {
      const { status, text } = await get(p);
      expect(status, p.userId).toBe(200);
      for (const leak of ["teams-team-d", "fictional-d", "D Team", SECOND])
        expect(text, `${p.userId}: ${leak}`).not.toContain(leak);
    }
    const { body } = await get(ownerD);
    expect(body.data.map((row: Row) => row.slug)).toEqual(["fictional-d"]);
  });

  it("lists only a team-only owner's own owner and admin teams", async () => {
    const { status, body } = await get(teamOwnerB);
    expect(status).toBe(200);
    expect(body).toEqual({
      data: [
        {
          teamId: "teams-team-b",
          name: "Fictional B Team",
          slug: "fictional-b",
          createdAt: created["teams-team-b"],
          teamRole: "owner",
          current: true,
        },
      ],
    });
  });

  it("lists every workspace team to a company owner and admin, other teams with no id and no access", async () => {
    for (const [p, role] of [
      [owner, "owner"],
      [companyAdmin, "recruiter"],
    ] as const) {
      const { status, body, text } = await get(p);
      expect(status, p.userId).toBe(200);
      for (const row of body.data)
        expect(Object.keys(row).sort(), p.userId).toEqual(ROW_KEYS);
      expect(body.data, p.userId).toEqual([
        {
          teamId: "teams-team-a",
          name: "Fictional A Team",
          slug: "fictional-a",
          createdAt: created["teams-team-a"],
          teamRole: role,
          current: true,
        },
        ...["b", "c"].map((letter) => ({
          teamId: null,
          name: `Fictional ${letter.toUpperCase()} Team`,
          slug: `fictional-${letter}`,
          createdAt: created[`teams-team-${letter}`],
          teamRole: null,
          current: false,
        })),
      ]);
      // No member name, email or user id, and no id of a team the caller is not in.
      for (const leak of [
        "teams-owner-b",
        "teams-owner-c",
        "Fictional Member",
        "@example.test",
        "teams-team-b",
        "teams-team-c",
      ])
        expect(text, `${p.userId}: ${leak}`).not.toContain(leak);
    }
  });

  it("refuses a recruiter, a viewer, a Bearer token, an anonymous caller and any query key", async () => {
    for (const p of [recruiter, viewer]) {
      const { status, body } = await get(p);
      expect(status, p.userId).toBe(403);
      expect(body.error.code, p.userId).toBe("teams_forbidden");
    }
    const bearer = await get("bearer");
    expect(bearer.status).toBe(403);
    expect(bearer.body.error.code).toBe("session_required");
    const anonymous = await get("anonymous");
    expect(anonymous.status).toBe(401);
    const query = await get(owner, "/api/v1/teams?archived=true");
    expect(query.status).toBe(400);
    expect(query.body.error.code).toBe("invalid_input");
  });
});

describe("creating a team for the Teams list through Better Auth", () => {
  let harness: Harness;
  const mail: Mail[] = [];
  let caller: ReturnType<typeof authCaller>;

  const superuser = async <T>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  /** Better Auth runs as the identity role; the mapping trigger runs as the owner. */
  const create = async (slug: string, cookie: string) => {
    await harness.identityDb();
    return caller.post(
      "organization/create",
      { name: `Fictional ${slug}`, slug },
      { cookie },
    );
  };
  const userId = async (email: string) =>
    (
      await superuser<{ id: string }>(
        'SELECT id FROM auth."user" WHERE email = $1',
        [email],
      )
    )[0].id;

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    caller = authCaller(createTestAuth(await harness.identityDb(), mail));
  });
  afterAll(async () => harness?.close());

  it("maps a team owner's new team in the workspace, lists it as Owner, and gives no company authority; refuses someone canCreateTeam refuses", async () => {
    await harness.identityDb();
    const admin = await setUpAdmin(caller, mail);
    const first = (
      await superuser<{ id: string }>(
        "SELECT id FROM auth.organization WHERE slug = 'fictional-first-team'",
      )
    )[0].id;
    await harness.identityDb();
    const later = await addMember(
      caller,
      mail,
      admin.cookie,
      first,
      "teams-later-owner@example.test",
      "owner",
    );
    await harness.identityDb();
    const member = await addMember(
      caller,
      mail,
      admin.cookie,
      first,
      "teams-later-recruiter@example.test",
      "recruiter",
    );
    const laterId = await userId("teams-later-owner@example.test");
    const admins = await superuser(
      "SELECT * FROM app.workspace_admins ORDER BY user_id",
    );
    const response = await create("teams-later-team", later.cookie);
    expect(response.status).toBe(200);
    const teamId = ((await response.json()) as { id: string }).id;
    expect(
      await superuser(
        "SELECT workspace_id FROM app.workspace_teams WHERE team_id = $1",
        [teamId],
      ),
    ).toEqual([{ workspace_id: COMPANY }]);
    expect(
      await superuser("SELECT * FROM app.workspace_admins ORDER BY user_id"),
    ).toEqual(admins);
    expect(
      await superuser(
        "SELECT count(*)::int AS n FROM app.workspace_admins WHERE user_id = $1",
        [laterId],
      ),
    ).toEqual([{ n: 0 }]);
    // The creator, now in the new team, lists it as Owner beside the first team they own.
    const listed = await get({
      userId: laterId,
      teamId,
      role: "owner",
      scopes: [],
      authType: "session",
    });
    expect(listed.status).toBe(200);
    expect(
      listed.body.data.map((row: Row) => [
        row.slug,
        row.teamRole,
        row.current,
        row.teamId,
      ]),
    ).toEqual([
      ["fictional-first-team", "owner", false, first],
      ["teams-later-team", "owner", true, teamId],
    ]);
    // A recruiter who owns no team and is not the initial administrator cannot create one.
    const refused = await create("teams-refused-team", member.cookie);
    expect(refused.ok).toBe(false);
    expect(
      await superuser(
        "SELECT count(*)::int AS n FROM auth.organization WHERE slug = 'teams-refused-team'",
      ),
    ).toEqual([{ n: 0 }]);
  });
});
