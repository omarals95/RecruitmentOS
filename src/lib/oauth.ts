import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, isNull, notExists, sql } from "drizzle-orm";
import { getIdentityDb, type TeamTx } from "@/db";
import { withDeadlines } from "@/db/deadlines";
import {
  apiTokens,
  member,
  oauthClients,
  oauthCodes,
  oauthTokens,
  organization,
  user,
} from "@/db/auth-schema";
import { getAuthOptions } from "./auth";
import { ApiError, errorJson, readLimitedBytes } from "./api";
import { chargeRateWindow, createOAuthGrant, rateWindow } from "./api-tokens";
import { hashToken } from "./api-token-policy";
import { purgeExpiredAuthRowsThrottled } from "./auth-purge";
import { clientIp, rateLimitClientKey } from "./client-ip";
import { cleanClientName } from "./client-name";
import {
  MCP_SCOPES,
  parseRole,
  roleScopes,
  type McpScope,
  type Role,
} from "./permissions";
import type { Principal } from "./principal";

// Every URL is derived from BETTER_AUTH_URL, never from Host or forwarding headers.
export function appOrigin(): string {
  return new URL(process.env.BETTER_AUTH_URL ?? "").origin;
}
/** The RFC 8414 issuer, the same string in both metadata documents and every `iss` (RFC 9207). */
export function issuer(): string {
  return appOrigin();
}
export function mcpResource(): string {
  return `${appOrigin()}/api/mcp`;
}
export function resourceMetadataUrl(): string {
  return `${appOrigin()}/.well-known/oauth-protected-resource/api/mcp`;
}
/** The OAuth and MCP endpoints follow the same readiness as sign-in. */
export function notReady(): Response | null {
  return getAuthOptions().configured
    ? null
    : errorJson(
        503,
        "AUTH_NOT_CONFIGURED",
        "Authentication setup is required.",
      );
}
function noStore(body: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}
/** RFC 6749 / RFC 7591 error body. */
function oauthError(status: number, error: string, description: string) {
  return noStore(
    { error, error_description: description },
    status,
    status === 429 ? { "Retry-After": "60" } : {},
  );
}

const CLIENT_ID = /^ros_client_[A-Za-z0-9_-]{22}$/;
/** Registered clients without any grant; registration is refused while this many exist. */
const UNCONSENTED_CLIENT_CAP = 1000;
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;
const GRANT_TYPES = ["authorization_code", "refresh_token"];

/** RFC 9728 protected resource metadata for /api/mcp. */
export function protectedResourceMetadata(): Response {
  const unavailable = notReady();
  if (unavailable) return unavailable;
  return noStore({
    resource: mcpResource(),
    authorization_servers: [issuer()],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "RecruitmentOS",
  });
}
/** RFC 8414 authorization server metadata. */
export function authorizationServerMetadata(): Response {
  const unavailable = notReady();
  if (unavailable) return unavailable;
  const origin = appOrigin();
  return noStore({
    issuer: issuer(),
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: GRANT_TYPES,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...MCP_SCOPES],
    authorization_response_iss_parameter_supported: true,
  });
}

const CLIENT_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
];
/**
 * Claude's two callbacks and ChatGPT's stable callback by exact string, or http loopback for
 * local testing.
 */
function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (CLIENT_REDIRECT_URIS.includes(value)) return true;
  if (value.length > 2000 || value.includes("#")) return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      url.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
/** The hashed client address used in rate-limit keys; no raw address is stored. */
function clientKey(request: Request): string {
  return rateLimitClientKey(
    clientIp(request.headers),
    process.env.BETTER_AUTH_SECRET!,
  );
}
function subsetOf(value: unknown, allowed: string[]): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((item) => typeof item !== "string" || !allowed.includes(item))
  )
    return null;
  return [...new Set(value as string[])];
}
async function readText(request: Request, maxBytes: number) {
  try {
    const bytes = await readLimitedBytes(request, maxBytes);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes ?? new Uint8Array(),
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 413) return 413;
    return null;
  }
}

/**
 * RFC 7591 dynamic registration for public clients. Registration grants nothing: no grant,
 * code or token exists until a signed-in team member approves the consent page.
 */
