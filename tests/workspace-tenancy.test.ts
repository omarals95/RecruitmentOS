import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDb, TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import type { Principal } from "@/lib/principal";
import { installTenantContext } from "@/lib/tenant-context";
import {
  addMember,
  authCaller,
  createTeam,
  createTestAuth,
  setUpAdmin,
  type Mail,
} from "./helpers/auth";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace above four fictional teams (R2a-01, 0028).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const TABLES = ["workspaces", "workspace_teams", "workspace_admins"] as const;
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Audit = {
  team_id: string;
  actor_id: string;
  actor_type: string;
  token_id: string | null;
  record_id: string | null;
  action: string;
  summary: string;
  metadata: Record<string, unknown>;
};

/** Raw reads as the PGlite superuser, which bypasses RLS; only to inspect outcomes. */
function inspector(harness: Harness) {
  const query = async <T>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  return {
    query,
    admins: () =>
      query<{
        user_id: string;
        level: string;
        areas: string[];
        plan_access: boolean;
        granted_by: string | null;
        suspended: boolean;
      }>(
        "SELECT user_id, level, areas, plan_access, granted_by, suspended_at IS NOT NULL AS suspended FROM app.workspace_admins ORDER BY user_id",
      ),
    audits: () =>
      query<Audit>(
        "SELECT team_id, actor_id, actor_type, token_id, record_id, action, summary, metadata FROM app.activity WHERE kind = 'workspace-authority' ORDER BY created_at, id",
      ),
    snapshot: async () =>
      Object.fromEntries(
        await Promise.all(
          TABLES.map(async (table) => [
            table,
            await query(`SELECT * FROM app.${table} ORDER BY 1, 2`),
          ]),
        ),
      ),
  };
}

/** One data-role transaction under the principal's verified context. */
function asContext<T>(
  harness: Harness,
  principal: Principal,
  work: (tx: TeamTx) => Promise<T>,
) {
  return harness.dataDb().then((db) =>
    withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
      await installTenantContext(tx, principal, snapshot);
      return work(tx);
    }),
  );
}

const arrayLiteral = (areas: string[] | null) =>
  areas === null ? null : `{${areas.join(",")}}`;

