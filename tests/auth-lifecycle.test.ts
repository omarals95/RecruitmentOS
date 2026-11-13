import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_EMAIL,
  BOOTSTRAP_TOKEN,
  ORIGIN,
  PASSWORD,
  addMember,
  authCaller,
  cookieOf,
  createAuthDb,
  createTeam,
  createTestAuth,
  mailLink,
  registerVerified,
  resetPattern,
  setUpAdmin,
  TEST_SECRET,
  verifyPattern,
  type Mail,
} from "./helpers/auth";

type Harness = Awaited<ReturnType<typeof createAuthDb>>;
type Caller = ReturnType<typeof authCaller>;

// Each block gets its own disposable database; flows run as the restricted identity role.
function useAuthDb() {
  const state = {} as {
    h: Harness;
    mail: Mail[];
    caller: Caller;
    open: Caller;
  };
  beforeAll(async () => {
    state.h = await createAuthDb();
    state.mail = [];
    state.caller = authCaller(createTestAuth(state.h.db, state.mail));
    state.open = authCaller(
      createTestAuth(state.h.db, state.mail, { publicSignup: true }),
    );
  });
  afterAll(async () => state.h.pg.close());
  return state;
}

const failOwnerMember = `
  CREATE FUNCTION public.fail_owner_member() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'Fictional owner-member failure'; END $$;
  CREATE TRIGGER fail_owner_member BEFORE INSERT ON auth.member
  FOR EACH ROW EXECUTE FUNCTION public.fail_owner_member();`;
const restoreOwnerMember = `
  DROP TRIGGER fail_owner_member ON auth.member;
  DROP FUNCTION public.fail_owner_member();`;

const userId = async (h: Harness, email: string) =>
  (
    await h.pg.query<{ id: string }>(
      `SELECT id FROM auth."user" WHERE email=$1`,
      [email],
    )
  ).rows[0]?.id;
const emailVerified = async (h: Harness, email: string) =>
  (
    await h.pg.query<{ email_verified: boolean }>(
      `SELECT email_verified FROM auth."user" WHERE email=$1`,
      [email],
    )
  ).rows[0]?.email_verified;
const claimCompletedAt = async (h: Harness) =>
  (
    await h.pg.query<{ completed_at: Date | null }>(
      `SELECT completed_at FROM auth.initial_admin_claim`,
    )
  ).rows[0]?.completed_at;
const owners = async (h: Harness, slug: string) =>
  (
    await h.pg.query<{ email: string; role: string; created_by: string }>(
      `SELECT u.email, m.role, o.created_by FROM auth.organization o
       JOIN auth.member m ON m.organization_id=o.id JOIN auth."user" u ON u.id=m.user_id
       WHERE o.slug=$1`,
      [slug],
    )
  ).rows;