export async function registerClient(request: Request): Promise<Response> {
  const unavailable = notReady();
  if (unavailable) return unavailable;
  const db = await getIdentityDb();
  // There is no client identity before registration, so this budget stays per address.
  const attempts = await withDeadlines(db, (tx) =>
    rateWindow(tx, `oauth-register:${clientKey(request)}`, 1),
  );
  await purgeExpiredAuthRowsThrottled(db);
  if (attempts > 5)
    return oauthError(
      429,
      "rate_limited",
      "Too many client registrations. Try again in a minute.",
    );
  // Clients nobody approved are purged after a day; this bounds how many can pile up before then.
  const [unconsented] = await withDeadlines(db, (tx) =>
    tx.select({ total: count() }).from(
      tx
        .select({ id: oauthClients.id })
        .from(oauthClients)
        .where(
          notExists(
            tx
              .select({ id: apiTokens.id })
              .from(apiTokens)
              .where(eq(apiTokens.oauthClientId, oauthClients.id)),
          ),
        )
        .limit(UNCONSENTED_CLIENT_CAP)
        .as("unconsented"),
    ),
  );
  if ((unconsented?.total ?? 0) >= UNCONSENTED_CLIENT_CAP)
    return oauthError(
      429,
      "rate_limited",
      "Too many client registrations. Try again later.",
    );
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return oauthError(400, "invalid_client_metadata", "Send application/json.");
  const text = await readText(request, 16384);
  if (text === 413)
    return oauthError(
      413,
      "invalid_client_metadata",
      "The registration request is too large.",
    );
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(text ?? "");
  } catch {
    return oauthError(
      400,
      "invalid_client_metadata",
      "The registration request contains invalid JSON.",
    );
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return oauthError(
      400,
      "invalid_client_metadata",
      "Send client metadata as a JSON object.",
    );
  const redirectUris = metadata.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length < 1 ||
    redirectUris.length > 5 ||
    !redirectUris.every(validRedirectUri)
  )
    return oauthError(
      400,
      "invalid_redirect_uri",
      `Register 1 to 5 redirect URIs, each exactly one of ${CLIENT_REDIRECT_URIS.join(", ")}, or http on 127.0.0.1, [::1] or localhost without fragments or credentials.`,
    );
  const rawName = metadata.client_name ?? "";
  const name = typeof rawName === "string" ? cleanClientName(rawName) : null;
  const grantTypes =
    metadata.grant_types === undefined
      ? GRANT_TYPES
      : subsetOf(metadata.grant_types, GRANT_TYPES);
  const responseTypes =
    metadata.response_types === undefined
      ? ["code"]
      : subsetOf(metadata.response_types, ["code"]);
  if (name === null || name.length > 100 || !grantTypes || !responseTypes)
    return oauthError(
      400,
      "invalid_client_metadata",
      "client_name must be text of at most 100 characters; grant_types may list authorization_code and refresh_token; response_types may list code.",
    );
  const [client] = await db
    .insert(oauthClients)
    .values({
      id: `ros_client_${randomBytes(16).toString("base64url")}`,
      name: name || "Unnamed app",
      redirectUris: [...new Set(redirectUris)],
    })
    .returning();
  return noStore(
    {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: "none",
    },
    201,
  );
}

type AuthorizeParams = Record<string, string | string[] | undefined>;
export interface AuthorizeRequest {
  client: { id: string; name: string };
  redirectUri: string;
  redirectHost: string;
  state: string | null;
  codeChallenge: string;
  scopes: McpScope[];
  /** The retained authorize parameters, posted back unchanged by the consent page. */
  params: Record<string, string>;
}
export type AuthorizeCheck =
  | { kind: "fatal"; error: string; message: string }
  | { kind: "ok"; request: AuthorizeRequest };
const AUTHORIZE_KEYS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;

export function redirectWith(
  redirectUri: string,
  values: Record<string, string | null>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values))
    if (value !== null) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Validates an authorize request. Every problem is reported on the page, never to the client:
 * the browser reaches a redirect URI only through a signed-in member's consent decision.
 */
