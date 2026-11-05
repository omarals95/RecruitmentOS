import { createHash, randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Fictional sessions keyed by cookie; the real session and verification checks still run.
const auth = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  headers: new Headers(),
}));
vi.mock("@/lib/auth-session", async () => {
  const { requireVerifiedIdentity } = await import("../src/lib/auth-policy");
  const getSession = async (headers: Headers) =>
    (auth.sessions.get(headers.get("cookie") ?? "") ?? null) as {
      user: { id: string; emailVerified: boolean };
      session: { activeOrganizationId: string | null };
    } | null;
  return {
    getSession,
    getVerifiedSession: async (headers: Headers) =>
      requireVerifiedIdentity(await getSession(headers)),
  };
});
vi.mock("next/headers", () => ({ headers: async () => auth.headers }));
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("../src/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));

import Authorize from "../src/app/oauth/authorize/page";
import { POST as registerRoute } from "../src/app/oauth/register/route";
import { POST as tokenRoute } from "../src/app/oauth/token/route";
import { POST as consentRoute } from "../src/app/api/oauth/consent/route";
import { POST as mcpRoute } from "../src/app/api/mcp/route";
import { GET as candidatesRoute } from "../src/app/api/v1/[resource]/route";
import { GET as listTokensRoute } from "../src/app/api/settings/tokens/route";
import { DELETE as revokeRoute } from "../src/app/api/settings/tokens/[id]/route";
import { GET as authorizationServer } from "../src/app/.well-known/oauth-authorization-server/route";
import { GET as resourceRoot } from "../src/app/.well-known/oauth-protected-resource/route";
import { GET as resourceMcp } from "../src/app/.well-known/oauth-protected-resource/api/mcp/route";
import { safeNext } from "../src/components/auth/auth-form";
import { createTestDb, enforceTestRls, seedIdentity } from "./helpers/db";
import {
  stubHostedReadiness,
  stubLocalAuthReadiness,
} from "./helpers/readiness";

const ORIGIN = "http://localhost:3000";
const RESOURCE = `${ORIGIN}/api/mcp`;
const REDIRECT = "https://client.example.test/callback";
const TEAM = "oauth-team";
const SCOPES = [
  "candidates:read",
  "recruitment:read",
  "cvs:read",
  "candidates:write",
  "recruitment:write",
];
type Flow = {
  clientId: string;
  params: Record<string, string>;
  verifier: string;
  code: string;
};
let client = 0;
const nextIp = () => `203.0.113.${(client = (client % 250) + 1)}`;
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
};

