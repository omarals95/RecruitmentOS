import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => ({ identity: vi.fn(), data: vi.fn() }));
vi.mock("@/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));

import { applyMigrations, schema, type AppDb } from "../src/db";
import CreateAdmin from "../src/app/(auth)/create-admin/page";
import { POST as authRoute } from "../src/app/api/auth/[...all]/route";
import {
  BOOTSTRAP_EMAIL,
  BOOTSTRAP_TOKEN,
  PASSWORD,
  authCaller,
  createAuthDb,
  createTestAuth,
  mailLink,
  resetPattern,
  setUpAdmin,
  verifyPattern,
  type Mail,
} from "./helpers/auth";
import { HOSTED_ORIGIN, stubHostedReadiness } from "./helpers/readiness";

describe("hosted bootstrap setup through getAuth()", () => {
  const pg = new PGlite();
  const sent: { url: string; body: string }[] = [];
  // Every outbound request lands here; nothing reaches Resend or any other host.
  const fetchStub = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), body: String(init?.body) });
      return new Response(JSON.stringify({ id: "fictional" }), { status: 200 });
    },
  );
  beforeAll(async () => {
    await applyMigrations(pg);
    pools.identity.mockResolvedValue(
      drizzle(pg, { schema }) as unknown as AppDb,
    );
    pools.data.mockRejectedValue(
      new Error("Bootstrap setup must not use the data pool."),
    );
    vi.stubGlobal("fetch", fetchStub);
    stubHostedReadiness({
      BOOTSTRAP_OWNER_EMAIL: BOOTSTRAP_EMAIL,
      BOOTSTRAP_SETUP_TOKEN: BOOTSTRAP_TOKEN,
    });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await pg.close();
  });

  it("renders the setup form for an empty identity database", async () => {
    const html = renderToStaticMarkup(await CreateAdmin());
    expect(html).toContain("Create the first administrator");
    expect(html).toContain("<form");
    expect(html).not.toContain("Setup required");
    expect(html).not.toContain("Administrator setup unavailable");
    expect(html).not.toContain("must be configured by the deployment");
    expect(pools.data).not.toHaveBeenCalled();
  });

  it("sends the bootstrap verification link on the BETTER_AUTH_URL origin", async () => {
    const response = await authRoute(
      new Request(`${HOSTED_ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: HOSTED_ORIGIN,
          "x-vercel-forwarded-for": "203.0.113.70",
          "x-bootstrap-token": BOOTSTRAP_TOKEN,
        },
        body: JSON.stringify({
          name: "Fictional Owner",
          email: BOOTSTRAP_EMAIL,
          password: PASSWORD,
          callbackURL: "/sign-in",
        }),
      }),
    );
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent.map((request) => request.url)).toEqual([
      "https://api.resend.com/emails",
    ]);
    const message = JSON.parse(sent[0].body) as {
      from: string;
      to: string[];
      text: string;
    };
    expect(message.to).toEqual([BOOTSTRAP_EMAIL]);
    expect(message.from).toBe(process.env.EMAIL_FROM);
    const link = new URL(message.text.match(verifyPattern)![0]);
    expect(link.origin).toBe(process.env.BETTER_AUTH_URL);
    expect(pools.data).not.toHaveBeenCalled();
  });
});

describe("links and cookies on an https baseURL", () => {
  let close: (() => Promise<void>) | undefined;
  afterAll(async () => close?.());

  it("sets Secure, HttpOnly, SameSite=Lax __Secure- cookies and keeps invitation and reset links on the origin", async () => {
    const h = await createAuthDb();
    close = () => h.pg.close();
    const mail: Mail[] = [];
    const caller = authCaller(
      createTestAuth(h.db, mail, { baseURL: HOSTED_ORIGIN }),
      HOSTED_ORIGIN,
    );
    const { cookie, teamId } = await setUpAdmin(caller, mail);
    expect(new URL(mailLink(mail, BOOTSTRAP_EMAIL, verifyPattern)).origin).toBe(
      HOSTED_ORIGIN,
    );

    const signedIn = await caller.post("sign-in/email", {
      email: BOOTSTRAP_EMAIL,
      password: PASSWORD,
    });
    expect(signedIn.status).toBe(200);
    const cookies = signedIn.headers.getSetCookie();
    expect(cookies.some((c) => c.includes("session_token="))).toBe(true);
    for (const set of cookies) {
      expect(set).toMatch(/^__Secure-/);
      expect(set).toMatch(/;\s*Secure(;|$)/i);
      expect(set).toMatch(/;\s*HttpOnly(;|$)/i);
      expect(set).toMatch(/;\s*SameSite=Lax(;|$)/i);
    }

    const invitee = "invitee@example.test";
    const invited = await caller.post(
      "organization/invite-member",
      { organizationId: teamId, email: invitee, role: "recruiter" },
      { cookie },
    );
    expect(invited.status).toBe(200);
    expect(
      mailLink(mail, invitee, /https?:\/\/\S+\/accept-invitation\S+/),
    ).toMatch(new RegExp(`^${HOSTED_ORIGIN}/accept-invitation\\?id=`));

    const reset = await caller.post("request-password-reset", {
      email: BOOTSTRAP_EMAIL,
      redirectTo: `${HOSTED_ORIGIN}/reset-password`,
    });
    expect(reset.status).toBe(200);
    expect(mailLink(mail, BOOTSTRAP_EMAIL, resetPattern)).toMatch(
      new RegExp(`^${HOSTED_ORIGIN}/api/auth/reset-password/`),
    );
  });
});