describe("atomic team creation", () => {
  const t = useAuthDb();
  let adminCookie = "";

  it("keeps initial setup pending and other sign-ups blocked when the initial administrator's first owner-member insert fails", async () => {
    adminCookie = await registerVerified(t.caller, t.mail, BOOTSTRAP_EMAIL, {
      bootstrapToken: BOOTSTRAP_TOKEN,
    });
    await t.h.asOwner(failOwnerMember);
    const failed = await t.caller.post(
      "organization/create",
      { name: "Fictional first team", slug: "first-team" },
      { cookie: adminCookie },
    );
    expect(failed.ok).toBe(false);
    expect(
      await t.h.count(
        `SELECT count(*) FROM auth.organization WHERE slug='first-team'`,
      ),
    ).toBe(0);
    expect(await t.h.count(`SELECT count(*) FROM auth.member`)).toBe(0);
    expect(await claimCompletedAt(t.h)).toBeNull();
    expect(
      (await t.caller.session(adminCookie))?.session.activeOrganizationId,
    ).toBeFalsy();
    await t.open.post("sign-up/email", {
      name: "Public person",
      email: "public@example.test",
      password: PASSWORD,
    });
    expect(await userId(t.h, "public@example.test")).toBeUndefined();
  });

  it("completes initial setup when the same team creation is retried after the fault is removed", async () => {
    await t.h.asOwner(restoreOwnerMember);
    const retried = await t.caller.post(
      "organization/create",
      { name: "Fictional first team", slug: "first-team" },
      { cookie: adminCookie },
    );
    expect(retried.status).toBe(200);
    const team = (await retried.json()) as { id: string };
    expect(await owners(t.h, "first-team")).toEqual([
      {
        email: BOOTSTRAP_EMAIL,
        role: "owner",
        created_by: await userId(t.h, BOOTSTRAP_EMAIL),
      },
    ]);
    expect(await claimCompletedAt(t.h)).toBeTruthy();
    expect(
      (await t.caller.session(adminCookie))?.session.activeOrganizationId,
    ).toBe(team.id);
    // The new owner must turn on two-step sign-in before managing the team.
    adminCookie = (await t.caller.enableTwoStep(adminCookie)).cookie;
  });

  it("rolls back a failed owner-member insert without consuming the slug or the creator's five-team allowance", async () => {
    // Only owners and the initial administrator create teams; the creator owns the first team.
    const firstTeam = (
      await t.h.pg.query<{ id: string }>(
        `SELECT id FROM auth.organization WHERE slug='first-team'`,
      )
    ).rows[0].id;
    const { cookie } = await addMember(
      t.caller,
      t.mail,
      adminCookie,
      firstTeam,
      "creator@example.test",
      "owner",
    );
    const creator = await userId(t.h, "creator@example.test");
    await t.h.asOwner(failOwnerMember);
    const failed = await t.caller.post(
      "organization/create",
      { name: "Fictional shared team", slug: "shared-team" },
      { cookie },
    );
    expect(failed.ok).toBe(false);
    expect(
      await t.h.count(
        `SELECT count(*) FROM auth.organization WHERE slug='shared-team'`,
      ),
    ).toBe(0);
    expect(
      await t.h.count(
        `SELECT count(*) FROM auth.organization WHERE created_by=$1`,
        [creator],
      ),
    ).toBe(0);
    await t.h.asOwner(restoreOwnerMember);
    const retried = await t.caller.post(
      "organization/create",
      { name: "Fictional shared team", slug: "shared-team" },
      { cookie },
    );
    expect(retried.status).toBe(200);
    expect(
      await t.h.count(
        `SELECT count(*) FROM auth.organization WHERE slug='shared-team'`,
      ),
    ).toBe(1);
    expect(await owners(t.h, "shared-team")).toEqual([
      { email: "creator@example.test", role: "owner", created_by: creator },
    ]);
    // The failed attempt left the full allowance: four more teams fit, the sixth does not.
    for (const slug of ["second", "third", "fourth", "fifth"])
      await createTeam(t.caller, cookie, `shared-${slug}`);
    const sixth = await t.caller.post(
      "organization/create",
      { name: "Fictional sixth team", slug: "shared-sixth" },
      { cookie },
    );
    expect(sixth.status).toBe(403);
  });
});