export async function checkAuthorizeRequest(
  params: AuthorizeParams,
): Promise<AuthorizeCheck> {
  const one = (key: string) => {
    const value = params[key];
    return typeof value === "string" ? value : null;
  };
  const fail = (error: string) =>
    ({
      kind: "fatal",
      error,
      message:
        "This connection request is not valid. Start again from the app that sent you here.",
    }) as const;
  const clientId = one("client_id");
  const redirectUri = one("redirect_uri");
  if (!clientId || !CLIENT_ID.test(clientId)) return fail("invalid_client");
  if (!redirectUri) return fail("invalid_request");
  const db = await getIdentityDb();
  const [client] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.id, clientId))
    .limit(1);
  if (!client) return fail("invalid_client");
  // Exact string match only: no normalisation of case, slashes, ports or paths. Clients
  // registered before the allowlist keep their rows but are refused here.
  if (
    !client.redirectUris.includes(redirectUri) ||
    !validRedirectUri(redirectUri)
  )
    return fail("invalid_request");
  const state = one("state");
  if (AUTHORIZE_KEYS.some((key) => Array.isArray(params[key])))
    return fail("invalid_request");
  if (state !== null && state.length > 1000) return fail("invalid_request");
  if (one("response_type") !== "code") return fail("unsupported_response_type");
  const codeChallenge = one("code_challenge");
  if (!codeChallenge || !PKCE_VALUE.test(codeChallenge))
    return fail("invalid_request");
  if (one("code_challenge_method") !== "S256") return fail("invalid_request");
  const resource = one("resource");
  if (resource !== null && resource !== mcpResource())
    return fail("invalid_target");
  const scope = one("scope")?.split(" ").filter(Boolean) ?? [];
  if (scope.some((item) => !(MCP_SCOPES as readonly string[]).includes(item)))
    return fail("invalid_scope");
  const requested = scope.length
    ? (MCP_SCOPES.filter((item) => scope.includes(item)) as McpScope[])
    : (["candidates:read", "recruitment:read"] as McpScope[]);
  const retained: Record<string, string> = {};
  for (const key of AUTHORIZE_KEYS) {
    const value = one(key);
    if (value !== null) retained[key] = value;
  }
  return {
    kind: "ok",
    request: {
      client: {
        id: client.id,
        name: cleanClientName(client.name) || "Unnamed app",
      },
      redirectUri,
      redirectHost: new URL(redirectUri).host,
      state,
      codeChallenge,
      scopes: requested,
      params: retained,
    },
  };
}

/** The signed-in user's teams with the MCP scopes each current role allows. */
export async function consentTeams(userId: string) {
  const db = await getIdentityDb();
  const rows = await db
    .select({ id: organization.id, name: organization.name, role: member.role })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, userId));
  return rows.map((row) => {
    const role: Role = parseRole(row.role);
    return {
      id: row.id,
      name: row.name,
      allowed: MCP_SCOPES.filter((scope) => roleScopes(role).includes(scope)),
    };
  });
}

/**
 * Applies a consent decision for the session principal's selected team and returns where to
 * send the browser. Every authorize rule is checked again; deny writes nothing. Both redirects
 * carry `iss` (RFC 9207).
 */
export async function decideConsent(
  p: Principal,
  input: {
    params: AuthorizeParams;
    scopes: string[];
    decision: "approve" | "deny";
  },
): Promise<string> {
  const check = await checkAuthorizeRequest(input.params);
  if (check.kind !== "ok")
    throw new ApiError(
      400,
      "invalid_authorization_request",
      "This connection request is no longer valid. Start again from the app that sent you here.",
    );
  const request = check.request;
  if (input.decision === "deny")
    return redirectWith(request.redirectUri, {
      error: "access_denied",
      state: request.state,
      iss: issuer(),
    });
  const granted = [...new Set(input.scopes)];
  if (
    !granted.length ||
    granted.some((scope) => !request.scopes.includes(scope as McpScope))
  )
    throw new ApiError(
      403,
      "scope_not_allowed",
      "Approve only permissions that the app requested and your role allows.",
    );
  const { code } = await createOAuthGrant(p, {
    clientId: request.client.id,
    clientName: request.client.name,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    scopes: granted as McpScope[],
  });
  return redirectWith(request.redirectUri, {
    code,
    state: request.state,
    iss: issuer(),
  });
}

type Exchange =
  | { status: number; error: string; description: string }
  | { token: Record<string, unknown> };
const failure = (status: number, error: string, description: string) => ({
  status,
  error,
  description,
});
const invalidGrant = () =>
  failure(
    400,
    "invalid_grant",
    "The authorization code or refresh token is invalid, expired or already used.",
  );
