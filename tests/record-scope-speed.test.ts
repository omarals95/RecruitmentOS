import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requests pick the pool by role, as on a split-role deployment: the identity role reads the
// membership, the data role runs withTeam. Only one PGlite role is active at a time.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));

import type { AppDb } from "@/db";
import { createConfigDraft, publishConfigVersion } from "@/lib/config-store";
import {
  createEmployee,
  createPosition,
  linkEmployeeUser,
  setEmployeePositions,
} from "@/lib/directory";
import { overview } from "@/lib/insights";
import { assignMemberRole } from "@/lib/member-roles";
import { createOrgLevel, createOrgUnit } from "@/lib/org";
import type { Principal } from "@/lib/principal";
import { listRecords } from "@/lib/records";
import {
  defaultListQuery,
  listSearchParams,
  tabRequests,
} from "@/components/workspace/tab-requests";
import { HIRING_MANAGER_ROLE } from "@/domain/config-defaults";
import type { RoleBody } from "@/domain/config";
import { APPLICATION_STAGES, type ResourceName } from "@/domain/records";
import { createSplitRoleDb, seedIdentity } from "./helpers/db";

// R2-PERF-01: the scoped hiring manager's overview and first-load lists on a fictional fixture of
// the benchmark's sizes and shape (scripts/benchmark-round-trips.ts --fixture --scoped), read as the
// data role under row-level security. The bound is generous; main took 14 to 30 s here.
const TEAM = "speed-team";
const BOUND_MS = 5000;
const CANDIDATES = 2000;
const VACANCIES = 20;
const APPLICATIONS = 1200;
const BOARD_SIZE = 150;
/** Long enough for a slow call to fail on the bound instead of timing out. */
const TEST_TIMEOUT_MS = 60_000;

