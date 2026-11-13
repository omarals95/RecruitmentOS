import { DrizzleQueryError, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getIdentityDb, type TeamTx } from "@/db";
import { organization, user } from "@/db/auth-schema";
import {
  computedGroupKey,
  groupApproval,
  groupInput,
  groupPerson,
  groupMember,
  groupReplacements,
  groupRoleGrant,
  groupRoleTeam,
  managedMemberEmail,
} from "@/domain/groups";
import { userNotFound, withPeopleArea } from "@/lib/admin-users";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import { requireFreshSession } from "@/lib/fresh-session";
import {
  assignableRole,
  assignableRoles,
  type AssignableRole,
} from "@/lib/member-roles";
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
export type GroupStatus = "active" | "archived";
export type GroupRef = { id: string; name: string };
/** One row of the Groups list: counts and direct links only, never a person. */
export type GroupListRow = GroupRef & {
  description: string | null;
  status: GroupStatus;
  /** tenant_context.group_grants: it, or a group it is in, grants something. */
  grants: boolean;
  directPeople: number;
  /** Effective members, direct and through nesting. */
  people: number;
  childGroups: GroupRef[];
  parentGroups: GroupRef[];
};
/** A computed group by key, with its people count; read-only and never stored. */
export type ComputedGroupRow = { key: string; name: string; people: number };
export type GroupList = { data: GroupListRow[]; computed: ComputedGroupRow[] };
export type GroupPerson = {
  userId: string;
  name: string | null;
  email: string | null;
};
/** A group's direct people and direct child groups, each child with its own, down to depth 3. */
export type GroupMembers = { people: GroupPerson[]; groups: GroupChild[] };
export type GroupChild = GroupRef & { status: GroupStatus } & GroupMembers;
export type GroupAuditRow = {
  occurredAt: string;
  action: string;
  actorName: string | null;
  /**
   * What the change names, by name: a person, a child group, or the parent this group was added to
   * or removed from, or for a replacement all three groups; null for a change of the group itself, a
   * null name when it cannot be resolved.
   */
  target:
    | { kind: "person" | "group" | "parent"; name: string | null }
    | {
        kind: "replacement";
        parent: string | null;
        replaced: string | null;
        replacement: string | null;
      }
    | { kind: "role"; role: string | null; team: string | null }
    | null;
};
/**
 * One current use of a group, by id. Each source is one query in groupUses, so a later item adds its
 * source here and one query there: the active groups it is directly in, and the roles it gives.
 */
export type GroupUse =
  | {
      source: "parent-group";
      group: GroupRef & { status: GroupStatus };
    }
  | {
      source: "role-grant";
      team: { id: string; name: string };
      role: { id: string; name: string };
    };
/**
 * What replaces an archived group in a parent that uses it, or for the role it gives in a team:
 * another group, or null to remove it there.
 */
export type GroupReplacement =
  | { parentGroupId: string; replacementGroupId: string | null }
  | { teamId: string; replacementGroupId: string | null };
/** What a company owner can give a group: the current teams and the assignable roles, by name. */
export type GroupRoleChoices = {
  teams: { id: string; name: string }[];
  roles: AssignableRole[];
};
export type GroupDetail = GroupRef & {
  description: string | null;
  status: GroupStatus;
  grants: boolean;
  people: number;
  members: GroupMembers;
  /** Every group that contains this one, at any depth; via is the group in between, null when direct. */
  memberOf: (GroupRef & { status: GroupStatus; via: string | null })[];
  /** The delegated managers, by name. */
  managers: GroupPerson[];
  whereUsed: GroupUse[];
  /** From the caller's current team only, newest first, at most 50. */
  audit: GroupAuditRow[];
};
/** A current group the caller manages, for Groups I manage: its direct people only. */
export type ManagedGroup = GroupRef & {
  description: string | null;
  grants: boolean;
  people: GroupPerson[];
};
/** A company group a person is in, directly or through the groups nested below it. */
export type UserGroupRow = GroupRef & {
  status: GroupStatus;
  direct: boolean;
  /** The person's direct groups nested below this one, by name. */
  through: string[];
};

export const GROUP_AUDIT_LIMIT = 50;

const forbidden = () =>
  new ApiError(
    403,
    "group_forbidden",
    "Changing groups needs a company owner, or a company admin with the People area, signed in.",
  );
