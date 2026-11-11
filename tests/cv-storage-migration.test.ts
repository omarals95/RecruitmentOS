import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, schema, setDbForTests, type AppDb } from "../src/db";
import {
  assertStorageSchema,
  STORAGE_SCHEMA_VERSION,
} from "../src/db/storage-schema";
import { eraseCandidate } from "../src/lib/candidate-erasure";
import { expireCvReservations, getCvDownload } from "../src/lib/cvs";
import { withTeam } from "../src/lib/db-team";
import type { Principal } from "../src/lib/principal";
import type { StorageGateway } from "../src/lib/storage";
import { installTenantContextKey } from "../src/lib/tenant-context";

// Fictional legacy S3 data written by the pre-0007 schema, then upgraded in place.
const candidate = randomUUID(),
  readyId = randomUUID(),
  pendingId = randomUUID(),
  rejectedId = randomUUID();
const p: Principal = {
  userId: "legacy-owner",
  teamId: "legacy-team",
  role: "owner",
  authType: "session",
  scopes: ["candidates:read", "cvs:read", "cvs:write", "imports:write"],
};
const references =
  "id, object_key, status, size_bytes::int, created_at, completed_at, expires_at";
const counters =
  "team_id, used_bytes::int, reserved_bytes::int, used_files, reserved_files, max_bytes::bigint::text AS max_bytes, max_files";

