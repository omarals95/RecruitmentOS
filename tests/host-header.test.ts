import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requests pick the pool by role, as on a split-role deployment: the identity role runs sign-in and
// reads the membership, the data role runs withTeam. Only one PGlite role is active at a time.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("../src/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));

import {
  GET as authGet,
  POST as authPost,
} from "../src/app/api/auth/[...all]/route";
import { GET as authorizationServer } from "../src/app/.well-known/oauth-authorization-server/route";
import { GET as resourceRoot } from "../src/app/.well-known/oauth-protected-resource/route";
import { GET as resourceMcp } from "../src/app/.well-known/oauth-protected-resource/api/mcp/route";
import { POST as mcpRoute } from "../src/app/api/mcp/route";
import { GET as domainRoute } from "../src/app/api/v1/admin/domain/route";
import { getAuth, type AppAuth } from "../src/lib/auth";
import {
  BOOTSTRAP_EMAIL,
  BOOTSTRAP_TOKEN,
  PASSWORD,
  authCaller,
  mailLink,
  resetPattern,
  verifyPattern,
  type Mail,
} from "./helpers/auth";
import { createSplitRoleDb } from "./helpers/db";
import { HOSTED_ORIGIN, stubHostedReadiness } from "./helpers/readiness";

// TST-019 (ADM-40, job 098): every request carries a forged Host, X-Forwarded-Host and
// X-Forwarded-Proto, and arrives on the URL Next.js would build from them. Every link in the
// responses and in the captured emails must still come from BETTER_AUTH_URL. Fictional data only;
// global fetch is stubbed, so no email or other request leaves the process.
const ATTACKER = "attacker.example.test";
const FORGED = {
  host: ATTACKER,
  "x-forwarded-host": ATTACKER,
  "x-forwarded-proto": "http",
};
const PLAIN_HTTP = "http://recruitment.example.test";
const INVITEE = "host-header-invitee@example.test";

