import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));
vi.mock("@/lib/api-tokens", () => ({ authenticateApiToken: vi.fn() }));

import { POST as exportRoute } from "../src/app/api/v1/[resource]/export/route";
import { schema, type AppDb } from "../src/db";
import { activity } from "../src/db/schema";
import { JOB_ARCHITECTURE_KEY } from "../src/domain/config";
import { authenticateApiToken } from "../src/lib/api-tokens";
import { getVerifiedSession } from "../src/lib/auth-session";
import {
  createConfigDraft,
  publishConfigVersion,
} from "../src/lib/config-store";
import { withTeam } from "../src/lib/db-team";
import {
  createSalaryBracketDraft,
  publishSalaryBracketVersion,
} from "../src/lib/pay-brackets";
import type { Principal } from "../src/lib/principal";
import {
  EXPORT_FILTER_KEYS,
  createRecord,
  exportRecords,
  getCandidateState,
  updateCandidateState,
} from "../src/lib/records";
import {
  createSplitRoleDb,
  createTestDb,
  enforceTestRls,
  seedApiToken,
  seedIdentity,
} from "./helpers/db";

const ORIGIN = "http://localhost:3000";
const errorOf = (error: unknown) =>
  (error as { cause?: { code?: string } })?.cause?.code ??
  (error as { code?: string })?.code;

