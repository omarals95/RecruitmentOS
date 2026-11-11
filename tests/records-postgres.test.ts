import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { activity, idempotency, recordAssignments, records } from "@/db/schema";
import { addAssignment } from "@/lib/assignments";
import { withTeam } from "@/lib/db-team";
import {
  bulkApplications,
  candidateSuggestions,
  createRecord,
  exportRecords,
  getCandidateState,
  getRecord,
  listRecords,
  bootstrapTeam,
  updateCandidateState,
  updateRecord,
} from "@/lib/records";
import type { Principal } from "@/lib/principal";
import {
  beginRecordFileUpload,
  completeRecordFileUpload,
} from "@/lib/record-files";
import { createConfigDraft, publishConfigVersion } from "@/lib/config-store";
import { assignMemberRole } from "@/lib/member-roles";
import { archiveOrgUnit, createOrgLevel, createOrgUnit } from "@/lib/org";
import {
  DEFAULT_KIND_SCHEMAS,
  INTERVIEWER_ROLE,
  RECRUITER_ROLE,
  VIEWER_ROLE,
} from "@/domain/config-defaults";
import {
  CONFIGURABLE_KINDS,
  type ConfigurableKind,
  type KindSchemaBody,
  type RoleBody,
} from "@/domain/config";
import {
  TASK_LINK_KINDS,
  type RecordDto,
  type ResourceName,
} from "@/domain/records";
import { roleSnapshot } from "@/components/workspace/helpers";
import { interviewsOnDay } from "@/components/workspace/calendar";
import {
  defaultListQuery,
  listSearchParams,
} from "@/components/workspace/tab-requests";
import {
  createTestDb,
  enforceTestRls,
  seedApiToken,
  seedIdentity,
} from "./helpers/db";
import { fakeBlob } from "./helpers/fake-blob";
import {
  customField,
  insertKindSchema,
  kindBody,
} from "./helpers/kind-schemas";

