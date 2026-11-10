import { randomUUID } from "node:crypto";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requests pick the pool by role, as on a split-role deployment: the identity role reads the
// membership, the data role runs withTeam. Only one PGlite role is active at a time.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));

import type { AppDb, TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import { records } from "@/db/schema";
import { addAssignment, removeAssignment } from "@/lib/assignments";
import {
  accessContext,
  anyRecordScopeRule,
  recordScopeRule,
} from "@/lib/authz";
import { eraseCandidate } from "@/lib/candidate-erasure";
import { setCompanyAuthority } from "@/lib/company-authority";
import { createConfigDraft, publishConfigVersion } from "@/lib/config-store";
import { beginCvUpload } from "@/lib/cvs";
import {
  createEmployee,
  createPosition,
  linkEmployeeUser,
  setEmployeePositions,
} from "@/lib/directory";
import { eraseEmployee } from "@/lib/employee-erasure";
import { listActivity } from "@/lib/insights";
import { assignMemberRole } from "@/lib/member-roles";
import { createOrgLevel, createOrgUnit } from "@/lib/org";
import type { Principal } from "@/lib/principal";
import {
  createRecord,
  getRecord,
  idempotencyActorKey,
  listRecords,
  recordKindOf,
  updateRecord,
} from "@/lib/records";
import type { StorageGateway } from "@/lib/storage";
import { installTenantContext, type TenantAccess } from "@/lib/tenant-context";
import {
  HIRING_MANAGER_ROLE,
  INTERVIEWER_ROLE,
  RECRUITER_ROLE,
} from "@/domain/config-defaults";
import type { RoleBody } from "@/domain/config";
import type { RecordKind, ResourceName } from "@/domain/records";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";

// Fictional data only: one company with a small unit tree, a second fictional team for the
// other-team cases, and members whose roles limit records to their unit or to assigned records.
// Record scope is now enforced by restrictive policies on the data role (R2a-19, job 061).
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Row = Record<string, unknown>;
const TEAM = "rls-team";
const pdf = Buffer.from("%PDF-1.7\nfictional record scope CV");
const gateway: StorageGateway = {
  binding: {
    provider: "s3",
    environment: "development",
    store: "fictional-rls-bucket",
  },
  async assertVersioning() {},
  async presignPost(key) {
    return { url: "https://example.invalid/upload", fields: { key } };
  },
  async head() {
    return {
      sizeBytes: pdf.length,
      mimeType: "application/pdf",
      version: "fictional-v1",
    };
  },
  async readRange() {
    return pdf;
  },
  async signDownload() {
    return "https://example.invalid/download";
  },
};

describe("record scope in row-level security under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, recruiter: Principal, ownerX: Principal;
  let hm: Principal, interviewer: Principal, mixed: Principal;
  let noHome: Principal, hmToken: Principal;
  const unit: Record<string, string> = {};
  /** The fixture records by name. */
  const id: Record<string, string> = {};

  /** Raw reads as the PGlite superuser, which bypasses RLS; only to inspect outcomes. */
  const look = async <T = Row>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  /** One data-role transaction under the principal's verified context. */
  const asContext = <T>(
    principal: Principal,
    work: (tx: TeamTx, access: TenantAccess) => Promise<T>,
  ) =>
    harness
      .dataDb()
      .then((db) =>
        withDeadlinesAndSnapshot(db, async (tx, snapshot) =>
          work(tx, await installTenantContext(tx, principal, snapshot)),
        ),
      );
  const sqlAs = (principal: Principal, statement: string) =>
    asContext(principal, async (tx) => {
      const { rows } = await tx.execute(sql.raw(statement));
      return rows as Row[];
    });
  const sorted = (rows: Row[], key = "id") =>
    rows.map((row) => String(row[key])).sort();
  const named = (...names: string[]) => names.map((name) => id[name]).sort();
  const create = async (
    p: Principal,
    resource: ResourceName,
    input: Row,
  ): Promise<string> => (await createRecord(p, resource, input)).id;
  /** Drafts and publishes one company role as the company owner, then assigns it. */
  async function role(key: string, body: RoleBody, members: Principal[]) {
    const { objectId, versionId } = await createConfigDraft(owner, {
      type: "role",
      key,
      body,
    });
    await publishConfigVersion(owner, versionId);
    for (const member of members)
      await assignMemberRole(
        owner,
        { userId: member.userId, roleObjectId: objectId },
        new Headers(),
      );
  }
  /** A fictional employee linked to the member, holding one position in the unit. */
  async function homeIn(member: Principal, unitId: string, serial: number) {
    const position = await createPosition(owner, {
      title: `Fictional RLS desk ${serial}`,
      code: `RLS-DESK-${serial}`,
      orgUnitId: unitId,
    });
    const employee = await createEmployee(owner, {
      displayName: `Fictional RLS Person ${serial}`,
      employeeNumber: `RLS-EMP-${serial}`,
    });
    await linkEmployeeUser(owner, employee.id, { userId: member.userId });
    await setEmployeePositions(owner, employee.id, {
      positions: [{ positionId: position.id, primary: true }],
    });
  }
  /** The record ids the data role returns under the principal's context, with no predicate. */
  const visibleRecords = (p: Principal) =>
    sqlAs(p, "SELECT id FROM app.records").then((rows) => sorted(rows));
  /**
   * The ids the service rule selects over the same rows as the superuser: the team,
   * anyRecordScopeRule for the principal's installed access and the private owner of saved views.
   */
  const serviceRecords = async (p: Principal) => {
    const access = await asContext(p, async (_tx, state) => state);
    const rule = anyRecordScopeRule(accessContext(p, access), "records");
    const db = await harness.asSuperuser();
    const rows = await db
      .select({ id: records.id })
      .from(records)
      .where(
        and(
          eq(records.teamId, p.teamId),
          or(
            ne(records.kind, "saved-view"),
            eq(records.privateOwnerId, p.userId),
          ),
          ...(rule ? [rule] : []),
        ),
      );
    return sorted(rows);
  };
  /** What the existing policies alone show the principal, limited to the given records. */
  const expectedRows = async (p: Principal, visible: string[]) => ({
    activity: sorted(
      await look(
        `SELECT a.id FROM app.activity a WHERE a.team_id = $1
           AND (a.action <> 'personal_state_updated' OR a.actor_id = $2)
           AND (a.kind <> 'saved-view' OR a.actor_id = $2)
           AND (a.record_id IS NULL OR a.record_id = ANY($3::uuid[]))`,
        [p.teamId, p.userId, visible],
      ),
    ),
    uploads: sorted(
      await look(
        "SELECT u.id FROM app.uploads u WHERE u.team_id = $1 AND (u.candidate_id IS NULL OR u.candidate_id = ANY($2::uuid[]))",
        [p.teamId, visible],
      ),
    ),
    assignments: sorted(
      await look(
        "SELECT ra.record_id || ':' || ra.user_id || ':' || ra.relation AS id FROM app.record_assignments ra WHERE ra.team_id = $1 AND ra.record_id = ANY($2::uuid[])",
        [p.teamId, visible],
      ),
    ),
  });
  const actualRows = async (p: Principal) => ({
    activity: sorted(await sqlAs(p, "SELECT id FROM app.activity")),
    uploads: sorted(await sqlAs(p, "SELECT id FROM app.uploads")),
    assignments: sorted(
      await sqlAs(
        p,
        "SELECT record_id || ':' || user_id || ':' || relation AS id FROM app.record_assignments",
      ),
    ),
  });
  const upload = (p: Principal, candidate: string) =>
    asContext(p, async (tx) => {
      // The lock helper creates the usage rows before the charge, as a reservation does.
      await tx.execute(
        sql`SELECT tenant_context.lock_storage_allocation('s3','development','fictional-rls-bucket')`,
      );
      const { rows } = await tx.execute<{ id: string }>(
        sql`INSERT INTO app.uploads(team_id,candidate_id,original_name,mime_type,size_bytes,object_key,storage_provider,storage_environment,storage_store,created_by,expires_at)
          VALUES (${p.teamId}, ${candidate}::uuid, 'fictional-rls.pdf', 'application/pdf', 10, ${`teams/${p.teamId}/cvs/${randomUUID()}`}, 's3', 'development', 'fictional-rls-bucket', ${p.userId}, now() + interval '1 hour') RETURNING id`,
      );
      return rows[0].id;
    });

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, { userId: "rls-owner", teamId: TEAM });
    const member = (
      userId: string,
      role: "recruiter" | "viewer" = "recruiter",
    ) => seedIdentity(db, { userId, teamId: TEAM, role });
    recruiter = await member("rls-recruiter");
    hm = await member("rls-hiring-manager");
    interviewer = await member("rls-interviewer", "viewer");
    mixed = await member("rls-mixed");
    noHome = await member("rls-no-home");
    ownerX = await seedIdentity(db, {
      userId: "rls-owner-x",
      teamId: "rls-team-x",
    });
    hmToken = await seedApiToken(await harness.asOwner(), hm);

    // Root R with A and B below it, and A1 below A.
    const top = await createOrgLevel(owner, {
      name: "Fictional RLS level 0",
      depth: 0,
    });
    const middle = await createOrgLevel(owner, {
      name: "Fictional RLS level 1",
      depth: 1,
    });
    const bottom = await createOrgLevel(owner, {
      name: "Fictional RLS level 2",
      depth: 2,
    });
    const orgUnit = async (
      name: string,
      levelId: string,
      parentId: string | null,
    ) =>
      (
        await createOrgUnit(owner, {
          name: `Fictional RLS unit ${name}`,
          code: `RLS-${name}`,
          levelId,
          parentId,
        })
      ).id;
    unit.R = await orgUnit("R", top.id, null);
    unit.A = await orgUnit("A", middle.id, unit.R);
    unit.B = await orgUnit("B", middle.id, unit.R);
    unit.A1 = await orgUnit("A1", bottom.id, unit.A);
    await homeIn(hm, unit.A, 1);
    await homeIn(mixed, unit.A, 2);
    await role(
      "rls-hiring-manager",
      {
        ...structuredClone(HIRING_MANAGER_ROLE.body),
        name: "Fictional RLS hiring manager",
      } as RoleBody,
      [hm],
    );
    await role(
      "rls-interviewer",
      {
        ...structuredClone(INTERVIEWER_ROLE.body),
        name: "Fictional RLS interviewer",
      } as RoleBody,
      [interviewer],
    );
    await role(
      "rls-mixed",
      {
        ...structuredClone(RECRUITER_ROLE.body),
        name: "Fictional RLS mixed recruiter",
        recordScope: { pipeline: "unit", candidates: "all", tasks: "assigned" },
      } as RoleBody,
      [mixed],
    );
    await role(
      "rls-no-home",
      {
        ...structuredClone(RECRUITER_ROLE.body),
        name: "Fictional RLS unit recruiter",
        recordScope: { pipeline: "unit", candidates: "unit", tasks: "unit" },
      } as RoleBody,
      [noHome],
    );

    // Records, created by the company owner unless named otherwise.
    const bucket = await create(owner, "buckets", {
      data: { name: "Fictional RLS to do" },
    });
    id.jobRole = await create(owner, "job-roles", {
      data: { title: "Fictional RLS role" },
    });
    const vacancy = (name: string, orgUnitId: string | null) =>
      create(owner, "vacancies", {
        data: { title: `Fictional RLS vacancy ${name}` },
        ...(orgUnitId ? { orgUnitId } : {}),
      });
    id.vA = await vacancy("A", unit.A);
    id.vA1 = await vacancy("A1", unit.A1);
    id.vB = await vacancy("B", unit.B);
    id.vNone = await vacancy("none", null);
    id.vAssigned = await vacancy("assigned", unit.B);
    for (const name of ["A", "A1", "B", "None", "Assigned", "Erased"])
      id[`c${name}`] = await create(owner, "candidates", {
        data: { name: `Fictional RLS Candidate ${name}` },
      });
    const application = (candidate: string, vacancyName: string) =>
      create(owner, "applications", {
        candidateId: id[candidate],
        vacancyId: id[vacancyName],
        data: { stage: "Sourced" },
      });
    id.aA = await application("cA", "vA");
    id.aA1 = await application("cA1", "vA1");
    id.aB = await application("cB", "vB");
    id.aAssigned = await application("cAssigned", "vAssigned");
    const startAt = new Date(Date.now() + 86400000).toISOString();
    id.iA = await create(owner, "interviews", {
      applicationId: id.aA,
      data: { title: "Fictional RLS interview A", startAt },
    });
    id.iB = await create(owner, "interviews", {
      applicationId: id.aB,
      data: { title: "Fictional RLS interview B", startAt },
    });
    id.oA = await create(owner, "offers", {
      applicationId: id.aA,
      data: { title: "Fictional RLS offer A" },
    });
    id.obA = await create(owner, "onboarding", {
      applicationId: id.aA,
      data: {},
    });
    id.clA = await create(owner, "checklist", {
      onboardingId: id.obA,
      data: { title: "Fictional RLS checklist A" },
    });
    const task = (name: string, links: Row = {}) =>
      create(owner, "tasks", {
        bucketId: bucket,
        ...links,
        data: { title: `Fictional RLS task ${name}` },
      });
    id.tLinkCandidate = await task("linked candidate", { candidateId: id.cA });
    id.tLinkVacancy = await task("linked vacancy", { vacancyId: id.vA });
    id.tOut = await task("out", { candidateId: id.cB, vacancyId: id.vB });
    id.tAssigned = await task("assigned");
    id.tNone = await task("none");
    // The mixed member's own task, created through the service under their role.
    id.tMixed = await create(mixed, "tasks", {
      bucketId: bucket,
      data: { title: "Fictional RLS task mixed" },
    });
    id.viewOwner = await create(owner, "views", {
      data: { name: "Fictional RLS owner view", area: "directory", query: {} },
    });
    id.viewMixed = await create(mixed, "views", {
      data: { name: "Fictional RLS mixed view", area: "directory", query: {} },
    });
    const comment = (parent: string, name = parent) =>
      create(owner, "comments", {
        parentRecordId: id[parent],
        data: { body: `Fictional RLS comment ${name}` },
      });
    for (const parent of ["vA", "vB", "cA", "cB", "iB", "tOut", "jobRole"])
      id[`m_${parent}`] = await comment(parent);
    id.reply_vA = await comment("m_vA", "reply A");
    id.reply_vB = await comment("m_vB", "reply B");
    // A chain of depth four under the in-unit vacancy.
    id.deep1 = await comment("vA", "deep 1");
    id.deep2 = await comment("deep1", "deep 2");
    id.deep3 = await comment("deep2", "deep 3");
    id.deep4 = await comment("deep3", "deep 4");
    // Two comments re-pointed into each other by direct SQL, as only the owner could.
    id.loop1 = await comment("vA", "loop 1");
    id.loop2 = await comment("vB", "loop 2");
    await look(
      "UPDATE app.records SET parent_record_id = CASE id WHEN $1::uuid THEN $2::uuid ELSE $1::uuid END WHERE id IN ($1::uuid, $2::uuid)",
      [id.loop1, id.loop2],
    );

    // Assignments, made by the company owner through the service.
    for (const [user, record] of [
      [interviewer, "vA"],
      [interviewer, "iB"],
      [interviewer, "tAssigned"],
      [noHome, "aB"],
      [mixed, "tAssigned"],
      [mixed, "vAssigned"],
      [hm, "vAssigned"],
    ] as const)
      expect(
        await addAssignment(owner, {
          recordId: id[record],
          userId: user.userId,
          relation: "interviewer",
        }),
      ).toEqual({ changed: true });
    for (const candidate of ["cA", "cB", "cNone"])
      id[`u_${candidate}`] = await upload(owner, id[candidate]);

    // The other team's records, for the other-team cases.
    id.xVacancy = await create(ownerX, "vacancies", {
      data: { title: "Fictional RLS other vacancy" },
    });
    id.xCandidate = await create(ownerX, "candidates", {
      data: { name: "Fictional RLS Other Candidate" },
    });
  });
  afterAll(async () => harness?.close());

  const scoped = () => ({ hm, interviewer, mixed, noHome, hmToken });

  describe("reads", () => {
    it("returns exactly the records the service rule selects, for every scoped principal", async () => {
      const team = sorted(
        await look("SELECT id FROM app.records WHERE team_id = $1", [TEAM]),
      );
      for (const [name, p] of Object.entries(scoped())) {
        const visible = await visibleRecords(p);
        expect(visible, name).toEqual(await serviceRecords(p));
        expect(visible.length, name).toBeGreaterThan(0);
        expect(visible.length, name).toBeLessThan(team.length);
      }
      // Spot checks of the scope table (architecture §3.5).
      const hmSees = await visibleRecords(hm);
      for (const name of [
        "vA",
        "vA1",
        "vAssigned",
        "aA",
        "aA1",
        "iA",
        "oA",
        "obA",
        "clA",
        "cA",
        "cA1",
        "tLinkCandidate",
        "tLinkVacancy",
        "m_vA",
        "m_cA",
        "reply_vA",
        "deep4",
        "m_jobRole",
        "jobRole",
      ])
        expect(hmSees, name).toContain(id[name]);
      for (const name of [
        "vB",
        "vNone",
        "aB",
        "iB",
        "cB",
        "cNone",
        "tOut",
        "tAssigned",
        "m_vB",
        "reply_vB",
        "loop1",
        "loop2",
        "viewOwner",
        "viewMixed",
      ])
        expect(hmSees, name).not.toContain(id[name]);
      expect(await visibleRecords(interviewer)).toEqual(
        expect.arrayContaining(named("vA", "iB", "tAssigned", "aA", "deep4")),
      );
      expect(await visibleRecords(interviewer)).not.toContain(id.aB);
      // Mixed: every candidate, pipeline by unit, tasks only its own and assigned.
      const mixedSees = await visibleRecords(mixed);
      expect(mixedSees).toEqual(
        expect.arrayContaining(
          named("cB", "cNone", "tMixed", "tAssigned", "viewMixed", "vAssigned"),
        ),
      );
      for (const name of ["tLinkCandidate", "tOut", "vB", "viewOwner"])
        expect(mixedSees, name).not.toContain(id[name]);
      // No home units: only through the assignment on aB.
      const noHomeSees = await visibleRecords(noHome);
      expect(noHomeSees).toEqual(
        expect.arrayContaining(named("aB", "iB", "cB", "tOut", "m_iB")),
      );
      for (const name of ["vA", "vB", "aA", "cA"])
        expect(noHomeSees, name).not.toContain(id[name]);
    });

    it("selects the same records with the rule's sets computed once per statement, for every scoped principal", async () => {
      // As the superuser, so only the two shapes of the service rule decide (R2-PERF-01).
      const kinds: RecordKind[] = [
        "vacancy",
        "application",
        "interview",
        "offer",
        "onboarding",
        "checklist",
        "candidate",
        "task",
        "comment",
        "job-role",
      ];
      for (const [name, p] of Object.entries(scoped())) {
        const ctx = accessContext(
          p,
          await asContext(p, async (_tx, state) => state),
        );
        const db = await harness.asSuperuser();
        const ofKind = async (kind: RecordKind, once: boolean) => {
          const rule = recordScopeRule(ctx, kind, "records", { once });
          return sorted(
            await db
              .select({ id: records.id })
              .from(records)
              .where(
                and(
                  eq(records.teamId, p.teamId),
                  eq(records.kind, kind),
                  ...(rule ? [rule] : []),
                ),
              ),
          );
        };
        let selected = 0;
        for (const kind of kinds) {
          const once = await ofKind(kind, true);
          expect(once, `${name} ${kind}`).toEqual(await ofKind(kind, false));
          selected += once.length;
        }
        expect(selected, name).toBeGreaterThan(0);
      }
    });

    it("sees exactly what the existing policies show a scope-all member", async () => {
      for (const p of [owner, recruiter]) {
        expect(await visibleRecords(p)).toEqual(await serviceRecords(p));
        expect(await visibleRecords(p)).toEqual(
          sorted(
            await look(
              "SELECT id FROM app.records WHERE team_id = $1 AND (kind <> 'saved-view' OR private_owner_id = $2)",
              [TEAM, p.userId],
            ),
          ),
        );
      }
    });

    it("limits activity, uploads and assignments to records in scope, keeping team rows without a record", async () => {
      for (const p of [hm, interviewer]) {
        const visible = await visibleRecords(p);
        const actual = await actualRows(p);
        expect(actual).toEqual(await expectedRows(p, visible));
        // Rows without a record (configuration and directory events) stay.
        const blank = await look<{ id: string }>(
          "SELECT id FROM app.activity WHERE team_id = $1 AND record_id IS NULL",
          [TEAM],
        );
        expect(blank.length).toBeGreaterThan(0);
        for (const row of blank) expect(actual.activity).toContain(row.id);
      }
      expect((await actualRows(hm)).uploads).toEqual([id.u_cA].sort());
      expect((await actualRows(interviewer)).uploads).toEqual([id.u_cA].sort());
      expect((await actualRows(hm)).assignments).toEqual(
        [
          `${id.vAssigned}:${hm.userId}:interviewer`,
          `${id.vAssigned}:${mixed.userId}:interviewer`,
          `${id.vA}:${interviewer.userId}:interviewer`,
        ].sort(),
      );
      // A scope-all member's counts equal the existing policies alone.
      const team = sorted(
        await look("SELECT id FROM app.records WHERE team_id = $1", [TEAM]),
      );
      const all = await actualRows(recruiter);
      expect(all).toEqual(await expectedRows(recruiter, team));
      expect(all.uploads).toHaveLength(3);
      expect(all.assignments).toHaveLength(7);
    });
  });

  describe("writes", () => {
    const title = (name: string) => `Fictional RLS direct ${name}`;
    const insertVacancy = (p: Principal, name: string, orgUnitId: string) =>
      sqlAs(
        p,
        `INSERT INTO app.records(team_id,kind,data,created_by,org_unit_id) VALUES ('${TEAM}','vacancy','{"title":"${title(name)}"}','${p.userId}','${orgUnitId}') RETURNING id`,
      );
    const titled = (name: string) =>
      look("SELECT id FROM app.records WHERE data->>'title' = $1", [
        title(name),
      ]);

    it("refuses an insert outside the home units and an update that moves a record out, and changes nothing", async () => {
      await expect(insertVacancy(hm, "out", unit.B)).rejects.toMatchObject({
        cause: { code: "42501" },
      });
      expect(await titled("out")).toEqual([]);
      // The same insert under a home unit is allowed.
      expect(await insertVacancy(hm, "in", unit.A1)).toHaveLength(1);
      const before = await look("SELECT * FROM app.records WHERE id = $1", [
        id.vA,
      ]);
      await expect(
        sqlAs(
          hm,
          `UPDATE app.records SET org_unit_id = '${unit.B}' WHERE id = '${id.vA}'`,
        ),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      expect(
        await look("SELECT * FROM app.records WHERE id = $1", [id.vA]),
      ).toEqual(before);
    });

    it("updates no out-of-scope record", async () => {
      const before = await look("SELECT * FROM app.records WHERE id = $1", [
        id.vB,
      ]);
      expect(
        await sqlAs(
          hm,
          `UPDATE app.records SET data = '{"title":"Fictional RLS taken"}' WHERE id = '${id.vB}' RETURNING id`,
        ),
      ).toEqual([]);
      expect(
        await sqlAs(
          hm,
          `UPDATE app.records SET data = data WHERE team_id = '${TEAM}' AND kind = 'vacancy' RETURNING id`,
        ).then((rows) => sorted(rows)),
      ).not.toContain(id.vB);
      expect(
        await look("SELECT * FROM app.records WHERE id = $1", [id.vB]),
      ).toEqual(before);
    });

    it("refuses activity and uploads that name an out-of-scope record or candidate", async () => {
      const event = (recordId: string) =>
        `INSERT INTO app.activity(team_id,record_id,actor_id,actor_type,action,kind,summary) VALUES ('${TEAM}','${recordId}','${hm.userId}','session','updated','vacancy','Fictional RLS event') RETURNING id`;
      await expect(sqlAs(hm, event(id.vB))).rejects.toMatchObject({
        cause: { code: "42501" },
      });
      expect(await sqlAs(hm, event(id.vA))).toHaveLength(1);
      const uploads = async () =>
        (
          await look<{ n: number }>(
            "SELECT count(*)::int AS n FROM app.uploads",
          )
        )[0].n;
      const count = await uploads();
      await expect(upload(hm, id.cB)).rejects.toMatchObject({
        cause: { code: "42501" },
      });
      expect(await uploads()).toBe(count);
      expect(await upload(hm, id.cA)).toBeTruthy();
    });

    it("answers the hiring manager's unit move with 403 record_out_of_scope and leaves the vacancy unchanged", async () => {
      const before = await getRecord(owner, "vacancies", id.vA);
      await expect(
        updateRecord(hm, "vacancies", id.vA, {
          version: before.version,
          orgUnitId: unit.B,
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: "record_out_of_scope",
        message:
          "This change would put the record outside the records you can see.",
      });
      expect(await getRecord(owner, "vacancies", id.vA)).toEqual(before);
      // A move inside the subtree is allowed.
      const moved = await updateRecord(hm, "vacancies", id.vA1, {
        version: (await getRecord(owner, "vacancies", id.vA1)).version,
        orgUnitId: unit.A,
      });
      expect(moved).toMatchObject({ orgUnitId: unit.A });
      // A scope-all caller's database refusal is not mapped: an archived unit is still RQ012.
    });
  });

  describe("idempotency", () => {
    const fixtureRow = (p: Principal, actorKey: string, key: string) =>
      `INSERT INTO app.idempotency(team_id,actor_key,operation,key,payload_hash,response,expires_at) VALUES ('${p.teamId}','${actorKey}','rls-fixture','${key}','${"0".repeat(64)}','{}'::jsonb,now() + interval '1 hour') RETURNING key`;

    it("shows every context only its own actor's rows, and refuses writes to another actor's", async () => {
      const contexts = { recruiter, hm, hmToken };
      for (const [name, p] of Object.entries(contexts))
        expect(
          await sqlAs(p, fixtureRow(p, idempotencyActorKey(p), `own-${name}`)),
        ).toHaveLength(1);
      for (const [name, p] of Object.entries(contexts)) {
        const own = idempotencyActorKey(p);
        const rows = await sqlAs(p, "SELECT actor_key FROM app.idempotency");
        expect(rows.length, name).toBeGreaterThan(0);
        expect(new Set(rows.map((row) => row.actor_key)), name).toEqual(
          new Set([own]),
        );
        const other = Object.values(contexts).find((q) => q !== p)!;
        const theirs = idempotencyActorKey(other);
        await expect(
          sqlAs(p, fixtureRow(p, theirs, `forged-${name}`)),
          name,
        ).rejects.toMatchObject({ cause: { code: "42501" } });
        expect(
          await sqlAs(
            p,
            `UPDATE app.idempotency SET response = '{"taken":true}' WHERE actor_key = '${theirs}' RETURNING key`,
          ),
          name,
        ).toEqual([]);
        expect(
          await sqlAs(
            p,
            `DELETE FROM app.idempotency WHERE actor_key = '${theirs}' RETURNING key`,
          ),
          name,
        ).toEqual([]);
      }
      expect(
        await look(
          "SELECT key FROM app.idempotency WHERE operation = 'rls-fixture' AND (key LIKE 'forged-%' OR response ? 'taken') ORDER BY key",
        ),
      ).toEqual([]);
      expect(
        (
          await look<{ n: number }>(
            "SELECT count(*)::int AS n FROM app.idempotency WHERE operation = 'rls-fixture'",
          )
        )[0].n,
      ).toBe(3);
    });

    it("keeps the rows written by createRecord and beginCvUpload from another member of the team", async () => {
      await createRecord(
        recruiter,
        "vacancies",
        { data: { title: "Fictional RLS keyed vacancy" } },
        "rls-create-key",
      );
      await beginCvUpload(
        recruiter,
        id.cA,
        {
          originalName: "fictional-rls-keyed.pdf",
          mimeType: "application/pdf",
          sizeBytes: pdf.length,
          clientUploadId: randomUUID(),
        },
        gateway,
      );
      const written = await look<{ actor_key: string; operation: string }>(
        "SELECT actor_key, operation FROM app.idempotency WHERE actor_key = $1 AND operation <> 'rls-fixture' ORDER BY operation",
        [idempotencyActorKey(recruiter)],
      );
      expect(written.map((row) => row.operation)).toEqual([
        "create:vacancies",
        `cv-upload:${id.cA}`,
      ]);
      for (const p of [owner, mixed])
        expect(
          await sqlAs(
            p,
            `SELECT key FROM app.idempotency WHERE actor_key = '${idempotencyActorKey(recruiter)}'`,
          ),
        ).toEqual([]);
      expect(
        await sqlAs(
          recruiter,
          "SELECT operation FROM app.idempotency WHERE operation <> 'rls-fixture' ORDER BY operation",
        ).then((rows) => rows.map((row) => row.operation)),
      ).toEqual(["create:vacancies", `cv-upload:${id.cA}`]);
    });

    it("builds the context's actor key exactly as idempotencyActorKey does", async () => {
      for (const p of [hm, hmToken, owner])
        expect(
          (
            await sqlAs(p, "SELECT tenant_context.context_actor_key() AS key")
          )[0].key,
        ).toBe(idempotencyActorKey(p));
      expect(idempotencyActorKey(hmToken)).toBe(
        `${hm.userId}:token:${hmToken.tokenId}`,
      );
      expect(idempotencyActorKey(hm)).toBe(`${hm.userId}:session:session`);
    });
  });

  describe("comment loops", () => {
    const quick = async <T>(work: () => Promise<T>) => {
      const started = Date.now();
      const result = await work();
      expect(Date.now() - started).toBeLessThan(5000);
      return result;
    };

    it("ends the walk for scoped members, who see the deep chain and not the loop", async () => {
      const listed = await quick(() =>
        listRecords(hm, "comments", new URLSearchParams({ pageSize: "100" })),
      );
      const seen = listed.data.map((row) => row.id);
      expect(seen).toEqual(
        expect.arrayContaining(named("deep1", "deep2", "deep3", "deep4")),
      );
      expect(seen).not.toContain(id.loop1);
      expect(seen).not.toContain(id.loop2);
      await expect(
        quick(() => recordKindOf(hm, id.loop1)),
      ).rejects.toMatchObject({ status: 404 });
      expect(await quick(() => recordKindOf(hm, id.deep4))).toEqual({
        kind: "comment",
        archived: false,
      });
      const feed = await quick(() =>
        listActivity(mixed, new URLSearchParams({ pageSize: "100" })),
      );
      expect(feed.data.map((row) => row.recordId)).not.toContain(id.loop1);
      expect(
        (
          await quick(() =>
            listActivity(
              mixed,
              new URLSearchParams({ recordId: id.deep4, pageSize: "100" }),
            ),
          )
        ).data.length,
      ).toBeGreaterThan(0);
      for (const p of [hm, mixed, interviewer]) {
        const direct = await quick(() =>
          asContext(p, async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
            const { rows } = await tx.execute<{ id: string }>(
              sql`SELECT id FROM app.records WHERE kind = 'comment'`,
            );
            return rows.map((row) => row.id);
          }),
        );
        expect(direct).toContain(id.deep4);
        expect(direct).not.toContain(id.loop1);
        expect(direct).not.toContain(id.loop2);
      }
    });

    it("shows both loop comments to a scope-all member", async () => {
      const listed = await listRecords(
        recruiter,
        "comments",
        new URLSearchParams({ pageSize: "100" }),
      );
      expect(listed.data.map((row) => row.id)).toEqual(
        expect.arrayContaining(named("loop1", "loop2", "deep4")),
      );
      const direct = await sqlAs(
        recruiter,
        "SELECT id FROM app.records WHERE kind = 'comment'",
      );
      expect(sorted(direct)).toEqual(
        expect.arrayContaining(named("loop1", "loop2")),
      );
    });
  });

  describe("helpers", () => {
    it("answers false alike for a missing, another team's and an out-of-scope id", async () => {
      const ask = async (statement: string) =>
        (await sqlAs(hm, `SELECT ${statement} AS answer`))[0].answer;
      const missing = randomUUID();
      for (const recordId of [missing, id.xVacancy, id.vB, id.cB, id.aB])
        expect(
          await ask(`tenant_context.record_in_scope('${TEAM}', '${recordId}')`),
          recordId,
        ).toBe(false);
      expect(
        await ask(
          `tenant_context.record_in_scope('rls-team-x', '${id.xVacancy}')`,
        ),
      ).toBe(false);
      expect(
        await ask(`tenant_context.record_in_scope('${TEAM}', '${id.vA}')`),
      ).toBe(true);
      for (const candidateId of [missing, id.xCandidate, id.cB, id.vA])
        expect(
          await ask(
            `tenant_context.candidate_in_scope('${TEAM}', '${candidateId}')`,
          ),
          candidateId,
        ).toBe(false);
      expect(
        await ask(`tenant_context.candidate_in_scope('${TEAM}', '${id.cA}')`),
      ).toBe(true);
      const inScope = (team: string, recordId: string, unitId: string) =>
        ask(
          `tenant_context.in_scope('${team}', 'vacancy', '${recordId}', '${unitId}', NULL, '${recordId}', NULL, '${owner.userId}', NULL, NULL)`,
        );
      expect(await inScope(TEAM, missing, unit.B)).toBe(false);
      expect(await inScope("rls-team-x", id.xVacancy, unit.A)).toBe(false);
      expect(await inScope(TEAM, id.vB, unit.B)).toBe(false);
      expect(await inScope(TEAM, id.vA, unit.A)).toBe(true);
      // No context: every helper is false, and the actor key is null.
      const db = await harness.dataDb();
      expect(
        (
          await db.execute(
            sql`SELECT tenant_context.scope_is_all() AS a, tenant_context.record_in_scope(${TEAM}, ${id.vA}::uuid) AS b, tenant_context.candidate_in_scope(${TEAM}, ${id.cA}::uuid) AS c, tenant_context.context_actor_key() AS d`,
          )
        ).rows,
      ).toEqual([{ a: false, b: false, c: false, d: null }]);
    });
  });

  describe("owner-run helpers", () => {
    it("still erase a candidate, including other actors' cached responses", async () => {
      await createRecord(
        recruiter,
        "applications",
        {
          candidateId: id.cErased,
          vacancyId: id.vNone,
          data: { stage: "Sourced" },
        },
        "rls-erase-recruiter",
      );
      await createRecord(
        mixed,
        "applications",
        {
          candidateId: id.cErased,
          vacancyId: id.vA,
          data: { stage: "Sourced" },
        },
        "rls-erase-mixed",
      );
      const result = await eraseCandidate(owner, id.cErased, {
        confirmName: "Fictional RLS Candidate Erased",
      });
      expect(result).toMatchObject({
        alreadyErased: false,
        removed: { applications: 2, idempotencyKeys: 2 },
      });
      expect(
        await look(
          "SELECT response FROM app.idempotency WHERE key IN ('rls-erase-recruiter', 'rls-erase-mixed')",
        ),
      ).toEqual([
        { response: { erased: true } },
        { response: { erased: true } },
      ]);
    });

    it("still erase an employee, change assignments and authority, publish configuration and cascade a unit", async () => {
      const employee = await createEmployee(owner, {
        displayName: "Fictional RLS Leaver",
        employeeNumber: "RLS-EMP-LEAVER",
      });
      expect(
        await eraseEmployee(owner, employee.id, {
          confirmName: "Fictional RLS Leaver",
        }),
      ).toMatchObject({
        alreadyErased: false,
        removed: { positionRows: 0, userLinks: 0 },
      });
      const assignment = {
        recordId: id.vA,
        userId: recruiter.userId,
        relation: "assignee",
      };
      expect(await addAssignment(hm, assignment)).toEqual({ changed: true });
      expect(await removeAssignment(owner, assignment)).toEqual({
        changed: true,
      });
      expect(
        await setCompanyAuthority(owner, {
          userId: recruiter.userId,
          level: "admin",
          areas: ["organisation"],
          planAccess: false,
        }),
      ).toEqual({ changed: true });
      expect(
        await setCompanyAuthority(owner, {
          userId: recruiter.userId,
          level: null,
        }),
      ).toEqual({ changed: true });
      const draft = await createConfigDraft(owner, {
        type: "workflow",
        key: "rls-workflow",
        body: { label: "Fictional RLS workflow" },
      });
      await publishConfigVersion(owner, draft.versionId);
      // The cascade runs as the owner, below any member's scope.
      const vacancy = await getRecord(owner, "vacancies", id.vAssigned);
      await updateRecord(owner, "vacancies", id.vAssigned, {
        version: vacancy.version,
        orgUnitId: unit.A1,
      });
      expect(
        await look("SELECT org_unit_id FROM app.records WHERE id = $1", [
          id.aAssigned,
        ]),
      ).toEqual([{ org_unit_id: unit.A1 }]);
      expect(await visibleRecords(hm)).toContain(id.aAssigned);
    });

    it("never recurse: each table reads under every context and as the owner", async () => {
      const tables = [
        "app.records",
        "app.activity",
        "app.uploads",
        "app.record_assignments",
        "app.idempotency",
      ];
      for (const p of [recruiter, hm, interviewer, hmToken])
        for (const table of tables)
          await expect(
            sqlAs(p, `SELECT count(*)::int AS n FROM ${table}`),
            `${p.userId} ${table}`,
          ).resolves.toHaveLength(1);
      await harness.asOwner();
      for (const table of tables)
        await expect(
          harness.client.query(`SELECT count(*)::int AS n FROM ${table}`),
          table,
        ).resolves.toMatchObject({ rows: [expect.any(Object)] });
    });
  });
});
