import { DrizzleQueryError, eq, sql } from "drizzle-orm";
import { getIdentityDb } from "@/db";
import { member, organization } from "@/db/auth-schema";
import { withTeam } from "./db-team";
import { ApiError } from "./errors";
import { parseRole, type Role } from "./permissions";
import type { Principal } from "./principal";

/** One row of the Admin portal's Teams list; teamId only where the caller is a member. */
export type AdminTeamRow = {
  teamId: string | null;
  name: string;
  slug: string;
  createdAt: string;
  teamRole: Role | null;
  current: boolean;
  archived: boolean;
};

const teamsForbidden = () =>
  new ApiError(
    403,
    "teams_forbidden",
    "Only an owner or admin of this team, or a company owner or admin, can see the teams list.",
  );
const manages = (role: Role | null) => role === "owner" || role === "admin";

/**
 * Signed-in team owners and admins of the active team: their own owner and admin teams. Company
 * owners and admins also get every team of the workspace by name, slug, created date and archived
 * state only, through the owner-run helper, never its members, counts, records, storage or activity
 * (TST-005). The caller's own teams take their archived state from the member read helper.
 */
export async function listAdminTeams(p: Principal): Promise<AdminTeamRow[]> {
  let workspace: {
    id: string;
    name: string;
    slug: string;
    createdAt: Date;
    archived: boolean;
  }[];
  let archivedTeams: Set<string>;
  try {
    ({ workspace, archivedTeams } = await withTeam(p, async (tx, access) => {
      const company = access.companyLevel !== null;
      if (p.authType !== "session" || (!manages(p.role) && !company))
        throw teamsForbidden();
      if (company)
        return {
          workspace: (
            await tx.execute<{
              id: string;
              name: string;
              slug: string;
              createdAt: Date;
              archived: boolean;
            }>(
              sql`select id, name, slug, created_at as "createdAt", archived from tenant_context.workspace_team_list()`,
            )
          ).rows,
          archivedTeams: new Set<string>(),
        };
      return {
        workspace: [],
        archivedTeams: new Set(
          (
            await tx.execute<{ team_id: string }>(
              sql`select team_id from tenant_context.member_archived_teams()`,
            )
          ).rows.map((row) => row.team_id),
        ),
      };
    }));
  } catch (error) {
    const code = (
      (error instanceof DrizzleQueryError ? error.cause : error) as
        { code?: unknown } | undefined
    )?.code;
    if (code === "42501") throw teamsForbidden();
    throw error;
  }
  const db = await getIdentityDb();
  const memberships = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdAt: organization.createdAt,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, p.userId));
  const roles = new Map(
    memberships.map((row) => [row.id, parseRole(row.role)]),
  );
  const teams = new Map(workspace.map((row) => [row.id, row]));
  for (const row of memberships)
    if (manages(roles.get(row.id) ?? null) && !teams.has(row.id))
      teams.set(row.id, { ...row, archived: archivedTeams.has(row.id) });
  return [...teams.values()]
    .map((row) => {
      const teamRole = roles.get(row.id) ?? null;
      return {
        teamId: teamRole ? row.id : null,
        name: row.name,
        slug: row.slug,
        createdAt: new Date(row.createdAt).toISOString(),
        teamRole,
        current: row.id === p.teamId,
        archived: row.archived,
      };
    })
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "en") ||
        a.slug.localeCompare(b.slug, "en"),
    );
}
