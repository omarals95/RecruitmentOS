import { createHmac, randomBytes } from "node:crypto";
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
import { createTokenMaterial, hashToken } from "../src/lib/api-token-policy";
import {
  authenticateApiToken,
  authenticateOAuthAccessToken,
} from "../src/lib/api-tokens";
import { rateLimitClientKey } from "../src/lib/client-ip";
import { installTenantContextKey } from "../src/lib/tenant-context";
import { GET as overviewRoute } from "../src/app/api/v1/overview/route";
import {
  CLIENT_IP,
  hostedReadyEnv,
  stubHostedReadiness,
  stubLocalAuthReadiness,
} from "./helpers/readiness";

const TOKEN_ID = "00000000-0000-4000-8000-000000000031";
const LOCAL_SECRET = "fictional-valid-test-secret-0123456789";
const AUDIENCE = "http://localhost:3000/api/mcp";
/** The stored identity of a client address, derived independently of the helper under test. */
function expectedClientKey(ip: string, secret = LOCAL_SECRET) {
  const key = createHmac("sha256", secret)
    .update("recruitmentos:rate-limit-key:v1")
    .digest();
  return createHmac("sha256", key).update(ip).digest("base64url");
}
const guessKey = (ip: string, secret = LOCAL_SECRET) =>
  `api-guess:${expectedClientKey(ip, secret)}`;
