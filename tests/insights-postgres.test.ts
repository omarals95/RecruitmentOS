import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activity, notificationReads, records } from "@/db/schema";
import { member, user } from "@/db/auth-schema";
import { withTeam } from "@/lib/db-team";
import {
  analytics,
  listActivity,
  markNotifications,
  notifications,
  overview,
  searchWorkspace,
} from "@/lib/insights";
import {
  createRecord,
  updateCandidateState,
  updateRecord,
} from "@/lib/records";
import type { Principal } from "@/lib/principal";
import {
  createTestDb,
  enforceTestRls,
  seedApiToken,
  seedIdentity,
} from "./helpers/db";

describe("bounded, factual PostgreSQL reporting", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal,
    colleague: Principal,
    former: Principal,
    other: Principal,
    viewer: Principal;
  const now = "2030-01-01T22:00:00.000Z"; // January 2 in Dubai.
  beforeAll(async () => {
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db);
    colleague = await seedIdentity(fixture.db, { userId: "insight-colleague" });
    former = await seedIdentity(fixture.db, { userId: "insight-former" });
    await fixture.db
      .update(user)
      .set({ name: "Historical Activity Actor" })
      .where(eq(user.id, former.userId));
    await fixture.db
      .delete(member)
      .where(
        and(
          eq(member.organizationId, former.teamId),
          eq(member.userId, former.userId),
        ),
      );
    other = await seedIdentity(fixture.db, {
      userId: "insight-other",
      teamId: "insight-other",
    });
    viewer = await seedIdentity(fixture.db, {
      userId: "insight-viewer",
      role: "viewer",
    });
    await enforceTestRls(fixture.db);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(now));
  });
  afterAll(async () => {
    vi.useRealTimers();
    await fixture?.close();
  });
  async function basic(p = owner) {
    const person = await createRecord(p, "candidates", {
      data: {
        name: `Fictional Person ${randomUUID()}`,
        folderCategories: ["Engineering", "Operations"],
        yearsExperience: null,
      },
    });
    const job = await createRecord(p, "vacancies", {
      data: {
        title: "Fictional vacancy",
        status: "Open",
        department: "Engineering",
      },
    });
    const application = await withTeam(
      p,
      async (tx) =>
        (
          await tx
            .insert(records)
            .values({
              id: randomUUID(),
              teamId: p.teamId,
              kind: "application",
              data: { stage: "Sourced", source: "Fixture" },
              candidateId: person.id,
              vacancyId: job.id,
              createdBy: p.userId,
            })
            .returning()
        )[0],
    );
    return { person, job, application };
  }

  it("finds upcoming interviews and overdue tasks beyond the first hundred unrelated records", async () => {
    const { application, person } = await basic();
    await updateCandidateState(owner, person.id, {
      version: 0,
      shortlisted: true,
      note: "Never return this private body in reports",
    });
    const bucket = await createRecord(owner, "buckets", {
      data: { name: "Reporting bucket" },
    });
    const future = randomUUID(),
      overdue = randomUUID();
    await withTeam(owner, async (tx) => {
      await tx.insert(records).values([
        ...Array.from({ length: 105 }, (_, i) => ({
          id: randomUUID(),
          teamId: owner.teamId,
          kind: "interview",
          applicationId: application.id,
          data: {
            title: `Old interview ${i}`,
            startAt: "2029-01-01T00:00:00.000Z",
            status: "Scheduled",
          },
          createdBy: owner.userId,
          createdAt: new Date("2029-01-01"),
        })),
        {
          id: future,
          teamId: owner.teamId,
          kind: "interview",
          applicationId: application.id,
          data: {
            title: "Future conversation",
            startAt: "2030-01-03T09:00:00.000Z",
            status: "Scheduled",
          },
          createdBy: owner.userId,
        },
        ...Array.from({ length: 105 }, (_, i) => ({
          id: randomUUID(),
          teamId: owner.teamId,
          kind: "task",
          bucketId: bucket.id,
          data: { title: `Future task ${i}`, dueDate: "2031-01-01" },
          createdBy: owner.userId,
        })),
        {
          id: overdue,
          teamId: owner.teamId,
          kind: "task",
          bucketId: bucket.id,
          data: { title: "Old overdue task", dueDate: "2029-01-01" },
          createdBy: owner.userId,
          updatedAt: new Date("2029-01-01"),
        },
      ]);
    });
    const result = await overview(owner);
    expect(result.upcomingInterviews.map((row) => row.id)).toContain(future);
    expect(result.overdueTasks.map((row) => row.id)).toContain(overdue);
    expect(result.counts.shortlisted).toBe(1);
    expect(result.coverage.experience).toBe(0);
    expect(result.categories).toContainEqual({ name: "Engineering", count: 1 });
    expect(JSON.stringify(result)).not.toContain(
      "Never return this private body",
    );
    expect((await overview(colleague)).counts.shortlisted).toBe(0);
  });

  it("aggregates observed first hires only, excludes imports and preserves unknown experience", async () => {
    const { application } = await basic(other);
    const imported = await basic(other);
    await withTeam(other, async (tx) => {
      const event = (
        at: string,
        fromStage: string | null,
        toStage: string,
        action = "updated",
        recordId = application.id,
        actorType = "session",
      ) => ({
        id: randomUUID(),
        teamId: other.teamId,
        recordId,
        actorId: other.userId,
        actorType,
        kind: "application",
        action,
        summary: "Fictional observed event",
        metadata: { fromStage, toStage },
        createdAt: new Date(at),
      });
      await tx
        .insert(activity)
        .values([
          event("2030-01-01T00:00:00Z", null, "Sourced", "created"),
          event("2030-01-03T00:00:00Z", "Sourced", "Screening"),
          event("2030-01-07T00:00:00Z", "Screening", "Hired"),
          event("2030-01-09T00:00:00Z", "Hired", "Rejected"),
          event("2030-01-10T00:00:00Z", "Rejected", "Hired"),
          event(
            "2030-01-02T21:00:00Z",
            null,
            "Hired",
            "imported",
            imported.application.id,
            "import",
          ),
        ]);
    });
    const result = await analytics(
      other,
      new URLSearchParams({ from: "2030-01-01", to: "2030-01-31" }),
    );
    expect(result.hiresCount).toBe(1);
    expect(result.timeToHireDays).toBe(6);
    expect(result.timeToHireSample).toBe(1);
    expect(result.series.reduce((sum, day) => sum + day.hired, 0)).toBe(1);
    expect(result.series.find((day) => day.date === "2030-01-07")?.hired).toBe(
      1,
    );
    expect(result.series.find((day) => day.date === "2030-01-10")?.hired).toBe(
      0,
    );
    expect(result.series.reduce((sum, day) => sum + day.applications, 0)).toBe(
      1,
    );
    expect(result.stageDurations).toContainEqual({
      stage: "Screening",
      averageDays: 4,
      count: 1,
    });
    expect(result.experience).toContainEqual({
      name: "Not recorded",
      count: 2,
    });
    expect(
      result.conversions.find((row) => row.stage === "Hired"),
    ).toMatchObject({ count: 1, rate: 1 });
  });

  it("validates date ranges and pagination instead of passing NaN, Infinity or fractions to SQL", async () => {
    await expect(
      analytics(owner, new URLSearchParams({ to: "not-a-date" })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      analytics(
        owner,
        new URLSearchParams({ from: "2020-01-01", to: "2030-01-01" }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    for (const page of ["Infinity", "1.5", "-1", "1e309"])
      await expect(
        listActivity(owner, new URLSearchParams({ page })),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      listActivity(owner, new URLSearchParams({ pageSize: "101" })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("accepts the activity screen query and applies bounded, literal summary/action/actor filters", async () => {
    await withTeam(owner, (tx) =>
      tx.insert(activity).values([
        {
          id: randomUUID(),
          teamId: owner.teamId,
          actorId: owner.userId,
          actorType: "session",
          kind: "cv",
          action: "cv.uploaded",
          summary: "Fictional 100% upload",
        },
        {
          id: randomUUID(),
          teamId: owner.teamId,
          actorId: owner.userId,
          actorType: "session",
          kind: "cv",
          action: "cv.uploaded",
          summary: "Fictional 1000 upload",
        },
      ]),
    );
    // Only the owner-run audit helper may write token events, so seed this one as the superuser.
    await fixture.db.execute(sql`reset role`);
    try {
      await fixture.db.insert(activity).values({
        id: randomUUID(),
        teamId: owner.teamId,
        actorId: owner.userId,
        actorType: "session",
        kind: "api-token",
        action: "token.created",
        summary: "Issued token fixture",
      });
    } finally {
      await fixture.db.execute(sql`set role recruitment_test_runtime`);
    }
    const initial = await listActivity(
      owner,
      new URLSearchParams({ page: "1", pageSize: "50", search: "", kind: "" }),
    );
    expect(initial.pagination.total).toBeGreaterThan(0);
    expect(
      (await listActivity(owner, new URLSearchParams({ kind: "cv" })))
        .pagination.total,
    ).toBe(2);
    expect(
      (
        await listActivity(
          owner,
          new URLSearchParams({ kind: "cv", search: "100" }),
        )
      ).pagination.total,
    ).toBe(2);
    const literal = await listActivity(
      owner,
      new URLSearchParams({ search: "100%", kind: "cv" }),
    );
    expect(literal.pagination.total).toBe(1);
    expect(literal.data[0].summary).toBe("Fictional 100% upload");
    const action = await listActivity(
      owner,
      new URLSearchParams({ search: "token.created", kind: "api-token" }),
    );
    expect(action.data).toHaveLength(1);
    expect(action.data[0].kind).toBe("api-token");
    expect(
      (
        await listActivity(
          owner,
          new URLSearchParams({ search: "Fictional Test User", kind: "cv" }),
        )
      ).pagination.total,
    ).toBe(2);
    expect(
      (
        await listActivity(
          owner,
          new URLSearchParams({ search: "Never return this private body" }),
        )
      ).pagination.total,
    ).toBe(0);
    await expect(
      listActivity(owner, new URLSearchParams({ kind: "unknown-resource" })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      listActivity(owner, new URLSearchParams({ search: "x".repeat(501) })),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      listActivity(owner, new URLSearchParams({ unsupported: "" })),
    ).rejects.toMatchObject({ status: 400 });
    const readToken = {
      ...owner,
      scopes: ["recruitment:read"] as Principal["scopes"],
    };
    expect(
      (
        await listActivity(
          readToken,
          new URLSearchParams({ kind: "candidate", search: "candidate" }),
        )
      ).pagination.total,
    ).toBe(0);
  });

  it("searches and paginates historical actor names without exposing other teams' activity", async () => {
    const firstId = randomUUID(),
      secondId = randomUUID(),
      foreignId = randomUUID();
    // Events name only their writing context's actor, so seed a former member's history as the superuser.
    await fixture.db.execute(sql`reset role`);
    try {
      await fixture.db.insert(activity).values([
        {
          id: firstId,
          teamId: owner.teamId,
          actorId: former.userId,
          actorType: "session",
          kind: "cv",
          action: "cv.uploaded",
          summary: "Earlier synthetic event",
          createdAt: new Date("2029-12-01T00:00:00Z"),
        },
        {
          id: secondId,
          teamId: owner.teamId,
          actorId: former.userId,
          actorType: "session",
          kind: "cv",
          action: "cv.uploaded",
          summary: "Later synthetic event",
          createdAt: new Date("2029-12-02T00:00:00Z"),
        },
        {
          id: foreignId,
          teamId: other.teamId,
          actorId: former.userId,
          actorType: "session",
          kind: "cv",
          action: "cv.uploaded",
          summary: "Foreign synthetic event",
          createdAt: new Date("2029-12-03T00:00:00Z"),
        },
      ]);
    } finally {
      await fixture.db.execute(sql`set role recruitment_test_runtime`);
    }
    const query = {
      kind: "cv",
      search: "Historical Activity Actor",
      pageSize: "1",
    };
    const pageOne = await listActivity(
      owner,
      new URLSearchParams({ ...query, page: "1" }),
    );
    const pageTwo = await listActivity(
      owner,
      new URLSearchParams({ ...query, page: "2" }),
    );
    expect(pageOne.pagination.total).toBe(2);
    expect(pageTwo.pagination.total).toBe(2);
    expect(pageOne.data).toHaveLength(1);
    expect(pageTwo.data).toHaveLength(1);
    expect(pageOne.data[0]).toMatchObject({
      id: secondId,
      actorName: "Historical Activity Actor",
    });
    expect(pageTwo.data[0]).toMatchObject({
      id: firstId,
      actorName: "Historical Activity Actor",
    });
    expect(JSON.stringify([pageOne, pageTwo])).not.toContain(foreignId);
    expect(JSON.stringify([pageOne, pageTwo])).not.toContain(
      "Foreign synthetic event",
    );
  });

  it("derives seven-day Dubai reminders with exact source links and authenticated personal read markers", async () => {
    const { application } = await basic();
    const interview = await createRecord(owner, "interviews", {
      applicationId: application.id,
      data: {
        title: "Dubai midnight interview",
        startAt: "2030-01-07T21:00:00Z",
      },
    });
    const outside = await createRecord(owner, "interviews", {
      applicationId: application.id,
      data: { title: "Outside horizon", startAt: "2030-01-09T21:00:00Z" },
    });
    const onboarding = await createRecord(owner, "onboarding", {
      applicationId: application.id,
      data: { startDate: "2030-01-09" },
    });
    const item = await createRecord(owner, "checklist", {
      onboardingId: onboarding.id,
      data: { title: "Fictional document", dueDate: "2030-01-08" },
    });
    const result = await notifications(owner);
    const reminder = result.data.find((row) =>
      row.key.startsWith(`interview:${interview.id}:`),
    );
    expect(reminder).toMatchObject({
      date: "2030-01-08",
      description: "Coming up within 7 days",
      href: `/app/interviews?record=${interview.id}`,
      read: false,
    });
    expect(
      result.data.find((row) => row.key.startsWith(`interview:${outside.id}:`)),
    ).toBeUndefined();
    expect(
      result.data.find((row) =>
        row.key.startsWith(`onboarding:${onboarding.id}:`),
      ),
    ).toBeDefined();
    expect(
      result.data.find((row) => row.key.startsWith(`checklist:${item.id}:`))
        ?.href,
    ).toBe(`/app/onboarding?record=${onboarding.id}&checklist=${item.id}`);
    expect(await markNotifications(owner, ["arbitrary-forged-key"])).toEqual({
      updated: 0,
    });
    expect(await markNotifications(owner, [reminder!.key])).toEqual({
      updated: 1,
    });
    expect(await markNotifications(owner, [reminder!.key])).toEqual({
      updated: 0,
    });
    expect(
      (await notifications(colleague)).data.find(
        (row) => row.key === reminder!.key,
      )?.read,
    ).toBe(false);
    await updateRecord(owner, "interviews", interview.id, {
      version: 1,
      data: { startAt: "2030-01-07T22:00:00Z" },
    });
    const rescheduled = (await notifications(owner)).data.find((row) =>
      row.key.startsWith(`interview:${interview.id}:`),
    );
    expect(rescheduled?.key).not.toBe(reminder!.key);
    expect(rescheduled?.read).toBe(false);
  });

  it("keeps personal audit and candidate inventory outside recruitment-only token results", async () => {
    const token = await seedApiToken(fixture.db, owner, ["recruitment:read"]);
    await expect(overview(token)).rejects.toMatchObject({ status: 403 });
    const events = await listActivity(
      token,
      new URLSearchParams({ pageSize: "100" }),
    );
    expect(events.data.some((row) => row.kind === "candidate")).toBe(false);
    const colleagueEvents = await listActivity(
      colleague,
      new URLSearchParams({ pageSize: "100" }),
    );
    expect(
      colleagueEvents.data.some(
        (row) =>
          row.action === "personal_state_updated" &&
          row.actorId === owner.userId,
      ),
    ).toBe(false);
    expect(await searchWorkspace(token, "")).toMatchObject({
      groups: [],
      total: 0,
      limited: false,
    });
    expect(
      (await searchWorkspace(token, "Fictional")).groups.some(
        (row) => row.type === "candidates",
      ),
    ).toBe(false);
  });

  it("bounds chart groups without discarding their aggregate totals", async () => {
    await withTeam(other, (tx) =>
      tx.insert(records).values(
        Array.from({ length: 105 }, (_, i) => ({
          id: randomUUID(),
          teamId: other.teamId,
          kind: "candidate",
          data: {
            name: `Fictional category ${i}`,
            folderCategories: [`Distinct category ${i}`],
          },
          createdBy: other.userId,
        })),
      ),
    );
    const result = await analytics(
      other,
      new URLSearchParams({ from: "2030-01-01", to: "2030-01-31" }),
    );
    expect(result.categories).toHaveLength(101);
    expect(
      result.categories.some((row) => row.name === "Other recorded values"),
    ).toBe(true);
    expect(result.categories.reduce((sum, row) => sum + row.count, 0)).toBe(
      109,
    ); // 105 single tags + two candidates with two tags.
  });

  it("bounds reminder payloads while retaining exact totals instead of fabricating a smaller unread count", async () => {
    const bucket = await createRecord(owner, "buckets", {
      data: { name: "Bounded reminders" },
    });
    await withTeam(owner, (tx) =>
      tx.insert(records).values(
        Array.from({ length: 501 }, (_, i) => ({
          id: randomUUID(),
          teamId: owner.teamId,
          kind: "task",
          bucketId: bucket.id,
          data: { title: `Fictional reminder ${i}`, dueDate: "2030-01-02" },
          createdBy: owner.userId,
        })),
      ),
    );
    const result = await notifications(owner);
    expect(result.data).toHaveLength(500);
    expect(result.limited).toBe(true);
    expect(result.total).toBeGreaterThan(500);
    expect(result.unreadCount).toBeGreaterThan(500);
    const visible = new Set(result.data.map((row) => row.key));
    expect((await markNotifications(owner, [...visible])).updated).toBe(500);
    const next = await notifications(owner);
    expect(next.unreadCount).toBe(result.unreadCount - 500);
    expect(next.data[0].read).toBe(false);
    expect(
      next.data
        .filter((row) => !row.read)
        .every((row) => !visible.has(row.key)),
    ).toBe(true);
  });

  it("requires a write scope for token read markers while allowing a signed-in viewer to mark their own reminders", async () => {
    const reminder = (await notifications(viewer)).data[0];
    expect(reminder.read).toBe(false);
    const token = await seedApiToken(fixture.db, viewer, ["recruitment:read"]);
    await expect(
      markNotifications(token, [reminder.key]),
    ).rejects.toMatchObject({ status: 403 });
    const unchanged = await withTeam(viewer, (tx) =>
      tx
        .select()
        .from(notificationReads)
        .where(
          and(
            eq(notificationReads.teamId, viewer.teamId),
            eq(notificationReads.userId, viewer.userId),
          ),
        ),
    );
    expect(unchanged).toEqual([]);
    expect(await markNotifications(viewer, [reminder.key])).toEqual({
      updated: 1,
    });
    const saved = await withTeam(viewer, (tx) =>
      tx
        .select()
        .from(notificationReads)
        .where(
          and(
            eq(notificationReads.teamId, viewer.teamId),
            eq(notificationReads.userId, viewer.userId),
            eq(notificationReads.key, reminder.key),
          ),
        ),
    );
    expect(saved).toHaveLength(1);
    const importToken = await seedApiToken(fixture.db, colleague, [
      "recruitment:read",
      "recruitment:write",
      "imports:write",
    ]);
    expect(await markNotifications(importToken, [reminder.key])).toEqual({
      updated: 1,
    });
  });
});
