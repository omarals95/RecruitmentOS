import { meAccess, type MeAccess } from "./authz";
import { withTeam } from "./db-team";
import { roleScopes } from "./permissions";
import type { Principal } from "./principal";
import { getWorkspaceContext } from "./workspace";

/**
 * The server check every admin page awaits before rendering: the signed-in session from cookies
 * (never a Bearer token, so a token-only request is anonymous and goes to /sign-in), its active
 * team, and the same access state GET /api/v1/me/access returns, through authorize(). Null
 * without a team.
 */
export async function adminPageAccess(): Promise<MeAccess | null> {
  const { user, team, role } = await getWorkspaceContext();
  if (!team || !role) return null;
  const p: Principal = {
    userId: user.id,
    teamId: team.id,
    role,
    scopes: roleScopes(role),
    authType: "session",
  };
  const access = await withTeam(p, async (_tx, state) => state);
  return meAccess(p, access);
}
