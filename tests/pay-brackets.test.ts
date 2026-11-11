import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requests pick the pool by role, as on a split-role deployment: the identity role reads the
// membership, the data role runs withTeam. The session lookup is mocked per request.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));

import type { AppDb, TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import {
  JOB_ARCHITECTURE_KEY,
  type JobArchitectureBody,
  type RoleBody,
} from "@/domain/config";
import { ADMIN_ROLE } from "@/domain/config-defaults";
import { getVerifiedSession } from "@/lib/auth-session";
import { createConfigDraft, publishConfigVersion } from "@/lib/config-store";
import { listActivity } from "@/lib/insights";
import {
  createSalaryBracketDraft,
  getSalaryBrackets,
  publishSalaryBracketVersion,
  updateSalaryBracketDraft,
  type SalaryBracketInput,
} from "@/lib/pay-brackets";
import type { Principal } from "@/lib/principal";
import { createRecord, updateRecord } from "@/lib/records";
import { setTeamArchived } from "@/lib/team-archive";
import { installTenantContext } from "@/lib/tenant-context";
import {
  GET as readRoute,
  POST as createRoute,
} from "@/app/api/v1/salary-brackets/route";
import { PUT as editRoute } from "@/app/api/v1/salary-brackets/[versionId]/route";
import { POST as publishRoute } from "@/app/api/v1/salary-brackets/[versionId]/publish/route";
import {
  GET as listRecordsRoute,
  POST as createRecordRoute,
} from "@/app/api/v1/[resource]/route";
import { GET as getRecordRoute } from "@/app/api/v1/[resource]/[id]/route";
import { GET as searchRoute } from "@/app/api/v1/search/route";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace with three fictional teams, a second fictional
// workspace inserted by the owner role, and fictional pay figures in AED fils (ADM-25, job 083).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000083";
const ORIGIN = "http://localhost:3000";
const UNKNOWN = "00000000-0000-4000-a000-0000000000ff";
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Row = Record<string, unknown>;

/** A fictional job architecture: two grades and two titles, or the grades given. */
const architecture = (
  grades: string[] = ["G5", "G7"],
): JobArchitectureBody => ({
  families: [{ key: "finance", name: "Fictional Finance" }],
  grades: grades.map((code, index) => ({
    code,
    name: `Fictional grade ${code}`,
    order: index + 1,
  })),
  titles: grades.includes("G7")
    ? [
        {
          key: "payroll-lead",
          name: "Fictional Payroll Lead",
          familyKey: "finance",
          gradeCode: "G7",
        },
        {
          key: "payroll-associate",
          name: "Fictional Payroll Associate",
          familyKey: "finance",
          gradeCode: "G5",
        },
      ]
    : [],
});
/** One bracket per grade, the minimum given in fils and the others above it. */
const bracket = (gradeCode: string, minimumFils: number) => ({
  gradeCode,
  minimumFils,
  midpointFils: minimumFils + 300_000,
  maximumFils: minimumFils + 600_000,
});
const draftInput = (
  g5 = 1_200_000,
  g7 = 2_000_000,
  extra: Partial<SalaryBracketInput> = {},
): SalaryBracketInput => ({
  effectiveFrom: "2027-01-01",
  brackets: [bracket("G7", g7), bracket("G5", g5)],
  ...extra,
});
/** Distinctive fictional figures that must never leave the bracket tables. */
const SECRET_FIGURES = { g5: 7_654_321, g7: 17_654_321 };
const SECRET_TEXT = ["7654321", "7954321", "8254321", "17654321", "17954321"];

describe("salary brackets under Plan & pay access", () => {
  let harness: Harness;
  let owner: Principal, coOwner: Principal, orgAdmin: Principal;
  let orgAdminPlain: Principal, fieldsHolder: Principal, noPlans: Principal;
  let readOnly: Principal, recruiterHolder: Principal, recruiter: Principal;
  let teamOwnerB: Principal, ownerC: Principal, ownerX: Principal;
  let ownerToken: Principal;
  /** Bracket versions by name. */
  const v: Record<string, string> = {};
  /** Fixture records by name. */
  const r: Record<string, string> = {};

  /** Raw reads as the PGlite superuser, which bypasses RLS; only to inspect outcomes. */
  const look = async <T = Row>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  /** Owner-role statements: fixtures the app has no route for. */
  const asOwner = async (text: string) => {
    await harness.asOwner();
    await harness.client.exec(text);
  };
  /** One data-role statement under the principal's verified context. */
  const sqlAs = (principal: Principal, statement: string) =>
    harness.dataDb().then((db) =>
      withDeadlinesAndSnapshot(db, async (tx: TeamTx, snapshot) => {
        await installTenantContext(tx, principal, snapshot);
        return (await tx.execute(sql.raw(statement))).rows as Row[];
      }),
    );
  /** Every bracket row, every record pin and every salary-brackets activity row. */
  const state = async () => ({
    versions: await look(
      "SELECT * FROM app.salary_bracket_versions ORDER BY id",
    ),
    brackets: await look(
      "SELECT * FROM app.salary_brackets ORDER BY version_id, grade_code",
    ),
    pins: await look(
      "SELECT id, pay_bracket_version_id FROM app.records ORDER BY id",
    ),
    activity: await look(
      "SELECT id FROM app.activity WHERE kind = 'salary-brackets' ORDER BY id",
    ),
  });
  /** The call is refused with this status, code and, when given, message; no row changes. */
  async function refused(
    call: () => Promise<unknown>,
    status: number,
    code: string,
    message?: string,
  ) {
    const before = await state();
    await expect(call()).rejects.toMatchObject({
      status,
      code,
      ...(message ? { message } : {}),
    });
    expect(await state()).toEqual(before);
  }
  /** The statement is refused with this SQLSTATE, and no row changes. */
  async function refusedSql(call: () => Promise<unknown>, code: string) {
    const before = await state();
    await expect(call()).rejects.toMatchObject({ cause: { code } });
    expect(await state()).toEqual(before);
  }
  const pinOf = async (id: string) =>
    (
      await look<{ pin: string | null }>(
        "SELECT pay_bracket_version_id AS pin FROM app.records WHERE id = $1",
        [id],
      )
    )[0].pin;
  async function publishArchitecture(p: Principal, grades?: string[]) {
    const { versionId } = await createConfigDraft(p, {
      type: "job-architecture",
      key: JOB_ARCHITECTURE_KEY,
      body: architecture(grades),
    });
    await publishConfigVersion(p, versionId, { type: "job-architecture" });
  }
  const signIn = (p: Principal, fresh = true) =>
    vi.mocked(getVerifiedSession).mockResolvedValue({
      user: { id: p.userId, twoFactorEnabled: true },
      session: {
        activeOrganizationId: p.teamId,
        // ADM-06: younger than 15 minutes, or a stale one.
        createdAt: new Date(Date.now() - (fresh ? 1_000 : 16 * 60_000)),
      },
    } as never);
  async function route(
    p: Principal,
    handler: (request: Request, ctx: never) => Promise<Response>,
    path: string,
    init: {
      method?: string;
      body?: unknown;
      token?: boolean;
      stale?: boolean;
    } = {},
    params: Record<string, string> = {},
  ) {
    signIn(p, !init.stale);
    const response = await handler(
      new Request(`${ORIGIN}${path}`, {
        method: init.method ?? "GET",
        headers: {
          origin: ORIGIN,
          "x-team-id": p.teamId,
          ...(init.token
            ? { authorization: "Bearer fictional-bracket-token" }
            : {}),
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
      { params: Promise.resolve(params) } as never,
    );
    const text = await response.text();
    return {
      status: response.status,
      text,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: JSON.parse(text) as any,
    };
  }
  let serial = 0;
  const offer = (p: Principal, applicationId: string) =>
    createRecord(p, "offers", {
      applicationId,
      data: {
        title: `Fictional offer ${++serial}`,
        amount: "21000",
        currency: "AED",
        status: "Draft",
      },
    });

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, { userId: "pb-owner", teamId: "pb-team-a" });
    const member = (
      userId: string,
      role: "admin" | "recruiter",
      teamId = "pb-team-a",
    ) => seedIdentity(db, { userId, teamId, role });
    coOwner = await member("pb-co-owner", "admin");
    orgAdmin = await member("pb-org-admin", "admin");
    orgAdminPlain = await member("pb-org-admin-plain", "admin");
    fieldsHolder = await member("pb-fields-holder", "admin");
    noPlans = await member("pb-holder-no-plans", "admin");
    readOnly = await member("pb-holder-read-only", "admin");
    recruiterHolder = await member("pb-holder-recruiter", "recruiter");
    recruiter = await member("pb-recruiter", "recruiter");
    teamOwnerB = await seedIdentity(db, {
      userId: "pb-owner-b",
      teamId: "pb-team-b",
    });
    ownerC = await seedIdentity(db, {
      userId: "pb-owner-c",
      teamId: "pb-team-c",
    });
    ownerX = await seedIdentity(db, {
      userId: "pb-owner-x",
      teamId: "pb-team-x",
    });
    ownerToken = await seedApiToken(db, owner);
    // Company authority, the grants and the second workspace are owner-written; no team is created
    // after this.
    await harness.client.exec(`
      UPDATE app.workspace_admins SET plan_access = true WHERE user_id = 'pb-owner';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas,plan_access) VALUES
        ('${COMPANY}','pb-co-owner','owner','{}',false),
        ('${COMPANY}','pb-org-admin','admin','{organisation}',true),
        ('${COMPANY}','pb-org-admin-plain','admin','{organisation}',false),
        ('${COMPANY}','pb-fields-holder','admin','{fields}',true),
        ('${COMPANY}','pb-holder-no-plans','admin','{organisation}',true),
        ('${COMPANY}','pb-holder-read-only','admin','{organisation}',true),
        ('${COMPANY}','pb-holder-recruiter','admin','{organisation}',true),
        ('${COMPANY}','pb-owner-c','admin','{organisation}',true);
      INSERT INTO app.workspaces(id,name) VALUES ('${OTHER}','Fictional Other Company');
      UPDATE app.workspace_teams SET workspace_id = '${OTHER}' WHERE team_id = 'pb-team-x';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas,plan_access) VALUES
        ('${OTHER}','pb-owner-x','owner','{}',true);
    `);
    // Two configured admin roles: one without either plan scope, one without plans:write.
    const scopes = ADMIN_ROLE.body.scopes;
    for (const [key, kept, holder] of [
      [
        "pb-no-plans",
        scopes.filter((scope) => !scope.startsWith("plans:")),
        noPlans,
      ],
      [
        "pb-read-only",
        scopes.filter((scope) => scope !== "plans:write"),
        readOnly,
      ],
    ] as const) {
      const { objectId, versionId } = await createConfigDraft(owner, {
        type: "role",
        key,
        body: {
          ...structuredClone(ADMIN_ROLE.body),
          name: `Fictional ${key}`,
          scopes: [...kept],
        } as RoleBody,
      });
      await publishConfigVersion(owner, versionId);
      await asOwner(
        `INSERT INTO app.member_roles(team_id,user_id,role_object_id) VALUES ('pb-team-a','${holder.userId}','${objectId}')`,
      );
    }
  });
  afterAll(async () => harness?.close());

  describe("before a job architecture with grades", () => {
    it("reads nothing, pins nothing and refuses a draft with job_grades_required", async () => {
      expect(await getSalaryBrackets(owner)).toEqual({
        current: null,
        draft: null,
      });
      expect(
        await sqlAs(
          recruiter,
          "SELECT tenant_context.published_bracket_version() AS id",
        ),
      ).toEqual([{ id: null }]);
      await refused(
        () => createSalaryBracketDraft(owner, draftInput()),
        409,
        "job_grades_required",
        "Publish a job architecture with at least one grade first.",
      );
      await publishArchitecture(owner, []);
      await refused(
        () => createSalaryBracketDraft(orgAdmin, draftInput()),
        409,
        "job_grades_required",
      );
      await publishArchitecture(owner);
    });

    it("pins no offer while no version is published", async () => {
      const candidate = await createRecord(owner, "candidates", {
        data: { name: "Fictional Candidate One" },
      });
      const otherCandidate = await createRecord(owner, "candidates", {
        data: { name: "Fictional Candidate Two" },
      });
      const titled = await createRecord(owner, "vacancies", {
        data: {
          title: "Fictional titled vacancy",
          jobTitleKey: "payroll-lead",
        },
      });
      const plain = await createRecord(owner, "vacancies", {
        data: { title: "Fictional plain vacancy" },
      });
      for (const [name, candidateId, vacancyId] of [
        ["appTitled", candidate.id, titled.id],
        ["appPlain", otherCandidate.id, plain.id],
      ])
        r[name] = (
          await createRecord(owner, "applications", {
            candidateId,
            vacancyId,
            data: { stage: "Offer" },
          })
        ).id;
      r.early = (await offer(recruiter, r.appTitled)).id;
      expect(await pinOf(r.early)).toBeNull();
    });
  });

  describe("draft and publish", () => {
    it("lets a company owner holding the grant draft with the defaults and publish as number 1, then 2", async () => {
      const first = await createSalaryBracketDraft(owner, draftInput());
      expect(first).toEqual({
        versionId: expect.any(String),
        number: null,
        state: "draft",
        payPeriod: "monthly",
        covers: "basic",
        effectiveFrom: "2027-01-01",
        createdAt: expect.any(String),
        publishedAt: null,
        brackets: [bracket("G5", 1_200_000), bracket("G7", 2_000_000)],
      });
      expect(
        await look(
          "SELECT created_by, published_by FROM app.salary_bracket_versions WHERE id = $1",
          [first.versionId],
        ),
      ).toEqual([{ created_by: "pb-owner", published_by: null }]);
      expect(await publishSalaryBracketVersion(owner, first.versionId)).toEqual(
        { versionId: first.versionId, number: 1 },
      );
      v.one = first.versionId;
      const published = await state();
      const second = await createSalaryBracketDraft(
        owner,
        draftInput(1_300_000, 2_100_000, {
          payPeriod: "annual",
          covers: "total-cash",
        }),
      );
      expect(
        await publishSalaryBracketVersion(owner, second.versionId),
      ).toEqual({ versionId: second.versionId, number: 2 });
      v.two = second.versionId;
      // Version 1 stays published with unchanged rows.
      const after = await state();
      expect(after.versions.filter((row) => row.id === v.one)).toEqual(
        published.versions.filter((row) => row.id === v.one),
      );
      expect(after.brackets.filter((row) => row.version_id === v.one)).toEqual(
        published.brackets.filter((row) => row.version_id === v.one),
      );
      expect(
        await look(
          "SELECT number, state, pay_period, covers, published_by FROM app.salary_bracket_versions ORDER BY number",
        ),
      ).toEqual([
        {
          number: 1,
          state: "published",
          pay_period: "monthly",
          covers: "basic",
          published_by: "pb-owner",
        },
        {
          number: 2,
          state: "published",
          pay_period: "annual",
          covers: "total-cash",
          published_by: "pb-owner",
        },
      ]);
    });

    it("lets a company admin with organisation and the grant draft, edit and publish", async () => {
      const draft = await createSalaryBracketDraft(orgAdmin, draftInput());
      const edited = await updateSalaryBracketDraft(
        orgAdmin,
        draft.versionId,
        draftInput(1_250_000, 2_050_000, {
          payPeriod: "annual",
          covers: "basic-housing-transport",
          effectiveFrom: "2027-02-01",
        }),
      );
      expect(edited).toMatchObject({
        versionId: draft.versionId,
        state: "draft",
        payPeriod: "annual",
        covers: "basic-housing-transport",
        effectiveFrom: "2027-02-01",
        brackets: [bracket("G5", 1_250_000), bracket("G7", 2_050_000)],
      });
      expect(
        await publishSalaryBracketVersion(orgAdmin, draft.versionId),
      ).toEqual({ versionId: draft.versionId, number: 3 });
      v.three = draft.versionId;
      expect(
        await look(
          "SELECT count(*)::int AS n FROM app.salary_bracket_versions WHERE state = 'retired'",
        ),
      ).toEqual([{ n: 0 }]);
    });

    it("writes exactly one ids-only activity row per publish", async () => {
      const rows = await look<{
        team_id: string;
        actor_id: string;
        actor_type: string;
        token_id: string | null;
        record_id: string | null;
        summary: string;
        metadata: Row;
      }>(
        "SELECT team_id, actor_id, actor_type, token_id, record_id, summary, metadata FROM app.activity WHERE kind = 'salary-brackets' AND action = 'salary_brackets.published' ORDER BY created_at, id",
      );
      expect(rows.map((row) => [row.actor_id, row.metadata])).toEqual([
        ["pb-owner", { workspaceId: COMPANY, versionId: v.one, number: 1 }],
        ["pb-owner", { workspaceId: COMPANY, versionId: v.two, number: 2 }],
        [
          "pb-org-admin",
          { workspaceId: COMPANY, versionId: v.three, number: 3 },
        ],
      ]);
      for (const row of rows) {
        expect(Object.keys(row.metadata).sort()).toEqual([
          "number",
          "versionId",
          "workspaceId",
        ]);
        expect(row).toMatchObject({
          team_id: "pb-team-a",
          actor_type: "session",
          token_id: null,
          record_id: null,
          summary: "Published a salary bracket version",
        });
      }
      expect(
        await look(
          "SELECT count(*)::int AS n FROM app.activity WHERE kind = 'salary-brackets'",
        ),
      ).toEqual([{ n: 3 }]);
    });

    it("reads the highest-numbered published version and the newest draft", async () => {
      const older = await createSalaryBracketDraft(owner, draftInput());
      const newer = await createSalaryBracketDraft(
        owner,
        draftInput(1_400_000),
      );
      v.draft = newer.versionId;
      const read = await getSalaryBrackets(orgAdmin);
      expect(read.current).toMatchObject({
        versionId: v.three,
        number: 3,
        state: "published",
        publishedAt: expect.any(String),
      });
      expect(read.draft).toEqual(newer);
      expect(read.draft?.versionId).not.toBe(older.versionId);
    });
  });

  describe("service refusals", () => {
    it("refuses a bracket out of order before any write", async () => {
      const message =
        "The minimum must be at most the midpoint, and the midpoint at most the maximum.";
      for (const wrong of [
        { ...bracket("G5", 1_200_000), midpointFils: 1_100_000 },
        { ...bracket("G5", 1_200_000), maximumFils: 1_400_000 },
      ]) {
        const input = {
          ...draftInput(),
          brackets: [bracket("G7", 2_000_000), wrong],
        };
        await refused(
          () => createSalaryBracketDraft(owner, input),
          400,
          "invalid_input",
          message,
        );
        await refused(
          () => updateSalaryBracketDraft(owner, v.draft, input),
          400,
          "invalid_input",
          message,
        );
      }
    });

    it("refuses a missing, unknown or repeated grade on create and other grades on edit", async () => {
      const message =
        "brackets must hold exactly one bracket for each grade of the published job architecture.";
      for (const brackets of [
        [bracket("G5", 1_200_000)],
        [
          bracket("G5", 1_200_000),
          bracket("G7", 2_000_000),
          bracket("G9", 3_000_000),
        ],
        [
          bracket("G5", 1_200_000),
          bracket("G5", 1_300_000),
          bracket("G7", 2_000_000),
        ],
        [bracket("G5", 1_200_000), bracket("G9", 2_000_000)],
      ]) {
        const input = { ...draftInput(), brackets };
        await refused(
          () => createSalaryBracketDraft(owner, input),
          400,
          "invalid_input",
          message,
        );
        await refused(
          () => updateSalaryBracketDraft(owner, v.draft, input),
          400,
          "invalid_input",
          message,
        );
      }
    });

    it("refuses an unknown version and another workspace's version as not found", async () => {
      await publishArchitecture(ownerX);
      v.other = (
        await createSalaryBracketDraft(ownerX, draftInput())
      ).versionId;
      for (const id of [UNKNOWN, v.other]) {
        await refused(
          () => updateSalaryBracketDraft(owner, id, draftInput()),
          404,
          "not_found",
        );
        await refused(
          () => publishSalaryBracketVersion(owner, id),
          404,
          "not_found",
        );
      }
      // The other workspace never sees this company's versions either.
      expect((await getSalaryBrackets(ownerX)).current).toBeNull();
    });
  });

  describe("immutability", () => {
    it("refuses any change to a published version in the service, with nothing changed", async () => {
      await refused(
        () => updateSalaryBracketDraft(owner, v.one, draftInput()),
        409,
        "bracket_version_published",
        "A published salary bracket version cannot be changed. Create a new draft instead.",
      );
      await refused(
        () => publishSalaryBracketVersion(owner, v.one),
        409,
        "bracket_version_published",
      );
    });

    it("refuses direct SQL changes to a published version and its brackets with 42501", async () => {
      for (const statement of [
        `UPDATE app.salary_brackets SET minimum_fils = 1 WHERE version_id = '${v.one}'`,
        `UPDATE app.salary_bracket_versions SET pay_period = 'annual' WHERE id = '${v.one}'`,
        `UPDATE app.salary_bracket_versions SET number = 9 WHERE id = '${v.one}'`,
        `UPDATE app.salary_bracket_versions SET state = 'retired' WHERE id = '${v.one}'`,
        `UPDATE app.salary_brackets SET version_id = '${v.draft}' WHERE version_id = '${v.one}' AND grade_code = 'G5'`,
        `INSERT INTO app.salary_brackets(version_id, workspace_id, grade_code, minimum_fils, midpoint_fils, maximum_fils) VALUES ('${v.one}', '${COMPANY}', 'G9', 1, 2, 3)`,
        `INSERT INTO app.salary_bracket_versions(workspace_id, effective_from, state, number) VALUES ('${COMPANY}', '2027-01-01', 'published', 99)`,
        `UPDATE app.salary_bracket_versions SET state = 'published', number = 99 WHERE id = '${v.draft}'`,
        `UPDATE app.salary_bracket_versions SET created_by = 'pb-org-admin' WHERE id = '${v.draft}'`,
        `DELETE FROM app.salary_brackets WHERE version_id = '${v.one}'`,
        `DELETE FROM app.salary_bracket_versions WHERE id = '${v.draft}'`,
      ])
        await refusedSql(() => sqlAs(owner, statement), "42501");
    });

    it("refuses a bracket out of order by direct SQL on a draft with the database check", async () => {
      await refusedSql(
        () =>
          sqlAs(
            owner,
            `UPDATE app.salary_brackets SET minimum_fils = midpoint_fils + 1 WHERE version_id = '${v.draft}'`,
          ),
        "23514",
      );
    });

    it("lets the owner-run helper publish only drafts with brackets", async () => {
      await refusedSql(
        () =>
          sqlAs(
            owner,
            `SELECT tenant_context.publish_bracket_version('${v.one}')`,
          ),
        "RQ007",
      );
    });
  });

  describe("confidentiality by direct SQL as the data role", () => {
    const counts = (p: Principal) =>
      sqlAs(
        p,
        "SELECT (SELECT count(*) FROM app.salary_bracket_versions)::int AS versions, (SELECT count(*) FROM app.salary_brackets)::int AS brackets",
      );

    it("reads no version or bracket without the grant, plans:read or a session", async () => {
      for (const p of [
        teamOwnerB,
        orgAdminPlain,
        coOwner,
        noPlans,
        recruiterHolder,
        recruiter,
        ownerToken,
      ]) {
        expect(await counts(p), p.userId).toEqual([
          { versions: 0, brackets: 0 },
        ]);
        await refused(
          () => getSalaryBrackets(p),
          403,
          "plan_access_required",
          "Salary brackets need Plan & pay access, which only a company owner gives.",
        );
      }
    });

    it("reads every version of the company for a holder with plans:read", async () => {
      const [{ versions }] = await look<{ versions: number }>(
        `SELECT count(*)::int AS versions FROM app.salary_bracket_versions WHERE workspace_id = '${COMPANY}'`,
      );
      for (const p of [owner, orgAdmin, fieldsHolder, readOnly, ownerC]) {
        expect(await counts(p), p.userId).toEqual([
          { versions, brackets: versions * 2 },
        ]);
        expect((await getSalaryBrackets(p)).current?.number, p.userId).toBe(3);
      }
    });

    it("refuses a draft insert without the grant, plans:write or organisation, and from an archived team", async () => {
      const insert = `INSERT INTO app.salary_bracket_versions(workspace_id, effective_from) VALUES ('${COMPANY}', '2027-01-01')`;
      const publish = `SELECT tenant_context.publish_bracket_version('${v.draft}')`;
      const cases: [Principal, number, string][] = [
        [teamOwnerB, 403, "plan_access_required"],
        [orgAdminPlain, 403, "plan_access_required"],
        [coOwner, 403, "plan_access_required"],
        [noPlans, 403, "plan_access_required"],
        [readOnly, 403, "plan_access_required"],
        [recruiterHolder, 403, "plan_access_required"],
        [ownerToken, 403, "plan_access_required"],
        [fieldsHolder, 403, "config_forbidden"],
      ];
      const check = async (p: Principal, status: number, code: string) => {
        await refusedSql(() => sqlAs(p, insert), "42501");
        await refusedSql(() => sqlAs(p, publish), "42501");
        await refused(
          () => createSalaryBracketDraft(p, draftInput()),
          status,
          code,
        );
        await refused(
          () => updateSalaryBracketDraft(p, v.draft, draftInput()),
          status,
          code,
        );
        await refused(
          () => publishSalaryBracketVersion(p, v.draft),
          status,
          code,
        );
      };
      for (const [p, status, code] of cases) await check(p, status, code);
      // The team C owner writes until their team is archived, then reads only.
      expect(await sqlAs(ownerC, `${insert} RETURNING number`)).toEqual([
        { number: null },
      ]);
      await setTeamArchived(ownerC, true);
      try {
        await check(ownerC, 403, "team_archived");
        expect((await getSalaryBrackets(ownerC)).current?.number).toBe(3);
      } finally {
        await setTeamArchived(ownerC, false);
      }
    });

    it("defines allows_plan from the context row only, so no group or approval membership grants access", async () => {
      const [{ source }] = await look<{ source: string }>(
        "SELECT p.prosrc AS source FROM pg_proc p WHERE p.oid = 'tenant_context.allows_plan(uuid,text)'::regprocedure",
      );
      expect(source).toContain("tenant_context.contexts");
      expect(source).not.toMatch(/\bapp\./);
      expect(source).toContain("c.plan_access");
      expect(source).toContain("c.auth_type = 'session'");
    });
  });

  describe("offer pinning", () => {
    it("pins the published version on an offer for a titled vacancy, made by a recruiter without the grant", async () => {
      r.pinned = (await offer(recruiter, r.appTitled)).id;
      r.unpinned = (await offer(recruiter, r.appPlain)).id;
      expect(await pinOf(r.pinned)).toBe(v.three);
      expect(await pinOf(r.unpinned)).toBeNull();
      expect(await pinOf(r.early)).toBeNull();
    });

    it("keeps the pin after a later publish and an update of the offer", async () => {
      const before = await getSalaryBrackets(owner);
      const next = await createSalaryBracketDraft(owner, draftInput(1_500_000));
      expect(await publishSalaryBracketVersion(owner, next.versionId)).toEqual({
        versionId: next.versionId,
        number: 4,
      });
      v.four = next.versionId;
      expect(before.current?.versionId).toBe(v.three);
      const [row] = await look<{ version: number }>(
        "SELECT version FROM app.records WHERE id = $1",
        [r.pinned],
      );
      await updateRecord(recruiter, "offers", r.pinned, {
        version: row.version,
        data: { status: "Sent" },
      });
      expect(await pinOf(r.pinned)).toBe(v.three);
      expect(await pinOf(r.unpinned)).toBeNull();
      expect(
        await sqlAs(
          recruiter,
          "SELECT tenant_context.published_bracket_version() AS id",
        ),
      ).toEqual([{ id: v.four }]);
      expect(
        await sqlAs(
          ownerToken,
          "SELECT tenant_context.published_bracket_version() AS id",
        ),
      ).toEqual([{ id: v.four }]);
    });

    it("refuses the id helper without a context", async () => {
      await harness.dataDb();
      await expect(
        harness.client.query(
          "SELECT tenant_context.published_bracket_version()",
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("answers REST offer creates and reads with the same keys, pinned or not, and no bracket key", async () => {
      const created = [];
      for (const applicationId of [r.appTitled, r.appPlain]) {
        const response = await route(
          recruiter,
          createRecordRoute as never,
          "/api/v1/offers",
          {
            method: "POST",
            body: { applicationId, data: { title: "Fictional REST offer" } },
          },
          { resource: "offers" },
        );
        expect(response.status, response.text).toBe(201);
        created.push(response.body.data as Row);
      }
      const [pinned, unpinned] = created;
      expect(await pinOf(pinned.id as string)).toBe(v.four);
      expect(await pinOf(unpinned.id as string)).toBeNull();
      expect(Object.keys(pinned).sort()).toEqual(Object.keys(unpinned).sort());
      const reads = [];
      for (const record of created) {
        const response = await route(
          recruiter,
          getRecordRoute as never,
          `/api/v1/offers/${record.id}`,
          {},
          { resource: "offers", id: record.id as string },
        );
        expect(response.status).toBe(200);
        reads.push(response);
      }
      expect(Object.keys(reads[0].body.data).sort()).toEqual(
        Object.keys(reads[1].body.data).sort(),
      );
      const list = await route(
        recruiter,
        listRecordsRoute as never,
        "/api/v1/offers",
        {},
        { resource: "offers" },
      );
      for (const text of [
        JSON.stringify(created),
        ...reads.map((read) => read.text),
        list.text,
      ]) {
        expect(text.toLowerCase()).not.toContain("bracket");
        expect(text).not.toContain(v.four);
      }
    });
  });

  describe("routes", () => {
    it("refuses a Bearer token on every operation with session_required and no data-pool call", async () => {
      for (const [handler, method, path, params] of [
        [readRoute, "GET", "/api/v1/salary-brackets", {}],
        [createRoute, "POST", "/api/v1/salary-brackets", {}],
        [
          editRoute,
          "PUT",
          `/api/v1/salary-brackets/${v.draft}`,
          { versionId: v.draft },
        ],
        [
          publishRoute,
          "POST",
          `/api/v1/salary-brackets/${v.draft}/publish`,
          { versionId: v.draft },
        ],
      ] as const) {
        const before = await state();
        const calls = pools.data.mock.calls.length;
        const response = await route(
          owner,
          handler as never,
          path,
          {
            method,
            token: true,
            ...(method === "GET" ? {} : { body: draftInput() }),
          },
          params,
        );
        expect(response.status, path).toBe(403);
        expect(response.body.error?.code, path).toBe("session_required");
        expect(pools.data.mock.calls.length, path).toBe(calls);
        expect(await state()).toEqual(before);
      }
    });

    it("refuses a stale session's publish with SESSION_NOT_FRESH and leaves the draft a draft", async () => {
      const before = await state();
      const response = await route(
        owner,
        publishRoute as never,
        `/api/v1/salary-brackets/${v.draft}/publish`,
        { method: "POST", stale: true },
        { versionId: v.draft },
      );
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("SESSION_NOT_FRESH");
      expect(await state()).toEqual(before);
    });

    it("reads, creates, edits and publishes for a holder, and refuses a non-holder's read", async () => {
      const read = await route(
        owner,
        readRoute as never,
        "/api/v1/salary-brackets",
      );
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ data: await getSalaryBrackets(owner) });
      expect(Object.keys(read.body.data.current).sort()).toEqual([
        "brackets",
        "covers",
        "createdAt",
        "effectiveFrom",
        "number",
        "payPeriod",
        "publishedAt",
        "state",
        "versionId",
      ]);
      const denied = await route(
        coOwner,
        readRoute as never,
        "/api/v1/salary-brackets",
      );
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("plan_access_required");
      const created = await route(
        orgAdmin,
        createRoute as never,
        "/api/v1/salary-brackets",
        { method: "POST", body: draftInput() },
      );
      expect(created.status).toBe(201);
      const id = created.body.data.versionId as string;
      const edited = await route(
        orgAdmin,
        editRoute as never,
        `/api/v1/salary-brackets/${id}`,
        { method: "PUT", body: draftInput(1_210_000) },
        { versionId: id },
      );
      expect(edited.status).toBe(200);
      expect(edited.body.data.brackets[0]).toEqual(bracket("G5", 1_210_000));
      const published = await route(
        orgAdmin,
        publishRoute as never,
        `/api/v1/salary-brackets/${id}/publish`,
        { method: "POST" },
        { versionId: id },
      );
      expect(published).toMatchObject({
        status: 200,
        body: { data: { versionId: id, number: 5 } },
      });
      const invalid = await route(
        orgAdmin,
        createRoute as never,
        "/api/v1/salary-brackets",
        { method: "POST", body: { ...draftInput(), currency: "USD" } },
      );
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe("invalid_input");
    });
  });

  describe("no figure leaves the bracket tables", () => {
    it("keeps distinctive figures out of activity, search and the activity feeds", async () => {
      const draft = await createSalaryBracketDraft(
        owner,
        draftInput(SECRET_FIGURES.g5, SECRET_FIGURES.g7),
      );
      await publishSalaryBracketVersion(owner, draft.versionId);
      const stored = JSON.stringify(
        await look(
          "SELECT minimum_fils, midpoint_fils, maximum_fils FROM app.salary_brackets WHERE version_id = $1",
          [draft.versionId],
        ),
      );
      for (const figure of SECRET_TEXT) expect(stored).toContain(figure);
      const activity = JSON.stringify(
        await look("SELECT summary, metadata FROM app.activity"),
      );
      for (const figure of SECRET_TEXT) {
        expect(activity, figure).not.toContain(figure);
        const search = await route(
          owner,
          searchRoute as never,
          `/api/v1/search?q=${figure}`,
        );
        expect(search.status).toBe(200);
        expect(search.text, figure).not.toContain(figure);
      }
      const feed = async (p: Principal) =>
        listActivity(p, new URLSearchParams({ pageSize: "100" }));
      for (const p of [recruiter, teamOwnerB, ownerToken]) {
        const page = await feed(p);
        expect(
          page.data.filter((row) => row.kind === "salary-brackets"),
          p.userId,
        ).toEqual([]);
        for (const figure of SECRET_TEXT)
          expect(JSON.stringify(page)).not.toContain(figure);
      }
      // A company owner's feed holds the publish rows, with the version number only.
      const ownerRows = (await feed(owner)).data.filter(
        (row) => row.kind === "salary-brackets",
      );
      expect(ownerRows.length).toBeGreaterThan(0);
      for (const figure of SECRET_TEXT)
        expect(JSON.stringify(ownerRows)).not.toContain(figure);
    });
  });

  describe("grade changes", () => {
    it("refuses to publish a draft whose grades no longer match with bracket_grades_changed", async () => {
      await publishArchitecture(owner, ["G5", "G7", "G9"]);
      await refused(
        () => publishSalaryBracketVersion(owner, v.draft),
        409,
        "bracket_grades_changed",
        "The job grades changed since this draft was made. Create a new draft for the current grades.",
      );
      // A new draft for the current grades publishes.
      const draft = await createSalaryBracketDraft(owner, {
        ...draftInput(),
        brackets: [...draftInput().brackets, bracket("G9", 3_000_000)],
      });
      expect(
        (await publishSalaryBracketVersion(owner, draft.versionId)).number,
      ).toBe(7);
    });
  });
});
