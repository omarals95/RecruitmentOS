import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations, schema, setDbForTests, type AppDb } from "../src/db";
import {
  authenticateApiToken,
  createToken,
  revokeToken,
} from "../src/lib/api-tokens";
import { roleScopes } from "../src/lib/permissions";

describe("staged identity separation and token audit", () => {
  it("does not allow either isolated role to perform the current cross-schema token transaction", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await pg.exec(`
        INSERT INTO auth."user"(id,name,email,email_verified,initial_admin)
          VALUES('fixture-user','Fixture','fixture@example.test',true,true);
        INSERT INTO auth.organization(id,name,slug,created_by)
          VALUES('fixture-team','Fixture','fixture-team','fixture-user');
        INSERT INTO auth.member(id,organization_id,user_id,role)
          VALUES('fixture-member','fixture-team','fixture-user','owner');
        CREATE ROLE fixture_data NOLOGIN NOSUPERUSER NOBYPASSRLS;
        CREATE ROLE fixture_identity NOLOGIN NOSUPERUSER NOBYPASSRLS;
        GRANT USAGE ON SCHEMA app TO fixture_data;
        GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA app TO fixture_data;
        GRANT USAGE ON SCHEMA auth TO fixture_identity;
        GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA auth TO fixture_identity;
        REVOKE INSERT,UPDATE,DELETE ON auth.initial_admin_claim FROM fixture_identity;
        SET ROLE fixture_data;
      `);
      setDbForTests(drizzle(pg, { schema }) as unknown as AppDb);
      await expect(
        pg.query("SELECT id FROM auth.api_tokens"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        createToken(
          {
            userId: "fixture-user",
            teamId: "fixture-team",
            role: "owner",
            scopes: roleScopes("owner"),
            authType: "session",
          },
          { name: "Synthetic token", scopes: ["candidates:read"] },
        ),
      ).rejects.toThrow();
      await pg.exec("RESET ROLE; SET ROLE fixture_identity");
      const count = await pg.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM auth.api_tokens",
      );
      expect(count.rows[0].count).toBe(0);
      await expect(
        pg.exec(`INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary)
          VALUES('fixture-team','fixture-user','session','token.created','api-token','fixture')`),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await pg.close();
    }
  });

  it("keeps token creation and its audit atomic with a synthetic nonowner legacy role", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await pg.exec(`
        INSERT INTO auth."user"(id,name,email,email_verified,initial_admin)
          VALUES('fixture-user','Fixture','fixture@example.test',true,true);
        INSERT INTO auth.organization(id,name,slug,created_by)
          VALUES('fixture-team','Fixture','fixture-team','fixture-user');
        INSERT INTO auth.member(id,organization_id,user_id,role)
          VALUES('fixture-member','fixture-team','fixture-user','owner');
        CREATE ROLE fixture_legacy NOLOGIN NOSUPERUSER NOBYPASSRLS;
        GRANT USAGE ON SCHEMA app,auth TO fixture_legacy;
        GRANT SELECT,INSERT,UPDATE,DELETE ON auth."user",auth.member,auth.api_tokens TO fixture_legacy;
        GRANT SELECT,INSERT ON app.activity TO fixture_legacy;
        SET ROLE fixture_legacy;
      `);
      setDbForTests(drizzle(pg, { schema }) as unknown as AppDb);
      const principal = {
        userId: "fixture-user",
        teamId: "fixture-team",
        role: "owner" as const,
        scopes: roleScopes("owner"),
        authType: "session" as const,
      };
      await createToken(principal, {
        name: "First",
        scopes: ["candidates:read"],
      });
      await pg.exec("RESET ROLE");
      const saved = await pg.query<{ tokens: number; audits: number }>(
        "SELECT (SELECT count(*)::int FROM auth.api_tokens) AS tokens, (SELECT count(*)::int FROM app.activity WHERE action='token.created') AS audits",
      );
      expect(saved.rows).toEqual([{ tokens: 1, audits: 1 }]);
      await pg.exec(
        "REVOKE INSERT ON app.activity FROM fixture_legacy; SET ROLE fixture_legacy",
      );
      await expect(
        createToken(principal, { name: "Second", scopes: ["candidates:read"] }),
      ).rejects.toThrow();
      await pg.exec("RESET ROLE");
      const after = await pg.query<{ tokens: number; audits: number }>(
        "SELECT (SELECT count(*)::int FROM auth.api_tokens) AS tokens, (SELECT count(*)::int FROM app.activity WHERE action='token.created') AS audits",
      );
      expect(after.rows).toEqual([{ tokens: 1, audits: 1 }]);
    } finally {
      await pg.close();
    }
  });

  it("preserves owner-managed revocation and one audit event under a nonowner role", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await pg.exec(`
        INSERT INTO auth."user"(id,name,email,email_verified,initial_admin)
          VALUES('owner','Owner','owner@example.test',true,true);
        INSERT INTO auth.organization(id,name,slug,created_by)
          VALUES('team','Team','team','owner');
        INSERT INTO auth.member(id,organization_id,user_id,role)
          VALUES('owner-member','team','owner','owner');
        INSERT INTO auth."user"(id,name,email,email_verified)
          VALUES('recruiter-a','Recruiter A','a@example.test',true),
                ('recruiter-b','Recruiter B','b@example.test',true);
        INSERT INTO auth.member(id,organization_id,user_id,role)
          VALUES('a-member','team','recruiter-a','recruiter'),
                ('b-member','team','recruiter-b','recruiter');
        CREATE ROLE fixture_revoke NOLOGIN NOSUPERUSER NOBYPASSRLS;
        GRANT USAGE ON SCHEMA app,auth TO fixture_revoke;
        GRANT SELECT,INSERT,UPDATE,DELETE ON auth."user",auth.member,auth.api_tokens,auth.api_rate_limits TO fixture_revoke;
        GRANT SELECT,INSERT ON app.activity TO fixture_revoke;
        SET ROLE fixture_revoke;
      `);
      setDbForTests(drizzle(pg, { schema }) as unknown as AppDb);
      const recruiter = (userId: string) => ({
        userId,
        teamId: "team",
        role: "recruiter" as const,
        scopes: roleScopes("recruiter"),
        authType: "session" as const,
      });
      const owner = {
        userId: "owner",
        teamId: "team",
        role: "owner" as const,
        scopes: roleScopes("owner"),
        authType: "session" as const,
      };
      const created = await createToken(recruiter("recruiter-a"), {
        name: "Synthetic token",
        scopes: ["candidates:read"],
      });
      await expect(
        revokeToken(recruiter("recruiter-b"), created.data.id),
      ).rejects.toMatchObject({ status: 404 });
      expect((await authenticateApiToken(created.token)).userId).toBe(
        "recruiter-a",
      );
      await pg.exec(
        "RESET ROLE; REVOKE INSERT ON app.activity FROM fixture_revoke; SET ROLE fixture_revoke",
      );
      await expect(revokeToken(owner, created.data.id)).rejects.toThrow();
      expect((await authenticateApiToken(created.token)).userId).toBe(
        "recruiter-a",
      );
      await pg.exec(
        "RESET ROLE; GRANT INSERT ON app.activity TO fixture_revoke; SET ROLE fixture_revoke",
      );
      await revokeToken(owner, created.data.id);
      await revokeToken(owner, created.data.id);
      await expect(authenticateApiToken(created.token)).rejects.toMatchObject({
        status: 401,
      });
      await pg.exec("RESET ROLE");
      const events = await pg.query<{ action: string; actor_id: string }>(
        "SELECT action,actor_id FROM app.activity ORDER BY action",
      );
      expect(events.rows).toEqual([
        { action: "token.created", actor_id: "recruiter-a" },
        { action: "token.revoked", actor_id: "owner" },
      ]);
      const audits = await pg.query("SELECT * FROM app.activity");
      expect(JSON.stringify(audits.rows)).not.toContain(created.token);
    } finally {
      await pg.close();
    }
  });
});
