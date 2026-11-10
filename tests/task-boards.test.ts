import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Requests pick the pool by role, as on a split-role deployment: the identity role reads the
// membership, the data role runs withTeam. The session lookup is mocked per request.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));

import type { AppDb, TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import {
  configBodySchemas,
  taskBoardBodySchema,
  type RoleBody,
  type TaskBoardBody,
} from "@/domain/config";
import { ADMIN_ROLE, RECRUITER_ROLE } from "@/domain/config-defaults";
import type { RecordDto } from "@/domain/records";
import { getVerifiedSession } from "@/lib/auth-session";
import {
  archiveConfigObject,
  createConfigDraft,
  getConfigObject,
  listConfigHistory,
  publishConfigVersion,
  updateConfigDraft,
} from "@/lib/config-store";
import { notifications, overview } from "@/lib/insights";
import { assignMemberRole } from "@/lib/member-roles";
import type { Principal } from "@/lib/principal";
import {
  createRecord,
  exportRecords,
  listRecords,
  updateRecord,
} from "@/lib/records";
import { listTaskBoards } from "@/lib/task-boards";
import { installTenantContext } from "@/lib/tenant-context";
import {
  GET as boardsRoute,
  POST as createRoute,
} from "@/app/api/v1/task-boards/route";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";

// Fictional data only: one company with two fictional teams. Team A has buckets, a dropdown task
// field "Project", a vacancy, a job role and tasks; team B has its own (R2a-21, job 064).
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Row = Record<string, unknown>;
const TEAM = "tb-team";
const TEAM_B = "tb-team-b";
const ORIGIN = "http://localhost:3000";
const PAST = "2020-01-06";
const CONFIG_TABLES = ["config_objects", "config_versions"] as const;

describe("task boards per team under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, admin: Principal, recruiter: Principal;
  let viewer: Principal, scopedAdmin: Principal, scopedMember: Principal;
  let hiddenMember: Principal, ownerB: Principal, adminB: Principal;
  let ownerInB: Principal, ownerToken: Principal;
  /** The fixture records by name. */
  const id: Record<string, string> = {};
  /** The published boards by name: object id and version id. */
  const board: Record<string, { objectId: string; versionId: string }> = {};
  let completion: unknown;
  let untouched: Row[];

  /** Raw reads as the PGlite superuser, which bypasses RLS; only to inspect outcomes. */
  const look = async <T = Row>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  /** One data-role statement under the principal's verified context. */
  const sqlAs = (principal: Principal, statement: string) =>
    harness.dataDb().then((db) =>
      withDeadlinesAndSnapshot(db, async (tx: TeamTx, snapshot) => {
        await installTenantContext(tx, principal, snapshot);
        return (await tx.execute(sql.raw(statement))).rows as Row[];
      }),
    );
  const configRows = async () => ({
    ...Object.fromEntries(
      await Promise.all(
        CONFIG_TABLES.map(async (table) => [
          table,
          await look(`SELECT * FROM app.${table} ORDER BY 1`),
        ]),
      ),
    ),
    activity: await look(
      "SELECT id FROM app.activity WHERE kind = 'config' ORDER BY id",
    ),
  });
  /** The call is refused with this status and code, and no config row or audit row changes. */
  async function refused(
    call: () => Promise<unknown>,
    status: number,
    code: string,
  ) {
    const before = await configRows();
    await expect(call()).rejects.toMatchObject({ status, code });
    expect(await configRows()).toEqual(before);
  }
  /** The config activity rows of one board key, oldest first. */
  const audits = (key: string) =>
    look<{ action: string; type: string; team_id: string }>(
      "SELECT action, metadata->>'type' AS type, team_id FROM app.activity WHERE kind = 'config' AND metadata->>'key' = $1 ORDER BY created_at, id",
      [key],
    );
  const body = (
    columns: string[],
    filter?: TaskBoardBody["filter"],
    name = "Fictional board",
  ): TaskBoardBody => ({ name, columns, ...(filter ? { filter } : {}) });
  async function publish(p: Principal, key: string, value: TaskBoardBody) {
    const created = await createConfigDraft(p, {
      type: "task-board",
      key,
      body: value,
    });
    await publishConfigVersion(p, created.versionId, { type: "task-board" });
    return created;
  }
  const tasks = async (p: Principal, query: Record<string, string> = {}) =>
    (await listRecords(p, "tasks", new URLSearchParams(query))).data
      .map((row) => row.id)
      .sort();
  const named = (...names: string[]) => names.map((name) => id[name]).sort();
  async function route(
    p: Principal,
    handler: (request: Request) => Promise<Response>,
    path: string,
    init: { method?: string; body?: unknown; token?: boolean } = {},
  ) {
    vi.mocked(getVerifiedSession).mockResolvedValue({
      user: { id: p.userId, twoFactorEnabled: true },
      session: { activeOrganizationId: p.teamId },
    } as never);
    const response = await handler(
      new Request(`${ORIGIN}${path}`, {
        method: init.method ?? "GET",
        headers: {
          origin: ORIGIN,
          "x-team-id": p.teamId,
          ...(init.token
            ? { authorization: "Bearer fictional-board-token" }
            : {}),
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        data: Row[];
        error?: { code: string };
      },
    };
  }
  const create = async (p: Principal, resource: string, input: Row) =>
    (await createRecord(p, resource as never, input)).id;
  async function archive(p: Principal, resource: string, recordId: string) {
    const [row] = await look<{ version: number }>(
      "SELECT version FROM app.records WHERE id = $1",
      [recordId],
    );
    await updateRecord(p, resource as never, recordId, {
      version: row.version,
      archived: true,
    });
  }
  async function role(key: string, roleBody: RoleBody, member: Principal) {
    const { objectId, versionId } = await createConfigDraft(owner, {
      type: "role",
      key,
      body: roleBody,
    });
    await publishConfigVersion(owner, versionId);
    await assignMemberRole(
      owner,
      { userId: member.userId, roleObjectId: objectId },
      new Headers(),
    );
  }
  const completionState = async () => {
    const summary = await overview(owner);
    const reminders = await notifications(owner);
    return {
      open: summary.counts.tasks,
      overdue: summary.overdueTasks.map((row: RecordDto) => row.id).sort(),
      reminders: reminders.data.map((row) => row.key).sort(),
      total: reminders.total,
    };
  };
  const recordRows = () =>
    look(
      "SELECT id, kind, version, updated_at, bucket_id, data FROM app.records WHERE kind IN ('task', 'bucket', 'task-field') ORDER BY id",
    );

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, { userId: "tb-owner", teamId: TEAM });
    const member = (
      userId: string,
      teamRole: "admin" | "recruiter" | "viewer",
      teamId = TEAM,
    ) => seedIdentity(db, { userId, teamId, role: teamRole });
    admin = await member("tb-admin", "admin");
    recruiter = await member("tb-recruiter", "recruiter");
    viewer = await member("tb-viewer", "viewer");
    scopedAdmin = await member("tb-scoped-admin", "admin");
    scopedMember = await member("tb-scoped-member", "recruiter");
    hiddenMember = await member("tb-hidden-member", "recruiter");
    ownerB = await seedIdentity(db, { userId: "tb-owner-b", teamId: TEAM_B });
    adminB = await member("tb-admin-b", "admin", TEAM_B);
    ownerInB = await member("tb-owner", "recruiter", TEAM_B);
    ownerToken = await seedApiToken(await harness.asOwner(), owner);

    id.todo = await create(owner, "buckets", {
      data: { name: "Fictional to do", position: 0 },
    });
    id.doing = await create(owner, "buckets", {
      data: { name: "Fictional doing", position: 1 },
    });
    id.done = await create(owner, "buckets", {
      data: { name: "Fictional done", position: 2, completed: true },
    });
    id.old = await create(owner, "buckets", {
      data: { name: "Fictional old", position: 3 },
    });
    await archive(owner, "buckets", id.old);
    id.project = await create(owner, "task-fields", {
      data: {
        name: "Project",
        type: "Dropdown",
        options: ["Fictional Apollo", "Fictional Zephyr"],
      },
    });
    id.notes = await create(owner, "task-fields", {
      data: { name: "Fictional notes", type: "Text" },
    });
    id.vacancy = await create(owner, "vacancies", {
      data: { title: "Fictional board vacancy" },
    });
    id.closed = await create(owner, "vacancies", {
      data: { title: "Fictional archived vacancy" },
    });
    await archive(owner, "vacancies", id.closed);
    id.jobRole = await create(owner, "job-roles", {
      data: { title: "Fictional board role" },
    });
    id.bucketB = await create(ownerB, "buckets", {
      data: { name: "Fictional team B to do" },
    });
    id.vacancyB = await create(ownerB, "vacancies", {
      data: { title: "Fictional team B vacancy" },
    });
    id.jobRoleB = await create(ownerB, "job-roles", {
      data: { title: "Fictional team B role" },
    });
    id.projectB = await create(ownerB, "task-fields", {
      data: {
        name: "Project",
        type: "Dropdown",
        options: ["Fictional Apollo"],
      },
    });

    await role(
      "tb-scoped-admin",
      {
        ...structuredClone(ADMIN_ROLE.body),
        name: "Fictional scoped admin",
        recordScope: { pipeline: "assigned", candidates: "all", tasks: "all" },
      } as RoleBody,
      scopedAdmin,
    );
    await role(
      "tb-scoped-member",
      {
        ...structuredClone(RECRUITER_ROLE.body),
        name: "Fictional assigned tasks",
        recordScope: { pipeline: "all", candidates: "all", tasks: "assigned" },
      } as RoleBody,
      scopedMember,
    );
    await role(
      "tb-hidden-member",
      {
        ...structuredClone(RECRUITER_ROLE.body),
        name: "Fictional no project",
        fields: {
          ...structuredClone(RECRUITER_ROLE.body.fields),
          task: { [id.project]: "hidden" },
        },
      } as RoleBody,
      hiddenMember,
    );

    const task = (
      p: Principal,
      title: string,
      bucket: string,
      extra: Row = {},
      project?: string,
    ) =>
      create(p, "tasks", {
        bucketId: id[bucket],
        ...extra,
        data: {
          title,
          dueDate: PAST,
          customValues: project ? { [id.project]: project } : {},
        },
      });
    id.apollo = await task(
      owner,
      "Fictional Apollo task",
      "todo",
      { vacancyId: id.vacancy },
      "Fictional Apollo",
    );
    id.zephyr = await task(
      owner,
      "Fictional Zephyr task",
      "doing",
      { parentRecordId: id.jobRole },
      "Fictional Zephyr",
    );
    id.finished = await task(
      owner,
      "Fictional finished task",
      "done",
      {},
      "Fictional Apollo",
    );
    id.mine = await task(
      scopedMember,
      "Fictional scoped member task",
      "todo",
      {},
      "Fictional Apollo",
    );
    completion = await completionState();
    untouched = await recordRows();
  });
  afterAll(async () => harness?.close());

  describe("the strict body", () => {
    const valid = body(["00000000-0000-4000-8000-000000000001"]);
    it("is the task-board schema of the store and refuses unknown keys, no columns, a repeated column and two filters", () => {
      expect(configBodySchemas["task-board"]).toBe(taskBoardBodySchema);
      expect(taskBoardBodySchema.parse(valid)).toEqual(valid);
      const vacancy = {
        by: "vacancy",
        vacancyId: "00000000-0000-4000-8000-000000000002",
      };
      const field = {
        by: "field",
        fieldId: "00000000-0000-4000-8000-000000000003",
        value: "Fictional Apollo",
      };
      expect(
        taskBoardBodySchema.parse({ ...valid, filter: field }).filter,
      ).toEqual(field);
      for (const refused of [
        { ...valid, recordId: "00000000-0000-4000-8000-000000000009" },
        { ...valid, label: "Fictional" },
        { ...valid, columns: [] },
        {
          ...valid,
          columns: [valid.columns[0], valid.columns[0]],
        },
        { ...valid, columns: ["not-a-bucket-id"] },
        { ...valid, filter: [vacancy, field] },
        {
          ...valid,
          filter: { ...vacancy, recordId: field.fieldId },
        },
        { ...valid, filter: { ...field, extra: true } },
        { ...valid, filter: { by: "priority", value: "High" } },
        { ...valid, name: "" },
      ])
        expect(
          taskBoardBodySchema.safeParse(refused).success,
          JSON.stringify(refused),
        ).toBe(false);
    });
  });

  describe("own team, by the service, the routes and SQL", () => {
    let sprint: { objectId: string; versionId: string };

    it("creates, edits, publishes and retires a board with one activity row each, listed in History", async () => {
      sprint = await createConfigDraft(admin, {
        type: "task-board",
        key: "fictional-sprint",
        body: body([id.doing, id.todo], undefined, "Fictional sprint"),
      });
      expect(await audits("fictional-sprint")).toEqual([
        { action: "config.draft_created", type: "task-board", team_id: TEAM },
      ]);
      // A draft edit writes no row, as for roles.
      await updateConfigDraft(
        admin,
        sprint.versionId,
        { body: body([id.todo, id.doing], undefined, "Fictional sprint") },
        { type: "task-board" },
      );
      expect(await audits("fictional-sprint")).toHaveLength(1);
      expect(
        await publishConfigVersion(admin, sprint.versionId, {
          type: "task-board",
        }),
      ).toBe(1);
      expect(
        (await audits("fictional-sprint")).map((row) => row.action),
      ).toEqual(["config.draft_created", "config.published"]);
      board.sprint = sprint;

      // Every member who may view tasks lists it, without its filter.
      for (const p of [recruiter, viewer, admin]) {
        const listed = await route(p, boardsRoute, "/api/v1/task-boards");
        expect(listed.status).toBe(200);
        expect(listed.body.data).toEqual([
          {
            id: sprint.objectId,
            key: "fictional-sprint",
            name: "Fictional sprint",
            columns: [id.todo, id.doing],
          },
        ]);
      }
      const drafts = await route(
        admin,
        boardsRoute,
        "/api/v1/task-boards?drafts=true",
      );
      expect(drafts.status).toBe(200);
      expect(drafts.body.data).toMatchObject([
        {
          id: sprint.objectId,
          key: "fictional-sprint",
          current: { id: sprint.versionId, number: 1 },
          draft: null,
        },
      ]);

      // A second board, retired for good.
      const retiring = await publish(
        admin,
        "fictional-retired",
        body([id.todo], undefined, "Fictional retired"),
      );
      await archiveConfigObject(admin, retiring.objectId, {
        type: "task-board",
      });
      board.retired = retiring;
      expect(
        (await audits("fictional-retired")).map((row) => row.action),
      ).toEqual([
        "config.draft_created",
        "config.published",
        "config.archived",
      ]);
      expect(
        (await listTaskBoards(recruiter)).map((item) => item.id),
      ).not.toContain(retiring.objectId);
      // The key of a retired board takes no new draft, and the object is not retired twice.
      await refused(
        () =>
          createConfigDraft(admin, {
            type: "task-board",
            key: "fictional-retired",
            body: body([id.todo]),
          }),
        409,
        "config_state_conflict",
      );
      await refused(
        () =>
          archiveConfigObject(admin, retiring.objectId, { type: "task-board" }),
        409,
        "config_state_conflict",
      );
      // With a type, an object of another type is not found; existing callers pass none.
      await refused(
        () => archiveConfigObject(owner, sprint.objectId, { type: "role" }),
        404,
        "not_found",
      );

      // History: the company owner of the same team sees each change, the same owner in team B none.
      const keys = (rows: { objectType: string; objectKey: string }[]) =>
        rows
          .filter((row) => row.objectType === "task-board")
          .map((row) => row.objectKey);
      const history = await listConfigHistory(owner);
      expect(
        history
          .filter((row) => row.objectKey === "fictional-sprint")
          .map((row) => row.action)
          .reverse(),
      ).toEqual(["config.draft_created", "config.published"]);
      expect(
        history
          .filter((row) => row.objectKey === "fictional-retired")
          .map((row) => row.action)
          .reverse(),
      ).toEqual([
        "config.draft_created",
        "config.published",
        "config.archived",
      ]);
      expect(keys(await listConfigHistory(ownerInB))).toEqual([]);
    });

    it("shows another team's owner and admin none of it, and refuses their writes, by the service and SQL", async () => {
      const { versionId: pending } = await createConfigDraft(admin, {
        type: "task-board",
        key: "fictional-sprint",
        body: body([id.doing], undefined, "Fictional sprint"),
      });
      const [{ workspace }] = await look<{ workspace: string }>(
        "SELECT workspace_id::text AS workspace FROM app.config_objects WHERE id = $1",
        [sprint.objectId],
      );
      for (const p of [ownerB, adminB, ownerInB]) {
        expect(await listTaskBoards(p)).toEqual([]);
        expect(
          await getConfigObject(p, "task-board", "fictional-sprint"),
        ).toBeNull();
        await refused(
          () =>
            updateConfigDraft(
              p,
              pending,
              { body: body([id.bucketB]) },
              { type: "task-board" },
            ),
          404,
          "not_found",
        );
        await refused(
          () => publishConfigVersion(p, pending, { type: "task-board" }),
          404,
          "not_found",
        );
        await refused(
          () => archiveConfigObject(p, sprint.objectId, { type: "task-board" }),
          404,
          "not_found",
        );
        for (const statement of [
          `SELECT id FROM app.config_objects WHERE id = '${sprint.objectId}'`,
          `SELECT id FROM app.config_versions WHERE object_id = '${sprint.objectId}'`,
          `UPDATE app.config_objects SET archived_at = now() WHERE id = '${sprint.objectId}' RETURNING id`,
          `UPDATE app.config_versions SET body = '{"name":"Forged","columns":[]}' WHERE id = '${pending}' RETURNING id`,
          `DELETE FROM app.config_versions WHERE id = '${pending}' RETURNING id`,
        ])
          expect(await sqlAs(p, statement), `${p.userId} ${statement}`).toEqual(
            [],
          );
        for (const statement of [
          `SELECT tenant_context.publish_config_version('${pending}')`,
          `INSERT INTO app.config_versions(object_id, workspace_id, body) VALUES ('${sprint.objectId}', '${workspace}', '{"name":"Forged","columns":[]}')`,
        ]) {
          const before = await configRows();
          await expect(sqlAs(p, statement), statement).rejects.toMatchObject({
            cause: { code: "42501" },
          });
          expect(await configRows()).toEqual(before);
        }
      }
      // The team B owner and admin list only their own team's drafts.
      for (const p of [ownerB, adminB]) {
        const drafts = await route(
          p,
          boardsRoute,
          "/api/v1/task-boards?drafts=true",
        );
        expect(drafts.status).toBe(200);
        expect(drafts.body.data).toEqual([]);
        expect(
          (await route(p, boardsRoute, "/api/v1/task-boards")).body.data,
        ).toEqual([]);
      }
      // Team A's own admin still sees the draft and publishes it.
      expect(
        await publishConfigVersion(admin, pending, { type: "task-board" }),
      ).toBe(2);
    });

    it("refuses recruiters, viewers and tokens, and lets a team owner without company authority write", async () => {
      const { versionId } = await createConfigDraft(admin, {
        type: "task-board",
        key: "fictional-locked",
        body: body([id.todo]),
      });
      for (const p of [recruiter, viewer, ownerToken]) {
        await refused(
          () =>
            createConfigDraft(p, {
              type: "task-board",
              key: "fictional-denied",
              body: body([id.todo]),
            }),
          403,
          "config_forbidden",
        );
        await refused(
          () =>
            updateConfigDraft(
              p,
              versionId,
              { body: body([id.doing]) },
              { type: "task-board" },
            ),
          403,
          "config_forbidden",
        );
        await refused(
          () => publishConfigVersion(p, versionId, { type: "task-board" }),
          403,
          "config_forbidden",
        );
        await refused(
          () =>
            archiveConfigObject(p, board.sprint.objectId, {
              type: "task-board",
            }),
          403,
          "config_forbidden",
        );
      }
      for (const p of [recruiter, viewer]) {
        const drafts = await route(
          p,
          boardsRoute,
          "/api/v1/task-boards?drafts=true",
        );
        expect(drafts.status).toBe(403);
        expect(drafts.body.error?.code).toBe("config_forbidden");
      }
      // The routes are session only.
      for (const [handler, init] of [
        [boardsRoute, {}],
        [
          createRoute,
          {
            method: "POST",
            body: { key: "fictional-token", body: body([id.todo]) },
          },
        ],
      ] as const) {
        const response = await route(owner, handler, "/api/v1/task-boards", {
          ...init,
          token: true,
        });
        expect(response.status).toBe(403);
        expect(response.body.error?.code).toBe("session_required");
      }
      for (const query of ["drafts=false", "drafts=true&drafts=true", "x=1"]) {
        const response = await route(
          admin,
          boardsRoute,
          `/api/v1/task-boards?${query}`,
        );
        expect(response.status, query).toBe(400);
        expect(response.body.error?.code).toBe("invalid_input");
      }
      // Team B's owner holds no company authority, writes their own board and is granted none.
      const authority = () =>
        look("SELECT * FROM app.workspace_admins WHERE user_id = $1", [
          ownerB.userId,
        ]);
      expect(await authority()).toEqual([]);
      board.teamB = await publish(ownerB, "fictional-team-b", {
        name: "Fictional team B board",
        columns: [id.bucketB],
      });
      expect(await authority()).toEqual([]);
      expect(
        (
          await look("SELECT team_id FROM app.config_objects WHERE id = $1", [
            board.teamB.objectId,
          ])
        )[0],
      ).toEqual({ team_id: TEAM_B });
    });
  });

  describe("references at save", () => {
    it("refuses another team's, archived and out-of-scope records and wrong fields with nothing written", async () => {
      const draft = (p: Principal, value: unknown) => () =>
        createConfigDraft(p, {
          type: "task-board",
          key: "fictional-refused",
          body: value,
        });
      const field = (fieldId: string, value = "Fictional Apollo") =>
        body([id.todo], { by: "field", fieldId, value });
      for (const p of [admin, scopedAdmin]) {
        for (const [value, code] of [
          [body([id.bucketB]), "invalid_reference"],
          [body([id.todo, id.bucketB]), "invalid_reference"],
          [body([id.old]), "archived_reference"],
          [body([id.vacancy]), "invalid_reference"],
          [
            body([id.todo], { by: "vacancy", vacancyId: id.vacancyB }),
            "invalid_reference",
          ],
          // Out of the scoped admin's scope, the archived vacancy reads as missing.
          [
            body([id.todo], { by: "vacancy", vacancyId: id.closed }),
            p === scopedAdmin ? "invalid_reference" : "archived_reference",
          ],
          [
            body([id.todo], { by: "linked-record", recordId: id.jobRoleB }),
            "invalid_reference",
          ],
          [field(id.notes), "invalid_reference"],
          [field(id.project, "Fictional Mars"), "invalid_reference"],
          [field(id.projectB), "invalid_reference"],
          [field(id.vacancy), "invalid_reference"],
        ] as const)
          await refused(draft(p, value), 400, code);
      }
      // The scoped admin's pipeline scope is assigned records: the vacancy is out of it.
      for (const filter of [
        { by: "vacancy", vacancyId: id.vacancy },
        { by: "linked-record", recordId: id.vacancy },
      ] as const)
        await refused(
          draft(scopedAdmin, body([id.todo], filter)),
          400,
          "invalid_reference",
        );
      // In scope for the owner, so the same filters save for them.
      const saved = await createConfigDraft(admin, {
        type: "task-board",
        key: "fictional-refused",
        body: body([id.todo], { by: "vacancy", vacancyId: id.vacancy }),
      });
      // An edit is checked too, and the draft keeps its body.
      await refused(
        () =>
          updateConfigDraft(
            admin,
            saved.versionId,
            { body: body([id.bucketB]) },
            { type: "task-board" },
          ),
        400,
        "invalid_reference",
      );
      // The scoped admin still writes a board of the team's own buckets.
      await createConfigDraft(scopedAdmin, {
        type: "task-board",
        key: "fictional-scoped",
        body: body([id.done, id.todo]),
      });
      // An unknown key is refused by the strict schema, by the service and the route.
      const before = await configRows();
      await expect(
        createConfigDraft(admin, {
          type: "task-board",
          key: "fictional-unknown",
          body: { ...body([id.todo]), label: "Fictional" },
        }),
      ).rejects.toBeInstanceOf(z.ZodError);
      const response = await route(admin, createRoute, "/api/v1/task-boards", {
        method: "POST",
        body: {
          key: "fictional-unknown",
          body: { ...body([id.todo]), recordId: id.apollo },
        },
      });
      expect(response.status).toBe(400);
      expect(response.body.error?.code).toBe("invalid_input");
      expect(await configRows()).toEqual(before);
    });
  });

  describe("the task list with a board", () => {
    beforeAll(async () => {
      board.columns = await publish(
        admin,
        "fictional-columns",
        body([id.doing, id.todo], undefined, "Fictional columns"),
      );
      board.vacancy = await publish(
        admin,
        "fictional-vacancy",
        body(
          [id.todo, id.doing, id.done],
          { by: "vacancy", vacancyId: id.vacancy },
          "Fictional vacancy board",
        ),
      );
      board.linked = await publish(
        admin,
        "fictional-linked",
        body(
          [id.todo, id.doing, id.done],
          { by: "linked-record", recordId: id.jobRole },
          "Fictional linked board",
        ),
      );
      board.project = await publish(
        admin,
        "fictional-project",
        body(
          [id.todo, id.done],
          { by: "field", fieldId: id.project, value: "Fictional Apollo" },
          "Fictional Project board",
        ),
      );
    });

    it("keeps today's list without a board and limits it to the board's columns and filter with one", async () => {
      const all = named("apollo", "zephyr", "finished", "mine");
      expect(await tasks(owner)).toEqual(all);
      expect(await tasks(owner, { board: board.columns.objectId })).toEqual(
        named("apollo", "zephyr", "mine"),
      );
      expect(await tasks(owner, { board: board.vacancy.objectId })).toEqual(
        named("apollo"),
      );
      expect(await tasks(owner, { board: board.linked.objectId })).toEqual(
        named("zephyr"),
      );
      expect(await tasks(owner, { board: board.project.objectId })).toEqual(
        named("apollo", "finished", "mine"),
      );
      // With the other filters, record scope included.
      expect(
        await tasks(owner, {
          board: board.project.objectId,
          search: "finished",
        }),
      ).toEqual(named("finished"));
      // A scoped member sees only their in-scope tasks on any board.
      expect(await tasks(scopedMember)).toEqual(named("mine"));
      for (const name of ["columns", "project", "vacancy"])
        expect(
          await tasks(scopedMember, { board: board[name].objectId }),
          name,
        ).toEqual(name === "vacancy" ? [] : named("mine"));
    });

    it("lists the published boards by name, and leaves out a board whose filter field the role hides", async () => {
      const listed = await listTaskBoards(owner);
      expect(listed.map((item) => item.name)).toEqual([
        "Fictional columns",
        "Fictional linked board",
        "Fictional Project board",
        "Fictional sprint",
        "Fictional vacancy board",
      ]);
      for (const item of listed) expect(item).not.toHaveProperty("filter");
      const hidden = await listTaskBoards(hiddenMember);
      expect(hidden.map((item) => item.id)).not.toContain(
        board.project.objectId,
      );
      expect(hidden).toHaveLength(listed.length - 1);
      await expect(
        tasks(hiddenMember, { board: board.project.objectId }),
      ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
    });

    it("refuses another team's board, a retired board, an unknown id, another resource and an export", async () => {
      const refusals = [
        () => tasks(owner, { board: board.teamB.objectId }),
        () => tasks(ownerB, { board: board.columns.objectId }),
        () => tasks(owner, { board: board.retired.objectId }),
        () => tasks(owner, { board: "00000000-0000-4000-8000-000000000999" }),
        () => tasks(owner, { board: "not-a-board" }),
        () =>
          listRecords(
            owner,
            "vacancies",
            new URLSearchParams({ board: board.columns.objectId }),
          ),
      ];
      for (const call of refusals)
        await expect(call()).rejects.toMatchObject({
          status: 400,
          code: "invalid_query",
          message:
            "board must name a current task board of this team, on tasks only.",
        });
      await expect(
        exportRecords(
          owner,
          "tasks",
          new URLSearchParams({ board: board.columns.objectId }),
        ),
      ).rejects.toMatchObject({ status: 400, code: "invalid_query" });
      expect(await tasks(ownerB, { board: board.teamB.objectId })).toEqual([]);
    });

    it("keeps overdue tasks, the open-task count and reminders, and changes no task, bucket or task field", async () => {
      // The columns board leaves out the bucket that counts as completed.
      expect(await completionState()).toEqual(completion);
      expect(completion).toMatchObject({
        open: 3,
        overdue: named("apollo", "zephyr", "mine"),
      });
      expect(await recordRows()).toEqual(untouched);
    });
  });
});
