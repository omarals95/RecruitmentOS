import { DrizzleQueryError, sql } from "drizzle-orm";
import type { TeamTx } from "@/db";
import { accessContext, authorize } from "./authz";
import { withTeam } from "./db-team";
import { ApiError } from "./errors";
import type { Principal } from "./principal";
import type { TenantAccess } from "./tenant-context";

/** One row of the Admin portal's Users list: a member of a workspace team or a pending invitation. */
export type WorkspacePersonRow = {
  userId: string | null;
  name: string | null;
  email: string;
  teams: {
    team: string;
    teamRole: string | null;
    configuredRole: string | null;
  }[];
  companyLevel: "owner" | "admin" | null;
  status: "active" | "invited" | "deactivated";
  lastSignInAt: string | null;
  twoStep: boolean;
};
export type WorkspacePeopleQuery = {
  team?: string;
  status?: "active" | "invited" | "deactivated";
  level?: "owner" | "admin" | "none";
  role?: string;
  /** A company group's id: only its effective members, direct or through nesting. */
  group?: string;
  /** The sort and row key of the last row shown, from nextCursor. */
  cursor?: [string, string];
};
export type WorkspacePeople = {
  data: WorkspacePersonRow[];
  /** The workspace's published, unarchived configured roles, for the role filter. */
  roles: { key: string; name: string }[];
  pagination: { pageSize: number; hasMore: boolean; nextCursor: string | null };
};
/** One event of the user detail page's Activity tab: ids, codes and names only. */
export type WorkspacePersonEvent = {
  occurredAt: string;
  action: string;
  actorId: string | null;
  actorName: string | null;
  /** Configuration rows only. */
  objectType: string | null;
  objectKey: string | null;
  /** Configured role rows only: the name in the role version the row names. */
  roleName: string | null;
};
/** The Admin portal's user detail page: one person of the workspace. */
export type WorkspacePerson = {
  userId: string;
  name: string;
  email: string;
  status: "active" | "deactivated";
  lastSignInAt: string | null;
  twoStep: boolean;
  /** Sessions that have not expired. */
  signedInDevices: number;
  /** The person's teams in this workspace only. */
  teams: {
    team: string;
    slug: string;
    teamRole: string | null;
    configuredRole: string | null;
  }[];
  /** The company authority fields are null without an app.workspace_admins row. */
  companyLevel: "owner" | "admin" | null;
  companyAreas: string[] | null;
  planAccess: boolean | null;
  authoritySuspended: boolean | null;
  authoritySince: string | null;
  /** Newest first, at most 50. */
  events: WorkspacePersonEvent[];
};

const PAGE_SIZE = 25;
export const peopleForbidden = () =>
  new ApiError(
    403,
    "people_forbidden",
    "Only a company owner, or a company admin with the People area, can see the users list.",
  );
export const userNotFound = () =>
  new ApiError(
    404,
    "user_not_found",
    "This person is not in any team of your company.",
  );
const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

/**
 * One withTeam for a signed-in company owner or company admin with the people area; anyone else,
 * and the owner-run helpers' 42501, gets 403 people_forbidden.
 */
export async function withPeopleArea<T>(
  p: Principal,
  work: (tx: TeamTx, access: TenantAccess) => Promise<T>,
): Promise<T> {
  try {
    return await withTeam(p, async (tx, access) => {
      if (p.authType !== "session") throw peopleForbidden();
      try {
        authorize(accessContext(p, access), {
          adminArea: "people",
          action: "view",
        });
      } catch (error) {
        if (error instanceof ApiError) throw peopleForbidden();
        throw error;
      }
      return work(tx, access);
    });
  } catch (error) {
    const code = (
      (error instanceof DrizzleQueryError ? error.cause : error) as
        { code?: unknown } | undefined
    )?.code;
    if (code === "42501") throw peopleForbidden();
    throw error;
  }
}

/**
 * Signed-in company owners and company admins with the people area: one page of everyone in every
 * team of the workspace and every pending invitation, through the owner-run helper, which returns
 * names, emails, teams and roles only, never team data (TST-005). The configured role choices come
 * from the same transaction. With a group, the group's effective members are read under RLS in the
 * same transaction and the helper's pages are walked, keeping the rows of those members, until a
 * full page and one more are found or the helper has no more rows; invitations never match.
 */
