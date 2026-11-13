import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requests pick the pool by role, as on a split-role deployment: the identity role reads the
// membership, the data role runs withTeam. Only one PGlite role is active at a time.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));

import type { AppDb } from "@/db";
import {
  ACTION_RESOURCES,
  ACTIONS,
  ADMIN_AREAS,
  PAGE_KEYS,
  RECORD_RESOURCES,
  type RoleBody,
} from "@/domain/config";
import {
  ADMIN_ROLE,
  OWNER_ROLE,
  RECRUITER_ROLE,
  VIEWER_ROLE,
  builtInRoleFor,
} from "@/domain/config-defaults";
import { resourceToKind } from "@/domain/records";
import {
  accessContext,
  accessMap,
  authorize,
  type AccessContext,
  type AccessRequest,
} from "@/lib/authz";
import { getVerifiedSession } from "@/lib/auth-session";
import { createConfigDraft, publishConfigVersion } from "@/lib/config-store";
import { withTeam } from "@/lib/db-team";
import { createEmployee, linkEmployeeUser } from "@/lib/directory";
import { ApiError } from "@/lib/errors";
import { assignMemberRole } from "@/lib/member-roles";
import { roleScopes, type Role } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import { GET as meAccessRoute } from "@/app/api/v1/me/access/route";
import { GET as configHistoryRoute } from "@/app/api/v1/config-history/route";
import { GET as accessChangesRoute } from "@/app/api/v1/access-changes/route";
import { GET as activityRoute } from "@/app/api/v1/activity/route";
import { GET as domainRoute } from "@/app/api/v1/admin/domain/route";
import * as authorityRoute from "@/app/api/v1/company-authority/route";
import * as rolesRoute from "@/app/api/v1/roles/route";
import * as roleRoute from "@/app/api/v1/roles/[id]/route";
import * as publishRoute from "@/app/api/v1/roles/[id]/publish/route";
import { createSplitRoleDb, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace with two fictional teams (R2a-11).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const ORIGIN = "http://localhost:3000";
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_FIELDS = [
  "action",
  "actorName",
  "fromVersionNumber",
  "objectKey",
  "objectType",
  "occurredAt",
  "versionNumber",
];
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Route = (request: Request) => Promise<Response>;

const signIn = (p: Principal) =>
  vi.mocked(getVerifiedSession).mockResolvedValue({
    user: { id: p.userId, twoFactorEnabled: true },
    session: { activeOrganizationId: p.teamId, createdAt: new Date() },
  } as never);
/** Every action authorize() allows per resource, asked one request at a time. */
function expectedAnswers(ctx: AccessContext) {
  const allowed = (request: AccessRequest) => {
    try {
      return authorize(ctx, request);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) return null;
      throw error;
    }
  };
  const actions: Record<string, string[]> = {};
  for (const resource of ACTION_RESOURCES) {
    const list = ACTIONS.filter(
      (action) => allowed({ resource, action }) !== null,
    );
    if (list.length) actions[resource] = list;
  }
  const fields: Record<string, unknown> = {};
  for (const resource of RECORD_RESOURCES) {
    const decision = allowed({ resource, action: "view" });
    if (decision) fields[resourceToKind[resource]] = decision.fields;
  }
  return {
    actions,
    fields,
    adminAreas: ADMIN_AREAS.filter(
      (adminArea) => allowed({ action: "admin", adminArea }) !== null,
    ),
  };
}

describe("accessMap", () => {
  const session = (role: Role): Principal => ({
    userId: "fictional-user",
    teamId: "fictional-team",
    role,
    scopes: roleScopes(role),
    authType: "session",
  });
  const contextOf = (
    role: Role,
    companyLevel: "owner" | "admin" | null = null,
  ) => {
    const p = session(role);
    return accessContext(p, {
      scopes: p.scopes,
      workspaceId: COMPANY,
      memberRole: role,
      companyLevel,
      companyAreas: companyLevel === "admin" ? ["fields"] : [],
      versions: {},
    });
  };

  it("answers every action, field rule and company area exactly as authorize does", () => {
    for (const role of ["owner", "admin", "recruiter", "viewer"] as const)
      for (const level of ["owner", "admin", null] as const) {
        const ctx = contextOf(role, level);
        const map = accessMap(ctx);
        expect(map, `${role} / ${level}`).toEqual({
          role: {
            name: builtInRoleFor(role).body.name,
            membership: role,
          },
          scopes: ctx.scopes,
          pages: PAGE_KEYS.filter((page) =>
            builtInRoleFor(role).body.pages.includes(page),
          ),
          ...expectedAnswers(ctx),
        });
        expect(map.adminAreas).toEqual(
          level === "owner" ? [...ADMIN_AREAS] : level ? ["fields"] : [],
        );
      }
    expect(accessMap(contextOf("viewer")).actions.candidates).toEqual([
      "view",
      "export",
    ]);
  });

  it("returns empty pages, actions, fields and areas without a role", () => {
    const p = session("owner");
    const ctx = accessContext(p, {
      scopes: p.scopes,
      workspaceId: COMPANY,
      memberRole: "owner",
      companyLevel: "owner",
      companyAreas: [],
      versions: {},
      roleVersionId: null,
    });
    expect(ctx.role).toBeNull();
    expect(accessMap(ctx)).toEqual({
      role: null,
      scopes: [],
      pages: [],
      actions: {},
      fields: {},
      adminAreas: [],
    });
  });
});