describe("recruitment records with real PostgreSQL migrations and RLS", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal,
    colleague: Principal,
    other: Principal,
    viewer: Principal,
    bucketRace: Principal,
    rollback: Principal,
    suggesting: Principal,
    lead: Principal,
    memberA: Principal,
    memberB: Principal,
    memberC: Principal;
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
    suggesting = await seedIdentity(fixture.db, {
      userId: "suggestion-owner",
      teamId: "suggestion-team",
    });
    // Team tasks (R2a-20): a team of its own, so no other case's custom fields or tasks apply.
    lead = await seedIdentity(fixture.db, {
      userId: "assignee-lead",
      teamId: "assignee-team",
    });
    const teamMember = (name: string) =>
      seedIdentity(fixture.db, {
        userId: `assignee-member-${name}`,
        teamId: "assignee-team",
        role: "recruiter",
      });
    memberA = await teamMember("a");
    memberB = await teamMember("b");
    memberC = await teamMember("c");
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

  it("writes an update's comment in the same transaction, and none without the option", async () => {
    const person = await candidate("Fictional Comment Mover");
    const job = await vacancy("Comment move vacancy");
    const app = await createRecord(owner, "applications", {
      candidateId: person.id,
      vacancyId: job.id,
      data: { stage: "Screening" },
    });
    const comments = () =>
      withTeam(owner, (tx) =>
        tx
          .select({ id: records.id, data: records.data })
          .from(records)
          .where(
            and(
              eq(records.teamId, owner.teamId),
              eq(records.kind, "comment"),
              eq(records.parentRecordId, app.id),
            ),
          ),
      );
    const events = async () =>
      (
        await withTeam(owner, (tx) =>
          tx
            .select({ count: count() })
            .from(activity)
            .where(eq(activity.teamId, owner.teamId)),
        )
      )[0].count;
    const plain = await updateRecord(owner, "applications", app.id, {
      version: 1,
      data: { stage: "Interview" },
    });
    expect(plain).not.toHaveProperty("commentId");
    expect(await comments()).toEqual([]);
    const moved = await updateRecord(
      owner,
      "applications",
      app.id,
      { version: 2, data: { stage: "Rejected" } },
      { comment: "Moved to Rejected. Reason: Fictional reason" },
    );
    expect(moved.version).toBe(3);
    expect(await comments()).toEqual([
      {
        id: moved.commentId,
        data: { body: "Moved to Rejected. Reason: Fictional reason" },
      },
    ]);
    await updateRecord(owner, "applications", app.id, {
      version: 3,
      archived: true,
    });
    const before = await events();
    // An archived parent refuses the comment, so the stage change rolls back with it.
    await expect(
      updateRecord(
        owner,
        "applications",
        app.id,
        { version: 4, data: { stage: "Withdrawn" } },
        { comment: "Moved to Withdrawn. Reason: Fictional reason" },
      ),
    ).rejects.toMatchObject({ code: "archived_reference" });
    const after = await getRecord(owner, "applications", app.id);
    expect(after.version).toBe(4);
    expect(after.data).toMatchObject({ stage: "Rejected" });
    expect(await comments()).toHaveLength(1);
    expect(await events()).toBe(before);
    await expect(
      updateRecord(
        owner,
        "applications",
        app.id,
        { version: 4, data: { stage: "Screening" } },
        { comment: " " },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect((await getRecord(owner, "applications", app.id)).version).toBe(4);
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

  it("records offer status changes and never changes the offer's application", async () => {
    const person = await candidate("Fictional Offer Person");
    const job = await vacancy("Fictional offer vacancy");
    const app = await createRecord(owner, "applications", {
      candidateId: person.id,
      vacancyId: job.id,
      data: { stage: "Offer" },
    });
    const offer = await createRecord(owner, "offers", {
      applicationId: app.id,
      data: { title: "Fictional offer", status: "Draft" },
    });
    const sent = await updateRecord(owner, "offers", offer.id, {
      version: offer.version,
      data: { status: "Sent" },
    });
    const noted = await updateRecord(owner, "offers", offer.id, {
      version: sent.version,
      data: { notes: "Fictional note only" },
    });
    const applicationBefore = await getRecord(owner, "applications", app.id);
    const applicationEvents = () =>
      withTeam(
        owner,
        async (tx) =>
          (
            await tx
              .select({ total: count() })
              .from(activity)
              .where(
                and(
                  eq(activity.teamId, owner.teamId),
                  eq(activity.recordId, app.id),
                ),
              )
          )[0].total,
      );
    const eventsBefore = await applicationEvents();
    const accepted = await updateRecord(owner, "offers", offer.id, {
      version: noted.version,
      data: { status: "Accepted" },
    });
    const archived = await updateRecord(owner, "offers", offer.id, {
      version: accepted.version,
      archived: true,
    });
    const offerEvents = await withTeam(owner, (tx) =>
      tx
        .select({ action: activity.action, metadata: activity.metadata })
        .from(activity)
        .where(
          and(
            eq(activity.teamId, owner.teamId),
            eq(activity.recordId, offer.id),
          ),
        ),
    );
    expect(offerEvents).toHaveLength(5);
    expect(offerEvents).toEqual(
      expect.arrayContaining([
        {
          action: "created",
          metadata: { fromStatus: null, toStatus: "Draft" },
        },
        {
          action: "updated",
          metadata: { fromStatus: "Draft", toStatus: "Sent" },
        },
        { action: "updated", metadata: {} },
        {
          action: "updated",
          metadata: { fromStatus: "Sent", toStatus: "Accepted" },
        },
        { action: "archived", metadata: {} },
      ]),
    );
    expect(archived.data).toMatchObject({ status: "Accepted" });
    const applicationAfter = await getRecord(owner, "applications", app.id);
    expect(applicationAfter.data).toEqual(applicationBefore.data);
    expect(applicationAfter.data).toMatchObject({ stage: "Offer" });
    expect(applicationAfter.version).toBe(applicationBefore.version);
    expect(applicationAfter.updatedAt).toBe(applicationBefore.updatedAt);
    expect(await applicationEvents()).toBe(eventsBefore);
  });

  it("refuses archived roles as new vacancy references but keeps an unchanged one editable", async () => {
    const archivedRole = await createRecord(owner, "job-roles", {
      data: { title: "Fictional Archived Role" },
    });
    await updateRecord(owner, "job-roles", archivedRole.id, {
      version: archivedRole.version,
      archived: true,
    });
    await expect(
      createRecord(owner, "vacancies", {
        jobRoleId: archivedRole.id,
        data: { title: "Fictional vacancy from an archived role" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "archived_reference" });
    const activeRole = await createRecord(owner, "job-roles", {
      data: { title: "Fictional Active Role" },
    });
    const job = await createRecord(owner, "vacancies", {
      jobRoleId: activeRole.id,
      data: { title: "Fictional vacancy from an active role" },
    });
    await expect(
      updateRecord(owner, "vacancies", job.id, {
        version: job.version,
        jobRoleId: archivedRole.id,
      }),
    ).rejects.toMatchObject({ status: 400, code: "archived_reference" });
    const role = await getRecord(owner, "job-roles", activeRole.id);
    await updateRecord(owner, "job-roles", activeRole.id, {
      version: role.version,
      archived: true,
    });
    const edited = await updateRecord(owner, "vacancies", job.id, {
      version: job.version,
      jobRoleId: activeRole.id,
      data: { openings: 2 },
    });
    expect(edited).toMatchObject({
      jobRoleId: activeRole.id,
      version: job.version + 1,
      data: { openings: 2 },
    });
  });

  it("leaves applications untouched when a vacancy status changes", async () => {
    const job = await vacancy("Fictional status vacancy");
    const apps = [];
    for (const [name, stage] of [
      ["Fictional Status Person One", "Screening"],
      ["Fictional Status Person Two", "Interview"],
    ])
      apps.push(
        await createRecord(owner, "applications", {
          candidateId: (await candidate(name)).id,
          vacancyId: job.id,
          data: { stage },
        }),
      );
    const events = () =>
      withTeam(
        owner,
        async (tx) =>
          (
            await tx
              .select({ total: count() })
              .from(activity)
              .where(
                and(
                  eq(activity.teamId, owner.teamId),
                  eq(activity.kind, "application"),
                ),
              )
          )[0].total,
      );
    const before = await Promise.all(
      apps.map((app) => getRecord(owner, "applications", app.id)),
    );
    const eventsBefore = await events();
    let current = job;
    for (const status of ["Closed", "Filled"])
      current = await updateRecord(owner, "vacancies", job.id, {
        version: current.version,
        data: { status },
      });
    expect(current.data).toMatchObject({ status: "Filled" });
    const after = await Promise.all(
      apps.map((app) => getRecord(owner, "applications", app.id)),
    );
    for (const [index, row] of after.entries()) {
      expect(row.data).toEqual(before[index].data);
      expect(row.version).toBe(before[index].version);
      expect(row.updatedAt).toBe(before[index].updatedAt);
    }
    expect(await events()).toBe(eventsBefore);
  });

  it("lists a candidate's interviews, offers and onboarding through their applications", async () => {
    const personA = await candidate("Fictional Profile Person A");
    const personB = await candidate("Fictional Profile Person B");
    const jobs = [
      await vacancy("Fictional profile vacancy one"),
      await vacancy("Fictional profile vacancy two"),
    ];
    const application = (candidateId: string, vacancyId: string) =>
      createRecord(owner, "applications", {
        candidateId,
        vacancyId,
        data: { stage: "Interview" },
      });
    const appsA = [
      await application(personA.id, jobs[0].id),
      await application(personA.id, jobs[1].id),
    ];
    const appB = await application(personB.id, jobs[0].id);
    const linked = async (applicationId: string) => ({
      interview: await createRecord(owner, "interviews", {
        applicationId,
        data: {
          title: "Fictional profile interview",
          startAt: "2026-12-01T09:00:00+04:00",
        },
      }),
      offer: await createRecord(owner, "offers", {
        applicationId,
        data: { title: "Fictional profile offer" },
      }),
      onboarding: await createRecord(owner, "onboarding", {
        applicationId,
        data: {},
      }),
    });
    const forA = [await linked(appsA[0].id), await linked(appsA[1].id)];
    await linked(appB.id);
    for (const [resource, key] of [
      ["interviews", "interview"],
      ["offers", "offer"],
      ["onboarding", "onboarding"],
    ] as const) {
      const listed = await listRecords(
        owner,
        resource,
        new URLSearchParams({ applicationCandidateId: personA.id }),
      );
      expect(listed.data.map((row) => row.id).sort()).toEqual(
        forA.map((item) => item[key].id).sort(),
      );
    }
    await expect(
      listRecords(
        owner,
        "tasks",
        new URLSearchParams({ applicationCandidateId: personA.id }),
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
    await expect(
      listRecords(
        owner,
        "offers",
        new URLSearchParams({ applicationCandidateId: "not-a-record-id" }),
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
    expect(
      (
        await listRecords(
          other,
          "offers",
          new URLSearchParams({ applicationCandidateId: personA.id }),
        )
      ).data,
    ).toEqual([]);
  });

  it("returns exactly the interviews the calendar places on one Dubai day", async () => {
    const person = await candidate("Fictional Calendar Person");
    const job = await vacancy("Fictional calendar vacancy");
    const app = await createRecord(owner, "applications", {
      candidateId: person.id,
      vacancyId: job.id,
      data: { stage: "Interview" },
    });
    const ids: Record<string, string> = {};
    for (const startAt of [
      "2027-03-09T19:59:59Z",
      "2027-03-09T20:00:00Z",
      "2027-03-10T12:00:00Z",
      "2027-03-10T19:59:59Z",
      "2027-03-10T20:00:00Z",
    ])
      ids[startAt] = (
        await createRecord(owner, "interviews", {
          applicationId: app.id,
          data: { title: `Fictional interview ${startAt}`, startAt },
        })
      ).id;
    const all = await listRecords(
      owner,
      "interviews",
      new URLSearchParams({ applicationId: app.id }),
    );
    const listed = await listRecords(
      owner,
      "interviews",
      new URLSearchParams({
        startFrom: "2027-03-10T00:00:00+04:00",
        startTo: "2027-03-11T00:00:00+04:00",
        pageSize: "100",
      }),
    );
    const placed = interviewsOnDay(all.data, "2027-03-10")
      .map((row) => row.id)
      .sort();
    expect(placed).toEqual(
      [
        ids["2027-03-09T20:00:00Z"],
        ids["2027-03-10T12:00:00Z"],
        ids["2027-03-10T19:59:59Z"],
      ].sort(),
    );
    expect(listed.data.map((row) => row.id).sort()).toEqual(placed);
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

  it("matches skills and certifications ignoring case and surrounding spaces, all of them", async () => {
    const tag = randomUUID().slice(0, 8);
    const make = (name: string, data: Record<string, unknown>) =>
      createRecord(owner, "candidates", {
        data: { name: `Fictional Case ${tag} ${name}`, ...data },
      });
    const first = await make("First", {
      skills: ["React", "TypeScript"],
      certifications: ["Fictional PMP", "Fictional CPA"],
    });
    const second = await make("Second", {
      skills: [" react "],
      certifications: [" fictional pmp "],
    });
    const third = await make("Third", {
      skills: ["REACT", "Go"],
      certifications: ["FICTIONAL PMP", "Fictional ACCA"],
    });
    const none = await make("None", {});
    const broken = await make("Broken", {});
    // Trimmed on write; the case is kept as typed.
    expect(second.data).toMatchObject({
      skills: ["react"],
      certifications: ["fictional pmp"],
    });
    // A non-array value written below the service must neither match nor break the query.
    await withTeam(owner, (tx) =>
      tx
        .update(records)
        .set({
          data: sql`${records.data} || '{"skills":"React","certifications":{"name":"Fictional PMP"}}'::jsonb`,
        })
        .where(eq(records.id, broken.id)),
    );
    const query = (filters: Record<string, string>) =>
      new URLSearchParams({
        search: `"Fictional Case ${tag}"`,
        pageSize: "100",
        ...filters,
      });
    const ids = async (filters: Record<string, string>) =>
      (await listRecords(owner, "candidates", query(filters))).data
        .map((row) => row.id)
        .sort();
    const three = [first.id, second.id, third.id].sort();
    for (const value of ["react", "REACT ", "React"])
      expect(await ids({ skills: JSON.stringify([value]) }), value).toEqual(
        three,
      );
    expect(
      await ids({ skills: JSON.stringify(["react", "typescript"]) }),
    ).toEqual([first.id]);
    for (const value of ["fictional pmp", "FICTIONAL PMP ", "Fictional PMP"])
      expect(
        await ids({ certifications: JSON.stringify([value]) }),
        value,
      ).toEqual(three);
    expect(
      await ids({
        certifications: JSON.stringify(["fictional pmp", "FICTIONAL CPA"]),
      }),
    ).toEqual([first.id]);
    expect(
      await ids({
        skills: JSON.stringify(["react"]),
        certifications: JSON.stringify(["fictional acca"]),
      }),
    ).toEqual([third.id]);
    for (const key of ["skills", "certifications"]) {
      const all = await ids({ [key]: JSON.stringify(["Fictional nowhere"]) });
      expect(all).toEqual([]);
      expect(await ids({ [key]: JSON.stringify(["react", "pmp"]) })).toEqual(
        [],
      );
    }
    expect(await ids({})).toContain(none.id);
    expect(await ids({})).toContain(broken.id);
    // Empty values are still refused, and the bounds and error codes are unchanged.
    for (const invalid of [
      JSON.stringify(["  "]),
      JSON.stringify(Array.from({ length: 101 }, (_, i) => `Skill ${i}`)),
      JSON.stringify(["x".repeat(201)]),
    ])
      await expect(
        listRecords(owner, "candidates", query({ skills: invalid })),
      ).rejects.toMatchObject({ status: 400, code: "invalid_input" });
    await expect(
      listRecords(owner, "candidates", query({ certifications: "react" })),
    ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
    // Folder categories keep their exact "any of" match.
    await make("Category", { folderCategories: ["Fictional Ops"] });
    expect(
      await ids({ categories: JSON.stringify(["fictional ops"]) }),
    ).toEqual([]);

    // A saved view stored in any case lists the same candidates, applied as the screen applies it.
    const view = await createRecord(owner, "views", {
      data: {
        name: `Fictional case view ${tag}`,
        area: "directory",
        query: {
          search: `"Fictional Case ${tag}"`,
          skills: ["react"],
          certifications: ["FICTIONAL pmp"],
        },
      },
    });
    const stored = (await getRecord(owner, "views", view.id)).data as {
      query: Record<string, unknown>;
    };
    expect(stored.query).toMatchObject({
      skills: ["react"],
      certifications: ["FICTIONAL pmp"],
    });
    const params = listSearchParams("candidates", {
      ...defaultListQuery("candidates"),
      search: String(stored.query.search),
      skills: (stored.query.skills as unknown[]).map(String),
      certifications: (stored.query.certifications as unknown[]).map(String),
      pageSize: 100,
    });
    expect(
      (await listRecords(owner, "candidates", params)).data
        .map((row) => row.id)
        .sort(),
    ).toEqual(three);

    // The export shares the filter and names only the filter keys in its audit row.
    const exported = await exportRecords(
      owner,
      "candidates",
      new URLSearchParams({
        search: `"Fictional Case ${tag}"`,
        skills: JSON.stringify(["react"]),
      }),
    );
    expect(exported.rows.map((row) => row.id).sort()).toEqual(three);
    const [audit] = await withTeam(owner, (tx) =>
      tx
        .select({ metadata: activity.metadata })
        .from(activity)
        .where(
          and(eq(activity.teamId, owner.teamId), eq(activity.kind, "export")),
        )
        .orderBy(sql`${activity.createdAt} desc`)
        .limit(1),
    );
    expect(audit.metadata).toEqual({
      resource: "candidates",
      rows: 3,
      filters: ["search", "skills"],
    });
  });

  it("suggests the team's skills and certifications, one entry per case variant", async () => {
    const make = (data: Record<string, unknown>, p = suggesting) =>
      createRecord(p, "candidates", {
        data: { name: "Fictional Suggestion Person", ...data },
      });
    await make({ skills: ["React", "TypeScript"], certifications: ["PMP"] });
    await make({ skills: [" react "], certifications: ["pmp"] });
    await make({ skills: ["REACT", "Go"], certifications: ["Pmp"] });
    await make({ skills: ["React"], certifications: ["Fictional CIPD"] });
    const archived = await make({
      skills: ["Fictional archived skill"],
      certifications: ["Fictional archived certificate"],
    });
    await updateRecord(suggesting, "candidates", archived.id, {
      version: archived.version,
      archived: true,
    });
    await make({ skills: ["Fictional other team skill"] }, other);
    const first = await candidateSuggestions(suggesting, new URLSearchParams());
    // Most candidates first, then alphabetically; "React" is the most common spelling.
    expect(first).toEqual({
      skills: ["React", "Go", "TypeScript"],
      certifications: ["PMP", "Fictional CIPD"],
    });
    // Each list stops at 200 entries.
    for (let start = 0; start < 300; start += 100)
      await make({
        skills: Array.from(
          { length: 100 },
          (_, i) => `Fictional skill ${String(start + i).padStart(3, "0")}`,
        ),
      });
    const capped = await candidateSuggestions(
      suggesting,
      new URLSearchParams(),
    );
    // React (4 candidates) first; the one-candidate values follow alphabetically, so Go and
    // TypeScript fall after the 200th entry.
    expect(capped.skills).toHaveLength(200);
    expect(capped.skills[0]).toBe("React");
    expect(capped.skills[1]).toBe("Fictional skill 000");
    expect(capped.skills[199]).toBe("Fictional skill 198");
    expect(capped.skills).not.toContain("Fictional archived skill");
    expect(capped.skills).not.toContain("Fictional other team skill");
    expect(capped.certifications).toEqual(["PMP", "Fictional CIPD"]);
    await expect(
      candidateSuggestions(
        { ...suggesting, scopes: ["recruitment:read"] },
        new URLSearchParams(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      candidateSuggestions(suggesting, new URLSearchParams({ field: "x" })),
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
    const [stored] = await withTeam(token, (tx) =>
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

  // R2a-19: a cached response belongs to the role version it was composed under.
  it("returns the current, redacted state on a replay after the member's role changes", async () => {
    const recruiter = await seedIdentity(fixture.db, {
      userId: "replay-recruiter",
      role: "recruiter",
    });
    const payload = {
      data: {
        name: "Fictional Role Replay Person",
        email: "role.replay@example.test",
      },
    };
    const key = "fictional-role-replay";
    const stored = () =>
      withTeam(recruiter, (tx) =>
        tx
          .select()
          .from(idempotency)
          .where(
            and(
              eq(idempotency.teamId, recruiter.teamId),
              eq(idempotency.key, key),
            ),
          ),
      );
    const first = await createRecord(recruiter, "candidates", payload, key);
    expect(first.data).toMatchObject({ email: "role.replay@example.test" });
    expect((await stored())[0].roleVersionId).toBe(RECRUITER_ROLE.versionId);
    await updateRecord(owner, "candidates", first.id, {
      version: 1,
      data: { jobTitle: "Fictional role replay edit" },
    });
    // The same role version: the cached body, without the later edit.
    expect(await createRecord(recruiter, "candidates", payload, key)).toEqual(
      first,
    );
    const { body } = RECRUITER_ROLE;
    const narrowed = await createConfigDraft(owner, {
      type: "role",
      key: "replay-narrowed-recruiter",
      body: {
        ...structuredClone(body),
        name: "Fictional narrowed recruiter",
        fields: {
          ...structuredClone(body.fields),
          candidate: { ...body.fields.candidate, email: "hidden" },
        },
      } as RoleBody,
    });
    await publishConfigVersion(owner, narrowed.versionId);
    await assignMemberRole(
      owner,
      { userId: recruiter.userId, roleObjectId: narrowed.objectId },
      new Headers(),
    );
    const replay = await createRecord(recruiter, "candidates", payload, key);
    expect(replay.id).toBe(first.id);
    expect(replay.version).toBe(2);
    expect(replay.data).toMatchObject({
      jobTitle: "Fictional role replay edit",
    });
    expect(replay.data).not.toHaveProperty("email");
    expect(JSON.stringify(replay)).not.toContain("role.replay@example.test");
    const [row] = await stored();
    expect(row.roleVersionId).toBe(narrowed.versionId);
    expect(row.response).toEqual(JSON.parse(JSON.stringify(replay)));
    // The same version again: the renewed cached body.
    expect(await createRecord(recruiter, "candidates", payload, key)).toEqual(
      replay,
    );
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

  it("hides comments on candidates without candidates:read and needs candidates:write to add one", async () => {
    const person = await candidate("Fictional Hidden Comment Person");
    const job = await vacancy("Fictional Visible Comment Vacancy");
    const onPerson = await createRecord(owner, "comments", {
      parentRecordId: person.id,
      data: { body: "Fictional candidate note" },
    });
    const onJob = await createRecord(owner, "comments", {
      parentRecordId: job.id,
      data: { body: "Fictional vacancy note" },
    });
    const recruitment = await seedApiToken(fixture.db, owner, [
      "recruitment:read",
      "recruitment:write",
    ]);
    const page = new URLSearchParams({ pageSize: "100" });
    const all = await listRecords(owner, "comments", page);
    const hidden = await withTeam(owner, async (tx) =>
      Number(
        (
          await tx.execute<{ n: string }>(
            sql`select count(*) as n from app.records c join app.records parent on parent.team_id=c.team_id and parent.id=c.parent_record_id where c.team_id=${owner.teamId} and c.kind='comment' and c.archived_at is null and parent.kind='candidate'`,
          )
        ).rows[0].n,
      ),
    );
    expect(hidden).toBeGreaterThan(0);
    const visible = await listRecords(recruitment, "comments", page);
    const ids = visible.data.map((row) => row.id);
    expect(ids).toContain(onJob.id);
    expect(ids).not.toContain(onPerson.id);
    expect(visible.pagination.total).toBe(all.pagination.total - hidden);
    expect(
      await listRecords(
        recruitment,
        "comments",
        new URLSearchParams({ parentRecordId: person.id }),
      ),
    ).toMatchObject({ data: [], pagination: { total: 0 } });
    await expect(
      getRecord(recruitment, "comments", onPerson.id),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect((await getRecord(recruitment, "comments", onJob.id)).id).toBe(
      onJob.id,
    );
    const refusal = (parentRecordId: string, p = recruitment) =>
      createRecord(p, "comments", {
        parentRecordId,
        data: { body: "Fictional refused note" },
      }).then(
        () => null,
        (error: { status: number; code: string; message: string }) => ({
          status: error.status,
          code: error.code,
          message: error.message,
        }),
      );
    const missing = await refusal(randomUUID());
    expect(missing).toMatchObject({ status: 400, code: "invalid_reference" });
    expect(await refusal(person.id)).toEqual(missing);
    const reader = await seedApiToken(fixture.db, owner, [
      "recruitment:read",
      "recruitment:write",
      "candidates:read",
    ]);
    expect(await refusal(person.id, reader)).toMatchObject({ status: 403 });
    expect(
      (
        await createRecord(recruitment, "comments", {
          parentRecordId: job.id,
          data: { body: "Fictional vacancy follow-up" },
        })
      ).parentRecordId,
    ).toBe(job.id);
    const writer = await seedApiToken(fixture.db, owner, [
      "recruitment:write",
      "candidates:read",
      "candidates:write",
    ]);
    expect(
      (
        await createRecord(writer, "comments", {
          parentRecordId: person.id,
          data: { body: "Fictional permitted note" },
        })
      ).parentRecordId,
    ).toBe(person.id);
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
    expect(app).toMatchObject({
      candidateLabel: "FictionalUniqueLinkPerson",
      vacancyLabel: "FictionalUniqueLinkVacancy",
    });
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
    const limited = await getRecord(token, "applications", app.id);
    expect(limited.label).not.toContain("FictionalUniqueLinkPerson");
    expect(limited).not.toHaveProperty("candidateLabel");
    expect(limited.vacancyLabel).toBe("FictionalUniqueLinkVacancy");
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
    // The list carries the same labels; an archived parent says so.
    await updateRecord(owner, "vacancies", job.id, {
      version: job.version,
      archived: true,
    });
    const [listed] = (
      await listRecords(
        owner,
        "applications",
        new URLSearchParams({ candidateId: person.id }),
      )
    ).data;
    expect(listed).toMatchObject({
      id: app.id,
      candidateLabel: "FictionalUniqueLinkPerson",
      vacancyLabel: "FictionalUniqueLinkVacancy (archived)",
    });
  });

  it("supports bounded saved-view tag and review filters while protecting source provenance", async () => {
    const person = await createRecord(owner, "candidates", {
      data: {
        name: "Fictional TagFilter Person",
        folderCategories: ["Engineering", "Operations"],
        skills: ["TypeScript", "Security"],
        reviewStatus: "Reviewed",
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
    const reviewed = await listRecords(
      owner,
      "candidates",
      new URLSearchParams({ reviewStatus: "Reviewed", pageSize: "100" }),
    );
    expect(reviewed.data.map((row) => row.id)).toContain(person.id);
    expect(
      reviewed.data.every(
        (row) =>
          (row as RecordDto<"candidate">).data.reviewStatus === "Reviewed",
      ),
    ).toBe(true);
    expect(
      (
        await listRecords(
          owner,
          "candidates",
          new URLSearchParams({
            reviewStatus: "Needs review",
            pageSize: "100",
          }),
        )
      ).data.map((row) => row.id),
    ).not.toContain(person.id);
    for (const value of ["Verified", "reviewed", "Pending HR"])
      await expect(
        listRecords(
          owner,
          "candidates",
          new URLSearchParams({ reviewStatus: value }),
        ),
      ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
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

  it("refuses a caller without permission before it validates the input", async () => {
    const person = await candidate("Fictional Refusal Order Person");
    await expect(
      createRecord(viewer, "candidates", { data: { name: "" }, extra: true }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(
      getRecord(
        { ...owner, scopes: ["recruitment:read"] },
        "candidates",
        "not-a-record-id",
      ),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(
      updateRecord(viewer, "comments", person.id, { version: 1, data: {} }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    const reader = await seedApiToken(fixture.db, owner, ["candidates:read"]);
    await expect(
      updateCandidateState(reader, person.id, { version: "one", note: 42 }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  // Team tasks (R2a-20, job 062): assignees as assignment rows, links to the allowed kinds and the
  // Assigned to me filter, in a team of their own.
  describe("team tasks", () => {
    let todo: RecordDto;
    beforeAll(async () => {
      [todo] = (await bootstrapTeam(lead)).data;
    });
    const task = (
      data: Record<string, unknown>,
      references: Record<string, unknown> = {},
    ) =>
      createRecord(lead, "tasks", { bucketId: todo.id, ...references, data });
    const assignees = (recordId: string) =>
      withTeam(lead, (tx) =>
        tx
          .select({
            userId: recordAssignments.userId,
            relation: recordAssignments.relation,
          })
          .from(recordAssignments)
          .where(eq(recordAssignments.recordId, recordId))
          .orderBy(recordAssignments.userId, recordAssignments.relation),
      );
    const stored = (ids: string[]) =>
      withTeam(lead, (tx) =>
        tx
          .select()
          .from(records)
          .where(inArray(records.id, ids))
          .orderBy(records.id),
      );
    const events = async (recordId: string) =>
      (
        await withTeam(lead, (tx) =>
          tx
            .select({ action: activity.action, metadata: activity.metadata })
            .from(activity)
            .where(
              and(
                eq(activity.recordId, recordId),
                eq(activity.kind, "assignment"),
              ),
            ),
        )
      )
        .map((row) => `${row.action}:${String(row.metadata.userId)}`)
        .sort();
    const assigned = (...people: Principal[]) =>
      people.map((person) => ({ userId: person.userId, relation: "assignee" }));

    it("leaves existing tasks, buckets and task fields untouched when they are read", async () => {
      const field = await createRecord(lead, "task-fields", {
        data: { name: "Fictional effort", type: "Number" },
      });
      // A task row as written before R2a-20, straight into the table.
      const existingId = randomUUID();
      await withTeam(lead, (tx) =>
        tx.insert(records).values({
          id: existingId,
          teamId: lead.teamId,
          kind: "task",
          bucketId: todo.id,
          data: {
            title: "Fictional existing task",
            context: "",
            owner: "Fictional owner label",
            dueDate: "",
            priority: "Normal",
            description: "",
            customValues: { [field.id]: 3 },
          },
          createdBy: lead.userId,
        }),
      );
      const ids = [existingId, todo.id, field.id];
      const before = await stored(ids);
      expect(before).toHaveLength(3);
      for (const resource of ["tasks", "buckets", "task-fields"] as const)
        await listRecords(lead, resource, new URLSearchParams());
      const read = await getRecord(lead, "tasks", existingId);
      expect(read.data).toMatchObject({
        owner: "Fictional owner label",
        customValues: { [field.id]: 3 },
        assigneeIds: [],
      });
      expect(read).not.toHaveProperty("parentKind");
      await getRecord(lead, "buckets", todo.id);
      await getRecord(lead, "task-fields", field.id);
      // Id, version, updated_at, data (customValues keys included) and the completed flag.
      expect(await stored(ids)).toEqual(before);
      for (const row of before)
        expect(row.data).not.toHaveProperty("assigneeIds");
    });

    it("stores assignees as assignment rows, never in data, and changes only the difference", async () => {
      const [a, b, c] = [memberA.userId, memberB.userId, memberC.userId];
      const created = await task({
        title: "Fictional assigned task",
        assigneeIds: [b, a],
      });
      expect(created.data).toMatchObject({ assigneeIds: [a, b] });
      expect(await assignees(created.id)).toEqual(assigned(memberA, memberB));
      expect((await stored([created.id]))[0].data).not.toHaveProperty(
        "assigneeIds",
      );
      expect((await getRecord(lead, "tasks", created.id)).data).toMatchObject({
        assigneeIds: [a, b],
      });

      const swapped = await updateRecord(lead, "tasks", created.id, {
        version: created.version,
        data: { assigneeIds: [c, a] },
      });
      expect(swapped.data).toMatchObject({ assigneeIds: [a, c] });
      expect(await assignees(created.id)).toEqual(assigned(memberA, memberC));
      expect(await events(created.id)).toEqual([
        `assignment.added:${a}`,
        `assignment.added:${b}`,
        `assignment.added:${c}`,
        `assignment.removed:${b}`,
      ]);

      // Without assigneeIds, or with the same set, no assignment changes.
      const edited = await updateRecord(lead, "tasks", created.id, {
        version: swapped.version,
        data: { priority: "High" },
      });
      expect(edited.data).toMatchObject({
        priority: "High",
        assigneeIds: [a, c],
      });
      const same = await updateRecord(lead, "tasks", created.id, {
        version: edited.version,
        data: { assigneeIds: [c, a] },
      });
      expect(await events(created.id)).toHaveLength(4);
      expect(await assignees(created.id)).toEqual(assigned(memberA, memberC));

      // Another relation is neither touched nor read as an assignee.
      await addAssignment(lead, {
        recordId: created.id,
        userId: b,
        relation: "interviewer",
      });
      const cleared = await updateRecord(lead, "tasks", created.id, {
        version: same.version,
        data: { assigneeIds: [] },
      });
      expect(cleared.data).toMatchObject({ assigneeIds: [] });
      expect(await assignees(created.id)).toEqual([
        { userId: b, relation: "interviewer" },
      ]);
      expect((await getRecord(lead, "tasks", created.id)).data).toMatchObject({
        assigneeIds: [],
      });
      expect((await stored([created.id]))[0].data).not.toHaveProperty(
        "assigneeIds",
      );
    });

    it("refuses more than ten, repeated or non-member assignees and rolls back the whole write", async () => {
      const a = memberA.userId;
      const title = "Fictional refused task";
      const refusedTasks = () =>
        withTeam(lead, (tx) =>
          tx
            .select({ id: records.id })
            .from(records)
            .where(
              and(
                eq(records.kind, "task"),
                sql`${records.data}->>'title' = ${title}`,
              ),
            ),
        );
      await expect(
        task({
          title,
          assigneeIds: Array.from(
            { length: 11 },
            (_, index) => `fictional-user-${index}`,
          ),
        }),
      ).rejects.toMatchObject({ status: 400, code: "invalid_input" });
      await expect(task({ title, assigneeIds: [a, a] })).rejects.toMatchObject({
        status: 400,
        code: "invalid_input",
      });
      await expect(
        task({ title, assigneeIds: [a, other.userId] }),
      ).rejects.toMatchObject({
        status: 400,
        code: "invalid_assignee",
        message: "assigneeIds: choose members of this team.",
      });
      expect(await refusedTasks()).toEqual([]);

      const kept = await task({
        title: "Fictional kept task",
        assigneeIds: [a],
      });
      await expect(
        updateRecord(lead, "tasks", kept.id, {
          version: kept.version,
          data: {
            title: "Fictional changed task",
            assigneeIds: [a, other.userId],
          },
        }),
      ).rejects.toMatchObject({ status: 400, code: "invalid_assignee" });
      expect(await getRecord(lead, "tasks", kept.id)).toMatchObject({
        version: kept.version,
        data: { title: "Fictional kept task", assigneeIds: [a] },
      });
      expect(await assignees(kept.id)).toEqual(assigned(memberA));
      expect(await events(kept.id)).toEqual([`assignment.added:${a}`]);
    });

    it("links a task to each kind of TASK_LINK_KINDS and refuses every other kind with one message", async () => {
      expect(TASK_LINK_KINDS).toEqual([
        "job-role",
        "vacancy",
        "bucket",
        "task-field",
        "task",
      ]);
      const role = await createRecord(lead, "job-roles", {
        data: { title: "Fictional linked role" },
      });
      const job = await vacancy("Fictional linked vacancy", lead);
      const field = await createRecord(lead, "task-fields", {
        data: { name: "Fictional linked field" },
      });
      const parent = await task({ title: "Fictional parent task" });
      for (const [record, kind, label] of [
        [role, "job-role", "Fictional linked role"],
        [job, "vacancy", "Fictional linked vacancy"],
        [todo, "bucket", "To do"],
        [field, "task-field", "Fictional linked field"],
        [parent, "task", "Fictional parent task"],
      ] as const) {
        const linked = await task(
          { title: `Fictional task linked to a ${kind}` },
          { parentRecordId: record.id },
        );
        const expected = {
          parentRecordId: record.id,
          parentKind: kind,
          parentLabel: label,
        };
        expect(linked).toMatchObject(expected);
        expect(await getRecord(lead, "tasks", linked.id)).toMatchObject(
          expected,
        );
      }

      const moving = await task({ title: "Fictional relinked task" });
      expect(moving).not.toHaveProperty("parentKind");
      const toRole = await updateRecord(lead, "tasks", moving.id, {
        version: moving.version,
        parentRecordId: role.id,
      });
      expect(toRole).toMatchObject({
        parentKind: "job-role",
        parentLabel: "Fictional linked role",
      });
      await updateRecord(lead, "job-roles", role.id, {
        version: role.version,
        archived: true,
      });
      expect(await getRecord(lead, "tasks", moving.id)).toMatchObject({
        parentLabel: "Fictional linked role (archived)",
      });
      await expect(
        task({ title: "Fictional archived link" }, { parentRecordId: role.id }),
      ).rejects.toMatchObject({ status: 400, code: "archived_reference" });
      const unlinked = await updateRecord(lead, "tasks", moving.id, {
        version: toRole.version,
        parentRecordId: null,
      });
      expect(unlinked.parentRecordId).toBeNull();
      expect(unlinked).not.toHaveProperty("parentKind");
      expect(unlinked).not.toHaveProperty("parentLabel");

      // Saved views, comments, another team's record, the task itself, a missing record and, under
      // option B, every kind candidate erasure deletes: one message for all.
      const person = await candidate("Fictional Unlinkable Person", lead);
      const application = await createRecord(lead, "applications", {
        candidateId: person.id,
        vacancyId: job.id,
        data: {},
      });
      const interview = await createRecord(lead, "interviews", {
        applicationId: application.id,
        data: {
          title: "Fictional unlinkable interview",
          startAt: "2026-12-01T09:00:00+04:00",
        },
      });
      const offer = await createRecord(lead, "offers", {
        applicationId: application.id,
        data: { title: "Fictional unlinkable offer" },
      });
      const onboarding = await createRecord(lead, "onboarding", {
        applicationId: application.id,
        data: {},
      });
      const item = await createRecord(lead, "checklist", {
        onboardingId: onboarding.id,
        data: { title: "Fictional unlinkable item" },
      });
      const view = await createRecord(lead, "views", {
        data: {
          name: "Fictional unlinkable view",
          area: "applications",
          query: {},
        },
      });
      const comment = await createRecord(lead, "comments", {
        parentRecordId: job.id,
        data: { body: "Fictional unlinkable comment" },
      });
      const foreign = await vacancy("Fictional foreign link vacancy", other);
      const refused = {
        status: 400,
        code: "invalid_reference",
        message:
          "parentRecordId does not reference the expected record in this team.",
      };
      for (const record of [
        view,
        comment,
        foreign,
        person,
        application,
        interview,
        offer,
        onboarding,
        item,
      ])
        await expect(
          task(
            { title: `Fictional refused ${record.kind} link` },
            { parentRecordId: record.id },
          ),
        ).rejects.toMatchObject(refused);
      for (const parentRecordId of [unlinked.id, randomUUID()])
        await expect(
          updateRecord(lead, "tasks", unlinked.id, {
            version: unlinked.version,
            parentRecordId,
          }),
        ).rejects.toMatchObject(refused);
    });

    it("lists the caller's assigned tasks with assignedToMe, on the task list only", async () => {
      const mine = await task({
        title: "Fictional task for member A",
        assigneeIds: [memberA.userId],
      });
      const theirs = await task({
        title: "Fictional task for member B",
        assigneeIds: [memberB.userId],
      });
      const page = (query: Record<string, string>) =>
        listRecords(
          memberA,
          "tasks",
          new URLSearchParams({ pageSize: "100", ...query }),
        );
      const all = (await page({})).data;
      const expected = all
        .filter((row) =>
          (row.data as { assigneeIds: string[] }).assigneeIds.includes(
            memberA.userId,
          ),
        )
        .map((row) => row.id)
        .sort();
      expect(expected).toContain(mine.id);
      const assignedToMe = await page({ assignedToMe: "true" });
      expect(assignedToMe.data.map((row) => row.id).sort()).toEqual(expected);
      expect(assignedToMe.pagination.total).toBe(expected.length);
      const rest = await page({ assignedToMe: "false" });
      expect(rest.pagination.total).toBe(all.length - expected.length);
      expect(rest.data.map((row) => row.id)).toContain(theirs.id);
      expect(rest.data.map((row) => row.id)).not.toContain(mine.id);
      for (const [resource, value] of [
        ["tasks", "maybe"],
        ["candidates", "true"],
      ] as const)
        await expect(
          listRecords(
            memberA,
            resource,
            new URLSearchParams({ assignedToMe: value }),
          ),
        ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
      await expect(
        exportRecords(
          lead,
          "tasks",
          new URLSearchParams({ assignedToMe: "true" }),
        ),
      ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
    });
  });
});

/** Publishes the body as the kind's next current version, as the database owner; its version id. */
async function publishKindSchema(
  fixture: Awaited<ReturnType<typeof createTestDb>>,
  createdBy: string,
  body: KindSchemaBody,
): Promise<string> {
  await fixture.client.exec("RESET ROLE");
  try {
    return await insertKindSchema(fixture.client, createdBy, body);
  } finally {
    await fixture.client.exec("SET ROLE recruitment_test_runtime");
  }
}

// Record pins and custom values (R2b-02, job 067), on a database of their own so the kind schema
// published here reaches no other case.
describe("record pins and custom values with real PostgreSQL migrations and RLS", () => {
  const COMPANY = "00000000-0000-4000-a000-000000000001";
  const PIN_NAMES = [
    "schemaVersionId",
    "typeId",
    "schema_version_id",
    "type_id",
  ];
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal;
  /** Runs fixture setup or inspection as the database owner, outside RLS. */
  const asOwner = async <T>(work: () => Promise<T>): Promise<T> => {
    await fixture.client.exec("RESET ROLE");
    try {
      return await work();
    } finally {
      await fixture.client.exec("SET ROLE recruitment_test_runtime");
    }
  };
  type Stored = {
    kind: string;
    data: Record<string, unknown>;
    schema_version_id: string | null;
    type_id: string | null;
  };
  const stored = (id: string) =>
    asOwner(
      async () =>
        (
          await fixture.client.query<Stored>(
            "SELECT kind, data, schema_version_id::text, type_id::text FROM app.records WHERE id = $1",
            [id],
          )
        ).rows[0],
    );
  const pinOf = async (id: string) => {
    const row = await stored(id);
    return { pin: row.schema_version_id, type: row.type_id };
  };
  /** A REST create or update body never names the pins. */
  const unpinned = (row: RecordDto) => {
    const text = JSON.stringify({ data: row });
    for (const name of PIN_NAMES) expect(text, name).not.toContain(name);
    return row;
  };
  const defaultId = (kind: ConfigurableKind) =>
    DEFAULT_KIND_SCHEMAS[kind].versionId;

  beforeAll(async () => {
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db, {
      userId: "pin-owner",
      teamId: "pin-team",
    });
    await enforceTestRls(fixture.db);
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it("pins a create of each configurable kind to its default version and leaves the other kinds and every type null", async () => {
    const create = async (resource: ResourceName, input: object) =>
      unpinned(await createRecord(owner, resource, input));
    const candidate = await create("candidates", {
      data: { name: "Fictional Pin Candidate" },
    });
    const jobRole = await create("job-roles", {
      data: { title: "Fictional pin role" },
    });
    const vacancy = await create("vacancies", {
      jobRoleId: jobRole.id,
      data: { title: "Fictional pin vacancy" },
    });
    const application = await create("applications", {
      candidateId: candidate.id,
      vacancyId: vacancy.id,
      data: {},
    });
    const bucket = await create("buckets", {
      data: { name: "Fictional pin bucket" },
    });
    const field = await create("task-fields", {
      data: { name: "Fictional pin field" },
    });
    const task = await create("tasks", {
      bucketId: bucket.id,
      data: { title: "Fictional pin task" },
    });
    const interview = await create("interviews", {
      applicationId: application.id,
      data: {
        title: "Fictional pin interview",
        startAt: "2026-11-20T06:00:00.000Z",
      },
    });
    const offer = await create("offers", {
      applicationId: application.id,
      data: { title: "Fictional pin offer" },
    });
    const onboarding = await create("onboarding", {
      applicationId: application.id,
      data: {},
    });
    const checklist = await create("checklist", {
      onboardingId: onboarding.id,
      data: { title: "Fictional pin checklist item" },
    });
    const view = await create("views", {
      data: { name: "Fictional pin view", area: "directory", query: {} },
    });
    const comment = await create("comments", {
      parentRecordId: candidate.id,
      data: { body: "Fictional pin comment" },
    });
    const configurable: [RecordDto, ConfigurableKind][] = [
      [candidate, "candidate"],
      [jobRole, "job-role"],
      [vacancy, "vacancy"],
      [application, "application"],
      [task, "task"],
      [interview, "interview"],
      [offer, "offer"],
      [onboarding, "onboarding"],
      [checklist, "checklist"],
    ];
    for (const [row, kind] of configurable)
      expect(await pinOf(row.id), kind).toEqual({
        pin: defaultId(kind),
        type: null,
      });
    expect(configurable.map(([, kind]) => defaultId(kind))).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
        (n) => `00000000-0000-4000-8000-00000000020${n}`,
      ),
    );
    for (const row of [bucket, field, view, comment])
      expect(await pinOf(row.id), row.kind).toEqual({ pin: null, type: null });
    // An update keeps those kinds unpinned and answers without the pins too.
    const renamed = unpinned(
      await updateRecord(owner, "buckets", bucket.id, {
        version: 1,
        data: { name: "Fictional renamed pin bucket" },
      }),
    );
    expect(renamed.version).toBe(2);
    expect(await pinOf(bucket.id)).toEqual({ pin: null, type: null });
  });

  it("pins creates and re-pins updates to the published kind schema current at the time", async () => {
    const earlier = unpinned(
      await createRecord(owner, "job-roles", {
        data: { title: "Fictional earlier role" },
      }),
    );
    expect(await pinOf(earlier.id)).toEqual({
      pin: defaultId("job-role"),
      type: null,
    });
    // The workspace's published job-role kind schema, written by the owner as an admin writer would.
    const body = structuredClone(DEFAULT_KIND_SCHEMAS["job-role"].body);
    body.fields[1].label = "Fictional business unit";
    const versionId = await asOwner(async () => {
      const objectId = (
        await fixture.client.query<{ id: string }>(
          `INSERT INTO app.config_objects(workspace_id, type, key, created_by) VALUES ('${COMPANY}', 'kind-schema', 'job-role', $1) RETURNING id`,
          [owner.userId],
        )
      ).rows[0].id;
      const id = (
        await fixture.client.query<{ id: string }>(
          `INSERT INTO app.config_versions(object_id, workspace_id, state, number, body, published_at) VALUES ($1, '${COMPANY}', 'published', 1, $2::jsonb, now()) RETURNING id`,
          [objectId, JSON.stringify(body)],
        )
      ).rows[0].id;
      await fixture.client.query(
        "UPDATE app.config_objects SET current_version_id = $1 WHERE id = $2",
        [id, objectId],
      );
      return id;
    });
    const later = unpinned(
      await createRecord(owner, "job-roles", {
        data: { title: "Fictional later role" },
      }),
    );
    expect(await pinOf(later.id)).toEqual({ pin: versionId, type: null });
    const updated = unpinned(
      await updateRecord(owner, "job-roles", earlier.id, {
        version: 1,
        data: { department: "Fictional Analytics" },
      }),
    );
    expect(updated.data).toMatchObject({ department: "Fictional Analytics" });
    expect(await pinOf(earlier.id)).toEqual({ pin: versionId, type: null });
    // Kinds without a published schema keep their default.
    const vacancy = unpinned(
      await createRecord(owner, "vacancies", {
        jobRoleId: later.id,
        data: { title: "Fictional later vacancy" },
      }),
    );
    expect(await pinOf(vacancy.id)).toEqual({
      pin: defaultId("vacancy"),
      type: null,
    });
  });

  it("reads a row written without pins byte for byte as before, and an update adds no customValues", async () => {
    const id = randomUUID();
    await asOwner(() =>
      fixture.client.query(
        `INSERT INTO app.records(id, team_id, kind, data, created_by, created_at, updated_at) VALUES ($1, $2, 'candidate', '{"name":"Fictional Pinless Candidate"}', $3, '2026-01-01T09:00:00Z', '2026-01-01T09:00:00Z')`,
        [id, owner.teamId, owner.userId],
      ),
    );
    expect(await pinOf(id)).toEqual({ pin: null, type: null });
    const search = new URLSearchParams({
      search: '"Fictional Pinless Candidate"',
    });
    const read = async () =>
      JSON.stringify({
        get: { data: await getRecord(owner, "candidates", id) },
        list: await listRecords(owner, "candidates", search),
      });
    const before = await read();
    expect(before).not.toContain("customValues");
    unpinned(
      await createRecord(owner, "candidates", {
        data: { name: "Fictional Unrelated Candidate" },
      }),
    );
    expect(await read()).toBe(before);
    expect(await pinOf(id)).toEqual({ pin: null, type: null });
    const updated = unpinned(
      await updateRecord(owner, "candidates", id, {
        version: 1,
        data: { phone: "+971 50 000 0000" },
      }),
    );
    expect(updated.data).not.toHaveProperty("customValues");
    const row = await stored(id);
    expect(row.data).not.toHaveProperty("customValues");
    expect(row.data).toMatchObject({
      name: "Fictional Pinless Candidate",
      phone: "+971 50 000 0000",
    });
    expect([row.schema_version_id, row.type_id]).toEqual([
      defaultId("candidate"),
      null,
    ]);
  });

  it("round-trips non-task custom values of published fields and refuses anything outside the bounded shape first", async () => {
    const [text, number, flag, empty] = [1, 2, 3, 4].map(() => randomUUID());
    await publishKindSchema(
      fixture,
      owner.userId,
      kindBody("candidate", [
        customField("Fictional note", "short-text", {}, text),
        customField("Fictional score", "number", {}, number),
        customField("Fictional flag", "checkbox", {}, flag),
        customField("Fictional empty", "short-text", {}, empty),
      ]),
    );
    await publishKindSchema(
      fixture,
      owner.userId,
      kindBody("job-role", [
        customField("Fictional role flag", "checkbox", {}, flag),
        customField("Fictional role note", "short-text", {}, text),
      ]),
    );
    const values = {
      [text]: "Fictional custom value",
      [number]: 12.5,
      [flag]: true,
      [empty]: null,
    };
    const person = unpinned(
      await createRecord(owner, "candidates", {
        data: { name: "Fictional Custom Candidate", customValues: values },
      }),
    );
    expect(person.data).toMatchObject({ customValues: values });
    expect(
      (await getRecord(owner, "candidates", person.id)).data,
    ).toMatchObject({ customValues: values });
    expect((await stored(person.id)).data.customValues).toEqual(values);
    // An update without the key keeps the map; one with it replaces the whole map.
    const kept = unpinned(
      await updateRecord(owner, "candidates", person.id, {
        version: 1,
        data: { phone: "+971 50 111 1111" },
      }),
    );
    expect(kept.data).toMatchObject({ customValues: values });
    const replaced = unpinned(
      await updateRecord(owner, "candidates", person.id, {
        version: 2,
        data: { customValues: { [text]: "Fictional replaced value" } },
      }),
    );
    expect((replaced.data as { customValues?: unknown }).customValues).toEqual({
      [text]: "Fictional replaced value",
    });
    const role = unpinned(
      await createRecord(owner, "job-roles", {
        data: {
          title: "Fictional custom role",
          customValues: { [flag]: false },
        },
      }),
    );
    expect(role.data).toMatchObject({ customValues: { [flag]: false } });
    // The strict schema runs first: a value outside the bounded shape is invalid_input, never
    // unknown_custom_field or invalid_custom_value, and so is a system field error beside custom
    // values that would fail later.
    await expect(
      createRecord(owner, "candidates", {
        data: { customValues: { [randomUUID()]: "x", [number]: "x" } },
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_input" });
    const refused = [
      { "not-a-uuid": "Fictional value" },
      { [text]: { nested: "Fictional value" } },
      { [text]: ["Fictional value"] },
      { [text]: "x".repeat(4001) },
      { [text]: Number.POSITIVE_INFINITY },
    ];
    for (const customValues of refused) {
      await expect(
        createRecord(owner, "candidates", {
          data: { name: "Fictional Refused Candidate", customValues },
        }),
      ).rejects.toMatchObject({ status: 400, code: "invalid_input" });
      await expect(
        updateRecord(owner, "job-roles", role.id, {
          version: 1,
          data: { customValues },
        }),
      ).rejects.toMatchObject({ status: 400, code: "invalid_input" });
    }
    // Pins are never taken from input, at the top level or in data.
    for (const input of [
      { schemaVersionId: randomUUID(), data: { title: "Fictional forged" } },
      { typeId: randomUUID(), data: { title: "Fictional forged" } },
      { data: { title: "Fictional forged", schemaVersionId: randomUUID() } },
      { data: { title: "Fictional forged", typeId: randomUUID() } },
    ])
      await expect(
        createRecord(owner, "job-roles", input),
      ).rejects.toMatchObject({ status: 400, code: "invalid_input" });
    expect((await stored(role.id)).data.customValues).toEqual({
      [flag]: false,
    });
  });

  it("hides custom values from a role published before they existed, in a get, a list and a search", async () => {
    const secret = "Fictional confidential custom value";
    const confidential = customField(
      "Fictional confidential note",
      "long-text",
    );
    await publishKindSchema(
      fixture,
      owner.userId,
      kindBody("candidate", [confidential]),
    );
    const person = unpinned(
      await createRecord(owner, "candidates", {
        data: {
          name: "Fictional Restricted Candidate",
          jobTitle: "Fictional analyst",
          customValues: { [confidential.key]: secret },
        },
      }),
    );
    const search = new URLSearchParams({ search: `"${secret}"` });
    // Owner, admin, recruiter and viewer have no field rules, so they keep seeing and finding them.
    expect(
      (await listRecords(owner, "candidates", search)).data.map(
        (row) => row.id,
      ),
    ).toEqual([person.id]);
    // The interviewer template as published before customValues existed: every candidate key but
    // name and job title hidden, and no rule for customValues.
    const candidate = Object.fromEntries(
      Object.entries(INTERVIEWER_ROLE.body.fields.candidate ?? {}).filter(
        ([key]) => key !== "customValues",
      ),
    );
    const earlier = await createConfigDraft(owner, {
      type: "role",
      key: "earlier-interviewer",
      body: {
        ...structuredClone(VIEWER_ROLE.body),
        name: "Fictional earlier interviewer",
        fields: { candidate },
      } as RoleBody,
    });
    await publishConfigVersion(owner, earlier.versionId);
    const member = await seedIdentity(fixture.db, {
      userId: "pin-earlier-interviewer",
      teamId: owner.teamId,
      role: "viewer",
    });
    await assignMemberRole(
      owner,
      { userId: member.userId, roleObjectId: earlier.objectId },
      new Headers(),
    );
    const read = await getRecord(member, "candidates", person.id);
    expect(read.data).toEqual({
      name: "Fictional Restricted Candidate",
      jobTitle: "Fictional analyst",
    });
    const listed = await listRecords(
      member,
      "candidates",
      new URLSearchParams({ search: '"Fictional Restricted Candidate"' }),
    );
    expect(listed.data.map((row) => row.id)).toEqual([person.id]);
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(JSON.stringify(read)).not.toContain(secret);
    expect(await listRecords(member, "candidates", search)).toMatchObject({
      data: [],
      pagination: { total: 0 },
    });
  });

  it("keeps a vacancy without a job title key free of it, and takes only a published title (ADM-24)", async () => {
    const plain = unpinned(
      await createRecord(owner, "vacancies", {
        data: { title: "Fictional untitled-grade vacancy" },
      }),
    );
    expect(plain.data).not.toHaveProperty("jobTitleKey");
    const edited = await updateRecord(owner, "vacancies", plain.id, {
      version: 1,
      data: { status: "Open" },
    });
    expect(edited.data).not.toHaveProperty("jobTitleKey");
    expect((await stored(plain.id)).data).not.toHaveProperty("jobTitleKey");
    expect(
      (await getRecord(owner, "vacancies", plain.id)).data,
    ).not.toHaveProperty("jobTitleKey");
    // No job architecture is published yet, so no key is a title.
    await expect(
      createRecord(owner, "vacancies", {
        data: { title: "Fictional titled vacancy", jobTitleKey: "analyst" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_reference" });
    const draft = await createConfigDraft(owner, {
      type: "job-architecture",
      key: "company",
      body: {
        families: [{ key: "data", name: "Fictional Data" }],
        grades: [{ code: "G6", name: "Fictional Senior", order: 6 }],
        titles: [
          {
            key: "analyst",
            name: "Fictional Analyst",
            familyKey: "data",
            gradeCode: "G6",
          },
        ],
      },
    });
    await publishConfigVersion(owner, draft.versionId);
    const titled = unpinned(
      await createRecord(owner, "vacancies", {
        data: { title: "Fictional titled vacancy", jobTitleKey: "analyst" },
      }),
    );
    expect(titled.data).toMatchObject({ jobTitleKey: "analyst" });
    expect((await stored(titled.id)).data.jobTitleKey).toBe("analyst");
    await expect(
      createRecord(owner, "vacancies", {
        data: { title: "Fictional other vacancy", jobTitleKey: "architect" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_reference" });
    await expect(
      updateRecord(owner, "vacancies", plain.id, {
        version: 2,
        data: { jobTitleKey: "architect" },
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_reference" });
    expect((await stored(plain.id)).data).not.toHaveProperty("jobTitleKey");
  });
});

// Dynamic validation on create and update (R2b-04, job 081), on a database of its own so the kind
// schemas published here reach no other case. Each case publishes the versions it needs first.
describe("dynamic validation of custom values with real PostgreSQL migrations and RLS", () => {
  const UNKNOWN = "A custom field is not available in this team.";
  const PRESERVED = "Archived custom field values must be preserved unchanged.";
  const KEPT = "Archived field values cannot be removed.";
  const options = [
    { id: "opt-1", label: "Fictional first" },
    { id: "opt-2", label: "Fictional second" },
  ];
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal;
  const publish = (body: KindSchemaBody) =>
    publishKindSchema(fixture, owner.userId, body);
  /** The stored row, read as the database owner outside RLS. */
  const stored = async (id: string) => {
    await fixture.client.exec("RESET ROLE");
    try {
      return (
        await fixture.client.query<{
          data: Record<string, unknown>;
          version: number;
          schema_version_id: string | null;
        }>(
          "SELECT data, version, schema_version_id::text FROM app.records WHERE id = $1",
          [id],
        )
      ).rows[0];
    } finally {
      await fixture.client.exec("SET ROLE recruitment_test_runtime");
    }
  };
  const refusal = (code: string, message: string) => ({
    status: 400,
    code,
    message,
  });

  beforeAll(async () => {
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db, {
      userId: "dynamic-owner",
      teamId: "dynamic-team",
    });
    await enforceTestRls(fixture.db);
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it("refuses every custom value on the built-in default schemas as an unknown field", async () => {
    const customValues = { [randomUUID()]: "x" };
    const unknown = refusal("unknown_custom_field", UNKNOWN);
    await expect(
      createRecord(owner, "candidates", {
        data: { name: "Fictional Default Candidate", customValues },
      }),
    ).rejects.toMatchObject(unknown);
    await expect(
      createRecord(owner, "job-roles", {
        data: { title: "Fictional default role", customValues },
      }),
    ).rejects.toMatchObject(unknown);
    const person = await createRecord(owner, "candidates", {
      data: { name: "Fictional Default Candidate" },
    });
    await expect(
      updateRecord(owner, "candidates", person.id, {
        version: 1,
        data: { customValues },
      }),
    ).rejects.toMatchObject(unknown);
    expect((await stored(person.id)).data).not.toHaveProperty("customValues");
  });

  it("checks added and changed custom values on each configurable kind and pins the version", async () => {
    const bucket = await createRecord(owner, "buckets", {
      data: { name: "Fictional dynamic bucket" },
    });
    const vacancy = await createRecord(owner, "vacancies", {
      data: { title: "Fictional dynamic vacancy" },
    });
    const applicant = async () =>
      (
        await createRecord(owner, "candidates", {
          data: { name: "Fictional Dynamic Applicant" },
        })
      ).id;
    const application = async () =>
      (
        await createRecord(owner, "applications", {
          candidateId: await applicant(),
          vacancyId: vacancy.id,
          data: {},
        })
      ).id;
    const parent = await application();
    const onboarding = await createRecord(owner, "onboarding", {
      applicationId: parent,
      data: {},
    });
    // Each kind's create input without custom values; parents are created as needed.
    const inputs: [
      ConfigurableKind,
      ResourceName,
      () => Promise<{ data: Record<string, unknown> }>,
    ][] = [
      [
        "candidate",
        "candidates",
        async () => ({ data: { name: "Fictional Dynamic Candidate" } }),
      ],
      [
        "job-role",
        "job-roles",
        async () => ({ data: { title: "Fictional dynamic role" } }),
      ],
      [
        "vacancy",
        "vacancies",
        async () => ({ data: { title: "Fictional dynamic vacancy" } }),
      ],
      [
        "application",
        "applications",
        async () => ({
          candidateId: await applicant(),
          vacancyId: vacancy.id,
          data: {},
        }),
      ],
      [
        "task",
        "tasks",
        async () => ({
          bucketId: bucket.id,
          data: { title: "Fictional dynamic task" },
        }),
      ],
      [
        "interview",
        "interviews",
        async () => ({
          applicationId: parent,
          data: {
            title: "Fictional dynamic interview",
            startAt: "2026-11-20T06:00:00.000Z",
          },
        }),
      ],
      [
        "offer",
        "offers",
        async () => ({
          applicationId: parent,
          data: { title: "Fictional dynamic offer" },
        }),
      ],
      [
        "onboarding",
        "onboarding",
        async () => ({ applicationId: await application(), data: {} }),
      ],
      [
        "checklist",
        "checklist",
        async () => ({
          onboardingId: onboarding.id,
          data: { title: "Fictional dynamic checklist item" },
        }),
      ],
    ];
    expect(inputs.map(([kind]) => kind)).toEqual([...CONFIGURABLE_KINDS]);
    for (const [kind, resource, input] of inputs) {
      const score = customField(`Fictional ${kind} score`, "number", {
        min: 0,
        max: 10,
      });
      const status = customField(`Fictional ${kind} status`, "dropdown", {
        options,
      });
      const versionId = await publish(kindBody(kind, [score, status]));
      const values = { [score.key]: 7, [status.key]: "opt-1" };
      const { data, ...refs } = await input();
      const created = await createRecord(owner, resource, {
        ...refs,
        data: { ...data, customValues: values },
      });
      expect(created.data, kind).toMatchObject({ customValues: values });
      const before = await stored(created.id);
      expect(before.data.customValues, kind).toEqual(values);
      expect(before.schema_version_id, kind).toBe(versionId);
      for (const [field, value] of [
        [score, "7"],
        [score, 11],
        [score, -1],
        [status, "opt-9"],
        [status, true],
      ] as const)
        await expect(
          updateRecord(owner, resource, created.id, {
            version: 1,
            data: { customValues: { ...values, [field.key]: value } },
          }),
          `${kind} ${String(value)}`,
        ).rejects.toMatchObject(
          refusal("invalid_custom_value", `Invalid value for ${field.label}.`),
        );
      const stranger = { [randomUUID()]: 3 };
      await expect(
        updateRecord(owner, resource, created.id, {
          version: 1,
          data: { customValues: { ...values, ...stranger } },
        }),
        kind,
      ).rejects.toMatchObject(refusal("unknown_custom_field", UNKNOWN));
      const other = await input();
      await expect(
        createRecord(owner, resource, {
          ...other,
          data: { ...other.data, customValues: stranger },
        }),
        kind,
      ).rejects.toMatchObject(refusal("unknown_custom_field", UNKNOWN));
      expect(await stored(created.id), kind).toEqual(before);
    }
  });

  it("keeps an archived field's value and refuses changing, removing or adding one unless imported", async () => {
    const legacy = customField("Fictional legacy code", "short-text");
    const grade = customField("Fictional grade", "number");
    await publish(kindBody("vacancy", [legacy, grade]));
    const held = await createRecord(owner, "vacancies", {
      data: {
        title: "Fictional archived-field vacancy",
        customValues: { [legacy.key]: "Fictional code 7" },
      },
    });
    const plain = await createRecord(owner, "vacancies", {
      data: { title: "Fictional plain vacancy" },
    });
    const archived = await publish(
      kindBody("vacancy", [{ ...legacy, archived: true }, grade]),
    );
    const edited = await updateRecord(owner, "vacancies", held.id, {
      version: 1,
      data: { title: "Fictional renamed vacancy" },
    });
    expect(edited.data).toMatchObject({
      customValues: { [legacy.key]: "Fictional code 7" },
    });
    expect((await stored(held.id)).schema_version_id).toBe(archived);
    // The kept value may be sent again unchanged beside a new one.
    const both = { [legacy.key]: "Fictional code 7", [grade.key]: 4 };
    const added = await updateRecord(owner, "vacancies", held.id, {
      version: 2,
      data: { customValues: both },
    });
    expect(added.data).toMatchObject({ customValues: both });
    for (const value of ["Fictional code 8", null, ""])
      await expect(
        updateRecord(owner, "vacancies", held.id, {
          version: 3,
          data: { customValues: { ...both, [legacy.key]: value } },
        }),
      ).rejects.toMatchObject(refusal("archived_custom_field", PRESERVED));
    await expect(
      updateRecord(owner, "vacancies", held.id, {
        version: 3,
        data: { customValues: { [grade.key]: 4 } },
      }),
    ).rejects.toMatchObject(refusal("archived_custom_field", KEPT));
    await expect(
      updateRecord(owner, "vacancies", plain.id, {
        version: 1,
        data: { customValues: { [legacy.key]: "Fictional code 9" } },
      }),
    ).rejects.toMatchObject(refusal("archived_custom_field", PRESERVED));
    await expect(
      createRecord(owner, "vacancies", {
        data: {
          title: "Fictional new vacancy",
          customValues: { [legacy.key]: "Fictional code 9" },
        },
      }),
    ).rejects.toMatchObject(refusal("archived_custom_field", PRESERVED));
    expect((await stored(held.id)).data.customValues).toEqual(both);
    // An imported write skips only the archived rules, as task imports do.
    const imported = await updateRecord(owner, "vacancies", held.id, {
      version: 3,
      importMeta: { workbook: "Fictional.xlsx" },
      data: {
        customValues: {
          [legacy.key]: "Fictional imported code",
          [grade.key]: 4,
        },
      },
    });
    expect(imported.data).toMatchObject({
      customValues: { [legacy.key]: "Fictional imported code" },
    });
    await expect(
      updateRecord(owner, "vacancies", held.id, {
        version: 4,
        importMeta: { workbook: "Fictional.xlsx" },
        data: { customValues: { [grade.key]: "four" } },
      }),
    ).rejects.toMatchObject(
      refusal("invalid_custom_value", "Invalid value for Fictional grade."),
    );
  });

  it("lets a field made mandatory after the pin stay empty on an unrelated edit, but not be emptied once set", async () => {
    const note = customField("Fictional role note", "short-text");
    await publish(kindBody("job-role", [note]));
    const role = await createRecord(owner, "job-roles", {
      data: { title: "Fictional pinned role" },
    });
    const level = customField("Fictional role level", "dropdown", {
      options,
      required: true,
    });
    const second = await publish(
      kindBody("job-role", [note, level], {
        create: [note.key, level.key],
        edit: [level.key, note.key],
        view: [note.key],
      }),
    );
    const edited = await updateRecord(owner, "job-roles", role.id, {
      version: 1,
      data: { title: "Fictional retitled role" },
    });
    expect(edited.data).toMatchObject({ title: "Fictional retitled role" });
    expect(edited.data).not.toHaveProperty("customValues");
    expect((await stored(role.id)).schema_version_id).toBe(second);
    const required = refusal(
      "required_custom_field",
      "A valid value for Fictional role level is required.",
    );
    for (const customValues of [
      undefined,
      {},
      { [level.key]: null },
      { [level.key]: "" },
      { [note.key]: "Fictional note" },
    ])
      await expect(
        createRecord(owner, "job-roles", {
          data: { title: "Fictional new role", customValues },
        }),
      ).rejects.toMatchObject(required);
    const created = await createRecord(owner, "job-roles", {
      data: {
        title: "Fictional new role",
        customValues: { [level.key]: "opt-1" },
      },
    });
    expect(created.data).toMatchObject({
      customValues: { [level.key]: "opt-1" },
    });
    await updateRecord(owner, "job-roles", role.id, {
      version: 2,
      data: { customValues: { [level.key]: "opt-2" } },
    });
    for (const customValues of [
      { [level.key]: null },
      { [level.key]: "" },
      {},
      { [note.key]: "Fictional note" },
    ])
      await expect(
        updateRecord(owner, "job-roles", role.id, {
          version: 3,
          data: { customValues },
        }),
      ).rejects.toMatchObject(required);
    const noted = await updateRecord(owner, "job-roles", role.id, {
      version: 3,
      data: {
        customValues: { [level.key]: "opt-2", [note.key]: "Fictional note" },
      },
    });
    expect(noted.version).toBe(4);
  });

  it("never checks again a value carried over unchanged from an earlier version", async () => {
    const code = customField("Fictional role code", "short-text", { max: 40 });
    const band = customField("Fictional role band", "number", { max: 100 });
    await publish(kindBody("job-role", [code, band]));
    const values = { [code.key]: "Fictional code value", [band.key]: 90 };
    const role = await createRecord(owner, "job-roles", {
      data: { title: "Fictional carried role", customValues: values },
    });
    // Version 2 drops the code field and tightens the band below the stored value.
    await publish(
      kindBody("job-role", [
        customField(band.label, "number", { max: 10 }, band.key),
      ]),
    );
    const edited = await updateRecord(owner, "job-roles", role.id, {
      version: 1,
      data: { department: "Fictional Carried" },
    });
    expect(edited.data).toMatchObject({ customValues: values });
    const resent = await updateRecord(owner, "job-roles", role.id, {
      version: 2,
      data: { title: "Fictional resent role", customValues: values },
    });
    expect(resent.data).toMatchObject({ customValues: values });
    await expect(
      updateRecord(owner, "job-roles", role.id, {
        version: 3,
        data: { customValues: { ...values, [band.key]: 95 } },
      }),
    ).rejects.toMatchObject(
      refusal("invalid_custom_value", "Invalid value for Fictional role band."),
    );
    await expect(
      updateRecord(owner, "job-roles", role.id, {
        version: 3,
        data: { customValues: { ...values, [code.key]: "Fictional new code" } },
      }),
    ).rejects.toMatchObject(refusal("unknown_custom_field", UNKNOWN));
    // A value of a dropped field may be removed.
    const removed = await updateRecord(owner, "job-roles", role.id, {
      version: 3,
      data: { customValues: { [band.key]: 90 } },
    });
    expect((removed.data as { customValues?: unknown }).customValues).toEqual({
      [band.key]: 90,
    });
  });

  it("checks a task's team task-field values and its central custom values each by their own rules", async () => {
    const bucket = await createRecord(owner, "buckets", {
      data: { name: "Fictional mixed bucket" },
    });
    const team = await createRecord(owner, "task-fields", {
      data: { name: "Fictional team estimate", type: "Number" },
    });
    const central = customField("Fictional central priority", "dropdown", {
      options,
    });
    await publish(kindBody("task", [central]));
    const values = { [team.id]: 3, [central.key]: "opt-1" };
    const task = await createRecord(owner, "tasks", {
      bucketId: bucket.id,
      data: { title: "Fictional mixed task", customValues: values },
    });
    expect(task.data).toMatchObject({ customValues: values });
    const refused: [Record<string, unknown>, object][] = [
      [
        { ...values, [team.id]: "three" },
        refusal(
          "invalid_custom_value",
          "Invalid value for Fictional team estimate.",
        ),
      ],
      [
        { ...values, [central.key]: "opt-9" },
        refusal(
          "invalid_custom_value",
          "Invalid value for Fictional central priority.",
        ),
      ],
      [
        { ...values, [randomUUID()]: 1 },
        refusal("unknown_custom_field", UNKNOWN),
      ],
    ];
    for (const [customValues, error] of refused)
      await expect(
        updateRecord(owner, "tasks", task.id, {
          version: 1,
          data: { customValues },
        }),
      ).rejects.toMatchObject(error);
    // Once the team field is archived its value must stay, while the central value may go.
    await updateRecord(owner, "task-fields", team.id, {
      version: 1,
      archived: true,
    });
    const kept = await updateRecord(owner, "tasks", task.id, {
      version: 1,
      data: { customValues: { [team.id]: 3 } },
    });
    expect((kept.data as { customValues?: unknown }).customValues).toEqual({
      [team.id]: 3,
    });
    await expect(
      updateRecord(owner, "tasks", task.id, {
        version: 2,
        data: { customValues: { [central.key]: "opt-2" } },
      }),
    ).rejects.toMatchObject(refusal("archived_custom_field", KEPT));
  });

  // Last: it leaves the candidate email mandatory for any later case.
  it("refuses a create without a system field made mandatory, and lets an empty one stay empty on edit", async () => {
    const emailless = await createRecord(owner, "candidates", {
      data: { name: "Fictional Emailless Candidate" },
    });
    const emailed = await createRecord(owner, "candidates", {
      data: {
        name: "Fictional Emailed Candidate",
        email: "emailed@example.test",
      },
    });
    const body = kindBody("candidate", []);
    const email = body.fields.find((field) => field.key === "email")!;
    email.required = true;
    await publish(body);
    const required = refusal(
      "invalid_input",
      `email: ${email.label} is required.`,
    );
    for (const data of [
      { name: "Fictional New Candidate" },
      { name: "Fictional New Candidate", email: "" },
    ])
      await expect(
        createRecord(owner, "candidates", { data }),
      ).rejects.toMatchObject(required);
    const created = await createRecord(owner, "candidates", {
      data: { name: "Fictional New Candidate", email: "new@example.test" },
    });
    expect(created.data).toMatchObject({ email: "new@example.test" });
    const edited = await updateRecord(owner, "candidates", emailless.id, {
      version: 1,
      data: { phone: "+971 50 222 2222" },
    });
    expect(edited.data).toMatchObject({
      email: "",
      phone: "+971 50 222 2222",
    });
    await expect(
      updateRecord(owner, "candidates", emailed.id, {
        version: 1,
        data: { email: "" },
      }),
    ).rejects.toMatchObject(required);
  });
});

// Person, org unit and lookup fields (R2b-05, job 084), on a database of its own so the kind schemas
// published here reach no other case. The person member cases run under the split runtime roles in
// tests/org-scope.test.ts.
describe("person, org unit and lookup references with real PostgreSQL migrations and RLS", () => {
  const OTHER = "00000000-0000-4000-a000-000000000002";
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal, sibling: Principal, outsider: Principal;
  let levelId: string;
  let unit: string, spare: string, archivedUnit: string, otherUnit: string;
  /** Fixture setup or inspection as the database owner, outside RLS. */
  const asOwner = async <T>(work: () => Promise<T>): Promise<T> => {
    await fixture.client.exec("RESET ROLE");
    try {
      return await work();
    } finally {
      await fixture.client.exec("SET ROLE recruitment_test_runtime");
    }
  };
  const stored = (id: string) =>
    asOwner(
      async () =>
        (
          await fixture.client.query<{
            data: Record<string, unknown>;
            version: number;
          }>("SELECT data, version FROM app.records WHERE id = $1", [id])
        ).rows[0],
    );
  const named = (kind: string, key: string, value: string) =>
    asOwner(
      async () =>
        (
          await fixture.client.query<{ total: number }>(
            "SELECT count(*)::int AS total FROM app.records WHERE kind = $1 AND data->>$2 = $3",
            [kind, key, value],
          )
        ).rows[0].total,
    );
  const newUnit = async (p: Principal, level: string, code: string) =>
    (
      await createOrgUnit(p, {
        name: `Fictional ${code} unit`,
        code,
        levelId: level,
      })
    ).id;
  /** The refusal a write answers, as its status, code and message only. */
  const refusalOf = async (write: Promise<unknown>) => {
    const error = await write.then(
      () => expect.fail("The write was accepted."),
      (error: { status: number; code: string; message: string }) => error,
    );
    return { status: error.status, code: error.code, message: error.message };
  };
  const unitRefusal = (label: string) => ({
    status: 400,
    code: "invalid_reference",
    message: `${label} does not reference a current unit of this company.`,
  });
  const lookupRefusal = (label: string) => ({
    status: 400,
    code: "invalid_reference",
    message: `${label} does not reference the expected record in this team.`,
  });
  // A candidate and a job role, each with a unit, a lookup and a person field.
  const fields = {
    candidate: {
      unit: customField("Fictional candidate unit", "org-unit"),
      lookup: customField("Fictional candidate vacancy", "lookup", {
        target: "vacancy",
      }),
      person: customField("Fictional candidate sponsor", "person"),
    },
    "job-role": {
      unit: customField("Fictional role unit", "org-unit"),
      lookup: customField("Fictional role candidate", "lookup", {
        target: "candidate",
      }),
      person: customField("Fictional role sponsor", "person"),
    },
  };
  const kinds = [
    ["candidate", "candidates", "name"],
    ["job-role", "job-roles", "title"],
  ] as const;

  beforeAll(async () => {
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db, {
      userId: "reference-owner",
      teamId: "reference-team",
    });
    await seedIdentity(fixture.db, {
      userId: "reference-colleague",
      teamId: "reference-team",
      role: "recruiter",
    });
    sibling = await seedIdentity(fixture.db, {
      userId: "reference-sibling",
      teamId: "reference-sibling-team",
    });
    outsider = await seedIdentity(fixture.db, {
      userId: "reference-outsider",
      teamId: "reference-outsider-team",
    });
    // A second fictional company holding only the outsider's team.
    await fixture.client.exec(`
      INSERT INTO app.workspaces(id,name) VALUES ('${OTHER}','Fictional Other Company');
      UPDATE app.workspace_teams SET workspace_id = '${OTHER}' WHERE team_id = 'reference-outsider-team';
      INSERT INTO app.workspace_admins(workspace_id,user_id,level) VALUES ('${OTHER}','reference-outsider','owner');
    `);
    await enforceTestRls(fixture.db);
    levelId = (
      await createOrgLevel(owner, {
        name: "Fictional reference level",
        depth: 0,
      })
    ).id;
    unit = await newUnit(owner, levelId, "REF-1");
    spare = await newUnit(owner, levelId, "REF-2");
    archivedUnit = await newUnit(owner, levelId, "REF-3");
    await archiveOrgUnit(owner, archivedUnit);
    const otherLevel = await createOrgLevel(outsider, {
      name: "Fictional other reference level",
      depth: 0,
    });
    otherUnit = await newUnit(outsider, otherLevel.id, "REF-OTHER");
    for (const [kind] of kinds)
      await publishKindSchema(
        fixture,
        owner.userId,
        kindBody(kind, Object.values(fields[kind])),
      );
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it("stores a current unit of the company and refuses an unknown, archived or other company's unit on each kind", async () => {
    for (const [kind, resource, title] of kinds) {
      const field = fields[kind].unit;
      const created = await createRecord(owner, resource, {
        data: {
          [title]: `Fictional ${kind} with a unit`,
          customValues: { [field.key]: unit },
        },
      });
      expect(created.data, kind).toMatchObject({
        customValues: { [field.key]: unit },
      });
      const moved = await updateRecord(owner, resource, created.id, {
        version: 1,
        data: { customValues: { [field.key]: spare } },
      });
      expect(moved.data, kind).toMatchObject({
        customValues: { [field.key]: spare },
      });
      const before = await stored(created.id);
      expect(before.data.customValues, kind).toEqual({ [field.key]: spare });
      for (const value of [randomUUID(), archivedUnit, otherUnit]) {
        expect(
          await refusalOf(
            updateRecord(owner, resource, created.id, {
              version: 2,
              data: { customValues: { [field.key]: value } },
            }),
          ),
          `${kind} ${value}`,
        ).toEqual(unitRefusal(field.label));
        const name = `Fictional ${kind} refused unit ${value}`;
        expect(
          await refusalOf(
            createRecord(owner, resource, {
              data: { [title]: name, customValues: { [field.key]: value } },
            }),
          ),
          `${kind} ${value}`,
        ).toEqual(unitRefusal(field.label));
        expect(await named(kind, title, name)).toBe(0);
      }
      expect(await stored(created.id), kind).toEqual(before);
      // A value of the wrong shape still answers the R2b-04 refusal first.
      expect(
        await refusalOf(
          updateRecord(owner, resource, created.id, {
            version: 2,
            data: { customValues: { [field.key]: "REF-1" } },
          }),
        ),
      ).toEqual({
        status: 400,
        code: "invalid_custom_value",
        message: `Invalid value for ${field.label}.`,
      });
    }
  });

  it("stores a lookup to a record of the target kind in the team and refuses the wrong kind, another team's record and an unknown id alike", async () => {
    const vacancy = await createRecord(owner, "vacancies", {
      data: { title: "Fictional looked-up vacancy" },
    });
    const candidate = await createRecord(owner, "candidates", {
      data: { name: "Fictional Looked-up Candidate" },
    });
    const role = await createRecord(owner, "job-roles", {
      data: { title: "Fictional unrelated role" },
    });
    // The sibling team shares the company; its records are still another team's.
    const targets = {
      candidate: {
        own: vacancy.id,
        other: (
          await createRecord(sibling, "vacancies", {
            data: { title: "Fictional sibling vacancy" },
          })
        ).id,
        wrongKind: role.id,
      },
      "job-role": {
        own: candidate.id,
        other: (
          await createRecord(sibling, "candidates", {
            data: { name: "Fictional Sibling Candidate" },
          })
        ).id,
        wrongKind: vacancy.id,
      },
    };
    for (const [kind, resource, title] of kinds) {
      const field = fields[kind].lookup;
      const { own, other, wrongKind } = targets[kind];
      const created = await createRecord(owner, resource, {
        data: {
          [title]: `Fictional ${kind} with a lookup`,
          customValues: { [field.key]: own },
        },
      });
      expect(created.data, kind).toMatchObject({
        customValues: { [field.key]: own },
      });
      const before = await stored(created.id);
      const refusals = [];
      for (const value of [wrongKind, other, randomUUID()]) {
        refusals.push(
          await refusalOf(
            updateRecord(owner, resource, created.id, {
              version: 1,
              data: { customValues: { [field.key]: value } },
            }),
          ),
        );
        const name = `Fictional ${kind} refused lookup ${value}`;
        refusals.push(
          await refusalOf(
            createRecord(owner, resource, {
              data: { [title]: name, customValues: { [field.key]: value } },
            }),
          ),
        );
        expect(await named(kind, title, name)).toBe(0);
      }
      expect(refusals, kind).toEqual(Array(6).fill(lookupRefusal(field.label)));
      expect(await stored(created.id), kind).toEqual(before);
    }
    // An archived target is refused as archived, except on an imported archived write.
    const field = fields.candidate.lookup;
    await updateRecord(owner, "vacancies", vacancy.id, {
      version: 1,
      archived: true,
    });
    expect(
      await refusalOf(
        createRecord(owner, "candidates", {
          data: {
            name: "Fictional Archived Lookup Candidate",
            customValues: { [field.key]: vacancy.id },
          },
        }),
      ),
    ).toEqual({
      status: 400,
      code: "archived_reference",
      message: `${field.label} references an archived record.`,
    });
    const imported = await createRecord(owner, "candidates", {
      archived: true,
      importMeta: { workbook: "Fictional.xlsx" },
      data: {
        name: "Fictional Imported Lookup Candidate",
        customValues: { [field.key]: vacancy.id },
      },
    });
    expect(imported.data).toMatchObject({
      customValues: { [field.key]: vacancy.id },
    });
  });

  it("keeps a person, unit or lookup value that is no longer valid on an unrelated edit", async () => {
    const { unit: unitField, lookup, person } = fields.candidate;
    const kept = await newUnit(owner, levelId, "REF-KEPT");
    const vacancy = await createRecord(owner, "vacancies", {
      data: { title: "Fictional kept vacancy" },
    });
    const values = {
      [unitField.key]: kept,
      [lookup.key]: vacancy.id,
      [person.key]: "reference-colleague",
    };
    const created = await createRecord(owner, "candidates", {
      data: { name: "Fictional Kept Candidate", customValues: values },
    });
    expect((await stored(created.id)).data.customValues).toEqual(values);
    // The unit and the vacancy are archived and the colleague leaves the team.
    await archiveOrgUnit(owner, kept);
    await updateRecord(owner, "vacancies", vacancy.id, {
      version: 1,
      archived: true,
    });
    await asOwner(() =>
      fixture.client.query(
        "DELETE FROM auth.member WHERE organization_id = 'reference-team' AND user_id = 'reference-colleague'",
      ),
    );
    const edited = await updateRecord(owner, "candidates", created.id, {
      version: 1,
      data: { name: "Fictional Renamed Kept Candidate" },
    });
    expect(edited.data).toMatchObject({ customValues: values });
    const resent = await updateRecord(owner, "candidates", created.id, {
      version: 2,
      data: { phone: "+971 50 333 3333", customValues: values },
    });
    expect(resent.data).toMatchObject({ customValues: values });
    expect((await stored(created.id)).data.customValues).toEqual(values);
    // Changing one of them again is checked.
    expect(
      await refusalOf(
        updateRecord(owner, "candidates", created.id, {
          version: 3,
          data: {
            customValues: { ...values, [person.key]: "reference-sibling" },
          },
        }),
      ),
    ).toEqual({
      status: 400,
      code: "invalid_reference",
      message: `${person.label} must be a member of this team.`,
    });
  });

  it("writes a kind on the built-in default schema exactly as before", async () => {
    const vacancy = await createRecord(owner, "vacancies", {
      data: { title: "Fictional default vacancy" },
      orgUnitId: unit,
    });
    expect(vacancy.data).not.toHaveProperty("customValues");
    const edited = await updateRecord(owner, "vacancies", vacancy.id, {
      version: 1,
      data: { title: "Fictional renamed default vacancy" },
    });
    expect(edited).toMatchObject({ version: 2, orgUnitId: unit });
    expect(edited.data).not.toHaveProperty("customValues");
    expect((await stored(vacancy.id)).data).not.toHaveProperty("customValues");
    await expect(
      createRecord(owner, "vacancies", {
        data: {
          title: "Fictional default custom vacancy",
          customValues: { [fields.candidate.unit.key]: unit },
        },
      }),
    ).rejects.toMatchObject({ status: 400, code: "unknown_custom_field" });
  });
});

// File fields (R2b-06, job 087), on a database of its own so the kind schema published here reaches
// no other case. A file value must be the id of a ready, unerased record file of the same team and
// record; the files go through the record file service behind the fake Blob client.
describe("file field references with real PostgreSQL migrations and RLS", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal, outsider: Principal;
  const field = customField("Fictional certificate", "file");
  const pdf = Buffer.from("%PDF-1.7\nfictional file field\n%%EOF");
  const fake = fakeBlob();
  /** Fixture setup or inspection as the database owner, outside RLS. */
  const asOwner = async <T>(work: () => Promise<T>): Promise<T> => {
    await fixture.client.exec("RESET ROLE");
    try {
      return await work();
    } finally {
      await fixture.client.exec("SET ROLE recruitment_test_runtime");
    }
  };
  const stored = (id: string) =>
    asOwner(
      async () =>
        (
          await fixture.client.query<{
            data: Record<string, unknown>;
            version: number;
          }>("SELECT data, version FROM app.records WHERE id = $1", [id])
        ).rows[0],
    );
  const candidate = async (p: Principal, name: string) =>
    (await createRecord(p, "candidates", { data: { name } })).id;
  /** A pending record file of the record; with `ready`, its bytes validated and settled. */
  async function file(p: Principal, recordId: string, ready = true) {
    const reserved = await beginRecordFileUpload(
      p,
      {
        recordId,
        originalName: "fictional-certificate.pdf",
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
        clientUploadId: randomUUID(),
      },
      fake.gateway,
    );
    if (!ready) return reserved.data.id;
    const key = await asOwner(
      async () =>
        (
          await fixture.client.query<{ object_key: string }>(
            "SELECT object_key FROM app.record_files WHERE id = $1",
            [reserved.data.id],
          )
        ).rows[0].object_key,
    );
    fake.objects.set(key, { bytes: pdf, mimeType: "application/pdf" });
    return (await completeRecordFileUpload(p, reserved.data.id, fake.gateway))
      .id;
  }
  const refusal = {
    status: 400,
    code: "invalid_reference",
    message: `${field.label} does not reference the expected record in this team.`,
  };
  const refusalOf = async (write: Promise<unknown>) => {
    const error = await write.then(
      () => expect.fail("The write was accepted."),
      (error: { status: number; code: string; message: string }) => error,
    );
    return { status: error.status, code: error.code, message: error.message };
  };
  const update = (id: string, version: number, value: unknown, data = {}) =>
    updateRecord(owner, "candidates", id, {
      version,
      data: { ...data, customValues: { [field.key]: value } },
    });

  beforeAll(async () => {
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db, {
      userId: "file-owner",
      teamId: "file-team",
    });
    // Another team of the same fictional company, so the same kind schema applies.
    outsider = await seedIdentity(fixture.db, {
      userId: "file-outsider",
      teamId: "file-outsider-team",
    });
    await enforceTestRls(fixture.db);
    await publishKindSchema(
      fixture,
      owner.userId,
      kindBody("candidate", [field]),
    );
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it("stores a ready file of the record on update and refuses a random id, a pending file, another record's file and another team's file with the record unchanged", async () => {
    const id = await candidate(owner, "Fictional File Candidate");
    const ready = await file(owner, id);
    const updated = await update(id, 1, ready);
    expect(updated.data).toMatchObject({
      customValues: { [field.key]: ready },
    });
    const before = await stored(id);
    expect(before.data.customValues).toEqual({ [field.key]: ready });
    const otherRecord = await file(
      owner,
      await candidate(owner, "Fictional Other File Candidate"),
    );
    const otherTeam = await file(
      outsider,
      await candidate(outsider, "Fictional Outsider File Candidate"),
    );
    const pending = await file(owner, id, false);
    const refusals = [];
    for (const value of [randomUUID(), pending, otherRecord, otherTeam])
      refusals.push(await refusalOf(update(id, 2, value)));
    expect(refusals).toEqual(Array(4).fill(refusal));
    expect(await stored(id)).toEqual(before);
    // A value that is not a uuid still answers the shape refusal first.
    await expect(update(id, 2, "fictional.pdf")).rejects.toMatchObject({
      status: 400,
      code: "invalid_custom_value",
    });
    // Clearing the value needs no file.
    const cleared = await update(id, 2, null);
    expect(cleared.data).toMatchObject({ customValues: { [field.key]: null } });
  });

  it("refuses every file value on create, where no record owns a file yet", async () => {
    const id = await candidate(owner, "Fictional Source Candidate");
    const ready = await file(owner, id);
    for (const value of [ready, randomUUID()])
      expect(
        await refusalOf(
          createRecord(owner, "candidates", {
            data: {
              name: "Fictional Refused File Candidate",
              customValues: { [field.key]: value },
            },
          }),
        ),
      ).toEqual(refusal);
    expect(
      await asOwner(
        async () =>
          (
            await fixture.client.query(
              "SELECT id FROM app.records WHERE data->>'name' = 'Fictional Refused File Candidate'",
            )
          ).rows,
      ),
    ).toEqual([]);
    // An empty value is no reference.
    const created = await createRecord(owner, "candidates", {
      data: {
        name: "Fictional Empty File Candidate",
        customValues: { [field.key]: "" },
      },
    });
    expect(created.data).toMatchObject({ customValues: { [field.key]: "" } });
  });

  it("keeps an existing file value unchecked on an unrelated edit", async () => {
    const id = await candidate(owner, "Fictional Kept File Candidate");
    const ready = await file(owner, id);
    await update(id, 1, ready);
    // The file is moved to another record by the owner, so the stored value no longer checks.
    const elsewhere = await candidate(owner, "Fictional Elsewhere Candidate");
    await asOwner(() =>
      fixture.client.query(
        "UPDATE app.record_files SET record_id = $1 WHERE id = $2",
        [elsewhere, ready],
      ),
    );
    const edited = await updateRecord(owner, "candidates", id, {
      version: 2,
      data: { name: "Fictional Renamed Kept File Candidate" },
    });
    expect(edited.data).toMatchObject({ customValues: { [field.key]: ready } });
    const resent = await update(id, 3, ready, { phone: "+971 50 444 4444" });
    expect(resent.data).toMatchObject({ customValues: { [field.key]: ready } });
    // Changing it again is checked.
    expect(await refusalOf(update(id, 4, randomUUID()))).toEqual(refusal);
  });
});