/** Whether this call revoked the grant; an already revoked grant is left unchanged. */
async function revokeGrant(tx: TeamTx, grantId: string): Promise<boolean> {
  const revoked = await tx
    .update(apiTokens)
    .set({ revokedAt: sql`current_timestamp` })
    .where(and(eq(apiTokens.id, grantId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  return revoked.length > 0;
}
/** Revokes the grant of a replayed code or refresh token and records why, in this transaction. */
async function revokeReusedGrant(
  tx: TeamTx,
  grantId: string,
  reason: "authorization_code_reused" | "refresh_token_reused",
) {
  if (await revokeGrant(tx, grantId))
    await tx.execute(
      sql`select tenant_context.audit_grant_reuse(${grantId}, ${reason})`,
    );
}
/** An unrevoked, unexpired grant of this client whose user is verified and still a member. */
async function liveGrant(tx: TeamTx, grantId: string, clientId: string) {
  const [grant] = await tx
    .select({ id: apiTokens.id, scopes: apiTokens.scopes, role: member.role })
    .from(apiTokens)
    .innerJoin(user, eq(user.id, apiTokens.userId))
    .innerJoin(
      member,
      and(
        eq(member.userId, apiTokens.userId),
        eq(member.organizationId, apiTokens.teamId),
      ),
    )
    .where(
      and(
        eq(apiTokens.id, grantId),
        eq(apiTokens.oauthClientId, clientId),
        isNull(apiTokens.revokedAt),
        gt(apiTokens.expiresAt, sql`current_timestamp`),
        eq(user.emailVerified, true),
      ),
    );
  // A revocation committed after this check still stops the tokens: each use rechecks the grant.
  return grant;
}
/** A new access/refresh pair; the access token lasts at most an hour and neither outlives the grant. */
async function issue(
  tx: TeamTx,
  grant: { id: string; scopes: string[] },
): Promise<Exchange> {
  const [times] = await tx
    .select({
      access:
        sql<Date>`least(current_timestamp + interval '3600 seconds', ${apiTokens.expiresAt})`.mapWith(
          apiTokens.expiresAt,
        ),
      refresh: apiTokens.expiresAt,
      expiresIn: sql<number>`greatest(0, floor(extract(epoch from least(interval '3600 seconds', ${apiTokens.expiresAt} - current_timestamp))))::int`,
    })
    .from(apiTokens)
    .where(eq(apiTokens.id, grant.id));
  const access = `ros_oat_${randomBytes(32).toString("base64url")}`;
  const refresh = `ros_ort_${randomBytes(32).toString("base64url")}`;
  const audience = mcpResource();
  await tx.insert(oauthTokens).values([
    {
      grantId: grant.id,
      kind: "access",
      tokenHash: hashToken(access),
      audience,
      expiresAt: times.access,
    },
    {
      grantId: grant.id,
      kind: "refresh",
      tokenHash: hashToken(refresh),
      audience,
      expiresAt: times.refresh,
    },
  ]);
  return {
    token: {
      access_token: access,
      token_type: "Bearer",
      expires_in: times.expiresIn,
      refresh_token: refresh,
      scope: grant.scopes.join(" "),
    },
  };
}
async function exchange(tx: TeamTx, form: URLSearchParams): Promise<Exchange> {
  const grantType = form.get("grant_type");
  const clientId = form.get("client_id");
  if (!grantType || !clientId)
    return failure(
      400,
      "invalid_request",
      "grant_type and client_id are required.",
    );
  if (!GRANT_TYPES.includes(grantType))
    return failure(
      400,
      "unsupported_grant_type",
      "Use authorization_code or refresh_token.",
    );
  const [client] = CLIENT_ID.test(clientId)
    ? await tx
        .select({ id: oauthClients.id })
        .from(oauthClients)
        .where(eq(oauthClients.id, clientId))
        .limit(1)
    : [];
  if (!client)
    return failure(401, "invalid_client", "The client is not registered.");
  const resource = form.get("resource");
  if (resource !== null && resource !== mcpResource())
    return failure(
      400,
      "invalid_target",
      "Tokens are issued only for this MCP endpoint.",
    );
  if (grantType === "authorization_code") {
    const code = form.get("code");
    const redirectUri = form.get("redirect_uri");
    const verifier = form.get("code_verifier");
    if (!code || !redirectUri || !verifier)
      return failure(
        400,
        "invalid_request",
        "code, redirect_uri and code_verifier are required.",
      );
    const [row] = await tx
      .select({
        code: oauthCodes,
        expired: sql<boolean>`${oauthCodes.expiresAt} <= current_timestamp`,
      })
      .from(oauthCodes)
      .where(eq(oauthCodes.codeHash, hashToken(code)))
      .for("update");
    if (!row) return invalidGrant();
    // A replayed code may have leaked: revoke everything issued from it.
    if (row.code.usedAt) {
      await revokeReusedGrant(
        tx,
        row.code.grantId,
        "authorization_code_reused",
      );
      return invalidGrant();
    }
    // Any attempt spends the code, so a wrong verifier cannot be retried.
    await tx
      .update(oauthCodes)
      .set({ usedAt: sql`current_timestamp` })
      .where(eq(oauthCodes.codeHash, row.code.codeHash));
    const challenge = createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64url");
    if (
      row.expired ||
      row.code.clientId !== clientId ||
      row.code.redirectUri !== redirectUri ||
      !PKCE_VALUE.test(verifier) ||
      challenge !== row.code.codeChallenge
    )
      return invalidGrant();
    const grant = await liveGrant(tx, row.code.grantId, clientId);
    if (!grant) return invalidGrant();
    await tx
      .update(apiTokens)
      .set({ expiresAt: sql`current_timestamp + interval '30 days'` })
      .where(eq(apiTokens.id, grant.id));
    return issue(tx, grant);
  }
  const refresh = form.get("refresh_token");
  if (!refresh)
    return failure(400, "invalid_request", "refresh_token is required.");
  const [row] = /^ros_ort_[A-Za-z0-9_-]{43}$/.test(refresh)
    ? await tx
        .select({
          token: oauthTokens,
          expired: sql<boolean>`${oauthTokens.expiresAt} <= current_timestamp`,
        })
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.tokenHash, hashToken(refresh)),
            eq(oauthTokens.kind, "refresh"),
            eq(oauthTokens.audience, mcpResource()),
          ),
        )
        .for("update")
    : [];
  if (!row) return invalidGrant();
  if (row.token.usedAt) {
    await revokeReusedGrant(tx, row.token.grantId, "refresh_token_reused");
    return invalidGrant();
  }
  await tx
    .update(oauthTokens)
    .set({ usedAt: sql`current_timestamp` })
    .where(eq(oauthTokens.id, row.token.id));
  if (row.expired) return invalidGrant();
  // Issued scopes are always the grant's; a scope parameter is ignored.
  const grant = await liveGrant(tx, row.token.grantId, clientId);
  if (!grant) return invalidGrant();
  return issue(tx, grant);
}

