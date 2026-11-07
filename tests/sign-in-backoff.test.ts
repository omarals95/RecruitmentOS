import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_EMAIL,
  PASSWORD,
  TEST_SECRET,
  authCaller,
  createAuthDb,
  createTestAuth,
  setUpAdmin,
  type Mail,
} from "./helpers/auth";

const MESSAGE = "Too many sign-in attempts. Wait a few minutes and try again.";
/** The stored key for an address, derived independently of the code under test. */
function backoffKey(email: string) {
  const key = createHmac("sha256", TEST_SECRET)
    .update("recruitmentos:rate-limit-key:v1")
    .digest();
  return `sign-in-email:${createHmac("sha256", key).update(email.trim().toLowerCase()).digest("base64url")}`;
}

describe("per-email sign-in backoff", () => {
  const mail: Mail[] = [];
  let h: Awaited<ReturnType<typeof createAuthDb>>;
  let caller: ReturnType<typeof authCaller>;
  let ip = 0;
  // Every attempt comes from a new client address, so the per-IP limit never applies.
  const attempt = async (email: string, password: string) => {
    ip += 1;
    const response = await caller.post(
      "sign-in/email",
      { email, password },
      { ip: `198.51.100.${ip}` },
    );
    return {
      status: response.status,
      body: await response.text(),
      retryAfter: response.headers.get("retry-after"),
    };
  };
  const wrong = (email: string) => attempt(email, "a-wrong-fictional-password");
  const row = async (email: string) =>
    (
      await h.pg.query<{ count: number }>(
        "SELECT count FROM auth.api_rate_limits WHERE key=$1",
        [backoffKey(email)],
      )
    ).rows[0];
  const rewind = (email: string, seconds: number) =>
    h.asOwner(
      `UPDATE auth.api_rate_limits SET window_start = window_start - interval '${seconds} seconds' WHERE key = '${backoffKey(email)}';`,
    );
  beforeAll(async () => {
    h = await createAuthDb();
    caller = authCaller(createTestAuth(h.db, mail));
    await setUpAdmin(caller, mail);
  });
  afterAll(async () => h.pg.close());

  it("refuses the 6th attempt for an existing or unknown address alike, then doubles the delay", async () => {
    const outcomes = [];
    for (const email of [BOOTSTRAP_EMAIL, "nobody-backoff@example.test"]) {
      const seen = [];
      for (let n = 0; n < 5; n++) seen.push(await wrong(email));
      // Refused before the password is checked, even when it is right.
      seen.push(await attempt(email, PASSWORD));
      outcomes.push(seen);
      expect((await row(email)).count).toBe(5);
    }
    const [existing, unknown] = outcomes;
    expect(existing.map((item) => item.status)).toEqual([
      401, 401, 401, 401, 401, 429,
    ]);
    expect(unknown.map((item) => item.status)).toEqual(
      existing.map((item) => item.status),
    );
    expect(unknown.map((item) => item.body)).toEqual(
      existing.map((item) => item.body),
    );
    for (const refused of [existing[5], unknown[5]]) {
      expect(JSON.parse(refused.body)).toMatchObject({ message: MESSAGE });
      expect(Number(refused.retryAfter)).toBeGreaterThanOrEqual(58);
      expect(Number(refused.retryAfter)).toBeLessThanOrEqual(60);
    }
    expect(existing.slice(0, 5).every((item) => item.retryAfter === null)).toBe(
      true,
    );

    // A minute after the 5th failure one more attempt is checked; the 6th failure waits 2 minutes.
    await rewind(BOOTSTRAP_EMAIL, 61);
    expect((await wrong(BOOTSTRAP_EMAIL)).status).toBe(401);
    const longer = await wrong(BOOTSTRAP_EMAIL);
    expect(longer.status).toBe(429);
    expect(Number(longer.retryAfter)).toBeGreaterThanOrEqual(118);
    expect(Number(longer.retryAfter)).toBeLessThanOrEqual(120);
    expect((await row(BOOTSTRAP_EMAIL)).count).toBe(6);

    // A correct password (here a two-step challenge) clears the address.
    await rewind(BOOTSTRAP_EMAIL, 121);
    const correct = await attempt(BOOTSTRAP_EMAIL, PASSWORD);
    expect(correct.status).toBe(200);
    expect(JSON.parse(correct.body)).toMatchObject({ twoFactorRedirect: true });
    expect(await row(BOOTSTRAP_EMAIL)).toBeUndefined();
  });

  it("starts again after 15 quiet minutes", async () => {
    const email = "quiet-backoff@example.test";
    for (let n = 0; n < 5; n++) expect((await wrong(email)).status).toBe(401);
    expect((await wrong(email)).status).toBe(429);
    await rewind(email, 15 * 60);
    expect((await wrong(email)).status).toBe(401);
    expect((await row(email)).count).toBe(1);
  });

  it("checks at most 5 passwords out of 8 concurrent attempts on a fresh address", async () => {
    const email = "burst-backoff@example.test";
    const statuses = (
      await Promise.all(Array.from({ length: 8 }, () => wrong(email)))
    ).map((item) => item.status);
    expect(
      statuses.filter((status) => status === 401).length,
    ).toBeLessThanOrEqual(5);
    expect(
      statuses.filter((status) => status === 429).length,
    ).toBeGreaterThanOrEqual(3);
    expect(statuses.every((status) => status === 401 || status === 429)).toBe(
      true,
    );
  });

  it("still ends the challenged password session when clearing the backoff fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await h.asOwner(
      "REVOKE DELETE ON auth.api_rate_limits FROM identity_flow_runtime;",
    );
    try {
      const sessions = () =>
        h.count(
          `SELECT count(*) FROM auth.session s JOIN auth."user" u ON u.id=s.user_id WHERE u.email=$1`,
          [BOOTSTRAP_EMAIL],
        );
      const before = await sessions();
      const correct = await attempt(BOOTSTRAP_EMAIL, PASSWORD);
      expect(correct.status).toBe(200);
      expect(JSON.parse(correct.body)).toMatchObject({
        twoFactorRedirect: true,
      });
      expect(await sessions()).toBe(before);
      const lines = logged.mock.calls.map((call) => call.join(" "));
      expect(lines).toContain("sign_in_backoff_clear_failed sqlstate=42501");
      for (const line of lines) expect(line).not.toContain(BOOTSTRAP_EMAIL);
    } finally {
      await h.asOwner(
        "GRANT DELETE ON auth.api_rate_limits TO identity_flow_runtime;",
      );
      logged.mockRestore();
    }
  });

  it("stores only a keyed hash of the address under the sign-in-email prefix", async () => {
    const keys = (
      await h.pg.query<{ key: string }>(
        "SELECT key FROM auth.api_rate_limits WHERE key LIKE 'sign-in-email:%'",
      )
    ).rows.map((item) => item.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain(backoffKey("nobody-backoff@example.test"));
    for (const key of keys) {
      expect(key).toMatch(/^sign-in-email:[A-Za-z0-9_-]{43}$/);
      expect(key).not.toMatch(/@|example|backoff/);
    }
  });
});
