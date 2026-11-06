import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));
vi.mock("@/lib/api-tokens", () => ({ authenticateApiToken: vi.fn() }));
import { authenticateApiToken } from "@/lib/api-tokens";
import { SCOPES, type Scope } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import { mcpScopeDescriptions } from "@/lib/scope-descriptions";
import { resourceToKind } from "@/domain/records";
import { EXPORT_RESOURCES } from "@/domain/export";
import { GET as openApi } from "@/app/api/openapi.json/route";
import {
  createTestDb,
  enforceTestRls,
  seedApiToken,
  seedIdentity,
} from "./helpers/db";

type Handler = (
  request: Request,
  context: { params: Promise<Record<string, string | string[]>> },
) => Promise<Response>;
interface Operation {
  security?: unknown[];
  "x-required-scopes"?: unknown;
  "x-session-only"?: boolean;
  requestBody?: { content?: Record<string, { example?: unknown }> };
  responses: Record<
    string,
    {
      headers?: Record<string, { $ref?: string }>;
      content?: Record<string, { schema?: { $ref?: string } }>;
    }
  >;
}
interface Document {
  paths: Record<string, Record<string, Operation>>;
  components: {
    headers: Record<string, unknown>;
    schemas: Record<string, { properties?: Record<string, unknown> }>;
  };
}
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const PUBLIC_PATHS = ["/api/openapi.json", "/api/auth/{path}"];
const apiRoot = fileURLToPath(new URL("../src/app/api", import.meta.url));

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? routeFiles(join(dir, entry.name))
      : entry.name === "route.ts"
        ? [join(dir, entry.name)]
        : [],
  );
}
/** Map a route file to its OpenAPI paths and the params Next.js would pass. */
function routePaths(file: string) {
  const segments = relative(apiRoot, file).split(sep).slice(0, -1);
  const expand = (resource?: string) => {
    const params: Record<string, string | string[]> = {};
    const path = segments.map((segment) => {
      if (segment === "[...all]") {
        params.all = ["session"];
        return "{path}";
      }
      const param = /^\[(\w+)\]$/.exec(segment)?.[1];
      if (!param) return segment;
      if (param === "resource") {
        params.resource = resource!;
        return resource!;
      }
      params[param] = randomUUID();
      return `{${param}}`;
    });
    return { path: `/api/${path.join("/")}`, params };
  };
  // Only the exportable resources have an export operation; the others return 404.
  return segments.includes("[resource]")
    ? (segments.includes("export")
        ? [...EXPORT_RESOURCES]
        : Object.keys(resourceToKind)
      ).map((resource) => expand(resource))
    : [expand()];
}

