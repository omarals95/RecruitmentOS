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
import {
  assignMemberRole,
  listRoleAssignmentChanges,
} from "@/lib/member-roles";
import { requireScope, roleScopes, type Role } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import {
  createRecord,
  updateCandidateState,
  updateRecord,
} from "@/lib/records";
import { storageConfigured, type StorageGateway } from "@/lib/storage";
import { installTenantContext } from "@/lib/tenant-context";
import { POST as memberRolesRoute } from "@/app/api/v1/teams/member-roles/route";
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
    session: { activeOrganizationId: p.teamId },
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

  it("refuses roles limited to a unit or to assigned records, by the service and by owner-session SQL", async () => {
    const target = viewers["record-scope"];
    authApi.updateMemberRole.mockClear();
    for (const role of [hiringManager, interviewer, unitScoped]) {
      await refused(() => assign(owner, target.userId, role.objectId), {
        status: 409,
        code: "role_record_scope_unsupported",
        message:
          "Roles limited to a unit or to assigned records cannot be assigned yet. Choose a role that sees all records.",
      });
      await refused(
        () =>
          sqlAs(
            owner,
            `INSERT INTO app.member_roles(team_id, user_id, role_object_id) VALUES ('${owner.teamId}', '${target.userId}', '${role.objectId}')`,
          ),
        { cause: { code: "RQ011" } },
      );
    }
    expect(authApi.updateMemberRole).not.toHaveBeenCalled();
    expect(await teamRole(target)).toBe("viewer");
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

  it("fails closed when an assigned role is republished with unit scope or archived", async () => {
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
    for (const p of [viewers.later, viewers.archived]) {
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
});
