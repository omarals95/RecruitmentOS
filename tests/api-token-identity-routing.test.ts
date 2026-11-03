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

import { applyMigrations, schema } from "../src/db";
import { createTokenMaterial } from "../src/lib/api-token-policy";
import { authenticateApiToken, listTokens } from "../src/lib/api-tokens";
import { roleScopes } from "../src/lib/permissions";

describe("API-token identity connection", () => {
  const pg = new PGlite();
  const material = createTokenMaterial();

  beforeAll(async () => {
    await applyMigrations(pg);
    await pg.exec(`
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin)
        VALUES('identity-user','Fixture','fixture@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by)
        VALUES('identity-team','Fixture','fixture','identity-user');
      INSERT INTO auth.member(id,organization_id,user_id,role)
        VALUES('identity-member','identity-team','identity-user','owner');
      INSERT INTO auth."user"(id,name,email,email_verified)
        VALUES('other-user','Other','other@example.test',true);
      INSERT INTO auth.organization(id,name,slug,created_by)
        VALUES('other-team','Other','other','other-user');
      INSERT INTO auth.member(id,organization_id,user_id,role)
        VALUES('other-member','other-team','other-user','owner');
    `);
    await pg.query(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at)
        VALUES('00000000-0000-4000-8000-000000000001','identity-team','identity-user','Fixture',$1,$2,'["candidates:read"]',now()+interval '1 day')`,
      [material.tokenHash, material.prefix],
    );
    const other = createTokenMaterial();
    await pg.query(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at)
        VALUES('00000000-0000-4000-8000-000000000002','other-team','other-user','Other',$1,$2,'["candidates:read"]',now()+interval '1 day')`,
      [other.tokenHash, other.prefix],
    );
    pools.identity.mockResolvedValue(drizzle(pg, { schema }));
    pools.data.mockRejectedValue(
      new Error("The data pool must not read authentication secrets."),
    );
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => pg.close());

  it("authenticates and commits rate-limit updates using the identity pool", async () => {
    const principal = await authenticateApiToken(material.token);
    expect(principal).toMatchObject({
      userId: "identity-user",
      teamId: "identity-team",
      authType: "token",
      scopes: ["candidates:read"],
    });
    expect(pools.identity).toHaveBeenCalledTimes(1);
    expect(pools.data).not.toHaveBeenCalled();
    const result = await pg.query<{ count: number }>(
      "SELECT count FROM auth.api_rate_limits",
    );
    expect(result.rows[0].count).toBe(1);
  });

  it("lists only the caller's team tokens through the identity pool", async () => {
    const listed = await listTokens({
      userId: "identity-user",
      teamId: "identity-team",
      role: "owner",
      scopes: roleScopes("owner"),
      authType: "session",
    });
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("Fixture");
    expect(JSON.stringify(listed)).not.toContain(material.token);
    expect(pools.identity).toHaveBeenCalledTimes(1);
    expect(pools.data).not.toHaveBeenCalled();
  });
});
