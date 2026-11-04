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
  it("adds a fresh correlation ID to every error and logs only a safe 500 category", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const ids: string[] = [];
    try {
      for (const [error, status] of [
        [new ApiError(404, "not_found", "Record not found in this team."), 404],
        [
          Object.assign(new Error("fictional unique detail"), {
            code: "23505",
          }),
          409,
        ],
        [new Error("secret-password database-connection-string"), 500],
      ] as const) {
        const response = errorResponse(error);
        expect(response.status).toBe(status);
        const header = response.headers.get("x-correlation-id");
        expect(header).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        const body = await response.json();
        expect(Object.keys(body.error).sort()).toEqual([
          "code",
          "correlationId",
          "message",
        ]);
        expect(body.error.correlationId).toBe(header);
        ids.push(header!);
      }
      expect(new Set(ids).size).toBe(3);
      expect(logged).toHaveBeenCalledTimes(1);
      const line = logged.mock.calls[0].join(" ");
      expect(line).toContain(ids[2]);
      expect(line).toContain("Error");
      expect(line).not.toContain("secret-password");
      expect(line).not.toContain("connection-string");
      expect(line).not.toContain("fictional unique detail");
    } finally {
      logged.mockRestore();
    }
  });
});