describe("bootstrap race through the handler", () => {
  const t = useAuthDb();

  it("creates exactly one initial administrator and claim from simultaneous bootstrap sign-ups, and no other user while setup is pending", async () => {
    const owner = {
      name: "Owner",
      email: BOOTSTRAP_EMAIL,
      password: PASSWORD,
      callbackURL: "/sign-in",
    };
    const results = await Promise.allSettled([
      t.caller.post("sign-up/email", owner, {
        bootstrapToken: BOOTSTRAP_TOKEN,
      }),
      t.caller.post("sign-up/email", owner, {
        bootstrapToken: BOOTSTRAP_TOKEN,
      }),
      t.open.post("sign-up/email", {
        name: "Public person",
        email: "public@example.test",
        password: PASSWORD,
      }),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await t.h.count(`SELECT count(*) FROM auth."user"`)).toBe(1);
    expect(
      await t.h.count(`SELECT count(*) FROM auth.initial_admin_claim`),
    ).toBe(1);
    expect(
      (
        await t.h.pg.query(
          `SELECT u.email, u.initial_admin FROM auth."user" u JOIN auth.initial_admin_claim c ON c.user_id=u.id`,
        )
      ).rows,
    ).toEqual([{ email: BOOTSTRAP_EMAIL, initial_admin: true }]);
  });
});

describe("auth rate limits", () => {
  const t = useAuthDb();
  beforeAll(async () => {
    const { cookie, teamId } = await setUpAdmin(t.caller, t.mail);
    expect(
      (
        await t.caller.post(
          "organization/invite-member",
          {
            organizationId: teamId,
            email: "unverified@example.test",
            role: "viewer",
          },
          { cookie },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await t.caller.post("sign-up/email", {
          name: "Unverified person",
          email: "unverified@example.test",
          password: PASSWORD,
          callbackURL: "/sign-in",
        })
      ).status,
    ).toBe(200);
  });

  it("refuses the 11th sign-in from one client within the window while another client keeps its budget", async () => {
    const ip = "198.51.100.11";
    for (let attempt = 0; attempt < 10; attempt++)
      expect(
        (
          await t.caller.post(
            "sign-in/email",
            // A different address each time stays under the per-email backoff.
            {
              email: `rate-limit-${attempt}@example.test`,
              password: "wrong-fictional-password",
            },
            { ip },
          )
        ).status,
      ).toBe(401);
    expect(
      (
        await t.caller.post(
          "sign-in/email",
          { email: BOOTSTRAP_EMAIL, password: PASSWORD },
          { ip },
        )
      ).status,
    ).toBe(429);
    expect(
      (
        await t.caller.post(
          "sign-in/email",
          { email: BOOTSTRAP_EMAIL, password: PASSWORD },
          { ip: "198.51.100.12" },
        )
      ).status,
    ).toBe(200);
  });

  it("refuses the 6th sign-up from one client within the window while another client keeps its budget", async () => {
    const ip = "198.51.100.21";
    const signUp = (n: number, from: string) =>
      t.caller.post(
        "sign-up/email",
        {
          name: "Uninvited",
          email: `uninvited-${n}@example.test`,
          password: PASSWORD,
        },
        { ip: from },
      );
    for (let attempt = 0; attempt < 5; attempt++)
      expect((await signUp(attempt, ip)).status).toBe(200);
    expect((await signUp(5, ip)).status).toBe(429);
    expect((await signUp(6, "198.51.100.22")).status).toBe(200);
  });

  it("refuses the 4th password-reset request from one client without sending mail while another client keeps its budget", async () => {
    const ip = "198.51.100.31";
    const reset = (from: string) =>
      t.caller.post(
        "request-password-reset",
        { email: BOOTSTRAP_EMAIL, redirectTo: `${ORIGIN}/reset-password` },
        { ip: from },
      );
    const before = t.mail.length;
    for (let attempt = 0; attempt < 3; attempt++)
      expect((await reset(ip)).status).toBe(200);
    expect(t.mail.length).toBe(before + 3);
    expect((await reset(ip)).status).toBe(429);
    expect(t.mail.length).toBe(before + 3);
    expect((await reset("198.51.100.32")).status).toBe(200);
    expect(t.mail.length).toBe(before + 4);
  });

  it("refuses the 4th verification resend from one client without sending mail while another client keeps its budget", async () => {
    const ip = "198.51.100.41";
    const resend = (from: string) =>
      t.caller.post(
        "send-verification-email",
        { email: "unverified@example.test", callbackURL: "/sign-in" },
        { ip: from },
      );
    const before = t.mail.length;
    for (let attempt = 0; attempt < 3; attempt++)
      expect((await resend(ip)).status).toBe(200);
    expect(t.mail.length).toBe(before + 3);
    expect((await resend(ip)).status).toBe(429);
    expect(t.mail.length).toBe(before + 3);
    expect((await resend("198.51.100.42")).status).toBe(200);
    expect(t.mail.length).toBe(before + 4);
  });

  it("stores each limiter key only as a keyed hash, never the client address or path", async () => {
    const ip = "198.51.100.51";
    for (let attempt = 0; attempt < 10; attempt++)
      expect(
        (
          await t.caller.post(
            "sign-in/email",
            // A different address each time stays under the per-email backoff.
            {
              email: `rate-limit-${attempt}@example.test`,
              password: "wrong-fictional-password",
            },
            { ip },
          )
        ).status,
      ).toBe(401);
    const refused = await t.caller.post(
      "sign-in/email",
      { email: BOOTSTRAP_EMAIL, password: PASSWORD },
      { ip },
    );
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("x-retry-after"))).toBeGreaterThan(0);
    expect(Number(refused.headers.get("x-retry-after"))).toBeLessThanOrEqual(
      60,
    );
    const keys = (
      await t.h.pg.query<{ key: string; count: number }>(
        "SELECT key, count FROM auth.rate_limit",
      )
    ).rows;
    expect(keys.length).toBeGreaterThan(0);
    for (const { key } of keys) {
      expect(key).toMatch(/^ba:[A-Za-z0-9_-]{43}$/);
      for (const raw of ["198.51.100.", "sign-in", "sign-up", "|"])
        expect(key).not.toContain(raw);
    }
    const derived = createHmac("sha256", TEST_SECRET)
      .update("recruitmentos:rate-limit-key:v1")
      .digest();
    const expected = `ba:${createHmac("sha256", derived).update(`${ip}|/sign-in/email`).digest("base64url")}`;
    // The refused attempt leaves the window unchanged and marks it at max + 1.
    expect(keys.find((row) => row.key === expected)?.count).toBe(11);
  });
});