describe("storage reference migration and startup check", () => {
  const pg = new PGlite();
  let beforeUploads: Record<string, unknown>[];
  let beforeUsage: Record<string, unknown>[];
  let preMigrationCheck: unknown;

  beforeAll(async () => {
    await applyMigrations(pg, "0006_trusted_tenant_context.sql");
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES('legacy-owner','Legacy Owner','legacy-owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES('legacy-team','Legacy Team','legacy-team','legacy-owner'),('custom-team','Custom Team','custom-team','legacy-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES('lm','legacy-team','legacy-owner','owner');`);
    await pg.query(
      `INSERT INTO app.records(id,team_id,kind,data,created_by) VALUES($1,'legacy-team','candidate','{"name":"Fictional Legacy Candidate"}','legacy-owner')`,
      [candidate],
    );
    await pg.query(
      `INSERT INTO app.uploads(id,team_id,candidate_id,original_name,mime_type,size_bytes,status,object_key,object_version,created_by,created_at,completed_at,expires_at) VALUES
        ($1,'legacy-team',$4,'ready.pdf','application/pdf',300,'ready','teams/legacy-team/cvs/ready.pdf','fictional-v1','legacy-owner','2026-01-01T00:00:00Z','2026-01-01T00:05:00Z','2026-01-01T01:00:00Z'),
        ($2,'legacy-team',$4,'pending.pdf','application/pdf',200,'pending','teams/legacy-team/cvs/pending.pdf',NULL,'legacy-owner','2026-01-02T00:00:00Z',NULL,'2026-01-02T01:00:00Z'),
        ($3,'legacy-team',$4,'rejected.pdf','application/pdf',100,'rejected','teams/legacy-team/cvs/rejected.pdf',NULL,'legacy-owner','2026-01-03T00:00:00Z',NULL,'2026-01-03T01:00:00Z')`,
      [readyId, pendingId, rejectedId, candidate],
    );
    // The legacy row keeps the old 10 GiB / 10,000-file defaults; the custom row was tuned by hand.
    await pg.exec(`INSERT INTO app.storage_usage(team_id,used_bytes,reserved_bytes,used_files,reserved_files) VALUES('legacy-team',300,200,1,1);
      INSERT INTO app.storage_usage(team_id,used_bytes,reserved_bytes,used_files,reserved_files,max_bytes,max_files) VALUES('custom-team',0,0,0,0,5000000,7);`);
    beforeUploads = (
      await pg.query<Record<string, unknown>>(
        `SELECT ${references}, object_version FROM app.uploads ORDER BY id`,
      )
    ).rows;
    beforeUsage = (
      await pg.query<Record<string, unknown>>(
        `SELECT ${counters} FROM app.storage_usage ORDER BY team_id`,
      )
    ).rows;
    preMigrationCheck = await assertStorageSchema(pg).catch((error) => error);
    await applyMigrations(pg);
    await installTenantContextKey(pg);
    setDbForTests(drizzle(pg, { schema }) as unknown as AppDb);
  });
  afterAll(async () => pg.close());

  it("refuses a database migrated only through 0006 and accepts the full schema", async () => {
    expect(preMigrationCheck).toMatchObject({
      status: 503,
      code: "storage_schema_mismatch",
    });
    expect(STORAGE_SCHEMA_VERSION).toBe(20);
    await expect(assertStorageSchema(pg)).resolves.toBeUndefined();
  });

  for (const through of [
    "0008_pending_s3_upload_index.sql",
    "0017_bulk_intake_tombstones.sql",
    "0018_blob_storage_enablement.sql",
    "0020_speed_log.sql",
    "0025_mcp_candidate_task_tools.sql",
  ])
    it(`refuses a database migrated only through ${through.slice(0, 4)} and accepts the full set`, async () => {
      const partial = new PGlite();
      try {
        await applyMigrations(partial, through);
        await expect(assertStorageSchema(partial)).rejects.toMatchObject({
          status: 503,
          code: "storage_schema_mismatch",
        });
        await applyMigrations(partial);
        await expect(assertStorageSchema(partial)).resolves.toBeUndefined();
      } finally {
        await partial.close();
      }
    });

  it("refuses a marker the owner changed to another version", async () => {
    await pg.exec("UPDATE db_boundary.storage_schema SET version=21");
    try {
      await expect(assertStorageSchema(pg)).rejects.toMatchObject({
        status: 503,
        code: "storage_schema_mismatch",
      });
    } finally {
      await pg.exec("UPDATE db_boundary.storage_schema SET version=20");
    }
  });

  it("keeps every legacy S3 reference as an unbound S3 row with its version", async () => {
    const after = (
      await pg.query<Record<string, unknown>>(
        `SELECT ${references}, s3_version_id, storage_provider, storage_environment, storage_store, blob_sha256, blob_size_bytes FROM app.uploads ORDER BY id`,
      )
    ).rows;
    expect(after).toEqual(
      beforeUploads.map(({ object_version, ...row }) => ({
        ...row,
        s3_version_id: object_version,
        storage_provider: "s3",
        storage_environment: null,
        storage_store: null,
        blob_sha256: null,
        blob_size_bytes: null,
      })),
    );
    expect(after.find((row) => row.id === readyId)?.s3_version_id).toBe(
      "fictional-v1",
    );
  });

  it("keeps team counters, clears only the old default limits and starts retained at zero", async () => {
    expect(
      (
        await pg.query(
          `SELECT ${counters}, retained_bytes::int, retained_files FROM app.storage_usage ORDER BY team_id`,
        )
      ).rows,
    ).toEqual(
      beforeUsage.map((row) => ({
        ...row,
        ...(row.team_id === "legacy-team"
          ? { max_bytes: null, max_files: null }
          : {}),
        retained_bytes: 0,
        retained_files: 0,
      })),
    );
    expect(beforeUsage).toMatchObject([
      { team_id: "custom-team", max_bytes: "5000000", max_files: 7 },
      { team_id: "legacy-team", max_bytes: "10737418240", max_files: 10000 },
    ]);
  });

  it("refuses the unbound legacy download without calling storage and expires its pending ticket", async () => {
    const calls: string[] = [];
    const gateway = new Proxy({} as StorageGateway, {
      get: (_target, property) =>
        property === "binding"
          ? { provider: "s3", environment: "development", store: "fictional-a" }
          : () => {
              calls.push(String(property));
              throw new Error("Storage must not be reached");
            },
    });
    await expect(getCvDownload(p, readyId, gateway)).rejects.toMatchObject({
      status: 409,
      code: "CV_STORAGE_BINDING_MISMATCH",
    });
    await withTeam(p, (tx) =>
      expireCvReservations(tx, p.teamId, gateway.binding, new Date()),
    );
    expect(calls).toEqual([]);
    expect(
      (await pg.query("SELECT id, status FROM app.uploads ORDER BY id")).rows,
    ).toEqual(
      [
        { id: readyId, status: "ready" },
        { id: pendingId, status: "rejected" },
        { id: rejectedId, status: "rejected" },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
    expect(
      (
        await pg.query(
          "SELECT used_bytes::int, reserved_bytes::int, used_files, reserved_files, retained_files FROM app.storage_usage WHERE team_id='legacy-team'",
        )
      ).rows,
    ).toEqual([
      {
        used_bytes: 300,
        reserved_bytes: 0,
        used_files: 1,
        reserved_files: 0,
        retained_files: 0,
      },
    ]);
  });

  it("erases the legacy candidate: its ready S3 row releases the team charge and every row loses its name", async () => {
    const result = await eraseCandidate(p, candidate, {
      confirmName: "Fictional Legacy Candidate",
    });
    expect(result).toMatchObject({
      alreadyErased: false,
      removed: { cvFiles: 3 },
      cvStorage: { deleted: 0, waiting: 0, deleteAfter: null },
    });
    expect(
      (
        await pg.query(
          "SELECT id, status, candidate_id, original_name, erasure_id, object_key FROM app.uploads ORDER BY id",
        )
      ).rows,
    ).toEqual(
      beforeUploads.map((row) => ({
        id: row.id,
        status: "rejected",
        candidate_id: null,
        original_name: null,
        erasure_id: result.erasureId,
        object_key: row.object_key,
      })),
    );
    // Unbound legacy rows were charged to the team only; no store row changes for them.
    expect(
      (
        await pg.query(
          "SELECT used_bytes::int, reserved_bytes::int, retained_bytes::int, used_files, reserved_files, retained_files FROM app.storage_usage WHERE team_id='legacy-team'",
        )
      ).rows,
    ).toEqual([
      {
        used_bytes: 0,
        reserved_bytes: 0,
        retained_bytes: 0,
        used_files: 0,
        reserved_files: 0,
        retained_files: 0,
      },
    ]);
    expect(
      (
        await pg.query(
          "SELECT store, used_bytes::int + reserved_bytes::int + retained_bytes::int AS bytes, used_files + reserved_files + retained_files AS files FROM storage_ledger.stores",
        )
      ).rows,
    ).toEqual([{ store: "fictional-a", bytes: 0, files: 0 }]);
  });
});
