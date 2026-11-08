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
import { applyMigrations, schema, setDbForTests, type AppDb } from "../src/db";
import { withDeadlinesAndSnapshot } from "../src/db/deadlines";
import { eraseCandidate } from "../src/lib/candidate-erasure";
import { listCandidateCvs } from "../src/lib/cvs";
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
    ).toEqual([{ version: 10 }]);
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
    ).toEqual([{ version: 10 }]);
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
    ).toEqual([{ version: 10 }]);
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
    ).toEqual([{ version: 10 }]);
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
          (await pg.query(`SELECT * FROM ${table} ORDER BY 1, 2`)).rows,
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
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES
        ('config-upgrade-admin','Fictional Upgrade Admin','config-upgrade-admin@example.test',true,false);
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
    ).toEqual([{ version: 10 }]);
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
    ).toEqual([{ version: 10 }]);
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
