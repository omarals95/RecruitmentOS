import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { member } from "@/db/auth-schema";
import { getVerifiedSession } from "./auth-session";
import { authenticateApiToken } from "./api-tokens";
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
    p = await authenticateApiToken(match[1]);
    const selected = request.headers.get("x-team-id");
    if (selected && selected !== p.teamId)
      throw new ApiError(
        403,
        "token_team_mismatch",
        "This token belongs to a different team.",
      );
  } else {
    const identity = await getVerifiedSession(request.headers);
    const teamId =
      request.headers.get("x-team-id") || identity.session.activeOrganizationId;
    if (!teamId)
      throw new ApiError(
        409,
        "team_required",
        "Create or select a team first.",
      );
    const db = await getDb();
    const [membership] = await db
      .select()
      .from(member)
      .where(
        and(
          eq(member.organizationId, teamId),
          eq(member.userId, identity.user.id),
        ),
      )
      .limit(1);
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
    };
  }
  if (scope) requireScope(p, scope);
  return p;
}
