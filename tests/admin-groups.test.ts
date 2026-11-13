import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requests pick the pool by role, as on a split-role deployment: the identity role reads the
// membership and the names, the data role runs withTeam. Only one PGlite role is active at a time.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));

import type { AppDb } from "@/db";
import { getVerifiedSession } from "@/lib/auth-session";
import { createGroup, setGroupApproval, type Group } from "@/lib/groups";
import type { Principal } from "@/lib/principal";
import {
  GET as groupsGet,
  POST as groupsPost,
} from "@/app/api/v1/admin/groups/route";
import {
  GET as groupGet,
  PATCH as groupPatch,
} from "@/app/api/v1/admin/groups/[group]/route";
import {
  DELETE as membersDelete,
  POST as membersPost,
} from "@/app/api/v1/admin/groups/[group]/members/route";
import { GET as userGroupsGet } from "@/app/api/v1/admin/users/[user]/groups/route";
import { GET as usersGet } from "@/app/api/v1/admin/users/route";
import { createSplitRoleDb, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace with two fictional teams, and a second fictional
// workspace the owner role inserts (ADM-12, job 095).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const SECOND = "00000000-0000-4000-a000-000000000095";
const UNKNOWN = "00000000-0000-4000-a000-0000000000ff";
const ORIGIN = "http://localhost:3000";
const STALE = 16 * 60_000;
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Caller = Principal | "bearer";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = { status: number; text: string; body: any };

/** One route call as a signed-in member (fresh unless `age` says otherwise) or a Bearer token. */
async function call(
  as: Caller,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  age = 1_000,
): Promise<Answer> {
  if (as !== "bearer")
    vi.mocked(getVerifiedSession).mockResolvedValue({
      user: { id: as.userId, twoFactorEnabled: true },
      session: {
        activeOrganizationId: as.teamId,
        createdAt: new Date(Date.now() - age),
      },
    } as never);
  const url = new URL(`${ORIGIN}${path}`);
  const request = new Request(url, {
    method,
    headers: {
      origin: ORIGIN,
      ...(as === "bearer"
        ? { authorization: "Bearer fictional-groups-token" }
        : { "x-team-id": as.teamId }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });
  const segments = url.pathname.split("/").slice(4);
  const params = <T>(value: T) => ({ params: Promise.resolve(value) });
  let response: Response;
  if (segments[0] === "users")
    response =
      segments.length === 1
        ? await usersGet(request)
        : await userGroupsGet(request, params({ user: segments[1] }));
  else if (segments.length === 1)
    response = await (method === "GET" ? groupsGet : groupsPost)(request);
  else if (segments.length === 2)
    response = await (method === "GET" ? groupGet : groupPatch)(
      request,
      params({ group: segments[1] }),
    );
  else
    response = await (method === "POST" ? membersPost : membersDelete)(
      request,
      params({ group: segments[1] }),
    );
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}
const stale = (
  as: Principal,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
) => call(as, method, path, body, STALE);

describe("the Groups page routes under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, peopleAdmin: Principal, fieldsAdmin: Principal;
  let teamOwnerB: Principal, teamAdminA: Principal, ownerX: Principal;
  let people: Principal[];
  let xGroup: string;

  /** Raw reads as the PGlite superuser, which bypasses RLS; only to inspect outcomes. */
  const look = async <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  /** Every group row, direct and effective member and group activity row. */
  const state = async () => ({
    groups: await look("SELECT * FROM app.groups ORDER BY id"),
    members: await look(
      "SELECT * FROM app.group_members ORDER BY group_id, user_id, child_group_id",
    ),
    effective: await look(
      "SELECT * FROM app.group_effective_members ORDER BY group_id, user_id",
    ),
    audits: await look(
      "SELECT id FROM app.activity WHERE kind = 'group' ORDER BY id",
    ),
  });
  /** The call answers this status and code and changes no group row or group activity row. */
  async function refused(
    request: () => Promise<Answer>,
    status: number,
    code: string,
  ) {
    const before = await state();
    const { status: got, body } = await request();
    expect([got, body.error?.code]).toEqual([status, code]);
    expect(await state()).toEqual(before);
  }
  const fresh = (p: Principal): Principal => ({
    ...p,
    sessionCreatedAt: new Date(),
  });
  const made = async (name: string) =>
    (await createGroup(owner, { name })) as Group;
  const link = (parent: string, child: string) =>
    look(
      `INSERT INTO app.group_members(group_id, workspace_id, child_group_id) VALUES ('${parent}', '${COMPANY}', '${child}')`,
    );
  const member = (group: string, userId: string) =>
    look(
      `INSERT INTO app.group_members(group_id, workspace_id, user_id) VALUES ('${group}', '${COMPANY}', '${userId}')`,
    );

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, {
      userId: "adm-owner",
      teamId: "adm-team-a",
    });
    peopleAdmin = await seedIdentity(db, {
      userId: "adm-people-admin",
      teamId: "adm-team-a",
      role: "recruiter",
    });
    fieldsAdmin = await seedIdentity(db, {
      userId: "adm-fields-admin",
      teamId: "adm-team-a",
      role: "recruiter",
    });
    teamAdminA = await seedIdentity(db, {
      userId: "adm-team-admin-a",
      teamId: "adm-team-a",
      role: "admin",
    });
    teamOwnerB = await seedIdentity(db, {
      userId: "adm-owner-b",
      teamId: "adm-team-b",
    });
    people = [];
    for (let index = 1; index <= 6; index++)
      people.push(
        await seedIdentity(db, {
          userId: `adm-person-${index}`,
          teamId: index % 2 ? "adm-team-a" : "adm-team-b",
          role: index === 2 ? "admin" : "recruiter",
        }),
      );
    ownerX = await seedIdentity(db, {
      userId: "adm-owner-x",
      teamId: "adm-team-x",
    });
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','adm-people-admin','admin','{people}'),
        ('${COMPANY}','adm-fields-admin','admin','{fields}');
      INSERT INTO app.workspaces(id,name) VALUES ('${SECOND}','Fictional Second Company');
      UPDATE app.workspace_teams SET workspace_id = '${SECOND}' WHERE team_id = 'adm-team-x';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level) VALUES ('${SECOND}','adm-owner-x','owner');`);
    // Names that differ from every id.
    await harness.asSuperuser();
    await harness.client.exec(`
      UPDATE auth.organization SET name = 'Fictional ' || upper(split_part(id, '-', 3)) || ' Team' WHERE id LIKE 'adm-team-%';
      UPDATE auth."user" SET name = 'Fictional ' || initcap(replace(replace(id, 'adm-', ''), '-', ' ')) WHERE id LIKE 'adm-%';`);
    // A group of the second workspace, inserted by the owner role.
    xGroup = (
      await look<{ id: string }>(
        `INSERT INTO app.groups(workspace_id, name) VALUES ('${SECOND}', 'Fictional Other Crew') RETURNING id`,
      )
    )[0].id;
    await look(
      `INSERT INTO app.group_members(group_id, workspace_id, user_id) VALUES ('${xGroup}', '${SECOND}', 'adm-owner-x')`,
    );
  });
  afterAll(async () => harness?.close());

  describe("refused callers", () => {
    let target: Group;
    beforeAll(async () => {
      target = await made("Fictional Refusal Target");
      await member(target.id, people[0].userId);
    });

    it("answers 403 to a team-only owner, a team-only admin and a company admin without people, writing nothing", async () => {
      const path = `/api/v1/admin/groups/${target.id}`;
      for (const p of [teamOwnerB, teamAdminA, fieldsAdmin]) {
        for (const [method, url, body, code] of [
          ["GET", "/api/v1/admin/groups", undefined, "people_forbidden"],
          [
            "POST",
            "/api/v1/admin/groups",
            { name: "Fictional Refused" },
            "group_forbidden",
          ],
          ["GET", path, undefined, "people_forbidden"],
          ["PATCH", path, { name: "Fictional Refused" }, "group_forbidden"],
          ["PATCH", path, { archived: true }, "group_forbidden"],
          [
            "POST",
            `${path}/members`,
            { userId: people[1].userId },
            "group_forbidden",
          ],
          [
            "DELETE",
            `${path}/members`,
            { userId: people[0].userId },
            "group_forbidden",
          ],
          [
            "GET",
            `/api/v1/admin/users/${people[0].userId}/groups`,
            undefined,
            "people_forbidden",
          ],
          [
            "GET",
            `/api/v1/admin/users?group=${target.id}`,
            undefined,
            "people_forbidden",
          ],
        ] as const)
          await refused(() => call(p, method, url, body), 403, code as string);
      }
    });

    it("answers 403 session_required to a Bearer token before any database call", async () => {
      const path = `/api/v1/admin/groups/${target.id}`;
      for (const [method, url, body] of [
        ["GET", "/api/v1/admin/groups", undefined],
        ["POST", "/api/v1/admin/groups", { name: "Fictional Token" }],
        ["GET", path, undefined],
        ["PATCH", path, { archived: true }],
        ["POST", `${path}/members`, { userId: people[1].userId }],
        ["DELETE", `${path}/members`, { userId: people[0].userId }],
        ["GET", `/api/v1/admin/users/${people[0].userId}/groups`, undefined],
        ["GET", `/api/v1/admin/users?group=${target.id}`, undefined],
      ] as const) {
        const calls = pools.data.mock.calls.length;
        await refused(
          () => call("bearer", method, url, body),
          403,
          "session_required",
        );
        expect(pools.data.mock.calls.length, `${method} ${url}`).toBe(calls);
      }
    });

    it("answers 400 to an unknown query key, a malformed id and a malformed body, writing nothing", async () => {
      const path = `/api/v1/admin/groups/${target.id}`;
      for (const [method, url, body] of [
        ["GET", "/api/v1/admin/groups?search=fictional", undefined],
        ["POST", "/api/v1/admin/groups?approval=true", { name: "Fictional" }],
        ["POST", "/api/v1/admin/groups", { name: "" }],
        [
          "POST",
          "/api/v1/admin/groups",
          { name: "Fictional Flagged", approval: true },
        ],
        ["GET", `${path}?tab=members`, undefined],
        ["GET", "/api/v1/admin/groups/not-a-uuid", undefined],
        ["PATCH", "/api/v1/admin/groups/not-a-uuid", { archived: true }],
        ["PATCH", path, { name: "Fictional Both", archived: true }],
        ["PATCH", path, { archived: false }],
        ["PATCH", path, { approval: true }],
        ["PATCH", path, {}],
        [
          "POST",
          `${path}/members`,
          { userId: people[1].userId, childGroupId: UNKNOWN },
        ],
        ["POST", `${path}/members`, { childGroupId: "not-a-uuid" }],
        ["DELETE", `${path}/members`, { userId: "" }],
        ["GET", `/api/v1/admin/users/${"u".repeat(129)}/groups`, undefined],
        [
          "GET",
          `/api/v1/admin/users/${people[0].userId}/groups?direct=true`,
          undefined,
        ],
        ["GET", "/api/v1/admin/users?group=not-a-uuid", undefined],
      ] as const)
        await refused(
          () => call(owner, method, url, body),
          400,
          "invalid_input",
        );
    });
  });

  describe("the recent sign-in rule for groups that grant something", () => {
    let flagged: Group, child: Group, grandchild: Group, spare: Group;
    let plain: Group, adminPlain: Group;
    const userIn = () => people[0].userId;
    const userNew = () => people[2].userId;
    /** The six changes of one group, with its current user member and child group. */
    const changes = (group: Group, current: string, currentChild: string) =>
      [
        [
          "PATCH",
          `/api/v1/admin/groups/${group.id}`,
          { name: `${group.name} Renamed` },
        ],
        ["PATCH", `/api/v1/admin/groups/${group.id}`, { archived: true }],
        [
          "POST",
          `/api/v1/admin/groups/${group.id}/members`,
          { userId: userNew() },
        ],
        [
          "DELETE",
          `/api/v1/admin/groups/${group.id}/members`,
          { userId: current },
        ],
        [
          "POST",
          `/api/v1/admin/groups/${group.id}/members`,
          { childGroupId: spare.id },
        ],
        [
          "DELETE",
          `/api/v1/admin/groups/${group.id}/members`,
          { childGroupId: currentChild },
        ],
      ] as const;

    beforeAll(async () => {
      flagged = await made("Fictional Flagged Approvers");
      child = await made("Fictional Flagged Child");
      grandchild = await made("Fictional Flagged Grandchild");
      spare = await made("Fictional Spare Group");
      plain = await made("Fictional Plain Group");
      adminPlain = await made("Fictional Admin Plain Group");
      await link(flagged.id, child.id);
      await link(child.id, grandchild.id);
      await member(flagged.id, userIn());
      await member(child.id, userIn());
      await setGroupApproval(fresh(owner), flagged.id, { approval: true });
    });

    it("refuses a stale company owner every change of the flagged group and of its child with SESSION_NOT_FRESH, writing nothing", async () => {
      for (const [group, childOf] of [
        [flagged, child],
        [child, grandchild],
      ] as const)
        for (const [method, url, body] of changes(group, userIn(), childOf.id))
          await refused(
            () => stale(owner, method, url, body),
            403,
            "SESSION_NOT_FRESH",
          );
    });

    /** Each change of a group that grants nothing, archive last. */
    const plainChanges = (group: Group) =>
      [
        [
          "PATCH",
          `/api/v1/admin/groups/${group.id}`,
          { name: `${group.name} Renamed` },
        ],
        [
          "POST",
          `/api/v1/admin/groups/${group.id}/members`,
          { userId: userIn() },
        ],
        [
          "DELETE",
          `/api/v1/admin/groups/${group.id}/members`,
          { userId: userIn() },
        ],
        [
          "POST",
          `/api/v1/admin/groups/${group.id}/members`,
          { childGroupId: spare.id },
        ],
        [
          "DELETE",
          `/api/v1/admin/groups/${group.id}/members`,
          { childGroupId: spare.id },
        ],
        ["PATCH", `/api/v1/admin/groups/${group.id}`, { archived: true }],
      ] as const;

    it("lets the same stale owner change the plain group and read every group route", async () => {
      for (const [method, url, body] of plainChanges(plain)) {
        const { status, text } = await stale(owner, method, url, body);
        expect(
          status,
          `${method} ${url} ${JSON.stringify(body)} ${text}`,
        ).toBeLessThan(300);
      }
      for (const url of [
        "/api/v1/admin/groups",
        `/api/v1/admin/groups/${flagged.id}`,
        `/api/v1/admin/groups/${child.id}`,
        `/api/v1/admin/users/${userIn()}/groups`,
        `/api/v1/admin/users?group=${flagged.id}`,
      ])
        expect((await stale(owner, "GET", url)).status, url).toBe(200);
    });

    it("refuses a company admin with people, fresh or stale, the flagged group and its child with group_owner_required, and lets them change a plain group", async () => {
      for (const age of [1_000, STALE])
        for (const [group, childOf] of [
          [flagged, child],
          [child, grandchild],
        ] as const)
          for (const [method, url, body] of changes(
            group,
            userIn(),
            childOf.id,
          ))
            await refused(
              () => call(peopleAdmin, method, url, body, age),
              403,
              "group_owner_required",
            );
      for (const [method, url, body] of plainChanges(adminPlain)) {
        const { status, text } = await stale(peopleAdmin, method, url, body);
        expect(status, `${method} ${url} ${text}`).toBeLessThan(300);
      }
    });

    it("lets a fresh company owner make every change of the flagged group", async () => {
      for (const [method, url, body] of [
        ...changes(flagged, userIn(), child.id).filter(
          ([method, , body]) => !(method === "PATCH" && "archived" in body),
        ),
        // The child goes back, so it grants again for the list below.
        [
          "POST",
          `/api/v1/admin/groups/${flagged.id}/members`,
          { childGroupId: child.id },
        ],
        ["PATCH", `/api/v1/admin/groups/${flagged.id}`, { archived: true }],
      ] as const) {
        const { status, text } = await call(owner, method, url, body);
        expect(status, `${method} ${url} ${text}`).toBeLessThan(300);
      }
      expect(
        await look(
          "SELECT name, archived_at IS NOT NULL AS archived FROM app.groups WHERE id = $1",
          [flagged.id],
        ),
      ).toEqual([
        { name: "Fictional Flagged Approvers Renamed", archived: true },
      ]);
    });
  });

  describe("read contents", () => {
    let a: Group, b: Group, c: Group, lone: Group;
    // A ⊃ B ⊃ C, with person 1 in A, person 2 in B and persons 3 and 4 in C.
    beforeAll(async () => {
      a = await made("Fictional Read A");
      b = await made("Fictional Read B");
      c = await made("Fictional Read C");
      lone = await made("Fictional Read Lone");
      for (const [method, url, body] of [
        [
          "PATCH",
          `/api/v1/admin/groups/${a.id}`,
          { name: "Fictional Read A", description: "Fictional top group" },
        ],
        [
          "POST",
          `/api/v1/admin/groups/${a.id}/members`,
          { childGroupId: b.id },
        ],
        [
          "POST",
          `/api/v1/admin/groups/${b.id}/members`,
          { childGroupId: c.id },
        ],
        [
          "POST",
          `/api/v1/admin/groups/${a.id}/members`,
          { userId: people[0].userId },
        ],
        [
          "POST",
          `/api/v1/admin/groups/${b.id}/members`,
          { userId: people[1].userId },
        ],
        [
          "POST",
          `/api/v1/admin/groups/${c.id}/members`,
          { userId: people[2].userId },
        ],
        [
          "POST",
          `/api/v1/admin/groups/${c.id}/members`,
          { userId: people[3].userId },
        ],
        [
          "POST",
          `/api/v1/admin/groups/${lone.id}/members`,
          { userId: people[3].userId },
        ],
      ] as const)
        expect((await call(owner, method, url, body)).status, url).toBeLessThan(
          300,
        );
    });

    it("lists every group with its status, grants, counts and direct links, and the computed groups with their counts, and no email", async () => {
      for (const p of [owner, peopleAdmin]) {
        const { status, body, text } = await call(
          p,
          "GET",
          "/api/v1/admin/groups",
        );
        expect(status).toBe(200);
        expect(Object.keys(body).sort()).toEqual(["computed", "data"]);
        for (const row of body.data)
          expect(Object.keys(row).sort()).toEqual([
            "childGroups",
            "description",
            "directPeople",
            "grants",
            "id",
            "name",
            "parentGroups",
            "people",
            "status",
          ]);
        const names = body.data.map((row: { name: string }) => row.name);
        expect(names).toEqual(
          [...names].sort((x: string, y: string) =>
            x.toLowerCase().localeCompare(y.toLowerCase()),
          ),
        );
        const byId = (id: string) =>
          body.data.find((row: { id: string }) => row.id === id);
        expect(byId(a.id)).toEqual({
          id: a.id,
          name: "Fictional Read A",
          description: "Fictional top group",
          status: "active",
          grants: false,
          directPeople: 1,
          people: 4,
          childGroups: [{ id: b.id, name: "Fictional Read B" }],
          parentGroups: [],
        });
        expect(byId(b.id)).toMatchObject({
          directPeople: 1,
          people: 3,
          childGroups: [{ id: c.id, name: "Fictional Read C" }],
          parentGroups: [{ id: a.id, name: "Fictional Read A" }],
        });
        expect(byId(c.id)).toMatchObject({
          directPeople: 2,
          people: 2,
          childGroups: [],
        });
        // The archived flagged group from the rule above still grants and reads Archived.
        expect(
          body.data.find(
            (row: { name: string }) =>
              row.name === "Fictional Flagged Approvers Renamed",
          ),
        ).toMatchObject({ status: "archived", grants: true });
        expect(
          body.data.find(
            (row: { name: string }) => row.name === "Fictional Flagged Child",
          ),
        ).toMatchObject({ status: "active", grants: true });
        expect(body.computed).toEqual([
          { key: "company-owners", name: "Company owners", people: 1 },
          { key: "company-admins", name: "Company admins", people: 2 },
          { key: "all-members", name: "All members", people: 11 },
          {
            key: "team-owners:adm-team-a",
            name: "Owners of Fictional A Team",
            people: 1,
          },
          {
            key: "team-admins:adm-team-a",
            name: "Admins of Fictional A Team",
            people: 1,
          },
          {
            key: "team-owners:adm-team-b",
            name: "Owners of Fictional B Team",
            people: 1,
          },
          {
            key: "team-admins:adm-team-b",
            name: "Admins of Fictional B Team",
            people: 1,
          },
        ]);
        for (const leak of [
          "@",
          "Fictional Other Crew",
          xGroup,
          "adm-person",
          "Fictional Person",
        ])
          expect(text, leak).not.toContain(leak);
      }
    });

    it("returns the tree, the groups it is in and the audit rows by name, with no other raw user id", async () => {
      const { status, body, text } = await call(
        owner,
        "GET",
        `/api/v1/admin/groups/${a.id}`,
      );
      expect(status).toBe(200);
      const person = (index: number) => ({
        userId: people[index].userId,
        name: `Fictional Person ${index + 1}`,
        email: `${people[index].userId}@example.test`,
      });
      expect(body.data).toMatchObject({
        id: a.id,
        name: "Fictional Read A",
        description: "Fictional top group",
        status: "active",
        grants: false,
        people: 4,
        members: {
          people: [person(0)],
          groups: [
            {
              id: b.id,
              name: "Fictional Read B",
              status: "active",
              people: [person(1)],
              groups: [
                {
                  id: c.id,
                  name: "Fictional Read C",
                  status: "active",
                  people: [person(2), person(3)],
                  groups: [],
                },
              ],
            },
          ],
        },
        memberOf: [],
      });
      // No user id outside the userId fields of member entries.
      const outside = text
        .replace(/"userId":"[^"]+"/g, "")
        .replace(/"email":"[^"]+"/g, "");
      for (const p of [owner, ...people])
        expect(outside, p.userId).not.toContain(p.userId);
      const c3 = (await call(owner, "GET", `/api/v1/admin/groups/${c.id}`)).body
        .data;
      expect(c3.memberOf).toEqual([
        { id: b.id, name: "Fictional Read B", status: "active", via: null },
        {
          id: a.id,
          name: "Fictional Read A",
          status: "active",
          via: "Fictional Read B",
        },
      ]);
      // B's audit, newest first: added person 2, added group C, added to A, created.
      const bAudit = (await call(owner, "GET", `/api/v1/admin/groups/${b.id}`))
        .body.data.audit;
      expect(
        bAudit.map(
          (row: { action: string; actorName: string; target: unknown }) => [
            row.action,
            row.actorName,
            row.target,
          ],
        ),
      ).toEqual([
        [
          "group.member_added",
          "Fictional Owner",
          { kind: "person", name: "Fictional Person 2" },
        ],
        [
          "group.child_added",
          "Fictional Owner",
          { kind: "group", name: "Fictional Read C" },
        ],
        [
          "group.child_added",
          "Fictional Owner",
          { kind: "parent", name: "Fictional Read A" },
        ],
        ["group.created", "Fictional Owner", null],
      ]);
      for (const row of bAudit) expect(row.occurredAt).toMatch(/Z$/);
      const aAudit = (await call(owner, "GET", `/api/v1/admin/groups/${a.id}`))
        .body.data.audit;
      expect(aAudit.map((row: { action: string }) => row.action)).toEqual([
        "group.member_added",
        "group.child_added",
        "group.renamed",
        "group.created",
      ]);
    });

    it("shows only the audit rows written from the caller's current team", async () => {
      // Person 2 is a company admin with people in team B for this case only.
      await look(
        `INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${COMPANY}','${people[1].userId}','admin','{people}')`,
      );
      try {
        expect(
          (
            await call(
              people[1],
              "POST",
              `/api/v1/admin/groups/${lone.id}/members`,
              { userId: people[0].userId },
            )
          ).status,
        ).toBe(201);
        const fromA = (
          await call(owner, "GET", `/api/v1/admin/groups/${lone.id}`)
        ).body.data;
        expect(
          fromA.audit.map((row: { action: string }) => row.action),
        ).toEqual(["group.member_added", "group.created"]);
        expect(fromA.members.people).toHaveLength(2);
        const fromB = (
          await call(people[1], "GET", `/api/v1/admin/groups/${lone.id}`)
        ).body.data;
        expect(fromB.audit).toEqual([
          expect.objectContaining({
            action: "group.member_added",
            actorName: "Fictional Person 2",
            target: { kind: "person", name: "Fictional Person 1" },
          }),
        ]);
      } finally {
        await look(
          `DELETE FROM app.workspace_admins WHERE user_id = '${people[1].userId}'`,
        );
      }
    });

    it("answers 404 for another workspace's group and an unknown id", async () => {
      for (const id of [xGroup, UNKNOWN]) {
        const { status, body, text } = await call(
          owner,
          "GET",
          `/api/v1/admin/groups/${id}`,
        );
        expect([status, body.error.code]).toEqual([404, "not_found"]);
        expect(text).not.toContain("Fictional Other Crew");
      }
      for (const [method, url, body] of [
        [
          "PATCH",
          `/api/v1/admin/groups/${xGroup}`,
          { name: "Fictional Taken" },
        ],
        [
          "POST",
          `/api/v1/admin/groups/${xGroup}/members`,
          { userId: owner.userId },
        ],
        [
          "DELETE",
          `/api/v1/admin/groups/${xGroup}/members`,
          { userId: ownerX.userId },
        ],
      ] as const)
        await refused(() => call(owner, method, url, body), 404, "not_found");
    });

    it("lists a person's groups, direct and through nesting, with the through names", async () => {
      const groupsOf = async (p: Principal) => {
        const { status, body } = await call(
          owner,
          "GET",
          `/api/v1/admin/users/${p.userId}/groups`,
        );
        expect(status).toBe(200);
        return body.data;
      };
      // Person 4 is directly in C and in Lone, and through C in B and A.
      expect(await groupsOf(people[3])).toEqual(
        [
          {
            id: lone.id,
            name: "Fictional Read Lone",
            status: "active",
            direct: true,
            through: [],
          },
          {
            id: a.id,
            name: "Fictional Read A",
            status: "active",
            direct: false,
            through: ["Fictional Read C"],
          },
          {
            id: b.id,
            name: "Fictional Read B",
            status: "active",
            direct: false,
            through: ["Fictional Read C"],
          },
          {
            id: c.id,
            name: "Fictional Read C",
            status: "active",
            direct: true,
            through: [],
          },
        ].sort((x, y) => x.name.localeCompare(y.name)),
      );
      // Person 1 is directly in A, and in A again through nothing else.
      expect(
        (await groupsOf(people[0])).find(
          (row: { id: string }) => row.id === a.id,
        ),
      ).toEqual({
        id: a.id,
        name: "Fictional Read A",
        status: "active",
        direct: true,
        through: [],
      });
      // Another workspace's owner is in no group of this one.
      expect(await groupsOf(ownerX)).toEqual([]);
      expect(await groupsOf({ ...owner, userId: "adm-nobody" })).toEqual([]);
    });

    it("filters the users list by a group's effective members, and lists nobody for another workspace's group or an unknown id", async () => {
      const emails = async (query: string) => {
        const { status, body } = await call(
          owner,
          "GET",
          `/api/v1/admin/users${query}`,
        );
        expect(status, query).toBe(200);
        return body.data.map((row: { email: string }) => row.email);
      };
      expect(await emails(`?group=${a.id}`)).toEqual(
        [0, 1, 2, 3].map((index) => `${people[index].userId}@example.test`),
      );
      expect(await emails(`?group=${c.id}&team=adm-team-b`)).toEqual([
        `${people[3].userId}@example.test`,
      ]);
      expect(await emails(`?group=${xGroup}`)).toEqual([]);
      expect(await emails(`?group=${UNKNOWN}`)).toEqual([]);
    });
  });
});
