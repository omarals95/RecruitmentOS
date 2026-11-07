import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { expect } from "vitest";
import type { AppDb } from "@/db";
import { authTables } from "@/db/auth-schema";
import { createAuth, type AppAuth } from "@/lib/auth";

export const ORIGIN = "http://localhost:3000";
export const BOOTSTRAP_EMAIL = "owner@example.test";
export const BOOTSTRAP_TOKEN = "fictional-bootstrap-secret-0123456789abcdefghi";
export const PASSWORD = "a-long-fictional-password";
export const TEST_SECRET = "fictional-test-secret-with-at-least-32-characters";
export type Mail = { to: string; subject: string; text: string };

// The real identity migrations, run as a restricted nonowner role like tests/auth-flows.test.ts.
export async function createAuthDb() {
  const pg = new PGlite();
  let sql = "";
  for (const file of [
    "0000_auth.sql",
    "0003_initial_admin.sql",
    "0004_protect_initial_admin_claim.sql",
  ])
    sql +=
      (await readFile(
        new URL(`../../drizzle/${file}`, import.meta.url),
        "utf8",
      )) + "\n";
  await pg.exec(`${sql}
    CREATE ROLE identity_flow_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA auth TO identity_flow_runtime;
    GRANT SELECT ON auth.initial_admin_claim TO identity_flow_runtime;
    GRANT SELECT,INSERT,UPDATE,DELETE ON auth."user",auth.organization,auth.session,auth.account,auth.verification,auth.member,auth.invitation,auth.rate_limit,auth.api_tokens,auth.api_rate_limits TO identity_flow_runtime;
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
  return { post, get, session, signIn };
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
  return { cookie, teamId: team.id };
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
  return { cookie, memberId };
}
