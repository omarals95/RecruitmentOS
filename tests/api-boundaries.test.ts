import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { z } from "zod";
vi.mock("@/lib/auth-session", () => ({
  getSession: vi.fn(),
  getVerifiedSession: vi.fn(),
}));
vi.mock("@/lib/api-tokens", () => ({ authenticateApiToken: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));
import { checkOrigin, readBody, errorResponse, json, runApi } from "@/lib/api";
import { authenticateApiToken } from "@/lib/api-tokens";
import { getSession, getVerifiedSession } from "@/lib/auth-session";
import { ApiError } from "@/lib/errors";
import {
  resolveStorageBinding,
  StorageConfigurationError,
} from "@/lib/storage";
import { getWorkspaceContext } from "@/lib/workspace";
import { GET as overviewRoute } from "@/app/api/v1/overview/route";
import { member } from "@/db/auth-schema";
import { createTestDb, seedIdentity } from "./helpers/db";
import { stubLocalAuthReadiness } from "./helpers/readiness";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A Bearer request, which skips the origin check, to a fictional create endpoint. */
function bearerRequest(init: RequestInit = {}) {
  return new Request("http://localhost/api/v1/candidates", {
    method: "POST",
    ...init,
    headers: {
      authorization: "Bearer ros_live_fictional",
      "content-type": "application/json",
    },
  });
}
async function errorOf(response: Response) {
  const body = (await response.json()) as {
    error: { code: string; message: string; correlationId: string };
  };
  expect(body.error.correlationId).toMatch(UUID);
  expect(body.error.correlationId).toBe(
    response.headers.get("x-correlation-id"),
  );
  return body.error;
}
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
  describe("through runApi", () => {
    let logged: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      vi.mocked(authenticateApiToken).mockResolvedValue({
        userId: "fictional-user",
        teamId: "fictional-team",
        role: "recruiter",
        scopes: ["candidates:write"],
        authType: "token",
        tokenId: "fictional-token",
      });
      logged = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    it("answers a body that fails mid-read with a quiet 499 request_cancelled", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"name":"Fictional'));
        },
        pull(controller) {
          controller.error(
            Object.assign(new Error("fictional socket hang up"), {
              code: "ECONNRESET",
            }),
          );
        },
      });
      const request = bearerRequest({ body, duplex: "half" } as RequestInit);
      const response = await runApi(request, undefined, async () =>
        json({ data: await readBody(request, z.unknown()) }, 201),
      );
      expect(response.status).toBe(499);
      expect((await errorOf(response)).code).toBe("request_cancelled");
      expect(logged).not.toHaveBeenCalled();
    });

    it("answers any unexpected error on an aborted request with a quiet 499, and logs it on a live one", async () => {
      const controller = new AbortController();
      controller.abort();
      const fail = async (): Promise<Response> => {
        throw new Error("fictional failure after the client left");
      };
      const cancelled = await runApi(
        bearerRequest({ signal: controller.signal }),
        undefined,
        fail,
      );
      expect(cancelled.status).toBe(499);
      expect((await errorOf(cancelled)).code).toBe("request_cancelled");
      expect(logged).not.toHaveBeenCalled();
      const live = await runApi(bearerRequest(), undefined, fail);
      expect(live.status).toBe(500);
      const { correlationId } = await errorOf(live);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]).toEqual([
        `internal_error correlationId=${correlationId} category=Error`,
      ]);
    });

    it("keeps an ApiError's own status even when the request was aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const response = await runApi(
        bearerRequest({ signal: controller.signal }),
        undefined,
        async () => {
          throw new ApiError(
            404,
            "not_found",
            "Record not found in this team.",
          );
        },
      );
      expect(response.status).toBe(404);
      expect(logged).not.toHaveBeenCalled();
    });

    it("answers a raw StorageConfigurationError with the generic 503 and one safe log line", async () => {
      const secret = "fictional setting S3_BUCKET_NAME=fictional-bucket";
      const response = await runApi(bearerRequest(), undefined, async () => {
        throw new StorageConfigurationError(secret, "not_configured");
      });
      expect(response.status).toBe(503);
      const error = await errorOf(response);
      expect(error.code).toBe("STORAGE_SETUP_REQUIRED");
      expect(error.message).not.toContain("S3_BUCKET_NAME");
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]).toEqual([
        `storage_configuration_error correlationId=${error.correlationId} code=STORAGE_SETUP_REQUIRED reason=not_configured`,
      ]);
    });

    it("answers 503 STORAGE_SETUP_REQUIRED for a hosted deployment without a provider", async () => {
      const response = await runApi(bearerRequest(), undefined, async () => {
        resolveStorageBinding({
          VERCEL: "1",
          VERCEL_ENV: "preview",
          BLOB_STORE_ID: "store_fictional",
        });
        return new Response(null, { status: 204 });
      });
      expect(response.status).toBe(503);
      const error = await errorOf(response);
      expect(error.code).toBe("STORAGE_SETUP_REQUIRED");
      expect(logged.mock.calls).toEqual([
        [
          `storage_configuration_error correlationId=${error.correlationId} code=STORAGE_SETUP_REQUIRED reason=not_configured`,
        ],
      ]);
    });
  });
});