describe("server-side record export over real migrations and RLS", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal;
  let large: Principal;
  /** Inspection and fixture setup as the bootstrap superuser, outside RLS. */
  async function asSuperuser<T>(work: () => Promise<T>): Promise<T> {
    await fixture.client.exec("RESET ROLE");
    try {
      return await work();
    } finally {
      await fixture.client.exec("SET ROLE recruitment_test_runtime");
    }
  }
  const exportRows = (teamId: string) =>
    asSuperuser(
      async () =>
        (
          await fixture.client.query<{
            actor_id: string;
            actor_type: string;
            record_id: string | null;
            action: string;
            summary: string;
            metadata: Record<string, unknown>;
          }>(
            "SELECT actor_id, actor_type, record_id, action, summary, metadata FROM app.activity WHERE kind='export' AND team_id=$1 ORDER BY created_at",
            [teamId],
          )
        ).rows,
    );
  function post(
    path: string,
    headers: Record<string, string> = { origin: ORIGIN },
  ) {
    const resource = path.split("/")[3];
    return exportRoute(
      new Request(`${ORIGIN}${path}`, { method: "POST", headers }),
      { params: Promise.resolve({ resource }) },
    );
  }
  const signIn = (p: Principal) =>
    vi.mocked(getVerifiedSession).mockResolvedValue({
      user: { id: p.userId, twoFactorEnabled: true },
      session: { activeOrganizationId: p.teamId },
    } as never);

  beforeAll(async () => {
    vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
    fixture = await createTestDb();
    pools.data.mockResolvedValue(fixture.db);
    pools.identity.mockResolvedValue(fixture.db);
    owner = await seedIdentity(fixture.db, {
      userId: "export-owner",
      teamId: "export-team",
    });
    large = await seedIdentity(fixture.db, {
      userId: "export-large-owner",
      teamId: "export-large-team",
    });
    await enforceTestRls(fixture.db);
    for (const [name, skills] of [
      ["Fictional Export One", ["SQL", "Excel"]],
      ["Fictional Export Two", ["SQL"]],
      ["Fictional Export Three", ["Python"]],
      ["Other Export Person", ["SQL"]],
    ] as const)
      await createRecord(owner, "candidates", {
        data: { name, skills: [...skills] },
      });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await fixture?.close();
  });

  it("streams the labelled CSV and records who exported which list, rows and filter keys", async () => {
    signIn(owner);
    const query = new URLSearchParams({
      search: "Fictional",
      skills: JSON.stringify(["SQL"]),
      sort: "name",
      direction: "asc",
    });
    const response = await post(`/api/v1/candidates/export?${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-export-rows")).toBe("2");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="RecruitmentOS-candidates-\d{4}-\d{2}-\d{2}-\d{4}\.csv"; filename\*=UTF-8''RecruitmentOS-candidates-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/,
    );
    // Keep the byte-order mark that spreadsheet apps use to detect UTF-8.
    const lines = new TextDecoder("utf-8", { ignoreBOM: true })
      .decode(await response.arrayBuffer())
      .split("\r\n");
    expect(lines[0]).toBe(`\uFEFF"RecruitmentOS export","Candidates"`);
    expect(lines[1]).toMatch(/^"Exported at",".+ \(Asia\/Dubai\)"$/);
    expect(lines[2]).toBe('"Environment","Local development"');
    expect(lines[3]).toBe('"Filters","Search: ""Fictional""; Skills: SQL"');
    expect(lines[4]).toBe('"Rows","2"');
    expect(lines[5]).toMatch(/^"Data protection","This file contains/);
    expect(lines[6]).toBe("");
    expect(lines[7]).toMatch(/^"Record ID","Name",/);
    expect(lines[7]).toMatch(/,"Created at","Updated at"$/);
    expect(lines.slice(8)).toHaveLength(2);
    expect(lines[8]).toContain('"Fictional Export One"');
    expect(lines[9]).toContain('"Fictional Export Two"');
    const rows = await exportRows(owner.teamId);
    expect(rows).toEqual([
      {
        actor_id: owner.userId,
        actor_type: "session",
        record_id: null,
        action: "records.exported",
        summary: "Exported 2 candidates",
        metadata: {
          resource: "candidates",
          rows: 2,
          filters: ["search", "skills"],
        },
      },
    ]);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain("Fictional");
    expect(stored).not.toContain("SQL");
  });

  it("lets a viewer export and refuses a token without candidates:read", async () => {
    const viewer = await seedIdentity(fixture.db, {
      userId: "export-viewer",
      teamId: owner.teamId,
      role: "viewer",
    });
    signIn(viewer);
    const viewed = await post("/api/v1/candidates/export?needsReview=true");
    expect(viewed.status).toBe(200);
    expect(viewed.headers.get("x-export-rows")).toBe("4");
    expect((await exportRows(owner.teamId)).at(-1)).toMatchObject({
      actor_id: viewer.userId,
      actor_type: "session",
      metadata: { resource: "candidates", rows: 4, filters: ["needsReview"] },
    });
    const before = (await exportRows(owner.teamId)).length;
    vi.mocked(authenticateApiToken).mockResolvedValue(
      await seedApiToken(fixture.db, owner, ["recruitment:read"]),
    );
    const refused = await post("/api/v1/candidates/export", {
      authorization: "Bearer fictional-export-token",
    });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("forbidden");
    expect(await exportRows(owner.teamId)).toHaveLength(before);
  });

  it("applies private shortlist and follow-up filters but leaves them out of the team-visible audit", async () => {
    signIn(owner);
    const [one] = await asSuperuser(
      async () =>
        (
          await fixture.client.query<{ id: string }>(
            "SELECT id FROM app.records WHERE team_id=$1 AND data->>'name'='Fictional Export One'",
            [owner.teamId],
          )
        ).rows,
    );
    const state = await getCandidateState(owner, one.id);
    await updateCandidateState(owner, one.id, {
      version: state.version,
      shortlisted: true,
      status: "Contacted",
    });
    const query = new URLSearchParams({
      shortlisted: "true",
      status: "Contacted",
      skills: JSON.stringify(["SQL"]),
    });
    const response = await post(`/api/v1/candidates/export?${query}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-export-rows")).toBe("1");
    const lines = new TextDecoder("utf-8", { ignoreBOM: true })
      .decode(await response.arrayBuffer())
      .split("\r\n");
    // The exporter's own file still names every filter it used.
    expect(lines[3]).toBe(
      '"Filters","Follow-up status: Contacted; Skills: SQL; My shortlist only"',
    );
    expect(lines.slice(8)).toHaveLength(1);
    expect(lines[8]).toContain('"Fictional Export One"');
    const candidates = (await exportRows(owner.teamId)).at(-1)!;
    expect(candidates.metadata).toEqual({
      resource: "candidates",
      rows: 1,
      filters: ["skills"],
    });
    expect(Object.keys(candidates.metadata).sort()).toEqual([
      "filters",
      "resource",
      "rows",
    ]);
    expect(JSON.stringify(candidates)).not.toMatch(
      /shortlist|status|Contacted|SQL/i,
    );

    await createRecord(owner, "vacancies", {
      data: { title: "Fictional Open Vacancy", status: "Open" },
    });
    const vacancies = await post("/api/v1/vacancies/export?status=Open");
    expect(vacancies.status).toBe(200);
    expect(vacancies.headers.get("x-export-rows")).toBe("1");
    expect((await exportRows(owner.teamId)).at(-1)!.metadata).toEqual({
      resource: "vacancies",
      rows: 1,
      filters: ["status"],
    });
  });

  it("refuses pages, unexportable resources, a missing origin and oversized exports", async () => {
    signIn(owner);
    const before = (await exportRows(owner.teamId)).length;
    for (const path of [
      "/api/v1/candidates/export?page=1",
      "/api/v1/candidates/export?pageSize=100",
    ]) {
      const response = await post(path);
      expect(response.status, path).toBe(400);
      expect((await response.json()).error.code, path).toBe("invalid_query");
    }
    const views = await post("/api/v1/views/export");
    expect(views.status).toBe(404);
    expect((await views.json()).error.code).toBe("not_found");
    const noOrigin = await post("/api/v1/candidates/export", {});
    expect(noOrigin.status).toBe(403);
    expect((await noOrigin.json()).error.code).toBe("invalid_origin");
    expect(await exportRows(owner.teamId)).toHaveLength(before);

    await asSuperuser(() =>
      fixture.client.query(
        `INSERT INTO app.records(id, team_id, kind, data, created_by)
          SELECT gen_random_uuid(), $1, 'job-role', jsonb_build_object('title', 'Fictional role ' || n), $2
          FROM generate_series(1, 100001) AS n`,
        [large.teamId, large.userId],
      ),
    );
    // Serve both exports over the same client with every statement recorded.
    const statements: string[] = [];
    pools.data.mockResolvedValue(
      drizzle(fixture.client, {
        schema,
        logger: { logQuery: (query) => statements.push(query) },
      }) as unknown as AppDb,
    );
    const loadsRows = (statement: string) =>
      statement.includes('from "app"."records"') &&
      statement.includes("over ()");
    try {
      signIn(large);
      const tooLarge = await post("/api/v1/job-roles/export");
      expect(tooLarge.status).toBe(400);
      expect(await tooLarge.json()).toMatchObject({
        error: {
          code: "export_too_large",
          message: "This export is too large. Narrow your filters.",
        },
      });
      expect(await exportRows(large.teamId)).toEqual([]);
      // The bounded count read the table; no statement loaded its rows.
      expect(
        statements.filter((statement) =>
          statement.includes('from "app"."records"'),
        ),
      ).toHaveLength(1);
      expect(statements.filter(loadsRows)).toEqual([]);

      statements.length = 0;
      signIn(owner);
      const normal = await post("/api/v1/candidates/export?search=Fictional");
      expect(normal.status).toBe(200);
      expect(normal.headers.get("x-export-rows")).toBe("3");
      const lines = new TextDecoder("utf-8", { ignoreBOM: true })
        .decode(await normal.arrayBuffer())
        .split("\r\n");
      expect(lines[4]).toBe('"Rows","3"');
      expect(lines.slice(8)).toHaveLength(3);
      expect(statements.filter(loadsRows)).toHaveLength(1);
      expect(await exportRows(owner.teamId)).toHaveLength(before + 1);
    } finally {
      pools.data.mockResolvedValue(fixture.db);
    }
  }, 120000);

  it("sends no file when the export audit row cannot be written", async () => {
    signIn(owner);
    const before = (await exportRows(owner.teamId)).length;
    await asSuperuser(() =>
      fixture.client.exec(`
        CREATE FUNCTION app.reject_test_export_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.kind = 'export' THEN RAISE EXCEPTION 'Fictional audit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_test_export_audit BEFORE INSERT ON app.activity
          FOR EACH ROW EXECUTE FUNCTION app.reject_test_export_audit();`),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await post("/api/v1/candidates/export");
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toMatch(
        /^application\/json/,
      );
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(await response.text()).not.toContain("Record ID");
    } finally {
      vi.mocked(console.error).mockRestore();
      await asSuperuser(() =>
        fixture.client.exec(
          "DROP TRIGGER reject_test_export_audit ON app.activity; DROP FUNCTION app.reject_test_export_audit()",
        ),
      );
    }
    expect(await exportRows(owner.teamId)).toHaveLength(before);
  });

  it("exports a pinned offer with no bracket column, key, version id or figure (ADM-25)", async () => {
    // Fictional figures in AED fils; the owner grants themselves Plan & pay access as fixture SQL.
    const figures = ["4321987", "5321987", "6321987"];
    await asSuperuser(() =>
      fixture.client.exec(
        "UPDATE app.workspace_admins SET plan_access = true WHERE user_id = 'export-owner'",
      ),
    );
    const { versionId: architecture } = await createConfigDraft(owner, {
      type: "job-architecture",
      key: JOB_ARCHITECTURE_KEY,
      body: {
        families: [{ key: "finance", name: "Fictional Finance" }],
        grades: [{ code: "G7", name: "Fictional Lead", order: 7 }],
        titles: [
          {
            key: "payroll-lead",
            name: "Fictional Payroll Lead",
            familyKey: "finance",
            gradeCode: "G7",
          },
        ],
      },
    });
    await publishConfigVersion(owner, architecture, {
      type: "job-architecture",
    });
    const draft = await createSalaryBracketDraft(owner, {
      effectiveFrom: "2027-01-01",
      brackets: [
        {
          gradeCode: "G7",
          minimumFils: Number(figures[0]),
          midpointFils: Number(figures[1]),
          maximumFils: Number(figures[2]),
        },
      ],
    });
    await publishSalaryBracketVersion(owner, draft.versionId);
    const vacancy = await createRecord(owner, "vacancies", {
      data: { title: "Fictional Pinned Vacancy", jobTitleKey: "payroll-lead" },
    });
    const candidate = await createRecord(owner, "candidates", {
      data: { name: "Pinned Offer Person" },
    });
    const application = await createRecord(owner, "applications", {
      candidateId: candidate.id,
      vacancyId: vacancy.id,
      data: { stage: "Offer" },
    });
    const offer = await createRecord(owner, "offers", {
      applicationId: application.id,
      data: { title: "Fictional pinned offer", amount: "21000" },
    });
    expect(
      await asSuperuser(
        async () =>
          (
            await fixture.client.query(
              "SELECT pay_bracket_version_id AS pin FROM app.records WHERE id = $1",
              [offer.id],
            )
          ).rows,
      ),
    ).toEqual([{ pin: draft.versionId }]);
    signIn(owner);
    const response = await post("/api/v1/offers/export");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-export-rows")).toBe("1");
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      await response.arrayBuffer(),
    );
    expect(text).toContain('"Fictional pinned offer"');
    expect(text).not.toMatch(/bracket/i);
    expect(text).not.toContain(draft.versionId);
    for (const figure of figures) expect(text).not.toContain(figure);
    const audit = JSON.stringify(await exportRows(owner.teamId));
    expect(audit).not.toMatch(/bracket/i);
  });
});

