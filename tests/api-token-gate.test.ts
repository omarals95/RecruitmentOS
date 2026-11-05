import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const pools = vi.hoisted(() => ({ identity: vi.fn(), data: vi.fn() }));
vi.mock("@/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));

import { applyMigrations, schema, type AppDb } from "../src/db";
import { createTokenMaterial } from "../src/lib/api-token-policy";
import { authenticateApiToken } from "../src/lib/api-tokens";
import { installTenantContextKey } from "../src/lib/tenant-context";
import { GET as overviewRoute } from "../src/app/api/v1/overview/route";
import {
  CLIENT_IP,
  stubHostedReadiness,
  stubLocalAuthReadiness,
} from "./helpers/readiness";

const TOKEN_ID = "00000000-0000-4000-8000-000000000031";

describe("API tokens are gated on sign-in readiness and a per-client guess budget", () => {
  const pg = new PGlite();
  const valid = createTokenMaterial();
  const request = (token: string, headers: Record<string, string> = {}) =>
    overviewRoute(
      new Request("http://localhost:3000/api/v1/overview", {
        headers: { authorization: `Bearer ${token}`, ...headers },
      }),
    );
  const guess = () => createTokenMaterial().token;
  const limits = async () =>
    (
      await pg.query<{ key: string; count: number }>(
        "SELECT key, count FROM auth.api_rate_limits ORDER BY key",
      )
    ).rows;
  const lastUsed = async () =>
    (
      await pg.query<{ last_used_at: Date | null }>(
        "SELECT last_used_at FROM auth.api_tokens WHERE id=$1",
        [TOKEN_ID],
      )
    ).rows[0].last_used_at;

  beforeAll(async () => {
    await applyMigrations(pg);
    await installTenantContextKey(pg);
    await pg.exec(`
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin)
        VALUES('gate-user','Fixture','gate@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by)
        VALUES('gate-team','Fixture','gate','gate-user');
      INSERT INTO auth.member(id,organization_id,user_id,role)
        VALUES('gate-member','gate-team','gate-user','owner');
    `);
    await pg.query(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at)
        VALUES($1,'gate-team','gate-user','Fixture',$2,$3,'["candidates:read","recruitment:read"]',now()+interval '1 day')`,
      [TOKEN_ID, valid.tokenHash, valid.prefix],
    );
    const db = drizzle(pg, { schema }) as unknown as AppDb;
    pools.identity.mockResolvedValue(db);
    pools.data.mockResolvedValue(db);
  });
  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await pg.exec(
      "DELETE FROM auth.api_rate_limits; UPDATE auth.api_tokens SET last_used_at=NULL;",
    );
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await pg.close();
  });

  async function expectNotConfigured() {
    await expect(
      authenticateApiToken(valid.token, CLIENT_IP),
    ).rejects.toMatchObject({ status: 503, code: "AUTH_NOT_CONFIGURED" });
    const response = await request(valid.token, {
      "x-forwarded-for": CLIENT_IP,
    });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("AUTH_NOT_CONFIGURED");
    expect(pools.identity).not.toHaveBeenCalled();
    expect(pools.data).not.toHaveBeenCalled();
    expect(await limits()).toEqual([]);
    expect(await lastUsed()).toBeNull();
  }

  it("refuses a valid token with 503 when hosted sign-in is not ready", async () => {
    stubHostedReadiness({ RESEND_API_KEY: undefined });
    await expectNotConfigured();
  });

  it("refuses a valid token with 503 locally without a usable secret", async () => {
    stubLocalAuthReadiness();
    vi.stubEnv("BETTER_AUTH_SECRET", undefined);
    await expectNotConfigured();
  });

  it("rejects malformed tokens without touching the database", async () => {
    stubLocalAuthReadiness();
    await expect(
      authenticateApiToken("ros_live_short", CLIENT_IP),
    ).rejects.toMatchObject({ status: 401, code: "invalid_token" });
    for (let n = 0; n < 12; n++)
      expect(
        (
          await request("ros_live_not-a-token", {
            "x-forwarded-for": CLIENT_IP,
          })
        ).status,
      ).toBe(401);
    expect(pools.identity).not.toHaveBeenCalled();
    expect(await limits()).toEqual([]);
  });

  it("refuses the 11th failed attempt from one client and then its valid token, while another client authenticates", async () => {
    stubLocalAuthReadiness();
    const from = { "x-forwarded-for": "198.51.100.40" };
    for (let n = 0; n < 10; n++) {
      const response = await request(guess(), from);
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("invalid_token");
    }
    const refused = await request(guess(), from);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect((await refused.json()).error.code).toBe("token_guess_rate_limited");
    const validRefused = await request(valid.token, from);
    expect(validRefused.status).toBe(429);
    expect((await validRefused.json()).error.code).toBe(
      "token_guess_rate_limited",
    );
    await expect(
      authenticateApiToken(valid.token, "198.51.100.40"),
    ).rejects.toMatchObject({ status: 429, code: "token_guess_rate_limited" });
    expect(await limits()).toEqual([
      { key: "api-guess:198.51.100.40", count: 10 },
    ]);
    expect(await lastUsed()).toBeNull();
    const other = await request(valid.token, {
      "x-forwarded-for": "198.51.100.41",
    });
    expect(other.status).toBe(200);
    expect(await lastUsed()).not.toBeNull();
    expect(await limits()).toEqual([
      { key: "api-guess:198.51.100.40", count: 10 },
      { key: "api-guess:198.51.100.41", count: 0 },
      { key: `api-token:${TOKEN_ID}`, count: 1 },
    ]);
  });

  it("keeps the budget on Vercel while spoofed headers rotate", async () => {
    stubHostedReadiness();
    const from = (n: number) => ({
      "x-vercel-forwarded-for": "203.0.113.40",
      "x-forwarded-for": `198.51.100.${n}`,
      "x-real-ip": `192.0.2.${n}`,
    });
    for (let n = 1; n <= 10; n++)
      expect((await request(guess(), from(n))).status).toBe(401);
    const refused = await request(valid.token, from(11));
    expect(refused.status).toBe(429);
    expect((await refused.json()).error.code).toBe("token_guess_rate_limited");
    expect(await lastUsed()).toBeNull();
    const other = await request(valid.token, {
      ...from(12),
      "x-vercel-forwarded-for": "203.0.113.41",
    });
    expect(other.status).toBe(200);
    expect(await limits()).toEqual([
      { key: "api-guess:203.0.113.40", count: 10 },
      { key: "api-guess:203.0.113.41", count: 0 },
      { key: `api-token:${TOKEN_ID}`, count: 1 },
    ]);
  });

  it("does not use the budget for valid authentications and shares one bucket without a client IP", async () => {
    stubLocalAuthReadiness();
    for (let n = 0; n < 12; n++)
      expect((await authenticateApiToken(valid.token, CLIENT_IP)).tokenId).toBe(
        TOKEN_ID,
      );
    await expect(
      authenticateApiToken(guess(), CLIENT_IP),
    ).rejects.toMatchObject({ status: 401, code: "invalid_token" });
    for (let n = 0; n < 10; n++)
      expect((await request(guess())).status).toBe(401);
    expect((await request(valid.token)).status).toBe(429);
    expect(await limits()).toEqual([
      { key: "api-guess:192.0.2.10", count: 1 },
      { key: "api-guess:no-client-ip", count: 10 },
      { key: `api-token:${TOKEN_ID}`, count: 12 },
    ]);
  });
});
