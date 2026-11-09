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
import { isOwnerTemplateBody, roleBodySchema } from "@/domain/config";
import {
  ADMIN_ROLE,
  OWNER_ROLE,
  RECRUITER_ROLE,
  ROLE_TEMPLATES,
} from "@/domain/config-defaults";
import { getVerifiedSession } from "@/lib/auth-session";
import {
  archiveEmployee,
  archivePosition,
  createEmployee,
  createPosition,
  directoryView,
  linkEmployeeUser,
  listEmployees,
  listHomeUnitChanges,
  listPositions,
  movePosition,
  setEmployeePositions,
  updateEmployee,
  updatePosition,
  type Employee,
  type Position,
} from "@/lib/directory";
import { createOrgLevel, createOrgUnit, type OrgLevel } from "@/lib/org";
import type { Principal } from "@/lib/principal";
import { installTenantContext } from "@/lib/tenant-context";
import {
  GET as listPositionsRoute,
  POST as createPositionRoute,
} from "@/app/api/v1/positions/route";
import { PATCH as patchPositionRoute } from "@/app/api/v1/positions/[id]/route";
import {
  GET as listEmployeesRoute,
  POST as createEmployeeRoute,
} from "@/app/api/v1/employees/route";
import { PATCH as patchEmployeeRoute } from "@/app/api/v1/employees/[id]/route";
import { PUT as putPositionsRoute } from "@/app/api/v1/employees/[id]/positions/route";
import {
  createSplitRoleDb,
  createTestDb,
  seedApiToken,
  seedIdentity,
} from "./helpers/db";

