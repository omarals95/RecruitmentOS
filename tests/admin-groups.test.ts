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
import { RECRUITER_ROLE } from "@/domain/config-defaults";
import { createConfigDraft, publishConfigVersion } from "@/lib/config-store";
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
import {
  DELETE as managersDelete,
  POST as managersPost,
} from "@/app/api/v1/admin/groups/[group]/managers/route";
import {
  DELETE as rolesDelete,
  GET as rolesGet,
  POST as rolesPost,
} from "@/app/api/v1/admin/groups/[group]/roles/route";
import { GET as meGroupsGet } from "@/app/api/v1/me/groups/route";
import {
  DELETE as meMembersDelete,
  POST as meMembersPost,
} from "@/app/api/v1/me/groups/[group]/members/route";
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
  if (url.pathname.startsWith("/api/v1/me/groups"))
    response =
      segments.length === 1
        ? await meGroupsGet(request)
        : await (method === "POST" ? meMembersPost : meMembersDelete)(
            request,
            params({ group: segments[1] }),
          );
  else if (segments[0] === "users")
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
  else if (segments[2] === "managers")
    response = await (method === "POST" ? managersPost : managersDelete)(
      request,
      params({ group: segments[1] }),
    );
  else if (segments[2] === "roles")
    response = await (
      method === "GET" ? rolesGet : method === "POST" ? rolesPost : rolesDelete
    )(request, params({ group: segments[1] }));
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
  /** Every group row, direct and effective member, manager and group activity row. */
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
    grants: await look(
      "SELECT * FROM app.group_roles ORDER BY group_id, team_id",
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

  // ADM-13 (job 101): archive with replacement, the managers route and Groups I manage.
  describe("where used, archive with replacement and delegated managers", () => {
    let plain: Group, granting: Group, approver: Group, nested: Group;
    let used: Group, usedParent: Group, otherParent: Group, unmanaged: Group;
    const manager = () => people[4];
    const email = (p: Principal) => `${p.userId}@example.test`;
    const groupAudits = (action: string) =>
      look<{
        team_id: string;
        actor_id: string;
        metadata: Record<string, string>;
      }>(
        "SELECT team_id, actor_id, metadata FROM app.activity WHERE kind = 'group' AND action = $1 ORDER BY created_at, id",
        [action],
      );
    beforeAll(async () => {
      plain = await made("Fictional Route Managed");
      granting = await made("Fictional Route Granting");
      approver = await made("Fictional Route Approver");
      nested = await made("Fictional Route Nested");
      used = await made("Fictional Route Used");
      usedParent = await made("Fictional Route Used Parent");
      otherParent = await made("Fictional Route Other Parent");
      unmanaged = await made("Fictional Route Unmanaged");
      await member(plain.id, people[0].userId);
      await member(unmanaged.id, people[2].userId);
      await link(plain.id, nested.id);
      await link(usedParent.id, used.id);
      await link(otherParent.id, used.id);
      await link(approver.id, granting.id);
      // Named while the groups granted nothing; the approver is flagged afterwards.
      for (const group of [plain, granting])
        expect(
          (
            await call(
              owner,
              "POST",
              `/api/v1/admin/groups/${group.id}/managers`,
              { userId: manager().userId },
            )
          ).status,
        ).toBe(201);
      await setGroupApproval(fresh(owner), approver.id, { approval: true });
    });

    it("shows Where used and the managers on the group, with no recent sign-in", async () => {
      const { status, body } = await stale(
        owner,
        "GET",
        `/api/v1/admin/groups/${used.id}`,
      );
      expect(status).toBe(200);
      expect(body.data.whereUsed).toEqual([
        {
          source: "parent-group",
          group: {
            id: otherParent.id,
            name: "Fictional Route Other Parent",
            status: "active",
          },
        },
        {
          source: "parent-group",
          group: {
            id: usedParent.id,
            name: "Fictional Route Used Parent",
            status: "active",
          },
        },
      ]);
      const managed = (
        await stale(peopleAdmin, "GET", `/api/v1/admin/groups/${plain.id}`)
      ).body.data;
      expect(managed.managers).toEqual([
        {
          userId: manager().userId,
          name: "Fictional Person 5",
          email: email(manager()),
        },
      ]);
      expect(managed.whereUsed).toEqual([]);
    });

    it("lets a company owner and a company admin with people name and remove a manager, one ids-only audit row each", async () => {
      for (const p of [owner, peopleAdmin]) {
        const path = `/api/v1/admin/groups/${unmanaged.id}/managers`;
        const before = (await groupAudits("group.manager_added")).length;
        expect(
          (await stale(p, "POST", path, { userId: people[3].userId })).status,
        ).toBe(201);
        await refused(
          () => call(p, "POST", path, { userId: people[3].userId }),
          409,
          "group_manager_exists",
        );
        const added = (await groupAudits("group.manager_added")).slice(before);
        expect(added).toEqual([
          {
            team_id: p.teamId,
            actor_id: p.userId,
            metadata: {
              workspaceId: COMPANY,
              groupId: unmanaged.id,
              targetUserId: people[3].userId,
            },
          },
        ]);
        const removedBefore = (await groupAudits("group.manager_removed"))
          .length;
        expect(
          (await stale(p, "DELETE", path, { userId: people[3].userId })).status,
        ).toBe(200);
        expect(
          (await groupAudits("group.manager_removed")).slice(removedBefore),
        ).toEqual([
          {
            team_id: p.teamId,
            actor_id: p.userId,
            metadata: {
              workspaceId: COMPANY,
              groupId: unmanaged.id,
              targetUserId: people[3].userId,
            },
          },
        ]);
        await refused(
          () => call(p, "DELETE", path, { userId: people[3].userId }),
          404,
          "not_found",
        );
      }
      await refused(
        () =>
          call(owner, "POST", `/api/v1/admin/groups/${unmanaged.id}/managers`, {
            userId: ownerX.userId,
          }),
        404,
        "user_not_found",
      );
      await refused(
        () =>
          call(owner, "POST", `/api/v1/admin/groups/${xGroup}/managers`, {
            userId: people[3].userId,
          }),
        404,
        "not_found",
      );
    });

    it("names no manager of a group that grants something, a company owner included, and no recent sign-in decides it", async () => {
      for (const [p, age] of [
        [owner, 1_000],
        [owner, STALE],
        [peopleAdmin, 1_000],
      ] as const)
        for (const group of [approver, granting])
          await refused(
            () =>
              call(
                p,
                "POST",
                `/api/v1/admin/groups/${group.id}/managers`,
                { userId: people[3].userId },
                age,
              ),
            409,
            "group_grants_no_managers",
          );
    });

    it("removes a manager from a granting group only for a company owner with a recent sign-in", async () => {
      const path = `/api/v1/admin/groups/${granting.id}/managers`;
      const body = { userId: manager().userId };
      await refused(
        () => stale(owner, "DELETE", path, body),
        403,
        "SESSION_NOT_FRESH",
      );
      await refused(
        () => call(peopleAdmin, "DELETE", path, body),
        403,
        "group_owner_required",
      );
      expect((await call(owner, "DELETE", path, body)).status).toBe(200);
      expect(
        await look("SELECT 1 FROM app.group_managers WHERE group_id = $1", [
          granting.id,
        ]),
      ).toEqual([]);
    });

    it("archives a group in use only with a choice for each use, in one change", async () => {
      const path = `/api/v1/admin/groups/${used.id}`;
      await refused(
        () => call(owner, "PATCH", path, { archived: true }),
        409,
        "group_in_use",
      );
      await refused(
        () =>
          call(owner, "PATCH", path, {
            archived: true,
            replacements: [
              { parentGroupId: usedParent.id, replacementGroupId: null },
            ],
          }),
        409,
        "group_uses_changed",
      );
      const { status, body } = await stale(peopleAdmin, "PATCH", path, {
        archived: true,
        replacements: [
          { parentGroupId: usedParent.id, replacementGroupId: null },
          {
            parentGroupId: otherParent.id,
            replacementGroupId: unmanaged.id,
          },
        ],
      });
      expect(status).toBe(200);
      expect(body.data.archivedAt).not.toBeNull();
      expect(
        await look(
          "SELECT group_id, child_group_id FROM app.group_members WHERE child_group_id = ANY($1) ORDER BY group_id",
          [[used.id, unmanaged.id]],
        ),
      ).toEqual([{ group_id: otherParent.id, child_group_id: unmanaged.id }]);
      expect(
        (await call(owner, "GET", `/api/v1/admin/groups/${otherParent.id}`))
          .body.data.audit[0],
      ).toMatchObject({
        action: "group.child_replaced",
        actorName: "Fictional People Admin",
        target: {
          kind: "replacement",
          parent: "Fictional Route Other Parent",
          replaced: "Fictional Route Used",
          replacement: "Fictional Route Unmanaged",
        },
      });
    });

    it("needs a recent sign-in to archive a granting group with replacements, writing nothing until then", async () => {
      // Nested below the approver, so it grants; it is used by the approver and by the plain group.
      const inner = await made("Fictional Route Inner");
      await link(approver.id, inner.id);
      await link(plain.id, inner.id);
      const path = `/api/v1/admin/groups/${inner.id}`;
      const body = {
        archived: true,
        replacements: [
          { parentGroupId: approver.id, replacementGroupId: null },
          { parentGroupId: plain.id, replacementGroupId: null },
        ],
      };
      await refused(
        () => stale(owner, "PATCH", path, body),
        403,
        "SESSION_NOT_FRESH",
      );
      await refused(
        () => call(peopleAdmin, "PATCH", path, body),
        403,
        "group_owner_required",
      );
      const { status } = await call(owner, "PATCH", path, body);
      expect(status).toBe(200);
      expect(
        await look(
          "SELECT archived_at IS NOT NULL AS archived FROM app.groups WHERE id = $1",
          [inner.id],
        ),
      ).toEqual([{ archived: true }]);
    });

    it("answers 403 on the managers route and the archive to team-only owners and admins and a company admin without people", async () => {
      for (const p of [teamOwnerB, teamAdminA, fieldsAdmin])
        for (const [method, url, body] of [
          [
            "POST",
            `/api/v1/admin/groups/${unmanaged.id}/managers`,
            { userId: people[3].userId },
          ],
          [
            "DELETE",
            `/api/v1/admin/groups/${plain.id}/managers`,
            { userId: manager().userId },
          ],
          [
            "PATCH",
            `/api/v1/admin/groups/${unmanaged.id}`,
            { archived: true, replacements: [] },
          ],
        ] as const)
          await refused(
            () => call(p, method, url, body),
            403,
            "group_forbidden",
          );
    });

    it("answers 403 session_required to a Bearer token on every new route before any database call", async () => {
      for (const [method, url, body] of [
        [
          "POST",
          `/api/v1/admin/groups/${plain.id}/managers`,
          { userId: people[3].userId },
        ],
        [
          "DELETE",
          `/api/v1/admin/groups/${plain.id}/managers`,
          { userId: manager().userId },
        ],
        ["GET", "/api/v1/me/groups", undefined],
        [
          "POST",
          `/api/v1/me/groups/${plain.id}/members`,
          { email: email(people[3]) },
        ],
        [
          "DELETE",
          `/api/v1/me/groups/${plain.id}/members`,
          { userId: people[0].userId },
        ],
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

    it("lists only the caller's current managed groups with direct people only, never asking for a recent sign-in", async () => {
      const { status, body, text } = await stale(
        manager(),
        "GET",
        "/api/v1/me/groups",
      );
      expect(status).toBe(200);
      expect(body).toEqual({
        data: [
          {
            id: plain.id,
            name: "Fictional Route Managed",
            description: null,
            grants: false,
            people: [
              {
                userId: people[0].userId,
                name: "Fictional Person 1",
                email: email(people[0]),
              },
            ],
          },
        ],
      });
      for (const leak of [
        "Fictional Route Nested",
        nested.id,
        "Fictional Other Crew",
        xGroup,
        "Fictional Route Unmanaged",
      ])
        expect(text, leak).not.toContain(leak);
      for (const p of [owner, teamOwnerB, ownerX])
        expect(
          (await call(p, "GET", "/api/v1/me/groups")).body,
          p.userId,
        ).toEqual({ data: [] });
    });

    it("lets a manager add a person by email and remove them, with the same 404 for an unknown email and a person outside the company", async () => {
      const path = `/api/v1/me/groups/${plain.id}/members`;
      expect(
        (
          await stale(manager(), "POST", path, {
            email: ` ${email(people[3]).toUpperCase()} `,
          })
        ).status,
      ).toBe(201);
      expect(
        await look(
          "SELECT user_id FROM app.group_members WHERE group_id = $1 AND user_id IS NOT NULL ORDER BY user_id",
          [plain.id],
        ),
      ).toEqual([{ user_id: people[0].userId }, { user_id: people[3].userId }]);
      const [added] = (await groupAudits("group.member_added")).slice(-1);
      expect(added).toEqual({
        team_id: manager().teamId,
        actor_id: manager().userId,
        metadata: {
          workspaceId: COMPANY,
          groupId: plain.id,
          targetUserId: people[3].userId,
        },
      });
      const answers: unknown[] = [];
      for (const value of ["fictional-nobody@example.test", email(ownerX)]) {
        const before = await state();
        const answer = await call(manager(), "POST", path, { email: value });
        expect(answer.status).toBe(404);
        // The same body but for its correlation id.
        const { correlationId, ...error } = answer.body.error;
        expect(correlationId).toEqual(expect.any(String));
        answers.push(error);
        expect(await state()).toEqual(before);
      }
      expect(answers).toEqual([
        {
          code: "user_not_found",
          message: "This person is not in any team of your company.",
        },
        {
          code: "user_not_found",
          message: "This person is not in any team of your company.",
        },
      ]);
      expect(
        (await call(manager(), "DELETE", path, { userId: people[3].userId }))
          .status,
      ).toBe(200);
      await refused(
        () => call(manager(), "DELETE", path, { userId: people[3].userId }),
        404,
        "not_found",
      );
      // A group they do not manage, or of another company, is not found; so is any write by
      // someone who manages nothing.
      for (const [p, url, body] of [
        [
          manager(),
          `/api/v1/me/groups/${unmanaged.id}/members`,
          { email: email(people[3]) },
        ],
        [
          manager(),
          `/api/v1/me/groups/${xGroup}/members`,
          { email: email(people[3]) },
        ],
        [teamOwnerB, path, { email: email(people[3]) }],
        [owner, path, { email: email(people[3]) }],
      ] as const)
        await refused(() => call(p, "POST", url, body), 404, "not_found");
      await refused(
        () => call(teamOwnerB, "DELETE", path, { userId: people[0].userId }),
        404,
        "not_found",
      );
    });

    it("refuses a manager a group that started granting with group_owner_required in plain words", async () => {
      await setGroupApproval(fresh(owner), plain.id, { approval: true });
      try {
        for (const [method, body] of [
          ["POST", { email: email(people[3]) }],
          ["DELETE", { userId: people[0].userId }],
        ] as const) {
          const before = await state();
          const { status, body: answer } = await call(
            manager(),
            method,
            `/api/v1/me/groups/${plain.id}/members`,
            body,
          );
          expect([status, answer.error]).toEqual([
            403,
            {
              correlationId: expect.any(String),
              code: "group_owner_required",
              message:
                "Only a company owner can change this group now, because it or a group it is in grants access.",
            },
          ]);
          expect(await state()).toEqual(before);
        }
        expect(
          (await call(manager(), "GET", "/api/v1/me/groups")).body.data,
        ).toEqual([expect.objectContaining({ id: plain.id, grants: true })]);
      } finally {
        await setGroupApproval(fresh(owner), plain.id, { approval: false });
      }
    });

    it("answers 400 to malformed archive, manager and Groups I manage bodies, writing nothing", async () => {
      const replacement = {
        parentGroupId: usedParent.id,
        replacementGroupId: null,
      };
      for (const [method, url, body] of [
        [
          "PATCH",
          `/api/v1/admin/groups/${unmanaged.id}`,
          { archived: true, replacements: Array(201).fill(replacement) },
        ],
        [
          "PATCH",
          `/api/v1/admin/groups/${unmanaged.id}`,
          {
            archived: true,
            replacements: [{ ...replacement, note: "Fictional" }],
          },
        ],
        [
          "PATCH",
          `/api/v1/admin/groups/${unmanaged.id}`,
          {
            archived: true,
            replacements: [
              { parentGroupId: "not-a-uuid", replacementGroupId: null },
            ],
          },
        ],
        [
          "PATCH",
          `/api/v1/admin/groups/${unmanaged.id}`,
          { name: "Fictional Both", replacements: [] },
        ],
        ["POST", `/api/v1/admin/groups/${plain.id}/managers`, {}],
        [
          "POST",
          `/api/v1/admin/groups/${plain.id}/managers`,
          { userId: people[3].userId, role: "admin" },
        ],
        [
          "DELETE",
          `/api/v1/admin/groups/not-a-uuid/managers`,
          { userId: people[3].userId },
        ],
        [
          "POST",
          `/api/v1/me/groups/${plain.id}/members`,
          { email: `${"f".repeat(243)}@example.test` },
        ],
        ["POST", `/api/v1/me/groups/${plain.id}/members`, { email: "  " }],
        [
          "POST",
          `/api/v1/me/groups/${plain.id}/members`,
          { userId: people[3].userId },
        ],
        [
          "DELETE",
          `/api/v1/me/groups/${plain.id}/members`,
          { email: email(people[0]) },
        ],
        ["GET", "/api/v1/me/groups?all=true", undefined],
      ] as const)
        await refused(
          () => call(owner, method, url, body),
          400,
          "invalid_input",
        );
    });
  });

  // ADM-14 (job 103): giving a group a role, company owners only, with a recent sign-in.
  describe("groups as role grantees", () => {
    let target: Group, spare: Group;
    let role: { objectId: string; versionId: string };
    let xRole: { objectId: string; versionId: string };
    const roles = (group: string) => `/api/v1/admin/groups/${group}/roles`;
    const publish = async (p: Principal, key: string) => {
      const draft = await createConfigDraft(p, {
        type: "role",
        key,
        body: {
          ...structuredClone(RECRUITER_ROLE.body),
          name: `Fictional ${key}`,
        },
      });
      await publishConfigVersion(p, draft.versionId);
      return draft;
    };
    beforeAll(async () => {
      target = await made("Fictional Role Target");
      spare = await made("Fictional Role Spare");
      await member(target.id, people[0].userId);
      role = await publish(owner, "adm-group-role");
      xRole = await publish(ownerX, "adm-x-role");
    });

    it("answers 403 on every roles method to a Bearer token, team-only owners and admins, a company admin without people and one with people, writing nothing", async () => {
      const grant = { teamId: "adm-team-a", roleObjectId: role.objectId };
      for (const [method, body] of [
        ["GET", undefined],
        ["POST", grant],
        ["DELETE", { teamId: "adm-team-a" }],
      ] as const) {
        await refused(
          () => call("bearer", method, roles(target.id), body),
          403,
          "session_required",
        );
        for (const p of [teamOwnerB, teamAdminA, fieldsAdmin])
          await refused(
            () => call(p, method, roles(target.id), body),
            403,
            "group_forbidden",
          );
        await refused(
          () => call(peopleAdmin, method, roles(target.id), body),
          403,
          "group_owner_required",
        );
      }
    });

    it("lists the current teams and the roles to give, and never a group, team or role of another workspace", async () => {
      const { status, body, text } = await stale(
        owner,
        "GET",
        roles(target.id),
      );
      expect(status).toBe(200);
      expect(body.data.teams).toEqual([
        { id: "adm-team-a", name: "Fictional A Team" },
        { id: "adm-team-b", name: "Fictional B Team" },
      ]);
      expect(body.data.roles).toContainEqual({
        roleObjectId: role.objectId,
        name: "Fictional adm-group-role",
        membership: "recruiter",
      });
      for (const hidden of ["adm-team-x", "Fictional X Team", xRole.objectId])
        expect(text, hidden).not.toContain(hidden);
      await refused(() => call(owner, "GET", roles(xGroup)), 404, "not_found");
      await refused(
        () => call(ownerX, "GET", roles(target.id)),
        404,
        "not_found",
      );
      for (const grant of [
        { teamId: "adm-team-x", roleObjectId: role.objectId },
        { teamId: "adm-team-a", roleObjectId: xRole.objectId },
      ])
        await refused(
          () => call(owner, "POST", roles(target.id), grant),
          404,
          "not_found",
        );
      await refused(
        () =>
          call(owner, "POST", roles(xGroup), {
            teamId: "adm-team-a",
            roleObjectId: role.objectId,
          }),
        404,
        "not_found",
      );
      await refused(
        () =>
          call(owner, "POST", roles(UNKNOWN), {
            teamId: "adm-team-a",
            roleObjectId: role.objectId,
          }),
        404,
        "not_found",
      );
    });

    it("needs a recent sign-in to give, remove, change the people of and archive a group that gives a role, and never to read it", async () => {
      const grant = { teamId: "adm-team-a", roleObjectId: role.objectId };
      await refused(
        () => stale(owner, "POST", roles(target.id), grant),
        403,
        "SESSION_NOT_FRESH",
      );
      const given = await call(owner, "POST", roles(target.id), grant);
      expect([given.status, given.body]).toEqual([
        201,
        { data: { granted: true } },
      ]);
      for (const path of [
        `/api/v1/admin/groups/${target.id}`,
        roles(target.id),
      ]) {
        const { status, text } = await stale(owner, "GET", path);
        expect(status, path).toBe(200);
        expect(text, path).not.toContain("SESSION_NOT_FRESH");
      }
      const archive = {
        archived: true,
        replacements: [{ teamId: "adm-team-a", replacementGroupId: spare.id }],
      };
      for (const [method, path, body] of [
        ["DELETE", roles(target.id), { teamId: "adm-team-a" }],
        [
          "POST",
          `/api/v1/admin/groups/${target.id}/members`,
          { userId: people[2].userId },
        ],
        ["PATCH", `/api/v1/admin/groups/${target.id}`, archive],
      ] as const)
        await refused(
          () => stale(owner, method, path, body),
          403,
          "SESSION_NOT_FRESH",
        );
      // The same changes with a recent sign-in.
      expect(
        (
          await call(
            owner,
            "POST",
            `/api/v1/admin/groups/${target.id}/members`,
            {
              userId: people[2].userId,
            },
          )
        ).status,
      ).toBe(201);
      const removed = await call(owner, "DELETE", roles(target.id), {
        teamId: "adm-team-a",
      });
      expect([removed.status, removed.body]).toEqual([
        200,
        { data: { removed: true } },
      ]);
      expect((await call(owner, "POST", roles(target.id), grant)).status).toBe(
        201,
      );
      const archived = await call(
        owner,
        "PATCH",
        `/api/v1/admin/groups/${target.id}`,
        archive,
      );
      expect(archived.status).toBe(200);
      expect(archived.body.data.archivedAt).not.toBeNull();
      const { body } = await call(
        owner,
        "GET",
        `/api/v1/admin/groups/${spare.id}`,
      );
      expect(body.data.whereUsed).toEqual([
        {
          source: "role-grant",
          team: { id: "adm-team-a", name: "Fictional A Team" },
          role: { id: role.objectId, name: "Fictional adm-group-role" },
        },
      ]);
    });

    it("answers 400 to malformed roles bodies and any query key, writing nothing", async () => {
      for (const [method, url, body] of [
        ["POST", roles(spare.id), { teamId: "adm-team-a" }],
        [
          "POST",
          roles(spare.id),
          { teamId: "adm-team-a", roleObjectId: "not-a-uuid" },
        ],
        ["POST", roles(spare.id), { teamId: "", roleObjectId: role.objectId }],
        [
          "POST",
          roles(spare.id),
          {
            teamId: "adm-team-a",
            roleObjectId: role.objectId,
            membership: "admin",
          },
        ],
        ["DELETE", roles(spare.id), {}],
        ["DELETE", roles("not-a-uuid"), { teamId: "adm-team-a" }],
        ["GET", `${roles(spare.id)}?team=adm-team-a`, undefined],
        [
          "PATCH",
          `/api/v1/admin/groups/${spare.id}`,
          {
            archived: true,
            replacements: [{ teamId: "", replacementGroupId: null }],
          },
        ],
      ] as const)
        await refused(
          () => call(owner, method, url, body),
          400,
          "invalid_input",
        );
    });
  });
});
