import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { expect } from "vitest";
import { applyMigrations, type AppDb } from "@/db";
import { symmetricEncrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { authTables, twoFactor, user } from "@/db/auth-schema";
import { createAuth, type AppAuth } from "@/lib/auth";
import { installTenantContextKey } from "@/lib/tenant-context";
import { base32Decode } from "../../scripts/totp";

export const ORIGIN = "http://localhost:3000";
export const BOOTSTRAP_EMAIL = "owner@example.test";
export const BOOTSTRAP_TOKEN = "fictional-bootstrap-secret-0123456789abcdefghi";
export const PASSWORD = "a-long-fictional-password";
export const TEST_SECRET = "fictional-test-secret-with-at-least-32-characters";
export type Mail = { to: string; subject: string; text: string };

/**
 * Every migration and the fictional tenant context key, and what the identity runtime role may use
 * to install a session context: the two-step gate reads company authority that way for a member
 * without two-step (companyAuthorityHeld). Run before the restricted role is set.
 */
export async function applyWorkspaceSchema(pg: PGlite, role: string) {
  await applyMigrations(pg);
  await installTenantContextKey(pg);
  return `
    GRANT USAGE ON SCHEMA tenant_context, db_boundary TO ${role};
    GRANT SELECT ON db_boundary.connection_marker TO ${role};
    GRANT EXECUTE ON FUNCTION tenant_context.install(text,text,text[]) TO ${role};`;
}

// Every migration, run as a restricted nonowner role like tests/auth-flows.test.ts, so the two-step
// gate can read company authority and session creation can check deactivation (ADM-09).
export async function createAuthDb() {
  const pg = new PGlite();
  const grants = await applyWorkspaceSchema(pg, "identity_flow_runtime");
  await pg.exec(`
    CREATE ROLE identity_flow_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA auth TO identity_flow_runtime;
    GRANT SELECT ON auth.initial_admin_claim TO identity_flow_runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON auth."user",auth.organization,auth.session,auth.account,auth.verification,auth.two_factor,auth.member,auth.invitation,auth.rate_limit,auth.api_tokens,auth.api_rate_limits TO identity_flow_runtime;${grants}
    SET ROLE identity_flow_runtime;`);
  const db = drizzle(pg, { schema: authTables }) as unknown as AppDb;
  const count = async (query: string, params: unknown[] = []) =>
    Number(
      (await pg.query<{ count: string }>(query, params)).rows[0]?.count ?? 0,
    );
  return {
    pg,
    db,
    count,
    // Test-only fault injection and cleanup run as the database owner, then drop back to the restricted role.
    asOwner: (statements: string) =>
      pg.exec(`RESET ROLE;\n${statements}\nSET ROLE identity_flow_runtime;`),
  };
}

export function createTestAuth(
  db: AppDb,
  mail: Mail[],
  config: Partial<Parameters<typeof createAuth>[1]> = {},
) {
  return createAuth(db, {
    baseURL: ORIGIN,
    secret: TEST_SECRET,
    bootstrapOwnerEmail: BOOTSTRAP_EMAIL,
    bootstrapSetupToken: BOOTSTRAP_TOKEN,
    publicSignup: false,
    deliver: async (message) => {
      mail.push(message);
    },
    ...config,
  });
}

let client = 0;
// A fresh private client address per call keeps unrelated steps out of each other's rate-limit budget.
const nextIP = () => {
  client += 1;
  return `10.${(client >> 16) & 255}.${(client >> 8) & 255}.${client & 255}`;
};

export function authCaller(auth: AppAuth, origin = new URL(ORIGIN).origin) {
  const post = (
    path: string,
    body: unknown,
    options: { cookie?: string; ip?: string; bootstrapToken?: string } = {},
  ) =>
    auth.handler(
      new Request(`${origin}/api/auth/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-forwarded-for": options.ip ?? nextIP(),
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...(options.bootstrapToken
            ? { "x-bootstrap-token": options.bootstrapToken }
            : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  const get = (url: string, cookie?: string) =>
    auth.handler(
      new Request(url, {
        headers: {
          "x-forwarded-for": nextIP(),
          ...(cookie ? { cookie } : {}),
        },
      }),
    );
  const session = (cookie: string) =>
    auth.api.getSession({
      headers: new Headers({ cookie }),
      query: { disableCookieCache: true },
    });
  const signIn = async (email: string, password = PASSWORD) => {
    const response = await post("sign-in/email", { email, password });
    expect(response.status).toBe(200);
    return cookieOf(response);
  };
  const code = async (secret: string) =>
    (await auth.api.generateTOTP({ body: { secret } })).code;
  // Turns two-step sign-in on through the real endpoints; the returned cookie is the new session.
  const enableTwoStep = async (cookie: string, password = PASSWORD) => {
    const enabled = await post("two-factor/enable", { password }, { cookie });
    expect(enabled.status).toBe(200);
    const { totpURI, backupCodes } = (await enabled.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    const secret = totpSecret(totpURI);
    const verified = await post(
      "two-factor/verify-totp",
      { code: await code(secret) },
      { cookie },
    );
    expect(verified.status).toBe(200);
    return { cookie: cookieOf(verified), secret, backupCodes };
  };
  // Password, then the authenticator code: the session cookie of a two-step user.
  const signInWithCode = async (
    email: string,
    secret: string,
    password = PASSWORD,
  ) => {
    const challenged = await post("sign-in/email", { email, password });
    expect(challenged.status).toBe(200);
    expect(await challenged.json()).toMatchObject({ twoFactorRedirect: true });
    const verified = await post(
      "two-factor/verify-totp",
      { code: await code(secret) },
      { cookie: cookieOf(challenged) },
    );
    expect(verified.status).toBe(200);
    return cookieOf(verified);
  };
  return {
    auth,
    post,
    get,
    session,
    signIn,
    code,
    enableTwoStep,
    signInWithCode,
  };
}

/** Gives a seeded user two-step sign-in with a known secret, encrypted as Better Auth stores it. */
export async function seedTwoFactor(
  db: AppDb,
  userId: string,
  secret = "fictional-two-step-secret-0001",
) {
  await db.insert(twoFactor).values({
    userId,
    secret: await symmetricEncrypt({ key: TEST_SECRET, data: secret }),
    backupCodes: await symmetricEncrypt({ key: TEST_SECRET, data: "[]" }),
  });
  await db
    .update(user)
    .set({ twoFactorEnabled: true })
    .where(eq(user.id, userId));
  return secret;
}

/** The raw secret behind an otpauth:// URI, as Better Auth's generateTOTP takes it. */
export function totpSecret(totpURI: string) {
  return Buffer.from(
    base32Decode(new URL(totpURI).searchParams.get("secret") ?? ""),
  ).toString("utf8");
}

export function cookieOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

export function mailLink(mail: Mail[], to: string, pattern: RegExp) {
  const link = mail
    .filter((message) => message.to === to)
    .map((message) => message.text.match(pattern)?.[0])
    .filter(Boolean)
    .at(-1);
  expect(link).toBeTruthy();
  return link!;
}

export const verifyPattern = /https?:\/\/[^\s/]+\/api\/auth\/verify-email\S+/;
export const resetPattern =
  /https?:\/\/[^\s/]+\/api\/auth\/reset-password\/\S+/;

// Registers through the real flow, opens the emailed verification link and signs in.
export async function registerVerified(
  caller: ReturnType<typeof authCaller>,
  mail: Mail[],
  email: string,
  options: { bootstrapToken?: string; password?: string } = {},
) {
  const password = options.password ?? PASSWORD;
  const response = await caller.post(
    "sign-up/email",
    { name: "Fictional Person", email, password, callbackURL: "/sign-in" },
    { bootstrapToken: options.bootstrapToken },
  );
  expect(response.status).toBe(200);
  const verified = await caller.get(mailLink(mail, email, verifyPattern));
  expect([200, 302]).toContain(verified.status);
  return caller.signIn(email, password);
}

export async function createTeam(
  caller: ReturnType<typeof authCaller>,
  cookie: string,
  slug: string,
) {
  const response = await caller.post(
    "organization/create",
    { name: `Fictional ${slug}`, slug },
    { cookie },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string };
}

// Completes initial setup: the verified bootstrap administrator owns a first team.
export async function setUpAdmin(
  caller: ReturnType<typeof authCaller>,
  mail: Mail[],
) {
  const cookie = await registerVerified(caller, mail, BOOTSTRAP_EMAIL, {
    bootstrapToken: BOOTSTRAP_TOKEN,
  });
  const team = await createTeam(caller, cookie, "fictional-first-team");
  // Owners must use two-step sign-in before anything else.
  const twoStep = await caller.enableTwoStep(cookie);
  return { cookie: twoStep.cookie, teamId: team.id, secret: twoStep.secret };
}

// Invites an address, registers and verifies it, and accepts the invitation as that account.
export async function addMember(
  caller: ReturnType<typeof authCaller>,
  mail: Mail[],
  ownerCookie: string,
  organizationId: string,
  email: string,
  role: string,
) {
  const invite = await caller.post(
    "organization/invite-member",
    { organizationId, email, role },
    { cookie: ownerCookie },
  );
  expect(invite.status).toBe(200);
  const invitationId = ((await invite.json()) as { id: string }).id;
  const cookie = await registerVerified(caller, mail, email);
  const accepted = await caller.post(
    "organization/accept-invitation",
    { invitationId },
    { cookie },
  );
  expect(accepted.status).toBe(200);
  const memberId = ((await accepted.json()) as { member: { id: string } })
    .member.id;
  // Owners and admins must use two-step sign-in before anything else.
  if (role !== "owner" && role !== "admin") return { cookie, memberId };
  const twoStep = await caller.enableTwoStep(cookie);
  return { cookie: twoStep.cookie, memberId, secret: twoStep.secret };
}
