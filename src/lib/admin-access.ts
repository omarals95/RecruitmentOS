import { redirect } from "next/navigation";
import type { TeamDetailTab } from "@/components/settings/team-detail-tabs";
import { meAccess, type MeAccess } from "./authz";
import { withTeam } from "./db-team";
import { roleScopes, type Role } from "./permissions";
import type { Principal } from "./principal";
import { getTeamWorkspaceContext, getWorkspaceContext } from "./workspace";

/** One withTeam for the session user in one of their teams, answering as GET /api/v1/me/access. */
async function sessionAccess(
  userId: string,
  teamId: string,
  role: Role,
): Promise<MeAccess> {
  const p: Principal = {
    userId,
    teamId,
    role,
    scopes: roleScopes(role),
    authType: "session",
  };
  const access = await withTeam(p, async (_tx, state) => state);
  return meAccess(p, access);
}

/**
 * The server check every admin page awaits before rendering: the signed-in session from cookies
 * (never a Bearer token, so a token-only request is anonymous and goes to /sign-in), its active
 * team, and the same access state GET /api/v1/me/access returns, through authorize(). Null
 * without a team.
 */
export async function adminPageAccess(): Promise<MeAccess | null> {
  const { user, team, role } = await getWorkspaceContext();
  if (!team || !role) return null;
  return sessionAccess(user.id, team.id, role);
}

export type TeamPageAccess =
  | { state: "allowed"; team: { id: string; name: string }; access: MeAccess }
  | { state: "not-a-member" }
  | { state: "refused" };

/**
 * The team detail page's server check (architecture §14.2): it opens only through the team role,
 * for an owner or admin of that team, checked as the session user in that team. A company owner or
 * admin who is not a member gets only the not-a-member state, since company authority never opens
 * team data (TST-005); that is read from the active team, as adminPageAccess does. Everyone else
 * is refused, and an unknown id is treated as a team the caller is not in.
 */
export async function teamPageAccess(teamId: string): Promise<TeamPageAccess> {
  const { user, team, role, member } = await getTeamWorkspaceContext(teamId);
  if (member) {
    const access = await sessionAccess(user.id, member.team.id, member.role);
    return access.teamRole === "owner" || access.teamRole === "admin"
      ? { state: "allowed", team: member.team, access }
      : { state: "refused" };
  }
  const access =
    team && role ? await sessionAccess(user.id, team.id, role) : null;
  return access?.companyLevel === "owner" || access?.companyLevel === "admin"
    ? { state: "not-a-member" }
    : { state: "refused" };
}

/**
 * The old team pages (IMP-001): an owner or admin of the current team goes to that tab of its
 * detail page, through the same teamPageAccess check. Anyone else returns here, and the old page
 * renders what it gave them before; without a session readWorkspace() sends them to /sign-in.
 */
export async function redirectToTeamTab(tab: TeamDetailTab): Promise<void> {
  const { team } = await getWorkspaceContext();
  if (team && (await teamPageAccess(team.id)).state === "allowed")
    redirect(`/app/admin/teams/${encodeURIComponent(team.id)}?tab=${tab}`);
}
