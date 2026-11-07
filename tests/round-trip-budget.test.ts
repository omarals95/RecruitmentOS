import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));

import { getVerifiedSession } from "@/lib/auth-session";
import { bootstrapTeam, createRecord, listRecords } from "@/lib/records";
import type { Principal } from "@/lib/principal";
import type { RecordDto } from "@/domain/records";
import { GET as listRoute } from "@/app/api/v1/[resource]/route";
import { GET as getRoute, PATCH } from "@/app/api/v1/[resource]/[id]/route";
import { createTestDb, seedIdentity } from "./helpers/db";

// Fictional team and records only; the session lookup is mocked, so it is not counted.
const ORIGIN = "http://localhost:3000";
const TIMING = /^total;dur=\d+\.\d, db;dur=\d+\.\d, dbrt;desc="(\d+)"$/;

describe("database round trips per request", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal;
  let task: RecordDto, candidate: RecordDto, application: RecordDto;
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
      user: { id: owner.userId },
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
    const vacancy = await createRecord(owner, "vacancies", {
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
});
