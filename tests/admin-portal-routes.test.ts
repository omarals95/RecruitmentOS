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
    session: { activeOrganizationId: p.teamId },
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
            "role",
            "scopes",
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
        role: { name: "Fictional narrowed recruiter", membership: "recruiter" },
        scopes: ctx.scopes,
        adminAreas: [],
        ...expectedAnswers(ctx),
      });
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
});