/**
 * RFC 6749 token endpoint for public clients with S256 PKCE. Every failed exchange costs one
 * unit of a budget checked before any code or token lookup: per address and registered client,
 * so one misbehaving connector behind a shared egress address cannot exhaust the others' budget,
 * or per address alone for a malformed or unregistered client_id.
 */
export async function exchangeToken(request: Request): Promise<Response> {
  const unavailable = notReady();
  if (unavailable) return unavailable;
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/x-www-form-urlencoded")
  )
    return oauthError(
      400,
      "invalid_request",
      "Send application/x-www-form-urlencoded.",
    );
  const text = await readText(request, 16384);
  if (text === 413)
    return oauthError(413, "invalid_request", "The request is too large.");
  if (text === null)
    return oauthError(400, "invalid_request", "The request is not valid.");
  const form = new URLSearchParams(text);
  if ([...form.keys()].some((key) => form.getAll(key).length > 1))
    return oauthError(
      400,
      "invalid_request",
      "Request parameters must not repeat.",
    );
  const clientId = form.get("client_id");
  const db = await getIdentityDb();
  const result = await withDeadlines(db, async (tx) => {
    const [client] =
      clientId && CLIENT_ID.test(clientId)
        ? await tx
            .select({ id: oauthClients.id })
            .from(oauthClients)
            .where(eq(oauthClients.id, clientId))
            .limit(1)
        : [];
    const budget = client
      ? `oauth-token:${clientKey(request)}:${client.id}`
      : `oauth-token:${clientKey(request)}`;
    if ((await rateWindow(tx, budget, 0)) >= 10) return null;
    const outcome = await exchange(tx, form);
    if ("error" in outcome) await chargeRateWindow(tx, budget);
    return outcome;
  });
  await purgeExpiredAuthRowsThrottled(db);
  // Failures are returned, not thrown, so the budget and any revocation with its audit row commit.
  if (!result)
    return oauthError(
      429,
      "rate_limited",
      "Too many failed token requests. Try again in a minute.",
    );
  if ("error" in result)
    return oauthError(result.status, result.error, result.description);
  return noStore(result.token);
}
