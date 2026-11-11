import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Only the company authority gate describe routes these; the others never call them.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({
  getSession: vi.fn(),
  getVerifiedSession: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

import type { AppDb } from "../src/db";
import { authTables } from "../src/db/auth-schema";
import { createAuth } from "../src/lib/auth";
import { getSession, getVerifiedSession } from "../src/lib/auth-session";
import { changeTeamRole } from "../src/lib/member-roles";
import { requirePrincipal } from "../src/lib/principal";
import { getWorkspaceContext } from "../src/lib/workspace";
import {
  addMember,
  applyWorkspaceSchema,
  authCaller,
  createAuthDb,
  createTeam,
  createTestAuth,
  setUpAdmin,
  type Mail,
} from "./helpers/auth";
import { createSplitRoleDb } from "./helpers/db";

describe("Better Auth verified invite-only flows", () => {
  const pg = new PGlite();
  const db = drizzle(pg, { schema: authTables }) as unknown as AppDb;
  const mail: Array<{ to: string; subject: string; text: string }> = [];
  let ownerCookie = "";
  let teamId = "";
  let invitationId = "";
  const auth = createAuth(db, {
    baseURL: "http://localhost:3000",
    secret: "fictional-test-secret-with-at-least-32-characters",
    bootstrapOwnerEmail: "owner@example.test",
    bootstrapSetupToken: "fictional-bootstrap-secret-0123456789abcdefghi",
    publicSignup: false,
    deliver: async (message) => {
      mail.push(message);
    },
  });
  const call = (
    path: string,
    body: unknown,
    cookie?: string,
    bootstrapToken?: string,
  ) =>
    auth.handler(
      new Request(`http://localhost:3000/api/auth/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          ...(cookie ? { cookie } : {}),
          ...(bootstrapToken ? { "x-bootstrap-token": bootstrapToken } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  // Every migration: the two-step gate reads company authority for the invited recruiter.
  beforeAll(async () => {
    const grants = await applyWorkspaceSchema(pg, "identity_flow_runtime");
    await pg.exec(`
          CREATE ROLE identity_flow_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
          GRANT USAGE ON SCHEMA auth TO identity_flow_runtime;
          GRANT SELECT ON auth.initial_admin_claim TO identity_flow_runtime;
          GRANT SELECT,INSERT,UPDATE,DELETE ON auth."user",auth.organization,auth.session,auth.account,auth.verification,auth.two_factor,auth.member,auth.invitation,auth.rate_limit,auth.api_tokens,auth.api_rate_limits TO identity_flow_runtime;${grants}
          SET ROLE identity_flow_runtime;
        `);
  });
  afterAll(async () => pg.close());
  it("executes the identity flow under a restricted nonowner role", async () => {
    const result = await pg.query<{
      role_name: string;
      owner: boolean;
      marker_write: boolean;
    }>(`SELECT current_user AS role_name,
      pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid='auth.initial_admin_claim'::regclass), 'MEMBER') AS owner,
      has_table_privilege(current_user, 'auth.initial_admin_claim', 'INSERT,UPDATE,DELETE') AS marker_write`);
    expect(result.rows[0]).toEqual({
      role_name: "identity_flow_runtime",
      owner: false,
      marker_write: false,
    });
  });
  it("rejects an unsolicited signup", async () => {
    const response = await call("sign-up/email", {
      name: "Uninvited",
      email: "uninvited@example.test",
      password: "a-long-test-password",
    });
    // Better Auth deliberately returns a synthetic success for rejected registrations to prevent enumeration.
    expect(response.status).toBe(200);
    expect((await pg.query(`SELECT id FROM auth."user"`)).rows).toHaveLength(0);
    expect(mail).toHaveLength(0);
  });
  it("rejects bootstrap signup without the secret or with the wrong secret", async () => {
    for (const secret of [
      undefined,
      "incorrect-bootstrap-secret-0123456789abcdef",
    ]) {
      await call(
        "sign-up/email",
        {
          name: "Impostor",
          email: "owner@example.test",
          password: "a-long-test-password",
        },
        undefined,
        secret,
      );
      expect((await pg.query(`SELECT id FROM auth."user"`)).rows).toHaveLength(
        0,
      );
      expect(
        (await pg.query(`SELECT id FROM auth.initial_admin_claim`)).rows,
      ).toHaveLength(0);
    }
    expect(mail).toHaveLength(0);
    await call(
      "sign-up/email",
      {
        name: "Wrong address",
        email: "wrong@example.test",
        password: "a-long-test-password",
      },
      undefined,
      "fictional-bootstrap-secret-0123456789abcdefghi",
    );
    expect((await pg.query(`SELECT id FROM auth."user"`)).rows).toHaveLength(0);
    await pg.exec(`DELETE FROM auth.rate_limit`);
  });
  it("rejects cross-origin initial setup before creating an account", async () => {
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://untrusted.example.test",
          "x-bootstrap-token": "fictional-bootstrap-secret-0123456789abcdefghi",
        },
        body: JSON.stringify({
          name: "Owner",
          email: "owner@example.test",
          password: "a-long-test-password",
        }),
      }),
    );
    expect(response.status).toBe(403);
    expect((await pg.query(`SELECT id FROM auth."user"`)).rows).toHaveLength(0);
    expect(
      (await pg.query(`SELECT id FROM auth.initial_admin_claim`)).rows,
    ).toHaveLength(0);
    await pg.exec(`DELETE FROM auth.rate_limit`);
  });
  it("creates a bootstrap account but blocks sign-in before verification", async () => {
    expect(
      (
        await call(
          "sign-up/email",
          {
            name: "Owner",
            email: "owner@example.test",
            password: "a-long-test-password",
            callbackURL: "/app",
          },
          undefined,
          "fictional-bootstrap-secret-0123456789abcdefghi",
        )
      ).status,
    ).toBe(200);
    expect(
      mail.some(
        (message) =>
          message.to === "owner@example.test" &&
          message.subject.includes("Verify"),
      ),
    ).toBe(true);
    expect(
      (await pg.query(`SELECT id FROM auth.initial_admin_claim`)).rows,
    ).toHaveLength(1);
    expect(
      (
        await pg.query(
          `SELECT initial_admin FROM auth."user" WHERE email='owner@example.test'`,
        )
      ).rows[0],
    ).toMatchObject({ initial_admin: true });
    expect(
      (
        await call("sign-in/email", {
          email: "owner@example.test",
          password: "a-long-test-password",
        })
      ).status,
    ).toBe(403);
    expect((await pg.query("SELECT id FROM auth.session")).rows).toHaveLength(
      0,
    );
  });
  it("verifies the emailed link then creates a working database session", async () => {
    const verification = mail.find((message) =>
      message.subject.includes("Verify"),
    )!;
    const link = verification.text.match(
      /http:\/\/localhost:3000\/api\/auth\/verify-email[^\s]+/,
    )?.[0];
    expect(link).toBeTruthy();
    const verify = await auth.handler(new Request(link!));
    expect([200, 302]).toContain(verify.status);
    const response = await call("sign-in/email", {
      email: "owner@example.test",
      password: "a-long-test-password",
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie");
    ownerCookie = cookie!;
    expect(cookie).toContain("HttpOnly");
    expect(
      (
        await auth.api.getSession({
          headers: new Headers({ cookie: cookie! }),
          query: { disableCookieCache: true },
        })
      )?.user.emailVerified,
    ).toBe(true);
  });
  it("blocks another public account while the verified administrator still has no owner team", async () => {
    expect(
      (await pg.query(`SELECT completed_at FROM auth.initial_admin_claim`))
        .rows[0],
    ).toMatchObject({ completed_at: null });
    const openAuth = createAuth(db, {
      baseURL: "http://localhost:3000",
      secret: "fictional-test-secret-with-at-least-32-characters",
      bootstrapOwnerEmail: "owner@example.test",
      bootstrapSetupToken: "fictional-bootstrap-secret-0123456789abcdefghi",
      publicSignup: true,
      deliver: async () => {},
    });
    await pg.exec(`DELETE FROM auth.rate_limit`);
    await openAuth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          name: "Other",
          email: "other@example.test",
          password: "another-long-password",
          initialAdmin: true,
          emailVerified: true,
        }),
      }),
    );
    expect(
      (
        await pg.query(
          `SELECT id FROM auth."user" WHERE email='other@example.test'`,
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (await pg.query(`SELECT completed_at FROM auth.initial_admin_claim`))
        .rows[0],
    ).toMatchObject({ completed_at: null });
    await pg.exec(`DELETE FROM auth.rate_limit`);
  });
  it("creates a team and sends a real invitation through the configured mail boundary", async () => {
    const response = await call(
      "organization/create",
      { name: "Fictional team", slug: "fictional-team", createdBy: "attacker" },
      ownerCookie,
    );
    expect(response.status).toBe(200);
    const team = await response.json();
    teamId = team.id;
    expect(
      (
        await pg.query<{ completed_at: Date | null }>(
          `SELECT completed_at FROM auth.initial_admin_claim`,
        )
      ).rows[0].completed_at,
    ).toBeTruthy();
    expect(teamId).toBeTruthy();
    const creator = (
      await pg.query<{ email: string }>(
        `SELECT u.email FROM auth.organization o JOIN auth."user" u ON u.id=o.created_by WHERE o.id=$1`,
        [teamId],
      )
    ).rows[0];
    expect(creator.email).toBe("owner@example.test");
    // The new owner must turn on two-step sign-in before managing the team.
    ownerCookie = (
      await authCaller(auth).enableTwoStep(ownerCookie, "a-long-test-password")
    ).cookie;
    const invite = await call(
      "organization/invite-member",
      {
        organizationId: teamId,
        email: "invited@example.test",
        role: "recruiter",
      },
      ownerCookie,
    );
    expect(invite.status).toBe(200);
    invitationId = (await invite.json()).id;
    expect(
      mail.some(
        (message) =>
          message.to === "invited@example.test" &&
          message.text.includes(invitationId),
      ),
    ).toBe(true);
  });
  it("permits an invited account and rejects acceptance by another verified email", async () => {
    expect(
      (
        await call(
          "organization/invite-member",
          {
            organizationId: teamId,
            email: "wrong@example.test",
            role: "viewer",
          },
          ownerCookie,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call("sign-up/email", {
          name: "Wrong email",
          email: "wrong@example.test",
          password: "wrong-account-password",
        })
      ).status,
    ).toBe(200);
    const wrongVerification = mail.find(
      (message) =>
        message.to === "wrong@example.test" &&
        message.subject.includes("Verify"),
    )!;
    await auth.handler(
      new Request(
        wrongVerification.text.match(
          /http:\/\/localhost:3000\/api\/auth\/verify-email[^\s]+/,
        )![0],
      ),
    );
    const wrongSignin = await call("sign-in/email", {
      email: "wrong@example.test",
      password: "wrong-account-password",
    });
    expect(wrongSignin.status).toBe(200);
    const wrong = await call(
      "organization/accept-invitation",
      { invitationId },
      wrongSignin.headers.get("set-cookie")!,
    );
    expect(wrong.status).toBe(403);
    const signup = await call("sign-up/email", {
      name: "Invited",
      email: "invited@example.test",
      password: "another-long-password",
    });
    expect(signup.status).toBe(200);
    expect(
      (
        await pg.query(
          `SELECT email_verified FROM auth."user" WHERE email='invited@example.test'`,
        )
      ).rows,
    ).toEqual([{ email_verified: false }]);
    const verification = mail.find(
      (message) =>
        message.to === "invited@example.test" &&
        message.subject.includes("Verify"),
    )!;
    const link = verification.text.match(
      /http:\/\/localhost:3000\/api\/auth\/verify-email[^\s]+/,
    )![0];
    await auth.handler(new Request(link));
    const signin = await call("sign-in/email", {
      email: "invited@example.test",
      password: "another-long-password",
    });
    expect(signin.status).toBe(200);
    const accepted = await call(
      "organization/accept-invitation",
      { invitationId },
      signin.headers.get("set-cookie")!,
    );
    expect(accepted.status).toBe(200);
    expect(
      (
        await pg.query(
          `SELECT m.role FROM auth.member m JOIN auth."user" u ON u.id=m.user_id WHERE u.email='invited@example.test'`,
        )
      ).rows,
    ).toEqual([{ role: "recruiter" }]);
    const promotion = await call(
      "organization/invite-member",
      { organizationId: teamId, email: "stranger@example.test", role: "owner" },
      signin.headers.get("set-cookie")!,
    );
    expect(promotion.status).toBe(403);
  });
  it("rejects combined roles and cross-origin auth writes", async () => {
    expect(
      (
        await call(
          "organization/invite-member",
          {
            organizationId: teamId,
            email: "stranger@example.test",
            role: "admin,owner",
          },
          ownerCookie,
        )
      ).status,
    ).toBe(400);
    const crossOrigin = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://untrusted.example",
        },
        body: JSON.stringify({
          email: "owner@example.test",
          password: "a-long-test-password",
        }),
      }),
    );
    expect(crossOrigin.status).toBe(403);
  });
  it("resets a password and immediately revokes the old session", async () => {
    expect(
      (
        await call("request-password-reset", {
          email: "owner@example.test",
          redirectTo: "http://localhost:3000/reset-password",
        })
      ).status,
    ).toBe(200);
    const reset = mail.find((message) => message.subject.startsWith("Reset"))!;
    const link = reset.text.match(
      /http:\/\/localhost:3000\/api\/auth\/reset-password\/[^\s]+/,
    )![0];
    const token = new URL(link).pathname.split("/").at(-1)!;
    expect(
      (
        await call("reset-password", {
          token,
          newPassword: "new-long-test-password",
        })
      ).status,
    ).toBe(200);
    expect(
      await auth.api.getSession({
        headers: new Headers({ cookie: ownerCookie }),
        query: { disableCookieCache: true },
      }),
    ).toBeNull();
  });
});

describe("owner role and team creation through the handler", () => {
  let h: Awaited<ReturnType<typeof createAuthDb>>;
  let caller: ReturnType<typeof authCaller>;
  const mail: Mail[] = [];
  let ownerCookie = "";
  let teamId = "";
  let admin = { cookie: "", memberId: "" };
  let recruiter = { cookie: "", memberId: "" };
  const ownerLike = [" owner", "Owner", "OWNER", "owner ", "owner\n"];
  const ownerLikeInvitations = () =>
    h.count(
      `SELECT count(*) FROM auth.invitation WHERE lower(trim(both E' \t\r\n' FROM role)) LIKE '%owner%'`,
    );
  const roleOf = async (memberId: string) =>
    (
      await h.pg.query<{ role: string }>(
        `SELECT role FROM auth.member WHERE id=$1`,
        [memberId],
      )
    ).rows[0]?.role;
  beforeAll(async () => {
    h = await createAuthDb({ workspace: true });
    caller = authCaller(createTestAuth(h.db, mail));
    ({ cookie: ownerCookie, teamId } = await setUpAdmin(caller, mail));
    admin = await addMember(
      caller,
      mail,
      ownerCookie,
      teamId,
      "team-admin@example.test",
      "admin",
    );
    recruiter = await addMember(
      caller,
      mail,
      ownerCookie,
      teamId,
      "team-recruiter@example.test",
      "recruiter",
    );
  });
  afterAll(async () => h.pg.close());

  it("refuses padded or differently cased owner roles from an admin, for invitations and role changes", async () => {
    for (const role of ownerLike) {
      const invite = await caller.post(
        "organization/invite-member",
        { organizationId: teamId, email: "padded@example.test", role },
        { cookie: admin.cookie },
      );
      expect(invite.status, JSON.stringify(role)).toBeGreaterThanOrEqual(400);
      expect(invite.status, JSON.stringify(role)).toBeLessThan(500);
      const promote = await caller.post(
        "organization/update-member-role",
        { organizationId: teamId, memberId: recruiter.memberId, role },
        { cookie: admin.cookie },
      );
      expect(promote.status, JSON.stringify(role)).toBeGreaterThanOrEqual(400);
      expect(promote.status, JSON.stringify(role)).toBeLessThan(500);
    }
    expect(await ownerLikeInvitations()).toBe(0);
    expect(await roleOf(recruiter.memberId)).toBe("recruiter");
  });

  it("refuses a padded owner role from an owner, because only exact role names are valid", async () => {
    const invite = await caller.post(
      "organization/invite-member",
      { organizationId: teamId, email: "padded@example.test", role: " owner" },
      { cookie: ownerCookie },
    );
    expect(invite.status).toBe(400);
    const promote = await caller.post(
      "organization/update-member-role",
      { organizationId: teamId, memberId: recruiter.memberId, role: " owner" },
      { cookie: ownerCookie },
    );
    expect(promote.status).toBe(400);
    expect(await ownerLikeInvitations()).toBe(0);
    expect(await roleOf(recruiter.memberId)).toBe("recruiter");
  });

  it("refuses team creation by a verified recruiter or an admin who owns no team", async () => {
    const before = await h.count(`SELECT count(*) FROM auth.organization`);
    for (const [slug, cookie] of [
      ["recruiter-team", recruiter.cookie],
      ["admin-team", admin.cookie],
    ]) {
      const response = await caller.post(
        "organization/create",
        { name: "Fictional refused team", slug },
        { cookie },
      );
      expect(response.status, slug).toBe(403);
    }
    expect(await h.count(`SELECT count(*) FROM auth.organization`)).toBe(
      before,
    );
  });

  it("lets the initial administrator and an owner of one team create another team", async () => {
    await createTeam(caller, ownerCookie, "initial-admin-second");
    const owner = await addMember(
      caller,
      mail,
      ownerCookie,
      teamId,
      "second-owner@example.test",
      "owner",
    );
    expect(owner.memberId).toBeTruthy();
    await createTeam(caller, owner.cookie, "owned-second-team");
    expect(
      await h.count(
        `SELECT count(*) FROM auth.organization o JOIN auth."user" u ON u.id=o.created_by WHERE o.slug='owned-second-team' AND u.email='second-owner@example.test'`,
      ),
    ).toBe(1);
  });

  it("removes control, bidi and zero-width characters from the team name in invitation mail", async () => {
    const created = await caller.post(
      "organization/create",
      {
        name: "Fictional\r\nUrgent\u202Eteam\u200Bname",
        slug: "unsafe-name-team",
      },
      { cookie: ownerCookie },
    );
    expect(created.status).toBe(200);
    const organizationId = ((await created.json()) as { id: string }).id;
    const invite = await caller.post(
      "organization/invite-member",
      { organizationId, email: "named-invite@example.test", role: "viewer" },
      { cookie: ownerCookie },
    );
    expect(invite.status).toBe(200);
    const message = mail.findLast(
      (item) => item.to === "named-invite@example.test",
    )!;
    expect(message.subject).toBe(
      "Invitation to FictionalUrgentteamname on RecruitmentOS",
    );
    for (const text of [message.subject, message.text])
      expect(text).not.toMatch(/[\r\u202E\u200B]/);
    expect(message.subject).not.toContain("\n");
    expect(message.text).toContain(
      "You have been invited to join FictionalUrgentteamname.",
    );
  });

  it("keeps every role-change rule when the role service drives updateMemberRole (R2a-10)", async () => {
    const as = (cookie: string) => new Headers({ cookie });
    const change = (cookie: string, memberId: string, role: string) =>
      changeTeamRole(caller.auth, as(cookie), {
        organizationId: teamId,
        memberId,
        role,
      });
    const ownerMember = (
      await h.pg.query<{ id: string }>(
        "SELECT id FROM auth.member WHERE organization_id=$1 AND role='owner' ORDER BY created_at LIMIT 1",
        [teamId],
      )
    ).rows[0].id;
    // A recruiter holds no member update; an admin cannot change an owner or make one.
    expect(await change(recruiter.cookie, admin.memberId, "viewer")).toBe(
      false,
    );
    expect(await change(admin.cookie, ownerMember, "recruiter")).toBe(false);
    expect(await change(admin.cookie, recruiter.memberId, "owner")).toBe(false);
    // Only exact role names are valid, even from an owner.
    expect(await change(ownerCookie, recruiter.memberId, " viewer")).toBe(
      false,
    );
    expect(await roleOf(admin.memberId)).toBe("admin");
    expect(await roleOf(ownerMember)).toBe("owner");
    expect(await roleOf(recruiter.memberId)).toBe("recruiter");
    // A team owner changes a member's role, and back.
    expect(await change(ownerCookie, recruiter.memberId, "viewer")).toBe(true);
    expect(await roleOf(recruiter.memberId)).toBe("viewer");
    expect(await change(ownerCookie, recruiter.memberId, "recruiter")).toBe(
      true,
    );
    expect(await roleOf(recruiter.memberId)).toBe("recruiter");
  });
});

// ADM-16 (job 077): company owners and admins with an unsuspended row must use two-step sign-in,
// at Better Auth, the API and pages alike, on the split runtime roles with fictional people.
describe("two-step sign-in for company authority under the split runtime roles", () => {
  const COMPANY = "00000000-0000-4000-a000-000000000001";
  const ORIGIN = "http://localhost:3000";
  const mail: Mail[] = [];
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  let caller: ReturnType<typeof authCaller>;
  let teamId = "";
  type Person = { id: string; cookie: string };
  const people: Record<
    "companyAdmin" | "plain" | "suspended" | "teamOwner",
    Person
  > = {
    companyAdmin: { id: "", cookie: "" },
    plain: { id: "", cookie: "" },
    suspended: { id: "", cookie: "" },
    teamOwner: { id: "", cookie: "" },
  };
  /** As the PGlite superuser, which bypasses RLS: only to arrange and inspect. */
  const superuser = async <T>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  /** The session lookups return the person's live identity row. */
  async function signedIn(userId: string) {
    const [row] = await superuser<{
      name: string;
      email: string;
      two_factor_enabled: boolean | null;
    }>(
      `SELECT name, email, two_factor_enabled FROM auth."user" WHERE id = $1`,
      [userId],
    );
    const identity = {
      user: {
        id: userId,
        name: row.name,
        email: row.email,
        emailVerified: true,
        twoFactorEnabled: row.two_factor_enabled,
      },
      session: { activeOrganizationId: teamId, createdAt: new Date() },
    };
    vi.mocked(getSession).mockResolvedValue(identity as never);
    vi.mocked(getVerifiedSession).mockResolvedValue(identity as never);
  }
  /** The three gates: a Better Auth endpoint, requirePrincipal and getWorkspaceContext. */
  async function gates(person: Person) {
    await harness.identityDb();
    const response = await caller.get(
      `${ORIGIN}/api/auth/organization/list`,
      person.cookie,
    );
    const betterAuth = response.ok
      ? response.status
      : `${response.status} ${((await response.json()) as { code: string }).code}`;
    await signedIn(person.id);
    const api = await requirePrincipal(
      new Request(ORIGIN, { headers: { "x-team-id": teamId } }),
    ).then(
      (principal) => principal.userId,
      (error: { status: number; code: string }) =>
        `${error.status} ${error.code}`,
    );
    const page = await getWorkspaceContext().then(
      (context) => context.user.id,
      (error: Error) => error.message,
    );
    return { betterAuth, api, page };
  }
  const gated = {
    betterAuth: "403 two_step_setup_required",
    api: "403 two_step_setup_required",
    page: "redirect:/two-step-setup?next=/app",
  };
  const passes = (userId: string) => ({
    betterAuth: 200,
    api: userId,
    page: userId,
  });

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.identity.mockImplementation(harness.identityDb);
    pools.data.mockImplementation(async () => {
      throw new Error("The two-step gate must not use the data pool");
    });
    vi.stubEnv("DATABASE_MODE", "pglite");
    vi.stubEnv("ALLOW_LOCAL_DB", "true");
    vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
    vi.stubEnv("BETTER_AUTH_SECRET", "fictional-valid-test-secret-0123456789");
    vi.stubEnv("BOOTSTRAP_OWNER_EMAIL", "owner@example.test");
    vi.stubEnv(
      "BOOTSTRAP_SETUP_TOKEN",
      "fictional-bootstrap-secret-0123456789abcdefghi",
    );
    vi.stubEnv("DEV_MAIL_MODE", "console");
    caller = authCaller(createTestAuth(await harness.identityDb(), mail));
    const admin = await setUpAdmin(caller, mail);
    teamId = admin.teamId;
    for (const [key, email] of [
      ["companyAdmin", "ca-company-admin@example.test"],
      ["plain", "ca-plain@example.test"],
      ["suspended", "ca-suspended@example.test"],
      ["teamOwner", "ca-team-owner@example.test"],
    ] as const) {
      await harness.identityDb();
      const added = await addMember(
        caller,
        mail,
        admin.cookie,
        teamId,
        email,
        "recruiter",
      );
      const [{ id }] = await superuser<{ id: string }>(
        `SELECT id FROM auth."user" WHERE email = $1`,
        [email],
      );
      people[key] = { id, cookie: added.cookie };
    }
    // Rows an upgraded database may hold for people without two-step: one active, one suspended.
    await superuser(
      `INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ($1,$2,'admin','{fields}')`,
      [COMPANY, people.companyAdmin.id],
    );
    await superuser(
      `INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas,suspended_at) VALUES ($1,$2,'owner','{}',now())`,
      [COMPANY, people.suspended.id],
    );
    await superuser(
      `UPDATE auth.member SET role = 'owner' WHERE user_id = $1`,
      [people.teamOwner.id],
    );
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness?.close();
  });

  it("sends a company admin without two-step to set it up at Better Auth, the API and pages", async () => {
    expect(await gates(people.companyAdmin)).toEqual(gated);
  });

  it("lets the same company admin through once two-step is on", async () => {
    await harness.identityDb();
    const { cookie } = await caller.enableTwoStep(people.companyAdmin.cookie);
    expect(await gates({ id: people.companyAdmin.id, cookie })).toEqual(
      passes(people.companyAdmin.id),
    );
  });

  it("leaves a plain recruiter and a suspended holder without two-step ungated", async () => {
    expect(await gates(people.plain)).toEqual(passes(people.plain.id));
    expect(await gates(people.suspended)).toEqual(passes(people.suspended.id));
  });

  it("still gates a team owner without two-step", async () => {
    expect(await gates(people.teamOwner)).toEqual(gated);
  });

  it("never opens the data pool for the lookup", () => {
    expect(pools.data).not.toHaveBeenCalled();
  });
});