describe("OAuth 2.1 authorization for the MCP endpoint", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;

  async function asOwner<T>(work: () => Promise<T>): Promise<T> {
    await fixture.client.exec("RESET ROLE");
    try {
      return await work();
    } finally {
      await fixture.client.exec("SET ROLE recruitment_test_runtime");
    }
  }
  const count = (text: string, params: unknown[] = []) =>
    asOwner(
      async () =>
        (await fixture.client.query<{ count: number }>(text, params)).rows[0]
          .count,
    );
  /** A fictional browser session for a seeded user. */
  function signIn(
    userId: string,
    options: { verified?: boolean; team?: string | null } = {},
  ) {
    const cookie = `fictional-session=${userId}-${randomBytes(4).toString("hex")}`;
    auth.sessions.set(cookie, {
      user: {
        id: userId,
        name: "Fictional Person",
        email: `${userId}@example.test`,
        emailVerified: options.verified ?? true,
      },
      session: { activeOrganizationId: options.team ?? TEAM },
    });
    return cookie;
  }
  const register = (body: unknown, ip = nextIp()) =>
    registerRoute(
      new Request(`${ORIGIN}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify(body),
      }),
    );
  async function registered(name = "Fictional Connector", uri = REDIRECT) {
    const response = await register({
      client_name: name,
      redirect_uris: [uri],
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { client_id: string }).client_id;
  }
  async function authorize(params: Record<string, string>, cookie?: string) {
    auth.headers = new Headers(cookie ? { cookie } : {});
    try {
      return {
        html: renderToStaticMarkup(
          await Authorize({ searchParams: Promise.resolve(params) }),
        ),
        redirect: null,
      };
    } catch (error) {
      const digest = (error as { digest?: string }).digest ?? "";
      if (!digest.startsWith("NEXT_REDIRECT;")) throw error;
      return { html: "", redirect: digest.split(";").slice(2, -2).join(";") };
    }
  }
  /** An empty header value in `headers` omits that header. */
  function consent(
    cookie: string | null,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    const sent = new Headers({
      "content-type": "application/json",
      origin: ORIGIN,
      "x-team-id": TEAM,
      ...(cookie ? { cookie } : {}),
      ...headers,
    });
    for (const [name, value] of Object.entries(headers))
      if (!value) sent.delete(name);
    return consentRoute(
      new Request(`${ORIGIN}/api/oauth/consent`, {
        method: "POST",
        headers: sent,
        body: JSON.stringify(body),
      }),
    );
  }
  const tokenRequest = (form: Record<string, string>, ip = nextIp()) =>
    tokenRoute(
      new Request(`${ORIGIN}/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-forwarded-for": ip,
        },
        body: new URLSearchParams(form).toString(),
      }),
    );
  const mcp = (token: string, method = "tools/list", params?: unknown) =>
    mcpRoute(
      new Request(RESOURCE, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-forwarded-for": nextIp(),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
  function authorizeParams(
    clientId: string,
    challenge: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return {
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "fictional-state-1",
      resource: RESOURCE,
      ...extra,
    };
  }
  /** Registers (unless given a client), approves on the consent page's endpoint and returns the code. */
  async function connect(
    cookie: string,
    options: {
      clientId?: string;
      scope?: string;
      approve?: string[];
      teamId?: string;
    } = {},
  ): Promise<Flow> {
    const clientId = options.clientId ?? (await registered());
    const { verifier, challenge } = pkce();
    const params = authorizeParams(clientId, challenge, {
      scope: options.scope ?? "candidates:read recruitment:read",
    });
    const response = await consent(
      cookie,
      {
        ...params,
        scopes: options.approve ?? ["candidates:read", "recruitment:read"],
        decision: "approve",
      },
      { "x-team-id": options.teamId ?? TEAM },
    );
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    const redirectTo = new URL(body.data.redirectTo);
    expect(`${redirectTo.origin}${redirectTo.pathname}`).toBe(REDIRECT);
    expect(redirectTo.searchParams.get("state")).toBe("fictional-state-1");
    return {
      clientId,
      params,
      verifier,
      code: redirectTo.searchParams.get("code")!,
    };
  }
  const redeem = (flow: Flow, overrides: Record<string, string> = {}) =>
    tokenRequest({
      grant_type: "authorization_code",
      client_id: flow.clientId,
      code: flow.code,
      redirect_uri: REDIRECT,
      code_verifier: flow.verifier,
      resource: RESOURCE,
      ...overrides,
    });
  async function tokens(flow: Flow) {
    const response = await redeem(flow);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
      token_type: string;
    };
  }
  const grantOf = async (clientId: string) =>
    asOwner(
      async () =>
        (
          await fixture.client.query<{
            id: string;
            revoked_at: Date | null;
            expires_at: Date;
          }>(
            "SELECT id, revoked_at, expires_at FROM auth.api_tokens WHERE oauth_client_id=$1",
            [clientId],
          )
        ).rows,
    );

  beforeAll(async () => {
    fixture = await createTestDb();
    pools.data.mockResolvedValue(fixture.db);
    pools.identity.mockResolvedValue(fixture.db);
    await seedIdentity(fixture.db, { userId: "oauth-owner", teamId: TEAM });
    for (const [userId, role] of [
      ["oauth-recruiter", "recruiter"],
      ["oauth-viewer", "viewer"],
      ["oauth-capped", "recruiter"],
    ] as const)
      await seedIdentity(fixture.db, { userId, teamId: TEAM, role });
    await seedIdentity(fixture.db, {
      userId: "oauth-unverified",
      teamId: TEAM,
      role: "recruiter",
      emailVerified: false,
    });
    await fixture.client.exec(`
      UPDATE auth.organization SET name='Fictional Oauth Team' WHERE id='${TEAM}';
      INSERT INTO auth."user"(id,name,email,email_verified) VALUES('oauth-loner','Fictional Loner','oauth-loner@example.test',true);`);
    await enforceTestRls(fixture.db);
  });
  beforeEach(() => {
    vi.unstubAllEnvs();
    stubLocalAuthReadiness();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await fixture?.close();
  });

  it("refuses every protocol endpoint with 503 until sign-in is ready", async () => {
    stubHostedReadiness({ RESEND_API_KEY: undefined });
    for (const response of [
      await mcp(`ros_oat_${randomBytes(32).toString("base64url")}`),
      resourceRoot(),
      resourceMcp(),
      authorizationServer(),
      await register({ redirect_uris: [REDIRECT] }),
      await tokenRequest({ grant_type: "refresh_token", client_id: "x" }),
    ]) {
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe("AUTH_NOT_CONFIGURED");
    }
    expect((await authorize({})).html).toContain("Setup required");
    expect(
      await count("SELECT count(*)::int AS count FROM auth.oauth_clients"),
    ).toBe(0);
  });

  it("publishes metadata from BETTER_AUTH_URL only", async () => {
    const hostile = new Request(`${ORIGIN}/.well-known/x`, {
      headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
    });
    const call = (route: () => Response) =>
      (route as unknown as (request: Request) => Response)(hostile);
    const resource = {
      resource: RESOURCE,
      authorization_servers: [ORIGIN],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "RecruitmentOS",
    };
    for (const route of [resourceRoot, resourceMcp]) {
      const response = call(route);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(resource);
    }
    expect(await call(authorizationServer).json()).toEqual({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SCOPES,
    });
  });

  it("registers public clients only, validates redirect URIs and grants nothing", async () => {
    const totals = () =>
      count(
        "SELECT ((SELECT count(*) FROM auth.api_tokens) + (SELECT count(*) FROM auth.oauth_codes) + (SELECT count(*) FROM auth.oauth_tokens))::int AS count",
      );
    const before = await totals();
    const response = await register({
      client_name: " Fictional\u0007 Connector ",
      redirect_uris: [REDIRECT, "http://127.0.0.1:9/callback"],
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["authorization_code", "refresh_token"],
      logo_uri: "https://client.example.test/logo.png",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({
      client_id: expect.stringMatching(/^ros_client_[A-Za-z0-9_-]{22}$/),
      client_id_issued_at: expect.any(Number),
      client_name: "Fictional Connector",
      redirect_uris: [REDIRECT, "http://127.0.0.1:9/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(
      (await (await register({ redirect_uris: [REDIRECT] })).json())
        .client_name,
    ).toBe("Unnamed app");
    expect(await totals()).toBe(before);
    for (const redirect_uris of [
      ["http://example.com/cb"],
      [`${REDIRECT}#fragment`],
      ["https://user:secret@client.example.test/cb"],
      Array.from({ length: 6 }, (_, n) => `${REDIRECT}/${n}`),
      undefined,
    ]) {
      const refused = await register({ redirect_uris });
      expect(refused.status, JSON.stringify(redirect_uris)).toBe(400);
      expect((await refused.json()).error).toBe("invalid_redirect_uri");
    }
    expect(
      (await register({ redirect_uris: [REDIRECT], grant_types: ["password"] }))
        .status,
    ).toBe(400);
    const ip = "198.51.100.90";
    for (let n = 0; n < 5; n++)
      expect((await register({ redirect_uris: [REDIRECT] }, ip)).status).toBe(
        201,
      );
    const limited = await register({ redirect_uris: [REDIRECT] }, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await totals()).toBe(before);
  });

  it("requires a verified member's session consent before any code exists", async () => {
    const clientId = await registered("Fictional Consent App");
    const { challenge } = pkce();
    const params = authorizeParams(clientId, challenge, {
      scope: "candidates:read recruitment:write",
    });
    const anonymous = await authorize(params);
    const next = `/oauth/authorize?${new URLSearchParams(params)}`;
    expect(anonymous.redirect).toBe(
      `/sign-in?next=${encodeURIComponent(next)}`,
    );
    expect(safeNext(next)).toBe(next);
    expect(safeNext("/oauth/other")).toBe("/app");
    expect(
      (await authorize(params, signIn("oauth-unverified", { verified: false })))
        .redirect,
    ).toBe("/verify-email");
    const loner = await authorize(params, signIn("oauth-loner"));
    expect(loner.html).toContain("Create or join a team first");
    expect(loner.html).not.toContain("Approve");
    const owner = signIn("oauth-owner");
    const page = await authorize(params, owner);
    for (const text of [
      "Fictional Consent App",
      "name supplied by the app",
      "client.example.test",
      "Fictional Oauth Team",
      "candidates:read",
      "recruitment:write",
      "up to 30 days",
      "Settings → API tokens",
      "Approve",
      "Deny",
    ])
      expect(page.html, text).toContain(text);
    const rows = () =>
      count(
        "SELECT ((SELECT count(*) FROM auth.api_tokens WHERE oauth_client_id=$1) + (SELECT count(*) FROM auth.oauth_codes WHERE client_id=$1))::int AS count",
        [clientId],
      );
    const decision = {
      ...params,
      scopes: ["candidates:read"],
      decision: "approve",
    };
    const bearer = await consent(null, decision, {
      authorization: "Bearer ros_live_fictional",
    });
    expect(bearer.status).toBe(403);
    expect((await bearer.json()).error.code).toBe("session_required");
    for (const origin of [{ origin: "" }, { origin: "https://evil.example" }]) {
      const crossSite = await consent(owner, decision, origin);
      expect(crossSite.status).toBe(403);
      expect((await crossSite.json()).error.code).toBe("invalid_origin");
    }
    const unverified = await consent(
      signIn("oauth-unverified", { verified: false }),
      decision,
    );
    expect(unverified.status).toBeGreaterThanOrEqual(400);
    expect(unverified.status).toBeLessThan(500);
    const denied = await consent(owner, { ...decision, decision: "deny" });
    expect(denied.status).toBe(200);
    const deniedTo = new URL((await denied.json()).data.redirectTo);
    expect(deniedTo.searchParams.get("error")).toBe("access_denied");
    expect(deniedTo.searchParams.get("state")).toBe("fictional-state-1");
    expect(deniedTo.searchParams.has("code")).toBe(false);
    expect(await rows()).toBe(0);
    const guessed = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code: randomBytes(32).toString("base64url"),
      redirect_uri: REDIRECT,
      code_verifier: pkce().verifier,
    });
    expect((await guessed.json()).error).toBe("invalid_grant");
  });

  it("matches redirect URIs exactly at authorize and token time", async () => {
    const clientId = await registered();
    const { challenge } = pkce();
    for (const redirect_uri of [
      `${REDIRECT}/`,
      "https://client.example.test:8443/callback",
      `${REDIRECT}/extra`,
      "https://Client.example.test/callback",
      "https://client.example.test/Callback",
    ]) {
      const result = await authorize(
        authorizeParams(clientId, challenge, { redirect_uri }),
        signIn("oauth-owner"),
      );
      expect(result.redirect, redirect_uri).toBeNull();
      expect(result.html).toContain("This connection cannot continue");
    }
    expect(
      (
        await authorize(
          authorizeParams(`ros_client_${"x".repeat(22)}`, challenge),
        )
      ).redirect,
    ).toBeNull();
    const flow = await connect(signIn("oauth-owner"), { clientId });
    const mismatch = await redeem(flow, { redirect_uri: `${REDIRECT}/` });
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error).toBe("invalid_grant");
  });

  it("enforces S256 PKCE at authorize and at the token endpoint", async () => {
    const clientId = await registered();
    const owner = signIn("oauth-owner");
    const { challenge } = pkce();
    for (const change of [
      { code_challenge: "" },
      { code_challenge_method: "plain" },
      { code_challenge_method: "" },
    ] as Record<string, string>[]) {
      const params = authorizeParams(clientId, challenge, change);
      for (const [key, value] of Object.entries(change))
        if (!value) delete params[key];
      const result = await authorize(params, owner);
      const location = new URL(result.redirect!);
      expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
      expect(location.searchParams.get("error")).toBe("invalid_request");
      expect(location.searchParams.get("state")).toBe("fictional-state-1");
    }
    const flow = await connect(owner, { clientId });
    const wrong = await redeem(flow, { code_verifier: pkce().verifier });
    expect((await wrong.json()).error).toBe("invalid_grant");
    const retried = await redeem(flow);
    expect(retried.status).toBe(400);
    expect((await retried.json()).error).toBe("invalid_grant");
  });

  it("expires codes after 120 seconds, revokes on reuse and limits failed exchanges", async () => {
    const owner = signIn("oauth-owner");
    const stale = await connect(owner);
    // Simulate 121 seconds passing for the code and its pending grant.
    for (const table of ["auth.oauth_codes", "auth.api_tokens"])
      await asOwner(() =>
        fixture.client.query(
          `UPDATE ${table} SET expires_at=expires_at-interval '121 seconds' WHERE ${table === "auth.oauth_codes" ? "client_id" : "oauth_client_id"}=$1`,
          [stale.clientId],
        ),
      );
    expect((await (await redeem(stale)).json()).error).toBe("invalid_grant");
    const listed = (await (
      await listTokensRoute(
        new Request(`${ORIGIN}/api/settings/tokens`, {
          headers: { cookie: owner, "x-team-id": TEAM },
        }),
      )
    ).json()) as {
      data: { oauthClient: { id: string } | null; expiresAt: string }[];
    };
    const pending = listed.data.find(
      (row) => row.oauthClient?.id === stale.clientId,
    )!;
    expect(new Date(pending.expiresAt).getTime()).toBeLessThan(Date.now());

    const flow = await connect(owner);
    const issued = await tokens(flow);
    expect((await mcp(issued.access_token)).status).toBe(200);
    const replay = await redeem(flow);
    expect((await replay.json()).error).toBe("invalid_grant");
    expect((await grantOf(flow.clientId))[0].revoked_at).not.toBeNull();
    expect((await mcp(issued.access_token)).status).toBe(401);

    const ip = "198.51.100.91";
    for (let n = 0; n < 10; n++)
      expect(
        (
          await tokenRequest(
            {
              grant_type: "refresh_token",
              client_id: flow.clientId,
              refresh_token: "x",
            },
            ip,
          )
        ).status,
      ).toBe(400);
    const limited = await tokenRequest(
      {
        grant_type: "refresh_token",
        client_id: flow.clientId,
        refresh_token: "x",
      },
      ip,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("binds tokens to the /api/mcp audience", async () => {
    const owner = signIn("oauth-owner");
    const clientId = await registered();
    const { challenge } = pkce();
    const wrongTarget = await authorize(
      authorizeParams(clientId, challenge, { resource: `${ORIGIN}/api/v1` }),
      owner,
    );
    expect(new URL(wrongTarget.redirect!).searchParams.get("error")).toBe(
      "invalid_target",
    );
    const flow = await connect(owner, { clientId });
    const refused = await redeem(flow, { resource: `${ORIGIN}/api/v1` });
    expect((await refused.json()).error).toBe("invalid_target");
    const issued = await tokens(await connect(owner));
    expect((await mcp(issued.access_token)).status).toBe(200);
    const rest = await candidatesRoute(
      new Request(`${ORIGIN}/api/v1/candidates`, {
        headers: { authorization: `Bearer ${issued.access_token}` },
      }),
      { params: Promise.resolve({ resource: "candidates" }) },
    );
    expect(rest.status).toBe(401);
    await asOwner(() =>
      fixture.client.query(
        "UPDATE auth.oauth_tokens SET audience=$1 WHERE kind='access'",
        [`${ORIGIN}/api/v1`],
      ),
    );
    expect((await mcp(issued.access_token)).status).toBe(401);
  });

  it("issues hour-long, approved-scope access tokens with rotating refresh tokens", async () => {
    const owner = signIn("oauth-owner");
    const flow = await connect(owner, {
      scope: "candidates:read recruitment:read cvs:read",
      approve: ["candidates:read"],
    });
    const issued = await tokens(flow);
    expect(issued.token_type).toBe("Bearer");
    expect(issued.expires_in).toBeLessThanOrEqual(3600);
    expect(issued.expires_in).toBeGreaterThan(3500);
    expect(issued.scope).toBe("candidates:read");
    expect(issued.access_token).toMatch(/^ros_oat_[A-Za-z0-9_-]{43}$/);
    expect(issued.refresh_token).toMatch(/^ros_ort_[A-Za-z0-9_-]{43}$/);
    const listed = await (await mcp(issued.access_token)).json();
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "search_candidates",
      "get_candidate",
    ]);
    const called = await mcp(issued.access_token, "tools/call", {
      name: "search_candidates",
      arguments: {},
    });
    expect((await called.json()).result.isError).toBeUndefined();
    const [grant] = await grantOf(flow.clientId);
    expect(
      await count(
        "SELECT count(*)::int AS count FROM app.activity WHERE token_id=$1::uuid AND metadata->>'oauthClientId'=$2",
        [grant.id, flow.clientId],
      ),
    ).toBe(1);
    expect(grant.expires_at.getTime() - Date.now()).toBeGreaterThan(
      29 * 86400000,
    );
    await asOwner(() =>
      fixture.client.query(
        "UPDATE auth.oauth_tokens SET expires_at=now()-interval '1 second' WHERE grant_id=$1 AND kind='access'",
        [grant.id],
      ),
    );
    expect((await mcp(issued.access_token)).status).toBe(401);
    const refresh = (token: string) =>
      tokenRequest({
        grant_type: "refresh_token",
        client_id: flow.clientId,
        refresh_token: token,
        scope: "candidates:write",
      });
    const rotated = await (await refresh(issued.refresh_token)).json();
    expect(rotated.scope).toBe("candidates:read");
    expect(rotated.refresh_token).not.toBe(issued.refresh_token);
    expect((await mcp(rotated.access_token)).status).toBe(200);
    const reused = await refresh(issued.refresh_token);
    expect((await reused.json()).error).toBe("invalid_grant");
    expect((await grantOf(flow.clientId))[0].revoked_at).not.toBeNull();
    expect((await mcp(rotated.access_token)).status).toBe(401);

    const viewer = signIn("oauth-viewer");
    const clientId = await registered();
    const { challenge } = pkce();
    const params = authorizeParams(clientId, challenge, {
      scope: "candidates:read candidates:write",
    });
    const page = await authorize(params, viewer);
    expect(page.html).toContain("Not available to your role");
    expect(page.html.match(/type="checkbox"/g)).toHaveLength(1);
    const refusedScope = await consent(viewer, {
      ...params,
      scopes: ["candidates:write"],
      decision: "approve",
    });
    expect(refusedScope.status).toBe(403);
    expect((await refusedScope.json()).error.code).toBe("scope_not_allowed");
    const unrequested = await consent(viewer, {
      ...params,
      scopes: ["cvs:read"],
      decision: "approve",
    });
    expect((await unrequested.json()).error.code).toBe("scope_not_allowed");
  });

  it("lists grants in Settings, caps them with API tokens and revokes them there", async () => {
    const recruiter = signIn("oauth-recruiter");
    const flow = await connect(recruiter, {
      clientId: await registered("Fictional Settings App"),
    });
    const issued = await tokens(flow);
    const settings = (cookie: string, path = "/api/settings/tokens") =>
      listTokensRoute(
        new Request(`${ORIGIN}${path}`, {
          headers: { cookie, "x-team-id": TEAM },
        }),
      );
    const mine = (await (await settings(recruiter)).json()).data as {
      id: string;
      scopes: string[];
      oauthClient: { id: string; name: string } | null;
    }[];
    const listed = mine.find((row) => row.oauthClient?.id === flow.clientId)!;
    expect(listed.oauthClient).toEqual({
      id: flow.clientId,
      name: "Fictional Settings App",
    });
    expect(listed.scopes).toEqual(["candidates:read", "recruitment:read"]);
    const owner = signIn("oauth-owner");
    const all = (
      await (await settings(owner, "/api/settings/tokens?all=true")).json()
    ).data as { id: string }[];
    expect(all.map((row) => row.id)).toContain(listed.id);
    const revoked = await revokeRoute(
      new Request(`${ORIGIN}/api/settings/tokens/${listed.id}`, {
        method: "DELETE",
        headers: { cookie: owner, origin: ORIGIN, "x-team-id": TEAM },
      }),
      { params: Promise.resolve({ id: listed.id }) },
    );
    expect(revoked.status).toBe(200);
    expect(
      await count(
        "SELECT count(*)::int AS count FROM app.activity WHERE action='token.revoked' AND metadata->>'tokenId'=$1",
        [listed.id],
      ),
    ).toBe(1);
    expect((await mcp(issued.access_token)).status).toBe(401);
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      client_id: flow.clientId,
      refresh_token: issued.refresh_token,
    });
    expect((await refreshed.json()).error).toBe("invalid_grant");

    await asOwner(() =>
      fixture.client.query(
        `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at)
          SELECT gen_random_uuid()::text,'${TEAM}','oauth-capped','Fictional filler',md5(n::text)||md5((n+1000)::text),'ros_live_fiction','["candidates:read"]',now()+interval '1 day'
          FROM generate_series(1,50) n`,
      ),
    );
    const capped = await consent(signIn("oauth-capped"), {
      ...authorizeParams(await registered(), pkce().challenge),
      scopes: ["candidates:read"],
      decision: "approve",
    });
    expect(capped.status).toBe(409);
    expect((await capped.json()).error.code).toBe("token_limit");
  });
});
