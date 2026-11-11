# API access for AI clients and integrations

Create a personal access token under **Settings → API tokens** while signed in with two-step sign-in turned on; without it the page links to the setup and `POST /api/settings/tokens` answers 403 `two_step_required`. Select the smallest set of scopes required. The token is tied to your user and the selected team. It is displayed once and is never returned by the token list. Store it in your integration's secret store, never in prompts, browser bundles, source control or screenshots.

The token's permissions are checked against your current verified account and live team membership on every request. Removing a member, reducing their role, revoking the token or reaching its expiry removes the corresponding access. Tokens cannot manage users, teams, invitations, roles or other tokens. API token traffic is limited to 60 authenticated requests per minute per token. Retry a 429 response with backoff; do not repeat a failed create without reusing its idempotency key.

Tokens expire after 30 days by default; a shorter or longer duration up to 365 days can be chosen. Owners and admins can revoke team tokens; everyone can revoke their own. Revocation does not delete records already created by that token. Change history identifies API token actions without recording the secret.

| Scope               | Access                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `candidates:read`   | Read the candidate directory and candidate facts                                            |
| `candidates:write`  | Create or update candidates                                                                 |
| `recruitment:read`  | Read vacancies, applications, tasks and recruitment operations                              |
| `recruitment:write` | Create or update recruitment records                                                        |
| `cvs:read`          | List CV metadata and request temporary private download links; also needs `candidates:read` |
| `cvs:write`         | Reserve, upload and complete a CV upload                                                    |
| `imports:write`     | Preserve legacy import identifiers and source metadata; owner/admin only                    |

