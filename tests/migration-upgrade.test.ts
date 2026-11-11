import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  schema,
  setDbForTests,
  type AppDb,
  type TeamTx,
} from "../src/db";
import { withDeadlinesAndSnapshot } from "../src/db/deadlines";
import { eraseCandidate } from "../src/lib/candidate-erasure";
import { listCandidateCvs } from "../src/lib/cvs";
import {
  kindToResource,
  resourceToKind,
  type RecordKind,
  type ResourceName,
} from "../src/domain/records";
import { roleScopes, type Role } from "../src/lib/permissions";
import type { Principal } from "../src/lib/principal";
import { getCandidateState, getRecord, listRecords } from "../src/lib/records";
import {
  installTenantContext,
  installTenantContextKey,
} from "../src/lib/tenant-context";

// A populated fictional workspace written by the 0006 schema, upgraded in place through every
// later migration. Candidates already hold a controlled review status and no bucket is named Done,
// so 0012 and 0014 have nothing to rewrite and every row must come through unchanged.
const ids = Object.fromEntries(
  [
    "jobRole",
    "vacancy",
    "candidate",
    "otherCandidate",
    "application",
    "offer",
    "interview",
    "onboarding",
    "checklist",
    "bucket",
    "task",
    "comment",
    "view",
    "teamBCandidate",
    "cv",
  ].map((name) => [name, randomUUID()]),
) as Record<string, string>;
const principal = (userId: string, teamId: string, role: Role): Principal => ({
  userId,
  teamId,
  role,
  scopes: roleScopes(role),
  authType: "session",
});
const ownerA = principal("upgrade-owner-a", "upgrade-team-a", "owner");
const memberA = principal("upgrade-member-a", "upgrade-team-a", "recruiter");
const ownerB = principal("upgrade-owner-b", "upgrade-team-b", "owner");
const note = "Fictional private follow-up note";
const recordColumns =
  "id, team_id, kind, data, version, candidate_id, vacancy_id, application_id, onboarding_id, bucket_id, job_role_id, parent_record_id, private_owner_id";
const activityColumns =
  "id, team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata, created_at";
const stateColumns =
  "team_id, user_id, candidate_id, shortlisted, status, note, version, import_meta, updated_at";
const migrationFiles = async (dir: string) =>
  (await readdir(dir)).filter((f) => /^\d{4}.*\.sql$/.test(f)).sort();
// A row as the earlier schema wrote it: the activity column 0036 adds and the two team archive
// columns 0044 adds to app.workspace_teams (the only table with archived_by) are left out, so an
// upgrade from before them compares the columns its fixture rows had.
const earlierColumns = (row: unknown) => {
  const { employee_erasure_id: _added, ...kept } = row as Record<
    string,
    unknown
  >;
  if (!Object.hasOwn(kept, "archived_by")) return kept;
  const { archived_at: _archivedAt, archived_by: _archivedBy, ...team } = kept;
  return team;
};
// A record row as the schema before 0040 wrote it: the two pin columns 0040 adds and the bracket
// pin 0048 adds are left out.
const withoutPins = (row: unknown) => {
  const {
    schema_version_id: _schemaVersion,
    type_id: _type,
    pay_bracket_version_id: _bracketVersion,
    ...kept
  } = row as Record<string, unknown>;
  return kept;
};

