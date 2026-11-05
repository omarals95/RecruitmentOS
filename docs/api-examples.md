# API access for AI clients and integrations

Create a personal access token under **Settings → API tokens** while signed in. Select the smallest set of scopes required. The token is tied to your user and the selected team. It is displayed once and is never returned by the token list. Store it in your integration's secret store, never in prompts, browser bundles, source control or screenshots.

The token's permissions are checked against your current verified account and live team membership on every request. Removing a member, reducing their role, revoking the token or reaching its expiry removes the corresponding access. Tokens cannot manage users, teams, invitations, roles or other tokens. API token traffic is limited to 60 authenticated requests per minute per token. Retry a 429 response with backoff; do not repeat a failed create without reusing its idempotency key.

Tokens expire after 30 days by default; a shorter or longer duration up to 365 days can be chosen. Owners and admins can revoke team tokens; everyone can revoke their own. Revocation does not delete records already created by that token. Change history identifies API token actions without recording the secret.

| Scope               | Access                                                                   |
| ------------------- | ------------------------------------------------------------------------ |
| `candidates:read`   | Read the candidate directory and candidate facts                         |
| `candidates:write`  | Create or update candidates                                              |
| `recruitment:read`  | Read vacancies, applications, tasks and recruitment operations           |
| `recruitment:write` | Create or update recruitment records                                     |
| `cvs:read`          | List CV metadata and request temporary private download links            |
| `cvs:write`         | Reserve, upload and complete a CV upload                                 |
| `imports:write`     | Preserve legacy import identifiers and source metadata; owner/admin only |

Write scopes do not implicitly grant the corresponding read scope. Choose both when an integration needs to read its results. A viewer can create a read-only token. A recruiter cannot request import privileges. AI integrations are explicit clients: RecruitmentOS does not send candidate records to an AI provider automatically.

AI assistants that speak the Model Context Protocol, such as Claude Code and Claude.ai, can use `/api/mcp` instead of these REST calls. See [mcp.md](mcp.md) for its tools, scopes and setup.

## Read candidates

Set `RECRUITMENTOS_URL` to the deployed HTTPS origin and `RECRUITMENTOS_TOKEN` through your shell or integration's secret store. The commands below contain no credentials or real candidate data.

```bash
curl --fail-with-body "$RECRUITMENTOS_URL/api/v1/candidates?page=1&pageSize=25&search=engineer" \
  -H "Authorization: Bearer $RECRUITMENTOS_TOKEN"
```

The response contains `data` and `pagination`. Results are limited to the token's team. Supplying another team's `X-Team-Id` is rejected.

## Create a candidate safely

Use one stable, unique `Idempotency-Key` for one logical create. A retry with the same key and body returns the original result; a changed body returns a conflict. Do not infer missing personal facts.

Keys are retained for 7 days. A key is never reused for different content: a changed body under an expired key still returns 409 `idempotency_mismatch`. After expiry, a retry with the same key and body never creates a second record. It returns 201 with the original record's current state, including an archived record; a token without the resource's read scope receives the original response instead. If that record is no longer available, it returns 409 `idempotency_expired` and creates nothing; search for the record (for example by email or legacy ID) before creating it again with a new key.

```bash
curl --fail-with-body "$RECRUITMENTOS_URL/api/v1/candidates" \
  -H "Authorization: Bearer $RECRUITMENTOS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: external-record-12345" \
  --data '{"data":{"name":"Fictional Example","email":"fictional@example.com","skills":["TypeScript"],"folderCategories":["Engineering"]}}'
```

For updates, send the record's latest `version` in `PATCH /api/v1/candidates/{id}`. A 409 means someone changed the record; reread and reconcile rather than overwriting their changes.

## Assign candidates to a vacancy

`POST /api/v1/applications/bulk` assigns up to 500 active candidates to one active vacancy. Requires `recruitment:write` and `candidates:read`. Validation is all-or-nothing. Send an optional `Idempotency-Key`; a retry with the same key and body replays the stored response, and a changed body returns 409 `idempotency_mismatch`.

```bash
curl --fail-with-body "$RECRUITMENTOS_URL/api/v1/applications/bulk" \
  -H "Authorization: Bearer $RECRUITMENTOS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: assign-fictional-batch-1" \
  --data '{"candidateIds":["3f6c1d2e-8a4b-4c7d-9e1f-2a3b4c5d6e7f"],"vacancyId":"7b2e9c41-5d3a-4f8e-a6b1-0c9d8e7f6a5b","stage":"Sourced"}'
```

