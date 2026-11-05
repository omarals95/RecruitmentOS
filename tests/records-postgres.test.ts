import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq, sql } from "drizzle-orm";
import { activity, idempotency, records } from "@/db/schema";
import { withTeam } from "@/lib/db-team";
import {
  bulkApplications,
  createRecord,
  getCandidateState,
  getRecord,
  listRecords,
  bootstrapTeam,
  updateCandidateState,
  updateRecord,
} from "@/lib/records";
import type { Principal } from "@/lib/principal";
import type { RecordDto } from "@/domain/records";
import { roleSnapshot } from "@/components/workspace/helpers";
import {
  createTestDb,
  enforceTestRls,
  seedApiToken,
  seedIdentity,
} from "./helpers/db";

describe("recruitment records with real PostgreSQL migrations and RLS", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal,
    colleague: Principal,
    other: Principal,
    viewer: Principal,
    bucketRace: Principal,
    rollback: Principal;
  beforeAll(async () => {
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db);
    colleague = await seedIdentity(fixture.db, { userId: "test-colleague" });
    other = await seedIdentity(fixture.db, {
      userId: "other-owner",
      teamId: "other-team",
    });
    bucketRace = await seedIdentity(fixture.db, {
      userId: "bucket-race-owner",
      teamId: "bucket-race-team",
    });
    rollback = await seedIdentity(fixture.db, {
      userId: "rollback-owner",
      teamId: "rollback-team",
    });
    viewer = await seedIdentity(fixture.db, {
      userId: "test-viewer",
      role: "viewer",
    });
    await fixture.client
      .exec(`CREATE FUNCTION app.records_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF EXISTS(SELECT 1 FROM app.records WHERE id=NEW.record_id AND data->>'name'='Fictional forced audit rejection') THEN
      RAISE EXCEPTION 'Fictional audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER records_test_reject_audit BEFORE INSERT ON app.activity FOR EACH ROW EXECUTE FUNCTION app.records_test_reject_audit();`);
    await enforceTestRls(fixture.db);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  const candidate = (name: string, p = owner) =>
    createRecord(p, "candidates", { data: { name } });
  const vacancy = (title: string, p = owner) =>
    createRecord(p, "vacancies", { data: { title, status: "Open" } });

  it("isolates reads, reference kinds, scopes and personal state across users and teams", async () => {
    const person = await candidate("Fictional Privacy Person");
    const foreignVacancy = await vacancy("Foreign vacancy", other);
    await expect(
      getRecord(other, "candidates", person.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createRecord(owner, "applications", {
        candidateId: person.id,
        vacancyId: foreignVacancy.id,
        data: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createRecord(owner, "applications", {
        candidateId: person.id,
        vacancyId: person.id,
        data: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      candidate("Viewer cannot create", viewer),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      candidate("Read token cannot create", {
        ...owner,
        scopes: ["candidates:read"],
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await getCandidateState(owner, person.id)).toMatchObject({
      version: 0,
      note: "",
      shortlisted: false,
    });
    const first = await updateCandidateState(owner, person.id, {
      version: 0,
      note: "Private fictional note",
      shortlisted: true,
    });
    expect(first.version).toBe(1);
    expect(await getCandidateState(colleague, person.id)).toMatchObject({
      version: 0,
      note: "",
      shortlisted: false,
    });
    await expect(
      updateCandidateState(owner, person.id, { version: 0, note: "Stale" }),
    ).rejects.toMatchObject({ status: 409 });
    const selected = await listRecords(
      owner,
      "candidates",
      new URLSearchParams({ shortlisted: "true" }),
    );
    expect(selected.data.map((row) => row.id)).toContain(person.id);
    expect(
      (
        await listRecords(
          colleague,
          "candidates",
          new URLSearchParams({ shortlisted: "true" }),
        )
      ).data.map((row) => row.id),
    ).not.toContain(person.id);
    const events = await withTeam(owner, (tx) =>
      tx
        .select()
        .from(activity)
        .where(
          and(
            eq(activity.teamId, owner.teamId),
            eq(activity.recordId, person.id),
          ),
        ),
    );
    expect(JSON.stringify(events)).not.toContain("Private fictional note");
  });

  it("uses optimistic versions, immutable parents, independent statuses and audited manual stages", async () => {
    const person = await candidate("Fictional Pipeline Person");
    const job = await vacancy("Pipeline vacancy");
    const app = await createRecord(owner, "applications", {
      candidateId: person.id,
      vacancyId: job.id,
      data: { stage: "Screening" },
    });
    const advanced = await updateRecord(owner, "applications", app.id, {
      version: 1,
      data: { stage: "Hired" },
    });
    expect(advanced.version).toBe(2);
    await expect(
      updateRecord(owner, "applications", app.id, {
        version: 1,
        data: { stage: "Rejected" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      updateRecord(owner, "applications", app.id, {
        version: 2,
        candidateId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await getRecord(owner, "vacancies", job.id)).data).toMatchObject({
      status: "Open",
    });
    const events = await withTeam(owner, (tx) =>
      tx
        .select()
        .from(activity)
        .where(
          and(eq(activity.teamId, owner.teamId), eq(activity.recordId, app.id)),
        ),
    );
    expect(events.map((event) => event.metadata)).toContainEqual({
      fromStage: "Screening",
      toStage: "Hired",
    });
    await updateRecord(owner, "applications", app.id, {
      version: 2,
      archived: true,
    });
    const replacement = await createRecord(owner, "applications", {
      candidateId: person.id,
      vacancyId: job.id,
      data: {},
    });
    expect(replacement.id).not.toBe(app.id);
    await expect(
      updateRecord(owner, "applications", app.id, {
        version: 3,
        archived: false,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("allows one active application when duplicate creates race", async () => {
    const person = await candidate("Fictional Race Applicant");
    const job = await vacancy("Fictional race vacancy");
    const results = await Promise.allSettled(
      ["fictional-race-a", "fictional-race-b"].map((key) =>
        createRecord(
          owner,
          "applications",
          { candidateId: person.id, vacancyId: job.id, data: {} },
          key,
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 409 });
    expect(
      (
        await listRecords(
          owner,
          "applications",
          new URLSearchParams({ candidateId: person.id, vacancyId: job.id }),
        )
      ).pagination.total,
    ).toBe(1);
  });

  it("links a task to a candidate without creating or moving an application", async () => {
    const person = await candidate("Fictional Task Link Person");
    const job = await vacancy("Fictional task link vacancy");
    const app = await createRecord(owner, "applications", {
      candidateId: person.id,
      vacancyId: job.id,
      data: { stage: "Screening" },
    });
    const bucket = await createRecord(owner, "buckets", {
      data: { name: "Fictional task link bucket" },
    });
    const task = await createRecord(owner, "tasks", {
      bucketId: bucket.id,
      candidateId: person.id,
      data: { title: "Fictional call back", priority: "High" },
    });
    const applications = await listRecords(
      owner,
      "applications",
      new URLSearchParams({ candidateId: person.id }),
    );
    expect(applications.data).toHaveLength(1);
    expect(applications.data[0]).toMatchObject({
      id: app.id,
      version: app.version,
      data: { stage: "Screening" },
    });
    expect(
      (
        await listRecords(
          owner,
          "tasks",
          new URLSearchParams({ candidateId: person.id }),
        )
      ).data.map((row) => row.id),
    ).toEqual([task.id]);
  });

  it("never changes a vacancy when its source role is edited or archived", async () => {
    const role = await createRecord(owner, "job-roles", {
      data: {
        title: "Fictional Role Analyst",
        department: "Finance",
        skills: ["SQL"],
      },
    });
    const job = await createRecord(owner, "vacancies", {
      jobRoleId: role.id,
      data: {
        ...roleSnapshot(role.data as unknown as Record<string, unknown>),
        status: "Draft",
        openings: 1,
      },
    });
    const updated = await updateRecord(owner, "job-roles", role.id, {
      version: role.version,
      data: { title: "Fictional Role Renamed", skills: ["SQL", "Python"] },
    });
    await updateRecord(owner, "job-roles", role.id, {
      version: updated.version,
      archived: true,
    });
    const after = await getRecord(owner, "vacancies", job.id);
    expect(after.data).toEqual(job.data);
    expect(after.version).toBe(job.version);
    expect(after.data).toMatchObject({
      title: "Fictional Role Analyst",
      skills: ["SQL"],
    });
  });

  it("allows one active onboarding per application", async () => {
    const person = await candidate("Fictional Onboarding Person");
    const job = await vacancy("Fictional onboarding vacancy");
    const app = await createRecord(owner, "applications", {
      candidateId: person.id,
      vacancyId: job.id,
      data: { stage: "Hired" },
    });
    const first = await createRecord(owner, "onboarding", {
      applicationId: app.id,
      data: {},
    });
    await expect(
      createRecord(owner, "onboarding", { applicationId: app.id, data: {} }),
    ).rejects.toMatchObject({ status: 409 });
    await updateRecord(owner, "onboarding", first.id, {
      version: first.version,
      archived: true,
    });
    const second = await createRecord(owner, "onboarding", {
      applicationId: app.id,
      data: {},
    });
    expect(second.id).not.toBe(first.id);
  });

  it("filters candidates by certifications, education and stated experience", async () => {
    const tag = randomUUID().slice(0, 8);
    const make = (name: string, data: Record<string, unknown>) =>
      createRecord(owner, "candidates", {
        data: { name: `Fictional Filter ${tag} ${name}`, ...data },
      });
    const both = await make("Both", {
      certifications: ["Fictional PMP", "Fictional CPA"],
      degreeName: "Bachelor of Fictional Science",
      yearsExperience: 3,
    });
    const one = await make("One", {
      certifications: ["Fictional PMP"],
      major: "Fictional HISTORY",
      yearsExperience: 5,
    });
    const two = await make("Two", {
      university: "University of Fictional Arts",
      yearsExperience: 2,
    });
    const six = await make("Six", { yearsExperience: 6 });
    const unknown = await make("Unknown", { yearsExperience: null });
    const query = (filters: Record<string, string>) =>
      new URLSearchParams({
        search: `"Fictional Filter ${tag}"`,
        pageSize: "100",
        ...filters,
      });
    const ids = async (filters: Record<string, string>) =>
      (await listRecords(owner, "candidates", query(filters))).data
        .map((row) => row.id)
        .sort();
    expect(
      await ids({
        certifications: JSON.stringify(["Fictional PMP", "Fictional CPA"]),
      }),
    ).toEqual([both.id]);
    expect(
      await ids({ certifications: JSON.stringify(["Fictional PMP"]) }),
    ).toEqual([both.id, one.id].sort());
    expect(await ids({ education: "fictional science" })).toEqual([both.id]);
    expect(await ids({ education: "history" })).toEqual([one.id]);
    expect(await ids({ education: "FICTIONAL ARTS" })).toEqual([two.id]);
    expect(
      await ids({ minYearsExperience: "3", maxYearsExperience: "5" }),
    ).toEqual([both.id, one.id].sort());
    expect(await ids({ minYearsExperience: "0" })).toEqual(
      [both.id, one.id, two.id, six.id].sort(),
    );
    expect(await ids({ maxYearsExperience: "100" })).not.toContain(unknown.id);
    const page = await listRecords(
      owner,
      "candidates",
      query({
        minYearsExperience: "3",
        maxYearsExperience: "5",
        pageSize: "1",
      }),
    );
    expect(page.data).toHaveLength(1);
    expect(page.pagination.total).toBe(2);
    for (const invalid of [
      { minYearsExperience: "6", maxYearsExperience: "5" },
      { minYearsExperience: "three" },
      { maxYearsExperience: "101" },
      { minYearsExperience: "" },
    ] as Record<string, string>[])
      await expect(
        listRecords(owner, "candidates", query(invalid)),
      ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
    for (const [key, value] of [
      ["certifications", JSON.stringify(["Fictional PMP"])],
      ["education", "Fictional"],
      ["minYearsExperience", "1"],
      ["maxYearsExperience", "5"],
    ])
      await expect(
        listRecords(owner, "tasks", new URLSearchParams({ [key]: value })),
      ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
  });

  it("validates every bulk parent before writing and skips active duplicate pairs", async () => {
    const first = await candidate("Fictional Bulk First");
    const second = await candidate("Fictional Bulk Second");
    const job = await vacancy("Bulk vacancy");
    await expect(
      bulkApplications(owner, {
        candidateIds: [first.id, randomUUID()],
        vacancyId: job.id,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (
        await listRecords(
          owner,
          "applications",
          new URLSearchParams({ vacancyId: job.id }),
        )
      ).pagination.total,
    ).toBe(0);
    expect(
      await bulkApplications(owner, {
        candidateIds: [first.id, second.id, first.id],
        vacancyId: job.id,
      }),
    ).toMatchObject({ created: 2, skipped: 0 });
    expect(
      await bulkApplications(owner, {
        candidateIds: [first.id, second.id],
        vacancyId: job.id,
      }),
    ).toMatchObject({ created: 0, skipped: 2 });
  });

  it("atomically moves populated buckets and protects the last active bucket", async () => {
    const workflow = await bootstrapTeam(other);
    expect(workflow.created).toBe(4);
    expect(
      workflow.data.map((bucket) => [
        (bucket.data as { name: string }).name,
        (bucket.data as { completed: boolean }).completed,
      ]),
    ).toEqual([
      ["To do", false],
      ["In progress", false],
      ["Waiting", false],
      ["Done", true],
    ]);
    expect((await bootstrapTeam(other)).created).toBe(0);
    const [first, second, third, fourth] = workflow.data;
    const task = await createRecord(other, "tasks", {
      bucketId: first.id,
      data: { title: "Fictional move task" },
    });
    await expect(
      updateRecord(other, "buckets", first.id, { version: 1, archived: true }),
    ).rejects.toMatchObject({ status: 409 });
    await updateRecord(other, "buckets", first.id, {
      version: 1,
      archived: true,
      moveToBucketId: second.id,
    });
    expect(await getRecord(other, "tasks", task.id)).toMatchObject({
      bucketId: second.id,
      version: 2,
    });
    await updateRecord(other, "buckets", third.id, {
      version: 1,
      archived: true,
    });
    await updateRecord(other, "buckets", fourth.id, {
      version: 1,
      archived: true,
    });
    await expect(
      updateRecord(other, "buckets", second.id, { version: 1, archived: true }),
    ).rejects.toMatchObject({ status: 409, code: "last_bucket" });
  });

  // PGlite has one connection, so these prove the team lock and checks under interleaved calls only.
  it("keeps one active bucket when the last two are archived concurrently", async () => {
    const first = await createRecord(bucketRace, "buckets", {
      data: { name: "Fictional race first" },
    });
    const second = await createRecord(bucketRace, "buckets", {
      data: { name: "Fictional race second" },
    });
    const results = await Promise.allSettled([
      updateRecord(bucketRace, "buckets", first.id, {
        version: 1,
        archived: true,
      }),
      updateRecord(bucketRace, "buckets", second.id, {
        version: 1,
        archived: true,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      status: 409,
      code: "last_bucket",
    });
    expect(
      (await listRecords(bucketRace, "buckets", new URLSearchParams()))
        .pagination.total,
    ).toBe(1);
  });

  it("rolls back every task move when the bucket archive fails mid-transaction", async () => {
    const source = await createRecord(rollback, "buckets", {
      data: { name: "Fictional rollback source" },
    });
    const target = await createRecord(rollback, "buckets", {
      data: { name: "Fictional rollback target" },
    });
    const tasks: RecordDto[] = [];
    for (const title of ["Fictional rollback one", "Fictional rollback two"])
      tasks.push(
        await createRecord(rollback, "tasks", {
          bucketId: source.id,
          data: { title },
        }),
      );
    // Renamed below the service so only the bucket's own archive audit is rejected.
    await withTeam(rollback, (tx) =>
      tx
        .update(records)
        .set({
          data: sql`jsonb_set(${records.data}, '{name}', '"Fictional forced audit rejection"')`,
        })
        .where(eq(records.id, source.id)),
    );
    const before = await getRecord(rollback, "buckets", source.id);
    const taskEvents = () =>
      withTeam(rollback, (tx) =>
        tx
          .select()
          .from(activity)
          .where(
            and(
              eq(activity.teamId, rollback.teamId),
              sql`${activity.recordId} in (${sql.join(
                tasks.map((task) => sql`${task.id}`),
                sql`, `,
              )})`,
            ),
          ),
      );
    expect(await taskEvents()).toHaveLength(2);
    const failure = await updateRecord(rollback, "buckets", source.id, {
      version: before.version,
      archived: true,
      moveToBucketId: target.id,
    }).catch((error: Error) => error);
    // The trigger fires on the bucket's audit row, after the task moves ran.
    expect(
      `${failure} ${(failure as Error & { cause?: unknown }).cause}`,
    ).toContain("Fictional audit failure");
    for (const task of tasks)
      expect(await getRecord(rollback, "tasks", task.id)).toMatchObject({
        bucketId: source.id,
        version: task.version,
      });
    expect(await getRecord(rollback, "buckets", source.id)).toMatchObject({
      archivedAt: null,
      version: before.version,
    });
    const events = await taskEvents();
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.action === "created")).toBe(true);
  });

  it("enforces custom values and blocks incompatible schema changes without losing archived values", async () => {
    const bucket = await createRecord(owner, "buckets", {
      data: { name: "Custom workflow" },
    });
    const field = await createRecord(owner, "task-fields", {
      data: {
        name: "Fictional approval",
        type: "Dropdown",
        options: ["Pending", "Approved"],
      },
    });
    const task = await createRecord(owner, "tasks", {
      bucketId: bucket.id,
      data: {
        title: "Custom values task",
        customValues: { [field.id]: "Pending" },
      },
    });
    await expect(
      updateRecord(owner, "task-fields", field.id, {
        version: 1,
        data: { options: ["Approved"] },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      createRecord(owner, "task-fields", {
        data: { name: "Required retrofit", type: "Text", required: true },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      updateRecord(owner, "tasks", task.id, {
        version: 1,
        data: { customValues: { [field.id]: "Unknown" } },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await updateRecord(owner, "task-fields", field.id, {
      version: 1,
      archived: true,
    });
    const edited = await updateRecord(owner, "tasks", task.id, {
      version: 1,
      data: { title: "Edited without data loss" },
    });
    expect(edited.data).toMatchObject({
      customValues: { [field.id]: "Pending" },
    });
    await expect(
      updateRecord(owner, "tasks", task.id, {
        version: 2,
        data: { customValues: {} },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("replays idempotent creates and rejects mismatched payloads without duplicate audit events", async () => {
    const payload = { data: { name: "Fictional Idempotent Person" } };
    const first = await createRecord(
      owner,
      "candidates",
      payload,
      "fictional-create-1",
    );
    const replay = await createRecord(
      owner,
      "candidates",
      payload,
      "fictional-create-1",
    );
    expect(replay).toEqual(first);
    await expect(
      createRecord(
        owner,
        "candidates",
        { data: { name: "Different person" } },
        "fictional-create-1",
      ),
    ).rejects.toMatchObject({ status: 409 });
    const events = await withTeam(owner, (tx) =>
      tx
        .select({ total: count() })
        .from(activity)
        .where(
          and(
            eq(activity.teamId, owner.teamId),
            eq(activity.recordId, first.id),
          ),
        ),
    );
    expect(events[0].total).toBe(1);
    await expect(
      createRecord(owner, "candidates", payload, "bad key"),
    ).rejects.toMatchObject({ status: 400 });
    const concurrent = await Promise.all([
      createRecord(
        owner,
        "candidates",
        { data: { name: "Fictional retry race" } },
        "retry-race",
      ),
      createRecord(
        owner,
        "candidates",
        { data: { name: "Fictional retry race" } },
        "retry-race",
      ),
    ]);
    expect(concurrent[0].id).toBe(concurrent[1].id);
  });

  it("reconciles expired create keys with the existing record and never re-creates", async () => {
    const payload = { data: { name: "Fictional Expired Key Person" } };
    const first = await createRecord(
      owner,
      "candidates",
      payload,
      "fictional-expired-1",
    );
    const where = and(
      eq(idempotency.teamId, owner.teamId),
      eq(idempotency.operation, "create:candidates"),
      eq(idempotency.key, "fictional-expired-1"),
    );
    const expire = () =>
      withTeam(owner, (tx) =>
        tx
          .update(idempotency)
          .set({ expiresAt: new Date(Date.now() - 60000) })
          .where(where),
      );
    const candidates = async () =>
      (
        await withTeam(owner, (tx) =>
          tx
            .select({ total: count() })
            .from(records)
            .where(
              and(
                eq(records.teamId, owner.teamId),
                eq(records.kind, "candidate"),
              ),
            ),
        )
      )[0].total;
    const audits = async (recordId: string) =>
      (
        await withTeam(owner, (tx) =>
          tx
            .select({ total: count() })
            .from(activity)
            .where(
              and(
                eq(activity.teamId, owner.teamId),
                eq(activity.recordId, recordId),
              ),
            ),
        )
      )[0].total;
    await expire();
    const before = await candidates();
    const retry = await createRecord(
      owner,
      "candidates",
      payload,
      "fictional-expired-1",
    );
    expect(retry.id).toBe(first.id);
    expect(await candidates()).toBe(before);
    expect(await audits(first.id)).toBe(1);
    const [renewed] = await withTeam(owner, (tx) =>
      tx.select().from(idempotency).where(where),
    );
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(renewed.response).toMatchObject({ id: first.id });
    await expire();
    await expect(
      createRecord(
        owner,
        "candidates",
        { data: { name: "Fictional Different Person" } },
        "fictional-expired-1",
      ),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_mismatch" });
    await withTeam(owner, (tx) =>
      tx
        .update(idempotency)
        .set({
          response: sql`jsonb_set(response, '{id}', ${JSON.stringify(randomUUID())}::jsonb)`,
        })
        .where(where),
    );
    await expect(
      createRecord(owner, "candidates", payload, "fictional-expired-1"),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_expired" });
    expect(await candidates()).toBe(before);
  });

  it("replays bulk assignment keys and reports created versus existing applications", async () => {
    const first = await candidate("Fictional Bulk Key First");
    const second = await candidate("Fictional Bulk Key Second");
    const job = await vacancy("Bulk key vacancy");
    const earlier = await createRecord(owner, "applications", {
      candidateId: first.id,
      vacancyId: job.id,
      data: {},
    });
    const body = { candidateIds: [first.id, second.id], vacancyId: job.id };
    const result = await bulkApplications(owner, body, "fictional-bulk-1");
    expect(result).toMatchObject({ created: 1, skipped: 1 });
    expect(result.data.map((row) => row.candidateId)).toEqual([second.id]);
    expect(result.existing.map((row) => row.id)).toEqual([earlier.id]);
    expect(await bulkApplications(owner, body, "fictional-bulk-1")).toEqual(
      result,
    );
    await expect(
      bulkApplications(
        owner,
        { ...body, candidateIds: [second.id] },
        "fictional-bulk-1",
      ),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_mismatch" });
    const retry = await bulkApplications(owner, body);
    expect(retry).toMatchObject({ created: 0, skipped: 2, data: [] });
    expect(retry.existing.map((row) => row.id).sort()).toEqual(
      [earlier.id, result.data[0].id].sort(),
    );
    await withTeam(owner, (tx) =>
      tx
        .update(idempotency)
        .set({ expiresAt: new Date(Date.now() - 60000) })
        .where(
          and(
            eq(idempotency.teamId, owner.teamId),
            eq(idempotency.operation, "bulk:applications"),
            eq(idempotency.key, "fictional-bulk-1"),
          ),
        ),
    );
    const expired = await bulkApplications(owner, body, "fictional-bulk-1");
    expect(expired).toMatchObject({ created: 0, skipped: 2 });
  });

  it("reports only references for existing applications to write tokens without recruitment:read", async () => {
    const person = await candidate("Fictional Bulk Scope Person");
    const job = await vacancy("Bulk scope vacancy");
    const private_ = await createRecord(colleague, "applications", {
      candidateId: person.id,
      vacancyId: job.id,
      data: { owner: "Fictional colleague", notes: "Fictional private note" },
    });
    const token = await seedApiToken(fixture.db, owner, [
      "recruitment:write",
      "candidates:read",
    ]);
    const result = await bulkApplications(
      token,
      { candidateIds: [person.id], vacancyId: job.id },
      "fictional-bulk-scope",
    );
    expect(result).toMatchObject({ created: 0, skipped: 1, data: [] });
    expect(result.existing).toEqual([
      {
        id: private_.id,
        kind: "application",
        candidateId: person.id,
        vacancyId: job.id,
      },
    ]);
    const [stored] = await withTeam(owner, (tx) =>
      tx
        .select()
        .from(idempotency)
        .where(
          and(
            eq(idempotency.teamId, owner.teamId),
            eq(idempotency.key, "fictional-bulk-scope"),
          ),
        ),
    );
    expect(JSON.stringify([result, stored.response])).not.toMatch(
      /Fictional private note|Fictional colleague/,
    );
  });

  it("returns the original snapshot on expired-key retries without the read scope", async () => {
    const writer = await seedApiToken(fixture.db, owner, ["candidates:write"]);
    const payload = { data: { name: "Fictional Write Only Person" } };
    const first = await createRecord(
      writer,
      "candidates",
      payload,
      "fictional-write-only",
    );
    await updateRecord(owner, "candidates", first.id, {
      version: 1,
      data: { jobTitle: "Fictional later edit" },
    });
    await withTeam(owner, (tx) =>
      tx
        .update(idempotency)
        .set({ expiresAt: new Date(Date.now() - 60000) })
        .where(
          and(
            eq(idempotency.teamId, owner.teamId),
            eq(idempotency.key, "fictional-write-only"),
          ),
        ),
    );
    const retry = await createRecord(
      writer,
      "candidates",
      payload,
      "fictional-write-only",
    );
    expect(retry).toEqual(first);
    expect(JSON.stringify(retry)).not.toContain("Fictional later edit");
  });

  it("rolls back the business record and retry cache when its audit append fails", async () => {
    await expect(
      createRecord(
        owner,
        "candidates",
        { data: { name: "Fictional forced audit rejection" } },
        "rollback-audit",
      ),
    ).rejects.toThrow();
    expect(
      (
        await listRecords(
          owner,
          "candidates",
          new URLSearchParams({ search: '"Fictional forced audit rejection"' }),
        )
      ).pagination.total,
    ).toBe(0);
    const cached = await withTeam(owner, (tx) =>
      tx
        .select()
        .from(idempotency)
        .where(
          and(
            eq(idempotency.teamId, owner.teamId),
            eq(idempotency.key, "rollback-audit"),
          ),
        ),
    );
    expect(cached).toEqual([]);
  });

  it("makes saved views private and comments append-only", async () => {
    const view = await createRecord(owner, "views", {
      data: {
        name: "Personal fictional view",
        area: "directory",
        query: { search: "fictional" },
      },
    });
    await expect(getRecord(colleague, "views", view.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (await listRecords(colleague, "views", new URLSearchParams())).data.map(
        (row) => row.id,
      ),
    ).not.toContain(view.id);
    const person = await candidate("Fictional Discussion Person");
    const comment = await createRecord(owner, "comments", {
      parentRecordId: person.id,
      data: { body: "<script>literal text</script>" },
    });
    expect(comment.createdBy).toBe(owner.userId);
    await expect(
      updateRecord(owner, "comments", comment.id, {
        version: 1,
        archived: true,
      }),
    ).rejects.toMatchObject({ status: 405 });
    await expect(
      createRecord(
        { ...owner, role: "recruiter", scopes: ["recruitment:write"] },
        "comments",
        {
          parentRecordId: person.id,
          data: { body: "Forged", legacyAuthorLabel: "Owner" },
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("names comment authors through the activity accessor without exposing user IDs", async () => {
    await fixture.db.execute(
      sql`update auth."user" set name='Fictional Comment Author' where id=${owner.userId}`,
    );
    const person = await candidate("Fictional Commented Person");
    const written = await createRecord(owner, "comments", {
      parentRecordId: person.id,
      data: { body: "Fictional named comment" },
    });
    expect(written.authorName).toBe("Fictional Comment Author");
    const imported = await createRecord(owner, "comments", {
      parentRecordId: person.id,
      data: {
        body: "Fictional imported comment",
        legacyAuthorLabel: "Fictional source label",
      },
      legacyId: "named-comment-import",
    });
    const listed = await listRecords(
      colleague,
      "comments",
      new URLSearchParams({ parentRecordId: person.id, sort: "createdAt" }),
    );
    const named = listed.data.find((row) => row.id === written.id)!;
    expect(named.authorName).toBe("Fictional Comment Author");
    const { createdBy, ...rest } = named;
    expect(createdBy).toBe(owner.userId);
    expect(JSON.stringify(rest)).not.toContain(owner.userId);
    expect(
      listed.data.find((row) => row.id === imported.id)?.authorName,
    ).toBeNull();
    expect(
      (await getRecord(colleague, "comments", written.id)).authorName,
    ).toBe("Fictional Comment Author");
  });

  it("preserves imported provenance while never fabricating observed stage history", async () => {
    const person = await createRecord(owner, "candidates", {
      data: { name: "Fictional Historic Person" },
      legacyId: "historic-person",
      archived: true,
      importMeta: { createdAt: "2017-01-01", sourceFile: "fictional.xlsx" },
    });
    const job = await createRecord(owner, "vacancies", {
      data: { title: "Historic vacancy" },
      legacyId: "historic-vacancy",
      archived: true,
    });
    const app = await createRecord(owner, "applications", {
      candidateId: person.id,
      vacancyId: job.id,
      data: { stage: "Hired" },
      legacyId: "historic-app",
      archived: true,
    });
    expect(app.data).toMatchObject({ appliedDate: "", stage: "Hired" });
    const events = await withTeam(owner, (tx) =>
      tx
        .select()
        .from(activity)
        .where(
          and(eq(activity.teamId, owner.teamId), eq(activity.recordId, app.id)),
        ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: "import",
      action: "imported",
      metadata: {},
    });
    await expect(
      createRecord(owner, "applications", {
        candidateId: person.id,
        vacancyId: job.id,
        data: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    const historicalComment = await createRecord(owner, "comments", {
      parentRecordId: person.id,
      data: {
        body: "Fictional historic comment",
        legacyAuthorLabel: "Unverified source label",
      },
      legacyId: "historic-comment",
    });
    expect(historicalComment.archivedAt).toBeNull();
    await expect(
      createRecord(owner, "comments", {
        parentRecordId: person.id,
        data: { body: "New ordinary comment" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("labels and searches application parents only within the caller’s factual read scopes", async () => {
    const person = await candidate("FictionalUniqueLinkPerson");
    const job = await vacancy("FictionalUniqueLinkVacancy");
    const app = await createRecord(owner, "applications", {
      candidateId: person.id,
      vacancyId: job.id,
      data: {},
    });
    expect(app.label).toContain("FictionalUniqueLinkPerson");
    expect(app.label).toContain("FictionalUniqueLinkVacancy");
    expect(
      (
        await listRecords(
          owner,
          "applications",
          new URLSearchParams({ search: "FictionalUniqueLinkPerson" }),
        )
      ).data.map((row) => row.id),
    ).toContain(app.id);
    const token = {
      ...owner,
      scopes: ["recruitment:read"] as Principal["scopes"],
    };
    expect(
      (await getRecord(token, "applications", app.id)).label,
    ).not.toContain("FictionalUniqueLinkPerson");
    expect(
      (
        await listRecords(
          token,
          "applications",
          new URLSearchParams({ search: "FictionalUniqueLinkPerson" }),
        )
      ).pagination.total,
    ).toBe(0);
    expect(
      (
        await listRecords(
          token,
          "applications",
          new URLSearchParams({ search: "FictionalUniqueLinkVacancy" }),
        )
      ).data.map((row) => row.id),
    ).toContain(app.id);
    const start = await createRecord(owner, "onboarding", {
      applicationId: app.id,
      data: {},
    });
    expect(start.label).toContain("FictionalUniqueLinkPerson");
  });

  it("supports bounded saved-view tag and review filters while protecting source provenance", async () => {
    const person = await createRecord(owner, "candidates", {
      data: {
        name: "Fictional TagFilter Person",
        folderCategories: ["Engineering", "Operations"],
        skills: ["TypeScript", "Security"],
        reviewStatus: "Verified",
      },
    });
    const filters = new URLSearchParams({
      categories: JSON.stringify(["Engineering", "Design"]),
      skills: JSON.stringify(["TypeScript", "Security"]),
      needsReview: "false",
    });
    expect(
      (await listRecords(owner, "candidates", filters)).data.map(
        (row) => row.id,
      ),
    ).toContain(person.id);
    expect(
      (
        await listRecords(
          owner,
          "candidates",
          new URLSearchParams({ needsReview: "true" }),
        )
      ).data.map((row) => row.id),
    ).not.toContain(person.id);
    expect(
      (
        await listRecords(
          owner,
          "candidates",
          new URLSearchParams({ skills: JSON.stringify(["Missing skill"]) }),
        )
      ).data.map((row) => row.id),
    ).not.toContain(person.id);
    await expect(
      listRecords(
        owner,
        "candidates",
        new URLSearchParams({ categories: "not-json" }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      updateRecord(
        { ...owner, role: "recruiter", scopes: ["candidates:write"] },
        "candidates",
        person.id,
        { version: 1, data: { rawSource: {} } },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("paginates safe factual search without treating property names as candidate attributes", async () => {
    await createRecord(owner, "candidates", {
      data: {
        name: "Fictional Search Alpha",
        skills: ["Security operations", "TypeScript"],
      },
    });
    await createRecord(owner, "candidates", {
      data: {
        name: "Fictional Search Beta",
        skills: ["Security operations", "Python"],
      },
    });
    const result = await listRecords(
      owner,
      "candidates",
      new URLSearchParams({
        search: '"security operations" -python',
        pageSize: "1",
      }),
    );
    expect(result.pagination.total).toBe(1);
    expect(result.data[0].data).toMatchObject({
      name: "Fictional Search Alpha",
    });
    expect(
      (
        await listRecords(
          owner,
          "candidates",
          new URLSearchParams({ search: "documentedYearsEstimate" }),
        )
      ).pagination.total,
    ).toBe(0);
    expect(
      (
        await listRecords(
          owner,
          "candidates",
          new URLSearchParams({ search: "100%" }),
        )
      ).pagination.total,
    ).toBe(0);
    await expect(
      listRecords(
        owner,
        "candidates",
        new URLSearchParams({ sort: "data;drop table" }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("matches literal percent signs in factual phrases and exclusions without SQL wildcard behavior", async () => {
    const target = await createRecord(owner, "candidates", {
      data: {
        name: "Fictional Percent Target",
        skills: ["Coverage 100%", "Security operations"],
      },
    });
    const control = await createRecord(owner, "candidates", {
      data: {
        name: "Fictional Percent Control",
        skills: ["Coverage 1000", "Security operations"],
      },
    });
    const included = await listRecords(
      owner,
      "candidates",
      new URLSearchParams({ search: '"security operations" "Coverage 100%"' }),
    );
    expect(included.data.map((row) => row.id)).toEqual([target.id]);
    const excluded = await listRecords(
      owner,
      "candidates",
      new URLSearchParams({ search: '"Fictional Percent" -100%' }),
    );
    expect(excluded.data.map((row) => row.id)).toEqual([control.id]);
  });

  it("matches literal underscores in names and email facts with matching exclusion semantics", async () => {
    const target = await createRecord(owner, "candidates", {
      data: {
        name: "Fictional_Underscore_Target",
        email: "fixture_team@example.test",
      },
    });
    const control = await createRecord(owner, "candidates", {
      data: {
        name: "FictionalXUnderscoreXTarget",
        email: "fixtureXteam@example.test",
      },
    });
    expect(
      (
        await listRecords(
          owner,
          "candidates",
          new URLSearchParams({ search: "fixture_team@example.test" }),
        )
      ).data.map((row) => row.id),
    ).toEqual([target.id]);
    expect(
      (
        await listRecords(
          owner,
          "candidates",
          new URLSearchParams({ search: '"Fictional_Underscore_Target"' }),
        )
      ).data.map((row) => row.id),
    ).toEqual([target.id]);
    expect(
      (
        await listRecords(
          owner,
          "candidates",
          new URLSearchParams({
            search: "Underscore -fixture_team@example.test",
          }),
        )
      ).data.map((row) => row.id),
    ).toEqual([control.id]);
  });

  it("enforces database tenant FKs, row security and immutable audit history even below the service", async () => {
    const person = await candidate("Fictional SQL Guard Person");
    const foreignJob = await vacancy("Foreign SQL guard vacancy", other);
    await expect(
      withTeam(owner, (tx) =>
        tx.insert(records).values({
          id: randomUUID(),
          teamId: owner.teamId,
          kind: "application",
          data: {},
          candidateId: person.id,
          vacancyId: foreignJob.id,
          createdBy: owner.userId,
        }),
      ),
    ).rejects.toThrow();
    const foreignRows = await withTeam(other, (tx) =>
      tx.select().from(records).where(eq(records.id, person.id)),
    );
    expect(foreignRows).toEqual([]);
    await expect(
      withTeam(owner, (tx) =>
        tx.execute(
          sql`update ${activity} set summary='tampered' where ${activity.teamId}=${owner.teamId}`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      withTeam(owner, (tx) =>
        tx.insert(records).values({
          id: randomUUID(),
          teamId: other.teamId,
          kind: "candidate",
          data: { name: "Blocked" },
          createdBy: owner.userId,
        }),
      ),
    ).rejects.toThrow();
  });
});