describe("OpenAPI contract", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal;
  let document: Document;
  const routes = new Map<
    string,
    { handler: Handler; params: Record<string, string | string[]> }
  >();
  const documented = new Set<string>();
  const operations: {
    label: string;
    path: string;
    method: string;
    operation: Operation;
  }[] = [];

  beforeAll(async () => {
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db, {
      userId: "contract-owner",
      teamId: "contract-team",
    });
    await enforceTestRls(fixture.db);
    for (const file of routeFiles(apiRoot)) {
      const exported = (await import(/* @vite-ignore */ file)) as Record<
        string,
        unknown
      >;
      for (const method of METHODS)
        if (typeof exported[method] === "function")
          for (const { path, params } of routePaths(file))
            routes.set(`${method} ${path}`, {
              handler: exported[method] as Handler,
              params,
            });
    }
    document = (await openApi().json()) as Document;
    for (const [path, item] of Object.entries(document.paths))
      for (const [method, operation] of Object.entries(item)) {
        const label = `${method.toUpperCase()} ${path}`;
        if (!METHODS.includes(method.toUpperCase() as never)) continue;
        documented.add(label);
        operations.push({ label, path, method, operation });
      }
  });
  afterAll(async () => fixture?.close());

  it("documents exactly the route handlers on disk", () => {
    expect(routes.size).toBeGreaterThan(50);
    const undocumented = [...routes.keys()].filter(
      (key) => !documented.has(key),
    );
    const unhandled = [...documented].filter((key) => !routes.has(key));
    expect(
      undocumented,
      `Undocumented routes: ${undocumented.join(", ")}`,
    ).toEqual([]);
    expect(
      unhandled,
      `Documented operations without a handler: ${unhandled.join(", ")}`,
    ).toEqual([]);
  });

  it("declares scopes, public access, error shapes, statuses and examples", () => {
    const { headers, schemas } = document.components;
    expect(headers["X-Correlation-Id"]).toBeDefined();
    expect(headers["Retry-After"]).toBeDefined();
    expect(
      (schemas.Error.properties?.error as { required?: string[] }).required,
    ).toEqual(expect.arrayContaining(["code", "message", "correlationId"]));
    for (const { label, path, operation } of operations) {
      const scopes = operation["x-required-scopes"];
      expect(Array.isArray(scopes), `${label} x-required-scopes`).toBe(true);
      for (const scope of scopes as unknown[])
        expect(SCOPES, `${label} scope ${String(scope)}`).toContain(scope);
      const isPublic =
        Array.isArray(operation.security) && operation.security.length === 0;
      expect(isPublic, `${label} security: []`).toBe(
        PUBLIC_PATHS.includes(path),
      );
      for (const [status, response] of Object.entries(operation.responses)) {
        if (Number(status) < 400) continue;
        expect(
          response.content?.["application/json"]?.schema?.$ref,
          `${label} ${status} schema`,
        ).toBe("#/components/schemas/Error");
        expect(
          response.headers?.["X-Correlation-Id"]?.$ref,
          `${label} ${status} X-Correlation-Id`,
        ).toBe("#/components/headers/X-Correlation-Id");
        if (status === "429")
          expect(
            response.headers?.["Retry-After"]?.$ref,
            `${label} 429 Retry-After`,
          ).toBe("#/components/headers/Retry-After");
      }
      if (!isPublic) {
        const required = operation["x-session-only"]
          ? ["401", "403", "500"]
          : ["401", "403", "429", "500"];
        for (const status of required)
          expect(
            Object.keys(operation.responses),
            `${label} documents ${status}`,
          ).toContain(status);
      }
      if (operation.requestBody)
        expect(
          operation.requestBody.content?.["application/json"]?.example,
          `${label} request example`,
        ).toBeDefined();
    }
  });

  async function probe(
    label: string,
    operation: Operation,
    scopes: Scope[],
  ): Promise<Response> {
    vi.mocked(authenticateApiToken).mockResolvedValue(
      await seedApiToken(fixture.db, owner, scopes),
    );
    const { handler, params } = routes.get(label)!;
    const [method, path] = label.split(" ");
    const url = `http://localhost:3000${path.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]))}`;
    const example =
      operation.requestBody?.content?.["application/json"]?.example;
    const response = await handler(
      new Request(url, {
        method,
        headers: {
          authorization: "Bearer fictional-contract-token",
          ...(example === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: example === undefined ? undefined : JSON.stringify(example),
      }),
      { params: Promise.resolve(params) },
    );
    const context = `${label} with [${scopes.join(", ")}] -> ${response.status}`;
    expect(response.headers.get("cache-control"), context).toBe("no-store");
    expect(response.headers.get("x-content-type-options"), context).toBe(
      "nosniff",
    );
    if (response.status >= 400) {
      expect(Object.keys(operation.responses), context).toContain(
        String(response.status),
      );
      const body = await response.clone().json();
      expect(body, context).toEqual({
        error: {
          code: expect.any(String),
          message: expect.any(String),
          correlationId: expect.any(String),
        },
      });
      expect(response.headers.get("x-correlation-id"), context).toBe(
        body.error.correlationId,
      );
    }
    return response;
  }

  it("enforces every documented token scope at the real route handlers", async () => {
    for (const { label, path, operation } of operations) {
      if (PUBLIC_PATHS.includes(path) || operation["x-session-only"]) continue;
      const scopes = operation["x-required-scopes"] as Scope[];
      for (const scope of scopes) {
        const response = await probe(
          label,
          operation,
          SCOPES.filter((item) => item !== scope),
        );
        expect(response.status, `${label} without ${scope}`).toBe(403);
      }
      const response = await probe(label, operation, scopes);
      expect(response.status, `${label} with exactly its scopes`).not.toBe(403);
    }
  });

  it("documents the tagged CV upload and the Blob manifest and chunk reads", () => {
    const reservation = JSON.stringify(
      document.paths["/api/v1/candidates/{id}/cvs/uploads"].post.responses[
        "201"
      ],
    );
    const schemas = JSON.stringify(document.components.schemas);
    for (const protocol of ["s3-form-v1", "blob-put-v1"]) {
      expect(reservation).toContain(protocol);
      expect(schemas).toContain(`{"const":"${protocol}"}`);
    }
    expect(reservation).toContain('"propertyName":"protocol"');
    for (const path of ["/api/v1/cvs/{id}/manifest", "/api/v1/cvs/{id}/chunks"])
      expect(document.paths[path].get["x-required-scopes"], path).toEqual([
        "cvs:read",
      ]);
    const chunks = document.paths["/api/v1/cvs/{id}/chunks"]
      .get as Operation & {
      parameters: { name: string; in: string; required?: boolean }[];
    };
    expect(chunks.parameters).toContainEqual(
      expect.objectContaining({ name: "index", in: "query", required: true }),
    );
    expect(Object.keys(chunks.responses)).toEqual(
      expect.arrayContaining(["200", "400", "404", "409", "503"]),
    );
    expect(Object.keys(chunks.responses["200"].content ?? {})).toEqual([
      "application/octet-stream",
    ]);
  });

  it("describes OAuth scopes with the MCP consent wording", () => {
    const { securitySchemes } = document.components as unknown as {
      securitySchemes: {
        oauth2: { flows: { authorizationCode: { scopes: unknown } } };
      };
    };
    expect(securitySchemes.oauth2.flows.authorizationCode.scopes).toEqual(
      mcpScopeDescriptions,
    );
  });

  it("rejects Bearer tokens on session-only operations", async () => {
    const sessionOnly = operations.filter(
      ({ operation }) => operation["x-session-only"],
    );
    expect(sessionOnly.map(({ label }) => label).sort()).toEqual([
      "DELETE /api/settings/tokens/{id}",
      "GET /api/settings/tokens",
      "POST /api/oauth/consent",
      "POST /api/settings/tokens",
      "POST /api/v1/teams/bootstrap",
    ]);
    for (const { label, operation } of sessionOnly) {
      const response = await probe(label, operation, [...SCOPES]);
      expect(response.status, label).toBe(403);
      expect((await response.json()).error.code, label).toBe(
        "session_required",
      );
    }
  });
});