// Fictional data only: one company workspace with three fictional teams, and a second fictional
// workspace inserted by the owner for the isolation case (R2a-14, 0034).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000002";
const ORIGIN = "http://localhost:3000";
const TIMING = /^total;dur=\d+\.\d, db;dur=\d+\.\d, dbrt;desc="(\d+)"$/;
const DIRECTORY_ACTIONS = [
  "directory.employee_created",
  "directory.employee_updated",
  "directory.employee_archived",
  "directory.employee_positions_changed",
];
const POSITION_ACTIONS = [
  "org.position_created",
  "org.position_updated",
  "org.position_archived",
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
  method: "GET" | "POST" | "PATCH" | "PUT",
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
          ? { authorization: "Bearer fictional-directory-token" }
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

/** Thrown to roll a probe transaction back after its statement ran. */
class RolledBack extends Error {
  constructor(readonly count: number) {
    super("rolled back");
  }
}

describe("positions and employees under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, teamAdminA: Principal, recruiter: Principal;
  let teamOwnerB: Principal, orgAdmin: Principal, fieldsAdmin: Principal;
  let ownerToken: Principal, ownerOauth: Principal, ownerX: Principal;
  /** Fictional users an employee can be linked to; each is a viewer of team A. */
  let people: string[];
  let levels: OrgLevel[];
  let unitA: string, unitB: string, unitC: string;

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
      "SELECT id, team_id, actor_id, actor_type, token_id, record_id, action, kind, summary, metadata FROM app.activity WHERE kind IN ('org', 'scope', 'directory') ORDER BY created_at, id",
    );
  /** Every position, employee and position row, and every org, scope or directory activity row. */
  const state = async () => ({
    positions: await look("SELECT * FROM app.positions ORDER BY id"),
    employees: await look("SELECT * FROM app.employees ORDER BY id"),
    held: await look(
      "SELECT * FROM app.employee_positions ORDER BY employee_id, position_id, valid_from",
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
  /** Runs the call and expects one SQLSTATE, with no directory row or audit row changed. */
  async function refused(call: () => Promise<unknown>, code: string) {
    const before = await state();
    await expect(call()).rejects.toMatchObject({ cause: { code } });
    expect(await state()).toEqual(before);
  }
  /** Runs the call and expects one API error, with no directory row or audit row changed. */
  async function refusedApi(
    call: () => Promise<unknown>,
    status: number,
    code: string,
  ) {
    const before = await state();
    await expect(call()).rejects.toMatchObject({ status, code });
    expect(await state()).toEqual(before);
  }
  /** The org, scope and directory activity rows the call added. */
  async function audited<T>(call: () => Promise<T>) {
    const before = new Set((await audits()).map((row) => row.id));
    const result = await call();
    return {
      result,
      rows: (await audits()).filter((row) => !before.has(row.id)),
    };
  }
  const scopeRows = (rows: Audit[]) =>
    rows.filter((row) => row.action === "scope.home_units_changed");
  const position = (
    p: Principal,
    title: string,
    code: string,
    orgUnitId: string,
  ) => createPosition(p, { title, code, orgUnitId });
  let serial = 0;
  const employee = (p: Principal, extra: Record<string, unknown> = {}) =>
    createEmployee(p, {
      displayName: `Fictional Employee ${++serial}`,
      employeeNumber: `FICT-${serial}`,
      ...extra,
    });
  /** The owner links an employee and gives it one position, through the service. */
  async function linkedHolder(userId: string, positionId: string) {
    const holder = await employee(owner);
    await linkEmployeeUser(owner, holder.id, { userId });
    await setEmployeePositions(owner, holder.id, {
      positions: [{ positionId, primary: true }],
    });
    return holder;
  }

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, {
      userId: "dir-owner",
      teamId: "dir-team-a",
    });
    teamAdminA = await seedIdentity(db, {
      userId: "dir-team-admin",
      teamId: "dir-team-a",
      role: "admin",
    });
    recruiter = await seedIdentity(db, {
      userId: "dir-recruiter",
      teamId: "dir-team-a",
      role: "recruiter",
    });
    teamOwnerB = await seedIdentity(db, {
      userId: "dir-owner-b",
      teamId: "dir-team-b",
    });
    orgAdmin = await seedIdentity(db, {
      userId: "dir-org-admin",
      teamId: "dir-team-b",
      role: "admin",
    });
    fieldsAdmin = await seedIdentity(db, {
      userId: "dir-fields-admin",
      teamId: "dir-team-b",
      role: "admin",
    });
    ownerX = await seedIdentity(db, {
      userId: "dir-owner-x",
      teamId: "dir-team-x",
    });
    people = [];
    for (const index of [1, 2, 3, 4, 5, 6])
      people.push(
        (
          await seedIdentity(db, {
            userId: `dir-person-${index}`,
            teamId: "dir-team-a",
            role: "viewer",
          })
        ).userId,
      );
    // Owner tokens holding every scope, directory ones included, which the app never issues: the
    // database still refuses every directory write by a token context.
    ownerToken = await seedApiToken(db, owner);
    ownerOauth = {
      ...(await seedApiToken(db, owner)),
      oauthClientId: "fictional-oauth-client",
    };
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','dir-org-admin','admin','{organisation}'),
        ('${COMPANY}','dir-fields-admin','admin','{fields}');
      INSERT INTO app.workspaces(id,name) VALUES ('${OTHER}','Fictional Other Company');
      UPDATE app.workspace_teams SET workspace_id = '${OTHER}' WHERE team_id = 'dir-team-x';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level) VALUES ('${OTHER}','dir-owner-x','owner');
    `);
    levels = [];
    for (let depth = 0; depth < 6; depth++)
      levels.push(
        await createOrgLevel(owner, {
          name: `Fictional level ${depth}`,
          depth,
        }),
      );
    unitA = (
      await createOrgUnit(owner, {
        name: "Fictional Holdings",
        code: "DIR-A",
        levelId: levels[0].id,
      })
    ).id;
    unitB = (
      await createOrgUnit(owner, {
        name: "Sample Division",
        code: "DIR-B",
        levelId: levels[1].id,
        parentId: unitA,
      })
    ).id;
    unitC = (
      await createOrgUnit(owner, {
        name: "Fictional Group",
        code: "DIR-C",
        levelId: levels[0].id,
      })
    ).id;
  });
  afterAll(async () => harness?.close());

  it("forces row-level security on the three tables and holds no personal trait column", async () => {
    expect(
      await look(
        "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid IN ('app.positions'::regclass, 'app.employees'::regclass, 'app.employee_positions'::regclass) ORDER BY relname",
      ),
    ).toEqual(
      ["employee_positions", "employees", "positions"].map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );
    expect(
      (
        await look<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'employees' ORDER BY ordinal_position",
        )
      ).map((row) => row.column_name),
    ).toEqual([
      "id",
      "workspace_id",
      "display_name",
      "work_email",
      "work_phone",
      "employee_number",
      "user_id",
      "status",
      "source",
      "created_at",
      "updated_at",
      "archived_at",
    ]);
  });

  describe("routes for a company owner", () => {
    it("creates, updates, moves, archives and pages positions", async () => {
      const created = await call(
        createPositionRoute,
        "POST",
        "/api/v1/positions",
        {
          as: owner,
          body: {
            title: "Fictional Payroll Lead",
            code: "POS-PAY",
            orgUnitId: unitA,
            isManager: true,
          },
        },
      );
      expect(created.status).toBe(201);
      const payroll = created.body.data as Position;
      expect(payroll).toMatchObject({
        title: "Fictional Payroll Lead",
        code: "POS-PAY",
        orgUnitId: unitA,
        isManager: true,
        jobRoleId: null,
        archivedAt: null,
      });
      const second = (
        await call(createPositionRoute, "POST", "/api/v1/positions", {
          as: owner,
          body: {
            title: "Fictional Analyst",
            code: "POS-AN",
            orgUnitId: unitA,
          },
        })
      ).body.data as Position;
      const renamed = await call(
        patchPositionRoute,
        "PATCH",
        `/api/v1/positions/${payroll.id}`,
        {
          as: owner,
          id: payroll.id,
          body: { title: "Fictional Payroll Manager", isManager: false },
        },
      );
      expect(renamed.status).toBe(200);
      expect(renamed.body.data).toMatchObject({
        id: payroll.id,
        title: "Fictional Payroll Manager",
        isManager: false,
        code: "POS-PAY",
      });
      const moved = await call(
        patchPositionRoute,
        "PATCH",
        `/api/v1/positions/${payroll.id}`,
        { as: owner, id: payroll.id, body: { orgUnitId: unitB } },
      );
      expect(moved.status).toBe(200);
      expect(moved.body.data).toMatchObject({ orgUnitId: unitB });
      const page = await call(
        listPositionsRoute,
        "GET",
        `/api/v1/positions?unitId=${unitA}&pageSize=1`,
        { as: owner },
      );
      expect(page.status).toBe(200);
      expect(page.body).toEqual({
        data: [second],
        pagination: { page: 1, pageSize: 1, hasMore: false },
      });
      const inB = await call(
        listPositionsRoute,
        "GET",
        `/api/v1/positions?unitId=${unitB}`,
        { as: owner },
      );
      expect(inB.body.data.map((row: Position) => row.id)).toEqual([
        payroll.id,
      ]);
      const archived = await call(
        patchPositionRoute,
        "PATCH",
        `/api/v1/positions/${payroll.id}`,
        { as: owner, id: payroll.id, body: { archived: true } },
      );
      expect(archived.status).toBe(200);
      expect(archived.body.data.archivedAt).toEqual(expect.any(String));
      expect(
        (
          await call(
            listPositionsRoute,
            "GET",
            `/api/v1/positions?unitId=${unitB}`,
            { as: owner },
          )
        ).body.data,
      ).toEqual([]);
      // An archived position takes no change, its code is free again, and unknown ids are 404.
      expect(
        (
          await call(
            patchPositionRoute,
            "PATCH",
            `/api/v1/positions/${payroll.id}`,
            { as: owner, id: payroll.id, body: { title: "Denied" } },
          )
        ).body.error.code,
      ).toBe("directory_state_conflict");
      expect(
        (
          await call(createPositionRoute, "POST", "/api/v1/positions", {
            as: owner,
            body: { title: "Denied", code: "POS-AN", orgUnitId: unitA },
          })
        ).body.error.code,
      ).toBe("position_code_exists");
      expect(
        (
          await call(createPositionRoute, "POST", "/api/v1/positions", {
            as: owner,
            body: {
              title: "Fictional Payroll Lead",
              code: "POS-PAY",
              orgUnitId: unitA,
            },
          })
        ).status,
      ).toBe(201);
      for (const [path, method, handler, body] of [
        [
          `/api/v1/positions?unitId=${OTHER}`,
          "GET",
          listPositionsRoute,
          undefined,
        ],
        [
          "/api/v1/positions",
          "POST",
          createPositionRoute,
          { title: "Denied", code: "POS-X", orgUnitId: OTHER },
        ],
        [
          `/api/v1/positions/${OTHER}`,
          "PATCH",
          patchPositionRoute,
          { title: "Denied" },
        ],
      ] as const) {
        const response = await call(handler as Handler, method, path, {
          as: owner,
          id: OTHER,
          body,
        });
        expect(response.status, path).toBe(404);
        expect(response.body.error.code).toBe("not_found");
      }
      // Two operations, an empty change or an unknown key are refused.
      for (const body of [
        {},
        { title: "Denied", archived: true },
        { orgUnitId: unitA, title: "Denied" },
        { archived: false },
        { code: "POS-NEW" },
      ])
        expect(
          (
            await call(
              patchPositionRoute,
              "PATCH",
              `/api/v1/positions/${second.id}`,
              { as: owner, id: second.id, body },
            )
          ).body.error.code,
          JSON.stringify(body),
        ).toBe("invalid_input");
    });

    it("creates, updates, archives and pages employees and sets their positions", async () => {
      const lead = await position(
        owner,
        "Fictional Team Lead",
        "POS-LEAD",
        unitA,
      );
      const helper = await position(
        owner,
        "Fictional Helper",
        "POS-HELP",
        unitB,
      );
      const created = await call(
        createEmployeeRoute,
        "POST",
        "/api/v1/employees",
        {
          as: owner,
          body: {
            displayName: "Fictional Dana Sample",
            employeeNumber: "EMP-ROUTE-1",
            workEmail: "dana.sample@example.test",
            workPhone: " +971 50 000 0001 ",
          },
        },
      );
      expect(created.status).toBe(201);
      const dana = created.body.data as Employee;
      expect(dana).toMatchObject({
        displayName: "Fictional Dana Sample",
        employeeNumber: "EMP-ROUTE-1",
        workEmail: "dana.sample@example.test",
        workPhone: "+971 50 000 0001",
        status: "active",
        source: "app",
        userId: null,
        positions: [],
        archivedAt: null,
      });
      const updated = await call(
        patchEmployeeRoute,
        "PATCH",
        `/api/v1/employees/${dana.id}`,
        {
          as: owner,
          id: dana.id,
          body: { displayName: "Fictional Dana Example", workPhone: "" },
        },
      );
      expect(updated.status).toBe(200);
      expect(updated.body.data).toMatchObject({
        displayName: "Fictional Dana Example",
        workPhone: null,
      });
      const set = await call(
        putPositionsRoute,
        "PUT",
        `/api/v1/employees/${dana.id}/positions`,
        {
          as: owner,
          id: dana.id,
          body: {
            positions: [
              { positionId: lead.id, primary: true },
              { positionId: helper.id, primary: false },
            ],
          },
        },
      );
      expect(set.status).toBe(200);
      expect(
        (set.body.data as Employee).positions.map((row) => [
          row.positionId,
          row.title,
          row.orgUnitId,
          row.primary,
        ]),
      ).toEqual([
        [lead.id, "Fictional Team Lead", unitA, true],
        [helper.id, "Fictional Helper", unitB, false],
      ]);
      // The primary moves, the helper position ends; the ended row stays as history.
      const swapped = await call(
        putPositionsRoute,
        "PUT",
        `/api/v1/employees/${dana.id}/positions`,
        {
          as: owner,
          id: dana.id,
          body: { positions: [{ positionId: lead.id, primary: false }] },
        },
      );
      expect(
        (swapped.body.data as Employee).positions.map((row) => [
          row.positionId,
          row.primary,
        ]),
      ).toEqual([[lead.id, false]]);
      expect(
        await look(
          'SELECT position_id, "primary", valid_to IS NOT NULL AS ended FROM app.employee_positions WHERE employee_id = $1 ORDER BY valid_from',
          [dana.id],
        ),
      ).toEqual([
        { position_id: lead.id, primary: false, ended: false },
        { position_id: helper.id, primary: false, ended: true },
      ]);
      const listed = await call(
        listEmployeesRoute,
        "GET",
        `/api/v1/employees?positionId=${lead.id}`,
        { as: owner },
      );
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual({
        data: [swapped.body.data],
        pagination: { page: 1, pageSize: 100, hasMore: false },
      });
      const second = await employee(owner);
      await setEmployeePositions(owner, second.id, {
        positions: [{ positionId: lead.id, primary: true }],
      });
      const paged = await call(
        listEmployeesRoute,
        "GET",
        `/api/v1/employees?positionId=${lead.id}&pageSize=1&page=2`,
        { as: owner },
      );
      expect(paged.body.data.map((row: Employee) => row.id)).toEqual([
        second.id,
      ]);
      expect(paged.body.pagination).toEqual({
        page: 2,
        pageSize: 1,
        hasMore: false,
      });
      const archived = await call(
        patchEmployeeRoute,
        "PATCH",
        `/api/v1/employees/${dana.id}`,
        { as: owner, id: dana.id, body: { archived: true } },
      );
      expect(archived.status).toBe(200);
      expect(archived.body.data.archivedAt).toEqual(expect.any(String));
      expect(
        (
          await call(
            listEmployeesRoute,
            "GET",
            `/api/v1/employees?positionId=${lead.id}`,
            { as: owner },
          )
        ).body.data.map((row: Employee) => row.id),
      ).toEqual([second.id]);
      // An archived employee takes no change; a duplicate number, a bad email or position is refused.
      for (const [handler, method, path, body, status, code] of [
        [
          patchEmployeeRoute,
          "PATCH",
          `/api/v1/employees/${dana.id}`,
          { status: "left" },
          409,
          "directory_state_conflict",
        ],
        [
          putPositionsRoute,
          "PUT",
          `/api/v1/employees/${dana.id}/positions`,
          { positions: [] },
          409,
          "directory_state_conflict",
        ],
        [
          createEmployeeRoute,
          "POST",
          "/api/v1/employees",
          { displayName: "Denied", employeeNumber: "EMP-ROUTE-1" },
          409,
          "employee_number_exists",
        ],
        [
          createEmployeeRoute,
          "POST",
          "/api/v1/employees",
          {
            displayName: "Denied",
            employeeNumber: "EMP-DENIED",
            workEmail: "not-an-email",
          },
          400,
          "invalid_input",
        ],
        [
          createEmployeeRoute,
          "POST",
          "/api/v1/employees",
          {
            displayName: "Denied",
            employeeNumber: "EMP-DENIED",
            dateOfBirth: "1990-01-01",
          },
          400,
          "invalid_input",
        ],
        [
          putPositionsRoute,
          "PUT",
          `/api/v1/employees/${second.id}/positions`,
          { positions: [{ positionId: OTHER, primary: false }] },
          404,
          "not_found",
        ],
        [
          putPositionsRoute,
          "PUT",
          `/api/v1/employees/${second.id}/positions`,
          {
            positions: [
              { positionId: lead.id, primary: true },
              { positionId: helper.id, primary: true },
            ],
          },
          400,
          "invalid_input",
        ],
        [
          putPositionsRoute,
          "PUT",
          `/api/v1/employees/${second.id}/positions`,
          {
            positions: [
              { positionId: lead.id, primary: true },
              { positionId: lead.id, primary: false },
            ],
          },
          400,
          "invalid_input",
        ],
        [
          listEmployeesRoute,
          "GET",
          `/api/v1/employees?levelId=${OTHER}`,
          undefined,
          404,
          "not_found",
        ],
        [
          listEmployeesRoute,
          "GET",
          "/api/v1/employees?status=retired",
          undefined,
          400,
          "invalid_input",
        ],
      ] as const) {
        const response = await call(handler as Handler, method, path, {
          as: owner,
          id: path.split("/")[4]?.split("?")[0],
          body,
        });
        expect([response.status, response.body.error?.code], path).toEqual([
          status,
          code,
        ]);
      }
      const archivedPosition = await position(
        owner,
        "Fictional Archived",
        "POS-ARCH",
        unitA,
      );
      await archivePosition(owner, archivedPosition.id);
      await refusedApi(
        () =>
          setEmployeePositions(owner, second.id, {
            positions: [{ positionId: archivedPosition.id, primary: false }],
          }),
        409,
        "directory_state_conflict",
      );
    });

    it("answers every Bearer request with 403 session_required", async () => {
      for (const [handler, method] of [
        [listPositionsRoute, "GET"],
        [createPositionRoute, "POST"],
        [patchPositionRoute, "PATCH"],
        [listEmployeesRoute, "GET"],
        [createEmployeeRoute, "POST"],
        [patchEmployeeRoute, "PATCH"],
        [putPositionsRoute, "PUT"],
      ] as const) {
        const response = await call(handler as Handler, method, "/api/v1/x", {
          bearer: true,
          body: method === "GET" ? undefined : {},
        });
        expect([response.status, response.body.error.code], method).toEqual([
          403,
          "session_required",
        ]);
      }
    });
  });

  describe("user links", () => {
    it("links a user to at most one employee per workspace", async () => {
      const first = await employee(owner);
      const second = await employee(owner);
      await linkEmployeeUser(owner, first.id, { userId: people[0] });
      const response = await call(
        patchEmployeeRoute,
        "PATCH",
        `/api/v1/employees/${second.id}`,
        { as: owner, id: second.id, body: { userId: people[0] } },
      );
      expect([response.status, response.body.error.code]).toEqual([
        409,
        "employee_user_linked",
      ]);
      await refusedApi(
        () =>
          createEmployee(owner, {
            displayName: "Denied",
            employeeNumber: "EMP-DUP",
            userId: people[0],
          }),
        409,
        "employee_user_linked",
      );
      await refusedApi(
        () => linkEmployeeUser(owner, second.id, { userId: "dir-nobody" }),
        404,
        "not_found",
      );
      // The owner's own SQL is refused by the index too.
      await harness.asOwner();
      await expect(
        harness.client.query(
          `INSERT INTO app.employees(workspace_id, display_name, employee_number, user_id) VALUES ('${COMPANY}', 'Fictional Owner SQL', 'EMP-OWNER-SQL', '${people[0]}')`,
        ),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "employees_user_link",
      });
    });
  });

  describe("owner-only home-unit facts", () => {
    let held: Position, spare: Position, free: Position;
    let linked: Employee, unlinked: Employee, own: Employee;
    beforeAll(async () => {
      held = await position(owner, "Fictional Held", "POS-HELD", unitA);
      spare = await position(owner, "Fictional Spare", "POS-SPARE", unitA);
      free = await position(owner, "Fictional Free", "POS-FREE", unitA);
      linked = await linkedHolder(people[1], held.id);
      // The team B owner's own employee row, linked by the company owner.
      own = await linkedHolder(teamOwnerB.userId, spare.id);
      unlinked = await employee(owner);
    });

    it("refuses link, unlink, linked create and a linked employee's positions in the service", async () => {
      for (const p of [teamAdminA, orgAdmin, teamOwnerB]) {
        for (const operation of [
          () => linkEmployeeUser(p, unlinked.id, { userId: people[2] }),
          () => linkEmployeeUser(p, linked.id, { userId: null }),
          () => linkEmployeeUser(p, own.id, { userId: null }),
          () => employee(p, { userId: people[3] }),
          () =>
            setEmployeePositions(p, linked.id, {
              positions: [
                { positionId: held.id, primary: true },
                { positionId: free.id, primary: false },
              ],
            }),
          () =>
            setEmployeePositions(p, linked.id, {
              positions: [{ positionId: held.id, primary: false }],
            }),
          () => setEmployeePositions(p, linked.id, { positions: [] }),
          () =>
            setEmployeePositions(p, own.id, {
              positions: [{ positionId: free.id, primary: true }],
            }),
        ])
          await refusedApi(operation, 403, "directory_owner_required");
      }
    });

    it("refuses moving, archiving and re-coding a held position to a company admin, and position writes to team roles", async () => {
      await refusedApi(
        () => movePosition(orgAdmin, held.id, { orgUnitId: unitC }),
        403,
        "directory_owner_required",
      );
      await refusedApi(
        () => archivePosition(orgAdmin, held.id),
        403,
        "directory_owner_required",
      );
      for (const p of [teamAdminA, teamOwnerB])
        for (const operation of [
          () => movePosition(p, held.id, { orgUnitId: unitC }),
          () => archivePosition(p, held.id),
        ])
          await refusedApi(operation, 403, "org_forbidden");
      // An unheld position moves and is renamed by the company admin; a held one is renamed too.
      expect(
        (await movePosition(orgAdmin, free.id, { orgUnitId: unitB })).orgUnitId,
      ).toBe(unitB);
      expect(
        (
          await updatePosition(orgAdmin, held.id, {
            title: "Fictional Held Renamed",
          })
        ).title,
      ).toBe("Fictional Held Renamed");
    });

    it("refuses each home-unit change by direct SQL for team roles, a company admin and owner tokens", async () => {
      const statements = [
        `UPDATE app.employees SET user_id = '${people[2]}' WHERE id = '${unlinked.id}'`,
        `UPDATE app.employees SET user_id = NULL WHERE id = '${linked.id}'`,
        `UPDATE app.employees SET user_id = NULL WHERE id = '${own.id}'`,
        `INSERT INTO app.employees(workspace_id, display_name, employee_number, user_id) VALUES ('${COMPANY}', 'Denied', 'EMP-DENIED-SQL', '${people[3]}')`,
        `INSERT INTO app.employee_positions(employee_id, position_id, workspace_id) VALUES ('${linked.id}', '${free.id}', '${COMPANY}')`,
        `INSERT INTO app.employee_positions(employee_id, position_id, workspace_id) VALUES ('${own.id}', '${free.id}', '${COMPANY}')`,
        `UPDATE app.employee_positions SET "primary" = false WHERE employee_id = '${linked.id}'`,
        `UPDATE app.employee_positions SET valid_to = now() WHERE employee_id = '${own.id}'`,
        `UPDATE app.positions SET org_unit_id = '${unitC}' WHERE id = '${held.id}'`,
        `UPDATE app.positions SET archived_at = now() WHERE id = '${held.id}'`,
      ];
      for (const p of [
        teamAdminA,
        orgAdmin,
        teamOwnerB,
        ownerToken,
        ownerOauth,
      ])
        for (const statement of statements)
          await refused(() => sqlAs(p, statement), "42501");
    });

    it("refuses a new effective row giving a held position's code another unit", async () => {
      const recoded = await position(
        owner,
        "Fictional Recoded",
        "POS-RECODE",
        unitA,
      );
      await linkedHolder(people[4], recoded.id);
      // Only the owner archives a held position; the code is then free for a new effective row.
      await archivePosition(owner, recoded.id);
      await refusedApi(
        () => position(orgAdmin, "Denied", "POS-RECODE", unitC),
        403,
        "directory_owner_required",
      );
      for (const p of [
        orgAdmin,
        teamAdminA,
        teamOwnerB,
        ownerToken,
        ownerOauth,
      ])
        await refused(
          () =>
            sqlAs(
              p,
              `INSERT INTO app.positions(workspace_id, org_unit_id, title, code) VALUES ('${COMPANY}', '${unitC}', 'Denied', 'POS-RECODE')`,
            ),
          "42501",
        );
      // The same unit is no move: the company admin may create it.
      const same = await audited(() =>
        position(orgAdmin, "Fictional Recoded", "POS-RECODE", unitA),
      );
      expect(same.rows.map((row) => row.action)).toEqual([
        "org.position_created",
      ]);
    });

    it("lets a company owner make each change, by service and direct SQL, with one scope row each", async () => {
      const [uA, uB, uC] = [people[2], people[3], people[5]];
      const metadataKeys = (row: Audit) => Object.keys(row.metadata).sort();
      const expectScope = (
        rows: Audit[],
        subject: "employeeId" | "positionId",
        id: string,
        affected: string[],
      ) => {
        const scope = scopeRows(rows);
        expect(scope).toHaveLength(1);
        expect(scope[0]).toMatchObject({
          team_id: "dir-team-a",
          actor_id: "dir-owner",
          actor_type: "session",
          token_id: null,
          record_id: null,
          kind: "scope",
          summary: "Changed the employee facts that set home units",
        });
        expect(metadataKeys(scope[0])).toEqual(
          ["affectedUserIds", subject, "workspaceId"].sort(),
        );
        expect(scope[0].metadata).toEqual({
          workspaceId: COMPANY,
          affectedUserIds: affected,
          [subject]: id,
        });
      };
      const created = await audited(() =>
        createEmployee(owner, {
          displayName: "Fictional Linked Hire",
          employeeNumber: "EMP-LINKED-1",
          userId: uA,
        }),
      );
      expectScope(created.rows, "employeeId", created.result.id, [uA]);
      const target = created.result;
      const relink = await employee(owner);
      expectScope(
        (
          await audited(() =>
            linkEmployeeUser(owner, relink.id, { userId: uB }),
          )
        ).rows,
        "employeeId",
        relink.id,
        [uB],
      );
      await linkEmployeeUser(owner, relink.id, { userId: null });
      // A direct-SQL relink by the owner session names the old and new user, sorted.
      await linkEmployeeUser(owner, relink.id, { userId: uC });
      expectScope(
        (
          await audited(() =>
            sqlAs(
              owner,
              `UPDATE app.employees SET user_id = '${uB}' WHERE id = '${relink.id}'`,
            ),
          )
        ).rows,
        "employeeId",
        relink.id,
        [uB, uC].sort(),
      );
      expectScope(
        (
          await audited(() =>
            linkEmployeeUser(owner, relink.id, { userId: null }),
          )
        ).rows,
        "employeeId",
        relink.id,
        [uB],
      );
      // Insert, update and end a position row of the linked employee.
      const desk = await position(owner, "Fictional Desk", "POS-DESK", unitA);
      for (const positions of [
        [{ positionId: desk.id, primary: true }],
        [{ positionId: desk.id, primary: false }],
        [],
      ])
        expectScope(
          (
            await audited(() =>
              setEmployeePositions(owner, target.id, { positions }),
            )
          ).rows,
          "employeeId",
          target.id,
          [uA],
        );
      expectScope(
        (
          await audited(() =>
            sqlAs(
              owner,
              `INSERT INTO app.employee_positions(employee_id, position_id, workspace_id, "primary") VALUES ('${target.id}', '${desk.id}', '${COMPANY}', true)`,
            ),
          )
        ).rows,
        "employeeId",
        target.id,
        [uA],
      );
      // Move, archive and re-create the held position under another unit.
      expectScope(
        (
          await audited(() =>
            movePosition(owner, desk.id, { orgUnitId: unitB }),
          )
        ).rows,
        "positionId",
        desk.id,
        [uA],
      );
      expectScope(
        (
          await audited(() =>
            sqlAs(
              owner,
              `UPDATE app.positions SET org_unit_id = '${unitC}' WHERE id = '${desk.id}'`,
            ),
          )
        ).rows,
        "positionId",
        desk.id,
        [uA],
      );
      expectScope(
        (await audited(() => archivePosition(owner, desk.id))).rows,
        "positionId",
        desk.id,
        [uA],
      );
      const recreated = await audited(() =>
        position(owner, "Fictional Desk", "POS-DESK", unitA),
      );
      expectScope(recreated.rows, "positionId", recreated.result.id, [uA]);
      // Unheld positions and unlinked employees write no scope row.
      const quiet = await employee(owner);
      expect(
        scopeRows(
          (
            await audited(async () => {
              await setEmployeePositions(owner, quiet.id, {
                positions: [{ positionId: recreated.result.id, primary: true }],
              });
              await movePosition(owner, free.id, { orgUnitId: unitA });
              await archiveEmployee(owner, quiet.id);
            })
          ).rows,
        ),
      ).toEqual([]);
    });

    it("lists the home-unit changes to company owners only, with action, time, users and actor name", async () => {
      const scope = scopeRows(await audits()).reverse();
      const changes = await listHomeUnitChanges(owner, { pageSize: 100 });
      expect(changes.length).toBeGreaterThanOrEqual(10);
      expect(changes).toHaveLength(scope.length);
      for (const [index, change] of changes.entries()) {
        expect(Object.keys(change).sort()).toEqual([
          "action",
          "actorName",
          "affectedUserIds",
          "occurredAt",
        ]);
        expect(change).toMatchObject({
          action: "scope.home_units_changed",
          actorName: "Fictional Test User",
          affectedUserIds: scope[index].metadata.affectedUserIds,
        });
      }
      expect(
        (await listHomeUnitChanges(owner, { pageSize: 2 })).map(
          (change) => change.affectedUserIds,
        ),
      ).toEqual(changes.slice(0, 2).map((change) => change.affectedUserIds));
      expect(
        await listHomeUnitChanges(owner, {
          before: new Date("2000-01-01T00:00:00Z"),
        }),
      ).toEqual([]);
      for (const p of [orgAdmin, teamOwnerB, recruiter, ownerToken]) {
        await refusedApi(
          () => listHomeUnitChanges(p),
          403,
          "directory_owner_required",
        );
        await refused(
          () =>
            sqlAs(
              p,
              "SELECT * FROM tenant_context.home_unit_changes(NULL, 50)",
            ),
          "42501",
        );
      }
      for (const size of [0, 101])
        await refused(
          () =>
            sqlAs(
              owner,
              `SELECT * FROM tenant_context.home_unit_changes(NULL, ${size})`,
            ),
          "22023",
        );
    });
  });

  describe("audit", () => {
    it("writes field names only for every position and employee change, to the acting team", async () => {
      const values = [
        "Fictional Audit Title",
        "AUDIT-CODE-77",
        "Fictional Audit Retitled",
        "Fictional Audit Person",
        "AUDIT-NUMBER-88",
        "audit.person@example.test",
        "+971 50 000 0088",
        "Fictional Audit Renamed",
      ];
      const { rows } = await audited(async () => {
        const made = await createPosition(owner, {
          title: values[0],
          code: values[1],
          orgUnitId: unitA,
          isManager: true,
        });
        await updatePosition(owner, made.id, { title: values[2] });
        await movePosition(owner, made.id, { orgUnitId: unitB });
        const person = await createEmployee(owner, {
          displayName: values[3],
          employeeNumber: values[4],
          workEmail: values[5],
          workPhone: values[6],
        });
        await updateEmployee(owner, person.id, {
          displayName: values[7],
          status: "left",
        });
        await setEmployeePositions(owner, person.id, {
          positions: [{ positionId: made.id, primary: true }],
        });
        await setEmployeePositions(owner, person.id, { positions: [] });
        await archiveEmployee(owner, person.id);
        await archivePosition(owner, made.id);
      });
      expect(
        rows.map((row) => [row.action, row.metadata.fields, row.summary]),
      ).toEqual([
        [
          "org.position_created",
          ["code", "isManager", "orgUnitId", "title"],
          "Created a position",
        ],
        ["org.position_updated", ["title"], "Updated a position"],
        ["org.position_updated", ["orgUnitId"], "Updated a position"],
        [
          "directory.employee_created",
          ["displayName", "employeeNumber", "status", "workEmail", "workPhone"],
          "Created an employee",
        ],
        [
          "directory.employee_updated",
          ["displayName", "status"],
          "Updated an employee",
        ],
        [
          "directory.employee_positions_changed",
          ["positionId", "primary"],
          "Changed an employee's positions",
        ],
        [
          "directory.employee_positions_changed",
          ["validTo"],
          "Changed an employee's positions",
        ],
        ["directory.employee_archived", ["archivedAt"], "Archived an employee"],
        ["org.position_archived", ["archivedAt"], "Archived a position"],
      ]);
      for (const row of rows) {
        expect(row).toMatchObject({
          team_id: "dir-team-a",
          actor_id: "dir-owner",
          actor_type: "session",
          token_id: null,
          record_id: null,
          kind: row.action.split(".")[0],
        });
        const keys = Object.keys(row.metadata).sort();
        expect(keys).toEqual(
          row.action === "directory.employee_positions_changed"
            ? ["employeeId", "fields", "positionId", "workspaceId"]
            : row.kind === "org"
              ? ["fields", "positionId", "workspaceId"]
              : ["employeeId", "fields", "workspaceId"],
        );
        const text = JSON.stringify([row.metadata, row.summary]);
        for (const value of [...values, "example.test"])
          expect(text, row.action).not.toContain(value);
      }
    });

    it("refuses a direct data-role insert of a position, directory or scope activity row", async () => {
      for (const [kind, action] of [
        ...POSITION_ACTIONS.map((action) => ["org", action]),
        ...DIRECTORY_ACTIONS.map((action) => ["directory", action]),
        ["scope", "scope.home_units_changed"],
      ])
        await refused(
          () =>
            sqlAs(
              owner,
              `INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary,metadata) VALUES ('dir-team-a','dir-owner','session','${action}','${kind}','Forged','{}')`,
            ),
          "42501",
        );
    });

    it("writes no audit row for the owner's own SQL, which has no context", async () => {
      const { rows } = await audited(async () => {
        await harness.asOwner();
        await harness.client.query(
          `INSERT INTO app.employees(workspace_id, display_name, employee_number, user_id) VALUES ('${COMPANY}', 'Fictional Owner SQL Employee', 'EMP-OWNER-SQL-2', 'dir-person-6')`,
        );
      });
      expect(rows).toEqual([]);
    });
  });

  describe("directory rule", () => {
    it("leaves out work email and phone without the full rule, and keeps both for owners and admins", async () => {
      const row: Employee = {
        id: "00000000-0000-4000-a000-0000000000e1",
        displayName: "Fictional Rule Person",
        employeeNumber: "EMP-RULE",
        status: "active",
        source: "app",
        userId: null,
        workEmail: "rule.person@example.test",
        workPhone: "+971 50 000 0099",
        positions: [],
        createdAt: "2026-11-09T00:00:00.000Z",
        updatedAt: "2026-11-09T00:00:00.000Z",
        archivedAt: null,
      };
      for (const role of [
        null,
        RECRUITER_ROLE.body,
        { ...ADMIN_ROLE.body, directoryRule: "basic" as const },
        roleBodySchema.parse({ ...ADMIN_ROLE.body, directoryRule: undefined }),
      ]) {
        const view = directoryView(role, row);
        expect(Object.hasOwn(view, "workEmail")).toBe(false);
        expect(Object.hasOwn(view, "workPhone")).toBe(false);
        expect(view.displayName).toBe(row.displayName);
      }
      expect(directoryView(OWNER_ROLE.body, row)).toEqual(row);
      expect(directoryView(ADMIN_ROLE.body, row)).toEqual(row);
      expect([
        OWNER_ROLE.body.directoryRule,
        ADMIN_ROLE.body.directoryRule,
      ]).toEqual(["full", "full"]);
      for (const template of ROLE_TEMPLATES)
        expect(
          template.key === "owner"
            ? isOwnerTemplateBody(template.body)
            : roleBodySchema.safeParse(template.body).success,
          template.key,
        ).toBe(true);
      expect(
        roleBodySchema.safeParse({ ...ADMIN_ROLE.body, directoryRule: "all" })
          .success,
      ).toBe(false);

      // Owner and admin sessions get both keys through every employee route.
      const desk = await position(
        owner,
        "Fictional Rule Desk",
        "POS-RULE",
        unitA,
      );
      for (const p of [owner, teamAdminA]) {
        const created = await call(
          createEmployeeRoute,
          "POST",
          "/api/v1/employees",
          {
            as: p,
            body: {
              displayName: `Fictional Rule ${p.userId}`,
              employeeNumber: `EMP-RULE-${p.userId}`,
              workEmail: "rule.person@example.test",
            },
          },
        );
        const id = created.body.data.id as string;
        const responses = [
          created,
          await call(patchEmployeeRoute, "PATCH", `/api/v1/employees/${id}`, {
            as: p,
            id,
            body: { workPhone: "+971 50 000 0099" },
          }),
          await call(
            putPositionsRoute,
            "PUT",
            `/api/v1/employees/${id}/positions`,
            {
              as: p,
              id,
              body: { positions: [{ positionId: desk.id, primary: true }] },
            },
          ),
          ...(p === owner
            ? [
                await call(
                  patchEmployeeRoute,
                  "PATCH",
                  `/api/v1/employees/${id}`,
                  {
                    as: p,
                    id,
                    body: { userId: null },
                  },
                ),
              ]
            : []),
          await call(
            listEmployeesRoute,
            "GET",
            `/api/v1/employees?positionId=${desk.id}`,
            {
              as: p,
            },
          ),
          await call(patchEmployeeRoute, "PATCH", `/api/v1/employees/${id}`, {
            as: p,
            id,
            body: { archived: true },
          }),
        ];
        for (const response of responses) {
          expect(response.status).toBeLessThan(300);
          for (const data of [response.body.data].flat()) {
            expect(Object.hasOwn(data, "workEmail")).toBe(true);
            expect(Object.hasOwn(data, "workPhone")).toBe(true);
          }
        }
      }
    });
  });

  describe("directory scope and workspace isolation", () => {
    it("gives a recruiter no employee or position row, by service, route and direct SQL", async () => {
      expect(
        (
          await look<{ n: number }>(
            "SELECT count(*)::int AS n FROM app.employee_positions",
          )
        )[0].n,
      ).toBeGreaterThan(0);
      for (const [handler, method, body] of [
        [listEmployeesRoute, "GET", undefined],
        [
          createEmployeeRoute,
          "POST",
          { displayName: "Denied", employeeNumber: "EMP-REC" },
        ],
        [patchEmployeeRoute, "PATCH", { displayName: "Denied" }],
        [putPositionsRoute, "PUT", { positions: [] }],
      ] as const) {
        const response = await call(
          handler as Handler,
          method,
          "/api/v1/employees",
          {
            as: recruiter,
            id: COMPANY,
            body,
          },
        );
        expect([response.status, response.body.error.code], method).toEqual([
          403,
          "directory_forbidden",
        ]);
      }
      expect(
        await sqlAs(
          recruiter,
          "SELECT (SELECT count(*) FROM app.employees)::int AS employees, (SELECT count(*) FROM app.employee_positions)::int AS held",
        ),
      ).toEqual([{ employees: 0, held: 0 }]);
      // Positions are company structure: any session of the workspace reads them, as units.
      expect((await listPositions(recruiter)).data.length).toBeGreaterThan(0);
    });

    it("keeps each workspace's positions, employees and position rows from the other workspace's contexts", async () => {
      // The owner writes the other workspace's rows directly, as the migration owner would.
      await harness.asOwner();
      const [{ id: otherLevel }] = (
        await harness.client.query<{ id: string }>(
          `INSERT INTO app.org_levels(workspace_id, name, depth) VALUES ('${OTHER}', 'Fictional Other Level', 0) RETURNING id`,
        )
      ).rows;
      const [{ id: otherUnit }] = (
        await harness.client.query<{ id: string }>(
          `INSERT INTO app.org_units(workspace_id, level_id, name, code) VALUES ('${OTHER}', '${otherLevel}', 'Fictional Other Unit', 'OTHER-1') RETURNING id`,
        )
      ).rows;
      const [{ id: otherPosition }] = (
        await harness.client.query<{ id: string }>(
          `INSERT INTO app.positions(workspace_id, org_unit_id, title, code) VALUES ('${OTHER}', '${otherUnit}', 'Fictional Other Position', 'OTHER-POS') RETURNING id`,
        )
      ).rows;
      const [{ id: otherEmployee }] = (
        await harness.client.query<{ id: string }>(
          `INSERT INTO app.employees(workspace_id, display_name, employee_number) VALUES ('${OTHER}', 'Fictional Other Person', 'OTHER-EMP') RETURNING id`,
        )
      ).rows;
      await harness.client.query(
        `INSERT INTO app.employee_positions(employee_id, position_id, workspace_id) VALUES ('${otherEmployee}', '${otherPosition}', '${OTHER}')`,
      );
      const visible = (p: Principal) =>
        asContext(p, async (tx) =>
          Object.fromEntries(
            await Promise.all(
              ["positions", "employees", "employee_positions"].map(
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
      const only = (workspace: string) => ({
        positions: [workspace],
        employees: [workspace],
        employee_positions: [workspace],
      });
      const companyPosition = (await listPositions(owner)).data[0].id;
      expect(await visible(ownerX)).toEqual(only(OTHER));
      for (const p of [owner, teamOwnerB, orgAdmin])
        expect(await visible(p)).toEqual(only(COMPANY));
      expect((await listEmployees(ownerX)).data.map((row) => row.id)).toEqual([
        otherEmployee,
      ]);
      expect((await listPositions(ownerX)).data.map((row) => row.id)).toEqual([
        otherPosition,
      ]);
      expect(
        (await listEmployees(owner)).data.map((row) => row.id),
      ).not.toContain(otherEmployee);
      await refusedApi(
        () => listEmployees(owner, { positionId: otherPosition }),
        404,
        "not_found",
      );
      await refusedApi(
        () => updateEmployee(owner, otherEmployee, { displayName: "Denied" }),
        404,
        "not_found",
      );
      await refusedApi(
        () =>
          setEmployeePositions(ownerX, otherEmployee, {
            positions: [{ positionId: unitA, primary: false }],
          }),
        404,
        "not_found",
      );
      for (const [statement, code] of [
        [
          `INSERT INTO app.employee_positions(employee_id, position_id, workspace_id) VALUES ('${otherEmployee}', '${otherPosition}', '${COMPANY}')`,
          "42501",
        ],
        [
          `INSERT INTO app.employee_positions(employee_id, position_id, workspace_id) VALUES ('${otherEmployee}', '${companyPosition}', '${OTHER}')`,
          "23503",
        ],
        [
          `INSERT INTO app.employees(workspace_id, display_name, employee_number) VALUES ('${COMPANY}', 'Denied', 'EMP-X')`,
          "42501",
        ],
        [
          `INSERT INTO app.positions(workspace_id, org_unit_id, title, code) VALUES ('${OTHER}', '${unitA}', 'Denied', 'POS-X')`,
          "23503",
        ],
      ])
        await refused(() => sqlAs(ownerX, statement), code);
      expect(
        await sqlAs(
          owner,
          `UPDATE app.employees SET display_name = 'Denied' WHERE id = '${otherEmployee}' RETURNING id`,
        ),
      ).toEqual([]);
    });
  });

  describe("company admin limits", () => {
    it("lets a company admin with the organisation area manage positions and unlinked employees", async () => {
      const { rows, result } = await audited(async () => {
        const made = await position(
          orgAdmin,
          "Fictional Admin Desk",
          "POS-ADMIN",
          unitA,
        );
        const renamed = await updatePosition(orgAdmin, made.id, {
          title: "Fictional Admin Desk Renamed",
        });
        const person = await createEmployee(orgAdmin, {
          displayName: "Fictional Admin Hire",
          employeeNumber: "EMP-ADMIN-1",
        });
        await updateEmployee(orgAdmin, person.id, { status: "left" });
        const placed = await setEmployeePositions(orgAdmin, person.id, {
          positions: [{ positionId: made.id, primary: true }],
        });
        return { renamed, placed };
      });
      expect(result.renamed.title).toBe("Fictional Admin Desk Renamed");
      expect(result.placed.positions.map((row) => row.title)).toEqual([
        "Fictional Admin Desk Renamed",
      ]);
      expect(
        rows.map((row) => [row.action, row.team_id, row.actor_id]),
      ).toEqual(
        [
          "org.position_created",
          "org.position_updated",
          "directory.employee_created",
          "directory.employee_updated",
          "directory.employee_positions_changed",
        ].map((action) => [action, "dir-team-b", "dir-org-admin"]),
      );
    });

    it("links a job role of the writer's own team only, and shows it to that team only", async () => {
      const [{ id: jobRole }] = await sqlAs(
        owner,
        `INSERT INTO app.records(team_id, kind, data, created_by) VALUES ('dir-team-a', 'job-role', '{"title":"Fictional Payroll Role"}', 'dir-owner') RETURNING id`,
      );
      const [{ id: archivedRole }] = await sqlAs(
        owner,
        `INSERT INTO app.records(team_id, kind, data, created_by, archived_at) VALUES ('dir-team-a', 'job-role', '{"title":"Fictional Old Role"}', 'dir-owner', now()) RETURNING id`,
      );
      const made = await createPosition(owner, {
        title: "Fictional Role Desk",
        code: "POS-ROLE",
        orgUnitId: unitA,
        jobRoleId: jobRole as string,
      });
      expect(made.jobRoleId).toBe(jobRole);
      expect(
        await look(
          "SELECT job_role_team_id, job_role_id FROM app.positions WHERE id = $1",
          [made.id],
        ),
      ).toEqual([{ job_role_team_id: "dir-team-a", job_role_id: jobRole }]);
      const seen = (p: Principal) =>
        listPositions(p, { unitId: unitA }).then(
          (page) => page.data.find((row) => row.id === made.id)?.jobRoleId,
        );
      expect(await seen(teamAdminA)).toBe(jobRole);
      expect(await seen(orgAdmin)).toBeNull();
      // Another team's or an archived job role is not found; null clears the link.
      for (const id of [jobRole, archivedRole])
        await refusedApi(
          () => updatePosition(orgAdmin, made.id, { jobRoleId: id as string }),
          404,
          "not_found",
        );
      await refusedApi(
        () =>
          updatePosition(owner, made.id, { jobRoleId: archivedRole as string }),
        404,
        "not_found",
      );
      expect(
        (await updatePosition(owner, made.id, { jobRoleId: null })).jobRoleId,
      ).toBeNull();
    });

    it("refuses position writes to a fields-only company admin and to team roles", async () => {
      const target = (await listPositions(owner)).data[0];
      for (const p of [fieldsAdmin, teamAdminA, teamOwnerB, recruiter])
        for (const operation of [
          () => position(p, "Denied", "POS-DENIED", unitA),
          () => updatePosition(p, target.id, { title: "Denied" }),
          () => movePosition(p, target.id, { orgUnitId: unitC }),
          () => archivePosition(p, target.id),
        ])
          await refusedApi(operation, 403, "org_forbidden");
      // A team admin with directory:write still manages unlinked employees.
      expect(
        (
          await createEmployee(teamAdminA, {
            displayName: "Fictional Team Hire",
            employeeNumber: "EMP-TEAM-1",
          })
        ).displayName,
      ).toBe("Fictional Team Hire");
    });
  });

  describe("runtime guards", () => {
    let unlinked: Employee, desk: Position;
    beforeAll(async () => {
      desk = await position(owner, "Fictional Guard Desk", "POS-GUARD", unitA);
      unlinked = await employee(owner);
    });

    it("refuses planted dates, fixed-column changes and archived inserts by direct SQL", async () => {
      for (const p of [owner, orgAdmin])
        for (const statement of [
          `INSERT INTO app.positions(workspace_id, org_unit_id, title, code, valid_from) VALUES ('${COMPANY}', '${unitA}', 'Denied', 'POS-DATED', '2999-01-01')`,
          `INSERT INTO app.positions(workspace_id, org_unit_id, title, code, valid_from) VALUES ('${COMPANY}', '${unitA}', 'Denied', 'POS-DATED', '2000-01-01')`,
          `INSERT INTO app.positions(workspace_id, org_unit_id, title, code, valid_to) VALUES ('${COMPANY}', '${unitA}', 'Denied', 'POS-DATED', now())`,
          `INSERT INTO app.positions(workspace_id, org_unit_id, title, code, archived_at) VALUES ('${COMPANY}', '${unitA}', 'Denied', 'POS-DATED', now())`,
          `INSERT INTO app.employee_positions(employee_id, position_id, workspace_id, valid_from) VALUES ('${unlinked.id}', '${desk.id}', '${COMPANY}', '2000-01-01')`,
          `INSERT INTO app.employee_positions(employee_id, position_id, workspace_id, valid_to) VALUES ('${unlinked.id}', '${desk.id}', '${COMPANY}', now())`,
          `UPDATE app.positions SET code = 'POS-RECODED' WHERE id = '${desk.id}'`,
          `UPDATE app.positions SET valid_from = '2000-01-01' WHERE id = '${desk.id}'`,
          `UPDATE app.positions SET valid_to = now() WHERE id = '${desk.id}'`,
          `INSERT INTO app.employees(workspace_id, display_name, employee_number, archived_at) VALUES ('${COMPANY}', 'Denied', 'EMP-ARCHIVED', now())`,
          `UPDATE app.employees SET source = 'excel' WHERE id = '${unlinked.id}'`,
          `UPDATE app.employees SET created_at = '2000-01-01' WHERE id = '${unlinked.id}'`,
        ])
          await refused(() => sqlAs(p, statement), "42501");
      // A position row changes only primary and ends once, at the time it is written.
      await setEmployeePositions(owner, unlinked.id, {
        positions: [{ positionId: desk.id, primary: false }],
      });
      const changes = [
        `UPDATE app.employee_positions SET valid_from = '2000-01-01' WHERE employee_id = '${unlinked.id}'`,
        `UPDATE app.employee_positions SET position_id = '${desk.id}', employee_id = '${unlinked.id}', workspace_id = '${OTHER}' WHERE employee_id = '${unlinked.id}'`,
      ];
      for (const statement of changes)
        await refused(() => sqlAs(orgAdmin, statement), "42501");
      await sqlAs(
        orgAdmin,
        `UPDATE app.employee_positions SET valid_to = '2999-01-01' WHERE employee_id = '${unlinked.id}'`,
      );
      const [ended] = await look<{ valid_to: Date }>(
        "SELECT valid_to FROM app.employee_positions WHERE employee_id = $1",
        [unlinked.id],
      );
      expect(ended.valid_to.getTime()).toBeLessThan(Date.now() + 60_000);
      await refused(
        () =>
          sqlAs(
            orgAdmin,
            `UPDATE app.employee_positions SET valid_to = now() WHERE employee_id = '${unlinked.id}'`,
          ),
        "42501",
      );
      // Archiving is one-way, for the owner session too.
      await archiveEmployee(owner, unlinked.id);
      await refused(
        () =>
          sqlAs(
            owner,
            `UPDATE app.employees SET archived_at = NULL WHERE id = '${unlinked.id}'`,
          ),
        "42501",
      );
    });

    it("refuses org and directory writes in a transaction that is not read committed", async () => {
      const leaf = await createOrgUnit(owner, {
        name: "Fictional Isolation Leaf",
        code: "ISO-LEAF",
        levelId: levels[2].id,
        parentId: unitB,
      });
      const probe = (
        level: "read committed" | "repeatable read" | "serializable",
        statement: string,
      ) =>
        harness.dataDb().then((db) =>
          db.transaction(
            async (tx) => {
              const [snapshot] = (
                await tx.execute<TransactionSnapshot>(
                  sql.raw(DEADLINES_AND_SNAPSHOT_SQL),
                )
              ).rows;
              await installTenantContext(tx, owner, snapshot);
              const result = await tx.execute(sql.raw(statement));
              throw new RolledBack(result.rows.length);
            },
            { isolationLevel: level },
          ),
        );
      const statements = [
        `INSERT INTO app.org_units(workspace_id, level_id, name, code, parent_id) VALUES ('${COMPANY}', '${levels[2].id}', 'Fictional Iso Unit', 'ISO-NEW', '${unitB}') RETURNING id`,
        `UPDATE app.org_units SET parent_id = '${unitA}' WHERE id = '${leaf.id}' RETURNING id`,
        `UPDATE app.org_units SET archived_at = now() WHERE id = '${leaf.id}' RETURNING id`,
        `INSERT INTO app.positions(workspace_id, org_unit_id, title, code) VALUES ('${COMPANY}', '${unitA}', 'Fictional Iso Position', 'ISO-POS') RETURNING id`,
        `INSERT INTO app.employees(workspace_id, display_name, employee_number) VALUES ('${COMPANY}', 'Fictional Iso Person', 'ISO-EMP') RETURNING id`,
        `INSERT INTO app.employee_positions(employee_id, position_id, workspace_id) VALUES ('${unlinked.id}', '${desk.id}', '${COMPANY}') RETURNING employee_id`,
      ];
      const units = () => look("SELECT * FROM app.org_units ORDER BY id");
      const before = await units();
      for (const level of ["repeatable read", "serializable"] as const)
        for (const statement of statements)
          await refused(() => probe(level, statement), "42501");
      for (const statement of statements)
        await expect(
          probe("read committed", statement),
          statement,
        ).rejects.toMatchObject({ count: 1 });
      expect(await units()).toEqual(before);
    });
  });

  describe("directory filters at scale", () => {
    // A fictional 500-unit tree on six levels, built by the data role under the owner's context.
    const COUNTS = [2, 8, 30, 80, 160, 220];
    const tree: string[][] = [];
    const parentOf = new Map<string, string | null>();
    const levelOf = new Map<string, number>();
    /** Each scale employee by name, with the unit and position of their current position. */
    const staff: {
      id: string;
      name: string;
      unit: string;
      position: string;
      left: boolean;
    }[] = [];
    const below = (unit: string, id: string) => {
      for (let at: string | null | undefined = id; at; at = parentOf.get(at))
        if (at === unit) return true;
      return false;
    };
    const page = async (query: string) => {
      const response = await call(
        listEmployeesRoute,
        "GET",
        `/api/v1/employees?pageSize=200&${query}`,
        { as: owner },
      );
      expect(response.status, query).toBe(200);
      expect(response.body.pagination.hasMore).toBe(false);
      return (response.body.data as Employee[]).map((row) => row.id);
    };
    /** The ids of the matching staff, once each, in display-name order as the directory lists them. */
    const expected = (match: (person: (typeof staff)[number]) => boolean) =>
      [
        ...new Map(
          staff.filter(match).map((person) => [person.id, person]),
        ).values(),
      ]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((person) => person.id);

    beforeAll(async () => {
      for (const [depth, count] of COUNTS.entries()) {
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
        ids.forEach((id, g) => {
          parentOf.set(id, depth === 0 ? null : parents[g % parents.length]);
          levelOf.set(id, depth);
        });
        tree.push(ids);
      }
      // One position in each of 85 units across the levels, one employee in each, every seventh left.
      const units = [
        ...tree[5].slice(0, 60),
        ...tree[4].slice(0, 20),
        ...tree[2].slice(0, 4),
        tree[0][1],
      ];
      await asContext(owner, async (tx) => {
        const { rows: positions } = await tx.execute<{
          id: string;
          unit: string;
        }>(sql`
          insert into app.positions(workspace_id, org_unit_id, title, code)
          select ${COMPANY}::uuid, u, 'Fictional scale position ' || n, 'SCALE-POS-' || n
          from unnest(${`{${units.join(",")}}`}::uuid[]) with ordinality t(u, n) order by n
          returning id, org_unit_id as unit`);
        const { rows: employees } = await tx.execute<{
          id: string;
          name: string;
          status: string;
        }>(sql`
          insert into app.employees(workspace_id, display_name, employee_number, status)
          select ${COMPANY}::uuid, 'Fictional Scale Person ' || lpad(n::text, 3, '0'), 'SCALE-EMP-' || n,
            case when n % 7 = 0 then 'left' else 'active' end
          from generate_series(1, ${sql.raw(String(units.length))}) n order by n
          returning id, display_name as name, status`);
        await tx.execute(sql`
          insert into app.employee_positions(employee_id, position_id, workspace_id, "primary")
          select e, p, ${COMPANY}::uuid, true
          from unnest(${`{${employees.map((row) => row.id).join(",")}}`}::uuid[], ${`{${positions.map((row) => row.id).join(",")}}`}::uuid[]) t(e, p)`);
        employees.forEach((row, index) =>
          staff.push({
            id: row.id,
            name: row.name,
            unit: positions[index].unit,
            position: positions[index].id,
            left: row.status === "left",
          }),
        );
      });
      // Not matched: an ended position row, a position that is archived, an archived employee.
      const last = tree[5][219];
      const [ended, archived, gone] = [
        await employee(owner),
        await employee(owner),
        staff[3],
      ];
      const lastDesk = await position(
        owner,
        "Fictional scale last",
        "SCALE-LAST",
        last,
      );
      const archivedDesk = await position(
        owner,
        "Fictional scale archived",
        "SCALE-ARCH",
        last,
      );
      await setEmployeePositions(owner, ended.id, {
        positions: [{ positionId: lastDesk.id, primary: true }],
      });
      await setEmployeePositions(owner, ended.id, { positions: [] });
      await setEmployeePositions(owner, archived.id, {
        positions: [{ positionId: archivedDesk.id, primary: true }],
      });
      await archivePosition(owner, archivedDesk.id);
      await archiveEmployee(owner, gone.id);
      staff.splice(3, 1);
      // A second current position for the first person, in another branch: still listed once.
      await asContext(owner, (tx) =>
        tx.execute(
          sql`insert into app.employee_positions(employee_id, position_id, workspace_id) values (${staff[0].id}::uuid, ${lastDesk.id}::uuid, ${COMPANY}::uuid)`,
        ),
      );
      staff.push({ ...staff[0], unit: last, position: lastDesk.id });
    });

    it("builds the fixture on 500 units", () => {
      expect(tree.flat()).toHaveLength(500);
      expect(staff.length).toBeGreaterThan(80);
    });

    it("filters by unit including every unit below it, through the closure", async () => {
      for (const unit of [
        tree[0][0],
        tree[0][1],
        tree[1][0],
        tree[2][1],
        tree[4][3],
        tree[5][219],
        tree[5][7],
      ]) {
        const ids = await page(`unitId=${unit}`);
        expect(ids, unit).toEqual(
          expected((person) => below(unit, person.unit)),
        );
      }
      expect((await page(`unitId=${tree[1][0]}`)).length).toBeGreaterThan(5);
      expect(await page(`unitId=${tree[5][219]}`)).toEqual([staff[0].id]);
    });

    it("filters by level, position and status, alone and together", async () => {
      for (const depth of [2, 4, 5])
        expect(
          await page(`levelId=${levels[depth].id}`),
          String(depth),
        ).toEqual(expected((person) => levelOf.get(person.unit) === depth));
      expect(await page(`positionId=${staff[10].position}`)).toEqual([
        staff[10].id,
      ]);
      expect(await page(`unitId=${tree[0][0]}&status=left`)).toEqual(
        expected((person) => person.left && below(tree[0][0], person.unit)),
      );
      expect(
        await page(
          `levelId=${levels[5].id}&status=active&unitId=${tree[1][1]}`,
        ),
      ).toEqual(
        expected(
          (person) =>
            !person.left &&
            levelOf.get(person.unit) === 5 &&
            below(tree[1][1], person.unit),
        ),
      );
      const left = await look<{ id: string }>(
        "SELECT id FROM app.employees WHERE workspace_id = $1 AND status = 'left' AND archived_at IS NULL ORDER BY display_name, id",
        [COMPANY],
      );
      expect(await page("status=left")).toEqual(left.map((row) => row.id));
      expect(staff.filter((person) => person.left).length).toBeGreaterThan(5);
    });
  });
});

describe("one directory page in database round trips", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal;
  let unit: string;

  beforeAll(async () => {
    fixture = await createTestDb();
    pools.data.mockImplementation(async () => fixture.db);
    pools.identity.mockImplementation(async () => fixture.db);
    owner = await seedIdentity(fixture.db, {
      userId: "dir-budget-owner",
      teamId: "dir-budget-team",
    });
    const level = await createOrgLevel(owner, {
      name: "Fictional Holdings",
      depth: 0,
    });
    unit = (
      await createOrgUnit(owner, {
        name: "Fictional Holdings",
        code: "FH",
        levelId: level.id,
      })
    ).id;
    const desk = await createPosition(owner, {
      title: "Fictional Desk",
      code: "FD",
      orgUnitId: unit,
    });
    for (const index of [1, 2, 3]) {
      const person = await createEmployee(owner, {
        displayName: `Fictional Person ${index}`,
        employeeNumber: `FP-${index}`,
      });
      await setEmployeePositions(owner, person.id, {
        positions: [{ positionId: desk.id, primary: true }],
      });
    }
  });
  afterAll(async () => fixture?.close());

  it("reads one page of employees under a unit in at most 6 round trips", async () => {
    const response = await call(
      listEmployeesRoute,
      "GET",
      `/api/v1/employees?unitId=${unit}&status=active`,
      { as: owner },
    );
    expect(response.status).toBe(200);
    expect(
      (response.body.data as Employee[]).map((row) => row.displayName),
    ).toEqual([
      "Fictional Person 1",
      "Fictional Person 2",
      "Fictional Person 3",
    ]);
    expect(response.roundTrips).toBeLessThanOrEqual(6);
  });
});
