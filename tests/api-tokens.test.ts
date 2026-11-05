import { randomUUID } from "node:crypto";
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
import { applyMigrations, schema, setDbForTests, type AppDb } from "../src/db";
import {
  authenticateApiToken,
  createToken,
  listTokens,
  revokeToken,
} from "../src/lib/api-tokens";
import { createTokenMaterial } from "../src/lib/api-token-policy";
import { roleScopes } from "../src/lib/permissions";
import type { Principal } from "../src/lib/principal";
import { installTenantContextKey } from "../src/lib/tenant-context";
import { GET as overviewRoute } from "../src/app/api/v1/overview/route";
import { CLIENT_IP, stubLocalAuthReadiness } from "./helpers/readiness";

const principal = (
  userId = "recruiter",
  role: Principal["role"] = "recruiter",
  teamId = "team",
): Principal => ({
  userId,
  teamId,
  role,
  scopes: roleScopes(role),
  authType: "session",
});

describe("team scoped API tokens against actual SQL", () => {
  const pg = new PGlite();
  beforeAll(async () => {
    stubLocalAuthReadiness();
    await applyMigrations(pg);
    await installTenantContextKey(pg);
    setDbForTests(drizzle(pg, { schema }) as unknown as AppDb);
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES('owner','Owner','owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES('team','Team','team','owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES('owner-member','team','owner','owner');
      INSERT INTO auth."user"(id,name,email,email_verified) VALUES('recruiter','Recruiter','recruiter@example.test',true),('other','Other','other@example.test',true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES('other-team','Other Team','other-team','other');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES('recruiter-member','team','recruiter','recruiter'),('other-member','other-team','other','owner');`);
  });
  beforeEach(async () => {
    await pg.exec(`TRUNCATE app.activity; DELETE FROM auth.api_tokens; DELETE FROM auth.api_rate_limits;
      UPDATE auth."user" SET email_verified=true;
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES('recruiter-member','team','recruiter','recruiter') ON CONFLICT(id) DO UPDATE SET role='recruiter';`);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await pg.close();
  });

  it("returns the secret once and stores/list only safe metadata", async () => {
    const result = await createToken(principal(), {
      name: "Read candidates",
      scopes: ["candidates:read"],
    });
    expect(result.token).toMatch(/^ros_live_/);
    const rows = await pg.query("SELECT * FROM auth.api_tokens");
    expect(JSON.stringify(rows.rows)).not.toContain(result.token);
    const listed = await listTokens(principal());
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(result.token);
    expect(JSON.stringify(listed)).not.toContain("tokenHash");
    expect((await authenticateApiToken(result.token, CLIENT_IP)).teamId).toBe(
      "team",
    );
    expect(
      (await pg.query("SELECT action FROM app.activity")).rows,
    ).toContainEqual({ action: "token.created" });
  });

  it("rolls back token creation if the corresponding audit entry fails", async () => {
    await pg.exec(`
      CREATE FUNCTION app.reject_test_token_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$;
      CREATE TRIGGER reject_test_token_audit BEFORE INSERT ON app.activity
        FOR EACH ROW EXECUTE FUNCTION app.reject_test_token_audit();
    `);
    try {
      await expect(
        createToken(principal(), {
          name: "Fixture",
          scopes: ["candidates:read"],
        }),
      ).rejects.toThrow();
      const result = await pg.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM auth.api_tokens",
      );
      expect(result.rows[0].count).toBe(0);
    } finally {
      await pg.exec(
        "DROP TRIGGER reject_test_token_audit ON app.activity; DROP FUNCTION app.reject_test_token_audit()",
      );
    }
  });

  it("rolls back token revocation if the corresponding audit entry fails", async () => {
    const result = await createToken(principal(), {
      name: "Fixture",
      scopes: ["candidates:read"],
    });
    await pg.exec(`
      CREATE FUNCTION app.reject_test_token_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$;
      CREATE TRIGGER reject_test_token_audit BEFORE INSERT ON app.activity
        FOR EACH ROW EXECUTE FUNCTION app.reject_test_token_audit();
    `);
    try {
      await expect(revokeToken(principal(), result.data.id)).rejects.toThrow();
      expect((await authenticateApiToken(result.token, CLIENT_IP)).userId).toBe(
        "recruiter",
      );
    } finally {
      await pg.exec(
        "DROP TRIGGER reject_test_token_audit ON app.activity; DROP FUNCTION app.reject_test_token_audit()",
      );
    }
  });

  it("rechecks live membership and role instead of trusting a stale principal or token grant", async () => {
    const result = await createToken(principal(), {
      name: "Recruiting",
      scopes: ["candidates:read", "candidates:write"],
    });
    await pg.exec(
      "UPDATE auth.member SET role='viewer' WHERE id='recruiter-member'",
    );
    expect(
      (await authenticateApiToken(result.token, CLIENT_IP)).scopes,
    ).toEqual(["candidates:read"]);
    await expect(
      createToken(principal(), {
        name: "Stale permission",
        scopes: ["candidates:write"],
      }),
    ).rejects.toMatchObject({ status: 403 });
    await pg.exec("DELETE FROM auth.member WHERE id='recruiter-member'");
    await expect(
      authenticateApiToken(result.token, CLIENT_IP),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects revoked, expired and unverified credentials", async () => {
    const first = await createToken(principal(), {
      name: "Revoked",
      scopes: ["candidates:read"],
    });
    await revokeToken(principal(), first.data.id);
    await expect(
      authenticateApiToken(first.token, CLIENT_IP),
    ).rejects.toMatchObject({
      status: 401,
    });
    const second = await createToken(principal(), {
      name: "Expired",
      scopes: ["candidates:read"],
    });
    await pg.query(
      "UPDATE auth.api_tokens SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [second.data.id],
    );
    await expect(
      authenticateApiToken(second.token, CLIENT_IP),
    ).rejects.toMatchObject({
      status: 401,
    });
    const third = await createToken(principal(), {
      name: "Unverified",
      scopes: ["candidates:read"],
    });
    await pg.exec(
      "UPDATE auth.\"user\" SET email_verified=false WHERE id='recruiter'",
    );
    await expect(
      authenticateApiToken(third.token, CLIENT_IP),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it("does not let another user or team list/revoke a personal token", async () => {
    const result = await createToken(principal(), {
      name: "Private",
      scopes: ["candidates:read"],
    });
    expect(await listTokens(principal("owner", "owner"))).toHaveLength(0);
    expect(await listTokens(principal("owner", "owner"), true)).toHaveLength(1);
    expect(
      await listTokens(principal("other", "owner", "other-team"), true),
    ).toHaveLength(0);
    await expect(
      revokeToken(principal("other", "owner", "other-team"), result.data.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(revokeToken(principal(), randomUUID())).rejects.toMatchObject({
      status: 404,
    });
    await revokeToken(principal("owner", "owner"), result.data.id);
    await expect(
      authenticateApiToken(result.token, CLIENT_IP),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it("uses database rate limits and rejects the sixty-first authenticated request", async () => {
    const result = await createToken(principal(), {
      name: "Rate limit",
      scopes: ["candidates:read"],
    });
    for (let i = 0; i < 60; i++)
      await authenticateApiToken(result.token, CLIENT_IP);
    await expect(
      authenticateApiToken(result.token, CLIENT_IP),
    ).rejects.toMatchObject({
      status: 429,
    });
    const limits = await pg.query<{ count: number }>(
      "SELECT count FROM auth.api_rate_limits WHERE key=$1",
      [`api-token:${result.data.id}`],
    );
    expect(limits.rows[0].count).toBe(61);
  });

  it("sends Retry-After and a correlation ID on a rate-limited route request", async () => {
    const result = await createToken(principal(), {
      name: "Route rate limit",
      scopes: ["candidates:read", "recruitment:read"],
    });
    for (let i = 0; i < 60; i++)
      await authenticateApiToken(result.token, CLIENT_IP);
    const response = await overviewRoute(
      new Request("http://localhost:3000/api/v1/overview", {
        headers: { authorization: `Bearer ${result.token}` },
      }),
    );
    expect(response.status).toBe(429);
    const retryAfter = response.headers.get("retry-after");
    expect(retryAfter).toMatch(/^[1-9]\d*$/);
    const body = await response.json();
    expect(body.error.code).toBe("token_rate_limited");
    expect(body.error.correlationId).toBe(
      response.headers.get("x-correlation-id"),
    );
    expect(body.error.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never authenticates an OAuth grant row as an API token", async () => {
    const material = createTokenMaterial();
    await pg.exec(
      `INSERT INTO auth.oauth_clients(id,name,redirect_uris) VALUES('ros_client_FictionalGrantClient00','Fictional','["https://client.example.test/cb"]') ON CONFLICT DO NOTHING`,
    );
    await pg.query(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at,oauth_client_id)
        VALUES($1,'team','recruiter','Fictional grant',$2,'ros_oauth_fiction','["candidates:read"]',now()+interval '1 day','ros_client_FictionalGrantClient00')`,
      [randomUUID(), material.tokenHash],
    );
    await expect(
      authenticateApiToken(material.token, CLIENT_IP),
    ).rejects.toMatchObject({ status: 401, code: "invalid_token" });
  });

  it("never allows a token principal to create or administer tokens", async () => {
    const bot = {
      ...principal(),
      authType: "token" as const,
      tokenId: randomUUID(),
    };
    await expect(
      createToken(bot, { name: "Nested", scopes: ["candidates:read"] }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(listTokens(bot)).rejects.toMatchObject({ status: 403 });
    await expect(revokeToken(bot, randomUUID())).rejects.toMatchObject({
      status: 403,
    });
  });
});
