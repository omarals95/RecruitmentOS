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
  configBodySchemas,
  jobArchitectureBodySchema,
  type JobArchitectureBody,
} from "@/domain/config";
import { getVerifiedSession } from "@/lib/auth-session";
import {
  createConfigDraft,
  publishConfigVersion,
  updateConfigDraft,
} from "@/lib/config-store";
import { createPosition, updatePosition } from "@/lib/directory";
import { getJobArchitecture, jobTitleUsage } from "@/lib/job-architecture";
import { createOrgLevel, createOrgUnit } from "@/lib/org";
import type { Principal } from "@/lib/principal";
import { createRecord, updateRecord } from "@/lib/records";
import { installTenantContext } from "@/lib/tenant-context";
import {
  GET as readRoute,
  POST as createRoute,
} from "@/app/api/v1/job-architecture/route";
import { PUT as editRoute } from "@/app/api/v1/job-architecture/[versionId]/route";
import { POST as publishRoute } from "@/app/api/v1/job-architecture/[versionId]/publish/route";
import { GET as usageRoute } from "@/app/api/v1/job-architecture/usage/route";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace with two fictional teams, and a second fictional
// workspace inserted by the owner for the company admin's own versions (ADM-24, job 079).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000002";
const ORIGIN = "http://localhost:3000";
const TYPE = { type: "job-architecture" } as const;
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Row = Record<string, unknown>;

/** A fictional body: two families, two grades and three titles. */
const architecture = (
  extra: Partial<JobArchitectureBody> = {},
): JobArchitectureBody => ({
  families: [
    { key: "finance", name: "Fictional Finance" },
    { key: "people", name: "Fictional People" },
  ],
  grades: [
    { code: "G5", name: "Fictional Associate", order: 5 },
    { code: "G7", name: "Fictional Lead", order: 7 },
  ],
  titles: [
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
    {
      key: "recruiter",
      name: "Fictional Recruiter",
      familyKey: "people",
      gradeCode: "G5",
    },
  ],
  ...extra,
});
/** A body at the given sizes, every title in the first family and grade. */
const sized = (families: number, grades: number, titles: number) => ({
  families: Array.from({ length: families }, (_, i) => ({
    key: `family-${i + 1}`,
    name: `Fictional family ${i + 1}`,
  })),
  grades: Array.from({ length: grades }, (_, i) => ({
    code: `G${i + 1}`,
    name: `Fictional grade ${i + 1}`,
    order: i + 1,
  })),
  titles: Array.from({ length: titles }, (_, i) => ({
    key: `title-${i + 1}`,
    name: `Fictional title ${i + 1}`,
    familyKey: "family-1",
    gradeCode: "G1",
  })),
});

