import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));

import { getVerifiedSession } from "@/lib/auth-session";
import {
  configBodyCache,
  createConfigDraft,
  publishConfigVersion,
} from "@/lib/config-store";
import { withTeam } from "@/lib/db-team";
import { assignMemberRole } from "@/lib/member-roles";
import { roleScopes } from "@/lib/permissions";
import { RECRUITER_ROLE } from "@/domain/config-defaults";
import { bootstrapTeam, createRecord, listRecords } from "@/lib/records";
import type { Principal } from "@/lib/principal";
import type { RecordDto } from "@/domain/records";
import { GET as listRoute } from "@/app/api/v1/[resource]/route";
import { GET as getRoute, PATCH } from "@/app/api/v1/[resource]/[id]/route";
import { GET as overviewRoute } from "@/app/api/v1/overview/route";
import { GET as meAccessRoute } from "@/app/api/v1/me/access/route";
import { createTestDb, seedIdentity } from "./helpers/db";

// Fictional team and records only; the session lookup is mocked, so it is not counted.
const ORIGIN = "http://localhost:3000";
const TIMING = /^total;dur=\d+\.\d, db;dur=\d+\.\d, dbrt;desc="(\d+)"$/;

describe("database round trips per request", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal;
  let task: RecordDto,
    candidate: RecordDto,
    vacancy: RecordDto,
    application: RecordDto;
  let buckets: RecordDto[];

  async function call(
    method: "GET" | "PATCH",
    path: string,
    params: Record<string, string>,
    body?: unknown,
  ) {
    const request = new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        "x-team-id": owner.teamId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const context = { params: Promise.resolve(params) } as never;
    const response =
      method === "PATCH"
        ? await PATCH(request, context)
        : params.id
          ? await getRoute(request, context)
          : await listRoute(request, context);
    const timing = response.headers.get("server-timing") ?? "";
    expect(timing).toMatch(TIMING);
    return {
      status: response.status,
      body: (await response.json()) as { data: RecordDto },
      roundTrips: Number(TIMING.exec(timing)![1]),
    };
  }

  beforeAll(async () => {
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db, {
      userId: "budget-owner",
      teamId: "budget-team",
    });
    vi.mocked(getVerifiedSession).mockResolvedValue({
      user: { id: owner.userId, twoFactorEnabled: true },
      session: { activeOrganizationId: owner.teamId },
    } as never);
    await bootstrapTeam(owner);
    buckets = (
      await listRecords(
        owner,
        "buckets",
        new URLSearchParams({ pageSize: "100", sort: "position" }),
      )
    ).data;
    task = await createRecord(owner, "tasks", {
      bucketId: buckets[0].id,
      data: { title: "Fictional budget task" },
    });
    candidate = await createRecord(owner, "candidates", {
      data: { name: "Fictional Budget Candidate" },
    });
    vacancy = await createRecord(owner, "vacancies", {
      data: { title: "Fictional budget vacancy" },
    });
    application = await createRecord(owner, "applications", {
      candidateId: candidate.id,
      vacancyId: vacancy.id,
      data: { stage: "Sourced" },
    });
    for (let index = 0; index < 4; index++)
      await createRecord(owner, "tasks", {
        bucketId: buckets[1].id,
        data: { title: `Fictional budget task ${index + 2}` },
      });
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it("keeps a simple read, an open candidate, a task move and a stage change within budget", async () => {
    const read = await call("GET", "/api/v1/tasks?page=1&pageSize=25", {
      resource: "tasks",
    });
    expect(read.status).toBe(200);
    expect(read.roundTrips).toBe(6);

    const open = await call("GET", `/api/v1/candidates/${candidate.id}`, {
      resource: "candidates",
      id: candidate.id,
    });
    expect(open.status).toBe(200);
    expect(open.roundTrips).toBe(6);

    const move = await call(
      "PATCH",
      `/api/v1/tasks/${task.id}`,
      { resource: "tasks", id: task.id },
      { version: task.version, bucketId: buckets[1].id },
    );
    expect(move.status).toBe(200);
    expect(move.body.data.bucketId).toBe(buckets[1].id);
    expect(move.roundTrips).toBe(11);

    const stage = await call(
      "PATCH",
      `/api/v1/applications/${application.id}`,
      { resource: "applications", id: application.id },
      { version: application.version, data: { stage: "Screening" } },
    );
    expect(stage.status).toBe(200);
    expect(stage.roundTrips).toBe(11);
  });

  it("opens a vacancy in 6 round trips and the overview in one transaction", async () => {
    const open = await call("GET", `/api/v1/vacancies/${vacancy.id}`, {
      resource: "vacancies",
      id: vacancy.id,
    });
    expect(open.status).toBe(200);
    expect(open.roundTrips).toBe(6);

    const response = await overviewRoute(
      new Request(`${ORIGIN}/api/v1/overview`, {
        headers: { origin: ORIGIN, "x-team-id": owner.teamId },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      "counts",
      "coverage",
      "stages",
      "departments",
      "categories",
      "upcomingInterviews",
      "overdueTasks",
      "recentActivity",
      "asOf",
      "timezone",
    ]);
    expect((body.recentActivity as unknown[]).length).toBeGreaterThan(0);
    // 20 before P1-25: recent activity opened a second transaction (BEGIN, deadlines, signed
    // context, COMMIT) and counted its total, which the overview never shows.
    const timing = response.headers.get("server-timing") ?? "";
    expect(timing).toMatch(TIMING);
    expect(Number(TIMING.exec(timing)![1])).toBe(15);
  });

  it("reports the real total on the first page, a middle page and a page past the end", async () => {
    const page = async (number: number) =>
      (
        await listRecords(
          owner,
          "tasks",
          new URLSearchParams({ page: String(number), pageSize: "2" }),
        )
      ).pagination;
    expect(await page(1)).toEqual({
      page: 1,
      pageSize: 2,
      total: 5,
      totalPages: 3,
    });
    expect(await page(2)).toEqual({
      page: 2,
      pageSize: 2,
      total: 5,
      totalPages: 3,
    });
    expect(await page(9)).toEqual({
      page: 9,
      pageSize: 2,
      total: 5,
      totalPages: 3,
    });
  });

  it("times an error response too", async () => {
    const missing = randomUUID();
    const response = await call("GET", `/api/v1/tasks/${missing}`, {
      resource: "tasks",
      id: missing,
    });
    expect(response.status).toBe(404);
  });

  it("reads the caller's own access in at most 6 round trips", async () => {
    const response = await meAccessRoute(
      new Request(`${ORIGIN}/api/v1/me/access`, {
        headers: { origin: ORIGIN, "x-team-id": owner.teamId },
      }),
    );
    expect(response.status).toBe(200);
    const timing = response.headers.get("server-timing") ?? "";
    expect(timing).toMatch(TIMING);
    expect(Number(TIMING.exec(timing)![1])).toBeLessThanOrEqual(6);
  });

  // Configuration versions and bodies come back in the install statement (R2a-05, 0032).
  describe("with a published company configuration object", () => {
    let versionId: string;
    let moveTo = 0;
    let stage: "Interview" | "Screening" = "Interview";

    /** The six common requests, in the order of the cases above; returns their round trips. */
    async function measure(beforeEach: () => void) {
      const counts: number[] = [];
      const record = async (
        method: "GET" | "PATCH",
        path: string,
        params: Record<string, string>,
        body?: unknown,
      ) => {
        beforeEach();
        const result = await call(method, path, params, body);
        expect(result.status).toBe(200);
        counts.push(result.roundTrips);
        return result.body.data;
      };
      await record("GET", "/api/v1/tasks?page=1&pageSize=25", {
        resource: "tasks",
      });
      await record("GET", `/api/v1/candidates/${candidate.id}`, {
        resource: "candidates",
        id: candidate.id,
      });
      moveTo = 1 - moveTo;
      task = await record(
        "PATCH",
        `/api/v1/tasks/${task.id}`,
        { resource: "tasks", id: task.id },
        { version: task.version, bucketId: buckets[moveTo].id },
      );
      stage = stage === "Interview" ? "Screening" : "Interview";
      application = await record(
        "PATCH",
        `/api/v1/applications/${application.id}`,
        { resource: "applications", id: application.id },
        { version: application.version, data: { stage } },
      );
      await record("GET", `/api/v1/vacancies/${vacancy.id}`, {
        resource: "vacancies",
        id: vacancy.id,
      });
      beforeEach();
      const response = await overviewRoute(
        new Request(`${ORIGIN}/api/v1/overview`, {
          headers: { origin: ORIGIN, "x-team-id": owner.teamId },
        }),
      );
      expect(response.status).toBe(200);
      const timing = response.headers.get("server-timing") ?? "";
      expect(timing).toMatch(TIMING);
      counts.push(Number(TIMING.exec(timing)![1]));
      return counts;
    }

    beforeAll(async () => {
      // The budget owner is the first seeded user, so the company owner (0028).
      ({ versionId } = await createConfigDraft(owner, {
        type: "workflow",
        key: "budget-workflow",
        body: { label: "Fictional budget workflow" },
      }));
      await publishConfigVersion(owner, versionId);
      task = (
        await listRecords(owner, "tasks", new URLSearchParams())
      ).data.find((row) => row.id === task.id)!;
      application = (
        await listRecords(owner, "applications", new URLSearchParams())
      ).data.find((row) => row.id === application.id)!;
      moveTo = buckets.findIndex((bucket) => bucket.id === task.bucketId);
      stage = (application.data as { stage: typeof stage }).stage;
    });

    it("keeps every request within budget with a cold cache", async () => {
      expect(await measure(() => configBodyCache.clear())).toEqual([
        6, 6, 11, 11, 6, 15,
      ]);
      configBodyCache.clear();
      const access = await withTeam(owner, (tx, state) =>
        Promise.resolve(state),
      );
      expect(Object.values(access.versions)).toContain(versionId);
      expect(access.documents[versionId].body).toEqual({
        label: "Fictional budget workflow",
      });
      expect(configBodyCache.ids()).toContain(versionId);
    });

    it("keeps every request within budget with a warm cache", async () => {
      expect(configBodyCache.ids()).toContain(versionId);
      expect(await measure(() => {})).toEqual([6, 6, 11, 11, 6, 15]);
      const access = await withTeam(owner, (tx, state) =>
        Promise.resolve(state),
      );
      expect(access.documents[versionId].body).toEqual({
        label: "Fictional budget workflow",
      });
      expect(configBodyCache.ids()).toContain(versionId);
    });

    // A custom role (R2a-10): install narrows to it in the same statement, so the counts hold.
    it("keeps every request within budget for a member holding an assigned configured role", async () => {
      const member = await seedIdentity(fixture.db, {
        userId: "budget-recruiter",
        teamId: owner.teamId,
        role: "recruiter",
      });
      const role = await createConfigDraft(owner, {
        type: "role",
        key: "budget-role",
        body: {
          ...structuredClone(RECRUITER_ROLE.body),
          name: "Fictional budget role",
          scopes: roleScopes("recruiter").filter((s) => s !== "cvs:write"),
        },
      });
      await publishConfigVersion(owner, role.versionId);
      await assignMemberRole(
        owner,
        { userId: member.userId, roleObjectId: role.objectId },
        new Headers(),
      );
      const signIn = (p: Principal) =>
        vi.mocked(getVerifiedSession).mockResolvedValue({
          user: { id: p.userId, twoFactorEnabled: true },
          session: { activeOrganizationId: p.teamId },
        } as never);
      signIn(member);
      try {
        const access = await withTeam(member, (tx, state) =>
          Promise.resolve(state),
        );
        expect(access.roleVersionId).toBe(role.versionId);
        expect(access.scopes).not.toContain("cvs:write");
        expect(await measure(() => configBodyCache.clear())).toEqual([
          6, 6, 11, 11, 6, 15,
        ]);
        expect(await measure(() => {})).toEqual([6, 6, 11, 11, 6, 15]);
      } finally {
        signIn(owner);
      }
    });
  });
});
