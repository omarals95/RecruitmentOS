import { randomBytes, randomUUID } from "node:crypto";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  gt,
  isNull,
  sql,
} from "drizzle-orm";
import { getIdentityDb, type TeamTx } from "@/db";
import { withDeadlines } from "@/db/deadlines";
import {
  apiTokens,
  apiRateLimits,
  member,
  oauthClients,
  oauthCodes,
  oauthTokens,
  user,
} from "@/db/auth-schema";
import { getAuthOptions } from "./auth";
import { purgeExpiredAuthRowsThrottled } from "./auth-purge";
import { rateLimitClientKey } from "./client-ip";
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
import { assertTenantContextKey, installTenantContext } from "./tenant-context";

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
  oauthClient: { id: string; name: string } | null;
}
function dto(row: TokenRow, clientName: string | null = null): TokenDto {
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
    oauthClient: row.oauthClientId
      ? { id: row.oauthClientId, name: clientName ?? "" }
      : null,
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

/**
 * One-minute window counter in auth.api_rate_limits. The upsert locks the key's row until
 * commit, so concurrent callers cannot pass a budget. add = 0 only reads (and resets) the window.
 */
export async function rateWindow(
  tx: TeamTx,
  key: string,
  add: 0 | 1,
): Promise<number> {
  const [row] = await tx
    .insert(apiRateLimits)
    .values({ key, windowStart: sql`current_timestamp`, count: add })
    .onConflictDoUpdate({
      target: apiRateLimits.key,
      set: {
        count: sql`CASE WHEN ${apiRateLimits.windowStart} <= current_timestamp - interval '1 minute' THEN ${add}::int ELSE LEAST(${apiRateLimits.count} + ${add}::int, 1000000) END`,
        windowStart: sql`CASE WHEN ${apiRateLimits.windowStart} <= current_timestamp - interval '1 minute' THEN current_timestamp ELSE ${apiRateLimits.windowStart} END`,
      },
    })
    .returning({ count: apiRateLimits.count });
  return row?.count ?? Number.MAX_SAFE_INTEGER;
}
/** Charges one failed attempt to a window read earlier in the same transaction. */
export async function chargeRateWindow(tx: TeamTx, key: string) {
  await tx
    .update(apiRateLimits)
    .set({ count: sql`LEAST(${apiRateLimits.count} + 1, 1000000)` })
    .where(eq(apiRateLimits.key, key));
}

/** Unknown-hash guesses allowed per client key and minute before every token from it is refused. */
const GUESS_LIMIT = 10;
const GUESS_WINDOW_MS = 60_000;
const PRECHECK_MAX_ENTRIES = 10_000;
/**
 * Per-instance copy of the database guess budget, keyed by hashed client key, so a client already
 * over budget is refused before any identity-database access. The database stays authoritative.
 */
const guessPrecheck = new Map<string, { start: number; count: number }>();
function noteGuesses(client: string, count: number) {
  const now = Date.now();
  const entry = guessPrecheck.get(client);
  if (entry && now - entry.start < GUESS_WINDOW_MS) {
    entry.count = count;
    return;
  }
  guessPrecheck.delete(client);
  if (guessPrecheck.size >= PRECHECK_MAX_ENTRIES) {
    for (const [key, value] of guessPrecheck)
      if (now - value.start >= GUESS_WINDOW_MS) guessPrecheck.delete(key);
    // Then the oldest: a Map iterates in insertion order.
    for (const key of guessPrecheck.keys()) {
      if (guessPrecheck.size < PRECHECK_MAX_ENTRIES) break;
      guessPrecheck.delete(key);
    }
  }
  guessPrecheck.set(client, { start: now, count });
}
/** Test seam: forget every client's in-process guess count. */
export function resetGuessPrecheck() {
  guessPrecheck.clear();
}

type Authenticated =
  | { guessLimited: true; guesses: number }
  | { guess: true; guesses: number }
  | { limited: true }
  | { principal: Principal }
  | null;
const MEMBER_ROLES = ["owner", "admin", "recruiter", "viewer"];
/** Shared by both Bearer authenticators once a live token row and role are found. */
async function admit(
  tx: TeamTx,
  token: TokenRow,
  role: string,
): Promise<Authenticated> {
  if ((await rateWindow(tx, `api-token:${token.id}`, 1)) > 60)
    return { limited: true };
  await tx
    .update(apiTokens)
    .set({ lastUsedAt: sql`current_timestamp` })
    .where(eq(apiTokens.id, token.id));
  return {
    principal: {
      userId: token.userId,
      teamId: token.teamId,
      role: role as Role,
      scopes: effectiveTokenScopes(token.scopes, role),
      authType: "token",
      tokenId: token.id,
      ...(token.oauthClientId ? { oauthClientId: token.oauthClientId } : {}),
    },
  };
}
const guessLimitedError = () =>
  new ApiError(
    429,
    "token_guess_rate_limited",
    "Too many invalid API token attempts. Try again in a minute.",
  );
// Throw after commit so rejected rate-limit attempts cannot roll back their counter.
function settle(result: Authenticated): Principal {
  if (!result || "guess" in result)
    throw new ApiError(
      401,
      "invalid_token",
      "The API token is invalid or no longer active.",
    );
  if ("guessLimited" in result) throw guessLimitedError();
  if ("limited" in result)
    throw new ApiError(
      429,
      "token_rate_limited",
      "This API token is limited to 60 requests per minute.",
    );
  return result.principal;
}
function requireReadiness(raw: string, format: RegExp) {
  // Tokens never work where sign-in is unavailable.
  if (!getAuthOptions().configured)
    throw new ApiError(
      503,
      "AUTH_NOT_CONFIGURED",
      "Authentication setup is required.",
    );
  if (!format.test(raw))
    throw new ApiError(
      401,
      "invalid_token",
      "The API token is invalid or no longer active.",
    );
}
/** After readiness and format, before any identity-database access. Returns the hashed client key. */
function precheckGuesses(clientIp: string | null): string {
  const client = rateLimitClientKey(clientIp, process.env.BETTER_AUTH_SECRET!);
  const entry = guessPrecheck.get(client);
  if (
    entry &&
    Date.now() - entry.start < GUESS_WINDOW_MS &&
    entry.count >= GUESS_LIMIT
  )
    throw guessLimitedError();
  return client;
}
/**
 * The database guess budget around one token lookup. Over budget, every token from the client is
 * refused, valid or not: admitting a valid one would tell a guesser which value is real. Only a
 * hash with no row at all is a guess (`charge`), so stale credentials (revoked, expired, expired
 * MCP access tokens) cannot lock everyone out behind a shared egress address.
 */
async function withGuessBudget(
  client: string,
  lookup: (
    tx: TeamTx,
    charge: () => Promise<Authenticated>,
  ) => Promise<Authenticated>,
): Promise<Principal> {
  const guessKey = `api-guess:${client}`;
  const db = await getIdentityDb();
  const result = await withDeadlines(db, async (tx): Promise<Authenticated> => {
    const guesses = await rateWindow(tx, guessKey, 0);
    if (guesses >= GUESS_LIMIT) return { guessLimited: true, guesses };
    return lookup(tx, async () => {
      await chargeRateWindow(tx, guessKey);
      return { guess: true, guesses: guesses + 1 };
    });
  });
  if (result && "guesses" in result) noteGuesses(client, result.guesses);
  await purgeExpiredAuthRowsThrottled(db);
  return settle(result);
}

export async function authenticateApiToken(
  raw: string,
  clientIp: string | null,
): Promise<Principal> {
  requireReadiness(raw, /^ros_live_[A-Za-z0-9_-]{43}$/);
  const client = precheckGuesses(clientIp);
  return withGuessBudget(client, async (tx, charge) => {
    const [found] = await tx
      .select({
        token: apiTokens,
        // An OAuth grant authenticates only through its access tokens.
        active: sql<boolean>`${apiTokens.revokedAt} is null and ${apiTokens.expiresAt} > current_timestamp and ${apiTokens.oauthClientId} is null`,
        verified: user.emailVerified,
        role: member.role,
      })
      .from(apiTokens)
      .leftJoin(user, eq(apiTokens.userId, user.id))
      .leftJoin(
        member,
        and(
          eq(member.userId, apiTokens.userId),
          eq(member.organizationId, apiTokens.teamId),
        ),
      )
      .where(eq(apiTokens.tokenHash, hashToken(raw)));
    if (!found) return charge();
    if (
      !found.active ||
      !found.verified ||
      !found.role ||
      !MEMBER_ROLES.includes(found.role)
    )
      return null;
    return admit(tx, found.token, found.role);
  });
}

/**
 * OAuth access tokens, accepted only by /api/mcp. The same readiness gate, guess budget,
 * per-grant limit and role intersection as API tokens; the grant row is what the tenant context checks.
 */
export async function authenticateOAuthAccessToken(
  raw: string,
  clientIp: string | null,
  audience: string,
): Promise<Principal> {
  requireReadiness(raw, /^ros_oat_[A-Za-z0-9_-]{43}$/);
  const client = precheckGuesses(clientIp);
  return withGuessBudget(client, async (tx, charge) => {
    const [found] = await tx
      .select({
        token: getTableColumns(apiTokens),
        active: sql<boolean>`${oauthTokens.kind} = 'access' and ${oauthTokens.expiresAt} > current_timestamp and ${oauthTokens.audience} = ${audience} and ${apiTokens.revokedAt} is null and ${apiTokens.expiresAt} > current_timestamp and ${apiTokens.oauthClientId} is not null`,
        verified: user.emailVerified,
        role: member.role,
      })
      .from(oauthTokens)
      .innerJoin(apiTokens, eq(apiTokens.id, oauthTokens.grantId))
      .leftJoin(user, eq(apiTokens.userId, user.id))
      .leftJoin(
        member,
        and(
          eq(member.userId, apiTokens.userId),
          eq(member.organizationId, apiTokens.teamId),
        ),
      )
      .where(eq(oauthTokens.tokenHash, hashToken(raw)));
    if (!found) return charge();
    if (
      !found.active ||
      !found.verified ||
      !found.role ||
      !MEMBER_ROLES.includes(found.role)
    )
      return null;
    return admit(tx, found.token, found.role);
  });
}

async function assertTokenCap(tx: TeamTx, p: Principal) {
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
  assertTenantContextKey();
  const db = await getIdentityDb();
  return withDeadlines(db, async (tx) => {
    const role = await liveHuman(tx, p);
    // Lock the user row first; the context lets the audit helper pass activity RLS.
    await installTenantContext(tx, p);
    const scopes = effectiveTokenScopes(parsed.data.scopes, role);
    if (scopes.length !== parsed.data.scopes.length)
      throw new ApiError(
        403,
        "scope_not_allowed",
        "One or more token scopes are not available to your current team role.",
      );
    await assertTokenCap(tx, p);
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
    await tx.execute(
      sql`select tenant_context.audit_token(${id}, ${"token.created"})`,
    );
    return { token: material.token, data: dto(saved) };
  });
}

/**
 * Records an approved OAuth consent: a grant row that expires after 120 seconds unless its
 * authorization code is redeemed, plus that code. Only hashes are stored; the code is returned once.
 */
export async function createOAuthGrant(
  p: Principal,
  input: {
    clientId: string;
    clientName: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: Scope[];
  },
): Promise<{ code: string }> {
  human(p);
  assertTenantContextKey();
  const db = await getIdentityDb();
  return withDeadlines(db, async (tx) => {
    const role = await liveHuman(tx, p);
    await installTenantContext(tx, p);
    const scopes = effectiveTokenScopes(input.scopes, role);
    if (!scopes.length || scopes.length !== new Set(input.scopes).size)
      throw new ApiError(
        403,
        "scope_not_allowed",
        "One or more permissions are not available to your current team role.",
      );
    await assertTokenCap(tx, p);
    const id = randomUUID();
    await tx.insert(apiTokens).values({
      id,
      teamId: p.teamId,
      userId: p.userId,
      name: input.clientName,
      // The grant's own secret is never issued; the client uses OAuth access tokens.
      tokenHash: hashToken(randomBytes(32).toString("base64url")),
      prefix: `ros_oauth_${randomBytes(6).toString("base64url")}`,
      scopes,
      oauthClientId: input.clientId,
      expiresAt: sql`current_timestamp + interval '120 seconds'`,
    });
    await tx.execute(
      sql`select tenant_context.audit_token(${id}, ${"token.created"})`,
    );
    const code = randomBytes(32).toString("base64url");
    await tx.insert(oauthCodes).values({
      codeHash: hashToken(code),
      grantId: id,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      expiresAt: sql`current_timestamp + interval '120 seconds'`,
    });
    return { code };
  });
}

export async function listTokens(
  p: Principal,
  all = false,
): Promise<TokenDto[]> {
  human(p);
  const db = await getIdentityDb();
  return withDeadlines(db, async (tx) => {
    const role = await liveHuman(tx, p);
    if (all && role !== "owner" && role !== "admin")
      throw new ApiError(
        403,
        "team_admin_required",
        "Only owners and admins can view all team tokens.",
      );
    const rows = await tx
      .select({
        token: getTableColumns(apiTokens),
        clientName: oauthClients.name,
      })
      .from(apiTokens)
      .leftJoin(oauthClients, eq(oauthClients.id, apiTokens.oauthClientId))
      .where(
        and(
          eq(apiTokens.teamId, p.teamId),
          all ? undefined : eq(apiTokens.userId, p.userId),
        ),
      )
      .orderBy(desc(apiTokens.createdAt))
      .limit(1000);
    return rows.map((row) => dto(row.token, row.clientName));
  });
}

export async function revokeToken(p: Principal, id: string): Promise<void> {
  human(p);
  if (!/^[0-9a-f-]{36}$/i.test(id))
    throw new ApiError(404, "token_not_found", "The API token was not found.");
  assertTenantContextKey();
  const db = await getIdentityDb();
  await withDeadlines(db, async (tx) => {
    const role = await liveHuman(tx, p);
    await installTenantContext(tx, p);
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
    await tx.execute(
      sql`select tenant_context.audit_token(${id}, ${"token.revoked"})`,
    );
  });
}

export type { Scope };
