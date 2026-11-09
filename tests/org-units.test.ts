import { sql } from "drizzle-orm";
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

import type { AppDb, TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import { getVerifiedSession } from "@/lib/auth-session";
import {
  archiveOrgLevel,
  archiveOrgUnit,
  createOrgLevel,
  createOrgUnit,
  listOrgLevels,
  listOrgUnits,
  moveOrgUnit,
  renameOrgLevel,
  renameOrgUnit,
  type OrgLevel,
  type OrgUnit,
} from "@/lib/org";
import type { Principal } from "@/lib/principal";
import { installTenantContext } from "@/lib/tenant-context";
import {
  GET as listUnitsRoute,
  POST as createUnitRoute,
} from "@/app/api/v1/org-units/route";
import { PATCH as patchUnitRoute } from "@/app/api/v1/org-units/[id]/route";
import {
  GET as listLevelsRoute,
  POST as createLevelRoute,
} from "@/app/api/v1/org-units/levels/route";
import { PATCH as patchLevelRoute } from "@/app/api/v1/org-units/levels/[id]/route";
import {
  createSplitRoleDb,
  createTestDb,
  seedApiToken,
  seedIdentity,
} from "./helpers/db";

// Fictional data only: one company workspace with three fictional teams, and a second fictional
// workspace inserted by the owner for the isolation case (R2a-13, 0033).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000002";
const ORIGIN = "http://localhost:3000";
const TIMING = /^total;dur=\d+\.\d, db;dur=\d+\.\d, dbrt;desc="(\d+)"$/;
const ORG_ACTIONS = [
  "org.level_created",
  "org.level_renamed",
  "org.level_archived",
  "org.unit_created",
  "org.unit_renamed",
  "org.unit_moved",
  "org.unit_archived",
];
const LEVEL_KEYS = ["depth", "levelId", "workspaceId"];
const UNIT_KEYS = [
  "fromParentId",
  "levelId",
  "toParentId",
  "unitId",
  "workspaceId",
];
// Right-to-left override, zero-width space and a bell control character, removed by cleaning.
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const BEL = String.fromCharCode(0x07);
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
type Handler = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

const signIn = (p: Principal) =>
  vi.mocked(getVerifiedSession).mockResolvedValue({
    user: { id: p.userId, twoFactorEnabled: true },
    session: { activeOrganizationId: p.teamId },
  } as never);

/** One request through a route handler, as a signed-in member or with a Bearer token. */
async function call(
  handler: Handler,
  method: "GET" | "POST" | "PATCH",
  path: string,
  options: { as?: Principal; body?: unknown; id?: string; bearer?: boolean },
) {
  if (options.as) signIn(options.as);
  const response = await handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(options.as ? { "x-team-id": options.as.teamId } : {}),
        ...(options.bearer
          ? { authorization: "Bearer fictional-org-token" }
          : {}),
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    { params: Promise.resolve({ id: options.id ?? "" }) },
  );
  const timing = TIMING.exec(response.headers.get("server-timing") ?? "");
  return {
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: (await response.json()) as any,
    roundTrips: Number(timing?.[1]),
  };
}

