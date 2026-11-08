import "./load-env";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { seedTotpCode } from "./totp";

/**
 * Local measurement only: database round trips, db time and total time per common action, read
 * from the Server-Timing header of the real route handlers. It signs in the fictional seed account
 * in process, creates fictional "Benchmark" records in the local PGlite database and opens no
 * network connection.
 *
 * With --fixture it first adds a fictional fixture (2,000 candidates, 20 vacancies, 1,200
 * applications) to the seed team through the route handlers, once, and runs every request under a
 * non-superuser, non-BYPASSRLS role, so the row-level security policies run as they do hosted.
 */
const RUNS = 5;
const FIXTURE = process.argv.includes("--fixture");
const FIXTURE_CANDIDATES = 2000;
const FIXTURE_VACANCIES = 20;
const FIXTURE_APPLICATIONS = 1200;
/** The first fixture vacancy holds this many applications; the rest are spread over the others. */
const FIXTURE_BOARD_SIZE = 150;
const FIXTURE_SKILLS = [
  "React",
  "react",
  "TypeScript",
  "Go",
  "SQL",
  "Figma",
  "Recruiting",
  "Excel",
];
const FIXTURE_CERTIFICATIONS = [
  "PMP",
  "pmp",
  "AWS Certified",
  "CIPD Level 5",
  "SHRM-CP",
];
const BENCH_ROLE = "recruitment_bench_runtime";
type Handler = (request: Request, context: never) => Promise<Response>;
type Row = {
  id: string;
  version: number;
  bucketId?: string | null;
  candidateId?: string | null;
  vacancyId?: string | null;
  data?: Record<string, unknown>;
};

