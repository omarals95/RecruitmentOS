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
      user: { id: string; emailVerified: boolean; twoFactorEnabled: boolean };
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
import {
  purgeExpiredAuthRows,
  resetAuthPurgeThrottle,
} from "../src/lib/auth-purge";
import { rateLimitClientKey } from "../src/lib/client-ip";
import {
  mcpScopeDescriptions,
  scopeDescriptions,
} from "../src/lib/scope-descriptions";
import { createTestDb, enforceTestRls, seedIdentity } from "./helpers/db";
import {
  stubHostedReadiness,
  stubLocalAuthReadiness,
} from "./helpers/readiness";

const ORIGIN = "http://localhost:3000";
const RESOURCE = `${ORIGIN}/api/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CHATGPT_REDIRECT =
  "https://chatgpt.com/connector_platform_oauth_redirect";
const ALLOWED_REDIRECTS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  CHATGPT_REDIRECT,
];
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
  redirectUri: string;
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
    options: {
      verified?: boolean;
      team?: string | null;
      twoStep?: boolean;
    } = {},
  ) {
    const cookie = `fictional-session=${userId}-${randomBytes(4).toString("hex")}`;
    auth.sessions.set(cookie, {
      user: {
        id: userId,
        name: "Fictional Person",
        email: `${userId}@example.test`,
        emailVerified: options.verified ?? true,
        twoFactorEnabled: options.twoStep ?? true,
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
      redirectUri?: string;
    } = {},
  ): Promise<Flow> {
    const redirectUri = options.redirectUri ?? REDIRECT;
    const clientId =
      options.clientId ?? (await registered(undefined, redirectUri));
    const { verifier, challenge } = pkce();
    const params = authorizeParams(clientId, challenge, {
      redirect_uri: redirectUri,
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
    expect(`${redirectTo.origin}${redirectTo.pathname}`).toBe(redirectUri);
    expect(redirectTo.searchParams.get("state")).toBe("fictional-state-1");
    expect(redirectTo.searchParams.get("iss")).toBe(ORIGIN);
    return {
      clientId,
      redirectUri,
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
      redirect_uri: flow.redirectUri,
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
    const metadata = await call(authorizationServer).json();
    expect(metadata).toEqual({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SCOPES,
      authorization_response_iss_parameter_supported: true,
    });
    expect(metadata).not.toHaveProperty(
      "client_id_metadata_document_supported",
    );
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(["none"]);
    for (const route of [resourceRoot, resourceMcp]) {
      const response = call(route);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const document = await response.json();
      expect(document).toEqual(resource);
      expect(document.authorization_servers).toHaveLength(1);
      expect(document.authorization_servers[0] === metadata.issuer).toBe(true);
    }
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
      logo_uri: "http://127.0.0.1:9/logo.png",
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
      ["http://127.0.0.1:9/cb#fragment"],
      ["http://user:secret@127.0.0.1:9/cb"],
      Array.from({ length: 6 }, (_, n) => `http://127.0.0.1:${9000 + n}/cb`),
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

  it("registers only Claude's and ChatGPT's callbacks and http loopback redirect URIs", async () => {
    const clients = () =>
      count("SELECT count(*)::int AS count FROM auth.oauth_clients");
    for (const uri of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.com/api/mcp/auth_callback",
      CHATGPT_REDIRECT,
      "http://127.0.0.1:33418/callback",
      "http://localhost:8080/cb",
      "http://[::1]:9/cb",
    ]) {
      const response = await register({ redirect_uris: [uri] });
      expect(response.status, uri).toBe(201);
      expect((await response.json()).redirect_uris).toEqual([uri]);
    }
    const before = await clients();
    for (const redirect_uris of [
      ["https://evil.example/cb"],
      ["https://claude.ai/api/mcp/auth_callback/"],
      ["https://claude.ai/api/mcp/auth_callback?x=1"],
      ["https://Claude.ai/api/mcp/auth_callback"],
      ["https://claude.ai.evil.example/api/mcp/auth_callback"],
      ["https://localhost/cb"],
      ["http://example.test/cb"],
      ["https://claude.ai/api/mcp/auth_callback", "https://evil.example/cb"],
      ["http://chatgpt.com/connector_platform_oauth_redirect"],
      [`${CHATGPT_REDIRECT}/`],
      [`${CHATGPT_REDIRECT}?x=1`],
      [`${CHATGPT_REDIRECT}#x`],
      ["https://chatgpt.com:443/connector_platform_oauth_redirect"],
      ["https://ChatGPT.com/connector_platform_oauth_redirect"],
      ["https://chatgpt.com/Connector_platform_oauth_redirect"],
      [`${CHATGPT_REDIRECT}/extra`],
      ["https://chatgpt.com/connector/oauth/abc123"],
      ["https://www.chatgpt.com/connector_platform_oauth_redirect"],
      ["https://chat.openai.com/connector_platform_oauth_redirect"],
      ["https://chatgpt.com.evil.example/connector_platform_oauth_redirect"],
      ["https://evil.example/connector_platform_oauth_redirect"],
      ["https://chatgpt.com/api/mcp/auth_callback"],
      [CHATGPT_REDIRECT, "https://evil.example/cb"],
    ]) {
      const refused = await register({ redirect_uris });
      expect(refused.status, JSON.stringify(redirect_uris)).toBe(400);
      const body = await refused.json();
      expect(body.error).toBe("invalid_redirect_uri");
      for (const text of [
        ...ALLOWED_REDIRECTS,
        "127.0.0.1, [::1] or localhost",
      ])
        expect(body.error_description).toContain(text);
    }
    expect(await clients()).toBe(before);

    const chatgpt = await registered("Fictional ChatGPT", CHATGPT_REDIRECT);
    const page = await authorize(
      authorizeParams(chatgpt, pkce().challenge, {
        redirect_uri: CHATGPT_REDIRECT,
      }),
      signIn("oauth-owner"),
    );
    expect(page.redirect).toBeNull();
    expect(page.html).toContain("you return to <strong>chatgpt.com</strong>");

    // ChatGPT's per-connection callback is not on the allowlist, even for a stored client.
    const callbackId = "https://chatgpt.com/connector/oauth/abc123";
    const legacy = `ros_client_${randomBytes(16).toString("base64url")}`;
    await asOwner(() =>
      fixture.client.query(
        "INSERT INTO auth.oauth_clients(id,name,redirect_uris) VALUES($1,'Fictional Callback App',$2::jsonb)",
        [legacy, JSON.stringify([callbackId])],
      ),
    );
    for (const cookie of [undefined, signIn("oauth-owner")]) {
      const result = await authorize(
        authorizeParams(legacy, pkce().challenge, { redirect_uri: callbackId }),
        cookie,
      );
      expect(result.redirect).toBeNull();
      expect(result.html).toContain("This connection cannot continue");
    }
  });

  it("strips invisible characters from client names everywhere they are shown", async () => {
    const response = await register({
      client_name: "Fict\u202Eional\u200B Conn\u2066ector\uFEFF\u00AD\u3164",
      redirect_uris: [REDIRECT],
    });
    const body = await response.json();
    expect(body.client_name).toBe("Fictional Connector");
    const stored = (table: string, id: string) =>
      asOwner(
        async () =>
          (
            await fixture.client.query<{ name: string }>(
              `SELECT name FROM ${table} WHERE id=$1`,
              [id],
            )
          ).rows[0].name,
      );
    expect(await stored("auth.oauth_clients", body.client_id)).toBe(
      "Fictional Connector",
    );
    const invisible = await (
      await register({ client_name: "\u200B\u202E", redirect_uris: [REDIRECT] })
    ).json();
    expect(await stored("auth.oauth_clients", invisible.client_id)).toBe(
      "Unnamed app",
    );
    const spaced = await register({
      client_name: "Fictional\u2028Line\u3000\u3000Break\tApp",
      redirect_uris: [REDIRECT],
    });
    expect((await spaced.json()).client_name).toBe("Fictional Line BreakApp");

    const legacy = `ros_client_${randomBytes(16).toString("base64url")}`;
    await asOwner(() =>
      fixture.client.query(
        "INSERT INTO auth.oauth_clients(id,name,redirect_uris) VALUES($1,$2,$3::jsonb)",
        [legacy, "Fictional\u202EApp", JSON.stringify([REDIRECT])],
      ),
    );
    const owner = signIn("oauth-owner");
    const page = await authorize(
      authorizeParams(legacy, pkce().challenge),
      owner,
    );
    expect(page.html).toContain("<strong>FictionalApp</strong>");
    expect(page.html).not.toContain("\u202E");
    const flow = await connect(owner, { clientId: legacy });
    const [grant] = await grantOf(flow.clientId);
    expect(await stored("auth.api_tokens", grant.id)).not.toContain("\u202E");
  });

  it("describes each scope by what the MCP tools actually do", async () => {
    for (const text of Object.values(mcpScopeDescriptions))
      expect(text).not.toMatch(/download|edit/i);
    expect(scopeDescriptions["cvs:read"]).toBe(
      "Read CVs and private download links (also needs candidates:read)",
    );
    const clientId = await registered();
    const page = await authorize(
      authorizeParams(clientId, pkce().challenge, { scope: SCOPES.join(" ") }),
      signIn("oauth-owner"),
    );
    for (const text of [
      "Search candidates and read their stated facts and evidence summaries",
      "Read job roles, vacancies, applications, tasks, interviews, offers and onboarding",
      "See CV file names, types and sizes, but not CV contents",
      "Add new candidates",
      "Create, update, archive and restore job roles, vacancies, applications, interviews, offers and onboarding, move application stages and add comments; comments on candidates also need candidates:read and candidates:write",
    ])
      expect(page.html, text).toContain(text);
    expect(page.html).not.toContain("private download links");
    expect(page.html).not.toContain("Create and edit");
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
      "you return to <strong>claude.ai</strong>",
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
    expect(deniedTo.searchParams.get("iss")).toBe(ORIGIN);
    expect(deniedTo.searchParams.has("code")).toBe(false);
    const stateless: Record<string, unknown> = {
      ...decision,
      decision: "deny",
    };
    delete stateless.state;
    const deniedWithoutState = await consent(owner, stateless);
    expect(deniedWithoutState.status).toBe(200);
    const statelessTo = new URL(
      (await deniedWithoutState.json()).data.redirectTo,
    );
    expect(statelessTo.searchParams.get("error")).toBe("access_denied");
    expect(statelessTo.searchParams.has("state")).toBe(false);
    expect(statelessTo.searchParams.get("iss")).toBe(ORIGIN);
    expect(statelessTo.searchParams.has("code")).toBe(false);
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

  it("needs two-step sign-in to approve a connection, but not to deny one", async () => {
    const clientId = await registered("Fictional Two-Step App");
    const params = authorizeParams(clientId, pkce().challenge, {
      scope: "candidates:read",
    });
    const setTwoStep = (enabled: boolean) =>
      asOwner(() =>
        fixture.client.query(
          `UPDATE auth."user" SET two_factor_enabled=$1 WHERE id='oauth-recruiter'`,
          [enabled],
        ),
      );
    const rows = () =>
      count(
        "SELECT count(*)::int AS count FROM auth.api_tokens WHERE oauth_client_id=$1",
        [clientId],
      );
    await setTwoStep(false);
    try {
      const recruiter = signIn("oauth-recruiter", { twoStep: false });
      const next = `/oauth/authorize?${new URLSearchParams(params)}`;
      const card = await authorize(params, recruiter);
      expect(card.html).toContain("Turn on two-step sign-in first");
      expect(card.html).toContain("Fictional Two-Step App");
      expect(card.html).toContain(
        `href="/two-step-setup?next=${encodeURIComponent(next)}"`,
      );
      expect(card.html).not.toContain("Approve");
      // An owner or admin without two-step sign-in is sent to set it up first.
      expect(
        (await authorize(params, signIn("oauth-owner", { twoStep: false })))
          .redirect,
      ).toBe(`/two-step-setup?next=${encodeURIComponent(next)}`);
      const decision = { ...params, scopes: ["candidates:read"] };
      const refused = await consent(recruiter, {
        ...decision,
        decision: "approve",
      });
      expect(refused.status).toBe(403);
      expect((await refused.json()).error).toMatchObject({
        code: "two_step_required",
        message:
          "Turn on two-step sign-in in your profile before creating API tokens or connecting apps.",
      });
      expect(await rows()).toBe(0);
      const denied = await consent(recruiter, {
        ...decision,
        decision: "deny",
      });
      expect(denied.status).toBe(200);
      expect(
        new URL((await denied.json()).data.redirectTo).searchParams.get(
          "error",
        ),
      ).toBe("access_denied");
      expect(await rows()).toBe(0);
      await setTwoStep(true);
      const approved = await consent(
        signIn("oauth-recruiter", { twoStep: true }),
        { ...decision, decision: "approve" },
      );
      expect(approved.status).toBe(200);
      expect(await rows()).toBe(1);
    } finally {
      await setTwoStep(true);
    }
  });

  it("matches redirect URIs exactly at authorize and token time", async () => {
    const clientId = await registered();
    const { challenge } = pkce();
    for (const redirect_uri of [
      `${REDIRECT}/`,
      "https://claude.ai:8443/api/mcp/auth_callback",
      `${REDIRECT}/extra`,
      "https://Claude.ai/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/Auth_callback",
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

  it("refuses clients registered before the allowlist without redirecting", async () => {
    const legacy = `ros_client_${randomBytes(16).toString("base64url")}`;
    const uri = "https://client.example.test/cb";
    await asOwner(() =>
      fixture.client.query(
        "INSERT INTO auth.oauth_clients(id,name,redirect_uris) VALUES($1,'Fictional Legacy App',$2::jsonb)",
        [legacy, JSON.stringify([uri])],
      ),
    );
    const params = authorizeParams(legacy, pkce().challenge, {
      redirect_uri: uri,
    });
    for (const cookie of [undefined, signIn("oauth-owner")]) {
      const result = await authorize(params, cookie);
      expect(result.redirect).toBeNull();
      expect(result.html).toContain("This connection cannot continue");
      expect(result.html).not.toContain("Fictional Legacy App");
    }
    const decided = await consent(signIn("oauth-owner"), {
      ...params,
      scopes: ["candidates:read"],
      decision: "deny",
    });
    expect(decided.status).toBe(400);
  });

  it("shows an error page, never a client redirect, for every invalid request", async () => {
    const clientId = await registered();
    const { challenge } = pkce();
    const invalid: [Record<string, string | null>, string][] = [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ code_challenge: null }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ scope: "candidates:read fictional:scope" }, "invalid_scope"],
      [{ resource: `${ORIGIN}/api/v1` }, "invalid_target"],
      [{ state: "s".repeat(1001) }, "invalid_request"],
    ];
    for (const cookie of [undefined, signIn("oauth-owner")])
      for (const [change, error] of invalid) {
        const params = authorizeParams(clientId, challenge);
        for (const [key, value] of Object.entries(change))
          if (value === null) delete params[key];
          else params[key] = value;
        const result = await authorize(params, cookie);
        const label = `${JSON.stringify(change).slice(0, 80)} ${cookie ? "signed in" : "signed out"}`;
        expect(result.redirect, label).toBeNull();
        expect(result.html, label).toContain("This connection cannot continue");
        expect(result.html, label).toContain(error);
      }
    auth.headers = new Headers();
    const repeated = await Authorize({
      searchParams: Promise.resolve({
        ...authorizeParams(clientId, challenge),
        scope: ["candidates:read", "recruitment:read"],
      }),
    });
    expect(renderToStaticMarkup(repeated)).toContain("invalid_request");
  });

  it("audits a revocation caused by a reused code or refresh token exactly once", async () => {
    const owner = signIn("oauth-owner");
    const revocations = (grantId: string) =>
      asOwner(
        async () =>
          (
            await fixture.client.query<{
              kind: string;
              action: string;
              actor_type: string;
              actor_id: string;
              token_id: string;
              summary: string;
              metadata: Record<string, string>;
            }>(
              "SELECT kind,action,actor_type,actor_id,token_id,summary,metadata FROM app.activity WHERE action='token.revoked' AND metadata->>'tokenId'=$1",
              [grantId],
            )
          ).rows,
      );
    const audited = (grantId: string, reason: string) => [
      {
        kind: "api-token",
        action: "token.revoked",
        actor_type: "token",
        actor_id: "oauth-owner",
        token_id: grantId,
        summary: "Revoked an OAuth connection after a reused credential",
        metadata: { tokenId: grantId, prefix: expect.any(String), reason },
      },
    ];

    const codeFlow = await connect(owner);
    await tokens(codeFlow);
    const [codeGrant] = await grantOf(codeFlow.clientId);
    expect(await revocations(codeGrant.id)).toEqual([]);
    for (let n = 0; n < 2; n++) {
      const replay = await redeem(codeFlow);
      expect(replay.status).toBe(400);
      expect((await replay.json()).error).toBe("invalid_grant");
      expect(await revocations(codeGrant.id)).toEqual(
        audited(codeGrant.id, "authorization_code_reused"),
      );
    }

    const refreshFlow = await connect(owner);
    const issued = await tokens(refreshFlow);
    const refresh = () =>
      tokenRequest({
        grant_type: "refresh_token",
        client_id: refreshFlow.clientId,
        refresh_token: issued.refresh_token,
      });
    expect((await refresh()).status).toBe(200);
    const [refreshGrant] = await grantOf(refreshFlow.clientId);
    for (let n = 0; n < 2; n++) {
      const reused = await refresh();
      expect(reused.status).toBe(400);
      expect((await reused.json()).error).toBe("invalid_grant");
      expect(await revocations(refreshGrant.id)).toEqual(
        audited(refreshGrant.id, "refresh_token_reused"),
      );
    }

    const settingsFlow = await connect(owner);
    const settingsTokens = await tokens(settingsFlow);
    const [settingsGrant] = await grantOf(settingsFlow.clientId);
    const revoked = await revokeRoute(
      new Request(`${ORIGIN}/api/settings/tokens/${settingsGrant.id}`, {
        method: "DELETE",
        headers: { cookie: owner, origin: ORIGIN, "x-team-id": TEAM },
      }),
      { params: Promise.resolve({ id: settingsGrant.id }) },
    );
    expect(revoked.status).toBe(200);
    const refreshAgain = () =>
      tokenRequest({
        grant_type: "refresh_token",
        client_id: settingsFlow.clientId,
        refresh_token: settingsTokens.refresh_token,
      });
    for (const response of [
      await redeem(settingsFlow),
      await refreshAgain(),
      await refreshAgain(),
    ]) {
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("invalid_grant");
    }
    const settingsRows = await revocations(settingsGrant.id);
    expect(settingsRows).toHaveLength(1);
    expect(settingsRows[0]).toMatchObject({
      actor_type: "session",
      summary: "Revoked an API token",
    });
    expect(settingsRows[0].metadata.reason).toBeUndefined();
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
      expect(result.redirect).toBeNull();
      expect(result.html).toContain("This connection cannot continue");
      expect(result.html).toContain("invalid_request");
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
    expect(wrongTarget.redirect).toBeNull();
    expect(wrongTarget.html).toContain("invalid_target");
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

  it("refuses every resource but /api/mcp at authorize and at both token grants", async () => {
    const owner = signIn("oauth-owner");
    const wrong = [
      `${ORIGIN}/api/v1`,
      `${ORIGIN}/api/mcp/`,
      ORIGIN,
      "https://chatgpt.com/api/mcp",
      `${ORIGIN.toUpperCase()}/api/mcp`,
    ];
    const clientId = await registered();
    const { challenge } = pkce();
    for (const cookie of [undefined, owner])
      for (const resource of wrong) {
        const result = await authorize(
          authorizeParams(clientId, challenge, { resource }),
          cookie,
        );
        expect(result.redirect, resource).toBeNull();
        expect(result.html, resource).toContain(
          "This connection cannot continue",
        );
        expect(result.html, resource).toContain("invalid_target");
      }
    const flow = await connect(owner, { clientId });
    for (const resource of wrong) {
      const refused = await redeem(flow, { resource });
      expect(refused.status, resource).toBe(400);
      expect((await refused.json()).error, resource).toBe("invalid_target");
    }
    const issued = await tokens(flow);
    const refresh = (resource: string) =>
      tokenRequest({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: issued.refresh_token,
        resource,
      });
    for (const resource of wrong) {
      const refused = await refresh(resource);
      expect(refused.status, resource).toBe(400);
      expect((await refused.json()).error, resource).toBe("invalid_target");
    }
    const rotated = await refresh(RESOURCE);
    expect(rotated.status).toBe(200);
    expect((await mcp((await rotated.json()).access_token)).status).toBe(200);
  });

  it("binds refresh tokens and resource-less flows to the /api/mcp audience", async () => {
    const owner = signIn("oauth-owner");
    const audiences = (clientId: string) =>
      asOwner(
        async () =>
          (
            await fixture.client.query<{ kind: string; audience: string }>(
              "SELECT t.kind, t.audience FROM auth.oauth_tokens t JOIN auth.api_tokens g ON g.id=t.grant_id WHERE g.oauth_client_id=$1 ORDER BY t.kind",
              [clientId],
            )
          ).rows,
      );
    const issuedRows = () =>
      count("SELECT count(*)::int AS count FROM auth.oauth_tokens");
    const bound = [
      { kind: "access", audience: RESOURCE },
      { kind: "refresh", audience: RESOURCE },
    ];

    const flow = await connect(owner);
    const issued = await tokens(flow);
    expect(await audiences(flow.clientId)).toEqual(bound);
    const [grant] = await grantOf(flow.clientId);
    await asOwner(() =>
      fixture.client.query(
        "UPDATE auth.oauth_tokens SET audience=$1 WHERE grant_id=$2 AND kind='refresh'",
        [`${ORIGIN}/api/v1`, grant.id],
      ),
    );
    const before = await issuedRows();
    const moved = await tokenRequest({
      grant_type: "refresh_token",
      client_id: flow.clientId,
      refresh_token: issued.refresh_token,
      resource: RESOURCE,
    });
    expect(moved.status).toBe(400);
    expect((await moved.json()).error).toBe("invalid_grant");
    expect(await issuedRows()).toBe(before);

    // A missing resource is accepted and the tokens are still bound to /api/mcp.
    const clientId = await registered();
    const { verifier, challenge } = pkce();
    const params = authorizeParams(clientId, challenge);
    delete params.resource;
    const approved = await consent(owner, {
      ...params,
      scopes: ["candidates:read", "recruitment:read"],
      decision: "approve",
    });
    expect(approved.status).toBe(200);
    const code = new URL(
      (await approved.json()).data.redirectTo,
    ).searchParams.get("code")!;
    const redeemed = await tokenRequest({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(redeemed.status).toBe(200);
    const plain = await redeemed.json();
    expect(await audiences(clientId)).toEqual(bound);
    expect((await mcp(plain.access_token)).status).toBe(200);
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: plain.refresh_token,
    });
    expect(refreshed.status).toBe(200);
    expect((await mcp((await refreshed.json()).access_token)).status).toBe(200);
  });

  for (const [label, redirectUri] of [
    ["Claude", REDIRECT],
    ["ChatGPT", CHATGPT_REDIRECT],
    ["loopback", "http://127.0.0.1:33418/callback"],
  ])
    it(`connects a fake ${label} client end to end without outbound fetches`, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        const asMetadata = await authorizationServer().json();
        const resourceMetadata = await resourceMcp().json();
        const issuer: string = asMetadata.issuer;
        const resource: string = resourceMetadata.resource;
        expect(resourceMetadata.authorization_servers).toEqual([issuer]);

        const registeredClient = await registerRoute(
          new Request(asMetadata.registration_endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-forwarded-for": nextIp(),
            },
            body: JSON.stringify({
              client_name: `Fictional ${label} Client`,
              redirect_uris: [redirectUri],
            }),
          }),
        );
        expect(registeredClient.status).toBe(201);
        const clientId: string = (await registeredClient.json()).client_id;

        const { verifier, challenge } = pkce();
        const params = authorizeParams(clientId, challenge, {
          redirect_uri: redirectUri,
          resource,
        });
        const signedOut = await authorize(params);
        expect(signedOut.redirect).toBe(
          `/sign-in?next=${encodeURIComponent(`/oauth/authorize?${new URLSearchParams(params)}`)}`,
        );
        const owner = signIn("oauth-owner");
        const page = await authorize(params, owner);
        expect(page.html).toContain(
          `you return to <strong>${new URL(redirectUri).host}</strong>`,
        );

        const approved = await consent(owner, {
          ...params,
          scopes: ["candidates:read", "recruitment:read"],
          decision: "approve",
        });
        expect(approved.status).toBe(200);
        const redirectTo: string = (await approved.json()).data.redirectTo;
        expect(redirectTo.startsWith(`${redirectUri}?`)).toBe(true);
        const returned = new URL(redirectTo).searchParams;
        expect(returned.get("state")).toBe("fictional-state-1");
        expect(returned.get("iss")).toBe(issuer);
        const code = returned.get("code");
        expect(code).toBeTruthy();

        const exchanged = await tokenRequest({
          grant_type: "authorization_code",
          client_id: clientId,
          code: code!,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource,
        });
        expect(exchanged.status).toBe(200);
        const first = await exchanged.json();
        expect((await mcp(first.access_token)).status).toBe(200);

        const refresh = () =>
          tokenRequest({
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: first.refresh_token,
            resource,
          });
        const refreshed = await refresh();
        expect(refreshed.status).toBe(200);
        const second = await refreshed.json();
        expect((await mcp(second.access_token)).status).toBe(200);
        const spent = await refresh();
        expect(spent.status).toBe(400);
        expect((await spent.json()).error).toBe("invalid_grant");

        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
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

  describe("rate-limit keys, budgets and retention", () => {
    const clientKey = (ip: string) =>
      rateLimitClientKey(ip, process.env.BETTER_AUTH_SECRET!);
    const keys = () =>
      asOwner(
        async () =>
          (
            await fixture.client.query<{ key: string; count: number }>(
              "SELECT key, count FROM auth.api_rate_limits",
            )
          ).rows,
      );
    const failRefresh = (clientId: string, ip: string) =>
      tokenRequest(
        {
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: "x",
        },
        ip,
      );

    it("stores registration and token budgets under keyed hashes of the client address", async () => {
      const ip = "198.51.100.92";
      expect((await register({ redirect_uris: [REDIRECT] }, ip)).status).toBe(
        201,
      );
      const clientId = await registered();
      expect((await failRefresh(clientId, ip)).status).toBe(400);
      expect((await failRefresh("not-a-client", ip)).status).toBe(401);
      const stored = await keys();
      expect(stored.map((row) => row.key)).toEqual(
        expect.arrayContaining([
          `oauth-register:${clientKey(ip)}`,
          `oauth-token:${clientKey(ip)}:${clientId}`,
          `oauth-token:${clientKey(ip)}`,
        ]),
      );
      expect(JSON.stringify(stored)).not.toContain(ip);
      vi.stubEnv(
        "BETTER_AUTH_SECRET",
        "fictional-other-test-secret-0123456789ab",
      );
      expect((await register({ redirect_uris: [REDIRECT] }, ip)).status).toBe(
        201,
      );
      const rotated = `oauth-register:${clientKey(ip)}`;
      expect(rotated).not.toBe(
        `oauth-register:${rateLimitClientKey(ip, "fictional-valid-test-secret-0123456789")}`,
      );
      expect((await keys()).map((row) => row.key)).toContain(rotated);
    });

    it("gives each registered client its own failed-exchange budget per address", async () => {
      const ip = "198.51.100.93";
      const clientA = await registered("Fictional Connector A");
      const clientB = await registered("Fictional Connector B");
      for (let n = 0; n < 10; n++)
        expect((await failRefresh(clientA, ip)).status).toBe(400);
      const limited = await failRefresh(clientA, ip);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      const flow = await connect(signIn("oauth-owner"), { clientId: clientB });
      const exchanged = await tokenRequest(
        {
          grant_type: "authorization_code",
          client_id: flow.clientId,
          code: flow.code,
          redirect_uri: flow.redirectUri,
          code_verifier: flow.verifier,
          resource: RESOURCE,
        },
        ip,
      );
      expect(exchanged.status).toBe(200);
      expect((await failRefresh(clientB, ip)).status).toBe(400);

      // Malformed and unregistered client_id values share the address's own budget.
      const shared = "198.51.100.94";
      const unregistered = `ros_client_${"F".repeat(22)}`;
      for (let n = 0; n < 5; n++) {
        expect((await failRefresh(unregistered, shared)).status).toBe(401);
        expect((await failRefresh("not-a-client", shared)).status).toBe(401);
      }
      expect((await failRefresh("another-unknown", shared)).status).toBe(429);
      expect((await failRefresh(clientA, shared)).status).toBe(400);
      expect(
        (await keys()).find(
          (row) => row.key === `oauth-token:${clientKey(shared)}`,
        )?.count,
      ).toBe(10);
    });

    it("refuses registration while 1,000 clients have no grant and accepts it at 999", async () => {
      const unconsented = () =>
        count(
          "SELECT count(*)::int AS count FROM auth.oauth_clients c WHERE NOT EXISTS (SELECT 1 FROM auth.api_tokens t WHERE t.oauth_client_id = c.id)",
        );
      const clients = () =>
        count("SELECT count(*)::int AS count FROM auth.oauth_clients");
      const fill = (total: number) =>
        asOwner(() =>
          fixture.client.query(
            `INSERT INTO auth.oauth_clients(id,name,redirect_uris)
              SELECT 'ros_client_' || lpad(n::text, 22, 'Z'), 'Fictional filler', '["https://claude.ai/api/mcp/auth_callback"]'
              FROM generate_series(1, $1::int) n`,
            [total],
          ),
        );
      try {
        // Consented clients do not count towards the cap.
        await connect(signIn("oauth-owner"));
        await fill(999 - (await unconsented()));
        expect(await unconsented()).toBe(999);
        expect(
          (await register({ redirect_uris: [REDIRECT] }, "198.51.100.95"))
            .status,
        ).toBe(201);
        expect(await unconsented()).toBe(1000);
        const before = await clients();
        const refused = await register(
          { redirect_uris: [REDIRECT] },
          "198.51.100.96",
        );
        expect(refused.status).toBe(429);
        expect(refused.headers.get("retry-after")).toBe("60");
        expect(await refused.json()).toEqual({
          error: "rate_limited",
          error_description: "Too many client registrations. Try again later.",
        });
        expect(await clients()).toBe(before);
      } finally {
        await asOwner(() =>
          fixture.client.query(
            "DELETE FROM auth.oauth_clients WHERE name='Fictional filler'",
          ),
        );
      }
    });

    it("purges only rows past their retention, at most 500 per table, and keeps reuse detection", async () => {
      const owner = signIn("oauth-owner");
      // A grant whose code and tokens are long expired, and one with a used refresh token still kept.
      const old = await connect(owner);
      await tokens(old);
      const kept = await connect(owner);
      const issued = await tokens(kept);
      const rotated = await tokenRequest({
        grant_type: "refresh_token",
        client_id: kept.clientId,
        refresh_token: issued.refresh_token,
      });
      expect(rotated.status).toBe(200);
      const pending = await connect(owner);
      const [oldGrant] = await grantOf(old.clientId);
      const [keptGrant] = await grantOf(kept.clientId);
      const stale = await registered("Fictional Stale Client");
      const recent = await registered("Fictional Recent Client");
      await asOwner(() =>
        fixture.client.exec(`
          DELETE FROM auth.api_rate_limits;
          DELETE FROM auth.rate_limit;
          INSERT INTO auth.api_rate_limits(key, window_start, count)
            SELECT 'fictional-old-' || n, now() - interval '16 minutes' - n * interval '1 second', 1
            FROM generate_series(1, 600) n;
          INSERT INTO auth.api_rate_limits(key, window_start, count)
            VALUES ('fictional-fresh', now() - interval '14 minutes', 1);
          INSERT INTO auth.rate_limit(key, count, last_request)
            VALUES ('ba:fictional-old', 1, (extract(epoch from now()) * 1000)::bigint - 660000),
                   ('ba:fictional-fresh', 1, (extract(epoch from now()) * 1000)::bigint - 540000);
          UPDATE auth.oauth_codes SET expires_at = now() - interval '2 days' WHERE grant_id = '${oldGrant.id}';
          UPDATE auth.oauth_tokens SET expires_at = now() - interval '2 days' WHERE grant_id = '${oldGrant.id}';
          UPDATE auth.oauth_codes SET expires_at = now() - interval '12 hours' WHERE grant_id = '${keptGrant.id}';
          UPDATE auth.oauth_tokens SET expires_at = now() - interval '12 hours'
            WHERE grant_id = '${keptGrant.id}' AND kind = 'access';
          UPDATE auth.oauth_clients SET created_at = now() - interval '2 days'
            WHERE id IN ('${stale}', '${old.clientId}');
          UPDATE auth.oauth_clients SET created_at = now() - interval '12 hours' WHERE id = '${recent}';
          INSERT INTO auth.oauth_clients(id, name, redirect_uris, created_at)
            SELECT 'ros_client_' || lpad(n::text, 22, 'Y'), 'Fictional purge filler', '["https://claude.ai/api/mcp/auth_callback"]', now() - interval '3 days' - n * interval '1 second'
            FROM generate_series(1, 600) n;`),
      );
      const remaining = (text: string) => count(text);
      const oldLimits = () =>
        remaining(
          "SELECT count(*)::int AS count FROM auth.api_rate_limits WHERE key LIKE 'fictional-old-%'",
        );
      const fillers = () =>
        remaining(
          "SELECT count(*)::int AS count FROM auth.oauth_clients WHERE name = 'Fictional purge filler'",
        );
      const clientIds = async () =>
        asOwner(async () =>
          (
            await fixture.client.query<{ id: string }>(
              "SELECT id FROM auth.oauth_clients WHERE name <> 'Fictional purge filler'",
            )
          ).rows.map((row) => row.id),
        );

      await purgeExpiredAuthRows(fixture.db);
      expect(await oldLimits()).toBe(100);
      // Oldest first: the stale client (2 days old) is newer than every filler.
      expect(await fillers()).toBe(100);
      expect(await clientIds()).toContain(stale);
      await purgeExpiredAuthRows(fixture.db);
      expect(await oldLimits()).toBe(0);
      expect(await fillers()).toBe(0);

      expect(
        await remaining(
          "SELECT count(*)::int AS count FROM auth.api_rate_limits WHERE key = 'fictional-fresh'",
        ),
      ).toBe(1);
      expect(
        (
          await asOwner(
            async () =>
              (
                await fixture.client.query<{ key: string }>(
                  "SELECT key FROM auth.rate_limit ORDER BY key",
                )
              ).rows,
          )
        ).map((row) => row.key),
      ).toEqual(["ba:fictional-fresh"]);
      const byGrant = (table: string, grantId: string) =>
        remaining(
          `SELECT count(*)::int AS count FROM ${table} WHERE grant_id = '${grantId}'`,
        );
      expect(await byGrant("auth.oauth_codes", oldGrant.id)).toBe(0);
      expect(await byGrant("auth.oauth_tokens", oldGrant.id)).toBe(0);
      // Expired within a day, used, or unexpired: all kept.
      expect(await byGrant("auth.oauth_codes", keptGrant.id)).toBe(1);
      expect(await byGrant("auth.oauth_tokens", keptGrant.id)).toBe(4);
      const [pendingGrant] = await grantOf(pending.clientId);
      expect(await byGrant("auth.oauth_codes", pendingGrant.id)).toBe(1);
      const ids = await clientIds();
      expect(ids).not.toContain(stale);
      expect(ids).toEqual(
        expect.arrayContaining([recent, old.clientId, kept.clientId]),
      );

      // The used refresh token is still recognised, so replaying it revokes the grant.
      const replay = await tokenRequest({
        grant_type: "refresh_token",
        client_id: kept.clientId,
        refresh_token: issued.refresh_token,
      });
      expect((await replay.json()).error).toBe("invalid_grant");
      expect((await grantOf(kept.clientId))[0].revoked_at).not.toBeNull();
    });

    it("purges from a request at most once a minute per instance", async () => {
      const seedOld = (key: string) =>
        asOwner(() =>
          fixture.client.query(
            "INSERT INTO auth.api_rate_limits(key, window_start, count) VALUES ($1, now() - interval '16 minutes', 1)",
            [key],
          ),
        );
      const present = (key: string) =>
        count(
          "SELECT count(*)::int AS count FROM auth.api_rate_limits WHERE key = $1",
          [key],
        );
      resetAuthPurgeThrottle();
      await seedOld("fictional-throttle-1");
      expect((await failRefresh("not-a-client", nextIp())).status).toBe(401);
      expect(await present("fictional-throttle-1")).toBe(0);
      await seedOld("fictional-throttle-2");
      expect((await failRefresh("not-a-client", nextIp())).status).toBe(401);
      expect(
        (await register({ redirect_uris: [REDIRECT] }, nextIp())).status,
      ).toBe(201);
      expect(await present("fictional-throttle-2")).toBe(1);
      await asOwner(() =>
        fixture.client.query(
          "DELETE FROM auth.api_rate_limits WHERE key = 'fictional-throttle-2'",
        ),
      );
    });

    it("keeps answering normally and logs one safe line when the OAuth DELETE grant is missing", async () => {
      const grants = (action: "GRANT" | "REVOKE") =>
        asOwner(() =>
          fixture.client.exec(
            `${action} DELETE ON auth.oauth_clients, auth.oauth_codes, auth.oauth_tokens ${action === "GRANT" ? "TO" : "FROM"} recruitment_test_runtime`,
          ),
        );
      const seedOld = () =>
        asOwner(() =>
          fixture.client.query(
            "INSERT INTO auth.api_rate_limits(key, window_start, count) VALUES ('fictional-ungranted', now() - interval '16 minutes', 1)",
          ),
        );
      const oldPresent = () =>
        count(
          "SELECT count(*)::int AS count FROM auth.api_rate_limits WHERE key = 'fictional-ungranted'",
        );
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      await grants("REVOKE");
      try {
        resetAuthPurgeThrottle();
        await seedOld();
        const registeredResponse = await register(
          { redirect_uris: [REDIRECT] },
          nextIp(),
        );
        expect(registeredResponse.status).toBe(201);
        expect((await registeredResponse.json()).client_id).toMatch(
          /^ros_client_/,
        );
        expect(await oldPresent()).toBe(0);
        expect(logged.mock.calls).toEqual([
          [
            expect.stringMatching(
              /^auth_purge_failed category=\w+ sqlstate=42501$/,
            ),
          ],
        ]);

        // Registered inside the same minute, so this registration does not purge again.
        const clientId = await registered();
        logged.mockClear();
        resetAuthPurgeThrottle();
        await seedOld();
        const exchanged = await failRefresh(clientId, nextIp());
        expect(exchanged.status).toBe(400);
        expect((await exchanged.json()).error).toBe("invalid_grant");
        expect(await oldPresent()).toBe(0);
        expect(logged.mock.calls).toEqual([
          [
            expect.stringMatching(
              /^auth_purge_failed category=\w+ sqlstate=42501$/,
            ),
          ],
        ]);
        const line = logged.mock.calls[0][0] as string;
        expect(line).not.toMatch(/fictional|ros_client|198\.51|203\.0/);
      } finally {
        logged.mockRestore();
        await grants("GRANT");
      }
    });
  });
});
