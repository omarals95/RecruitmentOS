import { randomUUID } from "node:crypto";
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
import { addAssignment, removeAssignment } from "@/lib/assignments";
import { createConfigDraft, publishConfigVersion } from "@/lib/config-store";
import {
  getCvDownload,
  listCandidateCvsPage,
  readyCv,
  readyCvsOf,
} from "@/lib/cvs";
import {
  createEmployee,
  createPosition,
  linkEmployeeUser,
  setEmployeePositions,
} from "@/lib/directory";
import {
  analytics,
  listActivity,
  notifications,
  overview,
  searchWorkspace,
} from "@/lib/insights";
import { assignMemberRole } from "@/lib/member-roles";
import { archiveOrgUnit, createOrgLevel, createOrgUnit } from "@/lib/org";
import type { Principal } from "@/lib/principal";
import {
  createRecord,
  exportRecords,
  getRecord,
  listRecords,
  recordKindOf,
  updateRecord,
} from "@/lib/records";
import { installTenantContext } from "@/lib/tenant-context";
import { HIRING_MANAGER_ROLE, RECRUITER_ROLE } from "@/domain/config-defaults";
import type { RoleBody } from "@/domain/config";
import { dubaiToday, type ResourceName } from "@/domain/records";
import { POST as createRoute } from "@/app/api/v1/[resource]/route";
import { PATCH as updateRoute } from "@/app/api/v1/[resource]/[id]/route";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";

// Fictional data only: one company with a 500-unit, six-level tree, a second fictional company for
// the cross-workspace refusal, and members whose roles limit records to their unit or to assigned
// records (R2a-18, job 060).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000002";
const ORIGIN = "http://localhost:3000";
const WORD = "Scopeword";
const COUNTS = [2, 8, 30, 80, 160, 220];
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Row = Record<string, unknown>;

const signIn = (p: Principal) =>
  vi.mocked(getVerifiedSession).mockResolvedValue({
    user: { id: p.userId, twoFactorEnabled: true },
    session: { activeOrganizationId: p.teamId },
  } as never);
const unitScope = { pipeline: "unit", candidates: "unit", tasks: "unit" };
const assignedScope = {
  pipeline: "assigned",
  candidates: "assigned",
  tasks: "assigned",
};

