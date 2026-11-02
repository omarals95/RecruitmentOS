import { describe, expect, it } from "vitest";
import {
  boundedAuthRequest,
  canRegisterEmail,
  isUsableAuthSecret,
  requireVerifiedIdentity,
  validateInvitationRole,
} from "../src/lib/auth-policy";

describe("registration and verified identity policy", () => {
  it("blocks unsolicited registration in invite-only mode", () => {
    expect(
      canRegisterEmail("candidate@example.test", {
        publicSignup: false,
        bootstrapOwnerEmail: "owner@example.test",
        hasPendingInvitation: false,
      }),
    ).toBe(false);
  });
  it("accepts only a matching bootstrap email, pending invite, or explicit public signup", () => {
    expect(
      canRegisterEmail(" Owner@Example.test ", {
        publicSignup: false,
        bootstrapOwnerEmail: "owner@example.test",
        hasPendingInvitation: false,
      }),
    ).toBe(true);
    expect(
      canRegisterEmail("person@example.test", {
        publicSignup: false,
        hasPendingInvitation: true,
      }),
    ).toBe(true);
    expect(
      canRegisterEmail("person@example.test", {
        publicSignup: true,
        hasPendingInvitation: false,
      }),
    ).toBe(true);
    expect(
      canRegisterEmail("", { publicSignup: true, hasPendingInvitation: true }),
    ).toBe(false);
  });
  it("does not treat a session as proof of a verified account", () => {
    expect(() => requireVerifiedIdentity(null)).toThrow("Sign in");
    expect(() =>
      requireVerifiedIdentity({ user: { emailVerified: false } }),
    ).toThrow("Verify");
    const verified = { user: { emailVerified: true } };
    expect(requireVerifiedIdentity(verified)).toBe(verified);
  });
  it("rejects unknown or combined invitation roles", () => {
    for (const role of ["root", "admin,owner", "member", ""])
      expect(() => validateInvitationRole(role)).toThrow();
    for (const role of ["owner", "admin", "recruiter", "viewer"])
      expect(validateInvitationRole(role)).toBe(role);
  });
  it("bounds auth request bytes even without a Content-Length header", async () => {
    const request = new Request(
      "https://recruitment.example/api/auth/sign-in/email",
      { method: "POST", body: "x".repeat(65_537) },
    );
    await expect(boundedAuthRequest(request)).rejects.toThrow("too large");
    const accepted = await boundedAuthRequest(
      new Request("https://recruitment.example/api/auth/sign-in/email", {
        method: "POST",
        body: JSON.stringify({ email: "person@example.test" }),
      }),
    );
    expect(await accepted.json()).toEqual({ email: "person@example.test" });
  });
  it("accepts framework-wrapped Requests without accessing native private state", async () => {
    const native = new Request(
      "https://recruitment.example/api/auth/sign-in/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://recruitment.example",
        },
        body: JSON.stringify({ email: "person@example.test" }),
      },
    );
    const frameworkRequest = new Proxy(native, {
      get(target, key) {
        return Reflect.get(target, key, target);
      },
    });
    const accepted = await boundedAuthRequest(frameworkRequest);
    expect(accepted.url).toBe(native.url);
    expect(accepted.method).toBe("POST");
    expect(accepted.headers.get("origin")).toBe("https://recruitment.example");
    expect(await accepted.json()).toEqual({ email: "person@example.test" });
  });
  it("rejects placeholder, repeated and whitespace-containing authentication secrets", () => {
    for (const secret of [
      undefined,
      "short",
      "replace-with-at-least-32-random-characters",
      "your-secret-value-with-at-least-32-characters",
      "x".repeat(40),
      ` ${"abcd".repeat(10)}`,
      `${"abcd".repeat(10)}\n`,
    ])
      expect(isUsableAuthSecret(secret)).toBe(false);
    expect(
      isUsableAuthSecret(
        "34c84503f6917b4103a6141e4050fe29cd2c9d14d973b68c75514776b66acc99",
      ),
    ).toBe(true);
  });
});
