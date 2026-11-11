import { eq } from "drizzle-orm";
import { getIdentityDb } from "@/db";
import { member } from "@/db/auth-schema";
import { TWO_STEP_SETUP_MESSAGE, twoStepSetupRequired } from "./auth-policy";
import { getVerifiedSession } from "./auth-session";
import {
  authenticateApiToken,
  authenticateOAuthAccessToken,
} from "./api-tokens";
import { clientIp } from "./client-ip";
import { companyAuthorityHeld } from "./two-step";
import { ApiError } from "./errors";
import {
  parseRole,
  roleScopes,
  requireScope,
  type Role,
  type Scope,
} from "./permissions";
export interface Principal {
  userId: string;
  teamId: string;
  role: Role;
  scopes: Scope[];
  authType: "session" | "token";
  tokenId?: string;
  /** Set for OAuth grants; tokenId is then the grant's auth.api_tokens id. */
  oauthClientId?: string;
  /** Browser sessions only: when the session was created, for requireFreshSession. */
  sessionCreatedAt?: Date;
}
export async function requirePrincipal(
  request: Request,
  scope?: Scope,
  humanOnly = false,
): Promise<Principal> {
  const authorization = request.headers.get("authorization");
  let p: Principal;
  if (authorization !== null) {
    if (humanOnly)
      throw new ApiError(
        403,
        "session_required",
        "Sign in to manage accounts, teams and API tokens.",
      );
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match)
      throw new ApiError(
        401,
        "invalid_token",
        "A valid Bearer token is required.",
      );
    p = await authenticateApiToken(match[1], clientIp(request.headers));
    const selected = request.headers.get("x-team-id");
    if (selected && selected !== p.teamId)
      throw new ApiError(
        403,
        "token_team_mismatch",
        "This token belongs to a different team.",
      );
  } else {
    const identity = await getVerifiedSession(request.headers);
    const db = await getIdentityDb();
    // Every membership in one query: the roles the two-step gate needs, and the selected team's.
    const memberships = await db
      .select({ organizationId: member.organizationId, role: member.role })
      .from(member)
      .where(eq(member.userId, identity.user.id));
    if (
      twoStepSetupRequired(
        identity.user.twoFactorEnabled,
        memberships.map((row) => row.role),
        await companyAuthorityHeld(
          db,
          identity.user,
          memberships.map((row) => ({
            teamId: row.organizationId,
            role: row.role,
          })),
        ),
      )
    )
      throw new ApiError(
        403,
        "two_step_setup_required",
        TWO_STEP_SETUP_MESSAGE,
      );
    const teamId =
      request.headers.get("x-team-id") || identity.session.activeOrganizationId;
    if (!teamId)
      throw new ApiError(
        409,
        "team_required",
        "Create or select a team first.",
      );
    const membership = memberships.find((row) => row.organizationId === teamId);
    if (!membership)
      throw new ApiError(
        403,
        "team_access_denied",
        "You are not a member of this team.",
      );
    const role = parseRole(membership.role);
    p = {
      userId: identity.user.id,
      teamId,
      role,
      scopes: roleScopes(role),
      authType: "session",
      sessionCreatedAt: new Date(identity.session.createdAt),
    };
  }
  if (scope) requireScope(p, scope);
  return p;
}

/**
 * Token-only resolver for /api/mcp: cookies are never read. ros_oat_ tokens are OAuth access
 * tokens bound to this endpoint; any other Bearer value is checked as an API token.
 */
export async function requireMcpPrincipal(
  request: Request,
  audience: string,
): Promise<Principal> {
  const authorization = request.headers.get("authorization");
  if (authorization === null)
    throw new ApiError(
      401,
      "authentication_required",
      "Send an API token or OAuth access token as a Bearer token.",
    );
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match)
    throw new ApiError(
      401,
      "invalid_token",
      "A valid Bearer token is required.",
    );
  const ip = clientIp(request.headers);
  const p = match[1].startsWith("ros_oat_")
    ? await authenticateOAuthAccessToken(match[1], ip, audience)
    : await authenticateApiToken(match[1], ip);
  const selected = request.headers.get("x-team-id");
  if (selected && selected !== p.teamId)
    throw new ApiError(
      403,
      "token_team_mismatch",
      "This token belongs to a different team.",
    );
  return p;
}
