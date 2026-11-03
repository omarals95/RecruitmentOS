import { z } from "zod";
import { recordDataSchemas, resourceToKind } from "@/domain/records";
export const runtime = "nodejs";
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
  const responses = {
    "200": { description: "Success; JSON data, with pagination for lists." },
    "400": { description: "Invalid fields or references." },
    "401": { description: "Missing, invalid, expired or revoked credentials." },
    "403": { description: "Scope, role, verification or team access denied." },
    "409": {
      description:
        "Version, duplicate or idempotency conflict; preserve your draft and re-read.",
    },
    "429": { description: "Rate limit; respect Retry-After." },
    "503": { description: "Required service configuration is unavailable." },
  };
  const paths: Record<string, unknown> = {};
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
      get: {
        summary: `List ${resource}`,
        description: `Requires ${scope}:read. Page size is capped at 100. Search supports words, quoted phrases and exclusions.`,
        parameters: [
          ...parameters,
          ...[
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
        ],
        responses,
      },
      post: {
        summary: `Create ${kind}`,
        description: `Requires ${scope}:write. References must belong to the selected team and have the expected record kind.`,
        parameters: [
          ...parameters,
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            schema: { type: "string", maxLength: 200 },
            description:
              "Reuse the same key and identical payload after an uncertain result; a different payload returns 409.",
          },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: input } },
        },
        responses: {
          ...responses,
          "201": {
            description: "Created or idempotently replayed; {data:record}.",
          },
        },
      },
    };
    paths[`/api/v1/${resource}/{id}`] = {
      get: {
        summary: `Get ${kind}`,
        parameters: [
          ...parameters,
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses,
      },
      patch: {
        summary: `Update or archive ${kind}`,
        description: `Requires ${scope}:write. Send the latest version and only changed data fields. Parent references for applications/interviews/offers/onboarding/checklists are immutable. Comments are append-only. Bucket archive requires moveToBucketId when tasks exist.`,
        parameters: [
          ...parameters,
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
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
            },
          },
        },
        responses,
      },
    };
  }
  paths["/api/v1/candidates/{id}/cvs"] = {
    get: {
      summary: "List private CV references",
      description:
        "Requires cvs:read; returns {data,pagination} with the full total. Storage keys and object versions are not exposed.",
      parameters: [
        ...parameters,
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
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
      responses,
    },
  };
  paths["/api/v1/candidates/{id}/cvs/uploads"] = {
    post: {
      summary: "Reserve a direct private S3 CV upload",
      description:
        "Requires cvs:write. Upload bytes to returned upload.url using multipart form fields plus file, then complete the upload. A ready replay returns upload:null. Never send CV bytes through the Vercel JSON API.",
      parameters: [
        ...parameters,
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
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
                  description:
                    "Imports only; original relative source metadata.",
                },
              },
            },
          },
        },
      },
      responses,
    },
  };
  paths["/api/v1/cvs/uploads/{id}/complete"] = {
    post: {
      summary: "Validate uploaded immutable CV version",
      description:
        "Requires cvs:write. Idempotent. Returns a ready reference only after size/type/format and version checks.",
      parameters: [
        ...parameters,
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses,
    },
  };
  paths["/api/v1/cvs/{id}/download"] = {
    get: {
      summary: "Get a short-lived private CV download",
      description:
        "Requires cvs:read. Returns {url,expiresAt}; link is a bearer credential and must not be logged.",
      parameters: [
        ...parameters,
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses,
    },
  };
  for (const name of [
    "overview",
    "analytics",
    "activity",
    "notifications",
    "search",
  ])
    paths[`/api/v1/${name}`] = {
      get: {
        summary: `Read ${name}`,
        description:
          "Team-scoped factual data; analytics documents observed-history limits.",
        parameters,
        responses,
      },
    };
  paths["/api/v1/notifications"] = {
    get: {
      summary: "Read personal reminders",
      description:
        "Requires recruitment:read. Returns bounded unread-first reminders, full total and unread count.",
      parameters,
      responses,
    },
    post: {
      summary: "Mark visible genuine reminders read",
      description:
        "Token clients need recruitment:read and recruitment:write. Human viewers can mark their own reminders. Keys must identify current genuine reminders for the selected team.",
      parameters,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
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
          },
        },
      },
      responses,
    },
  };
  return Response.json(
    {
      openapi: "3.1.0",
      info: {
        title: "RecruitmentOS API",
        version: "1.0.0",
        description:
          "Scoped API for authorised integrations. Token creation and team administration require human sign-in and are not exposed to API tokens.",
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
        },
        schemas,
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