export async function listWorkspacePeople(
  p: Principal,
  query: WorkspacePeopleQuery,
): Promise<WorkspacePeople> {
  return withPeopleArea(p, async (tx, access) => {
    const helperPage = async ([after, afterKey]: [
      string | null,
      string | null,
    ]) =>
      (
        await tx.execute<{
          userId: string | null;
          name: string | null;
          email: string;
          teams: WorkspacePersonRow["teams"];
          companyLevel: WorkspacePersonRow["companyLevel"];
          status: WorkspacePersonRow["status"];
          lastSignInAt: Date | string | null;
          twoStep: boolean;
          sortKey: string;
          rowKey: string;
        }>(
          sql`select user_id as "userId", name, email, teams, company_level as "companyLevel", status, last_sign_in as "lastSignInAt", two_step as "twoStep", sort_key as "sortKey", row_key as "rowKey" from tenant_context.workspace_people(${query.team ?? null}::text, ${query.status ?? null}::text, ${query.level ?? null}::text, ${query.role ?? null}::text, ${after}::text, ${afterKey}::text)`,
        )
      ).rows;
    let rows: Awaited<ReturnType<typeof helperPage>>;
    if (query.group === undefined)
      rows = await helperPage(query.cursor ?? [null, null]);
    else {
      // RLS hides another workspace's group, so an unknown or foreign id has no members.
      const members = new Set(
        (
          await tx.execute<{ user_id: string }>(
            sql`select user_id from app.group_effective_members where group_id = ${query.group}::uuid and workspace_id = ${access.workspaceId}::uuid`,
          )
        ).rows.map((row) => row.user_id),
      );
      rows = [];
      let cursor: [string | null, string | null] = query.cursor ?? [null, null];
      while (members.size && rows.length <= PAGE_SIZE) {
        // The helper answers at most PAGE_SIZE + 1 rows; fewer means it has no more.
        const batch = await helperPage(cursor);
        rows.push(
          ...batch.filter((row) => row.userId && members.has(row.userId)),
        );
        const last = batch.at(-1);
        if (batch.length <= PAGE_SIZE || !last) break;
        cursor = [last.sortKey, last.rowKey];
      }
    }
    const roles = (
      await tx.execute<{ key: string; name: string }>(
        sql`select o.key, v.body->>'name' as name from app.config_objects o join app.config_versions v on v.id = o.current_version_id where o.workspace_id = ${access.workspaceId}::uuid and o.type = 'role' and o.archived_at is null order by name, o.key`,
      )
    ).rows;
    const page = rows.slice(0, PAGE_SIZE);
    const hasMore = rows.length > PAGE_SIZE;
    const last = page.at(-1);
    return {
      data: page.map((row) => ({
        userId: row.userId,
        name: row.name,
        email: row.email,
        teams: row.teams,
        companyLevel: row.companyLevel,
        status: row.status,
        lastSignInAt: iso(row.lastSignInAt),
        twoStep: row.twoStep,
      })),
      roles,
      pagination: {
        pageSize: PAGE_SIZE,
        hasMore,
        nextCursor:
          hasMore && last
            ? Buffer.from(JSON.stringify([last.sortKey, last.rowKey])).toString(
                "base64url",
              )
            : null,
      },
    };
  });
}

/**
 * Signed-in company owners and company admins with the people area: one person of the workspace,
 * through the owner-run helper, which answers nothing for anyone outside the workspace's teams
 * (404 user_not_found). Profile, teams and roles in this workspace, company authority, two-step and
 * signed-in device count, and up to 50 configuration and access-change events by ids and names.
 */
export async function getWorkspacePerson(
  p: Principal,
  userId: string,
): Promise<WorkspacePerson> {
  const row = await withPeopleArea(
    p,
    async (tx) =>
      (
        await tx.execute<{
          userId: string;
          name: string;
          email: string;
          lastSignInAt: Date | string | null;
          twoStep: boolean;
          signedInDevices: number;
          teams: WorkspacePerson["teams"];
          companyLevel: WorkspacePerson["companyLevel"];
          companyAreas: string[] | null;
          planAccess: boolean | null;
          authoritySuspended: boolean | null;
          authoritySince: Date | string | null;
          deactivated: boolean;
          events: WorkspacePersonEvent[];
        }>(
          sql`select user_id as "userId", name, email, last_sign_in as "lastSignInAt", two_step as "twoStep", signed_in_devices as "signedInDevices", teams, company_level as "companyLevel", company_areas as "companyAreas", plan_access as "planAccess", authority_suspended as "authoritySuspended", authority_since as "authoritySince", deactivated, events from tenant_context.workspace_person(${userId}::text)`,
        )
      ).rows[0],
  );
  if (!row) throw userNotFound();
  return {
    userId: row.userId,
    name: row.name,
    email: row.email,
    status: row.deactivated ? "deactivated" : "active",
    lastSignInAt: iso(row.lastSignInAt),
    twoStep: row.twoStep,
    signedInDevices: row.signedInDevices,
    teams: row.teams,
    companyLevel: row.companyLevel,
    companyAreas: row.companyAreas,
    planAccess: row.planAccess,
    authoritySuspended: row.authoritySuspended,
    authoritySince: iso(row.authoritySince),
    events: row.events.map((event) => ({
      occurredAt: new Date(event.occurredAt).toISOString(),
      action: event.action,
      actorId: event.actorId,
      actorName: event.actorName,
      objectType: event.objectType,
      objectKey: event.objectKey,
      roleName: event.roleName,
    })),
  };
}
