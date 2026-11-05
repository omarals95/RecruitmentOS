import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db";

// Fictional buckets written before completion was a flag, then upgraded by a non-superuser,
// non-BYPASSRLS migration owner that FORCE RLS would otherwise stop from seeing any row.
const owner = "bucket_test_owner";
const buckets = {
  done: randomUUID(),
  lowerDone: randomUUID(),
  explicit: randomUUID(),
  waiting: randomUUID(),
  otherDone: randomUUID(),
};

describe("existing Done buckets after the completion flag", () => {
  const pg = new PGlite();
  beforeAll(async () => {
    await pg.exec(`
      CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
      DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO ${owner}', current_database()); END $$;
      SET SESSION AUTHORIZATION ${owner};
    `);
    await applyMigrations(pg, "0011_oauth_reuse_audit.sql");
    // The bootstrap superuser bypasses RLS; it only seeds the pre-upgrade rows.
    await pg.exec(`SET SESSION AUTHORIZATION postgres;
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES('bucket-owner','Fictional Bucket Owner','bucket-owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES('bucket-team','Bucket Team','bucket-team','bucket-owner'),('bucket-other','Other Team','bucket-other','bucket-owner');`);
    await pg.query(
      `INSERT INTO app.records(id,team_id,kind,data,created_by,archived_at) VALUES
        ($1,'bucket-team','bucket','{"name":"Done","color":"#059669","position":3}','bucket-owner',NULL),
        ($2,'bucket-team','bucket','{"name":" done ","color":"#059669","position":4}','bucket-owner','2026-01-01T00:00:00Z'),
        ($3,'bucket-team','bucket','{"name":"DONE","color":"#059669","position":5,"completed":false}','bucket-owner','2026-01-02T00:00:00Z'),
        ($4,'bucket-team','bucket','{"name":"Waiting","color":"#D97706","position":2}','bucket-owner',NULL),
        ($5,'bucket-other','bucket','{"name":"Done","color":"#059669","position":3}','bucket-owner',NULL)`,
      [
        buckets.done,
        buckets.lowerDone,
        buckets.explicit,
        buckets.waiting,
        buckets.otherDone,
      ],
    );
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
    await pg.exec("SET SESSION AUTHORIZATION postgres");
  });
  afterAll(async () => pg.close());

  it("flags unflagged Done buckets in every team and leaves explicit choices and other buckets alone", async () => {
    const rows = (
      await pg.query<{ id: string; completed: string | null; version: number }>(
        "SELECT id, data->>'completed' AS completed, version FROM app.records WHERE kind='bucket'",
      )
    ).rows;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(buckets.done)).toMatchObject({
      completed: "true",
      version: 2,
    });
    expect(byId.get(buckets.lowerDone)).toMatchObject({
      completed: "true",
      version: 2,
    });
    expect(byId.get(buckets.otherDone)).toMatchObject({
      completed: "true",
      version: 2,
    });
    expect(byId.get(buckets.explicit)).toMatchObject({
      completed: "false",
      version: 1,
    });
    expect(byId.get(buckets.waiting)).toMatchObject({
      completed: null,
      version: 1,
    });
  });

  it("restores FORCE row-level security on the records table", async () => {
    const result = await pg.query<{ forced: boolean }>(
      "SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid='app.records'::regclass",
    );
    expect(result.rows[0].forced).toBe(true);
  });
});