export const ownerRequired = () =>
  new ApiError(
    403,
    "group_owner_required",
    "Only a company owner can change a group that grants access, or a group nested in one.",
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
const groupArchived = () =>
  new ApiError(409, "group_archived", "This group is archived.");
const roleExists = () =>
  new ApiError(
    409,
    "group_role_exists",
    "This group already gives a role in this team. Remove it first.",
  );
/** A manager's refusal on a group that grants something, it or a group it is in. */
const managerGranting = () =>
  new ApiError(
    403,
    "group_owner_required",
    "Only a company owner can change this group now, because it or a group it is in grants access.",
  );

/**
 * The database refusals by SQLSTATE and constraint (drizzle/0052_company_groups.sql,
 * drizzle/0056_group_managers.sql).
 */
const refusals: Record<string, () => ApiError> = {
  RQ006: userNotFound,
  RQ023: groupArchived,
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
  group_managers_pkey: () =>
    new ApiError(
      409,
      "group_manager_exists",
      "This person is already a manager of this group.",
    ),
  group_roles_pkey: roleExists,
  group_roles_group_fkey: notFound,
};

/** A database refusal as its API error, 42501 as `denied`; anything else is returned unchanged. */
function refusalOf(error: unknown, denied: () => ApiError): unknown {
  const cause = (error instanceof DrizzleQueryError ? error.cause : error) as
    { code?: unknown; constraint?: unknown } | undefined;
  if (cause?.code === "42501") return denied();
  const refusal = ["23505", "23503", "23514"].includes(String(cause?.code))
    ? refusals[String(cause?.constraint)]
    : refusals[String(cause?.code)];
  return refusal ? refusal() : error;
}

/** RQ024's DETAIL (drizzle/0057_group_roles.sql): ids only. */
const conflictDetail = z.object({
  teamId: z.string(),
  userIds: z.array(z.string()),
  count: z.number().int().positive(),
});
const NAMED_PEOPLE = 5;
/** The two-roles sentence (D30) for the people listed, by name, and the team's name. */
export const roleConflictMessage = (listed: string, team: string) =>
  `This would give ${listed} two roles in ${team}. A person holds one configured role per team: remove them from one of the groups, or choose their role in the team's Members tab.`;

/**
 * As refusalOf, plus the two-roles refusal (RQ024) as 409 group_role_conflict, naming the people
 * and the team from the identity database by the ids the database reported: at most five people,
 * then how many more, and a name it cannot find as a former member.
 */
async function refusal(
  error: unknown,
  denied: () => ApiError,
): Promise<unknown> {
  const cause = (error instanceof DrizzleQueryError ? error.cause : error) as
    { code?: unknown; detail?: unknown } | undefined;
  if (cause?.code !== "RQ024") return refusalOf(error, denied);
  let detail: z.infer<typeof conflictDetail>;
  try {
    detail = conflictDetail.parse(JSON.parse(String(cause.detail)));
  } catch {
    return error;
  }
  const shown = detail.userIds.slice(0, NAMED_PEOPLE);
  const people = await peopleByIds(shown);
  const names = shown.map((id) => people.get(id)?.name ?? "a former member");
  const more = detail.count - names.length;
  const listed =
    more > 0
      ? `${names.join(", ")} and ${more} more`
      : names.length > 1
        ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
        : names[0];
  const db = await getIdentityDb();
  const [team] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, detail.teamId))
    .limit(1);
  return new ApiError(
    409,
    "group_role_conflict",
    roleConflictMessage(listed, team?.name ?? "this team"),
  );
}

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
 * group that grants something.
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
    throw await refusal(error, allowed ? ownerRequired : forbidden);
  }
}

const groupJson = sql.raw(
  `jsonb_build_object('id', g.id, 'name', g.name, 'description', g.description, 'approval', g.approval, 'archivedAt', g.archived_at, 'createdAt', g.created_at)`,
);

/**
 * Before any write to a group for which tenant_context.group_grants is true (it, or a group it is
 * nested in, grants something): a caller below company owner gets 403 group_owner_required, and a
 * company owner needs a recent sign-in (403 SESSION_NOT_FRESH, ADM-06), so nothing is written. A
 * group that grants nothing needs neither. app.guard_group_write stays the real control.
 */
async function requireGrantingChange(
  tx: TeamTx,
  p: Principal,
  access: TenantAccess,
  groupId: string,
) {
  const { rows } = await tx.execute<{ grants: boolean }>(
    sql`select tenant_context.group_grants(${groupId}::uuid) as grants`,
  );
  if (!rows[0]?.grants) return;
  if (access.companyLevel !== "owner") throw ownerRequired();
  requireFreshSession(p);
}

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
      await requireGrantingChange(tx, p, access, id);
      const { rows } = await tx.execute<{ group: Group }>(
        sql`update app.groups g set ${change} where g.id = ${id}::uuid and g.workspace_id = ${access.workspaceId}::uuid and g.archived_at is null returning ${groupJson} as group`,
      );
      if (rows[0]) return rows[0].group;
      const { rows: found } = await tx.execute(
        sql`select 1 from app.groups where id = ${id}::uuid and workspace_id = ${access.workspaceId}::uuid`,
      );
      throw found[0] ? groupArchived() : notFound();
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