describe("Admin portal routes under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, recruiter: Principal, narrowed: Principal;
  let companyAdmin: Principal, teamOwnerB: Principal, teamAdminA: Principal;
  let narrowRole: { objectId: string; versionId: string; body: RoleBody };
  const ids: string[] = [];

  /** Raw statements as the PGlite superuser, which bypasses RLS; only to arrange or inspect. */
  const superuser = async (text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query(text, params)).rows;
  };
  /** Service calls run on the data role, like a request. */
  const run = async <T>(work: () => Promise<T>) => {
    await harness.dataDb();
    return work();
  };
  async function get(
    route: Route,
    as: Principal | "bearer",
    path: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; text: string; body: any }> {
    if (as !== "bearer") signIn(as);
    const response = await route(
      new Request(`${ORIGIN}${path}`, {
        headers: {
          origin: ORIGIN,
          ...(as === "bearer"
            ? { authorization: "Bearer fictional-portal-token" }
            : { "x-team-id": as.teamId }),
        },
      }),
    );
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  }
  /** The access state install returns for this member, as a request would see it. */
  const contextFor = async (p: Principal) =>
    run(() => withTeam(p, async (_tx, access) => accessContext(p, access)));

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, {
      userId: "portal-owner",
      teamId: "portal-team-a",
    });
    teamAdminA = await seedIdentity(db, {
      userId: "portal-team-admin",
      teamId: "portal-team-a",
      role: "admin",
    });
    recruiter = await seedIdentity(db, {
      userId: "portal-recruiter",
      teamId: "portal-team-a",
      role: "recruiter",
    });
    narrowed = await seedIdentity(db, {
      userId: "portal-narrowed",
      teamId: "portal-team-a",
      role: "recruiter",
    });
    // A newly created team: its owner holds no company authority.
    teamOwnerB = await seedIdentity(db, {
      userId: "portal-owner-b",
      teamId: "portal-team-b",
    });
    // A company admin with one area, working in team B as a recruiter.
    companyAdmin = await seedIdentity(db, {
      userId: "portal-company-admin",
      teamId: "portal-team-b",
      role: "recruiter",
    });
    await harness.client.exec(
      `INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${COMPANY}','portal-company-admin','admin','{fields}')`,
    );
    // Configuration events made in team A by the company owner.
    const draft = await run(() =>
      createConfigDraft(owner, {
        type: "workflow",
        key: "portal-workflow",
        body: { label: "Fictional portal workflow" },
      }),
    );
    await run(() => publishConfigVersion(owner, draft.versionId));
    const body: RoleBody = structuredClone({
      ...(RECRUITER_ROLE.body as RoleBody),
      name: "Fictional narrowed recruiter",
      scopes: roleScopes("recruiter").filter((scope) => scope !== "cvs:write"),
      actions: {
        ...structuredClone(RECRUITER_ROLE.body.actions),
        candidates: ["view", "export", "comment"],
      },
    });
    const role = await run(() =>
      createConfigDraft(owner, { type: "role", key: "portal-narrow", body }),
    );
    await run(() => publishConfigVersion(owner, role.versionId));
    narrowRole = { ...role, body };
    // The member's team role already equals the role's membership: no team-role change is needed.
    await run(() =>
      assignMemberRole(
        owner,
        { userId: narrowed.userId, roleObjectId: role.objectId },
        new Headers(),
      ),
    );
    ids.push(
      ...[
        owner,
        teamAdminA,
        recruiter,
        narrowed,
        teamOwnerB,
        companyAdmin,
      ].flatMap((p) => [p.userId, p.teamId]),
      COMPANY,
      draft.objectId,
      draft.versionId,
      role.objectId,
      role.versionId,
      ...(["owner", "admin", "recruiter", "viewer"] as const).map(
        (r) => builtInRoleFor(r).versionId,
      ),
    );
  });
  afterAll(async () => harness?.close());

  describe("GET /api/v1/me/access", () => {
    it("returns each caller's own answers, equal to authorize under their own scopes", async () => {
      const cases: [
        Principal,
        Role,
        "owner" | "admin" | null,
        string[],
        { name: string; membership: string },
      ][] = [
        [owner, "owner", "owner", [...ADMIN_AREAS], OWNER_ROLE.body],
        [companyAdmin, "recruiter", "admin", ["fields"], RECRUITER_ROLE.body],
        [teamOwnerB, "owner", null, [], OWNER_ROLE.body],
        [teamAdminA, "admin", null, [], ADMIN_ROLE.body],
        [recruiter, "recruiter", null, [], RECRUITER_ROLE.body],
      ];
      for (const [p, teamRole, companyLevel, adminAreas, role] of cases) {
        const { status, body } = await get(
          meAccessRoute,
          p,
          "/api/v1/me/access",
        );
        expect(status, p.userId).toBe(200);
        const ctx = await contextFor(p);
        expect(body, p.userId).toEqual({
          data: {
            teamRole,
            companyLevel,
            teamArchived: false,
            planAccess: { read: false, write: false },
            role: { name: role.name, membership: role.membership },
            scopes: ctx.scopes,
            pages: PAGE_KEYS.filter((page) => ctx.role!.pages.includes(page)),
            ...expectedAnswers(ctx),
          },
        });
        expect(body.data.adminAreas, p.userId).toEqual(adminAreas);
        expect(Object.keys(body.data).sort()).toEqual(
          [
            "actions",
            "adminAreas",
            "companyLevel",
            "fields",
            "pages",
            "planAccess",
            "role",
            "scopes",
            "teamArchived",
            "teamRole",
          ].sort(),
        );
      }
    });

    it("returns the narrower answers of an assigned configured role", async () => {
      const { status, body } = await get(
        meAccessRoute,
        narrowed,
        "/api/v1/me/access",
      );
      expect(status).toBe(200);
      const ctx = await contextFor(narrowed);
      expect(ctx.role).toEqual(narrowRole.body);
      expect(body.data).toMatchObject({
        teamRole: "recruiter",
        companyLevel: null,
        planAccess: { read: false, write: false },
        role: { name: "Fictional narrowed recruiter", membership: "recruiter" },
        scopes: ctx.scopes,
        ...expectedAnswers(ctx),
      });
      expect(body.data.adminAreas).toEqual([]);
      expect(body.data.scopes).not.toContain("cvs:write");
      expect(body.data.actions.candidates).toEqual([
        "view",
        "export",
        "comment",
      ]);
      const { body: plain } = await get(
        meAccessRoute,
        recruiter,
        "/api/v1/me/access",
      );
      expect(plain.data.scopes).toContain("cvs:write");
      expect(plain.data.actions.candidates).toContain("edit");
    });

    // ADM-26: the database's allows_plan answers; the plan scopes come from the team role.
    it("answers Plan & pay access for a company owner holding the grant only where their team role gives the plan scopes", async () => {
      await superuser(
        "UPDATE app.workspace_admins SET plan_access = true WHERE user_id = $1",
        [owner.userId],
      );
      const inTeamB = await seedIdentity(await harness.asOwner(), {
        userId: owner.userId,
        teamId: teamOwnerB.teamId,
        role: "recruiter",
      });
      try {
        const asOwner = await get(meAccessRoute, owner, "/api/v1/me/access");
        expect(asOwner.status).toBe(200);
        expect(asOwner.body.data).toMatchObject({
          teamRole: "owner",
          companyLevel: "owner",
          planAccess: { read: true, write: true },
        });
        const asRecruiter = await get(
          meAccessRoute,
          inTeamB,
          "/api/v1/me/access",
        );
        expect(asRecruiter.status).toBe(200);
        expect(asRecruiter.body.data).toMatchObject({
          teamRole: "recruiter",
          companyLevel: "owner",
          planAccess: { read: false, write: false },
        });
        expect(asRecruiter.body.data.scopes).not.toContain("plans:read");
      } finally {
        await superuser(
          "UPDATE app.workspace_admins SET plan_access = false WHERE user_id = $1",
          [owner.userId],
        );
        await superuser(
          "DELETE FROM auth.member WHERE user_id = $1 AND organization_id = $2",
          [owner.userId, teamOwnerB.teamId],
        );
      }
    });

    it("holds no user, team, workspace, role, version or object id", async () => {
      for (const p of [owner, companyAdmin, teamOwnerB, recruiter, narrowed]) {
        const { text } = await get(meAccessRoute, p, "/api/v1/me/access");
        for (const id of ids)
          expect(text, `${p.userId}: ${id}`).not.toContain(id);
        expect(text).not.toContain("Fictional portal workflow");
      }
    });

    it("refuses a Bearer token", async () => {
      const { status, body } = await get(
        meAccessRoute,
        "bearer",
        "/api/v1/me/access",
      );
      expect(status).toBe(403);
      expect(body.error.code).toBe("session_required");
    });
  });

  describe("GET /api/v1/config-history", () => {
    it("lists config events of the workspace to company owners and admins, paged with nextBefore", async () => {
      for (const p of [owner, companyAdmin]) {
        const { status, body } = await get(
          configHistoryRoute,
          p,
          "/api/v1/config-history",
        );
        expect(status, p.userId).toBe(200);
        expect(body.pagination).toEqual({
          pageSize: 25,
          hasMore: false,
          nextBefore: null,
        });
        expect(
          body.data.map((row: { action: string; objectKey: string }) => [
            row.action,
            row.objectKey,
          ]),
        ).toEqual([
          ["config.published", "portal-narrow"],
          ["config.draft_created", "portal-narrow"],
          ["config.published", "portal-workflow"],
          ["config.draft_created", "portal-workflow"],
        ]);
        for (const row of body.data)
          expect(Object.keys(row).sort()).toEqual(HISTORY_FIELDS);
        expect(body.data[0]).toMatchObject({
          objectType: "role",
          versionNumber: 1,
          fromVersionNumber: null,
          actorName: "Fictional Test User",
        });
      }
      const first = await get(
        configHistoryRoute,
        companyAdmin,
        "/api/v1/config-history?pageSize=3",
      );
      expect(first.body.data).toHaveLength(3);
      expect(first.body.pagination).toEqual({
        pageSize: 3,
        hasMore: true,
        nextBefore: new Date(first.body.data[2].occurredAt).toISOString(),
      });
      const next = await get(
        configHistoryRoute,
        companyAdmin,
        `/api/v1/config-history?pageSize=3&before=${encodeURIComponent(first.body.pagination.nextBefore)}`,
      );
      expect(next.status).toBe(200);
      expect(
        next.body.data.map((row: { action: string; objectKey: string }) => [
          row.action,
          row.objectKey,
        ]),
      ).toEqual([["config.draft_created", "portal-workflow"]]);
      expect(next.body.pagination).toEqual({
        pageSize: 3,
        hasMore: false,
        nextBefore: null,
      });
      for (const id of ids) expect(first.text + next.text).not.toContain(id);
    });

    it("refuses callers without company authority and a Bearer token", async () => {
      for (const p of [teamOwnerB, teamAdminA, recruiter]) {
        const { status, body } = await get(
          configHistoryRoute,
          p,
          "/api/v1/config-history",
        );
        expect(status, p.userId).toBe(403);
        expect(body.error.code, p.userId).toBe("config_forbidden");
      }
      const bearer = await get(
        configHistoryRoute,
        "bearer",
        "/api/v1/config-history",
      );
      expect(bearer.status).toBe(403);
      expect(bearer.body.error.code).toBe("session_required");
    });

    it("answers 400 invalid_input for a bad page size, a bad time or an unknown key", async () => {
      for (const query of [
        "pageSize=0",
        "pageSize=101",
        "pageSize=2.5",
        "pageSize=many",
        "before=yesterday",
        "objectId=00000000-0000-4000-a000-000000000099",
        "page=2",
      ]) {
        const { status, body } = await get(
          configHistoryRoute,
          owner,
          `/api/v1/config-history?${query}`,
        );
        expect(status, query).toBe(400);
        expect(body.error.code, query).toBe("invalid_input");
      }
    });
  });

  describe("GET /api/v1/access-changes", () => {
    it("lists role-assignment and home-unit rows of the last seven days, newest first, to a company owner", async () => {
      const employee = await run(() =>
        createEmployee(owner, {
          displayName: "Fictional Portal Employee",
          employeeNumber: "FICT-PORTAL-1",
        }),
      );
      await run(() =>
        linkEmployeeUser(owner, employee.id, { userId: recruiter.userId }),
      );
      // Rows older than seven days are left out.
      await superuser(
        `INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary,metadata,created_at) VALUES
          ($1,$2,'session','role.assigned','role-assignment','Fictional old row',jsonb_build_object('workspaceId',$3::text,'affectedUserId','portal-old-member'),now()-interval '8 days'),
          ($1,$2,'session','scope.home_units_changed','scope','Fictional old row',jsonb_build_object('workspaceId',$3::text,'affectedUserIds',jsonb_build_array('portal-old-member')),now()-interval '8 days')`,
        [owner.teamId, owner.userId, COMPANY],
      );
      const { status, body, text } = await get(
        accessChangesRoute,
        owner,
        "/api/v1/access-changes",
      );
      expect(status).toBe(200);
      expect(body.truncated).toBe(false);
      expect(text).not.toContain("portal-old-member");
      expect(
        body.data.map(
          (row: {
            kind: string;
            action: string;
            affectedUserIds: string[];
          }) => [row.kind, row.action, row.affectedUserIds],
        ),
      ).toEqual([
        ["home-units", "scope.home_units_changed", [recruiter.userId]],
        ["role-assignment", "role.assigned", [narrowed.userId]],
      ]);
      expect(body.data[0]).toEqual({
        occurredAt: expect.any(String),
        kind: "home-units",
        action: "scope.home_units_changed",
        affectedUserIds: [recruiter.userId],
        roleName: null,
        actorName: "Fictional Test User",
      });
      expect(body.data[1]).toMatchObject({
        roleName: "Fictional narrowed recruiter",
        actorName: "Fictional Test User",
      });
      const times = body.data.map((row: { occurredAt: string }) =>
        new Date(row.occurredAt).getTime(),
      );
      expect(times).toEqual([...times].sort((a, b) => b - a));
      for (const time of times)
        expect(time).toBeGreaterThan(Date.now() - 7 * DAY_MS);
    });

    it("says truncated when a full page of a kind is still inside the seven days", async () => {
      await superuser(
        `INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary,metadata,created_at)
          SELECT $1,$2,'session','scope.home_units_changed','scope','Fictional bulk row',jsonb_build_object('workspaceId',$3::text,'affectedUserIds',jsonb_build_array('portal-bulk-member')),now()-make_interval(hours=>n)
          FROM generate_series(1,100) n`,
        [owner.teamId, owner.userId, COMPANY],
      );
      const { status, body } = await get(
        accessChangesRoute,
        owner,
        "/api/v1/access-changes",
      );
      expect(status).toBe(200);
      expect(body.truncated).toBe(true);
      expect(
        body.data.filter((row: { kind: string }) => row.kind === "home-units"),
      ).toHaveLength(100);
    });

    it("refuses a company admin, a team owner, a team admin, a Bearer token and any query key", async () => {
      for (const p of [companyAdmin, teamOwnerB, teamAdminA, recruiter]) {
        const { status, body } = await get(
          accessChangesRoute,
          p,
          "/api/v1/access-changes",
        );
        expect(status, p.userId).toBe(403);
        expect(body.error.code, p.userId).toBe("role_assignment_forbidden");
      }
      const bearer = await get(
        accessChangesRoute,
        "bearer",
        "/api/v1/access-changes",
      );
      expect(bearer.status).toBe(403);
      expect(bearer.body.error.code).toBe("session_required");
      const query = await get(
        accessChangesRoute,
        owner,
        "/api/v1/access-changes?pageSize=10",
      );
      expect(query.status).toBe(400);
      expect(query.body.error.code).toBe("invalid_input");
    });
  });

  // ADM-40 (job 098): the Domain page's route, company owners only (D20).
  describe("GET /api/v1/admin/domain", () => {
    it("answers a company owner the configured address, and refuses a company admin, a team owner, a team admin, a recruiter, a Bearer token and any query key", async () => {
      vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
      try {
        const { status, body } = await get(
          domainRoute,
          owner,
          "/api/v1/admin/domain",
        );
        expect(status).toBe(200);
        expect(body).toEqual({
          data: {
            address: {
              origin: ORIGIN,
              https: false,
              originOnly: true,
              valid: true,
            },
          },
        });
        for (const p of [companyAdmin, teamOwnerB, teamAdminA, recruiter]) {
          const refused = await get(domainRoute, p, "/api/v1/admin/domain");
          expect(refused.status, p.userId).toBe(403);
          expect(refused.body.error.code, p.userId).toBe("domain_forbidden");
        }
        const bearer = await get(domainRoute, "bearer", "/api/v1/admin/domain");
        expect(bearer.status).toBe(403);
        expect(bearer.body.error.code).toBe("session_required");
        const query = await get(
          domainRoute,
          owner,
          `/api/v1/admin/domain?address=${encodeURIComponent("https://attacker.example.test")}`,
        );
        expect(query.status).toBe(400);
        expect(query.body.error.code).toBe("invalid_input");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});

// R2a-12 (job 056): the role routes and the company authority route, company owners only.
describe("Roles & permissions routes under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, member: Principal, leaver: Principal;
  let recruiter: Principal, companyAdmin: Principal, teamOwnerB: Principal;

  const superuser = async (text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query(text, params)).rows;
  };
  const authorityRows = () =>
    superuser(
      "SELECT team_id, actor_id, metadata FROM app.activity WHERE kind = 'workspace-authority' AND action = 'workspace_authority.changed' ORDER BY created_at, id",
    );
  const holders = () =>
    superuser(
      "SELECT user_id, level, areas, plan_access, suspended_at IS NOT NULL AS suspended FROM app.workspace_admins ORDER BY user_id",
    );
  const configRows = () =>
    superuser(
      "SELECT o.id, o.key, o.current_version_id, o.draft_version_id, v.body FROM app.config_objects o LEFT JOIN app.config_versions v ON v.id = o.draft_version_id ORDER BY o.key",
    );
  /** One request through a route handler, as a signed-in member or with a Bearer token. */
  async function call(
    handler: (request: Request, context: never) => Promise<Response>,
    as: Principal | "bearer",
    method: string,
    path: string,
    options: { body?: unknown; params?: Record<string, string> } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; body: any }> {
    if (as !== "bearer") signIn(as);
    const response = await handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          origin: ORIGIN,
          ...(options.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...(as === "bearer"
            ? { authorization: "Bearer fictional-roles-token" }
            : { "x-team-id": as.teamId }),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
      { params: Promise.resolve(options.params ?? {}) } as never,
    );
    return { status: response.status, body: await response.json() };
  }
  const grant = (as: Principal | "bearer", body: unknown) =>
    call(authorityRoute.POST, as, "POST", "/api/v1/company-authority", {
      body,
    });
  /** Expects the call to be refused without changing a holder or writing an audit row. */
  async function refusedGrant(
    as: Principal | "bearer",
    body: unknown,
    status: number,
    code: string,
    message?: string,
  ) {
    const before = [await holders(), await authorityRows()];
    const response = await grant(as, body);
    expect(response.status, JSON.stringify(body)).toBe(status);
    expect(response.body.error.code, JSON.stringify(body)).toBe(code);
    if (message) expect(response.body.error.message).toBe(message);
    expect([await holders(), await authorityRows()]).toEqual(before);
  }

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    owner = await seedIdentity(db, {
      userId: "roles-owner",
      teamId: "roles-team-a",
    });
    member = await seedIdentity(db, {
      userId: "roles-member",
      teamId: "roles-team-a",
      role: "recruiter",
    });
    leaver = await seedIdentity(db, {
      userId: "roles-leaver",
      teamId: "roles-team-a",
      role: "recruiter",
    });
    recruiter = await seedIdentity(db, {
      userId: "roles-recruiter",
      teamId: "roles-team-a",
      role: "recruiter",
    });
    teamOwnerB = await seedIdentity(db, {
      userId: "roles-owner-b",
      teamId: "roles-team-b",
    });
    companyAdmin = await seedIdentity(db, {
      userId: "roles-company-admin",
      teamId: "roles-team-b",
      role: "recruiter",
    });
    await harness.client.exec(
      `INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${COMPANY}','roles-company-admin','admin','{fields}')`,
    );
  });
  afterAll(async () => harness?.close());

  describe("company authority", () => {
    it("grants, changes and removes admin and owner levels, areas and plan access, auditing each change once", async () => {
      const list = await call(
        authorityRoute.GET,
        owner,
        "GET",
        "/api/v1/company-authority",
      );
      expect(list.status).toBe(200);
      expect(list.body.data).toEqual([
        {
          userId: owner.userId,
          name: "Fictional Test User",
          level: "owner",
          areas: [],
          planAccess: false,
          suspended: false,
          twoStep: true,
          since: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
        },
        {
          userId: companyAdmin.userId,
          name: "Fictional Test User",
          level: "admin",
          areas: ["fields"],
          planAccess: false,
          suspended: false,
          twoStep: true,
          since: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
        },
      ]);
      const before = (await authorityRows()).length;
      const steps: [unknown, boolean, Record<string, unknown> | null][] = [
        [
          {
            userId: member.userId,
            level: "admin",
            areas: ["fields"],
            planAccess: true,
          },
          true,
          { level: "admin", areas: ["fields"], planAccess: true },
        ],
        // The same grant again changes nothing and writes no row.
        [
          {
            userId: member.userId,
            level: "admin",
            areas: ["fields"],
            planAccess: true,
          },
          false,
          null,
        ],
        [
          {
            userId: member.userId,
            level: "admin",
            areas: ["organisation", "fields"],
            planAccess: false,
          },
          true,
          {
            level: "admin",
            areas: ["fields", "organisation"],
            planAccess: false,
          },
        ],
        [
          {
            userId: member.userId,
            level: "owner",
            areas: [],
            planAccess: true,
          },
          true,
          { level: "owner", areas: [], planAccess: true },
        ],
        // The owner's own plan access.
        [
          {
            userId: owner.userId,
            level: "owner",
            areas: [],
            planAccess: true,
          },
          true,
          { level: "owner", areas: [], planAccess: true },
        ],
        [{ userId: member.userId, level: null }, true, null],
        [{ userId: member.userId, level: null }, false, null],
      ];
      let expected = before;
      for (const [body, changed, after] of steps) {
        const response = await grant(owner, body);
        expect(response, JSON.stringify(body)).toEqual({
          status: 200,
          body: { data: { changed } },
        });
        if (changed) expected += 1;
        const rows = await authorityRows();
        expect(rows, JSON.stringify(body)).toHaveLength(expected);
        if (changed)
          expect(rows.at(-1)).toMatchObject({
            team_id: owner.teamId,
            actor_id: owner.userId,
            metadata: {
              targetUserId: (body as { userId: string }).userId,
              after: after ? { ...after, suspended: false } : null,
            },
          });
      }
      expect(
        (await holders()).filter(
          (row) => (row as { user_id: string }).user_id === member.userId,
        ),
      ).toEqual([]);
      expect(
        (await holders()).find(
          (row) => (row as { user_id: string }).user_id === owner.userId,
        ),
      ).toMatchObject({ level: "owner", plan_access: true });
    });

    it("refuses removing or demoting the last company owner, and a grant to someone in no team", async () => {
      for (const body of [
        { userId: owner.userId, level: null },
        {
          userId: owner.userId,
          level: "admin",
          areas: ["fields"],
          planAccess: true,
        },
      ])
        await refusedGrant(
          owner,
          body,
          409,
          "last_company_owner",
          "The last company owner cannot be removed or demoted. Make someone else a company owner first.",
        );
      await refusedGrant(
        owner,
        {
          userId: "roles-nobody",
          level: "admin",
          areas: [],
          planAccess: false,
        },
        409,
        "not_in_company",
        "This person is not a member of any team in this company. Invite them to a team first.",
      );
    });

    it("restores a suspended admin after they rejoin a team, clearing the suspension with an audit row", async () => {
      const body = {
        userId: leaver.userId,
        level: "admin",
        areas: ["workflows"],
        planAccess: true,
      };
      expect((await grant(owner, body)).body).toEqual({
        data: { changed: true },
      });
      await superuser("DELETE FROM auth.member WHERE user_id = $1", [
        leaver.userId,
      ]);
      const listed = await call(
        authorityRoute.GET,
        owner,
        "GET",
        "/api/v1/company-authority",
      );
      expect(
        listed.body.data.find(
          (row: { userId: string }) => row.userId === leaver.userId,
        ),
      ).toMatchObject({
        level: "admin",
        areas: ["workflows"],
        suspended: true,
      });
      // Not in any team: restore is refused plainly.
      await refusedGrant(owner, body, 409, "not_in_company");
      await seedIdentity(await harness.asOwner(), {
        userId: leaver.userId,
        teamId: "roles-team-b",
        role: "viewer",
      });
      const rowsBefore = (await authorityRows()).length;
      expect((await grant(owner, body)).body).toEqual({
        data: { changed: true },
      });
      const rows = await authorityRows();
      expect(rows).toHaveLength(rowsBefore + 1);
      expect(rows.at(-1)).toMatchObject({
        metadata: {
          targetUserId: leaver.userId,
          before: { level: "admin", suspended: true },
          after: { level: "admin", suspended: false },
        },
      });
      expect(
        (await holders()).find(
          (row) => (row as { user_id: string }).user_id === leaver.userId,
        ),
      ).toMatchObject({ suspended: false });
    });

    it("answers 400 for a grant the helper would refuse, and 403 for anyone but a company owner", async () => {
      for (const body of [
        {
          userId: member.userId,
          level: "owner",
          areas: ["fields"],
          planAccess: true,
        },
        {
          userId: member.userId,
          level: "admin",
          areas: ["roles"],
          planAccess: true,
        },
        ...["ai", "plan", "home-units"].map((area) => ({
          userId: member.userId,
          level: "admin",
          areas: [area],
          planAccess: false,
        })),
        {
          userId: member.userId,
          level: "admin",
          areas: ["fields", "fields"],
          planAccess: false,
        },
        { userId: member.userId, level: "admin", areas: ["fields"] },
        { userId: member.userId, level: null, planAccess: false },
        { userId: member.userId, level: "superuser" },
        { userId: member.userId, level: null, extra: true },
      ])
        await refusedGrant(owner, body, 400, "invalid_input");
      const body = {
        userId: member.userId,
        level: "admin",
        areas: ["fields"],
        planAccess: true,
      };
      for (const p of [companyAdmin, teamOwnerB, recruiter]) {
        await refusedGrant(
          p,
          body,
          403,
          "authority_forbidden",
          "Only a company owner can manage company authority.",
        );
        const list = await call(
          authorityRoute.GET,
          p,
          "GET",
          "/api/v1/company-authority",
        );
        expect(list.status, p.userId).toBe(403);
        expect(list.body.error.code, p.userId).toBe("authority_forbidden");
      }
      await refusedGrant("bearer", body, 403, "session_required");
      const bearer = await call(
        authorityRoute.GET,
        "bearer",
        "GET",
        "/api/v1/company-authority",
      );
      expect(bearer.status).toBe(403);
      expect(bearer.body.error.code).toBe("session_required");
    });

    it("leaves authority rows out of the activity feed for a member without company authority", async () => {
      const kinds = async (p: Principal) => {
        const { status, body } = await call(
          activityRoute,
          p,
          "GET",
          "/api/v1/activity?pageSize=100",
        );
        expect(status, p.userId).toBe(200);
        return new Set(body.data.map((row: { kind: string }) => row.kind));
      };
      expect((await kinds(owner)).has("workspace-authority")).toBe(true);
      expect((await kinds(recruiter)).has("workspace-authority")).toBe(false);
    });
  });

  describe("role routes", () => {
    const recruiterBody = () =>
      structuredClone({
        ...(RECRUITER_ROLE.body as RoleBody),
        name: "Copy of Recruiter",
      });

    it("copies the Recruiter template, edits pages, an action, a field rule and the name, and publishes it into History", async () => {
      const created = await call(
        rolesRoute.POST,
        owner,
        "POST",
        "/api/v1/roles",
        {
          body: { key: "fictional-copy", body: recruiterBody() },
        },
      );
      expect(created.status).toBe(201);
      const { objectId, versionId } = created.body.data;
      expect(Object.keys(created.body.data).sort()).toEqual([
        "objectId",
        "versionId",
      ]);
      const listed = await call(rolesRoute.GET, owner, "GET", "/api/v1/roles");
      expect(listed.status).toBe(200);
      expect(listed.body.data).toEqual([
        expect.objectContaining({
          id: objectId,
          type: "role",
          key: "fictional-copy",
          current: null,
          draft: expect.objectContaining({ id: versionId, state: "draft" }),
        }),
      ]);
      const edited = recruiterBody();
      edited.name = "Fictional sourcing recruiter";
      edited.pages = edited.pages.filter((page) => page !== "analytics");
      edited.actions.candidates = ["view", "comment"];
      edited.fields = { candidate: { email: "read" } };
      const saved = await call(
        roleRoute.PUT,
        owner,
        "PUT",
        `/api/v1/roles/${versionId}`,
        { body: { body: edited }, params: { id: versionId } },
      );
      expect(saved).toEqual({ status: 200, body: { data: { versionId } } });
      const published = await call(
        publishRoute.POST,
        owner,
        "POST",
        `/api/v1/roles/${versionId}/publish`,
        { params: { id: versionId } },
      );
      expect(published).toEqual({
        status: 200,
        body: { data: { versionId, number: 1 } },
      });
      const after = await call(rolesRoute.GET, owner, "GET", "/api/v1/roles");
      expect(after.body.data[0]).toMatchObject({
        current: { id: versionId, number: 1, body: edited },
        draft: null,
      });
      const history = await call(
        configHistoryRoute,
        owner,
        "GET",
        "/api/v1/config-history",
      );
      expect(
        history.body.data
          .filter(
            (row: { objectKey: string }) => row.objectKey === "fictional-copy",
          )
          .map((row: { action: string; objectType: string }) => [
            row.action,
            row.objectType,
          ]),
      ).toEqual([
        ["config.published", "role"],
        ["config.draft_created", "role"],
      ]);
      // A new draft of the published role uses the same key.
      const next = await call(rolesRoute.POST, owner, "POST", "/api/v1/roles", {
        body: { key: "fictional-copy", body: edited },
      });
      expect(next.status).toBe(201);
      expect(next.body.data.objectId).toBe(objectId);
      const again = await call(
        rolesRoute.POST,
        owner,
        "POST",
        "/api/v1/roles",
        {
          body: { key: "fictional-copy", body: edited },
        },
      );
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("config_draft_exists");
    });

    it("refuses a body outside the membership ceiling or with membership owner, storing nothing", async () => {
      const viewer = structuredClone({
        ...(VIEWER_ROLE.body as RoleBody),
        name: "Fictional viewer",
      });
      const writing = structuredClone({
        ...viewer,
        actions: { ...viewer.actions, candidates: ["view", "edit"] },
      });
      const importing = recruiterBody();
      importing.actions.candidates = [
        ...(importing.actions.candidates ?? []),
        "import",
      ];
      const ownerBody = structuredClone(OWNER_ROLE.body);
      const before = await configRows();
      for (const body of [
        writing,
        importing,
        ownerBody,
        { ...viewer, extra: 1 },
      ]) {
        const response = await call(
          rolesRoute.POST,
          owner,
          "POST",
          "/api/v1/roles",
          { body: { key: "fictional-refused", body } },
        );
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("invalid_input");
      }
      const unknownKey = await call(
        rolesRoute.POST,
        owner,
        "POST",
        "/api/v1/roles",
        {
          body: { key: "fictional-refused", body: viewer, extra: true },
        },
      );
      expect(unknownKey.status).toBe(400);
      expect(await configRows()).toEqual(before);
      // A stored draft keeps its body when an edit is refused.
      const { body: created } = await call(
        rolesRoute.POST,
        owner,
        "POST",
        "/api/v1/roles",
        { body: { key: "fictional-viewer", body: viewer } },
      );
      const draftId = created.data.versionId;
      const stored = await configRows();
      for (const body of [writing, ownerBody]) {
        const response = await call(
          roleRoute.PUT,
          owner,
          "PUT",
          `/api/v1/roles/${draftId}`,
          { body: { body }, params: { id: draftId } },
        );
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe("invalid_input");
      }
      expect(await configRows()).toEqual(stored);
    });

    it("answers 404 for another configuration type's version, leaving it unchanged", async () => {
      await harness.dataDb();
      const workflow = await createConfigDraft(owner, {
        type: "workflow",
        key: "fictional-roles-workflow",
        body: { label: "Fictional workflow" },
      });
      const before = await configRows();
      const edit = await call(
        roleRoute.PUT,
        owner,
        "PUT",
        `/api/v1/roles/${workflow.versionId}`,
        {
          body: { body: { label: "Fictional changed" } },
          params: { id: workflow.versionId },
        },
      );
      expect(edit.status).toBe(404);
      expect(edit.body.error.code).toBe("not_found");
      const publish = await call(
        publishRoute.POST,
        owner,
        "POST",
        `/api/v1/roles/${workflow.versionId}/publish`,
        { params: { id: workflow.versionId } },
      );
      expect(publish.status).toBe(404);
      expect(publish.body.error.code).toBe("not_found");
      expect(await configRows()).toEqual(before);
    });

    it("refuses a Bearer token on every role route", async () => {
      const id = "00000000-0000-4000-a000-000000000099";
      for (const [handler, method, path, body] of [
        [rolesRoute.GET, "GET", "/api/v1/roles", undefined],
        [rolesRoute.POST, "POST", "/api/v1/roles", { key: "x", body: {} }],
        [roleRoute.PUT, "PUT", `/api/v1/roles/${id}`, { body: {} }],
        [publishRoute.POST, "POST", `/api/v1/roles/${id}/publish`, undefined],
      ] as const) {
        const response = await call(handler, "bearer", method, path, {
          body,
          params: { id },
        });
        expect(response.status, path).toBe(403);
        expect(response.body.error.code, path).toBe("session_required");
      }
    });
  });
});