The response is `{data, existing, created, skipped}`. `data` lists the applications this request created and `created` is its length. `existing` lists the active applications that already existed for the vacancy and requested candidates; `skipped` equals its length. Without `recruitment:read`, each `existing` entry contains only `id`, `kind`, `candidateId` and `vacancyId`, never another user's application details. A pair that already has an active application is never duplicated, so a retry after an uncertain result, with or without the key, reports the earlier applications in `existing`.

## Upload a CV

CV uploads bypass Vercel's small request-body limit by uploading directly to the configured private storage.

1. `POST /api/v1/candidates/{candidateId}/cvs/uploads` with JSON containing `originalName`, `mimeType`, `sizeBytes` and a stable `clientUploadId` UUID. Requires `cvs:write`. A ready replay returns `upload: null`.
2. Switch on `upload.protocol`; never guess it from the URL's hostname, and reject any value you do not know. Send no RecruitmentOS token, cookie or `X-Team-Id` to `upload.url`, and do not log it: it is a secret capability.
   - `s3-form-v1` (`method: "POST"`): send a multipart form to `upload.url` with every value in `upload.fields` unchanged, followed by the file part.
   - `blob-put-v1` (`method: "PUT"`): send the file bytes as the body to `upload.url` with exactly the headers in `upload.headers` (`content-type`). Vercel Blob is currently disabled; the reservation returns 503 `STORAGE_SETUP_REQUIRED` for it.

   Both variants carry `expiresAt` and `maxBytes`, which equals the reserved `sizeBytes`.

3. `POST /api/v1/cvs/uploads/{data.id}/complete` with the RecruitmentOS token and no body. The server reads the stored object itself and checks its size, type and format, then pins the S3 version or records the SHA-256 of the Blob bytes before marking it ready. A client-supplied hash is never used.
4. Read metadata through `GET /api/v1/candidates/{candidateId}/cvs?page=1&pageSize=50`. The response includes `data` and `pagination` with the full candidate file total; page size is capped at 100. Each ready reference has a `downloadProtocol`. Requires `cvs:read`.
   - `s3-url-v1`: request a short-lived attachment URL through `GET /api/v1/cvs/{cvId}/download`.
   - `blob-chunks-v1`: read `GET /api/v1/cvs/{cvId}/manifest` for `{uploadId, originalName, contentType, sizeBytes, sha256, chunkSize, chunkCount}`, then fetch `GET /api/v1/cvs/{cvId}/chunks?index=0` up to `chunkCount - 1`, one at a time. Each 200 response is the raw slice with `X-CV-Upload-Id`, `X-CV-Chunk-Index`, `X-CV-Chunk-Offset`, `X-CV-Size-Bytes` and `X-CV-SHA256` headers; check them against the manifest, join the slices and verify the final SHA-256 before using the file. A 409 `CV_INTEGRITY_FAILED` means the stored object no longer matches; discard every chunk.
   - The wrong route for a reference returns 409 `CV_DOWNLOAD_PROTOCOL_MISMATCH`.

Uploads are limited to 10 MiB and team storage quotas. The upload ticket expires within five minutes. Reuse `clientUploadId` when recovering an uncertain reservation result. File format validation is not malware scanning; integrate a separate scanning/quarantine workflow before accepting untrusted public intake at scale.

## Errors

The API uses structured errors: `{"error":{"code","message","correlationId"}}`. 401 indicates an invalid session or token, 403 an unavailable scope or membership, 409 a version/idempotency/uniqueness conflict, 413 an oversized body and 429 a rate limit. A 429 response carries `Retry-After` with the number of seconds to wait before retrying. 5xx failures may have an uncertain result; check by idempotency key or legacy ID before attempting another create. Avoid logging response payloads containing candidate personal information.

Every error response has a fresh `error.correlationId` and an identical `X-Correlation-Id` header. Quote it when reporting a failure: for a 500 the server logs that ID with a safe error category, never the request or record contents.

See `/api/openapi.json` for endpoint documentation. Each operation lists the token scopes it needs in `x-required-scopes`; operations marked `x-session-only` reject API tokens with 403 `session_required`. Auth and team management use the interactive sign-in session, never a personal API token.

`POST /api/v1/notifications` marks genuine reminder keys read for the token's user. Token clients need both `recruitment:read` and `recruitment:write`; a read-only token cannot change reminder state.

Authentication UI uses [Better Auth organization APIs](https://better-auth.com/docs/plugins/organization), [session controls](https://better-auth.com/docs/concepts/session-management) and [profile/password controls](https://better-auth.com/docs/concepts/users-accounts).
