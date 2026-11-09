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
const PUBLIC_PATHS = ["/api/openapi.json", "/api/auth/{path}", "/api/version"];
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
    for (const path of [
      "/api/v1/candidates/{id}/cvs",
      "/api/v1/cvs/{id}/download",
      "/api/v1/cvs/{id}/manifest",
      "/api/v1/cvs/{id}/chunks",
    ])
      expect(document.paths[path].get["x-required-scopes"], path).toEqual([
        "cvs:read",
        "candidates:read",
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

  it("documents the bulk intake routes, their limits and the real upload capability", () => {
    const bulk = {
      "/api/v1/cvs/bulk-batches": "get",
      "/api/v1/cvs/bulk-batches/{batchId}": "get",
      "/api/v1/cvs/bulk-batches/{batchId}/items/{itemId}": "post",
      "/api/v1/cvs/bulk-batches/{batchId}/items/{itemId}/upload": "post",
    };
    for (const [path, method] of Object.entries(bulk))
      expect(document.paths[path][method]["x-required-scopes"], path).toEqual([
        "cvs:write",
        "candidates:write",
      ]);
    const item = JSON.stringify(
      document.paths["/api/v1/cvs/bulk-batches/{batchId}/items/{itemId}"],
    );
    for (const code of [
      "STORAGE_SETUP_REQUIRED",
      "bulk_batch_expired",
      "bulk_batch_limit",
      "bulk_item_conflict",
      "bulk_review_required",
      "bulk_duplicates_changed",
    ])
      expect(item).toContain(code);
    expect(
      JSON.stringify(
        document.paths[
          "/api/v1/cvs/bulk-batches/{batchId}/items/{itemId}/upload"
        ],
      ),
    ).toContain("bulk_candidate_required");
    const listed = JSON.stringify(document.paths["/api/v1/cvs/bulk-batches"]);
    for (const text of [
      "invalid_query",
      "pagination",
      "pageSize",
      "possibleDuplicates",
    ])
      expect(listed).toContain(text);
    expect(
      JSON.stringify(document.paths["/api/v1/cvs/bulk-batches/{batchId}"]),
    ).toContain("404 not_found");
    const reupload = JSON.stringify(
      document.paths[
        "/api/v1/cvs/bulk-batches/{batchId}/items/{itemId}/upload"
      ],
    );
    for (const text of ["new server-chosen clientUploadId", "blob-put-v1"])
      expect(reupload).toContain(text);
    expect(JSON.stringify(document)).not.toContain(
      "deleted when its user next imports",
    );
    const capability = JSON.stringify(
      document.paths["/api/v1/cvs/bulk-capabilities"],
    );
    expect(capability).not.toMatch(/always reports uploads/i);
    expect(capability).toContain("uploadsAvailable:boolean");
    expect(capability).toContain("aiAvailable:boolean");
    expect(capability).toContain("none is configured in this build");
    for (const code of [
      "aiReview",
      "ai_review_invalid",
      "ai_review_incomplete",
    ])
      expect(item).toContain(code);
  });

  it("documents the AI extraction consent and job contract", () => {
    const consent = JSON.stringify(
      document.paths["/api/v1/extraction-consent"],
    );
    for (const code of ["ai_not_configured", "ai_disclosure_changed"])
      expect(consent).toContain(code);
    const jobs = document.paths["/api/v1/extraction-jobs"].post;
    expect(jobs["x-required-scopes"]).toEqual([
      "cvs:write",
      "candidates:write",
    ]);
    expect(Object.keys(jobs.responses)).toEqual(
      expect.arrayContaining(["200", "400", "409", "413", "429", "502", "504"]),
    );
    const text = JSON.stringify(jobs);
    for (const code of [
      "ai_not_configured",
      "invalid_input",
      "ai_file_too_large",
      "ai_digest_mismatch",
      "INVALID_CV",
      "ai_disclosure_changed",
      "ai_consent_required",
      "ai_request_used",
      "ai_budget_exhausted",
      "ai_timed_out",
      "ai_rate_limited",
      "ai_quota_exhausted",
      "ai_provider_failed",
      "ai_invalid_response",
      "ai_cancelled",
    ])
      expect(text).toContain(code);
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

  it("documents CV storage cleanup, team storage settings and the upload rate limit", () => {
    const cleanup = document.paths["/api/v1/cvs/storage-reconciliation"].post;
    expect(cleanup["x-required-scopes"]).toEqual(["cvs:write"]);
    const text = JSON.stringify(cleanup);
    for (const code of [
      "storage_reconciliation_forbidden",
      "STORAGE_RECONCILIATION_UNSUPPORTED",
      "STORAGE_SETUP_REQUIRED",
      "STORAGE_RECONCILIATION_COOLDOWN",
      "complete",
    ])
      expect(text).toContain(code);
    expect(cleanup.responses["429"].headers?.["Retry-After"]?.$ref).toBe(
      "#/components/headers/Retry-After",
    );
    const settings = JSON.stringify(
      document.paths["/api/v1/teams/storage-settings"],
    );
    for (const text of [
      "storage_settings_forbidden",
      "invalid_input",
      "STORAGE_QUOTA_EXCEEDED",
      "storage.settings_updated",
      "application limits, not hard provider caps",
      "mcpCvTextEnabled",
    ])
      expect(settings).toContain(text);
    expect(
      JSON.stringify(
        document.paths["/api/v1/teams/storage-settings"].put.requestBody,
      ),
    ).toContain(
      '"required":["maxBytes","maxFiles","uploadRequestsPerMinute","mcpCvTextEnabled"]',
    );
    const mcp = document.paths["/api/mcp"].post;
    for (const text of [
      "get_cv_text",
      "upload_cv",
      "create_cv_upload_link",
      "open_bulk_import_page",
      "cvs:write is offered",
      "4,400,000",
    ])
      expect(JSON.stringify(mcp)).toContain(text);
    expect(mcp.security).toContainEqual({
      oauth2: expect.arrayContaining(["cvs:write"]),
    });
    for (const path of [
      "/api/v1/candidates/{id}/cvs/uploads",
      "/api/v1/cvs/bulk-batches/{batchId}/items/{itemId}/upload",
    ]) {
      const upload = document.paths[path].post;
      expect(JSON.stringify(upload), path).toContain("CV_UPLOAD_RATE_LIMITED");
      expect(JSON.stringify(upload), path).toContain("CV_UPLOAD_TICKET_LIMIT");
      expect(upload.responses["429"].headers?.["Retry-After"]?.$ref).toBe(
        "#/components/headers/Retry-After",
      );
    }
    expect(JSON.stringify(document)).not.toContain(
      "Blob storage is currently disabled",
    );
  });

  it("documents skill suggestions, case-insensitive skill filters and application labels", () => {
    const suggestions = document.paths["/api/v1/candidates/suggestions"].get;
    expect(suggestions["x-required-scopes"]).toEqual(["candidates:read"]);
    const text = JSON.stringify(suggestions);
    for (const phrase of [
      "no query parameters",
      "invalid_query",
      "active candidates",
      "most common spelling",
      "at most 200",
      "skills: string[]",
      "certifications: string[]",
    ])
      expect(text).toContain(phrase);
    const list = JSON.stringify(document.paths["/api/v1/candidates"].get);
    expect(list).toContain("ignoring case and surrounding spaces");
    for (const name of ["skills", "certifications"])
      expect(list).toContain(`"name":"${name}"`);
    const record = document.components.schemas.RecordDto.properties!;
    expect(JSON.stringify(record.candidateLabel)).toContain(
      "Left out without candidates:read",
    );
    expect(JSON.stringify(record.vacancyLabel)).toContain("Untitled vacancy");
  });

  it("documents candidate erasure as session-only, owner-only and typed", () => {
    const erasure = document.paths["/api/v1/candidates/{id}/erasure"].post;
    expect(erasure["x-session-only"]).toBe(true);
    expect(erasure["x-required-scopes"]).toEqual([]);
    const text = JSON.stringify(erasure);
    for (const code of [
      "team owner",
      "confirmName",
      "erasure_forbidden",
      "session_required",
      "erasure_confirmation_mismatch",
      "invalid_input",
      "not_found",
      "idempotency_expired",
      "alreadyErased",
      "erasureId",
      "erasedAt",
      "removed",
      "cvStorage",
      "deleteAfter",
      "There is no MCP tool",
      "erasure_storage_settlement_failed",
      "whole phrase",
      "at least 3 characters",
    ])
      expect(text).toContain(code);
  });

  it("rejects Bearer tokens on session-only operations", async () => {
    const sessionOnly = operations.filter(
      ({ operation }) => operation["x-session-only"],
    );
    expect(sessionOnly.map(({ label }) => label).sort()).toEqual(
      [
        "DELETE /api/settings/tokens/{id}",
        "GET /api/settings/tokens",
        "GET /api/v1/extraction-consent",
        "POST /api/oauth/consent",
        "POST /api/settings/tokens",
        "POST /api/v1/extraction-consent",
        "POST /api/v1/extraction-jobs",
        "POST /api/v1/teams/bootstrap",
        "GET /api/v1/teams/storage-settings",
        "PUT /api/v1/teams/storage-settings",
        "POST /api/v1/teams/two-step-reset",
        "POST /api/v1/speed-samples",
        "GET /api/v1/teams/speed",
        "POST /api/v1/candidates/{id}/erasure",
        "GET /api/v1/org-units",
        "POST /api/v1/org-units",
        "PATCH /api/v1/org-units/{id}",
        "GET /api/v1/org-units/levels",
        "POST /api/v1/org-units/levels",
        "PATCH /api/v1/org-units/levels/{id}",
        "GET /api/v1/positions",
        "POST /api/v1/positions",
        "PATCH /api/v1/positions/{id}",
        "GET /api/v1/employees",
        "POST /api/v1/employees",
        "PATCH /api/v1/employees/{id}",
        "PUT /api/v1/employees/{id}/positions",
      ].sort(),
    );
    for (const { label, operation } of sessionOnly) {
      const response = await probe(label, operation, [...SCOPES]);
      expect(response.status, label).toBe(403);
      expect((await response.json()).error.code, label).toBe(
        "session_required",
      );
    }
  });
});
