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
import { signInBackoffKey } from "../src/lib/client-ip";
import { changeTeamRole } from "../src/lib/member-roles";
import { roleScopes } from "../src/lib/permissions";
import { requirePrincipal, type Principal } from "../src/lib/principal";
import {
  clearSignInLockout,
  setUserActive,
  signOutEverywhere,
} from "../src/lib/user-account";
import { getWorkspaceContext } from "../src/lib/workspace";
import {
  PASSWORD,
  TEST_SECRET,
  addMember,
  applyWorkspaceSchema,
  authCaller,
  cookieOf,
  createAuthDb,
  createTeam,
  createTestAuth,
  registerVerified,
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
    h = await createAuthDb();
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

// ADM-08 (job 076): Invite to teams sends one ordinary Better Auth invitation per chosen team, with
// the fake mail array only; Better Auth refuses every team where the caller is not owner or admin.
describe("invitations to several teams through the handler", () => {
  let h: Awaited<ReturnType<typeof createAuthDb>>;
  let caller: ReturnType<typeof authCaller>;
  const mail: Mail[] = [];
  const teams = { a: "", b: "", c: "", d: "" };
  let multi = "";
  const invite = (
    organizationId: string,
    email: string,
    role: string,
    extra: Record<string, unknown> = {},
  ) =>
    caller.post(
      "organization/invite-member",
      { organizationId, email, role, ...extra },
      { cookie: multi },
    );
  const invitations = (email: string) =>
    h.pg
      .query<{ organization_id: string; role: string; status: string }>(
        "SELECT organization_id, role, status FROM auth.invitation WHERE email = $1 ORDER BY organization_id",
        [email],
      )
      .then((result) => result.rows);
  const mailTo = (email: string) =>
    mail.filter(
      (message) =>
        message.to === email && message.subject.startsWith("Invitation"),
    );

  beforeAll(async () => {
    // With every migration: once the invitee is a viewer, the two-step gate reads company authority.
    h = await createAuthDb();
    caller = authCaller(createTestAuth(h.db, mail));
    const owner = await setUpAdmin(caller, mail);
    teams.a = owner.teamId;
    teams.b = (await createTeam(caller, owner.cookie, "fictional-team-b")).id;
    teams.c = (await createTeam(caller, owner.cookie, "fictional-team-c")).id;
    teams.d = (await createTeam(caller, owner.cookie, "fictional-team-d")).id;
    // The caller: owner of team A, admin of team B, recruiter in team C and not in team D.
    multi = (
      await addMember(
        caller,
        mail,
        owner.cookie,
        teams.a,
        "multi@example.test",
        "owner",
      )
    ).cookie;
    for (const [team, role] of [
      [teams.b, "admin"],
      [teams.c, "recruiter"],
    ]) {
      const sent = await caller.post(
        "organization/invite-member",
        { organizationId: team, email: "multi@example.test", role },
        { cookie: owner.cookie },
      );
      expect(sent.status).toBe(200);
      const accepted = await caller.post(
        "organization/accept-invitation",
        { invitationId: ((await sent.json()) as { id: string }).id },
        { cookie: multi },
      );
      expect(accepted.status).toBe(200);
    }
    expect(
      (
        await h.pg.query<{ organization_id: string; role: string }>(
          `SELECT m.organization_id, m.role FROM auth.member m JOIN auth."user" u ON u.id = m.user_id
            WHERE u.email = 'multi@example.test' ORDER BY m.organization_id`,
        )
      ).rows,
    ).toEqual(
      [
        { organization_id: teams.a, role: "owner" },
        { organization_id: teams.b, role: "admin" },
        { organization_id: teams.c, role: "recruiter" },
      ].sort((x, y) => x.organization_id.localeCompare(y.organization_id)),
    );
  });
  afterAll(async () => h.pg.close());

  it("sends one invitation and one mail per team, each with its own role", async () => {
    expect(
      (await invite(teams.a, "several@example.test", "viewer")).status,
    ).toBe(200);
    expect(
      (await invite(teams.b, "several@example.test", "recruiter")).status,
    ).toBe(200);
    expect(await invitations("several@example.test")).toEqual(
      [
        { organization_id: teams.a, role: "viewer", status: "pending" },
        { organization_id: teams.b, role: "recruiter", status: "pending" },
      ].sort((x, y) => x.organization_id.localeCompare(y.organization_id)),
    );
    expect(mailTo("several@example.test")).toHaveLength(2);
    expect(
      mailTo("several@example.test").map((message) => message.subject),
    ).toEqual([
      "Invitation to Fictional fictional-first-team on RecruitmentOS",
      "Invitation to Fictional fictional-team-b on RecruitmentOS",
    ]);
  });

  it("refuses a forged invitation to a team where the caller is a recruiter or not a member", async () => {
    for (const team of [teams.c, teams.d]) {
      const response = await invite(team, "forged@example.test", "viewer");
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(await invitations("forged@example.test")).toEqual([]);
    expect(mailTo("forged@example.test")).toEqual([]);
  });

  it("refuses an admin's invitation with the owner role, as today", async () => {
    expect(
      (await invite(teams.b, "promoted@example.test", "owner")).status,
    ).toBe(403);
    expect(await invitations("promoted@example.test")).toEqual([]);
    expect(mailTo("promoted@example.test")).toEqual([]);
    // As owner of team A the same caller may give Owner there.
    expect(
      (await invite(teams.a, "promoted@example.test", "owner")).status,
    ).toBe(200);
  });

  it("ignores extra company fields in the body and creates only the plain invitation", async () => {
    const response = await invite(teams.a, "extra@example.test", "viewer", {
      companyLevel: "owner",
      areas: ["people"],
      planAccess: true,
      roleObjectId: "00000000-0000-4000-a000-0000000000f1",
    });
    expect(response.status).toBe(200);
    const rows = (
      await h.pg.query(
        "SELECT * FROM auth.invitation WHERE email = 'extra@example.test'",
      )
    ).rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(mailTo("extra@example.test")).toHaveLength(1);
    for (const row of rows) {
      expect(row).toMatchObject({ organization_id: teams.a, role: "viewer" });
      const text = JSON.stringify(row);
      for (const value of [
        "people",
        "planAccess",
        "0000000000f1",
        "companyLevel",
      ])
        expect(text, value).not.toContain(value);
    }
  });

  it("gives the invitee exactly the chosen team roles once they accept both", async () => {
    const cookie = await registerVerified(caller, mail, "several@example.test");
    const pending = (
      await h.pg.query<{ id: string }>(
        "SELECT id FROM auth.invitation WHERE email = 'several@example.test' AND status = 'pending'",
      )
    ).rows;
    expect(pending).toHaveLength(2);
    for (const { id } of pending)
      expect(
        (
          await caller.post(
            "organization/accept-invitation",
            { invitationId: id },
            { cookie },
          )
        ).status,
      ).toBe(200);
    expect(
      (
        await h.pg.query<{ organization_id: string; role: string }>(
          `SELECT m.organization_id, m.role FROM auth.member m JOIN auth."user" u ON u.id = m.user_id
            WHERE u.email = 'several@example.test' ORDER BY m.organization_id`,
        )
      ).rows,
    ).toEqual(
      [
        { organization_id: teams.a, role: "viewer" },
        { organization_id: teams.b, role: "recruiter" },
      ].sort((x, y) => x.organization_id.localeCompare(y.organization_id)),
    );
  });
});

// ADM-09 (job 082): a deactivated person's session creation is refused after the password or code,
// and Sign out everywhere and Clear lockout act on Better Auth's own rows, on the split runtime
// roles with fictional people and the fake mail array only.
describe("deactivation, sign out everywhere and clear lockout through the handler", () => {
  const ORIGIN = "http://localhost:3000";
  const DEACTIVATED = {
    code: "account_deactivated",
    message:
      "This account has been deactivated. Ask a company owner or admin to reactivate it.",
  };
  const mail: Mail[] = [];
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  let caller: ReturnType<typeof authCaller>;
  let owner: Principal;
  let ownerCookie = "";
  type Person = { id: string; email: string; cookie: string; secret?: string };
  const people = {} as Record<"plain" | "twoStep" | "other", Person>;
  /** As the PGlite superuser, which bypasses RLS: only to arrange and inspect. */
  const superuser = async <T>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  const sessions = async (userId: string) =>
    (
      await superuser<{ n: number }>(
        "SELECT count(*)::int AS n FROM auth.session WHERE user_id = $1",
        [userId],
      )
    )[0].n;
  const backoff = async (email: string) =>
    (
      await superuser<{ count: number }>(
        "SELECT count FROM auth.api_rate_limits WHERE key = $1",
        [signInBackoffKey(email, TEST_SECRET)],
      )
    )[0]?.count ?? null;
  /** Better Auth runs on the identity role; a service call may have switched to the data role. */
  const post = async (...args: Parameters<typeof caller.post>) => {
    await harness.identityDb();
    return caller.post(...args);
  };
  const signIn = (email: string, password = PASSWORD) =>
    post("sign-in/email", { email, password });
  const setActive = async (person: Person, active: boolean) =>
    expect(await setUserActive(owner, person.id, active)).toEqual({
      active,
      changed: true,
    });

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.identity.mockImplementation(harness.identityDb);
    pools.data.mockImplementation(harness.dataDb);
    // Clear lockout derives the backoff key with the same secret as Better Auth.
    vi.stubEnv("BETTER_AUTH_SECRET", TEST_SECRET);
    caller = authCaller(createTestAuth(await harness.identityDb(), mail));
    const admin = await setUpAdmin(caller, mail);
    ownerCookie = admin.cookie;
    for (const [key, email] of [
      ["plain", "dx-plain@example.test"],
      ["twoStep", "dx-two-step@example.test"],
      ["other", "dx-other@example.test"],
    ] as const) {
      await harness.identityDb();
      const added = await addMember(
        caller,
        mail,
        admin.cookie,
        admin.teamId,
        email,
        "recruiter",
      );
      const [{ id }] = await superuser<{ id: string }>(
        `SELECT id FROM auth."user" WHERE email = $1`,
        [email],
      );
      people[key] = { id, email, cookie: added.cookie };
    }
    await harness.identityDb();
    const twoStep = await caller.enableTwoStep(people.twoStep.cookie);
    people.twoStep = { ...people.twoStep, ...twoStep };
    const [{ id }] = await superuser<{ id: string }>(
      `SELECT id FROM auth."user" WHERE email = 'owner@example.test'`,
    );
    owner = {
      userId: id,
      teamId: admin.teamId,
      role: "owner",
      scopes: roleScopes("owner"),
      authType: "session",
    };
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness?.close();
  });

  it("refuses a deactivated member only after a correct password, creates no session and keeps the backoff", async () => {
    const { plain } = people;
    await setActive(plain, false);
    const before = await sessions(plain.id);
    const wrong = await signIn(plain.email, "a-wrong-fictional-password");
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({
      code: "INVALID_EMAIL_OR_PASSWORD",
    });
    const refused = await signIn(plain.email);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject(DEACTIVATED);
    expect(refused.headers.getSetCookie().join("")).not.toContain(
      "session_token=",
    );
    expect(await sessions(plain.id)).toBe(before);
    // Both attempts were charged and the refusal cleared nothing.
    expect(await backoff(plain.email)).toBe(2);
    // The session they already had is refused at Better Auth as well.
    await harness.identityDb();
    const listed = await caller.get(
      `${ORIGIN}/api/auth/organization/list`,
      plain.cookie,
    );
    expect(listed.status).toBe(403);
    expect(await listed.json()).toMatchObject(DEACTIVATED);
    await setActive(plain, true);
    expect((await signIn(plain.email)).status).toBe(200);
    expect(await backoff(plain.email)).toBeNull();
  });

  it("refuses the two-step code of a challenge started before the deactivation, the password step and a password change", async () => {
    const { twoStep } = people;
    const challenged = await signIn(twoStep.email);
    expect(await challenged.json()).toMatchObject({ twoFactorRedirect: true });
    await setActive(twoStep, false);
    const before = await sessions(twoStep.id);
    const verified = await post(
      "two-factor/verify-totp",
      { code: await caller.code(twoStep.secret!) },
      { cookie: cookieOf(challenged) },
    );
    expect(verified.status).toBe(403);
    expect(await verified.json()).toMatchObject(DEACTIVATED);
    const again = await signIn(twoStep.email);
    expect(again.status).toBe(403);
    expect(await again.json()).toMatchObject(DEACTIVATED);
    // A password change makes its new session inside Better Auth's transaction: refused, and the
    // password is kept.
    const [{ password }] = await superuser<{ password: string }>(
      "SELECT password FROM auth.account WHERE user_id = $1",
      [twoStep.id],
    );
    const changed = await post(
      "change-password",
      {
        currentPassword: PASSWORD,
        newPassword: "another-long-fictional-password",
        revokeOtherSessions: true,
      },
      { cookie: twoStep.cookie },
    );
    expect(changed.status).toBe(403);
    expect(await changed.json()).toMatchObject(DEACTIVATED);
    expect(
      await superuser("SELECT password FROM auth.account WHERE user_id = $1", [
        twoStep.id,
      ]),
    ).toEqual([{ password }]);
    expect(await sessions(twoStep.id)).toBe(before);
    await setActive(twoStep, true);
    await harness.identityDb();
    expect(
      await caller.session(
        await caller.signInWithCode(twoStep.email, twoStep.secret!),
      ),
    ).not.toBeNull();
  });

  it("signs the target out of every session in Better Auth and no one else", async () => {
    const { plain, other } = people;
    await harness.identityDb();
    const cookies = [
      await caller.signIn(plain.email),
      await caller.signIn(plain.email),
    ];
    const kept = await caller.signIn(other.email);
    for (const cookie of [...cookies, kept, ownerCookie])
      expect(await caller.session(cookie)).not.toBeNull();
    expect(await signOutEverywhere(owner, plain.id)).toEqual({
      signedOut: true,
    });
    expect(await sessions(plain.id)).toBe(0);
    await harness.identityDb();
    for (const cookie of cookies)
      expect(await caller.session(cookie)).toBeNull();
    for (const cookie of [kept, ownerCookie])
      expect(await caller.session(cookie)).not.toBeNull();
  });

  it("clears the target's backoff so they can sign in at once, and only theirs", async () => {
    const { plain, other } = people;
    for (const email of [plain.email, other.email])
      for (let n = 0; n < 5; n++)
        expect((await signIn(email, "a-wrong-fictional-password")).status).toBe(
          401,
        );
    expect((await signIn(plain.email)).status).toBe(429);
    expect(await clearSignInLockout(owner, plain.id)).toEqual({
      cleared: true,
    });
    expect(await backoff(plain.email)).toBeNull();
    expect(await backoff(other.email)).toBe(5);
    expect((await signIn(plain.email)).status).toBe(200);
    expect((await signIn(other.email)).status).toBe(429);
  });
});
