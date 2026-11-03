import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations, schema, setDbForTests, type AppDb } from "../src/db";
import { listActivity } from "../src/lib/insights";
import { roleScopes } from "../src/lib/permissions";

describe("activity identity boundary readiness", () => {
  it("shows the current activity list cannot use a data role without identity access", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await pg.exec(`
        INSERT INTO auth."user"(id,name,email,email_verified,initial_admin)
          VALUES('fixture-user','Fictional User','fixture@example.test',true,true);
        INSERT INTO auth.organization(id,name,slug,created_by)
          VALUES('fixture-team','Fictional Team','fixture-team','fixture-user');
        INSERT INTO auth.member(id,organization_id,user_id,role)
          VALUES('fixture-member','fixture-team','fixture-user','owner');
        INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary)
          VALUES('fixture-team','fixture-user','session','fixture','task','Fictional event');
        CREATE ROLE activity_fixture_data NOLOGIN NOSUPERUSER NOBYPASSRLS;
        GRANT USAGE ON SCHEMA app TO activity_fixture_data;
        GRANT SELECT ON app.activity TO activity_fixture_data;
        SET ROLE activity_fixture_data;
        BEGIN;
        SELECT set_config('app.team_id','fixture-team',true),
               set_config('app.user_id','fixture-user',true);
      `);
      const visible = await pg.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM app.activity",
      );
      expect(visible.rows).toEqual([{ total: 1 }]);
      await pg.exec("COMMIT");
      setDbForTests(drizzle(pg, { schema }) as unknown as AppDb);
      const owner = {
        userId: "fixture-user",
        teamId: "fixture-team",
        role: "owner" as const,
        scopes: roleScopes("owner"),
        authType: "session" as const,
      };
      await expect(
        listActivity(owner, new URLSearchParams()),
      ).rejects.toMatchObject({
        cause: {
          code: "42501",
          message: expect.stringMatching(/permission denied for schema auth/i),
        },
      });
      await expect(
        listActivity(owner, new URLSearchParams({ search: "Fictional" })),
      ).rejects.toMatchObject({
        cause: {
          code: "42501",
          message: expect.stringMatching(/permission denied for schema auth/i),
        },
      });
    } finally {
      await pg.close();
    }
  });
});
