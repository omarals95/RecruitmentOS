import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { clientIp, clientIpHeader } from "@/lib/client-ip";
import {
  ORIGIN,
  createAuthDb,
  createTestAuth,
  type Mail,
} from "./helpers/auth";

const spoofed = {
  "x-forwarded-for": "198.51.100.1",
  "x-real-ip": "198.51.100.2",
  forwarded: "for=198.51.100.3",
};

describe("client IP resolution", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses only x-vercel-forwarded-for on Vercel", () => {
    vi.stubEnv("VERCEL", "1");
    expect(clientIpHeader()).toBe("x-vercel-forwarded-for");
    expect(
      clientIp(new Headers({ "x-vercel-forwarded-for": "203.0.113.7" })),
    ).toBe("203.0.113.7");
    expect(
      clientIp(
        new Headers({ "x-vercel-forwarded-for": "2001:DB8:1:2:3:4:5:6" }),
      ),
    ).toBe("2001:0db8:0001:0002:0000:0000:0000:0000");
    expect(
      clientIp(new Headers({ "x-vercel-forwarded-for": "::ffff:192.0.2.1" })),
    ).toBe("192.0.2.1");
  });

  it("ignores spoofed x-forwarded-for, x-real-ip and forwarded on Vercel", () => {
    vi.stubEnv("VERCEL", "1");
    expect(clientIp(new Headers(spoofed))).toBeNull();
    expect(
      clientIp(
        new Headers({ ...spoofed, "x-vercel-forwarded-for": "203.0.113.7" }),
      ),
    ).toBe("203.0.113.7");
  });

  it("gives no client IP for a multi-valued or invalid value", () => {
    vi.stubEnv("VERCEL", "1");
    for (const value of [
      "203.0.113.7, 198.51.100.1",
      "198.51.100.1,203.0.113.7",
      "not-an-ip",
      "203.0.113.7:443",
      "",
    ])
      expect(
        clientIp(new Headers({ "x-vercel-forwarded-for": value })),
        value,
      ).toBeNull();
    vi.stubEnv("VERCEL", undefined);
    expect(
      clientIp(new Headers({ "x-forwarded-for": "198.51.100.1, 203.0.113.7" })),
    ).toBeNull();
    expect(clientIp(new Headers({ "x-forwarded-for": "unknown" }))).toBeNull();
  });

  it("uses x-forwarded-for with single-value rules outside Vercel", () => {
    vi.stubEnv("VERCEL", undefined);
    expect(clientIpHeader()).toBe("x-forwarded-for");
    expect(clientIp(new Headers({ "x-forwarded-for": "198.51.100.1" }))).toBe(
      "198.51.100.1",
    );
    expect(
      clientIp(
        new Headers({
          "x-vercel-forwarded-for": "203.0.113.7",
          "x-real-ip": "198.51.100.2",
        }),
      ),
    ).toBeNull();
  });
});

describe("Better Auth rate limits use the Vercel client IP", () => {
  let close: (() => Promise<void>) | undefined;
  afterAll(async () => {
    vi.unstubAllEnvs();
    await close?.();
  });

  it("refuses the 11th sign-in for one x-vercel-forwarded-for despite rotating spoofed headers", async () => {
    vi.stubEnv("VERCEL", "1");
    const h = await createAuthDb();
    close = () => h.pg.close();
    const mail: Mail[] = [];
    const auth = createTestAuth(h.db, mail);
    const signIn = (vercelIp: string, n: number) =>
      auth.handler(
        new Request(`${ORIGIN}/api/auth/sign-in/email`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: ORIGIN,
            "x-vercel-forwarded-for": vercelIp,
            "x-forwarded-for": `198.51.100.${n}`,
            "x-real-ip": `192.0.2.${n}`,
          },
          body: JSON.stringify({
            email: "nobody@example.test",
            password: "a-wrong-fictional-password",
          }),
        }),
      );
    for (let n = 1; n <= 10; n++)
      expect((await signIn("203.0.113.20", n)).status).toBe(401);
    expect((await signIn("203.0.113.20", 11)).status).toBe(429);
    expect((await signIn("203.0.113.21", 12)).status).not.toBe(429);
    expect(mail).toEqual([]);
  });
});
