import { randomUUID } from "node:crypto";
import { APIError } from "better-auth/api";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requests pick the pool by role, as on a split-role deployment: the identity role reads the
// membership, the data role runs withTeam. Only one PGlite role is active at a time. Better Auth's
// member-role endpoint is a stub here; tests/auth-flows.test.ts drives the real one.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
const authApi = vi.hoisted(() => ({ updateMemberRole: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));
vi.mock("@/lib/auth", async (original) => ({
  ...(await original<typeof import("@/lib/auth")>()),
  getAuth: () => Promise.resolve({ api: authApi }),
}));

import type { AppDb, TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import type { RoleBody } from "@/domain/config";
import {
  HIRING_MANAGER_ROLE,
  INTERVIEWER_ROLE,
  RECRUITER_ROLE,
  VIEWER_ROLE,
  builtInRoleFor,
} from "@/domain/config-defaults";
import { accessContext } from "@/lib/authz";
import { authorize } from "@/lib/authz";
import { getVerifiedSession } from "@/lib/auth-session";
import {
  archiveConfigObject,
  createConfigDraft,
  publishConfigVersion,
} from "@/lib/config-store";
import { beginCvUpload } from "@/lib/cvs";
import { withTeam } from "@/lib/db-team";
import { createEmployee, linkEmployeeUser } from "@/lib/directory";
import { RESOURCE_CONFIG } from "@/domain/records";
import { safeCsvCell } from "@/domain/export";
import { extractionProvider } from "@/lib/ai-provider";
import {
  listActivity,
  markNotifications,
  notifications,
  overview,
  searchWorkspace,
} from "@/lib/insights";
import { callTool, TOOLS } from "@/lib/mcp/tools";
import { listStoredTools } from "@/lib/mcp/tools";
import { addGroupMember, createGroup, grantGroupRole } from "@/lib/groups";
import {
  assignMemberRole,
  listMemberRoles,
  listRoleAssignmentChanges,
} from "@/lib/member-roles";
import { requireScope, roleScopes, type Role } from "@/lib/permissions";
import { ROLE_UNAVAILABLE } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import {
  createRecord,
  updateCandidateState,
  updateRecord,
} from "@/lib/records";
import { storageConfigured, type StorageGateway } from "@/lib/storage";
import { installTenantContext } from "@/lib/tenant-context";
import { POST as memberRolesRoute } from "@/app/api/v1/teams/member-roles/route";
import { GET as memberRolesListRoute } from "@/app/api/v1/teams/member-roles/route";
import { GET as listRoute } from "@/app/api/v1/[resource]/route";
import { POST as exportRoute } from "@/app/api/v1/[resource]/export/route";
import { GET as activityRoute } from "@/app/api/v1/activity/route";
import { GET as analyticsRoute } from "@/app/api/v1/analytics/route";
import { GET as bulkCapabilitiesRoute } from "@/app/api/v1/cvs/bulk-capabilities/route";
import { GET as overviewRoute } from "@/app/api/v1/overview/route";
import { GET as searchRoute } from "@/app/api/v1/search/route";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace with two fictional teams (R2a-10, 0035).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const ORIGIN = "http://localhost:3000";
const COMPANY_KINDS = ["directory", "scope", "role-assignment"];
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type PublishedRole = { objectId: string; versionId: string; body: RoleBody };
type Audit = {
  id: string;
  team_id: string;
  actor_id: string;
  actor_type: string;
  token_id: string | null;
  record_id: string | null;
  action: string;
  kind: string;
  summary: string;
  metadata: Record<string, unknown>;
};

const signIn = (p: Principal) =>
  vi.mocked(getVerifiedSession).mockResolvedValue({
    user: { id: p.userId, twoFactorEnabled: true },
    session: { activeOrganizationId: p.teamId, createdAt: new Date() },
  } as never);
/** A principal as requirePrincipal builds it for this request: the current team role's scopes. */
const fresh = (p: Principal, role: Role = p.role): Principal => ({
  ...p,
  role,
  scopes: p.authType === "token" ? [...p.scopes] : roleScopes(role),
});
const body = (
  base: RoleBody,
  name: string,
  changes: Partial<RoleBody> = {},
): RoleBody => structuredClone({ ...base, name, ...changes });

describe("configured roles and member assignment under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, teamAdminA: Principal, recruiter: Principal;
  let companyAdmin: Principal, teamOwnerB: Principal, viewerB: Principal;
  let ownerToken: Principal, ownerOauth: Principal;
  /** Fictional viewers of team A, one per case, so no case sees another's row. */
  const viewers: Record<string, Principal> = {};
  let narrow: PublishedRole,
    lean: PublishedRole,
    noCandidates: PublishedRole,
    noRecruitment: PublishedRole;
  let noPages: PublishedRole, redacted: PublishedRole, plain: PublishedRole;
  let hiringManager: PublishedRole,
    interviewer: PublishedRole,
    unitScoped: PublishedRole;
  let later: PublishedRole,
    archived: PublishedRole,
    unpublished: { objectId: string };
  let candidate: string;

  /** Raw reads as the PGlite superuser, which bypasses RLS; only to inspect outcomes. */
  const look = async <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  const audits = () =>
    look<Audit>(
      "SELECT id, team_id, actor_id, actor_type, token_id, record_id, action, kind, summary, metadata FROM app.activity WHERE kind = 'role-assignment' ORDER BY created_at, id",
    );
  const rows = () =>
    look<{
      team_id: string;
      user_id: string;
      role_object_id: string;
      assigned_by: string | null;
    }>(
      "SELECT team_id, user_id, role_object_id, assigned_by FROM app.member_roles ORDER BY team_id, user_id",
    );
  const teamRole = async (p: Principal) =>
    (
      await look<{ role: string }>(
        "SELECT role FROM auth.member WHERE organization_id = $1 AND user_id = $2",
        [p.teamId, p.userId],
      )
    )[0]?.role as Role;
  /** One data-role transaction under the principal's verified context. */
  const asContext = <T>(
    principal: Principal,
    work: (tx: TeamTx) => Promise<T>,
  ) =>
    harness.dataDb().then((db) =>
      withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
        await installTenantContext(tx, fresh(principal), snapshot);
        return work(tx);
      }),
    );
  const sqlAs = (principal: Principal, statement: string) =>
    asContext(principal, async (tx) => {
      const { rows } = await tx.execute(sql.raw(statement));
      return rows;
    });
  /** The access state install returned and the context row it stored, for the current team role. */
  async function installed(p: Principal) {
    const principal = fresh(p, await teamRole(p));
    const { access, xid } = await harness.dataDb().then((db) =>
      withDeadlinesAndSnapshot(db, async (tx, snapshot) => ({
        access: await installTenantContext(tx, principal, snapshot),
        xid: snapshot.xid,
      })),
    );
    const [stored] = await look<{
      scopes: string[];
      role_version_id: string | null;
    }>(
      "SELECT scopes, role_version_id FROM tenant_context.contexts WHERE xid = $1::xid8",
      [xid],
    );
    return { principal, access, stored };
  }
  /** Service calls run on the data role, like a request; the headers stand in for the request's. */
  const assign = async (
    p: Principal,
    userId: string,
    roleObjectId: string | null,
  ) => {
    await harness.dataDb();
    return assignMemberRole(
      fresh(p),
      { userId, roleObjectId },
      new Headers({ cookie: "fictional-session" }),
    );
  };
  async function route(as: Principal | "bearer", input: unknown) {
    if (as !== "bearer") signIn(as);
    const response = await memberRolesRoute(
      new Request(`${ORIGIN}/api/v1/teams/member-roles`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          ...(as === "bearer"
            ? { authorization: "Bearer fictional-member-roles-token" }
            : { "x-team-id": as.teamId }),
        },
        body: JSON.stringify(input),
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: response.status, body: (await response.json()) as any };
  }
  /** One GET through a route handler as a signed-in member. */
  async function get(
    handler: (request: Request, context: never) => Promise<Response>,
    p: Principal,
    path: string,
    params: Record<string, string> = {},
  ) {
    signIn(p);
    const response = await handler(
      new Request(`${ORIGIN}${path}`, {
        headers: { origin: ORIGIN, "x-team-id": p.teamId },
      }),
      { params: Promise.resolve(params) } as never,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: response.status, body: (await response.json()) as any };
  }
  /** One export through its route as a signed-in member: the status and the CSV or error text. */
  async function exportAs(p: Principal, resource: string) {
    signIn(p);
    const response = await exportRoute(
      new Request(`${ORIGIN}/api/v1/${resource}/export`, {
        method: "POST",
        headers: { origin: ORIGIN, "x-team-id": p.teamId },
      }),
      { params: Promise.resolve({ resource }) },
    );
    return { status: response.status, text: await response.text() };
  }
  /** Drafts and publishes one company role as the company owner. */
  async function publishRole(
    key: string,
    roleBody: RoleBody,
  ): Promise<PublishedRole> {
    await harness.dataDb();
    const { objectId, versionId } = await createConfigDraft(owner, {
      type: "role",
      key,
      body: roleBody,
    });
    await harness.dataDb();
    await publishConfigVersion(owner, versionId);
    return { objectId, versionId, body: roleBody };
  }
  /** Runs the call and expects one refusal, with no member-role row, team role or audit row changed. */
  async function refused(
    call: () => Promise<unknown>,
    expected: Record<string, unknown>,
  ) {
    const before = [
      await rows(),
      await audits(),
      await look("SELECT * FROM auth.member ORDER BY id"),
    ];
    await expect(call()).rejects.toMatchObject(expected);
    expect([
      await rows(),
      await audits(),
      await look("SELECT * FROM auth.member ORDER BY id"),
    ]).toEqual(before);
  }

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    // Better Auth sets member.role as its endpoint would; a case makes it refuse once.
    authApi.updateMemberRole.mockImplementation(
      async ({ body: change }: { body: Record<string, string> }) => {
        await harness.asSuperuser();
        await harness.client.query(
          "UPDATE auth.member SET role = $1 WHERE id = $2 AND organization_id = $3",
          [change.role, change.memberId, change.organizationId],
        );
        return { member: {} };
      },
    );
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, { userId: "mr-owner", teamId: "mr-team-a" });
    teamAdminA = await seedIdentity(db, {
      userId: "mr-team-admin",
      teamId: "mr-team-a",
      role: "admin",
    });
    recruiter = await seedIdentity(db, {
      userId: "mr-recruiter",
      teamId: "mr-team-a",
      role: "recruiter",
    });
    companyAdmin = await seedIdentity(db, {
      userId: "mr-company-admin",
      teamId: "mr-team-a",
      role: "admin",
    });
    // A newly created team: its owner holds no company authority.
    teamOwnerB = await seedIdentity(db, {
      userId: "mr-owner-b",
      teamId: "mr-team-b",
    });
    viewerB = await seedIdentity(db, {
      userId: "mr-viewer-b",
      teamId: "mr-team-b",
      role: "viewer",
    });
    // The company owner is also an admin of team B, so team B can hold a row.
    await seedIdentity(db, {
      userId: "mr-owner",
      teamId: "mr-team-b",
      role: "admin",
    });
    for (const name of [
      "assigned",
      "mismatch",
      "refused",
      "record-scope",
      "later",
      "archived",
      "audit",
      "no-candidates",
      "no-cvs",
      "no-recruitment",
      "no-pages",
      "redacted",
      "plain",
    ])
      viewers[name] = await seedIdentity(db, {
        userId: `mr-viewer-${name}`,
        teamId: "mr-team-a",
        role: "viewer",
      });
    // Owner tokens holding every scope, directory ones included, which the app never issues.
    ownerToken = await seedApiToken(db, owner);
    ownerOauth = {
      ...(await seedApiToken(db, owner)),
      oauthClientId: "fictional-oauth-client",
    };
    await harness.client.exec(
      `INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${COMPANY}','mr-company-admin','admin','{fields,workflows,boards,organisation,templates}')`,
    );
    const recruiterBody = RECRUITER_ROLE.body as RoleBody;
    narrow = await publishRole(
      "fictional-narrow",
      body(recruiterBody, "Fictional narrowed recruiter", {
        scopes: roleScopes("recruiter").filter((s) => s !== "cvs:write"),
      }),
    );
    lean = await publishRole(
      "fictional-lean",
      body(recruiterBody, "Fictional lean recruiter", {
        scopes: ["candidates:read", "recruitment:read", "recruitment:write"],
      }),
    );
    noCandidates = await publishRole(
      "fictional-no-candidates",
      body(recruiterBody, "Fictional pipeline recruiter", {
        scopes: [
          "recruitment:read",
          "recruitment:write",
          "cvs:read",
          "cvs:write",
        ],
      }),
    );
    noRecruitment = await publishRole(
      "fictional-no-recruitment",
      body(VIEWER_ROLE.body as RoleBody, "Fictional candidate reader", {
        scopes: ["candidates:read", "cvs:read"],
      }),
    );
    noPages = await publishRole(
      "fictional-no-pages",
      body(recruiterBody, "Fictional pageless recruiter", {
        pages: recruiterBody.pages.filter(
          (page) =>
            !["home", "analytics", "activity", "candidates"].includes(page),
        ),
      }),
    );
    redacted = await publishRole(
      "fictional-redacted",
      body(recruiterBody, "Fictional redacted recruiter", {
        fields: {
          candidate: { email: "hidden", residenceEmirate: "hidden" },
          vacancy: { department: "hidden" },
          application: { stage: "hidden" },
          task: { title: "hidden" },
        },
      }),
    );
    plain = await publishRole(
      "fictional-plain",
      body(recruiterBody, "Fictional plain recruiter"),
    );
    hiringManager = await publishRole(
      "fictional-hiring-manager",
      structuredClone(HIRING_MANAGER_ROLE.body),
    );
    interviewer = await publishRole(
      "fictional-interviewer",
      structuredClone(INTERVIEWER_ROLE.body),
    );
    unitScoped = await publishRole(
      "fictional-unit",
      body(recruiterBody, "Fictional unit recruiter", {
        recordScope: { pipeline: "unit", candidates: "all", tasks: "all" },
      }),
    );
    later = await publishRole(
      "fictional-later",
      body(recruiterBody, "Fictional later recruiter"),
    );
    archived = await publishRole(
      "fictional-archived",
      body(recruiterBody, "Fictional archived recruiter"),
    );
    await harness.dataDb();
    unpublished = await createConfigDraft(owner, {
      type: "role",
      key: "fictional-unpublished",
      body: body(recruiterBody, "Fictional unpublished recruiter"),
    });
    await harness.dataDb();
    candidate = (
      await createRecord(owner, "candidates", {
        data: { name: "Fictional Role Candidate" },
      })
    ).id;
  });
  afterAll(async () => harness?.close());

  it("forces row-level security on app.member_roles and keeps it empty without an assignment", async () => {
    expect(
      await look(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'app.member_roles'::regclass",
      ),
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    expect(await rows()).toEqual([]);
  });

  it("keeps a member without a row on the built-in template of member.role, with the asserted scopes stored", async () => {
    for (const p of [owner, teamAdminA, recruiter, viewers.assigned]) {
      const { principal, access, stored } = await installed(p);
      const { versionId, body: template } = builtInRoleFor(p.role);
      expect(access.roleVersionId, p.userId).toBe(versionId);
      expect(access.scopes, p.userId).toEqual(principal.scopes);
      expect(stored, p.userId).toEqual({
        scopes: principal.scopes,
        role_version_id: versionId,
      });
      const ctx = accessContext(principal, access);
      expect(ctx.role, p.userId).toBe(template);
      expect(ctx.scopes, p.userId).toEqual(principal.scopes);
    }
  });

  it("assigns a narrowed recruiter role through the route: the row first, then member.role through Better Auth", async () => {
    const target = viewers.assigned;
    authApi.updateMemberRole.mockClear();
    const before = new Set((await audits()).map((row) => row.id));
    const response = await route(owner, {
      userId: target.userId,
      roleObjectId: narrow.objectId,
    });
    expect(response).toEqual({
      status: 200,
      body: {
        data: {
          userId: target.userId,
          roleObjectId: narrow.objectId,
          roleVersionId: narrow.versionId,
          membership: "recruiter",
        },
      },
    });
    expect(authApi.updateMemberRole).toHaveBeenCalledTimes(1);
    const [{ headers, body: change }] = authApi.updateMemberRole.mock
      .calls[0] as [{ headers: Headers; body: unknown }];
    expect(change).toEqual({
      organizationId: owner.teamId,
      memberId: `${target.userId}:${target.teamId}`,
      role: "recruiter",
    });
    expect(headers.get("x-team-id")).toBe(owner.teamId);
    expect(await teamRole(target)).toBe("recruiter");
    expect(
      (await rows()).filter((row) => row.user_id === target.userId),
    ).toEqual([
      {
        team_id: owner.teamId,
        user_id: target.userId,
        role_object_id: narrow.objectId,
        assigned_by: owner.userId,
      },
    ]);
    const added = (await audits()).filter((row) => !before.has(row.id));
    expect(added).toEqual([
      {
        id: expect.any(String),
        team_id: owner.teamId,
        actor_id: owner.userId,
        actor_type: "session",
        token_id: null,
        record_id: null,
        action: "role.assigned",
        kind: "role-assignment",
        summary: "Assigned a configured role to a member",
        metadata: {
          workspaceId: COMPANY,
          affectedUserId: target.userId,
          roleObjectId: narrow.objectId,
          roleVersionId: narrow.versionId,
        },
      },
    ]);
    expect(Object.keys(added[0].metadata).sort()).toEqual([
      "affectedUserId",
      "roleObjectId",
      "roleVersionId",
      "workspaceId",
    ]);
    // Install narrows to the role: recruiter scopes without cvs:write.
    const { principal, access, stored } = await installed(target);
    const scopes = roleScopes("recruiter").filter((s) => s !== "cvs:write");
    expect(principal.role).toBe("recruiter");
    expect(access).toMatchObject({ roleVersionId: narrow.versionId, scopes });
    expect(stored).toEqual({ scopes, role_version_id: narrow.versionId });
    const ctx = accessContext(principal, access);
    expect(ctx.role?.name).toBe("Fictional narrowed recruiter");
    expect(ctx.scopes).toEqual(scopes);
  });

  it("keeps the row and the narrower scopes when Better Auth refuses the team-role change", async () => {
    const target = viewers.mismatch;
    authApi.updateMemberRole.mockRejectedValueOnce(
      new APIError("FORBIDDEN", { message: "Fictional refusal" }),
    );
    await expect(
      assign(owner, target.userId, lean.objectId),
    ).rejects.toMatchObject({ status: 409, code: "team_role_unchanged" });
    expect(await teamRole(target)).toBe("viewer");
    expect(
      (await rows()).filter((row) => row.user_id === target.userId),
    ).toMatchObject([{ role_object_id: lean.objectId }]);
    // Viewer membership intersected with the role: never the role's recruitment:write.
    const { principal, access, stored } = await installed(target);
    expect(stored).toEqual({
      scopes: ["candidates:read", "recruitment:read"],
      role_version_id: lean.versionId,
    });
    const ctx = accessContext(principal, access);
    expect(ctx.scopes).toEqual(["candidates:read", "recruitment:read"]);
    expect(ctx.role?.membership).toBe("recruiter");
  });

  it("refuses team owners and admins without company authority, company admins and owner tokens, by the service and by SQL", async () => {
    // The company owner's row in each team, so updates and deletes have a target.
    await assign(owner, viewers.refused.userId, narrow.objectId);
    await assign(
      { ...owner, teamId: "mr-team-b", role: "admin" },
      viewerB.userId,
      narrow.objectId,
    );
    const cases: [Principal, Principal][] = [
      [teamOwnerB, viewerB],
      [teamAdminA, viewers.refused],
      [companyAdmin, viewers.refused],
      [ownerToken, viewers.refused],
      [ownerOauth, viewers.refused],
    ];
    for (const [caller, target] of cases) {
      const code =
        caller.authType === "token"
          ? "session_required"
          : "role_assignment_forbidden";
      for (const roleObjectId of [lean.objectId, null])
        await refused(() => assign(caller, target.userId, roleObjectId), {
          status: 403,
          code,
        });
      await refused(
        () =>
          sqlAs(
            caller,
            `INSERT INTO app.member_roles(team_id, user_id, role_object_id) VALUES ('${target.teamId}', 'mr-recruiter', '${lean.objectId}')`,
          ),
        { cause: { code: "42501" } },
      );
      for (const statement of [
        `UPDATE app.member_roles SET role_object_id = '${lean.objectId}' WHERE user_id = '${target.userId}' RETURNING user_id`,
        `DELETE FROM app.member_roles WHERE user_id = '${target.userId}' RETURNING user_id`,
      ]) {
        const before = await rows();
        expect(
          await sqlAs(caller, statement),
          `${caller.userId} ${statement}`,
        ).toEqual([]);
        expect(await rows()).toEqual(before);
      }
    }
    expect(
      (await rows()).filter((row) =>
        [viewers.refused.userId, viewerB.userId].includes(row.user_id),
      ),
    ).toMatchObject([
      { team_id: "mr-team-a", role_object_id: narrow.objectId },
      { team_id: "mr-team-b", role_object_id: narrow.objectId },
    ]);
    // The route is session only.
    expect(
      await route("bearer", {
        userId: viewers.refused.userId,
        roleObjectId: null,
      }),
    ).toMatchObject({
      status: 403,
      body: { error: { code: "session_required" } },
    });
  });

  it("lets only a company owner session publish a role version", async () => {
    await harness.dataDb();
    const { versionId } = await createConfigDraft(owner, {
      type: "role",
      key: "fictional-publish",
      body: body(RECRUITER_ROLE.body as RoleBody, "Fictional publish probe"),
    });
    for (const p of [
      teamOwnerB,
      teamAdminA,
      companyAdmin,
      ownerToken,
      ownerOauth,
    ]) {
      await harness.dataDb();
      await expect(
        publishConfigVersion(fresh(p), versionId),
        p.userId,
      ).rejects.toMatchObject({ status: 403, code: "config_forbidden" });
      await expect(
        sqlAs(
          p,
          `SELECT tenant_context.publish_config_version('${versionId}')`,
        ),
        p.userId,
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    }
    await harness.dataDb();
    expect(await publishConfigVersion(owner, versionId)).toBe(1);
  });

  // R2a-18 (job 060): record scope is enforced, so the job 052 refusal is lifted.
  it("assigns roles limited to a unit or to assigned records, by the service and by owner-session SQL", async () => {
    const target = viewers["record-scope"];
    for (const role of [interviewer, hiringManager]) {
      expect(await assign(owner, target.userId, role.objectId)).toMatchObject({
        roleObjectId: role.objectId,
        roleVersionId: role.versionId,
      });
      const { access, stored } = await installed(target);
      expect(access).toMatchObject({
        roleVersionId: role.versionId,
        recordScope: role.body.recordScope,
        homeUnits: [],
      });
      expect(stored.role_version_id).toBe(role.versionId);
    }
    expect(await teamRole(target)).toBe("recruiter");
    await sqlAs(
      owner,
      `UPDATE app.member_roles SET role_object_id = '${unitScoped.objectId}' WHERE team_id = '${owner.teamId}' AND user_id = '${target.userId}'`,
    );
    expect(
      (await rows()).filter((row) => row.user_id === target.userId),
    ).toMatchObject([{ role_object_id: unitScoped.objectId }]);
    expect((await installed(target)).access).toMatchObject({
      roleVersionId: unitScoped.versionId,
      recordScope: { pipeline: "unit", candidates: "all", tasks: "all" },
    });
    // Other refusals before any write.
    await refused(() => assign(owner, target.userId, unpublished.objectId), {
      status: 409,
      code: "role_not_published",
    });
    await refused(() => assign(owner, target.userId, randomUUID()), {
      status: 404,
      code: "not_found",
    });
    await refused(() => assign(owner, "mr-nobody", narrow.objectId), {
      status: 404,
      code: "member_not_found",
    });
    await refused(() => assign(owner, owner.userId, narrow.objectId), {
      status: 409,
      code: "team_owner_role",
    });
    await refused(
      () =>
        sqlAs(
          owner,
          `INSERT INTO app.member_roles(team_id, user_id, role_object_id) VALUES ('${owner.teamId}', '${owner.userId}', '${narrow.objectId}')`,
        ),
      { cause: { code: "42501" } },
    );
  });

  it("keeps an assigned role republished with unit scope and fails closed when it is archived", async () => {
    await assign(owner, viewers.later.userId, later.objectId);
    await assign(owner, viewers.archived.userId, archived.objectId);
    expect((await installed(viewers.later)).stored).toEqual({
      scopes: roleScopes("recruiter"),
      role_version_id: later.versionId,
    });
    await harness.dataDb();
    const { versionId } = await createConfigDraft(owner, {
      type: "role",
      key: "fictional-later",
      body: body(later.body, "Fictional later recruiter", {
        recordScope: { pipeline: "unit", candidates: "unit", tasks: "unit" },
      }),
    });
    await harness.dataDb();
    await publishConfigVersion(owner, versionId);
    await harness.dataDb();
    await archiveConfigObject(owner, archived.objectId);
    const republished = await installed(viewers.later);
    expect(republished.stored).toEqual({
      scopes: roleScopes("recruiter"),
      role_version_id: versionId,
    });
    expect(republished.access).toMatchObject({
      roleVersionId: versionId,
      recordScope: { pipeline: "unit", candidates: "unit", tasks: "unit" },
    });
    for (const p of [viewers.archived]) {
      const { principal, access, stored } = await installed(p);
      expect(stored, p.userId).toEqual({ scopes: [], role_version_id: null });
      expect(access).toMatchObject({ scopes: [], roleVersionId: null });
      expect(accessContext(principal, access)).toMatchObject({
        role: null,
        scopes: [],
      });
      await harness.dataDb();
      await expect(
        withTeam(principal, () => Promise.resolve(principal.scopes)),
      ).resolves.toEqual([]);
    }
  });

  it("audits every assign and clear once, refuses forged rows and lists them for company owners only", async () => {
    const target = viewers.audit;
    const before = new Set((await audits()).map((row) => row.id));
    await assign(owner, target.userId, narrow.objectId);
    expect(await assign(owner, target.userId, null)).toEqual({
      userId: target.userId,
      roleObjectId: null,
      roleVersionId: null,
      membership: null,
    });
    // Clearing leaves member.role as the assignment set it.
    expect(await teamRole(target)).toBe("recruiter");
    const added = (await audits()).filter((row) => !before.has(row.id));
    expect(added.map((row) => [row.action, row.metadata])).toEqual([
      [
        "role.assigned",
        {
          workspaceId: COMPANY,
          affectedUserId: target.userId,
          roleObjectId: narrow.objectId,
          roleVersionId: narrow.versionId,
        },
      ],
      [
        "role.cleared",
        {
          workspaceId: COMPANY,
          affectedUserId: target.userId,
          roleObjectId: narrow.objectId,
          roleVersionId: narrow.versionId,
        },
      ],
    ]);
    for (const action of ["role.assigned", "role.cleared", "role.forged"])
      await refused(
        () =>
          sqlAs(
            owner,
            `INSERT INTO app.activity(team_id, actor_id, actor_type, action, kind, summary, metadata) VALUES ('${owner.teamId}', '${owner.userId}', 'session', '${action}', 'role-assignment', 'Fictional forged row', '{"workspaceId":"${COMPANY}"}')`,
          ),
        { cause: { code: "42501" } },
      );
    await harness.dataDb();
    const changes = await listRoleAssignmentChanges(owner, { pageSize: 100 });
    for (const change of changes)
      expect(Object.keys(change).sort()).toEqual([
        "action",
        "actorName",
        "affectedUserId",
        "groupName",
        "occurredAt",
        "roleName",
      ]);
    const times = changes.map((change) =>
      new Date(change.occurredAt).getTime(),
    );
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(changes.slice(0, 2)).toEqual([
      expect.objectContaining({
        action: "role.cleared",
        affectedUserId: target.userId,
        roleName: "Fictional narrowed recruiter",
        actorName: "Fictional Test User",
      }),
      expect.objectContaining({
        action: "role.assigned",
        affectedUserId: target.userId,
      }),
    ]);
    // Every team of the workspace: the team B row is listed too.
    expect(changes.map((change) => change.affectedUserId)).toContain(
      viewerB.userId,
    );
    expect(changes).toHaveLength((await audits()).length);
    for (const p of [
      teamOwnerB,
      teamAdminA,
      companyAdmin,
      recruiter,
      ownerToken,
      ownerOauth,
    ]) {
      await harness.dataDb();
      await expect(
        listRoleAssignmentChanges(fresh(p)),
        p.userId,
      ).rejects.toMatchObject({
        status: 403,
        code: "role_assignment_forbidden",
      });
      await expect(
        sqlAs(
          p,
          "SELECT * FROM tenant_context.role_assignment_changes(NULL, 50)",
        ),
        p.userId,
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    }
    for (const size of [0, 101])
      await expect(
        sqlAs(
          owner,
          `SELECT * FROM tenant_context.role_assignment_changes(NULL, ${size})`,
        ),
      ).rejects.toMatchObject({ cause: { code: "22023" } });
  });

  it("leaves directory, scope and role-assignment rows out of the feed for tokens, OAuth and members without company authority", async () => {
    // Fresh directory, scope and role rows in team A, newest in the feed.
    await harness.dataDb();
    const employee = await createEmployee(owner, {
      displayName: "Fictional Role Employee",
      employeeNumber: "FICT-ROLE-1",
    });
    await harness.dataDb();
    await linkEmployeeUser(owner, employee.id, { userId: recruiter.userId });
    await assign(owner, viewers.audit.userId, narrow.objectId);
    const kinds = async (p: Principal, query: Record<string, string> = {}) => {
      await harness.dataDb();
      return new Set(
        (
          await listActivity(
            fresh(p),
            new URLSearchParams({ pageSize: "100", ...query }),
          )
        ).data.map((row) => row.kind),
      );
    };
    const recent = async (p: Principal) => {
      await harness.dataDb();
      return new Set(
        (await overview(fresh(p))).recentActivity.map((row) => row.kind),
      );
    };
    const history = TOOLS.find((tool) => tool.name === "list_activity")!;
    for (const p of [recruiter, ownerToken, ownerOauth]) {
      const listed = [
        ...(await kinds(p)),
        ...(await kinds(p, { recordId: candidate })),
        ...(await recent(p)),
      ];
      expect(listed.length, p.userId).toBeGreaterThan(0);
      for (const kind of COMPANY_KINDS)
        expect(listed, `${p.userId} ${kind}`).not.toContain(kind);
    }
    for (const p of [ownerToken, ownerOauth]) {
      await harness.dataDb();
      const result = await callTool(fresh(p), history, {
        recordId: candidate,
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const rows = (result.structuredContent as { data: { kind: string }[] })
        .data;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(COMPANY_KINDS).not.toContain(row.kind);
    }
    for (const p of [owner, companyAdmin]) {
      const listed = await kinds(p);
      for (const kind of COMPANY_KINDS)
        expect(listed.has(kind), `${p.userId} ${kind}`).toBe(true);
      expect((await recent(p)).has("role-assignment"), p.userId).toBe(true);
    }
  });

  it("narrows every surface to the scopes install stored", async () => {
    await assign(owner, viewers["no-candidates"].userId, noCandidates.objectId);
    await assign(owner, viewers["no-cvs"].userId, narrow.objectId);
    await assign(
      owner,
      viewers["no-recruitment"].userId,
      noRecruitment.objectId,
    );
    const pipeline = fresh(viewers["no-candidates"], "recruiter");
    // REST: no candidate rows.
    const list = await get(listRoute, pipeline, "/api/v1/candidates", {
      resource: "candidates",
    });
    expect(list.status).toBe(403);
    expect(list.body.data).toBeUndefined();
    // Insights: the overview needs candidates:read.
    expect(
      await get(overviewRoute, pipeline, "/api/v1/overview"),
    ).toMatchObject({
      status: 403,
      body: { error: { code: "scope_required" } },
    });
    await harness.dataDb();
    // Search leaves out the candidate group the stored scopes cannot view and returns the others.
    const vacancy = await createRecord(owner, "vacancies", {
      data: { title: "Fictional Narrowed Vacancy", status: "Open" },
    });
    await harness.dataDb();
    const found = await searchWorkspace(fresh(pipeline), "Fictional");
    expect(found.groups.map((group) => group.type)).toEqual([
      "vacancies",
      "job-roles",
      "tasks",
      "applications",
    ]);
    expect(found.groups[0].results.map((row) => row.id)).toContain(vacancy.id);
    expect(found.data.some((row) => row.kind === "candidate")).toBe(false);
    const routed = await get(
      searchRoute,
      pipeline,
      "/api/v1/search?q=Fictional",
    );
    expect(routed.status).toBe(200);
    expect(
      routed.body.groups.map((group: { type: string }) => group.type),
    ).toEqual(["vacancies", "job-roles", "tasks", "applications"]);
    // MCP: a token of the member is narrowed by install too.
    const db = await harness.asOwner();
    const token = await seedApiToken(db, pipeline, roleScopes("recruiter"));
    await harness.dataDb();
    const searched = await callTool(
      token,
      TOOLS.find((tool) => tool.name === "search_candidates")!,
      { query: "Fictional" },
    );
    expect(searched.structuredContent).toMatchObject({
      error: { code: "scope_required" },
    });
    // The audit row records the decision under the stored scopes.
    expect(
      await look(
        "SELECT action FROM app.activity WHERE kind = 'mcp-tool' AND token_id = $1",
        [token.tokenId],
      ),
    ).toEqual([{ action: "mcp.tool_denied" }]);
    // CVs: the reservation needs cvs:write, which the narrowed recruiter role lacks.
    const uploader = fresh(viewers["no-cvs"], "recruiter");
    requireScope(uploader, "cvs:write");
    const unused = new Proxy({} as StorageGateway, {
      get: () => () => {
        throw new Error("Storage must not be reached");
      },
    });
    await harness.dataDb();
    await expect(
      beginCvUpload(
        uploader,
        candidate,
        {
          originalName: "fictional.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
          clientUploadId: randomUUID(),
        },
        unused,
      ),
    ).rejects.toMatchObject({ status: 403, code: "scope_required" });
    expect(
      await look("SELECT id FROM app.uploads WHERE created_by = $1", [
        uploader.userId,
      ]),
    ).toEqual([]);
    // Activity needs recruitment:read, which the candidate reader role lacks.
    expect(
      await get(
        activityRoute,
        fresh(viewers["no-recruitment"]),
        "/api/v1/activity",
      ),
    ).toMatchObject({
      status: 403,
      body: { error: { code: "scope_required" } },
    });
  });

  // R2a-08: insights and exports decide on the engine, with pages, actions and field rules.
  it("refuses the overview, analytics, activity and a candidate export to a role without their pages", async () => {
    await assign(owner, viewers["no-pages"].userId, noPages.objectId);
    const member = fresh(viewers["no-pages"], "recruiter");
    for (const [handler, path] of [
      [overviewRoute, "/api/v1/overview"],
      [analyticsRoute, "/api/v1/analytics"],
      [activityRoute, "/api/v1/activity"],
    ] as const)
      expect(await get(handler, member, path), path).toMatchObject({
        status: 403,
        body: {
          error: {
            code: "forbidden",
            message: "You do not have permission for this action.",
          },
        },
      });
    const refusedExport = await exportAs(member, "candidates");
    expect(refusedExport.status).toBe(403);
    expect(JSON.parse(refusedExport.text)).toMatchObject({
      error: { code: "forbidden" },
    });
    expect(
      await look(
        "SELECT id FROM app.activity WHERE kind = 'export' AND actor_id = $1",
        [member.userId],
      ),
    ).toEqual([]);
    // The actions the role keeps still work: a vacancy export is allowed and audited.
    expect((await exportAs(member, "vacancies")).status).toBe(200);
    expect(
      await look(
        "SELECT action FROM app.activity WHERE kind = 'export' AND actor_id = $1",
        [member.userId],
      ),
    ).toHaveLength(1);
  });

  it("leaves hidden fields out of exports, counts, labels, search, reminders and activity", async () => {
    await assign(owner, viewers.redacted.userId, redacted.objectId);
    const member = () => fresh(viewers.redacted, "recruiter");
    const email = "fictional.redacted@example.test";
    const person = await createRecord(owner, "candidates", {
      data: {
        name: "Fictional Redacted Candidate",
        email,
        phone: "+971 50 000 0001",
        residenceEmirate: "Fictional Emirate",
      },
    });
    const job = await createRecord(owner, "vacancies", {
      data: {
        title: "Fictional Redacted Vacancy",
        status: "Open",
        department: "Fictional Department",
      },
    });
    const application = await createRecord(owner, "applications", {
      candidateId: person.id,
      vacancyId: job.id,
      data: { stage: "Sourced" },
    });
    await updateRecord(owner, "applications", application.id, {
      version: application.version,
      data: { stage: "Screening" },
    });
    const bucket = await createRecord(owner, "buckets", {
      data: { name: "Fictional redacted bucket" },
    });
    const task = await createRecord(owner, "tasks", {
      bucketId: bucket.id,
      data: { title: "Fictional redacted task", dueDate: "2020-01-01" },
    });

    // Export: no Email or Residence emirate column, the others in today's order.
    const fields = RESOURCE_CONFIG.candidates.fields;
    const header = (hidden: string[]) =>
      [
        "Record ID",
        ...fields
          .filter((field) => !hidden.includes(field.key))
          .map((field) => field.label),
        "Created at",
        "Updated at",
      ]
        .map(safeCsvCell)
        .join(",");
    const headerOf = (text: string) =>
      text.split("\r\n").find((line) => line.startsWith('"Record ID"'));
    const ownerFile = await exportAs(owner, "candidates");
    expect(ownerFile.status).toBe(200);
    expect(headerOf(ownerFile.text)).toBe(header([]));
    expect(ownerFile.text).toContain(email);
    const memberFile = await exportAs(member(), "candidates");
    expect(memberFile.status).toBe(200);
    expect(headerOf(memberFile.text)).toBe(
      header(["email", "residenceEmirate"]),
    );
    for (const label of ["Email", "Residence emirate"])
      expect(headerOf(memberFile.text)?.split(",")).not.toContain(
        safeCsvCell(label),
      );
    expect(memberFile.text).not.toContain(email);
    expect(memberFile.text).not.toContain("Fictional Emirate");
    expect(memberFile.text).toContain("Fictional Redacted Candidate");

    // Overview and analytics: outputs that read a hidden field are left out.
    const home = await get(overviewRoute, member(), "/api/v1/overview");
    expect(home.status).toBe(200);
    expect(Object.hasOwn(home.body.coverage, "email")).toBe(false);
    expect(home.body.coverage).toMatchObject({
      phone: expect.any(Number),
      total: expect.any(Number),
    });
    expect(home.body.departments).toEqual([]);
    expect(home.body.stages).toEqual([]);
    const ownerHome = await get(overviewRoute, owner, "/api/v1/overview");
    expect(ownerHome.body.departments).not.toEqual([]);
    expect(ownerHome.body.stages).not.toEqual([]);
    const charts = await get(analyticsRoute, member(), "/api/v1/analytics");
    expect(charts.status).toBe(200);
    for (const key of [
      "emirates",
      "departments",
      "stages",
      "series",
      "stageDurations",
      "conversions",
    ])
      expect(charts.body[key], key).toEqual([]);
    for (const key of ["hiresCount", "timeToHireDays", "timeToHireSample"])
      expect(Object.hasOwn(charts.body, key), key).toBe(false);
    expect(charts.body.categories).not.toEqual([]);
    const ownerCharts = await get(analyticsRoute, owner, "/api/v1/analytics");
    expect(ownerCharts.body.emirates).not.toEqual([]);
    expect(ownerCharts.body.series).not.toEqual([]);

    // Search never matches a hidden value, and titles come from visible fields only.
    const ids = (result: Awaited<ReturnType<typeof searchWorkspace>>) =>
      result.data.map((row) => row.id);
    await harness.dataDb();
    expect(ids(await searchWorkspace(fresh(owner), email))).toEqual(
      expect.arrayContaining([person.id, application.id]),
    );
    await harness.dataDb();
    const byEmail = await searchWorkspace(member(), email);
    expect(byEmail.total).toBe(0);
    expect(
      byEmail.groups.find((group) => group.type === "candidates")?.results,
    ).toEqual([]);
    await harness.dataDb();
    const byName = await searchWorkspace(
      member(),
      "Fictional Redacted Candidate",
    );
    expect(ids(byName)).toEqual(
      expect.arrayContaining([person.id, application.id]),
    );
    expect(byName.data.find((row) => row.id === application.id)?.title).toBe(
      "Application",
    );

    // Reminders: the task's title is hidden, so only its label is shown.
    await harness.dataDb();
    const reminder = (await notifications(member())).data.find((row) =>
      row.key.startsWith(`task:${task.id}:`),
    );
    expect(reminder?.title).toBe("Task due");
    await harness.dataDb();
    expect(
      (await notifications(fresh(owner))).data.find((row) =>
        row.key.startsWith(`task:${task.id}:`),
      )?.title,
    ).toBe("Task due: Fictional redacted task");

    // Activity: the stage change keeps its row without the stage values.
    const history = async (p: Principal) => {
      await harness.dataDb();
      return (
        await listActivity(
          p,
          new URLSearchParams({ recordId: application.id, pageSize: "100" }),
        )
      ).data;
    };
    const ownerRows = await history(fresh(owner));
    expect(ownerRows.some((row) => row.metadata.toStage === "Screening")).toBe(
      true,
    );
    const memberRows = await history(member());
    expect(memberRows.map((row) => row.id)).toEqual(
      ownerRows.map((row) => row.id),
    );
    for (const row of memberRows) {
      expect(Object.hasOwn(row.metadata, "fromStage")).toBe(false);
      expect(Object.hasOwn(row.metadata, "toStage")).toBe(false);
    }
  });

  it("binds bulk capabilities to the stored scopes", async () => {
    // The narrowed recruiter role of the case above lacks cvs:write.
    expect(
      await get(
        bulkCapabilitiesRoute,
        fresh(viewers["no-cvs"], "recruiter"),
        "/api/v1/cvs/bulk-capabilities",
      ),
    ).toMatchObject({
      status: 403,
      body: { error: { code: "scope_required" } },
    });
    await assign(owner, viewers.plain.userId, plain.objectId);
    const configured = storageConfigured();
    expect(
      await get(
        bulkCapabilitiesRoute,
        fresh(viewers.plain, "recruiter"),
        "/api/v1/cvs/bulk-capabilities",
      ),
    ).toEqual({
      status: 200,
      body: {
        data: {
          uploadsAvailable: configured,
          aiAvailable: extractionProvider() !== null,
          storageConfigured: configured,
        },
      },
    });
  });

  it("keeps shortlists and read markers private to each member under a configured role", async () => {
    // The member of the case above, holding an assigned configured role.
    const member = () => fresh(viewers.plain, "recruiter");
    const shortlisted = async (p: Principal) => {
      await harness.dataDb();
      return (await overview(p)).counts.shortlisted;
    };
    const ownerBefore = await shortlisted(fresh(owner));
    const memberBefore = await shortlisted(member());
    await harness.dataDb();
    await updateCandidateState(owner, candidate, {
      version: 0,
      shortlisted: true,
    });
    expect(await shortlisted(fresh(owner))).toBe(ownerBefore + 1);
    expect(await shortlisted(member())).toBe(memberBefore);

    const bucket = await createRecord(owner, "buckets", {
      data: { name: "Fictional private bucket" },
    });
    const task = await createRecord(owner, "tasks", {
      bucketId: bucket.id,
      data: { title: "Fictional private reminder", dueDate: "2020-01-02" },
    });
    const find = async (p: Principal) => {
      await harness.dataDb();
      return (await notifications(p)).data.find((row) =>
        row.key.startsWith(`task:${task.id}:`),
      );
    };
    const reminder = await find(fresh(owner));
    expect(reminder?.read).toBe(false);
    await harness.dataDb();
    expect(await markNotifications(fresh(owner), [reminder!.key])).toEqual({
      updated: 1,
    });
    expect((await find(fresh(owner)))?.read).toBe(true);
    expect((await find(member()))?.read).toBe(false);
    expect(
      await look("SELECT user_id FROM app.notification_reads WHERE key = $1", [
        reminder!.key,
      ]),
    ).toEqual([{ user_id: owner.userId }]);
  });

  // R2a-09: the MCP tool list and every call follow the stored scopes and the assigned role.
  /** A fictional member of team A assigned the role, with an API token asserting recruiter scopes. */
  async function mcpMember(name: string, role: PublishedRole) {
    const member = await seedIdentity(await harness.asOwner(), {
      userId: `mr-mcp-${name}`,
      teamId: "mr-team-a",
      role: "viewer",
    });
    await assign(owner, member.userId, role.objectId);
    return seedApiToken(
      await harness.asOwner(),
      fresh(member, "recruiter"),
      roleScopes("recruiter"),
    );
  }
  /** tools/list as the endpoint answers it, for a fresh request of the token. */
  const toolNames = async (p: Principal) => {
    await harness.dataDb();
    return (await listStoredTools(fresh(p))).map((item) => item.name);
  };
  const mcpCall = async (p: Principal, name: string, args: unknown) => {
    await harness.dataDb();
    return callTool(
      fresh(p),
      TOOLS.find((item) => item.name === name)!,
      args,
    );
  };
  const mcpAudits = (p: Principal) =>
    look(
      "SELECT action FROM app.activity WHERE kind = 'mcp-tool' AND token_id = $1 ORDER BY created_at, id",
      [p.tokenId],
    );
  /** The items of a list tool's result, or the record of a get tool's. */
  const mcpData = <T>(result: Awaited<ReturnType<typeof callTool>>) => {
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return (result.structuredContent as { data: T }).data;
  };
  const CV_UPLOAD_TOOLS = [
    "upload_cv",
    "create_cv_upload_link",
    "complete_cv_upload",
    "start_bulk_import",
    "add_bulk_import_item",
    "list_bulk_import_items",
    "open_bulk_import_page",
  ];

  it("leaves the CV upload tools out of a narrowed member's tool list and refuses upload_cv", async () => {
    const token = await mcpMember("narrow", narrow);
    // The token asserts cvs:write; the role install stored lacks it.
    expect(token.scopes).toContain("cvs:write");
    const names = await toolNames(token);
    expect(names).toEqual(
      expect.arrayContaining(["search_candidates", "create_candidate"]),
    );
    for (const name of CV_UPLOAD_TOOLS) expect(names).not.toContain(name);
    const result = await mcpCall(token, "upload_cv", {
      idempotencyKey: `fictional-${randomUUID()}`,
      candidateId: candidate,
      originalName: "fictional.pdf",
      mimeType: "application/pdf",
      contentBase64: Buffer.from("%PDF-1.4 fictional").toString("base64"),
    });
    expect(result.structuredContent).toEqual({
      error: {
        code: "scope_required",
        message: "This tool requires cvs:write.",
      },
    });
    expect(await mcpAudits(token)).toEqual([{ action: "mcp.tool_denied" }]);
    expect(
      await look("SELECT id FROM app.uploads WHERE created_by = $1", [
        token.userId,
      ]),
    ).toEqual([]);
  });

  it("lists and runs only the vacancy tools a view-only vacancy role allows", async () => {
    const recruiterBody = RECRUITER_ROLE.body as RoleBody;
    const vacancyViewer = await publishRole(
      "fictional-vacancy-viewer",
      body(recruiterBody, "Fictional vacancy viewer", {
        actions: { ...recruiterBody.actions, vacancies: ["view", "export"] },
      }),
    );
    const token = await mcpMember("vacancy-viewer", vacancyViewer);
    const names = await toolNames(token);
    expect(names).toContain("list_vacancies");
    expect(names).toContain("get_vacancy");
    expect(names).not.toContain("create_vacancy");
    expect(names).not.toContain("update_vacancy");
    mcpData<unknown[]>(await mcpCall(token, "list_vacancies", {}));
    const title = "Fictional refused MCP vacancy";
    const refusedCall = await mcpCall(token, "create_vacancy", {
      idempotencyKey: `fictional-${randomUUID()}`,
      title,
    });
    expect(refusedCall.structuredContent).toEqual({
      error: {
        code: "scope_required",
        message: "This tool requires recruitment:write.",
      },
    });
    expect(await mcpAudits(token)).toEqual([
      { action: "mcp.tool_called" },
      { action: "mcp.tool_denied" },
    ]);
    expect(
      await look(
        "SELECT id FROM app.records WHERE kind = 'vacancy' AND data->>'title' = $1",
        [title],
      ),
    ).toEqual([]);
  });

  it("leaves the overview, analytics and activity tools out for a role without their pages", async () => {
    const token = await mcpMember("no-pages", noPages);
    const names = await toolNames(token);
    for (const name of ["get_overview", "get_analytics", "list_activity"])
      expect(names).not.toContain(name);
    expect(names).toContain("list_notifications");
    expect(
      (await mcpCall(token, "get_overview", {})).structuredContent,
    ).toMatchObject({ error: { code: "scope_required" } });
  });

  it("leaves hidden fields out of MCP results instead of returning them as null", async () => {
    const token = await mcpMember("redacted", redacted);
    await harness.dataDb();
    const person = await createRecord(owner, "candidates", {
      data: {
        name: "Fictional MCP Redacted Candidate",
        email: "fictional.mcp.redacted@example.test",
        residenceEmirate: "Fictional MCP Emirate",
      },
    });
    const job = await createRecord(owner, "vacancies", {
      data: {
        title: "Fictional MCP Redacted Vacancy",
        status: "Open",
        department: "Fictional MCP Department",
      },
    });
    await createRecord(owner, "applications", {
      candidateId: person.id,
      vacancyId: job.id,
      data: { stage: "Screening" },
    });
    const bucket = await createRecord(owner, "buckets", {
      data: { name: "Fictional MCP redacted bucket" },
    });
    await createRecord(owner, "tasks", {
      bucketId: bucket.id,
      data: { title: "Fictional MCP redacted task" },
    });
    const absent = (row: Record<string, unknown>, key: string) =>
      expect(Object.hasOwn(row, key), `${key} in ${JSON.stringify(row)}`).toBe(
        false,
      );

    const found = mcpData<Record<string, unknown>[]>(
      await mcpCall(token, "search_candidates", {
        query: "Fictional MCP Redacted Candidate",
      }),
    );
    expect(found.map((row) => row.id)).toContain(person.id);
    for (const row of found) {
      absent(row, "residenceEmirate");
      expect(row).toHaveProperty("name");
    }
    const facts = mcpData<{ facts: Record<string, unknown> }>(
      await mcpCall(token, "get_candidate", { id: person.id }),
    ).facts;
    absent(facts, "email");
    absent(facts, "residenceEmirate");
    expect(facts.name).toBe("Fictional MCP Redacted Candidate");
    const vacancies = mcpData<Record<string, unknown>[]>(
      await mcpCall(token, "list_vacancies", {
        query: "Fictional MCP Redacted Vacancy",
      }),
    );
    expect(vacancies.map((row) => row.id)).toEqual([job.id]);
    for (const row of vacancies) absent(row, "department");
    const applications = mcpData<Record<string, unknown>[]>(
      await mcpCall(token, "list_applications", { vacancyId: job.id }),
    );
    expect(applications).toHaveLength(1);
    for (const row of applications) absent(row, "stage");
    const tasks = mcpData<Record<string, unknown>[]>(
      await mcpCall(token, "list_tasks", { bucketId: bucket.id }),
    );
    expect(tasks).toHaveLength(1);
    for (const row of tasks) absent(row, "title");

    // The owner's token still gets every one of them.
    const ownerFacts = mcpData<{ facts: Record<string, unknown> }>(
      await mcpCall(ownerToken, "get_candidate", { id: person.id }),
    ).facts;
    expect(ownerFacts.email).toBe("fictional.mcp.redacted@example.test");
    const ownerTasks = mcpData<Record<string, unknown>[]>(
      await mcpCall(ownerToken, "list_tasks", { bucketId: bucket.id }),
    );
    expect(ownerTasks[0].title).toBe("Fictional MCP redacted task");
  });

  it("derives no interview time or meeting-link flag from hidden fields", async () => {
    const hiddenTimes = await publishRole(
      "fictional-hidden-times",
      body(RECRUITER_ROLE.body as RoleBody, "Fictional hidden times", {
        fields: { interview: { startAt: "hidden", meetingUrl: "hidden" } },
      }),
    );
    const token = await mcpMember("hidden-times", hiddenTimes);
    await harness.dataDb();
    const job = await createRecord(owner, "vacancies", {
      data: { title: "Fictional MCP interview vacancy" },
    });
    const application = await createRecord(owner, "applications", {
      candidateId: candidate,
      vacancyId: job.id,
      data: { stage: "Interview" },
    });
    await createRecord(owner, "interviews", {
      applicationId: application.id,
      data: {
        title: "Fictional MCP interview",
        startAt: new Date(Date.now() + 86_400_000).toISOString(),
        meetingUrl: "https://meet.example.test/fictional",
      },
    });
    const [item] = mcpData<Record<string, unknown>[]>(
      await mcpCall(token, "list_interviews", {
        applicationId: application.id,
      }),
    );
    expect(item.title).toBe("Fictional MCP interview");
    for (const key of ["startAt", "startAtDubai", "timezone", "hasMeetingUrl"])
      expect(Object.hasOwn(item, key), key).toBe(false);
    const [ownerItem] = mcpData<Record<string, unknown>[]>(
      await mcpCall(ownerToken, "list_interviews", {
        applicationId: application.id,
      }),
    );
    expect(ownerItem).toMatchObject({
      startAt: expect.any(String),
      startAtDubai: expect.any(String),
      timezone: "Asia/Dubai",
      hasMeetingUrl: true,
    });
  });

  // R2a-12 (job 056): the picker, failed-closed roles and an unconfirmed team role.
  it("lists member roles for a company owner, roles limited to a unit or to assigned records included", async () => {
    const { status, body: listed } = await get(
      memberRolesListRoute,
      owner,
      "/api/v1/teams/member-roles",
    );
    expect(status).toBe(200);
    expect(Object.keys(listed.data).sort()).toEqual([
      "assignments",
      "groupRoles",
      "roles",
    ]);
    const { assignments, roles } = listed.data as {
      assignments: {
        userId: string;
        roleObjectId: string;
        roleName: string | null;
        available: boolean;
      }[];
      roles: { roleObjectId: string; name: string; membership: string }[];
    };
    const offered = roles.map((role) => role.roleObjectId);
    for (const role of [hiringManager, interviewer, unitScoped, later])
      expect(offered).toContain(role.objectId);
    expect(offered).not.toContain(archived.objectId);
    expect(offered).not.toContain(unpublished.objectId);
    expect(roles).toContainEqual({
      roleObjectId: narrow.objectId,
      name: "Fictional narrowed recruiter",
      membership: "recruiter",
    });
    const names = roles.map((role) => role.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    // Only team A's rows, each with its role's name.
    const rowsA = (await rows()).filter((row) => row.team_id === owner.teamId);
    expect(assignments.map((row) => row.userId).sort()).toEqual(
      rowsA.map((row) => row.user_id).sort(),
    );
    expect(assignments).toContainEqual({
      userId: viewers.assigned.userId,
      roleObjectId: narrow.objectId,
      roleName: "Fictional narrowed recruiter",
      available: true,
    });
    expect(
      assignments.find((row) => row.userId === viewerB.userId),
    ).toBeUndefined();
  });

  it("reports archived roles as no longer available, unit-republished ones as available, and reassigns and clears them", async () => {
    const assignmentOf = async (userId: string) =>
      (
        await get(memberRolesListRoute, owner, "/api/v1/teams/member-roles")
      ).body.data.assignments.find(
        (row: { userId: string }) => row.userId === userId,
      );
    expect(await assignmentOf(viewers.later.userId)).toEqual({
      userId: viewers.later.userId,
      roleObjectId: later.objectId,
      roleName: "Fictional later recruiter",
      available: true,
    });
    expect(await assignmentOf(viewers.archived.userId)).toEqual({
      userId: viewers.archived.userId,
      roleObjectId: archived.objectId,
      roleName: "Fictional archived recruiter",
      available: false,
    });
    expect(
      await route(owner, {
        userId: viewers.later.userId,
        roleObjectId: plain.objectId,
      }),
    ).toMatchObject({
      status: 200,
      body: { data: { membership: "recruiter" } },
    });
    expect(await assignmentOf(viewers.later.userId)).toMatchObject({
      roleObjectId: plain.objectId,
      available: true,
    });
    expect((await installed(viewers.later)).stored).toEqual({
      scopes: roleScopes("recruiter"),
      role_version_id: plain.versionId,
    });
    expect(
      await route(owner, {
        userId: viewers.archived.userId,
        roleObjectId: null,
      }),
    ).toMatchObject({ status: 200, body: { data: { roleObjectId: null } } });
    expect(await assignmentOf(viewers.archived.userId)).toBeUndefined();
  });

  it("refuses a failed-closed member in plain words, with the same statuses and codes", async () => {
    const member = await seedIdentity(await harness.asOwner(), {
      userId: "mr-viewer-failed",
      teamId: "mr-team-a",
      role: "viewer",
    });
    const gone = await publishRole(
      "fictional-gone",
      body(RECRUITER_ROLE.body as RoleBody, "Fictional gone recruiter"),
    );
    await assign(owner, member.userId, gone.objectId);
    await harness.dataDb();
    await archiveConfigObject(owner, gone.objectId);
    const failed = fresh(member, "recruiter");
    for (const [handler, path, params, code] of [
      // The overview checks its scope first; the list decides on the engine.
      [overviewRoute, "/api/v1/overview", {}, "scope_required"],
      [
        listRoute,
        "/api/v1/candidates",
        { resource: "candidates" },
        "forbidden",
      ],
    ] as const)
      expect(await get(handler, failed, path, params), path).toEqual({
        status: 403,
        body: {
          error: {
            code,
            message: ROLE_UNAVAILABLE,
            correlationId: expect.any(String),
          },
        },
      });
    expect(ROLE_UNAVAILABLE).toBe(
      "Your role is no longer available. Ask a company owner to choose a role for you.",
    );
    // A check after the context, and the engine's refusals, say the same.
    const principal = fresh(member, "recruiter");
    await harness.dataDb();
    const ctx = await withTeam(principal, async (_tx, access) =>
      accessContext(principal, access),
    );
    expect(() => requireScope(principal, "candidates:read")).toThrow(
      expect.objectContaining({
        status: 403,
        code: "scope_required",
        message: ROLE_UNAVAILABLE,
      }),
    );
    for (const [action, code] of [
      ["view", "forbidden"],
      ["import", "import_forbidden"],
    ] as const)
      expect(() => authorize(ctx, { resource: "candidates", action })).toThrow(
        expect.objectContaining({
          status: 403,
          code,
          message: ROLE_UNAVAILABLE,
        }),
      );
    // Any other member keeps today's words.
    const viewer = await seedIdentity(await harness.asOwner(), {
      userId: "mr-viewer-unchanged",
      teamId: "mr-team-a",
      role: "viewer",
    });
    await harness.dataDb();
    const plainCtx = await withTeam(fresh(viewer), async (_tx, access) =>
      accessContext(fresh(viewer), access),
    );
    expect(() =>
      authorize(plainCtx, { resource: "candidates", action: "edit" }),
    ).toThrow(
      expect.objectContaining({
        code: "forbidden",
        message: "You do not have permission for this action.",
      }),
    );
  });

  it("answers 503 team_role_unconfirmed, keeping the row, when Better Auth fails with something other than an APIError", async () => {
    const member = await seedIdentity(await harness.asOwner(), {
      userId: "mr-viewer-unconfirmed",
      teamId: "mr-team-a",
      role: "viewer",
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    authApi.updateMemberRole.mockRejectedValueOnce(
      new TypeError("Fictional network failure"),
    );
    try {
      expect(
        await route(owner, {
          userId: member.userId,
          roleObjectId: plain.objectId,
        }),
      ).toEqual({
        status: 503,
        body: {
          error: {
            code: "team_role_unconfirmed",
            message:
              "The role was saved, but the team role could not be checked or changed, so the narrower of the two applies. Try again, or ask a team owner or admin to check the team role in Team settings.",
            correlationId: expect.any(String),
          },
        },
      });
      expect(logged.mock.calls.map((call) => call.join(" "))).toEqual([
        "team_role_unconfirmed category=TypeError",
      ]);
    } finally {
      logged.mockRestore();
    }
    expect(
      (await rows()).filter((row) => row.user_id === member.userId),
    ).toMatchObject([{ role_object_id: plain.objectId }]);
    expect(await teamRole(member)).toBe("viewer");
  });

  it("refuses the member-roles list to anyone but a company owner session", async () => {
    for (const p of [companyAdmin, teamOwnerB, teamAdminA, recruiter]) {
      const { status, body: refusal } = await get(
        memberRolesListRoute,
        fresh(p),
        "/api/v1/teams/member-roles",
      );
      expect(status, p.userId).toBe(403);
      expect(refusal.error.code, p.userId).toBe("role_assignment_forbidden");
    }
    for (const p of [ownerToken, ownerOauth]) {
      await harness.dataDb();
      await expect(listMemberRoles(fresh(p))).rejects.toMatchObject({
        status: 403,
        code: "role_assignment_forbidden",
      });
    }
    const bearer = await memberRolesListRoute(
      new Request(`${ORIGIN}/api/v1/teams/member-roles`, {
        headers: {
          origin: ORIGIN,
          authorization: "Bearer fictional-member-roles-token",
        },
      }),
    );
    expect(bearer.status).toBe(403);
    expect((await bearer.json()).error.code).toBe("session_required");
  });

  // ADM-14 (job 103): a role a company group gives in the team, under a role chosen here.
  it("gives a group's members the group's role, lets a role chosen here win, skips team owners and refuses two roles naming the people", async () => {
    const db = await harness.asOwner();
    const seed = (userId: string) =>
      seedIdentity(db, { userId, teamId: "mr-team-a", role: "recruiter" });
    const grouped = await seed("mr-group-member");
    const chosen = await seed("mr-group-chosen");
    await harness.asSuperuser();
    await harness.client.exec(
      `UPDATE auth."user" SET name = 'Fictional Grouped Member' WHERE id = 'mr-group-member'`,
    );
    const groupRole = await publishRole(
      "mr-group-role",
      body(RECRUITER_ROLE.body, "Fictional group recruiter"),
    );
    const otherRole = await publishRole(
      "mr-group-other-role",
      body(RECRUITER_ROLE.body, "Fictional other group recruiter"),
    );
    const signedIn = { ...fresh(owner), sessionCreatedAt: new Date() };
    await harness.dataDb();
    const group = await createGroup(owner, { name: "Fictional Role Group" });
    for (const p of [grouped, chosen, owner])
      await addGroupMember(owner, group.id, { userId: p.userId });
    await grantGroupRole(signedIn, group.id, {
      teamId: "mr-team-a",
      roleObjectId: groupRole.objectId,
    });
    await assign(owner, chosen.userId, otherRole.objectId);
    // The member holds the group's role; the role chosen here wins; the team owner keeps Owner.
    expect((await installed(grouped)).stored).toEqual({
      scopes: roleScopes("recruiter"),
      role_version_id: groupRole.versionId,
    });
    expect((await installed(chosen)).stored.role_version_id).toBe(
      otherRole.versionId,
    );
    expect((await installed(owner)).access.roleVersionId).toBe(
      builtInRoleFor("owner").versionId,
    );
    await harness.dataDb();
    const listed = await listMemberRoles(fresh(owner));
    expect(listed.groupRoles).toEqual([
      {
        userId: chosen.userId,
        roleObjectId: groupRole.objectId,
        roleName: "Fictional group recruiter",
        groupId: group.id,
        groupName: "Fictional Role Group",
      },
      {
        userId: grouped.userId,
        roleObjectId: groupRole.objectId,
        roleName: "Fictional group recruiter",
        groupId: group.id,
        groupName: "Fictional Role Group",
      },
    ]);
    // A second group with another role: adding the member is refused, naming them and the team.
    await harness.dataDb();
    const second = await createGroup(owner, {
      name: "Fictional Second Role Group",
    });
    await grantGroupRole(signedIn, second.id, {
      teamId: "mr-team-a",
      roleObjectId: otherRole.objectId,
    });
    const before = [
      await rows(),
      await look("SELECT * FROM app.group_members ORDER BY group_id, user_id"),
    ];
    await harness.dataDb();
    await expect(
      addGroupMember(signedIn, second.id, { userId: grouped.userId }),
    ).rejects.toMatchObject({
      status: 409,
      code: "group_role_conflict",
      message:
        "This would give Fictional Grouped Member two roles in Fictional Test Team. A person holds one configured role per team: remove them from one of the groups, or choose their role in the team's Members tab.",
    });
    expect([
      await rows(),
      await look("SELECT * FROM app.group_members ORDER BY group_id, user_id"),
    ]).toEqual(before);
    // The member whose role is chosen here may join: that role wins.
    await harness.dataDb();
    await addGroupMember(signedIn, second.id, { userId: chosen.userId });
    expect((await installed(chosen)).stored.role_version_id).toBe(
      otherRole.versionId,
    );
  });
});