describe("expired, reused and tampered links", () => {
  const t = useAuthDb();
  const email = "link@example.test";
  let link = "";
  beforeAll(async () => {
    const { cookie, teamId } = await setUpAdmin(t.caller, t.mail);
    await t.caller.post(
      "organization/invite-member",
      { organizationId: teamId, email, role: "viewer" },
      { cookie },
    );
    expect(
      (
        await t.caller.post("sign-up/email", {
          name: "Link person",
          email,
          password: PASSWORD,
          callbackURL: "/sign-in",
        })
      ).status,
    ).toBe(200);
    link = mailLink(t.mail, email, verifyPattern);
  });
  const sessions = async () =>
    t.h.count(
      `SELECT count(*) FROM auth.session s JOIN auth."user" u ON u.id=s.user_id WHERE u.email=$1`,
      [email],
    );
  const errorOf = (response: Response) =>
    new URL(response.headers.get("location")!, ORIGIN).searchParams.get(
      "error",
    );

  it("redirects an expired verification link with an error and leaves the account unverified", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Better Auth's default verification expiry is one hour.
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
      const response = await t.caller.get(link);
      expect(response.status).toBe(302);
      expect(errorOf(response)).toBe("TOKEN_EXPIRED");
    } finally {
      vi.useRealTimers();
    }
    expect(await emailVerified(t.h, email)).toBe(false);
  });

  it("redirects a tampered verification link with an error and leaves the account unverified", async () => {
    const url = new URL(link);
    const [header, payload, signature] = url.searchParams
      .get("token")!
      .split(".");
    const flipped = signature[10] === "A" ? "B" : "A";
    url.searchParams.set(
      "token",
      `${header}.${payload}.${signature.slice(0, 10)}${flipped}${signature.slice(11)}`,
    );
    const response = await t.caller.get(url.href);
    expect(response.status).toBe(302);
    expect(errorOf(response)).toBe("INVALID_TOKEN");
    expect(await emailVerified(t.h, email)).toBe(false);
  });

  it("creates no session and changes nothing when a consumed verification link is reused", async () => {
    expect((await t.caller.get(link)).status).toBe(302);
    expect(await emailVerified(t.h, email)).toBe(true);
    const before = (
      await t.h.pg.query(`SELECT * FROM auth."user" WHERE email=$1`, [email])
    ).rows;
    const reused = await t.caller.get(link);
    expect(reused.status).toBeLessThan(400);
    expect(cookieOf(reused)).not.toContain("session_token");
    expect(await sessions()).toBe(0);
    expect(
      (await t.h.pg.query(`SELECT * FROM auth."user" WHERE email=$1`, [email]))
        .rows,
    ).toEqual(before);
  });

  const requestReset = async () => {
    expect(
      (
        await t.caller.post("request-password-reset", {
          email,
          redirectTo: `${ORIGIN}/reset-password`,
        })
      ).status,
    ).toBe(200);
    return new URL(mailLink(t.mail, email, resetPattern)).pathname
      .split("/")
      .at(-1)!;
  };
  const signInStatus = async (password: string) =>
    (await t.caller.post("sign-in/email", { email, password })).status;

  it("refuses a reused reset token and the second password never works", async () => {
    const token = await requestReset();
    expect(
      (
        await t.caller.post("reset-password", {
          token,
          newPassword: "first-new-fictional-password",
        })
      ).status,
    ).toBe(200);
    const reused = await t.caller.post("reset-password", {
      token,
      newPassword: "second-new-fictional-password",
    });
    expect(reused.ok).toBe(false);
    expect(await signInStatus("second-new-fictional-password")).toBe(401);
    expect(await signInStatus("first-new-fictional-password")).toBe(200);
  });

  it("refuses an expired reset token and leaves the password unchanged", async () => {
    const token = await requestReset();
    await t.h.pg.query(
      `UPDATE auth.verification SET expires_at=now()-interval '1 minute' WHERE value=$1`,
      [await userId(t.h, email)],
    );
    const expired = await t.caller.post("reset-password", {
      token,
      newPassword: "expired-new-fictional-password",
    });
    expect(expired.ok).toBe(false);
    expect(await signInStatus("expired-new-fictional-password")).toBe(401);
    expect(await signInStatus("first-new-fictional-password")).toBe(200);
  });
});

