import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));

import { getVerifiedSession } from "@/lib/auth-session";
import type { Principal } from "@/lib/principal";
import { SPEED_ACTIONS, SPEED_TABS } from "@/domain/speed";
import { POST } from "@/app/api/v1/speed-samples/route";
import { GET } from "@/app/api/v1/teams/speed/route";
import {
  createSpeedLog,
  sendSpeedSamples,
  type SpeedSample,
} from "@/components/workspace/speed-log";
import { createTestDb, enforceTestRls, seedIdentity } from "./helpers/db";

// Fictional teams and synthetic timings only.
const ORIGIN = "http://localhost:3000";

describe("speed log routes", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal, admin: Principal, recruiter: Principal;
  let viewer: Principal, otherOwner: Principal;
  /** Raw SQL as the PGlite owner, outside the runtime role and its policies. */
  async function asOwner<T = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    await fixture.client.exec("RESET ROLE");
    try {
      return (await fixture.client.query<T>(query, params)).rows;
    } finally {
      await fixture.client.exec("SET ROLE recruitment_test_runtime");
    }
  }
  const count = async (table: string, teamId: string) =>
    Number(
      (
        await asOwner<{ n: number }>(
          `SELECT count(*)::int AS n FROM app.${table} WHERE team_id = $1`,
          [teamId],
        )
      )[0].n,
    );
  function signIn(p: Principal) {
    vi.mocked(getVerifiedSession).mockResolvedValue({
      user: { id: p.userId },
      session: { activeOrganizationId: p.teamId },
    } as never);
  }
  async function post(
    p: Principal,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    signIn(p);
    const response = await POST(
      new Request(`${ORIGIN}/api/v1/speed-samples`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
    return { status: response.status, body: await response.json() };
  }
  async function summary(p: Principal) {
    signIn(p);
    const response = await GET(
      new Request(`${ORIGIN}/api/v1/teams/speed`, {
        headers: { origin: ORIGIN },
      }),
    );
    return { status: response.status, body: await response.json() };
  }
  const action = (durationMs: number, name = "task.move") => ({
    kind: "action",
    name,
    durationMs,
  });

  beforeAll(async () => {
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db, {
      userId: "speed-owner",
      teamId: "speed-team",
    });
    admin = await seedIdentity(fixture.db, {
      userId: "speed-admin",
      teamId: "speed-team",
      role: "admin",
    });
    recruiter = await seedIdentity(fixture.db, {
      userId: "speed-recruiter",
      teamId: "speed-team",
      role: "recruiter",
    });
    viewer = await seedIdentity(fixture.db, {
      userId: "speed-viewer",
      teamId: "speed-team",
      role: "viewer",
    });
    otherOwner = await seedIdentity(fixture.db, {
      userId: "speed-other-owner",
      teamId: "speed-other-team",
    });
    await enforceTestRls(fixture.db);
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it("accepts a viewer's valid batch and refuses Bearer tokens and anything but timings", async () => {
    const valid = {
      samples: [
        action(120),
        {
          kind: "route",
          name: "PATCH /api/v1/tasks/[id]",
          durationMs: 40,
          dbMs: 12,
        },
      ],
    };
    expect(await post(viewer, valid)).toEqual({
      status: 202,
      body: { accepted: 2 },
    });
    expect(await count("speed_samples", viewer.teamId)).toBe(2);
    const bearer = await post(viewer, valid, {
      authorization: "Bearer fictional-speed-token",
    });
    expect(bearer.status).toBe(403);
    expect(bearer.body.error.code).toBe("session_required");
    const invalid = [
      { samples: [action(10, "task.delete")] },
      {
        samples: [
          {
            kind: "route",
            name: "GET /api/v1/candidates/3f2c9a1e-0d4b-4c6e-9f00-1a2b3c4d5e6f",
            durationMs: 10,
          },
        ],
      },
      {
        samples: [
          {
            kind: "route",
            name: "GET /api/v1/tasks?search=ann",
            durationMs: 1,
          },
        ],
      },
      { samples: [{ ...action(10), dbMs: 4 }] },
      { samples: [{ ...action(10), note: "Fictional content" }] },
      { samples: [action(600_001)] },
      { samples: [action(1.5)] },
      { samples: [] },
      { samples: Array.from({ length: 51 }, () => action(10)) },
      JSON.stringify(valid) + " ".repeat(16_384),
    ];
    for (const body of invalid) {
      const response = await post(viewer, body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(response.body.error.code).toBe("invalid_input");
    }
    expect(await count("speed_samples", viewer.teamId)).toBe(2);
  });

  it("gives owners and admins the median and 95th percentile per name, and refuses others", async () => {
    await asOwner("DELETE FROM app.speed_samples");
    for (const p of [owner, recruiter])
      expect(
        (
          await post(p, {
            samples: [
              ...[100, 200, 300, 400, 500].map((ms) => action(ms)),
              action(70, "tab.tasks"),
              {
                kind: "route",
                name: "GET /api/v1/tasks",
                durationMs: 10,
                dbMs: 2,
              },
              {
                kind: "route",
                name: "GET /api/v1/tasks",
                durationMs: 30,
                dbMs: 4,
              },
            ].slice(p === owner ? 0 : 5),
          })
        ).status,
      ).toBe(202);
    const expected = [
      {
        kind: "action",
        name: "tab.tasks",
        samples: 2,
        medianMs: 70,
        p95Ms: 70,
      },
      {
        kind: "action",
        name: "task.move",
        samples: 5,
        medianMs: 300,
        p95Ms: 480,
      },
      {
        kind: "route",
        name: "GET /api/v1/tasks",
        samples: 4,
        medianMs: 20,
        p95Ms: 30,
        medianDbMs: 3,
        p95DbMs: 4,
      },
    ];
    for (const p of [owner, admin])
      expect(await summary(p)).toEqual({
        status: 200,
        body: { data: expected },
      });
    for (const p of [recruiter, viewer]) {
      const refused = await summary(p);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe("speed_log_forbidden");
    }
    expect(await count("activity", owner.teamId)).toBe(0);
  });

  it("never shows one team's timings to another", async () => {
    expect((await post(otherOwner, { samples: [action(999)] })).status).toBe(
      202,
    );
    const other = await summary(otherOwner);
    expect(other.body.data).toEqual([
      {
        kind: "action",
        name: "task.move",
        samples: 1,
        medianMs: 999,
        p95Ms: 999,
      },
    ]);
    const own = await summary(owner);
    expect(
      own.body.data.find((row: { name: string }) => row.name === "task.move")
        .samples,
    ).toBe(5);
  });

  it("leaves rows older than 30 days out and deletes at most 1000 of them per write", async () => {
    await asOwner(
      "INSERT INTO app.speed_samples(team_id, kind, name, duration_ms, recorded_at) SELECT $1, 'action', 'task.move', 50000, date_trunc('hour', now()) - interval '31 days' FROM generate_series(1, 1005)",
      [owner.teamId],
    );
    await asOwner(
      "INSERT INTO app.speed_samples(team_id, kind, name, duration_ms, recorded_at) VALUES($1, 'action', 'task.move', 50000, date_trunc('hour', now()) - interval '31 days')",
      [otherOwner.teamId],
    );
    const before = await summary(owner);
    expect(
      before.body.data.find(
        (row: { name: string }) => row.name === "task.move",
      ),
    ).toMatchObject({ samples: 5, p95Ms: 480 });
    const old = () =>
      asOwner<{ n: number }>(
        "SELECT count(*)::int AS n FROM app.speed_samples WHERE team_id = $1 AND recorded_at < now() - interval '30 days'",
        [owner.teamId],
      ).then((rows) => rows[0].n);
    await post(owner, { samples: [action(10, "tab.overview")] });
    expect(await old()).toBe(5);
    await post(owner, { samples: [action(10, "tab.overview")] });
    expect(await old()).toBe(0);
    // Another team's expired rows wait for that team's own next write.
    expect(
      (
        await asOwner<{ n: number }>(
          "SELECT count(*)::int AS n FROM app.speed_samples WHERE team_id = $1 AND recorded_at < now() - interval '30 days'",
          [otherOwner.teamId],
        )
      )[0].n,
    ).toBe(1);
    expect(await count("activity", owner.teamId)).toBe(0);
    expect(await count("activity", otherOwner.teamId)).toBe(0);
  });
});

describe("speed log browser buffer", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  function log(random: () => number = () => 0) {
    const sent: { teamId: string; samples: SpeedSample[] }[] = [];
    let stored = 0;
    const speed = createSpeedLog({
      now: () => Date.now(),
      random,
      lastSent: { read: () => stored, write: (value) => (stored = value) },
      send: (teamId, samples) => sent.push({ teamId, samples }),
    });
    return { speed, sent };
  }
  const timing = 'total;dur=41.6, db;dur=12.2, dbrt;desc="6"';

  it("records only the fixed action names and route patterns", () => {
    expect(SPEED_ACTIONS).toEqual(
      expect.arrayContaining(SPEED_TABS.map((tab) => `tab.${tab}`)),
    );
    const { speed } = log();
    speed.setTeam("fictional-team");
    speed.action("task.move", 180.4);
    speed.action("candidate.delete", 10);
    speed.action("Fictional Candidate", 10);
    speed.route("PATCH", "/api/v1/tasks/3f2c9a1e?search=Sam", timing);
    speed.route("GET", "/api/settings/tokens", timing);
    speed.route("GET", "/api/v1/tasks", null);
    expect(speed.size()).toBe(2);
  });

  it("keeps at most 50 samples, sends at most once per 10 seconds and clears on a team switch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T10:00:00Z"));
    const { speed, sent } = log();
    speed.setTeam("fictional-team-a");
    for (let index = 0; index < 60; index++) speed.action("tab.tasks", index);
    expect(speed.size()).toBe(50);
    expect(speed.flush()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].samples).toHaveLength(50);
    expect(sent[0].samples[0]).toEqual({
      kind: "action",
      name: "tab.tasks",
      durationMs: 0,
    });
    speed.action("task.move", 100);
    vi.advanceTimersByTime(9_999);
    expect(speed.flush()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(speed.flush()).toBe(true);
    expect(sent).toHaveLength(2);
    speed.action("task.move", 100);
    speed.setTeam("fictional-team-b");
    vi.advanceTimersByTime(10_000);
    expect(speed.size()).toBe(0);
    expect(speed.flush()).toBe(false);
    speed.action("task.move", 100);
    speed.clear();
    expect(speed.size()).toBe(0);
  });

  it("samples one in five route timings", () => {
    const sequence = [0.1, 0.3, 0.5, 0.7, 0.9];
    let index = 0;
    const { speed, sent } = log(() => sequence[index++ % sequence.length]);
    speed.setTeam("fictional-team");
    for (let call = 0; call < 25; call++)
      speed.route("GET", "/api/v1/tasks", timing);
    expect(speed.size()).toBe(5);
    speed.flush();
    expect(sent[0].samples[0]).toEqual({
      kind: "route",
      name: "GET /api/v1/tasks",
      durationMs: 42,
      dbMs: 12,
    });
  });

  it("sends with its own request and never dispatches recruitmentos:data-changed", async () => {
    const target = new EventTarget();
    const events: string[] = [];
    target.addEventListener("recruitmentos:data-changed", () =>
      events.push("changed"),
    );
    vi.stubGlobal("window", target);
    const fetch = vi.fn(async () =>
      Response.json({ accepted: 1 }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetch);
    sendSpeedSamples(
      "fictional-team",
      [{ kind: "action", name: "task.move", durationMs: 90 }],
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [path, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toBe("/api/v1/speed-samples");
    expect(init).toMatchObject({ method: "POST", keepalive: true });
    expect(new Headers(init.headers).get("x-team-id")).toBe("fictional-team");
    expect(events).toEqual([]);
  });
});
