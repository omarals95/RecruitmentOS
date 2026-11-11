import { DrizzleQueryError, sql } from "drizzle-orm";
import { accessContext, authorize } from "./authz";
import { withTeam } from "./db-team";
import { ApiError } from "./errors";
import type { Principal } from "./principal";

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
  status: "active" | "invited";
  lastSignInAt: string | null;
  twoStep: boolean;
};
export type WorkspacePeopleQuery = {
  team?: string;
  status?: "active" | "invited";
  level?: "owner" | "admin" | "none";
  role?: string;
  /** The sort and row key of the last row shown, from nextCursor. */
  cursor?: [string, string];
};
export type WorkspacePeople = {
  data: WorkspacePersonRow[];
  /** The workspace's published, unarchived configured roles, for the role filter. */
  roles: { key: string; name: string }[];
  pagination: { pageSize: number; hasMore: boolean; nextCursor: string | null };
};

const PAGE_SIZE = 25;
const peopleForbidden = () =>
  new ApiError(
    403,
    "people_forbidden",
    "Only a company owner, or a company admin with the People area, can see the users list.",
  );

/**
 * Signed-in company owners and company admins with the people area: one page of everyone in every
 * team of the workspace and every pending invitation, through the owner-run helper, which returns
 * names, emails, teams and roles only, never team data (TST-005). The configured role choices come
 * from the same transaction.
 */
export async function listWorkspacePeople(
  p: Principal,
  query: WorkspacePeopleQuery,
): Promise<WorkspacePeople> {
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
      const [after, afterKey] = query.cursor ?? [null, null];
      const { rows } = await tx.execute<{
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
      );
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
          lastSignInAt:
            row.lastSignInAt === null
              ? null
              : new Date(row.lastSignInAt).toISOString(),
          twoStep: row.twoStep,
        })),
        roles,
        pagination: {
          pageSize: PAGE_SIZE,
          hasMore,
          nextCursor:
            hasMore && last
              ? Buffer.from(
                  JSON.stringify([last.sortKey, last.rowKey]),
                ).toString("base64url")
              : null,
        },
      };
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
