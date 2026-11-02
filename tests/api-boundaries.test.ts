import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));
vi.mock("@/lib/api-tokens", () => ({ authenticateApiToken: vi.fn() }));
import { checkOrigin, readBody, errorResponse } from "@/lib/api";
import { ApiError } from "@/lib/errors";
describe("request boundaries", () => {
  it("rejects cookie writes without the exact configured origin", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://recruitment.example.test");
    expect(() =>
      checkOrigin(
        new Request("https://recruitment.example.test/api/v1/tasks", {
          method: "POST",
        }),
      ),
    ).toThrow(ApiError);
    expect(() =>
      checkOrigin(
        new Request("https://recruitment.example.test/api/v1/tasks", {
          method: "PATCH",
          headers: { origin: "https://evil.example.test" },
        }),
      ),
    ).toThrow(ApiError);
    expect(() =>
      checkOrigin(
        new Request("https://recruitment.example.test/api/v1/tasks", {
          method: "POST",
          headers: { origin: "https://recruitment.example.test" },
        }),
      ),
    ).not.toThrow();
  });
  it("enforces streaming bounds even without Content-Length", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"name":"'));
        c.enqueue(new TextEncoder().encode("x".repeat(100)));
        c.enqueue(new TextEncoder().encode('"}'));
        c.close();
      },
    });
    const request = new Request("http://localhost/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(
      readBody(request, z.object({ name: z.string() }), 32),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("rejects invalid UTF-8/JSON and strict unknown fields", async () => {
    const make = (body: BodyInit) =>
      new Request("http://localhost/api", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    await expect(
      readBody(make(new Uint8Array([0xff])), z.unknown()),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      readBody(
        make('{"name":"A","teamId":"other"}'),
        z.object({ name: z.string() }).strict(),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("masks internal errors and never serializes database details", async () => {
    const response = errorResponse(
      new Error("secret-password database-connection-string"),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret-password");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
