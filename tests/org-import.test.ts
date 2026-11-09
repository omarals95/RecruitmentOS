import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
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
// The real parser, wrapped so a test can see whether it ran.
vi.mock("read-excel-file/node", async (original) => {
  const actual = await original<typeof import("read-excel-file/node")>();
  return { ...actual, default: vi.fn(actual.default) };
});

import readXlsx from "read-excel-file/node";
import writeXlsx from "write-excel-file/node";
import type { TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import { getVerifiedSession } from "@/lib/auth-session";
import {
  archiveEmployee,
  createEmployee,
  createPosition,
  linkEmployeeUser,
  setEmployeePositions,
} from "@/lib/directory";
import { listActivity } from "@/lib/insights";
import { XLSX_TYPE } from "@/domain/org";
import { createOrgLevel, createOrgUnit, type OrgLevel } from "@/lib/org";
import {
  applyImportSheet,
  checkWorkbookArchive,
  parseWorkbook,
  type ImportSheet,
} from "@/lib/org-import";
import type { Principal } from "@/lib/principal";
import { installTenantContext, type TenantAccess } from "@/lib/tenant-context";
import { POST as dryRunRoute } from "@/app/api/v1/org-import/dry-run/route";
import { POST as applyRoute } from "@/app/api/v1/org-import/apply/route";
import { createSplitRoleDb, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace with fictional teams, people, units, positions and
// employees, and fictional workbooks built here (R2a-17).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const ORIGIN = "http://localhost:3000";
const UNIT_COLUMNS = ["Code", "Name", "Level", "Parent code"];
const POSITION_COLUMNS = ["Code", "Title", "Unit code", "Manager"];
const EMPLOYEE_COLUMNS = [
  "Employee number",
  "Name",
  "Work email",
  "Work phone",
  "Position codes",
  "Primary position",
];
const TABLES = {
  org_units: "id",
  org_unit_closure: "ancestor_id, descendant_id",
  positions: "id",
  employees: "id",
  employee_positions: "employee_id, position_id, valid_from",
  activity: "id",
};
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Cell = string | number | boolean | Date | null;
type Sheets = Partial<Record<ImportSheet, Cell[][]>>;

/** A fictional .xlsx workbook; each sheet's first row is its header. */
async function workbook(sheets: Sheets): Promise<Buffer> {
  return writeXlsx(
    Object.entries(sheets).map(([sheet, rows]) => ({
      sheet,
      data: rows.map((row) =>
        row.map((value) =>
          value === null
            ? null
            : value instanceof Date
              ? { value, format: "yyyy-mm-dd" }
              : { value },
        ),
      ),
    })),
  ).toBuffer();
}
/** A zip holding only a central directory, for the archive checks that run before parsing. */
function centralDirectory(entries: { name: string; size: number }[]) {
  const records = entries.map(({ name, size }) => {
    const bytes = Buffer.from(name);
    const record = Buffer.alloc(46 + bytes.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(Math.ceil(size / 1000) || 1, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(bytes.length, 28);
    bytes.copy(record, 46);
    return record;
  });
  const directory = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(0, 16);
  return Buffer.concat([directory, end]);
}
/**
 * A zip with local headers, data and a central directory. local overrides the sizes the local
 * header declares; streamed writes bit 3 with zero local sizes and a data descriptor after the data.
 */
function zip(
  entries: {
    name: string;
    data: Buffer;
    method: 0 | 8;
    expanded: number;
    local?: { compressed: number; expanded: number };
    streamed?: boolean;
  }[],
) {
  const parts: Buffer[] = [];
  const records: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const flags = entry.streamed ? 0x08 : 0;
    const header = Buffer.alloc(30 + name.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(entry.method, 8);
    if (!entry.streamed) {
      header.writeUInt32LE(entry.local?.compressed ?? entry.data.length, 18);
      header.writeUInt32LE(entry.local?.expanded ?? entry.expanded, 22);
    }
    header.writeUInt16LE(name.length, 26);
    name.copy(header, 30);
    const descriptor = Buffer.alloc(entry.streamed ? 16 : 0);
    if (entry.streamed) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(entry.data.length, 8);
      descriptor.writeUInt32LE(entry.expanded, 12);
    }
    const record = Buffer.alloc(46 + name.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(entry.method, 10);
    record.writeUInt32LE(entry.data.length, 20);
    record.writeUInt32LE(entry.expanded, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    name.copy(record, 46);
    parts.push(header, entry.data, descriptor);
    records.push(record);
    offset += header.length + entry.data.length + descriptor.length;
  }
  const directory = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const signIn = (p: Principal) =>
  vi.mocked(getVerifiedSession).mockResolvedValue({
    user: { id: p.userId, twoFactorEnabled: true },
    session: { activeOrganizationId: p.teamId },
  } as never);

/** One import request, as a signed-in member or with a Bearer token. */
async function post(
  route: "dry-run" | "apply",
  body: Uint8Array,
  options: {
    as?: Principal;
    bearer?: string;
    query?: string;
    type?: string;
  },
) {
  if (options.as) signIn(options.as);
  const response = await (route === "dry-run" ? dryRunRoute : applyRoute)(
    new Request(`${ORIGIN}/api/v1/org-import/${route}${options.query ?? ""}`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": options.type ?? XLSX_TYPE,
        ...(options.as ? { "x-team-id": options.as.teamId } : {}),
        ...(options.bearer
          ? { authorization: `Bearer ${options.bearer}` }
          : {}),
      },
      body: new Uint8Array(body),
    }),
  );
  return {
    status: response.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: (await response.json()) as any,
  };
}
const dryRun = (body: Uint8Array, as: Principal) =>
  post("dry-run", body, { as });
const apply = (body: Uint8Array, as: Principal, group?: "owner") =>
  post("apply", body, {
    as,
    query: `?sha256=${sha(body)}${group ? `&group=${group}` : ""}`,
  });

describe("organisation import from Excel", () => {
  let harness: Harness;
  let owner: Principal, teamAdminA: Principal, teamOwnerB: Principal;
  let orgAdmin: Principal, recruiterOrgAdmin: Principal;
  let viewerOrgAdmin: Principal, fieldsAdmin: Principal, person: Principal;
  let levels: OrgLevel[];

  /** Raw reads as the PGlite superuser, which bypasses RLS; only to inspect outcomes. */
  const look = async <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  /** Every row of the tables an import can touch, in a stable order. */
  const state = async () => {
    const tables: Record<string, unknown[]> = {};
    for (const [table, order] of Object.entries(TABLES))
      tables[table] = await look(
        `SELECT * FROM app.${table} ORDER BY ${order}`,
      );
    return tables;
  };
  const unit = async (code: string) =>
    (
      await look<{ id: string; name: string; parent_id: string | null }>(
        "SELECT id, name, parent_id FROM app.org_units WHERE code = $1 AND valid_to IS NULL AND archived_at IS NULL",
        [code],
      )
    )[0];
  const position = async (code: string) =>
    (
      await look<{ id: string; title: string; org_unit_id: string }>(
        "SELECT id, title, org_unit_id FROM app.positions WHERE code = $1 AND valid_to IS NULL AND archived_at IS NULL",
        [code],
      )
    )[0];
  const employee = async (number: string) =>
    (
      await look<{
        id: string;
        display_name: string;
        work_phone: string | null;
        source: string;
        user_id: string | null;
      }>(
        "SELECT id, display_name, work_phone, source, user_id FROM app.employees WHERE employee_number = $1",
        [number],
      )
    )[0];
  const holding = async (number: string) =>
    (
      await look<{ code: string; primary: boolean }>(
        `SELECT p.code, ep."primary" FROM app.employee_positions ep JOIN app.employees e ON e.id = ep.employee_id JOIN app.positions p ON p.id = ep.position_id WHERE e.employee_number = $1 AND ep.valid_to IS NULL ORDER BY p.code`,
        [number],
      )
    ).map((row) => `${row.code}${row.primary ? "*" : ""}`);
  /** One data-role transaction under the principal's verified context. */
  const asContext = <T>(
    principal: Principal,
    work: (tx: TeamTx, access: TenantAccess) => Promise<T>,
  ) =>
    harness
      .dataDb()
      .then((db) =>
        withDeadlinesAndSnapshot(db, async (tx, snapshot) =>
          work(tx, await installTenantContext(tx, principal, snapshot)),
        ),
      );
  /** Expects one refusal on the route, with no row of any import table changed. */
  async function refused(
    call: () => ReturnType<typeof post>,
    status: number,
    code: string,
  ) {
    const before = await state();
    const response = await call();
    expect([response.status, response.body.error?.code]).toEqual([
      status,
      code,
    ]);
    expect(await state()).toEqual(before);
    return response;
  }

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, { userId: "imp-owner", teamId: "imp-a" });
    teamAdminA = await seedIdentity(db, {
      userId: "imp-team-admin",
      teamId: "imp-a",
      role: "admin",
    });
    teamOwnerB = await seedIdentity(db, {
      userId: "imp-owner-b",
      teamId: "imp-b",
    });
    orgAdmin = await seedIdentity(db, {
      userId: "imp-org-admin",
      teamId: "imp-b",
      role: "admin",
    });
    recruiterOrgAdmin = await seedIdentity(db, {
      userId: "imp-org-recruiter",
      teamId: "imp-b",
      role: "recruiter",
    });
    viewerOrgAdmin = await seedIdentity(db, {
      userId: "imp-org-viewer",
      teamId: "imp-b",
      role: "viewer",
    });
    fieldsAdmin = await seedIdentity(db, {
      userId: "imp-fields-admin",
      teamId: "imp-b",
      role: "admin",
    });
    person = await seedIdentity(db, {
      userId: "imp-person",
      teamId: "imp-a",
      role: "viewer",
    });
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','imp-org-admin','admin','{organisation}'),
        ('${COMPANY}','imp-org-recruiter','admin','{organisation}'),
        ('${COMPANY}','imp-org-viewer','admin','{organisation}'),
        ('${COMPANY}','imp-fields-admin','admin','{fields}');
    `);
    levels = [];
    for (const [depth, name] of ["Company", "Division", "Team"].entries())
      levels.push(
        await createOrgLevel(owner, { name: `Fictional ${name}`, depth }),
      );
    const hq = await createOrgUnit(owner, {
      name: "Fictional Holdings",
      code: "HQ",
      levelId: levels[0].id,
    });
    await createOrgUnit(owner, {
      name: "Sample Group",
      code: "HQ2",
      levelId: levels[0].id,
    });
    const divA = await createOrgUnit(owner, {
      name: "Sample Division",
      code: "DIV-A",
      levelId: levels[1].id,
      parentId: hq.id,
    });
    const divB = await createOrgUnit(owner, {
      name: "Fictional Operations",
      code: "DIV-B",
      levelId: levels[1].id,
      parentId: hq.id,
    });
    const lead = await createPosition(owner, {
      title: "Fictional Lead",
      code: "P-LEAD",
      orgUnitId: divA.id,
    });
    const held = await createPosition(owner, {
      title: "Fictional Analyst",
      code: "P-HELD",
      orgUnitId: divA.id,
    });
    await createPosition(owner, {
      title: "Fictional Coordinator",
      code: "P-OPS",
      orgUnitId: divB.id,
    });
    const first = await createEmployee(owner, {
      displayName: "Fictional Employee One",
      employeeNumber: "E-1",
    });
    await setEmployeePositions(owner, first.id, {
      positions: [{ positionId: lead.id, primary: true }],
    });
    await createEmployee(owner, {
      displayName: "Fictional Employee Seven",
      employeeNumber: "E-7",
    });
    const linked = await createEmployee(owner, {
      displayName: "Fictional Linked Employee",
      employeeNumber: "E-LINKED",
    });
    await linkEmployeeUser(owner, linked.id, { userId: person.userId });
    await setEmployeePositions(owner, linked.id, {
      positions: [{ positionId: held.id, primary: true }],
    });
    const gone = await createEmployee(owner, {
      displayName: "Fictional Former Employee",
      employeeNumber: "E-ARCH",
    });
    await archiveEmployee(owner, gone.id);
  });
  afterAll(async () => harness?.close());

  /** The main fictional workbook: matching, new, changed and refused rows on every sheet. */
  const main = () =>
    workbook({
      Units: [
        UNIT_COLUMNS,
        ["HQ", "Fictional Holdings", "Fictional Company", null],
        ["DIV-A", "Sample Division West", "fictional division", "HQ"],
        ["TEAM-1", "Fictional Team One", "Fictional Team", "DIV-A"],
        ["BAD-LVL", "Fictional Region", "Fictional Region", "HQ"],
        ["ORPHAN", "Fictional Orphan", "Fictional Team", "NOPE"],
        ["CYC-1", "Fictional Loop One", "Fictional Division", "CYC-2"],
        ["CYC-2", "Fictional Loop Two", "Fictional Team", "CYC-1"],
        ["DUP", "Fictional Twin", "Fictional Team", "DIV-A"],
        ["DUP", "Fictional Twin Again", "Fictional Team", "DIV-A"],
      ],
      Positions: [
        POSITION_COLUMNS,
        ["P-LEAD", "Fictional Lead", "DIV-A", null],
        ["P-OPS", "Fictional Operations Coordinator", "DIV-B", "yes"],
        ["P-NEW", "Fictional Planner", "TEAM-1", "no"],
        ["P-LOST", "Fictional Lost", "NOPE", null],
      ],
      Employees: [
        EMPLOYEE_COLUMNS,
        ["E-1", "Fictional Employee One", null, null, "P-LEAD", "P-LEAD"],
        [
          "E-2",
          "Fictional Employee Two",
          "two@example.test",
          "+00 0000 0002",
          "P-NEW",
          "P-NEW",
        ],
        ["E-3", "Fictional Employee Three", "not-an-email", null, null, null],
        ["E-4", "Fictional Employee Four", null, "0".repeat(101), null, null],
        ["E-5", "Fictional Employee Five", null, null, "P-UNKNOWN", null],
        [
          "E-6",
          "Fictional Employee Six",
          null,
          null,
          "P-NEW; P-LEAD",
          "P-NEW, P-LEAD",
        ],
        ["E-7", "Fictional Employee Seventh", null, null, null, null],
        ["E-ARCH", "Fictional Former Employee", null, null, null, null],
        [null, null, null, null, null, null],
      ],
    });

  it("dry-runs with counts and a reason per rejected row, and changes no row", async () => {
    const file = await main();
    const before = await state();
    const response = await dryRun(file, owner);
    expect(response.status).toBe(200);
    expect(await state()).toEqual(before);
    const { data } = response.body;
    expect(data.sha256).toBe(sha(file));
    expect(data.sheets).toEqual({
      units: { create: 1, update: 1, unchanged: 1, reject: 6, needsOwner: 0 },
      positions: {
        create: 1,
        update: 1,
        unchanged: 1,
        reject: 1,
        needsOwner: 0,
      },
      employees: {
        create: 1,
        update: 1,
        unchanged: 1,
        reject: 5,
        needsOwner: 0,
      },
    });
    expect(
      data.rejected.map((issue: { sheet: string; row: number }) => [
        issue.sheet,
        issue.row,
      ]),
    ).toEqual([
      ["Units", 5],
      ["Units", 6],
      ["Units", 7],
      ["Units", 8],
      ["Units", 9],
      ["Units", 10],
      ["Positions", 5],
      ["Employees", 4],
      ["Employees", 5],
      ["Employees", 6],
      ["Employees", 7],
      ["Employees", 9],
    ]);
    expect(
      data.rejected.map((issue: { reason: string }) => issue.reason),
    ).toEqual([
      'Unit BAD-LVL: unknown level "Fictional Region".',
      "Unit ORPHAN: missing parent; no unit has the code NOPE.",
      "Unit CYC-1: cyclic parent; its parent codes lead back to it.",
      "Unit CYC-2: cyclic parent; its parent codes lead back to it.",
      "Unit DUP: duplicate code; it is on more than one row.",
      "Unit DUP: duplicate code; it is on more than one row.",
      "Position P-LOST: unknown unit code NOPE.",
      "Employee E-3: Work email is not a valid email address.",
      "Employee E-4: Work phone must be at most 100 characters.",
      "Employee E-5: unknown position code P-UNKNOWN.",
      "Employee E-6: more than one primary position.",
      "Employee E-ARCH: archived employee; the import does not change archived employees.",
    ]);
    expect(data.needsOwner).toEqual([]);
    expect(data.flagged).toEqual([
      { sheet: "Employees", row: 3, column: "Work phone" },
    ]);
    expect(data.truncated).toBe(false);
  });

  it("refuses callers without company authority and the organisation area, without directory write for employees, and every token", async () => {
    const file = await main();
    const query = `?sha256=${sha(file)}`;
    for (const route of ["dry-run", "apply"] as const) {
      for (const as of [teamOwnerB, fieldsAdmin])
        await refused(
          () => post(route, file, { as, query }),
          403,
          "org_forbidden",
        );
      await refused(
        () => post(route, file, { as: recruiterOrgAdmin, query }),
        403,
        "directory_forbidden",
      );
      // An API token and an MCP OAuth token are both Bearer credentials.
      for (const bearer of ["fictional-api-token", "fictional-oauth-token"])
        await refused(
          () => post(route, file, { bearer, query }),
          403,
          "session_required",
        );
    }
    // Without employee rows the recruiter's company admin role checks units and positions; a role
    // with none of the write scopes the activity policy needs can check a file but not apply it.
    const units = await workbook({
      Units: [
        UNIT_COLUMNS,
        ["HQ", "Fictional Holdings", "Fictional Company", null],
      ],
    });
    expect((await dryRun(units, recruiterOrgAdmin)).status).toBe(200);
    expect((await dryRun(units, viewerOrgAdmin)).status).toBe(200);
    await refused(
      () => apply(units, viewerOrgAdmin),
      403,
      "org_import_forbidden",
    );
  });

  it("refuses a file that is not the one the dry run checked, a malformed sha256 and other content types", async () => {
    const file = await main();
    await refused(
      () =>
        post("apply", file, {
          as: owner,
          query: `?sha256=${"0".repeat(64)}`,
        }),
      409,
      "import_file_changed",
    );
    for (const query of ["", "?sha256=abc", `?sha256=${sha(file)}&group=all`])
      await refused(
        () => post("apply", file, { as: owner, query }),
        400,
        "invalid_input",
      );
    await refused(
      () => post("dry-run", file, { as: owner, type: "application/json" }),
      415,
      "xlsx_required",
    );
  });

  it("applies exactly the counted rows, marks new employees as from Excel, and changes nothing the second time", async () => {
    const file = await main();
    const before = await state();
    const first = await apply(file, owner);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      sha256: sha(file),
      group: "normal",
      sheets: {
        units: { create: 1, update: 1, unchanged: 1, reject: 6 },
        positions: { create: 1, update: 1, unchanged: 1, reject: 1 },
        employees: { create: 1, update: 1, unchanged: 1, reject: 5 },
      },
    });
    expect(first.body.data.rejected).toHaveLength(12);
    const after = await state();
    for (const table of ["org_units", "positions", "employees"])
      expect(after[table].length, table).toBe(before[table].length + 1);
    const divA = await unit("DIV-A");
    expect(divA.name).toBe("Sample Division West");
    expect((await unit("TEAM-1")).parent_id).toBe(divA.id);
    expect((await position("P-OPS")).title).toBe(
      "Fictional Operations Coordinator",
    );
    expect(
      await look("SELECT is_manager FROM app.positions WHERE code = 'P-OPS'"),
    ).toEqual([{ is_manager: true }]);
    expect((await position("P-NEW")).org_unit_id).toBe(
      (await unit("TEAM-1")).id,
    );
    expect(await employee("E-2")).toMatchObject({
      source: "excel",
      user_id: null,
      work_phone: "+00 0000 0002",
    });
    expect(await holding("E-2")).toEqual(["P-NEW*"]);
    expect(await employee("E-7")).toMatchObject({
      display_name: "Fictional Employee Seventh",
      source: "app",
    });
    expect(await holding("E-1")).toEqual(["P-LEAD*"]);

    const again = await apply(file, owner);
    expect(again.status).toBe(200);
    const unchanged = (reject: number) => ({
      create: 0,
      update: 0,
      unchanged: 3,
      reject,
      needsOwner: 0,
    });
    expect(again.body.data.sheets).toEqual({
      units: unchanged(6),
      positions: unchanged(1),
      employees: unchanged(5),
    });
    expect(await state()).toEqual(after);
  });

  it("writes one audit row per sheet with counts only, shown only to company authority", async () => {
    const rows = await look<{
      team_id: string;
      actor_id: string;
      actor_type: string;
      token_id: string | null;
      record_id: string | null;
      action: string;
      summary: string;
      metadata: Record<string, unknown>;
    }>(
      "SELECT team_id, actor_id, actor_type, token_id, record_id, action, summary, metadata FROM app.activity WHERE kind = 'org-import' ORDER BY created_at, id",
    );
    expect(rows.map((row) => row.summary)).toEqual([
      "Imported units from Excel",
      "Imported positions from Excel",
      "Imported employees from Excel",
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        team_id: owner.teamId,
        actor_id: owner.userId,
        actor_type: "session",
        token_id: null,
        record_id: null,
        action: "org-import.applied",
      });
      expect(Object.keys(row.metadata).sort()).toEqual([
        "created",
        "group",
        "rejected",
        "sheet",
        "unchanged",
        "updated",
        "workspaceId",
      ]);
    }
    expect(rows[0].metadata).toEqual({
      workspaceId: COMPANY,
      sheet: "units",
      group: "normal",
      created: 1,
      updated: 1,
      unchanged: 1,
      rejected: 6,
    });
    // No metadata value is a code, name, email, phone or employee number of the workbook.
    const book = await parseWorkbook(await main());
    const facts = new Set<unknown>(
      [...book.units, ...book.positions, ...book.employees].flatMap((row) =>
        Object.values(row)
          .flat()
          .filter((value) => typeof value === "string"),
      ),
    );
    for (const row of rows)
      for (const value of Object.values(row.metadata))
        expect(facts.has(value), String(value)).toBe(false);
    const feed = (p: Principal) =>
      listActivity(p, new URLSearchParams({ search: "from Excel" }));
    expect((await feed(owner)).pagination.total).toBe(3);
    expect((await feed(teamAdminA)).pagination.total).toBe(0);
  });

  it("stores formula-like cells as plain text and flags them", async () => {
    const file = await workbook({
      Units: [UNIT_COLUMNS, ["-U9", "=1+1", "Fictional Team", "DIV-A"]],
      Positions: [POSITION_COLUMNS, ["P-AT", "@cmd", "-U9", null]],
      Employees: [
        EMPLOYEE_COLUMNS,
        [
          "E-PLUS",
          "Fictional Employee Plus",
          null,
          "+971 50 000 0000",
          "P-AT",
          null,
        ],
      ],
    });
    const flagged = [
      { sheet: "Units", row: 2, column: "Code" },
      { sheet: "Units", row: 2, column: "Name" },
      { sheet: "Positions", row: 2, column: "Title" },
      { sheet: "Positions", row: 2, column: "Unit code" },
      { sheet: "Employees", row: 2, column: "Work phone" },
    ];
    const dry = await dryRun(file, owner);
    expect(dry.body.data.flagged).toEqual(flagged);
    expect(dry.body.data.rejected).toEqual([]);
    const applied = await apply(file, owner);
    expect(applied.body.data.flagged).toEqual(flagged);
    expect((await unit("-U9")).name).toBe("=1+1");
    expect(await position("P-AT")).toMatchObject({
      title: "@cmd",
      org_unit_id: (await unit("-U9")).id,
    });
    expect(await employee("E-PLUS")).toMatchObject({
      work_phone: "+971 50 000 0000",
      source: "excel",
    });
    expect(await holding("E-PLUS")).toEqual(["P-AT"]);
  });

  it("leaves scope-moving rows to a company owner's separate step, which the database also enforces", async () => {
    const file = await workbook({
      Units: [
        UNIT_COLUMNS,
        ["DIV-B", "Fictional Operations", "Fictional Division", "HQ2"],
      ],
      Positions: [
        POSITION_COLUMNS,
        ["P-HELD", "Fictional Analyst", "DIV-B", null],
      ],
      Employees: [
        EMPLOYEE_COLUMNS,
        [
          "E-LINKED",
          "Fictional Linked Employee",
          null,
          null,
          "P-LEAD",
          "P-LEAD",
        ],
      ],
    });
    const dry = await dryRun(file, orgAdmin);
    expect(dry.status).toBe(200);
    expect(dry.body.data.needsOwner).toEqual([
      {
        sheet: "Units",
        row: 2,
        reason: "Unit DIV-B: moves the unit to another parent.",
      },
      {
        sheet: "Positions",
        row: 2,
        reason:
          "Position P-HELD: moves a position that an employee linked to a user holds.",
      },
      {
        sheet: "Employees",
        row: 2,
        reason:
          "Employee E-LINKED: changes the positions of an employee linked to a user.",
      },
    ]);
    for (const sheet of ["units", "positions", "employees"])
      expect(dry.body.data.sheets[sheet]).toEqual({
        create: 0,
        update: 0,
        unchanged: 0,
        reject: 0,
        needsOwner: 1,
      });
    for (const as of [owner, orgAdmin]) {
      const before = await state();
      const response = await apply(file, as);
      expect(response.status).toBe(200);
      expect(response.body.data.needsOwner).toHaveLength(3);
      expect(await state()).toEqual(before);
    }
    await refused(
      () => apply(file, orgAdmin, "owner"),
      403,
      "org_owner_required",
    );
    // With the service's owner check bypassed, app.guard_scope_sources refuses each sheet's write.
    const book = await parseWorkbook(file);
    for (const sheet of ["Units", "Positions", "Employees"] as const) {
      const before = await state();
      await expect(
        asContext(orgAdmin, (tx, access) =>
          applyImportSheet(tx, orgAdmin, access, book, sheet, "owner"),
        ),
        sheet,
      ).rejects.toMatchObject({
        cause: {
          code: "42501",
          message: expect.stringContaining("Only a company owner"),
        },
      });
      expect(await state()).toEqual(before);
    }
    const scopeRows = () =>
      look<{ metadata: { affectedUserIds: string[] } }>(
        "SELECT metadata FROM app.activity WHERE action = 'scope.home_units_changed' ORDER BY created_at, id",
      );
    const scopeBefore = (await scopeRows()).length;
    const done = await apply(file, owner, "owner");
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ group: "owner", needsOwner: [] });
    for (const sheet of ["units", "positions", "employees"])
      expect(done.body.data.sheets[sheet]).toEqual({
        create: 0,
        update: 1,
        unchanged: 0,
        reject: 0,
        needsOwner: 0,
      });
    expect((await unit("DIV-B")).parent_id).toBe((await unit("HQ2")).id);
    expect((await position("P-HELD")).org_unit_id).toBe(
      (await unit("DIV-B")).id,
    );
    expect(await holding("E-LINKED")).toEqual(["P-LEAD*"]);
    const added = (await scopeRows()).slice(scopeBefore);
    expect(
      added.some((row) => row.metadata.affectedUserIds.includes(person.userId)),
    ).toBe(true);
    expect(
      await look(
        "SELECT employee_number FROM app.employees WHERE user_id IS NOT NULL",
      ),
    ).toEqual([{ employee_number: "E-LINKED" }]);
    const after = await state();
    const again = await apply(file, owner, "owner");
    expect(again.body.data.sheets.units).toMatchObject({
      create: 0,
      update: 0,
      unchanged: 1,
    });
    expect(await state()).toEqual(after);
  });

  it("refuses oversized bodies, too many rows and unsafe archives before parsing, after only the authority check", async () => {
    const parsed = vi.mocked(readXlsx);
    const sheet = Buffer.alloc(1_000, " ");
    // Inflates to 20 MiB, far past the 1,000 bytes its directory and descriptor declare.
    const bomb = deflateRawSync(Buffer.alloc(20 * 1024 * 1024, " "));
    const plain = {
      name: "xl/sheet.xml",
      data: deflateRawSync(sheet),
      method: 8,
      expanded: 1_000,
    } as const;
    const streamed = { ...plain, name: "xl/streamed.xml", streamed: true };
    // The same shapes, honestly sized, pass the archive check.
    expect(() => checkWorkbookArchive(zip([plain, streamed]))).not.toThrow();
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    const archives: [string, Buffer, string][] = [
      [
        "2,001 entries",
        centralDirectory(
          Array.from({ length: 2_001 }, (_, i) => ({
            name: `xl/fictional-${i}.xml`,
            size: 10,
          })),
        ),
        "import_archive_too_large",
      ],
      [
        "50 MiB declared",
        centralDirectory([
          { name: "xl/fictional.xml", size: 50 * 1024 * 1024 + 1 },
        ]),
        "import_archive_too_large",
      ],
      [
        "../x.xml",
        centralDirectory([{ name: "../x.xml", size: 10 }]),
        "import_unreadable",
      ],
      ["not a zip", Buffer.from("not a workbook"), "import_unreadable"],
      [
        "a local header declaring 300 MiB",
        zip([
          {
            ...plain,
            local: {
              compressed: plain.data.length,
              expanded: 300 * 1024 * 1024,
            },
          },
        ]),
        "import_unreadable",
      ],
      [
        "a bit 3 entry inflating past its size",
        zip([{ ...streamed, data: bomb }]),
        "import_unreadable",
      ],
      [
        "a deflated entry inflating past its size",
        zip([{ ...plain, data: bomb }]),
        "import_unreadable",
      ],
      [
        "a descriptor signature inside bit 3 data",
        zip([
          {
            name: "xl/hidden.xml",
            data: Buffer.concat([
              Buffer.from([0x50, 0x4b, 0x07, 0x08]),
              Buffer.alloc(60),
            ]),
            method: 0,
            expanded: 64,
            streamed: true,
          },
        ]),
        "import_unreadable",
      ],
    ];
    /** One refused request: the parser never runs, and the only transaction is the authority check. */
    const limited = async (
      route: "dry-run" | "apply",
      file: Buffer,
      status: number,
      code: string,
      as = owner,
    ) => {
      parsed.mockClear();
      pools.data.mockClear();
      const response = await refused(
        () => post(route, file, { as, query: `?sha256=${sha(file)}` }),
        status,
        code,
      );
      expect(parsed, code).not.toHaveBeenCalled();
      expect(pools.data, code).toHaveBeenCalledTimes(1);
      return response;
    };
    for (const route of ["dry-run", "apply"] as const) {
      const tooLarge = await limited(route, big, 413, "import_too_large");
      expect(tooLarge.body.error.message).toContain("5 MiB");
      for (const [label, file, code] of archives) {
        expect(() => checkWorkbookArchive(file), label).toThrow();
        await limited(route, file, 422, code);
      }
      // A caller who may not import is refused before the body is read at all.
      for (const file of [big, archives[5][1]])
        await limited(route, file, 403, "org_forbidden", teamOwnerB);
    }
    const rows = await workbook({
      Units: [
        UNIT_COLUMNS,
        ...Array.from({ length: 20_001 }, (_, i) => [
          `ROW-${i}`,
          "Fictional Row",
          "Fictional Team",
          "DIV-A",
        ]),
      ],
    });
    for (const route of ["dry-run", "apply"] as const) {
      pools.data.mockClear();
      const response = await refused(
        () => post(route, rows, { as: owner, query: `?sha256=${sha(rows)}` }),
        422,
        "import_too_many_rows",
      );
      expect(response.body.error.message).toContain("20,000");
      expect(pools.data).toHaveBeenCalledTimes(1);
    }
  });
});

describe("organisation import at the largest configuration", () => {
  let harness: Harness;
  let owner: Principal;

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    owner = await seedIdentity(await harness.asOwner(), {
      userId: "imp-scale-owner",
      teamId: "imp-scale",
    });
    for (let depth = 0; depth < 6; depth++)
      await createOrgLevel(owner, { name: `Fictional level ${depth}`, depth });
  });
  afterAll(async () => harness?.close());

  it("dry-runs and applies 2,000 units in 6 levels, 5,000 positions and 5,000 employees within the deadlines", async () => {
    const units: Cell[][] = [UNIT_COLUMNS];
    let above: string[] = [];
    [10, 40, 150, 300, 600, 900].forEach((count, depth) => {
      const codes = Array.from({ length: count }, (_, i) => `S${depth}-${i}`);
      codes.forEach((code, i) =>
        units.push([
          code,
          `Fictional unit ${code}`,
          `Fictional level ${depth}`,
          depth ? above[i % above.length] : null,
        ]),
      );
      above = codes;
    });
    const codes = units.slice(1).map((row) => row[0]);
    const file = await workbook({
      Units: units,
      Positions: [
        POSITION_COLUMNS,
        ...Array.from({ length: 5_000 }, (_, i) => [
          `SP-${i}`,
          `Fictional position ${i}`,
          codes[i % codes.length],
          i % 10 ? "no" : "yes",
        ]),
      ],
      Employees: [
        EMPLOYEE_COLUMNS,
        ...Array.from({ length: 5_000 }, (_, i) => [
          `SE-${i}`,
          `Fictional Person ${i}`,
          `person-${i}@example.test`,
          null,
          `SP-${i}`,
          `SP-${i}`,
        ]),
      ],
    });
    const created = (count: number) => ({
      create: count,
      update: 0,
      unchanged: 0,
      reject: 0,
      needsOwner: 0,
    });
    const sheets = {
      units: created(2_000),
      positions: created(5_000),
      employees: created(5_000),
    };
    const dry = await dryRun(file, owner);
    expect(dry.status).toBe(200);
    expect(dry.body.data.sheets).toEqual(sheets);
    const applied = await apply(file, owner);
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200);
    expect(applied.body.data.sheets).toEqual(sheets);
    const again = await dryRun(file, owner);
    expect(again.body.data.sheets.employees).toMatchObject({
      create: 0,
      unchanged: 5_000,
    });
  }, 600_000);
});
