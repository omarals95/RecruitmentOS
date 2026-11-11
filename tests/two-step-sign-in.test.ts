import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  addMember,
  authCaller,
  cookieOf,
  createAuthDb,
  createTestAuth,
  setUpAdmin,
  totpSecret,
  type Mail,
} from "./helpers/auth";

// Better Auth's handler over every migration, run as the restricted identity role: the gate reads
// company authority for a member without two-step.
describe("two-step sign-in through the Better Auth handler", () => {
  const mail: Mail[] = [];
  let h: Awaited<ReturnType<typeof createAuthDb>>;
  let caller: ReturnType<typeof authCaller>;
  let owner = { cookie: "", teamId: "", secret: "" };
  beforeAll(async () => {
    h = await createAuthDb({ workspace: true });
    caller = authCaller(createTestAuth(h.db, mail));
    const setup = await setUpAdmin(caller, mail);
    owner = {
      cookie: setup.cookie,
      teamId: setup.teamId,
      secret: setup.secret,
    };
  });
  afterAll(async () => h.pg.close());

  const userId = async (email: string) =>
    (
      await h.pg.query<{ id: string }>(
        `SELECT id FROM auth."user" WHERE email=$1`,
        [email],
      )
    ).rows[0].id;
  /** A browser's cookies: later responses replace or clear earlier values. */
  function jar(initial = "") {
    const values = new Map<string, string>();
    const add = (pairs: string) => {
      for (const pair of pairs.split("; ").filter(Boolean)) {
        const at = pair.indexOf("=");
        values.set(pair.slice(0, at), pair.slice(at + 1));
      }
    };
    add(initial);
    return {
      take(response: Response) {
        for (const cookie of response.headers.getSetCookie()) {
          const [pair, ...attributes] = cookie.split(";");
          const at = pair.indexOf("=");
          const name = pair.slice(0, at).trim();
          const cleared =
            pair.slice(at + 1) === "" ||
            attributes.some((item) => /max-age=0\b/i.test(item.trim()));
          if (cleared) values.delete(name);
          else values.set(name, pair.slice(at + 1));
        }
      },
      get header() {
        return [...values]
          .map(([name, value]) => `${name}=${value}`)
          .join("; ");
      },
      has: (name: string) =>
        [...values.keys()].some((key) => key.endsWith(name)),
    };
  }

  it("sets up with the password, a code and 10 backup codes, stores nothing in plain text and ends other sessions", async () => {
    const email = "setup@example.test";
    const { cookie } = await addMember(
      caller,
      mail,
      owner.cookie,
      owner.teamId,
      email,
      "recruiter",
    );
    const other = await caller.signIn(email);
    expect(await caller.session(other)).not.toBeNull();
    const enabled = await caller.post(
      "two-factor/enable",
      { password: PASSWORD },
      { cookie },
    );
    expect(enabled.status).toBe(200);
    const { totpURI, backupCodes } = (await enabled.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    const uri = new URL(totpURI);
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.searchParams.get("issuer")).toBe("RecruitmentOS");
    expect(uri.searchParams.get("digits")).toBe("6");
    expect(uri.searchParams.get("period")).toBe("30");
    expect(backupCodes).toHaveLength(10);
    const secret = totpSecret(totpURI);
    const verified = await caller.post(
      "two-factor/verify-totp",
      { code: await caller.code(secret) },
      { cookie },
    );
    expect(verified.status).toBe(200);
    const id = await userId(email);
    expect(
      (
        await h.pg.query(
          `SELECT two_factor_enabled FROM auth."user" WHERE id=$1`,
          [id],
        )
      ).rows,
    ).toEqual([{ two_factor_enabled: true }]);
    const [row] = (
      await h.pg.query<{ secret: string; backup_codes: string }>(
        `SELECT secret, backup_codes FROM auth.two_factor WHERE user_id=$1`,
        [id],
      )
    ).rows;
    const stored = JSON.stringify(row);
    for (const plain of [
      secret,
      uri.searchParams.get("secret")!,
      ...backupCodes,
    ])
      expect(stored).not.toContain(plain);
    // Only the session the code created remains.
    expect(await caller.session(other)).toBeNull();
    expect(await caller.session(cookie)).toBeNull();
    expect(await caller.session(cookieOf(verified))).not.toBeNull();
    expect(
      await h.count(`SELECT count(*) FROM auth.session WHERE user_id=$1`, [id]),
    ).toBe(1);
  });

  it("challenges a correct password, refuses a wrong code and accepts a right code or a backup code once", async () => {
    const email = "challenge@example.test";
    const { cookie } = await addMember(
      caller,
      mail,
      owner.cookie,
      owner.teamId,
      email,
      "viewer",
    );
    const { secret, backupCodes } = await caller.enableTwoStep(cookie);
    const challenged = await caller.post("sign-in/email", {
      email,
      password: PASSWORD,
    });
    expect(challenged.status).toBe(200);
    expect(await challenged.json()).toMatchObject({
      twoFactorRedirect: true,
      twoFactorMethods: ["totp"],
    });
    expect(cookieOf(challenged)).not.toContain("session_token");
    const pending = cookieOf(challenged);
    const wrong = await caller.post(
      "two-factor/verify-totp",
      { code: (await caller.code(secret)) === "000000" ? "111111" : "000000" },
      { cookie: pending },
    );
    expect(wrong.status).toBe(401);
    expect(cookieOf(wrong)).not.toContain("session_token");
    const right = await caller.post(
      "two-factor/verify-totp",
      { code: await caller.code(secret) },
      { cookie: pending },
    );
    expect(right.status).toBe(200);
    expect(await caller.session(cookieOf(right))).not.toBeNull();
    // The stored key is never returned again, even with a two-step session and the password.
    const again = await caller.post(
      "two-factor/get-totp-uri",
      { password: PASSWORD },
      { cookie: cookieOf(right) },
    );
    expect(again.status).toBe(403);
    const hidden = await again.text();
    expect(JSON.parse(hidden)).toMatchObject({ code: "two_step_key_hidden" });
    expect(hidden).not.toContain("otpauth");

    const backup = async () => {
      const again = await caller.post("sign-in/email", {
        email,
        password: PASSWORD,
      });
      return caller.post(
        "two-factor/verify-backup-code",
        { code: backupCodes[0] },
        { cookie: cookieOf(again) },
      );
    };
    const first = await backup();
    expect(first.status).toBe(200);
    expect(await caller.session(cookieOf(first))).not.toBeNull();
    const reused = await backup();
    expect(reused.status).toBe(401);
    expect(cookieOf(reused)).not.toContain("session_token");
  });

  it("honours a trusted device for 30 days from the code without extending it", async () => {
    const email = "trusted@example.test";
    const { cookie } = await addMember(
      caller,
      mail,
      owner.cookie,
      owner.teamId,
      email,
      "recruiter",
    );
    const { secret } = await caller.enableTwoStep(cookie);
    const id = await userId(email);
    const browser = jar();
    const signIn = async () => {
      const response = await caller.post(
        "sign-in/email",
        { email, password: PASSWORD },
        { cookie: browser.header },
      );
      expect(response.status).toBe(200);
      browser.take(response);
      return response;
    };
    const challenged = await signIn();
    expect(await challenged.json()).toMatchObject({ twoFactorRedirect: true });
    const verified = await caller.post(
      "two-factor/verify-totp",
      { code: await caller.code(secret), trustDevice: true },
      { cookie: browser.header },
    );
    expect(verified.status).toBe(200);
    browser.take(verified);
    expect(browser.has("trust_device")).toBe(true);
    const trustRows = async () =>
      (
        await h.pg.query<{ expires_at: Date }>(
          `SELECT expires_at FROM auth.verification WHERE identifier LIKE 'trust-device-%' AND value=$1`,
          [id],
        )
      ).rows;
    const [first] = await trustRows();
    const days = (first.expires_at.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThanOrEqual(30);

    const trusted = await signIn();
    expect(await trusted.json()).not.toHaveProperty("twoFactorRedirect");
    expect(await caller.session(cookieOf(trusted))).not.toBeNull();
    // The re-issued trust row may not outlive the one it replaced.
    const rows = await trustRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].expires_at.getTime()).toBeLessThanOrEqual(
      first.expires_at.getTime(),
    );

    await h.asOwner(
      `UPDATE auth.verification SET expires_at = now() - interval '1 minute'
       WHERE identifier LIKE 'trust-device-%' AND value = '${id}';`,
    );
    const expired = await signIn();
    expect(await expired.json()).toMatchObject({ twoFactorRedirect: true });
  });

  it("forgets every trusted device when backup codes are replaced or two-step sign-in is turned off", async () => {
    const email = "forget@example.test";
    const { cookie } = await addMember(
      caller,
      mail,
      owner.cookie,
      owner.teamId,
      email,
      "recruiter",
    );
    const { secret, backupCodes } = await caller.enableTwoStep(cookie);
    const id = await userId(email);
    const trustedSignIn = async () => {
      const challenged = await caller.post("sign-in/email", {
        email,
        password: PASSWORD,
      });
      const verified = await caller.post(
        "two-factor/verify-totp",
        { code: await caller.code(secret), trustDevice: true },
        { cookie: cookieOf(challenged) },
      );
      expect(verified.status).toBe(200);
      return cookieOf(verified)
        .split("; ")
        .filter((pair) => pair.includes("session_token"))
        .join("; ");
    };
    const trusted = () =>
      h.count(
        `SELECT count(*) FROM auth.verification WHERE identifier LIKE 'trust-device-%' AND value=$1`,
        [id],
      );
    await trustedSignIn();
    const session = await trustedSignIn();
    expect(await trusted()).toBe(2);
    const replaced = await caller.post(
      "two-factor/generate-backup-codes",
      { password: PASSWORD },
      { cookie: session },
    );
    expect(replaced.status).toBe(200);
    const fresh = ((await replaced.json()) as { backupCodes: string[] })
      .backupCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(backupCodes[0]);
    expect(await trusted()).toBe(0);
    const challenged = await caller.post("sign-in/email", {
      email,
      password: PASSWORD,
    });
    expect(
      (
        await caller.post(
          "two-factor/verify-backup-code",
          { code: backupCodes[0] },
          { cookie: cookieOf(challenged) },
        )
      ).status,
    ).toBe(401);

    const last = await trustedSignIn();
    expect(await trusted()).toBe(1);
    const disabled = await caller.post(
      "two-factor/disable",
      { password: PASSWORD },
      { cookie: last },
    );
    expect(disabled.status).toBe(200);
    expect(await trusted()).toBe(0);
    expect(
      (
        await h.pg.query(
          `SELECT u.two_factor_enabled, (SELECT count(*)::int FROM auth.two_factor t WHERE t.user_id=u.id) AS secrets FROM auth."user" u WHERE u.id=$1`,
          [id],
        )
      ).rows,
    ).toEqual([{ two_factor_enabled: false, secrets: 0 }]);
    expect(await caller.session(cookieOf(disabled))).not.toBeNull();
  });

  it("gates an owner or admin without two-step on every Better Auth endpoint but setup and sign-out", async () => {
    const email = "promoted@example.test";
    const added = await addMember(
      caller,
      mail,
      owner.cookie,
      owner.teamId,
      email,
      "recruiter",
    );
    const viewer = await addMember(
      caller,
      mail,
      owner.cookie,
      owner.teamId,
      "viewer-gate@example.test",
      "viewer",
    );
    for (const cookie of [added.cookie, viewer.cookie])
      expect(
        (
          await caller.get(
            "http://localhost:3000/api/auth/organization/list",
            cookie,
          )
        ).status,
      ).toBe(200);
    const promoted = await caller.post(
      "organization/update-member-role",
      { memberId: added.memberId, role: "admin", organizationId: owner.teamId },
      { cookie: owner.cookie },
    );
    expect(promoted.status).toBe(200);

    const refusals = [
      await caller.get(
        "http://localhost:3000/api/auth/organization/list",
        added.cookie,
      ),
      await caller.get(
        "http://localhost:3000/api/auth/list-sessions",
        added.cookie,
      ),
      await caller.post(
        "change-password",
        { currentPassword: PASSWORD, newPassword: "another-long-password" },
        { cookie: added.cookie },
      ),
    ];
    for (const refused of refusals) {
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        code: "two_step_setup_required",
        message:
          "Set up two-step sign-in to continue. Owners and admins must use it.",
      });
    }
    expect(
      (
        await caller.get(
          "http://localhost:3000/api/auth/get-session",
          added.cookie,
        )
      ).status,
    ).toBe(200);
    const twoStep = await caller.enableTwoStep(added.cookie);
    expect(
      (
        await caller.get(
          "http://localhost:3000/api/auth/organization/list",
          twoStep.cookie,
        )
      ).status,
    ).toBe(200);

    // A gated user may still sign out.
    const viewerPromoted = await caller.post(
      "organization/update-member-role",
      {
        memberId: viewer.memberId,
        role: "admin",
        organizationId: owner.teamId,
      },
      { cookie: owner.cookie },
    );
    expect(viewerPromoted.status).toBe(200);
    expect(
      (await caller.post("sign-out", {}, { cookie: viewer.cookie })).status,
    ).toBe(200);
    expect(await caller.session(viewer.cookie)).toBeNull();
  });
});
