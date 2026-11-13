import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Requests pick the pool by role, as on a split-role deployment: the identity role reads the
// membership, the data role runs withTeam. Only one PGlite role is active at a time.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));

import type { AppDb, TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import {
  addGroupManager,
  addGroupMember,
  addManagedMember,
  archiveGroup,
  computedGroupMembers,
  createGroup,
  getGroup,
  listManagedGroups,
  removeGroupManager,
  removeGroupMember,
  removeManagedMember,
  renameGroup,
  setGroupApproval,
  type Group,
} from "@/lib/groups";
import { listActivity } from "@/lib/insights";
import type { Principal } from "@/lib/principal";
import { installTenantContext } from "@/lib/tenant-context";
import { anonymiseUser } from "@/lib/user-anonymisation";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace with two fictional teams, and a second fictional
// workspace inserted by the owner for the isolation cases (ADM-11, 0052).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000092";
const TABLES = [
  "groups",
  "group_members",
  "group_managers",
  "group_effective_members",
];
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Audit = {
  id: string;
  team_id: string;
  actor_id: string;
  actor_type: string;
  token_id: string | null;
  record_id: string | null;
  action: string;
  kind: string;
  summary: string;
  metadata: Record<string, unknown>;
};
type Link = {
  group_id: string;
  user_id: string | null;
  child_group_id: string | null;
};
type Member = { userId: string } | { childGroupId: string };

/** A small seeded generator, so the load sequence is the same on every run. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("company groups under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, owner2: Principal, peopleAdmin: Principal;
  let orgAdmin: Principal, suspendedAdmin: Principal, teamOwnerB: Principal;
  let teamAdminA: Principal, teamAdminB: Principal, recruiter: Principal;
  let ownerToken: Principal, ownerX: Principal;
  let loadUsers: Principal[];

  /** Raw reads as the PGlite superuser, which bypasses RLS; only to inspect outcomes. */
  const look = async <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  const audits = () =>
    look<Audit>(
      "SELECT id, team_id, actor_id, actor_type, token_id, record_id, action, kind, summary, metadata FROM app.activity WHERE kind = 'group' ORDER BY created_at, id",
    );
  /** Every group row of both workspaces and every group activity row. */
  const state = async () => ({
    groups: await look("SELECT * FROM app.groups ORDER BY id"),
    members: await look(
      "SELECT * FROM app.group_members ORDER BY group_id, user_id, child_group_id",
    ),
    managers: await look(
      "SELECT * FROM app.group_managers ORDER BY group_id, user_id",
    ),
    effective: await look(
      "SELECT * FROM app.group_effective_members ORDER BY group_id, user_id",
    ),
    audits: await audits(),
  });
  /** One data-role transaction under the principal's verified context. */
  const asContext = <T>(
    principal: Principal,
    work: (tx: TeamTx) => Promise<T>,
  ) =>
    harness.dataDb().then((db) =>
      withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
        await installTenantContext(tx, principal, snapshot);
        return work(tx);
      }),
    );
  const sqlAs = (principal: Principal, statement: string) =>
    asContext(principal, async (tx) => {
      const { rows } = await tx.execute(sql.raw(statement));
      return rows;
    });
  /** Runs the call and expects one SQLSTATE, with no group row or group audit row changed. */
  async function refused(call: () => Promise<unknown>, code: string) {
    const before = await state();
    await expect(call()).rejects.toMatchObject({ cause: { code } });
    expect(await state()).toEqual(before);
  }
  /** Runs the call and expects one API error, with no group row or group audit row changed. */
  async function refusedApi(
    call: () => Promise<unknown>,
    status: number,
    code: string,
  ) {
    const before = await state();
    await expect(call()).rejects.toMatchObject({ status, code });
    expect(await state()).toEqual(before);
  }
  /** The group activity rows the call added. */
  async function audited(call: () => Promise<unknown>) {
    const before = new Set((await audits()).map((row) => row.id));
    await call();
    return (await audits()).filter((row) => !before.has(row.id));
  }
  /** Exactly one session row of the action by the principal, with ids only in its metadata. */
  function expectAudit(
    rows: Audit[],
    action: string,
    p: Principal,
    groupId: string,
    extra: Record<string, string> = {},
  ) {
    expect(rows, action).toEqual([
      expect.objectContaining({
        team_id: p.teamId,
        actor_id: p.userId,
        actor_type: "session",
        token_id: null,
        record_id: null,
        action,
        kind: "group",
      }),
    ]);
    expect(rows[0].metadata, action).toEqual({
      workspaceId: COMPANY,
      groupId,
      ...extra,
    });
  }
  const groupRow = async (id: string) =>
    (await look("SELECT * FROM app.groups WHERE id = $1", [id]))[0];
  const directMembers = (groupId: string) =>
    look<Link>(
      "SELECT group_id, user_id, child_group_id FROM app.group_members WHERE group_id = $1 ORDER BY user_id, child_group_id",
      [groupId],
    );
  const insertMember = (groupId: string, member: Member) =>
    "userId" in member
      ? `INSERT INTO app.group_members(group_id, workspace_id, user_id) VALUES ('${groupId}', '${COMPANY}', '${member.userId}')`
      : `INSERT INTO app.group_members(group_id, workspace_id, child_group_id) VALUES ('${groupId}', '${COMPANY}', '${member.childGroupId}')`;
  const deleteMember = (groupId: string, member: Member) =>
    "userId" in member
      ? `DELETE FROM app.group_members WHERE group_id = '${groupId}' AND user_id = '${member.userId}'`
      : `DELETE FROM app.group_members WHERE group_id = '${groupId}' AND child_group_id = '${member.childGroupId}'`;
  /**
   * app.group_effective_members of the workspace equals the reference computed here from the
   * direct members: every user member of the group or of a group below it, at any depth.
   */
  async function expectEffective(workspace = COMPANY) {
    const links = await look<Link>(
      "SELECT group_id, user_id, child_group_id FROM app.group_members WHERE workspace_id = $1",
      [workspace],
    );
    const groups = await look<{ id: string }>(
      "SELECT id FROM app.groups WHERE workspace_id = $1",
      [workspace],
    );
    const children = new Map<string, string[]>();
    const users = new Map<string, string[]>();
    for (const link of links) {
      const map = link.user_id ? users : children;
      map.set(link.group_id, [
        ...(map.get(link.group_id) ?? []),
        (link.user_id ?? link.child_group_id)!,
      ]);
    }
    const expected = new Set<string>();
    for (const { id } of groups) {
      const seen = new Set<string>();
      const walk = (group: string) => {
        if (seen.has(group)) return;
        seen.add(group);
        for (const user of users.get(group) ?? [])
          expected.add(`${id}|${user}`);
        for (const child of children.get(group) ?? []) walk(child);
      };
      walk(id);
    }
    const actual = await look<{ group_id: string; user_id: string }>(
      "SELECT group_id, user_id FROM app.group_effective_members WHERE workspace_id = $1",
      [workspace],
    );
    expect(
      actual.map((row) => `${row.group_id}|${row.user_id}`).sort(),
    ).toEqual([...expected].sort());
    return actual.length;
  }

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    // Signed in just now: changes to a group that grants something need a recent sign-in (ADM-12).
    owner = {
      ...(await seedIdentity(db, {
        userId: "grp-owner",
        teamId: "grp-team-a",
      })),
      sessionCreatedAt: new Date(),
    };
    owner2 = await seedIdentity(db, {
      userId: "grp-owner-2",
      teamId: "grp-team-b",
      role: "recruiter",
    });
    peopleAdmin = await seedIdentity(db, {
      userId: "grp-people-admin",
      teamId: "grp-team-a",
      role: "recruiter",
    });
    orgAdmin = await seedIdentity(db, {
      userId: "grp-org-admin",
      teamId: "grp-team-b",
      role: "recruiter",
    });
    suspendedAdmin = await seedIdentity(db, {
      userId: "grp-suspended-admin",
      teamId: "grp-team-b",
      role: "viewer",
    });
    teamOwnerB = await seedIdentity(db, {
      userId: "grp-owner-b",
      teamId: "grp-team-b",
    });
    teamAdminA = await seedIdentity(db, {
      userId: "grp-team-admin-a",
      teamId: "grp-team-a",
      role: "admin",
    });
    teamAdminB = await seedIdentity(db, {
      userId: "grp-team-admin-b",
      teamId: "grp-team-b",
      role: "admin",
    });
    recruiter = await seedIdentity(db, {
      userId: "grp-recruiter",
      teamId: "grp-team-a",
      role: "recruiter",
    });
    // Recruiters of either team for the membership and load cases.
    loadUsers = [];
    for (let index = 1; index <= 8; index++)
      loadUsers.push(
        await seedIdentity(db, {
          userId: `grp-load-${index}`,
          teamId: index % 2 ? "grp-team-a" : "grp-team-b",
          role: "recruiter",
        }),
      );
    ownerX = await seedIdentity(db, {
      userId: "grp-owner-x",
      teamId: "grp-team-x",
    });
    ownerToken = await seedApiToken(db, owner);
    // Company authority and the second workspace are owner-written; no team is created after this.
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas,suspended_at) VALUES
        ('${COMPANY}','grp-owner-2','owner','{}',NULL),
        ('${COMPANY}','grp-people-admin','admin','{people}',NULL),
        ('${COMPANY}','grp-org-admin','admin','{organisation}',NULL),
        ('${COMPANY}','grp-suspended-admin','admin','{people}',now());
      INSERT INTO app.workspaces(id,name) VALUES ('${OTHER}','Fictional Other Company');
      UPDATE app.workspace_teams SET workspace_id = '${OTHER}' WHERE team_id = 'grp-team-x';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level) VALUES ('${OTHER}','grp-owner-x','owner');
    `);
  });
  afterAll(async () => harness?.close());

  it("forces row-level security on the four tables", async () => {
    expect(
      await look(
        "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = 'app'::regnamespace AND relname = ANY($1) ORDER BY relname",
        [TABLES],
      ),
    ).toEqual(
      [...TABLES].sort().map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );
  });

  describe("computed groups", () => {
    it("answers each computed group with exactly its people, never the suspended holder or another workspace", async () => {
      const company = [
        owner,
        owner2,
        peopleAdmin,
        orgAdmin,
        suspendedAdmin,
        teamOwnerB,
        teamAdminA,
        teamAdminB,
        recruiter,
        ...loadUsers,
      ].map((p) => p.userId);
      const expected: Record<string, string[]> = {
        "company-owners": ["grp-owner", "grp-owner-2"],
        "company-admins": ["grp-org-admin", "grp-people-admin"],
        "all-members": [...company].sort(),
        "team-owners:grp-team-a": ["grp-owner"],
        "team-owners:grp-team-b": ["grp-owner-b"],
        "team-admins:grp-team-a": ["grp-team-admin-a"],
        "team-admins:grp-team-b": ["grp-team-admin-b"],
      };
      const before = await state();
      for (const p of [owner, peopleAdmin])
        for (const [key, ids] of Object.entries(expected))
          expect(
            await computedGroupMembers(p, key),
            `${p.userId} ${key}`,
          ).toEqual(ids);
      expect(await computedGroupMembers(ownerX, "all-members")).toEqual([
        "grp-owner-x",
      ]);
      expect(
        await sqlAs(
          owner,
          "SELECT user_id FROM tenant_context.computed_group_members('company-admins')",
        ),
      ).toEqual([
        { user_id: "grp-org-admin" },
        { user_id: "grp-people-admin" },
      ]);
      // Nothing is stored: no group, member or activity row.
      expect(await state()).toEqual(before);
    });

    it("refuses an unknown key and another workspace's team: 404 in the service, 22023 in SQL", async () => {
      for (const key of [
        "company-everyone",
        "team-owners:grp-team-x",
        "team-admins:grp-team-x",
        "team-owners:",
        "team-owners",
        "team-viewers:grp-team-a",
      ]) {
        await refusedApi(
          () => computedGroupMembers(owner, key),
          404,
          "not_found",
        );
        await refused(
          () =>
            sqlAs(
              owner,
              `SELECT * FROM tenant_context.computed_group_members('${key}')`,
            ),
          "22023",
        );
      }
    });

    it("writes to no table, and group_grants never answers for a computed key", async () => {
      const [{ source }] = await look<{ source: string }>(
        "SELECT prosrc AS source FROM pg_proc WHERE oid = 'tenant_context.computed_group_members(text)'::regprocedure",
      );
      expect(source).toMatch(/workspace_admins/);
      expect(source).not.toMatch(/\b(insert|update|delete|truncate|merge)\b/i);
      // The key is not a group id, so the helper cannot even be asked about it.
      await refused(
        () =>
          sqlAs(owner, "SELECT tenant_context.group_grants('company-owners')"),
        "22P02",
      );
    });
  });

  describe("writes through the service", () => {
    for (const who of ["owner", "people admin"] as const)
      it(`lets a company ${who} create, rename, archive and add and remove members and child groups, one audit row each`, async () => {
        const p = who === "owner" ? owner : peopleAdmin;
        const tag = who === "owner" ? "Owner" : "Admin";
        let group!: Group;
        expectAudit(
          await audited(async () => {
            group = await createGroup(p, {
              name: `Fictional ${tag} Crew`,
              description: `Fictional ${tag} crew notes`,
            });
          }),
          "group.created",
          p,
          group.id,
        );
        expect(group).toEqual({
          id: expect.any(String),
          name: `Fictional ${tag} Crew`,
          description: `Fictional ${tag} crew notes`,
          approval: false,
          archivedAt: null,
          createdAt: expect.any(String),
        });
        expect(await groupRow(group.id)).toMatchObject({
          workspace_id: COMPANY,
          name: `Fictional ${tag} Crew`,
          description: `Fictional ${tag} crew notes`,
          approval: false,
          archived_at: null,
          created_by: p.userId,
        });
        const child = await createGroup(p, { name: `Fictional ${tag} Pod` });
        expect(child.description).toBeNull();

        // A rename of the name alone keeps the description; an empty description clears it.
        expectAudit(
          await audited(async () => {
            expect(
              await renameGroup(p, group.id, {
                name: `Fictional ${tag} Squad`,
              }),
            ).toMatchObject({
              name: `Fictional ${tag} Squad`,
              description: `Fictional ${tag} crew notes`,
            });
          }),
          "group.renamed",
          p,
          group.id,
        );
        expectAudit(
          await audited(() =>
            renameGroup(p, group.id, {
              name: `Fictional ${tag} Squad`,
              description: `Fictional ${tag} squad notes`,
            }),
          ),
          "group.renamed",
          p,
          group.id,
        );
        expect(
          await renameGroup(p, child.id, {
            name: `Fictional ${tag} Pod`,
            description: "",
          }),
        ).toMatchObject({ description: null });
        expect(await groupRow(group.id)).toMatchObject({
          name: `Fictional ${tag} Squad`,
          description: `Fictional ${tag} squad notes`,
        });

        const user = loadUsers[who === "owner" ? 1 : 2].userId;
        expectAudit(
          await audited(() => addGroupMember(p, group.id, { userId: user })),
          "group.member_added",
          p,
          group.id,
          { targetUserId: user },
        );
        expectAudit(
          await audited(() =>
            addGroupMember(p, group.id, { childGroupId: child.id }),
          ),
          "group.child_added",
          p,
          group.id,
          { childGroupId: child.id },
        );
        expect(
          await look(
            "SELECT user_id, child_group_id, added_by FROM app.group_members WHERE group_id = $1 ORDER BY user_id",
            [group.id],
          ),
        ).toEqual([
          { user_id: user, child_group_id: null, added_by: p.userId },
          { user_id: null, child_group_id: child.id, added_by: p.userId },
        ]);
        await refusedApi(
          () => addGroupMember(p, group.id, { userId: user }),
          409,
          "group_member_exists",
        );
        await refusedApi(
          () => addGroupMember(p, group.id, { childGroupId: child.id }),
          409,
          "group_member_exists",
        );
        await expectEffective();

        expectAudit(
          await audited(() => removeGroupMember(p, group.id, { userId: user })),
          "group.member_removed",
          p,
          group.id,
          { targetUserId: user },
        );
        expectAudit(
          await audited(() =>
            removeGroupMember(p, group.id, { childGroupId: child.id }),
          ),
          "group.child_removed",
          p,
          group.id,
          { childGroupId: child.id },
        );
        expect(await directMembers(group.id)).toEqual([]);
        await refusedApi(
          () => removeGroupMember(p, group.id, { userId: user }),
          404,
          "not_found",
        );
        await refusedApi(
          () => removeGroupMember(p, group.id, { childGroupId: child.id }),
          404,
          "not_found",
        );

        expectAudit(
          await audited(async () => {
            expect(await archiveGroup(p, group.id)).toMatchObject({
              archivedAt: expect.any(String),
            });
          }),
          "group.archived",
          p,
          group.id,
        );
        expect((await groupRow(group.id)).archived_at).toBeInstanceOf(Date);
        for (const call of [
          () => archiveGroup(p, group.id),
          () => renameGroup(p, group.id, { name: "Fictional Revived" }),
          () => setGroupApproval(owner, group.id, { approval: true }),
        ])
          await refusedApi(call, 409, "group_archived");
        // An archived group cannot be unarchived, even by direct SQL as a company owner.
        await refused(
          () =>
            sqlAs(
              owner,
              `UPDATE app.groups SET archived_at = NULL WHERE id = '${group.id}'`,
            ),
          "42501",
        );
        // Its name is free again among current groups.
        expect(
          (await createGroup(p, { name: `fictional ${tag} squad` })).name,
        ).toBe(`fictional ${tag} squad`);
      });

    it("refuses a duplicate current name differing only in case, and unknown groups", async () => {
      const group = await createGroup(owner, { name: "Fictional Unique Name" });
      const other = await createGroup(owner, { name: "Fictional Other Name" });
      await refusedApi(
        () => createGroup(peopleAdmin, { name: "FICTIONAL UNIQUE NAME" }),
        409,
        "group_name_exists",
      );
      await refusedApi(
        () => renameGroup(owner, other.id, { name: "fictional unique name" }),
        409,
        "group_name_exists",
      );
      const unknown = "00000000-0000-4000-a000-0000000000ff";
      for (const call of [
        () => renameGroup(owner, unknown, { name: "Fictional Nobody" }),
        () => archiveGroup(owner, unknown),
        () => setGroupApproval(owner, unknown, { approval: true }),
        () => addGroupMember(owner, unknown, { userId: owner.userId }),
        () => addGroupMember(owner, group.id, { childGroupId: unknown }),
        () => removeGroupMember(owner, unknown, { userId: owner.userId }),
      ])
        await refusedApi(call, 404, "not_found");
      // A person in no team of the company.
      await refusedApi(
        () => addGroupMember(owner, group.id, { userId: "grp-nobody" }),
        404,
        "user_not_found",
      );
    });

    it("parses every input before any statement", async () => {
      const group = await createGroup(owner, { name: "Fictional Parsed" });
      const before = await state();
      for (const call of [
        () => createGroup(owner, { name: "" }),
        () => createGroup(owner, { name: "x".repeat(121) }),
        () =>
          createGroup(owner, {
            name: "Fictional Long",
            description: "x".repeat(501),
          }),
        () =>
          createGroup(owner, {
            name: "Fictional Flagged",
            approval: true,
          } as never),
        () => renameGroup(owner, "not-a-uuid", { name: "Fictional" }),
        () => addGroupMember(owner, group.id, { userId: "" }),
        () => addGroupMember(owner, group.id, { userId: "x".repeat(129) }),
        () =>
          addGroupMember(owner, group.id, {
            userId: owner.userId,
            childGroupId: group.id,
          } as never),
        () => addGroupMember(owner, group.id, { childGroupId: "nope" }),
        () => setGroupApproval(owner, group.id, { approval: "yes" } as never),
        () => computedGroupMembers(owner, ""),
      ])
        await expect(call()).rejects.toBeInstanceOf(z.ZodError);
      expect(await state()).toEqual(before);
    });
  });

  describe("nesting", () => {
    let a: Group, b: Group, c: Group, d: Group, top: Group;
    beforeAll(async () => {
      const made: Group[] = [];
      for (const name of ["A", "B", "C", "D", "Top"])
        made.push(await createGroup(owner, { name: `Fictional Nest ${name}` }));
      [a, b, c, d, top] = made;
    });

    it("accepts a third level, A over B over C", async () => {
      await addGroupMember(owner, a.id, { childGroupId: b.id });
      await addGroupMember(owner, b.id, { childGroupId: c.id });
      await addGroupMember(owner, c.id, { userId: loadUsers[3].userId });
      await expectEffective();
      expect(
        await look(
          "SELECT group_id FROM app.group_effective_members WHERE user_id = $1 AND group_id = ANY($2) ORDER BY group_id",
          [loadUsers[3].userId, [a.id, b.id, c.id]],
        ),
      ).toEqual([a.id, b.id, c.id].sort().map((group_id) => ({ group_id })));
    });

    it("refuses a cycle in the service (409 group_cycle) and in SQL (the check or RQ021)", async () => {
      for (const [parent, sqlState] of [
        [a, "23514"],
        [b, "RQ021"],
        [c, "RQ021"],
      ] as const) {
        await refusedApi(
          () => addGroupMember(owner, parent.id, { childGroupId: a.id }),
          409,
          "group_cycle",
        );
        await refused(
          () => sqlAs(owner, insertMember(parent.id, { childGroupId: a.id })),
          sqlState,
        );
      }
    });

    it("refuses a fourth level below or above in the service (409 group_depth) and in SQL (RQ022)", async () => {
      for (const [parent, child] of [
        [c, d],
        [top, a],
      ]) {
        await refusedApi(
          () => addGroupMember(owner, parent.id, { childGroupId: child.id }),
          409,
          "group_depth",
        );
        await refused(
          () =>
            sqlAs(owner, insertMember(parent.id, { childGroupId: child.id })),
          "RQ022",
        );
      }
      // A group may sit in two parents within the limit.
      await addGroupMember(owner, top.id, { childGroupId: c.id });
      await expectEffective();
    });

    // ADM-12 (job 095): references are by id, so a rename changes nothing that refers to the group.
    it("keeps every member, parent link and effective row when the middle group B of A over B over C is renamed", async () => {
      await addGroupMember(owner, a.id, { userId: loadUsers[1].userId });
      await addGroupMember(owner, b.id, { userId: loadUsers[2].userId });
      const links = () =>
        look(
          "SELECT * FROM app.group_members WHERE group_id = ANY($1) OR child_group_id = ANY($1) ORDER BY group_id, user_id, child_group_id",
          [[a.id, b.id, c.id]],
        );
      const effective = () =>
        look(
          "SELECT * FROM app.group_effective_members ORDER BY group_id, user_id",
        );
      const [linksBefore, effectiveBefore] = [await links(), await effective()];
      expect(
        linksBefore.filter(
          (row) => row.group_id === a.id && row.child_group_id === b.id,
        ),
      ).toHaveLength(1);
      for (const group of [a, b, c])
        expect(
          linksBefore.some(
            (row) => row.group_id === group.id && row.user_id !== null,
          ),
          group.name,
        ).toBe(true);
      const renamed = await renameGroup(owner, b.id, {
        name: "Fictional Nest Middle",
        description: "Fictional renamed middle group",
      });
      expect(renamed).toMatchObject({
        id: b.id,
        name: "Fictional Nest Middle",
      });
      expect(await links()).toEqual(linksBefore);
      expect(await effective()).toEqual(effectiveBefore);
    });
  });

  describe("approval groups are company owner only", () => {
    let g: Group, h: Group, k: Group, l: Group, plain: Group;
    const [inG, inH, extra] = [4, 5, 6];
    beforeAll(async () => {
      g = await createGroup(owner, { name: "Fictional Approvers" });
      h = await createGroup(owner, { name: "Fictional Approver Pool" });
      k = await createGroup(owner, { name: "Fictional Spare Pool" });
      l = await createGroup(owner, { name: "Fictional Inner Pool" });
      plain = await createGroup(owner, { name: "Fictional Plain List" });
      await addGroupMember(owner, g.id, { childGroupId: h.id });
      await addGroupMember(owner, h.id, { childGroupId: l.id });
      await addGroupMember(owner, g.id, { userId: loadUsers[inG].userId });
      await addGroupMember(owner, h.id, { userId: loadUsers[inH].userId });
      expectAudit(
        await audited(() => setGroupApproval(owner, g.id, { approval: true })),
        "group.approval_set",
        owner,
        g.id,
      );
    });

    it("refuses a company admin with people every change of G and H, in the service and in SQL", async () => {
      const userG = { userId: loadUsers[inG].userId };
      const userH = { userId: loadUsers[inH].userId };
      const newUser = { userId: loadUsers[extra].userId };
      const cases: [() => Promise<unknown>, string][] = [
        [
          () => addGroupMember(peopleAdmin, g.id, newUser),
          insertMember(g.id, newUser),
        ],
        [
          () => addGroupMember(peopleAdmin, h.id, newUser),
          insertMember(h.id, newUser),
        ],
        [
          () => removeGroupMember(peopleAdmin, g.id, userG),
          deleteMember(g.id, userG),
        ],
        [
          () => removeGroupMember(peopleAdmin, h.id, userH),
          deleteMember(h.id, userH),
        ],
        [
          () => addGroupMember(peopleAdmin, g.id, { childGroupId: k.id }),
          insertMember(g.id, { childGroupId: k.id }),
        ],
        [
          () => addGroupMember(peopleAdmin, h.id, { childGroupId: k.id }),
          insertMember(h.id, { childGroupId: k.id }),
        ],
        [
          () => removeGroupMember(peopleAdmin, g.id, { childGroupId: h.id }),
          deleteMember(g.id, { childGroupId: h.id }),
        ],
        [
          () => removeGroupMember(peopleAdmin, h.id, { childGroupId: l.id }),
          deleteMember(h.id, { childGroupId: l.id }),
        ],
        [
          () => setGroupApproval(peopleAdmin, g.id, { approval: false }),
          `UPDATE app.groups SET approval = false WHERE id = '${g.id}'`,
        ],
        [
          () => archiveGroup(peopleAdmin, g.id),
          `UPDATE app.groups SET archived_at = now() WHERE id = '${g.id}'`,
        ],
        [
          () => archiveGroup(peopleAdmin, h.id),
          `UPDATE app.groups SET archived_at = now() WHERE id = '${h.id}'`,
        ],
        [
          () => renameGroup(peopleAdmin, l.id, { name: "Fictional Renamed" }),
          `UPDATE app.groups SET name = 'Fictional Renamed' WHERE id = '${l.id}'`,
        ],
      ];
      for (const [service, statement] of cases) {
        await refusedApi(service, 403, "group_owner_required");
        await refused(() => sqlAs(peopleAdmin, statement), "42501");
      }
      // A manager of G: no service function yet, so direct SQL only.
      await refused(
        () =>
          sqlAs(
            peopleAdmin,
            `INSERT INTO app.group_managers(group_id, workspace_id, user_id) VALUES ('${g.id}', '${COMPANY}', '${newUser.userId}')`,
          ),
        "42501",
      );
      // Nor may they set the flag on a plain group, or create a flagged group.
      await refusedApi(
        () => setGroupApproval(peopleAdmin, plain.id, { approval: true }),
        403,
        "group_owner_required",
      );
      await refused(
        () =>
          sqlAs(
            peopleAdmin,
            `UPDATE app.groups SET approval = true WHERE id = '${plain.id}'`,
          ),
        "42501",
      );
      await refused(
        () =>
          sqlAs(
            peopleAdmin,
            `INSERT INTO app.groups(workspace_id, name, approval) VALUES ('${COMPANY}', 'Fictional Flagged', true)`,
          ),
        "42501",
      );
      await expect(
        createGroup(peopleAdmin, {
          name: "Fictional Flagged",
          approval: true,
        } as never),
      ).rejects.toBeInstanceOf(z.ZodError);
      // group_grants answers true for G and the groups below it, false for the rest.
      expect(
        await sqlAs(
          peopleAdmin,
          `SELECT tenant_context.group_grants('${g.id}') AS g, tenant_context.group_grants('${h.id}') AS h,
             tenant_context.group_grants('${l.id}') AS l, tenant_context.group_grants('${plain.id}') AS plain`,
        ),
      ).toEqual([{ g: true, h: true, l: true, plain: false }]);
    });

    it("lets the company owner make each change, and the admin once the flag is cleared", async () => {
      const newUser = { userId: loadUsers[extra].userId };
      const steps: [
        () => Promise<unknown>,
        string,
        string,
        Record<string, string>,
      ][] = [
        [
          () => addGroupMember(owner, g.id, newUser),
          "group.member_added",
          g.id,
          { targetUserId: newUser.userId },
        ],
        [
          () => addGroupMember(owner, h.id, newUser),
          "group.member_added",
          h.id,
          { targetUserId: newUser.userId },
        ],
        [
          () => removeGroupMember(owner, g.id, newUser),
          "group.member_removed",
          g.id,
          { targetUserId: newUser.userId },
        ],
        [
          () => removeGroupMember(owner, h.id, newUser),
          "group.member_removed",
          h.id,
          { targetUserId: newUser.userId },
        ],
        [
          () => addGroupMember(owner, g.id, { childGroupId: k.id }),
          "group.child_added",
          g.id,
          { childGroupId: k.id },
        ],
        [
          () => removeGroupMember(owner, g.id, { childGroupId: k.id }),
          "group.child_removed",
          g.id,
          { childGroupId: k.id },
        ],
        [
          () => addGroupMember(owner, h.id, { childGroupId: k.id }),
          "group.child_added",
          h.id,
          { childGroupId: k.id },
        ],
        [
          () => removeGroupMember(owner, h.id, { childGroupId: k.id }),
          "group.child_removed",
          h.id,
          { childGroupId: k.id },
        ],
        [
          () =>
            sqlAs(
              owner,
              `DELETE FROM app.group_managers WHERE group_id = '${g.id}' AND user_id = '${newUser.userId}'`,
            ),
          "group.manager_removed",
          g.id,
          { targetUserId: newUser.userId },
        ],
        [
          () => setGroupApproval(owner, g.id, { approval: false }),
          "group.approval_cleared",
          g.id,
          {},
        ],
      ];
      // No context names a manager of a group that grants something, the company owner included
      // (0055); one named by the owner's own SQL, as before G was flagged, may still be removed.
      await refused(
        () =>
          sqlAs(
            owner,
            `INSERT INTO app.group_managers(group_id, workspace_id, user_id) VALUES ('${g.id}', '${COMPANY}', '${newUser.userId}')`,
          ),
        "42501",
      );
      await look(
        `INSERT INTO app.group_managers(group_id, workspace_id, user_id) VALUES ('${g.id}', '${COMPANY}', '${newUser.userId}')`,
      );
      for (const [call, action, groupId, extraKeys] of steps) {
        expectAudit(await audited(call), action, owner, groupId, extraKeys);
        await expectEffective();
      }
      // G no longer grants: the admin changes G and H.
      expectAudit(
        await audited(() => addGroupMember(peopleAdmin, g.id, newUser)),
        "group.member_added",
        peopleAdmin,
        g.id,
        { targetUserId: newUser.userId },
      );
      // H stays in G, so G keeps granting through it below; the service would first ask what
      // replaces H in G (ADM-13), and the database archives a group in use as it is.
      expectAudit(
        await audited(() =>
          sqlAs(
            peopleAdmin,
            `UPDATE app.groups SET archived_at = now() WHERE id = '${h.id}'`,
          ),
        ),
        "group.archived",
        peopleAdmin,
        h.id,
      );
      // The owner flags G again and archives it; archived, it still grants.
      await setGroupApproval(owner, g.id, { approval: true });
      expectAudit(
        await audited(() => archiveGroup(owner, g.id)),
        "group.archived",
        owner,
        g.id,
      );
      expect(
        await sqlAs(
          peopleAdmin,
          `SELECT tenant_context.group_grants('${h.id}') AS h`,
        ),
      ).toEqual([{ h: true }]);
      await refusedApi(
        () => removeGroupMember(peopleAdmin, h.id, { childGroupId: l.id }),
        403,
        "group_owner_required",
      );
      // One update that changes several things writes one row per action.
      const both = await audited(() =>
        sqlAs(
          owner,
          `UPDATE app.groups SET name = 'Fictional Plain Approvers', approval = true WHERE id = '${plain.id}'`,
        ),
      );
      expect(both.map((row) => row.action).sort()).toEqual([
        "group.approval_set",
        "group.renamed",
      ]);
    });
  });

  describe("refused callers and isolation", () => {
    let current: Group, xGroup: Group;
    beforeAll(async () => {
      current = await createGroup(owner, { name: "Fictional Isolation" });
      await addGroupMember(owner, current.id, { userId: owner.userId });
      await sqlAs(
        owner,
        `INSERT INTO app.group_managers(group_id, workspace_id, user_id) VALUES ('${current.id}', '${COMPANY}', '${owner.userId}')`,
      );
      xGroup = await createGroup(ownerX, { name: "Fictional Other Crew" });
      await addGroupMember(ownerX, xGroup.id, { userId: ownerX.userId });
      await expectEffective(OTHER);
    });

    it("refuses team-only owners and admins, an admin without people and a token: 403 group_forbidden, 0 rows and 42501 in SQL", async () => {
      for (const p of [teamOwnerB, teamAdminA, orgAdmin, ownerToken]) {
        for (const call of [
          () => createGroup(p, { name: "Fictional Refused" }),
          () => renameGroup(p, current.id, { name: "Fictional Refused" }),
          () => archiveGroup(p, current.id),
          () => setGroupApproval(p, current.id, { approval: true }),
          () => addGroupMember(p, current.id, { userId: recruiter.userId }),
          () => removeGroupMember(p, current.id, { userId: owner.userId }),
          () => computedGroupMembers(p, "all-members"),
        ])
          await refusedApi(call, 403, "group_forbidden");
        for (const table of TABLES)
          expect(
            await sqlAs(p, `SELECT * FROM app.${table}`),
            `${p.userId} ${table}`,
          ).toEqual([]);
        for (const statement of [
          `INSERT INTO app.groups(workspace_id, name) VALUES ('${COMPANY}', 'Fictional Refused')`,
          insertMember(current.id, { userId: recruiter.userId }),
          "SELECT * FROM tenant_context.computed_group_members('all-members')",
        ])
          await refused(() => sqlAs(p, statement), "42501");
      }
    });

    it("keeps every row of another workspace out of reach of a company owner", async () => {
      expect((await state()).groups.length).toBeGreaterThan(1);
      for (const table of TABLES) {
        expect(
          await sqlAs(
            owner,
            `SELECT * FROM app.${table} WHERE workspace_id = '${OTHER}'`,
          ),
          table,
        ).toEqual([]);
        expect(
          await sqlAs(ownerX, `SELECT DISTINCT workspace_id FROM app.${table}`),
          table,
        ).toEqual(table === "group_managers" ? [] : [{ workspace_id: OTHER }]);
      }
      for (const call of [
        () => renameGroup(owner, xGroup.id, { name: "Fictional Taken" }),
        () => archiveGroup(owner, xGroup.id),
        () => removeGroupMember(owner, xGroup.id, { userId: ownerX.userId }),
        () => addGroupMember(owner, xGroup.id, { userId: owner.userId }),
        () => addGroupMember(owner, current.id, { childGroupId: xGroup.id }),
      ])
        await refusedApi(call, 404, "not_found");
      await refusedApi(
        () => addGroupMember(owner, current.id, { userId: ownerX.userId }),
        404,
        "user_not_found",
      );
      // The guard refuses a row of another workspace before any policy.
      await refused(
        () =>
          sqlAs(
            owner,
            `INSERT INTO app.groups(workspace_id, name) VALUES ('${OTHER}', 'Fictional Intruder')`,
          ),
        "42501",
      );
      expect(
        await sqlAs(
          owner,
          `SELECT tenant_context.group_grants('${xGroup.id}') AS x`,
        ),
      ).toEqual([{ x: false }]);
    });
  });

  describe("contexts that expire during a statement", () => {
    let approval: Group, plain: Group;
    const person = () => loadUsers[7].userId;
    beforeAll(async () => {
      approval = await createGroup(owner, {
        name: "Fictional Expiry Approvers",
      });
      plain = await createGroup(owner, { name: "Fictional Expiry List" });
      for (const group of [approval, plain]) {
        await addGroupMember(owner, group.id, { userId: person() });
        await sqlAs(
          owner,
          `INSERT INTO app.group_managers(group_id, workspace_id, user_id) VALUES ('${group.id}', '${COMPANY}', '${person()}')`,
        );
      }
      await setGroupApproval(owner, approval.id, { approval: true });
      // Test-only, on this PGlite: a function the data role calls in a WHERE clause, after the read
      // policy has passed for the row, that moves its own context's expiry into the past.
      await harness.asSuperuser();
      await harness.client.exec(`CREATE SCHEMA fictional_expiry;
        CREATE FUNCTION fictional_expiry.expire() RETURNS boolean LANGUAGE sql SECURITY DEFINER
          SET search_path = pg_catalog, pg_temp AS $$
          UPDATE tenant_context.contexts SET expires_at = clock_timestamp() - interval '1 second'
            WHERE pid = pg_backend_pid() RETURNING true $$;
        GRANT USAGE ON SCHEMA fictional_expiry TO recruitmentos_data;
        GRANT EXECUTE ON FUNCTION fictional_expiry.expire() TO recruitmentos_data;`);
    });
    afterAll(async () => {
      await harness.asSuperuser();
      await harness.client.exec("DROP SCHEMA fictional_expiry CASCADE");
    });

    it("refuses a member or manager delete whose context expired after the read policy passed, with 42501", async () => {
      for (const group of [approval, plain])
        for (const table of ["group_members", "group_managers"])
          for (const p of [peopleAdmin, owner])
            await refused(
              () =>
                sqlAs(
                  p,
                  `DELETE FROM app.${table} WHERE group_id = '${group.id}' AND user_id = '${person()}' AND fictional_expiry.expire()`,
                ),
              "42501",
            );
      // The same delete of the plain group's member under a live context passes, with its audit row.
      expectAudit(
        await audited(() =>
          sqlAs(
            peopleAdmin,
            `DELETE FROM app.group_members WHERE group_id = '${plain.id}' AND user_id = '${person()}'`,
          ),
        ),
        "group.member_removed",
        peopleAdmin,
        plain.id,
        { targetUserId: person() },
      );
      await expectEffective();
    });

    it("stamps a group's creation time on a context insert", async () => {
      const [row] = (await sqlAs(
        peopleAdmin,
        `INSERT INTO app.groups(workspace_id, name, created_at) VALUES ('${COMPANY}', 'Fictional Backdated', '2001-01-01') RETURNING created_at`,
      )) as { created_at: string }[];
      expect(new Date(row.created_at).getFullYear()).toBeGreaterThan(2001);
    });
  });

  describe("effective membership is read-only to the runtime roles", () => {
    it("refuses every write of app.group_effective_members by the data role, even for a company owner", async () => {
      const [row] = await look<{ group_id: string; user_id: string }>(
        "SELECT group_id, user_id FROM app.group_effective_members LIMIT 1",
      );
      expect(row).toBeDefined();
      for (const statement of [
        `INSERT INTO app.group_effective_members(workspace_id, group_id, user_id) VALUES ('${COMPANY}', '${row.group_id}', '${recruiter.userId}')`,
        `UPDATE app.group_effective_members SET user_id = '${recruiter.userId}' WHERE group_id = '${row.group_id}'`,
        `DELETE FROM app.group_effective_members WHERE group_id = '${row.group_id}'`,
      ])
        await expect(sqlAs(owner, statement), statement).rejects.toMatchObject({
          cause: {
            code: "42501",
            message: expect.stringMatching(/permission denied/),
          },
        });
      await expectEffective();
    });

    it("gives the identity role nothing on the four tables", async () => {
      await harness.identityDb();
      for (const table of TABLES)
        for (const statement of [
          `SELECT * FROM app.${table}`,
          `INSERT INTO app.${table} DEFAULT VALUES`,
          `UPDATE app.${table} SET workspace_id = workspace_id`,
          `DELETE FROM app.${table}`,
        ])
          await expect(
            harness.client.query(statement),
            statement,
          ).rejects.toMatchObject({ code: "42501" });
    });
  });

  // ADM-13 (job 099, 0055): Where used, archive with replacement and archived groups.
  describe("where used and archive with replacement", () => {
    let g: Group, p1: Group, p2: Group, r: Group, k: Group, x: Group;
    let d: Group, d1: Group, gone: Group, oldParent: Group, empty: Group;
    let xGroup: Group;
    const replace = (parent: Group, replacement: string | null) => ({
      parentGroupId: parent.id,
      replacementGroupId: replacement,
    });
    const children = async (parent: Group) =>
      (await directMembers(parent.id)).flatMap((row) =>
        row.child_group_id ? [row.child_group_id] : [],
      );
    beforeAll(async () => {
      // X ⊃ P2 ⊃ G and P1 ⊃ G, K; D ⊃ D1; an archived parent of G; G holds one person, R another.
      g = await createGroup(owner, { name: "Fictional Used Group" });
      p1 = await createGroup(owner, { name: "Fictional First Parent" });
      p2 = await createGroup(owner, { name: "Fictional Second Parent" });
      r = await createGroup(owner, { name: "Fictional Replacement" });
      k = await createGroup(owner, { name: "Fictional Sibling" });
      x = await createGroup(owner, { name: "Fictional Top Parent" });
      d = await createGroup(owner, { name: "Fictional Deep Head" });
      d1 = await createGroup(owner, { name: "Fictional Deep Tail" });
      gone = await createGroup(owner, { name: "Fictional Gone Group" });
      oldParent = await createGroup(owner, { name: "Fictional Old Parent" });
      empty = await createGroup(owner, { name: "Fictional Unused Group" });
      xGroup = await createGroup(ownerX, { name: "Fictional Other Spare" });
      for (const [parent, child] of [
        [p1, g],
        [p2, g],
        [p1, k],
        [x, p2],
        [d, d1],
        [oldParent, g],
      ] as const)
        await addGroupMember(owner, parent.id, { childGroupId: child.id });
      await addGroupMember(owner, g.id, { userId: loadUsers[1].userId });
      await addGroupMember(owner, r.id, { userId: loadUsers[2].userId });
      await archiveGroup(owner, gone.id);
      await archiveGroup(owner, oldParent.id);
    });

    it("lists only the active direct parents in Where used, by name, and nothing for an unused group", async () => {
      const used = await getGroup(owner, g.id);
      expect(used.whereUsed).toEqual([
        {
          source: "parent-group",
          group: { id: p1.id, name: p1.name, status: "active" },
        },
        {
          source: "parent-group",
          group: { id: p2.id, name: p2.name, status: "active" },
        },
      ]);
      // X is above P2, not a direct parent; the archived parent is no current use.
      expect((await getGroup(peopleAdmin, p2.id)).whereUsed).toEqual([
        {
          source: "parent-group",
          group: { id: x.id, name: x.name, status: "active" },
        },
      ]);
      expect((await getGroup(owner, empty.id)).whereUsed).toEqual([]);
    });

    it("refuses an archive in use without replacements and with stale or extra parents, writing nothing", async () => {
      await refusedApi(() => archiveGroup(owner, g.id), 409, "group_in_use");
      for (const stale of [
        [replace(p1, null)],
        [replace(p1, null), replace(p1, r.id)],
        [replace(p1, null), replace(p2, null), replace(x, null)],
        [replace(p1, null), replace(x, null)],
      ])
        await refusedApi(
          () => archiveGroup(owner, g.id, stale),
          409,
          "group_uses_changed",
        );
      await refusedApi(
        () => archiveGroup(owner, empty.id, [replace(p1, null)]),
        409,
        "group_uses_changed",
      );
    });

    it("rolls everything back when a replacement makes a cycle, nests too deep or cannot be used", async () => {
      const activity = (await audits()).length;
      for (const [replacement, status, code] of [
        // X contains P2, so P2 would contain its own parent.
        [x.id, 409, "group_cycle"],
        // X ⊃ P2 ⊃ D ⊃ D1 is four levels.
        [d.id, 409, "group_depth"],
        [gone.id, 409, "group_archived"],
        [g.id, 409, "group_member_exists"],
        [xGroup.id, 404, "not_found"],
        ["00000000-0000-4000-a000-0000000000ff", 404, "not_found"],
      ] as const) {
        // P1 is removed first, so the refusal must undo it too.
        await refusedApi(
          () =>
            archiveGroup(owner, g.id, [
              replace(p1, null),
              replace(p2, replacement),
            ]),
          status,
          code,
        );
      }
      // K is already a direct child of P1.
      await refusedApi(
        () => archiveGroup(owner, g.id, [replace(p2, null), replace(p1, k.id)]),
        409,
        "group_member_exists",
      );
      expect((await groupRow(g.id)).archived_at).toBeNull();
      expect(await children(p1)).toEqual(expect.arrayContaining([g.id, k.id]));
      expect(await children(p2)).toEqual([g.id]);
      expect(await audits()).toHaveLength(activity);
    });

    it("replaces and removes in one transaction with the archive, one ids-only audit row each, and rebuilds effective membership", async () => {
      const rows = await audited(() =>
        archiveGroup(owner, g.id, [replace(p2, null), replace(p1, r.id)]),
      );
      expect((await groupRow(g.id)).archived_at).not.toBeNull();
      expect((await children(p1)).sort()).toEqual([k.id, r.id].sort());
      expect(await children(p2)).toEqual([]);
      // The archived parent keeps its link: it is no current use.
      expect(await children(oldParent)).toEqual([g.id]);
      await expectEffective();
      const effective = (group: Group) =>
        look<{ user_id: string }>(
          "SELECT user_id FROM app.group_effective_members WHERE group_id = $1 ORDER BY user_id",
          [group.id],
        );
      expect(await effective(p1)).toEqual([{ user_id: loadUsers[2].userId }]);
      expect(await effective(p2)).toEqual([]);
      expect(await effective(x)).toEqual([]);
      expect(rows.map((row) => row.action).sort()).toEqual([
        "group.archived",
        "group.child_removed",
        "group.child_replaced",
      ]);
      const one = (action: string) =>
        rows.filter((row) => row.action === action);
      expectAudit(
        one("group.child_replaced"),
        "group.child_replaced",
        owner,
        p1.id,
        {
          childGroupId: r.id,
          replacedGroupId: g.id,
        },
      );
      expect(one("group.child_replaced")[0].summary).toBe(
        "Replaced a group in a group",
      );
      expectAudit(
        one("group.child_removed"),
        "group.child_removed",
        owner,
        p2.id,
        {
          childGroupId: g.id,
        },
      );
      expectAudit(one("group.archived"), "group.archived", owner, g.id);
      // The parent's, the replaced group's and the replacement's Audit tab name all three groups.
      for (const group of [p1, g, r])
        expect(
          (await getGroup(owner, group.id)).audit.find(
            (row) => row.action === "group.child_replaced",
          )?.target,
          group.name,
        ).toEqual({
          kind: "replacement",
          parent: p1.name,
          replaced: g.name,
          replacement: r.name,
        });
      expect((await getGroup(owner, g.id)).whereUsed).toEqual([]);
    });

    it("takes nothing new into an archived group, by the service (409 group_archived) and the database (RQ023)", async () => {
      const person = { userId: loadUsers[3].userId };
      for (const call of [
        () => addGroupMember(owner, g.id, person),
        () => addGroupMember(owner, g.id, { childGroupId: empty.id }),
        () => addGroupMember(owner, empty.id, { childGroupId: g.id }),
        () => addGroupManager(owner, g.id, person),
        () => archiveGroup(owner, g.id),
      ])
        await refusedApi(call, 409, "group_archived");
      for (const statement of [
        insertMember(g.id, person),
        insertMember(g.id, { childGroupId: empty.id }),
        insertMember(empty.id, { childGroupId: g.id }),
        `INSERT INTO app.group_managers(group_id, workspace_id, user_id) VALUES ('${g.id}', '${COMPANY}', '${person.userId}')`,
        `UPDATE app.group_members SET child_group_id = '${g.id}' WHERE group_id = '${p1.id}' AND child_group_id = '${r.id}'`,
      ])
        for (const p of [owner, peopleAdmin])
          await refused(() => sqlAs(p, statement), "RQ023");
      // An archived parent takes no new child through the replacement update either: the archived
      // Old Parent still holds G, and replacing G there with a current group is refused, with the
      // same effective rows.
      const before = await expectEffective();
      for (const p of [owner, peopleAdmin])
        await refused(
          () =>
            sqlAs(
              p,
              `UPDATE app.group_members SET child_group_id = '${empty.id}' WHERE group_id = '${oldParent.id}' AND child_group_id = '${g.id}'`,
            ),
          "RQ023",
        );
      expect(await expectEffective()).toBe(before);
      expect(await children(oldParent)).toEqual([g.id]);
    });

    it("refuses every other member or manager update, for a company owner too, with 42501", async () => {
      await sqlAs(
        owner,
        `INSERT INTO app.group_managers(group_id, workspace_id, user_id) VALUES ('${p1.id}', '${COMPANY}', '${loadUsers[4].userId}')`,
      );
      for (const statement of [
        `UPDATE app.group_members SET user_id = '${loadUsers[4].userId}' WHERE group_id = '${r.id}' AND user_id = '${loadUsers[2].userId}'`,
        `UPDATE app.group_members SET added_at = now() WHERE group_id = '${r.id}'`,
        `UPDATE app.group_members SET group_id = '${empty.id}' WHERE group_id = '${p1.id}' AND child_group_id = '${k.id}'`,
        `UPDATE app.group_members SET child_group_id = child_group_id WHERE group_id = '${p1.id}' AND child_group_id = '${k.id}'`,
        `UPDATE app.group_members SET child_group_id = '${empty.id}', added_by = NULL WHERE group_id = '${p1.id}' AND child_group_id = '${k.id}'`,
        `UPDATE app.group_managers SET user_id = '${loadUsers[5].userId}' WHERE group_id = '${p1.id}'`,
      ])
        await refused(() => sqlAs(owner, statement), "42501");
      // The one update there is: a child group replaced in place, with its audit row.
      expectAudit(
        await audited(() =>
          sqlAs(
            peopleAdmin,
            `UPDATE app.group_members SET child_group_id = '${empty.id}' WHERE group_id = '${p1.id}' AND child_group_id = '${k.id}'`,
          ),
        ),
        "group.child_replaced",
        peopleAdmin,
        p1.id,
        { childGroupId: empty.id, replacedGroupId: k.id },
      );
      await expectEffective();
    });
  });

  // ADM-13 (job 099, 0055): delegated managers, named by company authority, acting without it.
  describe("delegated managers", () => {
    let m: Group, mc: Group, other: Group, spare: Group, parent: Group;
    let xGroup: Group;
    let managerToken: Principal;
    const manager = () => recruiter;
    const email = (p: Principal) => `${p.userId}@example.test`;
    const stale = (p: Principal): Principal => ({
      ...p,
      sessionCreatedAt: new Date(Date.now() - 16 * 60_000),
    });
    const managersOf = (group: Group) =>
      look<{ user_id: string }>(
        "SELECT user_id FROM app.group_managers WHERE group_id = $1 ORDER BY user_id",
        [group.id],
      );
    beforeAll(async () => {
      // M holds a person and a child group; the recruiter and team B's admin manage M.
      m = await createGroup(owner, {
        name: "Fictional Managed Crew",
        description: "Fictional crew a recruiter looks after",
      });
      mc = await createGroup(owner, { name: "Fictional Managed Child" });
      other = await createGroup(owner, { name: "Fictional Unmanaged Crew" });
      spare = await createGroup(owner, { name: "Fictional Manager Spare" });
      parent = await createGroup(owner, { name: "Fictional Later Approvers" });
      await addGroupMember(owner, m.id, { userId: loadUsers[3].userId });
      await addGroupMember(owner, m.id, { childGroupId: mc.id });
      await addGroupMember(owner, mc.id, { userId: loadUsers[4].userId });
      await addGroupMember(owner, other.id, { userId: loadUsers[5].userId });
      await addGroupManager(owner, m.id, { userId: manager().userId });
      await addGroupManager(peopleAdmin, m.id, { userId: teamAdminB.userId });
      await addGroupManager(owner, other.id, { userId: teamAdminB.userId });
      xGroup = await createGroup(ownerX, { name: "Fictional Other Managed" });
      await addGroupMember(ownerX, xGroup.id, { userId: ownerX.userId });
      managerToken = await seedApiToken(await harness.asOwner(), manager());
    });

    it("lets a company owner and a company admin with people name and remove managers, one ids-only audit row each", async () => {
      for (const p of [owner, peopleAdmin]) {
        expectAudit(
          await audited(() =>
            addGroupManager(p, spare.id, { userId: teamAdminA.userId }),
          ),
          "group.manager_added",
          p,
          spare.id,
          { targetUserId: teamAdminA.userId },
        );
        await refusedApi(
          () => addGroupManager(p, spare.id, { userId: teamAdminA.userId }),
          409,
          "group_manager_exists",
        );
        expectAudit(
          await audited(() =>
            removeGroupManager(p, spare.id, { userId: teamAdminA.userId }),
          ),
          "group.manager_removed",
          p,
          spare.id,
          { targetUserId: teamAdminA.userId },
        );
        await refusedApi(
          () => removeGroupManager(p, spare.id, { userId: teamAdminA.userId }),
          404,
          "not_found",
        );
      }
      await refusedApi(
        () => addGroupManager(owner, spare.id, { userId: ownerX.userId }),
        404,
        "user_not_found",
      );
      await refusedApi(
        () => addGroupManager(owner, xGroup.id, { userId: recruiter.userId }),
        404,
        "not_found",
      );
      expect(
        (await getGroup(owner, m.id)).managers.map((row) => row.userId).sort(),
      ).toEqual([manager().userId, teamAdminB.userId].sort());
      expect((await getGroup(owner, m.id)).managers[0]).toEqual({
        userId: expect.any(String),
        name: "Fictional Test User",
        email: expect.stringMatching(/@example\.test$/),
      });
    });

    it("lists a manager's current groups with their direct people only", async () => {
      expect(await listManagedGroups(manager())).toEqual([
        {
          id: m.id,
          name: m.name,
          description: "Fictional crew a recruiter looks after",
          grants: false,
          people: [
            {
              userId: loadUsers[3].userId,
              name: "Fictional Test User",
              email: email(loadUsers[3]),
            },
          ],
        },
      ]);
      // Team B's admin manages M and the crew the recruiter does not, by name.
      expect(
        (await listManagedGroups(teamAdminB)).map((row) => row.id),
      ).toEqual([m.id, other.id]);
      // Someone who manages nothing, a company owner included, and another workspace see none.
      for (const p of [teamOwnerB, peopleAdmin, ownerX, managerToken])
        expect(await listManagedGroups(p), p.userId).toEqual([]);
    });

    it("lets a manager without company authority add and remove a person through the service and by direct SQL", async () => {
      const added = loadUsers[6];
      // By email, trimmed and ignoring case; the row is the same as an admin's.
      expectAudit(
        await audited(() =>
          addManagedMember(manager(), m.id, {
            email: `  ${email(added).toUpperCase()} `,
          }),
        ),
        "group.member_added",
        manager(),
        m.id,
        { targetUserId: added.userId },
      );
      await expectEffective();
      await refusedApi(
        () => addManagedMember(manager(), m.id, { email: email(added) }),
        409,
        "group_member_exists",
      );
      expectAudit(
        await audited(() =>
          removeManagedMember(manager(), m.id, { userId: added.userId }),
        ),
        "group.member_removed",
        manager(),
        m.id,
        { targetUserId: added.userId },
      );
      await refusedApi(
        () => removeManagedMember(manager(), m.id, { userId: added.userId }),
        404,
        "not_found",
      );
      expectAudit(
        await audited(() =>
          sqlAs(manager(), insertMember(m.id, { userId: added.userId })),
        ),
        "group.member_added",
        manager(),
        m.id,
        { targetUserId: added.userId },
      );
      expectAudit(
        await audited(() =>
          sqlAs(manager(), deleteMember(m.id, { userId: added.userId })),
        ),
        "group.member_removed",
        manager(),
        m.id,
        { targetUserId: added.userId },
      );
      await expectEffective();
      // An unknown email and a person outside the workspace get the same answer.
      const answers = [];
      for (const value of ["fictional-nobody@example.test", email(ownerX)]) {
        const before = await state();
        answers.push(
          await addManagedMember(manager(), m.id, { email: value }).catch(
            (e) => ({ status: e.status, code: e.code, message: e.message }),
          ),
        );
        expect(await state()).toEqual(before);
      }
      expect(answers).toEqual([
        {
          status: 404,
          code: "user_not_found",
          message: "This person is not in any team of your company.",
        },
        {
          status: 404,
          code: "user_not_found",
          message: "This person is not in any team of your company.",
        },
      ]);
      // A group they do not manage, or of another workspace, is not found.
      for (const call of [
        () => addManagedMember(manager(), other.id, { email: email(added) }),
        () =>
          removeManagedMember(manager(), other.id, {
            userId: loadUsers[5].userId,
          }),
        () => addManagedMember(manager(), xGroup.id, { email: email(added) }),
        () => addManagedMember(teamOwnerB, m.id, { email: email(added) }),
      ])
        await refusedApi(call, 404, "not_found");
    });

    it("refuses a manager every other write by direct SQL with 42501", async () => {
      for (const statement of [
        insertMember(m.id, { childGroupId: spare.id }),
        `INSERT INTO app.group_managers(group_id, workspace_id, user_id) VALUES ('${m.id}', '${COMPANY}', '${loadUsers[6].userId}')`,
        `UPDATE app.groups SET name = 'Fictional Taken Over' WHERE id = '${m.id}'`,
        `UPDATE app.groups SET archived_at = now() WHERE id = '${m.id}'`,
        `UPDATE app.group_members SET added_at = now() WHERE group_id = '${m.id}'`,
        `INSERT INTO app.groups(workspace_id, name) VALUES ('${COMPANY}', 'Fictional Manager Made')`,
        insertMember(other.id, { userId: loadUsers[6].userId }),
        insertMember(spare.id, { userId: loadUsers[6].userId }),
      ])
        await refused(() => sqlAs(manager(), statement), "42501");
      // Rows a manager cannot see are never matched: no error, nothing changed.
      for (const statement of [
        deleteMember(m.id, { childGroupId: mc.id }),
        deleteMember(other.id, { userId: loadUsers[5].userId }),
        `DELETE FROM app.group_managers WHERE group_id = '${m.id}'`,
      ]) {
        const before = await state();
        expect(await sqlAs(manager(), statement)).toEqual([]);
        expect(await state()).toEqual(before);
      }
    });

    it("lets a manager read only their groups, their own manager rows and those groups' user members", async () => {
      expect(await sqlAs(manager(), "SELECT id FROM app.groups")).toEqual([
        { id: m.id },
      ]);
      expect(
        await sqlAs(
          manager(),
          "SELECT group_id, user_id, child_group_id FROM app.group_members ORDER BY user_id",
        ),
      ).toEqual([
        {
          group_id: m.id,
          user_id: loadUsers[3].userId,
          child_group_id: null,
        },
      ]);
      expect(
        await sqlAs(
          manager(),
          "SELECT group_id, user_id FROM app.group_managers",
        ),
      ).toEqual([{ group_id: m.id, user_id: manager().userId }]);
      expect(
        await sqlAs(manager(), "SELECT * FROM app.group_effective_members"),
      ).toEqual([]);
      for (const table of TABLES)
        expect(
          await sqlAs(
            manager(),
            `SELECT * FROM app.${table} WHERE workspace_id = '${OTHER}'`,
          ),
          table,
        ).toEqual([]);
      // A token of the manager, and a team owner who manages nothing, see and change nothing.
      for (const p of [managerToken, teamOwnerB]) {
        for (const table of TABLES)
          expect(
            await sqlAs(p, `SELECT * FROM app.${table}`),
            `${p.authType} ${table}`,
          ).toEqual([]);
        await refused(
          () => sqlAs(p, insertMember(m.id, { userId: loadUsers[6].userId })),
          "42501",
        );
      }
      await refusedApi(
        () =>
          addManagedMember(managerToken, m.id, { email: email(loadUsers[6]) }),
        404,
        "not_found",
      );
    });

    it("refuses a manager once the group or a group it is in grants something, by the service and by direct SQL", async () => {
      const person = loadUsers[3].userId;
      const sentence =
        "Only a company owner can change this group now, because it or a group it is in grants access.";
      const expectRefused = async () => {
        for (const call of [
          () =>
            addManagedMember(manager(), m.id, { email: email(loadUsers[6]) }),
          () => removeManagedMember(manager(), m.id, { userId: person }),
        ]) {
          const before = await state();
          await expect(call()).rejects.toMatchObject({
            status: 403,
            code: "group_owner_required",
            message: sentence,
          });
          expect(await state()).toEqual(before);
        }
        for (const statement of [
          insertMember(m.id, { userId: loadUsers[6].userId }),
          deleteMember(m.id, { userId: person }),
        ])
          await refused(() => sqlAs(manager(), statement), "42501");
        expect(await listManagedGroups(manager())).toEqual([
          expect.objectContaining({ id: m.id, grants: true }),
        ]);
      };
      // Flagged itself after the manager was named.
      await setGroupApproval(owner, m.id, { approval: true });
      await expectRefused();
      await setGroupApproval(owner, m.id, { approval: false });
      // Nested in a group the owner then flags.
      await addGroupMember(owner, parent.id, { childGroupId: m.id });
      await setGroupApproval(owner, parent.id, { approval: true });
      await expectRefused();
      // Their managers stay named, and only a company owner with a recent sign-in removes one.
      await refusedApi(
        () =>
          removeGroupManager(peopleAdmin, m.id, { userId: teamAdminB.userId }),
        403,
        "group_owner_required",
      );
      await refusedApi(
        () =>
          removeGroupManager(stale(owner), m.id, {
            userId: teamAdminB.userId,
          }),
        403,
        "SESSION_NOT_FRESH",
      );
      expectAudit(
        await audited(() =>
          removeGroupManager(owner, m.id, { userId: teamAdminB.userId }),
        ),
        "group.manager_removed",
        owner,
        m.id,
        { targetUserId: teamAdminB.userId },
      );
      await removeGroupMember(owner, parent.id, { childGroupId: m.id });
      // Granting nothing again, the manager's change goes through.
      expectAudit(
        await audited(() =>
          removeManagedMember(manager(), m.id, { userId: person }),
        ),
        "group.member_removed",
        manager(),
        m.id,
        { targetUserId: person },
      );
    });

    it("names no manager on a group that grants something, a company owner included", async () => {
      for (const p of [owner, stale(owner), peopleAdmin])
        await refusedApi(
          () => addGroupManager(p, parent.id, { userId: teamAdminA.userId }),
          409,
          "group_grants_no_managers",
        );
      for (const p of [owner, peopleAdmin])
        await refused(
          () =>
            sqlAs(
              p,
              `INSERT INTO app.group_managers(group_id, workspace_id, user_id) VALUES ('${parent.id}', '${COMPANY}', '${teamAdminA.userId}')`,
            ),
          "42501",
        );
      expect(await managersOf(parent)).toEqual([]);
    });

    it("gives no manager rights to a token or to anyone not named", async () => {
      for (const p of [ownerToken, teamOwnerB, teamAdminA, orgAdmin])
        for (const call of [
          () => addManagedMember(p, m.id, { email: email(loadUsers[6]) }),
          () => removeManagedMember(p, m.id, { userId: loadUsers[3].userId }),
        ])
          await refusedApi(call, 404, "not_found");
    });
  });

  it("keeps effective membership right after every change on 200 groups", async () => {
    const random = seeded(92);
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
    const ids = (
      await sqlAs(
        owner,
        `INSERT INTO app.groups(workspace_id, name) SELECT '${COMPANY}', 'Fictional Load ' || lpad(i::text, 3, '0') FROM generate_series(1, 200) i RETURNING id`,
      )
    ).map((row) => (row as { id: string }).id);
    expect(ids).toHaveLength(200);
    const anonymised = loadUsers[0].userId;
    let gone = false;
    const people = () =>
      loadUsers.map((p) => p.userId).filter((id) => id !== anonymised || !gone);
    let slowest = 0;
    const counts: Record<string, number> = {};
    const links = () =>
      look<Link>(
        "SELECT group_id, user_id, child_group_id FROM app.group_members WHERE group_id = ANY($1)",
        [ids],
      );
    /** Longest chains of links above and below a group, as app.maintain_group_members counts. */
    const chain = (all: Link[], start: string, up: boolean): number => {
      const next = all
        .filter(
          (l) =>
            l.child_group_id &&
            (up ? l.child_group_id === start : l.group_id === start),
        )
        .map((l) => (up ? l.group_id : l.child_group_id!));
      return next.length
        ? 1 + Math.max(...next.map((id) => chain(all, id, up)))
        : 0;
    };
    /** An archive that removes the group from no parent keeps every effective row. */
    async function change(
      kind: string,
      service: () => Promise<unknown>,
      statement: string,
      viaService: boolean,
      keepsEffective = kind === "archive",
    ) {
      const before = keepsEffective ? await expectEffective() : 0;
      const started = performance.now();
      await (viaService ? service() : sqlAs(owner, statement));
      slowest = Math.max(slowest, performance.now() - started);
      counts[kind] = (counts[kind] ?? 0) + 1;
      const after = await expectEffective();
      if (keepsEffective) expect(after).toBe(before);
    }
    // The person anonymised half way is first a member of three groups, one of them nested.
    await addGroupMember(owner, ids[0], { childGroupId: ids[1] });
    for (const index of [0, 1, 2])
      await change(
        "user-add",
        () => addGroupMember(owner, ids[index], { userId: anonymised }),
        insertMember(ids[index], { userId: anonymised }),
        index % 2 === 0,
      );
    for (let step = 0; step < 120; step++) {
      const viaService = step % 2 === 0;
      const actor = step % 4 === 0 ? owner : peopleAdmin;
      const all = await links();
      if (step === 60) {
        const started = performance.now();
        await anonymiseUser(owner, anonymised, {
          confirmName: "Fictional Test User",
        });
        slowest = Math.max(slowest, performance.now() - started);
        gone = true;
        counts.anonymise = 1;
        await expectEffective();
        expect(
          await look(
            "SELECT 1 FROM app.group_effective_members WHERE user_id = $1",
            [anonymised],
          ),
        ).toEqual([]);
        continue;
      }
      const roll = random();
      const users = all.filter((l) => l.user_id);
      const children = all.filter((l) => l.child_group_id);
      // An archived group takes no new member or child, and is nobody's new child (0055).
      const current = (
        await look<{ id: string }>(
          "SELECT id FROM app.groups WHERE id = ANY($1) AND archived_at IS NULL",
          [ids],
        )
      ).map((row) => row.id);
      if (roll < 0.35 || (roll < 0.55 && !users.length)) {
        const group = pick(current);
        const user = pick(people());
        if (users.some((l) => l.group_id === group && l.user_id === user))
          continue;
        await change(
          "user-add",
          () => addGroupMember(actor, group, { userId: user }),
          insertMember(group, { userId: user }),
          viaService,
        );
      } else if (roll < 0.55) {
        const link = pick(users);
        await change(
          "user-remove",
          () =>
            removeGroupMember(actor, link.group_id, { userId: link.user_id! }),
          deleteMember(link.group_id, { userId: link.user_id! }),
          viaService,
        );
      } else if (roll < 0.8 || (roll < 0.92 && !children.length)) {
        // A child link within depth 3 that makes no cycle.
        for (let attempt = 0; attempt < 30; attempt++) {
          const parent = pick(current);
          const child = pick(current);
          const above = new Set<string>([parent]);
          for (let grew = true; grew;) {
            grew = false;
            for (const l of children)
              if (above.has(l.child_group_id!) && !above.has(l.group_id)) {
                above.add(l.group_id);
                grew = true;
              }
          }
          if (
            above.has(child) ||
            children.some(
              (l) => l.group_id === parent && l.child_group_id === child,
            ) ||
            chain(all, parent, true) + chain(all, child, false) + 2 > 3
          )
            continue;
          await change(
            "child-add",
            () => addGroupMember(actor, parent, { childGroupId: child }),
            insertMember(parent, { childGroupId: child }),
            viaService,
          );
          break;
        }
      } else if (roll < 0.92) {
        const link = pick(children);
        await change(
          "child-remove",
          () =>
            removeGroupMember(actor, link.group_id, {
              childGroupId: link.child_group_id!,
            }),
          deleteMember(link.group_id, { childGroupId: link.child_group_id! }),
          viaService,
        );
      } else {
        // The service removes a group in use from each current parent first; direct SQL keeps it.
        const group = pick(current);
        const uses = children
          .filter(
            (l) => l.child_group_id === group && current.includes(l.group_id),
          )
          .map((l) => ({
            parentGroupId: l.group_id,
            replacementGroupId: null,
          }));
        await change(
          "archive",
          () => archiveGroup(actor, group, uses.length ? uses : undefined),
          `UPDATE app.groups SET archived_at = now() WHERE id = '${group}'`,
          viaService,
          !viaService || !uses.length,
        );
      }
    }
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBeGreaterThanOrEqual(100);
    for (const kind of [
      "user-add",
      "user-remove",
      "child-add",
      "child-remove",
      "archive",
      "anonymise",
    ])
      expect(counts[kind], kind).toBeGreaterThan(0);
    // Child links exist in the fixture at the end.
    const all = await links();
    expect(
      Math.max(...ids.map((id) => chain(all, id, false))),
    ).toBeGreaterThanOrEqual(1);
    console.log(
      `Company groups load: ${total} changes on 200 groups (${JSON.stringify(counts)}); slowest single change ${slowest.toFixed(1)} ms`,
    );
  }, 240_000);

  describe("audit", () => {
    it("refuses a direct group activity row from the data role", async () => {
      await refused(
        () =>
          sqlAs(
            owner,
            `INSERT INTO app.activity(team_id, actor_id, actor_type, action, kind, summary, metadata) VALUES ('${owner.teamId}', '${owner.userId}', 'session', 'group.created', 'group', 'Created a group', '{}')`,
          ),
        "42501",
      );
    });

    it("writes ids only: no group name, description, person name or email in any group row", async () => {
      const rows = await audits();
      expect(rows.length).toBeGreaterThan(200);
      const secrets = [
        ...(
          await look<{ name: string; description: string | null }>(
            "SELECT name, description FROM app.groups",
          )
        ).flatMap((row) => [row.name, row.description ?? ""]),
        ...(
          await look<{ name: string; email: string }>(
            'SELECT name, email FROM auth."user"',
          )
        ).flatMap((row) => [row.name, row.email]),
        "Fictional",
        "@example.test",
      ].filter(Boolean);
      for (const row of rows) {
        expect(row.actor_type).toBe("session");
        expect(row.token_id).toBeNull();
        expect(row.record_id).toBeNull();
        const keys = Object.keys(row.metadata).sort();
        if (row.summary === "Details removed by user anonymisation") {
          expect(keys).toEqual([]);
          continue;
        }
        expect(keys).toEqual(
          [
            "groupId",
            "workspaceId",
            ...(/member_|manager_/.test(row.action) ? ["targetUserId"] : []),
            ...(/child_/.test(row.action) ? ["childGroupId"] : []),
            ...(row.action === "group.child_replaced"
              ? ["replacedGroupId"]
              : []),
          ].sort(),
        );
        const text = JSON.stringify([row.summary, row.metadata]).toLowerCase();
        for (const secret of secrets)
          expect(text, row.action).not.toContain(secret.toLowerCase());
      }
    });

    it("keeps group rows out of the feed of a recruiter and of a token", async () => {
      const search = new URLSearchParams({ search: "group." });
      expect(
        (await listActivity(owner, search)).pagination.total,
      ).toBeGreaterThan(0);
      for (const p of [recruiter, ownerToken])
        expect(
          (await listActivity(p, search)).data.filter(
            (row) => row.kind === "group",
          ),
          p.authType,
        ).toEqual([]);
      for (const p of [recruiter, ownerToken])
        expect(
          (await listActivity(p, search)).pagination.total,
          p.authType,
        ).toBe(0);
    });
  });
});
