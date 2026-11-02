import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppDb } from "../src/db";
import { authTables } from "../src/db/auth-schema";
import { createAuth } from "../src/lib/auth";

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
    publicSignup: false,
    deliver: async (message) => {
      mail.push(message);
    },
  });
  const call = (path: string, body: unknown, cookie?: string) =>
    auth.handler(
      new Request(`http://localhost:3000/api/auth/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  beforeAll(async () =>
    pg.exec(
      await readFile(
        new URL("../drizzle/0000_auth.sql", import.meta.url),
        "utf8",
      ),
    ),
  );
  afterAll(async () => pg.close());
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
  it("creates a bootstrap account but blocks sign-in before verification", async () => {
    expect(
      (
        await call("sign-up/email", {
          name: "Owner",
          email: "owner@example.test",
          password: "a-long-test-password",
          callbackURL: "/app",
        })
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
  it("creates a team and sends a real invitation through the configured mail boundary", async () => {
    const response = await call(
      "organization/create",
      { name: "Fictional team", slug: "fictional-team", createdBy: "attacker" },
      ownerCookie,
    );
    expect(response.status).toBe(200);
    const team = await response.json();
    teamId = team.id;
    expect(teamId).toBeTruthy();
    const creator = (
      await pg.query<{ email: string }>(
        `SELECT u.email FROM auth.organization o JOIN auth."user" u ON u.id=o.created_by WHERE o.id=$1`,
        [teamId],
      )
    ).rows[0];
    expect(creator.email).toBe("owner@example.test");
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