describe("populated fictional baseline upgrade from 0006", () => {
  const pg = new PGlite();
  const snapshot = async () => ({
    records: (
      await pg.query(`SELECT ${recordColumns} FROM app.records ORDER BY id`)
    ).rows,
    activity: (
      await pg.query(`SELECT ${activityColumns} FROM app.activity ORDER BY id`)
    ).rows,
    states: (
      await pg.query(
        `SELECT ${stateColumns} FROM app.candidate_states ORDER BY candidate_id`,
      )
    ).rows,
  });
  const ledger = async () =>
    (
      await pg.query<{ name: string }>(
        "SELECT name FROM public.recruitment_migrations ORDER BY name",
      )
    ).rows.map((row) => row.name);
  let before: Awaited<ReturnType<typeof snapshot>>;
  let uploadBefore: Record<string, unknown>;

  beforeAll(async () => {
    await applyMigrations(pg, "0006_trusted_tenant_context.sql");
    // The first owner completes the initial-administrator setup before anyone else signs up.
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('upgrade-owner-a','Fictional Owner A','upgrade-owner-a@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('upgrade-team-a','Fictional Team A','upgrade-team-a','upgrade-owner-a');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('upgrade-ma','upgrade-team-a','upgrade-owner-a','owner');
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('upgrade-member-a','Fictional Member A','upgrade-member-a@example.test',true,false),
        ('upgrade-owner-b','Fictional Owner B','upgrade-owner-b@example.test',true,false);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('upgrade-team-b','Fictional Team B','upgrade-team-b','upgrade-owner-b');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('upgrade-mm','upgrade-team-a','upgrade-member-a','recruiter'),
        ('upgrade-mb','upgrade-team-b','upgrade-owner-b','owner');`);
    const insert = (
      id: string,
      team: string,
      kind: string,
      data: object,
      refs: Record<string, string> = {},
      privateOwner: string | null = null,
    ) =>
      pg.query(
        `INSERT INTO app.records(id,team_id,kind,data,created_by,candidate_id,vacancy_id,application_id,onboarding_id,bucket_id,job_role_id,parent_record_id,private_owner_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          id,
          team,
          kind,
          JSON.stringify(data),
          team === "upgrade-team-a" ? ownerA.userId : ownerB.userId,
          refs.candidate ?? null,
          refs.vacancy ?? null,
          refs.application ?? null,
          refs.onboarding ?? null,
          refs.bucket ?? null,
          refs.jobRole ?? null,
          refs.parent ?? null,
          privateOwner,
        ],
      );
    const a = "upgrade-team-a";
    await insert(ids.jobRole, a, "job-role", {
      title: "Fictional Platform Engineer",
      department: "Engineering",
    });
    await insert(
      ids.vacancy,
      a,
      "vacancy",
      { title: "Fictional Platform Engineer", requisitionId: "UPG-001" },
      { jobRole: ids.jobRole },
    );
    await insert(ids.candidate, a, "candidate", {
      name: "Fictional Upgrade Candidate",
      email: "upgrade-candidate@example.test",
      reviewStatus: "Reviewed",
    });
    await insert(ids.otherCandidate, a, "candidate", {
      name: "Fictional Second Candidate",
      reviewStatus: "Needs review",
    });
    await insert(
      ids.application,
      a,
      "application",
      { stage: "Offer" },
      { candidate: ids.candidate, vacancy: ids.vacancy },
    );
    await insert(
      ids.offer,
      a,
      "offer",
      {
        title: "Fictional offer",
        amount: "25000.50",
        currency: "AED",
        status: "Draft",
      },
      { application: ids.application },
    );
    await insert(
      ids.interview,
      a,
      "interview",
      { title: "Fictional interview", status: "Scheduled" },
      { application: ids.application },
    );
    await insert(
      ids.onboarding,
      a,
      "onboarding",
      { status: "In progress" },
      { application: ids.application },
    );
    await insert(
      ids.checklist,
      a,
      "checklist",
      { title: "Fictional orientation", status: "Pending" },
      { onboarding: ids.onboarding },
    );
    await insert(ids.bucket, a, "bucket", { name: "Fictional follow-ups" });
    await insert(
      ids.task,
      a,
      "task",
      { title: "Fictional follow-up task" },
      { bucket: ids.bucket },
    );
    await insert(
      ids.comment,
      a,
      "comment",
      { body: "Fictional comment" },
      { parent: ids.candidate },
    );
    await insert(
      ids.view,
      a,
      "saved-view",
      { name: "Fictional private view", query: { q: "Fictional" } },
      {},
      memberA.userId,
    );
    await insert(ids.teamBCandidate, "upgrade-team-b", "candidate", {
      name: "Fictional Team B Candidate",
      reviewStatus: "Reviewed",
    });
    await pg.query(
      `INSERT INTO app.candidate_states(team_id,user_id,candidate_id,status,note) VALUES($1,$2,$3,'Contacted',$4)`,
      [a, memberA.userId, ids.candidate, note],
    );
    await pg.query(
      `INSERT INTO app.activity(team_id,record_id,actor_id,actor_type,action,kind,summary,created_at) VALUES
        ($1,$2,$4,'session','created','candidate','Fictional candidate created','2026-01-01T00:00:00Z'),
        ($1,$3,$4,'session','created','offer','Fictional offer created','2026-01-02T00:00:00Z'),
        ($1,$5,$4,'session','created','comment','Fictional comment created','2026-01-03T00:00:00Z')`,
      [a, ids.candidate, ids.offer, ownerA.userId, ids.comment],
    );
    await pg.query(
      `INSERT INTO app.uploads(id,team_id,candidate_id,original_name,mime_type,size_bytes,status,object_key,object_version,created_by,created_at,completed_at,expires_at)
        VALUES($1,$2,$3,'fictional-cv.pdf','application/pdf',300,'ready','teams/upgrade-team-a/cvs/fictional-cv.pdf','fictional-v1',$4,'2026-01-01T00:00:00Z','2026-01-01T00:05:00Z','2026-01-01T01:00:00Z')`,
      [ids.cv, a, ids.candidate, ownerA.userId],
    );
    await pg.query(
      "INSERT INTO app.storage_usage(team_id,used_bytes,used_files) VALUES($1,300,1)",
      [a],
    );
    before = await snapshot();
    uploadBefore = (
      await pg.query<Record<string, unknown>>(
        "SELECT id, candidate_id, object_key, object_version, size_bytes::int, status FROM app.uploads",
      )
    ).rows[0];
    await applyMigrations(pg);
    await installTenantContextKey(pg);
    setDbForTests(drizzle(pg, { schema }) as unknown as AppDb);
  });
  afterAll(async () => pg.close());

  it("records every migration file in the ledger", async () => {
    expect(await ledger()).toEqual(
      await migrationFiles(join(process.cwd(), "drizzle")),
    );
  });

  it("keeps every record, audit row and private state unchanged", async () => {
    expect(before.records).toHaveLength(14);
    expect(before.activity).toHaveLength(3);
    expect(before.states).toHaveLength(1);
    expect(await snapshot()).toEqual(before);
  });

  it("keeps the offer amount and currency exactly", async () => {
    const offer = await getRecord(ownerA, "offers", ids.offer);
    expect(offer.data).toMatchObject({ amount: "25000.50", currency: "AED" });
    expect(
      (
        await pg.query(
          "SELECT data->>'amount' AS amount, data->>'currency' AS currency FROM app.records WHERE id=$1",
          [ids.offer],
        )
      ).rows,
    ).toEqual([{ amount: "25000.50", currency: "AED" }]);
  });

  it("keeps the CV identity and moves its version into s3_version_id", async () => {
    const { object_version, ...identity } = uploadBefore;
    expect(
      (
        await pg.query(
          "SELECT id, candidate_id, object_key, s3_version_id, size_bytes::int, status FROM app.uploads",
        )
      ).rows,
    ).toEqual([{ ...identity, s3_version_id: object_version }]);
    expect(object_version).toBe("fictional-v1");
    // 0019 starts every existing reservation's PUT ticket count at zero.
    expect(
      (await pg.query("SELECT put_tickets_issued FROM app.uploads")).rows,
    ).toEqual([{ put_tickets_issued: 0 }]);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
    expect(
      (await listCandidateCvs(ownerA, ids.candidate)).map((cv) => cv.id),
    ).toEqual([ids.cv]);
  });

  it("keeps team and private boundaries through the application", async () => {
    await expect(
      getRecord(ownerB, "candidates", ids.candidate),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await getCandidateState(memberA, ids.candidate)).toMatchObject({
      status: "Contacted",
      note,
    });
    expect(await getCandidateState(ownerA, ids.candidate)).toMatchObject({
      status: "New",
      note: "",
      version: 0,
    });
    const views = async (p: Principal) =>
      (await listRecords(p, "views", new URLSearchParams())).data.map(
        (view) => view.id,
      );
    expect(await views(memberA)).toEqual([ids.view]);
    expect(await views(ownerA)).toEqual([]);
  });

  it("leaves no trace of a failed migration and continues once it is removed", async () => {
    const source = join(process.cwd(), "drizzle");
    const real = await migrationFiles(source);
    const applied = await ledger();
    const root = await mkdtemp(
      join(tmpdir(), "recruitmentos-failed-migration-"),
    );
    const drizzleDir = join(root, "drizzle");
    const failing = join(drizzleDir, "9999_fictional_failure.sql");
    await mkdir(drizzleDir);
    for (const file of real)
      await copyFile(join(source, file), join(drizzleDir, file));
    // The table is created first; the division then aborts the whole file.
    await writeFile(
      failing,
      "CREATE TABLE app.fictional_partial(value integer);\nINSERT INTO app.fictional_partial(value) VALUES (1/0);\n",
    );
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      await expect(applyMigrations(pg)).rejects.toMatchObject({
        code: "22012",
      });
      expect(await ledger()).toEqual(applied);
      expect(applied).toEqual(real);
      expect(
        (
          await pg.query(
            "SELECT to_regclass('app.fictional_partial') IS NULL AS absent",
          )
        ).rows,
      ).toEqual([{ absent: true }]);
      expect(await snapshot()).toEqual(before);
      await rm(failing);
      await applyMigrations(pg);
      expect(await ledger()).toEqual(applied);
    } finally {
      cwd.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Rows written by the 0020 schema, upgraded through 0021: nothing changes until an owner erases.
describe("upgrade from 0020 to candidate erasure", () => {
  const pg = new PGlite();
  const owner = principal(
    "erasure-upgrade-owner",
    "erasure-upgrade-team",
    "owner",
  );
  const candidate = randomUUID(),
    upload = randomUUID(),
    batch = randomUUID(),
    item = randomUUID();
  const tables = {
    records: "id, team_id, kind, data, version, candidate_id",
    activity: activityColumns,
    uploads:
      "id, team_id, candidate_id, original_name, mime_type, size_bytes, status, object_key, expires_at",
    bulk_intake_items:
      "id, team_id, batch_id, original_name, mime_type, size_bytes, payload_hash, reviewed_at, possible_duplicates, candidate_id, upload_id",
  };
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(tables).map(async ([table, columns]) => [
          table,
          (await pg.query(`SELECT ${columns} FROM app.${table} ORDER BY id`))
            .rows,
        ]),
      ),
    );
  let before: Record<string, unknown>;

  beforeAll(async () => {
    await applyMigrations(pg, "0020_speed_log.sql");
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('erasure-upgrade-owner','Fictional Upgrade Owner','erasure-upgrade-owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('erasure-upgrade-team','Fictional Upgrade Team','erasure-upgrade-team','erasure-upgrade-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('erasure-upgrade-m','erasure-upgrade-team','erasure-upgrade-owner','owner');
      INSERT INTO storage_ledger.stores(provider,store,environment) VALUES ('s3','fictional-upgrade','development');
      INSERT INTO app.storage_usage(team_id) VALUES ('erasure-upgrade-team');`);
    await pg.query(
      `INSERT INTO app.records(id,team_id,kind,data,created_by) VALUES($1,'erasure-upgrade-team','candidate','{"name":"Fictional Upgrade Erasure"}','erasure-upgrade-owner')`,
      [candidate],
    );
    await pg.query(
      `INSERT INTO app.activity(team_id,record_id,actor_id,actor_type,action,kind,summary) VALUES
        ('erasure-upgrade-team',$1,'erasure-upgrade-owner','session','created','candidate','Created candidate')`,
      [candidate],
    );
    await pg.query(
      `INSERT INTO app.uploads(id,team_id,candidate_id,original_name,mime_type,size_bytes,status,object_key,storage_provider,storage_environment,storage_store,created_by,expires_at)
        VALUES($1,'erasure-upgrade-team',$2,'fictional-upgrade.pdf','application/pdf',300,'pending','teams/erasure-upgrade-team/cvs/fictional-upgrade.pdf','s3','development','fictional-upgrade','erasure-upgrade-owner',now()+interval '1 hour')`,
      [upload, candidate],
    );
    await pg.query(
      `INSERT INTO app.bulk_intake_batches(id,team_id,created_by,created_at,expires_at) VALUES($1,'erasure-upgrade-team','erasure-upgrade-owner',now(),now()+interval '1 day')`,
      [batch],
    );
    await pg.query(
      `INSERT INTO app.bulk_intake_items(id,team_id,batch_id,created_by,original_name,mime_type,size_bytes,payload_hash,reviewed_at,possible_duplicates,candidate_id,upload_id,created_at,updated_at)
        VALUES($1,'erasure-upgrade-team',$2,'erasure-upgrade-owner','fictional-upgrade.pdf','application/pdf',300,$3,now(),0,$4,$5,now(),now())`,
      [item, batch, "a".repeat(64), candidate, upload],
    );
    before = await snapshot();
    await applyMigrations(pg);
    await installTenantContextKey(pg);
    setDbForTests(drizzle(pg, { schema }) as unknown as AppDb);
  });
  afterAll(async () => pg.close());

  it("keeps every row, adds empty erasure columns and sets storage schema 5", async () => {
    expect(await snapshot()).toEqual(before);
    for (const table of ["activity", "uploads"])
      expect(
        (
          await pg.query(
            `SELECT count(*)::int AS n FROM app.${table} WHERE erasure_id IS NOT NULL`,
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    expect(
      (
        await pg.query(
          "SELECT count(*)::int AS n FROM app.bulk_intake_items WHERE erased_at IS NOT NULL",
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
    expect(
      (
        await pg.query<{ name: string }>(
          "SELECT name FROM public.recruitment_migrations WHERE name LIKE '0021%'",
        )
      ).rows,
    ).toEqual([{ name: "0021_candidate_erasure.sql" }]);
  });

  it("erases an upgraded candidate with its pre-existing upload and bulk item", async () => {
    // No CV storage is configured here, so the erasure skips the Blob pass and logs nothing.
    const lines: unknown[] = [];
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => lines.push(args));
    const result = await eraseCandidate(owner, candidate, {
      confirmName: "Fictional Upgrade Erasure",
    }).finally(() => logged.mockRestore());
    expect(lines).toEqual([]);
    expect(result.removed).toMatchObject({
      bulkItems: 1,
      cvFiles: 1,
      activityRedacted: 1,
    });
    expect(
      (
        await pg.query(
          "SELECT status, candidate_id, original_name, erasure_id FROM app.uploads WHERE id=$1",
          [upload],
        )
      ).rows,
    ).toEqual([
      {
        status: "rejected",
        candidate_id: null,
        original_name: null,
        erasure_id: result.erasureId,
      },
    ]);
    // A rejected S3 reservation releases its charge, as before.
    expect(
      (
        await pg.query(
          "SELECT reserved_bytes::int, used_bytes::int, retained_bytes::int FROM app.storage_usage WHERE team_id=$1",
          [owner.teamId],
        )
      ).rows,
    ).toEqual([{ reserved_bytes: 0, used_bytes: 0, retained_bytes: 0 }]);
    expect(
      (
        await pg.query(
          "SELECT erased_at IS NOT NULL AS erased, original_name, candidate_id FROM app.bulk_intake_items WHERE id=$1",
          [item],
        )
      ).rows,
    ).toEqual([{ erased: true, original_name: null, candidate_id: null }]);
  });
});

// Teams and members written by the 0027 schema, upgraded through 0028: one company workspace above
// both teams, with only the initial administrator as company owner.
describe("upgrade from 0027 to the company workspace", () => {
  const pg = new PGlite();
  const company = "00000000-0000-4000-a000-000000000001";
  const workspaceRows = async () =>
    Object.fromEntries(
      await Promise.all(
        ["workspaces", "workspace_teams", "workspace_admins"].map(
          async (table) => [
            table,
            (await pg.query(`SELECT * FROM app.${table} ORDER BY 1, 2`)).rows,
          ],
        ),
      ),
    );

  beforeAll(async () => {
    await applyMigrations(pg, "0027_release_1_cleanup.sql");
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('workspace-upgrade-admin','Fictional Upgrade Admin','workspace-upgrade-admin@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('workspace-upgrade-team-a','Fictional Upgrade Team A','workspace-upgrade-team-a','workspace-upgrade-admin');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('workspace-upgrade-ma','workspace-upgrade-team-a','workspace-upgrade-admin','owner');
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('workspace-upgrade-owner-b','Fictional Upgrade Owner B','workspace-upgrade-owner-b@example.test',true,false),
        ('workspace-upgrade-viewer','Fictional Upgrade Viewer','workspace-upgrade-viewer@example.test',true,false);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('workspace-upgrade-team-b','Fictional Upgrade Team B','workspace-upgrade-team-b','workspace-upgrade-owner-b');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('workspace-upgrade-mb','workspace-upgrade-team-b','workspace-upgrade-owner-b','owner'),
        ('workspace-upgrade-mv','workspace-upgrade-team-a','workspace-upgrade-viewer','viewer');`);
    await applyMigrations(pg);
  });
  afterAll(async () => pg.close());

  it("maps both teams to the one workspace and makes only the initial administrator company owner", async () => {
    expect(
      (await pg.query("SELECT id, name FROM app.workspaces")).rows,
    ).toEqual([{ id: company, name: "Company" }]);
    expect(
      (
        await pg.query(
          "SELECT team_id, workspace_id FROM app.workspace_teams ORDER BY team_id",
        )
      ).rows,
    ).toEqual([
      { team_id: "workspace-upgrade-team-a", workspace_id: company },
      { team_id: "workspace-upgrade-team-b", workspace_id: company },
    ]);
    expect(
      (
        await pg.query(
          "SELECT workspace_id, user_id, level, areas, plan_access, granted_by, suspended_at FROM app.workspace_admins",
        )
      ).rows,
    ).toEqual([
      {
        workspace_id: company,
        user_id: "workspace-upgrade-admin",
        level: "owner",
        areas: [],
        plan_access: false,
        granted_by: null,
        suspended_at: null,
      },
    ]);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("changes nothing when the migrations run again", async () => {
    const before = await workspaceRows();
    await applyMigrations(pg);
    expect(await workspaceRows()).toEqual(before);
  });

  it("makes every seed insert of the migration idempotent", async () => {
    const [file] = (
      await migrationFiles(join(process.cwd(), "drizzle"))
    ).filter((name) => name.startsWith("0028_"));
    const body = await readFile(join(process.cwd(), "drizzle", file), "utf8");
    for (const table of ["workspaces", "workspace_teams", "workspace_admins"]) {
      const seed = new RegExp(
        String.raw`^INSERT INTO app\.${table}\([^;]*?ON CONFLICT \([a-z_, ]+\) DO NOTHING;`,
        "m",
      );
      expect(body, table).toMatch(seed);
    }
  });
});

// Teams, members, company authority and a leftover context row written by the 0028 schema,
// upgraded through 0029: the context gains the derived columns and install returns them.
describe("upgrade from 0028 to the signed context that derives the workspace", () => {
  const pg = new PGlite();
  const company = "00000000-0000-4000-a000-000000000001";
  const admin = principal(
    "context-upgrade-admin",
    "context-upgrade-team",
    "recruiter",
  );
  const leftover = {
    pid: 1,
    xid: "1",
    team_id: "context-upgrade-team",
    actor_id: "context-upgrade-owner",
    auth_type: "session",
    token_id: null,
    scopes: ["candidates:read"],
  };

  beforeAll(async () => {
    await applyMigrations(pg, "0028_workspace_company_authority.sql");
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('context-upgrade-owner','Fictional Upgrade Owner','context-upgrade-owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('context-upgrade-team','Fictional Upgrade Team','context-upgrade-team','context-upgrade-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('context-upgrade-mo','context-upgrade-team','context-upgrade-owner','owner');
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('context-upgrade-admin','Fictional Upgrade Admin','context-upgrade-admin@example.test',true,false);
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('context-upgrade-ma','context-upgrade-team','context-upgrade-admin','recruiter');
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas,plan_access) VALUES
        ('${company}','context-upgrade-admin','admin','{boards,templates}',true);
      INSERT INTO tenant_context.contexts(pid,xid,team_id,actor_id,auth_type,token_id,scopes,expires_at) VALUES
        (1,'1','context-upgrade-team','context-upgrade-owner','session',NULL,'{candidates:read}',now()+interval '1 hour');`);
    await applyMigrations(pg);
    await installTenantContextKey(pg);
  });
  afterAll(async () => pg.close());

  it("adds the derived context columns and keeps the leftover row with nulls and defaults", async () => {
    expect(
      (
        await pg.query(
          "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'tenant_context' AND table_name = 'contexts' AND ordinal_position > 8 ORDER BY ordinal_position",
        )
      ).rows,
    ).toEqual(
      [
        ["workspace_id", "uuid", "YES", null],
        ["member_role", "text", "YES", null],
        ["company_level", "text", "YES", null],
        ["company_areas", "ARRAY", "NO", "'{}'::text[]"],
        ["plan_access", "boolean", "NO", "false"],
        ["role_version_id", "uuid", "YES", null],
        ["record_scope", "jsonb", "YES", null],
        ["home_units", "ARRAY", "YES", null],
      ].map(([column_name, data_type, is_nullable, column_default]) => ({
        column_name,
        data_type,
        is_nullable,
        column_default,
      })),
    );
    expect(
      (
        await pg.query(
          "SELECT pid, xid::text, team_id, actor_id, auth_type, token_id, scopes, workspace_id, member_role, company_level, company_areas, plan_access FROM tenant_context.contexts",
        )
      ).rows,
    ).toEqual([
      {
        ...leftover,
        workspace_id: null,
        member_role: null,
        company_level: null,
        company_areas: [],
        plan_access: false,
      },
    ]);
  });

  it("leaves one install, (text, text, text[]) returning jsonb, and storage schema 8", async () => {
    expect(
      (
        await pg.query(
          "SELECT oidvectortypes(p.proargtypes) AS args, p.prorettype::regtype::text AS returns, p.prosecdef AS definer FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'tenant_context' AND p.proname = 'install'",
        )
      ).rows,
    ).toEqual([
      { args: "text, text, text[]", returns: "jsonb", definer: true },
    ]);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("installs an upgraded member's context with the derived workspace and company authority", async () => {
    const db = drizzle(pg, { schema }) as unknown as AppDb;
    const { access, xid } = await withDeadlinesAndSnapshot(
      db,
      async (tx, snapshot) => ({
        access: await installTenantContext(tx, admin, snapshot),
        xid: snapshot.xid,
      }),
    );
    expect(access).toEqual({
      scopes: admin.scopes,
      workspaceId: company,
      memberRole: "recruiter",
      companyLevel: "admin",
      companyAreas: ["boards", "templates"],
      versions: {},
      documents: {},
      roleVersionId: "00000000-0000-4000-8000-000000000103",
      recordScope: { pipeline: "all", candidates: "all", tasks: "all" },
      homeUnits: [],
      teamArchived: false,
    });
    expect(
      (
        await pg.query(
          "SELECT workspace_id, member_role, company_level, company_areas, plan_access FROM tenant_context.contexts WHERE xid = $1::xid8",
          [xid],
        )
      ).rows,
    ).toEqual([
      {
        workspace_id: company,
        member_role: "recruiter",
        company_level: "admin",
        company_areas: ["boards", "templates"],
        plan_access: true,
      },
    ]);
  });
});

// Teams, members, company authority and activity written by the 0029 schema under a non-superuser
// migration owner, upgraded through 0030: the configuration store starts empty under FORCE RLS, and
// the re-created activity insert policy still takes the authority helper's audit row.
describe("upgrade from 0029 to the configuration store", () => {
  const pg = new PGlite();
  const owner = "config_upgrade_owner";
  const company = "00000000-0000-4000-a000-000000000001";
  const companyOwner = principal(
    "config-upgrade-owner",
    "config-upgrade-team",
    "owner",
  );
  const rows = async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    return Object.fromEntries(
      await Promise.all(
        [
          "app.workspaces",
          "app.workspace_teams",
          "app.workspace_admins",
          "app.activity",
          "auth.member",
        ].map(async (table) => [
          table,
          (await pg.query(`SELECT * FROM ${table} ORDER BY 1, 2`)).rows.map(
            earlierColumns,
          ),
        ]),
      ),
    );
  };
  let before: Awaited<ReturnType<typeof rows>>;

  beforeAll(async () => {
    await pg.exec(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
      DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO ${owner}', current_database()); END $$;
      SET SESSION AUTHORIZATION ${owner};`);
    await applyMigrations(pg, "0029_signed_context_workspace.sql");
    // Fixture rows as the bootstrap superuser, which bypasses RLS; the triggers still run as the owner.
    await pg.exec(`SET SESSION AUTHORIZATION postgres;
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('config-upgrade-owner','Fictional Upgrade Owner','config-upgrade-owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('config-upgrade-team','Fictional Upgrade Team','config-upgrade-team','config-upgrade-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('config-upgrade-mo','config-upgrade-team','config-upgrade-owner','owner');
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin,two_factor_enabled) VALUES
        ('config-upgrade-admin','Fictional Upgrade Admin','config-upgrade-admin@example.test',true,false,true);
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('config-upgrade-ma','config-upgrade-team','config-upgrade-admin','recruiter');
      INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary,metadata) VALUES
        ('config-upgrade-team','config-upgrade-owner','session','workspace_authority.changed','workspace-authority','Fictional earlier change','{}');`);
    before = await rows();
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
    await installTenantContextKey(pg);
  });
  afterAll(async () => pg.close());

  it("keeps every existing row and sets storage schema 9", async () => {
    expect(await rows()).toEqual(before);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("adds the three configuration tables empty, under FORCE RLS", async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    const tables = ["config_layouts", "config_objects", "config_versions"];
    expect(
      (
        await pg.query(
          `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
           FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
           WHERE s.nspname = 'app' AND c.relkind = 'r' AND c.relname LIKE 'config\\_%' ORDER BY c.relname`,
        )
      ).rows,
    ).toEqual(
      tables.map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
        owner,
      })),
    );
    for (const table of tables)
      expect(
        (await pg.query(`SELECT count(*)::int AS n FROM app.${table}`)).rows,
        table,
      ).toEqual([{ n: 0 }]);
  });

  it("still audits a workspace-authority change through the re-created insert policy", async () => {
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    const db = drizzle(pg, { schema }) as unknown as AppDb;
    const changed = await withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
      await installTenantContext(tx, companyOwner, snapshot);
      const result = await tx.execute<{ changed: boolean }>(
        sql`select tenant_context.set_workspace_authority('config-upgrade-admin', 'admin', '{fields}', false) as changed`,
      );
      return result.rows[0].changed;
    });
    expect(changed).toBe(true);
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    expect(
      (
        await pg.query(
          "SELECT team_id, actor_id, action, metadata->'after' AS after FROM app.activity WHERE kind = 'workspace-authority' ORDER BY created_at",
        )
      ).rows,
    ).toEqual([
      {
        team_id: "config-upgrade-team",
        actor_id: "config-upgrade-owner",
        action: "workspace_authority.changed",
        after: null,
      },
      {
        team_id: "config-upgrade-team",
        actor_id: "config-upgrade-owner",
        action: "workspace_authority.changed",
        after: {
          level: "admin",
          areas: ["fields"],
          planAccess: false,
          suspended: false,
        },
      },
    ]);
    expect(
      (
        await pg.query(
          "SELECT level, areas FROM app.workspace_admins WHERE workspace_id = $1 AND user_id = 'config-upgrade-admin'",
          [company],
        )
      ).rows,
    ).toEqual([{ level: "admin", areas: ["fields"] }]);
  });
});