describe("company workspace authority under the split runtime roles", () => {
  let harness: Harness;
  let look: ReturnType<typeof inspector>;
  let owner: Principal, fieldsAdmin: Principal, viewer: Principal;
  let secondOwner: Principal, ownerB: Principal, fieldsAdminC: Principal;

  const setAuthority = (
    actor: Principal,
    target: string | null,
    level: string | null,
    areas: string[] | null,
    plan: boolean | null,
  ) =>
    asContext(harness, actor, async (tx) => {
      const { rows } = await tx.execute<{ changed: boolean }>(
        sql`select tenant_context.set_workspace_authority(${target}::text, ${level}::text, ${arrayLiteral(areas)}::text[], ${plan}::boolean) as changed`,
      );
      return rows[0].changed;
    });
  const readAs = (principal: Principal) =>
    asContext(harness, principal, async (tx) => ({
      admins: (
        await tx.execute<{ user_id: string }>(
          sql`select user_id from app.workspace_admins order by user_id`,
        )
      ).rows.map((row) => row.user_id),
      workspaces: (
        await tx.execute<{ id: string }>(sql`select id from app.workspaces`)
      ).rows.map((row) => row.id),
      teams: (
        await tx.execute<{ team_id: string }>(
          sql`select team_id from app.workspace_teams order by team_id`,
        )
      ).rows.map((row) => row.team_id),
    }));
  /** Runs the call and expects one SQLSTATE, with no authority or audit row changed. */
  async function refused(call: () => Promise<unknown>, code: string) {
    const admins = await look.admins();
    const audits = await look.audits();
    await expect(call()).rejects.toMatchObject({ cause: { code } });
    expect(await look.admins()).toEqual(admins);
    expect(await look.audits()).toEqual(audits);
  }

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    look = inspector(harness);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, { userId: "ws-owner", teamId: "ws-team-a" });
    fieldsAdmin = await seedIdentity(db, {
      userId: "ws-fields-admin",
      teamId: "ws-team-a",
      role: "recruiter",
    });
    viewer = await seedIdentity(db, {
      userId: "ws-viewer",
      teamId: "ws-team-a",
      role: "viewer",
    });
    secondOwner = await seedIdentity(db, {
      userId: "ws-second-owner",
      teamId: "ws-team-a",
      role: "recruiter",
    });
    // Team B is created later by an owner who is not the initial administrator.
    ownerB = await seedIdentity(db, {
      userId: "ws-owner-b",
      teamId: "ws-team-b",
    });
    // The admin-to-be is also a recruiter in a third team.
    fieldsAdminC = await seedIdentity(db, {
      userId: "ws-fields-admin",
      teamId: "ws-team-c",
      role: "recruiter",
    });
    await harness.client.exec(
      `INSERT INTO auth."user"(id,name,email,email_verified) VALUES ('ws-loner','Fictional Loner','ws-loner@example.test',true)`,
    );
  });
  afterAll(async () => harness?.close());

  it("maps every team to the one workspace and makes only the initial administrator company owner", async () => {
    expect(await look.query("SELECT id, name FROM app.workspaces")).toEqual([
      { id: COMPANY, name: "Company" },
    ]);
    expect(
      await look.query(
        "SELECT team_id, workspace_id FROM app.workspace_teams ORDER BY team_id",
      ),
    ).toEqual(
      ["ws-team-a", "ws-team-b", "ws-team-c"].map((team_id) => ({
        team_id,
        workspace_id: COMPANY,
      })),
    );
    expect(await look.admins()).toEqual([
      {
        user_id: "ws-owner",
        level: "owner",
        areas: [],
        plan_access: false,
        granted_by: null,
        suspended: false,
      },
    ]);
  });

  it("forces row-level security on all three tables", async () => {
    expect(
      await look.query(
        "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid IN ('app.workspaces'::regclass, 'app.workspace_teams'::regclass, 'app.workspace_admins'::regclass) ORDER BY relname",
      ),
    ).toEqual(
      ["workspace_admins", "workspace_teams", "workspaces"].map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );
  });

  const writes = [
    `INSERT INTO app.workspaces(id,name) VALUES (gen_random_uuid(),'Fictional Company')`,
    `UPDATE app.workspaces SET name = 'Fictional Company'`,
    `DELETE FROM app.workspaces`,
    `INSERT INTO app.workspace_teams(team_id,workspace_id) VALUES ('ws-team-b','${COMPANY}') ON CONFLICT DO NOTHING`,
    `UPDATE app.workspace_teams SET workspace_id = workspace_id`,
    `DELETE FROM app.workspace_teams`,
    `INSERT INTO app.workspace_admins(workspace_id,user_id,level) VALUES ('${COMPANY}','ws-viewer','owner')`,
    `UPDATE app.workspace_admins SET plan_access = true`,
    `DELETE FROM app.workspace_admins`,
  ];

  it("refuses every insert, update and delete by both runtime roles and changes nothing", async () => {
    const before = await look.snapshot();
    for (const statement of writes) {
      await expect(
        asContext(harness, owner, (tx) => tx.execute(sql.raw(statement))),
        `data ${statement}`,
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      await harness.identityDb();
      await expect(
        harness.client.query(statement),
        `identity ${statement}`,
      ).rejects.toMatchObject({ code: "42501" });
    }
    expect(await look.snapshot()).toEqual(before);
  });

  it("refuses a direct data-role insert of a workspace-authority activity row", async () => {
    await expect(
      asContext(harness, owner, (tx) =>
        tx.execute(
          sql`insert into app.activity(team_id,actor_id,actor_type,action,kind,summary,metadata) values ('ws-team-a','ws-owner','session','workspace_authority.changed','workspace-authority','Forged','{}')`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
    expect(await look.audits()).toEqual([]);
  });

  it("refuses a team owner without company authority, a token context and a suspended owner", async () => {
    await refused(
      () => setAuthority(ownerB, "ws-owner-b", "owner", [], false),
      "42501",
    );
    await refused(
      () => setAuthority(ownerB, "ws-fields-admin", "admin", ["fields"], true),
      "42501",
    );
    const token = await seedApiToken(await harness.asOwner(), owner);
    await refused(
      () => setAuthority(token, "ws-fields-admin", "admin", ["fields"], true),
      "42501",
    );
    await (
      await harness.asOwner()
    ).execute(
      sql`insert into app.workspace_admins(workspace_id,user_id,level,suspended_at) values (${COMPANY}, 'ws-second-owner', 'owner', now())`,
    );
    await refused(
      () => setAuthority(secondOwner, "ws-viewer", "admin", ["fields"], false),
      "42501",
    );
  });

  it("refuses invalid arguments with 22023 and a target in no team of the company with RQ006", async () => {
    for (const [target, level, areas, plan] of [
      [null, "admin", ["fields"], true],
      ["ws-viewer", "superuser", [], false],
      ["ws-viewer", null, [], null],
      ["ws-viewer", null, null, false],
      ["ws-viewer", "owner", ["fields"], false],
      ["ws-viewer", "owner", null, false],
      ["ws-viewer", "admin", ["roles"], false],
      ["ws-viewer", "admin", ["ai"], false],
      ["ws-viewer", "admin", ["fields", "fields"], false],
      ["ws-viewer", "admin", ["fields", "NULL"], false],
      ["ws-viewer", "admin", ["fields"], null],
      ["ws-viewer", "admin", null, true],
    ] as const)
      await refused(
        () =>
          setAuthority(
            owner,
            target,
            level,
            areas === null ? null : [...areas],
            plan,
          ),
        "22023",
      );
    await refused(
      () => setAuthority(owner, "ws-loner", "admin", ["fields"], false),
      "RQ006",
    );
    await refused(
      () => setAuthority(owner, "ws-nobody", "admin", ["fields"], false),
      "RQ006",
    );
  });

  it("refuses the sole company owner removing or demoting themselves", async () => {
    await refused(
      () => setAuthority(owner, "ws-owner", null, null, null),
      "RQ005",
    );
    await refused(
      () => setAuthority(owner, "ws-owner", "admin", ["fields"], false),
      "RQ005",
    );
  });

  it("audits a grant and a plan-access change with one row each, and writes nothing for an unchanged call", async () => {
    expect(
      await setAuthority(owner, "ws-fields-admin", "admin", ["fields"], true),
    ).toBe(true);
    expect(
      await setAuthority(owner, "ws-fields-admin", "admin", ["fields"], false),
    ).toBe(true);
    const rows = await look.audits();
    expect(rows).toHaveLength(2);
    const base = {
      team_id: "ws-team-a",
      actor_id: "ws-owner",
      actor_type: "session",
      token_id: null,
      record_id: null,
      action: "workspace_authority.changed",
      summary: "Changed a member's company authority",
    };
    expect(rows).toEqual([
      {
        ...base,
        metadata: {
          targetUserId: "ws-fields-admin",
          before: null,
          after: {
            level: "admin",
            areas: ["fields"],
            planAccess: true,
            suspended: false,
          },
        },
      },
      {
        ...base,
        metadata: {
          targetUserId: "ws-fields-admin",
          before: {
            level: "admin",
            areas: ["fields"],
            planAccess: true,
            suspended: false,
          },
          after: {
            level: "admin",
            areas: ["fields"],
            planAccess: false,
            suspended: false,
          },
        },
      },
    ]);
    expect(
      (await look.admins()).find((row) => row.user_id === "ws-fields-admin"),
    ).toEqual({
      user_id: "ws-fields-admin",
      level: "admin",
      areas: ["fields"],
      plan_access: false,
      granted_by: "ws-owner",
      suspended: false,
    });
    // The same level, areas and plan access on an unsuspended row change nothing.
    const audits = await look.audits();
    expect(
      await setAuthority(owner, "ws-fields-admin", "admin", ["fields"], false),
    ).toBe(false);
    expect(await setAuthority(owner, "ws-viewer", null, null, null)).toBe(
      false,
    );
    expect(await look.audits()).toEqual(audits);
  });

  it("refuses a company admin's call", async () => {
    await refused(
      () => setAuthority(fieldsAdmin, "ws-viewer", "admin", ["fields"], false),
      "42501",
    );
  });

  it("lets a second unsuspended owner be present so the first can be demoted, and promoted back", async () => {
    // Clears the suspended owner row seeded above, audited.
    expect(
      await setAuthority(owner, "ws-second-owner", "owner", [], false),
    ).toBe(true);
    expect((await look.audits()).at(-1)!.metadata).toEqual({
      targetUserId: "ws-second-owner",
      before: { level: "owner", areas: [], planAccess: false, suspended: true },
      after: { level: "owner", areas: [], planAccess: false, suspended: false },
    });
    expect(
      await setAuthority(
        owner,
        "ws-owner",
        "admin",
        ["workflows", "fields"],
        false,
      ),
    ).toBe(true);
    expect((await look.audits()).at(-1)!.metadata).toMatchObject({
      targetUserId: "ws-owner",
      after: { level: "admin", areas: ["fields", "workflows"] },
    });
    // Now ws-second-owner is the last owner and cannot step down.
    await refused(
      () => setAuthority(secondOwner, "ws-second-owner", null, null, null),
      "RQ005",
    );
    expect(
      await setAuthority(secondOwner, "ws-owner", "owner", [], false),
    ).toBe(true);
    expect(
      (await look.admins()).map((row) => [row.user_id, row.level, row.areas]),
    ).toEqual([
      ["ws-fields-admin", "admin", ["fields"]],
      ["ws-owner", "owner", []],
      ["ws-second-owner", "owner", []],
    ]);
  });

  it("lets a member without company authority read only their own row; owners and admins read every row", async () => {
    const all = ["ws-fields-admin", "ws-owner", "ws-second-owner"];
    for (const [principal, admins] of [
      [viewer, []],
      [ownerB, []],
      [owner, all],
      [fieldsAdmin, all],
      [fieldsAdminC, all],
    ] as const)
      expect(await readAs(principal), principal.userId).toEqual({
        admins,
        workspaces: [COMPANY],
        teams: [principal.teamId],
      });
  });

  it("suspends a company admin removed from every team; a re-invitation restores nothing until an owner clears it", async () => {
    const suspended = async () =>
      (
        await look.query<{ suspended: boolean }>(
          "SELECT suspended_at IS NOT NULL AS suspended FROM app.workspace_admins WHERE user_id = 'ws-fields-admin'",
        )
      )[0].suspended;
    await harness.identityDb();
    await harness.client.query(
      "DELETE FROM auth.member WHERE id = 'ws-fields-admin:ws-team-c'",
    );
    expect(await suspended()).toBe(false);
    await harness.identityDb();
    await harness.client.query(
      "DELETE FROM auth.member WHERE id = 'ws-fields-admin:ws-team-a'",
    );
    expect(await suspended()).toBe(true);
    expect(
      (await look.admins()).find((row) => row.user_id === "ws-fields-admin"),
    ).toMatchObject({ level: "admin", areas: ["fields"], plan_access: false });
    // Invited back into team A: still suspended, and read as a plain member.
    await harness.identityDb();
    await harness.client.query(
      "INSERT INTO auth.member(id,organization_id,user_id,role) VALUES ('ws-fields-admin:ws-team-a','ws-team-a','ws-fields-admin','recruiter')",
    );
    expect(await suspended()).toBe(true);
    expect(await readAs(fieldsAdmin)).toEqual({
      admins: ["ws-fields-admin"],
      workspaces: [COMPANY],
      teams: ["ws-team-a"],
    });
    await refused(
      () => setAuthority(fieldsAdmin, "ws-viewer", "admin", ["fields"], false),
      "42501",
    );
    const audits = await look.audits();
    expect(
      await setAuthority(owner, "ws-fields-admin", "admin", ["fields"], false),
    ).toBe(true);
    expect(await suspended()).toBe(false);
    const added = (await look.audits()).slice(audits.length);
    expect(added).toHaveLength(1);
    expect(added[0].metadata).toEqual({
      targetUserId: "ws-fields-admin",
      before: {
        level: "admin",
        areas: ["fields"],
        planAccess: false,
        suspended: true,
      },
      after: {
        level: "admin",
        areas: ["fields"],
        planAccess: false,
        suspended: false,
      },
    });
  });

  it("removes a deleted user's company authority without error", async () => {
    const db = await harness.asOwner();
    await db.execute(
      sql`insert into auth."user"(id,name,email,email_verified) values ('ws-leaver','Fictional Leaver','ws-leaver@example.test',true)`,
    );
    await db.execute(
      sql`insert into auth.member(id,organization_id,user_id,role) values ('ws-leaver:ws-team-a','ws-team-a','ws-leaver','recruiter')`,
    );
    expect(
      await setAuthority(owner, "ws-leaver", "admin", ["boards"], false),
    ).toBe(true);
    await (
      await harness.asOwner()
    ).execute(sql`delete from auth."user" where id = 'ws-leaver'`);
    expect(
      await look.query(
        "SELECT count(*)::int AS n FROM app.workspace_admins WHERE user_id = 'ws-leaver'",
      ),
    ).toEqual([{ n: 0 }]);
  });

  it("runs the documented owner SQL step under FORCE RLS on the non-superuser owner", async () => {
    const docs = await readFile(
      join(process.cwd(), "docs", "deployment.md"),
      "utf8",
    );
    const step =
      /```sql\r?\n(INSERT INTO app\.workspace_admins[\s\S]*?)```/.exec(
        docs,
      )![1];
    const audits = await look.audits();
    await (
      await harness.asOwner()
    ).execute(sql.raw(step.replace("<owner email>", "WS-VIEWER@example.test")));
    expect(
      (await look.admins()).find((row) => row.user_id === "ws-viewer"),
    ).toEqual({
      user_id: "ws-viewer",
      level: "owner",
      areas: [],
      plan_access: false,
      granted_by: null,
      suspended: false,
    });
    expect(await look.audits()).toEqual(audits);
  });
});

describe("team creation through Better Auth maps the team in the same transaction", () => {
  let harness: Harness;
  let look: ReturnType<typeof inspector>;
  const mail: Mail[] = [];
  let caller: ReturnType<typeof authCaller>;
  let adminCookie = "";
  const team = (slug: string) =>
    look.query<{ organization: number; members: number; mapped: number }>(
      `SELECT (SELECT count(*) FROM auth.organization WHERE slug = $1)::int AS organization,
        (SELECT count(*) FROM auth.member m JOIN auth.organization o ON o.id = m.organization_id WHERE o.slug = $1)::int AS members,
        (SELECT count(*) FROM app.workspace_teams t JOIN auth.organization o ON o.id = t.team_id WHERE o.slug = $1 AND t.workspace_id = $2)::int AS mapped`,
      [slug, COMPANY],
    );
  /** Better Auth runs as the identity role; the trigger runs as the owner. */
  const create = async (slug: string, cookie: string) => {
    await harness.identityDb();
    return caller.post(
      "organization/create",
      { name: `Fictional ${slug}`, slug },
      { cookie },
    );
  };

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    look = inspector(harness);
    caller = authCaller(createTestAuth(await harness.identityDb(), mail));
  });
  afterAll(async () => harness?.close());

  it("maps the initial administrator's first team and makes them company owner", async () => {
    await harness.identityDb();
    const admin = await setUpAdmin(caller, mail);
    adminCookie = admin.cookie;
    expect(await team("fictional-first-team")).toEqual([
      { organization: 1, members: 1, mapped: 1 },
    ]);
    expect(await look.admins()).toEqual([
      expect.objectContaining({
        level: "owner",
        areas: [],
        plan_access: false,
        granted_by: null,
        suspended: false,
      }),
    ]);
  });

  it("leaves neither the team nor its mapping when a later step of the transaction fails", async () => {
    await look.query(`CREATE FUNCTION public.fail_owner_member() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Fictional owner-member failure'; END $$`);
    await look.query(`CREATE TRIGGER fail_owner_member BEFORE INSERT ON auth.member
      FOR EACH ROW EXECUTE FUNCTION public.fail_owner_member()`);
    try {
      expect((await create("fictional-failed-team", adminCookie)).ok).toBe(
        false,
      );
    } finally {
      await look.query("DROP TRIGGER fail_owner_member ON auth.member");
      await look.query("DROP FUNCTION public.fail_owner_member()");
    }
    expect(await team("fictional-failed-team")).toEqual([
      { organization: 0, members: 0, mapped: 0 },
    ]);
  });

  it("maps a later owner's team without giving them company authority", async () => {
    const first = (
      await look.query<{ id: string }>(
        "SELECT id FROM auth.organization WHERE slug = 'fictional-first-team'",
      )
    )[0].id;
    await harness.identityDb();
    const later = await addMember(
      caller,
      mail,
      adminCookie,
      first,
      "ws-later-owner@example.test",
      "owner",
    );
    const admins = await look.admins();
    await harness.identityDb();
    await createTeam(caller, later.cookie, "fictional-later-team");
    expect(await team("fictional-later-team")).toEqual([
      { organization: 1, members: 1, mapped: 1 },
    ]);
    expect(await look.admins()).toEqual(admins);
    expect(admins).toHaveLength(1);
  });

  it("refuses every team creation once a second workspace exists", async () => {
    await (
      await harness.asOwner()
    ).execute(
      sql`insert into app.workspaces(id,name) values (gen_random_uuid(), 'Fictional Second Company')`,
    );
    try {
      expect(
        (await create("fictional-second-company-team", adminCookie)).ok,
      ).toBe(false);
      expect(await team("fictional-second-company-team")).toEqual([
        { organization: 0, members: 0, mapped: 0 },
      ]);
    } finally {
      await (
        await harness.asOwner()
      ).execute(sql`delete from app.workspaces where id <> ${COMPANY}`);
    }
    expect((await create("fictional-after-team", adminCookie)).ok).toBe(true);
    expect(await team("fictional-after-team")).toEqual([
      { organization: 1, members: 1, mapped: 1 },
    ]);
  });
});
