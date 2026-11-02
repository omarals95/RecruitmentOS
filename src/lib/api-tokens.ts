import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, type TeamTx } from "@/db";
import { apiTokens, apiRateLimits, member, user } from "@/db/auth-schema";
import { activity } from "@/db/schema";
import { withTeam } from "./db-team";
import { ApiError } from "./errors";
import { parseRole, type Role, type Scope } from "./permissions";
import type { Principal } from "./principal";
import {
  createTokenMaterial,
  effectiveTokenScopes,
  hashToken,
  tokenInputSchema,
  type TokenInput,
} from "./api-token-policy";

type TokenRow = typeof apiTokens.$inferSelect;
export interface TokenDto {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}
function dto(row: TokenRow): TokenDto {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
function human(p: Principal) {
  if (p.authType !== "session")
    throw new ApiError(
      403,
      "human_session_required",
      "Sign in to manage API tokens.",
    );
}
async function liveHuman(tx: TeamTx, p: Principal): Promise<Role> {
  human(p);
  // Lock this user's row while creating a token, making the active-token cap atomic.
  const [current] = await tx
    .select({ verified: user.emailVerified, role: member.role })
    .from(user)
    .innerJoin(
      member,
      and(eq(member.userId, user.id), eq(member.organizationId, p.teamId)),
    )
    .where(eq(user.id, p.userId))
    .for("update");
  if (!current?.verified)
    throw new ApiError(
      403,
      "membership_required",
      "A verified account and current team membership are required.",
    );
  return parseRole(current.role);
}

export async function authenticateApiToken(raw: string): Promise<Principal> {
  if (!/^ros_live_[A-Za-z0-9_-]{43}$/.test(raw))
    throw new ApiError(
      401,
      "invalid_token",
      "The API token is invalid or no longer active.",
    );
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const [found] = await tx
      .select({
        token: apiTokens,
        verified: user.emailVerified,
        role: member.role,
      })
      .from(apiTokens)
      .innerJoin(user, eq(apiTokens.userId, user.id))
      .innerJoin(
        member,
        and(
          eq(member.userId, apiTokens.userId),
          eq(member.organizationId, apiTokens.teamId),
        ),
      )
      .where(
        and(
          eq(apiTokens.tokenHash, hashToken(raw)),
          isNull(apiTokens.revokedAt),
          gt(apiTokens.expiresAt, sql`current_timestamp`),
        ),
      );
    if (
      !found?.verified ||
      !["owner", "admin", "recruiter", "viewer"].includes(found.role)
    )
      return null;
    const [limit] = await tx
      .insert(apiRateLimits)
      .values({
        key: `api-token:${found.token.id}`,
        windowStart: sql`current_timestamp`,
        count: 1,
      })
      .onConflictDoUpdate({
        target: apiRateLimits.key,
        set: {
          count: sql`CASE WHEN ${apiRateLimits.windowStart} <= current_timestamp - interval '1 minute' THEN 1 ELSE LEAST(${apiRateLimits.count} + 1, 1000000) END`,
          windowStart: sql`CASE WHEN ${apiRateLimits.windowStart} <= current_timestamp - interval '1 minute' THEN current_timestamp ELSE ${apiRateLimits.windowStart} END`,
        },
      })
      .returning({ count: apiRateLimits.count });
    if (!limit || limit.count > 60) return { limited: true as const };
    await tx
      .update(apiTokens)
      .set({ lastUsedAt: sql`current_timestamp` })
      .where(eq(apiTokens.id, found.token.id));
    const principal: Principal = {
      userId: found.token.userId,
      teamId: found.token.teamId,
      role: found.role as Role,
      scopes: effectiveTokenScopes(found.token.scopes, found.role),
      authType: "token",
      tokenId: found.token.id,
    };
    return { principal };
  });
  if (!result)
    throw new ApiError(
      401,
      "invalid_token",
      "The API token is invalid or no longer active.",
    );
  // Throw after commit so rejected rate-limit attempts cannot roll back their counter.
  if ("limited" in result)
    throw new ApiError(
      429,
      "token_rate_limited",
      "This API token is limited to 60 requests per minute.",
    );
  return result.principal;
}

