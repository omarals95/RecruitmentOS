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
import {
  DEADLINES_AND_SNAPSHOT_SQL,
  withDeadlinesAndSnapshot,
  type TransactionSnapshot,
} from "@/db/deadlines";
import { getVerifiedSession } from "@/lib/auth-session";
import {
  createEmployee,
  createPosition,
  linkEmployeeUser,
  listEmployees,
  listRetentionReview,
  setEmployeePositions,
  updateEmployee,
  archiveEmployee,
  type Employee,
} from "@/lib/directory";
import { eraseEmployee } from "@/lib/employee-erasure";
import { createOrgLevel, createOrgUnit } from "@/lib/org";
import type { Principal } from "@/lib/principal";
import { installTenantContext } from "@/lib/tenant-context";
import {
  GET as listEmployeesRoute,
  POST as createEmployeeRoute,
} from "@/app/api/v1/employees/route";
import { PATCH as patchEmployeeRoute } from "@/app/api/v1/employees/[id]/route";
import { POST as erasureRoute } from "@/app/api/v1/employees/[id]/erasure/route";
import { GET as retentionReviewRoute } from "@/app/api/v1/employees/retention-review/route";
import {
  createSplitRoleDb,
  seedApiToken,
  seedIdentity,
  splitRoles,
} from "./helpers/db";

// Fictional data only: one company workspace with four fictional teams, and a second fictional
// workspace inserted by the owner for the isolation case (R2a-15, 0036).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000002";
const ORIGIN = "http://localhost:3000";
const ERASED_SUMMARY = "Details removed by employee erasure";
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Row = Record<string, unknown>;
type Activity = {
  id: string;
  team_id: string;
  actor_id: string;
  actor_type: string;
  token_id: string | null;
  record_id: string | null;
  erasure_id: string | null;
  employee_erasure_id: string | null;
  action: string;
  kind: string;
  summary: string;
  metadata: Record<string, unknown>;
  created_at: Date;
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
  options: {
    as?: Principal;
    body?: unknown;
    id?: string;
    bearer?: boolean;
    key?: string;
  },
) {
  if (options.as) signIn(options.as);
  const response = await handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(options.as ? { "x-team-id": options.as.teamId } : {}),
        ...(options.bearer
          ? { authorization: "Bearer fictional-erasure-token" }
          : {}),
        ...(options.key ? { "idempotency-key": options.key } : {}),
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    { params: Promise.resolve({ id: options.id ?? "" }) },
  );
  return {
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: (await response.json()) as any,
  };
}

/** Thrown to roll a probe transaction back after its statement ran. */
class RolledBack extends Error {
  constructor(readonly rows: Row[]) {
    super("rolled back");
  }
}