describe("reset and callback links stay in their environment", () => {
  const t = useAuthDb();
  const environments = [
    "https://preview.example.test",
    "https://app.example.test",
  ];
  const callers = new Map<string, Caller>();
  beforeAll(async () => {
    for (const origin of environments)
      callers.set(
        origin,
        authCaller(createTestAuth(t.h.db, t.mail, { baseURL: origin }), origin),
      );
    await registerVerified(
      callers.get(environments[0])!,
      t.mail,
      BOOTSTRAP_EMAIL,
      {
        bootstrapToken: BOOTSTRAP_TOKEN,
      },
    );
  });

  it.each(
    environments.map((origin, index) => [origin, environments[1 - index]]),
  )(
    "%s issues reset links only to its own origin and refuses redirects or callbacks to %s",
    async (origin, other) => {
      const caller = callers.get(origin)!;
      const before = t.mail.length;
      expect(
        (
          await caller.post("request-password-reset", {
            email: BOOTSTRAP_EMAIL,
            redirectTo: `${origin}/reset-password`,
          })
        ).status,
      ).toBe(200);
      const link = new URL(
        mailLink(t.mail.slice(before), BOOTSTRAP_EMAIL, resetPattern),
      );
      expect(link.origin).toBe(origin);
      expect(new URL(link.searchParams.get("callbackURL")!).origin).toBe(
        origin,
      );
      const sent = t.mail.length;
      expect(
        (
          await caller.post("request-password-reset", {
            email: BOOTSTRAP_EMAIL,
            redirectTo: `${other}/reset-password`,
          })
        ).status,
      ).toBe(403);
      const crossEmail = `cross-${new URL(origin).hostname}@example.test`;
      expect(
        (
          await caller.post("sign-up/email", {
            name: "Cross environment",
            email: crossEmail,
            password: PASSWORD,
            callbackURL: `${other}/sign-in`,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await caller.post("send-verification-email", {
            email: BOOTSTRAP_EMAIL,
            callbackURL: `${other}/sign-in`,
          })
        ).status,
      ).toBe(403);
      expect(t.mail.length).toBe(sent);
      expect(await userId(t.h, crossEmail)).toBeUndefined();
    },
  );
});

describe("enumeration-safe responses", () => {
  const t = useAuthDb();
  beforeAll(async () => {
    const { cookie, teamId } = await setUpAdmin(t.caller, t.mail);
    await t.caller.post(
      "organization/invite-member",
      {
        organizationId: teamId,
        email: "unverified@example.test",
        role: "viewer",
      },
      { cookie },
    );
    await t.caller.post("sign-up/email", {
      name: "Unverified person",
      email: "unverified@example.test",
      password: PASSWORD,
      callbackURL: "/sign-in",
    });
  });
  const respond = async (path: string, body: unknown) => {
    const response = await t.caller.post(path, body);
    return { status: response.status, body: await response.json() };
  };

  it("answers a password-reset request identically for an existing and an unknown address, mailing only the account", async () => {
    const before = t.mail.length;
    const existing = await respond("request-password-reset", {
      email: BOOTSTRAP_EMAIL,
      redirectTo: `${ORIGIN}/reset-password`,
    });
    const unknown = await respond("request-password-reset", {
      email: "nobody@example.test",
      redirectTo: `${ORIGIN}/reset-password`,
    });
    expect(existing.status).toBe(200);
    expect(unknown).toEqual(existing);
    expect(t.mail.slice(before).map((message) => message.to)).toEqual([
      BOOTSTRAP_EMAIL,
    ]);
  });

  it("answers a signed-out verification resend identically for unverified, verified and unknown addresses, mailing only the unverified account", async () => {
    const before = t.mail.length;
    const results = [];
    for (const email of [
      "unverified@example.test",
      BOOTSTRAP_EMAIL,
      "nobody@example.test",
    ])
      results.push(
        await respond("send-verification-email", {
          email,
          callbackURL: "/sign-in",
        }),
      );
    expect(results[0].status).toBe(200);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(t.mail.slice(before).map((message) => message.to)).toEqual([
      "unverified@example.test",
    ]);
  });

  it("answers sign-up identically for an existing account and an uninvited address without creating users or mail", async () => {
    const before = t.mail.length;
    const users = await t.h.count(`SELECT count(*) FROM auth."user"`);
    const existing = await respond("sign-up/email", {
      name: "Existing",
      email: BOOTSTRAP_EMAIL,
      password: "another-fictional-password",
    });
    const uninvited = await respond("sign-up/email", {
      name: "Uninvited",
      email: "stranger@example.test",
      password: "another-fictional-password",
    });
    const keys = (body: Record<string, unknown>) =>
      Object.keys(body)
        .sort()
        .map((key) =>
          body[key] && typeof body[key] === "object"
            ? `${key}:${Object.keys(body[key]).sort().join(",")}`
            : key,
        );
    expect(existing.status).toBe(200);
    expect(uninvited.status).toBe(existing.status);
    expect(keys(uninvited.body)).toEqual(keys(existing.body));
    expect(await t.h.count(`SELECT count(*) FROM auth."user"`)).toBe(users);
    expect(t.mail.length).toBe(before);
  });

  it("answers sign-in identically for an unknown address and a wrong password", async () => {
    const unknown = await respond("sign-in/email", {
      email: "nobody@example.test",
      password: PASSWORD,
    });
    const wrong = await respond("sign-in/email", {
      email: BOOTSTRAP_EMAIL,
      password: "wrong-fictional-password",
    });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(unknown.status);
    expect(wrong.body.code).toBe(unknown.body.code);
  });
});

describe("sign-out and session revocation", () => {
  const t = useAuthDb();
  let kept = "";
  beforeAll(async () => {
    kept = await registerVerified(t.caller, t.mail, BOOTSTRAP_EMAIL, {
      bootstrapToken: BOOTSTRAP_TOKEN,
    });
  });
  const tokenOf = (cookie: string) =>
    decodeURIComponent(cookie.match(/session_token=([^;]+)/)![1]).split(".")[0];

  it("signing out revokes that session only", async () => {
    const revoked = await t.caller.signIn(BOOTSTRAP_EMAIL);
    expect(await t.caller.session(revoked)).not.toBeNull();
    expect(
      (await t.caller.post("sign-out", {}, { cookie: revoked })).status,
    ).toBe(200);
    expect(await t.caller.session(revoked)).toBeNull();
    expect(await t.caller.session(kept)).not.toBeNull();
  });

  it("revoking another session by token stops that session only", async () => {
    const revoked = await t.caller.signIn(BOOTSTRAP_EMAIL);
    expect(
      (
        await t.caller.post(
          "revoke-session",
          { token: tokenOf(revoked) },
          { cookie: kept },
        )
      ).status,
    ).toBe(200);
    expect(await t.caller.session(revoked)).toBeNull();
    expect(await t.caller.session(kept)).not.toBeNull();
  });

  it("revoking other sessions keeps only the caller's session", async () => {
    const revoked = [
      await t.caller.signIn(BOOTSTRAP_EMAIL),
      await t.caller.signIn(BOOTSTRAP_EMAIL),
    ];
    expect(
      (await t.caller.post("revoke-other-sessions", {}, { cookie: kept }))
        .status,
    ).toBe(200);
    for (const cookie of revoked)
      expect(await t.caller.session(cookie)).toBeNull();
    expect(await t.caller.session(kept)).not.toBeNull();
  });

  it("changing the password with revokeOtherSessions revokes every earlier session and keeps the new one", async () => {
    const other = await t.caller.signIn(BOOTSTRAP_EMAIL);
    const changed = await t.caller.post(
      "change-password",
      {
        currentPassword: PASSWORD,
        newPassword: "changed-fictional-password",
        revokeOtherSessions: true,
      },
      { cookie: kept },
    );
    expect(changed.status).toBe(200);
    const renewed = cookieOf(changed);
    expect(await t.caller.session(other)).toBeNull();
    expect(await t.caller.session(kept)).toBeNull();
    expect(await t.caller.session(renewed)).not.toBeNull();
  });
});

describe("expired and revoked invitations", () => {
  const t = useAuthDb();
  let ownerCookie = "";
  let teamId = "";
  const invite = async (email: string) => {
    const response = await t.caller.post(
      "organization/invite-member",
      { organizationId: teamId, email, role: "viewer" },
      { cookie: ownerCookie },
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { id: string }).id;
  };
  const cancel = async (invitationId: string) =>
    expect(
      (
        await t.caller.post(
          "organization/cancel-invitation",
          { invitationId },
          { cookie: ownerCookie },
        )
      ).status,
    ).toBe(200);
  const expire = (invitationId: string) =>
    t.h.pg.query(
      `UPDATE auth.invitation SET expires_at=now()-interval '1 minute' WHERE id=$1`,
      [invitationId],
    );
  const memberships = (email: string) =>
    t.h.count(
      `SELECT count(*) FROM auth.member m JOIN auth."user" u ON u.id=m.user_id WHERE u.email=$1`,
      [email],
    );
  beforeAll(async () => {
    ({ cookie: ownerCookie, teamId } = await setUpAdmin(t.caller, t.mail));
  });

  it("refuses to accept a cancelled invitation and adds no member", async () => {
    const email = "cancelled@example.test";
    const invitationId = await invite(email);
    const cookie = await registerVerified(t.caller, t.mail, email);
    await cancel(invitationId);
    const accepted = await t.caller.post(
      "organization/accept-invitation",
      { invitationId },
      { cookie },
    );
    expect(accepted.ok).toBe(false);
    expect(await memberships(email)).toBe(0);
  });

  it("refuses to accept an expired invitation and adds no member", async () => {
    const email = "expired@example.test";
    const invitationId = await invite(email);
    const cookie = await registerVerified(t.caller, t.mail, email);
    await expire(invitationId);
    const accepted = await t.caller.post(
      "organization/accept-invitation",
      { invitationId },
      { cookie },
    );
    expect(accepted.ok).toBe(false);
    expect(await memberships(email)).toBe(0);
  });

  it("does not let a cancelled or an expired invitation register its address", async () => {
    await cancel(await invite("cancelled-new@example.test"));
    await expire(await invite("expired-new@example.test"));
    for (const email of [
      "cancelled-new@example.test",
      "expired-new@example.test",
    ]) {
      await t.caller.post("sign-up/email", {
        name: "Former invitee",
        email,
        password: PASSWORD,
      });
      expect(await userId(t.h, email)).toBeUndefined();
    }
  });
});

describe("admins cannot take or change ownership", () => {
  const t = useAuthDb();
  let teamId = "";
  let ownerMember = "";
  let admin = { cookie: "", memberId: "" };
  let recruiter = { cookie: "", memberId: "" };
  let roles: unknown[] = [];
  const currentRoles = async () =>
    (
      await t.h.pg.query(
        `SELECT id, role FROM auth.member WHERE organization_id=$1 ORDER BY id`,
        [teamId],
      )
    ).rows;
  beforeAll(async () => {
    const setup = await setUpAdmin(t.caller, t.mail);
    teamId = setup.teamId;
    admin = await addMember(
      t.caller,
      t.mail,
      setup.cookie,
      teamId,
      "team-admin@example.test",
      "admin",
    );
    recruiter = await addMember(
      t.caller,
      t.mail,
      setup.cookie,
      teamId,
      "team-recruiter@example.test",
      "recruiter",
    );
    ownerMember = (
      await t.h.pg.query<{ id: string }>(
        `SELECT id FROM auth.member WHERE organization_id=$1 AND role='owner'`,
        [teamId],
      )
    ).rows[0].id;
    roles = await currentRoles();
  });
  const asAdmin = (path: string, body: Record<string, unknown>) =>
    t.caller.post(
      `organization/${path}`,
      { organizationId: teamId, ...body },
      { cookie: admin.cookie },
    );

  it("refuses an admin promoting themselves to owner, including with an array role", async () => {
    expect(
      (
        await asAdmin("update-member-role", {
          memberId: admin.memberId,
          role: "owner",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await asAdmin("update-member-role", {
          memberId: admin.memberId,
          role: ["owner"],
        })
      ).status,
    ).toBe(400);
    expect(await currentRoles()).toEqual(roles);
  });

  it("refuses an admin promoting another member to owner", async () => {
    expect(
      (
        await asAdmin("update-member-role", {
          memberId: recruiter.memberId,
          role: "owner",
        })
      ).status,
    ).toBe(403);
    expect(await currentRoles()).toEqual(roles);
  });

  it("refuses an admin demoting or removing an owner, by member id or email", async () => {
    expect(
      (
        await asAdmin("update-member-role", {
          memberId: ownerMember,
          role: "admin",
        })
      ).status,
    ).toBe(403);
    expect(
      (await asAdmin("remove-member", { memberIdOrEmail: ownerMember })).status,
    ).toBe(403);
    expect(
      (await asAdmin("remove-member", { memberIdOrEmail: BOOTSTRAP_EMAIL }))
        .status,
    ).toBe(403);
    expect(await currentRoles()).toEqual(roles);
  });

  it("refuses an admin inviting anyone as owner", async () => {
    expect(
      (
        await asAdmin("invite-member", {
          email: "would-be-owner@example.test",
          role: "owner",
        })
      ).status,
    ).toBe(403);
    expect(
      await t.h.count(
        `SELECT count(*) FROM auth.invitation WHERE email='would-be-owner@example.test'`,
      ),
    ).toBe(0);
    expect(await currentRoles()).toEqual(roles);
  });
});

describe("concurrent last-owner changes", () => {
  const t = useAuthDb();
  let a = { cookie: "", memberId: "" };
  let b = { cookie: "", memberId: "" };
  let removalTeam = "";
  let demotionTeam = "";
  let demotion = { a: "", b: "" };
  const ownerCount = (organizationId: string) =>
    t.h.count(
      `SELECT count(*) FROM auth.member WHERE organization_id=$1 AND role='owner'`,
      [organizationId],
    );
  beforeAll(async () => {
    const setup = await setUpAdmin(t.caller, t.mail);
    removalTeam = setup.teamId;
    a = {
      cookie: setup.cookie,
      memberId: (
        await t.h.pg.query<{ id: string }>(
          `SELECT id FROM auth.member WHERE organization_id=$1`,
          [removalTeam],
        )
      ).rows[0].id,
    };
    b = await addMember(
      t.caller,
      t.mail,
      a.cookie,
      removalTeam,
      "second-owner@example.test",
      "owner",
    );
    demotionTeam = (await createTeam(t.caller, a.cookie, "demotion-team")).id;
    const invite = await t.caller.post(
      "organization/invite-member",
      {
        organizationId: demotionTeam,
        email: "second-owner@example.test",
        role: "owner",
      },
      { cookie: a.cookie },
    );
    const accepted = await t.caller.post(
      "organization/accept-invitation",
      { invitationId: ((await invite.json()) as { id: string }).id },
      { cookie: b.cookie },
    );
    expect(accepted.status).toBe(200);
    const rows = (
      await t.h.pg.query<{ id: string; email: string }>(
        `SELECT m.id, u.email FROM auth.member m JOIN auth."user" u ON u.id=m.user_id WHERE m.organization_id=$1`,
        [demotionTeam],
      )
    ).rows;
    demotion = {
      a: rows.find((row) => row.email === BOOTSTRAP_EMAIL)!.id,
      b: rows.find((row) => row.email === "second-owner@example.test")!.id,
    };
    expect(await ownerCount(removalTeam)).toBe(2);
    expect(await ownerCount(demotionTeam)).toBe(2);
  });

  it("keeps an owner when two owners remove each other simultaneously", async () => {
    const results = await Promise.all([
      t.caller.post(
        "organization/remove-member",
        { organizationId: removalTeam, memberIdOrEmail: b.memberId },
        { cookie: a.cookie },
      ),
      t.caller.post(
        "organization/remove-member",
        { organizationId: removalTeam, memberIdOrEmail: a.memberId },
        { cookie: b.cookie },
      ),
    ]);
    expect(await ownerCount(removalTeam)).toBeGreaterThanOrEqual(1);
    expect(
      results.filter((response) => response.ok).length,
    ).toBeLessThanOrEqual(1);
  });

  it("keeps an owner when two owners demote each other simultaneously", async () => {
    const results = await Promise.all([
      t.caller.post(
        "organization/update-member-role",
        { organizationId: demotionTeam, memberId: demotion.b, role: "admin" },
        { cookie: a.cookie },
      ),
      t.caller.post(
        "organization/update-member-role",
        { organizationId: demotionTeam, memberId: demotion.a, role: "admin" },
        { cookie: b.cookie },
      ),
    ]);
    expect(await ownerCount(demotionTeam)).toBeGreaterThanOrEqual(1);
    expect(
      results.filter((response) => response.ok).length,
    ).toBeLessThanOrEqual(1);
  });
});