// A team with an owner, a recruiter and a viewer written by the 0030 schema, upgraded through 0031:
// install keeps its one overload and its grants, and only owners and admins reach the new scopes.
describe("upgrade from 0030 to the explicit scope ceilings", () => {
  const pg = new PGlite();
  const grantee = "ceiling_upgrade_runtime";
  const member = (userId: string, role: Role) =>
    principal(userId, "ceiling-upgrade-team", role);
  const owner = member("ceiling-upgrade-owner", "owner");
  const recruiter = member("ceiling-upgrade-recruiter", "recruiter");
  const viewer = member("ceiling-upgrade-viewer", "viewer");
  const overloads = async () =>
    (
      await pg.query(
        "SELECT oidvectortypes(p.proargtypes) AS args, p.prorettype::regtype::text AS returns, p.prosecdef AS definer, p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'tenant_context' AND p.proname = 'install'",
      )
    ).rows;
  let before: Awaited<ReturnType<typeof overloads>>;

  beforeAll(async () => {
    await applyMigrations(pg, "0030_config_store.sql");
    await pg.exec(`CREATE ROLE ${grantee} NOLOGIN;
      GRANT EXECUTE ON FUNCTION tenant_context.install(text, text, text[]) TO ${grantee};
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('ceiling-upgrade-owner','Fictional Upgrade Owner','ceiling-upgrade-owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('ceiling-upgrade-team','Fictional Upgrade Team','ceiling-upgrade-team','ceiling-upgrade-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('ceiling-upgrade-mo','ceiling-upgrade-team','ceiling-upgrade-owner','owner');
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('ceiling-upgrade-recruiter','Fictional Upgrade Recruiter','ceiling-upgrade-recruiter@example.test',true,false),
        ('ceiling-upgrade-viewer','Fictional Upgrade Viewer','ceiling-upgrade-viewer@example.test',true,false);
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('ceiling-upgrade-mr','ceiling-upgrade-team','ceiling-upgrade-recruiter','recruiter'),
        ('ceiling-upgrade-mv','ceiling-upgrade-team','ceiling-upgrade-viewer','viewer');`);
    before = await overloads();
    await applyMigrations(pg);
    await installTenantContextKey(pg);
  });
  afterAll(async () => pg.close());

  it("keeps one install, (text, text, text[]) returning jsonb, with its grants, and sets storage schema 10", async () => {
    expect(before).toEqual([
      expect.objectContaining({
        args: "text, text, text[]",
        returns: "jsonb",
        definer: true,
        acl: expect.stringContaining(`${grantee}=X/`),
      }),
    ]);
    expect(await overloads()).toEqual(before);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("accepts the owner's eleven scopes and rejects plans:read for the recruiter and viewer", async () => {
    const db = drizzle(pg, { schema }) as unknown as AppDb;
    const install = (p: Principal) =>
      withDeadlinesAndSnapshot(db, (tx, snapshot) =>
        installTenantContext(tx, p, snapshot),
      );
    expect(owner.scopes).toHaveLength(11);
    expect(await install(owner)).toMatchObject({
      scopes: owner.scopes,
      memberRole: "owner",
    });
    for (const p of [recruiter, viewer]) {
      expect(await install(p), p.role).toMatchObject({ scopes: p.scopes });
      await expect(
        install({ ...p, scopes: [...p.scopes, "plans:read"] }),
        p.role,
      ).rejects.toMatchObject({ status: 403, code: "tenant_context_denied" });
    }
  });
});

// A team and a published company configuration object written by the 0031 schema, upgraded through
// 0032: install keeps its one overload and its grants, and returns the object's version and body.
describe("upgrade from 0031 to configuration versions through install", () => {
  const pg = new PGlite();
  const grantee = "versions_upgrade_runtime";
  const company = "00000000-0000-4000-a000-000000000001";
  const owner = principal(
    "versions-upgrade-owner",
    "versions-upgrade-team",
    "owner",
  );
  const overloads = async () =>
    (
      await pg.query(
        "SELECT oidvectortypes(p.proargtypes) AS args, p.prorettype::regtype::text AS returns, p.prosecdef AS definer, p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'tenant_context' AND p.proname = 'install'",
      )
    ).rows;
  let before: Awaited<ReturnType<typeof overloads>>;
  let object: string;
  let version: { id: string; sha: string };

  beforeAll(async () => {
    await applyMigrations(pg, "0031_scope_ceilings.sql");
    await pg.exec(`CREATE ROLE ${grantee} NOLOGIN;
      GRANT EXECUTE ON FUNCTION tenant_context.install(text, text, text[]) TO ${grantee};
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('versions-upgrade-owner','Fictional Upgrade Owner','versions-upgrade-owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('versions-upgrade-team','Fictional Upgrade Team','versions-upgrade-team','versions-upgrade-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('versions-upgrade-mo','versions-upgrade-team','versions-upgrade-owner','owner');`);
    object = (
      await pg.query<{ id: string }>(
        `INSERT INTO app.config_objects(workspace_id,type,key) VALUES ('${company}','workflow','upgrade-workflow') RETURNING id`,
      )
    ).rows[0].id;
    version = (
      await pg.query<{ id: string; sha: string }>(
        `INSERT INTO app.config_versions(object_id,workspace_id,state,number,body,published_at) VALUES ('${object}','${company}','published',1,'{"label":"Fictional upgrade workflow"}',now()) RETURNING id, body_sha256 AS sha`,
      )
    ).rows[0];
    await pg.exec(
      `UPDATE app.config_objects SET current_version_id = '${version.id}' WHERE id = '${object}'`,
    );
    before = await overloads();
    await applyMigrations(pg);
    await installTenantContextKey(pg);
  });
  afterAll(async () => pg.close());

  it("keeps one install, (text, text, text[]) returning jsonb, with its grants, and sets storage schema 11", async () => {
    expect(before).toEqual([
      expect.objectContaining({
        args: "text, text, text[]",
        returns: "jsonb",
        definer: true,
        acl: expect.stringContaining(`${grantee}=X/`),
      }),
    ]);
    expect(await overloads()).toEqual(before);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("returns the published object in versions and its body in documents", async () => {
    const db = drizzle(pg, { schema }) as unknown as AppDb;
    const access = await withDeadlinesAndSnapshot(db, (tx, snapshot) =>
      installTenantContext(tx, owner, snapshot),
    );
    expect(access).toMatchObject({
      workspaceId: company,
      memberRole: "owner",
      companyLevel: "owner",
      versions: { [object]: version.id },
    });
    expect(access.documents).toEqual({
      [version.id]: {
        versionId: version.id,
        objectId: object,
        type: "workflow",
        key: "upgrade-workflow",
        number: 1,
        bodySha256: version.sha,
        body: { label: "Fictional upgrade workflow" },
      },
    });
  });
});

// A team, a company admin grant and a configuration draft written by the 0032 schema, upgraded
// through 0033: every row stays, the three org tables arrive empty under FORCE RLS, install keeps
// its one overload and grants, and the re-created activity insert policy still takes config and
// workspace-authority audits.
describe("upgrade from 0032 to the organisation hierarchy", () => {
  const pg = new PGlite();
  const owner = "org_upgrade_owner";
  const grantee = "org_upgrade_runtime";
  const company = "00000000-0000-4000-a000-000000000001";
  const companyOwner = principal(
    "org-upgrade-owner",
    "org-upgrade-team",
    "owner",
  );
  const rows = async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    return Object.fromEntries(
      await Promise.all(
        [
          "app.workspaces",
          "app.workspace_teams",
          "app.workspace_admins",
          "app.activity",
          "app.config_objects",
          "app.config_versions",
          "auth.member",
        ].map(async (table) => [
          table,
          (await pg.query(`SELECT * FROM ${table} ORDER BY 1, 2`)).rows.map(
            earlierColumns,
          ),
        ]),
      ),
    );
  };
  const overloads = async () =>
    (
      await pg.query(
        "SELECT oidvectortypes(p.proargtypes) AS args, p.prorettype::regtype::text AS returns, p.prosecdef AS definer, p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'tenant_context' AND p.proname = 'install'",
      )
    ).rows;
  let before: Awaited<ReturnType<typeof rows>>;
  let beforeInstall: Awaited<ReturnType<typeof overloads>>;
  let version: string;

  beforeAll(async () => {
    await pg.exec(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
      DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO ${owner}', current_database()); END $$;
      SET SESSION AUTHORIZATION ${owner};`);
    await applyMigrations(pg, "0032_config_versions_install.sql");
    await pg.exec(`CREATE ROLE ${grantee} NOLOGIN;
      GRANT EXECUTE ON FUNCTION tenant_context.install(text, text, text[]) TO ${grantee};`);
    // Fixture rows as the bootstrap superuser, which bypasses RLS; the triggers still run.
    await pg.exec(`SET SESSION AUTHORIZATION postgres;
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('org-upgrade-owner','Fictional Upgrade Owner','org-upgrade-owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('org-upgrade-team','Fictional Upgrade Team','org-upgrade-team','org-upgrade-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('org-upgrade-mo','org-upgrade-team','org-upgrade-owner','owner');
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin,two_factor_enabled) VALUES
        ('org-upgrade-admin','Fictional Upgrade Admin','org-upgrade-admin@example.test',true,false,true);
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('org-upgrade-ma','org-upgrade-team','org-upgrade-admin','recruiter');
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${company}','org-upgrade-admin','admin','{fields}');
      INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary,metadata) VALUES
        ('org-upgrade-team','org-upgrade-owner','session','workspace_authority.changed','workspace-authority','Fictional earlier change','{}');`);
    const object = (
      await pg.query<{ id: string }>(
        `INSERT INTO app.config_objects(workspace_id,type,key) VALUES ('${company}','workflow','upgrade-workflow') RETURNING id`,
      )
    ).rows[0].id;
    version = (
      await pg.query<{ id: string }>(
        `INSERT INTO app.config_versions(object_id,workspace_id,body) VALUES ('${object}','${company}','{"label":"Fictional upgrade workflow"}') RETURNING id`,
      )
    ).rows[0].id;
    await pg.exec(
      `UPDATE app.config_objects SET draft_version_id = '${version}' WHERE id = '${object}'`,
    );
    before = await rows();
    beforeInstall = await overloads();
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
    await installTenantContextKey(pg);
  });
  afterAll(async () => pg.close());

  it("keeps every existing row and sets storage schema 17", async () => {
    expect(await rows()).toEqual(before);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("adds the three organisation tables empty, under ENABLE and FORCE RLS", async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    const tables = ["org_levels", "org_unit_closure", "org_units"];
    expect(
      (
        await pg.query(
          `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
           FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
           WHERE s.nspname = 'app' AND c.relkind = 'r' AND c.relname LIKE 'org\\_%' ORDER BY c.relname`,
        )
      ).rows,
    ).toEqual(
      tables.map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
        owner,
      })),
    );
    for (const table of tables)
      expect(
        (await pg.query(`SELECT count(*)::int AS n FROM app.${table}`)).rows,
        table,
      ).toEqual([{ n: 0 }]);
  });

  it("keeps one install, (text, text, text[]) returning jsonb, with the same ACL", async () => {
    expect(beforeInstall).toEqual([
      expect.objectContaining({
        args: "text, text, text[]",
        returns: "jsonb",
        definer: true,
        acl: expect.stringContaining(`${grantee}=X/`),
      }),
    ]);
    expect(await overloads()).toEqual(beforeInstall);
  });

  it("still audits a config draft and a workspace-authority change through the re-created insert policy", async () => {
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    const db = drizzle(pg, { schema }) as unknown as AppDb;
    await withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
      await installTenantContext(tx, companyOwner, snapshot);
      await tx.execute(
        sql`select tenant_context.audit_config(${version}::uuid, 'config.draft_created')`,
      );
      await tx.execute(
        sql`select tenant_context.set_workspace_authority('org-upgrade-admin', 'admin', '{fields,organisation}', false)`,
      );
    });
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    expect(
      (
        await pg.query(
          "SELECT team_id, actor_id, kind, action, metadata->'after'->'areas' AS areas FROM app.activity WHERE summary <> 'Fictional earlier change' ORDER BY kind",
        )
      ).rows,
    ).toEqual([
      {
        team_id: "org-upgrade-team",
        actor_id: "org-upgrade-owner",
        kind: "config",
        action: "config.draft_created",
        areas: null,
      },
      {
        team_id: "org-upgrade-team",
        actor_id: "org-upgrade-owner",
        kind: "workspace-authority",
        action: "workspace_authority.changed",
        areas: ["fields", "organisation"],
      },
    ]);
  });
});

// A team, org levels and units with their closure and audit rows written by the 0033 schema,
// upgraded through 0034: every row stays, the three directory tables arrive empty under FORCE RLS,
// the replaced org functions keep their owner and grants and add the read committed check, the org
// audit still inserts through the re-created policy, and a second run changes nothing.
describe("upgrade from 0033 to positions and employees", () => {
  const pg = new PGlite();
  const owner = "directory_upgrade_owner";
  const company = "00000000-0000-4000-a000-000000000001";
  const companyOwner = principal(
    "directory-upgrade-owner",
    "directory-upgrade-team",
    "owner",
  );
  const tables = [
    "app.workspaces",
    "app.workspace_teams",
    "app.workspace_admins",
    "app.activity",
    "app.org_levels",
    "app.org_units",
    "app.org_unit_closure",
    "auth.member",
  ];
  const rows = async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    return Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table,
          (await pg.query(`SELECT * FROM ${table} ORDER BY 1, 2`)).rows.map(
            earlierColumns,
          ),
        ]),
      ),
    );
  };
  const functions = async () =>
    (
      await pg.query<{ proname: string; isolation: boolean }>(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proacl::text AS acl,
           p.proconfig AS config, position('transaction_isolation' in p.prosrc) > 0 AS isolation
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'app' AND p.proname IN ('guard_scope_sources', 'maintain_org_closure', 'guard_org_archive', 'audit_org_change', 'guard_org_row')
         ORDER BY p.proname`,
      )
    ).rows;
  let before: Awaited<ReturnType<typeof rows>>;
  let beforeFunctions: Awaited<ReturnType<typeof functions>>;
  let unit: string;

  beforeAll(async () => {
    await pg.exec(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
      DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO ${owner}', current_database()); END $$;
      SET SESSION AUTHORIZATION ${owner};`);
    await applyMigrations(pg, "0033_org_levels_units.sql");
    await installTenantContextKey(pg);
    // Fixture rows as the bootstrap superuser, which bypasses RLS; the triggers still run.
    await pg.exec(`SET SESSION AUTHORIZATION postgres;
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('directory-upgrade-owner','Fictional Upgrade Owner','directory-upgrade-owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('directory-upgrade-team','Fictional Upgrade Team','directory-upgrade-team','directory-upgrade-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('directory-upgrade-mo','directory-upgrade-team','directory-upgrade-owner','owner');`);
    // Levels and units through the 0033 triggers, under the company owner's context, so closure and
    // audit rows exist before the upgrade.
    const db = drizzle(pg, { schema }) as unknown as AppDb;
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    unit = await withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
      await installTenantContext(tx, companyOwner, snapshot);
      const insert = async (statement: ReturnType<typeof sql>) =>
        (await tx.execute<{ id: string }>(statement)).rows[0].id;
      const top = await insert(
        sql`insert into app.org_levels(workspace_id, name, depth) values (${company}::uuid, 'Fictional Upgrade Level', 0) returning id`,
      );
      const lower = await insert(
        sql`insert into app.org_levels(workspace_id, name, depth) values (${company}::uuid, 'Fictional Upgrade Section', 1) returning id`,
      );
      const holdings = await insert(
        sql`insert into app.org_units(workspace_id, level_id, name, code) values (${company}::uuid, ${top}::uuid, 'Fictional Upgrade Holdings', 'UP-1') returning id`,
      );
      return insert(
        sql`insert into app.org_units(workspace_id, level_id, parent_id, name, code) values (${company}::uuid, ${lower}::uuid, ${holdings}::uuid, 'Fictional Upgrade Section', 'UP-2') returning id`,
      );
    });
    before = await rows();
    beforeFunctions = await functions();
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
  });
  afterAll(async () => pg.close());

  it("keeps every existing row and sets storage schema 17", async () => {
    expect(before["app.org_unit_closure"]).toHaveLength(3);
    expect(before["app.activity"]).toHaveLength(4);
    expect(await rows()).toEqual(before);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("adds the three directory tables empty, under ENABLE and FORCE RLS", async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    const added = ["employee_positions", "employees", "positions"];
    expect(
      (
        await pg.query(
          `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
           FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
           WHERE s.nspname = 'app' AND c.relkind = 'r' AND c.relname = ANY($1::text[]) ORDER BY c.relname`,
          [added],
        )
      ).rows,
    ).toEqual(
      added.map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
        owner,
      })),
    );
    for (const table of added)
      expect(
        (await pg.query(`SELECT count(*)::int AS n FROM app.${table}`)).rows,
        table,
      ).toEqual([{ n: 0 }]);
  });

  it("replaces the org functions in place with the read committed check, owner and grants kept", async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    const after = await functions();
    expect(after.map((row) => row.proname)).toEqual(
      beforeFunctions.map((row) => row.proname),
    );
    for (const [index, row] of after.entries()) {
      const { isolation, ...kept } = row;
      const { isolation: was, ...earlier } = beforeFunctions[index];
      expect(kept, row.proname).toEqual(earlier);
      expect(was, row.proname).toBe(false);
      expect(isolation, row.proname).toBe(
        [
          "guard_scope_sources",
          "maintain_org_closure",
          "guard_org_archive",
        ].includes(row.proname),
      );
    }
  });

  it("still audits an org change through the re-created insert policy, and a second run changes nothing", async () => {
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    const db = drizzle(pg, { schema }) as unknown as AppDb;
    await withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
      await installTenantContext(tx, companyOwner, snapshot);
      await tx.execute(
        sql`update app.org_units set name = 'Fictional Upgrade Renamed' where id = ${unit}::uuid`,
      );
    });
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    expect(
      (
        await pg.query(
          "SELECT team_id, actor_id, kind, action FROM app.activity WHERE action = 'org.unit_renamed'",
        )
      ).rows,
    ).toEqual([
      {
        team_id: "directory-upgrade-team",
        actor_id: "directory-upgrade-owner",
        kind: "org",
        action: "org.unit_renamed",
      },
    ]);
    const settled = { rows: await rows(), functions: await functions() };
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
    expect({ rows: await rows(), functions: await functions() }).toEqual(
      settled,
    );
  });
});

// A team with members, a published role and its audit rows written by the 0034 schema, upgraded
// through 0035: every row stays, app.member_roles arrives empty under FORCE RLS, install keeps its
// owner, grants and settings and gains the role step, a member without a row keeps the built-in
// template, and a second run changes nothing.
describe("upgrade from 0034 to configured member roles", () => {
  const pg = new PGlite();
  const owner = "member_roles_upgrade_owner";
  const company = "00000000-0000-4000-a000-000000000001";
  const companyOwner = principal(
    "member-roles-upgrade-owner",
    "member-roles-upgrade-team",
    "owner",
  );
  const recruiter = principal(
    "member-roles-upgrade-recruiter",
    "member-roles-upgrade-team",
    "recruiter",
  );
  const tables = [
    "app.workspaces",
    "app.workspace_teams",
    "app.workspace_admins",
    "app.activity",
    "app.config_objects",
    "app.config_versions",
    "auth.member",
  ];
  const rows = async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    return Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table,
          (await pg.query(`SELECT * FROM ${table} ORDER BY 1, 2`)).rows.map(
            earlierColumns,
          ),
        ]),
      ),
    );
  };
  const install = async () =>
    (
      await pg.query<{ source: string }>(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proacl::text AS acl,
           p.proconfig AS config, oidvectortypes(p.proargtypes) AS args, p.prorettype::regtype::text AS returns,
           p.prosrc AS source
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'tenant_context' AND p.proname = 'install'`,
      )
    ).rows;
  let before: Awaited<ReturnType<typeof rows>>;
  let beforeInstall: Awaited<ReturnType<typeof install>>;

  beforeAll(async () => {
    await pg.exec(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
      DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO ${owner}', current_database()); END $$;
      SET SESSION AUTHORIZATION ${owner};`);
    await applyMigrations(pg, "0034_positions_employees.sql");
    await installTenantContextKey(pg);
    await pg.exec(`SET SESSION AUTHORIZATION postgres;
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('member-roles-upgrade-owner','Fictional Upgrade Owner','member-roles-upgrade-owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('member-roles-upgrade-team','Fictional Upgrade Team','member-roles-upgrade-team','member-roles-upgrade-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('member-roles-upgrade-mo','member-roles-upgrade-team','member-roles-upgrade-owner','owner');
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('member-roles-upgrade-recruiter','Fictional Upgrade Recruiter','member-roles-upgrade-recruiter@example.test',true,false);
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('member-roles-upgrade-mr','member-roles-upgrade-team','member-roles-upgrade-recruiter','recruiter');`);
    // A role drafted, published and audited through the 0034 helpers by the company owner.
    const db = drizzle(pg, { schema }) as unknown as AppDb;
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
      await installTenantContext(tx, companyOwner, snapshot);
      const [object] = (
        await tx.execute<{ id: string }>(
          sql`insert into app.config_objects(workspace_id, type, key) values (${company}::uuid, 'role', 'upgrade-role') returning id`,
        )
      ).rows;
      const [version] = (
        await tx.execute<{ id: string }>(
          sql`insert into app.config_versions(object_id, workspace_id, body) values (${object.id}::uuid, ${company}::uuid, '{"name":"Fictional upgrade role"}'::jsonb) returning id`,
        )
      ).rows;
      await tx.execute(
        sql`update app.config_objects set draft_version_id = ${version.id}::uuid where id = ${object.id}::uuid`,
      );
      await tx.execute(
        sql`select tenant_context.audit_config(${version.id}::uuid, 'config.draft_created')`,
      );
      await tx.execute(
        sql`select tenant_context.publish_config_version(${version.id}::uuid)`,
      );
    });
    before = await rows();
    beforeInstall = await install();
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
  });
  afterAll(async () => pg.close());

  it("keeps every existing row and sets storage schema 17", async () => {
    expect(before["app.config_versions"]).toHaveLength(1);
    expect(before["app.activity"]).toHaveLength(2);
    expect(await rows()).toEqual(before);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("adds app.member_roles empty, under ENABLE and FORCE RLS, and the context column", async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    expect(
      (
        await pg.query(
          `SELECT c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
           FROM pg_class c WHERE c.oid = 'app.member_roles'::regclass`,
        )
      ).rows,
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true, owner }]);
    expect(
      (await pg.query("SELECT count(*)::int AS n FROM app.member_roles")).rows,
    ).toEqual([{ n: 0 }]);
    expect(
      (
        await pg.query(
          "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'tenant_context' AND table_name = 'contexts' AND column_name = 'role_version_id'",
        )
      ).rows,
    ).toEqual([{ data_type: "uuid", is_nullable: "YES" }]);
  });

  it("replaces install in place with the same owner, grants and settings, plus the role step", async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    const [after] = await install();
    const { source, ...kept } = after;
    const { source: was, ...earlier } = beforeInstall[0];
    expect(beforeInstall).toHaveLength(1);
    expect(kept).toEqual(earlier);
    expect(was).not.toContain("member_roles");
    expect(source).toContain("app.member_roles");
  });

  it("gives an upgraded member without a row the built-in template, and a second run changes nothing", async () => {
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    const db = drizzle(pg, { schema }) as unknown as AppDb;
    const access = await withDeadlinesAndSnapshot(db, (tx, snapshot) =>
      installTenantContext(tx, recruiter, snapshot),
    );
    expect(access).toMatchObject({
      scopes: recruiter.scopes,
      memberRole: "recruiter",
      roleVersionId: "00000000-0000-4000-8000-000000000103",
    });
    const settled = { rows: await rows(), install: await install() };
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
    expect({ rows: await rows(), install: await install() }).toEqual(settled);
  });
});

// An employee and its audit row written by the 0035 schema, upgraded through 0036: every row stays,
// the employee gains the standard retention class and no left date, app.employee_erasures arrives
// empty under FORCE RLS, the helper is owner-owned with PUBLIC EXECUTE revoked, the two replaced
// functions keep their owner, grants and settings, the re-created insert policy still takes a
// directory audit row, and a second run changes nothing.
describe("upgrade from 0035 to employee erasure", () => {
  const pg = new PGlite();
  const owner = "employee_erasure_upgrade_owner";
  const company = "00000000-0000-4000-a000-000000000001";
  const companyOwner = principal(
    "employee-erasure-upgrade-owner",
    "employee-erasure-upgrade-team",
    "owner",
  );
  const tables = [
    "app.workspaces",
    "app.workspace_teams",
    "app.workspace_admins",
    "app.activity",
    "app.employees",
    "auth.member",
  ];
  const rows = async (): Promise<Record<string, Record<string, unknown>[]>> => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    return Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table,
          (
            await pg.query<Record<string, unknown>>(
              `SELECT * FROM ${table} ORDER BY 1, 2`,
            )
          ).rows,
        ]),
      ),
    );
  };
  const functions = async () =>
    (
      await pg.query<{ proname: string; source: string }>(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proacl::text AS acl,
           p.proconfig AS config, p.prosrc AS source
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'app' AND p.proname IN ('prevent_activity_mutation', 'audit_directory_change')
         ORDER BY p.proname`,
      )
    ).rows;
  let before: Awaited<ReturnType<typeof rows>>;
  let beforeFunctions: Awaited<ReturnType<typeof functions>>;
  const insertEmployee = (number: string) =>
    withDeadlinesAndSnapshot(
      drizzle(pg, { schema }) as unknown as AppDb,
      async (tx, snapshot) => {
        await installTenantContext(tx, companyOwner, snapshot);
        await tx.execute(
          sql`insert into app.employees(workspace_id, display_name, employee_number, work_email) values (${company}::uuid, 'Fictional Upgrade Employee', ${number}, 'upgrade.employee@example.test')`,
        );
      },
    );

  beforeAll(async () => {
    await pg.exec(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
      DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO ${owner}', current_database()); END $$;
      SET SESSION AUTHORIZATION ${owner};`);
    await applyMigrations(pg, "0035_member_roles.sql");
    await installTenantContextKey(pg);
    await pg.exec(`SET SESSION AUTHORIZATION postgres;
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('employee-erasure-upgrade-owner','Fictional Upgrade Owner','employee-erasure-upgrade-owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('employee-erasure-upgrade-team','Fictional Upgrade Team','employee-erasure-upgrade-team','employee-erasure-upgrade-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('employee-erasure-upgrade-mo','employee-erasure-upgrade-team','employee-erasure-upgrade-owner','owner');`);
    // One employee written and audited through the 0035 triggers by the company owner.
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await insertEmployee("UP-EMP-1");
    before = await rows();
    beforeFunctions = await functions();
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
  });
  afterAll(async () => pg.close());

  it("keeps every existing row, gives the employee the standard class and no left date, and sets storage schema 17", async () => {
    expect(before["app.employees"]).toHaveLength(1);
    expect(before["app.activity"]).toHaveLength(1);
    const after = await rows();
    expect({
      ...after,
      "app.workspace_teams": after["app.workspace_teams"].map(earlierColumns),
      "app.activity": after["app.activity"].map(earlierColumns),
      "app.employees": after["app.employees"].map(
        ({ retention_class: _class, left_at: _left, ...kept }) => kept,
      ),
    }).toEqual(before);
    expect(
      after["app.employees"].map(({ retention_class, left_at }) => ({
        retention_class,
        left_at,
      })),
    ).toEqual([{ retention_class: "standard", left_at: null }]);
    expect(
      after["app.activity"].map(
        ({ employee_erasure_id }) => employee_erasure_id,
      ),
    ).toEqual([null]);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("adds app.employee_erasures empty, under ENABLE and FORCE RLS", async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    expect(
      (
        await pg.query(
          `SELECT c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
           FROM pg_class c WHERE c.oid = 'app.employee_erasures'::regclass`,
        )
      ).rows,
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true, owner }]);
    expect(
      (await pg.query("SELECT count(*)::int AS n FROM app.employee_erasures"))
        .rows,
    ).toEqual([{ n: 0 }]);
  });

  it("adds the helper owner-owned, security definer, with the fixed search_path and PUBLIC EXECUTE revoked", async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    expect(
      (
        await pg.query(
          `SELECT pg_get_userbyid(p.proowner) = (SELECT pg_get_userbyid(n.nspowner) FROM pg_namespace n WHERE n.nspname = 'tenant_context') AS owned,
             pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public
           FROM pg_proc p WHERE p.oid = 'tenant_context.erase_employee(uuid,text,text)'::regprocedure`,
        )
      ).rows,
    ).toEqual([
      {
        owned: true,
        owner,
        definer: true,
        config: ["search_path=pg_catalog, pg_temp"],
        public: false,
      },
    ]);
  });

  it("replaces the activity guard and the directory audit in place, with the same owner, grants and settings", async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    const after = await functions();
    expect(after.map((row) => row.proname)).toEqual(
      beforeFunctions.map((row) => row.proname),
    );
    for (const [index, row] of after.entries()) {
      const { source, ...kept } = row;
      const { source: was, ...earlier } = beforeFunctions[index];
      expect(kept, row.proname).toEqual(earlier);
      expect(was, row.proname).not.toContain("employee_erasure");
      expect(source, row.proname).toContain("employee_erasure");
    }
  });

  it("still audits an employee created through the re-created insert policy, and a second run changes nothing", async () => {
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await insertEmployee("UP-EMP-2");
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    expect(
      (
        await pg.query(
          "SELECT team_id, actor_id, kind, action, employee_erasure_id FROM app.activity ORDER BY created_at, id",
        )
      ).rows,
    ).toEqual(
      [1, 2].map(() => ({
        team_id: "employee-erasure-upgrade-team",
        actor_id: "employee-erasure-upgrade-owner",
        kind: "directory",
        action: "directory.employee_created",
        employee_erasure_id: null,
      })),
    );
    const settled = { rows: await rows(), functions: await functions() };
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
    expect({ rows: await rows(), functions: await functions() }).toEqual(
      settled,
    );
  });
});

// Records written by the 0036 schema, upgraded through 0037: no record row is rewritten and the scope
// columns arrive null, app.record_assignments arrives empty under FORCE RLS, the two helpers are
// owner-owned with PUBLIC EXECUTE revoked, and the three replaced functions keep their owner, grants
// and settings.
describe("upgrade from 0036 to record scope", () => {
  const pg = new PGlite();
  const owner = "record_scope_upgrade_owner";
  const team = "record-scope-upgrade-team";
  const records = async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    return (
      await pg.query<Record<string, unknown>>(
        "SELECT * FROM app.records ORDER BY id",
      )
    ).rows;
  };
  const replaced = async () =>
    (
      await pg.query<{ fn: string; source: string }>(
        `SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
           p.proacl::text AS acl, p.proconfig AS config, p.prosrc AS source
         FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`,
        [
          [
            "app.guard_member_role()",
            "tenant_context.erase_employee(uuid,text,text)",
            "tenant_context.install(text,text,text[])",
          ],
        ],
      )
    ).rows;
  let before: Record<string, unknown>[];
  let beforeFunctions: Awaited<ReturnType<typeof replaced>>;

  beforeAll(async () => {
    await pg.exec(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
      DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO ${owner}', current_database()); END $$;
      SET SESSION AUTHORIZATION ${owner};`);
    await applyMigrations(pg, "0036_employee_erasure.sql");
    await pg.exec(`SET SESSION AUTHORIZATION postgres;
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('record-scope-upgrade-owner','Fictional Upgrade Owner','record-scope-upgrade-owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('${team}','Fictional Upgrade Team','${team}','record-scope-upgrade-owner');
      INSERT INTO app.records(id,team_id,kind,data,created_by,candidate_id,vacancy_id,application_id,parent_record_id) VALUES
        ('${ids.candidate}','${team}','candidate','{"name":"Fictional Upgrade Candidate"}','record-scope-upgrade-owner',NULL,NULL,NULL,NULL),
        ('${ids.vacancy}','${team}','vacancy','{"title":"Fictional upgrade vacancy"}','record-scope-upgrade-owner',NULL,NULL,NULL,NULL),
        ('${ids.application}','${team}','application','{"stage":"Sourced"}','record-scope-upgrade-owner','${ids.candidate}','${ids.vacancy}',NULL,NULL),
        ('${ids.interview}','${team}','interview','{"title":"Fictional upgrade interview"}','record-scope-upgrade-owner',NULL,NULL,'${ids.application}',NULL),
        ('${ids.comment}','${team}','comment','{"body":"Fictional upgrade comment"}','record-scope-upgrade-owner',NULL,NULL,NULL,'${ids.vacancy}');`);
    before = await records();
    beforeFunctions = await replaced();
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
  });
  afterAll(async () => pg.close());

  it("rewrites no record row, adds null scope columns and sets storage schema 17", async () => {
    expect(before).toHaveLength(5);
    const after = await records();
    expect(
      after.map(
        ({
          org_unit_id: _unit,
          scope_vacancy_id: _vacancy,
          scope_application_id: _application,
          ...kept
        }) => withoutPins(kept),
      ),
    ).toEqual(before);
    for (const row of after)
      expect([
        row.org_unit_id,
        row.scope_vacancy_id,
        row.scope_application_id,
      ]).toEqual([null, null, null]);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("adds app.record_assignments empty, under ENABLE and FORCE RLS, and the two context columns", async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    expect(
      (
        await pg.query(
          `SELECT c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
           FROM pg_class c WHERE c.oid = 'app.record_assignments'::regclass`,
        )
      ).rows,
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true, owner }]);
    expect(
      (await pg.query("SELECT count(*)::int AS n FROM app.record_assignments"))
        .rows,
    ).toEqual([{ n: 0 }]);
    expect(
      (
        await pg.query(
          "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'tenant_context' AND table_name = 'contexts' AND column_name IN ('record_scope', 'home_units') ORDER BY ordinal_position",
        )
      ).rows,
    ).toEqual([
      { column_name: "record_scope", data_type: "jsonb" },
      { column_name: "home_units", data_type: "ARRAY" },
    ]);
  });

  it("adds the helpers and the trigger function owner-owned, security definer, with the fixed search_path and PUBLIC EXECUTE revoked", async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    expect(
      (
        await pg.query(
          `SELECT p.oid::regprocedure::text AS fn,
             pg_get_userbyid(p.proowner) = (SELECT pg_get_userbyid(n.nspowner) FROM pg_namespace n WHERE n.nspname = 'tenant_context') AS owned,
             p.prosecdef AS definer, p.proconfig AS config,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public
           FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`,
          [
            [
              "tenant_context.add_assignment(uuid,text,text)",
              "tenant_context.remove_assignment(uuid,text,text)",
              "tenant_context.change_assignment(uuid,text,text,boolean)",
              "app.maintain_record_scope()",
            ],
          ],
        )
      ).rows,
    ).toEqual(
      [
        "app.maintain_record_scope()",
        "tenant_context.add_assignment(uuid,text,text)",
        "tenant_context.change_assignment(uuid,text,text,boolean)",
        "tenant_context.remove_assignment(uuid,text,text)",
      ].map((fn) => ({
        fn,
        owned: true,
        definer: true,
        config: ["search_path=pg_catalog, pg_temp"],
        public: false,
      })),
    );
  });

  it("replaces install, the member-role guard and employee erasure in place, with the same owner, grants and settings", async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    const after = await replaced();
    expect(after.map((row) => row.fn)).toEqual(
      beforeFunctions.map((row) => row.fn),
    );
    for (const [index, row] of after.entries()) {
      const { source, ...kept } = row;
      const { source: was, ...earlier } = beforeFunctions[index];
      expect(kept, row.fn).toEqual(earlier);
      expect(source, row.fn).not.toEqual(was);
    }
    const settled = { rows: await records(), functions: await replaced() };
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
    expect({ rows: await records(), functions: await replaced() }).toEqual(
      settled,
    );
  });
});

// Rows written by the 0037 schema, upgraded through 0038: no row of the five tables the new
// restrictive policies limit is rewritten, app.idempotency gains a null role_version_id, and the five
// helpers arrive owner-owned with PUBLIC EXECUTE revoked.
describe("upgrade from 0037 to record scope in row-level security", () => {
  const pg = new PGlite();
  const owner = "record_scope_rls_upgrade_owner";
  const team = "record-scope-rls-upgrade-team";
  const user = "record-scope-rls-upgrade-user";
  const tables = [
    "app.records",
    "app.activity",
    "app.uploads",
    "app.record_assignments",
    "app.idempotency",
  ];
  const rows = async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    const all: Record<string, Record<string, unknown>[]> = {};
    for (const table of tables)
      all[table] = (
        await pg.query<Record<string, unknown>>(
          `SELECT * FROM ${table} ORDER BY 1, 2, 3`,
        )
      ).rows;
    return all;
  };
  const helpers = [
    "tenant_context.scope_is_all()",
    "tenant_context.in_scope(text,text,uuid,uuid,uuid,uuid,uuid,text,uuid,uuid)",
    "tenant_context.record_in_scope(text,uuid)",
    "tenant_context.candidate_in_scope(text,uuid)",
    "tenant_context.context_actor_key()",
  ];
  let before: Awaited<ReturnType<typeof rows>>;
  beforeAll(async () => {
    await pg.exec(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
      DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO ${owner}', current_database()); END $$;
      SET SESSION AUTHORIZATION ${owner};`);
    await applyMigrations(pg, "0037_record_scope.sql");
    // The fixture rows as the 0037 schema held them; ledger triggers are off for the bare upload row.
    await pg.exec(`SET SESSION AUTHORIZATION postgres;
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('${user}','Fictional RLS Upgrade User','${user}@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('${team}','Fictional RLS Upgrade Team','${team}','${user}');
      INSERT INTO app.records(id,team_id,kind,data,created_by,candidate_id,vacancy_id,application_id,parent_record_id) VALUES
        ('${ids.candidate}','${team}','candidate','{"name":"Fictional RLS Upgrade Candidate"}','${user}',NULL,NULL,NULL,NULL),
        ('${ids.vacancy}','${team}','vacancy','{"title":"Fictional RLS upgrade vacancy"}','${user}',NULL,NULL,NULL,NULL),
        ('${ids.application}','${team}','application','{"stage":"Sourced"}','${user}','${ids.candidate}','${ids.vacancy}',NULL,NULL),
        ('${ids.comment}','${team}','comment','{"body":"Fictional RLS upgrade comment"}','${user}',NULL,NULL,NULL,'${ids.vacancy}');
      INSERT INTO app.activity(team_id,record_id,actor_id,actor_type,action,kind,summary) VALUES
        ('${team}','${ids.vacancy}','${user}','session','created','vacancy','Fictional RLS upgrade event'),
        ('${team}',NULL,'${user}','session','config.published','config','Fictional RLS upgrade team event');
      SET session_replication_role = replica;
      INSERT INTO app.uploads(id,team_id,candidate_id,original_name,mime_type,size_bytes,object_key,storage_provider,storage_environment,storage_store,created_by,expires_at) VALUES
        ('${ids.cv}','${team}','${ids.candidate}','fictional-rls-upgrade.pdf','application/pdf',10,'teams/${team}/cvs/fictional','s3','development','fictional-rls-upgrade','${user}',now() + interval '1 hour');
      SET session_replication_role = DEFAULT;
      INSERT INTO app.record_assignments(team_id,record_id,user_id,relation) VALUES
        ('${team}','${ids.vacancy}','${user}','interviewer');
      INSERT INTO app.idempotency(team_id,actor_key,operation,key,payload_hash,response,expires_at) VALUES
        ('${team}','${user}:session:session','create:vacancies','fictional-rls-upgrade','${"0".repeat(64)}','{"id":"${ids.vacancy}"}',now() + interval '1 day'),
        ('${team}','session:${user}','cv-upload:${ids.candidate}','fictional-rls-upgrade-cv','${"1".repeat(64)}','{"uploadId":"${ids.cv}"}',now() + interval '1 day');`);
    before = await rows();
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
  });
  afterAll(async () => pg.close());

  it("rewrites no row, adds a null role_version_id and sets storage schema 17", async () => {
    expect(before["app.records"]).toHaveLength(4);
    const after = await rows();
    const { "app.idempotency": cached, ...kept } = after;
    const { "app.idempotency": cachedBefore, ...keptBefore } = before;
    expect({
      ...kept,
      "app.records": kept["app.records"].map(withoutPins),
    }).toEqual(keptBefore);
    expect(cached.map(({ role_version_id: _version, ...row }) => row)).toEqual(
      cachedBefore,
    );
    expect(cached.map((row) => row.role_version_id)).toEqual([null, null]);
    expect(
      (
        await pg.query(
          "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'idempotency' AND column_name = 'role_version_id'",
        )
      ).rows,
    ).toEqual([
      { data_type: "uuid", is_nullable: "YES", column_default: null },
    ]);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("adds one restrictive policy for all commands on each of the five tables and keeps the permissive ones", async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    expect(
      (
        await pg.query(
          `SELECT c.relname AS table, p.polname AS name, p.polcmd AS command
           FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
           WHERE NOT p.polpermissive ORDER BY 1`,
        )
      ).rows,
    ).toEqual([
      { table: "activity", name: "record_scope", command: "*" },
      { table: "idempotency", name: "actor_only", command: "*" },
      { table: "record_assignments", name: "record_scope", command: "*" },
      // 0049 adds the same policy on the record files it creates.
      { table: "record_files", name: "record_scope", command: "*" },
      { table: "records", name: "record_scope", command: "*" },
      { table: "uploads", name: "record_scope", command: "*" },
    ]);
    expect(
      (
        await pg.query<{ table: string; names: string[] }>(
          `SELECT c.relname AS table, array_agg(p.polname ORDER BY p.polname) AS names
           FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
           WHERE p.polpermissive AND c.relname IN ('records', 'idempotency') GROUP BY 1 ORDER BY 1`,
        )
      ).rows,
    ).toEqual([
      {
        table: "idempotency",
        names: [
          "context_delete",
          "context_insert",
          "context_read",
          "context_update",
          "erasure_owner_select",
          "erasure_owner_update",
        ],
      },
      {
        table: "records",
        names: [
          "context_delete",
          "context_insert",
          "context_read",
          "context_update",
          "erasure_owner_delete",
          "erasure_owner_select",
          "erasure_owner_update",
        ],
      },
    ]);
  });

  it("adds the five helpers owner-owned, security definer and stable, with the fixed search_path and PUBLIC EXECUTE revoked", async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    expect(
      (
        await pg.query(
          `SELECT p.oid::regprocedure::text AS fn,
             pg_get_userbyid(p.proowner) = (SELECT pg_get_userbyid(n.nspowner) FROM pg_namespace n WHERE n.nspname = 'tenant_context') AS owned,
             p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS config,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public
           FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`,
          [helpers],
        )
      ).rows,
    ).toEqual(
      [
        "tenant_context.candidate_in_scope(text,uuid)",
        "tenant_context.context_actor_key()",
        "tenant_context.in_scope(text,text,uuid,uuid,uuid,uuid,uuid,text,uuid,uuid)",
        "tenant_context.record_in_scope(text,uuid)",
        "tenant_context.scope_is_all()",
      ].map((fn) => ({
        fn,
        owned: true,
        definer: true,
        volatility: "s",
        config: ["search_path=pg_catalog, pg_temp"],
        public: false,
      })),
    );
  });

  it("changes nothing when the migrations run again", async () => {
    const settled = await rows();
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
    expect(await rows()).toEqual(settled);
  });
});

// Rows written by the 0038 schema, upgraded through 0039: one partial index on candidates, with no
// row rewritten, the storage schema marker kept at 17 and every record-scope policy and helper as
// 0038 left them.
describe("upgrade from 0038 to the candidate scope index", () => {
  const pg = new PGlite();
  const owner = "candidate_scope_index_upgrade_owner";
  const team = "candidate-scope-index-upgrade-team";
  const user = "candidate-scope-index-upgrade-user";
  const helpers = [
    "tenant_context.scope_is_all()",
    "tenant_context.in_scope(text,text,uuid,uuid,uuid,uuid,uuid,text,uuid,uuid)",
    "tenant_context.record_in_scope(text,uuid)",
    "tenant_context.candidate_in_scope(text,uuid)",
    "tenant_context.context_actor_key()",
  ];
  /** The rows, the restrictive policies and the helpers, read as the PGlite superuser. */
  const state = async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    return {
      records: (await pg.query("SELECT * FROM app.records ORDER BY id")).rows,
      policies: (
        await pg.query(
          `SELECT tablename, policyname, permissive, roles, cmd, qual, with_check FROM pg_policies
           WHERE policyname IN ('record_scope', 'actor_only') AND tablename <> 'record_files' ORDER BY 1, 2`,
        )
      ).rows,
      helpers: (
        await pg.query(
          `SELECT p.oid::regprocedure::text AS fn, pg_get_functiondef(p.oid) AS definition,
             pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.provolatile AS volatility,
             p.proconfig AS config, p.proacl::text AS acl, has_function_privilege('public', p.oid, 'EXECUTE') AS public
           FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`,
          [helpers],
        )
      ).rows,
      marker: (await pg.query("SELECT version FROM db_boundary.storage_schema"))
        .rows,
    };
  };
  let before: Awaited<ReturnType<typeof state>>;
  beforeAll(async () => {
    await pg.exec(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
      DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO ${owner}', current_database()); END $$;
      SET SESSION AUTHORIZATION ${owner};`);
    await applyMigrations(pg, "0038_record_scope_rls.sql");
    await pg.exec(`SET SESSION AUTHORIZATION postgres;
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('${user}','Fictional Index Upgrade User','${user}@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('${team}','Fictional Index Upgrade Team','${team}','${user}');
      INSERT INTO app.records(id,team_id,kind,data,created_by,candidate_id,vacancy_id) VALUES
        ('${ids.candidate}','${team}','candidate','{"name":"Fictional Index Upgrade Candidate"}','${user}',NULL,NULL),
        ('${ids.vacancy}','${team}','vacancy','{"title":"Fictional index upgrade vacancy"}','${user}',NULL,NULL),
        ('${ids.application}','${team}','application','{"stage":"Sourced"}','${user}','${ids.candidate}','${ids.vacancy}');`);
    before = await state();
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
  });
  afterAll(async () => pg.close());

  it("adds the partial candidate index and nothing else", async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    expect(
      (
        await pg.query(
          "SELECT indexdef FROM pg_indexes WHERE schemaname = 'app' AND indexname = 'records_candidate_id_idx'",
        )
      ).rows,
    ).toEqual([
      {
        indexdef:
          "CREATE INDEX records_candidate_id_idx ON app.records USING btree (team_id, id) WHERE (kind = 'candidate'::text)",
      },
    ]);
    const after = await state();
    expect(before.records).toHaveLength(3);
    expect({
      ...after,
      records: after.records.map(withoutPins),
      marker: before.marker,
    }).toEqual(before);
    expect(after.marker).toEqual([{ version: 28 }]);
    expect(after.policies).toHaveLength(5);
    expect(after.helpers).toHaveLength(5);
  });

  it("changes nothing when the migrations run again", async () => {
    const settled = await state();
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    await applyMigrations(pg);
    expect(await state()).toEqual(settled);
  });
});

// A populated fictional baseline written by the 0039 schema with fixed ids and times, upgraded
// through every later migration: no row is rewritten, both pins arrive null, the marker goes to 28, a
// second run of 0040 changes nothing, and every REST list and get body is byte for byte the golden
// file main's code wrote from the same baseline before any later migration existed.
describe("upgrade from 0039 to record pins", () => {
  const pg = new PGlite();
  const owner = "record_pins_upgrade_owner";
  const team = "record-pins-upgrade-team";
  const teamOwner = principal("record-pins-upgrade-owner", team, "owner");
  const viewOwner = principal(
    "record-pins-upgrade-recruiter",
    team,
    "recruiter",
  );
  const golden = join(
    process.cwd(),
    "tests",
    "fixtures",
    "record-pins-rest-baseline.json",
  );
  const pins = Object.fromEntries(
    [
      "jobRole",
      "archivedJobRole",
      "vacancy",
      "candidate",
      "otherCandidate",
      "application",
      "interview",
      "offer",
      "onboarding",
      "checklist",
      "bucket",
      "taskField",
      "task",
      "view",
      "comment",
    ].map((name, index) => [
      name,
      `00000000-0000-4000-8000-0000000670${String(index + 1).padStart(2, "0")}`,
    ]),
  ) as Record<string, string>;
  const baseline: {
    id: string;
    kind: RecordKind;
    data: object;
    refs?: Partial<
      Record<
        | "candidate"
        | "vacancy"
        | "application"
        | "onboarding"
        | "bucket"
        | "jobRole"
        | "parent",
        string
      >
    >;
    archived?: boolean;
    privateOwner?: string;
  }[] = [
    {
      id: pins.jobRole,
      kind: "job-role",
      data: { title: "Fictional Data Analyst", department: "Analytics" },
    },
    {
      id: pins.archivedJobRole,
      kind: "job-role",
      data: { title: "Fictional Archived Role" },
      archived: true,
    },
    {
      id: pins.vacancy,
      kind: "vacancy",
      data: {
        title: "Fictional Data Analyst",
        requisitionId: "PIN-001",
        status: "Open",
      },
      refs: { jobRole: pins.jobRole },
    },
    {
      id: pins.candidate,
      kind: "candidate",
      data: {
        name: "Fictional Pin Candidate",
        email: "pin-candidate@example.test",
        skills: ["SQL"],
        reviewStatus: "Reviewed",
      },
    },
    {
      id: pins.otherCandidate,
      kind: "candidate",
      data: { name: "Fictional Second Pin Candidate" },
    },
    {
      id: pins.application,
      kind: "application",
      data: { stage: "Interview", source: "Referral" },
      refs: { candidate: pins.candidate, vacancy: pins.vacancy },
    },
    {
      id: pins.interview,
      kind: "interview",
      data: {
        title: "Fictional pin interview",
        startAt: "2026-03-02T09:00:00.000Z",
        minutes: 45,
      },
      refs: { application: pins.application },
    },
    {
      id: pins.offer,
      kind: "offer",
      data: {
        title: "Fictional pin offer",
        amount: "18000.00",
        currency: "AED",
        status: "Draft",
      },
      refs: { application: pins.application },
    },
    {
      id: pins.onboarding,
      kind: "onboarding",
      data: { status: "Planned", startDate: "2026-04-01" },
      refs: { application: pins.application },
    },
    {
      id: pins.checklist,
      kind: "checklist",
      data: { title: "Fictional laptop setup", category: "Orientation" },
      refs: { onboarding: pins.onboarding },
    },
    {
      id: pins.bucket,
      kind: "bucket",
      data: { name: "Fictional pin follow-ups", position: 0 },
    },
    {
      id: pins.taskField,
      kind: "task-field",
      data: { name: "Fictional reference", type: "Text", position: 0 },
    },
    {
      id: pins.task,
      kind: "task",
      data: {
        title: "Fictional pin follow-up",
        priority: "High",
        customValues: { [pins.taskField]: "Fictional reference 42" },
      },
      refs: { bucket: pins.bucket, parent: pins.vacancy },
    },
    {
      id: pins.view,
      kind: "saved-view",
      data: {
        name: "Fictional private pin view",
        area: "directory",
        query: { search: "Fictional" },
      },
      privateOwner: viewOwner.userId,
    },
    {
      id: pins.comment,
      kind: "comment",
      data: { body: "Fictional pin comment" },
      refs: { parent: pins.candidate },
    },
  ];
  /** Every row of the three tables, read as the PGlite superuser. */
  const rows = async () => {
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    const all: Record<string, Record<string, unknown>[]> = {};
    for (const [table, order] of [
      ["app.records", "id"],
      ["app.candidate_states", "candidate_id, user_id"],
      ["app.activity", "id"],
    ])
      all[table] = (
        await pg.query<Record<string, unknown>>(
          `SELECT * FROM ${table} ORDER BY ${order}`,
        )
      ).rows;
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
    return all;
  };
  /** The REST bodies: each resource's default list and each baseline row's get. */
  const responses = async () => {
    const lists: Record<string, unknown> = {};
    for (const resource of Object.keys(resourceToKind) as ResourceName[])
      lists[resource] = await listRecords(
        resource === "views" ? viewOwner : teamOwner,
        resource,
        new URLSearchParams(),
      );
    const gets: Record<string, unknown> = {};
    for (const row of baseline) {
      const resource = kindToResource[row.kind];
      gets[`${resource}/${row.id}`] = {
        data: await getRecord(
          row.privateOwner ? viewOwner : teamOwner,
          resource,
          row.id,
        ),
      };
    }
    return { lists, gets };
  };
  let before: Awaited<ReturnType<typeof rows>>;

  beforeAll(async () => {
    await pg.exec(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
      DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO ${owner}', current_database()); END $$;
      SET SESSION AUTHORIZATION ${owner};`);
    await applyMigrations(pg, "0039_candidate_scope_index.sql");
    await pg.exec(`SET SESSION AUTHORIZATION postgres;
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('${teamOwner.userId}','Fictional Pin Owner','${teamOwner.userId}@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('${team}','Fictional Pin Team','${team}','${teamOwner.userId}');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('record-pins-upgrade-mo','${team}','${teamOwner.userId}','owner');
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('${viewOwner.userId}','Fictional Pin Recruiter','${viewOwner.userId}@example.test',true,false);
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('record-pins-upgrade-mr','${team}','${viewOwner.userId}','recruiter');`);
    // One row a minute from 09:00 on 1 January 2026, in baseline order.
    for (const [index, row] of baseline.entries()) {
      const refs = row.refs ?? {};
      await pg.query(
        `INSERT INTO app.records(id,team_id,kind,data,created_by,private_owner_id,created_at,updated_at,archived_at,candidate_id,vacancy_id,application_id,onboarding_id,bucket_id,job_role_id,parent_record_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          row.id,
          team,
          row.kind,
          JSON.stringify(row.data),
          teamOwner.userId,
          row.privateOwner ?? null,
          new Date(Date.UTC(2026, 0, 1, 9, index)).toISOString(),
          row.archived ? "2026-01-05T12:00:00.000Z" : null,
          refs.candidate ?? null,
          refs.vacancy ?? null,
          refs.application ?? null,
          refs.onboarding ?? null,
          refs.bucket ?? null,
          refs.jobRole ?? null,
          refs.parent ?? null,
        ],
      );
    }
    await pg.query(
      `INSERT INTO app.candidate_states(team_id,user_id,candidate_id,status,note,updated_at) VALUES($1,$2,$3,'Contacted','Fictional private pin note','2026-01-02T08:00:00Z')`,
      [team, viewOwner.userId, pins.candidate],
    );
    await pg.query(
      `INSERT INTO app.activity(id,team_id,record_id,actor_id,actor_type,action,kind,summary,metadata,created_at) VALUES
        ('00000000-0000-4000-8000-000000067101',$1,$2,$5,'session','created','candidate','Created candidate','{}','2026-01-01T09:03:00Z'),
        ('00000000-0000-4000-8000-000000067102',$1,$3,$5,'session','created','offer','Created offer','{"fromStatus":null,"toStatus":"Draft"}','2026-01-01T09:07:00Z'),
        ('00000000-0000-4000-8000-000000067103',$1,$4,$5,'session','created','comment','Created comment','{}','2026-01-01T09:14:00Z')`,
      [team, pins.candidate, pins.offer, pins.comment, teamOwner.userId],
    );
    before = await rows();
    await applyMigrations(pg);
    await installTenantContextKey(pg);
    setDbForTests(drizzle(pg, { schema }) as unknown as AppDb);
  });
  afterAll(async () => pg.close());

  it("keeps every record, private state and audit row unchanged", async () => {
    expect(before["app.records"]).toHaveLength(15);
    expect(new Set(before["app.records"].map((row) => row.kind)).size).toBe(13);
    expect(before["app.candidate_states"]).toHaveLength(1);
    expect(before["app.activity"]).toHaveLength(3);
    const after = await rows();
    expect({
      ...after,
      "app.records": after["app.records"].map(withoutPins),
    }).toEqual(before);
    for (const row of after["app.records"])
      expect([row.schema_version_id, row.type_id]).toEqual([null, null]);
    await pg.exec("SET SESSION AUTHORIZATION postgres");
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
    expect(
      (
        await pg.query(
          "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'records' AND column_name IN ('schema_version_id', 'type_id') ORDER BY ordinal_position",
        )
      ).rows,
    ).toEqual(
      ["schema_version_id", "type_id"].map((column_name) => ({
        column_name,
        data_type: "uuid",
        is_nullable: "YES",
        column_default: null,
      })),
    );
    await pg.exec(`SET SESSION AUTHORIZATION ${owner}`);
  });

  it("changes nothing when 0040 runs a second time", async () => {
    const settled = await rows();
    await pg.exec(
      await readFile(
        join(process.cwd(), "drizzle", "0040_record_pins.sql"),
        "utf8",
      ),
    );
    expect(await rows()).toEqual(settled);
    // Run alone, 0040 sets its own marker again; 0041 to 0050 have moved it on since.
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 18 }]);
    await pg.exec("UPDATE db_boundary.storage_schema SET version = 28");
  });

  it("answers every REST list and get byte for byte as before the upgrade", async () => {
    const expected = JSON.parse(await readFile(golden, "utf8")) as Awaited<
      ReturnType<typeof responses>
    >;
    const actual = await responses();
    expect(Object.keys(actual.lists)).toEqual(Object.keys(expected.lists));
    expect(Object.keys(actual.gets)).toEqual(Object.keys(expected.gets));
    for (const [name, body] of Object.entries(actual.lists))
      expect(JSON.stringify(body), name).toBe(
        JSON.stringify(expected.lists[name]),
      );
    for (const [name, body] of Object.entries(actual.gets))
      expect(JSON.stringify(body), name).toBe(
        JSON.stringify(expected.gets[name]),
      );
  });
});

// A company admin written by the 0041 schema with every earlier area, upgraded through 0042: the row
// stays valid and unchanged, the company owner's session then grants people through
// set_workspace_authority with one audited change, and the marker goes to 28.
describe("upgrade from 0041 to the people area", () => {
  const pg = new PGlite();
  const company = "00000000-0000-4000-a000-000000000001";
  const owner = principal(
    "people-upgrade-owner",
    "people-upgrade-team",
    "owner",
  );
  const admins = () =>
    pg.query(
      "SELECT workspace_id, user_id, level, areas, plan_access, granted_by, granted_at, suspended_at FROM app.workspace_admins ORDER BY user_id",
    );

  let before: unknown[];
  beforeAll(async () => {
    await applyMigrations(pg, "0041_workspace_team_list.sql");
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('people-upgrade-owner','Fictional Upgrade Owner','people-upgrade-owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('people-upgrade-team','Fictional Upgrade Team','people-upgrade-team','people-upgrade-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('people-upgrade-mo','people-upgrade-team','people-upgrade-owner','owner');
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin,two_factor_enabled) VALUES
        ('people-upgrade-admin','Fictional Upgrade Admin','people-upgrade-admin@example.test',true,false,true);
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('people-upgrade-ma','people-upgrade-team','people-upgrade-admin','recruiter');
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas,plan_access) VALUES
        ('${company}','people-upgrade-admin','admin','{fields,workflows,boards,organisation,templates}',true);`);
    before = (await admins()).rows;
    await applyMigrations(pg);
    await installTenantContextKey(pg);
  });
  afterAll(async () => pg.close());

  it("keeps the existing company admin row and sets storage schema 26", async () => {
    expect((await admins()).rows).toEqual(before);
    expect(before).toHaveLength(2);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("grants people to the existing admin, audited once, and refuses it twice", async () => {
    const db = drizzle(pg, { schema }) as unknown as AppDb;
    const grant = (areas: string[]) =>
      withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
        await installTenantContext(tx, owner, snapshot);
        return (
          await tx.execute<{ changed: boolean }>(
            sql`SELECT tenant_context.set_workspace_authority('people-upgrade-admin', 'admin', ${sql.param(areas)}::text[], true) AS changed`,
          )
        ).rows[0].changed;
      });
    await expect(
      grant([
        "fields",
        "workflows",
        "boards",
        "organisation",
        "templates",
        "people",
      ]),
    ).resolves.toBe(true);
    await expect(grant(["people", "people"])).rejects.toMatchObject({
      cause: { code: "22023" },
    });
    expect(
      (
        await pg.query(
          "SELECT areas FROM app.workspace_admins WHERE user_id = 'people-upgrade-admin'",
        )
      ).rows,
    ).toEqual([
      {
        areas: [
          "boards",
          "fields",
          "organisation",
          "people",
          "templates",
          "workflows",
        ],
      },
    ]);
    expect(
      (
        await pg.query(
          "SELECT metadata->'before'->'areas' AS before, metadata->'after'->'areas' AS after FROM app.activity WHERE action = 'workspace_authority.changed'",
        )
      ).rows,
    ).toEqual([
      {
        before: ["fields", "workflows", "boards", "organisation", "templates"],
        after: [
          "boards",
          "fields",
          "organisation",
          "people",
          "templates",
          "workflows",
        ],
      },
    ]);
  });
});

// A company owner and a company admin with people and Plan & pay access, both without two-step,
// written by the 0042 schema and upgraded through 0043: no row is removed or rewritten, the marker
// goes to 28, and a later grant of a level to either of them is refused with RQ017, writing nothing.
describe("upgrade from 0042 to two-step sign-in for company authority", () => {
  const pg = new PGlite();
  const company = "00000000-0000-4000-a000-000000000001";
  const owner = principal(
    "two-step-upgrade-owner",
    "two-step-upgrade-team",
    "owner",
  );
  const rows = async () => ({
    admins: (
      await pg.query("SELECT * FROM app.workspace_admins ORDER BY user_id")
    ).rows,
    users: (
      await pg.query(
        `SELECT id, two_factor_enabled FROM auth."user" ORDER BY id`,
      )
    ).rows,
    activity: (
      await pg.query(`SELECT ${activityColumns} FROM app.activity ORDER BY id`)
    ).rows,
  });
  const grant = (target: string, level: string, areas: string[]) =>
    withDeadlinesAndSnapshot(
      drizzle(pg, { schema }) as unknown as AppDb,
      async (tx, snapshot) => {
        await installTenantContext(tx, owner, snapshot);
        return tx.execute(
          sql`SELECT tenant_context.set_workspace_authority(${target}, ${level}, ${sql.param(areas)}::text[], true)`,
        );
      },
    );

  let before: Awaited<ReturnType<typeof rows>>;
  beforeAll(async () => {
    await applyMigrations(pg, "0042_workspace_people.sql");
    // The initial administrator's first team makes them company owner; the admin row is the owner's.
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('two-step-upgrade-owner','Fictional Upgrade Owner','two-step-upgrade-owner@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('two-step-upgrade-team','Fictional Upgrade Team','two-step-upgrade-team','two-step-upgrade-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('two-step-upgrade-mo','two-step-upgrade-team','two-step-upgrade-owner','owner');
      UPDATE app.workspace_admins SET plan_access = true WHERE user_id = 'two-step-upgrade-owner';
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('two-step-upgrade-admin','Fictional Upgrade Admin','two-step-upgrade-admin@example.test',true,false);
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('two-step-upgrade-ma','two-step-upgrade-team','two-step-upgrade-admin','recruiter');
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas,plan_access,granted_by) VALUES
        ('${company}','two-step-upgrade-admin','admin','{fields,people}',true,'two-step-upgrade-owner');`);
    before = await rows();
    await applyMigrations(pg);
    await installTenantContextKey(pg);
  });
  afterAll(async () => pg.close());

  it("keeps both holders without two-step in every column and sets storage schema 26", async () => {
    expect(await rows()).toEqual(before);
    expect(before.admins).toEqual([
      expect.objectContaining({
        user_id: "two-step-upgrade-admin",
        level: "admin",
        areas: ["fields", "people"],
        plan_access: true,
        suspended_at: null,
      }),
      expect.objectContaining({
        user_id: "two-step-upgrade-owner",
        level: "owner",
        plan_access: true,
        suspended_at: null,
      }),
    ]);
    expect(before.users).toEqual([
      { id: "two-step-upgrade-admin", two_factor_enabled: false },
      { id: "two-step-upgrade-owner", two_factor_enabled: false },
    ]);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("refuses a later grant to either of them with RQ017 and writes nothing", async () => {
    for (const [target, level, areas] of [
      ["two-step-upgrade-admin", "admin", ["people"]],
      ["two-step-upgrade-admin", "admin", ["fields", "people"]],
      ["two-step-upgrade-owner", "owner", []],
    ] as const) {
      await expect(
        grant(target, level, [...areas]),
        target,
      ).rejects.toMatchObject({ cause: { code: "RQ017" } });
      expect(await rows()).toEqual(before);
    }
  });
});

// Two fictional teams and an activity row written by the 0043 schema, upgraded through 0044: every
// team reads as not archived, the workspace team list returns archived false, install returns
// teamArchived false with the scopes it stored before, no row is rewritten and the marker goes from
// 21 to 28 (0045 to 0050 move it on from 22).
describe("upgrade from 0043 to team archive", () => {
  const pg = new PGlite();
  const owner = principal(
    "archive-upgrade-owner",
    "archive-upgrade-team",
    "owner",
  );
  const rows = async () => ({
    teams: (
      await pg.query(
        "SELECT team_id, workspace_id FROM app.workspace_teams ORDER BY team_id",
      )
    ).rows,
    activity: (
      await pg.query(`SELECT ${activityColumns} FROM app.activity ORDER BY id`)
    ).rows,
  });
  const inContext = <T>(work: (tx: TeamTx) => Promise<T>) =>
    withDeadlinesAndSnapshot(
      drizzle(pg, { schema }) as unknown as AppDb,
      async (tx, snapshot) => {
        const access = await installTenantContext(tx, owner, snapshot);
        return { access, result: await work(tx) };
      },
    );

  let before: Awaited<ReturnType<typeof rows>>;
  let marker: unknown[];
  beforeAll(async () => {
    await applyMigrations(pg, "0043_company_authority_two_step.sql");
    // The initial administrator's first team makes them company owner.
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin,two_factor_enabled) VALUES
        ('archive-upgrade-owner','Fictional Upgrade Owner','archive-upgrade-owner@example.test',true,true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('archive-upgrade-team','Fictional Upgrade Team','archive-upgrade-team','archive-upgrade-owner'),
        ('archive-upgrade-other','Fictional Other Team','archive-upgrade-other','archive-upgrade-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('archive-upgrade-mo','archive-upgrade-team','archive-upgrade-owner','owner');
      INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary,metadata) VALUES
        ('archive-upgrade-team','archive-upgrade-owner','session','record.created','record','Fictional event','{}');`);
    before = await rows();
    marker = (await pg.query("SELECT version FROM db_boundary.storage_schema"))
      .rows;
    await applyMigrations(pg);
    await installTenantContextKey(pg);
  });
  afterAll(async () => pg.close());

  it("reads every existing team as not archived, rewrites no row and moves the marker from 21 to 28", async () => {
    expect(marker).toEqual([{ version: 21 }]);
    expect(await rows()).toEqual(before);
    expect(before.teams).toHaveLength(2);
    expect(
      (
        await pg.query(
          "SELECT team_id, archived_at, archived_by FROM app.workspace_teams ORDER BY team_id",
        )
      ).rows,
    ).toEqual([
      {
        team_id: "archive-upgrade-other",
        archived_at: null,
        archived_by: null,
      },
      { team_id: "archive-upgrade-team", archived_at: null, archived_by: null },
    ]);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("returns archived false from the workspace team list and teamArchived false from install", async () => {
    const { access, result } = await inContext(
      async (tx) =>
        (
          await tx.execute<{ id: string; archived: boolean }>(
            sql`select id, archived from tenant_context.workspace_team_list()`,
          )
        ).rows,
    );
    expect(result).toEqual([
      { id: "archive-upgrade-other", archived: false },
      { id: "archive-upgrade-team", archived: false },
    ]);
    expect(access.teamArchived).toBe(false);
    expect(access.scopes).toEqual(roleScopes("owner"));
  });
});

// A position, and a published company configuration object, written by the 0044 schema, upgraded
// through 0045: the position keeps every column and gains a null job title key, no configuration row
// is rewritten, and the marker goes from 22 to 28 (0046 to 0050 move it on from 23).
describe("upgrade from 0044 to the job architecture", () => {
  const pg = new PGlite();
  const company = "00000000-0000-4000-a000-000000000001";
  const rows = async () => ({
    positions: (await pg.query("SELECT * FROM app.positions ORDER BY id")).rows,
    objects: (await pg.query("SELECT * FROM app.config_objects ORDER BY id"))
      .rows,
    versions: (await pg.query("SELECT * FROM app.config_versions ORDER BY id"))
      .rows,
    activity: (
      await pg.query(`SELECT ${activityColumns} FROM app.activity ORDER BY id`)
    ).rows,
  });

  let before: Awaited<ReturnType<typeof rows>>;
  let marker: unknown[];
  beforeAll(async () => {
    await applyMigrations(pg, "0044_team_archive.sql");
    // The initial administrator's first team makes them company owner.
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin,two_factor_enabled) VALUES
        ('titles-upgrade-owner','Fictional Upgrade Owner','titles-upgrade-owner@example.test',true,true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('titles-upgrade-team','Fictional Upgrade Team','titles-upgrade-team','titles-upgrade-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('titles-upgrade-mo','titles-upgrade-team','titles-upgrade-owner','owner');
      INSERT INTO app.org_levels(id,workspace_id,name,depth) VALUES
        ('00000000-0000-4000-a000-0000000000c1','${company}','Fictional level',0);
      INSERT INTO app.org_units(id,workspace_id,level_id,name,code) VALUES
        ('00000000-0000-4000-a000-0000000000c2','${company}','00000000-0000-4000-a000-0000000000c1','Fictional Holdings','UP-HOLD');
      INSERT INTO app.positions(workspace_id,org_unit_id,title,code,is_manager) VALUES
        ('${company}','00000000-0000-4000-a000-0000000000c2','Fictional Payroll Lead','UP-PAY-1',true);
      INSERT INTO app.config_objects(id,workspace_id,type,key) VALUES
        ('00000000-0000-4000-a000-0000000000c3','${company}','workflow','upgrade-workflow');
      INSERT INTO app.config_versions(id,object_id,workspace_id,state,number,body,published_at) VALUES
        ('00000000-0000-4000-a000-0000000000c4','00000000-0000-4000-a000-0000000000c3','${company}','published',1,'{"label":"Fictional upgrade workflow"}',now());
      UPDATE app.config_objects SET current_version_id = '00000000-0000-4000-a000-0000000000c4'
        WHERE id = '00000000-0000-4000-a000-0000000000c3';`);
    before = await rows();
    marker = (await pg.query("SELECT version FROM db_boundary.storage_schema"))
      .rows;
    await applyMigrations(pg);
  });
  afterAll(async () => pg.close());

  it("gives every existing position a null job title key, rewrites no row and moves the marker from 22 to 28", async () => {
    expect(marker).toEqual([{ version: 22 }]);
    const after = await rows();
    expect(before.positions).toHaveLength(1);
    expect(after.positions).toEqual(
      before.positions.map((row) => ({
        ...(row as Record<string, unknown>),
        job_title_key: null,
      })),
    );
    expect(after.objects).toEqual(before.objects);
    expect(after.versions).toEqual(before.versions);
    expect(before.versions).toHaveLength(1);
    expect(after.activity).toEqual(before.activity);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("takes the job-architecture type and refuses a job title key that is not a configuration key", async () => {
    await pg.exec(
      `INSERT INTO app.config_objects(workspace_id,type,key) VALUES ('${company}','job-architecture','company')`,
    );
    await expect(
      pg.exec("UPDATE app.positions SET job_title_key = 'Payroll Lead'"),
    ).rejects.toMatchObject({ code: "23514" });
    await pg.exec("UPDATE app.positions SET job_title_key = 'payroll-lead'");
    await expect(
      pg.exec(
        `INSERT INTO app.config_objects(workspace_id,type,key) VALUES ('${company}','pay-bracket','company')`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

// A company written by the 0045 schema, upgraded through 0046: no row changes, the marker goes from
// 23 to 28 (0047 to 0050 move it on from 24), the new helper is owner-run and closed to PUBLIC, and
// the company owner's session then reads one person through it, with the company authority change the
// owner made to them before the upgrade among their events.
describe("upgrade from 0045 to the workspace person helper", () => {
  const pg = new PGlite();
  const owner = principal(
    "person-upgrade-owner",
    "person-upgrade-team",
    "owner",
  );
  const rows = async () => ({
    admins: (
      await pg.query(
        "SELECT workspace_id, user_id, level, areas, plan_access, granted_by, granted_at, suspended_at FROM app.workspace_admins ORDER BY user_id",
      )
    ).rows,
    members: (
      await pg.query(
        "SELECT id, organization_id, user_id, role FROM auth.member ORDER BY id",
      )
    ).rows,
    activity: (
      await pg.query(`SELECT ${activityColumns} FROM app.activity ORDER BY id`)
    ).rows,
  });
  const helper = (target: string) =>
    withDeadlinesAndSnapshot(
      drizzle(pg, { schema }) as unknown as AppDb,
      async (tx, snapshot) => {
        await installTenantContext(tx, owner, snapshot);
        return (
          await tx.execute<Record<string, unknown>>(
            sql`SELECT * FROM tenant_context.workspace_person(${target})`,
          )
        ).rows;
      },
    );

  let before: Awaited<ReturnType<typeof rows>>;
  let marker: unknown[];
  beforeAll(async () => {
    await applyMigrations(pg, "0045_job_architecture.sql");
    // The initial administrator's first team makes them company owner; since 0043 a company level
    // goes only to someone with two-step sign-in.
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin,two_factor_enabled) VALUES
        ('person-upgrade-owner','Fictional Upgrade Owner','person-upgrade-owner@example.test',true,true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('person-upgrade-team','Fictional Upgrade Team','person-upgrade-team','person-upgrade-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('person-upgrade-mo','person-upgrade-team','person-upgrade-owner','owner');
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin,two_factor_enabled) VALUES
        ('person-upgrade-admin','Fictional Upgrade Admin','person-upgrade-admin@example.test',true,false,true);
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('person-upgrade-ma','person-upgrade-team','person-upgrade-admin','recruiter');`);
    await installTenantContextKey(pg);
    const db = drizzle(pg, { schema }) as unknown as AppDb;
    await withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
      await installTenantContext(tx, owner, snapshot);
      await tx.execute(
        sql`SELECT tenant_context.set_workspace_authority('person-upgrade-admin', 'admin', ARRAY['people']::text[], false)`,
      );
    });
    before = await rows();
    marker = (await pg.query("SELECT version FROM db_boundary.storage_schema"))
      .rows;
    await applyMigrations(pg);
  });
  afterAll(async () => pg.close());

  it("keeps every company admin, member and activity row and moves the marker from 23 to 28", async () => {
    expect(marker).toEqual([{ version: 23 }]);
    expect(await rows()).toEqual(before);
    expect(before.admins).toHaveLength(2);
    expect(before.activity).toHaveLength(1);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("adds the helper owner-run, SECURITY DEFINER, STABLE, with a fixed search_path and no PUBLIC EXECUTE", async () => {
    expect(
      (
        await pg.query(
          `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
             p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS config,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public
           FROM pg_proc p WHERE p.oid = 'tenant_context.workspace_person(text)'::regprocedure`,
        )
      ).rows,
    ).toEqual([
      {
        owned: true,
        definer: true,
        volatility: "s",
        config: ["search_path=pg_catalog, pg_temp"],
        public: false,
      },
    ]);
  });

  it("reads the upgraded person and their company authority change to the company owner", async () => {
    const [person] = await helper("person-upgrade-admin");
    expect(person).toMatchObject({
      user_id: "person-upgrade-admin",
      name: "Fictional Upgrade Admin",
      two_step: true,
      teams: [
        {
          team: "Fictional Upgrade Team",
          slug: "person-upgrade-team",
          teamRole: "recruiter",
          configuredRole: null,
        },
      ],
      company_level: "admin",
      company_areas: ["people"],
      plan_access: false,
      authority_suspended: false,
      signed_in_devices: 0,
    });
    expect(person.events).toEqual([
      {
        occurredAt: expect.any(String),
        action: "workspace_authority.changed",
        actorId: "person-upgrade-owner",
        actorName: "Fictional Upgrade Owner",
        objectType: null,
        objectKey: null,
        roleName: null,
      },
    ]);
    expect(await helper("person-upgrade-unknown")).toEqual([]);
  });
});

// A company written by the 0046 schema, upgraded through 0047: no row changes, the marker goes from
// 24 to 28 (0048 to 0050 move it on from 25), nobody is deactivated, install returns the same access to every
// member as before, the people helpers read everyone as active, and the two new helpers are owner-run
// and closed to PUBLIC.
describe("upgrade from 0046 to user deactivation", () => {
  const pg = new PGlite();
  const owner = principal(
    "deactivation-upgrade-owner",
    "deactivation-upgrade-team",
    "owner",
  );
  const member = principal(
    "deactivation-upgrade-member",
    "deactivation-upgrade-team",
    "recruiter",
  );
  const db = drizzle(pg, { schema }) as unknown as AppDb;
  const rows = async () => ({
    admins: (
      await pg.query(
        "SELECT workspace_id, user_id, level, areas, plan_access, granted_by, granted_at, suspended_at FROM app.workspace_admins ORDER BY user_id",
      )
    ).rows,
    members: (
      await pg.query(
        "SELECT id, organization_id, user_id, role FROM auth.member ORDER BY id",
      )
    ).rows,
    activity: (
      await pg.query(`SELECT ${activityColumns} FROM app.activity ORDER BY id`)
    ).rows,
  });
  const access = (p: Principal) =>
    withDeadlinesAndSnapshot(db, (tx, snapshot) =>
      installTenantContext(tx, p, snapshot),
    );

  let before: Awaited<ReturnType<typeof rows>>;
  let accessBefore: unknown[];
  let marker: unknown[];
  beforeAll(async () => {
    await applyMigrations(pg, "0046_workspace_person.sql");
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin,two_factor_enabled) VALUES
        ('deactivation-upgrade-owner','Fictional Upgrade Owner','deactivation-upgrade-owner@example.test',true,true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES
        ('deactivation-upgrade-team','Fictional Upgrade Team','deactivation-upgrade-team','deactivation-upgrade-owner');
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('deactivation-upgrade-mo','deactivation-upgrade-team','deactivation-upgrade-owner','owner');
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin,two_factor_enabled) VALUES
        ('deactivation-upgrade-member','Fictional Upgrade Member','deactivation-upgrade-member@example.test',true,false,false);
      INSERT INTO auth.member(id,organization_id,user_id,role) VALUES
        ('deactivation-upgrade-mm','deactivation-upgrade-team','deactivation-upgrade-member','recruiter');`);
    await installTenantContextKey(pg);
    before = await rows();
    accessBefore = [await access(owner), await access(member)];
    marker = (await pg.query("SELECT version FROM db_boundary.storage_schema"))
      .rows;
    await applyMigrations(pg);
  });
  afterAll(async () => pg.close());

  it("keeps every row, deactivates nobody and moves the marker from 24 to 28", async () => {
    expect(marker).toEqual([{ version: 24 }]);
    expect(await rows()).toEqual(before);
    expect(before.admins).toHaveLength(1);
    expect(before.members).toHaveLength(2);
    expect(
      (await pg.query("SELECT count(*)::int AS n FROM app.workspace_users"))
        .rows,
    ).toEqual([{ n: 0 }]);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("installs the same access for every member and reads everyone as active", async () => {
    expect([await access(owner), await access(member)]).toEqual(accessBefore);
    const listed = await withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
      await installTenantContext(tx, owner, snapshot);
      return (
        await tx.execute<{ user_id: string; status: string }>(
          sql`SELECT user_id, status FROM tenant_context.workspace_people(NULL, NULL, NULL, NULL, NULL, NULL)`,
        )
      ).rows;
    });
    expect(listed).toEqual([
      { user_id: "deactivation-upgrade-member", status: "active" },
      { user_id: "deactivation-upgrade-owner", status: "active" },
    ]);
    const [person] = await withDeadlinesAndSnapshot(
      db,
      async (tx, snapshot) => {
        await installTenantContext(tx, owner, snapshot);
        return (
          await tx.execute<{ deactivated: boolean; events: unknown[] }>(
            sql`SELECT deactivated, events FROM tenant_context.workspace_person('deactivation-upgrade-member')`,
          )
        ).rows;
      },
    );
    expect(person).toEqual({ deactivated: false, events: [] });
  });

  it("adds both helpers owner-run, SECURITY DEFINER, with a fixed search_path and no PUBLIC EXECUTE", async () => {
    for (const helper of [
      "tenant_context.set_user_active(text,boolean)",
      "tenant_context.user_account_action(text,text)",
    ])
      expect(
        (
          await pg.query(
            `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
               p.prosecdef AS definer, p.proconfig AS config,
               has_function_privilege('public', p.oid, 'EXECUTE') AS public
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
            [helper],
          )
        ).rows,
        helper,
      ).toEqual([
        {
          owned: true,
          definer: true,
          config: ["search_path=pg_catalog, pg_temp"],
          public: false,
        },
      ]);
  });
});

// Records written by the 0047 schema, upgraded through 0048: every record keeps every column value and
// gains a null pay_bracket_version_id, the two bracket tables arrive empty under FORCE RLS, the three
// helpers are owner-run and closed to PUBLIC, and the marker goes from 25 to 28 (0049 and 0050 move it on
// from 26).
describe("upgrade from 0047 to salary brackets", () => {
  const pg = new PGlite();
  const team = "brackets-upgrade-team";
  const user = "brackets-upgrade-owner";
  const records = async () =>
    (
      await pg.query<Record<string, unknown>>(
        "SELECT * FROM app.records ORDER BY id",
      )
    ).rows;
  let before: Record<string, unknown>[];
  let marker: unknown[];
  beforeAll(async () => {
    await applyMigrations(pg, "0047_user_deactivation.sql");
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin,two_factor_enabled) VALUES
        ('${user}','Fictional Upgrade Owner','${user}@example.test',true,true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES ('${team}','Fictional Upgrade Team','${team}','${user}');
      INSERT INTO app.records(id,team_id,kind,data,created_by,candidate_id,vacancy_id,application_id) VALUES
        ('${ids.candidate}','${team}','candidate','{"name":"Fictional Upgrade Candidate"}','${user}',NULL,NULL,NULL),
        ('${ids.vacancy}','${team}','vacancy','{"title":"Fictional upgrade vacancy","jobTitleKey":"payroll-lead"}','${user}',NULL,NULL,NULL),
        ('${ids.application}','${team}','application','{"stage":"Offer"}','${user}','${ids.candidate}','${ids.vacancy}',NULL),
        ('${ids.offer}','${team}','offer','{"title":"Fictional upgrade offer","amount":"21000","currency":"AED","status":"Draft"}','${user}',NULL,NULL,'${ids.application}');`);
    before = await records();
    marker = (await pg.query("SELECT version FROM db_boundary.storage_schema"))
      .rows;
    await applyMigrations(pg);
  });
  afterAll(async () => pg.close());

  it("keeps every record column value, pins nothing and moves the marker from 25 to 28", async () => {
    expect(marker).toEqual([{ version: 25 }]);
    expect(before).toHaveLength(4);
    const after = await records();
    expect(after.map(withoutPins)).toEqual(before.map(withoutPins));
    expect(after).toEqual(
      before.map((row) => ({ ...row, pay_bracket_version_id: null })),
    );
    expect(
      (
        await pg.query(
          "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'records' AND column_name = 'pay_bracket_version_id'",
        )
      ).rows,
    ).toEqual([
      { data_type: "uuid", is_nullable: "YES", column_default: null },
    ]);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("adds both bracket tables empty under ENABLE and FORCE RLS", async () => {
    expect(
      (
        await pg.query(
          `SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'app' AND c.relname IN ('salary_bracket_versions', 'salary_brackets') ORDER BY 1`,
        )
      ).rows,
    ).toEqual([
      { name: "salary_bracket_versions", enabled: true, forced: true },
      { name: "salary_brackets", enabled: true, forced: true },
    ]);
    expect(
      (
        await pg.query(
          "SELECT (SELECT count(*) FROM app.salary_bracket_versions)::int AS versions, (SELECT count(*) FROM app.salary_brackets)::int AS brackets",
        )
      ).rows,
    ).toEqual([{ versions: 0, brackets: 0 }]);
  });

  it("adds the three helpers owner-run, SECURITY DEFINER, with a fixed search_path and no PUBLIC EXECUTE", async () => {
    for (const helper of [
      "tenant_context.allows_plan(uuid,text)",
      "tenant_context.publish_bracket_version(uuid)",
      "tenant_context.published_bracket_version()",
    ])
      expect(
        (
          await pg.query(
            `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
               p.prosecdef AS definer, p.proconfig AS config,
               has_function_privilege('public', p.oid, 'EXECUTE') AS public
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
            [helper],
          )
        ).rows,
        helper,
      ).toEqual([
        {
          owned: true,
          definer: true,
          config: ["search_path=pg_catalog, pg_temp"],
          public: false,
        },
      ]);
  });
});

// A team with a ready Blob CV written by the 0048 schema, upgraded through 0049: every record, upload
// and ledger row keeps every value, app.record_files arrives empty under ENABLE and FORCE RLS with
// the restrictive record-scope policy, the two widened helpers keep their signature, owner, SECURITY
// DEFINER and search_path with no PUBLIC EXECUTE, and the marker goes from 26 to 28 (0050 moves it on
// from 27).
describe("upgrade from 0048 to record files", () => {
  const pg = new PGlite();
  const team = "files-upgrade-team";
  const user = "files-upgrade-owner";
  const upload = randomUUID();
  const state = async () => ({
    records: (await pg.query("SELECT * FROM app.records ORDER BY id")).rows,
    uploads: (await pg.query("SELECT * FROM app.uploads ORDER BY id")).rows,
    usage: (await pg.query("SELECT * FROM app.storage_usage ORDER BY team_id"))
      .rows,
    stores: (
      await pg.query("SELECT * FROM storage_ledger.stores ORDER BY store")
    ).rows,
  });
  let before: Awaited<ReturnType<typeof state>>;
  let marker: unknown[];
  beforeAll(async () => {
    await applyMigrations(pg, "0048_salary_brackets.sql");
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin,two_factor_enabled) VALUES
        ('${user}','Fictional Upgrade Owner','${user}@example.test',true,true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES ('${team}','Fictional Upgrade Team','${team}','${user}');
      INSERT INTO app.records(id,team_id,kind,data,created_by) VALUES
        ('${ids.candidate}','${team}','candidate','{"name":"Fictional Upgrade Candidate"}','${user}');
      INSERT INTO storage_ledger.stores(provider,store,environment) VALUES ('blob','store_fictionalupgrade','development');
      INSERT INTO app.storage_usage(team_id) VALUES ('${team}');
      INSERT INTO app.uploads(id,team_id,candidate_id,original_name,mime_type,size_bytes,status,object_key,storage_provider,storage_environment,storage_store,created_by,expires_at)
        VALUES ('${upload}','${team}','${ids.candidate}','fictional-upgrade-cv.pdf','application/pdf',1000,'pending','teams/${team}/cvs/${ids.candidate}/${upload}/fictional.pdf','blob','development','store_fictionalupgrade','${user}',now()+interval '15 minutes');
      UPDATE app.uploads SET status='ready', blob_sha256=repeat('a',64), blob_size_bytes=1000, completed_at=now() WHERE id='${upload}';`);
    before = await state();
    marker = (await pg.query("SELECT version FROM db_boundary.storage_schema"))
      .rows;
    await applyMigrations(pg);
  });
  afterAll(async () => pg.close());

  it("keeps every record, upload and ledger row and moves the marker from 26 to 28", async () => {
    expect(marker).toEqual([{ version: 26 }]);
    expect(before.uploads).toHaveLength(1);
    expect(before.stores).toMatchObject([{ used_files: 1, reserved_files: 0 }]);
    expect(await state()).toEqual(before);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("adds app.record_files empty under ENABLE and FORCE RLS with the team, owner and record-scope policies", async () => {
    expect(
      (
        await pg.query(
          "SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'app.record_files'::regclass",
        )
      ).rows,
    ).toEqual([{ enabled: true, forced: true }]);
    expect(
      (await pg.query("SELECT count(*)::int AS n FROM app.record_files")).rows,
    ).toEqual([{ n: 0 }]);
    expect(
      (
        await pg.query<{ name: string; permissive: string; command: string }>(
          "SELECT policyname AS name, permissive, cmd AS command FROM pg_policies WHERE schemaname = 'app' AND tablename = 'record_files' ORDER BY 1",
        )
      ).rows,
    ).toEqual([
      { name: "context_insert", permissive: "PERMISSIVE", command: "INSERT" },
      { name: "context_read", permissive: "PERMISSIVE", command: "SELECT" },
      { name: "context_update", permissive: "PERMISSIVE", command: "UPDATE" },
      {
        name: "ledger_owner_read",
        permissive: "PERMISSIVE",
        command: "SELECT",
      },
      {
        name: "ledger_owner_update",
        permissive: "PERMISSIVE",
        command: "UPDATE",
      },
      { name: "record_scope", permissive: "RESTRICTIVE", command: "ALL" },
    ]);
    const [scope] = (
      await pg.query<{ qual: string; check: string }>(
        "SELECT qual, with_check AS check FROM pg_policies WHERE schemaname = 'app' AND tablename = 'record_files' AND policyname = 'record_scope'",
      )
    ).rows;
    for (const text of [scope.qual, scope.check])
      expect(text).toContain("record_in_scope(team_id, record_id)");
  });

  it("keeps both widened helpers owner-run, SECURITY DEFINER, with a fixed search_path and no PUBLIC EXECUTE", async () => {
    for (const helper of [
      "tenant_context.release_blob_charge(text,uuid)",
      "tenant_context.erase_candidate(uuid,text,text)",
      "storage_ledger.charge_record_file()",
      "storage_ledger.settle_record_file()",
      "storage_ledger.settle_erased_record_file()",
    ])
      expect(
        (
          await pg.query(
            `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
               p.prosecdef AS definer, p.proconfig AS config,
               has_function_privilege('public', p.oid, 'EXECUTE') AS public
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
            [helper],
          )
        ).rows,
        helper,
      ).toEqual([
        {
          owned: true,
          definer: true,
          config: ["search_path=pg_catalog, pg_temp"],
          public: false,
        },
      ]);
  });
});

// Positions and vacancies with and without a job title written by the 0049 schema, upgraded through
// 0050: every position and record keeps every column value, the new helper is owner-run, SECURITY
// DEFINER with a fixed search_path and no PUBLIC EXECUTE, refuses a call without a context, and the
// marker goes from 27 to 28.
describe("upgrade from 0049 to job title usage", () => {
  const pg = new PGlite();
  const company = "00000000-0000-4000-a000-000000000001";
  const team = "usage-upgrade-team";
  const user = "usage-upgrade-owner";
  const state = async () => ({
    positions: (await pg.query("SELECT * FROM app.positions ORDER BY code"))
      .rows,
    records: (await pg.query("SELECT * FROM app.records ORDER BY id")).rows,
  });
  let before: Awaited<ReturnType<typeof state>>;
  let marker: unknown[];
  beforeAll(async () => {
    await applyMigrations(pg, "0049_record_files.sql");
    await pg.exec(`INSERT INTO auth."user"(id,name,email,email_verified,initial_admin,two_factor_enabled) VALUES
        ('${user}','Fictional Upgrade Owner','${user}@example.test',true,true,true);
      INSERT INTO auth.organization(id,name,slug,created_by) VALUES ('${team}','Fictional Upgrade Team','${team}','${user}');
      INSERT INTO app.org_levels(id,workspace_id,name,depth) VALUES
        ('00000000-0000-4000-a000-0000000000d1','${company}','Fictional level',0);
      INSERT INTO app.org_units(id,workspace_id,level_id,name,code) VALUES
        ('00000000-0000-4000-a000-0000000000d2','${company}','00000000-0000-4000-a000-0000000000d1','Fictional Holdings','UP-HOLD');
      INSERT INTO app.positions(workspace_id,org_unit_id,title,code,is_manager,job_title_key) VALUES
        ('${company}','00000000-0000-4000-a000-0000000000d2','Fictional Payroll Lead','UP-PAY-1',true,'payroll-lead'),
        ('${company}','00000000-0000-4000-a000-0000000000d2','Fictional Clerk','UP-CLK-1',false,NULL);
      INSERT INTO app.records(id,team_id,kind,data,created_by) VALUES
        ('${ids.vacancy}','${team}','vacancy','{"title":"Fictional titled vacancy","status":"Open","jobTitleKey":"payroll-lead"}','${user}'),
        ('${ids.jobRole}','${team}','vacancy','{"title":"Fictional untitled vacancy","status":"Open"}','${user}');`);
    before = await state();
    marker = (await pg.query("SELECT version FROM db_boundary.storage_schema"))
      .rows;
    await applyMigrations(pg);
  });
  afterAll(async () => pg.close());

  it("keeps every position and record column value and moves the marker from 27 to 28", async () => {
    expect(marker).toEqual([{ version: 27 }]);
    expect(before.positions).toHaveLength(2);
    expect(before.records).toHaveLength(2);
    expect(await state()).toEqual(before);
    expect(
      (await pg.query("SELECT version FROM db_boundary.storage_schema")).rows,
    ).toEqual([{ version: 28 }]);
  });

  it("adds the helper owner-run, SECURITY DEFINER, STABLE, with a fixed search_path and no PUBLIC EXECUTE", async () => {
    expect(
      (
        await pg.query(
          `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
             p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS config,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public
           FROM pg_proc p WHERE p.oid = 'tenant_context.job_title_usage(text)'::regprocedure`,
        )
      ).rows,
    ).toEqual([
      {
        owned: true,
        definer: true,
        volatility: "s",
        config: ["search_path=pg_catalog, pg_temp"],
        public: false,
      },
    ]);
  });

  it("refuses a call without a context and writes nothing", async () => {
    await expect(
      pg.query("SELECT * FROM tenant_context.job_title_usage('payroll-lead')"),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await state()).toEqual(before);
  });
});
