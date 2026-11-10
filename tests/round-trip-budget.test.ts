import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
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
import { HIRING_MANAGER_ROLE, RECRUITER_ROLE } from "@/domain/config-defaults";
import { bootstrapTeam, createRecord, listRecords } from "@/lib/records";
import type { Principal } from "@/lib/principal";
import type { RecordDto } from "@/domain/records";
import { GET as listRoute } from "@/app/api/v1/[resource]/route";
import { GET as getRoute, PATCH } from "@/app/api/v1/[resource]/[id]/route";
import { GET as overviewRoute } from "@/app/api/v1/overview/route";
import { GET as meAccessRoute } from "@/app/api/v1/me/access/route";
import { GET as listOrgUnitsRoute } from "@/app/api/v1/org-units/route";
import { GET as listPositionsRoute } from "@/app/api/v1/positions/route";
import { GET as listEmployeesRoute } from "@/app/api/v1/employees/route";
import { createOrgLevel, type OrgLevel } from "@/lib/org";
import { createTestDb, seedApiToken, seedIdentity } from "./helpers/db";
import { listStoredTools } from "@/lib/mcp/tools";
import { runWithServerTiming } from "@/lib/server-timing";

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

  // R2a-09: tools/list reads the stored access in one transaction with only the install.
  it("lists an owner token's MCP tools in at most 6 round trips", async () => {
    const token = await seedApiToken(fixture.db, owner);
    const { tools, timing } = await runWithServerTiming(async (finish) => {
      const tools = await listStoredTools(token);
      return { tools, timing: finish() };
    });
    expect(tools).toHaveLength(59);
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

    // R2a-19: a replay under a changed role version re-reads the record instead of the cached body,
    // inside the budget of a simple write.
    it("replays an idempotent create after the member's role changed in at most 11 round trips", async () => {
      const member = await seedIdentity(fixture.db, {
        userId: "budget-replay",
        teamId: owner.teamId,
        role: "recruiter",
      });
      const payload = { data: { name: "Fictional Budget Replay Person" } };
      const first = await createRecord(
        member,
        "candidates",
        payload,
        "budget-replay",
      );
      const role = await createConfigDraft(owner, {
        type: "role",
        key: "budget-replay-role",
        body: {
          ...structuredClone(RECRUITER_ROLE.body),
          name: "Fictional budget replay role",
        },
      });
      await publishConfigVersion(owner, role.versionId);
      await assignMemberRole(
        owner,
        { userId: member.userId, roleObjectId: role.objectId },
        new Headers(),
      );
      const { replay, timing } = await runWithServerTiming(async (finish) => {
        const replay = await createRecord(
          member,
          "candidates",
          payload,
          "budget-replay",
        );
        return { replay, timing: finish() };
      });
      expect(replay.id).toBe(first.id);
      expect(timing).toMatch(TIMING);
      expect(Number(TIMING.exec(timing)![1])).toBeLessThanOrEqual(11);
    });
  });

  // R2a-16: one org chart level and one directory page on a fictional 500-unit, 6-level tree,
  // within the "Directory page, org chart level" target of architecture section 12.
  describe("with a 500-unit organisation on six levels", () => {
    const COUNTS = [2, 8, 30, 80, 160, 220];
    const tree: string[][] = [];
    let positions: { id: string; unit: string }[];

    async function timed(
      handler: (request: Request) => Promise<Response>,
      path: string,
    ) {
      const response = await handler(
        new Request(`${ORIGIN}${path}`, {
          headers: { origin: ORIGIN, "x-team-id": owner.teamId },
        }),
      );
      expect(response.status, path).toBe(200);
      const timing = response.headers.get("server-timing") ?? "";
      expect(timing).toMatch(TIMING);
      return {
        rows: ((await response.json()) as { data: unknown[] }).data,
        roundTrips: Number(TIMING.exec(timing)![1]),
      };
    }

    beforeAll(async () => {
      const levels: OrgLevel[] = [];
      for (const depth of COUNTS.keys())
        levels.push(
          await createOrgLevel(owner, {
            name: `Fictional budget level ${depth}`,
            depth,
          }),
        );
      // Each unit's parent is the previous level's unit at its index modulo that level's size.
      for (const [depth, count] of COUNTS.entries()) {
        const parents = depth === 0 ? [] : tree[depth - 1];
        const parent = parents.length
          ? sql`(${`{${parents.join(",")}}`}::uuid[])[1 + g % ${sql.raw(String(parents.length))}]`
          : sql`null::uuid`;
        tree.push(
          await withTeam(owner, async (tx, access) => {
            const { rows } = await tx.execute<{ id: string }>(sql`
              insert into app.org_units(workspace_id, parent_id, level_id, name, code)
              select ${access.workspaceId}::uuid, ${parent}, ${levels[depth].id}::uuid,
                ${`Fictional budget unit ${depth}-`} || g, ${`BUDGET-${depth}-`} || g
              from generate_series(0, ${sql.raw(String(count - 1))}) g order by g returning id`);
            return rows.map((row) => row.id);
          }),
        );
      }
      // One position in each of 120 units across five levels, one employee in each, every seventh left.
      const units = [
        ...tree[5].slice(0, 80),
        ...tree[4].slice(0, 30),
        ...tree[2].slice(0, 8),
        ...tree[1].slice(0, 2),
      ];
      positions = await withTeam(owner, async (tx, access) => {
        const { rows: created } = await tx.execute<{
          id: string;
          unit: string;
        }>(sql`
          insert into app.positions(workspace_id, org_unit_id, title, code)
          select ${access.workspaceId}::uuid, u, 'Fictional budget position ' || n, 'BUDGET-POS-' || n
          from unnest(${`{${units.join(",")}}`}::uuid[]) with ordinality t(u, n) order by n
          returning id, org_unit_id as unit`);
        const { rows: employees } = await tx.execute<{ id: string }>(sql`
          insert into app.employees(workspace_id, display_name, employee_number, status)
          select ${access.workspaceId}::uuid, 'Fictional Budget Person ' || lpad(n::text, 3, '0'), 'BUDGET-EMP-' || n,
            case when n % 7 = 0 then 'left' else 'active' end
          from generate_series(1, ${sql.raw(String(units.length))}) n order by n
          returning id`);
        await tx.execute(sql`
          insert into app.employee_positions(employee_id, position_id, workspace_id, "primary")
          select e, p, ${access.workspaceId}::uuid, true
          from unnest(${`{${employees.map((row) => row.id).join(",")}}`}::uuid[], ${`{${created.map((row) => row.id).join(",")}}`}::uuid[]) t(e, p)`);
        return created;
      });
    });

    it("reads each org chart level and a filtered directory page in at most 6 round trips", async () => {
      expect(tree.flat()).toHaveLength(500);
      const top = await timed(
        listOrgUnitsRoute,
        "/api/v1/org-units?page=1&pageSize=100",
      );
      expect(top.rows).toHaveLength(2);
      expect(top.roundTrips).toBeLessThanOrEqual(6);

      const middle = await timed(
        listOrgUnitsRoute,
        `/api/v1/org-units?parentId=${tree[2][0]}&page=1&pageSize=100`,
      );
      expect(middle.rows.length).toBeGreaterThan(0);
      expect(middle.roundTrips).toBeLessThanOrEqual(6);

      const unitPositions = await timed(
        listPositionsRoute,
        `/api/v1/positions?unitId=${positions[0].unit}&page=1&pageSize=200`,
      );
      expect(unitPositions.rows).toHaveLength(1);
      expect(unitPositions.roundTrips).toBeLessThanOrEqual(6);

      const holders = await timed(
        listEmployeesRoute,
        `/api/v1/employees?positionId=${positions[0].id}&page=1&pageSize=25`,
      );
      expect(holders.rows).toHaveLength(1);
      expect(holders.roundTrips).toBeLessThanOrEqual(6);

      const page = await timed(
        listEmployeesRoute,
        `/api/v1/employees?unitId=${tree[0][0]}&status=active&search=budget%20person&page=1&pageSize=25`,
      );
      expect(page.rows).toHaveLength(25);
      expect(page.roundTrips).toBeLessThanOrEqual(6);
    });

    // R2a-18 (job 060): the record scope and home units come back with install, and the scope
    // predicate sits inside the existing statements, so a hiring manager's counts hold.
    it("keeps a hiring manager's read, write and overview at 6, 11 and 15", async () => {
      const manager = await seedIdentity(fixture.db, {
        userId: "budget-hiring-manager",
        teamId: owner.teamId,
        role: "recruiter",
      });
      const { body: template } = HIRING_MANAGER_ROLE;
      const role = await createConfigDraft(owner, {
        type: "role",
        key: "budget-hiring-manager",
        body: {
          ...structuredClone(template),
          name: "Fictional budget hiring manager",
          // The overview reads tasks and onboarding as well.
          actions: {
            ...structuredClone(template.actions),
            tasks: ["view"],
            onboarding: ["view"],
          },
        },
      });
      await publishConfigVersion(owner, role.versionId);
      await assignMemberRole(
        owner,
        { userId: manager.userId, roleObjectId: role.objectId },
        new Headers(),
      );
      // A home unit in the middle of the tree: tree[3][0] and tree[4][0] are below tree[2][0].
      await withTeam(owner, async (tx, access) => {
        const [desk] = (
          await tx.execute<{ id: string }>(sql`
            insert into app.positions(workspace_id, org_unit_id, title, code)
            values (${access.workspaceId}::uuid, ${tree[2][0]}::uuid, 'Fictional budget manager desk', 'BUDGET-HM-DESK') returning id`)
        ).rows;
        const [person] = (
          await tx.execute<{ id: string }>(sql`
            insert into app.employees(workspace_id, display_name, employee_number, user_id)
            values (${access.workspaceId}::uuid, 'Fictional Budget Manager', 'BUDGET-HM', ${manager.userId}) returning id`)
        ).rows;
        await tx.execute(sql`
          insert into app.employee_positions(employee_id, position_id, workspace_id, "primary")
          values (${person.id}::uuid, ${desk.id}::uuid, ${access.workspaceId}::uuid, true)`);
      });
      const unitVacancy = await createRecord(owner, "vacancies", {
        data: { title: "Fictional budget unit vacancy" },
        orgUnitId: tree[3][0],
      });
      const unitCandidate = await createRecord(owner, "candidates", {
        data: { name: "Fictional Budget Unit Candidate" },
      });
      let unitApplication = await createRecord(owner, "applications", {
        candidateId: unitCandidate.id,
        vacancyId: unitVacancy.id,
        data: { stage: "Sourced" },
      });
      vi.mocked(getVerifiedSession).mockResolvedValue({
        user: { id: manager.userId, twoFactorEnabled: true },
        session: { activeOrganizationId: manager.teamId },
      } as never);
      try {
        const access = await withTeam(manager, (tx, state) =>
          Promise.resolve(state),
        );
        expect(access).toMatchObject({
          roleVersionId: role.versionId,
          recordScope: template.recordScope,
          homeUnits: [tree[2][0]],
        });
        const list = await call(
          "GET",
          "/api/v1/applications?page=1&pageSize=25",
          { resource: "applications" },
        );
        expect(list.status).toBe(200);
        // Only the application below the manager's unit.
        expect(
          (list.body.data as unknown as RecordDto[]).map((row) => row.id),
        ).toEqual([unitApplication.id]);
        // The simple read of the cases above: a task page, tasks being scoped by the creator rule.
        const read = await call("GET", "/api/v1/tasks?page=1&pageSize=25", {
          resource: "tasks",
        });
        expect(read.status).toBe(200);
        expect(read.body.data).toEqual([]);
        expect(read.roundTrips).toBe(6);
        const open = await call("GET", `/api/v1/vacancies/${unitVacancy.id}`, {
          resource: "vacancies",
          id: unitVacancy.id,
        });
        expect(open.status).toBe(200);
        expect(open.roundTrips).toBe(6);
        const stage = await call(
          "PATCH",
          `/api/v1/applications/${unitApplication.id}`,
          { resource: "applications", id: unitApplication.id },
          { version: unitApplication.version, data: { stage: "Screening" } },
        );
        expect(stage.status).toBe(200);
        expect(stage.roundTrips).toBe(11);
        unitApplication = stage.body.data;
        const moved = await call(
          "PATCH",
          `/api/v1/vacancies/${unitVacancy.id}`,
          { resource: "vacancies", id: unitVacancy.id },
          { version: unitVacancy.version, orgUnitId: tree[4][0] },
        );
        expect(moved.status).toBe(200);
        expect(moved.body.data).toMatchObject({ orgUnitId: tree[4][0] });
        // Inside the 11 of a simple write: no reference or uniqueness lookup, the cascade runs in
        // the update's own trigger and the label comes back in its RETURNING.
        expect(moved.roundTrips).toBe(9);
        const response = await overviewRoute(
          new Request(`${ORIGIN}/api/v1/overview`, {
            headers: { origin: ORIGIN, "x-team-id": manager.teamId },
          }),
        );
        expect(response.status).toBe(200);
        const timing = response.headers.get("server-timing") ?? "";
        expect(timing).toMatch(TIMING);
        expect(Number(TIMING.exec(timing)![1])).toBe(15);
      } finally {
        vi.mocked(getVerifiedSession).mockResolvedValue({
          user: { id: owner.userId, twoFactorEnabled: true },
          session: { activeOrganizationId: owner.teamId },
        } as never);
      }
    });
  });

  // R2a-20 (job 062): a task's assignees and linked record come back in the statements that read
  // and write it; only an assignee change adds a statement, the one that calls the helpers.
  it("keeps a task page with assignees and links at 6, a linked write at 11 and an assignee swap at 12", async () => {
    const colleague = await seedIdentity(fixture.db, {
      userId: "budget-colleague",
      teamId: owner.teamId,
      role: "recruiter",
    });
    const linked = await createRecord(owner, "tasks", {
      bucketId: buckets[0].id,
      parentRecordId: vacancy.id,
      data: {
        title: "Fictional budget linked task",
        assigneeIds: [owner.userId],
      },
    });
    const read = await call("GET", "/api/v1/tasks?page=1&pageSize=25", {
      resource: "tasks",
    });
    expect(read.status).toBe(200);
    expect(
      (read.body.data as unknown as RecordDto[]).find(
        (row) => row.id === linked.id,
      ),
    ).toMatchObject({
      parentKind: "vacancy",
      parentLabel: "Fictional budget vacancy",
      data: { assigneeIds: [owner.userId] },
    });
    expect(read.roundTrips).toBe(6);

    const relinked = await call(
      "PATCH",
      `/api/v1/tasks/${linked.id}`,
      { resource: "tasks", id: linked.id },
      { version: linked.version, parentRecordId: buckets[2].id },
    );
    expect(relinked.status).toBe(200);
    expect(relinked.body.data).toMatchObject({
      parentKind: "bucket",
      data: { assigneeIds: [owner.userId] },
    });
    expect(relinked.roundTrips).toBe(11);

    const swapped = await call(
      "PATCH",
      `/api/v1/tasks/${linked.id}`,
      { resource: "tasks", id: linked.id },
      {
        version: relinked.body.data.version,
        bucketId: buckets[1].id,
        data: { assigneeIds: [colleague.userId] },
      },
    );
    expect(swapped.status).toBe(200);
    expect(swapped.body.data).toMatchObject({
      bucketId: buckets[1].id,
      data: { assigneeIds: [colleague.userId] },
    });
    // The move of the simple write (11) plus one statement for the added and the removed assignee.
    expect(swapped.roundTrips).toBe(12);
  });

  // R2a-21 (job 064): the board comes from the documents install returns, so no statement is added.
  it("keeps a Tasks list with a task board at 6 on a cold and a warm cache", async () => {
    const { objectId, versionId } = await createConfigDraft(owner, {
      type: "task-board",
      key: "budget-board",
      body: {
        name: "Fictional budget board",
        columns: [buckets[1].id, buckets[0].id],
      },
    });
    await publishConfigVersion(owner, versionId);
    const path = `/api/v1/tasks?page=1&pageSize=25&board=${objectId}`;
    for (const cold of [true, false]) {
      if (cold) configBodyCache.clear();
      const read = await call("GET", path, { resource: "tasks" });
      expect(read.status).toBe(200);
      expect(
        (read.body.data as unknown as RecordDto[]).every((row) =>
          [buckets[0].id, buckets[1].id].includes(row.bucketId!),
        ),
      ).toBe(true);
      expect(read.roundTrips, cold ? "cold" : "warm").toBe(6);
      expect(configBodyCache.ids()).toContain(versionId);
    }
  });
});