describe("organisation levels and units under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, orgAdmin: Principal, fieldsAdmin: Principal;
  let teamOwnerB: Principal, teamAdminA: Principal, recruiter: Principal;
  let viewer: Principal, ownerToken: Principal, ownerOauth: Principal;
  let ownerX: Principal;
  /** The six levels of the company workspace at depths 0 to 5, created by the company owner. */
  let levels: OrgLevel[];

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
      "SELECT id, team_id, actor_id, actor_type, token_id, record_id, action, kind, summary, metadata FROM app.activity WHERE kind IN ('org', 'scope') ORDER BY created_at, id",
    );
  /** Every org row and every org or scope activity row. */
  const state = async () => ({
    levels: await look("SELECT * FROM app.org_levels ORDER BY id"),
    units: await look("SELECT * FROM app.org_units ORDER BY id"),
    closure: await look(
      "SELECT * FROM app.org_unit_closure ORDER BY ancestor_id, descendant_id",
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
  /** Runs the call and expects one SQLSTATE, with no org row or org audit row changed. */
  async function refused(call: () => Promise<unknown>, code: string) {
    const before = await state();
    await expect(call()).rejects.toMatchObject({ cause: { code } });
    expect(await state()).toEqual(before);
  }
  /** Runs the call and expects one API error, with no org row or org audit row changed. */
  async function refusedApi(
    call: () => Promise<unknown>,
    status: number,
    code: string,
  ) {
    const before = await state();
    await expect(call()).rejects.toMatchObject({ status, code });
    expect(await state()).toEqual(before);
  }
  /** The org and scope rows the call added. */
  async function audited(call: () => Promise<unknown>) {
    const before = new Set((await audits()).map((row) => row.id));
    await call();
    return (await audits()).filter((row) => !before.has(row.id));
  }
  const unitRow = async (id: string) =>
    (
      await look<{
        parent_id: string | null;
        name: string;
        code: string;
        archived_at: Date | null;
        created_by: string | null;
      }>(
        "SELECT parent_id, name, code, archived_at, created_by FROM app.org_units WHERE id = $1",
        [id],
      )
    )[0];
  const unit = (
    p: Principal,
    name: string,
    code: string,
    level: number,
    parentId?: string | null,
  ) =>
    createOrgUnit(p, {
      name,
      code,
      levelId: levels[level].id,
      parentId,
    });
  /** Closure rows of the workspace and a recursive recomputation over parent_id. */
  async function expectClosure(workspace = COMPANY) {
    const actual = await look(
      "SELECT ancestor_id, descendant_id, depth FROM app.org_unit_closure WHERE workspace_id = $1 ORDER BY 1, 2",
      [workspace],
    );
    const expected = await look(
      `WITH RECURSIVE tree AS (
         SELECT id AS ancestor_id, id AS descendant_id, 0 AS depth FROM app.org_units WHERE workspace_id = $1
         UNION ALL SELECT t.ancestor_id, u.id, t.depth + 1 FROM tree t
           JOIN app.org_units u ON u.workspace_id = $1 AND u.parent_id = t.descendant_id)
       SELECT ancestor_id, descendant_id, depth FROM tree ORDER BY 1, 2`,
      [workspace],
    );
    expect(actual).toEqual(expected);
    return actual.length;
  }

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, {
      userId: "org-owner",
      teamId: "org-team-a",
    });
    teamAdminA = await seedIdentity(db, {
      userId: "org-team-admin",
      teamId: "org-team-a",
      role: "admin",
    });
    recruiter = await seedIdentity(db, {
      userId: "org-recruiter",
      teamId: "org-team-a",
      role: "recruiter",
    });
    viewer = await seedIdentity(db, {
      userId: "org-viewer",
      teamId: "org-team-a",
      role: "viewer",
    });
    teamOwnerB = await seedIdentity(db, {
      userId: "org-owner-b",
      teamId: "org-team-b",
    });
    orgAdmin = await seedIdentity(db, {
      userId: "org-admin",
      teamId: "org-team-b",
      role: "recruiter",
    });
    fieldsAdmin = await seedIdentity(db, {
      userId: "org-fields-admin",
      teamId: "org-team-b",
      role: "recruiter",
    });
    ownerX = await seedIdentity(db, {
      userId: "org-owner-x",
      teamId: "org-team-x",
    });
    ownerToken = await seedApiToken(db, owner);
    // An MCP OAuth grant is an auth.api_tokens row with a client id on the principal.
    ownerOauth = {
      ...(await seedApiToken(db, owner)),
      oauthClientId: "fictional-oauth-client",
    };
    // Company authority and the second workspace are owner-written; no team is created after this.
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','org-admin','admin','{organisation}'),
        ('${COMPANY}','org-fields-admin','admin','{fields}');
      INSERT INTO app.workspaces(id,name) VALUES ('${OTHER}','Fictional Other Company');
      UPDATE app.workspace_teams SET workspace_id = '${OTHER}' WHERE team_id = 'org-team-x';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level) VALUES ('${OTHER}','org-owner-x','owner');
    `);
    levels = [];
    for (let depth = 0; depth < 6; depth++)
      levels.push(
        await createOrgLevel(owner, {
          name: `Fictional level ${depth}`,
          depth,
        }),
      );
  });
  afterAll(async () => harness?.close());

  it("forces row-level security on the three tables", async () => {
    expect(
      await look(
        "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid IN ('app.org_levels'::regclass, 'app.org_units'::regclass, 'app.org_unit_closure'::regclass) ORDER BY relname",
      ),
    ).toEqual(
      ["org_levels", "org_unit_closure", "org_units"].map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );
  });

  describe("routes for a company owner", () => {
    it("creates, renames, moves and archives units and levels, and GET shows each result", async () => {
      const created = await call(createUnitRoute, "POST", "/api/v1/org-units", {
        as: owner,
        body: { name: "Fictional Holdings", code: "FH", levelId: levels[0].id },
      });
      expect(created.status).toBe(201);
      const holdings = created.body.data as OrgUnit;
      expect(holdings).toMatchObject({
        name: "Fictional Holdings",
        code: "FH",
        levelId: levels[0].id,
        parentId: null,
        archivedAt: null,
        hasChildren: false,
      });
      const group = (
        await call(createUnitRoute, "POST", "/api/v1/org-units", {
          as: owner,
          body: { name: "Fictional Group", code: "FG", levelId: levels[0].id },
        })
      ).body.data as OrgUnit;
      const division = await call(
        createUnitRoute,
        "POST",
        "/api/v1/org-units",
        {
          as: owner,
          body: {
            name: "Sample Division",
            code: "SD",
            levelId: levels[1].id,
            parentId: holdings.id,
          },
        },
      );
      expect(division.status).toBe(201);
      const divisionId = (division.body.data as OrgUnit).id;
      expect((await unitRow(divisionId)).created_by).toBe("org-owner");

      const top = await call(listUnitsRoute, "GET", "/api/v1/org-units", {
        as: owner,
      });
      expect(top.status).toBe(200);
      expect(
        (top.body.data as OrgUnit[]).filter((u) =>
          ["FG", "FH"].includes(u.code),
        ),
      ).toEqual([
        expect.objectContaining({ id: group.id, hasChildren: false }),
        expect.objectContaining({ id: holdings.id, hasChildren: true }),
      ]);
      expect(top.body.pagination).toEqual({
        page: 1,
        pageSize: 100,
        hasMore: false,
      });

      const renamed = await call(
        patchUnitRoute,
        "PATCH",
        `/api/v1/org-units/${divisionId}`,
        {
          as: owner,
          id: divisionId,
          body: { name: "Sample Division East" },
        },
      );
      expect(renamed.status).toBe(200);
      expect(renamed.body.data).toMatchObject({
        id: divisionId,
        name: "Sample Division East",
        code: "SD",
      });
      const moved = await call(
        patchUnitRoute,
        "PATCH",
        `/api/v1/org-units/${divisionId}`,
        {
          as: owner,
          id: divisionId,
          body: { parentId: group.id },
        },
      );
      expect(moved.status).toBe(200);
      expect(moved.body.data).toMatchObject({ parentId: group.id });
      const children = await call(
        listUnitsRoute,
        "GET",
        `/api/v1/org-units?parentId=${group.id}`,
        { as: owner },
      );
      expect(children.body.data).toEqual([
        expect.objectContaining({
          id: divisionId,
          parentId: group.id,
          levelId: levels[1].id,
          name: "Sample Division East",
          code: "SD",
          validFrom: expect.any(String),
          hasChildren: false,
        }),
      ]);
      const archived = await call(
        patchUnitRoute,
        "PATCH",
        `/api/v1/org-units/${divisionId}`,
        {
          as: owner,
          id: divisionId,
          body: { archived: true },
        },
      );
      expect(archived.status).toBe(200);
      expect(archived.body.data.archivedAt).toEqual(expect.any(String));
      expect(
        (
          await call(
            listUnitsRoute,
            "GET",
            `/api/v1/org-units?parentId=${group.id}`,
            {
              as: owner,
            },
          )
        ).body.data,
      ).toEqual([]);
      // An archived unit stays archived and takes no further change.
      expect(
        (
          await call(
            patchUnitRoute,
            "PATCH",
            `/api/v1/org-units/${divisionId}`,
            {
              as: owner,
              id: divisionId,
              body: { name: "Changed" },
            },
          )
        ).body.error.code,
      ).toBe("org_state_conflict");

      // A level at depth 6, created, renamed and archived while unused.
      const level = await call(
        createLevelRoute,
        "POST",
        "/api/v1/org-units/levels",
        {
          as: owner,
          body: { name: "Fictional Section", depth: 6 },
        },
      );
      expect(level.status).toBe(201);
      const levelId = (level.body.data as OrgLevel).id;
      const renamedLevel = await call(
        patchLevelRoute,
        "PATCH",
        `/api/v1/org-units/levels/${levelId}`,
        {
          as: owner,
          id: levelId,
          body: { name: "Fictional Team Level" },
        },
      );
      expect(renamedLevel.body.data).toEqual({
        id: levelId,
        name: "Fictional Team Level",
        depth: 6,
        archivedAt: null,
      });
      const archivedLevel = await call(
        patchLevelRoute,
        "PATCH",
        `/api/v1/org-units/levels/${levelId}`,
        {
          as: owner,
          id: levelId,
          body: { archived: true },
        },
      );
      expect(archivedLevel.status).toBe(200);
      const listed = await call(
        listLevelsRoute,
        "GET",
        "/api/v1/org-units/levels",
        {
          as: owner,
        },
      );
      expect(
        (listed.body.data as OrgLevel[]).map((l) => [l.depth, l.name]),
      ).toEqual([
        ...levels.map((l) => [l.depth, l.name]),
        [6, "Fictional Team Level"],
      ]);
      expect((listed.body.data as OrgLevel[])[6].archivedAt).toEqual(
        expect.any(String),
      );
      // No unit goes on an archived level; a level in use cannot be archived.
      expect(
        (
          await call(createUnitRoute, "POST", "/api/v1/org-units", {
            as: owner,
            body: { name: "Denied", code: "DENIED-LEVEL", levelId },
          })
        ).body.error.code,
      ).toBe("org_state_conflict");
      await refusedApi(
        () => archiveOrgLevel(owner, levels[0].id),
        409,
        "org_state_conflict",
      );
      // A duplicate depth and a duplicate current code.
      await refusedApi(
        () => createOrgLevel(owner, { name: "Duplicate", depth: 0 }),
        409,
        "org_level_exists",
      );
      await refusedApi(
        () => unit(owner, "Duplicate", "FH", 0),
        409,
        "org_code_exists",
      );
      // An unknown and another workspace's id.
      for (const id of ["00000000-0000-4000-a000-0000000000ff"]) {
        expect(
          (
            await call(patchUnitRoute, "PATCH", `/api/v1/org-units/${id}`, {
              as: owner,
              id,
              body: { name: "Missing" },
            })
          ).status,
        ).toBe(404);
        expect(
          (
            await call(
              listUnitsRoute,
              "GET",
              `/api/v1/org-units?parentId=${id}`,
              { as: owner },
            )
          ).body.error.code,
        ).toBe("not_found");
      }
      await expectClosure();
    });

    it("lets any member's session read, and answers every Bearer request with 403 session_required", async () => {
      for (const p of [viewer, recruiter, teamOwnerB])
        expect(
          (await call(listUnitsRoute, "GET", "/api/v1/org-units", { as: p }))
            .status,
          p.userId,
        ).toBe(200);
      const id = levels[0].id;
      const before = await state();
      for (const [handler, method, path, body] of [
        [listUnitsRoute, "GET", "/api/v1/org-units", undefined],
        [
          createUnitRoute,
          "POST",
          "/api/v1/org-units",
          { name: "Denied", code: "DENIED", levelId: id },
        ],
        [
          patchUnitRoute,
          "PATCH",
          `/api/v1/org-units/${id}`,
          { archived: true },
        ],
        [listLevelsRoute, "GET", "/api/v1/org-units/levels", undefined],
        [
          createLevelRoute,
          "POST",
          "/api/v1/org-units/levels",
          { name: "Denied", depth: 7 },
        ],
        [
          patchLevelRoute,
          "PATCH",
          `/api/v1/org-units/levels/${id}`,
          { archived: true },
        ],
      ] as const) {
        const response = await call(handler as Handler, method, path, {
          bearer: true,
          id,
          body,
        });
        expect(
          [response.status, response.body.error.code],
          `${method} ${path}`,
        ).toEqual([403, "session_required"]);
      }
      expect(await state()).toEqual(before);
    });

    it("stores names and codes cleaned and trimmed, and refuses bounds, unknown keys, depth 8 and two operations", async () => {
      const created = await call(createUnitRoute, "POST", "/api/v1/org-units", {
        as: owner,
        body: {
          name: `  Fictional${ZWSP} Clean${RLO} Unit${BEL} `,
          code: ` CL${ZWSP}-1${RLO} `,
          levelId: levels[0].id,
        },
      });
      expect(created.status).toBe(201);
      const id = (created.body.data as OrgUnit).id;
      expect(await unitRow(id)).toMatchObject({
        name: "Fictional Clean Unit",
        code: "CL-1",
      });
      const longest = await call(createUnitRoute, "POST", "/api/v1/org-units", {
        as: owner,
        body: {
          name: `${"a".repeat(120)}${ZWSP.repeat(5)}`,
          code: "CL-2",
          levelId: levels[0].id,
        },
      });
      expect(longest.status).toBe(201);
      const before = await state();
      for (const [handler, method, path, body] of [
        [
          createUnitRoute,
          "POST",
          "/api/v1/org-units",
          {
            name: `${"a".repeat(121)}${ZWSP}`,
            code: "CL-3",
            levelId: levels[0].id,
          },
        ],
        [
          createUnitRoute,
          "POST",
          "/api/v1/org-units",
          { name: ` ${ZWSP} `, code: "CL-3", levelId: levels[0].id },
        ],
        [
          createUnitRoute,
          "POST",
          "/api/v1/org-units",
          { name: "Fictional", code: "", levelId: levels[0].id },
        ],
        [
          createUnitRoute,
          "POST",
          "/api/v1/org-units",
          {
            name: "Fictional",
            code: "CL-3",
            levelId: levels[0].id,
            colour: "red",
          },
        ],
        [
          createUnitRoute,
          "POST",
          "/api/v1/org-units",
          { name: "Fictional", code: "CL-3", levelId: "not-a-uuid" },
        ],
        [
          createLevelRoute,
          "POST",
          "/api/v1/org-units/levels",
          { name: "Fictional", depth: 8 },
        ],
        [
          createLevelRoute,
          "POST",
          "/api/v1/org-units/levels",
          { name: "Fictional", depth: 1.5 },
        ],
        [
          createLevelRoute,
          "POST",
          "/api/v1/org-units/levels",
          { name: "", depth: 7 },
        ],
        [
          patchUnitRoute,
          "PATCH",
          `/api/v1/org-units/${id}`,
          { name: "Two", archived: true },
        ],
        [
          patchUnitRoute,
          "PATCH",
          `/api/v1/org-units/${id}`,
          { name: "Two", parentId: null },
        ],
        [
          patchUnitRoute,
          "PATCH",
          `/api/v1/org-units/${id}`,
          { archived: false },
        ],
        [patchUnitRoute, "PATCH", `/api/v1/org-units/${id}`, {}],
        [
          patchLevelRoute,
          "PATCH",
          `/api/v1/org-units/levels/${levels[0].id}`,
          { name: "Two", archived: true },
        ],
        [
          patchLevelRoute,
          "PATCH",
          `/api/v1/org-units/levels/${levels[0].id}`,
          { parentId: null },
        ],
      ] as const) {
        const response = await call(handler as Handler, method, path, {
          as: owner,
          id: path.split("/").pop(),
          body,
        });
        expect(
          [response.status, response.body.error.code],
          JSON.stringify(body),
        ).toEqual([400, "invalid_input"]);
      }
      for (const query of [
        "pageSize=201",
        "pageSize=0",
        "page=0",
        "parentId=x",
        "colour=red",
      ])
        expect(
          (
            await call(listUnitsRoute, "GET", `/api/v1/org-units?${query}`, {
              as: owner,
            })
          ).status,
          query,
        ).toBe(400);
      expect(await state()).toEqual(before);
    });

    it("pages one chart level by name then id", async () => {
      const parent = await unit(owner, "Fictional Paging Parent", "PG", 0);
      for (const [index, name] of ["Charlie", "Alpha", "Bravo"].entries())
        await unit(owner, `Fictional ${name}`, `PG-${index}`, 1, parent.id);
      const first = await listOrgUnits(owner, {
        parentId: parent.id,
        pageSize: 2,
      });
      expect(first.data.map((u) => u.name)).toEqual([
        "Fictional Alpha",
        "Fictional Bravo",
      ]);
      expect(first.pagination).toEqual({ page: 1, pageSize: 2, hasMore: true });
      const second = await listOrgUnits(owner, {
        parentId: parent.id,
        pageSize: 2,
        page: 2,
      });
      expect(second.data.map((u) => u.name)).toEqual(["Fictional Charlie"]);
      expect(second.pagination.hasMore).toBe(false);
    });
  });

  describe("level order and own-subtree moves", () => {
    let top: OrgUnit, middle: OrgUnit, lower: OrgUnit, leaf: OrgUnit;
    beforeAll(async () => {
      top = await unit(owner, "Fictional Order Top", "OR-0", 0);
      middle = await unit(owner, "Fictional Order Middle", "OR-1", 1, top.id);
      lower = await unit(owner, "Fictional Order Lower", "OR-2", 2, middle.id);
      leaf = await unit(owner, "Fictional Order Leaf", "OR-3", 3, lower.id);
    });

    it("refuses a unit at or above its parent's level, created or moved, with 409 and RQ008", async () => {
      await refusedApi(
        () => unit(owner, "Denied", "OR-X", 1, middle.id),
        409,
        "org_level_order",
      );
      await refusedApi(
        () => unit(owner, "Denied", "OR-X", 0, middle.id),
        409,
        "org_level_order",
      );
      expect(
        (
          await call(createUnitRoute, "POST", "/api/v1/org-units", {
            as: owner,
            body: {
              name: "Denied",
              code: "OR-X",
              levelId: levels[1].id,
              parentId: lower.id,
            },
          })
        ).body.error.code,
      ).toBe("org_level_order");
      const other = await unit(
        owner,
        "Fictional Order Other",
        "OR-4",
        2,
        top.id,
      );
      await refusedApi(
        () => moveOrgUnit(owner, lower.id, { parentId: other.id }),
        409,
        "org_level_order",
      );
      await refusedApi(
        () => moveOrgUnit(owner, middle.id, { parentId: leaf.id }),
        409,
        "org_cycle",
      );
      expect(
        (
          await call(patchUnitRoute, "PATCH", `/api/v1/org-units/${other.id}`, {
            as: owner,
            id: other.id,
            body: { parentId: lower.id },
          })
        ).body.error.code,
      ).toBe("org_level_order");
      await refused(
        () =>
          sqlAs(
            owner,
            `INSERT INTO app.org_units(workspace_id, parent_id, level_id, name, code) VALUES ('${COMPANY}', '${lower.id}', '${levels[2].id}', 'Denied', 'OR-X')`,
          ),
        "RQ008",
      );
      await refused(
        () =>
          sqlAs(
            owner,
            `UPDATE app.org_units SET parent_id = '${other.id}' WHERE id = '${lower.id}'`,
          ),
        "RQ008",
      );
    });

    it("refuses a move under the unit itself or any unit below it, with 409 and RQ009", async () => {
      for (const target of [middle, lower, leaf]) {
        await refusedApi(
          () => moveOrgUnit(owner, middle.id, { parentId: target.id }),
          409,
          "org_cycle",
        );
        await refused(
          () =>
            sqlAs(
              owner,
              `UPDATE app.org_units SET parent_id = '${target.id}' WHERE id = '${middle.id}'`,
            ),
          "RQ009",
        );
      }
      expect(
        (
          await call(patchUnitRoute, "PATCH", `/api/v1/org-units/${top.id}`, {
            as: owner,
            id: top.id,
            body: { parentId: leaf.id },
          })
        ).body.error.code,
      ).toBe("org_cycle");
      await expectClosure();
    });

    it("refuses a unit under an archived parent and archiving a unit with a current child", async () => {
      await refusedApi(
        () => archiveOrgUnit(owner, lower.id),
        409,
        "org_state_conflict",
      );
      await archiveOrgUnit(owner, leaf.id);
      await refusedApi(
        () => unit(owner, "Denied", "OR-X", 4, leaf.id),
        409,
        "org_state_conflict",
      );
      await refusedApi(
        () => moveOrgUnit(owner, leaf.id, { parentId: middle.id }),
        409,
        "org_state_conflict",
      );
      const spare = await unit(owner, "Fictional Order Spare", "OR-5", 4);
      await refusedApi(
        () => moveOrgUnit(owner, spare.id, { parentId: leaf.id }),
        409,
        "org_state_conflict",
      );
      await refused(
        () =>
          sqlAs(
            owner,
            `UPDATE app.org_units SET archived_at = NULL WHERE id = '${leaf.id}'`,
          ),
        "42501",
      );
    });
  });

  describe("company authority", () => {
    let parentA: OrgUnit, parentB: OrgUnit, child: OrgUnit;
    beforeAll(async () => {
      parentA = await unit(owner, "Fictional Authority A", "AU-A", 0);
      parentB = await unit(owner, "Fictional Authority B", "AU-B", 0);
      child = await unit(
        owner,
        "Fictional Authority Child",
        "AU-C",
        1,
        parentA.id,
      );
    });

    it("lets a company admin with the organisation area create and rename levels and units and archive an unused level", async () => {
      const level = await audited(async () => {
        const created = await call(
          createLevelRoute,
          "POST",
          "/api/v1/org-units/levels",
          {
            as: orgAdmin,
            body: { name: "Fictional Admin Level", depth: 7 },
          },
        );
        expect(created.status).toBe(201);
        const id = created.body.data.id as string;
        expect(
          (
            await call(
              patchLevelRoute,
              "PATCH",
              `/api/v1/org-units/levels/${id}`,
              {
                as: orgAdmin,
                id,
                body: { name: "Fictional Admin Level Renamed" },
              },
            )
          ).status,
        ).toBe(200);
        expect((await archiveOrgLevel(orgAdmin, id)).archivedAt).toEqual(
          expect.any(String),
        );
      });
      const units = await audited(async () => {
        const created = await call(
          createUnitRoute,
          "POST",
          "/api/v1/org-units",
          {
            as: orgAdmin,
            body: {
              name: "Fictional Admin Unit",
              code: "AU-D",
              levelId: levels[1].id,
              parentId: parentB.id,
            },
          },
        );
        expect(created.status).toBe(201);
        await renameOrgUnit(orgAdmin, created.body.data.id, {
          name: "Fictional Admin Unit Renamed",
        });
      });
      expect(
        [...level, ...units].map((row) => [
          row.action,
          row.team_id,
          row.actor_id,
        ]),
      ).toEqual([
        ["org.level_created", "org-team-b", "org-admin"],
        ["org.level_renamed", "org-team-b", "org-admin"],
        ["org.level_archived", "org-team-b", "org-admin"],
        ["org.unit_created", "org-team-b", "org-admin"],
        ["org.unit_renamed", "org-team-b", "org-admin"],
      ]);
    });

    it("refuses a company admin every move and archive of a unit, by service, route and direct SQL", async () => {
      await refusedApi(
        () => moveOrgUnit(orgAdmin, child.id, { parentId: parentB.id }),
        403,
        "org_owner_required",
      );
      await refusedApi(
        () => archiveOrgUnit(orgAdmin, child.id),
        403,
        "org_owner_required",
      );
      for (const body of [
        { parentId: parentB.id },
        { parentId: null },
        { archived: true },
      ]) {
        const response = await call(
          patchUnitRoute,
          "PATCH",
          `/api/v1/org-units/${child.id}`,
          {
            as: orgAdmin,
            id: child.id,
            body,
          },
        );
        expect([response.status, response.body.error.code]).toEqual([
          403,
          "org_owner_required",
        ]);
      }
      for (const statement of [
        `UPDATE app.org_units SET parent_id = '${parentB.id}' WHERE id = '${child.id}'`,
        `UPDATE app.org_units SET parent_id = NULL WHERE id = '${child.id}'`,
        `UPDATE app.org_units SET archived_at = now() WHERE id = '${child.id}'`,
        `UPDATE app.org_units SET level_id = '${levels[2].id}' WHERE id = '${child.id}'`,
        `UPDATE app.org_units SET code = 'AU-Z' WHERE id = '${child.id}'`,
        `UPDATE app.org_units SET valid_to = now() WHERE id = '${child.id}'`,
        `UPDATE app.org_levels SET depth = 7 WHERE id = '${levels[5].id}'`,
        `INSERT INTO app.org_units(workspace_id, level_id, name, code, archived_at) VALUES ('${COMPANY}', '${levels[0].id}', 'Denied', 'AU-Y', now())`,
        `INSERT INTO app.org_units(workspace_id, level_id, name, code, valid_to) VALUES ('${COMPANY}', '${levels[0].id}', 'Denied', 'AU-Y', now())`,
      ])
        await refused(() => sqlAs(orgAdmin, statement), "42501");
      // The same code under another parent is an effective-dated move, once the owner archived it.
      const original = await unit(
        owner,
        "Fictional Effective Unit",
        "AU-E",
        1,
        parentA.id,
      );
      await archiveOrgUnit(owner, original.id);
      await refused(
        () =>
          sqlAs(
            orgAdmin,
            `INSERT INTO app.org_units(workspace_id, parent_id, level_id, name, code) VALUES ('${COMPANY}', '${parentB.id}', '${levels[1].id}', 'Fictional Effective Unit', 'AU-E')`,
          ),
        "42501",
      );
      await refusedApi(
        () => unit(orgAdmin, "Fictional Effective Unit", "AU-E", 1, parentB.id),
        403,
        "org_forbidden",
      );
      // Positive control: under the same parent the code is the admin's to reuse.
      const again = await audited(() =>
        unit(orgAdmin, "Fictional Effective Unit", "AU-E", 1, parentA.id),
      );
      expect(again.map((row) => row.action)).toEqual(["org.unit_created"]);
    });

    it("keeps valid_from server-set for runtime inserts, so a planted date cannot hide a re-parent", async () => {
      const parentC = await unit(owner, "Fictional Authority C", "AU-C3", 0);
      const insertAs = (p: Principal, parent: string, validFrom?: string) =>
        sqlAs(
          p,
          `INSERT INTO app.org_units(workspace_id, parent_id, level_id, name, code${validFrom ? ", valid_from" : ""}) VALUES ('${COMPANY}', '${parent}', '${levels[1].id}', 'Fictional Dated Unit', 'AU-V'${validFrom ? `, '${validFrom}'` : ""}) RETURNING id`,
        ) as Promise<{ id: string }[]>;
      // The latest row for the code is an archived one under parent B.
      const first = await unit(
        owner,
        "Fictional Dated Unit",
        "AU-V",
        1,
        parentB.id,
      );
      await archiveOrgUnit(owner, first.id);
      // (a) A runtime insert with its own valid_from, past or future, is refused for anyone.
      for (const p of [orgAdmin, owner])
        for (const date of ["2999-01-01T00:00:00Z", "2000-01-01T00:00:00Z"])
          await refused(() => insertAs(p, parentB.id, date), "42501");
      // The default is allowed under the same parent, and the row gets the time it was written.
      const before = (await look<{ now: Date }>("SELECT now() AS now"))[0].now;
      const [planted] = await insertAs(orgAdmin, parentB.id);
      const stored = (
        await look<{ valid_from: Date }>(
          "SELECT valid_from FROM app.org_units WHERE id = $1",
          [planted.id],
        )
      )[0].valid_from;
      expect(stored.getTime()).toBeGreaterThanOrEqual(before.getTime());
      // (b) The owner archives it and gives the code a new parent through an effective-dated row.
      await archiveOrgUnit(owner, planted.id);
      const moved = await audited(() =>
        unit(owner, "Fictional Dated Unit", "AU-V", 1, parentC.id),
      );
      expect(moved.map((row) => row.action).sort()).toEqual([
        "org.unit_created",
        "scope.home_units_changed",
      ]);
      await archiveOrgUnit(owner, moved[0].metadata.unitId as string);
      // (c) Back under parent B is a re-parent again, which only a company owner may make.
      await refused(() => insertAs(orgAdmin, parentB.id), "42501");
      await refusedApi(
        () => unit(orgAdmin, "Fictional Dated Unit", "AU-V", 1, parentB.id),
        403,
        "org_forbidden",
      );
    });

    it("lets a company owner move and archive through the service and by direct SQL, each with one scope row", async () => {
      const scopeRow = (unitId: string) => ({
        kind: "scope",
        action: "scope.home_units_changed",
        team_id: "org-team-a",
        actor_id: "org-owner",
        actor_type: "session",
        token_id: null,
        record_id: null,
        metadata: { workspaceId: COMPANY, unitId, affectedUserIds: [] },
      });
      const sorted = (rows: Audit[]) =>
        [...rows].sort((a, b) => a.kind.localeCompare(b.kind));
      const moved = await audited(() =>
        moveOrgUnit(owner, child.id, { parentId: parentB.id }),
      );
      expect(sorted(moved)).toEqual([
        expect.objectContaining({ action: "org.unit_moved" }),
        expect.objectContaining(scopeRow(child.id)),
      ]);
      const back = await audited(() =>
        sqlAs(
          owner,
          `UPDATE app.org_units SET parent_id = '${parentA.id}' WHERE id = '${child.id}'`,
        ),
      );
      expect(sorted(back)).toEqual([
        expect.objectContaining({
          action: "org.unit_moved",
          metadata: {
            workspaceId: COMPANY,
            unitId: child.id,
            levelId: levels[1].id,
            fromParentId: parentB.id,
            toParentId: parentA.id,
          },
        }),
        expect.objectContaining(scopeRow(child.id)),
      ]);
      expect((await unitRow(child.id)).parent_id).toBe(parentA.id);
      const spare = await unit(
        owner,
        "Fictional Owner Spare",
        "AU-S",
        1,
        parentA.id,
      );
      const archived = await audited(() => archiveOrgUnit(owner, spare.id));
      expect(sorted(archived)).toEqual([
        expect.objectContaining({ action: "org.unit_archived" }),
        expect.objectContaining(scopeRow(spare.id)),
      ]);
      const sqlArchived = await audited(() =>
        sqlAs(
          owner,
          `UPDATE app.org_units SET archived_at = now() WHERE id = '${child.id}'`,
        ),
      );
      expect(sorted(sqlArchived)).toEqual([
        expect.objectContaining({ action: "org.unit_archived" }),
        expect.objectContaining(scopeRow(child.id)),
      ]);
      await expectClosure();
    });

    it("refuses every org write by team roles, a fields-only company admin and owner tokens", async () => {
      const target = await unit(
        owner,
        "Fictional Denial Target",
        "AU-T",
        1,
        parentA.id,
      );
      for (const p of [
        teamOwnerB,
        teamAdminA,
        fieldsAdmin,
        recruiter,
        ownerToken,
        ownerOauth,
      ]) {
        for (const write of [
          () => createOrgLevel(p, { name: "Denied", depth: 6 }),
          () => renameOrgLevel(p, levels[1].id, { name: "Denied" }),
          () => archiveOrgLevel(p, levels[5].id),
          () => unit(p, "Denied", "AU-DENIED", 1, parentA.id),
          () => renameOrgUnit(p, target.id, { name: "Denied" }),
          () => moveOrgUnit(p, target.id, { parentId: parentB.id }),
          () => archiveOrgUnit(p, target.id),
        ])
          await refusedApi(write, 403, "org_forbidden");
        for (const statement of [
          `INSERT INTO app.org_levels(workspace_id, name, depth) VALUES ('${COMPANY}', 'Denied', 6)`,
          `INSERT INTO app.org_units(workspace_id, parent_id, level_id, name, code) VALUES ('${COMPANY}', '${parentA.id}', '${levels[1].id}', 'Denied', 'AU-DENIED')`,
          `UPDATE app.org_levels SET name = 'Denied' WHERE id = '${levels[1].id}'`,
          `UPDATE app.org_levels SET archived_at = now() WHERE id = '${levels[5].id}'`,
          `UPDATE app.org_units SET name = 'Denied' WHERE id = '${target.id}'`,
          `UPDATE app.org_units SET parent_id = '${parentB.id}' WHERE id = '${target.id}'`,
          `UPDATE app.org_units SET archived_at = now() WHERE id = '${target.id}'`,
        ])
          await refused(() => sqlAs(p, statement), "42501");
      }
      // Every reading context still reads the rows, a token context included.
      for (const p of [teamOwnerB, recruiter, ownerToken, ownerOauth])
        expect(
          await sqlAs(
            p,
            `SELECT id FROM app.org_units WHERE id = '${target.id}'`,
          ),
          p.userId,
        ).toEqual([{ id: target.id }]);
    });
  });

  describe("audit", () => {
    it("writes exactly one metadata-only org row per accepted change, to the acting team", async () => {
      const name = "Fictional Secret Audit Unit";
      const code = "SECRET-AUDIT-CODE";
      let unitId = "";
      const created = await audited(async () => {
        unitId = (await unit(owner, name, code, 4)).id;
      });
      const parent = await unit(owner, "Fictional Audit Parent", "AUD-P", 3);
      const renamed = await audited(() =>
        renameOrgUnit(owner, unitId, { name: `${name} Renamed` }),
      );
      const moved = await audited(() =>
        moveOrgUnit(owner, unitId, { parentId: parent.id }),
      );
      const archived = await audited(() => archiveOrgUnit(owner, unitId));
      const orgRows = [created, renamed, moved, archived].map((rows) => {
        const org = rows.filter((row) => row.kind === "org");
        expect(org).toHaveLength(1);
        return org[0];
      });
      expect(orgRows.map((row) => [row.action, row.summary])).toEqual([
        ["org.unit_created", "Created an organisation unit"],
        ["org.unit_renamed", "Renamed an organisation unit"],
        ["org.unit_moved", "Moved an organisation unit"],
        ["org.unit_archived", "Archived an organisation unit"],
      ]);
      expect(orgRows.map((row) => row.metadata)).toEqual([
        {
          workspaceId: COMPANY,
          unitId,
          levelId: levels[4].id,
          fromParentId: null,
          toParentId: null,
        },
        {
          workspaceId: COMPANY,
          unitId,
          levelId: levels[4].id,
          fromParentId: null,
          toParentId: null,
        },
        {
          workspaceId: COMPANY,
          unitId,
          levelId: levels[4].id,
          fromParentId: null,
          toParentId: parent.id,
        },
        {
          workspaceId: COMPANY,
          unitId,
          levelId: levels[4].id,
          fromParentId: parent.id,
          toParentId: parent.id,
        },
      ]);
      const levelRows = await audited(() =>
        renameOrgLevel(owner, levels[4].id, { name: "Fictional level 4" }),
      );
      expect(levelRows).toEqual([]);
      const levelRenamed = await audited(() =>
        renameOrgLevel(owner, levels[4].id, { name: name }),
      );
      expect(levelRenamed.map((row) => [row.action, row.metadata])).toEqual([
        [
          "org.level_renamed",
          { workspaceId: COMPANY, levelId: levels[4].id, depth: 4 },
        ],
      ]);
      await renameOrgLevel(owner, levels[4].id, { name: "Fictional level 4" });
      for (const row of [...orgRows, ...levelRenamed]) {
        expect(Object.keys(row.metadata).sort()).toEqual(
          row.action.startsWith("org.level") ? LEVEL_KEYS : UNIT_KEYS,
        );
        expect(row).toMatchObject({
          team_id: "org-team-a",
          actor_id: "org-owner",
          actor_type: "session",
          token_id: null,
          record_id: null,
        });
        expect(JSON.stringify(row)).not.toContain(name);
        expect(JSON.stringify(row)).not.toContain(code);
      }
    });

    it("refuses a direct data-role insert of an org or scope activity row for every action", async () => {
      for (const [kind, action] of [
        ...ORG_ACTIONS.map((action) => ["org", action]),
        ["scope", "scope.home_units_changed"],
      ])
        await refused(
          () =>
            sqlAs(
              owner,
              `INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary,metadata) VALUES ('org-team-a','org-owner','session','${action}','${kind}','Forged','{}')`,
            ),
          "42501",
        );
    });

    it("writes no audit row for the owner's own SQL, which has no context", async () => {
      await harness.asOwner();
      const rows = await audited(async () => {
        await harness.asOwner();
        await harness.client.query(
          `INSERT INTO app.org_units(workspace_id, level_id, name, code) VALUES ('${COMPANY}', '${levels[0].id}', 'Fictional Owner SQL Unit', 'OWNER-SQL')`,
        );
      });
      expect(rows).toEqual([]);
      await expectClosure();
    });
  });

  describe("workspace isolation", () => {
    let otherLevel: string, otherUnit: string;
    beforeAll(async () => {
      // The owner writes the other workspace's rows directly, as the migration owner would.
      await harness.asOwner();
      otherLevel = (
        await harness.client.query<{ id: string }>(
          `INSERT INTO app.org_levels(workspace_id, name, depth) VALUES ('${OTHER}', 'Fictional Other Level', 0) RETURNING id`,
        )
      ).rows[0].id;
      otherUnit = (
        await harness.client.query<{ id: string }>(
          `INSERT INTO app.org_units(workspace_id, level_id, name, code) VALUES ('${OTHER}', '${otherLevel}', 'Fictional Other Unit', 'OTHER-1') RETURNING id`,
        )
      ).rows[0].id;
    });
    const visible = (p: Principal) =>
      asContext(p, async (tx) =>
        Object.fromEntries(
          await Promise.all(
            ["org_levels", "org_units", "org_unit_closure"].map(
              async (table) => [
                table,
                [
                  ...new Set(
                    (
                      await tx.execute<{ workspace_id: string }>(
                        sql.raw(`SELECT workspace_id FROM app.${table}`),
                      )
                    ).rows.map((row) => row.workspace_id),
                  ),
                ],
              ],
            ),
          ),
        ),
      );

    it("keeps each workspace's levels, units and closure from the other workspace's contexts", async () => {
      const company = {
        org_levels: [COMPANY],
        org_units: [COMPANY],
        org_unit_closure: [COMPANY],
      };
      const other = {
        org_levels: [OTHER],
        org_units: [OTHER],
        org_unit_closure: [OTHER],
      };
      expect(await visible(ownerX)).toEqual(other);
      for (const p of [owner, ownerToken, teamOwnerB])
        expect(await visible(p)).toEqual(company);
      expect((await listOrgLevels(ownerX)).map((l) => l.id)).toEqual([
        otherLevel,
      ]);
      expect((await listOrgUnits(ownerX)).data.map((u) => u.id)).toEqual([
        otherUnit,
      ]);
      expect((await listOrgUnits(owner)).data.map((u) => u.id)).not.toContain(
        otherUnit,
      );
      await refusedApi(
        () => listOrgUnits(owner, { parentId: otherUnit }),
        404,
        "not_found",
      );
      await refusedApi(
        () => renameOrgUnit(owner, otherUnit, { name: "Denied" }),
        404,
        "not_found",
      );
      await refusedApi(
        () => renameOrgLevel(ownerX, levels[0].id, { name: "Denied" }),
        404,
        "not_found",
      );
      expect(
        await sqlAs(
          owner,
          `UPDATE app.org_units SET name = 'Denied' WHERE id = '${otherUnit}' RETURNING id`,
        ),
      ).toEqual([]);
      // Another workspace's level or parent, or a row in another workspace, is refused.
      const company0 = (await listOrgUnits(owner)).data[0].id;
      for (const [statement, code] of [
        [
          `INSERT INTO app.org_units(workspace_id, level_id, name, code) VALUES ('${OTHER}', '${levels[1].id}', 'Denied', 'X-1')`,
          "23503",
        ],
        [
          `INSERT INTO app.org_units(workspace_id, parent_id, level_id, name, code) VALUES ('${OTHER}', '${company0}', '${otherLevel}', 'Denied', 'X-2')`,
          "23503",
        ],
        [
          `INSERT INTO app.org_units(workspace_id, level_id, name, code) VALUES ('${COMPANY}', '${levels[1].id}', 'Denied', 'X-3')`,
          "42501",
        ],
        [
          `INSERT INTO app.org_levels(workspace_id, name, depth) VALUES ('${COMPANY}', 'Denied', 6)`,
          "42501",
        ],
      ])
        await refused(() => sqlAs(ownerX, statement), code);
      await refusedApi(
        () =>
          createOrgUnit(ownerX, {
            name: "Denied",
            code: "X-4",
            levelId: levels[1].id,
          }),
        404,
        "not_found",
      );
      await expectClosure(OTHER);
    });
  });

  describe("closure at scale", () => {
    // A fictional 500-unit tree on six levels, built by the data role under the owner's context.
    const COUNTS = [2, 8, 30, 80, 160, 220];
    const tree: string[][] = [];
    const subtree = async (id: string) =>
      Number(
        (
          await look<{ n: number }>(
            "SELECT count(*)::int AS n FROM app.org_unit_closure WHERE ancestor_id = $1",
            [id],
          )
        )[0].n,
      );

    it("builds the tree with a correct closure", async () => {
      for (const [depth, count] of COUNTS.entries()) {
        // Each unit's parent is the previous level's unit at its index modulo that level's size.
        const parents = depth === 0 ? [] : tree[depth - 1];
        const parent = parents.length
          ? sql`(${`{${parents.join(",")}}`}::uuid[])[1 + g % ${sql.raw(String(parents.length))}]`
          : sql`null::uuid`;
        const ids = await asContext(owner, async (tx) => {
          const { rows } = await tx.execute<{ id: string }>(sql`
            insert into app.org_units(workspace_id, parent_id, level_id, name, code)
            select ${COMPANY}::uuid, ${parent}, ${levels[depth].id}::uuid,
              ${`Fictional scale unit ${depth}-`} || g, ${`SCALE-${depth}-`} || g
            from generate_series(0, ${sql.raw(String(count - 1))}) g order by g returning id`);
          return rows.map((row) => row.id);
        });
        tree.push(ids);
      }
      expect(tree.flat()).toHaveLength(500);
      expect(
        await look(
          "SELECT l.depth, count(*)::int AS n FROM app.org_units u JOIN app.org_levels l ON l.id = u.level_id WHERE u.code LIKE 'SCALE-%' GROUP BY l.depth ORDER BY 1",
        ),
      ).toEqual(COUNTS.map((n, depth) => ({ depth, n })));
      expect(await expectClosure()).toBeGreaterThan(2000);
    });

    it("stays equal to the recomputation after creates, moves, renames and archives", async () => {
      const leafParent = tree[4][0];
      await unit(owner, "Fictional scale extra", "SCALE-EXTRA", 5, leafParent);
      await expectClosure();
      // A leaf move.
      const leaf = tree[5][0];
      await moveOrgUnit(owner, leaf, { parentId: tree[4][1] });
      await expectClosure();
      // A subtree of at least 50 units to another branch.
      const branch = tree[1][0];
      expect(await subtree(branch)).toBeGreaterThanOrEqual(50);
      const from = (await unitRow(branch)).parent_id;
      const to = tree[0].find((id) => id !== from)!;
      await moveOrgUnit(owner, branch, { parentId: to });
      expect((await unitRow(branch)).parent_id).toBe(to);
      await expectClosure();
      // A move to top level, and back under its old parent.
      const middle = tree[2][3];
      const middleParent = (await unitRow(middle)).parent_id;
      await moveOrgUnit(owner, middle, { parentId: null });
      await expectClosure();
      await moveOrgUnit(owner, middle, { parentId: middleParent });
      await expectClosure();
      // Renames and archives change no closure row.
      const before = await expectClosure();
      await renameOrgUnit(owner, tree[3][0], {
        name: "Fictional scale renamed",
      });
      await renameOrgLevel(owner, levels[3].id, {
        name: "Fictional level 3 renamed",
      });
      await archiveOrgUnit(owner, tree[5][10]);
      expect(await expectClosure()).toBe(before);
      // One chart level shows which children have units below them.
      const leaves = await listOrgUnits(owner, { parentId: tree[4][1] });
      expect(leaves.data.map((u) => u.id)).toContain(leaf);
      expect(
        leaves.data.every((u) => u.parentId === tree[4][1] && !u.hasChildren),
      ).toBe(true);
      expect(
        (await listOrgUnits(owner, { parentId: tree[1][0] })).data.every(
          (u) => u.hasChildren,
        ),
      ).toBe(true);
    });
  });
});

describe("one chart level in database round trips", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal;
  let parent: OrgUnit;

  beforeAll(async () => {
    fixture = await createTestDb();
    pools.data.mockImplementation(async () => fixture.db);
    pools.identity.mockImplementation(async () => fixture.db);
    owner = await seedIdentity(fixture.db, {
      userId: "org-budget-owner",
      teamId: "org-budget-team",
    });
    const top = await createOrgLevel(owner, {
      name: "Fictional Holdings",
      depth: 0,
    });
    const division = await createOrgLevel(owner, {
      name: "Sample Division",
      depth: 1,
    });
    const section = await createOrgLevel(owner, {
      name: "Fictional Section",
      depth: 2,
    });
    parent = await createOrgUnit(owner, {
      name: "Fictional Holdings",
      code: "FH",
      levelId: top.id,
    });
    for (const index of [1, 2, 3]) {
      const child = await createOrgUnit(owner, {
        name: `Sample Division ${index}`,
        code: `SD-${index}`,
        levelId: division.id,
        parentId: parent.id,
      });
      if (index === 1)
        await createOrgUnit(owner, {
          name: "Fictional Section 1",
          code: "FS-1",
          levelId: section.id,
          parentId: child.id,
        });
    }
  });
  afterAll(async () => fixture?.close());

  it("reads one page of a unit's current children in at most 6 round trips", async () => {
    const response = await call(
      listUnitsRoute,
      "GET",
      `/api/v1/org-units?parentId=${parent.id}`,
      {
        as: owner,
      },
    );
    expect(response.status).toBe(200);
    expect(
      (response.body.data as OrgUnit[]).map((u) => [u.code, u.hasChildren]),
    ).toEqual([
      ["SD-1", true],
      ["SD-2", false],
      ["SD-3", false],
    ]);
    expect(response.roundTrips).toBeLessThanOrEqual(6);
  });
});