function refuse(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.DATABASE_MODE !== "pglite" ||
    process.env.ALLOW_LOCAL_DB !== "true"
  )
    refuse(
      "The round-trip benchmark runs only against the fictional local PGlite database (DATABASE_MODE=pglite and ALLOW_LOCAL_DB=true).",
    );
  const password = process.env.DEV_SEED_PASSWORD;
  if (!password)
    refuse(
      "Set DEV_SEED_PASSWORD and run npm run db:seed first; the benchmark signs in the fictional seed account.",
    );
  if (!process.env.DEV_SEED_TOTP_KEY)
    refuse(
      "Set DEV_SEED_TOTP_KEY to the key npm run db:seed printed; the seed owner signs in with a two-step code.",
    );
  const origin = new URL(process.env.BETTER_AUTH_URL || "http://localhost:3000")
    .origin;
  const { closeDb, getDb } = await import("../src/db");
  const { dataRoleHelpers, identityRoleHelpers } =
    await import("../src/db/connection-boundary");
  const { getAuth } = await import("../src/lib/auth");
  const {
    tabRequests,
    candidateProfileRequests,
    defaultListQuery,
    listSearchParams,
  } = await import("../src/components/workspace/tab-requests");
  const { APPLICATION_STAGES } = await import("../src/domain/records");
  const routes = {
    list: await import("../src/app/api/v1/[resource]/route"),
    item: await import("../src/app/api/v1/[resource]/[id]/route"),
    state: await import("../src/app/api/v1/candidates/[id]/state/route"),
    overview: await import("../src/app/api/v1/overview/route"),
    analytics: await import("../src/app/api/v1/analytics/route"),
    activity: await import("../src/app/api/v1/activity/route"),
    notifications: await import("../src/app/api/v1/notifications/route"),
  };
  try {
    if (FIXTURE) {
      // The grants of enforceTestRls() in tests/helpers/db.ts. The local PGlite owner is a
      // superuser and skips row-level security; this session-level role does not.
      const db = await getDb();
      for (const statement of [
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${BENCH_ROLE}') THEN CREATE ROLE ${BENCH_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`,
        `GRANT USAGE ON SCHEMA app,auth,tenant_context,db_boundary TO ${BENCH_ROLE}`,
        `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA app,auth TO ${BENCH_ROLE}`,
        `REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON auth.initial_admin_claim FROM ${BENCH_ROLE}`,
        `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app,auth TO ${BENCH_ROLE}`,
        `GRANT SELECT ON db_boundary.connection_marker,db_boundary.storage_schema TO ${BENCH_ROLE}`,
        `GRANT EXECUTE ON FUNCTION ${[...new Set([...dataRoleHelpers, ...identityRoleHelpers])].join(",")} TO ${BENCH_ROLE}`,
        `SET ROLE ${BENCH_ROLE}`,
      ])
        await db.execute(sql.raw(statement));
      const [check] = (
        await db.execute<{ bypass: boolean }>(
          sql`select rolsuper or rolbypassrls as bypass from pg_roles where rolname = current_user`,
        )
      ).rows;
      if (check?.bypass !== false)
        refuse("The benchmark role must not bypass row-level security.");
    }
    const auth = await getAuth();
    const signIn = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-forwarded-for": "127.0.0.1",
        },
        body: JSON.stringify({ email: "recruiter@example.test", password }),
      }),
    );
    if (signIn.status !== 200)
      refuse(
        `The fictional seed sign-in failed with status ${signIn.status}. Run npm run db:seed first.`,
      );
    const cookieOf = (response: Response) =>
      response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .filter((pair) => !pair.endsWith("="))
        .join("; ");
    // The seed owner has two-step sign-in: the password opens a challenge for the current code.
    const verified = await auth.handler(
      new Request(`${origin}/api/auth/two-factor/verify-totp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          cookie: cookieOf(signIn),
          "x-forwarded-for": "127.0.0.1",
        },
        body: JSON.stringify({ code: seedTotpCode(process.env) }),
      }),
    );
    if (verified.status !== 200)
      refuse(
        `The fictional seed two-step code was refused with status ${verified.status}. Check DEV_SEED_TOTP_KEY.`,
      );
    const cookie = cookieOf(verified);
    const teams = (await (
      await auth.handler(
        new Request(`${origin}/api/auth/organization/list`, {
          headers: { cookie, "x-forwarded-for": "127.0.0.1" },
        }),
      )
    ).json()) as { id: string; slug: string }[];
    const team = teams.find((item) => item.slug === "fictional-studio");
    if (!team) refuse("The fictional seed team was not found.");

    /** Dispatches a path to its route handler, as Next would. */
    function handlerFor(method: string, path: string) {
      const segments = new URL(path, origin).pathname.split("/").slice(3);
      const named: Record<string, { GET?: Handler; POST?: Handler }> = {
        overview: routes.overview,
        analytics: routes.analytics,
        activity: routes.activity,
        notifications: routes.notifications,
      };
      if (segments.length === 1 && named[segments[0]])
        return {
          handler: named[segments[0]][method as "GET"]!,
          params: {},
        };
      if (segments.length === 3 && segments[2] === "state")
        return {
          handler: (routes.state as unknown as Record<string, Handler>)[method],
          params: { id: segments[1] },
        };
      if (segments.length === 2)
        return {
          handler: (routes.item as unknown as Record<string, Handler>)[method],
          params: { resource: segments[0], id: segments[1] },
        };
      return {
        handler: (routes.list as unknown as Record<string, Handler>)[method],
        params: { resource: segments[0] },
      };
    }
    async function call(method: string, path: string, body?: unknown) {
      const { handler, params } = handlerFor(method, path);
      const response = await handler(
        new Request(`${origin}${path}`, {
          method,
          headers: {
            cookie,
            origin,
            "x-team-id": team!.id,
            ...(body === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "idempotency-key": randomUUID(),
                }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        { params: Promise.resolve(params) } as never,
      );
      if (!response.ok)
        throw new Error(`${method} ${path} returned ${response.status}.`);
      const timing =
        /^total;dur=([\d.]+), db;dur=([\d.]+), dbrt;desc="(\d+)"$/.exec(
          response.headers.get("server-timing") ?? "",
        );
      if (!timing) throw new Error(`${method} ${path} has no Server-Timing.`);
      return {
        body: (await response.json()) as {
          data: Row & Row[];
          pagination?: { total: number; totalPages: number };
        },
        total: Number(timing[1]),
        db: Number(timing[2]),
        roundTrips: Number(timing[3]),
      };
    }

    const stamp = new Date().toISOString().slice(0, 19);
    const buckets = (
      await call("GET", "/api/v1/buckets?pageSize=100&sort=position")
    ).body.data;
    if (buckets.length < 2) refuse("The fictional team needs two buckets.");
    let task = (
      await call("POST", "/api/v1/tasks", {
        bucketId: buckets[0].id,
        data: { title: `Benchmark task ${stamp}`, priority: "Normal" },
      })
    ).body.data;
    let candidate = (
      await call("POST", "/api/v1/candidates", {
        data: { name: `Benchmark Candidate ${stamp}` },
      })
    ).body.data;
    const vacancy = (
      await call("POST", "/api/v1/vacancies", {
        data: { title: `Benchmark vacancy ${stamp}`, status: "Open" },
      })
    ).body.data;
    let application = (
      await call("POST", "/api/v1/applications", {
        candidateId: candidate.id,
        vacancyId: vacancy.id,
        data: { stage: "Sourced", source: "Benchmark" },
      })
    ).body.data;

    /** Every page of a list path, 100 records at a time. */
    async function listAll(path: string) {
      const all: Row[] = [];
      for (let page = 1; ; page++) {
        const { body } = await call("GET", `${path}&page=${page}&pageSize=100`);
        all.push(...body.data);
        if (page >= (body.pagination?.totalPages ?? 1)) return all;
      }
    }
    const padded = (value: number, width: number) =>
      String(value).padStart(width, "0");
    /** Adds whatever part of the fictional fixture is missing; a complete fixture adds nothing. */
    async function ensureFixture() {
      const created = { candidates: 0, vacancies: 0, applications: 0 };
      const vacancies = new Map(
        (
          await listAll(
            `/api/v1/vacancies?search=${encodeURIComponent('"Fixture vacancy"')}&sort=title`,
          )
        ).map((row) => [String(row.data?.title), row.id]),
      );
      for (let index = 1; index <= FIXTURE_VACANCIES; index++) {
        const title = `Fixture vacancy ${padded(index, 2)}`;
        if (vacancies.has(title)) continue;
        const row = (
          await call("POST", "/api/v1/vacancies", {
            data: {
              title,
              status: "Open",
              department: ["Engineering", "Design", "Operations", "People"][
                index % 4
              ],
            },
          })
        ).body.data;
        vacancies.set(title, row.id);
        created.vacancies++;
      }
      const candidates = new Map(
        (
          await listAll(
            `/api/v1/candidates?search=${encodeURIComponent('"Fixture Candidate"')}&sort=name`,
          )
        ).map((row) => [String(row.data?.name), row.id]),
      );
      for (let index = 1; index <= FIXTURE_CANDIDATES; index++) {
        const name = `Fixture Candidate ${padded(index, 4)}`;
        if (candidates.has(name)) continue;
        const row = (
          await call("POST", "/api/v1/candidates", {
            data: {
              name,
              email: `fixture-${padded(index, 4)}@example.test`,
              jobTitle: index % 2 ? "Product Designer" : "Software Engineer",
              yearsExperience: index % 15,
              folderCategories: [index % 2 ? "Design" : "Engineering"],
              skills: [
                FIXTURE_SKILLS[index % FIXTURE_SKILLS.length],
                FIXTURE_SKILLS[(index * 3 + 1) % FIXTURE_SKILLS.length],
              ],
              certifications:
                index % 3
                  ? []
                  : [
                      FIXTURE_CERTIFICATIONS[
                        index % FIXTURE_CERTIFICATIONS.length
                      ],
                    ],
              reviewStatus: index % 4 ? "Reviewed" : "Needs review",
            },
          })
        ).body.data;
        candidates.set(name, row.id);
        created.candidates++;
      }
      const applications = new Set(
        (
          await listAll(
            `/api/v1/applications?search=${encodeURIComponent('"Fixture Candidate"')}&sort=createdAt`,
          )
        ).map((row) => `${row.candidateId}:${row.vacancyId}`),
      );
      for (let index = 1; index <= FIXTURE_APPLICATIONS; index++) {
        const candidateId = candidates.get(
          `Fixture Candidate ${padded(index, 4)}`,
        )!;
        const vacancyId = vacancies.get(
          `Fixture vacancy ${padded(index <= FIXTURE_BOARD_SIZE ? 1 : 2 + ((index - FIXTURE_BOARD_SIZE - 1) % (FIXTURE_VACANCIES - 1)), 2)}`,
        )!;
        if (applications.has(`${candidateId}:${vacancyId}`)) continue;
        await call("POST", "/api/v1/applications", {
          candidateId,
          vacancyId,
          data: {
            stage: APPLICATION_STAGES[index % APPLICATION_STAGES.length],
            source: "Fictional fixture",
          },
        });
        created.applications++;
      }
      const total = (
        await call(
          "GET",
          `/api/v1/candidates?search=${encodeURIComponent('"Fixture Candidate"')}&pageSize=1`,
        )
      ).body.pagination?.total;
      console.log(
        `Fixture: ${created.candidates} candidates, ${created.vacancies} vacancies and ${created.applications} applications added; ${total} fixture candidates in the team. Requests run as ${BENCH_ROLE} with row-level security enforced.\n`,
      );
      return vacancies.get("Fixture vacancy 01")!;
    }
    const boardVacancyId = FIXTURE ? await ensureFixture() : vacancy.id;

    const rows: {
      action: string;
      request: string;
      roundTrips: string;
      db: number;
      total: number;
    }[] = [];
    const median = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    async function measure(
      action: string,
      label: string,
      run: (index: number) => ReturnType<typeof call>,
    ) {
      await run(-1); // Warm-up, so module and statement caches are loaded.
      const samples = [];
      for (let index = 0; index < RUNS; index++) samples.push(await run(index));
      const trips = [...new Set(samples.map((sample) => sample.roundTrips))];
      rows.push({
        action,
        request: label,
        roundTrips: trips.length === 1 ? String(trips[0]) : trips.join("/"),
        db: median(samples.map((sample) => sample.db)),
        total: median(samples.map((sample) => sample.total)),
      });
    }

    await measure("move task", "PATCH /api/v1/tasks/:id", async () => {
      const target = buckets.find((bucket) => bucket.id !== task.bucketId)!;
      const result = await call("PATCH", `/api/v1/tasks/${task.id}`, {
        version: task.version,
        bucketId: target.id,
      });
      task = result.body.data;
      return result;
    });
    const stages = ["Screening", "Sourced"];
    await measure(
      "change stage",
      "PATCH /api/v1/applications/:id",
      async (index) => {
        const result = await call(
          "PATCH",
          `/api/v1/applications/${application.id}`,
          {
            version: application.version,
            data: { stage: stages[(index + 2) % 2] },
          },
        );
        application = result.body.data;
        return result;
      },
    );
    for (const [tab, paths] of Object.entries(tabRequests()))
      for (const path of paths)
        await measure(`open ${tab}`, `GET ${path}`, () => call("GET", path));
    for (const path of candidateProfileRequests(candidate.id))
      await measure(
        "open candidate",
        `GET ${path.replace(candidate.id, ":id")}`,
        () => call("GET", path),
      );
    await measure("open vacancy", "GET /api/v1/vacancies/:id", () =>
      call("GET", `/api/v1/vacancies/${boardVacancyId}`),
    );
    // The first page the whole-vacancy board loads, built as the Applications screen builds it.
    const board = listSearchParams("pipeline", {
      ...defaultListQuery("pipeline"),
      vacancy: boardVacancyId,
    });
    board.delete("page");
    board.delete("pageSize");
    board.set("sort", "createdAt");
    board.set("direction", "asc");
    const boardPath = `/api/v1/applications?${board}&page=1&pageSize=100`;
    await measure(
      "open vacancy board",
      `GET ${boardPath.replace(boardVacancyId, ":id")}`,
      () => call("GET", boardPath),
    );
    await measure(
      "save candidate",
      "PATCH /api/v1/candidates/:id",
      async (index) => {
        const result = await call(
          "PATCH",
          `/api/v1/candidates/${candidate.id}`,
          {
            version: candidate.version,
            data: { jobTitle: `Benchmark title ${index + 2}` },
          },
        );
        candidate = result.body.data;
        return result;
      },
    );
    await measure("schedule interview", "POST /api/v1/interviews", () =>
      call("POST", "/api/v1/interviews", {
        applicationId: application.id,
        data: {
          title: `Benchmark interview ${stamp}`,
          startAt: new Date(Date.now() + 86_400_000).toISOString(),
          minutes: 30,
          status: "Scheduled",
        },
      }),
    );

    console.log(
      `Round trips per request (session lookup included), median of ${RUNS} runs after one warm-up. Local PGlite${FIXTURE ? " with the fixture and row-level security enforced" : ""}; not representative of hosted timings.\n`,
    );
    console.log("| Action | Request | Round trips | db ms | total ms |");
    console.log("| --- | --- | ---: | ---: | ---: |");
    for (const row of rows)
      console.log(
        `| ${row.action} | \`${row.request}\` | ${row.roundTrips} | ${row.db.toFixed(1)} | ${row.total.toFixed(1)} |`,
      );
  } finally {
    await closeDb();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "The benchmark failed.",
    );
    process.exit(1);
  },
);