describe("record scope speed for a scoped hiring manager on the benchmark fixture", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  let owner: Principal, hm: Principal;
  let boardVacancy: string;

  /** The call's result and its wall time, which must stay under the bound. */
  async function timed<T>(work: () => Promise<T>) {
    const start = performance.now();
    const result = await work();
    const ms = performance.now() - start;
    expect(ms).toBeLessThan(BOUND_MS);
    return result;
  }

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, { userId: "speed-owner", teamId: TEAM });
    hm = await seedIdentity(db, {
      userId: "speed-hiring-manager",
      teamId: TEAM,
      role: "recruiter",
    });

    // The member's home unit, through a position held by their linked employee.
    const level = await createOrgLevel(owner, {
      name: "Fictional speed level",
      depth: 0,
    });
    const unit = (
      await createOrgUnit(owner, {
        name: "Fictional speed unit",
        code: "SPEED-SCOPE",
        levelId: level.id,
      })
    ).id;
    const position = await createPosition(owner, {
      title: "Fictional speed manager desk",
      code: "SPEED-HM-DESK",
      orgUnitId: unit,
    });
    const employee = await createEmployee(owner, {
      displayName: "Fictional Speed Manager",
      employeeNumber: "SPEED-HM",
    });
    await linkEmployeeUser(owner, employee.id, { userId: hm.userId });
    await setEmployeePositions(owner, employee.id, {
      positions: [{ positionId: position.id, primary: true }],
    });
    // The benchmark's hiring manager: the template, with view on tasks and onboarding added.
    const { body } = HIRING_MANAGER_ROLE;
    const draft = await createConfigDraft(owner, {
      type: "role",
      key: "speed-hiring-manager",
      body: {
        ...structuredClone(body),
        name: "Fictional speed hiring manager",
        actions: {
          ...structuredClone(body.actions),
          tasks: ["view"],
          onboarding: ["view"],
        },
      } as RoleBody,
    });
    await publishConfigVersion(owner, draft.versionId);
    await assignMemberRole(
      owner,
      { userId: hm.userId, roleObjectId: draft.objectId },
      new Headers(),
    );

    // The fixture rows of ensureFixture, set-based as the PGlite superuser; the records_scope
    // trigger still fills the scope columns. The odd-numbered vacancies are in the member's unit.
    await harness.asSuperuser();
    const run = (text: string, params: unknown[]) =>
      harness.client.query(text, params);
    await run(
      `INSERT INTO app.records(team_id, kind, data, created_by, org_unit_id)
       SELECT $1, 'vacancy', jsonb_build_object('title', 'Fixture vacancy ' || lpad(i::text, 2, '0'),
         'status', 'Open', 'department', (ARRAY['Engineering', 'Design', 'Operations', 'People'])[i % 4 + 1]),
         $2, CASE WHEN i % 2 = 1 THEN $3::uuid END
       FROM generate_series(1, $4::int) i`,
      [TEAM, owner.userId, unit, VACANCIES],
    );
    await run(
      `INSERT INTO app.records(team_id, kind, data, created_by)
       SELECT $1, 'candidate', jsonb_build_object(
         'name', 'Fixture Candidate ' || lpad(i::text, 4, '0'),
         'email', 'fixture-' || lpad(i::text, 4, '0') || '@example.test',
         'jobTitle', CASE WHEN i % 2 = 1 THEN 'Product Designer' ELSE 'Software Engineer' END,
         'yearsExperience', i % 15,
         'folderCategories', jsonb_build_array(CASE WHEN i % 2 = 1 THEN 'Design' ELSE 'Engineering' END),
         'skills', jsonb_build_array(skills[i % 8 + 1], skills[(i * 3 + 1) % 8 + 1]),
         'certifications', CASE WHEN i % 3 = 0 THEN jsonb_build_array(certifications[i % 5 + 1]) ELSE '[]'::jsonb END,
         'reviewStatus', CASE WHEN i % 4 = 0 THEN 'Needs review' ELSE 'Reviewed' END),
         $2
       FROM generate_series(1, $3::int) i,
         (SELECT ARRAY['React', 'react', 'TypeScript', 'Go', 'SQL', 'Figma', 'Recruiting', 'Excel'] AS skills,
           ARRAY['PMP', 'pmp', 'AWS Certified', 'CIPD Level 5', 'SHRM-CP'] AS certifications) lists`,
      [TEAM, owner.userId, CANDIDATES],
    );
    // Candidate i applies to vacancy 01 for the first 150, then to vacancies 02 to 20 in turn.
    await run(
      `INSERT INTO app.records(team_id, kind, data, created_by, candidate_id, vacancy_id)
       SELECT $1, 'application', jsonb_build_object('stage', ($3::text[])[i % cardinality($3::text[]) + 1],
         'source', 'Fictional fixture'), $2, c.id, v.id
       FROM generate_series(1, $4::int) i
       JOIN app.records c ON c.team_id = $1 AND c.kind = 'candidate'
         AND c.data->>'name' = 'Fixture Candidate ' || lpad(i::text, 4, '0')
       JOIN app.records v ON v.team_id = $1 AND v.kind = 'vacancy'
         AND v.data->>'title' = 'Fixture vacancy ' || lpad((CASE WHEN i <= $5::int THEN 1
           ELSE 2 + (i - $5::int - 1) % ($6::int - 1) END)::text, 2, '0')`,
      [
        TEAM,
        owner.userId,
        [...APPLICATION_STAGES],
        APPLICATIONS,
        BOARD_SIZE,
        VACANCIES,
      ],
    );
    // One "created" event per record, as the route handlers write, for the overview's activity.
    await run(
      `INSERT INTO app.activity(team_id, record_id, actor_id, actor_type, action, kind, summary)
       SELECT team_id, id, created_by, 'session', 'created', kind, 'Created ' || kind
       FROM app.records WHERE team_id = $1`,
      [TEAM],
    );
    const { rows } = await run(
      `SELECT id::text AS id FROM app.records WHERE team_id = $1 AND kind = 'vacancy'
         AND data->>'title' = 'Fixture vacancy 01'`,
      [TEAM],
    );
    boardVacancy = (rows[0] as { id: string }).id;
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  it(
    "sees a non-empty strict subset of the fixture",
    async () => {
      const total = async (resource: ResourceName) =>
        (
          await listRecords(
            hm,
            resource,
            new URLSearchParams({ pageSize: "1" }),
          )
        ).pagination.total;
      const candidates = await timed(() => total("candidates"));
      const applications = await timed(() => total("applications"));
      expect(candidates).toBeGreaterThan(0);
      expect(candidates).toBeLessThan(CANDIDATES);
      expect(applications).toBeGreaterThan(0);
      expect(applications).toBeLessThan(APPLICATIONS);
      // The overview counts the same records the lists show.
      const { counts } = await timed(() => overview(hm));
      expect(counts.candidates).toBe(candidates);
      expect(counts.applications).toBe(applications);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers the overview within the bound",
    async () => {
      await timed(() => overview(hm));
    },
    TEST_TIMEOUT_MS,
  );

  // The first-load list of each screen, exactly as the screens and the benchmark request it.
  const lists = Object.entries(tabRequests()).flatMap(([tab, paths]) =>
    paths.flatMap((path) => {
      const url = new URL(path, "http://fictional.invalid");
      const resource = url.pathname.split("/")[3] as ResourceName;
      return [
        "candidates",
        "vacancies",
        "job-roles",
        "applications",
        "tasks",
        "interviews",
        "offers",
        "onboarding",
      ].includes(resource)
        ? [{ name: `${tab} ${resource}`, resource, params: url.searchParams }]
        : [];
    }),
  );

  it("covers every scoped first-load list", () => {
    expect(lists.map((list) => list.name)).toEqual([
      "/app/candidates candidates",
      "/app/shortlist candidates",
      "/app/vacancies vacancies",
      "/app/roles job-roles",
      "/app/pipeline applications",
      "/app/tasks tasks",
      "/app/interviews interviews",
      "/app/offers offers",
      "/app/onboarding onboarding",
      "/app/source-review candidates",
    ]);
  });

  for (const { name, resource, params } of lists)
    it(
      `answers ${name} within the bound`,
      async () => {
        await timed(() => listRecords(hm, resource, params));
      },
      TEST_TIMEOUT_MS,
    );

  it(
    "answers the vacancy board within the bound",
    async () => {
      // The first page the whole-vacancy board loads, built as the benchmark builds it.
      const board = listSearchParams("pipeline", {
        ...defaultListQuery("pipeline"),
        vacancy: boardVacancy,
      });
      board.delete("page");
      board.delete("pageSize");
      board.set("sort", "createdAt");
      board.set("direction", "asc");
      board.set("page", "1");
      board.set("pageSize", "100");
      const page = await timed(() => listRecords(hm, "applications", board));
      expect(page.pagination.total).toBe(BOARD_SIZE);
    },
    TEST_TIMEOUT_MS,
  );
});
