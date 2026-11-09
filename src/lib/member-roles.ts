import { isAPIError } from "@better-auth/core/utils/is-api-error";
import { DrizzleQueryError, and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getIdentityDb, type TeamTx } from "@/db";
import { member } from "@/db/auth-schema";
import { roleBodySchema, type RoleBody } from "@/domain/config";
import { getAuth, type AppAuth } from "./auth";
import { withTeam } from "./db-team";
import { ApiError } from "./errors";
import type { Principal } from "./principal";
import type { TenantAccess } from "./tenant-context";

export type RoleAssignment = {
  userId: string;
  roleObjectId: string | null;
  roleVersionId: string | null;
  membership: Exclude<RoleBody["membership"], "owner"> | null;
};
export type MemberRoles = {
  assignments: {
    userId: string;
    roleObjectId: string;
    roleName: string | null;
    available: boolean;
  }[];
  roles: {
    roleObjectId: string;
    name: string;
    membership: Exclude<RoleBody["membership"], "owner">;
  }[];
  scopedRolesHidden: boolean;
};
export type RoleAssignmentChange = {
  occurredAt: string;
  action: string;
  affectedUserId: string;
  roleName: string | null;
  actorName: string | null;
};

const assignmentForbidden = () =>
  new ApiError(
    403,
    "role_assignment_forbidden",
    "Only a company owner can assign roles.",
  );
const recordScopeUnsupported = () =>
  new ApiError(
    409,
    "role_record_scope_unsupported",
    "Roles limited to a unit or to assigned records cannot be assigned yet. Choose a role that sees all records.",
  );
const assignmentInput = z
  .object({
    userId: z.string().min(1).max(128),
    roleObjectId: z.uuid().nullable(),
  })
  .strict();
const changesInput = z
  .object({
    before: z.date().optional(),
    pageSize: z.number().int().min(1).max(100).default(50),
  })
  .strict();

/** One withTeam transaction; the database stays authoritative and its refusals map to API errors. */
async function inRoles<T>(
  p: Principal,
  work: (tx: TeamTx, access: TenantAccess) => Promise<T>,
): Promise<T> {
  try {
    return await withTeam(p, work);
  } catch (error) {
    const code = (
      (error instanceof DrizzleQueryError ? error.cause : error) as
        { code?: unknown } | undefined
    )?.code;
    if (code === "42501") throw assignmentForbidden();
    if (code === "RQ011") throw recordScopeUnsupported();
    throw error;
  }
}

/**
 * Sets member.role through Better Auth's own endpoint with the caller's request headers, so every
 * existing organization rule and hook applies. False when Better Auth refuses.
 */
export async function changeTeamRole(
  auth: Pick<AppAuth, "api">,
  headers: Headers,
  body: { organizationId: string; memberId: string; role: string },
): Promise<boolean> {
  try {
    await auth.api.updateMemberRole({ headers, body });
    return true;
  } catch (error) {
    if (isAPIError(error)) return false;
    throw error;
  }
}

/**
 * A company owner, in a session, assigns a member of the active team a published configured role,
 * or clears it with a null roleObjectId. The row is written first; only then, when member.role
 * differs from the role's membership, is the team role changed through Better Auth. If that is
 * refused, or fails in any other way (503 team_role_unconfirmed), the row stays, so the narrower of
 * the two applies. Clearing leaves member.role unchanged.
 */