describe("export audit rows under the split data role", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  let member: Principal;
  let viewer: Principal;
  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db = await harness.asOwner();
    member = await seedIdentity(db, { userId: "split-export-owner" });
    viewer = await seedIdentity(db, {
      userId: "split-export-viewer",
      role: "viewer",
    });
  });
  afterAll(async () => harness?.close());

  const audit = (resource: string, rows: number, keys: string[]) =>
    sql`select tenant_context.audit_export(${resource}::text, ${rows}::integer, array[${sql.join(
      keys.map((key) => sql`${key}`),
      sql`, `,
    )}]::text[])`;
  async function denied(work: () => Promise<unknown>) {
    let failure: unknown;
    await work().catch((error) => {
      failure = error;
    });
    expect(errorOf(failure)).toBe("42501");
  }
  const rows = async () =>
    (
      await (
        await harness.asSuperuser()
      ).execute<{
        actor_id: string;
        actor_type: string;
        token_id: string | null;
        summary: string;
        metadata: Record<string, unknown>;
      }>(
        sql`select actor_id, actor_type, token_id::text, summary, metadata from app.activity where kind='export' order by created_at`,
      )
    ).rows;

  it("records a viewer's export through the helper", async () => {
    const result = await exportRecords(
      viewer,
      "candidates",
      new URLSearchParams({ search: "nothing fictional matches" }),
    );
    expect(result.total).toBe(0);
    expect(await rows()).toEqual([
      {
        actor_id: viewer.userId,
        actor_type: "session",
        token_id: null,
        summary: "Exported 0 candidates",
        metadata: { resource: "candidates", rows: 0, filters: ["search"] },
      },
    ]);
  });

  it("refuses direct export inserts, missing contexts and anything outside the reviewed values", async () => {
    const before = (await rows()).length;
    const writer = await seedApiToken(await harness.asOwner(), member, [
      "candidates:read",
      "candidates:write",
      "recruitment:read",
      "recruitment:write",
    ]);
    await denied(() =>
      withTeam(writer, (tx) =>
        tx.insert(activity).values({
          teamId: member.teamId,
          actorId: member.userId,
          actorType: "token",
          tokenId: writer.tokenId,
          action: "records.exported",
          kind: "export",
          summary: "Forged export",
        }),
      ),
    );
    await denied(async () =>
      (await harness.dataDb()).execute(audit("candidates", 1, [])),
    );
    for (const [resource, count, keys] of [
      ["views", 1, []],
      ["comments", 1, []],
      ["candidates", -1, []],
      ["candidates", 100001, []],
      ["candidates", 1, ["page"]],
      ["candidates", 1, ["sort"]],
      ["candidates", 1, ["search", "fictionalUnknownKey"]],
    ] as const)
      await denied(() =>
        withTeam(member, (tx) => tx.execute(audit(resource, count, [...keys]))),
      );
    const recruitmentOnly = await seedApiToken(
      await harness.asOwner(),
      member,
      ["recruitment:read"],
    );
    await denied(() =>
      withTeam(recruitmentOnly, (tx) => tx.execute(audit("candidates", 1, []))),
    );
    await withTeam(recruitmentOnly, (tx) =>
      tx.execute(audit("vacancies", 3, ["status", "status", "search"])),
    );
    const after = await rows();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toEqual({
      actor_id: member.userId,
      actor_type: "token",
      token_id: recruitmentOnly.tokenId,
      summary: "Exported 3 vacancies",
      metadata: {
        resource: "vacancies",
        rows: 3,
        filters: ["search", "status"],
      },
    });
  });

  it("accepts exactly the TypeScript export filter keys", async () => {
    await withTeam(member, (tx) =>
      tx.execute(audit("candidates", 100000, [...EXPORT_FILTER_KEYS])),
    );
    expect((await rows()).at(-1)?.metadata).toEqual({
      resource: "candidates",
      rows: 100000,
      filters: [...EXPORT_FILTER_KEYS].sort(),
    });
    for (const extra of ["page", "pageSize", "sort", "direction"])
      await denied(() =>
        withTeam(member, (tx) => tx.execute(audit("candidates", 1, [extra]))),
      );
    const source = (
      await (
        await harness.asSuperuser()
      ).execute<{ src: string }>(
        sql`select p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tenant_context' and p.proname = 'audit_export'`,
      )
    ).rows[0].src;
    const listed = /f\.k NOT IN \(([^)]*)\)/.exec(source)![1];
    expect([...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()).toEqual(
      [...EXPORT_FILTER_KEYS].sort(),
    );
  });
});