describe("two-step gate on API routes and /app pages", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  const identity = (userId: string, twoFactorEnabled: boolean) => ({
    user: {
      id: userId,
      name: "Fictional Person",
      email: `${userId}@example.test`,
      emailVerified: true,
      twoFactorEnabled,
    },
    session: { activeOrganizationId: "gate-team" },
  });
  const overview = () =>
    overviewRoute(
      new Request("http://localhost:3000/api/v1/overview", {
        headers: { "x-team-id": "gate-team" },
      }),
    );
  beforeAll(async () => {
    stubLocalAuthReadiness();
    fixture = await createTestDb();
    await seedIdentity(fixture.db, {
      userId: "gate-owner",
      teamId: "gate-other-team",
    });
    // Recruiter in the active team but admin of another one: the gate counts every team.
    await seedIdentity(fixture.db, {
      userId: "gate-admin-elsewhere",
      teamId: "gate-team",
      role: "recruiter",
      twoFactorEnabled: false,
    });
    await fixture.db.insert(member).values({
      id: "gate-admin-elsewhere:gate-other-team",
      organizationId: "gate-other-team",
      userId: "gate-admin-elsewhere",
      role: "admin",
    });
    await seedIdentity(fixture.db, {
      userId: "gate-viewer",
      teamId: "gate-team",
      role: "viewer",
      twoFactorEnabled: false,
    });
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await fixture?.close();
  });

  it("refuses a setup-required session with 403 two_step_setup_required and admits recruiters and viewers", async () => {
    vi.mocked(getVerifiedSession).mockResolvedValue(
      identity("gate-admin-elsewhere", false) as never,
    );
    const refused = await overview();
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toMatchObject({
      code: "two_step_setup_required",
      message:
        "Set up two-step sign-in to continue. Owners and admins must use it.",
    });
    vi.mocked(getVerifiedSession).mockResolvedValue(
      identity("gate-admin-elsewhere", true) as never,
    );
    expect((await overview()).status).toBe(200);
    vi.mocked(getVerifiedSession).mockResolvedValue(
      identity("gate-viewer", false) as never,
    );
    expect((await overview()).status).toBe(200);
  });

  it("redirects every /app page of a setup-required user to the setup screen", async () => {
    vi.mocked(getSession).mockResolvedValue(
      identity("gate-admin-elsewhere", false) as never,
    );
    await expect(getWorkspaceContext()).rejects.toMatchObject({
      url: "/two-step-setup?next=/app",
    });
    vi.mocked(getSession).mockResolvedValue(
      identity("gate-viewer", false) as never,
    );
    expect((await getWorkspaceContext()).user).toMatchObject({
      id: "gate-viewer",
      twoStepEnabled: false,
    });
  });
});