export async function assignMemberRole(
  p: Principal,
  input: { userId: string; roleObjectId: string | null },
  headers: Headers,
): Promise<RoleAssignment> {
  if (p.authType !== "session")
    throw new ApiError(
      403,
      "session_required",
      "Sign in to manage accounts, teams and API tokens.",
    );
  const { userId, roleObjectId } = assignmentInput.parse(input);
  const db = await getIdentityDb();
  const [target] = await db
    .select({ id: member.id, role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, p.teamId), eq(member.userId, userId)))
    .limit(1);
  const assigned = await inRoles(p, async (tx, access) => {
    if (access.companyLevel !== "owner") throw assignmentForbidden();
    if (!target)
      throw new ApiError(
        404,
        "member_not_found",
        "That person is not a member of this team.",
      );
    if (target.role === "owner")
      throw new ApiError(
        409,
        "team_owner_role",
        "Team owners keep the Owner role, so they cannot be given a configured role.",
      );
    if (roleObjectId === null) {
      await tx.execute(
        sql`delete from app.member_roles where team_id = ${p.teamId} and user_id = ${userId}`,
      );
      return null;
    }
    const versionId = Object.hasOwn(access.versions, roleObjectId)
      ? access.versions[roleObjectId]
      : undefined;
    const document = versionId ? access.documents[versionId] : undefined;
    if (document?.type !== "role") {
      // Only to tell a role without a published version from no role at all.
      const { rows } = await tx.execute<{ id: string }>(
        sql`select id from app.config_objects where id = ${roleObjectId}::uuid and workspace_id = ${access.workspaceId}::uuid and type = 'role' and archived_at is null`,
      );
      if (rows[0] && !versionId)
        throw new ApiError(
          409,
          "role_not_published",
          "Publish this role before assigning it.",
        );
      throw new ApiError(404, "not_found", "Role not found.");
    }
    const parsed = roleBodySchema.safeParse(document.body);
    if (!parsed.success)
      throw new ApiError(
        409,
        "role_invalid",
        "This role's published version is not a valid role. Publish a corrected version before assigning it.",
      );
    if (Object.values(parsed.data.recordScope).some((scope) => scope !== "all"))
      throw recordScopeUnsupported();
    await tx.execute(
      sql`insert into app.member_roles(team_id, user_id, role_object_id) values (${p.teamId}, ${userId}, ${roleObjectId}::uuid) on conflict (team_id, user_id) do update set role_object_id = excluded.role_object_id`,
    );
    return { roleVersionId: document.versionId, body: parsed.data };
  });
  if (!assigned)
    return {
      userId,
      roleObjectId: null,
      roleVersionId: null,
      membership: null,
    };
  const { membership } = assigned.body;
  let changed = true;
  if (target.role !== membership)
    try {
      changed = await changeTeamRole(await getAuth(), headers, {
        organizationId: p.teamId,
        memberId: target.id,
        role: membership,
      });
    } catch (error) {
      // The row is saved; log only a safe category, as errorResponse does.
      const category =
        (error as { constructor?: { name?: string } } | null)?.constructor
          ?.name || typeof error;
      console.error(`team_role_unconfirmed category=${category}`);
      throw new ApiError(
        503,
        "team_role_unconfirmed",
        "The role was saved, but the team role could not be checked or changed, so the narrower of the two applies. Try again, or ask a team owner or admin to check the team role in Team settings.",
      );
    }
  if (!changed)
    throw new ApiError(
      409,
      "team_role_unchanged",
      "The role was saved, but the team role was not changed, so the narrower of the two applies. A team owner or admin can change the team role in Team settings.",
    );
  return {
    userId,
    roleObjectId,
    roleVersionId: assigned.roleVersionId,
    membership,
  };
}

/**
 * Company owners, signed in: the configured role of each member of the active team, and the roles
 * that can be assigned. A role can be assigned, and an assignment is available, only when its
 * current published version is in force for this context, is a valid role and sees all records,
 * the rule tenant_context.install applies; roleName is the last published name, else the draft's.
 */
export async function listMemberRoles(p: Principal): Promise<MemberRoles> {
  return inRoles(p, async (tx, access) => {
    if (p.authType !== "session" || access.companyLevel !== "owner")
      throw assignmentForbidden();
    let scopedRolesHidden = false;
    const assignable = new Map<string, MemberRoles["roles"][number]>();
    for (const [objectId, versionId] of Object.entries(access.versions)) {
      const document = access.documents[versionId];
      if (document?.type !== "role") continue;
      const parsed = roleBodySchema.safeParse(document.body);
      if (!parsed.success) continue;
      const { name, membership, recordScope } = parsed.data;
      if (Object.values(recordScope).some((scope) => scope !== "all"))
        scopedRolesHidden = true;
      else
        assignable.set(objectId, { roleObjectId: objectId, name, membership });
    }
    const { rows } = await tx.execute<{
      userId: string;
      roleObjectId: string;
      roleName: string | null;
    }>(
      sql`select r.user_id as "userId", r.role_object_id as "roleObjectId", coalesce(c.body->>'name', d.body->>'name') as "roleName" from app.member_roles r left join app.config_objects o on o.id = r.role_object_id left join app.config_versions c on c.id = o.current_version_id left join app.config_versions d on d.id = o.draft_version_id where r.team_id = ${p.teamId} order by r.user_id`,
    );
    return {
      assignments: rows.map((row) => ({
        ...row,
        available: assignable.has(row.roleObjectId),
      })),
      roles: [...assignable.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      scopedRolesHidden,
    };
  });
}

/**
 * Company owners only: role assignments and clears of every team in the workspace, newest first,
 * for the owners' home screen (R2a-11). Action, time, member, role name and actor name only.
 */
export async function listRoleAssignmentChanges(
  p: Principal,
  options: z.input<typeof changesInput> = {},
): Promise<RoleAssignmentChange[]> {
  const { before, pageSize } = changesInput.parse(options);
  return inRoles(p, async (tx, access) => {
    if (p.authType !== "session" || access.companyLevel !== "owner")
      throw assignmentForbidden();
    const { rows } = await tx.execute<RoleAssignmentChange>(
      sql`select occurred_at as "occurredAt", action, affected_user_id as "affectedUserId", role_name as "roleName", actor_name as "actorName" from tenant_context.role_assignment_changes(${before?.toISOString() ?? null}::timestamptz, ${pageSize}::integer)`,
    );
    return rows;
  });
}
