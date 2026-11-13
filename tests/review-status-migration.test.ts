import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db";

// Fictional candidates and saved views written while review status was free text, then upgraded
// by a non-superuser, non-BYPASSRLS migration owner that FORCE RLS would otherwise stop.
const owner = "review_test_owner";
const candidates = {
  verified: randomUUID(),
  completed: randomUUID(),
  reviewed: randomUUID(),
  blank: randomUUID(),
  pending: randomUUID(),
  missing: randomUUID(),
};
const views = {
  verified: randomUUID(),
  pending: randomUUID(),
  empty: randomUUID(),
};
const rawSource = { "Source review status": "Verified by fictional HR" };

describe("free-text review statuses after controlled values", () => {
  const pg = new PGlite();
  beforeAll(async () => {
    await pg.exec(`
      CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
      DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO ${owner}', current_database()); END $$;
      SET SESSION AUTHORIZATION ${owner};
    `);
    await applyMigrations(pg, "0013_export_audit.sql");
    // The bootstrap superuser bypasses RLS; it only seeds the pre-upgrade rows.
    await pg.exec(`SET SESSION AUTHORIZATION postgres;
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES('review-owner','Fictional Review Owner','review-owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES('review-team','Review Team','review-team','review-owner'),('review-other','Other Team','review-other','review-owner');`);
    const candidate = (id: string, team: string, status?: string) =>
      pg.query(
        `INSERT INTO app.records(id,team_id,kind,data,created_by,archived_at) VALUES($1,$2,'candidate',$3,'review-owner',$4)`,
        [
          id,
          team,
          JSON.stringify({
            name: "Fictional Review Person",
            rawSource,
            ...(status === undefined ? {} : { reviewStatus: status }),
          }),
          id === candidates.blank ? "2026-01-01T00:00:00Z" : null,
        ],
      );
    await candidate(candidates.verified, "review-team", "Verified");
    await candidate(candidates.completed, "review-other", " completed ");
    await candidate(candidates.reviewed, "review-team", "Reviewed");
    await candidate(candidates.blank, "review-team", "");
    await candidate(candidates.pending, "review-team", "Pending HR");
    await candidate(candidates.missing, "review-team");
    const view = (id: string, status: string) =>
      pg.query(
        `INSERT INTO app.records(id,team_id,kind,data,created_by,private_owner_id) VALUES($1,'review-team','saved-view',$2,'review-owner','review-owner')`,
        [
          id,
          JSON.stringify({
            name: "Fictional review view",
            area: "directory",
            query: { search: "fictional", reviewStatus: status },
          }),
        ],
      );
    await view(views.verified, "verified");
    await view(views.pending, "Pending HR");
    await view(views.empty, "");
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
    await pg.exec("SET SESSION AUTHORIZATION postgres");
  });
  afterAll(async () => pg.close());

  const read = async (path: string) =>
    new Map(
      (
        await pg.query<{
          id: string;
          value: string | null;
          version: number;
          raw: unknown;
        }>(
          `SELECT id, data#>>'${path}' AS value, version, data->'rawSource' AS raw FROM app.records`,
        )
      ).rows.map((row) => [row.id, row]),
    );

  it("maps every candidate in every team to one of the two values", async () => {
    const rows = await read("{reviewStatus}");
    const expected: [string, string, number][] = [
      [candidates.verified, "Reviewed", 2],
      [candidates.completed, "Reviewed", 2],
      [candidates.reviewed, "Reviewed", 1],
      [candidates.blank, "Needs review", 2],
      [candidates.pending, "Needs review", 2],
      [candidates.missing, "Needs review", 2],
    ];
    for (const [id, value, version] of expected)
      expect(rows.get(id)).toEqual({ id, value, version, raw: rawSource });
  });

  it("maps non-empty saved-view review filters and leaves empty ones alone", async () => {
    const rows = await read("{query,reviewStatus}");
    expect(rows.get(views.verified)).toMatchObject({
      value: "Reviewed",
      version: 2,
    });
    expect(rows.get(views.pending)).toMatchObject({
      value: "Needs review",
      version: 2,
    });
    expect(rows.get(views.empty)).toMatchObject({ value: "", version: 1 });
  });

  it("restores FORCE row-level security on the records table", async () => {
    const result = await pg.query<{ forced: boolean }>(
      "SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid='app.records'::regclass",
    );
    expect(result.rows[0].forced).toBe(true);
  });
});