/** One request through a route handler, signed in as the principal or with a Bearer token. */
async function route(
  p: Principal,
  handler: (request: Request, ctx: never) => Promise<Response>,
  path: string,
  init: { method?: string; body?: unknown; token?: boolean } = {},
  params: Record<string, string> = {},
) {
  vi.mocked(getVerifiedSession).mockResolvedValue({
    user: { id: p.userId, twoFactorEnabled: true },
    session: { activeOrganizationId: p.teamId },
  } as never);
  const response = await handler(
    new Request(`${ORIGIN}${path}`, {
      method: init.method ?? "GET",
      headers: {
        origin: ORIGIN,
        "x-team-id": p.teamId,
        ...(init.token
          ? { authorization: "Bearer fictional-architecture-token" }
          : {}),
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    { params: Promise.resolve(params) } as never,
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      data: Row;
      error?: { code: string };
    },
  };
}

describe("job families, titles and grades under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, orgAdmin: Principal, teamOwnerB: Principal;
  let teamAdmin: Principal, fieldsAdmin: Principal, recruiter: Principal;
  let viewer: Principal, ownerToken: Principal, orgAdminX: Principal;
  let unit: string;
  /** The company's published version ids by number. */
  const published: Record<number, string> = {};

  /** Raw reads as the PGlite superuser, which bypasses RLS; only to inspect outcomes. */
  const look = async <T = Row>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  /** One data-role statement under the principal's verified context. */
  const sqlAs = (principal: Principal, statement: string) =>
    harness.dataDb().then((db) =>
      withDeadlinesAndSnapshot(db, async (tx: TeamTx, snapshot) => {
        await installTenantContext(tx, principal, snapshot);
        return (await tx.execute(sql.raw(statement))).rows as Row[];
      }),
    );
  /** Every config, position and vacancy row, and every config and org activity row. */
  const state = async () => ({
    objects: await look("SELECT * FROM app.config_objects ORDER BY id"),
    versions: await look("SELECT * FROM app.config_versions ORDER BY id"),
    positions: await look("SELECT * FROM app.positions ORDER BY id"),
    vacancies: await look(
      "SELECT id, version, data, updated_at FROM app.records WHERE kind = 'vacancy' ORDER BY id",
    ),
    activity: await look(
      "SELECT id FROM app.activity WHERE kind IN ('config', 'org', 'record') ORDER BY id",
    ),
  });
  /** The call is refused with this status and code, and no row changes. */
  async function refused(
    call: () => Promise<unknown>,
    status: number,
    code: string,
  ) {
    const before = await state();
    await expect(call()).rejects.toMatchObject({ status, code });
    expect(await state()).toEqual(before);
  }
  /** The statement is refused with this SQLSTATE, and no row changes. */
  async function refusedSql(call: () => Promise<unknown>, code: string) {
    const before = await state();
    await expect(call()).rejects.toMatchObject({ cause: { code } });
    expect(await state()).toEqual(before);
  }
  /** The config activity rows of one workspace's job architecture, oldest first. */
  const audits = (workspace: string) =>
    look<{ action: string; metadata: Row }>(
      "SELECT action, metadata FROM app.activity WHERE kind = 'config' AND metadata->>'type' = 'job-architecture' AND metadata->>'workspaceId' = $1 ORDER BY created_at, id",
      [workspace],
    );
  async function draftAndPublish(p: Principal, body: JobArchitectureBody) {
    const { versionId } = await createConfigDraft(p, {
      ...TYPE,
      key: JOB_ARCHITECTURE_KEY,
      body,
    });
    const number = await publishConfigVersion(p, versionId, TYPE);
    return { versionId, number };
  }
  const positionRow = async (id: string) =>
    (
      await look<{ job_title_key: string | null }>(
        "SELECT job_title_key FROM app.positions WHERE id = $1",
        [id],
      )
    )[0];
  let serial = 0;
  const position = (p: Principal, extra: Row = {}) =>
    createPosition(p, {
      title: `Fictional Position ${++serial}`,
      code: `JA-${serial}`,
      orgUnitId: unit,
      ...extra,
    });
  const vacancy = (p: Principal, extra: Row = {}) =>
    createRecord(p, "vacancies", {
      data: { title: `Fictional Vacancy ${++serial}`, ...extra },
    });

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, { userId: "ja-owner", teamId: "ja-team-a" });
    const member = (
      userId: string,
      role: "admin" | "recruiter" | "viewer",
      teamId = "ja-team-a",
    ) => seedIdentity(db, { userId, teamId, role });
    teamAdmin = await member("ja-team-admin", "admin");
    recruiter = await member("ja-recruiter", "recruiter");
    viewer = await member("ja-viewer", "viewer");
    teamOwnerB = await seedIdentity(db, {
      userId: "ja-owner-b",
      teamId: "ja-team-b",
    });
    orgAdmin = await member("ja-org-admin", "recruiter", "ja-team-b");
    fieldsAdmin = await member("ja-fields-admin", "admin", "ja-team-b");
    await seedIdentity(db, { userId: "ja-owner-x", teamId: "ja-team-x" });
    orgAdminX = await member("ja-org-admin-x", "recruiter", "ja-team-x");
    ownerToken = await seedApiToken(db, owner);
    // Company authority and the second workspace are owner-written; no team is created after this.
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','ja-org-admin','admin','{organisation}'),
        ('${COMPANY}','ja-fields-admin','admin','{fields}');
      INSERT INTO app.workspaces(id,name) VALUES ('${OTHER}','Fictional Other Company');
      UPDATE app.workspace_teams SET workspace_id = '${OTHER}' WHERE team_id = 'ja-team-x';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${OTHER}','ja-owner-x','owner','{}'),
        ('${OTHER}','ja-org-admin-x','admin','{organisation}');
    `);
    const level = await createOrgLevel(owner, {
      name: "Fictional level",
      depth: 0,
    });
    unit = (
      await createOrgUnit(owner, {
        name: "Fictional Holdings",
        code: "JA-HOLD",
        levelId: level.id,
      })
    ).id;
  });
  afterAll(async () => harness?.close());

  describe("the strict body", () => {
    it("is the job-architecture schema of the store and accepts empty lists", () => {
      expect(configBodySchemas["job-architecture"]).toBe(
        jobArchitectureBodySchema,
      );
      expect(jobArchitectureBodySchema.parse(architecture())).toEqual(
        architecture(),
      );
      expect(
        jobArchitectureBodySchema.parse({
          families: [],
          grades: [],
          titles: [],
        }),
      ).toEqual({ families: [], grades: [], titles: [] });
    });

    it("accepts 200 families, 200 grades and 2,000 titles and refuses one more of each", () => {
      expect(
        jobArchitectureBodySchema.safeParse(sized(200, 200, 2000)).success,
      ).toBe(true);
      for (const [families, grades, titles, path] of [
        [201, 200, 2000, "families"],
        [200, 201, 2000, "grades"],
        [200, 200, 2001, "titles"],
      ] as const) {
        const result = jobArchitectureBodySchema.safeParse(
          sized(families, grades, titles),
        );
        expect(result.success, path).toBe(false);
        expect(result.error?.issues.map((issue) => issue.path)).toEqual([
          [path],
        ]);
      }
    });

    it("refuses a repeated family key, grade code, grade order and title key at the repeated entry", () => {
      const body = architecture();
      const cases: [Partial<JobArchitectureBody>, (string | number)[]][] = [
        [
          {
            families: [...body.families, { key: "finance", name: "Again" }],
          },
          ["families", 2, "key"],
        ],
        [
          {
            grades: [...body.grades, { code: "G5", name: "Again", order: 9 }],
          },
          ["grades", 2, "code"],
        ],
        [
          {
            grades: [...body.grades, { code: "G9", name: "Again", order: 7 }],
          },
          ["grades", 2, "order"],
        ],
        [
          {
            titles: [...body.titles, { ...body.titles[0], name: "Again" }],
          },
          ["titles", 3, "key"],
        ],
      ];
      for (const [changed, path] of cases) {
        const result = jobArchitectureBodySchema.safeParse(
          architecture(changed),
        );
        expect(result.success, JSON.stringify(path)).toBe(false);
        expect(result.error?.issues.map((issue) => issue.path)).toEqual([path]);
      }
    });

    it("refuses a title naming a family or grade the body does not hold", () => {
      const body = architecture();
      for (const [title, path] of [
        [{ ...body.titles[0], familyKey: "legal" }, ["titles", 0, "familyKey"]],
        [{ ...body.titles[0], gradeCode: "G9" }, ["titles", 0, "gradeCode"]],
      ] as const) {
        const result = jobArchitectureBodySchema.safeParse(
          architecture({ titles: [title, ...body.titles.slice(1)] }),
        );
        expect(result.success, JSON.stringify(path)).toBe(false);
        expect(result.error?.issues.map((issue) => issue.path)).toEqual([path]);
      }
    });

    it("refuses any unknown key at every level, so no pay figure or record id is stored", () => {
      const body = architecture();
      for (const changed of [
        { ...body, salary: 1 },
        { ...body, recordId: "00000000-0000-4000-a000-000000000009" },
        { ...body, families: [{ ...body.families[0], bracket: "B1" }] },
        { ...body, grades: [{ ...body.grades[0], salary: 30000 }] },
        { ...body, titles: [{ ...body.titles[0], minimum: 1000 }] },
      ])
        expect(
          jobArchitectureBodySchema.safeParse(changed).success,
          JSON.stringify(changed),
        ).toBe(false);
    });

    it("bounds keys, grade codes, orders and names", () => {
      const body = architecture();
      const grade = body.grades[0];
      const valid = (code: string, order = 1) =>
        jobArchitectureBodySchema.safeParse({
          families: [],
          grades: [{ ...grade, code, order }],
          titles: [],
        }).success;
      expect(valid("G")).toBe(true);
      expect(valid("A".repeat(20))).toBe(true);
      expect(valid("SR-LEAD-1", 1000)).toBe(true);
      for (const code of ["", "A".repeat(21), "g7", "-G7", "G 7"])
        expect(valid(code), code).toBe(false);
      for (const order of [0, 1001, 1.5])
        expect(valid("G1", order)).toBe(false);
      for (const changed of [
        { ...body, families: [{ key: "Finance", name: "Fictional" }] },
        { ...body, families: [{ key: "finance", name: "" }] },
        { ...body, families: [{ key: "finance", name: "a".repeat(121) }] },
      ])
        expect(
          jobArchitectureBodySchema.safeParse(changed).success,
          JSON.stringify(changed.families),
        ).toBe(false);
    });
  });

  describe("before any version is published", () => {
    it("refuses any job title key on a position or a vacancy and stores nothing", async () => {
      expect(await getJobArchitecture(recruiter)).toEqual({
        current: null,
        draft: null,
      });
      await refused(
        () => position(owner, { jobTitleKey: "payroll-lead" }),
        400,
        "invalid_reference",
      );
      await refused(
        () => vacancy(owner, { jobTitleKey: "payroll-lead" }),
        400,
        "invalid_reference",
      );
    });
  });

  describe("editors", () => {
    it("refuses any key but company before writing anything", async () => {
      await refused(
        () =>
          createConfigDraft(owner, {
            ...TYPE,
            key: "finance",
            body: architecture(),
          }),
        400,
        "invalid_input",
      );
    });

    it("lets the company owner draft, publish and version it, with one audit row each", async () => {
      const first = await draftAndPublish(owner, architecture());
      expect(first.number).toBe(1);
      const second = await draftAndPublish(
        owner,
        architecture({
          families: [
            ...architecture().families,
            { key: "legal", name: "Fictional Legal" },
          ],
        }),
      );
      expect(second.number).toBe(2);
      published[1] = first.versionId;
      published[2] = second.versionId;
      // Older versions stay readable and unchanged.
      expect(
        await look(
          "SELECT id, number, state, body FROM app.config_versions WHERE id IN ($1, $2) ORDER BY number",
          [first.versionId, second.versionId],
        ),
      ).toEqual([
        {
          id: first.versionId,
          number: 1,
          state: "published",
          body: architecture(),
        },
        {
          id: second.versionId,
          number: 2,
          state: "published",
          body: expect.objectContaining({
            families: expect.arrayContaining([
              { key: "legal", name: "Fictional Legal" },
            ]),
          }),
        },
      ]);
      const rows = await audits(COMPANY);
      expect(rows.map((row) => [row.action, row.metadata.versionId])).toEqual([
        ["config.draft_created", first.versionId],
        ["config.published", first.versionId],
        ["config.draft_created", second.versionId],
        ["config.published", second.versionId],
      ]);
      for (const row of rows) {
        expect(row.metadata).toMatchObject({
          type: "job-architecture",
          key: JOB_ARCHITECTURE_KEY,
          workspaceId: COMPANY,
        });
        expect(Object.keys(row.metadata).sort()).toEqual([
          "fromVersionId",
          "key",
          "number",
          "objectId",
          "type",
          "versionId",
          "workspaceId",
        ]);
        expect(JSON.stringify(row.metadata)).not.toContain("Fictional");
      }
    });

    it("lets a company admin with organisation draft, publish and version it, with one audit row each", async () => {
      const first = await draftAndPublish(orgAdminX, architecture());
      const second = await draftAndPublish(
        orgAdminX,
        architecture({ titles: architecture().titles.slice(0, 1) }),
      );
      expect([first.number, second.number]).toEqual([1, 2]);
      expect(
        (await audits(OTHER)).map((row) => [
          row.action,
          row.metadata.versionId,
          row.metadata.type,
        ]),
      ).toEqual([
        ["config.draft_created", first.versionId, "job-architecture"],
        ["config.published", first.versionId, "job-architecture"],
        ["config.draft_created", second.versionId, "job-architecture"],
        ["config.published", second.versionId, "job-architecture"],
      ]);
      // The other workspace's version never reaches this company.
      expect((await getJobArchitecture(recruiter)).current?.versionId).toBe(
        published[2],
      );
      // The company admin with organisation edits this company's drafts too.
      const { versionId } = await createConfigDraft(orgAdmin, {
        ...TYPE,
        key: JOB_ARCHITECTURE_KEY,
        body: architecture(),
      });
      await updateConfigDraft(
        orgAdmin,
        versionId,
        { body: architecture(), note: "Fictional note" },
        TYPE,
      );
      await expect(
        createConfigDraft(owner, {
          ...TYPE,
          key: JOB_ARCHITECTURE_KEY,
          body: architecture(),
        }),
      ).rejects.toMatchObject({ status: 409, code: "config_draft_exists" });
      expect((await getJobArchitecture(orgAdmin)).draft).toMatchObject({
        id: versionId,
        body: architecture(),
        note: "Fictional note",
      });
      expect(await publishConfigVersion(orgAdmin, versionId, TYPE)).toBe(3);
      published[3] = versionId;
    });
  });

  describe("everyone else", () => {
    let pending: string;
    beforeAll(async () => {
      ({ versionId: pending } = await createConfigDraft(owner, {
        ...TYPE,
        key: JOB_ARCHITECTURE_KEY,
        body: architecture(),
      }));
    });

    it("refuses create, update and publish with 403 and a direct insert with 42501", async () => {
      for (const p of [
        teamOwnerB,
        teamAdmin,
        fieldsAdmin,
        recruiter,
        viewer,
        ownerToken,
      ]) {
        await refused(
          () =>
            createConfigDraft(p, {
              ...TYPE,
              key: JOB_ARCHITECTURE_KEY,
              body: architecture(),
            }),
          403,
          "config_forbidden",
        );
        await refused(
          () => updateConfigDraft(p, pending, { body: architecture() }, TYPE),
          403,
          "config_forbidden",
        );
        await refused(
          () => publishConfigVersion(p, pending, TYPE),
          403,
          "config_forbidden",
        );
        await refusedSql(
          () =>
            sqlAs(
              p,
              `INSERT INTO app.config_objects(workspace_id, type, key) VALUES ('${COMPANY}', 'job-architecture', 'company')`,
            ),
          "42501",
        );
        for (const statement of [
          `SELECT tenant_context.publish_config_version('${pending}')`,
          `SELECT tenant_context.audit_config('${pending}', 'config.draft_created')`,
        ])
          await refusedSql(() => sqlAs(p, statement), "42501");
        expect(
          await sqlAs(
            p,
            `UPDATE app.config_versions SET note = 'Denied' WHERE id = '${pending}' RETURNING id`,
          ),
          p.userId,
        ).toEqual([]);
      }
    });

    it("refuses a token at every route with session_required and another type's version as not found", async () => {
      for (const [handler, method, path, params] of [
        [readRoute, "GET", "/api/v1/job-architecture", {}],
        [createRoute, "POST", "/api/v1/job-architecture", {}],
        [
          editRoute,
          "PUT",
          `/api/v1/job-architecture/${pending}`,
          { versionId: pending },
        ],
        [
          publishRoute,
          "POST",
          `/api/v1/job-architecture/${pending}/publish`,
          { versionId: pending },
        ],
      ] as const) {
        const before = await state();
        const response = await route(
          owner,
          handler as never,
          path,
          {
            method,
            token: true,
            ...(method === "GET" ? {} : { body: { body: architecture() } }),
          },
          params,
        );
        expect(response.status, path).toBe(403);
        expect(response.body.error?.code, path).toBe("session_required");
        expect(await state()).toEqual(before);
      }
      const { versionId: workflow } = await createConfigDraft(owner, {
        type: "workflow",
        key: "fictional-workflow",
        body: { label: "Fictional workflow" },
      });
      await refused(
        () => publishConfigVersion(owner, workflow, TYPE),
        404,
        "not_found",
      );
      await refused(
        () =>
          updateConfigDraft(owner, workflow, { body: architecture() }, TYPE),
        404,
        "not_found",
      );
    });
  });

  describe("every member", () => {
    it("reads the published body, and only editors see the pending draft", async () => {
      const current = {
        versionId: published[3],
        number: 3,
        body: architecture(),
      };
      for (const p of [recruiter, viewer, teamOwnerB, fieldsAdmin])
        expect(await getJobArchitecture(p), p.userId).toEqual({
          current,
          draft: null,
        });
      for (const p of [owner, orgAdmin])
        expect(await getJobArchitecture(p), p.userId).toEqual({
          current,
          draft: expect.objectContaining({ body: architecture(), note: null }),
        });
      const viewerRead = await route(
        viewer,
        readRoute as never,
        "/api/v1/job-architecture",
      );
      expect(viewerRead).toEqual({
        status: 200,
        body: { data: { current, draft: null } },
      });
    });

    it("writes and publishes through the routes for an editor", async () => {
      const { draft } = await getJobArchitecture(owner);
      const edited = await route(
        owner,
        editRoute as never,
        `/api/v1/job-architecture/${draft!.id}`,
        { method: "PUT", body: { body: architecture() } },
        { versionId: draft!.id },
      );
      expect(edited).toEqual({
        status: 200,
        body: { data: { versionId: draft!.id } },
      });
      const done = await route(
        owner,
        publishRoute as never,
        `/api/v1/job-architecture/${draft!.id}/publish`,
        { method: "POST" },
        { versionId: draft!.id },
      );
      expect(done).toEqual({
        status: 200,
        body: { data: { versionId: draft!.id, number: 4 } },
      });
      published[4] = draft!.id;
      const created = await route(
        orgAdmin,
        createRoute as never,
        "/api/v1/job-architecture",
        { method: "POST", body: { body: { families: [] } } },
      );
      expect(created.status).toBe(400);
      expect(created.body.error?.code).toBe("invalid_input");
    });
  });

  describe("positions", () => {
    it("store a published title key, return it, and clear it with null, naming only the field in activity", async () => {
      const before = new Set(
        (await look<{ id: string }>("SELECT id FROM app.activity")).map(
          (row) => row.id,
        ),
      );
      const created = await position(orgAdmin, { jobTitleKey: "payroll-lead" });
      expect(created.jobTitleKey).toBe("payroll-lead");
      expect(await positionRow(created.id)).toEqual({
        job_title_key: "payroll-lead",
      });
      const changed = await updatePosition(orgAdmin, created.id, {
        jobTitleKey: "recruiter",
      });
      expect(changed.jobTitleKey).toBe("recruiter");
      const cleared = await updatePosition(owner, created.id, {
        jobTitleKey: null,
      });
      expect(cleared.jobTitleKey).toBeNull();
      expect(await positionRow(created.id)).toEqual({ job_title_key: null });
      const plain = await position(owner);
      expect(plain.jobTitleKey).toBeNull();
      const rows = (
        await look<{ id: string; action: string; metadata: Row }>(
          "SELECT id, action, metadata FROM app.activity WHERE kind = 'org' ORDER BY created_at, id",
        )
      ).filter((row) => !before.has(row.id));
      expect(
        rows.map((row) => [
          row.action,
          row.metadata.positionId,
          row.metadata.fields,
        ]),
      ).toEqual([
        [
          "org.position_created",
          created.id,
          ["code", "isManager", "jobTitleKey", "orgUnitId", "title"],
        ],
        ["org.position_updated", created.id, ["jobTitleKey"]],
        ["org.position_updated", created.id, ["jobTitleKey"]],
        [
          "org.position_created",
          plain.id,
          ["code", "isManager", "orgUnitId", "title"],
        ],
      ]);
      for (const key of ["payroll-lead", "recruiter"])
        expect(JSON.stringify(rows)).not.toContain(key);
    });

    it("refuse an unknown key with invalid_reference and leave the row unchanged", async () => {
      const held = await position(owner, { jobTitleKey: "payroll-lead" });
      await refused(
        () => position(owner, { jobTitleKey: "payroll-director" }),
        400,
        "invalid_reference",
      );
      await refused(
        () =>
          updatePosition(owner, held.id, { jobTitleKey: "payroll-director" }),
        400,
        "invalid_reference",
      );
      await refused(
        () =>
          updatePosition(owner, held.id, {
            title: "Fictional renamed",
            jobTitleKey: "payroll-director",
          }),
        400,
        "invalid_reference",
      );
      expect(await positionRow(held.id)).toEqual({
        job_title_key: "payroll-lead",
      });
      // The message never lists the valid keys.
      await expect(
        position(owner, { jobTitleKey: "payroll-director" }),
      ).rejects.toMatchObject({
        message:
          "jobTitleKey is not a job title of the published job architecture.",
      });
    });
  });

  describe("vacancies", () => {
    it("take a published title key, refuse an unknown one and keep an unchanged stale one", async () => {
      const plain = await vacancy(recruiter);
      expect(Object.hasOwn(plain.data, "jobTitleKey")).toBe(false);
      const titled = await vacancy(recruiter, { jobTitleKey: "payroll-lead" });
      expect(titled.data).toMatchObject({ jobTitleKey: "payroll-lead" });
      await refused(
        () => vacancy(recruiter, { jobTitleKey: "payroll-director" }),
        400,
        "invalid_reference",
      );
      await refused(
        () =>
          updateRecord(recruiter, "vacancies", plain.id, {
            version: plain.version,
            data: { jobTitleKey: "payroll-director" },
          }),
        400,
        "invalid_reference",
      );
      const set = await updateRecord(recruiter, "vacancies", plain.id, {
        version: plain.version,
        data: { jobTitleKey: "recruiter" },
      });
      expect(set.data).toMatchObject({ jobTitleKey: "recruiter" });
      // A later version drops payroll-lead; an unrelated edit of the titled vacancy still saves.
      await draftAndPublish(
        owner,
        architecture({
          titles: architecture().titles.filter(
            (title) => title.key !== "payroll-lead",
          ),
        }),
      );
      const renamed = await updateRecord(recruiter, "vacancies", titled.id, {
        version: titled.version,
        data: { title: "Fictional renamed vacancy" },
      });
      expect(renamed.data).toMatchObject({
        title: "Fictional renamed vacancy",
        jobTitleKey: "payroll-lead",
      });
      // Setting the removed key again is a change, and is refused.
      await refused(
        () =>
          updateRecord(recruiter, "vacancies", set.id, {
            version: set.version,
            data: { jobTitleKey: "payroll-lead" },
          }),
        400,
        "invalid_reference",
      );
    });
  });
});

// Job title usage (ADM-27, job 088): a fresh fictional company with two teams, and a team of another
// fictional workspace, all holding the title payroll-lead. Only current positions, Open vacancies and
// Draft or Sent offers of the company's own teams count.
describe("job title usage under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, orgAdmin: Principal, teamOwnerB: Principal;
  let fieldsAdmin: Principal, recruiter: Principal, ownerToken: Principal;
  const usageSql =
    "SELECT * FROM tenant_context.job_title_usage('payroll-lead')";
  const look = async <T = Row>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  const sqlAs = (principal: Principal, statement: string) =>
    harness.dataDb().then((db) =>
      withDeadlinesAndSnapshot(db, async (tx: TeamTx, snapshot) => {
        await installTenantContext(tx, principal, snapshot);
        return (await tx.execute(sql.raw(statement))).rows as Row[];
      }),
    );
  const activityCount = async () =>
    (
      await look<{ n: number }>("SELECT count(*)::int AS n FROM app.activity")
    )[0].n;

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    owner = await seedIdentity(db, { userId: "ju-owner", teamId: "ju-team-a" });
    recruiter = await seedIdentity(db, {
      userId: "ju-recruiter",
      teamId: "ju-team-a",
      role: "recruiter",
    });
    teamOwnerB = await seedIdentity(db, {
      userId: "ju-owner-b",
      teamId: "ju-team-b",
    });
    orgAdmin = await seedIdentity(db, {
      userId: "ju-org-admin",
      teamId: "ju-team-b",
      role: "recruiter",
    });
    fieldsAdmin = await seedIdentity(db, {
      userId: "ju-fields-admin",
      teamId: "ju-team-b",
      role: "admin",
    });
    await seedIdentity(db, { userId: "ju-owner-x", teamId: "ju-team-x" });
    ownerToken = await seedApiToken(db, owner);
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','ju-org-admin','admin','{organisation}'),
        ('${COMPANY}','ju-fields-admin','admin','{fields}');
      INSERT INTO app.workspaces(id,name) VALUES ('${OTHER}','Fictional Other Company');
      UPDATE app.workspace_teams SET workspace_id = '${OTHER}' WHERE team_id = 'ju-team-x';
    `);
    // Company rows are written as the owner, which the directory guard lets close and archive a
    // position; team records as the PGlite superuser. The helper then reads them as the owner.
    const id = (n: number) =>
      `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
    const vacancy = (status: string, key = "payroll-lead") =>
      JSON.stringify({ title: "Fictional Vacancy", status, jobTitleKey: key });
    const offer = (status: string) =>
      JSON.stringify({ title: "Fictional Offer", status });
    await harness.client.exec(`
      INSERT INTO app.org_levels(id,workspace_id,name,depth) VALUES
        ('${id(1)}','${COMPANY}','Fictional level',0),
        ('${id(2)}','${OTHER}','Fictional other level',0);
      INSERT INTO app.org_units(id,workspace_id,level_id,name,code) VALUES
        ('${id(3)}','${COMPANY}','${id(1)}','Fictional Holdings','JU-HOLD'),
        ('${id(4)}','${OTHER}','${id(2)}','Fictional Other Holdings','JU-OTHER');
      INSERT INTO app.positions(workspace_id,org_unit_id,title,code,job_title_key,valid_from,valid_to,archived_at) VALUES
        ('${COMPANY}','${id(3)}','Fictional Payroll Lead','JU-1','payroll-lead',now(),NULL,NULL),
        ('${COMPANY}','${id(3)}','Fictional Payroll Lead','JU-2','payroll-lead',now(),NULL,NULL),
        ('${COMPANY}','${id(3)}','Fictional Payroll Lead','JU-3','payroll-lead',now(),NULL,now()),
        ('${COMPANY}','${id(3)}','Fictional Payroll Lead','JU-4','payroll-lead',now() - interval '1 day',now(),NULL),
        ('${COMPANY}','${id(3)}','Fictional Recruiter','JU-5','recruiter',now(),NULL,NULL),
        ('${OTHER}','${id(4)}','Fictional Payroll Lead','JU-6','payroll-lead',now(),NULL,NULL);
    `);
    await harness.asSuperuser();
    await harness.client.exec(`
      INSERT INTO app.records(id,team_id,kind,data,created_by,archived_at) VALUES
        ('${id(10)}','ju-team-a','vacancy','${vacancy("Open")}','ju-owner',NULL),
        ('${id(11)}','ju-team-a','vacancy','${vacancy("Closed")}','ju-owner',NULL),
        ('${id(12)}','ju-team-a','vacancy','${vacancy("Open")}','ju-owner',now()),
        ('${id(13)}','ju-team-a','vacancy','${vacancy("Open", "recruiter")}','ju-owner',NULL),
        ('${id(20)}','ju-team-b','vacancy','${vacancy("Open")}','ju-owner-b',NULL),
        ('${id(21)}','ju-team-b','vacancy','${vacancy("Draft")}','ju-owner-b',NULL),
        ('${id(30)}','ju-team-x','vacancy','${vacancy("Open")}','ju-owner-x',NULL),
        ('${id(14)}','ju-team-a','candidate','{"name":"Fictional Candidate A"}','ju-owner',NULL),
        ('${id(22)}','ju-team-b','candidate','{"name":"Fictional Candidate B"}','ju-owner-b',NULL),
        ('${id(31)}','ju-team-x','candidate','{"name":"Fictional Candidate X"}','ju-owner-x',NULL);
      INSERT INTO app.records(id,team_id,kind,data,created_by,candidate_id,vacancy_id) VALUES
        ('${id(15)}','ju-team-a','application','{"stage":"Offer"}','ju-owner','${id(14)}','${id(10)}'),
        ('${id(23)}','ju-team-b','application','{"stage":"Offer"}','ju-owner-b','${id(22)}','${id(20)}'),
        ('${id(32)}','ju-team-x','application','{"stage":"Offer"}','ju-owner-x','${id(31)}','${id(30)}');
      INSERT INTO app.records(id,team_id,kind,data,created_by,application_id,archived_at) VALUES
        ('${id(16)}','ju-team-a','offer','${offer("Draft")}','ju-owner','${id(15)}',NULL),
        ('${id(17)}','ju-team-a','offer','${offer("Accepted")}','ju-owner','${id(15)}',NULL),
        ('${id(24)}','ju-team-b','offer','${offer("Sent")}','ju-owner-b','${id(23)}',NULL),
        ('${id(25)}','ju-team-b','offer','${offer("Declined")}','ju-owner-b','${id(23)}',NULL),
        ('${id(26)}','ju-team-b','offer','${offer("Sent")}','ju-owner-b','${id(23)}',now()),
        ('${id(33)}','ju-team-x','offer','${offer("Sent")}','ju-owner-x','${id(32)}',NULL);
    `);
  });
  afterAll(async () => harness?.close());

  it("counts the company's current positions, open vacancies and open offers, for owners and admins with organisation", async () => {
    const before = await activityCount();
    for (const p of [owner, orgAdmin]) {
      const rows = await sqlAs(p, usageSql);
      expect(rows, p.userId).toEqual([
        { positions: 2, open_vacancies: 2, open_offers: 2 },
      ]);
      expect(Object.keys(rows[0])).toEqual([
        "positions",
        "open_vacancies",
        "open_offers",
      ]);
      expect(
        await sqlAs(
          p,
          "SELECT * FROM tenant_context.job_title_usage('people-partner')",
        ),
      ).toEqual([{ positions: 0, open_vacancies: 0, open_offers: 0 }]);
    }
    expect(await jobTitleUsage(orgAdmin, "recruiter")).toEqual({
      positions: 1,
      openVacancies: 1,
      openOffers: 0,
    });
    const response = await route(
      owner,
      usageRoute as never,
      "/api/v1/job-architecture/usage?titleKey=payroll-lead",
    );
    expect(response).toEqual({
      status: 200,
      body: { data: { positions: 2, openVacancies: 2, openOffers: 2 } },
    });
    expect(await activityCount()).toBe(before);
  });

  it("refuses every other context with 42501, and a null key with 22023", async () => {
    const before = await activityCount();
    for (const p of [teamOwnerB, fieldsAdmin, recruiter, ownerToken])
      await expect(sqlAs(p, usageSql), p.userId).rejects.toMatchObject({
        cause: { code: "42501" },
      });
    // No context at all.
    const db = await harness.dataDb();
    await expect(db.execute(sql.raw(usageSql))).rejects.toMatchObject({
      cause: { code: "42501" },
    });
    await expect(
      sqlAs(owner, "SELECT * FROM tenant_context.job_title_usage(NULL)"),
    ).rejects.toMatchObject({ cause: { code: "22023" } });
    for (const p of [teamOwnerB, fieldsAdmin, recruiter, ownerToken])
      await expect(
        jobTitleUsage(p, "payroll-lead"),
        p.userId,
      ).rejects.toMatchObject({ status: 403, code: "config_forbidden" });
    expect(await activityCount()).toBe(before);
  });

  it("answers the route's refusals, a token and bad input with no data-pool call", async () => {
    for (const p of [teamOwnerB, fieldsAdmin, recruiter]) {
      const response = await route(
        p,
        usageRoute as never,
        "/api/v1/job-architecture/usage?titleKey=payroll-lead",
      );
      expect(response.status, p.userId).toBe(403);
      expect(response.body.error?.code, p.userId).toBe("config_forbidden");
    }
    for (const [path, token, status, code] of [
      [
        "/api/v1/job-architecture/usage?titleKey=payroll-lead",
        true,
        403,
        "session_required",
      ],
      ["/api/v1/job-architecture/usage", false, 400, "invalid_input"],
      [
        "/api/v1/job-architecture/usage?titleKey=Not_A_Key",
        false,
        400,
        "invalid_input",
      ],
    ] as const) {
      pools.data.mockClear();
      const response = await route(owner, usageRoute as never, path, { token });
      expect(response.status, path).toBe(status);
      expect(response.body.error?.code, path).toBe(code);
      expect(pools.data, path).not.toHaveBeenCalled();
    }
  });

  it("is owner-run, SECURITY DEFINER, with a fixed search_path and no PUBLIC EXECUTE", async () => {
    expect(
      await look(
        `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
           p.prosecdef AS definer, p.proconfig AS config,
           has_function_privilege('public', p.oid, 'EXECUTE') AS public
         FROM pg_proc p WHERE p.oid = 'tenant_context.job_title_usage(text)'::regprocedure`,
      ),
    ).toEqual([
      {
        owned: true,
        definer: true,
        config: ["search_path=pg_catalog, pg_temp"],
        public: false,
      },
    ]);
  });
});