/** The same ids as the current uses of one source, each once. */
const sameUses = (ids: string[], current: Set<string>) =>
  ids.length === current.size &&
  new Set(ids).size === current.size &&
  ids.every((item) => current.has(item));

/**
 * Archives a group for good, in one transaction: each parent group that uses it first takes the
 * chosen replacement (one UPDATE of its child row) or loses it (null), and each role it gives is
 * removed and, with a replacement, given in the same team by that group; then archived_at is set. A
 * group in use needs a choice for exactly its current uses (409 group_in_use, 409
 * group_uses_changed); a replacement that is the group itself, archived, unknown, already a direct
 * child of that parent or already giving a role in that team, or that makes a cycle, nests too deep
 * or gives someone two roles in one team is refused, and any refusal rolls everything back. Its
 * members and effective membership stay.
 */
export async function archiveGroup(
  p: Principal,
  groupId: string,
  replacements?: GroupReplacement[],
): Promise<Group> {
  const id = z.uuid().parse(groupId);
  const chosen = groupReplacements.optional().parse(replacements);
  return inGroups(p, async (tx, access) => {
    await requireGrantingChange(tx, p, access, id);
    const { rows: current } = await tx.execute<{ archived: boolean }>(
      sql`select archived_at is not null as archived from app.groups where id = ${id}::uuid and workspace_id = ${access.workspaceId}::uuid`,
    );
    if (!current[0]) throw notFound();
    if (current[0].archived) throw groupArchived();
    const uses = await groupUses(tx, id);
    if (uses.length && !chosen)
      throw new ApiError(
        409,
        "group_in_use",
        "This group is in use. Choose what replaces it in each place first.",
      );
    const roles = new Map(
      uses.flatMap((use) =>
        use.source === "role-grant"
          ? [[use.team.id, use.role.id] as const]
          : [],
      ),
    );
    const parentChoices = (chosen ?? []).flatMap((item) =>
      "parentGroupId" in item ? [item] : [],
    );
    const roleChoices = (chosen ?? []).flatMap((item) =>
      "teamId" in item ? [item] : [],
    );
    const parents = parentChoices.map((item) => item.parentGroupId);
    if (
      !sameUses(
        parents,
        new Set(
          uses.flatMap((use) =>
            use.source === "parent-group" ? [use.group.id] : [],
          ),
        ),
      ) ||
      !sameUses(
        roleChoices.map((item) => item.teamId),
        new Set(roles.keys()),
      )
    )
      throw new ApiError(
        409,
        "group_uses_changed",
        "What uses this group changed. Review Where used and try again.",
      );
    for (const parent of parents)
      await requireGrantingChange(tx, p, access, parent);
    for (const { parentGroupId, replacementGroupId } of parentChoices) {
      // The parent already holds the group itself directly.
      if (replacementGroupId === id) throw memberExists();
      await tx.execute(
        replacementGroupId === null
          ? sql`delete from app.group_members where group_id = ${parentGroupId}::uuid and child_group_id = ${id}::uuid`
          : sql`update app.group_members set child_group_id = ${replacementGroupId}::uuid where group_id = ${parentGroupId}::uuid and child_group_id = ${id}::uuid`,
      );
    }
    for (const { teamId, replacementGroupId } of roleChoices) {
      // The group itself already gives a role in that team.
      if (replacementGroupId === id) throw roleExists();
      await tx.execute(
        sql`delete from app.group_roles where group_id = ${id}::uuid and team_id = ${teamId}`,
      );
      if (replacementGroupId !== null)
        await tx.execute(
          sql`insert into app.group_roles (group_id, workspace_id, team_id, role_object_id) values (${replacementGroupId}::uuid, ${access.workspaceId}::uuid, ${teamId}, ${roles.get(teamId)}::uuid)`,
        );
    }
    const { rows } = await tx.execute<{ group: Group }>(
      sql`update app.groups g set archived_at = now() where g.id = ${id}::uuid and g.workspace_id = ${access.workspaceId}::uuid returning ${groupJson} as group`,
    );
    return rows[0].group;
  });
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

/**
 * Adds a direct member: a person in a team of the workspace, or a current child group within depth
 * 3. An archived group takes nothing new and is nobody's new child (409 group_archived).
 */
export async function addGroupMember(
  p: Principal,
  groupId: string,
  member: { userId: string } | { childGroupId: string },
): Promise<void> {
  const id = z.uuid().parse(groupId);
  const target = groupMember.parse(member);
  await inGroups(p, async (tx, access) => {
    await requireGrantingChange(tx, p, access, id);
    const { rows } = await tx.execute<{ archived: boolean }>(
      sql`select exists (select 1 from app.groups g where g.workspace_id = ${access.workspaceId}::uuid and g.archived_at is not null
        and g.id in (${id}::uuid, ${"childGroupId" in target ? target.childGroupId : null}::uuid)) as archived`,
    );
    if (rows[0].archived) throw groupArchived();
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
    await requireGrantingChange(tx, p, access, id);
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
 * Company owners only, here and in app.guard_group_role: what the group can be given, the current
 * teams of the workspace and the roles assignMemberRole would offer. Viewing needs no recent sign-in.
 */
export async function listGroupRoleChoices(
  p: Principal,
  groupId: string,
): Promise<GroupRoleChoices> {
  const id = z.uuid().parse(groupId);
  return inGroups(
    p,
    async (tx, access) => {
      const { rows } = await tx.execute(
        sql`select 1 from app.groups where id = ${id}::uuid and workspace_id = ${access.workspaceId}::uuid`,
      );
      if (!rows[0]) throw notFound();
      const { rows: teams } = await tx.execute<{ id: string; name: string }>(
        sql`select id, name from tenant_context.workspace_team_list() where not archived order by lower(name), id`,
      );
      return { teams, roles: assignableRoles(access) };
    },
    true,
  );
}

/**
 * A company owner with a recent sign-in gives a current group a published configured role in one
 * current team of the workspace (app.guard_group_role and the two-roles check stay the real
 * controls): 404 for an unknown group, team or role, 409 group_archived, role_not_published,
 * role_invalid, group_role_exists for a group already giving a role there, and
 * group_role_conflict when someone would hold two roles in that team.
 */
export async function grantGroupRole(
  p: Principal,
  groupId: string,
  input: { teamId: string; roleObjectId: string },
): Promise<void> {
  const id = z.uuid().parse(groupId);
  const { teamId, roleObjectId } = groupRoleGrant.parse(input);
  await inGroups(
    p,
    async (tx, access) => {
      requireFreshSession(p);
      const [group] = (
        await tx.execute<{ archived: boolean }>(
          sql`select archived_at is not null as archived from app.groups where id = ${id}::uuid and workspace_id = ${access.workspaceId}::uuid`,
        )
      ).rows;
      if (!group) throw notFound();
      if (group.archived) throw groupArchived();
      const { rows: teams } = await tx.execute(
        sql`select 1 from tenant_context.workspace_team_list() where id = ${teamId} and not archived`,
      );
      if (!teams[0]) throw new ApiError(404, "not_found", "Team not found.");
      await assignableRole(tx, access, roleObjectId);
      await tx.execute(
        sql`insert into app.group_roles (group_id, workspace_id, team_id, role_object_id) values (${id}::uuid, ${access.workspaceId}::uuid, ${teamId}, ${roleObjectId}::uuid)`,
      );
    },
    true,
  );
}

/** A company owner with a recent sign-in removes the role a group gives in one team; 404 when none. */
export async function removeGroupRole(
  p: Principal,
  groupId: string,
  input: { teamId: string },
): Promise<void> {
  const id = z.uuid().parse(groupId);
  const { teamId } = groupRoleTeam.parse(input);
  await inGroups(
    p,
    async (tx, access) => {
      requireFreshSession(p);
      const { rows } = await tx.execute(
        sql`delete from app.group_roles where group_id = ${id}::uuid and workspace_id = ${access.workspaceId}::uuid and team_id = ${teamId} returning 1`,
      );
      if (!rows[0])
        throw new ApiError(404, "not_found", "Role grant not found.");
    },
    true,
  );
}

/**
 * Names a delegated manager of a current group that grants nothing: a person in a team of the
 * workspace (404 user_not_found). A group that grants something has no managers, for a company owner
 * too (409 group_grants_no_managers here, 42501 in app.guard_group_write), so naming one never needs
 * a recent sign-in; a manager already named is 409 group_manager_exists.
 */
export async function addGroupManager(
  p: Principal,
  groupId: string,
  manager: { userId: string },
): Promise<void> {
  const id = z.uuid().parse(groupId);
  const { userId } = groupPerson.parse(manager);
  await inGroups(p, async (tx, access) => {
    const [group] = (
      await tx.execute<{ archived: boolean; grants: boolean }>(
        sql`select archived_at is not null as archived, tenant_context.group_grants(id) as grants from app.groups where id = ${id}::uuid and workspace_id = ${access.workspaceId}::uuid`,
      )
    ).rows;
    if (!group) throw notFound();
    if (group.grants)
      throw new ApiError(
        409,
        "group_grants_no_managers",
        "A group that grants access cannot have managers.",
      );
    if (group.archived) throw groupArchived();
    await tx.execute(
      sql`insert into app.group_managers (group_id, workspace_id, user_id) values (${id}::uuid, ${access.workspaceId}::uuid, ${userId})`,
    );
  });
}

/**
 * Removes a delegated manager; 404 when the person is not one. One named before the group started
 * granting is removed only by a company owner with a recent sign-in.
 */
export async function removeGroupManager(
  p: Principal,
  groupId: string,
  manager: { userId: string },
): Promise<void> {
  const id = z.uuid().parse(groupId);
  const { userId } = groupPerson.parse(manager);
  await inGroups(p, async (tx, access) => {
    await requireGrantingChange(tx, p, access, id);
    const { rows } = await tx.execute(
      sql`delete from app.group_managers where group_id = ${id}::uuid and workspace_id = ${access.workspaceId}::uuid and user_id = ${userId} returning 1`,
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

const statusOf = sql.raw(
  `case when g.archived_at is null then 'active' else 'archived' end`,
);

/**
 * Every current use of the group by id, one query per source, so a later item adds its source and
 * one query: the active groups it is directly in, by name, and the roles it gives, by team name.
 * A role's name is its current published name, else its draft's.
 */
async function groupUses(tx: TeamTx, groupId: string): Promise<GroupUse[]> {
  const { rows: parents } = await tx.execute<
    GroupRef & { status: GroupStatus }
  >(
    sql`select g.id, g.name, ${statusOf} as status from app.group_members m join app.groups g on g.id = m.group_id
      where m.child_group_id = ${groupId}::uuid and g.archived_at is null order by lower(g.name), g.id`,
  );
  const { rows: grants } = await tx.execute<{
    teamId: string;
    teamName: string;
    roleId: string;
    roleName: string;
  }>(
    sql`select r.team_id as "teamId", t.name as "teamName", r.role_object_id as "roleId", coalesce(c.body->>'name', d.body->>'name') as "roleName"
      from app.group_roles r join tenant_context.workspace_team_list() t on t.id = r.team_id
      left join app.config_objects o on o.id = r.role_object_id left join app.config_versions c on c.id = o.current_version_id left join app.config_versions d on d.id = o.draft_version_id
      where r.group_id = ${groupId}::uuid order by lower(t.name), t.id, lower(coalesce(c.body->>'name', d.body->>'name'))`,
  );
  return [
    ...parents.map((group) => ({ source: "parent-group" as const, group })),
    ...grants.map((row) => ({
      source: "role-grant" as const,
      team: { id: row.teamId, name: row.teamName },
      role: { id: row.roleId, name: row.roleName },
    })),
  ];
}

/** Names and emails by the user ids read under RLS, from the identity database. */
async function peopleByIds(ids: string[]) {
  if (!ids.length) return new Map<string, { name: string; email: string }>();
  const db = await getIdentityDb();
  return new Map(
    (
      await db
        .select({ id: user.id, name: user.name, email: user.email })
        .from(user)
        .where(inArray(user.id, [...new Set(ids)]))
    ).map((row) => [row.id, row]),
  );
}

/**
 * Signed-in company owners and company admins with the people area (403 people_forbidden
 * otherwise): every group of the workspace by name with its status, whether it grants something,
 * its counts and its direct child and parent groups, and the computed groups with their people
 * counts. No person's name or email.
 */
export async function listGroups(p: Principal): Promise<GroupList> {
  return withPeopleArea(p, async (tx, access) => {
    const { rows } = await tx.execute<GroupListRow>(
      sql`select g.id, g.name, g.description, ${statusOf} as status, tenant_context.group_grants(g.id) as grants,
        (select count(*)::int from app.group_members m where m.group_id = g.id and m.user_id is not null) as "directPeople",
        (select count(*)::int from app.group_effective_members e where e.group_id = g.id) as people,
        coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by lower(c.name), c.id) from app.group_members m join app.groups c on c.id = m.child_group_id where m.group_id = g.id), '[]'::jsonb) as "childGroups",
        coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) order by lower(o.name), o.id) from app.group_members m join app.groups o on o.id = m.group_id where m.child_group_id = g.id), '[]'::jsonb) as "parentGroups"
        from app.groups g where g.workspace_id = ${access.workspaceId}::uuid order by lower(g.name), g.id`,
    );
    // Company owners, company admins, all members, then each team's owners and admins by team name.
    const { rows: computed } = await tx.execute<ComputedGroupRow>(
      sql`with teams as (select t.id, t.name, t.n from tenant_context.workspace_team_list() with ordinality as t(id, name, slug, created_at, archived, n)),
        keys(n, o, key, name) as (
          select 0::bigint, 0, 'company-owners', 'Company owners'
          union all select 0, 1, 'company-admins', 'Company admins'
          union all select 0, 2, 'all-members', 'All members'
          union all select n, 0, 'team-owners:' || id, 'Owners of ' || name from teams
          union all select n, 1, 'team-admins:' || id, 'Admins of ' || name from teams)
        select key, name, (select count(*)::int from tenant_context.computed_group_members(key)) as people from keys order by n, o`,
    );
    return { data: rows, computed };
  });
}

/**
 * Signed-in company owners and company admins with the people area: one group of the workspace
 * (404 not_found for an unknown id or another workspace's group, which RLS hides), its members as a
 * tree down to the 3-level limit, its effective people count, every group it is in, its managers,
 * what uses it, and its audit rows from the caller's current team. Ids are read under RLS; names and
 * emails come from the identity database by those ids.
 */
export async function getGroup(
  p: Principal,
  groupId: string,
): Promise<GroupDetail> {
  const id = z.uuid().parse(groupId);
  const { group, links, above, managers, whereUsed, audit } =
    await withPeopleArea(p, async (tx, access) => {
      const [group] = (
        await tx.execute<{
          id: string;
          name: string;
          description: string | null;
          status: GroupStatus;
          grants: boolean;
          people: number;
        }>(
          sql`select g.id, g.name, g.description, ${statusOf} as status, tenant_context.group_grants(g.id) as grants,
            (select count(*)::int from app.group_effective_members e where e.group_id = g.id) as people
            from app.groups g where g.id = ${id}::uuid and g.workspace_id = ${access.workspaceId}::uuid`,
        )
      ).rows;
      if (!group) throw notFound();
      // The direct members of the group and of the groups below it, at most two levels down.
      const { rows: links } = await tx.execute<{
        groupId: string;
        userId: string | null;
        childId: string | null;
        childName: string | null;
        childStatus: GroupStatus | null;
      }>(
        sql`with recursive tree(id, depth) as (
            select ${id}::uuid, 0
            union select m.child_group_id, tree.depth + 1 from tree join app.group_members m on m.group_id = tree.id and m.child_group_id is not null where tree.depth < 2)
          select m.group_id as "groupId", m.user_id as "userId", m.child_group_id as "childId", g.name as "childName",
            case when g.id is null then null else ${statusOf} end as "childStatus"
          from app.group_members m left join app.groups g on g.id = m.child_group_id
          where m.group_id in (select tree.id from tree) order by lower(g.name), g.id`,
      );
      // Every group above it, at most two levels up, so via is the one group in between.
      const { rows: above } = await tx.execute<{
        id: string;
        name: string;
        status: GroupStatus;
        via: string | null;
      }>(
        sql`with recursive up(id, via, depth) as (
            select m.group_id, null::uuid, 1 from app.group_members m where m.child_group_id = ${id}::uuid
            union all select m.group_id, up.id, up.depth + 1 from up join app.group_members m on m.child_group_id = up.id where up.depth < 3)
          select g.id, g.name, ${statusOf} as status, v.name as via
          from up join app.groups g on g.id = up.id left join app.groups v on v.id = up.via
          order by up.via is not null, lower(g.name), g.id`,
      );
      const { rows: managers } = await tx.execute<{ userId: string }>(
        sql`select user_id as "userId" from app.group_managers where group_id = ${id}::uuid`,
      );
      const whereUsed = await groupUses(tx, id);
      // A replacement names three groups: the parent, the replacement and the group it replaced; a
      // role row names the role in the version it recorded and the team.
      const { rows: audit } = await tx.execute<{
        occurredAt: Date | string;
        action: string;
        actorName: string | null;
        targetUserId: string | null;
        relation: "group" | "parent" | null;
        groupName: string | null;
        parentName: string | null;
        childName: string | null;
        replacedName: string | null;
        roleName: string | null;
        teamName: string | null;
      }>(
        sql`select a.created_at as "occurredAt", a.action, tenant_context.activity_actor_name(a.id) as "actorName",
            a.metadata->>'targetUserId' as "targetUserId",
            case when a.metadata->>'childGroupId' = ${id} then 'parent' when a.metadata ? 'childGroupId' then 'group' end as relation,
            case when a.metadata->>'childGroupId' = ${id} then parent.name else child.name end as "groupName",
            parent.name as "parentName", child.name as "childName", replaced.name as "replacedName",
            role.body->>'name' as "roleName", team.name as "teamName"
          from app.activity a
          left join app.groups parent on parent.id::text = a.metadata->>'groupId' and parent.workspace_id = ${access.workspaceId}::uuid
          left join app.groups child on child.id::text = a.metadata->>'childGroupId' and child.workspace_id = ${access.workspaceId}::uuid
          left join app.groups replaced on replaced.id::text = a.metadata->>'replacedGroupId' and replaced.workspace_id = ${access.workspaceId}::uuid
          left join app.config_versions role on role.id::text = a.metadata->>'roleVersionId' and role.workspace_id = ${access.workspaceId}::uuid
          left join tenant_context.workspace_team_list() team on team.id = a.metadata->>'teamId'
          where a.team_id = ${p.teamId} and a.kind = 'group' and a.metadata->>'workspaceId' = ${access.workspaceId}
            and (a.metadata->>'groupId' = ${id} or a.metadata->>'childGroupId' = ${id} or a.metadata->>'replacedGroupId' = ${id})
          order by a.created_at desc, a.id desc limit ${GROUP_AUDIT_LIMIT}`,
      );
      return { group, links, above, managers, whereUsed, audit };
    });
  const people = await peopleByIds([
    ...links.flatMap((link) => (link.userId ? [link.userId] : [])),
    ...managers.map((row) => row.userId),
    ...audit.flatMap((row) => (row.targetUserId ? [row.targetUserId] : [])),
  ]);
  const personOf = (userId: string): GroupPerson => {
    const person = people.get(userId);
    return { userId, name: person?.name ?? null, email: person?.email ?? null };
  };
  const membersOf = (parent: string, depth: number): GroupMembers => {
    const direct = links.filter((link) => link.groupId === parent);
    return {
      people: direct
        .flatMap((link) => (link.userId ? [personOf(link.userId)] : []))
        .sort((a, b) => byName(a.name ?? "", b.name ?? "")),
      groups: direct.flatMap((link) =>
        link.childId && depth < 2
          ? [
              {
                id: link.childId,
                name: link.childName ?? "",
                status: link.childStatus ?? "active",
                ...membersOf(link.childId, depth + 1),
              },
            ]
          : [],
      ),
    };
  };
  // One entry per containing group, direct ones first: directly when it is a direct parent, else
  // through the first group in between.
  const memberOf = new Map<string, GroupDetail["memberOf"][number]>();
  for (const row of above) if (!memberOf.has(row.id)) memberOf.set(row.id, row);
  return {
    ...group,
    members: membersOf(group.id, 0),
    memberOf: [...memberOf.values()],
    managers: managers
      .map((row) => personOf(row.userId))
      .sort((a, b) => byName(a.name ?? "", b.name ?? "")),
    whereUsed,
    audit: audit.map((row) => ({
      occurredAt: new Date(row.occurredAt).toISOString(),
      action: row.action,
      actorName: row.actorName,
      target:
        row.action === "group.role_granted" ||
        row.action === "group.role_removed"
          ? { kind: "role" as const, role: row.roleName, team: row.teamName }
          : row.action === "group.child_replaced"
            ? {
                kind: "replacement" as const,
                parent: row.parentName,
                replaced: row.replacedName,
                replacement: row.childName,
              }
            : row.targetUserId
              ? {
                  kind: "person" as const,
                  name: people.get(row.targetUserId)?.name ?? null,
                }
              : row.relation
                ? { kind: row.relation, name: row.groupName }
                : null,
    })),
  };
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" });

/**
 * Signed-in company owners and company admins with the people area: the company groups the person
 * is in, directly or through nesting, by name, with the person's direct groups below each. A person
 * in no group of the workspace gets an empty list.
 */
export async function listUserGroups(
  p: Principal,
  userId: string,
): Promise<UserGroupRow[]> {
  return withPeopleArea(p, async (tx, access) => {
    const { rows } = await tx.execute<UserGroupRow>(
      sql`select g.id, g.name, ${statusOf} as status,
          exists (select 1 from app.group_members m where m.group_id = g.id and m.user_id = ${userId}) as direct,
          coalesce((with recursive down(id) as (
              select m.child_group_id from app.group_members m where m.group_id = g.id and m.child_group_id is not null
              union select m.child_group_id from down join app.group_members m on m.group_id = down.id and m.child_group_id is not null)
            select jsonb_agg(d.name order by lower(d.name), d.id) from down join app.groups d on d.id = down.id
            where exists (select 1 from app.group_members u where u.group_id = d.id and u.user_id = ${userId})), '[]'::jsonb) as through
        from app.group_effective_members e join app.groups g on g.id = e.group_id
        where e.user_id = ${userId} and e.workspace_id = ${access.workspaceId}::uuid order by lower(g.name), g.id`,
    );
    return rows;
  });
}

/**
 * One withTeam for any signed-in session in its current team, for Groups I manage. A delegated
 * manager reads and writes only through the manager policies of drizzle/0056_group_managers.sql, so
 * row-level security decides what they see and app.guard_group_write stays the real control; its
 * 42501 here is a group that started granting since the page loaded.
 */
async function asManager<T>(
  p: Principal,
  work: (tx: TeamTx, access: TenantAccess) => Promise<T>,
): Promise<T> {
  try {
    return await withTeam(p, work);
  } catch (error) {
    throw await refusal(error, managerGranting);
  }
}

/**
 * Before a manager's change: a current group the caller manages (404 not_found otherwise, the same
 * for a group of another workspace) that grants nothing (403 group_owner_required) and is not
 * archived (409 group_archived).
 */
async function requireManaged(
  tx: TeamTx,
  p: Principal,
  access: TenantAccess,
  groupId: string,
) {
  const [group] = (
    await tx.execute<{ archived: boolean; grants: boolean }>(
      sql`select g.archived_at is not null as archived, tenant_context.group_grants(g.id) as grants
        from app.groups g join app.group_managers r on r.group_id = g.id and r.user_id = ${p.userId}
        where g.id = ${groupId}::uuid and g.workspace_id = ${access.workspaceId}::uuid`,
    )
  ).rows;
  if (!group) throw notFound();
  if (group.grants) throw managerGranting();
  if (group.archived) throw groupArchived();
}

/**
 * The current groups of the current team's workspace the caller manages, by name, each with
 * whether it grants something and its direct people only (names and emails from the identity
 * database): no child group, manager or count. Someone who manages nothing gets an empty list.
 */
export async function listManagedGroups(p: Principal): Promise<ManagedGroup[]> {
  const rows = await asManager(p, async (tx, access) => {
    const { rows } = await tx.execute<
      Omit<ManagedGroup, "people"> & { userIds: string[] }
    >(
      sql`select g.id, g.name, g.description, tenant_context.group_grants(g.id) as grants,
          coalesce((select jsonb_agg(m.user_id order by m.user_id) from app.group_members m where m.group_id = g.id and m.user_id is not null), '[]'::jsonb) as "userIds"
        from app.groups g join app.group_managers r on r.group_id = g.id and r.user_id = ${p.userId}
        where g.workspace_id = ${access.workspaceId}::uuid and g.archived_at is null order by lower(g.name), g.id`,
    );
    return rows;
  });
  const people = await peopleByIds(rows.flatMap((row) => row.userIds));
  return rows.map(({ userIds, ...group }) => ({
    ...group,
    people: userIds
      .map((userId) => ({
        userId,
        name: people.get(userId)?.name ?? null,
        email: people.get(userId)?.email ?? null,
      }))
      .sort((a, b) => byName(a.name ?? "", b.name ?? "")),
  }));
}

/**
 * A manager adds a person by the email of their account, matched ignoring case. An email with no
 * account and an account in no team of the workspace get the same 404 user_not_found, so the answer
 * never tells whether an account exists.
 */
export async function addManagedMember(
  p: Principal,
  groupId: string,
  input: { email: string },
): Promise<void> {
  const id = z.uuid().parse(groupId);
  const { email } = managedMemberEmail.parse(input);
  const db = await getIdentityDb();
  const [account] = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = lower(${email})`)
    .limit(1);
  await asManager(p, async (tx, access) => {
    await requireManaged(tx, p, access, id);
    if (!account) throw userNotFound();
    await tx.execute(
      sql`insert into app.group_members (group_id, workspace_id, user_id) values (${id}::uuid, ${access.workspaceId}::uuid, ${account.id})`,
    );
  });
}

/** A manager removes a direct person of the group; 404 when they are not one. */
export async function removeManagedMember(
  p: Principal,
  groupId: string,
  member: { userId: string },
): Promise<void> {
  const id = z.uuid().parse(groupId);
  const { userId } = groupPerson.parse(member);
  await asManager(p, async (tx, access) => {
    await requireManaged(tx, p, access, id);
    const { rows } = await tx.execute(
      sql`delete from app.group_members where group_id = ${id}::uuid and workspace_id = ${access.workspaceId}::uuid and user_id = ${userId} returning 1`,
    );
    if (!rows[0]) throw notFound();
  });
}