describe("record scope in the service under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, ownerX: Principal, orgAdmin: Principal;
  let unitMember: Principal, assignedMember: Principal, noHome: Principal;
  let hm: Principal, colleague: Principal;
  const tree: string[][] = [];
  let otherUnit: string, archivedUnit: string;
  let hmEmployee: string;
  /** The fixture records by name. */
  const id: Record<string, string> = {};
  let bucket: string;

  /** Raw reads as the PGlite superuser, which bypasses RLS; only to inspect outcomes. */
  const look = async <T = Row>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
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
  const scopeOf = (recordId: string) =>
    look<{
      org_unit_id: string | null;
      scope_vacancy_id: string | null;
      scope_application_id: string | null;
    }>(
      "SELECT org_unit_id, scope_vacancy_id, scope_application_id FROM app.records WHERE id = $1",
      [recordId],
    ).then((rows) => rows[0]);
  const create = async (
    p: Principal,
    resource: ResourceName,
    input: Row,
  ): Promise<string> => (await createRecord(p, resource, input)).id;
  /** Drafts and publishes one company role as the company owner, then assigns it. */
  async function role(key: string, body: RoleBody, members: Principal[]) {
    const { objectId, versionId } = await createConfigDraft(owner, {
      type: "role",
      key,
      body,
    });
    await publishConfigVersion(owner, versionId);
    for (const member of members)
      await assignMemberRole(
        owner,
        { userId: member.userId, roleObjectId: objectId },
        new Headers(),
      );
  }
  /** A fictional employee linked to the member, holding one position in the unit. */
  async function homeIn(member: Principal, unit: string, serial: number) {
    const position = await createPosition(owner, {
      title: `Fictional scope desk ${serial}`,
      code: `OS-DESK-${serial}`,
      orgUnitId: unit,
    });
    const employee = await createEmployee(owner, {
      displayName: `Fictional Scope Person ${serial}`,
      employeeNumber: `OS-EMP-${serial}`,
    });
    await linkEmployeeUser(owner, employee.id, { userId: member.userId });
    await setEmployeePositions(owner, employee.id, {
      positions: [{ positionId: position.id, primary: true }],
    });
    return employee.id;
  }
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
  const named = (...names: string[]) => names.map((name) => id[name]).sort();
  const listed = async (p: Principal, resource: ResourceName) =>
    ids(
      (
        await listRecords(
          p,
          resource,
          new URLSearchParams({ pageSize: "100", includeArchived: "true" }),
        )
      ).data,
    );
  async function call(
    method: "POST" | "PATCH",
    p: Principal,
    path: string,
    params: Record<string, string>,
    body: unknown,
  ) {
    signIn(p);
    const request = new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        "x-team-id": p.teamId,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const context = { params: Promise.resolve(params) } as never;
    const response =
      method === "POST"
        ? await createRoute(request, context)
        : await updateRoute(request, context);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: response.status, body: (await response.json()) as any };
  }

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, { userId: "os-owner", teamId: "os-team" });
    const member = (
      userId: string,
      role: "admin" | "recruiter" = "recruiter",
    ) => seedIdentity(db, { userId, teamId: "os-team", role });
    unitMember = await member("os-unit");
    assignedMember = await member("os-assigned");
    noHome = await member("os-no-home");
    hm = await member("os-hiring-manager");
    colleague = await member("os-colleague");
    orgAdmin = await member("os-org-admin", "admin");
    await seedIdentity(db, { userId: "os-outsider", teamId: "os-team-y" });
    ownerX = await seedIdentity(db, {
      userId: "os-owner-x",
      teamId: "os-team-x",
    });
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','os-org-admin','admin','{organisation}');
      INSERT INTO app.workspaces(id,name) VALUES ('${OTHER}','Fictional Other Company');
      UPDATE app.workspace_teams SET workspace_id = '${OTHER}' WHERE team_id = 'os-team-x';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level) VALUES ('${OTHER}','os-owner-x','owner');
    `);

    // The fictional 500-unit, six-level tree: each unit's parent is the previous level's unit at
    // its index modulo that level's size, as in tests/round-trip-budget.test.ts.
    for (const depth of COUNTS.keys()) {
      const level = await createOrgLevel(owner, {
        name: `Fictional scope level ${depth}`,
        depth,
      });
      const parents = depth === 0 ? [] : tree[depth - 1];
      const parent = parents.length
        ? sql`(${`{${parents.join(",")}}`}::uuid[])[1 + g % ${sql.raw(String(parents.length))}]`
        : sql`null::uuid`;
      tree.push(
        await asContext(owner, async (tx) => {
          const { rows } = await tx.execute<{ id: string }>(sql`
            insert into app.org_units(workspace_id, parent_id, level_id, name, code)
            select ${COMPANY}::uuid, ${parent}, ${level.id}::uuid,
              ${`Fictional scope unit ${depth}-`} || g, ${`OS-${depth}-`} || g
            from generate_series(0, ${sql.raw(String(COUNTS[depth] - 1))}) g order by g returning id`);
          return rows.map((row) => row.id);
        }),
      );
    }
    archivedUnit = tree[5][219];
    await archiveOrgUnit(owner, archivedUnit);
    const otherLevel = await createOrgLevel(ownerX, {
      name: "Fictional other level",
      depth: 0,
    });
    otherUnit = (
      await createOrgUnit(ownerX, {
        name: "Fictional Other Holdings",
        code: "OS-OTHER",
        levelId: otherLevel.id,
      })
    ).id;

    // Home units: tree[2][0] for the unit member and the hiring manager; none for noHome.
    await homeIn(unitMember, tree[2][0], 1);
    hmEmployee = await homeIn(hm, tree[2][0], 2);
    await role(
      "os-unit-role",
      {
        ...structuredClone(RECRUITER_ROLE.body),
        name: "Fictional unit recruiter",
        recordScope: unitScope,
      } as RoleBody,
      [unitMember, noHome],
    );
    await role(
      "os-assigned-role",
      {
        ...structuredClone(RECRUITER_ROLE.body),
        name: "Fictional assigned recruiter",
        recordScope: assignedScope,
      } as RoleBody,
      [assignedMember],
    );
    await role(
      "os-hiring-manager",
      structuredClone(HIRING_MANAGER_ROLE.body) as RoleBody,
      [hm],
    );

    // Records, all created by the company owner, who sees every record.
    const today = dubaiToday();
    [bucket] = [
      await create(owner, "buckets", {
        data: { name: "Fictional scope to do" },
      }),
    ];
    id.jobRole = await create(owner, "job-roles", {
      data: { title: `${WORD} role` },
    });
    const vacancy = (name: string, unit: string | null) =>
      create(owner, "vacancies", {
        data: {
          title: `${WORD} vacancy ${name}`,
          status: "Open",
          targetDate: today,
        },
        ...(unit ? { orgUnitId: unit } : {}),
      });
    id.vIn = await vacancy("in", tree[2][0]);
    id.vDeep = await vacancy("deep", tree[5][0]);
    id.vOut = await vacancy("out", tree[2][1]);
    id.vAbove = await vacancy("above", tree[1][0]);
    id.vNoUnit = await vacancy("no unit", null);
    id.vAssigned = await vacancy("assigned", tree[3][1]);
    for (const name of ["In", "Deep", "Out", "None", "Assigned", "X"])
      id[`c${name}`] = await create(owner, "candidates", {
        data: { name: `${WORD} Candidate ${name}` },
      });
    const application = (candidate: string, vacancy: string) =>
      create(owner, "applications", {
        candidateId: id[candidate],
        vacancyId: id[vacancy],
        data: { stage: "Sourced", source: `${WORD} referral` },
      });
    id.aIn = await application("cIn", "vIn");
    id.aDeep = await application("cDeep", "vDeep");
    id.aOut = await application("cOut", "vOut");
    id.aAssignedVacancy = await application("cAssigned", "vAssigned");
    id.aAssignedRow = await application("cX", "vOut");
    const startAt = new Date(Date.now() + 86400000).toISOString();
    id.iIn = await create(owner, "interviews", {
      applicationId: id.aIn,
      data: { title: "Fictional interview in", startAt },
    });
    id.iOut = await create(owner, "interviews", {
      applicationId: id.aOut,
      data: { title: "Fictional interview out", startAt },
    });
    id.oIn = await create(owner, "offers", {
      applicationId: id.aIn,
      data: { title: "Fictional offer in" },
    });
    id.obIn = await create(owner, "onboarding", {
      applicationId: id.aIn,
      data: {},
    });
    id.clIn = await create(owner, "checklist", {
      onboardingId: id.obIn,
      data: { title: "Fictional checklist in" },
    });
    const task = (name: string, links: Row = {}) =>
      create(owner, "tasks", {
        bucketId: bucket,
        ...links,
        data: { title: `${WORD} task ${name}` },
      });
    id.tAssigned = await task("assigned");
    id.tLinkedCandidate = await task("linked candidate", {
      candidateId: id.cIn,
    });
    id.tLinkedVacancy = await task("linked vacancy", { vacancyId: id.vIn });
    id.tOut = await task("out", { candidateId: id.cOut, vacancyId: id.vOut });
    id.tNone = await task("none");
    // The unit member's own task, created through the service under their role.
    id.tOwn = await create(unitMember, "tasks", {
      bucketId: bucket,
      data: { title: `${WORD} task own` },
    });
    const comment = (parent: string) =>
      create(owner, "comments", {
        parentRecordId: id[parent],
        data: { body: `Fictional comment on ${parent}` },
      });
    for (const parent of [
      "vIn",
      "vOut",
      "aIn",
      "iOut",
      "cIn",
      "cOut",
      "tAssigned",
      "tNone",
      "jobRole",
    ])
      id[`m_${parent}`] = await comment(parent);
    // A reply on a comment follows the comment's own parent.
    id.m_reply_vIn = await create(owner, "comments", {
      parentRecordId: id.m_vIn,
      data: { body: "Fictional reply in" },
    });
    id.m_reply_vOut = await create(owner, "comments", {
      parentRecordId: id.m_vOut,
      data: { body: "Fictional reply out" },
    });

    // Assignments, made by the company owner through the service.
    for (const [user, record] of [
      [unitMember, "vAssigned"],
      [unitMember, "aAssignedRow"],
      [unitMember, "tAssigned"],
      [assignedMember, "vIn"],
      [assignedMember, "iOut"],
      [assignedMember, "tAssigned"],
      [noHome, "aOut"],
    ] as const)
      expect(
        await addAssignment(owner, {
          recordId: id[record],
          userId: user.userId,
          relation: "interviewer",
        }),
      ).toEqual({ changed: true });
  });
  afterAll(async () => harness?.close());

  /** What each principal sees, by kind (architecture §3.5). */
  const expected = (): Record<
    "unit" | "assigned" | "noHome",
    Record<string, string[]>
  > => ({
    unit: {
      vacancies: named("vIn", "vDeep", "vAssigned"),
      applications: named("aIn", "aDeep", "aAssignedVacancy", "aAssignedRow"),
      interviews: named("iIn"),
      offers: named("oIn"),
      onboarding: named("obIn"),
      checklist: named("clIn"),
      candidates: named("cIn", "cDeep", "cAssigned", "cX"),
      tasks: named("tOwn", "tAssigned", "tLinkedCandidate", "tLinkedVacancy"),
      comments: named(
        "m_vIn",
        "m_aIn",
        "m_cIn",
        "m_tAssigned",
        "m_jobRole",
        "m_reply_vIn",
      ),
      "job-roles": named("jobRole"),
    },
    assigned: {
      vacancies: named("vIn"),
      applications: named("aIn"),
      interviews: named("iIn", "iOut"),
      offers: named("oIn"),
      onboarding: named("obIn"),
      checklist: named("clIn"),
      candidates: named("cIn"),
      tasks: named("tAssigned"),
      comments: named(
        "m_vIn",
        "m_aIn",
        "m_iOut",
        "m_cIn",
        "m_tAssigned",
        "m_jobRole",
        "m_reply_vIn",
      ),
      "job-roles": named("jobRole"),
    },
    noHome: {
      vacancies: [],
      applications: named("aOut"),
      interviews: named("iOut"),
      offers: [],
      onboarding: [],
      checklist: [],
      candidates: named("cOut"),
      // Linked to a candidate in scope through the assigned application.
      tasks: named("tOut"),
      comments: named("m_iOut", "m_cOut", "m_jobRole"),
      "job-roles": named("jobRole"),
    },
  });
  const principals = () => ({
    unit: unitMember,
    assigned: assignedMember,
    noHome,
  });

  describe("trigger maintenance", () => {
    it("copies a vacancy's unit down its pipeline and comments, with the vacancy and application ids", async () => {
      const unit = tree[2][0];
      expect(await scopeOf(id.vIn)).toEqual({
        org_unit_id: unit,
        scope_vacancy_id: id.vIn,
        scope_application_id: null,
      });
      expect(await scopeOf(id.aIn)).toEqual({
        org_unit_id: unit,
        scope_vacancy_id: id.vIn,
        scope_application_id: id.aIn,
      });
      for (const row of ["iIn", "oIn", "obIn", "clIn", "m_aIn"])
        expect(await scopeOf(id[row]), row).toEqual({
          org_unit_id: unit,
          scope_vacancy_id: id.vIn,
          scope_application_id: id.aIn,
        });
      expect(await scopeOf(id.m_vIn)).toEqual({
        org_unit_id: unit,
        scope_vacancy_id: id.vIn,
        scope_application_id: null,
      });
      for (const row of [
        "cIn",
        "tLinkedVacancy",
        "jobRole",
        "m_cIn",
        "m_reply_vIn",
      ])
        expect(await scopeOf(id[row]), row).toEqual({
          org_unit_id: null,
          scope_vacancy_id: null,
          scope_application_id: null,
        });
    });

    it("moves every row below a vacancy to its new unit, reaching rows without scope columns, and changes nothing else on them", async () => {
      const vLate = await create(owner, "vacancies", {
        data: { title: "Fictional late vacancy" },
      });
      const cLate = await create(owner, "candidates", {
        data: { name: "Fictional Late Candidate" },
      });
      const aLate = await create(owner, "applications", {
        candidateId: cLate,
        vacancyId: vLate,
        data: {},
      });
      const startAt = new Date(Date.now() + 86400000).toISOString();
      const children = {
        interview: await create(owner, "interviews", {
          applicationId: aLate,
          data: { title: "Fictional late interview", startAt },
        }),
        offer: await create(owner, "offers", {
          applicationId: aLate,
          data: { title: "Fictional late offer" },
        }),
        onboarding: await create(owner, "onboarding", {
          applicationId: aLate,
          data: {},
        }),
      };
      const checklist = await create(owner, "checklist", {
        onboardingId: children.onboarding,
        data: { title: "Fictional late checklist" },
      });
      const comments = [
        await create(owner, "comments", {
          parentRecordId: vLate,
          data: { body: "Fictional late vacancy comment" },
        }),
        await create(owner, "comments", {
          parentRecordId: children.interview,
          data: { body: "Fictional late interview comment" },
        }),
      ];
      const below = [aLate, ...Object.values(children), checklist, ...comments];
      // As if written before 0037: the scope columns cleared with the triggers off.
      await harness.asSuperuser();
      await harness.client.exec(
        `SET session_replication_role = replica; UPDATE app.records SET scope_vacancy_id = NULL, scope_application_id = NULL WHERE id = ANY('{${below.join(",")}}'::uuid[]); SET session_replication_role = DEFAULT;`,
      );
      for (const row of below)
        expect(await scopeOf(row), row).toMatchObject({
          scope_vacancy_id: null,
          scope_application_id: null,
        });
      const unchanged = () =>
        look(
          "SELECT id, version, updated_at, archived_at, data FROM app.records WHERE id = ANY($1::uuid[]) ORDER BY id",
          [below],
        );
      const before = await unchanged();
      const activityBefore = (
        await look<{ n: number }>("SELECT count(*)::int AS n FROM app.activity")
      )[0].n;
      let version = 1;
      for (const unit of [tree[3][5], tree[4][7]]) {
        const updated = await updateRecord(owner, "vacancies", vLate, {
          version,
          orgUnitId: unit,
        });
        version = updated.version;
        expect(updated).toMatchObject({ orgUnitId: unit });
        expect(updated.orgUnitLabel).toMatch(
          /^Fictional scope unit \d-\d+ \(OS-\d-\d+\)$/,
        );
        expect(await scopeOf(vLate)).toEqual({
          org_unit_id: unit,
          scope_vacancy_id: vLate,
          scope_application_id: null,
        });
        expect(await scopeOf(aLate)).toEqual({
          org_unit_id: unit,
          scope_vacancy_id: vLate,
          scope_application_id: aLate,
        });
        for (const row of [...Object.values(children), checklist, comments[1]])
          expect(await scopeOf(row), row).toEqual({
            org_unit_id: unit,
            scope_vacancy_id: vLate,
            scope_application_id: aLate,
          });
        expect(await scopeOf(comments[0])).toEqual({
          org_unit_id: unit,
          scope_vacancy_id: vLate,
          scope_application_id: null,
        });
        expect(await unchanged()).toEqual(before);
      }
      // One updated activity row per vacancy save, none for the rows below it.
      expect(
        (
          await look<{ n: number }>(
            "SELECT count(*)::int AS n FROM app.activity",
          )
        )[0].n,
      ).toBe(activityBefore + 2);
      // Clearing the unit clears it below too, and the response keeps today's keys.
      const cleared = await updateRecord(owner, "vacancies", vLate, {
        version,
        orgUnitId: null,
      });
      expect(Object.hasOwn(cleared, "orgUnitId")).toBe(false);
      expect(Object.hasOwn(cleared, "orgUnitLabel")).toBe(false);
      expect((await scopeOf(checklist)).org_unit_id).toBeNull();
    });

    it("refuses another workspace's or an archived unit, by the trigger and by the routes", async () => {
      for (const unit of [otherUnit, archivedUnit, randomUUID()]) {
        await expect(
          sqlAs(
            owner,
            `INSERT INTO app.records(team_id,kind,data,created_by,org_unit_id) VALUES ('${owner.teamId}','vacancy','{"title":"Fictional refused"}','${owner.userId}','${unit}')`,
          ),
          unit,
        ).rejects.toMatchObject({ cause: { code: "RQ012" } });
        const created = await call(
          "POST",
          owner,
          "/api/v1/vacancies",
          { resource: "vacancies" },
          { data: { title: "Fictional refused vacancy" }, orgUnitId: unit },
        );
        expect(created).toEqual({
          status: 400,
          body: {
            error: expect.objectContaining({
              code: "invalid_reference",
              message:
                "orgUnitId does not reference a current unit of this company.",
            }),
          },
        });
        const current = await getRecord(owner, "vacancies", id.vNoUnit);
        const patched = await call(
          "PATCH",
          owner,
          `/api/v1/vacancies/${id.vNoUnit}`,
          { resource: "vacancies", id: id.vNoUnit },
          { version: current.version, orgUnitId: unit },
        );
        expect(patched.status).toBe(400);
        expect(patched.body.error.code).toBe("invalid_reference");
        expect(await scopeOf(id.vNoUnit)).toMatchObject({ org_unit_id: null });
      }
      // Other kinds refuse the key; a vacancy without a unit keeps today's keys.
      const refused = await call(
        "POST",
        owner,
        "/api/v1/candidates",
        { resource: "candidates" },
        {
          data: { name: "Fictional refused candidate" },
          orgUnitId: tree[0][0],
        },
      );
      expect([refused.status, refused.body.error.code]).toEqual([
        400,
        "invalid_input",
      ]);
      const plain = await getRecord(owner, "vacancies", id.vNoUnit);
      expect(Object.keys(plain)).not.toContain("orgUnitId");
      expect(Object.keys(plain)).not.toContain("orgUnitLabel");
      const labelled = await getRecord(owner, "vacancies", id.vIn);
      expect(labelled).toMatchObject({
        orgUnitId: tree[2][0],
        orgUnitLabel: "Fictional scope unit 2-0 (OS-2-0)",
      });
      // Exports and search never carry the unit.
      const exported = await exportRecords(
        owner,
        "vacancies",
        new URLSearchParams(),
      );
      for (const row of exported.rows) {
        expect(Object.keys(row)).not.toContain("orgUnitId");
        expect(Object.keys(row)).not.toContain("orgUnitLabel");
      }
      const found = await searchWorkspace(owner, WORD);
      expect(JSON.stringify(found)).not.toContain("orgUnit");
    });
  });

  describe("scope table (architecture §3.5)", () => {
    it("lists, gets and exports exactly the records in scope, and answers the rest as missing", async () => {
      for (const [name, p] of Object.entries(principals())) {
        const sees = expected()[name as keyof ReturnType<typeof expected>];
        for (const [resource, visible] of Object.entries(sees)) {
          expect(
            await listed(p, resource as ResourceName),
            `${name} ${resource}`,
          ).toEqual(visible);
        }
        for (const [resource, visible] of Object.entries(sees)) {
          const all = await listed(owner, resource as ResourceName);
          for (const recordId of all) {
            const read = getRecord(p, resource as ResourceName, recordId);
            if (visible.includes(recordId))
              await expect(read, `${name} ${resource}`).resolves.toMatchObject({
                id: recordId,
              });
            else
              await expect(read, `${name} ${resource}`).rejects.toMatchObject({
                status: 404,
                code: "not_found",
              });
          }
        }
        for (const resource of [
          "vacancies",
          "applications",
          "candidates",
          "tasks",
          "interviews",
        ] as const) {
          const exported = await exportRecords(
            p,
            resource,
            new URLSearchParams(),
          );
          expect(ids(exported.rows), `${name} export ${resource}`).toEqual(
            sees[resource],
          );
        }
        // Buckets and task fields are team configuration, always in scope.
        expect(await listed(p, "buckets")).toEqual(
          await listed(owner, "buckets"),
        );
      }
    });

    it("searches, reminds, counts and charts only records in scope", async () => {
      // The records holding the search word, as the company owner sees them.
      const matching = ids(
        (await searchWorkspace(owner, WORD)).groups.flatMap(
          (group) => group.results,
        ),
      );
      for (const [name, p] of Object.entries(principals())) {
        const sees = expected()[name as keyof ReturnType<typeof expected>];
        const search = await searchWorkspace(p, WORD);
        expect(search.groups.map((group) => group.type)).toEqual([
          "candidates",
          "vacancies",
          "job-roles",
          "tasks",
          "applications",
        ]);
        for (const group of search.groups) {
          expect(
            group.results.map((row) => row.id).sort(),
            `${name} search ${group.type}`,
          ).toEqual(
            sees[group.type as keyof typeof sees].filter((recordId) =>
              matching.includes(recordId),
            ),
          );
        }
        const reminders = await notifications(p);
        const due = (kind: string) =>
          reminders.data
            .filter((row) => row.key.startsWith(`${kind}:`))
            .map((row) => row.key.split(":")[1])
            .sort();
        expect(due("vacancy"), `${name} reminders`).toEqual(sees.vacancies);
        expect(due("interview"), `${name} reminders`).toEqual(sees.interviews);
        const counted = await analytics(p, new URLSearchParams());
        expect(counted.counts, `${name} counts`).toEqual({
          candidates: sees.candidates.length,
          vacancies: sees.vacancies.length,
          applications: sees.applications.length,
          tasks: sees.tasks.length,
          interviews: sees.interviews.length,
          offers: sees.offers.length,
          onboarding: sees.onboarding.length,
        });
        // Observed application creations: only the applications in scope.
        expect(
          counted.series.reduce((sum, day) => sum + day.applications, 0),
          `${name} stage history`,
        ).toBe(sees.applications.length);
        const home = await overview(p);
        expect(home.counts, `${name} overview`).toMatchObject({
          candidates: sees.candidates.length,
          applications: sees.applications.length,
        });
        const everything = Object.values(sees).flat();
        for (const row of home.recentActivity)
          if (row.recordId)
            expect(everything, `${name} recent activity`).toContain(
              row.recordId,
            );
      }
    });

    it("keeps activity rows only about records in scope, with and without recordId", async () => {
      const outOfScope = await Promise.all(
        Object.keys(id).map(async (name) => id[name]),
      );
      for (const [name, p] of Object.entries(principals())) {
        const sees = expected()[name as keyof ReturnType<typeof expected>];
        const everything = [
          ...Object.values(sees).flat(),
          ...(await listed(owner, "buckets")),
        ];
        const feed = await listActivity(
          p,
          new URLSearchParams({ pageSize: "100" }),
        );
        expect(feed.data.length).toBeGreaterThan(0);
        for (const row of feed.data)
          if (row.recordId)
            expect(everything, `${name} ${row.kind} ${row.action}`).toContain(
              row.recordId,
            );
        for (const recordId of outOfScope) {
          const one = await listActivity(
            p,
            new URLSearchParams({ recordId, pageSize: "100" }),
          );
          if (everything.includes(recordId))
            expect(one.data.length, `${name} ${recordId}`).toBeGreaterThan(0);
          else expect(one.data, `${name} ${recordId}`).toEqual([]);
        }
      }
      // The company owner still sees every row of the team.
      const all = await listActivity(
        owner,
        new URLSearchParams({ recordId: id.vOut }),
      );
      expect(all.data.length).toBeGreaterThan(0);
    });

    it("answers a record outside scope as missing in updates, recordKindOf, references and candidate state", async () => {
      const vOut = await getRecord(owner, "vacancies", id.vOut);
      await expect(
        updateRecord(unitMember, "vacancies", id.vOut, {
          version: vOut.version,
          data: { title: "Fictional takeover" },
        }),
      ).rejects.toMatchObject({ status: 404, code: "not_found" });
      await expect(recordKindOf(unitMember, id.vOut)).rejects.toMatchObject({
        status: 404,
        code: "not_found",
      });
      await expect(recordKindOf(unitMember, id.vIn)).resolves.toEqual({
        kind: "vacancy",
        archived: false,
      });
      await expect(
        createRecord(unitMember, "applications", {
          candidateId: id.cIn,
          vacancyId: id.vOut,
          data: {},
        }),
      ).rejects.toMatchObject({ status: 400, code: "invalid_reference" });
      // The any-kind comment parent lookup.
      for (const parent of ["iOut", "cOut", "vOut", "m_vOut"])
        await expect(
          createRecord(unitMember, "comments", {
            parentRecordId: id[parent],
            data: { body: "Fictional refused comment" },
          }),
          parent,
        ).rejects.toMatchObject({ status: 400, code: "invalid_reference" });
      expect(
        (
          await createRecord(unitMember, "comments", {
            parentRecordId: id.aIn,
            data: { body: "Fictional allowed comment" },
          })
        ).parentRecordId,
      ).toBe(id.aIn);
      // An application's labels come only from parents in scope.
      const [assignedRow] = (
        await listRecords(
          unitMember,
          "applications",
          new URLSearchParams({ candidateId: id.cX }),
        )
      ).data;
      expect(assignedRow.candidateLabel).toBe(`${WORD} Candidate X`);
      expect(assignedRow).not.toHaveProperty("vacancyLabel");
    });

    it("answers an out-of-scope candidate's CVs as missing", async () => {
      // The lock helper creates the usage rows before the charge, as a reservation does.
      const cv = await asContext(owner, async (tx) => {
        await tx.execute(
          sql`SELECT tenant_context.lock_storage_allocation('s3','development','fictional-scope-bucket')`,
        );
        const { rows } = await tx.execute<{ id: string }>(
          sql`INSERT INTO app.uploads(team_id,candidate_id,original_name,mime_type,size_bytes,object_key,storage_provider,storage_environment,storage_store,created_by,expires_at)
            VALUES (${owner.teamId}, ${id.cOut}::uuid, 'fictional-scope.pdf', 'application/pdf', 10, ${`teams/${owner.teamId}/cvs/${randomUUID()}`}, 's3', 'development', 'fictional-scope-bucket', ${owner.userId}, now() + interval '1 hour') RETURNING id`,
        );
        return rows[0].id;
      });
      await look(
        `UPDATE app.uploads SET status='ready', s3_version_id='fictional-v1', completed_at=now() WHERE id='${cv}'`,
      );
      const missing = { status: 404, code: "CANDIDATE_NOT_FOUND" };
      await expect(
        listCandidateCvsPage(unitMember, id.cOut),
      ).rejects.toMatchObject(missing);
      await expect(readyCv(unitMember, cv)).rejects.toMatchObject(missing);
      await expect(getCvDownload(unitMember, cv)).rejects.toMatchObject(
        missing,
      );
      expect([
        ...(await readyCvsOf(unitMember, [id.cOut, id.cIn])).keys(),
      ]).toEqual([id.cIn]);
      // In scope through its application for the member without home units.
      await expect(
        listCandidateCvsPage(noHome, id.cOut),
      ).resolves.toMatchObject({
        pagination: { total: 1 },
      });
    });
  });

  describe("assignments", () => {
    const audits = () =>
      look<{
        record_id: string;
        actor_id: string;
        action: string;
        metadata: Row;
      }>(
        "SELECT record_id, actor_id, action, metadata FROM app.activity WHERE kind = 'assignment' ORDER BY created_at, id",
      );

    it("refuses direct writes to app.record_assignments and forged assignment activity for the data role", async () => {
      for (const statement of [
        `INSERT INTO app.record_assignments(team_id,record_id,user_id,relation) VALUES ('${owner.teamId}','${id.vOut}','${unitMember.userId}','assignee')`,
        `UPDATE app.record_assignments SET relation = 'assignee' WHERE user_id = '${unitMember.userId}'`,
        `DELETE FROM app.record_assignments WHERE user_id = '${unitMember.userId}'`,
        `INSERT INTO app.activity(team_id,record_id,actor_id,actor_type,action,kind,summary,metadata) VALUES ('${owner.teamId}','${id.vOut}','${owner.userId}','session','assignment.added','assignment','Forged','{}')`,
      ])
        await expect(sqlAs(owner, statement), statement).rejects.toMatchObject({
          cause: { code: "42501" },
        });
      // Members read their team's assignments.
      expect(
        (
          await sqlAs(
            unitMember,
            `SELECT count(*)::int AS n FROM app.record_assignments WHERE team_id = '${owner.teamId}'`,
          )
        )[0].n,
      ).toBe(7);
    });

    it("refuses out-of-scope records, outsiders, self-assignment by limited callers and the approver relation, in the helper and the service", async () => {
      const before = await audits();
      const helper = (
        p: Principal,
        recordId: string,
        userId: string,
        relation: string,
      ) =>
        sqlAs(
          p,
          `SELECT tenant_context.add_assignment('${recordId}', '${userId}', '${relation}') AS changed`,
        );
      const cases: [Principal, string, string, string, string, Row][] = [
        [
          unitMember,
          id.vOut,
          colleague.userId,
          "assignee",
          "RQ016",
          { status: 404, code: "not_found" },
        ],
        [
          assignedMember,
          id.vDeep,
          colleague.userId,
          "assignee",
          "RQ016",
          { status: 404, code: "not_found" },
        ],
        [
          unitMember,
          id.vIn,
          "os-outsider",
          "assignee",
          "RQ013",
          { status: 400, code: "invalid_assignment" },
        ],
        [
          unitMember,
          id.vIn,
          "os-nobody",
          "assignee",
          "RQ013",
          { status: 400, code: "invalid_assignment" },
        ],
        [
          unitMember,
          id.vIn,
          colleague.userId,
          "owner",
          "RQ013",
          { status: 400, code: "invalid_assignment" },
        ],
        [
          unitMember,
          id.vIn,
          unitMember.userId,
          "assignee",
          "RQ014",
          { status: 403, code: "self_assignment_forbidden" },
        ],
        [
          assignedMember,
          id.vIn,
          assignedMember.userId,
          "recruiter",
          "RQ014",
          { status: 403, code: "self_assignment_forbidden" },
        ],
        [
          owner,
          id.vIn,
          colleague.userId,
          "approver",
          "RQ015",
          {
            status: 400,
            code: "invalid_assignment",
            message: "Approver assignments arrive with approval requests.",
          },
        ],
        [
          owner,
          id.cIn,
          colleague.userId,
          "assignee",
          "RQ013",
          { status: 400, code: "invalid_assignment" },
        ],
      ];
      for (const [p, recordId, userId, relation, code, error] of cases) {
        await expect(
          helper(p, recordId, userId, relation),
          `${p.userId} ${relation} ${code}`,
        ).rejects.toMatchObject({ cause: { code } });
        await expect(
          addAssignment(p, { recordId, userId, relation }),
          `${p.userId} ${relation}`,
        ).rejects.toMatchObject(error);
      }
      // Self-unassignment is refused the same way; the row stays.
      await expect(
        removeAssignment(unitMember, {
          recordId: id.vAssigned,
          userId: unitMember.userId,
          relation: "interviewer",
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: "self_assignment_forbidden",
      });
      // A context without a write scope: the helper refuses with 42501, the service with 403.
      const reader = await seedApiToken(await harness.asOwner(), unitMember, [
        "candidates:read",
        "recruitment:read",
      ]);
      await expect(
        helper(reader, id.vIn, colleague.userId, "assignee"),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      await expect(
        addAssignment(reader, {
          recordId: id.vIn,
          userId: colleague.userId,
          relation: "assignee",
        }),
      ).rejects.toMatchObject({ status: 403, code: "forbidden" });
      expect(await audits()).toEqual(before);
    });

    it("writes one ids-only row per change and nothing for a repeat, and lets an all-scope caller assign themselves", async () => {
      const before = (await audits()).length;
      const input = {
        recordId: id.vIn,
        userId: colleague.userId,
        relation: "hiring-manager",
      };
      expect(await addAssignment(unitMember, input)).toEqual({ changed: true });
      expect(await addAssignment(unitMember, input)).toEqual({
        changed: false,
      });
      expect(await removeAssignment(unitMember, input)).toEqual({
        changed: true,
      });
      expect(await removeAssignment(unitMember, input)).toEqual({
        changed: false,
      });
      expect(
        await addAssignment(owner, { ...input, userId: owner.userId }),
      ).toEqual({ changed: true });
      const added = (await audits()).slice(before);
      expect(added).toEqual([
        {
          record_id: id.vIn,
          actor_id: unitMember.userId,
          action: "assignment.added",
          metadata: { userId: colleague.userId, relation: "hiring-manager" },
        },
        {
          record_id: id.vIn,
          actor_id: unitMember.userId,
          action: "assignment.removed",
          metadata: { userId: colleague.userId, relation: "hiring-manager" },
        },
        {
          record_id: id.vIn,
          actor_id: owner.userId,
          action: "assignment.added",
          metadata: { userId: owner.userId, relation: "hiring-manager" },
        },
      ]);
      expect(
        await removeAssignment(owner, { ...input, userId: owner.userId }),
      ).toEqual({ changed: true });
    });
  });

  describe("hiring manager end to end", () => {
    const hmSees = () => ({
      vacancies: named("vIn", "vDeep"),
      applications: named("aIn", "aDeep"),
      candidates: named("cIn", "cDeep"),
    });

    it("gives a company owner's hiring manager the vacancies, applications and candidates of their unit and below", async () => {
      expect(
        (
          await look<{ role_object_id: string }>(
            "SELECT role_object_id FROM app.member_roles WHERE user_id = $1",
            [hm.userId],
          )
        ).length,
      ).toBe(1);
      for (const [resource, visible] of Object.entries(hmSees()))
        expect(await listed(hm, resource as ResourceName), resource).toEqual(
          visible,
        );
      await expect(getRecord(hm, "vacancies", id.vOut)).rejects.toMatchObject({
        status: 404,
      });
      // Assigned records join their unit's.
      await addAssignment(owner, {
        recordId: id.vAssigned,
        userId: hm.userId,
        relation: "hiring-manager",
      });
      expect(await listed(hm, "vacancies")).toEqual(
        named("vIn", "vDeep", "vAssigned"),
      );
      await removeAssignment(owner, {
        recordId: id.vAssigned,
        userId: hm.userId,
        relation: "hiring-manager",
      });
    });

    it("refuses a company admin with the organisation area who changes the hiring manager's positions or link, and the view is unchanged", async () => {
      const desk = await createPosition(owner, {
        title: "Fictional top desk",
        code: "OS-DESK-TOP",
        orgUnitId: tree[0][0],
      });
      const before = await look(
        "SELECT * FROM app.employee_positions WHERE employee_id = $1 ORDER BY position_id",
        [hmEmployee],
      );
      for (const change of [
        () =>
          setEmployeePositions(orgAdmin, hmEmployee, {
            positions: [{ positionId: desk.id, primary: true }],
          }),
        () => linkEmployeeUser(orgAdmin, hmEmployee, { userId: null }),
      ])
        await expect(change()).rejects.toMatchObject({ status: 403 });
      expect(
        await look(
          "SELECT * FROM app.employee_positions WHERE employee_id = $1 ORDER BY position_id",
          [hmEmployee],
        ),
      ).toEqual(before);
      for (const [resource, visible] of Object.entries(hmSees()))
        expect(await listed(hm, resource as ResourceName), resource).toEqual(
          visible,
        );
    });
  });
});