The scopes `directory:read`, `directory:write`, `plans:read` and `plans:write` are owner/admin membership ceilings for the company directory, salary brackets and the coming recruitment plan: they cannot be chosen for API tokens (a request with one answers 400 `invalid_token_request`, as for an unknown scope) or offered to MCP clients. The plan scopes open salary brackets only in a browser session that also holds the Plan & pay access grant (see [Salary brackets](#salary-brackets)).

Write scopes do not implicitly grant the corresponding read scope. Every CV read (`/api/v1/candidates/{id}/cvs`, `/download`, `/manifest`, `/chunks`) needs `candidates:read` as well as `cvs:read`, and returns 403 `scope_required` without it. API tokens created with `cvs:read` but without `candidates:read` get 403 `scope_required` on every CV read and must be replaced by a token with both. A comment on a candidate is candidate data: without `candidates:read`, `GET /api/v1/comments` leaves it out of the list and its total, `GET /api/v1/comments/{id}` answers 404, and `POST /api/v1/comments` with a candidate `parentRecordId` answers 400 `invalid_reference`, as for a missing record; with `candidates:read` but no `candidates:write`, that `POST` answers 403. Choose both when an integration needs to read its results. A viewer can create a read-only token. A recruiter cannot request import privileges. AI integrations are explicit clients: RecruitmentOS does not send candidate records to an AI provider automatically.

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

## Create a vacancy

`POST /api/v1/vacancies` needs `recruitment:write`. `status` defaults to `Draft`; send `Open` to open the vacancy at once. `jobRoleId` is optional and must name an active job role in the team. `orgUnitId` is optional too: a current, non-archived org unit of the company (see [Organisation levels and units](#organisation-levels-and-units)), whose applications, interviews, offers, onboarding, checklist items and comments then follow it. Any other id answers 400 `invalid_reference` with "orgUnitId does not reference a current unit of this company.", and every resource but vacancies refuses the key with 400 `invalid_input`.

```bash
curl --fail-with-body "$RECRUITMENTOS_URL/api/v1/vacancies" \
  -H "Authorization: Bearer $RECRUITMENTOS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: vacancy-fictional-payroll-1" \
  --data '{"jobRoleId":"5a1d7e3c-2b9f-4c6a-8d0e-1f2a3b4c5d6e","orgUnitId":"0b6f2c1e-7a4d-4e9b-9c3a-2d5e8f1a6b7c","data":{"title":"Fictional Payroll Analyst","department":"Finance","location":"Dubai","openings":2,"status":"Open"}}'
```

A vacancy with a unit comes back with `orgUnitId` and `orgUnitLabel`, the unit as "Name (CODE)"; a vacancy without one, and every other record, has neither key. Exports, search results and MCP tool results never carry them. Shortened:

```json
{
  "data": {
    "id": "7b2e9c41-5d3a-4f8e-a6b1-0c9d8e7f6a5b",
    "kind": "vacancy",
    "orgUnitId": "0b6f2c1e-7a4d-4e9b-9c3a-2d5e8f1a6b7c",
    "orgUnitLabel": "Sample Finance (FIN)"
  }
}
```

`PATCH /api/v1/vacancies/{id}` takes `orgUnitId` the same way with the vacancy's `version`; `"orgUnitId": null` removes the unit.

`data.jobTitleKey` is optional: the key of a title of the company's published [job architecture](#job-architecture), such as `"jobTitleKey":"payroll-lead"`. A key that is not one of its titles, or any key before a version is published, answers 400 `invalid_reference` with "jobTitleKey is not a job title of the published job architecture." and nothing is stored. An update checks the key only when it changes, so a vacancy keeps a title a later version removed until you change it; the key can be changed but not cleared. A vacancy without a title has no `jobTitleKey` in `data`. The MCP tools `create_vacancy` and `update_vacancy` take the same key, and `get_vacancy` shows it (`null` when not set).

## Add a candidate to a vacancy

`POST /api/v1/applications` needs `recruitment:write`. A candidate has at most one active application per vacancy; a second one returns 409 `duplicate_record`. `stage` defaults to `Sourced`.

```bash
curl --fail-with-body "$RECRUITMENTOS_URL/api/v1/applications" \
  -H "Authorization: Bearer $RECRUITMENTOS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: application-fictional-1" \
  --data '{"candidateId":"3f6c1d2e-8a4b-4c7d-9e1f-2a3b4c5d6e7f","vacancyId":"7b2e9c41-5d3a-4f8e-a6b1-0c9d8e7f6a5b","data":{"stage":"Screening","source":"Fictional referral"}}'
```

## Schedule an interview

`POST /api/v1/interviews` needs `recruitment:write`. `startAt` is ISO 8601 with an offset; it is stored in UTC and shown in Asia/Dubai. A `meetingUrl` must be http or https and is never opened by RecruitmentOS.

```bash
curl --fail-with-body "$RECRUITMENTOS_URL/api/v1/interviews" \
  -H "Authorization: Bearer $RECRUITMENTOS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: interview-fictional-1" \
  --data '{"applicationId":"9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d","data":{"title":"Fictional first interview","startAt":"2026-11-12T14:30:00+04:00","minutes":45,"interviewer":"Fictional Interviewer","meetingUrl":"https://meet.example.com/fictional-room"}}'
```

## Move an application to another stage

`PATCH /api/v1/applications/{id}` needs `recruitment:write` and the application's latest `version`. A 409 `version_conflict` means it changed since you read it.

```bash
curl --fail-with-body -X PATCH "$RECRUITMENTOS_URL/api/v1/applications/9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" \
  -H "Authorization: Bearer $RECRUITMENTOS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"version":3,"data":{"stage":"Interview"}}'
```

Over REST a reason for the move is a separate comment: `POST /api/v1/comments` with `{"parentRecordId":"<application id>","data":{"body":"Fictional reason"}}`. The MCP tool `move_application_stage` writes the stage and its reason comment in one step.

## Create an offer

`POST /api/v1/offers` needs `recruitment:write`. `amount` is a decimal string, never a number; `currency` defaults to `AED` and `status` to `Draft`. Change the status later with `PATCH /api/v1/offers/{id}` and the offer's `version`.

```bash
curl --fail-with-body "$RECRUITMENTOS_URL/api/v1/offers" \
  -H "Authorization: Bearer $RECRUITMENTOS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: offer-fictional-1" \
  --data '{"applicationId":"9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d","data":{"title":"Fictional Payroll Analyst offer","amount":"15000.00","currency":"AED","payPeriod":"Monthly","expiryDate":"2026-12-01"}}'
```

## Create and assign a team task

`POST /api/v1/tasks` needs `recruitment:write`. `data.assigneeIds` takes up to 10 distinct user IDs of members of the token's team; they are stored as assignments, not in the task's data, and every task response returns them sorted (`[]` for none). `parentRecordId` links one job role, vacancy, bucket, task field or other task you may see. The free-text `data.owner` label is separate from the assignees.

```bash
curl --fail-with-body "$RECRUITMENTOS_URL/api/v1/tasks" \
  -H "Authorization: Bearer $RECRUITMENTOS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: task-fictional-1" \
  --data '{"bucketId":"4a1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","parentRecordId":"7b2e9c41-5d3a-4f8e-a6b1-0c9d8e7f6a5b","data":{"title":"Fictional reference check","priority":"High","assigneeIds":["fictional-user-1","fictional-user-2"]}}'
```

The response carries `data.assigneeIds` and, for a linked record you may see, `parentKind` (here `vacancy`) and `parentLabel` (its title, with " (archived)" when archived). Change the assignees with `PATCH /api/v1/tasks/{id}`, the task's `version` and the full new list, for example `{"version":1,"data":{"assigneeIds":["fictional-user-2"]}}`: only the members added or removed change, and a `PATCH` without `assigneeIds` leaves them as they are. `{"version":2,"parentRecordId":null}` removes the link.

List the tasks assigned to you with `GET /api/v1/tasks?assignedToMe=true` (`false` lists the others); `pagination.total` counts only the matching tasks. The filter is list-only: `GET /api/v1/tasks/export?assignedToMe=true` and any other value answer 400 `invalid_query`.

Refusals roll back the whole write:

| Response                        | When                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400 `invalid_input`             | more than 10 assignees, or the same user ID twice                                                                                                                                                         |
| 400 `invalid_assignee`          | a user ID that is not a member of the team, including removing a former member                                                                                                                            |
| 403 `self_assignment_forbidden` | a member whose role shows only some tasks adds or removes themselves                                                                                                                                      |
| 403 `forbidden`                 | the assignees of the task cannot be changed                                                                                                                                                               |
| 400 `invalid_reference`         | a link to a saved view, comment, candidate, application, interview, offer, onboarding or checklist item, to the task itself, or to a record that is missing, in another team or outside your record scope |

## Custom values on records

Candidates, job roles, vacancies, applications, interviews, offers, onboarding records and checklist items take an optional `data.customValues` on `POST /api/v1/{resource}` and `PATCH /api/v1/{resource}/{id}`: a map from a field definition ID (a UUID) to a string of at most 4000 characters, a finite number, `true`, `false` or `null`. A key that is not a UUID, an object or array value, a longer string or a non-finite number answers 400 `invalid_input`, before any check below. On `PATCH`, a sent `customValues` replaces the whole stored map, and a `PATCH` without it leaves the map as it is.

Each write is checked against the kind's current published kind schema, which the record then pins:

| Response                    | When                                                                                                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400 `unknown_custom_field`  | an added or changed key that is not a custom field of the kind schema ("A custom field is not available in this team."); on the built-in default schemas, which hold no custom fields, every key                                                                         |
| 400 `invalid_custom_value`  | an added or changed value that does not fit its field's type, bounds or options ("Invalid value for {field label}.")                                                                                                                                                     |
| 400 `archived_custom_field` | a value of an archived field is added or changed, or removed from a record that holds it; an import (`legacyId` or `importMeta`) may change or remove it                                                                                                                 |
| 400 `required_custom_field` | a create without a value for a custom field required on the create screen, or an edit that empties a filled one required on the edit screen ("A valid value for {field label} is required.")                                                                             |
| 400 `invalid_input`         | the same mandatory rules for a system field the kind schema makes required ("{key}: {field label} is required.")                                                                                                                                                         |
| 400 `invalid_reference`     | a person value that is not the user ID of a member of the record's team ("{field label} must be a member of this team.")                                                                                                                                                 |
| 400 `invalid_reference`     | an org unit value that is not a current unit of your company, open and not archived ("{field label} does not reference a current unit of this company.")                                                                                                                 |
| 400 `invalid_reference`     | a lookup value that is not a record of the field's target kind in your team and record scope ("{field label} does not reference the expected record in this team."), the same answer for a missing record, another kind, another team's record or one outside your scope |
| 400 `archived_reference`    | a lookup value naming an archived record ("{field label} references an archived record."); an import of an archived record may name one                                                                                                                                  |

A value carried over unchanged from the stored record is not checked again, so a field removed or tightened later, or made mandatory later and left empty, never blocks an unrelated edit. `null` and `""` are empty values of any field.

Person, org unit and lookup values are bare IDs: a person value is a user ID, an org unit value the unit's ID and a lookup value the record's ID. They are checked only when added or changed, so a person who later leaves the team, or a unit or record archived later, never blocks an unrelated edit. Responses return the stored ID only, never a name or label.

```bash
curl --fail-with-body -X PATCH "$RECRUITMENTOS_URL/api/v1/candidates/$CANDIDATE_ID" \
  -H "Authorization: Bearer $RECRUITMENTOS_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"version":3,"data":{"customValues":{"2b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e":"fictional-user-id","3c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f":"6d9e0f1a-2b3c-4d4e-9f5a-6b7c8d9e0f1a","4d9e0f1a-2b3c-4d4e-8f5a-6b7c8d9e0f1a":"7e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b"}}}'
```

The example names three fictional fields of a published candidate kind schema: `2b7c8d9e-…` a person field "Sponsor" holding a member's user ID, `3c8d9e0f-…` an org unit field "Home unit" holding a current unit's ID and `4d9e0f1a-…` a lookup field "Linked vacancy" whose target kind is `vacancy`, holding a vacancy's ID.

```bash
curl --fail-with-body "$RECRUITMENTOS_URL/api/v1/vacancies" \
  -H "Authorization: Bearer $RECRUITMENTOS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: vacancy-custom-fictional-1" \
  --data '{"data":{"title":"Fictional Data Analyst","customValues":{"9c1e2d3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f":"Fictional cost centre 42"}}}'
```

The example names `9c1e2d3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f`, a fictional short-text field "Cost centre" of a published vacancy kind schema; on the built-in default schemas it answers 400 `unknown_custom_field`. No route publishes kind schemas yet. The values come back in `data.customValues` only on records that have them; existing records are unchanged and never gain the key. The values are not shown in the app, exports or MCP, and OpenAPI does not list them. A role that hides any field of a kind also hides that kind's `customValues` from its members, in responses and search, unless it names its own rule for `customValues`. Tasks keep their team task fields: a key that is one of the team's task fields is checked as before, every value on each write, and any other key by the rules above against the task kind schema. No response includes the kind schema version a record was last saved against.

## Upload a CV

CV uploads bypass Vercel's small request-body limit by uploading directly to the configured private storage.

1. `POST /api/v1/candidates/{candidateId}/cvs/uploads` with JSON containing `originalName`, `mimeType`, `sizeBytes` and a stable `clientUploadId` UUID. Requires `cvs:write`. A ready replay returns `upload: null`.
2. Switch on `upload.protocol`; never guess it from the URL's hostname, and reject any value you do not know. Send no RecruitmentOS token, cookie or `X-Team-Id` to `upload.url`, and do not log it: it is a secret capability.
   - `s3-form-v1` (`method: "POST"`): send a multipart form to `upload.url` with every value in `upload.fields` unchanged, followed by the file part.
   - `blob-put-v1` (`method: "PUT"`): send the file bytes as the body to `upload.url` with exactly the headers in `upload.headers` (`content-type`). This is the hosted protocol: private Vercel Blob. Send the whole file in one PUT; multipart is not supported, and an object whose size or type differs from the reservation is rejected at completion.

   Both variants carry `expiresAt` and `maxBytes`, which equals the reserved `sizeBytes`.

3. `POST /api/v1/cvs/uploads/{data.id}/complete` with the RecruitmentOS token and no body. The server reads the stored object itself and checks its size, type and format, then pins the S3 version or records the SHA-256 of the Blob bytes before marking it ready. A client-supplied hash is never used.
4. Read metadata through `GET /api/v1/candidates/{candidateId}/cvs?page=1&pageSize=50`. The response includes `data` and `pagination` with the full candidate file total; page size is capped at 100. Each ready reference has a `downloadProtocol`. Requires `cvs:read` and `candidates:read`.
   - `s3-url-v1`: request a short-lived attachment URL through `GET /api/v1/cvs/{cvId}/download`.
   - `blob-chunks-v1`: read `GET /api/v1/cvs/{cvId}/manifest` for `{uploadId, originalName, contentType, sizeBytes, sha256, chunkSize, chunkCount}`, then fetch `GET /api/v1/cvs/{cvId}/chunks?index=0` up to `chunkCount - 1`, one at a time. Each 200 response is the raw slice with `X-CV-Upload-Id`, `X-CV-Chunk-Index`, `X-CV-Chunk-Offset`, `X-CV-Size-Bytes` and `X-CV-SHA256` headers; check them against the manifest, join the slices and verify the final SHA-256 before using the file. A 409 `CV_INTEGRITY_FAILED` means the stored object no longer matches; discard every chunk.
   - The wrong route for a reference returns 409 `CV_DOWNLOAD_PROTOCOL_MISMATCH`.

Uploads are limited to 10 MiB, the team's storage limit and the store-wide budget, all application limits counting pending uploads and files waiting for cleanup; over them the reservation returns 409 `STORAGE_QUOTA_EXCEEDED`. When the team's CV upload rate limit is on, a new reservation beyond its requests per minute returns 429 `CV_UPLOAD_RATE_LIMITED` with `Retry-After: 60`; a replay with the same `clientUploadId` is not refused. The upload ticket expires within five minutes; a Blob reservation lasts 15 minutes and an S3 one 60. Reuse `clientUploadId` when recovering an uncertain reservation result; a Blob reservation gives at most 5 tickets in all, after which a replay returns 409 `CV_UPLOAD_TICKET_LIMIT` until the reservation expires and the file must be selected again. File format validation is not malware scanning; under DEC-07 CVs are downloaded only as attachments and scanned by the user's endpoint antivirus ([security.md](security.md#cv-handling)).

## Clean up CV storage

Owners and admins can run one bounded cleanup of the team's private Blob CV storage with a token holding `cvs:write` (or a session):

```bash
curl -sS -X POST "$RECRUITMENTOS_URL/api/v1/cvs/storage-reconciliation" \
  -H "Authorization: Bearer $RECRUITMENTOS_TOKEN"
```

Send no body. It expires old reservations, deletes the objects of rejected or abandoned uploads once their last ticket expired at least 10 minutes ago, frees each retained charge only after the object is confirmed missing, and deletes stray or mismatched objects under the team's own CV prefix; pending uploads and matching ready CVs are never touched. The response holds counts only: `{"data":{"expiredReservations","chargesReleased","objectsChecked","objectsDeleted","failures","complete"}}`. Call it again while `complete` is `false`. A team's cleanup runs at most once per 10 minutes, shared with the automatic cleanup after each completed or rejected Blob upload: inside that time it returns 429 `STORAGE_RECONCILIATION_COOLDOWN` with `Retry-After` set to the seconds left. Other roles get 403 `storage_reconciliation_forbidden`; with S3 storage it returns 409 `STORAGE_RECONCILIATION_UNSUPPORTED`, and with Blob not set up 503 `STORAGE_SETUP_REQUIRED`.

## Organisation levels and units

The organisation routes under `/api/v1/org-units` need a signed-in browser session. They are not available to API tokens or MCP: a Bearer token, including an MCP OAuth token, gets 403 `session_required` on every method, and there is no MCP tool. Any signed-in member of a team in the company can read them. Creating and renaming levels and units needs a company owner, or a company admin with the organisation area; anyone else gets 403 `org_forbidden`. Moving or archiving a unit needs a company owner, because it changes who can see the records under that unit in later releases; a company admin gets 403 `org_owner_required`. The examples use fictional names and ids.

Create the levels, top first. `depth` is 0 for the top and at most 7, so a company has at most 8 levels:

```http
POST /api/v1/org-units/levels
Content-Type: application/json

{"name":"Company","depth":0}
```

```json
{
  "data": {
    "id": "00000000-0000-4000-a000-0000000000a0",
    "name": "Company",
    "depth": 0,
    "archivedAt": null
  }
}
```

Create a unit on a level, at the top or under a parent on a higher level. Leave out `parentId`, or send `null`, for a top-level unit:

```http
POST /api/v1/org-units
Content-Type: application/json

{"name":"Fictional Holdings","code":"FH","levelId":"00000000-0000-4000-a000-0000000000a0"}
```

```http
POST /api/v1/org-units
Content-Type: application/json

{"name":"Sample Division","code":"SD","levelId":"00000000-0000-4000-a000-0000000000a1","parentId":"00000000-0000-4000-a000-0000000000b0"}
```

Each returns 201 with `{"data":{"id","parentId","levelId","name","code","validFrom","archivedAt","hasChildren"}}`. Names and codes are stored as text facts: control, format, bidi and zero-width characters are removed, then they are trimmed and must be 1 to 120 characters. A code is unique among the company's current units.

Read one level of the chart at a time: `GET /api/v1/org-units` lists the top-level units, and `GET /api/v1/org-units?parentId=00000000-0000-4000-a000-0000000000b0&page=1&pageSize=100` lists that unit's current children, ordered by name, with `hasChildren` on each and `{"pagination":{"page","pageSize","hasMore"}}` (`pageSize` 1 to 200, default 100). `GET /api/v1/org-units/levels` lists every level, archived ones included.

Change a unit with exactly one operation per request:

```http
PATCH /api/v1/org-units/00000000-0000-4000-a000-0000000000b1
Content-Type: application/json

{"name":"Sample Division East"}
```

Send `{"parentId":"<unit id>"}` to move it with everything below it (`null` moves it to the top level), or `{"archived":true}` to archive it. A level takes `{"name"}` or `{"archived":true}` on `PATCH /api/v1/org-units/levels/{id}`. Two operations in one body, or any other shape, return 400 `invalid_input`. Archiving is permanent.

| Error                    | When                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| 409 `org_level_order`    | The unit's level is not below its parent's level                                                      |
| 409 `org_cycle`          | A move under the unit itself or a unit below it                                                       |
| 409 `org_state_conflict` | An archived unit, parent or level, or archiving a unit or level that still has current units below it |
| 409 `org_code_exists`    | Another current unit already uses the code                                                            |
| 409 `org_level_exists`   | A level already exists at that depth                                                                  |
| 404 `not_found`          | The level, unit or parent is not in your company                                                      |

Every create, rename, move and archive appears in Activity for the team you made it from, with ids only. A move or archive also records that home units changed.

## Positions and employees

The position routes under `/api/v1/positions` and the employee routes under `/api/v1/employees` need a signed-in browser session, like the organisation routes. A Bearer token, including an MCP OAuth token, gets 403 `session_required` on every method, and there is no MCP tool.

- **Positions** are company structure. Any signed-in member of a team in the company can read them. Creating, changing, moving and archiving them needs a company owner, or a company admin with the organisation area; anyone else gets 403 `org_forbidden`.
- **Employees** hold work contact facts only: a display name, an employee number, a work email, a work phone, a status of `active` or `left` and a retention class of `standard` (the default) or `extended`, which is shown for the company owners' retention review and enforces nothing. Reading them needs `directory:read`, which team owners and admins have; changing them needs `directory:write` as well. Anyone else gets 403 `directory_forbidden`.
- **Home-unit facts are owner-only.** An employee's user link and the positions of a linked employee decide that member's home units. So only a company owner can link or unlink a user, create an employee with a `userId`, change the positions of a linked employee, or move or archive a position that a linked employee holds. Anyone else, including a company admin and the employee's own member, gets 403 `directory_owner_required`.
- **Contact rule.** The owner and admin roles have the `full` directory rule and see `workEmail` and `workPhone`. A role with the `basic` rule gets employees without those two keys.

The examples use fictional names and ids.

Create a position in a unit. `isManager`, `jobRoleId` (a job role of your team) and `jobTitleKey` (a title of the published [job architecture](#job-architecture)) are optional:

```http
POST /api/v1/positions
Content-Type: application/json

{"title":"Fictional Payroll Lead","code":"FIN-PAY-1","orgUnitId":"00000000-0000-4000-a000-0000000000b1","isManager":true,"jobTitleKey":"payroll-lead"}
```

```json
{
  "data": {
    "id": "00000000-0000-4000-a000-0000000000c1",
    "orgUnitId": "00000000-0000-4000-a000-0000000000b1",
    "title": "Fictional Payroll Lead",
    "code": "FIN-PAY-1",
    "isManager": true,
    "jobRoleId": null,
    "jobTitleKey": "payroll-lead",
    "validFrom": "2026-11-09T08:00:00.000Z",
    "archivedAt": null,
    "vacant": true
  }
}
```

`GET /api/v1/positions?unitId=00000000-0000-4000-a000-0000000000b1` lists the current positions of one unit, ordered by title; leave out `unitId` for every position of the company. `jobRoleId` is shown only to members of the team that owns the job role. `vacant` is `true` when no active, non-archived employee holds the position now and `false` when one does. It is `null` when your role has no directory view (`directory:read`), because employees are hidden from you; the response never names who holds the position. The org tree uses it to draw vacant positions, and every position response, from `GET`, `POST` and `PATCH`, carries it. Change a position with exactly one operation per request on `PATCH /api/v1/positions/{id}`:

- one or more of `{"title","isManager","jobRoleId","jobTitleKey"}`, where `"jobRoleId":null` and `"jobTitleKey":null` clear them;
- `{"orgUnitId":"<unit id>"}` to move it;
- `{"archived":true}` to archive it for good.

A code cannot change.

Create an employee:

```http
POST /api/v1/employees
Content-Type: application/json

{"displayName":"Fictional Dana Sample","employeeNumber":"EMP-0001","workEmail":"dana.sample@example.test","workPhone":"+971 50 000 0001","retentionClass":"standard"}
```

It returns 201 with `{"data":{"id","displayName","employeeNumber","status","retentionClass","source","userId","workEmail","workPhone","positions","createdAt","updatedAt","archivedAt"}}`. Names and numbers are text facts with the same cleaning and 1 to 120 character bounds as unit names. The work email must be a valid address, and an empty work phone is stored as null.

Set the employee's current positions by sending the full set, at most 20 positions and at most one primary:

```http
PUT /api/v1/employees/00000000-0000-4000-a000-0000000000e1/positions
Content-Type: application/json

{"positions":[{"positionId":"00000000-0000-4000-a000-0000000000c1","primary":true}]}
```

Positions you leave out end now and stay as history. New ones start now.

A company owner links the employee to a member's user with `PATCH /api/v1/employees/{id}` and `{"userId":"<user id>"}`, and unlinks with `{"userId":null}`. A user is linked to at most one employee in the company. The same route takes one or more of `{"displayName","employeeNumber","workEmail","workPhone","status","retentionClass"}`, or `{"archived":true}`. When the status becomes `left` the service records the date for the retention review; returning to `active` clears it.

Page through the directory with `GET /api/v1/employees?unitId=<unit id>&levelId=<level id>&positionId=<position id>&status=active&page=1&pageSize=100`. Every filter is optional, and filters combine on the same current position:

- `unitId` matches employees holding a current position in that unit or any unit below it;
- `levelId` matches the level of that position's unit;
- `positionId` matches its holders;
- `status` matches the employee status;
- `search` (1 to 120 characters) matches part of the display name or employee number, ignoring case; the text is matched literally;
- `includeArchived=true` also returns archived employees (default `false`).

The list is ordered by display name. For example, `GET /api/v1/employees?search=dana&includeArchived=true&pageSize=20` finds every employee whose name or number contains "dana", archived or not.

| Error                          | When                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| 403 `directory_owner_required` | A user link, a linked employee's positions, or a move or archive of a held position |
| 409 `position_code_exists`     | Another current position already uses the code                                      |
| 409 `employee_number_exists`   | Another employee of the company already has the number                              |
| 409 `employee_user_linked`     | The user is already linked to another employee                                      |
| 409 `directory_state_conflict` | An archived or closed position, unit or employee                                    |
| 404 `not_found`                | The unit, level, position, employee, job role or user is not in your company        |
| 400 `invalid_reference`        | A `jobTitleKey` that is not a title of the published job architecture               |

Every create, update and archive appears in Activity for the team you made it from, with ids and field names only, never a name, number, email or phone. Each owner-only change also records which users' home units changed.

### Reporting lines

One level of the org tree by people. It needs a role with the Directory page and directory view (`directory:read`); anyone else gets 403 `directory_forbidden`. Without `managerId` it returns the people at the top; with it, the people reporting to that employee:

```http
GET /api/v1/employees/reporting-lines?managerId=00000000-0000-4000-a000-0000000000e1&page=1&pageSize=100
```

```json
{
  "data": [
    {
      "id": "00000000-0000-4000-a000-0000000000e3",
      "displayName": "Fictional Robin Sample",
      "title": "Fictional Payroll Clerk",
      "unitName": "Fictional Payroll",
      "otherPositions": 1,
      "reports": 0
    }
  ],
  "pagination": { "page": 1, "pageSize": 100, "hasMore": false }
}
```

A person reports to the first holder, by name, of a manager position in their own unit, or in the nearest unit above with a current holder, skipping units where they hold a manager position themselves; nothing is stored. Only active, non-archived employees with a current position appear, ordered by display name, and every row has exactly these six keys under either directory rule. A `managerId` outside your company returns 404 `not_found`, an employee with no reports an empty page, and any other query key 400 `invalid_input`.

### Employee erasure and the retention review

Both are for company owners only, signed in. Company admins, team owners without company authority and every other member get 403; a Bearer token gets 403 `session_required`. There is no MCP tool.

List the employees whose status has been `left` for 12 months or more, oldest first, archived ones included. It is read only; nothing is erased automatically:

```http
GET /api/v1/employees/retention-review?page=1&pageSize=100
```

```json
{
  "data": [
    {
      "id": "00000000-0000-4000-a000-0000000000e2",
      "displayName": "Fictional Former Clerk",
      "employeeNumber": "EMP-0002",
      "leftAt": "2025-06-10T09:00:00+00:00",
      "retentionClass": "standard",
      "archivedAt": null
    }
  ],
  "pagination": { "page": 1, "pageSize": 100, "hasMore": false }
}
```

`leftAt` is when the status became `left`, or the last update for employees who left before that date was recorded. Anyone but a company owner gets 403 `retention_review_forbidden`; a company owner whose team role has no `directory:read` gets 403 `directory_forbidden`.

Permanently erase one employee for a data-protection request, with the display name typed exactly as shown (spaces at either end are ignored, case matters) and an optional `Idempotency-Key`:

```http
POST /api/v1/employees/00000000-0000-4000-a000-0000000000e2/erasure
Content-Type: application/json
Idempotency-Key: fictional-erasure-0001

{"confirmName":"Fictional Former Clerk"}
```

```json
{
  "data": {
    "erasureId": "00000000-0000-4000-a000-0000000000f1",
    "alreadyErased": false,
    "erasedAt": "2026-11-09T09:00:00.000Z",
    "removed": { "positionRows": 2, "activityRedacted": 7, "userLinks": 1 }
  }
}
```

It deletes the employee and their position history, removes the user link (with one home-unit change entry naming that user), redacts every activity entry about the employee to its type, time and actor, and keeps a tombstone with no personal data. The response never holds a name, number, email or phone. Sending the same key again returns the identical response; a new key or no key returns the earlier erasure with `"alreadyErased": true`, the same `erasureId`, `erasedAt` and counts.

| Error                               | When                                      |
| ----------------------------------- | ----------------------------------------- |
| 403 `employee_erasure_forbidden`    | Anyone but a signed-in company owner      |
| 409 `erasure_confirmation_mismatch` | The typed name is not the employee's name |
| 409 `idempotency_mismatch`          | The key was used for another employee     |
| 404 `not_found`                     | The employee is not in your company       |
| 400 `invalid_input`                 | A malformed id or body                    |

See [erasure-runbook.md](erasure-runbook.md#erase-an-employee) for the steps before and after erasing.

## Job architecture

The company's job families, job grades and job titles are one versioned configuration object, edited as drafts and published as numbered versions like roles. Positions and vacancies name a title by its key. It holds names, codes and order only: no salary, pay figure or bracket. The routes need a signed-in browser session; a Bearer token, including an MCP OAuth token, gets 403 `session_required`, and there is no MCP tool.

- **Who writes.** A company owner, or a company admin with the organisation area, creates, edits and publishes. Anyone else, team owners and admins without company authority, recruiters and viewers included, gets 403 `config_forbidden`.
- **Who reads.** Every signed-in member of a team in the company reads the published version. Only the people who may write it also see the pending draft.

`GET /api/v1/job-architecture` returns the published version (`current`, `null` before the first publish) and the draft (`draft`, `null` for everyone who may not write it, or when there is none):

```json
{
  "data": {
    "current": {
      "versionId": "00000000-0000-4000-a000-0000000000d1",
      "number": 1,
      "body": {
        "families": [{ "key": "finance", "name": "Fictional Finance" }],
        "grades": [
          { "code": "G5", "name": "Fictional Associate", "order": 5 },
          { "code": "G7", "name": "Fictional Lead", "order": 7 }
        ],
        "titles": [
          {
            "key": "payroll-lead",
            "name": "Fictional Payroll Lead",
            "familyKey": "finance",
            "gradeCode": "G7"
          }
        ]
      }
    },
    "draft": null
  }
}
```

`POST /api/v1/job-architecture` creates a draft with `{"body":{…},"note":"…"}` (`note` optional) and returns 201 `{"data":{"objectId":"…","versionId":"…"}}`. The company has one job architecture, so there is no key to send. The body is always the whole architecture:

- `families`: at most 200 of `{key, name}`;
- `grades`: at most 200 of `{code, name, order}`, where `code` is 1 to 20 upper-case letters, digits and hyphens, such as `G7`, and `order` a whole number from 1 to 1000;
- `titles`: at most 2,000 of `{key, name, familyKey, gradeCode}`, each naming a family and a grade of the same body.

Keys are 1 to 63 lowercase letters, digits and hyphens; names are 1 to 120 characters. Family keys, grade codes, grade orders and title keys must each be unique. The strict schema refuses any other key, such as `salary` on a grade, with 400 `invalid_input`; nothing is stored.

`PUT /api/v1/job-architecture/{versionId}` replaces the draft's body and returns `{"data":{"versionId":"…"}}`. `POST /api/v1/job-architecture/{versionId}/publish` publishes the draft as the next version and returns `{"data":{"versionId":"…","number":2}}`; older versions stay as they were. Every draft and publish appears in `GET /api/v1/config-history` as type `job-architecture`, without the body.

| Error                       | When                                                                      |
| --------------------------- | ------------------------------------------------------------------------- |
| 403 `session_required`      | A Bearer token, including an MCP OAuth token                              |
| 403 `config_forbidden`      | Anyone but a company owner, or a company admin with the organisation area |
| 400 `invalid_input`         | A body outside the schema: an unknown key, a repeat or a bound passed     |
| 404 `not_found`             | The version is not a job architecture version of your company             |
| 409 `config_draft_exists`   | A draft is already pending; edit or publish it first                      |
| 409 `config_state_conflict` | The version is no longer a draft                                          |

## Salary brackets

Salary brackets give each job grade of the published job architecture a minimum, midpoint and maximum in AED fils (whole numbers, 100 fils to the dirham), versioned like the job architecture. They are confidential: the database lets only a signed-in session holding **Plan & pay access** (a per-person grant only a company owner gives, themselves included) and the `plans:read` scope of their team role read them. A Bearer token, including an MCP OAuth token, gets 403 `session_required`; there is no MCP tool, and brackets never appear in exports, search, notifications, analytics or activity, which holds the version number only.

- **Who reads.** A grant holder in a team where their role gives `plans:read` (a team owner or admin, or a configured role that keeps it). Anyone else, team owners, company admins and company owners without the grant included, gets 403 `plan_access_required`.

- **Who writes.** A grant holder with `plans:write` who is a company owner, or a company admin with the organisation area. A holder without that authority gets 403 `config_forbidden`; in an archived team, 403 `team_archived`.

The examples assume a local development server and a session cookie held in `RECRUITMENTOS_SESSION_COOKIE`; never put a real session cookie in a script, log or chat. Every write also sends the application's `Origin`. The ids and figures are fictional.

`GET /api/v1/salary-brackets` returns the highest-numbered published version (`current`) and the newest draft (`draft`), each `null` when there is none, with the brackets ordered by grade code:

```bash

curl --fail-with-body "$RECRUITMENTOS_URL/api/v1/salary-brackets" \

  -H "Cookie: $RECRUITMENTOS_SESSION_COOKIE"

```

```json
{
  "data": {
    "current": {
      "versionId": "00000000-0000-4000-a000-0000000000e1",

      "number": 1,

      "state": "published",

      "payPeriod": "monthly",

      "covers": "basic",

      "effectiveFrom": "2027-01-01",

      "createdAt": "2026-11-11T08:00:00.000+00:00",

      "publishedAt": "2026-11-11T08:05:00.000+00:00",

      "brackets": [
        {
          "gradeCode": "G5",

          "minimumFils": 1200000,

          "midpointFils": 1500000,

          "maximumFils": 1800000
        },

        {
          "gradeCode": "G7",

          "minimumFils": 2000000,

          "midpointFils": 2500000,

          "maximumFils": 3000000
        }
      ]
    },

    "draft": null
  }
}
```

`POST /api/v1/salary-brackets` creates a draft with exactly one bracket for each grade of the published job architecture and returns it with 201. `payPeriod` is `monthly` (default) or `annual`; `covers` is `basic` (default, basic salary only), `basic-housing-transport` or `total-cash`; both are stored on the version and shown with every bracket. Several drafts may exist.

```bash

curl --fail-with-body "$RECRUITMENTOS_URL/api/v1/salary-brackets" \

  -H "Cookie: $RECRUITMENTOS_SESSION_COOKIE" \

  -H "Origin: $RECRUITMENTOS_URL" \

  -H "Content-Type: application/json" \

  -d '{"effectiveFrom":"2027-01-01","brackets":[{"gradeCode":"G5","minimumFils":1200000,"midpointFils":1500000,"maximumFils":1800000},{"gradeCode":"G7","minimumFils":2000000,"midpointFils":2500000,"maximumFils":3000000}]}'

```

`PUT /api/v1/salary-brackets/{versionId}` replaces a draft's settings and figures with the same body and returns the draft; the grade codes must be the draft's own. To change grades, create a new draft.

```bash

curl --fail-with-body -X PUT "$RECRUITMENTOS_URL/api/v1/salary-brackets/00000000-0000-4000-a000-0000000000e2" \

  -H "Cookie: $RECRUITMENTOS_SESSION_COOKIE" \

  -H "Origin: $RECRUITMENTOS_URL" \

  -H "Content-Type: application/json" \

  -d '{"payPeriod":"annual","effectiveFrom":"2027-01-01","brackets":[{"gradeCode":"G5","minimumFils":14400000,"midpointFils":18000000,"maximumFils":21600000},{"gradeCode":"G7","minimumFils":24000000,"midpointFils":30000000,"maximumFils":36000000}]}'

```

`POST /api/v1/salary-brackets/{versionId}/publish` publishes the draft as the next version and returns `{"data":{"versionId":"…","number":2}}`. It needs a recent sign-in: a session older than 15 minutes gets 403 `SESSION_NOT_FRESH` and nothing is published. Earlier versions stay published and unchanged; nothing is retired. An offer created afterwards for a vacancy with a job title keeps this version, which its response never shows.

```bash

curl --fail-with-body -X POST "$RECRUITMENTOS_URL/api/v1/salary-brackets/00000000-0000-4000-a000-0000000000e2/publish" \

  -H "Cookie: $RECRUITMENTOS_SESSION_COOKIE" \

  -H "Origin: $RECRUITMENTOS_URL"

```

A Bearer token is refused before any data is read:

```bash

curl "$RECRUITMENTOS_URL/api/v1/salary-brackets" \

  -H "Authorization: Bearer $RECRUITMENTOS_TOKEN"

# 403 {"error":{"code":"session_required",...}}

```

| Error | When |

| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |

| 403 `session_required` | A Bearer token, including an MCP OAuth token |

| 403 `plan_access_required` | No Plan & pay access, or no `plans:read` (read) or `plans:write` (write) in your role |

| 403 `config_forbidden` | A write by a holder who is neither a company owner nor a company admin with the organisation area |

| 403 `team_archived` | A write from an archived team |

| 403 `SESSION_NOT_FRESH` | Publishing with a session older than 15 minutes |

| 400 `invalid_input` | A minimum above its midpoint or a midpoint above its maximum, a grade missing, unknown or repeated, grades other than the draft's on edit, or a body outside the schema |

| 404 `not_found` | An unknown version, one of another company, or one you cannot read |

| 409 `job_grades_required` | No published job architecture with at least one grade |

| 409 `bracket_version_published` | The version is published and cannot be changed; create a new draft |

| 409 `bracket_grades_changed` | The job grades changed since the draft was made; create a new draft for the current grades |

## Organisation import

`POST /api/v1/org-import/dry-run` checks an .xlsx workbook and `POST /api/v1/org-import/apply` applies it. Both need a signed-in browser session; a Bearer token, including an MCP OAuth token, gets 403 `session_required`, and there is no MCP tool. The caller is a company owner, or a company admin with the organisation area, and a workbook with Employees rows also needs a role with directory create and edit. These checks run before the body is read. The body is the raw workbook, not JSON, at most 5 MiB.

The workbook has up to three sheets, matched by name ignoring case: `Units` (Code, Name, Level, Parent code), `Positions` (Code, Title, Unit code, Manager) and `Employees` (Employee number, Name, Work email, Work phone, Position codes, Primary position). Row 1 names the columns. `Level` is the name of a current level; `Manager` is yes, no, true or false; `Position codes` are separated by commas or semicolons. A blank cell leaves the stored value unchanged. Formulas are never evaluated, and a value starting with `=`, `+`, `-`, `@`, tab or CR is stored as text and listed in `flagged`.

The dry run runs in a read-only transaction and writes nothing:

```http
POST /api/v1/org-import/dry-run
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet

<the bytes of fictional-organisation.xlsx>
```

```json
{
  "data": {
    "sha256": "3b1f0c2e9d8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c",
    "sheets": {
      "units": {
        "create": 1,
        "update": 1,
        "unchanged": 4,
        "reject": 1,
        "needsOwner": 1
      },
      "positions": {
        "create": 2,
        "update": 0,
        "unchanged": 3,
        "reject": 0,
        "needsOwner": 0
      },
      "employees": {
        "create": 2,
        "update": 1,
        "unchanged": 6,
        "reject": 1,
        "needsOwner": 0
      }
    },
    "rejected": [
      {
        "sheet": "Units",
        "row": 5,
        "reason": "Unit FIN-EAST: unknown level \"Region\"."
      },
      {
        "sheet": "Employees",
        "row": 9,
        "reason": "Employee EMP-0009: Work email is not a valid email address."
      }
    ],
    "needsOwner": [
      {
        "sheet": "Units",
        "row": 3,
        "reason": "Unit FIN: moves the unit to another parent."
      }
    ],
    "flagged": [{ "sheet": "Employees", "row": 4, "column": "Work phone" }],
    "truncated": false
  }
}
```

`rejected`, `needsOwner` and `flagged` hold at most 500 entries each, and `truncated` is true when one was cut; the counts are always complete. Apply sends the same file with the dry run's `sha256`:

```http
POST /api/v1/org-import/apply?sha256=3b1f0c2e9d8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet

<the same bytes>
```

It plans again against the data as it is now and writes the create and update rows in one transaction per sheet: units, then positions, then employees. It returns the same shape plus `"group":"normal"`, with `create` and `update` counting the rows written. Applying the same file again writes nothing and reports those rows as unchanged. New employees get `"source":"excel"`; the import never sets a user link. Each sheet that wrote rows adds one `org-import` activity row with counts only, shown only to people with company authority.

Rows in `needsOwner` move a unit, move a position an employee linked to a user holds, or change such an employee's positions. A normal apply never writes them. A company owner applies only those rows with `group=owner`:

```http
POST /api/v1/org-import/apply?sha256=3b1f0c2e9d8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c&group=owner
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet

<the same bytes>
```

Its `create` and `update` count the owner rows written; a row whose new parent, unit or position does not exist yet is rejected, so run the normal apply first.

| Error                          | When                                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 403 `session_required`         | A Bearer token, including an MCP OAuth token                                                                                                                                                                                          |
| 403 `org_forbidden`            | Not a company owner, or a company admin with the organisation area                                                                                                                                                                    |
| 403 `directory_forbidden`      | Employees rows without a role that can create and edit employees                                                                                                                                                                      |
| 403 `org_owner_required`       | `group=owner` by anyone but a company owner                                                                                                                                                                                           |
| 403 `org_import_forbidden`     | Apply by a role with none of `candidates:write`, `recruitment:write`, `cvs:write` or `imports:write`                                                                                                                                  |
| 415 `xlsx_required`            | Another content type                                                                                                                                                                                                                  |
| 413 `import_too_large`         | A body over 5 MiB                                                                                                                                                                                                                     |
| 422 `import_unreadable`        | Not a readable .xlsx, ZIP64 or encrypted, an unsafe entry name such as `../x.xml`, a local entry that does not match the central directory or inflates past its declared size, or bytes outside the entries, directory and end record |
| 422 `import_archive_too_large` | More than 2,000 archive entries or 50 MiB declared uncompressed                                                                                                                                                                       |
| 422 `import_too_many_rows`     | More than 20,000 rows below the headers                                                                                                                                                                                               |
| 422 `import_columns_missing`   | A present sheet without one of its columns                                                                                                                                                                                            |
| 422 `import_empty`             | No rows to import                                                                                                                                                                                                                     |
| 400 `invalid_input`            | Apply without a 64-character `sha256`, with a `group` other than `owner`, or with another query key                                                                                                                                   |
| 409 `import_file_changed`      | The body is not the file whose `sha256` was sent; run the dry run again                                                                                                                                                               |

## Your access and the Admin portal reads

These three routes serve the Admin portal and need a signed-in browser session. A Bearer token, including an MCP OAuth token, gets 403 `session_required`, and there is no MCP tool. The examples use fictional names.

`GET /api/v1/me/access` returns your own access in the active team, as the server decides it, so a screen can hide what the server would refuse. Any signed-in member can read it. It takes no query parameters. This response is trimmed:

```json
{
  "data": {
    "teamRole": "recruiter",
    "companyLevel": "admin",
    "role": { "name": "Recruiter", "membership": "recruiter" },
    "scopes": ["candidates:read", "candidates:write", "recruitment:read"],
    "pages": ["home", "candidates", "vacancies", "settings", "admin"],
    "actions": {
      "candidates": ["view", "create", "edit", "transition", "archive"],
      "vacancies": ["view", "create", "edit", "transition", "archive"]
    },
    "fields": {
      "candidate": { "name": "edit", "email": "edit", "phone": "edit" }
    },
    "adminAreas": ["fields"]
  }
}
```

- `teamRole` is your team role and `companyLevel` your company authority (`owner`, `admin` or `null`).
- `role` is the name and level of the role that applies to you: the built-in template of your team role, or the configured role a company owner gave you. It is `null` when no role applies; `pages`, `actions` and `fields` are then empty.
- `actions` lists the allowed actions per resource and leaves out a resource with none. `fields` gives the rule of each field (`hidden`, `read` or `edit`) for each record kind you may view.
- `adminAreas` lists the company areas you hold.

It holds no user, team, workspace, role, version or configuration id and no configuration body.

`GET /api/v1/config-history?pageSize=25` lists the company configuration changes made in any team of the workspace, newest first. Only company owners and company admins can read it; anyone else, team owners and admins without company authority included, gets 403 `config_forbidden`.

```json
{
  "data": [
    {
      "occurredAt": "2026-11-08T10:15:00.000Z",
      "action": "config.published",
      "objectType": "workflow",
      "objectKey": "fictional-hiring",
      "versionNumber": 2,
      "fromVersionNumber": 1,
      "actorName": "Fictional Company Owner"
    }
  ],
  "pagination": {
    "pageSize": 25,
    "hasMore": true,
    "nextBefore": "2026-11-08T10:15:00.000Z"
  }
}
```

`pageSize` is 1 to 100 (default 25). While `hasMore` is `true`, send `nextBefore` as `before` for the next page: `GET /api/v1/config-history?pageSize=25&before=2026-11-08T10%3A15%3A00.000Z`. The cursor has millisecond precision, so changes made in the same millisecond as the last one listed may be skipped. Any other query key or value returns 400 `invalid_input`.

`GET /api/v1/access-changes` lists the role assignments and home-unit changes of every team in the workspace from the last seven days, newest first. Only company owners can read it; anyone else, company admins and team owners included, gets 403 `role_assignment_forbidden`. It takes no query parameters; any key returns 400 `invalid_input`.

```json
{
  "data": [
    {
      "occurredAt": "2026-11-08T09:00:00.000Z",
      "kind": "role-assignment",
      "action": "role.assigned",
      "affectedUserIds": ["fictional-member-id"],
      "roleName": "Fictional Hiring Manager",
      "actorName": "Fictional Company Owner"
    },
    {
      "occurredAt": "2026-11-07T09:00:00.000Z",
      "kind": "home-units",
      "action": "scope.home_units_changed",
      "affectedUserIds": ["fictional-member-id"],
      "roleName": null,
      "actorName": "Fictional Company Owner"
    }
  ],
  "truncated": false
}
```

At most the latest 100 changes of each kind are read. `truncated` is `true` when 100 changes of a kind were read and the oldest of them is still inside the seven days, so older changes from those days are not listed.

## Roles, member roles and company authority

These routes serve the **Roles & permissions** tab and **Team & access**. They need a signed-in browser session of a company owner: a Bearer token, including an MCP OAuth token, gets 403 `session_required`, and there is no MCP tool. The examples use fictional names and ids.

### Roles

`GET /api/v1/roles` lists the company's roles that are not archived, ordered by key, at most 100, each with its current published version (`current`) and its draft (`draft`), or `null`. Anyone but a company owner, company admins and team owners included, gets 403 `config_forbidden` on every role route.

`POST /api/v1/roles` creates a role draft. Send the key and the whole role body; a new key creates the role, and the key of an existing role adds a new draft to it. The screen copies a built-in template's body and changes its name:

```json
{
  "key": "fictional-reader",
  "body": {
    "name": "Fictional reader",
    "membership": "viewer",
    "scopes": ["candidates:read", "recruitment:read", "cvs:read"],
    "pages": ["home", "candidates", "vacancies"],
    "actions": { "candidates": ["view", "export"], "vacancies": ["view"] },
    "fields": { "candidate": { "email": "read" } },
    "recordScope": { "pipeline": "all", "candidates": "all", "tasks": "all" }
  }
}
```

It returns 201 `{"data":{"objectId":"…","versionId":"…"}}`. The strict role schema refuses an unknown key, membership `owner` and any grant outside the membership, such as `edit` for a viewer, `import` for a recruiter or any `plans` action, with 400 `invalid_input`; nothing is stored. A role that already has a draft gives 409 `config_draft_exists`.

`PUT /api/v1/roles/{versionId}` replaces the draft's body with `{"body":{…}}` and returns `{"data":{"versionId":"…"}}`. `POST /api/v1/roles/{versionId}/publish` publishes the draft and returns `{"data":{"versionId":"…","number":1}}`; publishing changes access for every member who holds the role. Both answer 404 `not_found` for a version of another configuration type, and 409 `config_state_conflict` for a version that is no longer a draft. Every draft and publish appears in `GET /api/v1/config-history` as type `role`.

### Member roles

`GET /api/v1/teams/member-roles` returns the configured roles of the active team's members and the roles that can be assigned. Anyone but a company owner gets 403 `role_assignment_forbidden`.

```json
{
  "data": {
    "assignments": [
      {
        "userId": "fictional-member-id",
        "roleObjectId": "00000000-0000-4000-a000-000000000010",
        "roleName": "Fictional archived reader",
        "available": false
      }
    ],
    "roles": [
      {
        "roleObjectId": "00000000-0000-4000-a000-000000000011",
        "name": "Fictional reader",
        "membership": "viewer"
      }
    ]
  }
}
```

`available` is `false` when the assigned role is archived or has no published version; that member is refused everything with "Your role is no longer available. Ask a company owner to choose a role for you." until the role is reassigned or cleared with `POST /api/v1/teams/member-roles` and `{"userId":"fictional-member-id","roleObjectId":null}`. `roles` lists every assignable published role, including roles limited to the member's org unit or to assigned records. If the role is saved but the team role could not be checked or changed for another reason than a refusal, the POST answers 503 `team_role_unconfirmed`; the role stays saved and the request can be retried.

### Company authority

`GET /api/v1/company-authority` lists the company owners and admins, owners first. Anyone but a company owner gets 403 `authority_forbidden`.

```json
{
  "data": [
    {
      "userId": "fictional-owner-id",
      "name": "Fictional Company Owner",
      "level": "owner",
      "areas": [],
      "planAccess": true,
      "suspended": false
    },
    {
      "userId": "fictional-admin-id",
      "name": "Fictional Company Admin",
      "level": "admin",
      "areas": ["fields", "organisation"],
      "planAccess": false,
      "suspended": true
    }
  ]
}
```

`POST /api/v1/company-authority` grants, changes or removes one person's authority and returns `{"data":{"changed":true}}`, or `false` when nothing changed:

```json
{
  "userId": "fictional-member-id",
  "level": "admin",
  "areas": ["fields"],
  "planAccess": true
}
```

- A company owner is `{"userId":"…","level":"owner","areas":[],"planAccess":true}`; removal is `{"userId":"…","level":null}`.
- `areas` is a unique subset of `fields`, `workflows`, `boards`, `organisation` and `templates`. Anything else, including `roles`, `ai`, `plan` or `home-units`, gives 400 `invalid_input`.
- Removing or demoting the last company owner gives 409 `last_company_owner`; a person in no team of the company gives 409 `not_in_company`.
- `suspended` is `true` for someone who left every team of the company. After they rejoin a team, sending their grant again restores it.
- Each change writes one `workspace_authority.changed` row to your team's activity, shown only to people with company authority.

## Errors

The API uses structured errors: `{"error":{"code","message","correlationId"}}`. 401 indicates an invalid session or token, 403 an unavailable scope or membership, 409 a version/idempotency/uniqueness conflict, 413 an oversized body and 429 a rate limit. A 429 response carries `Retry-After` with the number of seconds to wait before retrying; for 429 `CV_UPLOAD_RATE_LIMITED` (the team's CV upload rate limit) and `token_guess_rate_limited` it is 60, and for 429 `STORAGE_RECONCILIATION_COOLDOWN` it is the seconds left of the team's 10-minute cleanup cooldown. 5xx failures may have an uncertain result; check by idempotency key or legacy ID before attempting another create. Avoid logging response payloads containing candidate personal information.

Every error response has a fresh `error.correlationId` and an identical `X-Correlation-Id` header. Quote it when reporting a failure: for a 500 the server logs that ID with a safe error category, never the request or record contents.

See `/api/openapi.json` for endpoint documentation. Each operation lists the token scopes it needs in `x-required-scopes`; operations marked `x-session-only` reject API tokens with 403 `session_required`. Auth and team management use the interactive sign-in session, never a personal API token.

`POST /api/v1/notifications` marks genuine reminder keys read for the token's user. Token clients need both `recruitment:read` and `recruitment:write`; a read-only token cannot change reminder state.

Authentication UI uses [Better Auth organization APIs](https://better-auth.com/docs/plugins/organization), [session controls](https://better-auth.com/docs/concepts/session-management) and [profile/password controls](https://better-auth.com/docs/concepts/users-accounts).