export async function createToken(
  p: Principal,
  input: TokenInput,
): Promise<{ token: string; data: TokenDto }> {
  human(p);
  const parsed = tokenInputSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      400,
      "invalid_token_request",
      "Provide a token name, valid scopes and an expiry between 1 and 365 days.",
    );
  return withTeam(p, async (tx) => {
    const role = await liveHuman(tx, p);
    const scopes = effectiveTokenScopes(parsed.data.scopes, role);
    if (scopes.length !== parsed.data.scopes.length)
      throw new ApiError(
        403,
        "scope_not_allowed",
        "One or more token scopes are not available to your current team role.",
      );
    const [existing] = await tx
      .select({ total: count() })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.teamId, p.teamId),
          eq(apiTokens.userId, p.userId),
          isNull(apiTokens.revokedAt),
          gt(apiTokens.expiresAt, sql`current_timestamp`),
        ),
      );
    if ((existing?.total ?? 0) >= 50)
      throw new ApiError(
        409,
        "token_limit",
        "Revoke an unused token before creating another. You can have 50 active tokens per team.",
      );
    const material = createTokenMaterial();
    const id = randomUUID();
    const [saved] = await tx
      .insert(apiTokens)
      .values({
        id,
        teamId: p.teamId,
        userId: p.userId,
        name: parsed.data.name,
        tokenHash: material.tokenHash,
        prefix: material.prefix,
        scopes,
        expiresAt: sql`current_timestamp + (${parsed.data.expiresInDays} * interval '1 day')`,
      })
      .returning();
    await tx.insert(activity).values({
      teamId: p.teamId,
      actorId: p.userId,
      actorType: "session",
      action: "token.created",
      kind: "api-token",
      summary: "Created an API token",
      metadata: { tokenId: id, prefix: material.prefix, scopes },
    });
    return { token: material.token, data: dto(saved) };
  });
}

export async function listTokens(
  p: Principal,
  all = false,
): Promise<TokenDto[]> {
  human(p);
  return withTeam(p, async (tx) => {
    const role = await liveHuman(tx, p);
    if (all && role !== "owner" && role !== "admin")
      throw new ApiError(
        403,
        "team_admin_required",
        "Only owners and admins can view all team tokens.",
      );
    const rows = await tx
      .select()
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.teamId, p.teamId),
          all ? undefined : eq(apiTokens.userId, p.userId),
        ),
      )
      .orderBy(desc(apiTokens.createdAt))
      .limit(1000);
    return rows.map(dto);
  });
}

export async function revokeToken(p: Principal, id: string): Promise<void> {
  human(p);
  if (!/^[0-9a-f-]{36}$/i.test(id))
    throw new ApiError(404, "token_not_found", "The API token was not found.");
  await withTeam(p, async (tx) => {
    const role = await liveHuman(tx, p);
    const canManageTeam = role === "owner" || role === "admin";
    const [found] = await tx
      .select()
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.teamId, p.teamId),
          eq(apiTokens.id, id),
          canManageTeam ? undefined : eq(apiTokens.userId, p.userId),
        ),
      )
      .for("update");
    if (!found)
      throw new ApiError(
        404,
        "token_not_found",
        "The API token was not found.",
      );
    if (found.revokedAt) return;
    await tx
      .update(apiTokens)
      .set({ revokedAt: sql`current_timestamp` })
      .where(and(eq(apiTokens.teamId, p.teamId), eq(apiTokens.id, id)));
    await tx.insert(activity).values({
      teamId: p.teamId,
      actorId: p.userId,
      actorType: "session",
      action: "token.revoked",
      kind: "api-token",
      summary: "Revoked an API token",
      metadata: { tokenId: id, prefix: found.prefix },
    });
  });
}

export type { Scope };
