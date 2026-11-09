import { z } from "zod";
import {
  BULK_INTAKE_MAX_FILES,
  BULK_INTAKE_RECOVERY_HOURS,
  recordDataSchemas,
  resourceToKind,
  type RecordKind,
} from "@/domain/records";
import { EXPORT_RESOURCES } from "@/domain/export";
import { MCP_SCOPES, type Scope } from "@/lib/permissions";
import { CANDIDATE_SUGGESTION_LIMIT, EXPORT_FILTER_KEYS } from "@/lib/records";
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
    "Scope, role, verification, origin or team access denied. A session of an owner or admin without two-step sign-in gets two_step_setup_required.",
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
    candidateLabel: {
      type: "string",
      description:
        'Applications only: the candidate\'s name, or "Untitled candidate", with " (archived)" for an archived candidate. Left out without candidates:read.',
    },
    vacancyLabel: {
      type: "string",
      description:
        'Applications only: the vacancy\'s title, or "Untitled vacancy", with " (archived)" for an archived vacancy.',
    },
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
    const candidateCommentRead =
      kind === "comment"
        ? " Comments on a candidate also need candidates:read: without it they are left out of lists and pagination.total and answered as 404 not_found."
        : "";
    paths[`/api/v1/${resource}`] = {
      get: operation(
        [`${scope}:read`],
        {
          summary: `List ${resource}`,
          description: `Requires ${scope}:read. Page size is capped at 100. Search supports words, quoted phrases and exclusions.${resource === "candidates" ? " skills and certifications take a JSON array of up to 100 values and match candidates holding all of them, ignoring case and surrounding spaces." : ""}${candidateCommentRead}`,
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
            "skills",
            "certifications",
            "education",
            "minYearsExperience",
            "maxYearsExperience",
            "applicationCandidateId",
          ].map((name) => ({ name, in: "query", schema: { type: "string" } })),
        },
      ),
      post: operation(
        [`${scope}:write`],
        {
          summary: `Create ${kind}`,
          description: `Requires ${scope}:write. References must belong to the selected team and have the expected record kind.${kind === "comment" ? " A comment on a candidate also needs candidates:read and candidates:write: without candidates:read the parent is answered as 400 invalid_reference, as for a missing record; without candidates:write it returns 403." : ""}`,
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
        {
          summary: `Get ${kind}`,
          ...(candidateCommentRead
            ? { description: `Requires ${scope}:read.${candidateCommentRead}` }
            : {}),
        },
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
    if ((EXPORT_RESOURCES as readonly string[]).includes(resource))
      paths[`/api/v1/${resource}/export`] = {
        post: operation(
          [`${scope}:read`],
          {
            summary: `Export ${resource} as CSV`,
            description: `Requires ${scope}:read. Send no body. The query takes the list filters plus sort and direction; page and pageSize are refused because an export covers every matching record. Rows and their count come from one snapshot. 400 invalid_query for an unsupported, repeated or page filter; 400 export_too_large when more than 100,000 records match; 404 for a resource that cannot be exported. Each export writes one activity row (kind export) with the list, row count and applied filter keys, never filter values; the exporter's private shortlisted filter, and on candidates the personal status filter, still apply but are left out of that row; if that row cannot be written, no file is sent.`,
          },
          {
            "200": {
              description:
                "A UTF-8 CSV with a byte-order mark: the metadata rows, a blank row, the header and one row per record.",
              headers: {
                "Content-Disposition": {
                  schema: { type: "string" },
                  description: `attachment; filename RecruitmentOS-${resource}-YYYY-MM-DD-HHmm.csv (Asia/Dubai).`,
                },
                "X-Export-Rows": { schema: { type: "integer", minimum: 0 } },
              },
              content: {
                "text/csv": { schema: { type: "string" } },
              },
            },
          },
          {
            params: [...EXPORT_FILTER_KEYS, "sort", "direction"].map(
              (name) => ({ name, in: "query", schema: { type: "string" } }),
            ),
          },
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
  paths["/api/v1/candidates/{id}/erasure"] = {
    post: operation(
      [],
      {
        summary: "Permanently erase a candidate",
        description:
          "Session only, for data-protection requests: a signed-in team owner; admins, recruiters and viewers get 403 erasure_forbidden and Bearer tokens 403 session_required. There is no MCP tool. Send {confirmName} with the candidate's name exactly as shown (1 to 300 characters, compared after trimming, case-sensitive); a different name returns 400 erasure_confirmation_mismatch and an invalid id or body 400 invalid_input. A candidate that is not in the team, or an id of another kind of record, returns 404 not_found. In one transaction it deletes the candidate, its applications, their interviews, offers, onboarding and checklist items, and every comment on any of them; deletes every member's follow-up state and the notification reads of those records; unlinks linked tasks and replaces the name in their title, context and description with [erased candidate]; clears saved-view searches that contain the name as a whole phrase (case-insensitive, with no letter or digit directly before or after it, for names of at least 3 characters), the email or the phone; tombstones the candidate's bulk import items; makes its CV uploads rejected and nameless; replaces the stored responses of idempotency keys that name an erased record, so a replay returns 409 idempotency_expired; and redacts the activity rows about those records and the candidate's AI suggestion records, keeping their type, time and actor. It records a tombstone with only the candidate id, team, owner and time, and one candidate.erased activity row with counts. Each CV file in Blob storage is deleted, confirmed missing and its charge released only once its last upload ticket expired at least 10 minutes ago; a file still waiting is deleted by a later CV storage cleanup (see /api/v1/cvs/storage-reconciliation) or a retry of this call. A retry for an erased candidate returns 200 with alreadyErased true, the same erasureId and removed null, and repeats that CV deletion. Exports already downloaded are not affected. When the team's CV storage records cannot settle a CV's charge it returns 500 erasure_storage_settlement_failed with a correlation id and changes nothing. Returns {data:{erasureId, alreadyErased, erasedAt, removed:{applications, interviews, offers, onboarding, checklistItems, comments, followUpStates, tasksUnlinked, savedViewsCleared, bulkItems, cvFiles, activityRedacted, notificationReads, idempotencyKeys} or null, cvStorage:{deleted, waiting, deleteAfter}}}: deleted and waiting count this erasure's Blob CV files with and without a confirmed deletion, and deleteAfter is the latest time after which a waiting file can be deleted, or null.",
        requestBody: jsonBody(
          {
            type: "object",
            required: ["confirmName"],
            additionalProperties: false,
            properties: {
              confirmName: { type: "string", minLength: 1, maxLength: 300 },
            },
          },
          { confirmName: "Amira Fictional" },
        ),
      },
      {
        "200": {
          description:
            "{data:{erasureId, alreadyErased, erasedAt, removed, cvStorage:{deleted, waiting, deleteAfter}}}.",
        },
      },
      { sessionOnly: true, params: [idParameter] },
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
  paths["/api/v1/candidates/suggestions"] = {
    get: operation(
      ["candidates:read"],
      {
        summary: "Skill and certification suggestions",
        description: `Requires candidates:read. Takes no query parameters; any parameter returns 400 invalid_query. The values of the selected team's active candidates, aggregated in the database: values that differ only in case or surrounding spaces are one entry, shown in their most common spelling (ties: the alphabetically first), ordered by how many candidates hold them, then alphabetically, at most ${CANDIDATE_SUGGESTION_LIMIT} per field.`,
      },
      {
        "200": {
          description: `{data: {skills: string[], certifications: string[]}}; at most ${CANDIDATE_SUGGESTION_LIMIT} entries each.`,
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
          "Requires cvs:write and candidates:write. storageConfigured reports whether private CV storage is set up in the server environment; it is read from configuration only and contacts no storage provider. uploadsAvailable equals storageConfigured, the same readiness single CV upload uses: Blob and unknown providers report false. aiAvailable is true only when an approved AI extraction provider is configured; none is configured in this build, so it is false.",
      },
      {
        "200": {
          description:
            "{data:{uploadsAvailable:boolean, aiAvailable:boolean, storageConfigured:boolean}}.",
        },
      },
    ),
  };
  const disclosureSchema = {
    type: ["object", "null"],
    required: [
      "version",
      "provider",
      "model",
      "region",
      "retention",
      "trainingUse",
      "costNote",
      "purpose",
      "dataSent",
      "limits",
    ],
    properties: {
      version: {
        type: "string",
        pattern: "^[0-9a-f]{64}$",
        description:
          "SHA-256 of every other disclosure field; any change to them changes it.",
      },
      ...Object.fromEntries(
        [
          "provider",
          "model",
          "region",
          "retention",
          "trainingUse",
          "costNote",
          "purpose",
          "dataSent",
          "limits",
        ].map((name) => [name, { type: "string" }]),
      ),
    },
  };
  const consentShape = {
    "200": {
      description:
        "{data:{available, disclosure, consent:{status, at}}}. status is none (no decision), granted (for the current disclosure version), withdrawn, or outdated (granted for another version, or no provider is configured).",
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["data"],
            properties: {
              data: {
                type: "object",
                required: ["available", "disclosure", "consent"],
                properties: {
                  available: { type: "boolean" },
                  disclosure: disclosureSchema,
                  consent: {
                    type: "object",
                    required: ["status", "at"],
                    properties: {
                      status: {
                        enum: ["none", "granted", "withdrawn", "outdated"],
                      },
                      at: { type: ["string", "null"], format: "date-time" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const aiScopes: Scope[] = ["cvs:write", "candidates:write"];
  const aiAccess =
    "Session only: a Bearer token returns 403 session_required. Requires cvs:write and candidates:write, so viewers get 403. No approved AI extraction provider is configured in this build, so the extraction endpoints are unavailable.";
  paths["/api/v1/extraction-consent"] = {
    get: operation(
      aiScopes,
      {
        summary: "Read the AI extraction disclosure and my consent",
        description: `${aiAccess} available is false and disclosure is null when no provider is configured. Consent is per user and team and is tied to the disclosure version.`,
      },
      consentShape,
      { sessionOnly: true },
    ),
    post: operation(
      aiScopes,
      {
        summary: "Allow or withdraw AI suggestions from CVs",
        description: `${aiAccess} grant needs a configured provider (503 ai_not_configured) and the current disclosure version (409 ai_disclosure_changed). withdraw is always recorded, with the version shown to the user or null; it stops new requests, and CVs already sent stay with the provider under its stated retention terms. Each decision is one append-only ai-extraction activity event (ai.consent_granted with disclosureVersion, provider and model; ai.consent_withdrawn with disclosureVersion), visible to team members. Body at most 4096 bytes.`,
        requestBody: jsonBody(
          {
            type: "object",
            required: ["decision", "disclosureVersion"],
            additionalProperties: false,
            properties: {
              decision: { enum: ["grant", "withdraw"] },
              disclosureVersion: {
                type: ["string", "null"],
                pattern: "^[0-9a-f]{64}$",
              },
            },
          },
          {
            decision: "grant",
            disclosureVersion:
              "5f1c0e7a9b3d2c4e6f8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e",
          },
        ),
      },
      consentShape,
      { sessionOnly: true },
    ),
  };
  paths["/api/v1/extraction-jobs"] = {
    post: operation(
      aiScopes,
      {
        summary: "Get unverified AI suggestions from one CV",
        description: `${aiAccess} Sends one CV, base64-encoded in content, for unverified suggestions of the 10 candidate fields. The body is at most ${4 * 1024 * 1024 + 8192} bytes. Checks run in order: 503 ai_not_configured; 400 invalid_input for malformed base64; 413 ai_file_too_large over 3 MiB; 400 ai_digest_mismatch when the decoded length differs from file.sizeBytes or its SHA-256 from file.sha256; 400 INVALID_CV when the bytes fail the CV format check; then, under a per-team lock, 409 ai_disclosure_changed, 409 ai_consent_required, 409 ai_request_used for a requestId already sent (it is never sent again) and 429 ai_budget_exhausted after 100 requests by the team in 24 hours, where every request counts, failed, cancelled and uncertain ones included. The provider's adapter then receives only the CV bytes and MIME type, once, with no retries, and stops after 30 seconds. Provider outcomes: 504 ai_timed_out, 429 ai_rate_limited, 429 ai_quota_exhausted, 502 ai_provider_failed, 502 ai_invalid_response and 409 ai_cancelled when the client goes away; after a timeout or provider failure the CV may already have reached the provider. Each request writes ai.extraction_started and ai.extraction_finished activity events with the request ID, digest, size, type, provider, model, outcome and suggested field names, never the file name or any CV content or extracted value. Nothing is saved to a record: suggestions are returned only for the user to accept, reject or edit before import.`,
        requestBody: jsonBody(
          {
            type: "object",
            required: ["requestId", "disclosureVersion", "file", "content"],
            additionalProperties: false,
            properties: {
              requestId: { type: "string", format: "uuid" },
              disclosureVersion: { type: "string", pattern: "^[0-9a-f]{64}$" },
              file: {
                type: "object",
                required: ["originalName", "mimeType", "sizeBytes", "sha256"],
                additionalProperties: false,
                properties: {
                  originalName: { type: "string", maxLength: 180 },
                  mimeType: { type: "string", maxLength: 150 },
                  sizeBytes: { type: "integer", minimum: 1 },
                  sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
                },
              },
              content: {
                type: "string",
                contentEncoding: "base64",
                description: "The whole CV file, standard padded base64.",
              },
            },
          },
          {
            requestId: exampleIds.second,
            disclosureVersion:
              "5f1c0e7a9b3d2c4e6f8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e",
            file: {
              originalName: "fictional-cv.pdf",
              mimeType: "application/pdf",
              sizeBytes: 9,
              sha256:
                "0716f9264c9fe19f5d7455276107f3ddcc1d3497f63d60689a73558ae8a1bf5e",
            },
            content: "JVBERi0xLjcK",
          },
        ),
      },
      {
        "200": {
          description:
            "{data:{requestId, status:'succeeded', suggestions, provenance:{requestId, sourceSha256, provider, model, extractedAt}}}. suggestions holds only the 10 candidate fields; null means unknown and an omitted field was not supplied. All suggestions are unverified.",
        },
        "502": errorResponse(
          "ai_provider_failed or ai_invalid_response; no suggestions were added.",
        ),
        "504": errorResponse(
          "ai_timed_out; the CV may already have reached the provider.",
        ),
      },
      { sessionOnly: true },
    ),
  };
  const batchParam = {
    name: "batchId",
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
    description:
      "Client-chosen import batch ID; one per import session. The batch is private to its creator.",
  };
  const bulkParams = [
    batchParam,
    {
      name: "itemId",
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
      description:
        "Client-chosen item ID, one per selected CV file. It is also the clientUploadId of the item's first CV upload attempt.",
    },
  ];
  const bulkLifetime = `A batch's recovery rows last ${BULK_INTAKE_RECOVERY_HOURS} hours from its first item and are never extended. Afterwards the batch returns 409 bulk_batch_expired to item and upload POSTs and is hidden from the GETs. When an expired batch is purged (the next bulk item POST or list GET in any team, at most 100 per request), its items are deleted. Its batch ID stays reserved, so later item and upload POSTs for it, from any client, still return 409 bulk_batch_expired and never recreate it, and both GETs keep hiding it. Another team's or another user's batch or item returns 404.`;
  const batchShape = `{id, createdAt, expiresAt, items: [{id, originalName, sizeBytes, candidateId, possibleDuplicates, outcome}]} with all of the batch's items (at most ${BULK_INTAKE_MAX_FILES}); possibleDuplicates is the number of possible duplicates found when the item was imported, null before`;
  paths["/api/v1/cvs/bulk-batches"] = {
    get: operation(
      ["cvs:write", "candidates:write"],
      {
        summary: "List my recent bulk CV imports",
        description: `Requires cvs:write and candidates:write. Returns one page of the caller's unexpired batches in the selected team, newest first (createdAt, then id, descending); pagination.total counts all of them. Only page and pageSize are accepted, each at most once, as positive whole decimal numbers; anything else returns 400 invalid_query. outcome is derived when read: not-imported (no candidate), cv-pending (candidate without a ready CV), imported (CV ready) or cv-rejected. No candidate field values are stored or returned. ${bulkLifetime}`,
      },
      {
        "200": {
          description: `{data: [batch], pagination: {page, pageSize, total, totalPages}}; each batch is ${batchShape}.`,
        },
      },
      {
        params: [
          {
            name: "page",
            in: "query",
            schema: {
              type: "integer",
              minimum: 1,
              maximum: 1000000,
              default: 1,
            },
          },
          {
            name: "pageSize",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 20, default: 10 },
          },
        ],
      },
    ),
  };
  paths["/api/v1/cvs/bulk-batches/{batchId}"] = {
    get: operation(
      ["cvs:write", "candidates:write"],
      {
        summary: "Read one of my recent bulk CV imports",
        description: `Requires cvs:write and candidates:write. Returns the caller's own unexpired batch in the list-entry shape. A malformed, unknown, expired, purged, another user's or another team's batch ID returns 404 not_found. This GET does not purge. ${bulkLifetime}`,
      },
      { "200": { description: `{data: batch}; the batch is ${batchShape}.` } },
      { params: [batchParam] },
    ),
  };
  paths["/api/v1/cvs/bulk-batches/{batchId}/items/{itemId}"] = {
    post: operation(
      ["cvs:write", "candidates:write"],
      {
        summary: "Create the candidate for one reviewed bulk CV",
        description: `Requires cvs:write and candidates:write. Returns 503 STORAGE_SETUP_REQUIRED before any write when CV uploads are unavailable. A batch holds up to ${BULK_INTAKE_MAX_FILES} items; another item returns 400 bulk_batch_limit. Reusing an item ID with a different file or different data returns 409 bulk_item_conflict. Repeating a created item returns it unchanged and creates nothing. Otherwise factsReviewed and duplicatesReviewed must both be true (400 bulk_review_required), and the server re-runs the exact email and phone match: any current match not listed in acknowledgedDuplicateIds returns 409 bulk_duplicates_changed, so check duplicates again. The candidate is created with reviewStatus Reviewed, and its created activity event records the review evidence (bulkIntake: batchId, itemId, factsReviewed, duplicatesReviewed, possibleDuplicates, limited). Source fields (rawSource, evidence, sourceReviews) are not accepted. Optional aiReview ({requestId, decisions}) records how AI suggestions were reviewed: before anything is created, the server looks for the caller's own ai.extraction_finished event in the team with that requestId, outcome succeeded and the same validated file size and MIME type (else 400 ai_review_invalid), and the decision keys must equal its suggested field names (else 400 ai_review_incomplete). The created event then also holds aiReview: requestId, sourceSha256, provider, model, extractedAt and decisions. data is always the submitted human-reviewed values; aiReview is not part of the replay check. ${bulkLifetime}`,
        requestBody: jsonBody(
          {
            type: "object",
            required: ["file", "data"],
            additionalProperties: false,
            properties: {
              file: {
                type: "object",
                required: ["originalName", "mimeType", "sizeBytes"],
                additionalProperties: false,
                properties: {
                  originalName: { type: "string", maxLength: 180 },
                  mimeType: { type: "string", maxLength: 150 },
                  sizeBytes: {
                    type: "integer",
                    minimum: 1,
                    maximum: 10485760,
                  },
                },
              },
              data: {
                $ref: "#/components/schemas/candidates",
                description:
                  "Candidate details without rawSource, evidence or sourceReviews.",
              },
              factsReviewed: { type: "boolean", const: true },
              duplicatesReviewed: { type: "boolean", const: true },
              acknowledgedDuplicateIds: {
                type: "array",
                maxItems: 20,
                items: { type: "string", format: "uuid" },
                description:
                  "The possible duplicate IDs shown at the last duplicate check.",
              },
              aiReview: {
                type: "object",
                required: ["requestId", "decisions"],
                additionalProperties: false,
                properties: {
                  requestId: { type: "string", format: "uuid" },
                  decisions: {
                    type: "object",
                    propertyNames: {
                      enum: [
                        "name",
                        "email",
                        "phone",
                        "jobTitle",
                        "employer",
                        "university",
                        "degreeName",
                        "major",
                        "skills",
                        "certifications",
                      ],
                    },
                    additionalProperties: {
                      enum: ["accepted", "rejected", "edited"],
                    },
                  },
                },
                description:
                  "Optional. The extraction job's requestId and one decision per suggested field.",
              },
            },
          },
          {
            file: {
              originalName: "fictional-cv.pdf",
              mimeType: "application/pdf",
              sizeBytes: 48213,
            },
            data: {
              name: "Amira Fictional",
              email: "amira.fictional@example.test",
            },
            factsReviewed: true,
            duplicatesReviewed: true,
            acknowledgedDuplicateIds: [],
          },
        ),
      },
      {
        "201": {
          description:
            "{data: item} with id, batchId, originalName, mimeType, sizeBytes, candidateId, uploadId, reviewedAt, possibleDuplicates, createdAt, updatedAt and the batch expiresAt.",
        },
      },
      { params: bulkParams },
    ),
  };
  paths["/api/v1/cvs/bulk-batches/{batchId}/items/{itemId}/upload"] = {
    post: operation(
      ["cvs:write", "candidates:write"],
      {
        summary: "Reserve the CV upload for a bulk item",
        description: `Requires cvs:write and candidates:write. Send no body. Reserves the private CV upload for the item's candidate with the item's stored file metadata; the client chooses neither the metadata nor the key. The first attempt uses the item ID as clientUploadId. A repeat while the current attempt is pending and unexpired returns the same CV upload and creates no reservation; a ready attempt returns it with upload:null. When the current attempt is rejected or its reservation expired, the call starts one new attempt for the same file under a new server-chosen clientUploadId, records it on the item and returns 201 with the new ticket; overlapping calls share that one new attempt. The ticket is either protocol of /api/v1/candidates/{id}/cvs/uploads (s3-form-v1 or blob-put-v1), and a ready Blob CV is read through /manifest and /chunks (blob-chunks-v1). Returns 503 STORAGE_SETUP_REQUIRED when CV uploads are unavailable and 409 bulk_candidate_required before the item's candidate exists. When the team's CV upload rate limit is on, a new reservation beyond its requests per minute returns 429 CV_UPLOAD_RATE_LIMITED with Retry-After: 60; a replay of an existing reservation is not refused. A Blob attempt gets at most 5 upload tickets; after that a repeat returns 409 CV_UPLOAD_TICKET_LIMIT until the attempt's reservation expires. Send the bytes as described for /api/v1/candidates/{id}/cvs/uploads, then complete through /api/v1/cvs/uploads/{id}/complete. ${bulkLifetime}`,
      },
      {
        "201": {
          description:
            "{data: CV reference, upload}, as for /api/v1/candidates/{id}/cvs/uploads.",
        },
      },
      { params: bulkParams },
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
  paths["/api/v1/teams/two-step-reset"] = {
    post: operation(
      [],
      {
        summary: "Reset a member's two-step sign-in",
        description:
          "Session only: a signed-in owner of the active team; others get 403 owner_required. Removes the member's authenticator key and backup codes, turns two-step sign-in off, signs them out everywhere and forgets their trusted devices, so they set it up again at their next sign-in when their role requires it. Writes one account-security activity row (two_step.reset) with the targetUserId. 400 cannot_reset_self for your own account (use backup codes or Account settings), 404 member_not_found when the user is not a member of this team, 409 member_in_other_team when they also belong to a team you do not own (the reset is account-wide), 409 two_step_not_enabled when there is nothing to reset. Body at most 1024 bytes.",
        requestBody: jsonBody(
          {
            type: "object",
            required: ["userId"],
            additionalProperties: false,
            properties: { userId: { type: "string", maxLength: 128 } },
          },
          { userId: "fictional-member-id" },
        ),
      },
      { "200": { description: "{data:{reset:true}}." } },
      { sessionOnly: true },
    ),
  };
  paths["/api/v1/teams/member-roles"] = {
    post: operation(
      [],
      {
        summary: "Assign or clear a member's configured role",
        description:
          "Session only: a signed-in company owner; others, including team owners and admins without company authority and company admins, get 403 role_assignment_forbidden. roleObjectId names a published role configuration object of the company; null clears the member's role and leaves their team role unchanged. The role row is written first; when the member's team role differs from the role's membership it is then changed through the existing team-role rules, and if those refuse, 409 team_role_unchanged says the role was saved and the narrower of the two applies. Every assignment and clear writes one role-assignment activity row. 404 member_not_found when the user is not a member of this team, 404 not_found for an unknown role, 409 team_owner_role for a team owner, 409 role_not_published, 409 role_invalid for a published body that is not a valid role, 409 role_record_scope_unsupported for a role limited to a unit or to assigned records (refused until record scope is enforced). Body at most 1024 bytes.",
        requestBody: jsonBody(
          {
            type: "object",
            required: ["userId", "roleObjectId"],
            additionalProperties: false,
            properties: {
              userId: { type: "string", minLength: 1, maxLength: 128 },
              roleObjectId: { type: ["string", "null"], format: "uuid" },
            },
          },
          {
            userId: "fictional-member-id",
            roleObjectId: "00000000-0000-4000-a000-000000000010",
          },
        ),
      },
      {
        "200": {
          description:
            "{data:{userId, roleObjectId, roleVersionId, membership}}; the role fields are null after a clear.",
        },
      },
      { sessionOnly: true },
    ),
  };
  const storageSettings = {
    type: "object",
    required: [
      "maxBytes",
      "maxFiles",
      "uploadRequestsPerMinute",
      "mcpCvTextEnabled",
    ],
    additionalProperties: false,
    properties: {
      maxBytes: {
        type: ["integer", "null"],
        minimum: 1_000_000,
        maximum: 10_000_000_000_000,
        description:
          "Decimal bytes; null with maxFiles null turns the limit off.",
      },
      maxFiles: { type: ["integer", "null"], minimum: 1, maximum: 1_000_000 },
      uploadRequestsPerMinute: {
        type: ["integer", "null"],
        minimum: 1,
        maximum: 600,
        description: "New CV upload reservations per minute; null is off.",
      },
      mcpCvTextEnabled: {
        type: "boolean",
        description:
          "Connected AI apps can read CV contents: whether the MCP CV text tools may read this team's CVs.",
      },
    },
  };
  const storageSettingsShape =
    "{data:{maxBytes, maxFiles, uploadRequestsPerMinute, mcpCvTextEnabled, usage:{usedBytes, usedFiles, reservedBytes, reservedFiles, retainedBytes, retainedFiles}}}";
  paths["/api/v1/teams/storage-settings"] = {
    get: operation(
      [],
      {
        summary: "Read the team's CV storage settings and usage",
        description: `Session only: a signed-in team owner or admin; others get 403 storage_settings_forbidden. Returns the team's storage limit, upload rate limit, whether connected AI apps can read CV contents (mcpCvTextEnabled) and current usage: stored (used), uploads in progress (reserved) and rejected or abandoned files waiting for cleanup (retained). Nulls mean off; a team that never reserved storage reads as nulls and zeros, with mcpCvTextEnabled true. These are application limits, not hard provider caps; the store-wide budget set by the RecruitmentOS owner always applies.`,
      },
      { "200": { description: storageSettingsShape } },
      { sessionOnly: true },
    ),
    put: operation(
      [],
      {
        summary: "Change the team's CV storage settings",
        description: `Session only: a signed-in team owner or admin; others get 403 storage_settings_forbidden. Send all four fields: maxBytes and maxFiles are both null (limit off) or both set; uploadRequestsPerMinute is null (off) or 1 to 600; mcpCvTextEnabled is true or false. Anything else, including an unknown key, returns 400 invalid_input. A limit below current usage is accepted: existing CVs stay available, but new reservations return 409 STORAGE_QUOTA_EXCEEDED until usage is below it. The limits and the CV contents setting each write one storage-settings activity row (storage.settings_updated) with their before and after values when they change; an unchanged request writes none. Returns ${storageSettingsShape}.`,
        requestBody: jsonBody(storageSettings, {
          maxBytes: 500_000_000,
          maxFiles: 100,
          uploadRequestsPerMinute: null,
          mcpCvTextEnabled: true,
        }),
      },
      { "200": { description: storageSettingsShape } },
      { sessionOnly: true },
    ),
  };
  const speedSummaryShape =
    "{data:[{kind, name, samples, medianMs, p95Ms, medianDbMs?, p95DbMs?}]}";
  paths["/api/v1/speed-samples"] = {
    post: operation(
      [],
      {
        summary: "Record speed log timings",
        description: `Session only: any signed-in team member, viewers included (Bearer tokens get 403 session_required). Send {samples:[{kind, name, durationMs, dbMs?}]} with 1 to 50 samples and at most 16 KiB. kind "action" takes one of the fixed action names (task.move, application.stage, tab.<section> for each main tab, candidate.open, candidate.save, interview.schedule); kind "route" takes "<METHOD> /api/v1/<pattern>" of at most 80 characters, where every path segment is a plain lowercase word or [id], and may carry dbMs. durationMs and dbMs are whole milliseconds from 0 to 600000. Anything else, including an unknown key, dbMs on an action or a larger body, returns 400 invalid_input. Stores timings and names only, never ids, names or content, with the time rounded to the hour; one write also deletes at most 1000 of the team's rows older than 30 days. Nothing is audited. Returns 202 {accepted}.`,
        requestBody: jsonBody(
          {
            type: "object",
            required: ["samples"],
            additionalProperties: false,
            properties: {
              samples: {
                type: "array",
                minItems: 1,
                maxItems: 50,
                items: {
                  type: "object",
                  required: ["kind", "name", "durationMs"],
                  additionalProperties: false,
                  properties: {
                    kind: { enum: ["action", "route"] },
                    name: { type: "string", maxLength: 80 },
                    durationMs: {
                      type: "integer",
                      minimum: 0,
                      maximum: 600000,
                    },
                    dbMs: { type: "integer", minimum: 0, maximum: 600000 },
                  },
                },
              },
            },
          },
          {
            samples: [
              { kind: "action", name: "task.move", durationMs: 180 },
              {
                kind: "route",
                name: "PATCH /api/v1/tasks/[id]",
                durationMs: 42,
                dbMs: 12,
              },
            ],
          },
        ),
      },
      { "202": { description: "{accepted} samples stored." } },
      { sessionOnly: true },
    ),
  };
  paths["/api/v1/teams/speed"] = {
    get: operation(
      [],
      {
        summary: "Read the team's speed log summary",
        description: `Session only: a signed-in team owner or admin; others get 403 speed_log_forbidden. Over the team's samples from the last 30 days, one row per kind and name, ordered by kind then name: samples (count), medianMs and p95Ms of the durations and, for routes, medianDbMs and p95DbMs (null when no db time was reported), rounded to whole milliseconds. Holds timings and route names only. Nothing is audited. Returns ${speedSummaryShape}.`,
      },
      { "200": { description: speedSummaryShape } },
      { sessionOnly: true },
    ),
  };
  // Organisation levels and units (0033): session only, no MCP tool (D13).
  const orgText = { type: "string", minLength: 1, maxLength: 120 };
  const orgTextRule =
    "Names and codes are stored as text facts: control, format, bidi and zero-width characters are removed, then they are trimmed and must be 1 to 120 characters.";
  const orgWriteRule =
    "Session only; Bearer tokens, including MCP OAuth tokens, get 403 session_required. Writes need a company owner, or a company admin with the organisation area; anyone else gets 403 org_forbidden.";
  const orgLevelShape = "{data:{id, name, depth, archivedAt}}";
  const orgUnitShape =
    "{data:{id, parentId, levelId, name, code, validFrom, archivedAt, hasChildren}}";
  const orgAudit =
    "Each change writes one org activity row to your team with ids only, never a name or code.";
  paths["/api/v1/org-units"] = {
    get: operation(
      [],
      {
        summary: "List one level of the organisation chart",
        description: `Session only: any signed-in member of a team in the company reads; Bearer tokens get 403 session_required. Returns the current, non-archived children of parentId, or the top-level units without it, ordered by name then id, with hasChildren for each. page starts at 1; pageSize is 1 to 200 (default 100). A parentId that is not a unit of your company returns 404 not_found; any other query key or value returns 400 invalid_input. Returns {data:[{id, parentId, levelId, name, code, validFrom, archivedAt, hasChildren}], pagination:{page, pageSize, hasMore}}.`,
      },
      {
        "200": {
          description:
            "{data:[{id, parentId, levelId, name, code, validFrom, archivedAt, hasChildren}], pagination:{page, pageSize, hasMore}}.",
        },
      },
      {
        sessionOnly: true,
        params: [
          {
            name: "parentId",
            in: "query",
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
            schema: { type: "integer", minimum: 1, maximum: 200, default: 100 },
          },
        ],
      },
    ),
    post: operation(
      [],
      {
        summary: "Create an organisation unit",
        description: `${orgWriteRule} Send {name, code, levelId} and an optional parentId (null or left out for the top level). ${orgTextRule} An unknown key returns 400 invalid_input. The unit's level must be below its parent's level (409 org_level_order); a parent that is archived or a level that is archived returns 409 org_state_conflict; a code another current unit uses returns 409 org_code_exists; a level or parent that is not in your company returns 404 not_found. Reusing the code of an archived unit under a different parent gives it a new parent, so it needs a company owner (403 org_forbidden). ${orgAudit} Returns ${orgUnitShape}.`,
        requestBody: jsonBody(
          {
            type: "object",
            required: ["name", "code", "levelId"],
            additionalProperties: false,
            properties: {
              name: orgText,
              code: orgText,
              levelId: { type: "string", format: "uuid" },
              parentId: { type: ["string", "null"], format: "uuid" },
            },
          },
          {
            name: "Sample Division",
            code: "SD",
            levelId: "00000000-0000-4000-a000-0000000000a1",
            parentId: "00000000-0000-4000-a000-0000000000b1",
          },
        ),
      },
      { "201": { description: `${orgUnitShape}.` } },
      { sessionOnly: true },
    ),
  };
  paths["/api/v1/org-units/{id}"] = {
    patch: operation(
      [],
      {
        summary: "Rename, move or archive an organisation unit",
        description: `${orgWriteRule} Send exactly one of {name} (rename), {parentId} (move; null for the top level) or {archived: true} (archive); any other shape, including two operations, returns 400 invalid_input. Moving or archiving a unit changes who can see the records under it, so it needs a company owner: a company admin gets 403 org_owner_required. A move under the unit itself or a unit below it returns 409 org_cycle; a parent whose level is not above the unit's returns 409 org_level_order; an archived unit, an archived parent, or archiving a unit that still has current units below it returns 409 org_state_conflict; an unknown unit or parent returns 404 not_found. A move takes the units below it along. ${orgAudit} A move or archive also writes one scope.home_units_changed row. Archiving is permanent. Returns ${orgUnitShape}.`,
        requestBody: jsonBody(
          {
            oneOf: [
              {
                type: "object",
                required: ["name"],
                additionalProperties: false,
                properties: { name: orgText },
              },
              {
                type: "object",
                required: ["parentId"],
                additionalProperties: false,
                properties: {
                  parentId: { type: ["string", "null"], format: "uuid" },
                },
              },
              {
                type: "object",
                required: ["archived"],
                additionalProperties: false,
                properties: { archived: { const: true } },
              },
            ],
          },
          { name: "Sample Division East" },
        ),
      },
      { "200": { description: `${orgUnitShape}.` } },
      { sessionOnly: true, params: [idParameter] },
    ),
  };
  paths["/api/v1/org-units/levels"] = {
    get: operation(
      [],
      {
        summary: "List the organisation levels",
        description: `Session only: any signed-in member of a team in the company reads; Bearer tokens get 403 session_required. Returns every level of your company, top (depth 0) first, archived ones included with archivedAt. Returns {data:[{id, name, depth, archivedAt}]}.`,
      },
      { "200": { description: "{data:[{id, name, depth, archivedAt}]}." } },
      { sessionOnly: true },
    ),
    post: operation(
      [],
      {
        summary: "Create an organisation level",
        description: `${orgWriteRule} Send {name, depth}: depth 0 is the top and 7 the lowest, so a company has at most 8 levels. ${orgTextRule} A depth outside 0 to 7 or an unknown key returns 400 invalid_input; a depth that already has a level returns 409 org_level_exists. ${orgAudit} Returns ${orgLevelShape}.`,
        requestBody: jsonBody(
          {
            type: "object",
            required: ["name", "depth"],
            additionalProperties: false,
            properties: {
              name: orgText,
              depth: { type: "integer", minimum: 0, maximum: 7 },
            },
          },
          { name: "Division", depth: 1 },
        ),
      },
      { "201": { description: `${orgLevelShape}.` } },
      { sessionOnly: true },
    ),
  };
  paths["/api/v1/org-units/levels/{id}"] = {
    patch: operation(
      [],
      {
        summary: "Rename or archive an organisation level",
        description: `${orgWriteRule} Send exactly one of {name} (rename) or {archived: true} (archive); any other shape returns 400 invalid_input. Archiving a level that still has current units returns 409 org_state_conflict, as does changing an archived level; an unknown level returns 404 not_found. An archived level keeps its depth and takes no new units. ${orgAudit} Returns ${orgLevelShape}.`,
        requestBody: jsonBody(
          {
            oneOf: [
              {
                type: "object",
                required: ["name"],
                additionalProperties: false,
                properties: { name: orgText },
              },
              {
                type: "object",
                required: ["archived"],
                additionalProperties: false,
                properties: { archived: { const: true } },
              },
            ],
          },
          { name: "Business Unit" },
        ),
      },
      { "200": { description: `${orgLevelShape}.` } },
      { sessionOnly: true, params: [idParameter] },
    ),
  };
  // Positions and employees (0034): session only, no MCP tool and no API token access (D13).
  const directoryText = { type: "string", minLength: 1, maxLength: 120 };
  const directoryTextRule =
    "Titles, codes, display names and employee numbers are stored as text facts: control, format, bidi and zero-width characters are removed, then they are trimmed and must be 1 to 120 characters.";
  const positionWriteRule =
    "Session only; Bearer tokens, including MCP OAuth tokens, get 403 session_required. Writes need a company owner, or a company admin with the organisation area; anyone else gets 403 org_forbidden.";
  const employeeRule =
    "Session only; Bearer tokens, including MCP OAuth tokens, get 403 session_required. Reading needs a role with directory:read (team owners and admins) and writing directory:write; anyone else gets 403 directory_forbidden.";
  const homeUnitRule =
    "An employee's user link and the positions of a linked employee set that member's home units, so only a company owner links or unlinks a user, creates an employee with a userId or changes a linked employee's positions; anyone else gets 403 directory_owner_required.";
  const contactRule =
    "workEmail and workPhone are left out of every employee for a role whose directory rule is basic; the owner and admin roles are full.";
  const positionShape =
    "{id, orgUnitId, title, code, isManager, jobRoleId, validFrom, archivedAt}";
  const employeeShape =
    "{id, displayName, employeeNumber, status, source, userId, workEmail, workPhone, positions:[{positionId, title, orgUnitId, primary, validFrom}], createdAt, updatedAt, archivedAt}";
  const positionAudit =
    "Each change writes one org activity row to your team with ids and field names only, never a value.";
  const employeeAudit =
    "Each change writes one directory activity row to your team with ids and field names only, never a value; each change that sets home units also writes one scope.home_units_changed row naming the affected user ids.";
  const workEmailSchema = {
    type: ["string", "null"],
    format: "email",
    maxLength: 320,
  };
  const workPhoneSchema = {
    type: ["string", "null"],
    maxLength: 100,
    description: "Trimmed; an empty value is stored as null.",
  };
  const employeeStatus = { type: "string", enum: ["active", "left"] };
  const pageParams = [
    {
      name: "page",
      in: "query",
      schema: { type: "integer", minimum: 1, default: 1 },
    },
    {
      name: "pageSize",
      in: "query",
      schema: { type: "integer", minimum: 1, maximum: 200, default: 100 },
    },
  ];
  const uuidQuery = (name: string) => ({
    name,
    in: "query",
    schema: { type: "string", format: "uuid" },
  });
  paths["/api/v1/positions"] = {
    get: operation(
      [],
      {
        summary: "List the current positions",
        description: `Session only: any signed-in member of a team in the company reads; Bearer tokens get 403 session_required. Returns the current, non-archived positions of your company, or of one unit with unitId, ordered by title then id. jobRoleId is shown only to members of the team that owns the job role and is null otherwise. A unitId that is not a unit of your company returns 404 not_found; any other query key or value returns 400 invalid_input. Returns {data:[${positionShape}], pagination:{page, pageSize, hasMore}}.`,
      },
      {
        "200": {
          description: `{data:[${positionShape}], pagination:{page, pageSize, hasMore}}.`,
        },
      },
      { sessionOnly: true, params: [uuidQuery("unitId"), ...pageParams] },
    ),
    post: operation(
      [],
      {
        summary: "Create a position",
        description: `${positionWriteRule} Send {title, code, orgUnitId} and optionally isManager and jobRoleId. ${directoryTextRule} A jobRoleId must be a job role of your team that is not archived (404 not_found otherwise). A unit that is archived or closed returns 409 directory_state_conflict, and one outside your company 404 not_found; a code another current position uses returns 409 position_code_exists. Reusing the code of an archived position that an employee linked to a user still holds, in another unit, moves that member's home unit, so it needs a company owner (403 directory_owner_required). An unknown key returns 400 invalid_input. ${positionAudit} Returns {data:${positionShape}}.`,
        requestBody: jsonBody(
          {
            type: "object",
            required: ["title", "code", "orgUnitId"],
            additionalProperties: false,
            properties: {
              title: directoryText,
              code: directoryText,
              orgUnitId: { type: "string", format: "uuid" },
              isManager: { type: "boolean" },
              jobRoleId: { type: "string", format: "uuid" },
            },
          },
          {
            title: "Fictional Payroll Lead",
            code: "FIN-PAY-1",
            orgUnitId: "00000000-0000-4000-a000-0000000000b1",
            isManager: true,
          },
        ),
      },
      { "201": { description: `{data:${positionShape}}.` } },
      { sessionOnly: true },
    ),
  };
  paths["/api/v1/positions/{id}"] = {
    patch: operation(
      [],
      {
        summary: "Update, move or archive a position",
        description: `${positionWriteRule} Send exactly one of a facts update with one or more of {title, isManager, jobRoleId} (jobRoleId null clears it), {orgUnitId} (move) or {archived: true} (archive); any other shape, including two operations or a code, returns 400 invalid_input. Moving or archiving a position that an employee linked to a user holds changes that member's home unit, so it needs a company owner: a company admin gets 403 directory_owner_required. An archived position, or a target unit that is archived or closed, returns 409 directory_state_conflict; an unknown position, unit or job role returns 404 not_found. ${positionAudit} A move or archive of a held position also writes one scope.home_units_changed row. Archiving is permanent. Returns {data:${positionShape}}.`,
        requestBody: jsonBody(
          {
            oneOf: [
              {
                type: "object",
                minProperties: 1,
                additionalProperties: false,
                properties: {
                  title: directoryText,
                  isManager: { type: "boolean" },
                  jobRoleId: { type: ["string", "null"], format: "uuid" },
                },
              },
              {
                type: "object",
                required: ["orgUnitId"],
                additionalProperties: false,
                properties: { orgUnitId: { type: "string", format: "uuid" } },
              },
              {
                type: "object",
                required: ["archived"],
                additionalProperties: false,
                properties: { archived: { const: true } },
              },
            ],
          },
          { title: "Fictional Payroll Manager" },
        ),
      },
      { "200": { description: `{data:${positionShape}}.` } },
      { sessionOnly: true, params: [idParameter] },
    ),
  };
  paths["/api/v1/employees"] = {
    get: operation(
      [],
      {
        summary: "List one page of the directory",
        description: `${employeeRule} Returns the current, non-archived employees of your company by display name then id. unitId matches employees holding a current position in that unit or any unit below it, levelId the level of a current position's unit, positionId the holders of that position and status the employee status; filters combine on the same position. A unitId, levelId or positionId outside your company returns 404 not_found; any other query key or value returns 400 invalid_input. ${contactRule} Returns {data:[${employeeShape}], pagination:{page, pageSize, hasMore}}.`,
      },
      {
        "200": {
          description: `{data:[${employeeShape}], pagination:{page, pageSize, hasMore}}.`,
        },
      },
      {
        sessionOnly: true,
        params: [
          uuidQuery("unitId"),
          uuidQuery("levelId"),
          uuidQuery("positionId"),
          { name: "status", in: "query", schema: employeeStatus },
          ...pageParams,
        ],
      },
    ),
    post: operation(
      [],
      {
        summary: "Create an employee",
        description: `${employeeRule} Send {displayName, employeeNumber} and optionally workEmail, workPhone, status (active or left, default active) and userId. Employees hold work contact facts only. ${directoryTextRule} ${homeUnitRule} A number another employee of your company has returns 409 employee_number_exists; a user already linked to an employee returns 409 employee_user_linked; an unknown user returns 404 not_found; an unknown key returns 400 invalid_input. ${contactRule} ${employeeAudit} Returns {data:${employeeShape}}.`,
        requestBody: jsonBody(
          {
            type: "object",
            required: ["displayName", "employeeNumber"],
            additionalProperties: false,
            properties: {
              displayName: directoryText,
              employeeNumber: directoryText,
              workEmail: workEmailSchema,
              workPhone: workPhoneSchema,
              status: employeeStatus,
              userId: { type: "string", minLength: 1, maxLength: 128 },
            },
          },
          {
            displayName: "Fictional Dana Sample",
            employeeNumber: "EMP-0001",
            workEmail: "dana.sample@example.test",
            workPhone: "+971 50 000 0001",
          },
        ),
      },
      { "201": { description: `{data:${employeeShape}}.` } },
      { sessionOnly: true },
    ),
  };
  paths["/api/v1/employees/{id}"] = {
    patch: operation(
      [],
      {
        summary: "Update, link or archive an employee",
        description: `${employeeRule} Send exactly one of a facts update with one or more of {displayName, employeeNumber, workEmail, workPhone, status}, {userId} (link; null unlinks) or {archived: true} (archive); any other shape returns 400 invalid_input. ${homeUnitRule} An archived employee returns 409 directory_state_conflict; a duplicate number 409 employee_number_exists; a user already linked to another employee 409 employee_user_linked; an unknown employee or user 404 not_found. Archiving keeps the user link and position rows. ${contactRule} ${employeeAudit} Returns {data:${employeeShape}}.`,
        requestBody: jsonBody(
          {
            oneOf: [
              {
                type: "object",
                minProperties: 1,
                additionalProperties: false,
                properties: {
                  displayName: directoryText,
                  employeeNumber: directoryText,
                  workEmail: workEmailSchema,
                  workPhone: workPhoneSchema,
                  status: employeeStatus,
                },
              },
              {
                type: "object",
                required: ["userId"],
                additionalProperties: false,
                properties: {
                  userId: {
                    type: ["string", "null"],
                    minLength: 1,
                    maxLength: 128,
                  },
                },
              },
              {
                type: "object",
                required: ["archived"],
                additionalProperties: false,
                properties: { archived: { const: true } },
              },
            ],
          },
          { status: "left" },
        ),
      },
      { "200": { description: `{data:${employeeShape}}.` } },
      { sessionOnly: true, params: [idParameter] },
    ),
  };
  paths["/api/v1/employees/{id}/positions"] = {
    put: operation(
      [],
      {
        summary: "Set an employee's current positions",
        description: `${employeeRule} Send the full set {positions:[{positionId, primary}]}: at most 20 distinct positions, at most one primary (400 invalid_input otherwise). In one transaction, positions left out end now, primary flags change in place and new positions start now; ended rows stay as history. ${homeUnitRule} A position that is archived or closed, or an archived employee, returns 409 directory_state_conflict; an unknown employee or position returns 404 not_found. ${contactRule} Each changed position row writes one directory activity row with ids and field names only, and for a linked employee one scope.home_units_changed row. Returns {data:${employeeShape}}.`,
        requestBody: jsonBody(
          {
            type: "object",
            required: ["positions"],
            additionalProperties: false,
            properties: {
              positions: {
                type: "array",
                maxItems: 20,
                items: {
                  type: "object",
                  required: ["positionId", "primary"],
                  additionalProperties: false,
                  properties: {
                    positionId: { type: "string", format: "uuid" },
                    primary: { type: "boolean" },
                  },
                },
              },
            },
          },
          {
            positions: [
              {
                positionId: "00000000-0000-4000-a000-0000000000c1",
                primary: true,
              },
            ],
          },
        ),
      },
      { "200": { description: `{data:${employeeShape}}.` } },
      { sessionOnly: true, params: [idParameter] },
    ),
  };
  paths["/api/v1/cvs/storage-reconciliation"] = {
    post: operation(
      ["cvs:write"],
      {
        summary: "Clean up the team's private Blob CV storage",
        description:
          "Requires cvs:write and a team owner or admin (others get 403 storage_reconciliation_forbidden). Send no body. Runs one bounded, idempotent sweep of the team's own Blob objects: it expires old reservations; deletes the objects of rejected or abandoned uploads once their last ticket expired at least 10 minutes ago and frees each retained charge only after the object is confirmed missing; and lists the team's CV prefix to delete objects with no upload row once older than any ticket could be, oversized or mismatched objects and objects of rejected rows. Pending unexpired uploads and ready CVs that still match are never deleted. Every deleted object is confirmed missing with a head request before it counts in objectsDeleted; an object still present counts as a failure. A run stops after 50 rows, 100 deletions, 3 list pages or 20 seconds; complete is false when it stopped early, so call it again. A team's cleanup runs at most once per 10 minutes, shared with the automatic sweep after each completed or rejected Blob upload: inside that time it returns 429 STORAGE_RECONCILIATION_COOLDOWN with Retry-After set to the seconds left (1 to 600) and makes no storage call. Returns 409 STORAGE_RECONCILIATION_UNSUPPORTED when the configured storage is S3 and 503 STORAGE_SETUP_REQUIRED when Blob storage is not set up; these and the 403 are checked first and do not start the cooldown. Only counts are returned, never pathnames, file names or IDs.",
      },
      {
        "200": {
          description:
            "{data:{expiredReservations, chargesReleased, objectsChecked, objectsDeleted, failures, complete}}.",
        },
      },
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
          "Session only. Scopes are limited to the creator's role. The creator must have two-step sign-in turned on, otherwise 403 two_step_required. The secret is returned once.",
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
        "Model Context Protocol, Streamable HTTP, stateless with JSON responses: one JSON-RPC 2.0 message per POST, no Mcp-Session-Id and no SSE stream. Accepts an API token (Authorization: Bearer) or an OAuth access token issued for this endpoint; session cookies are never read. Only the tools capability is offered and tools/list shows only the tools your effective scopes allow, grouped by area (candidates, CVs and bulk import, job roles, vacancies, applications, interviews, offers, onboarding, tasks, saved views, collaboration, insights and search, and shared). Candidate tools need candidates:read or candidates:write (CV metadata in get_candidate also needs cvs:read). get_cv_text and get_cv_texts need cvs:read and candidates:read (get_cv_texts by vacancyId also recruitment:read), return text extracted on demand from PDF and DOCX CVs (at most 30,000 characters a CV and 150,000 a call, in a result of at most 1 MiB), store nothing, write one mcp.cv_text_read activity row per CV and return cv_text_access_off when the team turned off its Connected AI apps can read CV contents setting. upload_cv, create_cv_upload_link and complete_cv_upload need cvs:write (upload_cv with newCandidate also candidates:write); start_bulk_import, add_bulk_import_item, list_bulk_import_items and open_bulk_import_page need cvs:write and candidates:write. cvs:write is offered to OAuth clients; imports:write never is. A request body is at most 65,536 bytes, except a tools/call of upload_cv or add_bulk_import_item, which may send a base64 file of at most 3 MiB in a body of at most 4,400,000 bytes; larger bodies return 413 body_too_large. The other read tools need recruitment:read, and get_overview and get_analytics also need candidates:read; every other create, update, move, archive and restore tool needs recruitment:write. Conditional scopes: bulk_create_applications also needs candidates:read; add_comment on a candidate also needs candidates:read and candidates:write; archive_record and restore_record on a candidate also need candidates:write; update_task with customValues also needs recruitment:read; mark_notifications_read needs recruitment:read and recruitment:write. Shortlists, follow-up statuses, private notes, saved views and reminder read markers are the caller's own. A viewer never gets a write tool. Creates require an idempotencyKey argument; changes to an existing record require its version and return a version_conflict tool error when it changed. Nothing is permanently deleted: archive_record and restore_record are reversible. Tool results are untrusted record data labelled untrustedData: true. Every tools/call is audited as an mcp-tool activity row without its arguments. See docs/mcp.md for the per-tool table with the scope of each tool.",
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
          "Session only, called by the consent page at /oauth/authorize. X-Team-Id selects the team. Every authorize rule is checked again; approved scopes must be requested, allowed by your current role and offered to MCP clients. Approve needs two-step sign-in turned on (403 two_step_required otherwise), creates a grant listed in Settings → API tokens and returns the client redirect with a one-time code; deny returns error=access_denied and writes nothing. Both redirects include iss, the authorization server issuer (RFC 9207).",
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
      ["cvs:read", "candidates:read"],
      {
        summary: "List private CV references",
        description:
          "Requires cvs:read and candidates:read (without candidates:read, 403 scope_required before any storage call); returns {data,pagination} with the full total. Each reference has downloadProtocol: s3-url-v1 (use /download), blob-chunks-v1 (use /manifest and /chunks) or null when not ready. Storage keys, object versions, digests and store ids are not exposed.",
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
          "Requires cvs:write. Clients must switch on upload.protocol and never infer it from a hostname: s3-form-v1 is a multipart form POST of the fields plus file; blob-put-v1 is a PUT of the file with exactly the returned headers. Send no credentials, cookies or X-Team-Id to the upload URL, then complete the upload. The upload URL is a secret capability and must not be logged. A ready replay returns upload:null. Never send CV bytes through the Vercel JSON API. A Blob reservation lasts 15 minutes and each ticket at most 300 seconds; it gets at most 5 tickets in all, the first and every replay included, and then returns 409 CV_UPLOAD_TICKET_LIMIT until the reservation expires, so select the file again after that. An S3 reservation lasts 60 minutes. When the team's CV upload rate limit is on, a new reservation beyond its requests per minute returns 429 CV_UPLOAD_RATE_LIMITED with Retry-After: 60; a replay of an existing reservation is not refused. A reservation over the team's storage limit or the store-wide budget, counting pending uploads and files waiting for cleanup, returns 409 STORAGE_QUOTA_EXCEEDED. These are application limits, not hard provider caps. Returns 503 STORAGE_SETUP_REQUIRED when CV storage is not set up.",
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
          "Requires cvs:write. Idempotent. Reads the stored object itself and returns a ready reference only after size, type and format checks plus an S3 version, or, for Blob, a SHA-256 of the exact reserved size computed by the server. Any request body is ignored; no client hash, size or type is accepted. When this call settles a Blob upload ready or rejected, it also starts the team's cooldown-gated storage cleanup (see /api/v1/cvs/storage-reconciliation), which never changes this response.",
      },
      { "200": { description: "{data: CV reference}." } },
      { params: [idParameter] },
    ),
  };
  paths["/api/v1/cvs/{id}/download"] = {
    get: operation(
      ["cvs:read", "candidates:read"],
      {
        summary: "Get a short-lived private CV download",
        description:
          "Requires cvs:read and candidates:read; without candidates:read it returns 403 scope_required before any storage call. S3 references only (downloadProtocol s3-url-v1); Blob references return 409 CV_DOWNLOAD_PROTOCOL_MISMATCH. Returns {url,expiresAt}; link is a bearer credential and must not be logged.",
      },
      { "200": { description: "{url, expiresAt}." } },
      { params: [idParameter] },
    ),
  };
  paths["/api/v1/cvs/{id}/manifest"] = {
    get: operation(
      ["cvs:read", "candidates:read"],
      {
        summary: "Read a Blob CV download manifest",
        description:
          "Requires cvs:read and candidates:read; without candidates:read it returns 403 scope_required before any storage call. For downloadProtocol blob-chunks-v1 only; S3 references return 409 CV_DOWNLOAD_PROTOCOL_MISMATCH. Makes no storage call and returns no provider URL or pathname. The manifest grants nothing by itself: every chunk request is authorized again.",
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
      ["cvs:read", "candidates:read"],
      {
        summary: "Read one verified Blob CV chunk",
        description:
          "Requires cvs:read and candidates:read; without candidates:read it returns 403 scope_required before any storage call. The bytes are always sent as application/octet-stream with Content-Disposition: attachment and nosniff, never as the stored type. Reauthorizes the caller, reads the whole stored object and releases the 4 MiB slice only after its SHA-256 matches the validated digest. Send exactly one index parameter. Replaced, missing or altered objects return 409 CV_INTEGRITY_FAILED with no file bytes; S3 references return 409 CV_DOWNLOAD_PROTOCOL_MISMATCH; storage timeouts return 503. Verify the final SHA-256 after assembling every chunk.",
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
  paths["/api/version"] = {
    get: {
      summary: "Read the application version and build",
      security: [],
      "x-required-scopes": [],
      responses: {
        "200": {
          description:
            "Semantic version, UTC build number, short commit and environment.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["version", "build", "commit", "environment"],
                additionalProperties: false,
                properties: {
                  version: { type: "string", example: "1.0.0" },
                  build: { type: "string", example: "20261108.1430" },
                  commit: { type: "string", example: "f09caa4" },
                  environment: { type: "string", example: "Preview" },
                },
              },
            },
          },
        },
      },
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