describe("employee erasure and retention under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, ownerB: Principal, ownerViewer: Principal;
  let orgAdmin: Principal, plainAdmin: Principal, teamOwnerC: Principal;
  let teamAdminA: Principal, recruiter: Principal;
  let ownerToken: Principal, ownerOauth: Principal, ownerX: Principal;
  let people: string[];
  let unitA: string, deskA: string, deskB: string, jobRole: string;
  let otherEmployee: Employee;

  /** Raw reads as the PGlite superuser, which bypasses RLS; only to inspect outcomes. */
  const look = async <T = Row>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  const activity = () =>
    look<Activity>("SELECT * FROM app.activity ORDER BY created_at, id");
  /** Every row the erasure could touch, in both workspaces. */
  const world = async () => ({
    employees: await look("SELECT * FROM app.employees ORDER BY id"),
    held: await look(
      "SELECT * FROM app.employee_positions ORDER BY employee_id, position_id, valid_from",
    ),
    erasures: await look("SELECT * FROM app.employee_erasures ORDER BY id"),
    activity: await activity(),
    idempotency: await look(
      "SELECT * FROM app.idempotency ORDER BY team_id, actor_key, operation, key",
    ),
    positions: await look("SELECT * FROM app.positions ORDER BY id"),
    units: await look("SELECT * FROM app.org_units ORDER BY id"),
    levels: await look("SELECT * FROM app.org_levels ORDER BY id"),
    records: await look("SELECT * FROM app.records ORDER BY id"),
    states: await look(
      "SELECT * FROM app.candidate_states ORDER BY team_id, user_id, candidate_id",
    ),
    workspaces: await look("SELECT * FROM app.workspaces ORDER BY id"),
    teams: await look("SELECT * FROM app.workspace_teams ORDER BY team_id"),
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
      return rows as Row[];
    });
  const eraseSql = (principal: Principal, id: string, name: string) =>
    sqlAs(
      principal,
      `SELECT tenant_context.erase_employee('${id}', '${name.replaceAll("'", "''")}', 'app') AS result`,
    ).then((rows) => rows[0].result as Row | null);
  /** Runs the call and expects one SQLSTATE, with no row changed anywhere. */
  async function refused(call: () => Promise<unknown>, code: string) {
    const before = await world();
    await expect(call()).rejects.toMatchObject({ cause: { code } });
    expect(await world()).toEqual(before);
  }
  /** Runs the call and expects one API error, with no row changed anywhere. */
  async function refusedApi(
    call: () => Promise<unknown>,
    status: number,
    code: string,
  ) {
    const before = await world();
    await expect(call()).rejects.toMatchObject({ status, code });
    expect(await world()).toEqual(before);
  }
  let serial = 0;
  /** A fictional employee with every personal field set, created by the given principal. */
  const employee = (p: Principal, extra: Record<string, unknown> = {}) => {
    serial += 1;
    return createEmployee(p, {
      displayName: `Fictional Erasable ${serial}`,
      employeeNumber: `EE-${serial}`,
      workEmail: `erasable.${serial}@example.test`,
      workPhone: `+971 50 000 ${String(serial).padStart(4, "0")}`,
      ...extra,
    });
  };
  /** The activity rows naming the employee, as the directory trigger wrote them. */
  const about = async (id: string) =>
    (await activity()).filter((row) => row.metadata.employeeId === id);

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, { userId: "ee-owner", teamId: "ee-team-a" });
    ownerB = await seedIdentity(db, {
      userId: "ee-owner",
      teamId: "ee-team-b",
    });
    // The same company owner, as a viewer of a third team: no directory:read there.
    ownerViewer = await seedIdentity(db, {
      userId: "ee-owner",
      teamId: "ee-team-d",
      role: "viewer",
    });
    orgAdmin = await seedIdentity(db, {
      userId: "ee-org-admin",
      teamId: "ee-team-b",
      role: "admin",
    });
    plainAdmin = await seedIdentity(db, {
      userId: "ee-plain-admin",
      teamId: "ee-team-b",
      role: "admin",
    });
    teamOwnerC = await seedIdentity(db, {
      userId: "ee-owner-c",
      teamId: "ee-team-c",
    });
    // A team admin without company authority: the admin template holds directory:write.
    teamAdminA = await seedIdentity(db, {
      userId: "ee-team-admin",
      teamId: "ee-team-a",
      role: "admin",
    });
    recruiter = await seedIdentity(db, {
      userId: "ee-recruiter",
      teamId: "ee-team-a",
      role: "recruiter",
    });
    ownerX = await seedIdentity(db, {
      userId: "ee-owner-x",
      teamId: "ee-team-x",
    });
    people = [];
    for (const index of [1, 2, 3, 4])
      people.push(
        (
          await seedIdentity(db, {
            userId: `ee-person-${index}`,
            teamId: "ee-team-a",
            role: "viewer",
          })
        ).userId,
      );
    // Owner tokens holding every scope, which the app never issues for the directory.
    ownerToken = await seedApiToken(db, owner);
    ownerOauth = {
      ...(await seedApiToken(db, owner)),
      oauthClientId: "fictional-oauth-client",
    };
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','ee-org-admin','admin','{organisation}'),
        ('${COMPANY}','ee-plain-admin','admin','{}');
      INSERT INTO app.workspaces(id,name) VALUES ('${OTHER}','Fictional Other Company');
      UPDATE app.workspace_teams SET workspace_id = '${OTHER}' WHERE team_id = 'ee-team-x';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level) VALUES ('${OTHER}','ee-owner-x','owner');
    `);
    const level = await createOrgLevel(owner, {
      name: "Fictional erasure level",
      depth: 0,
    });
    unitA = (
      await createOrgUnit(owner, {
        name: "Fictional Erasure Holdings",
        code: "EE-UNIT",
        levelId: level.id,
      })
    ).id;
    // A job role and a candidate of team A, which no erasure may touch.
    [{ id: jobRole }] = (await sqlAs(
      owner,
      `INSERT INTO app.records(team_id,kind,data,created_by) VALUES ('ee-team-a','job-role','{"title":"Fictional Erasure Role"}','ee-owner') RETURNING id::text AS id`,
    )) as { id: string }[];
    await sqlAs(
      owner,
      `INSERT INTO app.records(team_id,kind,data,created_by) VALUES ('ee-team-a','candidate','{"name":"Fictional Kept Candidate"}','ee-owner')`,
    );
    deskA = (
      await createPosition(owner, {
        title: "Fictional Desk A",
        code: "EE-DESK-A",
        orgUnitId: unitA,
        jobRoleId: jobRole,
      })
    ).id;
    deskB = (
      await createPosition(owner, {
        title: "Fictional Desk B",
        code: "EE-DESK-B",
        orgUnitId: unitA,
      })
    ).id;
    // The other workspace's own unit, position and employee, written by its company owner.
    const otherLevel = await createOrgLevel(ownerX, {
      name: "Fictional other level",
      depth: 0,
    });
    const otherUnit = await createOrgUnit(ownerX, {
      name: "Fictional Other Holdings",
      code: "EE-OTHER",
      levelId: otherLevel.id,
    });
    const otherDesk = await createPosition(ownerX, {
      title: "Fictional Other Desk",
      code: "EE-OTHER-DESK",
      orgUnitId: otherUnit.id,
    });
    otherEmployee = await employee(ownerX);
    await setEmployeePositions(ownerX, otherEmployee.id, {
      positions: [{ positionId: otherDesk.id, primary: true }],
    });
  });
  afterAll(async () => harness?.close());

  it("keeps the tombstone owner-only under FORCE RLS, with no name, email, phone or number column", async () => {
    expect(
      await look(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'app.employee_erasures'::regclass",
      ),
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    expect(
      (
        await look<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'employee_erasures' ORDER BY ordinal_position",
        )
      ).map((row) => row.column_name),
    ).toEqual([
      "id",
      "workspace_id",
      "employee_id",
      "erased_by",
      "erased_at",
      "erasure_source",
    ]);
    for (const role of [splitRoles.data, splitRoles.identity, "public"])
      expect(
        await look(
          "SELECT has_table_privilege($1, 'app.employee_erasures', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS any",
          [role],
        ),
        role,
      ).toEqual([{ any: false }]);
  });

  describe("erasure by a company owner", () => {
    let linked: Employee;
    let neighbour: Employee;
    let first: { status: number; body: { data: Row } };
    let before: Awaited<ReturnType<typeof world>>;
    let earlier: Activity[];

    beforeAll(async () => {
      linked = await employee(owner);
      await linkEmployeeUser(owner, linked.id, { userId: people[0] });
      // Two position rows: the ended desk A and the current desk B.
      await setEmployeePositions(owner, linked.id, {
        positions: [{ positionId: deskA, primary: true }],
      });
      await setEmployeePositions(owner, linked.id, {
        positions: [{ positionId: deskB, primary: true }],
      });
      // A change made in team B, so rows about the employee sit in two teams of the workspace.
      await updateEmployee(ownerB, linked.id, { retentionClass: "extended" });
      neighbour = await employee(owner);
      await linkEmployeeUser(owner, neighbour.id, { userId: people[1] });
      await setEmployeePositions(owner, neighbour.id, {
        positions: [{ positionId: deskA, primary: true }],
      });
      before = await world();
      earlier = await about(linked.id);
      first = await call(
        erasureRoute as Handler,
        "POST",
        `/api/v1/employees/${linked.id}/erasure`,
        {
          as: owner,
          id: linked.id,
          key: "ee-erase-linked",
          body: { confirmName: `  ${linked.displayName} ` },
        },
      );
    });

    it("answers with the tombstone and counts only", () => {
      expect(first.status).toBe(200);
      expect(first.body.data).toEqual({
        erasureId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        alreadyErased: false,
        erasedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
        removed: {
          positionRows: 2,
          activityRedacted: earlier.length,
          userLinks: 1,
        },
      });
      expect(earlier.map((row) => row.team_id)).toEqual(
        expect.arrayContaining(["ee-team-a", "ee-team-b"]),
      );
    });

    it("deletes the employee and position history, and writes one scope row for the unlinked user", async () => {
      const erasureId = first.body.data.erasureId as string;
      expect(
        await look("SELECT 1 FROM app.employees WHERE id = $1", [linked.id]),
      ).toEqual([]);
      expect(
        await look(
          "SELECT 1 FROM app.employee_positions WHERE employee_id = $1",
          [linked.id],
        ),
      ).toEqual([]);
      const known = new Set(before.activity.map((row) => (row as Activity).id));
      const added = (await activity()).filter((row) => !known.has(row.id));
      expect(added.map((row) => row.action)).toEqual([
        "scope.home_units_changed",
        "employee.erased",
      ]);
      const [scope, erased] = added;
      expect(scope).toMatchObject({
        team_id: "ee-team-a",
        actor_id: "ee-owner",
        actor_type: "session",
        token_id: null,
        record_id: null,
        employee_erasure_id: null,
        kind: "scope",
        summary: "Changed the employee facts that set home units",
        metadata: { workspaceId: COMPANY, affectedUserIds: [people[0]] },
      });
      expect(Object.keys(scope.metadata).sort()).toEqual([
        "affectedUserIds",
        "workspaceId",
      ]);
      expect(erased).toMatchObject({
        team_id: "ee-team-a",
        actor_id: "ee-owner",
        actor_type: "session",
        token_id: null,
        record_id: null,
        erasure_id: null,
        employee_erasure_id: erasureId,
        kind: "employee-erasure",
        summary: "Permanently erased an employee",
        metadata: {
          source: "app",
          workspaceId: COMPANY,
          positionRows: 2,
          activityRedacted: earlier.length,
          userLinks: 1,
        },
      });
      expect(Object.keys(erased.metadata).sort()).toEqual([
        "activityRedacted",
        "positionRows",
        "source",
        "userLinks",
        "workspaceId",
      ]);
    });

    it("redacts every earlier row about the employee, in both teams, to type, time and actor", async () => {
      const erasureId = first.body.data.erasureId as string;
      const now = new Map(
        (await activity()).map((row) => [row.id, row] as const),
      );
      expect(earlier.length).toBeGreaterThan(4);
      for (const row of earlier)
        expect(now.get(row.id), row.action).toEqual({
          ...row,
          summary: ERASED_SUMMARY,
          metadata: {},
          employee_erasure_id: erasureId,
        });
    });

    it("writes one tombstone with ids, owner, time and source only", async () => {
      expect(
        await look(
          "SELECT * FROM app.employee_erasures WHERE employee_id = $1",
          [linked.id],
        ),
      ).toEqual([
        {
          id: first.body.data.erasureId,
          workspace_id: COMPANY,
          employee_id: linked.id,
          erased_by: "ee-owner",
          erased_at: new Date(first.body.data.erasedAt as string),
          erasure_source: "app",
        },
      ]);
    });

    it("leaves no name, email, phone or employee number in activity, idempotency or the tombstone", async () => {
      const texts = [
        ...(await look<{ text: string }>(
          "SELECT row_to_json(a)::text AS text FROM app.activity a",
        )),
        ...(await look<{ text: string }>(
          "SELECT row_to_json(i)::text AS text FROM app.idempotency i",
        )),
        ...(await look<{ text: string }>(
          "SELECT row_to_json(e)::text AS text FROM app.employee_erasures e",
        )),
      ].map((row) => row.text.toLowerCase());
      expect(texts.length).toBeGreaterThan(0);
      for (const value of [
        linked.displayName,
        linked.employeeNumber,
        linked.workEmail as string,
        linked.workPhone as string,
      ])
        for (const text of texts)
          expect(text).not.toContain(value.toLowerCase());
    });

    it("leaves other employees, positions, units, levels, records and the other workspace untouched", async () => {
      const after = await world();
      const others = <T extends Row>(rows: T[], key: keyof T) =>
        rows.filter((row) => row[key] !== linked.id);
      expect(others(after.employees, "id")).toEqual(
        others(before.employees, "id"),
      );
      expect(others(after.held, "employee_id")).toEqual(
        others(before.held, "employee_id"),
      );
      for (const table of [
        "positions",
        "units",
        "levels",
        "records",
        "states",
        "workspaces",
        "teams",
      ] as const)
        expect(after[table], table).toEqual(before[table]);
      expect(after.records.length).toBe(2);
      expect(
        after.employees.filter((row) => row.workspace_id === OTHER),
      ).toEqual([expect.objectContaining({ id: otherEmployee.id })]);
      // Rows not about the employee keep every value.
      const untouched = new Set(earlier.map((row) => row.id));
      const kept = (rows: Row[]) =>
        rows.filter((row) => !untouched.has(row.id as string));
      expect(
        kept(after.activity).slice(0, kept(before.activity).length),
      ).toEqual(kept(before.activity));
      expect(
        (await listEmployees(owner, { search: neighbour.displayName })).data,
      ).toHaveLength(1);
    });

    it("returns the earlier erasure on a retry by key, by a new key and by the helper, writing nothing", async () => {
      const settled = await world();
      const again = await call(
        erasureRoute as Handler,
        "POST",
        `/api/v1/employees/${linked.id}/erasure`,
        {
          as: owner,
          id: linked.id,
          key: "ee-erase-linked",
          body: { confirmName: linked.displayName },
        },
      );
      expect(again).toEqual(first);
      const repeated = await call(
        erasureRoute as Handler,
        "POST",
        `/api/v1/employees/${linked.id}/erasure`,
        {
          as: owner,
          id: linked.id,
          key: "ee-erase-linked-2",
          body: { confirmName: "Any name at all" },
        },
      );
      expect(repeated.status).toBe(200);
      expect(repeated.body.data).toEqual({
        ...first.body.data,
        alreadyErased: true,
      });
      const direct = await eraseSql(owner, linked.id, linked.displayName);
      expect({
        ...direct,
        erasedAt: new Date(direct!.erasedAt as string).toISOString(),
      }).toEqual({ ...first.body.data, alreadyErased: true });
      // The new key stores its response; nothing else changes.
      const after = await world();
      expect({ ...after, idempotency: [] }).toEqual({
        ...settled,
        idempotency: [],
      });
      expect(after.idempotency).toHaveLength(settled.idempotency.length + 1);
      expect(
        (
          await call(
            erasureRoute as Handler,
            "POST",
            `/api/v1/employees/${neighbour.id}/erasure`,
            {
              as: owner,
              id: neighbour.id,
              key: "ee-erase-linked",
              body: { confirmName: neighbour.displayName },
            },
          )
        ).body.error.code,
      ).toBe("idempotency_mismatch");
      expect(
        await look("SELECT 1 FROM app.employees WHERE id = $1", [neighbour.id]),
      ).toHaveLength(1);
      expect({ ...(await world()), idempotency: [] }).toEqual({
        ...settled,
        idempotency: [],
      });
    });
  });

  it("erases an unlinked employee through the service with no scope row", async () => {
    const unlinked = await employee(owner);
    await setEmployeePositions(owner, unlinked.id, {
      positions: [{ positionId: deskA, primary: false }],
    });
    const before = await activity();
    const result = await eraseEmployee(owner, unlinked.id, {
      confirmName: unlinked.displayName,
    });
    expect(result).toMatchObject({
      alreadyErased: false,
      removed: { positionRows: 1, activityRedacted: 2, userLinks: 0 },
    });
    const known = new Set(before.map((row) => row.id));
    expect(
      (await activity())
        .filter((row) => !known.has(row.id))
        .map((row) => row.action),
    ).toEqual(["employee.erased"]);
    expect(
      await eraseEmployee(owner, unlinked.id, { confirmName: "Anything" }),
    ).toEqual({ ...result, alreadyErased: true });
  });

  describe("refusals", () => {
    let target: Employee;
    beforeAll(async () => {
      target = await employee(owner);
      await linkEmployeeUser(owner, target.id, { userId: people[2] });
    });

    it("refuses company admins, team roles without company authority and directory:write members in the service and route", async () => {
      for (const p of [
        orgAdmin,
        plainAdmin,
        teamOwnerC,
        teamAdminA,
        recruiter,
      ]) {
        await refusedApi(
          () =>
            eraseEmployee(p, target.id, { confirmName: target.displayName }),
          403,
          "employee_erasure_forbidden",
        );
        // The authority check comes before the body is validated.
        await refusedApi(
          () => eraseEmployee(p, target.id, { wrong: true }),
          403,
          "employee_erasure_forbidden",
        );
        const response = await call(
          erasureRoute as Handler,
          "POST",
          `/api/v1/employees/${target.id}/erasure`,
          {
            as: p,
            id: target.id,
            body: { confirmName: target.displayName },
          },
        );
        expect([response.status, response.body.error.code]).toEqual([
          403,
          "employee_erasure_forbidden",
        ]);
      }
    });

    it("refuses owner API and MCP OAuth tokens in the service and Bearer requests in the route", async () => {
      for (const p of [ownerToken, ownerOauth])
        await refusedApi(
          () =>
            eraseEmployee(p, target.id, { confirmName: target.displayName }),
          403,
          "employee_erasure_forbidden",
        );
      const before = await world();
      const response = await call(
        erasureRoute as Handler,
        "POST",
        `/api/v1/employees/${target.id}/erasure`,
        {
          bearer: true,
          id: target.id,
          body: { confirmName: target.displayName },
        },
      );
      expect([response.status, response.body.error.code]).toEqual([
        403,
        "session_required",
      ]);
      expect(await world()).toEqual(before);
    });

    it("refuses every one of them by direct SQL of the helper", async () => {
      for (const p of [
        orgAdmin,
        plainAdmin,
        teamOwnerC,
        teamAdminA,
        recruiter,
        ownerToken,
        ownerOauth,
      ])
        await refused(
          () => eraseSql(p, target.id, target.displayName),
          "42501",
        );
    });

    it("refuses a company owner in a REPEATABLE READ or SERIALIZABLE transaction", async () => {
      for (const level of ["repeatable read", "serializable"] as const)
        await refused(
          () =>
            harness.dataDb().then((db) =>
              db.transaction(
                async (tx) => {
                  const [snapshot] = (
                    await tx.execute<TransactionSnapshot>(
                      sql.raw(DEADLINES_AND_SNAPSHOT_SQL),
                    )
                  ).rows;
                  await installTenantContext(tx, owner, snapshot);
                  const result = await tx.execute(
                    sql`select tenant_context.erase_employee(${target.id}::uuid, ${target.displayName}, 'app')`,
                  );
                  throw new RolledBack(result.rows as Row[]);
                },
                { isolationLevel: level },
              ),
            ),
          "42501",
        );
    });

    it("refuses an empty, missing or unknown source and a null target by direct SQL", async () => {
      for (const statement of [
        `SELECT tenant_context.erase_employee('${target.id}', 'x', 'import')`,
        `SELECT tenant_context.erase_employee('${target.id}', 'x', NULL)`,
        `SELECT tenant_context.erase_employee(NULL, 'x', 'app')`,
      ])
        await refused(() => sqlAs(owner, statement), "22023");
    });

    it("refuses a wrong confirmation, erasing nothing", async () => {
      for (const confirmName of [
        "Fictional Someone Else",
        target.displayName.toUpperCase(),
        target.displayName.toLowerCase(),
        "   ",
      ]) {
        await refusedApi(
          () => eraseEmployee(owner, target.id, { confirmName }),
          409,
          "erasure_confirmation_mismatch",
        );
        await refused(() => eraseSql(owner, target.id, confirmName), "RQ003");
      }
      await refused(() => eraseSql(owner, target.id, ""), "RQ003");
      // The body schema needs 1 to 300 characters.
      await refusedApi(
        () => eraseEmployee(owner, target.id, { confirmName: "" }),
        400,
        "invalid_input",
      );
      await refusedApi(
        () => eraseEmployee(owner, "not-a-uuid", { confirmName: "x" }),
        400,
        "invalid_input",
      );
      const before = await world();
      const response = await call(
        erasureRoute as Handler,
        "POST",
        `/api/v1/employees/${target.id}/erasure`,
        {
          as: owner,
          id: target.id,
          key: "ee-wrong-name",
          body: { confirmName: "Fictional Someone Else" },
        },
      );
      expect([response.status, response.body.error.code]).toEqual([
        409,
        "erasure_confirmation_mismatch",
      ]);
      expect(await world()).toEqual(before);
    });

    it("refuses direct writes to the tombstones for both runtime roles, even under an owner context", async () => {
      const writes = [
        `INSERT INTO app.employee_erasures(id,workspace_id,employee_id,erased_by,erased_at,erasure_source) VALUES (gen_random_uuid(),'${COMPANY}','${target.id}','ee-owner',now(),'app')`,
        "UPDATE app.employee_erasures SET erased_at = now()",
        "DELETE FROM app.employee_erasures",
        "TRUNCATE app.employee_erasures",
        "SELECT * FROM app.employee_erasures",
      ];
      for (const statement of writes)
        await refused(() => sqlAs(owner, statement), "42501");
      for (const role of ["dataDb", "identityDb"] as const) {
        await harness[role]();
        for (const statement of writes)
          await expect(
            harness.client.query(statement),
            `${role} ${statement}`,
          ).rejects.toMatchObject({ code: "42501" });
      }
    });

    it("refuses a runtime insert of an employee-erasure row or of any row naming a tombstone", async () => {
      const [tombstone] = await look<{ id: string }>(
        "SELECT id FROM app.employee_erasures LIMIT 1",
      );
      const insert = (kind: string, action: string, pointer: string | null) =>
        `INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary,metadata,employee_erasure_id) VALUES ('ee-team-a','ee-owner','session','${action}','${kind}','Forged','{}',${pointer ? `'${pointer}'` : "NULL"})`;
      for (const statement of [
        insert("employee-erasure", "employee.erased", tombstone.id),
        insert("employee-erasure", "employee.erased", null),
        insert("directory", "directory.employee_updated", tombstone.id),
        insert("scope", "scope.home_units_changed", tombstone.id),
        insert("record", "record.updated", tombstone.id),
      ])
        await refused(() => sqlAs(owner, statement), "42501");
      await expect(
        sqlAs(
          owner,
          `UPDATE app.activity SET employee_erasure_id = '${tombstone.id}', summary = 'Forged' WHERE team_id = 'ee-team-a'`,
        ),
      ).rejects.toBeTruthy();
    });
  });

  it("finds nothing of another workspace: 404 by route and service, null by the helper", async () => {
    const before = await world();
    const response = await call(
      erasureRoute as Handler,
      "POST",
      `/api/v1/employees/${otherEmployee.id}/erasure`,
      {
        as: owner,
        id: otherEmployee.id,
        body: { confirmName: otherEmployee.displayName },
      },
    );
    expect([response.status, response.body.error.code]).toEqual([
      404,
      "not_found",
    ]);
    expect(
      await eraseSql(owner, otherEmployee.id, otherEmployee.displayName),
    ).toBeNull();
    // The other workspace's company owner cannot reach this workspace's employees either.
    const local = await employee(owner);
    await expect(
      eraseEmployee(ownerX, local.id, { confirmName: local.displayName }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(
      await eraseSql(owner, "00000000-0000-4000-a000-0000000000ff", "x"),
    ).toBeNull();
    const after = await world();
    expect(after.employees.filter((row) => row.id !== local.id)).toEqual(
      before.employees,
    );
    expect(after.erasures).toEqual(before.erasures);
  });

  describe("retention class and left date", () => {
    const leftAt = async (id: string) =>
      (
        await look<{ left_at: Date | null; updated_at: Date }>(
          "SELECT left_at, updated_at FROM app.employees WHERE id = $1",
          [id],
        )
      )[0];
    const fieldsOf = async (id: string, action: string) =>
      (await about(id))
        .filter((row) => row.action === action)
        .map((row) => row.metadata.fields);

    it("stores, returns and audits the retention class, and refuses other values", async () => {
      const standard = await employee(owner);
      expect(standard.retentionClass).toBe("standard");
      expect(await fieldsOf(standard.id, "directory.employee_created")).toEqual(
        [["displayName", "employeeNumber", "status", "workEmail", "workPhone"]],
      );
      const created = await call(
        createEmployeeRoute as Handler,
        "POST",
        "/api/v1/employees",
        {
          as: owner,
          body: {
            displayName: "Fictional Extended Keeper",
            employeeNumber: "EE-EXT",
            retentionClass: "extended",
          },
        },
      );
      expect(created.status).toBe(201);
      expect(created.body.data.retentionClass).toBe("extended");
      expect(
        await fieldsOf(created.body.data.id, "directory.employee_created"),
      ).toEqual([
        ["displayName", "employeeNumber", "retentionClass", "status"],
      ]);
      const changed = await call(
        patchEmployeeRoute as Handler,
        "PATCH",
        `/api/v1/employees/${standard.id}`,
        { as: owner, id: standard.id, body: { retentionClass: "extended" } },
      );
      expect(changed.status).toBe(200);
      expect(changed.body.data.retentionClass).toBe("extended");
      expect(await fieldsOf(standard.id, "directory.employee_updated")).toEqual(
        [["retentionClass"]],
      );
      for (const [handler, method, path, body] of [
        [
          createEmployeeRoute,
          "POST",
          "/api/v1/employees",
          {
            displayName: "Fictional Refused",
            employeeNumber: "EE-REF",
            retentionClass: "forever",
          },
        ],
        [
          patchEmployeeRoute,
          "PATCH",
          `/api/v1/employees/${standard.id}`,
          { retentionClass: "legal-hold" },
        ],
      ] as const) {
        const response = await call(handler as Handler, method, path, {
          as: owner,
          id: standard.id,
          body,
        });
        expect([response.status, response.body.error.code]).toEqual([
          400,
          "invalid_input",
        ]);
      }
      expect(
        (
          await look(
            "SELECT retention_class FROM app.employees WHERE id = $1",
            [standard.id],
          )
        )[0],
      ).toEqual({ retention_class: "extended" });
    });

    it("sets left_at on leaving, keeps it while left and clears it on return", async () => {
      const leaver = await employee(owner);
      expect((await leftAt(leaver.id)).left_at).toBeNull();
      await updateEmployee(owner, leaver.id, { status: "left" });
      const left = (await leftAt(leaver.id)).left_at;
      expect(left).toBeInstanceOf(Date);
      await updateEmployee(owner, leaver.id, { workPhone: "+971 50 000 9999" });
      await updateEmployee(owner, leaver.id, { status: "left" });
      expect((await leftAt(leaver.id)).left_at).toEqual(left);
      await updateEmployee(owner, leaver.id, { status: "active" });
      expect((await leftAt(leaver.id)).left_at).toBeNull();
      const createdLeft = await employee(owner, { status: "left" });
      expect((await leftAt(createdLeft.id)).left_at).toBeInstanceOf(Date);
    });

    it("keeps a legacy left row's last update as its review date after an edit", async () => {
      await harness.asOwner();
      const [{ id }] = (
        await harness.client.query<{ id: string }>(
          `INSERT INTO app.employees(workspace_id, display_name, employee_number, status, updated_at) VALUES ('${COMPANY}', 'Fictional Legacy Leaver', 'EE-LEGACY', 'left', '2024-01-15T00:00:00Z') RETURNING id`,
        )
      ).rows;
      expect(await leftAt(id)).toEqual({
        left_at: null,
        updated_at: new Date("2024-01-15T00:00:00Z"),
      });
      await updateEmployee(owner, id, { workPhone: "+971 50 000 7777" });
      const after = await leftAt(id);
      expect(after.left_at).toEqual(new Date("2024-01-15T00:00:00Z"));
      expect(after.updated_at.getTime()).toBeGreaterThan(
        new Date("2025-01-01T00:00:00Z").getTime(),
      );
    });
  });

  describe("retention review", () => {
    const ids: Record<string, string> = {};
    beforeAll(async () => {
      await harness.asOwner();
      const insert = async (
        workspace: string,
        name: string,
        number: string,
        status: string,
        left: string | null,
        updated: string,
        archived: boolean,
        retention = "standard",
      ) =>
        (
          await harness.client.query<{ id: string }>(
            `INSERT INTO app.employees(workspace_id, display_name, employee_number, status, left_at, updated_at, archived_at, retention_class) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [
              workspace,
              name,
              number,
              status,
              left,
              updated,
              archived ? updated : null,
              retention,
            ],
          )
        ).rows[0].id;
      const ago = (months: number) => {
        const date = new Date();
        date.setUTCMonth(date.getUTCMonth() - months);
        return date.toISOString();
      };
      ids.thirteen = await insert(
        COMPANY,
        "Fictional Review Thirteen",
        "EE-R13",
        "left",
        ago(13),
        ago(1),
        false,
        "extended",
      );
      ids.eleven = await insert(
        COMPANY,
        "Fictional Review Eleven",
        "EE-R11",
        "left",
        ago(11),
        ago(30),
        false,
      );
      ids.legacyArchived = await insert(
        COMPANY,
        "Fictional Review Legacy",
        "EE-RLEG",
        "left",
        null,
        ago(30),
        true,
      );
      ids.active = await insert(
        COMPANY,
        "Fictional Review Active",
        "EE-RACT",
        "active",
        null,
        ago(40),
        false,
      );
      ids.other = await insert(
        OTHER,
        "Fictional Review Other",
        "EE-ROTH",
        "left",
        ago(40),
        ago(40),
        false,
      );
    });

    it("lists for a company owner only employees left 12 months or more, archived included, oldest first", async () => {
      const response = await call(
        retentionReviewRoute as Handler,
        "GET",
        "/api/v1/employees/retention-review",
        { as: owner },
      );
      expect(response.status).toBe(200);
      const listed = response.body.data as Row[];
      const due = await look<{ id: string }>(
        `SELECT id FROM app.employees WHERE workspace_id = $1 AND status = 'left' AND coalesce(left_at, updated_at) <= now() - interval '12 months' ORDER BY coalesce(left_at, updated_at), id`,
        [COMPANY],
      );
      expect(listed.map((row) => row.id)).toEqual(due.map((row) => row.id));
      const mine = listed.filter((row) =>
        Object.values(ids).includes(row.id as string),
      );
      expect(mine.map((row) => row.id)).toEqual([
        ids.legacyArchived,
        ids.thirteen,
      ]);
      for (const row of listed)
        expect(Object.keys(row).sort()).toEqual([
          "archivedAt",
          "displayName",
          "employeeNumber",
          "id",
          "leftAt",
          "retentionClass",
        ]);
      expect(mine[0]).toMatchObject({
        displayName: "Fictional Review Legacy",
        employeeNumber: "EE-RLEG",
        retentionClass: "standard",
        archivedAt: expect.any(String),
      });
      expect(mine[1]).toMatchObject({
        retentionClass: "extended",
        archivedAt: null,
      });
      expect(response.body.pagination).toEqual({
        page: 1,
        pageSize: 100,
        hasMore: false,
      });
      const paged = await listRetentionReview(owner, { pageSize: 1 });
      expect(paged.data).toHaveLength(1);
      expect(paged.pagination.hasMore).toBe(listed.length > 1);
    });

    it("refuses company admins, team owners without company authority, recruiters and Bearer tokens", async () => {
      for (const p of [
        plainAdmin,
        orgAdmin,
        teamOwnerC,
        teamAdminA,
        recruiter,
      ]) {
        const response = await call(
          retentionReviewRoute as Handler,
          "GET",
          "/api/v1/employees/retention-review",
          { as: p },
        );
        expect([response.status, response.body.error.code]).toEqual([
          403,
          "retention_review_forbidden",
        ]);
      }
      await expect(listRetentionReview(ownerToken)).rejects.toMatchObject({
        status: 403,
        code: "retention_review_forbidden",
      });
      const bearer = await call(
        retentionReviewRoute as Handler,
        "GET",
        "/api/v1/employees/retention-review",
        { bearer: true },
      );
      expect([bearer.status, bearer.body.error.code]).toEqual([
        403,
        "session_required",
      ]);
      // A company owner whose team role lacks directory:read.
      await expect(listRetentionReview(ownerViewer)).rejects.toMatchObject({
        status: 403,
        code: "directory_forbidden",
      });
      const invalid = await call(
        retentionReviewRoute as Handler,
        "GET",
        "/api/v1/employees/retention-review?status=left",
        { as: owner },
      );
      expect([invalid.status, invalid.body.error.code]).toEqual([
        400,
        "invalid_input",
      ]);
    });
  });

  describe("search and archived employees", () => {
    it("matches part of the name or number, ignoring case, and adds archived rows only when asked", async () => {
      const first = await createEmployee(owner, {
        displayName: "Fictional Searchable Rowan",
        employeeNumber: "SRCH-100",
      });
      const second = await createEmployee(owner, {
        displayName: "Fictional 100% Percent",
        employeeNumber: "SRCH-200",
      });
      const archived = await createEmployee(owner, {
        displayName: "Fictional Searchable Archived",
        employeeNumber: "SRCH-300",
      });
      await archiveEmployee(owner, archived.id);
      const found = async (query: string) =>
        (
          await call(
            listEmployeesRoute as Handler,
            "GET",
            `/api/v1/employees?${query}`,
            { as: owner },
          )
        ).body.data.map((row: Employee) => row.id);
      expect(await found("search=searchable%20ROWAN")).toEqual([first.id]);
      expect(await found("search=srch-2")).toEqual([second.id]);
      // The input is never a pattern: % and _ match themselves only.
      expect(await found("search=%25")).toEqual([second.id]);
      expect(await found("search=SRCH_")).toEqual([]);
      expect(await found("search=searchable")).toEqual([first.id]);
      expect(await found("search=searchable&includeArchived=true")).toEqual([
        archived.id,
        first.id,
      ]);
      expect(await found("search=searchable&includeArchived=false")).toEqual([
        first.id,
      ]);
      for (const query of [
        "includeArchived=yes",
        "search=",
        `search=${"x".repeat(121)}`,
      ]) {
        const response = await call(
          listEmployeesRoute as Handler,
          "GET",
          `/api/v1/employees?${query}`,
          { as: owner },
        );
        expect([response.status, response.body.error.code], query).toEqual([
          400,
          "invalid_input",
        ]);
      }
      const listed = await listEmployees(owner, { search: "SRCH" });
      for (const row of listed.data)
        expect(row.retentionClass).toBe("standard");
    });
  });
});