describe("links never come from the Host or forwarding headers (TST-019)", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  /** Every outbound request; only the Resend API is expected. */
  const sent: { url: string; body: string }[] = [];
  const fetchStub = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), body: String(init?.body) });
      return new Response(JSON.stringify({ id: "fictional" }), { status: 200 });
    },
  );
  /** The emails the Resend calls carried. */
  const mail = (): Mail[] =>
    sent.map((request) => {
      const message = JSON.parse(request.body) as {
        to: string[];
        subject: string;
        text: string;
      };
      return {
        to: message.to[0],
        subject: message.subject,
        text: message.text,
      };
    });
  /** Every response of a path under test: its status, headers and body. */
  const seen: {
    name: string;
    status: number;
    headers: Headers;
    body: string;
  }[] = [];
  const record = async (name: string, response: Response) => {
    const body = await response.clone().text();
    seen.push({
      name,
      status: response.status,
      headers: response.headers,
      body,
    });
    return response;
  };

  /** The request as Next.js builds it behind a proxy that passes the forged headers on. */
  async function forge(request: Request): Promise<Request> {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    for (const [name, value] of Object.entries(FORGED))
      headers.set(name, value);
    // Hosted, only the proxy-set client address counts.
    const ip = headers.get("x-forwarded-for");
    if (ip) headers.set("x-vercel-forwarded-for", ip);
    const forged = new Request(
      `http://${ATTACKER}${url.pathname}${url.search}`,
      {
        method: request.method,
        headers,
        body:
          request.method === "GET" ? undefined : await request.arrayBuffer(),
        redirect: "manual",
      },
    );
    expect(forged.headers.get("host")).toBe(ATTACKER);
    return forged;
  }
  let caller: ReturnType<typeof authCaller>;
  let ownerCookie = "";
  let teamId = "";

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.identity.mockImplementation(harness.identityDb);
    pools.data.mockImplementation(harness.dataDb);
    vi.stubGlobal("fetch", fetchStub);
    stubHostedReadiness({
      BOOTSTRAP_OWNER_EMAIL: BOOTSTRAP_EMAIL,
      BOOTSTRAP_SETUP_TOKEN: BOOTSTRAP_TOKEN,
    });
    const auth = await getAuth();
    // Every auth call, set-up included, goes through the real route with the forged headers.
    caller = authCaller(
      {
        handler: async (request: Request) => {
          const forged = await forge(request);
          const path = new URL(request.url).pathname;
          return record(
            path,
            await (forged.method === "GET" ? authGet : authPost)(forged),
          );
        },
        api: auth.api,
      } as unknown as AppAuth,
      HOSTED_ORIGIN,
    );
    // The bootstrap owner registers, verifies from the emailed link, signs in and creates a team.
    const signUp = await caller.post(
      "sign-up/email",
      {
        name: "Fictional Owner",
        email: BOOTSTRAP_EMAIL,
        password: PASSWORD,
        callbackURL: "/sign-in",
      },
      { bootstrapToken: BOOTSTRAP_TOKEN },
    );
    expect(signUp.status).toBe(200);
    await vi.waitFor(() =>
      expect(mail().some((item) => item.to === BOOTSTRAP_EMAIL)).toBe(true),
    );
    const verified = await caller.get(
      mailLink(mail(), BOOTSTRAP_EMAIL, verifyPattern),
    );
    expect([200, 302]).toContain(verified.status);
    const cookie = await caller.signIn(BOOTSTRAP_EMAIL);
    const team = await caller.post(
      "organization/create",
      { name: "Fictional Host Team", slug: "fictional-host-team" },
      { cookie },
    );
    expect(team.status).toBe(200);
    teamId = ((await team.json()) as { id: string }).id;
    ownerCookie = (await caller.enableTwoStep(cookie)).cookie;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await harness?.close();
  });

  it("emails the invitation link on BETTER_AUTH_URL", async () => {
    const invited = await caller.post(
      "organization/invite-member",
      { organizationId: teamId, email: INVITEE, role: "recruiter" },
      { cookie: ownerCookie },
    );
    expect(invited.status).toBe(200);
    await vi.waitFor(() =>
      expect(mail().some((item) => item.to === INVITEE)).toBe(true),
    );
    expect(
      mailLink(mail(), INVITEE, /https?:\/\/\S+\/accept-invitation\S+/),
    ).toMatch(new RegExp(`^${HOSTED_ORIGIN}/accept-invitation\\?id=`));
  });

  it("emails the password reset link on BETTER_AUTH_URL and redirects from it to BETTER_AUTH_URL", async () => {
    const before = mail().filter((item) => item.to === BOOTSTRAP_EMAIL).length;
    const reset = await caller.post("request-password-reset", {
      email: BOOTSTRAP_EMAIL,
      redirectTo: `${HOSTED_ORIGIN}/reset-password`,
    });
    expect(reset.status).toBe(200);
    await vi.waitFor(() =>
      expect(
        mail().filter((item) => item.to === BOOTSTRAP_EMAIL).length,
      ).toBeGreaterThan(before),
    );
    const link = mailLink(mail(), BOOTSTRAP_EMAIL, resetPattern);
    expect(link).toMatch(
      new RegExp(`^${HOSTED_ORIGIN}/api/auth/reset-password/`),
    );
    const opened = await caller.get(link);
    expect(opened.status).toBe(302);
    expect(opened.headers.get("location")).toMatch(
      new RegExp(`^${HOSTED_ORIGIN}/reset-password\\?token=`),
    );
  });

  it("publishes OAuth metadata from BETTER_AUTH_URL", async () => {
    const forgedGet = async (path: string) =>
      forge(new Request(`${HOSTED_ORIGIN}${path}`));
    const server = await (
      await record(
        "oauth-authorization-server",
        (authorizationServer as unknown as (request: Request) => Response)(
          await forgedGet("/.well-known/oauth-authorization-server"),
        ),
      )
    ).json();
    expect(server.issuer).toBe(HOSTED_ORIGIN);
    expect(server.authorization_endpoint).toBe(
      `${HOSTED_ORIGIN}/oauth/authorize`,
    );
    for (const [name, route, path] of [
      [
        "oauth-protected-resource",
        resourceRoot,
        "/.well-known/oauth-protected-resource",
      ],
      [
        "oauth-protected-resource/api/mcp",
        resourceMcp,
        "/.well-known/oauth-protected-resource/api/mcp",
      ],
    ] as const) {
      const document = await (
        await record(
          name,
          (route as unknown as (request: Request) => Response)(
            await forgedGet(path),
          ),
        )
      ).json();
      expect(document.resource, name).toBe(`${HOSTED_ORIGIN}/api/mcp`);
      expect(document.authorization_servers, name).toEqual([HOSTED_ORIGIN]);
    }
  });

  it("names BETTER_AUTH_URL's resource metadata in the MCP 401", async () => {
    const response = await record(
      "/api/mcp",
      await mcpRoute(
        await forge(
          new Request(`${HOSTED_ORIGIN}/api/mcp`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list",
            }),
          }),
        ),
      ),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${HOSTED_ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`,
    );
  });

  it("shows BETTER_AUTH_URL as the Domain page's address", async () => {
    const response = await record(
      "/api/v1/admin/domain",
      await domainRoute(
        await forge(
          new Request(`${HOSTED_ORIGIN}/api/v1/admin/domain`, {
            headers: { cookie: ownerCookie, "x-team-id": teamId },
          }),
        ),
      ),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.address).toEqual({
      origin: HOSTED_ORIGIN,
      https: true,
      originOnly: true,
      valid: true,
    });
  });

  it("keeps every link in every response and email on BETTER_AUTH_URL, and sends nothing but email", () => {
    const names = seen.map((response) => response.name);
    for (const name of [
      "/api/auth/request-password-reset",
      "/api/auth/organization/invite-member",
      "oauth-authorization-server",
      "oauth-protected-resource",
      "oauth-protected-resource/api/mcp",
      "/api/mcp",
      "/api/v1/admin/domain",
    ])
      expect(names).toContain(name);
    const texts = [
      ...seen.flatMap((response) => [
        response.body,
        response.headers.get("location") ?? "",
        response.headers.get("www-authenticate") ?? "",
      ]),
      ...mail().map((item) => item.text),
    ];
    const links = texts.flatMap(
      (text) => text.match(/https?:\/\/[^\s"'<>]+/g) ?? [],
    );
    // Eight in the metadata, the MCP 401, the Domain page, the reset redirect and three emails.
    expect(links.length).toBeGreaterThanOrEqual(14);
    for (const link of links)
      expect(
        link === HOSTED_ORIGIN || link.startsWith(`${HOSTED_ORIGIN}/`),
        link,
      ).toBe(true);
    const everything = [
      ...texts,
      ...seen.flatMap((response) => [...response.headers.values()]),
      ...mail().map((item) => item.subject),
    ].join("\n");
    expect(everything).not.toContain(ATTACKER);
    expect(everything).not.toContain(PLAIN_HTTP);
    expect(new Set(sent.map((request) => request.url))).toEqual(
      new Set(["https://api.resend.com/emails"]),
    );
  });
});
