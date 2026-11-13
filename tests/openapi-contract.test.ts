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
      description?: string;
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

  it("documents the file field upload and attachment-only download routes, Blob only (R2b-06)", () => {
    const write = [
      "/api/v1/record-files/uploads",
      "/api/v1/record-files/uploads/{id}/complete",
    ];
    for (const path of write)
      expect(document.paths[path].post["x-required-scopes"], path).toEqual([
        "cvs:write",
      ]);
    for (const path of [
      "/api/v1/record-files/{id}/manifest",
      "/api/v1/record-files/{id}/chunks",
    ]) {
      expect(document.paths[path].get["x-required-scopes"], path).toEqual([
        "cvs:read",
      ]);
      expect(JSON.stringify(document.paths[path]), path).toContain(
        "404 FILE_NOT_FOUND",
      );
    }
    const upload = JSON.stringify(document.paths[write[0]]);
    for (const code of [
      "FILE_STORAGE_UNSUPPORTED",
      "FILE_UPLOAD_TICKET_LIMIT",
      "STORAGE_QUOTA_EXCEEDED",
      "RECORD_NOT_FOUND",
      "blob-put-v1",
    ])
      expect(upload).toContain(code);
    expect(upload).not.toContain("s3-form-v1");
    const chunks = document.paths["/api/v1/record-files/{id}/chunks"].get;
    expect(JSON.stringify(chunks)).toContain("Content-Disposition: attachment");
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

  it("documents a vacancy's org unit on create, update and responses only (R2a-18)", () => {
    const record = document.components.schemas.RecordDto.properties!;
    for (const key of ["orgUnitId", "orgUnitLabel"])
      expect(JSON.stringify(record[key]), key).toContain(
        "Vacancies with an org unit only",
      );
    const input = (path: string, method: string) =>
      JSON.stringify(document.paths[path][method].requestBody);
    for (const [path, method] of [
      ["/api/v1/vacancies", "post"],
      ["/api/v1/vacancies/{id}", "patch"],
    ]) {
      expect(input(path, method)).toContain('"orgUnitId"');
      expect(input(path, method)).toContain("400 invalid_reference");
    }
    for (const resource of Object.keys(resourceToKind).filter(
      (name) => name !== "vacancies",
    )) {
      expect(input(`/api/v1/${resource}`, "post"), resource).not.toContain(
        "orgUnitId",
      );
      expect(
        input(`/api/v1/${resource}/{id}`, "patch"),
        resource,
      ).not.toContain("orgUnitId");
    }
  });

  it("documents task assignees, links and the Assigned to me filter (R2a-20)", () => {
    const tasks = document.components.schemas.tasks as {
      properties: Record<string, { type?: string; maxItems?: number }>;
    };
    expect(tasks.properties.assigneeIds).toMatchObject({
      type: "array",
      maxItems: 10,
    });
    const parameters = (path: string) =>
      (
        document.paths[path].get as unknown as {
          parameters: { name: string }[];
        }
      ).parameters.map((parameter) => parameter.name);
    expect(parameters("/api/v1/tasks")).toContain("assignedToMe");
    for (const resource of Object.keys(resourceToKind).filter(
      (name) => name !== "tasks",
    ))
      expect(parameters(`/api/v1/${resource}`), resource).not.toContain(
        "assignedToMe",
      );
    const record = document.components.schemas.RecordDto.properties!;
    for (const key of ["parentKind", "parentLabel"])
      expect(JSON.stringify(record[key]), key).toContain(
        "Tasks with a parentRecordId only",
      );
    for (const [path, method] of [
      ["/api/v1/tasks", "post"],
      ["/api/v1/tasks/{id}", "patch"],
    ]) {
      const text = JSON.stringify(document.paths[path][method]);
      for (const code of [
        "invalid_assignee",
        "self_assignment_forbidden",
        "invalid_reference",
      ])
        expect(text, `${method} ${code}`).toContain(code);
    }
    expect(
      JSON.stringify(document.paths["/api/v1/buckets/{id}"].patch),
    ).toContain("moves every active task of the team");
  });

  it("documents hidden export columns and search groups left out by role (R2a-08)", () => {
    for (const resource of EXPORT_RESOURCES)
      expect(
        JSON.stringify(document.paths[`/api/v1/${resource}/export`].post),
        resource,
      ).toContain(
        "Columns for fields the caller's role hides are left out and the rest keep their order.",
      );
    expect(JSON.stringify(document.paths["/api/v1/search"].get)).toContain(
      "each group is included only when the caller's role and scopes allow viewing it (candidates:read or recruitment:read); a group the caller cannot view is left out rather than refused.",
    );
  });

  it("documents field_forbidden, redacted data and refused hidden filters and sorts (R2b-08)", () => {
    for (const [path, method] of [
      ["/api/v1/candidates", "post"],
      ["/api/v1/offers/{id}", "patch"],
    ])
      expect(
        document.paths[path][method].responses["403"].description,
        `${method} ${path}`,
      ).toContain(
        'field_forbidden ("Your role cannot change <key>.", with the key or custom field id as sent)',
      );
    expect(document.components.schemas.RecordDto.properties?.data).toEqual({
      type: "object",
      description:
        "The record's fields. Fields and custom values the caller's role hides are left out.",
    });
    for (const resource of EXPORT_RESOURCES) {
      expect(
        JSON.stringify(document.paths[`/api/v1/${resource}`].get),
        resource,
      ).toContain(
        "Filtering or sorting by a field the caller's role hides returns 400 invalid_query",
      );
      expect(
        JSON.stringify(document.paths[`/api/v1/${resource}/export`].post),
        resource,
      ).toContain(
        "400 invalid_query for an unsupported, repeated or page filter, and for a filter or sort on a field the caller's role hides",
      );
    }
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
      "recordFiles",
      "There is no MCP tool",
      "erasure_storage_settlement_failed",
      "whole phrase",
      "at least 3 characters",
    ])
      expect(text).toContain(code);
  });

  it("documents employee erasure and the retention review as session-only and company owner only, with no name in the erasure response", () => {
    const erasure = document.paths["/api/v1/employees/{id}/erasure"].post;
    const review = document.paths["/api/v1/employees/retention-review"].get;
    for (const operation of [erasure, review]) {
      expect(operation["x-session-only"]).toBe(true);
      expect(operation["x-required-scopes"]).toEqual([]);
      expect(Object.keys(operation.responses)).toEqual(
        expect.arrayContaining(["200", "400", "401", "403", "500"]),
      );
    }
    expect(Object.keys(erasure.responses)).toEqual(
      expect.arrayContaining(["404", "409"]),
    );
    const text = JSON.stringify(erasure);
    for (const code of [
      "company owner",
      "confirmName",
      "employee_erasure_forbidden",
      "session_required",
      "erasure_confirmation_mismatch",
      "invalid_input",
      "not_found",
      "idempotency_mismatch",
      "invalid_idempotency_key",
      "alreadyErased",
      "erasureId",
      "erasedAt",
      "positionRows",
      "activityRedacted",
      "userLinks",
      "scope.home_units_changed",
      "There is no MCP tool",
    ])
      expect(text).toContain(code);
    expect(
      (
        erasure as Operation & {
          parameters: { name: string; in: string; required?: boolean }[];
        }
      ).parameters,
    ).toContainEqual(
      expect.objectContaining({
        name: "Idempotency-Key",
        in: "header",
        required: false,
      }),
    );
    expect(JSON.stringify(erasure.responses["200"])).not.toMatch(
      /[Nn]ame|employeeNumber|workEmail|workPhone/,
    );
    const reviewText = JSON.stringify(review);
    for (const code of [
      "retention_review_forbidden",
      "directory_forbidden",
      "session_required",
      "12 months",
      "leftAt",
      "retentionClass",
      "archivedAt",
      "Nothing is erased automatically",
    ])
      expect(reviewText).toContain(code);
    const list = JSON.stringify(document.paths["/api/v1/employees"]);
    for (const text of [
      '"name":"search"',
      '"name":"includeArchived"',
      "retentionClass",
      '"enum":["standard","extended"]',
    ])
      expect(list).toContain(text);
    expect(
      JSON.stringify(document.paths["/api/v1/employees/{id}"].patch),
    ).toContain("retentionClass");
  });

  it("documents the Admin portal reads as session-only, with their codes and no ids", () => {
    const access = document.paths["/api/v1/me/access"].get;
    const history = document.paths["/api/v1/config-history"].get;
    const changes = document.paths["/api/v1/access-changes"].get;
    const teams = document.paths["/api/v1/teams"].get;
    const users = document.paths["/api/v1/admin/users"].get;
    const person = document.paths["/api/v1/admin/users/{user}"].get;
    for (const operation of [access, history, changes, teams, users, person]) {
      expect(operation["x-session-only"]).toBe(true);
      expect(operation["x-required-scopes"]).toEqual([]);
      expect(Object.keys(operation.responses)).toEqual(
        expect.arrayContaining(["200", "400", "401", "403", "500"]),
      );
      expect(JSON.stringify(operation)).toContain("session_required");
    }
    for (const text of [
      "teamRole",
      "companyLevel",
      "role:{name, membership}",
      "scopes",
      "pages",
      "actions",
      "fields",
      "adminAreas",
      "no user, team, workspace, role, version or configuration object id and no configuration body",
    ])
      expect(JSON.stringify(access)).toContain(text);
    for (const text of [
      "config_forbidden",
      "invalid_input",
      "nextBefore",
      "hasMore",
      '"name":"before"',
      '"name":"pageSize"',
      '"maximum":100,"default":25',
    ])
      expect(JSON.stringify(history)).toContain(text);
    for (const text of [
      "role_assignment_forbidden",
      "invalid_input",
      "seven days",
      "truncated",
      "affectedUserIds",
      "roleName",
    ])
      expect(JSON.stringify(changes)).toContain(text);
    // ADM-02 (job 069): other teams by name, slug and created date only.
    for (const text of [
      "teams_forbidden",
      "invalid_input",
      "teamId, name, slug, createdAt, teamRole",
      "current",
      "no id, members, member count, record count, storage figure or activity",
    ])
      expect(JSON.stringify(teams)).toContain(text);
    // ADM-07 (job 073): people and invitations of every team, never team data.
    for (const text of [
      "people_forbidden",
      "invalid_input",
      "userId, name, email, teams:[{team, teamRole, configuredRole}]",
      "lastSignInAt, twoStep",
      "nextCursor",
      "never returns a team id, member count, record, candidate, upload, storage figure, activity, token, session or two-step secret",
      '"name":"team"',
      '"name":"status"',
      '"name":"level"',
      '"name":"role"',
      '"name":"cursor"',
    ])
      expect(JSON.stringify(users)).toContain(text);
    // ADM-08 (job 076): one person of the company, never team data.
    expect(Object.keys(person.responses)).toContain("404");
    for (const text of [
      "people_forbidden",
      "user_not_found",
      "invalid_input",
      "tenant_context.workspace_person",
      "signedInDevices, teams:[{team, slug, teamRole, configuredRole}]",
      "events:[{occurredAt, action, actorId, actorName, objectType, objectKey, roleName}]",
      "never returns a team id, record, candidate, upload, storage figure, token, session id, IP address, user agent, change summary or change body",
      '"name":"user","in":"path"',
      '"maxLength":128',
    ])
      expect(JSON.stringify(person)).toContain(text);
    expect(JSON.stringify(person)).not.toContain('"in":"query"');
  });

  it("documents deactivation, sign out everywhere and clear lockout as session-only fresh changes (ADM-09)", () => {
    const status = document.paths["/api/v1/admin/users/{user}/status"].put;
    const signOut = document.paths["/api/v1/admin/users/{user}/sign-out"].post;
    const clear =
      document.paths["/api/v1/admin/users/{user}/clear-lockout"].post;
    for (const operation of [status, signOut, clear]) {
      expect(operation["x-session-only"]).toBe(true);
      expect(operation["x-required-scopes"]).toEqual([]);
      expect(Object.keys(operation.responses)).toEqual(
        expect.arrayContaining([
          "200",
          "400",
          "401",
          "403",
          "404",
          "409",
          "500",
        ]),
      );
      for (const text of [
        "session_required",
        "people_forbidden",
        "company_owner_required",
        "Only a company owner can change a company owner or admin.",
        "SESSION_NOT_FRESH",
        "cannot_change_self",
        "user_not_found",
        "invalid_input",
        "one user-account activity row",
        "the person's id only",
        '"name":"user","in":"path"',
        '"maxLength":128',
      ])
        expect(JSON.stringify(operation), text).toContain(text);
      expect(JSON.stringify(operation)).not.toContain('"in":"query"');
    }
    for (const text of [
      "{data:{active, changed}}",
      "user.deactivated or user.reactivated",
      "last_company_owner",
      "account_deactivated",
      "changed false",
      '"example":{"active":false}',
      '"additionalProperties":false',
    ])
      expect(JSON.stringify(status), text).toContain(text);
    expect(JSON.stringify(signOut)).toContain("user.signed_out_everywhere");
    expect(JSON.stringify(signOut)).toContain("{data:{signedOut:true}}");
    expect(JSON.stringify(clear)).toContain("user.lockout_cleared");
    expect(JSON.stringify(clear)).toContain("{data:{cleared:true}}");
    for (const operation of [signOut, clear])
      expect(operation.requestBody).toBeUndefined();
    // The list filters and the person read carry the deactivated status.
    expect(JSON.stringify(document.paths["/api/v1/admin/users"].get)).toContain(
      '"enum":["active","invited","deactivated"]',
    );
    expect(
      document.paths["/api/v1/admin/users/{user}"].get.responses["200"]
        .description,
    ).toContain('status:"active"|"deactivated"');
    // The shared 403 names the refusal and its exact message.
    expect(
      document.paths["/api/v1/candidates"].post.responses["403"].description,
    ).toContain(
      'account_deactivated ("Your account has been deactivated. Ask a company owner or admin to reactivate it.")',
    );
  });

  it("documents user anonymisation as a session-only fresh change for company owners, with every refusal and the exact response (ADM-10)", () => {
    const anonymise =
      document.paths["/api/v1/admin/users/{user}/anonymise"].post;
    expect(
      Object.keys(document.paths["/api/v1/admin/users/{user}/anonymise"]),
    ).toEqual(["post"]);
    expect(anonymise["x-session-only"]).toBe(true);
    expect(anonymise["x-required-scopes"]).toEqual([]);
    expect(Object.keys(anonymise.responses)).toEqual(
      expect.arrayContaining(["200", "400", "401", "403", "404", "409", "500"]),
    );
    for (const text of [
      "session_required",
      "anonymisation_forbidden",
      "Only a company owner, signed in, can anonymise a user account.",
      "the people area included",
      "There is no MCP tool.",
      "SESSION_NOT_FRESH",
      "cannot_change_self",
      "anonymisation_confirmation_mismatch",
      "case-sensitive",
      "invalid_input",
      "user_not_found",
      "member_of_other_company",
      "last_team_owner",
      "last_company_owner",
      "Former user",
      "anonymised-<anonymisationId>@invalid",
      "redacted to its type, time and actor",
      "the activity the person performed are kept",
      "user.anonymised",
      "never the old name or email",
      "alreadyAnonymised true",
      "idempotency_mismatch",
      "the typed name is never stored",
      "{data:{anonymisationId, alreadyAnonymised, anonymisedAt, removed:{memberships, sessions, apiTokens, twoStep, configuredRoles, recordAssignments, companyAuthority, invitations, activityRedacted}}}",
      '"example":{"confirmName":"Fictional Dana Sample"}',
      '"additionalProperties":false',
      '"name":"user","in":"path"',
      '"maxLength":128',
    ])
      expect(JSON.stringify(anonymise), text).toContain(text);
    expect(JSON.stringify(anonymise)).not.toContain('"in":"query"');
  });

  it("documents the company group operations as session-only, with their codes, and the recent sign-in rule on granting groups only (ADM-12)", () => {
    const groups = document.paths["/api/v1/admin/groups"];
    const group = document.paths["/api/v1/admin/groups/{group}"];
    const members = document.paths["/api/v1/admin/groups/{group}/members"];
    const userGroups = document.paths["/api/v1/admin/users/{user}/groups"].get;
    expect(Object.keys(groups)).toEqual(["get", "post"]);
    expect(Object.keys(group)).toEqual(["get", "patch"]);
    expect(Object.keys(members)).toEqual(["post", "delete"]);
    const reads = [groups.get, group.get, userGroups];
    const writes = [groups.post, group.patch, members.post, members.delete];
    for (const operation of [...reads, ...writes]) {
      expect(operation["x-session-only"]).toBe(true);
      expect(operation["x-required-scopes"]).toEqual([]);
      expect(Object.keys(operation.responses)).toEqual(
        expect.arrayContaining(["400", "401", "403", "404", "409", "500"]),
      );
      expect(JSON.stringify(operation)).toContain("session_required");
    }
    for (const operation of reads) {
      expect(JSON.stringify(operation)).toContain("people_forbidden");
      expect(JSON.stringify(operation)).not.toContain("SESSION_NOT_FRESH");
    }
    for (const operation of writes)
      expect(JSON.stringify(operation)).toContain("group_forbidden");
    expect(JSON.stringify(groups.post)).not.toContain("SESSION_NOT_FRESH");
    for (const operation of [group.patch, members.post, members.delete])
      for (const text of [
        "SESSION_NOT_FRESH",
        "group_owner_required",
        "tenant_context.group_grants",
      ])
        expect(JSON.stringify(operation), text).toContain(text);
    for (const text of ["group_cycle", "group_depth", "group_member_exists"])
      expect(JSON.stringify(members.post), text).toContain(text);
    for (const text of [
      "computed:[{key, name, people}]",
      "grants, directPeople, people",
      "never returns a person's id, name or email",
    ])
      expect(JSON.stringify(groups.get), text).toContain(text);
    for (const text of [
      "memberOf:[{id, name, status, via}]",
      "changes made from another team are shown in that team",
      "not_found",
    ])
      expect(JSON.stringify(group.get), text).toContain(text);
    expect(JSON.stringify(userGroups)).toContain("through:[<group name>]");
    expect(JSON.stringify(document.paths["/api/v1/admin/users"].get)).toContain(
      '"name":"group","in":"query"',
    );
  });

  it("documents archive with replacement, the managers operations and Groups I manage as session-only, with their codes (ADM-13)", () => {
    const patch = document.paths["/api/v1/admin/groups/{group}"].patch;
    const managers = document.paths["/api/v1/admin/groups/{group}/managers"];
    const mine = document.paths["/api/v1/me/groups"].get;
    const mineMembers = document.paths["/api/v1/me/groups/{group}/members"];
    expect(Object.keys(managers)).toEqual(["post", "delete"]);
    expect(Object.keys(mineMembers)).toEqual(["post", "delete"]);
    const all = [
      patch,
      managers.post,
      managers.delete,
      mine,
      mineMembers.post,
      mineMembers.delete,
    ];
    for (const operation of all) {
      expect(operation["x-session-only"]).toBe(true);
      expect(operation["x-required-scopes"]).toEqual([]);
      expect(JSON.stringify(operation)).toContain("session_required");
    }
    for (const text of [
      "replacements",
      "group_in_use",
      "group_uses_changed",
      "group_archived",
      "group.child_replaced",
      "replacedGroupId",
      "SESSION_NOT_FRESH",
      '"maxItems":200',
    ])
      expect(JSON.stringify(patch), text).toContain(text);
    for (const text of [
      "group_grants_no_managers",
      "group_manager_exists",
      "group_archived",
      "user_not_found",
      "not_found",
      "group_forbidden",
    ])
      expect(JSON.stringify(managers.post), text).toContain(text);
    expect(JSON.stringify(managers.post)).not.toContain("SESSION_NOT_FRESH");
    expect(JSON.stringify(managers.delete)).toContain("SESSION_NOT_FRESH");
    for (const text of [
      "managers:[{userId, name, email}]",
      'whereUsed:[{source:\\"parent-group\\"',
    ])
      expect(
        JSON.stringify(document.paths["/api/v1/admin/groups/{group}"].get),
        text,
      ).toContain(text);
    for (const operation of [mine, mineMembers.post, mineMembers.delete]) {
      expect(JSON.stringify(operation)).toContain(
        "tenant_context.manages_group",
      );
      expect(JSON.stringify(operation)).not.toContain("SESSION_NOT_FRESH");
    }
    expect(JSON.stringify(mine)).toContain("people:[{userId, name, email}]");
    for (const operation of [mineMembers.post, mineMembers.delete])
      for (const text of [
        "group_owner_required",
        "group_archived",
        "not_found",
      ])
        expect(JSON.stringify(operation), text).toContain(text);
    for (const text of ["user_not_found", '"maxLength":254'])
      expect(JSON.stringify(mineMembers.post), text).toContain(text);
  });

  it("documents team archive and restore, the archived teams read and team_archived (ADM-05)", () => {
    const archive = document.paths["/api/v1/teams/archive"].put;
    const archived = document.paths["/api/v1/me/archived-teams"].get;
    for (const operation of [archive, archived]) {
      expect(operation["x-session-only"]).toBe(true);
      expect(operation["x-required-scopes"]).toEqual([]);
      expect(Object.keys(operation.responses)).toEqual(
        expect.arrayContaining(["200", "400", "401", "403", "500"]),
      );
      expect(JSON.stringify(operation)).toContain("session_required");
    }
    for (const text of [
      "team_archive_forbidden",
      "Only an owner of this team can archive or restore it.",
      "team_access_denied",
      "invalid_input",
      "{data:{archived, changed}}",
      "team.archived or team.restored",
      '"example":{"archived":true}',
      '"additionalProperties":false',
    ])
      expect(JSON.stringify(archive)).toContain(text);
    for (const text of ["{data:{teamIds:[<team id>]}}", "invalid_input"])
      expect(JSON.stringify(archived)).toContain(text);
    expect(JSON.stringify(document.paths["/api/v1/me/access"].get)).toContain(
      "teamArchived",
    );
    expect(JSON.stringify(document.paths["/api/v1/teams"].get)).toContain(
      "current, archived",
    );
    // The shared 403 names the refusal and its exact message.
    const forbidden =
      document.paths["/api/v1/candidates"].post.responses["403"].description;
    expect(forbidden).toContain("team_archived");
    expect(forbidden).toContain(
      "This team is archived. You can still read everything, but nothing can be changed until a team owner restores it.",
    );
  });

  it("documents customValues only on tasks and never names the record pins (R2b-02)", () => {
    const found: string[] = [];
    const walk = (value: unknown, path: string[]) => {
      if (!value || typeof value !== "object") return;
      const { properties } = value as { properties?: unknown };
      if (
        properties &&
        typeof properties === "object" &&
        Object.hasOwn(properties, "customValues")
      )
        found.push(path.join("/"));
      for (const [key, child] of Object.entries(value))
        walk(child, [...path, key]);
    };
    walk(document, []);
    expect(found).toEqual(["components/schemas/tasks"]);
    const text = JSON.stringify(document);
    for (const name of [
      "schemaVersionId",
      "schema_version_id",
      "typeId",
      "type_id",
      "payBracketVersionId",
      "pay_bracket_version_id",
    ])
      expect(text, name).not.toContain(name);
  });

  it("documents the Roles & permissions operations as session-only, with their codes", () => {
    const labels = [
      ["/api/v1/roles", "get"],
      ["/api/v1/roles", "post"],
      ["/api/v1/roles/{id}", "put"],
      ["/api/v1/roles/{id}/publish", "post"],
      ["/api/v1/teams/member-roles", "get"],
      ["/api/v1/company-authority", "get"],
      ["/api/v1/company-authority", "post"],
    ] as const;
    const text = (path: string, method: string) =>
      JSON.stringify(document.paths[path][method]);
    for (const [path, method] of labels) {
      const operation = document.paths[path][method];
      expect(operation["x-session-only"], path).toBe(true);
      expect(operation["x-required-scopes"], path).toEqual([]);
      expect(Object.keys(operation.responses), path).toEqual(
        expect.arrayContaining(["400", "401", "403", "404", "409", "500"]),
      );
      expect(text(path, method), path).toContain("session_required");
    }
    for (const [path, method] of labels.slice(0, 4))
      expect(text(path, method), path).toContain("config_forbidden");
    for (const code of [
      "invalid_input",
      "membership owner",
      "config_draft_exists",
    ])
      expect(text("/api/v1/roles", "post")).toContain(code);
    expect(text("/api/v1/roles/{id}", "put")).toContain("not_found");
    expect(text("/api/v1/roles/{id}/publish", "post")).toContain("not_found");
    for (const code of ["role_assignment_forbidden", "available"])
      expect(text("/api/v1/teams/member-roles", "get")).toContain(code);
    // R2a-18 (job 060): roles of any record scope can be assigned.
    for (const method of ["get", "post"])
      for (const gone of ["scopedRolesHidden", "role_record_scope_unsupported"])
        expect(text("/api/v1/teams/member-roles", method)).not.toContain(gone);
    const assign = document.paths["/api/v1/teams/member-roles"].post;
    expect(JSON.stringify(assign)).toContain("team_role_unconfirmed");
    expect(Object.keys(assign.responses)).toContain("503");
    for (const code of [
      "authority_forbidden",
      "invalid_input",
      "last_company_owner",
      "not_in_company",
      "workspace_authority.changed",
    ])
      expect(text("/api/v1/company-authority", "post")).toContain(code);
    expect(text("/api/v1/company-authority", "get")).toContain(
      "authority_forbidden",
    );
    // ADM-16 (job 077): two-step state and since date, and the two-step refusal.
    expect(text("/api/v1/company-authority", "get")).toContain(
      "suspended, twoStep, since}",
    );
    expect(text("/api/v1/company-authority", "post")).toContain(
      "a grant of a level to someone without two-step sign-in returns 409 authority_two_step_required",
    );
  });

  it("documents the job architecture operations as session-only, with their codes and no pay (ADM-24)", () => {
    const text = (path: string, method: string) =>
      JSON.stringify(document.paths[path][method]);
    const labels = [
      ["/api/v1/job-architecture", "get"],
      ["/api/v1/job-architecture", "post"],
      ["/api/v1/job-architecture/{versionId}", "put"],
      ["/api/v1/job-architecture/{versionId}/publish", "post"],
    ] as const;
    for (const [path, method] of labels) {
      const operation = document.paths[path][method];
      expect(operation["x-session-only"], path).toBe(true);
      expect(operation["x-required-scopes"], path).toEqual([]);
      expect(Object.keys(operation.responses), path).toEqual(
        expect.arrayContaining(["400", "401", "403", "404", "409", "500"]),
      );
      expect(text(path, method), path).toContain("session_required");
      expect(text(path, method), path).not.toContain("SESSION_NOT_FRESH");
    }
    for (const [path, method] of labels.slice(1))
      expect(text(path, method), path).toContain("config_forbidden");
    for (const code of ["invalid_input", "config_draft_exists", "never pay"])
      expect(text("/api/v1/job-architecture", "post")).toContain(code);
    for (const path of [
      "/api/v1/job-architecture/{versionId}",
      "/api/v1/job-architecture/{versionId}/publish",
    ]) {
      const method = path.endsWith("publish") ? "post" : "put";
      expect(text(path, method), path).toContain("not_found");
      expect(text(path, method), path).toContain("config_state_conflict");
    }
    expect(text("/api/v1/job-architecture", "get")).toContain(
      "current:{versionId, number, body}|null, draft:",
    );
    // Positions take a job title key on create and patch and return it.
    for (const [path, method] of [
      ["/api/v1/positions", "post"],
      ["/api/v1/positions/{id}", "patch"],
      ["/api/v1/positions", "get"],
    ] as const)
      expect(text(path, method), path).toContain("jobTitleKey");
    for (const [path, method] of [
      ["/api/v1/positions", "post"],
      ["/api/v1/positions/{id}", "patch"],
    ] as const) {
      expect(text(path, method), path).toContain("invalid_reference");
      expect(
        JSON.stringify(document.paths[path][method].requestBody),
        path,
      ).toContain('"jobTitleKey"');
    }
    // The vacancy data schema gains only the optional jobTitleKey.
    const vacancies = document.components.schemas.vacancies as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(vacancies.properties)).toEqual([
      "title",
      "requisitionId",
      "department",
      "location",
      "employmentType",
      "workMode",
      "description",
      "requirements",
      "skills",
      "openings",
      "status",
      "hiringManager",
      "recruiter",
      "targetDate",
      "jobTitleKey",
    ]);
    expect(vacancies.properties.jobTitleKey).toEqual({
      type: "string",
      pattern: "^[a-z0-9][a-z0-9-]{0,62}$",
    });
    expect(vacancies.required ?? []).not.toContain("jobTitleKey");
    for (const [name, schema] of Object.entries(document.components.schemas))
      if (name !== "vacancies")
        expect(
          Object.keys(
            (schema as { properties?: Record<string, unknown> }).properties ??
              {},
          ),
          name,
        ).not.toContain("jobTitleKey");
  });

  it("documents the Fields operations as session-only, with their codes (R2b-09)", () => {
    const text = (path: string, method: string) =>
      JSON.stringify(document.paths[path][method]);
    const labels = [
      ["/api/v1/admin/fields", "get"],
      ["/api/v1/admin/fields", "post"],
      ["/api/v1/admin/fields/drafts/{versionId}", "put"],
      ["/api/v1/admin/fields/drafts/{versionId}/publish", "post"],
    ] as const;
    for (const [path, method] of labels) {
      const operation = document.paths[path][method];
      expect(operation["x-session-only"], path).toBe(true);
      expect(operation["x-required-scopes"], path).toEqual([]);
      expect(Object.keys(operation.responses), path).toEqual(
        expect.arrayContaining(["400", "401", "403", "404", "409", "500"]),
      );
      for (const code of ["session_required", "config_forbidden"])
        expect(text(path, method), path).toContain(code);
      expect(text(path, method), path).not.toContain("SESSION_NOT_FRESH");
    }
    for (const [path, method] of labels.slice(1))
      expect(text(path, method), path).toContain("invalid_input");
    expect(text("/api/v1/admin/fields", "post")).toContain(
      "config_draft_exists",
    );
    for (const [path, method] of labels.slice(2))
      for (const code of ["not_found", "config_state_conflict"])
        expect(text(path, method), path).toContain(code);
    expect(text("/api/v1/admin/fields", "get")).toContain(
      "{data:[{kind, current:{versionId, number|null, body}, draft:",
    );
    // ADM-29: options by id with a disabled flag, a custom field's record types, and the count.
    expect(
      text("/api/v1/admin/fields/drafts/{versionId}/publish", "post"),
    ).toContain("a removed option returns 400 invalid_input");
    for (const [path, method] of labels.slice(1, 3))
      for (const rule of [
        "[{id, label, disabled?}]",
        "types? (1 to 30 unique record type uuids",
        "an option cannot be removed; disable it instead",
      ])
        expect(text(path, method), path).toContain(rule);
    const usage = document.paths["/api/v1/admin/fields/usage"].get;
    expect(usage["x-session-only"]).toBe(true);
    expect(usage["x-required-scopes"]).toEqual([]);
    expect(Object.keys(usage.responses)).toEqual(
      expect.arrayContaining(["200", "400", "401", "403", "404", "500"]),
    );
    for (const code of [
      "session_required",
      "config_forbidden",
      "invalid_input",
      "not_found",
      "{data:{count}}",
      "tenant_context.field_usage",
    ])
      expect(text("/api/v1/admin/fields/usage", "get")).toContain(code);
    expect(
      (
        usage as unknown as { parameters: { in: string; name: string }[] }
      ).parameters
        .filter((parameter) => parameter.in === "query")
        .map((parameter) => parameter.name),
    ).toEqual(["kind", "fieldId"]);
  });

  // R2b-10 (job 102): read-only screen entries and the publish check of required fields.
  it("documents read-only screen entries in the draft body and the required-field check at publish (R2b-10)", () => {
    const text = (path: string, method: string) =>
      JSON.stringify(document.paths[path][method]);
    for (const [path, method] of [
      ["/api/v1/admin/fields", "post"],
      ["/api/v1/admin/fields/drafts/{versionId}", "put"],
    ] as const)
      for (const rule of [
        "fields:[{key, hidden?, mandatory?, readOnly?}]",
        "A read-only field cannot be hidden or mandatory",
        "A create screen lets people fill every required system field",
      ])
        expect(text(path, method), path).toContain(rule);
    const publish = text(
      "/api/v1/admin/fields/drafts/{versionId}/publish",
      "post",
    );
    expect(publish).toContain("Required but not on the create screen");
    expect(publish).toContain("400 invalid_input with up to 8 reasons");
  });

  it("documents the salary bracket operations as session-only and confidential, with their codes (ADM-25)", () => {
    const text = (path: string, method: string) =>
      JSON.stringify(document.paths[path][method]);
    const labels = [
      ["/api/v1/salary-brackets", "get"],
      ["/api/v1/salary-brackets", "post"],
      ["/api/v1/salary-brackets/{versionId}", "put"],
      ["/api/v1/salary-brackets/{versionId}/publish", "post"],
    ] as const;
    for (const [path, method] of labels) {
      const operation = document.paths[path][method];
      expect(operation["x-session-only"], path).toBe(true);
      expect(operation["x-required-scopes"], path).toEqual([]);
      expect(Object.keys(operation.responses), path).toEqual(
        expect.arrayContaining(["400", "401", "403", "404", "409", "500"]),
      );
      for (const code of [
        "session_required",
        "plan_access_required",
        "AED fils",
        "never offered to API tokens or MCP",
        "never in exports",
        "version number only",
      ])
        expect(text(path, method), path).toContain(code);
    }
    for (const [path, method] of labels.slice(1))
      for (const code of ["config_forbidden", "team_archived"])
        expect(text(path, method), path).toContain(code);
    for (const code of [
      "invalid_input",
      "job_grades_required",
      "The minimum must be at most the midpoint, and the midpoint at most the maximum.",
      "brackets must hold exactly one bracket for each grade of the published job architecture.",
      '"additionalProperties":false',
    ])
      expect(text("/api/v1/salary-brackets", "post")).toContain(code);
    for (const code of ["not_found", "bracket_version_published"])
      for (const [path, method] of labels.slice(2))
        expect(text(path, method), path).toContain(code);
    for (const code of [
      "bracket_grades_changed",
      "SESSION_NOT_FRESH",
      "salary_brackets.published",
      "nothing is retired",
    ])
      expect(
        text("/api/v1/salary-brackets/{versionId}/publish", "post"),
      ).toContain(code);
    expect(text("/api/v1/salary-brackets", "get")).toContain(
      "{data:{current:{versionId, number|null, state, payPeriod, covers, effectiveFrom, createdAt, publishedAt|null, brackets:[{gradeCode, minimumFils, midpointFils, maximumFils}]}|null, draft:",
    );
  });

  it("documents the recent sign-in rule on exactly the thirteen sensitive admin changes (ADM-06, ADM-09, ADM-25, ADM-10, ADM-12, ADM-13)", () => {
    const guarded = [
      "POST /api/v1/salary-brackets/{versionId}/publish",
      "POST /api/v1/roles/{id}/publish",
      "POST /api/v1/teams/member-roles",
      "POST /api/v1/company-authority",
      "POST /api/v1/teams/two-step-reset",
      "PUT /api/v1/admin/users/{user}/status",
      "POST /api/v1/admin/users/{user}/sign-out",
      "POST /api/v1/admin/users/{user}/clear-lockout",
      "POST /api/v1/admin/users/{user}/anonymise",
      // ADM-12: changes to a group that grants something only.
      "PATCH /api/v1/admin/groups/{group}",
      "POST /api/v1/admin/groups/{group}/members",
      "DELETE /api/v1/admin/groups/{group}/members",
      // ADM-13: removing a manager from a group that grants something.
      "DELETE /api/v1/admin/groups/{group}/managers",
    ];
    for (const label of guarded) {
      const { operation } = operations.find((item) => item.label === label)!;
      expect(JSON.stringify(operation), label).toContain("SESSION_NOT_FRESH");
    }
    for (const path of [
      "/api/v1/teams/member-roles",
      "/api/v1/company-authority",
    ])
      expect(JSON.stringify(document.paths[path].get), path).not.toContain(
        "SESSION_NOT_FRESH",
      );
    expect(
      operations
        .filter(({ operation }) =>
          JSON.stringify(operation).includes("SESSION_NOT_FRESH"),
        )
        .map(({ label }) => label)
        .sort(),
    ).toEqual([...guarded].sort());
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
        "POST /api/v1/teams/member-roles",
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
        "POST /api/v1/employees/{id}/erasure",
        "GET /api/v1/employees/retention-review",
        "GET /api/v1/employees/reporting-lines",
        "POST /api/v1/org-import/dry-run",
        "POST /api/v1/org-import/apply",
        "GET /api/v1/me/access",
        "GET /api/v1/config-history",
        "GET /api/v1/access-changes",
        "GET /api/v1/admin/domain",
        "GET /api/v1/teams",
        "PUT /api/v1/teams/archive",
        "GET /api/v1/me/archived-teams",
        "GET /api/v1/admin/users",
        "GET /api/v1/admin/users/{user}",
        "PUT /api/v1/admin/users/{user}/status",
        "POST /api/v1/admin/users/{user}/sign-out",
        "POST /api/v1/admin/users/{user}/clear-lockout",
        "POST /api/v1/admin/users/{user}/anonymise",
        "GET /api/v1/admin/users/{user}/groups",
        "GET /api/v1/admin/groups",
        "POST /api/v1/admin/groups",
        "GET /api/v1/admin/groups/{group}",
        "PATCH /api/v1/admin/groups/{group}",
        "POST /api/v1/admin/groups/{group}/members",
        "DELETE /api/v1/admin/groups/{group}/members",
        "POST /api/v1/admin/groups/{group}/managers",
        "DELETE /api/v1/admin/groups/{group}/managers",
        "GET /api/v1/me/groups",
        "POST /api/v1/me/groups/{group}/members",
        "DELETE /api/v1/me/groups/{group}/members",
        "GET /api/v1/admin/fields",
        "POST /api/v1/admin/fields",
        "PUT /api/v1/admin/fields/drafts/{versionId}",
        "POST /api/v1/admin/fields/drafts/{versionId}/publish",
        "GET /api/v1/admin/fields/usage",
        "GET /api/v1/roles",
        "POST /api/v1/roles",
        "PUT /api/v1/roles/{id}",
        "POST /api/v1/roles/{id}/publish",
        "GET /api/v1/task-boards",
        "POST /api/v1/task-boards",
        "PUT /api/v1/task-boards/{id}",
        "DELETE /api/v1/task-boards/{id}",
        "POST /api/v1/task-boards/{id}/publish",
        "GET /api/v1/teams/member-roles",
        "GET /api/v1/company-authority",
        "POST /api/v1/company-authority",
        "GET /api/v1/job-architecture",
        "GET /api/v1/job-architecture/usage",
        "POST /api/v1/job-architecture",
        "PUT /api/v1/job-architecture/{versionId}",
        "POST /api/v1/job-architecture/{versionId}/publish",
        "GET /api/v1/salary-brackets",
        "POST /api/v1/salary-brackets",
        "PUT /api/v1/salary-brackets/{versionId}",
        "POST /api/v1/salary-brackets/{versionId}/publish",
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
