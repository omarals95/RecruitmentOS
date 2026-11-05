import { z } from "zod";
import {
  recordDataSchemas,
  resourceToKind,
  type RecordKind,
} from "@/domain/records";
import { MCP_SCOPES, type Scope } from "@/lib/permissions";
import { mcpScopeDescriptions } from "@/lib/scope-descriptions";
export const runtime = "nodejs";

// Fictional identifiers and values used only as documentation examples.
const exampleIds = {
  candidate: "3f6c1d2e-8a4b-4c7d-9e1f-2a3b4c5d6e7f",
  second: "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
  vacancy: "7b2e9c41-5d3a-4f8e-a6b1-0c9d8e7f6a5b",
  parent: "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f",
};
const createExamples: Record<RecordKind, Record<string, unknown>> = {
  candidate: {
    data: {
      name: "Amira Fictional",
      email: "amira.fictional@example.test",
      jobTitle: "Payroll Analyst",
    },
  },
  "job-role": {
    data: { title: "Fictional Payroll Analyst", department: "Finance" },
  },
  vacancy: {
    data: { title: "Fictional Payroll Analyst", status: "Open", openings: 1 },
  },
  application: {
    candidateId: exampleIds.candidate,
    vacancyId: exampleIds.vacancy,
    data: { stage: "Screening" },
  },
  bucket: { data: { name: "Fictional review", color: "#4338CA", position: 4 } },
  "task-field": { data: { name: "Fictional notice period", type: "Text" } },
  task: {
    bucketId: exampleIds.parent,
    data: { title: "Call fictional candidate", priority: "Normal" },
  },
  interview: {
    applicationId: exampleIds.parent,
    data: {
      title: "Fictional first interview",
      startAt: "2026-12-01T09:00:00+04:00",
    },
  },
  offer: {
    applicationId: exampleIds.parent,
    data: { title: "Fictional offer", amount: "15000", currency: "AED" },
  },
  onboarding: {
    applicationId: exampleIds.parent,
    data: { startDate: "2027-01-04", status: "Planned" },
  },
  checklist: {
    onboardingId: exampleIds.parent,
    data: { title: "Fictional ID copy", category: "Document" },
  },
  "saved-view": {
    data: {
      name: "Fictional finance shortlist",
      area: "directory",
      query: { search: "payroll" },
    },
  },
  comment: {
    parentRecordId: exampleIds.parent,
    data: { body: "Fictional follow-up note." },
  },
};
const jsonBody = (schema: unknown, example: unknown) => ({
  required: true,
  content: { "application/json": { schema, example } },
});
const errorResponse = (description: string, retry = false) => ({
  description,
  headers: {
    "X-Correlation-Id": { $ref: "#/components/headers/X-Correlation-Id" },
    ...(retry
      ? { "Retry-After": { $ref: "#/components/headers/Retry-After" } }
      : {}),
  },
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/Error" } },
  },
});
const errors = {
  "400": errorResponse("Invalid fields, references, query or JSON."),
  "401": errorResponse("Missing, invalid, expired or revoked credentials."),
  "403": errorResponse(
    "Scope, role, verification, origin or team access denied.",
  ),
  "404": errorResponse("Record, resource or CV not found in this team."),
  "409": errorResponse(
    "Version, duplicate or idempotency conflict; preserve your draft and re-read.",
  ),
  "413": errorResponse("The request body is too large."),
  "415": errorResponse("Send application/json."),
  "429": errorResponse("Rate limit; wait for Retry-After seconds.", true),
  "500": errorResponse(
    "Unexpected failure; quote error.correlationId when reporting it.",
  ),
  "503": errorResponse("Required service configuration is unavailable."),
};
const idParameter = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const recordDto = {
  type: "object",
  required: ["id", "kind", "data", "version"],
  properties: {
    id: { type: "string", format: "uuid" },
    kind: { type: "string" },
    data: { type: "object" },
    version: { type: "integer", minimum: 1 },
    label: { type: "string" },
    authorName: { type: ["string", "null"] },
    archivedAt: { type: ["string", "null"], format: "date-time" },
  },
};
export function GET() {
  const parameters = [
    {
      name: "X-Team-Id",
      in: "header",
      required: false,
      schema: { type: "string" },
      description:
        "Optional for sessions. A Bearer token always belongs to its fixed team; a conflicting header is rejected.",
    },
  ];
  const operation = (
    scopes: Scope[],
    details: Record<string, unknown>,
    success: Record<string, unknown>,
    options: { sessionOnly?: boolean; params?: unknown[] } = {},
  ) => ({
    ...details,
    parameters: [...parameters, ...(options.params ?? [])],
    "x-required-scopes": scopes,
    ...(options.sessionOnly
      ? { "x-session-only": true, security: [{ sessionCookie: [] }] }
      : {}),
    responses: { ...success, ...errors },
  });
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {};
  for (const [resource, kind] of Object.entries(resourceToKind)) {
    const schemaName = resource.replace(/-/g, "_");
    schemas[schemaName] = z.toJSONSchema(recordDataSchemas[kind], {
      io: "input",
      unrepresentable: "any",
    });
    const refs = Object.fromEntries(
      [
        "candidateId",
        "vacancyId",
        "applicationId",
        "onboardingId",
        "bucketId",
        "jobRoleId",
        "parentRecordId",
      ].map((name) => [name, { type: ["string", "null"], format: "uuid" }]),
    );
    const input = {
      type: "object",
      required: ["data"],
      additionalProperties: false,
      properties: {
        data: { $ref: `#/components/schemas/${schemaName}` },
        ...refs,
        legacyId: {
          type: "string",
          description: "Requires imports:write and an owner/admin role.",
        },
        importMeta: {
          type: "object",
          description: "Import provenance only; requires imports:write.",
        },
        archived: {
          type: "boolean",
          description: "Creation as archived requires imports:write.",
        },
      },
    };
    const scope = resource === "candidates" ? "candidates" : "recruitment";
    paths[`/api/v1/${resource}`] = {
      get: operation(
        [`${scope}:read`],
        {
          summary: `List ${resource}`,
          description: `Requires ${scope}:read. Page size is capped at 100. Search supports words, quoted phrases and exclusions.`,
        },
        {
          "200": {
            description: "{data: record[], pagination}.",
          },
        },
        {
          params: [
            "page",
            "pageSize",
            "search",
            "includeArchived",
            "legacyId",
            "candidateId",
            "vacancyId",
            "applicationId",
            "onboardingId",
            "parentRecordId",
            "status",
            "stage",
            "sort",
            "direction",
          ].map((name) => ({ name, in: "query", schema: { type: "string" } })),
        },
      ),
      post: operation(
        [`${scope}:write`],
        {
          summary: `Create ${kind}`,
          description: `Requires ${scope}:write. References must belong to the selected team and have the expected record kind.`,
          requestBody: jsonBody(input, createExamples[kind]),
        },
        {
          "201": {
            description:
              "Created, idempotently replayed, or reconciled to the existing record after key expiry; {data:record}.",
          },
        },
        {
          params: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
              description:
                "Reuse the same key and identical payload after an uncertain result; a different payload returns 409 idempotency_mismatch, even after the key expires. Keys are retained for 7 days. After that, an identical retry returns the existing record's current state (or the original response when the caller lacks the resource's read scope) instead of creating another; if that record is no longer available it returns 409 idempotency_expired and creates nothing, so search for the record before creating it again.",
            },
          ],
        },
      ),
    };
    paths[`/api/v1/${resource}/{id}`] = {
      get: operation(
        [`${scope}:read`],
        { summary: `Get ${kind}` },
        { "200": { description: "{data:record}." } },
        { params: [idParameter] },
      ),
      patch: operation(
        [`${scope}:write`],
        {
          summary: `Update or archive ${kind}`,
          description: `Requires ${scope}:write. Send the latest version and only changed data fields. Parent references for applications/interviews/offers/onboarding/checklists are immutable. Comments are append-only. Bucket archive requires moveToBucketId when tasks exist.`,
          requestBody: jsonBody(
            {
              type: "object",
              required: ["version"],
              additionalProperties: false,
              properties: {
                version: { type: "integer", minimum: 1 },
                data: {
                  type: "object",
                  description:
                    "Partial fields from the resource data schema; server validates strictly.",
                },
                ...refs,
                archived: { type: "boolean" },
                moveToBucketId: { type: "string", format: "uuid" },
                importMeta: { type: "object" },
              },
            },
            { version: 1, data: createExamples[kind].data },
          ),
        },
        {
          "200": { description: "{data:record}." },
          ...(kind === "comment"
            ? {
                "405": errorResponse(
                  "Comments are append-only; add a new comment instead.",
                ),
              }
            : {}),
        },
        { params: [idParameter] },
      ),
    };
  }
  paths["/api/v1/candidates/{id}/state"] = {
    get: operation(
      ["candidates:read"],
      {
        summary: "Read your personal candidate state",
        description:
          "Requires candidates:read. Shortlist, follow-up status and note are private to the caller; version 0 means nothing is saved yet.",
      },
      { "200": { description: "{data: personal state}." } },
      { params: [idParameter] },
    ),
    patch: operation(
      ["candidates:write"],
      {
        summary: "Update your personal candidate state",
        description:
          "Requires candidates:write. Send the version you read; a stale version returns 409 version_conflict. importMeta requires imports:write.",
        requestBody: jsonBody(
          {
            type: "object",
            required: ["version"],
            additionalProperties: false,
            properties: {
              version: { type: "integer", minimum: 0 },
              shortlisted: { type: "boolean" },
              status: { type: "string" },
              note: { type: "string", maxLength: 10000 },
              importMeta: { type: "object" },
            },
          },
          { version: 0, shortlisted: true, note: "Fictional private note." },
        ),
      },
      { "200": { description: "{data: personal state}." } },
      { params: [idParameter] },
    ),
  };
  paths["/api/v1/candidates/duplicates"] = {
    post: operation(
      ["candidates:read"],
      {
        summary: "Find possible duplicate candidates",
        description:
          "Requires candidates:read. Returns exact normalized email or phone matches in the selected team as possible matches for review, at most 20 results; limited is true when more matches exist. An empty result is not proof of uniqueness.",
        requestBody: jsonBody(
          {
            type: "object",
            additionalProperties: false,
            properties: {
              email: { type: "string", maxLength: 320 },
              phone: { type: "string", maxLength: 100 },
            },
          },
          { email: "amira.fictional@example.test" },
        ),
      },
      {
        "200": {
          description:
            "{data: [{id,name,email,phone,matches}], limited}; at most 20 in data, limited is true when more matches exist.",
        },
      },
    ),
  };
  paths["/api/v1/applications/bulk"] = {
    post: operation(
      ["recruitment:write", "candidates:read"],
      {
        summary: "Assign candidates to one vacancy",
        description:
          "Requires recruitment:write and candidates:read. Up to 500 active candidates in the selected team; the vacancy must be active. All-or-nothing validation. Candidates that already have an active application for the vacancy are reported in existing, never duplicated.",
        requestBody: jsonBody(
          {
            type: "object",
            required: ["candidateIds", "vacancyId"],
            additionalProperties: false,
            properties: {
              candidateIds: {
                type: "array",
                minItems: 1,
                maxItems: 500,
                items: { type: "string", format: "uuid" },
              },
              vacancyId: { type: "string", format: "uuid" },
              stage: { type: "string" },
              owner: { type: "string" },
              source: { type: "string" },
              appliedDate: { type: "string", format: "date" },
            },
          },
          {
            candidateIds: [exampleIds.candidate, exampleIds.second],
            vacancyId: exampleIds.vacancy,
            stage: "Sourced",
            owner: "Fictional Recruiter",
          },
        ),
      },
      {
        "200": {
          description:
            "Created and already-existing active applications for the requested pairs.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["data", "existing", "created", "skipped"],
                properties: {
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/RecordDto" },
                    description: "Applications created by this request.",
                  },
                  existing: {
                    type: "array",
                    items: {
                      oneOf: [
                        { $ref: "#/components/schemas/RecordDto" },
                        {
                          type: "object",
                          required: ["id", "kind", "candidateId", "vacancyId"],
                          additionalProperties: false,
                          properties: {
                            id: { type: "string", format: "uuid" },
                            kind: { type: "string" },
                            candidateId: { type: "string", format: "uuid" },
                            vacancyId: { type: "string", format: "uuid" },
                          },
                        },
                      ],
                    },
                    description:
                      "Active applications that already existed for the vacancy and requested candidates. Callers without recruitment:read receive references only (id, kind, candidateId, vacancyId).",
                  },
                  created: { type: "integer", description: "data.length" },
                  skipped: {
                    type: "integer",
                    description: "existing.length; kept for compatibility.",
                  },
                },
              },
            },
          },
        },
      },
      {
        params: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
            description:
              "Reuse the same key and identical body after an uncertain result to replay the stored response; a different body returns 409 idempotency_mismatch. After the 7-day retention an identical retry re-runs the assignment, which reports earlier applications in existing.",
          },
        ],
      },
    ),
  };
  paths["/api/v1/cvs/bulk-capabilities"] = {
    get: operation(
      ["cvs:write", "candidates:write"],
      {
        summary: "Read bulk CV import availability",
        description:
          "Requires cvs:write and candidates:write. Currently always reports uploads and AI as unavailable. storageConfigured reports whether private CV storage is set up in the server environment; it is read from configuration only and contacts no storage provider.",
      },
      {
        "200": {
          description:
            "{data:{uploadsAvailable:false, aiAvailable:false, storageConfigured:boolean}}.",
        },
      },
    ),
  };
  paths["/api/v1/teams/bootstrap"] = {
    post: operation(
      ["recruitment:write"],
      {
        summary: "Initialize the team's default task workflow",
        description:
          "Session only: a signed-in team owner or admin. Creates the default buckets once; later calls return the existing buckets with created 0.",
      },
      { "200": { description: "{data: buckets, created}." } },
      { sessionOnly: true },
    ),
  };
  paths["/api/settings/tokens"] = {
    get: operation(
      [],
      {
        summary: "List API tokens",
        description:
          "Session only. Lists safe token metadata; secrets are never returned again. all=true lists the team's tokens for owners and admins.",
      },
      { "200": { description: "{data: token metadata[]}." } },
      {
        sessionOnly: true,
        params: [{ name: "all", in: "query", schema: { type: "string" } }],
      },
    ),
    post: operation(
      [],
      {
        summary: "Create an API token",
        description:
          "Session only. Scopes are limited to the creator's role. The secret is returned once.",
        requestBody: jsonBody(
          {
            type: "object",
            required: ["name", "scopes"],
            additionalProperties: false,
            properties: {
              name: { type: "string", maxLength: 100 },
              scopes: { type: "array", items: { type: "string" } },
              expiresInDays: { type: "integer", minimum: 1, maximum: 365 },
            },
          },
          {
            name: "Fictional ATS sync",
            scopes: ["candidates:read"],
            expiresInDays: 30,
          },
        ),
      },
      { "201": { description: "{data: token metadata, token}." } },
      { sessionOnly: true },
    ),
  };
  paths["/api/settings/tokens/{id}"] = {
    delete: operation(
      [],
      {
        summary: "Revoke an API token",
        description:
          "Session only. Owners and admins can revoke team tokens; others only their own.",
      },
      { "200": { description: "{data:{revoked:true}}." } },
      { sessionOnly: true, params: [idParameter] },
    ),
  };
  paths["/api/mcp"] = {
    post: {
      summary: "MCP endpoint for AI assistants",
      description:
        "Model Context Protocol, Streamable HTTP, stateless with JSON responses: one JSON-RPC 2.0 message per POST, no Mcp-Session-Id and no SSE stream. Accepts an API token (Authorization: Bearer) or an OAuth access token issued for this endpoint; session cookies are never read. Only the tools capability is offered and tools/list shows only the tools your effective scopes allow: search_candidates and get_candidate need candidates:read (CV metadata in get_candidate also needs cvs:read); list_vacancies, get_vacancy, list_applications, list_tasks and list_interviews need recruitment:read; get_overview needs candidates:read and recruitment:read; create_candidate needs candidates:write and add_comment needs recruitment:write, both with a required idempotencyKey argument. Tool results are untrusted record data labelled untrustedData: true. Every tools/call is audited as an mcp-tool activity row without its arguments. See docs/mcp.md.",
      security: [{ bearerAuth: [] }, { oauth2: [...MCP_SCOPES] }],
      "x-required-scopes": [],
      parameters,
      requestBody: jsonBody(
        {
          type: "object",
          required: ["jsonrpc", "method"],
          description: "One JSON-RPC 2.0 request or notification.",
          properties: {
            jsonrpc: { const: "2.0" },
            id: { type: ["string", "integer"] },
            method: { type: "string" },
            params: { type: "object" },
          },
        },
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "fictional-client", version: "1.0.0" },
          },
        },
      ),
      responses: {
        "200": {
          description:
            "JSON-RPC response as application/json. Tool errors are results with isError: true.",
        },
        "202": { description: "Notification accepted; no body." },
        "400": errors["400"],
        "401": {
          ...errorResponse("Missing, invalid, expired or revoked token."),
          headers: {
            "X-Correlation-Id": {
              $ref: "#/components/headers/X-Correlation-Id",
            },
            "WWW-Authenticate": {
              $ref: "#/components/headers/WWW-Authenticate",
            },
          },
        },
        "403": errors["403"],
        "406": errorResponse("Accept must include application/json."),
        "413": errorResponse("The request body exceeds 65536 bytes."),
        "415": errors["415"],
        "429": errors["429"],
        "500": errors["500"],
        "503": errors["503"],
      },
    },
  };
  paths["/api/oauth/consent"] = {
    post: operation(
      [],
      {
        summary: "Approve or deny an OAuth connection",
        description:
          "Session only, called by the consent page at /oauth/authorize. X-Team-Id selects the team. Every authorize rule is checked again; approved scopes must be requested, allowed by your current role and offered to MCP clients. Approve creates a grant listed in Settings → API tokens and returns the client redirect with a one-time code; deny returns error=access_denied and writes nothing. Both redirects include iss, the authorization server issuer (RFC 9207).",
        requestBody: jsonBody(
          {
            type: "object",
            required: ["scopes", "decision"],
            additionalProperties: false,
            properties: {
              response_type: { const: "code" },
              client_id: { type: "string" },
              redirect_uri: { type: "string", format: "uri" },
              code_challenge: { type: "string" },
              code_challenge_method: { const: "S256" },
              state: { type: "string" },
              scope: { type: "string" },
              resource: { type: "string", format: "uri" },
              scopes: { type: "array", items: { enum: [...MCP_SCOPES] } },
              decision: { enum: ["approve", "deny"] },
            },
          },
          {
            response_type: "code",
            client_id: "ros_client_FictionalExampleClient",
            redirect_uri: "https://claude.ai/api/mcp/auth_callback",
            code_challenge: "fictional-pkce-challenge-for-documentation-only",
            code_challenge_method: "S256",
            state: "fictional-state",
            scope: "candidates:read recruitment:read",
            scopes: ["candidates:read"],
            decision: "approve",
          },
        ),
      },
      { "200": { description: "{data:{redirectTo}}." } },
      { sessionOnly: true },
    ),
  };
  paths["/api/v1/candidates/{id}/cvs"] = {
    get: operation(
      ["cvs:read"],
      {
        summary: "List private CV references",
        description:
          "Requires cvs:read; returns {data,pagination} with the full total. Each reference has downloadProtocol: s3-url-v1 (use /download), blob-chunks-v1 (use /manifest and /chunks) or null when not ready. Storage keys, object versions, digests and store ids are not exposed.",
      },
      { "200": { description: "{data: CV references, pagination}." } },
      {
        params: [
          idParameter,
          {
            name: "page",
            in: "query",
            schema: { type: "integer", minimum: 1, default: 1 },
          },
          {
            name: "pageSize",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 30 },
          },
        ],
      },
    ),
  };
  paths["/api/v1/candidates/{id}/cvs/uploads"] = {
    post: operation(
      ["cvs:write"],
      {
        summary: "Reserve a direct private CV upload",
        description:
          "Requires cvs:write. Clients must switch on upload.protocol and never infer it from a hostname: s3-form-v1 is a multipart form POST of the fields plus file; blob-put-v1 is a PUT of the file with exactly the returned headers. Send no credentials, cookies or X-Team-Id to the upload URL, then complete the upload. The upload URL is a secret capability and must not be logged. A ready replay returns upload:null. Never send CV bytes through the Vercel JSON API. Blob storage is currently disabled: the server returns 503 STORAGE_SETUP_REQUIRED for it.",
        requestBody: jsonBody(
          {
            type: "object",
            additionalProperties: false,
            required: [
              "originalName",
              "mimeType",
              "sizeBytes",
              "clientUploadId",
            ],
            properties: {
              originalName: { type: "string", maxLength: 180 },
              mimeType: { type: "string", maxLength: 150 },
              sizeBytes: { type: "integer", minimum: 1, maximum: 10485760 },
              clientUploadId: { type: "string", format: "uuid" },
              legacySourceId: {
                type: "string",
                description: "Imports only.",
              },
              sourcePath: {
                type: "string",
                description: "Imports only; original relative source metadata.",
              },
            },
          },
          {
            originalName: "fictional-cv.pdf",
            mimeType: "application/pdf",
            sizeBytes: 48213,
            clientUploadId: exampleIds.parent,
          },
        ),
      },
      {
        "201": {
          description: "{data: CV reference, upload}.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["data", "upload"],
                properties: {
                  data: { type: "object" },
                  upload: {
                    oneOf: [
                      { type: "null" },
                      {
                        oneOf: [
                          { $ref: "#/components/schemas/S3FormUploadV1" },
                          { $ref: "#/components/schemas/BlobPutUploadV1" },
                        ],
                        discriminator: {
                          propertyName: "protocol",
                          mapping: {
                            "s3-form-v1": "#/components/schemas/S3FormUploadV1",
                            "blob-put-v1":
                              "#/components/schemas/BlobPutUploadV1",
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
      { params: [idParameter] },
    ),
  };
  paths["/api/v1/cvs/uploads/{id}/complete"] = {
    post: operation(
      ["cvs:write"],
      {
        summary: "Validate the uploaded immutable CV",
        description:
          "Requires cvs:write. Idempotent. Reads the stored object itself and returns a ready reference only after size, type and format checks plus an S3 version, or, for Blob, a SHA-256 of the exact reserved size computed by the server. Any request body is ignored; no client hash, size or type is accepted.",
      },
      { "200": { description: "{data: CV reference}." } },
      { params: [idParameter] },
    ),
  };
  paths["/api/v1/cvs/{id}/download"] = {
    get: operation(
      ["cvs:read"],
      {
        summary: "Get a short-lived private CV download",
        description:
          "Requires cvs:read. S3 references only (downloadProtocol s3-url-v1); Blob references return 409 CV_DOWNLOAD_PROTOCOL_MISMATCH. Returns {url,expiresAt}; link is a bearer credential and must not be logged.",
      },
      { "200": { description: "{url, expiresAt}." } },
      { params: [idParameter] },
    ),
  };
  paths["/api/v1/cvs/{id}/manifest"] = {
    get: operation(
      ["cvs:read"],
      {
        summary: "Read a Blob CV download manifest",
        description:
          "Requires cvs:read. Disabled until Blob CV storage is enabled. For downloadProtocol blob-chunks-v1 only; S3 references return 409 CV_DOWNLOAD_PROTOCOL_MISMATCH. Makes no storage call and returns no provider URL or pathname. The manifest grants nothing by itself: every chunk request is authorized again.",
      },
      {
        "200": {
          description: "{data: Blob CV manifest}.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["data"],
                properties: {
                  data: { $ref: "#/components/schemas/BlobCvManifestV1" },
                },
              },
            },
          },
        },
      },
      { params: [idParameter] },
    ),
  };
  paths["/api/v1/cvs/{id}/chunks"] = {
    get: operation(
      ["cvs:read"],
      {
        summary: "Read one verified Blob CV chunk",
        description:
          "Requires cvs:read. Disabled until Blob CV storage is enabled. Reauthorizes the caller, reads the whole stored object and releases the 4 MiB slice only after its SHA-256 matches the validated digest. Send exactly one index parameter. Replaced, missing or altered objects return 409 CV_INTEGRITY_FAILED with no file bytes; S3 references return 409 CV_DOWNLOAD_PROTOCOL_MISMATCH; storage timeouts return 503. Verify the final SHA-256 after assembling every chunk.",
      },
      {
        "200": {
          description:
            "The raw chunk bytes. The X-CV-* headers come from the validated reference.",
          headers: {
            "X-CV-Upload-Id": { schema: { type: "string", format: "uuid" } },
            "X-CV-Chunk-Index": { schema: { type: "integer", minimum: 0 } },
            "X-CV-Chunk-Offset": { schema: { type: "integer", minimum: 0 } },
            "X-CV-Size-Bytes": { schema: { type: "integer", minimum: 1 } },
            "X-CV-SHA256": {
              schema: { type: "string", pattern: "^[0-9a-f]{64}$" },
            },
          },
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
      },
      {
        params: [
          idParameter,
          {
            name: "index",
            in: "query",
            required: true,
            schema: { type: "integer", minimum: 0 },
            description:
              "Zero-based chunk index below chunkCount, in decimal without leading zeros.",
          },
        ],
      },
    ),
  };
  paths["/api/v1/overview"] = {
    get: operation(
      ["candidates:read", "recruitment:read"],
      {
        summary: "Read the team overview",
        description:
          "Requires candidates:read and recruitment:read. Team-scoped factual counts.",
      },
      { "200": { description: "Overview counts and lists." } },
    ),
  };
  paths["/api/v1/analytics"] = {
    get: operation(
      ["candidates:read", "recruitment:read"],
      {
        summary: "Read analytics",
        description:
          "Requires candidates:read and recruitment:read. Documents observed-history limits.",
      },
      { "200": { description: "Analytics for the date range." } },
      {
        params: ["from", "to"].map((name) => ({
          name,
          in: "query",
          schema: { type: "string", format: "date" },
        })),
      },
    ),
  };
  paths["/api/v1/activity"] = {
    get: operation(
      ["recruitment:read"],
      {
        summary: "Read team activity",
        description:
          "Requires recruitment:read. Candidate activity is limited to callers with candidates:read.",
      },
      { "200": { description: "{data, pagination}." } },
      {
        params: ["page", "pageSize", "recordId", "search", "kind"].map(
          (name) => ({ name, in: "query", schema: { type: "string" } }),
        ),
      },
    ),
  };
  paths["/api/v1/search"] = {
    get: operation(
      [],
      {
        summary: "Search the workspace",
        description:
          "No fixed scope: each group is included only when the caller can read it (candidates:read or recruitment:read).",
      },
      { "200": { description: "{groups, total, limited, data}." } },
      { params: [{ name: "q", in: "query", schema: { type: "string" } }] },
    ),
  };
  paths["/api/v1/notifications"] = {
    get: operation(
      ["recruitment:read"],
      {
        summary: "Read personal reminders",
        description:
          "Requires recruitment:read. Returns bounded unread-first reminders, full total and unread count.",
      },
      {
        "200": {
          description: "Up to 500 reminders, unread first.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["data", "total", "limited", "unread", "unreadCount"],
                properties: {
                  data: { type: "array", items: { type: "object" } },
                  total: { type: "integer" },
                  limited: {
                    type: "boolean",
                    description: "True when total exceeds data.length.",
                  },
                  unread: { type: "integer" },
                  unreadCount: {
                    type: "integer",
                    description: "Same as unread.",
                  },
                },
              },
            },
          },
        },
      },
    ),
    post: operation(
      ["recruitment:read", "recruitment:write"],
      {
        summary: "Mark visible genuine reminders read",
        description:
          "Token clients need recruitment:read and recruitment:write. Human viewers can mark their own reminders. Keys must identify current genuine reminders for the selected team.",
        requestBody: jsonBody(
          {
            type: "object",
            required: ["keys"],
            additionalProperties: false,
            properties: {
              keys: {
                type: "array",
                maxItems: 500,
                items: { type: "string", maxLength: 300 },
              },
            },
          },
          { keys: [`task:${exampleIds.parent}:2026-12-01`] },
        ),
      },
      {
        "200": {
          description: "Number of reminders newly marked read.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["updated"],
                properties: { updated: { type: "integer" } },
              },
            },
          },
        },
      },
    ),
  };
  paths["/api/openapi.json"] = {
    get: {
      summary: "Read this OpenAPI document",
      security: [],
      "x-required-scopes": [],
      responses: { "200": { description: "OpenAPI 3.1 document." } },
    },
  };
  const authDetails = {
    security: [],
    "x-required-scopes": [],
    description:
      "Better Auth interactive sign-in and session flows for the web application; not part of the token API. Responses generated by Better Auth itself use its own format.",
    parameters: [
      {
        name: "path",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Better Auth endpoint path, for example sign-in/email.",
      },
    ],
  };
  paths["/api/auth/{path}"] = {
    get: {
      summary: "Better Auth session flows",
      ...authDetails,
      responses: {
        "200": { description: "Better Auth response." },
        "503": errors["503"],
      },
    },
    post: {
      summary: "Better Auth sign-in flows",
      ...authDetails,
      requestBody: jsonBody(
        { type: "object" },
        {
          email: "recruiter@example.test",
          password: "fictional-example-password",
        },
      ),
      responses: {
        "200": { description: "Better Auth response." },
        "413": errors["413"],
        "503": errors["503"],
      },
    },
  };
  return Response.json(
    {
      openapi: "3.1.0",
      info: {
        title: "RecruitmentOS API",
        version: "1.0.0",
        description:
          "Scoped API for authorised integrations. Token creation and team administration require human sign-in and are not exposed to API tokens. x-required-scopes lists the scopes a caller must hold; x-session-only operations reject Bearer tokens with 403 session_required. Every error carries error.correlationId and an identical X-Correlation-Id header. AI assistants use POST /api/mcp. Its OAuth 2.1 protocol endpoints (/oauth/authorize, /oauth/token, /oauth/register) use RFC 6749 and RFC 7591 form and error formats and are described by /.well-known/oauth-authorization-server and /.well-known/oauth-protected-resource/api/mcp rather than here.",
      },
      servers: [{ url: "/" }],
      security: [{ bearerAuth: [] }],
      paths,
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description:
              "A user/team-scoped token created in Team & settings → API tokens.",
          },
          oauth2: {
            type: "oauth2",
            description:
              "For MCP clients only: authorization code with S256 PKCE, public clients registered at /oauth/register. Access tokens last at most one hour, are bound to /api/mcp and are refused by /api/v1.",
            flows: {
              authorizationCode: {
                authorizationUrl: "/oauth/authorize",
                tokenUrl: "/oauth/token",
                refreshUrl: "/oauth/token",
                scopes: Object.fromEntries(
                  MCP_SCOPES.map((scope) => [
                    scope,
                    mcpScopeDescriptions[scope],
                  ]),
                ),
              },
            },
          },
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: "better-auth.session_token",
            description: "Interactive web session from signing in.",
          },
        },
        headers: {
          "X-Correlation-Id": {
            description:
              "Unique ID for this error response; equals error.correlationId. Quote it when reporting a failure.",
            schema: { type: "string", format: "uuid" },
          },
          "Retry-After": {
            description: "Seconds to wait before retrying.",
            schema: { type: "integer", minimum: 1 },
          },
          "WWW-Authenticate": {
            description:
              'Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/api/mcp", with error="invalid_token" when a presented token was refused.',
            schema: { type: "string" },
          },
        },
        schemas: {
          ...schemas,
          RecordDto: recordDto,
          S3FormUploadV1: {
            type: "object",
            required: [
              "protocol",
              "method",
              "url",
              "fields",
              "expiresAt",
              "maxBytes",
            ],
            properties: {
              protocol: { const: "s3-form-v1" },
              method: { const: "POST" },
              url: { type: "string", format: "uri" },
              fields: {
                type: "object",
                additionalProperties: { type: "string" },
              },
              expiresAt: { type: "string", format: "date-time" },
              maxBytes: { type: "integer", minimum: 1, maximum: 10485760 },
            },
          },
          BlobPutUploadV1: {
            type: "object",
            required: [
              "protocol",
              "method",
              "url",
              "headers",
              "expiresAt",
              "maxBytes",
            ],
            properties: {
              protocol: { const: "blob-put-v1" },
              method: { const: "PUT" },
              url: { type: "string", format: "uri" },
              headers: {
                type: "object",
                required: ["content-type"],
                additionalProperties: false,
                properties: { "content-type": { type: "string" } },
              },
              expiresAt: { type: "string", format: "date-time" },
              maxBytes: { type: "integer", minimum: 1, maximum: 10485760 },
            },
          },
          BlobCvManifestV1: {
            type: "object",
            required: [
              "protocol",
              "uploadId",
              "originalName",
              "contentType",
              "sizeBytes",
              "sha256",
              "chunkSize",
              "chunkCount",
            ],
            properties: {
              protocol: { const: "blob-chunks-v1" },
              uploadId: { type: "string", format: "uuid" },
              originalName: { type: "string" },
              contentType: { type: "string" },
              sizeBytes: { type: "integer", minimum: 1, maximum: 10485760 },
              sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
              chunkSize: { const: 4194304 },
              chunkCount: {
                type: "integer",
                minimum: 1,
                description: "ceil(sizeBytes / chunkSize).",
              },
            },
          },
          Error: {
            type: "object",
            required: ["error"],
            properties: {
              error: {
                type: "object",
                required: ["code", "message", "correlationId"],
                properties: {
                  code: { type: "string" },
                  message: { type: "string" },
                  correlationId: { type: "string", format: "uuid" },
                },
              },
            },
          },
        },
      },
    },
    {
      headers: {
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
