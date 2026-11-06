import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { POST as createRoute } from "../src/app/api/v1/[resource]/route";
import { POST as exportRoute } from "../src/app/api/v1/[resource]/export/route";
import { readBody, json, runApi } from "../src/lib/api";
import { createTokenMaterial } from "../src/lib/api-token-policy";
import { StorageConfigurationError } from "../src/lib/storage";
import { createTestDb, enforceTestRls, seedIdentity } from "./helpers/db";
import { authCaller, createTestAuth, type Mail } from "./helpers/auth";
import { stubLocalAuthReadiness } from "./helpers/readiness";
import { z } from "zod";

// Distinct fictional values that must never reach a log line, a rate-limit key or an audit row.
const CANARY = {
  email: "canary-email-5d1e@example.test",
  phone: "+971 50 555 7319",
  note: "CANARY-NOTE-91c2 fictional comment body",
  meetingUrl:
    "https://storage.example.test/cv.pdf?X-Amz-Signature=canarysignature0b7e",
  ip: "198.51.100.77",
};
const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

describe("logs, rate-limit keys and export audits never carry contact, note, token, URL or address values", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  const valid = createTokenMaterial();
  const unknown = createTokenMaterial().token;
  const canaries = () => [...Object.values(CANARY), valid.token, unknown];
  const spies: MockInstance[] = [];
  const output = () =>
    spies
      .flatMap((spy) => spy.mock.calls)
      .map((call) =>
        call
          .map((part) =>
            part instanceof Error
              ? `${part.message}\n${part.stack}`
              : typeof part === "string"
                ? part
                : JSON.stringify(part),
          )
          .join(" "),
      );
  const bearer = (token: string, path: string, init: RequestInit = {}) =>
    new Request(`http://localhost:3000${path}`, {
      method: "POST",
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-forwarded-for": CANARY.ip,
      },
    });
  const params = (resource: string) => ({
    params: Promise.resolve({ resource }),
  });
  async function create(resource: string, body: unknown) {
    const response = await createRoute(
      bearer(valid.token, `/api/v1/${resource}`, {
        body: JSON.stringify(body),
      }),
      params(resource),
    );
    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(201);
    return payload.data as { id: string };
  }

  beforeAll(async () => {
    stubLocalAuthReadiness();
    fixture = await createTestDb();
    const owner = await seedIdentity(fixture.db, {
      userId: "canary-owner",
      teamId: "canary-team",
    });
    await fixture.client.query(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at)
        VALUES(gen_random_uuid(),$1,$2,'Fictional canary token',$3,$4,'["candidates:read","candidates:write","recruitment:read","recruitment:write"]',now()+interval '1 day')`,
      [owner.teamId, owner.userId, valid.tokenHash, valid.prefix],
    );
    await enforceTestRls(fixture.db);
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      spies.push(vi.spyOn(console, method).mockImplementation(() => {}));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });

  it("exercises every logging path with the canaries and finds none of them", async () => {
    // Candidate, application, interview and comment creation.
    const candidate = await create("candidates", {
      data: {
        name: "Fictional Canary",
        email: CANARY.email,
        phone: CANARY.phone,
      },
    });
    await create("comments", {
      parentRecordId: candidate.id,
      data: { body: CANARY.note },
    });
    const vacancy = await create("vacancies", {
      data: { title: "Fictional Canary Vacancy" },
    });
    const application = await create("applications", {
      candidateId: candidate.id,
      vacancyId: vacancy.id,
      data: {},
    });
    await create("interviews", {
      applicationId: application.id,
      data: {
        title: "Fictional canary interview",
        startAt: "2026-11-02T09:00:00.000Z",
        meetingUrl: CANARY.meetingUrl,
      },
    });

    // A forced 500 and a storage setup error whose messages hold every canary.
    const all = canaries().join(" ");
    const forced = await runApi(
      bearer(valid.token, "/api/v1/fictional"),
      undefined,
      async () => {
        throw new Error(`fictional failure ${all}`);
      },
    );
    expect(forced.status).toBe(500);
    const storage = await runApi(
      bearer(valid.token, "/api/v1/fictional"),
      undefined,
      async () => {
        throw new StorageConfigurationError(`fictional setup ${all}`);
      },
    );
    expect(storage.status).toBe(503);

    // An export searching for the canary email.
    const exported = await exportRoute(
      bearer(
        valid.token,
        `/api/v1/candidates/export?${new URLSearchParams({ search: CANARY.email })}`,
      ),
      params("candidates"),
    );
    expect(exported.status).toBe(200);
    expect(exported.headers.get("x-export-rows")).toBe("1");
    await exported.arrayBuffer();

    // A body that fails mid-read.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`{"email":"${CANARY.email}"`),
        );
      },
      pull(controller) {
        controller.error(new Error(`fictional reset ${all}`));
      },
    });
    const aborted = bearer(valid.token, "/api/v1/candidates", {
      body,
      duplex: "half",
    } as RequestInit);
    const cancelled = await runApi(aborted, undefined, async () =>
      json({ data: await readBody(aborted, z.unknown()) }),
    );
    expect(cancelled.status).toBe(499);

    // Bearer guesses from the canary address, past the budget.
    for (let n = 0; n < 11; n++) {
      const response = await createRoute(
        bearer(
          n === 0 ? unknown : createTokenMaterial().token,
          "/api/v1/candidates",
          {
            body: "{}",
          },
        ),
        params("candidates"),
      );
      expect(response.status).toBe(n < 10 ? 401 : 429);
    }

    // A Better Auth sign-in attempt from the canary address.
    const mail: Mail[] = [];
    const caller = authCaller(createTestAuth(fixture.db, mail));
    const signIn = await caller.post(
      "sign-in/email",
      { email: CANARY.email, password: "a-wrong-fictional-password" },
      { ip: CANARY.ip },
    );
    expect(signIn.status).toBe(401);

    const lines = output();
    expect(lines.length).toBeGreaterThan(0);
    for (const canary of canaries())
      for (const line of lines) expect(line).not.toContain(canary);
    const correlated = lines.filter((line) =>
      /^(internal_error|storage_configuration_error) /.test(line),
    );
    expect(correlated).toHaveLength(2);
    for (const line of correlated)
      expect(line).toMatch(new RegExp(`^\\S+ correlationId=${UUID} `));

    await fixture.client.exec("RESET ROLE");
    const stored = await fixture.db.execute<{ value: string }>(sql`
      select key as value from auth.api_rate_limits
      union all select key from auth.rate_limit
      union all select metadata::text from app.activity where action = 'records.exported'`);
    expect(stored.rows.length).toBeGreaterThan(2);
    for (const canary of canaries())
      for (const { value } of stored.rows) expect(value).not.toContain(canary);
  });
});
