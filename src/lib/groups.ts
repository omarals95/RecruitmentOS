import { DrizzleQueryError, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { TeamTx } from "@/db";
import {
  computedGroupKey,
  groupApproval,
  groupInput,
  groupMember,
} from "@/domain/groups";
import { userNotFound } from "@/lib/admin-users";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";
import type { TenantAccess } from "@/lib/tenant-context";

export type Group = {
  id: string;
  name: string;
  description: string | null;
  approval: boolean;
  archivedAt: string | null;
  createdAt: string;
};

const forbidden = () =>
  new ApiError(
    403,
    "group_forbidden",
    "Changing groups needs a company owner, or a company admin with the People area, signed in.",
  );
const ownerRequired = () =>
  new ApiError(
    403,
    "group_owner_required",
    "Only a company owner can change an approval group or a group nested in one.",
  );
const notFound = () => new ApiError(404, "not_found", "Group not found.");
const cycle = () =>
  new ApiError(
    409,
    "group_cycle",
    "A group cannot contain itself or a group that contains it.",
  );
const memberExists = () =>
  new ApiError(
    409,
    "group_member_exists",
    "This person or group is already a direct member.",
  );

/** The database refusals by SQLSTATE and constraint (drizzle/0052_company_groups.sql). */
const refusals: Record<string, () => ApiError> = {
  RQ006: userNotFound,
  RQ021: cycle,
  RQ022: () =>
    new ApiError(
      409,
      "group_depth",
      "Groups nest at most 3 levels: a group, its groups and their groups.",
    ),
  group_members_not_self: cycle,
  group_members_user: memberExists,
  group_members_child: memberExists,
  groups_current_name: () =>
    new ApiError(
      409,
      "group_name_exists",
      "Another current group already uses this name.",
    ),
  group_members_group_fkey: notFound,
  group_members_child_fkey: notFound,
};

/**
 * A signed-in company owner, or company admin with the people area, from the access state install
 * returned, as tenant_context.allows_workspace answers for the people area. The approval flag also
 * needs a company owner, as app.guard_group_write does.
 */
function requireWrite(p: Principal, access: TenantAccess, ownerOnly: boolean) {
  if (
    p.authType !== "session" ||
    (access.companyLevel !== "owner" && !access.companyAreas.includes("people"))
  )
    throw forbidden();
  if (ownerOnly && access.companyLevel !== "owner") throw ownerRequired();
}

/**
 * One withTeam transaction; the database stays authoritative and its refusals map to API errors. A
 * 42501 for a caller who passed requireWrite is app.guard_group_write refusing a company admin a
 * group that grants an approval.
 */
async function inGroups<T>(
  p: Principal,
  work: (tx: TeamTx, access: TenantAccess) => Promise<T>,
  ownerOnly = false,
): Promise<T> {
  let allowed = false;
  try {
    return await withTeam(p, async (tx, access) => {
      requireWrite(p, access, ownerOnly);
      allowed = true;
      return work(tx, access);
    });
  } catch (error) {
    const cause = (error instanceof DrizzleQueryError ? error.cause : error) as
      { code?: unknown; constraint?: unknown } | undefined;
    if (cause?.code === "42501") throw allowed ? ownerRequired() : forbidden();
    const refusal = ["23505", "23503", "23514"].includes(String(cause?.code))
      ? refusals[String(cause?.constraint)]
      : refusals[String(cause?.code)];
    if (refusal) throw refusal();
    throw error;
  }
}

const groupJson = sql.raw(
  `jsonb_build_object('id', g.id, 'name', g.name, 'description', g.description, 'approval', g.approval, 'archivedAt', g.archived_at, 'createdAt', g.created_at)`,
);

/** One change of a current group: the changed row, or 409 when it is archived, or 404. */
function updateGroup(
  p: Principal,
  groupId: string,
  change: SQL,
  ownerOnly = false,
): Promise<Group> {
  const id = z.uuid().parse(groupId);
  return inGroups(
    p,
    async (tx, access) => {
      const { rows } = await tx.execute<{ group: Group }>(
        sql`update app.groups g set ${change} where g.id = ${id}::uuid and g.workspace_id = ${access.workspaceId}::uuid and g.archived_at is null returning ${groupJson} as group`,
      );
      if (rows[0]) return rows[0].group;
      const { rows: found } = await tx.execute(
        sql`select 1 from app.groups where id = ${id}::uuid and workspace_id = ${access.workspaceId}::uuid`,
      );
      throw found[0]
        ? new ApiError(409, "group_archived", "This group is archived.")
        : notFound();
    },
    ownerOnly,
  );
}

/** Creates a current group of the context's workspace, never an approval group. */
export async function createGroup(
  p: Principal,
  input: { name: string; description?: string },
): Promise<Group> {
  const { name, description } = groupInput.parse(input);
  return inGroups(p, async (tx, access) => {
    const { rows } = await tx.execute<{ group: Group }>(
      sql`insert into app.groups as g (workspace_id, name, description) values (${access.workspaceId}::uuid, ${name}, ${description ?? null}) returning ${groupJson} as group`,
    );
    return rows[0].group;
  });
}

/** Sets the name, and the description when the key is given (empty clears it). */
export async function renameGroup(
  p: Principal,
  groupId: string,
  input: { name: string; description?: string },
): Promise<Group> {
  const { name, description } = groupInput.parse(input);
  return updateGroup(
    p,
    groupId,
    description === undefined
      ? sql`name = ${name}`
      : sql`name = ${name}, description = ${description}`,
  );
}

/** Archives a group for good; its members and effective membership stay. */
export async function archiveGroup(
  p: Principal,
  groupId: string,
): Promise<Group> {
  return updateGroup(p, groupId, sql`archived_at = now()`);
}

/** Company owners only, here and in app.guard_group_write: sets or clears the approval flag. */
export async function setGroupApproval(
  p: Principal,
  groupId: string,
  input: { approval: boolean },
): Promise<Group> {
  const { approval } = groupApproval.parse(input);
  return updateGroup(p, groupId, sql`approval = ${approval}`, true);
}

/** Adds a direct member: a person in a team of the workspace, or a child group within depth 3. */
export async function addGroupMember(
  p: Principal,
  groupId: string,
  member: { userId: string } | { childGroupId: string },
): Promise<void> {
  const id = z.uuid().parse(groupId);
  const target = groupMember.parse(member);
  await inGroups(p, async (tx, access) => {
    await tx.execute(
      "userId" in target
        ? sql`insert into app.group_members (group_id, workspace_id, user_id) values (${id}::uuid, ${access.workspaceId}::uuid, ${target.userId})`
        : sql`insert into app.group_members (group_id, workspace_id, child_group_id) values (${id}::uuid, ${access.workspaceId}::uuid, ${target.childGroupId}::uuid)`,
    );
  });
}

/** Removes a direct member; 404 when the person or group is not one. */
export async function removeGroupMember(
  p: Principal,
  groupId: string,
  member: { userId: string } | { childGroupId: string },
): Promise<void> {
  const id = z.uuid().parse(groupId);
  const target = groupMember.parse(member);
  await inGroups(p, async (tx, access) => {
    const { rows } = await tx.execute(
      sql`delete from app.group_members where group_id = ${id}::uuid and workspace_id = ${access.workspaceId}::uuid and ${
        "userId" in target
          ? sql`user_id = ${target.userId}`
          : sql`child_group_id = ${target.childGroupId}::uuid`
      } returning 1`,
    );
    if (!rows[0]) throw notFound();
  });
}

/**
 * The user ids of a computed group, read-only and never stored: company-owners, company-admins,
 * all-members, team-owners:<team id> or team-admins:<team id> (tenant_context.computed_group_members).
 * An unknown key or another workspace's team is 404.
 */
export async function computedGroupMembers(
  p: Principal,
  key: string,
): Promise<string[]> {
  const groupKey = computedGroupKey.parse(key);
  try {
    return await inGroups(p, async (tx) => {
      const { rows } = await tx.execute<{ user_id: string }>(
        sql`select user_id from tenant_context.computed_group_members(${groupKey})`,
      );
      return rows.map((row) => row.user_id);
    });
  } catch (error) {
    const cause = (error instanceof DrizzleQueryError ? error.cause : error) as
      { code?: unknown } | undefined;
    if (cause?.code === "22023") throw notFound();
    throw error;
  }
}
