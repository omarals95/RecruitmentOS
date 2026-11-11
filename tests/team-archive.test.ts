import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requests pick the pool by role, as on a split-role deployment: the identity role reads the
// membership and tokens, the data role runs withTeam. The session lookup is mocked per request.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));
// CV reservations resolve the fake Blob binding; no provider is contacted.
const storage = vi.hoisted(() => ({ gateway: undefined as unknown }));
vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...original,
    storageConfigured: () => true,
    resolveStorageBinding: () =>
      ({
        provider: "blob",
        environment: "development",
        store: "store_fictional",
      }) as const,
    getStorage: async () => storage.gateway,
  };
});

import type { TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import { RECRUITER_ROLE } from "@/domain/config-defaults";
import { createToken } from "@/lib/api-tokens";
import { getVerifiedSession } from "@/lib/auth-session";
import { eraseCandidate } from "@/lib/candidate-erasure";
import { createConfigDraft, publishConfigVersion } from "@/lib/config-store";
import { withTeam } from "@/lib/db-team";
import { assignMemberRole } from "@/lib/member-roles";
import { TEAM_ARCHIVED } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import { createRecord } from "@/lib/records";
import { updateStorageSettings } from "@/lib/storage-settings";
import { installTenantContext } from "@/lib/tenant-context";
import { resetMemberTwoStep } from "@/lib/two-step";
import * as mcpRoute from "@/app/api/mcp/route";
import {
  GET as getRecordRoute,
  PATCH as patchRecordRoute,
} from "@/app/api/v1/[resource]/[id]/route";
import { POST as exportRoute } from "@/app/api/v1/[resource]/export/route";
import {
  GET as listRoute,
  POST as createRoute,
} from "@/app/api/v1/[resource]/route";
import { POST as bulkRoute } from "@/app/api/v1/applications/bulk/route";
import { PATCH as stateRoute } from "@/app/api/v1/candidates/[id]/state/route";
import { POST as uploadRoute } from "@/app/api/v1/candidates/[id]/cvs/uploads/route";
import { GET as accessRoute } from "@/app/api/v1/me/access/route";
import { GET as overviewRoute } from "@/app/api/v1/overview/route";
import { POST as publishBoardRoute } from "@/app/api/v1/task-boards/[id]/publish/route";
import { POST as createBoardRoute } from "@/app/api/v1/task-boards/route";
import { PUT as archiveRoute } from "@/app/api/v1/teams/archive/route";
import { POST as bootstrapRoute } from "@/app/api/v1/teams/bootstrap/route";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";
import { fakeBlob } from "./helpers/fake-blob";
import { CLIENT_IP, stubLocalAuthReadiness } from "./helpers/readiness";

// Fictional data only: one company workspace with an archived-to-be team, the company owner's own
// team and a second company owner's team (ADM-05, job 078).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const ORIGIN = "http://localhost:3000";
const TEAM = "archive-team";
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Row = Record<string, unknown>;
// Each route takes its own params shape; the test passes the one it needs.
type Handler = (
  request: Request,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: { params: Promise<any> },
) => Promise<Response>;
type Caller = Principal | { token: string; label: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = { status: number; body: any };
const ARCHIVED_ERROR = { code: "team_archived", message: TEAM_ARCHIVED };

describe("team archive and restore under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, admin: Principal, recruiter: Principal;
  let companyOwner: Principal, companyOwnerAdmin: Principal;
  let outsider: Principal;
  let ownerToken: string;
  const id: Record<string, string> = {};

  /** Raw reads as the PGlite superuser, which bypasses RLS; only to inspect outcomes. */
  const look = async <T = Row>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  const label = (as: Caller) => ("token" in as ? as.label : as.userId);
  /** One route call as a signed-in member of the principal's team, or with a Bearer token. */
  async function call(
    as: Caller,
    handler: Handler,
    path: string,
    init: {
      method?: string;
      body?: unknown;
      params?: Record<string, string>;
    } = {},
  ): Promise<Answer> {
    if (!("token" in as))
      vi.mocked(getVerifiedSession).mockResolvedValue({
        user: { id: as.userId, twoFactorEnabled: true },
        session: { activeOrganizationId: as.teamId, createdAt: new Date() },
      } as never);
    const response = await handler(
      new Request(`${ORIGIN}${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...("token" in as
            ? { authorization: `Bearer ${as.token}` }
            : { origin: ORIGIN, "x-team-id": as.teamId }),
          "x-forwarded-for": CLIENT_IP,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
      { params: Promise.resolve(init.params ?? {}) },
    );
    const text = await response.text();
    return {
      status: response.status,
      body: response.headers.get("content-type")?.includes("json")
        ? JSON.parse(text)
        : text,
    };
  }
  const archive = (as: Principal, archived: unknown) =>
    call(as, archiveRoute, "/api/v1/teams/archive", {
      method: "PUT",
      body: { archived },
    });
  /** One MCP JSON-RPC call with a Bearer token. */
  let rpc = 0;
  async function mcp(token: string, method: string, params?: unknown) {
    const response = await mcpRoute.POST(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-forwarded-for": CLIENT_IP,
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method, params }),
      }),
    );
    expect(response.status, method).toBe(200);
    const body = await response.json();
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();
    return body.result;
  }
  const createCandidateTool = (token: string) =>
    mcp(token, "tools/call", {
      name: "create_candidate",
      arguments: {
        idempotencyKey: randomUUID(),
        name: "Fictional Tool Candidate",
      },
    });
  /** Statements run on the data role under the principal's signed context, rolled back after. */
  class Rollback extends Error {
    constructor(readonly rows: Row[]) {
      super("rollback");
    }
  }
  async function asData(p: Principal, statement: string): Promise<Row[]> {
    const db = await harness.dataDb();
    try {
      await withDeadlinesAndSnapshot(db, async (tx: TeamTx, snapshot) => {
        await installTenantContext(
          tx,
          { ...p, scopes: [...p.scopes] },
          snapshot,
        );
        throw new Rollback(
          (await tx.execute(sql.raw(statement))).rows as Row[],
        );
      });
    } catch (error) {
      if (error instanceof Rollback) return error.rows;
      throw (error as Error).cause ?? error;
    }
    return [];
  }
  const helper = (p: Principal, teamId: string, archived: boolean | null) =>
    asData(
      p,
      `SELECT tenant_context.set_team_archived('${teamId}', ${archived === null ? "NULL" : archived}) AS changed`,
    );
  const teamState = () =>
    look<{ archived_at: Date | null; archived_by: string | null }>(
      "SELECT archived_at, archived_by FROM app.workspace_teams WHERE team_id = $1",
      [TEAM],
    );
  const archiveRows = () =>
    look<Row>(
      "SELECT team_id, record_id, actor_id, actor_type, token_id, action, kind, summary, metadata FROM app.activity WHERE kind = 'team-archive' ORDER BY created_at, id",
    );
  /** Every row of the team's data and configuration, to show a refusal changed nothing. */
  const teamData = async () => ({
    records: await look(
      "SELECT * FROM app.records WHERE team_id = $1 ORDER BY id",
      [TEAM],
    ),
    uploads: await look(
      "SELECT * FROM app.uploads WHERE team_id = $1 ORDER BY id",
      [TEAM],
    ),
    configObjects: await look(
      "SELECT * FROM app.config_objects WHERE team_id = $1 ORDER BY id",
      [TEAM],
    ),
    configVersions: await look(
      "SELECT v.* FROM app.config_versions v JOIN app.config_objects o ON o.id = v.object_id WHERE o.team_id = $1 ORDER BY v.id",
      [TEAM],
    ),
    states: await look(
      "SELECT * FROM app.candidate_states WHERE team_id = $1 ORDER BY 1, 2, 3",
      [TEAM],
    ),
  });
  const archiveCount = async () => (await archiveRows()).length;
  const expectArchivedRefusal = (answer: Answer, what: string) => {
    expect(answer.status, what).toBe(403);
    expect(answer.body.error, what).toMatchObject(ARCHIVED_ERROR);
  };

  beforeAll(async () => {
    stubLocalAuthReadiness();
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    storage.gateway = fakeBlob().gateway;
    const db = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    companyOwner = await seedIdentity(db, {
      userId: "archive-company-owner",
      teamId: "archive-home",
    });
    owner = await seedIdentity(db, { userId: "archive-owner", teamId: TEAM });
    admin = await seedIdentity(db, {
      userId: "archive-admin",
      teamId: TEAM,
      role: "admin",
    });
    recruiter = await seedIdentity(db, {
      userId: "archive-recruiter",
      teamId: TEAM,
      role: "recruiter",
    });
    companyOwnerAdmin = await seedIdentity(db, {
      userId: "archive-company-owner",
      teamId: TEAM,
      role: "admin",
    });
    // A second company owner, who is not a member of the team.
    outsider = await seedIdentity(db, {
      userId: "archive-outsider",
      teamId: "archive-other",
    });
    await harness.client.exec(
      `INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${COMPANY}','archive-outsider','owner','{}')`,
    );
    ownerToken = (
      await createToken(owner, {
        name: "Fictional archive token",
        scopes: [
          "candidates:read",
          "candidates:write",
          "recruitment:read",
          "recruitment:write",
          "cvs:read",
          "cvs:write",
        ],
      })
    ).token;
    id.candidate = (
      await createRecord(owner, "candidates", {
        data: { name: "Fictional Archive Candidate" },
      })
    ).id;
    id.erasable = (
      await createRecord(owner, "candidates", {
        data: { name: "Fictional Erasable Candidate" },
      })
    ).id;
    id.vacancy = (
      await createRecord(owner, "vacancies", {
        data: { title: "Fictional Archive Vacancy", status: "Open" },
      })
    ).id;
    id.bucket = (
      await createRecord(owner, "buckets", {
        data: { name: "Fictional Archive Bucket" },
      })
    ).id;
    id.draft = (
      await createConfigDraft(owner, {
        type: "task-board",
        key: "fictional-archive-board",
        body: { name: "Fictional archive board", columns: [id.bucket] },
      })
    ).versionId;
    // The team's storage row, as every team that ever reserved CV storage has one.
    await updateStorageSettings(admin, {
      maxBytes: null,
      maxFiles: null,
      uploadRequestsPerMinute: null,
      mcpCvTextEnabled: true,
    });
    // A published role of the company, for the assignment while archived.
    const role = await createConfigDraft(companyOwner, {
      type: "role",
      key: "fictional-archive-role",
      body: { ...RECRUITER_ROLE.body, name: "Fictional archive role" },
    });
    await publishConfigVersion(companyOwner, role.versionId);
    id.role = role.objectId;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness?.close();
  });

  it("refuses a team admin, a recruiter, company owners who are not its owner and a token, by the route and the helper", async () => {
    const before = { state: await teamState(), audit: await archiveRows() };
    for (const archived of [true, false]) {
      for (const p of [admin, recruiter, companyOwnerAdmin]) {
        const refused = await archive(p, archived);
        expect(refused.status, p.userId).toBe(403);
        expect(refused.body.error, p.userId).toMatchObject({
          code: "team_archive_forbidden",
          message: "Only an owner of this team can archive or restore it.",
        });
        await expect(helper(p, TEAM, archived), p.userId).rejects.toMatchObject(
          { code: "42501" },
        );
      }
      // A company owner who is not a member: the route refuses the team, the helper their context.
      const outside = await archive({ ...outsider, teamId: TEAM }, archived);
      expect(outside.status).toBe(403);
      expect(outside.body.error.code).toBe("team_access_denied");
      await expect(helper(outsider, TEAM, archived)).rejects.toMatchObject({
        code: "42501",
      });
      // Even the team's owner cannot name another team, and null arguments are invalid.
      await expect(
        helper(owner, "archive-other", archived),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(helper(owner, TEAM, null)).rejects.toMatchObject({
        code: "22023",
      });
      // A token: session_required from the route, 42501 from its context.
      const bearer = await call(
        { token: ownerToken, label: "token" },
        archiveRoute,
        "/api/v1/teams/archive",
        { method: "PUT", body: { archived } },
      );
      expect(bearer.status).toBe(403);
      expect(bearer.body.error.code).toBe("session_required");
      const token = await seedApiToken(await harness.asOwner(), owner, [
        "candidates:read",
        "candidates:write",
      ]);
      await expect(helper(token, TEAM, archived)).rejects.toMatchObject({
        code: "42501",
      });
    }
    // Strict, small JSON only.
    for (const body of [{}, { archived: "yes" }, { archived: true, name: "x" }])
      expect((await archive(owner, body)).status, JSON.stringify(body)).toBe(
        400,
      );
    expect(
      (
        await call(owner, archiveRoute, "/api/v1/teams/archive", {
          method: "PUT",
          body: { archived: true, padding: "x".repeat(1100) },
        })
      ).status,
    ).toBe(413);
    expect({ state: await teamState(), audit: await archiveRows() }).toEqual(
      before,
    );
    expect(before.state).toEqual([{ archived_at: null, archived_by: null }]);
  });

  it("deletes and rewrites nothing: archive plus restore add exactly two team-archive rows", async () => {
    const data = async () => ({
      ...(await teamData()),
      members: await look(
        "SELECT * FROM auth.member WHERE organization_id = $1 ORDER BY id",
        [TEAM],
      ),
      activity: await look(
        "SELECT * FROM app.activity WHERE team_id = $1 AND kind <> 'team-archive' ORDER BY id",
        [TEAM],
      ),
    });
    const before = { data: await data(), audit: await archiveRows() };
    expect((await archive(owner, true)).body.data).toEqual({
      archived: true,
      changed: true,
    });
    expect((await archive(owner, false)).body.data).toEqual({
      archived: false,
      changed: true,
    });
    expect(await data()).toEqual(before.data);
    const audit = await archiveRows();
    expect(audit.slice(0, before.audit.length)).toEqual(before.audit);
    expect(audit.slice(before.audit.length)).toEqual(
      [
        ["team.archived", "Archived the team"],
        ["team.restored", "Restored the team"],
      ].map(([action, summary]) => ({
        team_id: TEAM,
        record_id: null,
        actor_id: owner.userId,
        actor_type: "session",
        token_id: null,
        action,
        kind: "team-archive",
        summary,
        metadata: {},
      })),
    );
    expect(await teamState()).toEqual([
      { archived_at: null, archived_by: null },
    ]);
  });

  describe("once the owner archives the team", () => {
    let beforeArchive: number;
    beforeAll(async () => {
      beforeArchive = await archiveCount();
      const answer = await archive(owner, true);
      expect(answer).toEqual({
        status: 200,
        body: { data: { archived: true, changed: true } },
      });
    });

    it("stores the archive and one audit row by the owner's session", async () => {
      const [state] = await teamState();
      expect(state.archived_at).toBeInstanceOf(Date);
      expect(state.archived_by).toBe(owner.userId);
      expect(await archiveCount()).toBe(beforeArchive + 1);
      expect((await archiveRows()).at(-1)).toEqual({
        team_id: TEAM,
        record_id: null,
        actor_id: owner.userId,
        actor_type: "session",
        token_id: null,
        action: "team.archived",
        kind: "team-archive",
        summary: "Archived the team",
        metadata: {},
      });
    });

    it("keeps every read open to a recruiter, an admin, the owner and a token", async () => {
      const callers: Caller[] = [
        recruiter,
        admin,
        owner,
        { token: ownerToken, label: "token" },
      ];
      for (const as of callers) {
        const who = label(as);
        const list = await call(as, listRoute, "/api/v1/candidates", {
          params: { resource: "candidates" },
        });
        expect(list.status, who).toBe(200);
        expect(
          list.body.data.map((row: { id: string }) => row.id),
          who,
        ).toContain(id.candidate);
        const one = await call(
          as,
          getRecordRoute,
          `/api/v1/candidates/${id.candidate}`,
          { params: { resource: "candidates", id: id.candidate } },
        );
        expect(one.status, who).toBe(200);
        expect(
          (await call(as, overviewRoute, "/api/v1/overview")).status,
          who,
        ).toBe(200);
        const exported = await call(
          as,
          exportRoute,
          "/api/v1/candidates/export",
          { method: "POST", params: { resource: "candidates" } },
        );
        expect(exported.status, who).toBe(200);
        expect(exported.body, who).toContain("Fictional Archive Candidate");
        if ("token" in as) continue;
        // Session only: a token gets session_required here, archived or not.
        const access = await call(as, accessRoute, "/api/v1/me/access");
        expect(access.status, who).toBe(200);
        expect(access.body.data.teamArchived, who).toBe(true);
        expect(
          access.body.data.scopes.filter((scope: string) =>
            scope.endsWith(":write"),
          ),
          who,
        ).toEqual([]);
      }
    });

    it("refuses every write with team_archived and changes no record, upload or configuration row", async () => {
      const before = await teamData();
      const [{ version }] = await look<{ version: number }>(
        "SELECT version FROM app.records WHERE id = $1",
        [id.candidate],
      );
      const writes: [string, (as: Caller) => Promise<Answer>][] = [
        [
          "record create",
          (as) =>
            call(as, createRoute, "/api/v1/candidates", {
              method: "POST",
              params: { resource: "candidates" },
              body: { data: { name: "Fictional Refused Candidate" } },
            }),
        ],
        [
          "record update",
          (as) =>
            call(as, patchRecordRoute, `/api/v1/candidates/${id.candidate}`, {
              method: "PATCH",
              params: { resource: "candidates", id: id.candidate },
              body: { version, data: { name: "Fictional Renamed Candidate" } },
            }),
        ],
        [
          "bulk applications",
          (as) =>
            call(as, bulkRoute, "/api/v1/applications/bulk", {
              method: "POST",
              body: { candidateIds: [id.candidate], vacancyId: id.vacancy },
            }),
        ],
        [
          "candidate state",
          (as) =>
            call(as, stateRoute, `/api/v1/candidates/${id.candidate}/state`, {
              method: "PATCH",
              params: { id: id.candidate },
              body: { version: 0, shortlisted: true },
            }),
        ],
        [
          "CV upload reservation",
          (as) =>
            call(
              as,
              uploadRoute,
              `/api/v1/candidates/${id.candidate}/cvs/uploads`,
              {
                method: "POST",
                params: { id: id.candidate },
                body: {
                  originalName: "fictional-cv.pdf",
                  mimeType: "application/pdf",
                  sizeBytes: 2048,
                  clientUploadId: randomUUID(),
                },
              },
            ),
        ],
      ];
      const sessionWrites: [string, (as: Principal) => Promise<Answer>][] = [
        [
          "task-board create",
          (as) =>
            call(as, createBoardRoute, "/api/v1/task-boards", {
              method: "POST",
              body: {
                key: "fictional-refused-board",
                body: { name: "Fictional refused board", columns: [id.bucket] },
              },
            }),
        ],
        [
          "task-board publish",
          (as) =>
            call(
              as,
              publishBoardRoute,
              `/api/v1/task-boards/${id.draft}/publish`,
              { method: "POST", params: { id: id.draft } },
            ),
        ],
        [
          "team bootstrap",
          (as) =>
            call(as, bootstrapRoute, "/api/v1/teams/bootstrap", {
              method: "POST",
            }),
        ],
      ];
      for (const as of [recruiter, admin, owner]) {
        for (const [what, write] of [...writes, ...sessionWrites])
          // A recruiter may never prepare the task board: that role refusal comes first.
          if (as !== recruiter || what !== "team bootstrap")
            expectArchivedRefusal(await write(as), `${as.userId}: ${what}`);
      }
      const token = { token: ownerToken, label: "token" };
      for (const [what, write] of writes)
        expectArchivedRefusal(await write(token), `token: ${what}`);
      expect(await teamData()).toEqual(before);
    });

    it("lists only read tools over MCP and refuses a write tool with team_archived, audited as denied", async () => {
      const tools = (await mcp(ownerToken, "tools/list")).tools as {
        name: string;
        annotations: { readOnlyHint: boolean };
      }[];
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.map((tool) => tool.name)).toContain("search_candidates");
      expect(tools.filter((tool) => !tool.annotations.readOnlyHint)).toEqual(
        [],
      );
      const before = await teamData();
      const denied = () =>
        look(
          "SELECT action, metadata FROM app.activity WHERE team_id = $1 AND kind = 'mcp-tool' AND action = 'mcp.tool_denied'",
          [TEAM],
        );
      const deniedBefore = (await denied()).length;
      const result = await createCandidateTool(ownerToken);
      expect(result.isError).toBe(true);
      expect(result.structuredContent.error).toEqual(ARCHIVED_ERROR);
      const rows = await denied();
      expect(rows).toHaveLength(deniedBefore + 1);
      expect(JSON.stringify(rows.at(-1))).toContain("create_candidate");
      expect(await teamData()).toEqual(before);
    });

    it("refuses direct writes by the data role under a member's or the owner's context", async () => {
      const before = await teamData();
      for (const p of [recruiter, owner]) {
        const access = await withTeam(
          { ...p, scopes: [...p.scopes] },
          (_tx, state) => Promise.resolve(state),
        );
        expect(access.teamArchived, p.userId).toBe(true);
        expect(
          access.scopes.every((scope) => scope.endsWith(":read")),
          p.userId,
        ).toBe(true);
        for (const statement of [
          `INSERT INTO app.records(team_id, kind, data, created_by) VALUES ('${TEAM}', 'candidate', '{"name":"Fictional Direct"}', '${p.userId}')`,
          `INSERT INTO app.activity(team_id, actor_id, actor_type, action, kind, summary, metadata) VALUES ('${TEAM}', '${p.userId}', 'session', 'record.commented', 'record', 'Fictional comment event', '{}')`,
          `INSERT INTO app.config_objects(workspace_id, team_id, type, key) VALUES ('${COMPANY}', '${TEAM}', 'task-board', 'fictional-direct-board')`,
          `UPDATE app.workspace_teams SET archived_at = NULL, archived_by = NULL WHERE team_id = '${TEAM}'`,
        ])
          await expect(
            asData(p, statement),
            `${p.userId}: ${statement}`,
          ).rejects.toMatchObject({ code: "42501" });
        expect(
          await asData(
            p,
            `UPDATE app.records SET data = data || '{"name":"Fictional Direct Rename"}' WHERE team_id = '${TEAM}' AND id = '${id.candidate}' RETURNING id`,
          ),
          p.userId,
        ).toEqual([]);
      }
      expect(await teamData()).toEqual(before);
      expect(await teamState()).toEqual([
        expect.objectContaining({ archived_by: owner.userId }),
      ]);
    });

    it("keeps team administration, role assignment, rename, storage settings, tokens and candidate erasure working", async () => {
      // Membership administration: an owner resets a member's two-step sign-in.
      await resetMemberTwoStep({ ...owner }, recruiter.userId);
      expect(
        await look(`SELECT two_factor_enabled FROM auth."user" WHERE id = $1`, [
          recruiter.userId,
        ]),
      ).toEqual([{ two_factor_enabled: false }]);
      await (
        await harness.asOwner()
      ).execute(
        sql`UPDATE auth."user" SET two_factor_enabled = true WHERE id = ${recruiter.userId}`,
      );
      // Configured-role assignment by a company owner of the team, then cleared again.
      await assignMemberRole(
        { ...companyOwnerAdmin },
        { userId: recruiter.userId, roleObjectId: id.role },
        new Headers(),
      );
      expect(
        await look(
          "SELECT role_object_id FROM app.member_roles WHERE team_id = $1 AND user_id = $2",
          [TEAM, recruiter.userId],
        ),
      ).toEqual([{ role_object_id: id.role }]);
      await assignMemberRole(
        { ...companyOwnerAdmin },
        { userId: recruiter.userId, roleObjectId: null },
        new Headers(),
      );
      // Rename: Better Auth's update of the team row on the identity role.
      await (
        await harness.identityDb()
      ).execute(
        sql`UPDATE auth.organization SET name = 'Fictional Archived Team' WHERE id = ${TEAM}`,
      );
      expect(
        await look("SELECT name FROM auth.organization WHERE id = $1", [TEAM]),
      ).toEqual([{ name: "Fictional Archived Team" }]);
      // CV storage settings.
      expect(
        await updateStorageSettings(
          { ...admin },
          {
            maxBytes: 5_000_000,
            maxFiles: 10,
            uploadRequestsPerMinute: null,
            mcpCvTextEnabled: true,
          },
        ),
      ).toMatchObject({ maxBytes: 5_000_000, maxFiles: 10 });
      // API tokens.
      const created = await createToken(
        { ...recruiter },
        { name: "Fictional archived-team token", scopes: ["candidates:read"] },
      );
      expect(created.token).toMatch(/^ros_/);
      // Candidate erasure, per record.
      const erased = await eraseCandidate({ ...owner }, id.erasable, {
        confirmName: "Fictional Erasable Candidate",
      });
      expect(erased.alreadyErased).toBe(false);
      expect(
        await look("SELECT count(*)::int AS n FROM app.records WHERE id = $1", [
          id.erasable,
        ]),
      ).toEqual([{ n: 0 }]);
    });

    describe("then restores it", () => {
      beforeAll(async () => {
        const answer = await archive(owner, false);
        expect(answer).toEqual({
          status: 200,
          body: { data: { archived: false, changed: true } },
        });
      });

      it("makes the record create, task-board write and MCP write work again", async () => {
        const created = await call(owner, createRoute, "/api/v1/candidates", {
          method: "POST",
          params: { resource: "candidates" },
          body: { data: { name: "Fictional Restored Candidate" } },
        });
        expect(created.status).toBe(201);
        const published = await call(
          owner,
          publishBoardRoute,
          `/api/v1/task-boards/${id.draft}/publish`,
          { method: "POST", params: { id: id.draft } },
        );
        expect(published.status).toBe(200);
        const tool = await createCandidateTool(ownerToken);
        expect(tool.isError, JSON.stringify(tool.structuredContent)).not.toBe(
          true,
        );
        const access = await call(owner, accessRoute, "/api/v1/me/access");
        expect(access.body.data.teamArchived).toBe(false);
        expect(await teamState()).toEqual([
          { archived_at: null, archived_by: null },
        ]);
      });

      it("answers a repeated archive or restore with changed false and no audit row", async () => {
        const before = await archiveRows();
        expect((await archive(owner, false)).body).toEqual({
          data: { archived: false, changed: false },
        });
        expect(await archiveRows()).toEqual(before);
        expect((await archive(owner, true)).body.data.changed).toBe(true);
        const archived = await archiveRows();
        expect((await archive(owner, true)).body).toEqual({
          data: { archived: true, changed: false },
        });
        expect(await archiveRows()).toEqual(archived);
        expect((await archive(owner, false)).body.data.changed).toBe(true);
      });
    });
  });
});
