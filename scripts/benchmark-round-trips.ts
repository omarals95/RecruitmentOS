import "./load-env";
import { randomUUID } from "node:crypto";

/**
 * Local measurement only: database round trips, db time and total time per common action, read
 * from the Server-Timing header of the real route handlers. It signs in the fictional seed account
 * in process, creates fictional "Benchmark" records in the local PGlite database and opens no
 * network connection.
 */
const RUNS = 5;
type Handler = (request: Request, context: never) => Promise<Response>;
type Row = { id: string; version: number; bucketId?: string | null };

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
  const origin = new URL(process.env.BETTER_AUTH_URL || "http://localhost:3000")
    .origin;
  const { closeDb } = await import("../src/db");
  const { getAuth } = await import("../src/lib/auth");
  const { tabRequests, candidateProfileRequests } =
    await import("../src/components/workspace/tab-requests");
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
    const cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .filter((pair) => !pair.endsWith("="))
      .join("; ");
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
        body: (await response.json()) as { data: Row & Row[] },
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
      `Round trips per request (session lookup included), median of ${RUNS} runs after one warm-up. Local PGlite; not representative of hosted timings.\n`,
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
