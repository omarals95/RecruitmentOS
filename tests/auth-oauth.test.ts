import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getAuthOptions } from "../src/lib/auth";
import {
  BOOTSTRAP_EMAIL,
  ORIGIN,
  authCaller,
  cookieOf,
  createAuthDb,
  createTestAuth,
  setUpAdmin,
  type Mail,
} from "./helpers/auth";

describe("OAuth provider gating", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["google", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    ["microsoft", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
  ] as const)(
    "exposes %s only when both its client id and secret are set",
    (provider, id, secret) => {
      for (const [idValue, secretValue, expected] of [
        [undefined, undefined, false],
        ["fictional-client-id", undefined, false],
        [undefined, "fictional-client-secret", false],
        ["fictional-client-id", "fictional-client-secret", true],
      ] as const) {
        vi.stubEnv(id, idValue);
        vi.stubEnv(secret, secretValue);
        expect(getAuthOptions()[provider]).toBe(expected);
      }
    },
  );
});

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const MICROSOFT_TOKEN =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MICROSOFT_PHOTO = "https://graph.microsoft.com/v1.0/me/photos/";
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

describe("OAuth sign-in without implicit linking or invitation bypass", () => {
  const mail: Mail[] = [];
  const requested: string[] = [];
  const unexpected: string[] = [];
  let h: Awaited<ReturnType<typeof createAuthDb>>;
  let caller: ReturnType<typeof authCaller>;
  let teamId = "";
  let ownerCookie = "";
  let claims: Record<string, unknown> = {};
  beforeAll(async () => {
    h = await createAuthDb();
    caller = authCaller(
      createTestAuth(h.db, mail, {
        google: {
          clientId: "fictional-google-client",
          clientSecret: "fictional-google-secret",
        },
        microsoft: {
          clientId: "fictional-microsoft-client",
          clientSecret: "fictional-microsoft-secret",
        },
      }),
    );
    ({ cookie: ownerCookie, teamId } = await setUpAdmin(caller, mail));
    // The provider endpoints answer from this in-process stub; any other outbound request fails the suite.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        requested.push(url);
        if (url === GOOGLE_TOKEN || url === MICROSOFT_TOKEN)
          return Response.json({
            access_token: "fictional-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            id_token: `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.fictional-signature`,
          });
        if (url.startsWith(MICROSOFT_PHOTO))
          return new Response(null, { status: 404 });
        unexpected.push(url);
        throw new Error("Unexpected outbound request in a test.");
      }),
    );
  });
  afterEach(() => {
    expect(unexpected).toEqual([]);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await h.pg.close();
  });

  const oauth = async (
    provider: "google" | "microsoft",
    profile: Record<string, unknown>,
  ) => {
    const start = await caller.post("sign-in/social", {
      provider,
      callbackURL: "/app",
    });
    expect(start.status).toBe(200);
    const state = new URL(
      ((await start.json()) as { url: string }).url,
    ).searchParams.get("state");
    claims = profile;
    const sent = requested.length;
    const callback = await caller.get(
      `${ORIGIN}/api/auth/callback/${provider}?code=fictional-code&state=${state}`,
      cookieOf(start),
    );
    expect(unexpected).toEqual([]);
    // The callback really exchanged the code with the (stubbed) provider.
    expect(requested.slice(sent)[0]).toBe(
      provider === "google" ? GOOGLE_TOKEN : MICROSOFT_TOKEN,
    );
    return callback;
  };
  const google = (email: string, emailVerified: boolean) =>
    oauth("google", {
      iss: "https://accounts.google.com",
      aud: "fictional-google-client",
      sub: `fictional-google-${email}`,
      email,
      email_verified: emailVerified,
      name: "Fictional Google person",
    });
  // Microsoft's email claim is not proof of ownership, even when it says so.
  const microsoft = (email: string) =>
    oauth("microsoft", {
      iss: "https://login.microsoftonline.com/fictional-tenant/v2.0",
      tid: "fictional-tenant",
      aud: "fictional-microsoft-client",
      oid: `fictional-microsoft-${email}`,
      email,
      email_verified: true,
      name: "Fictional Microsoft person",
    });
  const rows = async (email: string) => ({
    users: await h.count(`SELECT count(*) FROM auth."user" WHERE email=$1`, [
      email,
    ]),
    providerAccounts: await h.count(
      `SELECT count(*) FROM auth.account a JOIN auth."user" u ON u.id=a.user_id
       WHERE u.email=$1 AND a.provider_id<>'credential'`,
      [email],
    ),
    sessions: await h.count(
      `SELECT count(*) FROM auth.session s JOIN auth."user" u ON u.id=s.user_id WHERE u.email=$1`,
      [email],
    ),
    memberships: await h.count(
      `SELECT count(*) FROM auth.member m JOIN auth."user" u ON u.id=m.user_id WHERE u.email=$1`,
      [email],
    ),
  });
  const invite = async (email: string) => {
    const response = await caller.post(
      "organization/invite-member",
      { organizationId: teamId, email, role: "viewer" },
      { cookie: ownerCookie },
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { id: string }).id;
  };

  it("does not link or sign in an existing verified local account whose email a provider asserts", async () => {
    const before = await rows(BOOTSTRAP_EMAIL);
    expect(before.providerAccounts).toBe(0);
    for (const callback of [
      await google(BOOTSTRAP_EMAIL, true),
      await microsoft(BOOTSTRAP_EMAIL),
    ]) {
      expect(callback.headers.get("location")).toContain(
        "error=account_not_linked",
      );
      expect(cookieOf(callback)).not.toContain("session_token");
    }
    expect(await rows(BOOTSTRAP_EMAIL)).toEqual(before);
  });

  it("creates no user, account or session for an uninvited provider email", async () => {
    for (const callback of [
      await google("stranger-google@example.test", true),
      await microsoft("stranger-microsoft@example.test"),
    ]) {
      expect(callback.ok).toBe(false);
      expect(cookieOf(callback)).not.toContain("session_token");
    }
    for (const email of [
      "stranger-google@example.test",
      "stranger-microsoft@example.test",
    ])
      expect(await rows(email)).toEqual({
        users: 0,
        providerAccounts: 0,
        sessions: 0,
        memberships: 0,
      });
  });

  it("keeps a Microsoft-asserted invited email unverified and unable to accept the invitation", async () => {
    const email = "invited-microsoft@example.test";
    const invitationId = await invite(email);
    const callback = await microsoft(email);
    expect(callback.status).toBe(302);
    expect(
      (
        await h.pg.query(
          `SELECT email_verified FROM auth."user" WHERE email=$1`,
          [email],
        )
      ).rows,
    ).toEqual([{ email_verified: false }]);
    const accepted = await caller.post(
      "organization/accept-invitation",
      { invitationId },
      { cookie: cookieOf(callback) },
    );
    expect(accepted.status).toBe(403);
    expect((await rows(email)).memberships).toBe(0);
  });

  it("gives a user with two-step sign-in no session from the Google callback", async () => {
    const email = "two-step-google@example.test";
    await invite(email);
    const first = await google(email, true);
    expect(first.status).toBe(302);
    expect(cookieOf(first)).toContain("session_token");
    await h.asOwner(
      `UPDATE auth."user" SET two_factor_enabled = true WHERE email = '${email}';`,
    );
    const before = await rows(email);
    const callback = await google(email, true);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain(
      "error=two_step_sign_in_required",
    );
    expect(cookieOf(callback)).not.toContain("session_token");
    expect(await rows(email)).toEqual(before);
  });

  it("keeps a Google-asserted invited email with email_verified false unverified, signed out and unable to accept the invitation", async () => {
    const email = "invited-google@example.test";
    const invitationId = await invite(email);
    const callback = await google(email, false);
    expect(callback.headers.get("location")).toContain("error=");
    expect(
      (
        await h.pg.query(
          `SELECT email_verified FROM auth."user" WHERE email=$1`,
          [email],
        )
      ).rows,
    ).toEqual([{ email_verified: false }]);
    expect((await rows(email)).sessions).toBe(0);
    const accepted = await caller.post(
      "organization/accept-invitation",
      { invitationId },
      { cookie: cookieOf(callback) },
    );
    expect(accepted.ok).toBe(false);
    expect((await rows(email)).memberships).toBe(0);
  });
});