const byKey = (rows: { key: string; count: number }[]) =>
  [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

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
    byKey(
      (
        await pg.query<{ key: string; count: number }>(
          "SELECT key, count FROM auth.api_rate_limits",
        )
      ).rows,
    );
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

  it("refuses the 11th unknown token from one client but still admits its valid token, without growing the budget", async () => {
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
    expect(await lastUsed()).toBeNull();
    const admitted = await request(valid.token, from);
    expect(admitted.status).toBe(200);
    expect(await lastUsed()).not.toBeNull();
    expect(
      (await authenticateApiToken(valid.token, "198.51.100.40")).tokenId,
    ).toBe(TOKEN_ID);
    const again = await request(guess(), from);
    expect(again.status).toBe(429);
    expect(again.headers.get("retry-after")).toBe("60");
    expect((await again.json()).error.code).toBe("token_guess_rate_limited");
    expect(await limits()).toEqual(
      byKey([
        { key: guessKey("198.51.100.40"), count: 10 },
        { key: `api-token:${TOKEN_ID}`, count: 2 },
      ]),
    );
  });

  it("stores only a keyed hash of the client address, which changes with BETTER_AUTH_SECRET", async () => {
    stubLocalAuthReadiness();
    for (let n = 0; n < 3; n++)
      expect(
        (await request(guess(), { "x-forwarded-for": "198.51.100.40" })).status,
      ).toBe(401);
    const keys = (
      await pg.query<{ key: string }>("SELECT key FROM auth.api_rate_limits")
    ).rows.map((row) => row.key);
    expect(keys).toEqual([guessKey("198.51.100.40")]);
    expect(keys.join("\n")).not.toContain("198.51.100.40");
    expect(rateLimitClientKey("198.51.100.40", LOCAL_SECRET)).toBe(
      expectedClientKey("198.51.100.40"),
    );
    const otherSecret = "fictional-other-test-secret-0123456789ab";
    vi.stubEnv("BETTER_AUTH_SECRET", otherSecret);
    expect(
      (await request(guess(), { "x-forwarded-for": "198.51.100.40" })).status,
    ).toBe(401);
    expect(guessKey("198.51.100.40", otherSecret)).not.toBe(
      guessKey("198.51.100.40"),
    );
    expect(await limits()).toEqual(
      byKey([
        { key: guessKey("198.51.100.40"), count: 3 },
        { key: guessKey("198.51.100.40", otherSecret), count: 1 },
      ]),
    );
    expect(rateLimitClientKey(null, LOCAL_SECRET)).toBe("no-client-ip");
  });

  it("keeps the budget on Vercel while spoofed headers rotate", async () => {
    stubHostedReadiness();
    const secret = hostedReadyEnv.BETTER_AUTH_SECRET!;
    const from = (n: number) => ({
      "x-vercel-forwarded-for": "203.0.113.40",
      "x-forwarded-for": `198.51.100.${n}`,
      "x-real-ip": `192.0.2.${n}`,
    });
    for (let n = 1; n <= 10; n++)
      expect((await request(guess(), from(n))).status).toBe(401);
    const refused = await request(guess(), from(11));
    expect(refused.status).toBe(429);
    expect((await refused.json()).error.code).toBe("token_guess_rate_limited");
    const other = await request(guess(), {
      ...from(12),
      "x-vercel-forwarded-for": "203.0.113.41",
    });
    expect(other.status).toBe(401);
    expect((await request(valid.token, from(13))).status).toBe(200);
    expect(await limits()).toEqual(
      byKey([
        { key: guessKey("203.0.113.40", secret), count: 10 },
        { key: guessKey("203.0.113.41", secret), count: 1 },
        { key: `api-token:${TOKEN_ID}`, count: 1 },
      ]),
    );
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
    expect((await request(guess())).status).toBe(429);
    expect((await request(valid.token)).status).toBe(200);
    expect(await limits()).toEqual(
      byKey([
        { key: guessKey(CLIENT_IP), count: 1 },
        { key: "api-guess:no-client-ip", count: 10 },
        { key: `api-token:${TOKEN_ID}`, count: 13 },
      ]),
    );
  });

  it("looks every well-formed token up in the database over budget, after the readiness and format checks", async () => {
    stubLocalAuthReadiness();
    const from = { "x-forwarded-for": "198.51.100.42" };
    for (let n = 0; n < 10; n++)
      expect((await request(guess(), from)).status).toBe(401);
    const calls = pools.identity.mock.calls.length;
    const refused = await request(guess(), from);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect((await refused.json()).error.code).toBe("token_guess_rate_limited");
    expect((await request(valid.token, from)).status).toBe(200);
    // No in-process refusal: each well-formed token costs one identity lookup.
    expect(pools.identity.mock.calls.length).toBeGreaterThan(calls + 1);
    const lookups = pools.identity.mock.calls.length;
    // The order holds: readiness, then format, then the database budget.
    expect((await request("ros_live_short", from)).status).toBe(401);
    vi.stubEnv("BETTER_AUTH_SECRET", undefined);
    expect((await request(valid.token, from)).status).toBe(503);
    vi.stubEnv("BETTER_AUTH_SECRET", LOCAL_SECRET);
    expect(pools.identity.mock.calls.length).toBe(lookups);
    expect(await limits()).toEqual(
      byKey([
        { key: guessKey("198.51.100.42"), count: 10 },
        { key: `api-token:${TOKEN_ID}`, count: 1 },
      ]),
    );
  });

  describe("stale credentials", () => {
    const grantId = "00000000-0000-4000-8000-000000000032";
    const material = () => `ros_oat_${randomBytes(32).toString("base64url")}`;
    const accessExpired = material();
    const wrongAudience = material();
    const refreshRow = material();
    const refresh = `ros_ort_${randomBytes(32).toString("base64url")}`;
    const accessValid = material();
    const revoked = createTokenMaterial();
    const expired = createTokenMaterial();

    beforeAll(async () => {
      await pg.query(
        `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at,revoked_at)
          VALUES(gen_random_uuid(),'gate-team','gate-user','Revoked',$1,$2,'["candidates:read","recruitment:read"]',now()+interval '1 day',now()),
                (gen_random_uuid(),'gate-team','gate-user','Expired',$3,$4,'["candidates:read","recruitment:read"]',now()-interval '1 minute',NULL)`,
        [revoked.tokenHash, revoked.prefix, expired.tokenHash, expired.prefix],
      );
      await pg.query(
        `INSERT INTO auth.oauth_clients(id,name,redirect_uris)
          VALUES('ros_client_FictionalGateClient000','Fictional','["https://claude.ai/api/mcp/auth_callback"]')`,
      );
      await pg.query(
        `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at,oauth_client_id)
          VALUES($1,'gate-team','gate-user','Fictional grant',$2,'ros_oauth_fiction','["candidates:read","recruitment:read"]',now()+interval '30 days','ros_client_FictionalGateClient000')`,
        [grantId, hashToken(material())],
      );
      for (const [token, kind, audience, expiry] of [
        [accessExpired, "access", AUDIENCE, "now()-interval '1 minute'"],
        [
          wrongAudience,
          "access",
          "http://localhost:3000/api/other",
          "now()+interval '1 hour'",
        ],
        [refreshRow, "refresh", AUDIENCE, "now()+interval '30 days'"],
        [refresh, "refresh", AUDIENCE, "now()+interval '30 days'"],
        [accessValid, "access", AUDIENCE, "now()+interval '1 hour'"],
      ])
        await pg.query(
          `INSERT INTO auth.oauth_tokens(grant_id,kind,token_hash,audience,expires_at)
            VALUES($1,$2,$3,$4,${expiry})`,
          [grantId, kind, hashToken(token), audience],
        );
    });

    it("refuse revoked, expired, wrong-audience and refresh credentials without charging the guess budget", async () => {
      stubLocalAuthReadiness();
      const ip = "198.51.100.43";
      for (let n = 0; n < 20; n++) {
        for (const token of [revoked.token, expired.token]) {
          const response = await request(token, { "x-forwarded-for": ip });
          expect(response.status).toBe(401);
          expect((await response.json()).error.code).toBe("invalid_token");
        }
        for (const token of [accessExpired, wrongAudience, refreshRow, refresh])
          await expect(
            authenticateOAuthAccessToken(token, ip, AUDIENCE),
          ).rejects.toMatchObject({ status: 401, code: "invalid_token" });
      }
      expect(await limits()).toEqual([{ key: guessKey(ip), count: 0 }]);
      expect(
        (await request(valid.token, { "x-forwarded-for": ip })).status,
      ).toBe(200);
      expect(
        (await authenticateOAuthAccessToken(accessValid, ip, AUDIENCE)).tokenId,
      ).toBe(grantId);
      expect(
        (await limits()).find((row) => row.key === guessKey(ip))?.count,
      ).toBe(0);
    });

    it("admits live API and OAuth tokens from a shared egress address over budget and refuses every other token with 429", async () => {
      stubLocalAuthReadiness();
      const ip = "198.51.100.44";
      const from = { "x-forwarded-for": ip };
      for (let n = 0; n < 12; n++) await request(guess(), from);
      expect((await limits()).find((row) => row.key === guessKey(ip))).toEqual({
        key: guessKey(ip),
        count: 10,
      });
      expect((await request(valid.token, from)).status).toBe(200);
      expect(
        (await authenticateOAuthAccessToken(accessValid, ip, AUDIENCE)).tokenId,
      ).toBe(grantId);
      for (const token of [guess(), revoked.token, expired.token]) {
        const response = await request(token, from);
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe("60");
        expect((await response.json()).error.code).toBe(
          "token_guess_rate_limited",
        );
      }
      for (const token of [
        material(),
        accessExpired,
        wrongAudience,
        refreshRow,
      ])
        await expect(
          authenticateOAuthAccessToken(token, ip, AUDIENCE),
        ).rejects.toMatchObject({
          status: 429,
          code: "token_guess_rate_limited",
        });
      expect(
        (await limits()).find((row) => row.key === guessKey(ip))?.count,
      ).toBe(10);
    });
  });
});
