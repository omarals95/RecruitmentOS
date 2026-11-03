# RecruitmentOS Software Requirements Specification

Version 1.0 | 3 November 2026 | Engineering baseline for review

Companion documents: [Business Requirements Document](recruitmentos-brd.md) and [Project Brief](recruitmentos-brief.md).

## 1 Purpose and release position

This specification defines the software behavior, contracts, controls and acceptance evidence needed to complete RecruitmentOS as a secure, team-based recruitment workspace. It is intended for product owners, developers, testers, security reviewers and deployment operators. It covers the existing recruitment application, the selected private Vercel Blob storage direction, bulk CV intake, optional AI-assisted extraction and migration from the earlier local recruitment dashboard.

**Release position:** Core workflows are present in source, but a production-ready hosted service has not been established. Hosted authentication/database access is deliberately blocked while identity and tenant isolation are completed. Private Blob CV upload/download integration remains disabled. AI extraction has a provider-neutral interface but no connected live provider. A resource being provisioned, a successful local production build, or a passing synthetic test does not establish a deployed or secure end-to-end service.

Private Vercel Blob is the selected testing direction. Existing S3 code must be treated as a legacy/alternative implementation, not silently selected when Blob is unavailable. Preview and Production resources were reported connected in the project task; their effective permissions, isolation, content and full application integration still require verification.

### 1.1 Baseline and evidence rules

The public repository inspected for this specification is [omarals95/RecruitmentOS](https://github.com/omarals95/RecruitmentOS), pinned to commit **d67828ed0889849ea0fc431949288f7c10061dda**. A later implementation report supplies local implementation status. Those local changes are not assumed to be present in the pinned repository or any deployment.

The following terms are used consistently:

- **Observed:** Directly present in the inspected source or repository documentation. This is not a claim of live verification.
- **Reported local:** Described in the existing task's latest completion report, not independently rerun for this document.
- **Required:** Normative target behavior expressed with “shall.” A requirement is not a statement that the code already complies.
- **Proposed:** An engineering default or design that needs approval before becoming a release commitment.
- **Open:** A choice, provider guarantee or acceptance fact that remains unresolved.

All requirement IDs are stable. New revisions shall retain IDs, mark superseded requirements and maintain the traceability register. Priority **P0** means a security/data-integrity release gate; **P1** means required functional release scope; **P2** means later enhancement unless promoted by the product owner. Numeric performance targets in Section 12 are proposed acceptance targets, not measured results or an SLA.

### 1.2 In scope and exclusions

In scope: verified identity and teams; candidates and factual source evidence; CV versions; reviewed bulk intake; optional extraction; roles and vacancies; applications; task boards and custom fields; interviews; offers; onboarding; personal follow-up; shared discussion; reminders; search and saved views; analytics; scoped API tokens; audit; migration/export; deployment and operations.

Out of scope unless separately approved: candidate-facing job applications, public CV intake, job-board posting, payroll, background screening, e-signatures, candidate messaging campaigns, automatic hiring decisions, automated ranking/rejection, automatic external calendar invitations, two-way Excel synchronization, and cloud access to Windows File Explorer. Recording an offer or interview does not send a contract or calendar invitation.

## 2 System context and architecture

### 2.1 Observed implementation

The application is a Next.js App Router application with React and TypeScript. It uses Better Auth for account/session/organization functions, Drizzle for schema/data access, PostgreSQL as the canonical hosted store, PGlite for explicitly enabled fictional local development, Zod for bounded domain validation, and REST-style handlers under `/api/v1`. Node.js 24 is the declared runtime. Package versions are those locked in the inspected repository, not a recommendation to use unreviewed upgrades.

The code separates `src/domain` schemas, `src/db` access/schema, `src/lib` business services, `src/app/api` routes and `src/components/workspace` UI. Business objects use a shared typed record envelope with kind-specific JSONB payloads rather than one SQL table per recruitment entity. The repository contains S3 upload/version validation, standalone Blob validation/ticket/assembly components, and tests. Standalone components are not yet a complete Blob implementation.

Sources: [package.json](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/package.json), [domain schemas](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/domain/records.ts), [database schema](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/db/schema.ts).

### 2.2 Target boundaries

1. **Browser:** UI, drafts, explicit review and bounded upload/download assembly. It never receives database credentials, provider signing secrets or unrestricted storage tokens.
2. **Application API:** request validation, exact-origin checks, authenticated principal resolution, role/scope checks, version/idempotency enforcement and safe responses.
3. **Identity access:** Better Auth, verified sessions, current membership, token lifecycle and restricted identity lookup. It is separated from the recruitment-data SQL role.
4. **Recruitment data access:** team-scoped records, private rows, audit, imports, analytics and CV metadata under a trusted authorization context.
5. **Private storage:** environment-specific Blob store, server-selected immutable logical reference, reserved allocation, complete-byte validation and verified download. S3 references remain explicitly distinguishable if retained.
6. **Extraction service:** optional provider adapter behind separate consent, budget, document-processing and review gates. It cannot write candidate facts directly.
7. **Operational plane:** migrations, backups, monitoring and reconciliation using operator-only privileges outside the deployed runtime.

**SRS-ARC-01 | P0.** Each boundary shall have one documented trust model and explicit interfaces. UI checks shall never substitute for server and database authorization. **Acceptance:** bypassing the UI, guessing identifiers and calling handlers directly cannot cross teams, elevate scopes or alter protected fields.

**SRS-ARC-02 | P0.** Hosted operation shall remain fail-closed until the identity, storage and environment release gates pass. No environment flag shall bypass an unresolved security guard. **Acceptance:** missing/unsafe connections and explicitly selected unsupported storage return a safe configuration error without sending candidate data to another provider.

**SRS-ARC-03 | P1.** Domain rules shall be shared by UI, API, importer and provider adapters, with the server authoritative. **Acceptance:** the same invalid field, parent reference and stale version are rejected through all supported entry points.

**SRS-ARC-04 | P1.** External calls shall use adapters, explicit deadlines, cancellation and bounded resource use. **Acceptance:** tests cover stalled body reads and providers that ignore cancellation; the caller exits within its configured timeout and cleanup does not hang indefinitely.

### 2.3 Actors and authorization

| Actor      | Recruitment records                                        | CV access                          | Imports                              | Team administration                                                       | Token administration                           |
| ---------- | ---------------------------------------------------------- | ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------- |
| Owner      | Read/write                                                 | Read/write when storage enabled    | Allowed                              | Full team control, including ownership with last-owner safeguard          | Own tokens and permitted team revocation       |
| Admin      | Read/write                                                 | Read/write when storage enabled    | Allowed                              | Members/invitations/settings within admin limits; cannot assume ownership | Own tokens and permitted team revocation       |
| Recruiter  | Read/write                                                 | Read/write when storage enabled    | No privileged legacy-import metadata | No ownership or membership administration                                 | Own tokens within current scopes               |
| Viewer     | Read only; personal interaction exceptions specified below | Read when storage enabled          | No                                   | No                                                                        | Own read-only tokens                           |
| API client | Explicit scopes intersected with creator's current role    | Explicit `cvs:read` or `cvs:write` | `imports:write` plus owner/admin     | Never through a personal API token                                        | Cannot create/manage other tokens              |
| Operator   | No automatic business access                               | Only approved operational access   | Controlled migration execution       | Infrastructure provisioning only                                          | Credential operations through approved process |

The business account owner and database migration owner are different concepts. Operators shall not receive candidate access merely because they deploy the application. Human users may maintain their own shortlist, follow-up and read reminders subject to the specific endpoint rules; these do not authorize shared-record mutation. Existing code permission details shall be reconciled with this matrix during acceptance, especially viewer personal-state behavior.

## 3 Identity and workspace requirements

**SRS-ID-01 | P0.** The system shall require verified identity and live team membership for protected recruitment access. Email/password registration shall be invitation-only unless an explicitly approved setting opens it. Initial administrator creation shall require the configured bootstrap identity and one-time setup authorization, with durable single-claim and interrupted-recovery behavior. **Acceptance:** unverified, uninvited, wrong-bootstrap and replayed setup attempts receive no team data; two concurrent bootstrap attempts cannot create unauthorized initial owners.

**SRS-ID-02 | P0.** Sign-in, verification, resend, password reset, sign-out and session revocation shall have bounded request size, rate limits, safe account-enumeration behavior and trusted callback/origin validation. **Acceptance:** invalid/expired/reused links fail safely; reset links go to the matching environment; revoked sessions fail their next protected request; development console delivery cannot operate in hosted production.

**SRS-ID-03 | P1.** Optional Google/Microsoft sign-in shall be exposed only when configured and tested for that environment. Email equality alone shall not auto-link accounts or confer team access. **Acceptance:** an untrusted/unverified provider claim cannot bypass invitation and verification rules; account linking requires the approved explicit flow.

**SRS-ID-04 | P0.** Owner/admin membership operations shall enforce actor permissions, invitation recipient binding, expiry and current membership on acceptance. Last-owner protection shall be serialized. **Acceptance:** concurrent owner removal/demotion leaves at least one owner; admins cannot promote themselves to owner; a revoked/expired invitation cannot be accepted.

**SRS-ID-05 | P1.** Team switching shall invalidate cached data and active mutation contexts before showing another team. An in-flight result from the old team shall not populate the new team's screen. **Acceptance:** switching during list fetch, bulk intake and save preserves isolation and presents a clear cancellation/review state.

**SRS-ID-06 | P1.** Profile settings shall support authorized name/password/session management without changing recruitment ownership. Interrupted team creation shall be reconciled without blindly creating repeated organizations. **Acceptance:** a failed owner-member creation results in a recoverable administrative state, not an accessible ownerless workspace.

## 4 Candidate and source requirements

**SRS-CAN-01 | P1.** Users with candidate write permission shall create, edit, archive and restore candidates through versioned forms. Name is required; missing optional facts remain empty/unknown rather than fabricated. **Acceptance:** a name-only candidate can be created; invalid email, impossible experience values, oversized fields and unknown keys are rejected; partial edits preserve omitted fields.

**SRS-CAN-02 | P1.** The directory shall support paginated factual search/filtering by available skills, certifications, education, experience, source categories, review status and related recruitment context. Search supports words, quoted phrases and exclusions. **Acceptance:** filters combine predictably; an empty result differs from a failed request; total counts reflect the complete authorized query, not only the current page.

**SRS-CAN-03 | P0.** Candidate facts shall retain source metadata and evidence, and distinguish CV-stated experience from documented estimates. Source folder categories shall be labeled as provenance, never suitability judgments. The system shall not infer gender, nationality, residence, national-service status or other sensitive attributes from names, photos or proxies. **Acceptance:** unsupported fields remain unknown, conflicting evidence is flagged for human review, and factual edits retain their origin and reviewer.

**SRS-CAN-04 | P1.** Candidate detail shall show factual profile, evidence/source reviews, available CV versions and linked applications, tasks, interviews, offers and onboarding, without confusing record types. **Acceptance:** creating a candidate task neither creates an application nor changes a hiring stage; unavailable parent records show a safe missing/archived state.

**SRS-CAN-05 | P0.** Personal shortlist, follow-up status and notes shall be scoped to team, candidate and user. Saved views and notification read state shall be user-private. Shared comments shall be separately labeled. **Acceptance:** another team member, including an admin through ordinary recruitment APIs, cannot retrieve private note bodies or private views; their own personal state remains independent.

**SRS-CAN-06 | P1.** Duplicate detection shall identify possible matches using normalized contact details, including matches within the current batch. It shall not merge or select a person's identity automatically. **Acceptance:** case-insensitive email and normalized phone matches are explained; ambiguous matches require review; no match is not represented as proof of uniqueness.

**SRS-CAN-07 | P1.** Shared discussion shall be append-only with authenticated author and timestamp. An importer may retain a distinct legacy author label without impersonating that author. **Acceptance:** author IDs cannot be supplied by an ordinary client, private note/comment text is not copied into audit metadata, and edits/deletion are unavailable unless a separately approved redaction policy is implemented.

**SRS-CAN-08 | P1.** Exports shall explicitly identify filters, columns, row count, time and environment, enforce current access and protect against spreadsheet formula execution. No secret URLs or private data belonging to another user may be included. **Acceptance:** export reconciliation matches the full requested dataset; leading formula characters in untrusted cell values are safely handled; partial/limited exports are labeled.

## 5 Recruitment workflow requirements

### 5.1 State vocabulary

These are the observed domain enumerations and required baseline vocabulary:

| Record                       | Values                                                           |
| ---------------------------- | ---------------------------------------------------------------- |
| Application stage            | Sourced; Screening; Interview; Offer; Hired; Rejected; Withdrawn |
| Vacancy status               | Draft; Open; On hold; Filled; Closed                             |
| Personal candidate follow-up | New; To contact; Contacted; Interviewing; On hold; Closed        |
| Interview status             | Scheduled; Completed; Cancelled; No show                         |
| Offer status                 | Draft; Sent; Accepted; Declined; Withdrawn; Expired              |
| Onboarding status            | Planned; In progress; Completed; On hold                         |
| Checklist status             | Pending; In progress; Complete; Waived                           |
| Task priority                | Low; Normal; High; Urgent                                        |
| Custom task field            | Text; Number; Date; Dropdown; Checkbox                           |

These state sets are separate. A terminal-looking label does not authorize hidden side effects. The current baseline permits explicit enum changes rather than a fully restricted transition graph. Adding mandatory stage prerequisites, approvals or restricted reopening is an open product decision, not an existing feature.

**SRS-REC-01 | P1.** Job roles shall hold reusable title, department, location, work arrangement, description, requirements and skills. Copying a role into a vacancy shall populate a draft snapshot. **Acceptance:** subsequent role edits do not silently rewrite existing vacancies; any refresh is explicit and reviewed.

**SRS-REC-02 | P1.** Vacancies shall include requisition details, openings, status, ownership labels and target date. **Acceptance:** openings are positive integers within the schema bound; archived roles cannot become new active references; changing vacancy status does not silently move applications.

**SRS-REC-03 | P1.** Applications shall link one candidate and one vacancy in the same team. Those parent references are immutable after creation; stage changes are explicit, versioned and audited. **Acceptance:** duplicate active candidate/vacancy applications are rejected or reported as already present, and concurrent requests cannot bypass uniqueness.

**SRS-REC-04 | P1.** Bulk assignment shall validate up to 500 candidate IDs per request, the target vacancy and current write scope before committing. **Acceptance:** cross-team/missing/archived inputs are rejected without partial hidden writes; the response clearly distinguishes created applications from existing ones; retry cannot create duplicates.

**SRS-REC-05 | P1.** Interviews shall attach to an application and store a timezone-aware instant, 15–480 minute duration, interviewer, location/HTTP(S) meeting link and status. The UI shall display Asia/Dubai as the baseline timezone. **Acceptance:** UTC storage round-trips to Dubai display across day boundaries; day/week/month/list views agree; invalid dates and unsafe URL schemes are rejected. External invitations are not sent by recording an interview.

**SRS-REC-06 | P1.** Offers shall attach to an application and record decimal amount, three-letter currency, pay period, dates, status and decline reason. **Acceptance:** money uses a precise decimal/string representation; status changes retain audit history; Accepted does not automatically mark the application Hired or send an offer to the candidate.

**SRS-REC-07 | P1.** Onboarding shall attach to an application with owner, start date, status and checklist. At most one active onboarding record shall exist for an application. **Acceptance:** progress counts Complete/Waived among active items, an empty checklist is not 100 percent complete, and checklist changes do not silently alter application stage.

**SRS-REC-08 | P1.** Archiving shall preserve history and linked records. Active operations shall reject invalid/archived parents except explicitly supported historical reads/imports. **Acceptance:** archive/restore are versioned, active-only default views omit archived records, and a restore that violates active uniqueness returns a conflict without losing history.

**SRS-REC-09 | P1.** Pipeline and board movements shall support keyboard/button alternatives to drag-and-drop and optimistic concurrency. **Acceptance:** stale moves preserve the user's draft/intention, announce the conflict and require rereading/reconciliation rather than silently overwriting another user's move.

### 5.2 Task workspace

**SRS-TASK-01 | P1.** Tasks shall use configurable team buckets as status, with title, optional candidate/vacancy links or free-text context, owner, due date, priority, description and custom values. **Acceptance:** tasks remain useful without an application; movement changes only their bucket; invalid reference kinds fail.

**SRS-TASK-02 | P1.** Bucket creation, reordering, renaming and archiving shall enforce unique active names and retain at least one active bucket. Archiving a populated bucket shall require an active destination and move its tasks atomically. **Acceptance:** concurrent archival cannot remove the final bucket; a failed move rolls back all task/bucket changes.

**SRS-TASK-03 | P1.** Custom fields shall validate typed values, dropdown options and requiredness. Incompatible type/option changes shall be blocked or require an explicit migration. Archived fields retain historic values without remaining required. **Acceptance:** invalid dates/numbers/options are rejected; field edits do not invalidate existing active tasks silently.

**SRS-TASK-04 | P1.** Saved views shall retain supported filters, sorting and page-size settings for the current user and team. **Acceptance:** reopening a saved view restores its query, rejects unknown query keys and does not expose it to another member.

## 6 CV storage requirements

### 6.1 Safe provider transition

The S3 baseline issues a private signed POST, validates a versioned object and signs a short-lived download for that exact version. The selected Blob target has a different integrity model: pin the digest and exact size of validated bytes and verify the entire fetched object before releasing any download slice. This provides detection and rejection of changed bytes, but does not recover a previous version if the object is replaced or deleted. Availability and backup requirements remain separate.

Sources: [storage adapter](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/lib/storage.ts), [Blob security design](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/blob-security-design.md), [Blob quota design](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/blob-quota-design.md).

**SRS-CV-01 | P0.** Every stored reference shall identify provider, environment, store/bucket binding and immutable validation reference. S3 VersionId and Blob SHA-256 shall be typed separately. **Acceptance:** changing the global provider setting cannot reinterpret an existing reference or expose it from another store; mismatch fails closed.

**SRS-CV-02 | P0.** An upload reservation shall authenticate the current user/token, verify team/candidate/scope, validate bounded metadata and generate the pathname server-side. File size shall be 1–10,485,760 bytes. Supported baseline formats are PDF, DOC, DOCX, Pages, JPG/JPEG and PNG, subject to actual signature/container checks. **Acceptance:** wrong extensions/MIME, path traversal, control characters, oversize and cross-team references fail before a ticket is issued.

**SRS-CV-03 | P0.** Blob upload capabilities shall be short-lived, private, exact-path and method-constrained, disallow overwrite/random path changes, and cap bytes at the reservation. The browser shall send no application token/cookies to the provider. **Acceptance:** synthetic live tests cover replay, method substitution, size/type/path changes and no-overwrite behavior; undocumented guarantees remain release blockers.

**SRS-CV-04 | P0.** Completion shall reauthorize, fetch bounded complete bytes without cache, check exact size/media/format, compute SHA-256 on those same bytes and commit the validated reference once. **Acceptance:** concurrent completion is idempotent; missing, truncated, substituted, malformed or timed-out files never become ready. A client-supplied hash or callback alone cannot establish validation.

**SRS-CV-05 | P0.** Blob downloads shall reauthorize every request, read and verify the entire object against the trusted stored hash and size before returning any bytes. The proposed protocol uses slices no larger than 4 MiB to fit hosting constraints, which must be reverified before release. **Acceptance:** replacing the object between chunks returns no invalid slice; revoking access between chunks blocks subsequent chunks; client assembly rejects missing, duplicate, reordered, oversized or inconsistent slices and verifies the full digest before offering a file.

**SRS-CV-06 | P0.** Downloads shall be attachment-safe, private/no-store, non-executable and protected from header injection. Provider URLs/tickets shall not enter logs, analytics, exports or long-lived UI state. **Acceptance:** malicious filenames cannot create headers, inline execution or paths; unauthorized users cannot obtain metadata or download bytes.

**SRS-CV-07 | P0.** Team and store allocation shall be checked atomically before issuance with consistent lock ordering and durable charges. The initial 1 GB planning preference recorded in the BRD shall be translated into approved byte/file allocations before release; the source default of 10 GiB and 10,000 files per team shall not be treated as that approval. Confirm decimal GB versus binary GiB and whether the envelope is per store or shared across Preview/Production. Logical quota, physical usage and billing exposure shall be labeled separately. **Acceptance:** simultaneous uploads across teams cannot oversubscribe configured allocation; crash/timeout after issuance retains the charge; a rejected/expired Blob upload does not free reusable allocation while a valid/in-flight capability could still create an object.

**SRS-CV-08 | P0.** Cleanup/reclamation shall require a proven safe provider condition and verified deletion, with retry and reconciliation. Until that condition is established, an issued Blob path/charge shall not be reused or released. **Acceptance:** late completion, uncertain deletion, replay after deletion and abandoned multipart behavior cannot create unaccounted allocation; unresolved provider guarantees keep Blob disabled.

**SRS-CV-09 | P1.** Candidate profiles shall list multiple CVs with original filename, media, bytes, status and dates, with complete pagination totals. Source paths shall remain relative historical metadata. **Acceptance:** multiple files do not inflate candidate count; no UI claims to open the cloud server's or user's Windows folder.

**SRS-CV-10 | P0.** Format validation shall never be described as malware scanning. Before real untrusted intake, the organization shall approve quarantine/scan and release policy. **Acceptance:** pending/rejected/unscanned files are handled according to that policy; scan failures and provider outages cannot silently mark a file safe.

### 6.2 Upload state and invariants

Observed S3 persistence uses `pending`, `ready` and `rejected`, with expiry interpreted through timestamps and rejection cleanup. The Blob target shall use a separate allocation lifecycle so file usability cannot erase accounting:

- **File lifecycle:** reserved/pending → validating → ready, rejected or expired. Ready is reached only after successful validation. Validation retry may return to pending with an error reason but cannot return bytes early.
- **Allocation lifecycle:** reserved → committed/retained → reclaimable → released. “Reclaimable” requires proved provider conditions; it is not implied by file expiry or rejection.
- **Idempotency:** same actor/team/upload identity plus same payload returns the original logical reservation/path. A changed payload conflicts. Uncertain outcomes are reconciled before starting a new identity.
- **Accounting:** each ticket/path is charged once; completion moves, rather than duplicates or drops, its charge. Team deletion, candidate archive or metadata cleanup cannot remove a live store charge.
- **Integrity:** provider identity, store, path, digest/version, exact bytes and candidate/team binding are immutable after ready. Replacing a CV creates a new version/reference.

## 7 Bulk intake and optional extraction

### 7.1 Reviewed bulk CV intake

The observed UI provides a multi-file review queue, manual candidate fields, contact duplicate checks, per-field suggestion helpers and sequential import. Selected files/review drafts are currently browser-memory state, not a proven durable server job. Its upload protocol is still S3-shaped. The current capability endpoint explicitly returns `uploadsAvailable: false` and `aiAvailable: false`, and requires both candidate-write and CV-write scopes. These are useful foundations, not evidence that Blob bulk intake works.

**SRS-BULK-01 | P1.** Bulk intake shall show every selected file as an independent queue item with validation status and editable candidate draft. It shall not create candidates merely by selecting files. **Acceptance:** invalid files stay individually visible with specific errors; unrelated valid items remain reviewable; closing warns about unsaved review state.

**SRS-BULK-02 | P0.** Import shall require current storage capability, a valid candidate name, completed duplicate review, completed factual review and no unresolved suggestions. **Acceptance:** capability loss or permission revocation immediately disables new work; missing review cannot be bypassed with a direct API call for any server-enforced review workflow.

**SRS-BULK-03 | P1.** A possible duplicate shall offer an explicit existing-candidate attachment path or a deliberately confirmed separate record, without automatic merging/overwriting. **Acceptance:** selecting an existing candidate adds a new CV only; uncertain contact matches do not overwrite facts; within-queue duplicate warnings appear before creation. Existing-candidate attachment is a target requirement to verify/complete, not assumed finished in the current bulk UI.

**SRS-BULK-04 | P0.** Candidate creation, upload reservation and completion shall use stable per-item identities and maintain the created candidate ID after partial failure. **Acceptance:** a lost create response can be retried with the unchanged idempotency key; upload failure shows “candidate created, CV pending” and retry attaches to that candidate rather than creating another.

**SRS-BULK-05 | P1.** The queue shall support cancel, retry failed items and a final itemized summary of created candidates, attachments, skipped items, unresolved failures and uncertain outcomes. Cancellation shall stop new work without claiming already committed work was rolled back. **Acceptance:** repeated clicks and cancel during create/upload/validation do not produce duplicates; completed items remain reconciled.

**SRS-BULK-06 | P1.** Before enabling large batches, batch count/total-byte/concurrency limits and recovery lifetime shall be configured and documented. A proposed initial envelope is 50 files per batch, one active upload per browser and 24-hour server recovery metadata, with file bytes never persisted to browser local storage. **Acceptance:** limits are visible before work begins; after the retention boundary the UI requires reconciliation instead of unsafe replay. These values need product/provider capacity approval.

### 7.2 Optional AI document processing

The inspected extraction schema accepts only a bounded set of factual fields: name, email, phone, job title, employer, university, degree name, major, skills and certifications. Null means unknown and is not a value to save. The task reports later local timeout/cancellation handling, but no connected provider or automatic document processing.

**SRS-AI-01 | P0.** AI shall be off by default and independently configurable from uploads. Before each authorized processing action or explicitly bounded batch, the user shall see provider, files/data sent, purpose, relevant retention/region information, cost limits and a clear choice to continue manually. **Acceptance:** declining leaves manual intake usable; upload alone does not transmit content to AI; missing consent or changed provider/purpose blocks transmission.

**SRS-AI-02 | P0.** Processing shall require current candidate/CV authorization and verified document bytes; it shall minimize extracted content sent externally and apply any approved sensitive-data restrictions. **Acceptance:** a revoked token, wrong team, unvalidated file or mismatched hash cannot be processed; no secrets, hidden account state or other candidates' records enter the request.

**SRS-AI-03 | P0.** Extracted output shall be treated as untrusted structured suggestions, schema-validated and tied to source digest, request ID, provider/model and timestamp. Document instructions shall never override application instructions or authorize actions. **Acceptance:** unknown keys, unsupported types, oversized fields, tool instructions and malformed output are rejected safely; missing facts remain unknown; no hiring score or protected-attribute inference is generated.

**SRS-AI-04 | P0.** Each suggested field shall support accept, reject or edit with source evidence when available. Existing human edits shall not be overwritten by a delayed response. **Acceptance:** a result for an earlier file/draft/request is discarded; all unresolved suggestions block final reviewed import; saving records only human-approved factual values and review provenance.

**SRS-AI-05 | P0.** Extraction shall enforce configurable file/text/token/request/batch/spend limits, request deadlines, cancellation and bounded retries. Retries shall not send duplicate provider work after an uncertain outcome unless reconciled or explicitly allowed under the budget. **Acceptance:** timeout, cancellation, quota exhaustion, rate limit, provider failure and invalid response produce distinct recoverable states; no partial result is silently saved.

**SRS-AI-06 | P0.** AI shall not rank, shortlist, reject, hire, infer sensitive traits or make employment decisions. External AI clients using API tokens remain independently authorized clients and require explicit permissions appropriate to their data use. **Acceptance:** extraction endpoints cannot mutate hiring outcomes, and the UI labels suggestions as unverified until reviewed.

**SRS-AI-07 | P1.** Provider configuration, consent records and processing provenance shall support audit and withdrawal for future processing. Retention/deletion policy shall cover original files, extracted text, suggestions and provider-held copies where contractually supported. **Acceptance:** withdrawal prevents new jobs; the UI explains already completed transmissions and does not promise retroactive deletion without provider evidence.

## 8 Data model and persistence

### 8.1 Existing logical model

| Entity                          | Main fields and relationships                                                                       | Integrity requirements                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| User                            | ID, name, unique email, verification state, timestamps                                              | Identity plane only; passwords/tokens never returned in business DTOs         |
| Session/account/verification    | Better Auth state linked to user                                                                    | Provider-managed semantics, revocation and expiry                             |
| Organization/member/invitation  | Team ID, user, role; invitation email/role/status/expiry                                            | Unique membership; last-owner and recipient binding                           |
| API token/rate limit            | Token hash, display prefix/name, user/team, scopes, expiry/revocation/last use                      | Plaintext shown once; effective role intersection; durable rate counters      |
| Recruitment record              | UUID, team, kind, JSONB data, version, references, creator, timestamps, archive, import metadata    | Strict kind schema; same-team, correct-kind references; optimistic locking    |
| Candidate state                 | Team, user, candidate, shortlist/status/note, version                                               | Composite private ownership; no cross-user reads                              |
| CV upload                       | UUID, team/candidate, filename/media/size, status, object reference, source metadata, creator/dates | Ready-only reads; provider-specific immutable validation reference            |
| Storage usage                   | Team byte/file used/reserved/max values                                                             | Nonnegative totals; atomic reservations; not by itself a physical billing cap |
| Activity                        | Team, record, actor/type/token ID, action/kind/summary/metadata/time                                | Append-only; transaction-bound record mutation; no note/token secrets         |
| Idempotency                     | Team, actor key, operation, key, payload hash, result, expiry                                       | Unique logical operation; changed payload conflict                            |
| Notification read               | Team, user, genuine reminder key, read time                                                         | Private state; cannot invent arbitrary reminder IDs                           |
| Initial admin/connection marker | Durable setup claim; operator-controlled database marker                                            | Runtime cannot forge/reset ownership or paired-database identity              |

Application references: application → candidate + vacancy; vacancy → optional job role; task → bucket plus optional candidate/vacancy; interview/offer/onboarding → application; checklist → onboarding; comment → parent record. Saved views use the generic record table with private owner. Composite team/record constraints shall supplement application validation.

### 8.2 Required additions and schema rules

**SRS-DATA-01 | P0.** All protected rows and references shall include tenant identity; private rows shall include owner identity. Tenant assertions shall be trusted at the policy boundary, not merely copied from caller-controlled settings. **Acceptance:** cross-tenant foreign keys, forged team/user context and private-row reads fail using the actual restricted data role.

**SRS-DATA-02 | P0.** Mutations shall validate strict schema, increment version and atomically commit corresponding audit and idempotency result. **Acceptance:** stale versions return 409 without data loss; simulated audit failure rolls back the business mutation; unknown fields and client-supplied actor/team ownership cannot be saved.

**SRS-DATA-03 | P1.** Dates shall distinguish UTC instants from date-only values. Experience shall distinguish explicit statements and documented estimates. Offer amounts shall avoid floating-point money arithmetic. **Acceptance:** date-only values do not drift through timezone conversion; unknown numeric values do not become zero.

**SRS-DATA-04 | P0.** Blob implementation shall add provider/store/environment reference fields, validation digest/size, durable ticket/allocation ledger, store-wide budgets and cleanup/reconciliation state. Constraints shall prevent illegal transitions and duplicate charges. **Acceptance:** migration fixtures preserve every existing S3 reference, and application startup refuses a partially migrated/mismatched storage schema.

**SRS-DATA-05 | P1.** Durable intake/extraction shall use explicit batch/item/job/consent/review records where server recovery is enabled. Store minimal metadata, source digest, lifecycle/version and reviewed fields, not provider credentials or unnecessary document text. **Acceptance:** recovery does not attach an old result to a changed file, reveal another user's draft, or replay an already committed item.

**SRS-DATA-06 | P1.** Migrations shall be versioned, forward-tested, backed up when required, and run with an operator connection outside runtime. Destructive changes require a reviewed recovery plan and reconciliation counts. **Acceptance:** upgrading a populated fictional baseline preserves relationships, audit, private ownership, monetary values and CV identity; failed migration leaves an understood recoverable state.

### 8.3 Field bounds and defaults

Preserve or explicitly version existing API bounds: candidate name 300 characters; email 320; phone 100; long notes 10,000; comments 4,000; job title/employer/education labels 500; tags up to 300 entries of 200 characters; ordinary source metadata at most 200,000 serialized bytes, 20 nesting levels and bounded nodes; list page size 1–100; JSON body 256 KiB by default. Extraction has tighter 100-entry tag arrays. Task custom values are typed by field definitions. Defaults apply on create, not to omitted PATCH fields.

## 9 APIs and integration contracts

### 9.1 Common contract

**SRS-API-01 | P0.** Protected API calls shall resolve either a valid Bearer token or a verified session. Presence of an invalid Authorization header shall never fall back to session privileges. `X-Team-Id` is optional for a session with an active team and cannot override a token's fixed team. **Acceptance:** malformed/expired/revoked credentials, conflicting team headers and stale membership are rejected consistently.

**SRS-API-02 | P0.** Cookie-authenticated mutations shall require the exact environment origin and safe fetch-site policy. JSON endpoints shall enforce streamed byte limits, valid UTF-8, content type and strict body/query schemas. **Acceptance:** cross-site writes, repeated/unknown filters, malformed JSON and streamed oversized requests fail before business mutation; no permissive cross-origin policy is introduced.

**SRS-API-03 | P1.** Responses shall use `{data: ...}` for records, `{data: [...], pagination: {page, pageSize, total, totalPages}}` for ordinary lists and `{error: {code, message}}` for failures. Additive metadata shall be documented. **Acceptance:** clients handle empty lists, safe errors and pagination without parsing free-form text; private APIs return no-store/nosniff headers.

**SRS-API-04 | P0.** Creates shall support actor/team/operation-scoped `Idempotency-Key`; updates shall require the latest `version`. After an uncertain result, clients shall reuse the original key and identical payload or reconcile first. **Acceptance:** identical replay returns the original result, changed-payload replay returns 409, and expired-key recovery cannot blindly duplicate a candidate.

**SRS-API-05 | P1.** OpenAPI shall cover every supported route, schemas, security, scopes, query bounds and response/error shapes, and shall distinguish disabled features and provider-specific upload/download protocols. **Acceptance:** contract tests compare handlers with the specification; Blob enablement cannot ship while docs/clients/importer still assume S3 fields.

### 9.2 Observed route inventory

| Route                                                    | Methods and purpose      | Key contract                                                                      |
| -------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `/api/auth/*`                                            | Better Auth handlers     | Interactive account/session/team flow, guarded by auth policy                     |
| `/api/v1/{resource}`                                     | GET list; POST create    | Resource is one of the 13 kinds listed below; explicit read/write scope           |
| `/api/v1/{resource}/{id}`                                | GET; PATCH               | Version required for PATCH; archive/restore via fields, not hard delete           |
| `/api/v1/candidates/{id}/state`                          | Personal follow-up state | Versioned, current user/team only                                                 |
| `/api/v1/candidates/duplicates`                          | Possible contact matches | Bounded, authorized team; no automatic identity decision                          |
| `/api/v1/applications/bulk`                              | Bulk vacancy assignment  | Up to 500 candidate IDs; current permission/parent checks                         |
| `/api/v1/candidates/{id}/cvs`                            | GET CV metadata          | `cvs:read`; full pagination; no raw storage keys                                  |
| `/api/v1/candidates/{id}/cvs/uploads`                    | POST reservation         | `cvs:write`; metadata + clientUploadId; current response is S3-shaped             |
| `/api/v1/cvs/uploads/{id}/complete`                      | POST validation          | Reauthorization; idempotent completion                                            |
| `/api/v1/cvs/{id}/download`                              | GET download access      | Current S3 response `{url, expiresAt}`; Blob needs an explicit different contract |
| `/api/v1/cvs/bulk-capabilities`                          | GET capability           | Upload/AI availability; storage readiness must be truthful                        |
| `/api/v1/overview`, `/analytics`, `/activity`, `/search` | GET summaries/search     | Scope-filtered and team-scoped; private data excluded                             |
| `/api/v1/notifications`                                  | GET; POST read state     | Genuine current keys; token reads/writes require corresponding recruitment scopes |
| `/api/v1/teams/bootstrap`                                | Workspace initialization | Human-session authorization and idempotent setup                                  |
| `/api/settings/tokens`, `/api/settings/tokens/{id}`      | Token lifecycle          | Human session; one-time plaintext creation; revocation                            |
| `/api/openapi.json`                                      | GET documentation        | No secrets, examples use fictional data                                           |

Generic resources: `candidates`, `job-roles`, `vacancies`, `applications`, `buckets`, `task-fields`, `tasks`, `interviews`, `offers`, `onboarding`, `checklist`, `views`, `comments`. Source: [OpenAPI route](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/app/api/openapi.json/route.ts) and repository API route tree. Route presence does not establish hosted availability.

### 9.3 Proposed provider-neutral contracts

These contracts are requirements for implementation/design approval, not currently deployed APIs:

- **Upload reservation response:** `{data: cvMetadata, upload: null | {protocol, method, url, headersOrFields, expiresAt, maxBytes}}`. Protocol is an explicit tagged union such as `s3-form-v1` or `blob-put-v1`; clients never infer it from a hostname. Provider capabilities remain transient and secret. Ready replay returns `upload: null`.
- **Blob download manifest:** an authenticated endpoint returns `{uploadId, sizeBytes, sha256, chunkSize, chunkCount, originalName, contentType}` without a raw provider URL. The manifest's authorization does not authorize later chunks by itself.
- **Blob chunk read:** proposed `/api/v1/cvs/{id}/chunks?index=N` returns an authorized bounded binary slice with trusted offset/size/digest metadata. Invalid index/offset/count is rejected; each request verifies the full object before release. The browser checks manifest consistency and final SHA-256. The final route name must be frozen in OpenAPI before integration.
- **Extraction job create:** proposed `/api/v1/extraction-jobs` accepts a validated CV ID/digest, consent record, bounded field set and idempotency key; returns 202 plus job ID/state. Status/read/cancel operations enforce the same tenant and current authorization. Suggestions never write the candidate directly.
- **Review/save:** reviewed values are submitted through existing candidate APIs or a documented batch commit operation with candidate version and immutable review provenance. Server-side review evidence must not be represented by an unverified client checkbox alone where a processing audit is required.

### 9.4 Token requirements

**SRS-TOK-01 | P0.** Tokens shall contain at least 256 random bits, store only a hash and display safe metadata. Creation shall allow only current-role scopes, with default 30-day expiry and maximum 365 days. **Acceptance:** plaintext is returned once; list/audit/log output cannot recover it; a viewer cannot obtain write scopes and recruiter cannot obtain imports scope.

**SRS-TOK-02 | P0.** Every token request shall intersect granted scopes with the creator's current role, verification, membership, revocation and expiry. A write scope does not imply read. **Acceptance:** role demotion/removal/revocation affects the next operation; token cannot manage accounts, invitations, ownership or other tokens.

**SRS-TOK-03 | P0.** Per-token authenticated traffic shall preserve the observed persistent 60 requests/minute limit unless a reviewed version changes it. Additional session/provider/store budgets shall protect expensive work. **Acceptance:** counters survive multiple application instances; 429 includes Retry-After; retries use bounded backoff and do not exceed extraction/download concurrency budgets.

**SRS-TOK-04 | P0.** Token create/revoke and their audit evidence shall be atomic or use a formally specified transactional outbox with durable delivery and clear UI semantics. **Acceptance:** token mutation cannot commit without durable audit intent; rollback/concurrency tests cover token caps, revocation, audit failure and duplicate outbox delivery. Two independent commits are not accepted as atomic.

### 9.5 Error and recovery catalog

| Condition                                            | HTTP/state                       | Required user/client behavior                                                           |
| ---------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| Invalid schema/query/reference                       | 400                              | Highlight safe field errors; preserve draft; no blind retry                             |
| Missing/expired/revoked identity                     | 401                              | Reauthenticate; retain only safe local draft; no automatic repeated writes              |
| Missing role/scope/team/verification or wrong origin | 403                              | Explain unavailable action without leaking another tenant's existence                   |
| Missing/inaccessible record                          | 404                              | Show unavailable; do not reveal cross-team details                                      |
| Version, unique, reference or idempotency conflict   | 409                              | Preserve draft; reread and reconcile; show created-existing result where relevant       |
| Oversized body/file                                  | 413                              | Show limit before retransmission                                                        |
| Non-JSON content at JSON endpoint                    | 415                              | Correct content type; no mutation                                                       |
| Rate/budget limit                                    | 429 or defined quota conflict    | Respect Retry-After/backoff; show which permitted allowance is exhausted                |
| Missing configuration/security guard                 | 503                              | Disable action and show setup-required state; never fall back to another provider       |
| Provider timeout/unavailable                         | 503 or asynchronous failed state | Retain reference and accounting; retry/reconcile safely                                 |
| Unexpected server failure                            | 500                              | Safe generic message plus correlation ID; outcome may be uncertain                      |
| Hash/size mismatch, malformed file, unsafe archive   | Rejected file/security error     | No bytes released; preserve audit and charge; investigate/reupload as appropriate       |
| Cancelled request/job                                | Cancelled/uncertain per stage    | Stop new work; reconcile committed work; do not claim cancellation undid remote effects |

Existing CV error codes include uppercase `STORAGE_SETUP_REQUIRED`, `STORAGE_UNAVAILABLE` and `INVALID_CV`, while general errors use lowercase codes. Compatibility shall be preserved or deliberately versioned; clients should not assume uniform casing. Correlation IDs and standardized asynchronous codes are required additions, not claimed current behavior.

### 9.6 External integration boundaries

| Integration                  | Allowed data and purpose                                                                                                 | Failure and isolation contract                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neon PostgreSQL              | Identity/session/team state through the identity connection; recruitment metadata through the restricted data connection | Verified TLS; matching environment/database binding; separate role privileges; transaction timeout; fail closed on unsafe roles or mismatched pools                        |
| Private Vercel Blob          | Explicitly authorized CV bytes and opaque server-generated paths                                                         | Separate Preview/Production stores; transient narrow upload capability; no raw private download URL bypassing integrity checks; retained accounting on uncertain outcomes  |
| Legacy S3 adapter            | Existing explicitly bound versioned CV references if retained                                                            | Version-specific reads; no automatic fallback from Blob; separate configured credentials/bucket; migration must preserve historical references                             |
| Resend                       | Account verification, password reset and invitation recipient plus required account-link content                         | No CVs or recruitment records; environment-correct links; distinguish request acceptance from delivered email; safe resend/rate limits and recovery after provider failure |
| Google/Microsoft             | User-chosen optional authentication exchange and minimum identity claims                                                 | Separate environment callbacks; no automatic account linking/team grant by email; disabled if missing configuration; actual provider acceptance tests                      |
| Optional extraction provider | Only consented validated document content/approved text and bounded extraction instructions                              | Separate server credentials, recipient/region/retention policy, spend/rate limits, job timeout and human-reviewed output; no automatic provider substitution               |
| Authorized API client        | Only records/documents covered by its explicit current scopes and team                                                   | Client stores its token securely; revocation/expiry/rate limits; no implicit push of data to the client or to an AI provider                                               |

No email, messaging, calendar, analytics or extraction integration may be inferred from a UI label. New external recipients, provider changes or expanded data use require an updated interface contract, privacy review and the appropriate authorization before enablement.

## 10 Security and privacy controls

### 10.1 Threat model

Protect against unauthorized users, cross-team access, malicious file contents, forged client fields, leaked/replayed capabilities, stale permissions, inconsistent provider state and compromise of the recruitment-data SQL role. The target identity boundary specifically addresses arbitrary SQL execution on that restricted role. It does not claim protection from a compromised database owner, trusted identity service, signing key, operator or entire application process. Existing tests identifying forged context do not establish an exposed public SQL-injection vulnerability.

**SRS-SEC-01 | P0.** Hosted runtime shall use separate nonowner identity and recruitment-data roles with no inheritance/assumption path between them or to privileged roles. Migration-owner credentials shall be absent from runtime. **Acceptance:** actual Neon inspection verifies effective direct, inherited, PUBLIC and default grants, role attributes, ownership, function/view access and SET ROLE denial in both environments.

**SRS-SEC-02 | P0.** Recruitment-data SQL shall not mint accepted sessions/tokens, mutate membership or read credential material. Identity access shall not broadly read recruitment records. Narrow activity-name/audit accessors shall expose only the authorized data. **Acceptance:** synthetic attack tests under real restricted connections cannot manufacture a valid token, change a user/team or read another user's auth secrets; legitimate activity still works.

**SRS-SEC-03 | P0.** All protected RLS paths shall rely on independently trusted identity/context, not mutable `app.team_id`/`app.user_id` settings alone. Any signed context shall bind environment, actor, team, action/scope, expiry and replay policy. **Acceptance:** changing GUCs, replaying claims after savepoint rollback, pooled connection reuse, expired assertions and revoked tokens cannot cross tenants or private owners. A protected setter that only writes forgeable GUCs is insufficient.

**SRS-SEC-04 | P0.** Privileged helpers shall have controlled ownership, fixed search paths, explicit schemas, narrowly granted execution and tested error behavior. Signing/assertion secrets shall never appear in SQL settings, bind logs, errors or client responses. **Acceptance:** review verifies indirect privilege paths and key rotation; denied access is not bypassed through alternate helpers.

**SRS-SEC-05 | P0.** All app/provider/database communication shall use verified TLS. Secrets shall be server-only, environment-specific and rotated through an approved process. **Acceptance:** no credentials in repository, NEXT_PUBLIC variables, browser bundles, screenshots, logs or exported artifacts; wrong-environment credentials fail startup/isolation checks.

**SRS-SEC-06 | P0.** Files and rendered data shall be treated as untrusted. Enforce output escaping, safe URL protocols, attachment disposition, archive expansion/path limits and bounded parsers; prevent arbitrary server-side URL fetches. **Acceptance:** malicious HTML, JavaScript URLs, traversal, archive bombs and prompt-injection text cannot execute actions or fetch unrelated resources.

**SRS-SEC-07 | P0.** Logs, traces and metrics shall contain opaque IDs and safe event categories, not raw CV text, private notes, personal contact fields, passwords, tokens or signed URLs. **Acceptance:** seeded canary values do not appear in collected logs; error reports retain diagnostic value through correlation IDs and sanitized codes.

**SRS-SEC-08 | P0.** Retention, access, export, offboarding, legal hold and deletion policies shall be approved before real candidate intake. Archiving shall not be presented as erasure. **Acceptance:** a documented deletion workflow covers database rows, originals, versions, extracted text, provider copies where supported, exports and backups, while preserving required audit and live quota charges. No legal-compliance certification is implied by this specification.

**SRS-SEC-09 | P0.** Security review shall cover dependency supply chain, browser CSP/framing, session cookies, CSRF, brute-force controls and failure modes. **Acceptance:** no unresolved critical/high issue remains without documented risk acceptance; the current CSP's inline-script/style allowances are disclosed rather than described as a nonce-based strict CSP.

## 11 Operations migration and analytics

**SRS-OPS-01 | P0.** Local, Preview and Production shall use distinct data, storage, credentials, auth secrets, origins, callback URLs and operator connections. Preview shall contain only fictional/sanitized approved data and shall never auto-clone production candidate data. **Acceptance:** cross-environment users/tokens/storage paths fail; each deployment records its resource bindings without secrets; a copied database marker alone is not accepted as proof of separation.

**SRS-OPS-02 | P0.** Deployment shall use reviewed migrations, a protected Preview verification stage, explicit Production authorization and rollback/disable controls. Code/schema/provider compatibility shall be checked before traffic. **Acceptance:** unsafe or partially configured releases stay unavailable; restoring the last known compatible release does not reinterpret CV references or lose committed data.

**SRS-OPS-03 | P1.** Legacy migration shall default to local dry-run, reconcile Excel/SQLite/source files and produce counts/exceptions before explicit apply. It shall preserve source IDs and provenance, use idempotency and enforce import privileges. **Acceptance:** rerunning apply does not duplicate records; absolute paths/traversal are rejected; unexpected/missing files and ambiguous facts are listed; no historical stage-transition timestamps are invented.

**SRS-OPS-04 | P1.** Import completion shall reconcile planned, created, updated, skipped, missing and failed records/files, with an operator recovery plan. PostgreSQL becomes authoritative after approved cutover. **Acceptance:** editing a legacy workbook does not silently sync; applying a changed migration plan requires deliberate reconciliation; no real data or migration reports enter the public repo.

**SRS-OPS-05 | P1.** Overview/analytics shall distinguish current inventory from observed events. Candidate count, ready-CV count, applications and workflow items shall have separate definitions. **Acceptance:** imported Hired status without an observed hiring event does not create fabricated time-to-hire; zero denominators and missing history show unavailable values rather than zero performance.

**SRS-OPS-06 | P1.** Reminders shall derive from due tasks, interviews, offer expiry, vacancy targets and onboarding, with genuine stable keys and per-user read state. **Acceptance:** reading reminders does not change underlying records; marking a nonexistent key is rejected/ignored safely; timezone and overdue boundaries match Dubai dates.

**SRS-OPS-07 | P0.** Monitoring shall cover availability, denied access, error rates, provider latency, failed validation, retained allocation, reconciliation drift and backup health without personal payloads. **Acceptance:** synthetic failure exercises produce the intended alert and runbook route; operational dashboards distinguish logical allocation from actual billed usage.

**SRS-OPS-08 | P0.** Backup/restore shall cover database, CV objects/references, schema versions and required operator configuration with restricted access. **Acceptance:** an isolated restore using fictional data verifies readable validated CVs, relationships, audit and privacy boundaries; restoration does not reactivate revoked sessions/tokens without an explicit policy.

## 12 Nonfunctional requirements

The following numbers are proposed engineering acceptance defaults pending workload and plan approval. They are not current capacity measurements, provider promises or business commitments. Tests shall record environment, region, build SHA, dataset and concurrency.

| ID         | Requirement and proposed measurable target                                                                                                                                                                                  | Acceptance method                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| SRS-NFR-01 | Ordinary list/read p95 ≤1 second and write p95 ≤1.5 seconds at 20 active users against 10,000 candidates, 30,000 applications and 100,000 task/history records; exclude provider transfer and report cold starts separately | Representative load test with query plans, no cross-tenant leaks and no failed invariants     |
| SRS-NFR-02 | Initial authenticated main content p75 ≤3 seconds on documented representative desktop/mobile network; no unbounded full-directory loading                                                                                  | Browser measurement and payload inspection                                                    |
| SRS-NFR-03 | Proposed production service objective 99.5% successful interactive availability per month, excluding approved maintenance; scope and monitoring calculation require owner approval                                          | Synthetic checks and incident ledger; not satisfied by local tests                            |
| SRS-NFR-04 | Proposed RPO ≤24 hours and RTO ≤8 hours for pilot; stricter needs require plan review                                                                                                                                       | Timed isolated restore and documented achieved values                                         |
| SRS-NFR-05 | Every operation has a timeout and bounded bytes/concurrency; proposed API DB deadline 10 seconds and provider processing deadline 60 seconds unless asynchronous                                                            | Stalled I/O, memory and cancellation tests; exact configuration documented                    |
| SRS-NFR-06 | Critical user journeys keyboard-operable with meaningful labels, visible focus, accessible errors and announced state; target WCAG 2.2 AA                                                                                   | Automated checks plus manual keyboard/screen-reader review; no unverified certification claim |
| SRS-NFR-07 | Responsive operation at 360 px mobile width and common desktop widths, 200% zoom, latest two supported Chrome/Edge/Firefox/Safari versions selected at release                                                              | Visual/interruption tests; no essential function limited to dragging                          |
| SRS-NFR-08 | UTC instants, explicit Asia/Dubai baseline display, Unicode-safe names/text and date-only integrity                                                                                                                         | Boundary tests with multilingual fictional names and timezone/day changes                     |
| SRS-NFR-09 | Concurrent edits, idempotent retries and partial failures shall not lose committed records or double-count allocations                                                                                                      | Multi-connection race, crash and replay tests                                                 |
| SRS-NFR-10 | Core flows remain usable without AI; configuration/provider outage has safe, understandable degraded states                                                                                                                 | Disable AI/mail/storage independently and verify supported manual/read-only behavior          |
| SRS-NFR-11 | Maintainability through strict typing, schema/contract tests, lint/build checks, reviewed migrations and dependency lockfile                                                                                                | Required CI checks tied to final commit, documented module ownership and update process       |
| SRS-NFR-12 | Cost/resource safety through approved store/team/provider budgets, transfer/request monitoring and bounded batch/download amplification                                                                                     | Budget exhaustion and reconciliation tests; no claim that app quotas are a hard billing cap   |

## 13 Verification and release acceptance

### 13.1 Existing evidence and its limits

The pinned repository's validation document reports local fictional-data tests and explicitly says hosted identity, live Neon/Blob integration and interactive accessibility checks remain incomplete. The later task completion report states production build, TypeScript, lint, **219 application tests and 52 storage tests** passed, with one application test skipped, after local cancellation work. Those are **reported local results**, not tests executed for this SRS, not a remote-CI certification and not evidence of deployment. Earlier counts in repository documentation describe earlier revisions and must not be added together.

No test in this specification is marked passed merely because a test file exists. PGlite tests and fake-provider tests cannot establish live Neon privilege behavior, multi-connection contention, provider replay guarantees, delivered email or actual browser interaction. Source: [validation record](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/validation.md) and the existing project task's latest report.

### 13.2 Test suites and requirement coverage

| Suite ID | Scope and minimum cases                                                                                                                                                                       | Linked requirements                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| T-ID     | Verified/invitation-only signup, bootstrap races/recovery, reset/resend, session revocation, optional OAuth, invitations and last owner                                                       | SRS-ID-01 through 06; SRS-TOK-01 through 04                                          |
| T-DOM    | All kind schemas, references, dates/money, partial PATCH, unique active records, archive/restore, custom fields/buckets                                                                       | SRS-CAN-01 through 08; SRS-REC-01 through 09; SRS-TASK-01 through 04; SRS-DATA-02/03 |
| T-API    | Every route/method/scope, origin/body/query limits, errors, list totals, OpenAPI agreement, stale writes and idempotent replay                                                                | SRS-API-01 through 05; SRS-TOK-01 through 03                                         |
| T-TENANT | At least two teams and two users per team under actual restricted roles; arbitrary GUCs, identity mutation, private rows, joins, claims, savepoint replay, pool reuse and revocation          | SRS-ARC-01/02; SRS-DATA-01; SRS-SEC-01 through 04                                    |
| T-CV     | Real private Preview provider using fictional files, 1 byte/10 MiB boundaries, metadata/signatures, ticket replay, mutation between read/commit/chunks, cancellation and malformed containers | SRS-CV-01 through 10; SRS-ARC-04                                                     |
| T-QUOTA  | Independent concurrent connections, cross-team/store contention, crash before/after issuance, late completion, retained charges, cleanup and reconciliation                                   | SRS-CV-07/08; SRS-DATA-04; SRS-NFR-09/12                                             |
| T-BULK   | Mixed valid/invalid batch, duplicate contacts/within-batch matches, existing candidate attachment, response loss, retry, close/cancel/navigation and permission changes                       | SRS-BULK-01 through 06                                                               |
| T-AI     | Consent decline/change/withdrawal, no-provider path, hostile document/output, strict fields, stale response, manual edits, provider timeout/cancel, spend limits and no autonomous decisions  | SRS-AI-01 through 07                                                                 |
| T-OPS    | Dry-run/apply reconciliation, restored backups, environment mismatch, safe rollback, mail delivery, no-production-data Preview and monitoring alerts                                          | SRS-OPS-01 through 08; SRS-DATA-05/06                                                |
| T-UI     | All screens and dialogs, repeated clicks, loading/error/empty states, keyboard alternatives, screen-reader checks, dark/light/system theme and phone layout                                   | SRS-NFR-02/06/07/08/10; SRS-REC-09                                                   |
| T-NFR    | Documented load envelope, p95 latency, cold starts, memory/timeouts, recovery, logs/secrets and cost budgets                                                                                  | SRS-NFR-01 through 12; SRS-SEC-05 through 09                                         |

### 13.3 Release gates

- **GATE-1 Identity and isolation:** reviewed architecture, atomic token/audit behavior, full trusted tenant/private-row policy coverage and actual restricted Neon role/multi-connection evidence. Local guards remain until approved completion.
- **GATE-2 Storage:** typed provider references, complete-byte integrity, authorized download assembly, durable team/store allocation, provider guarantees and synthetic live replay/late-upload/cleanup tests. Blob stays disabled while any hard-guarantee requirement is unresolved.
- **GATE-3 Core user journeys:** sign-in, team selection, candidate-to-onboarding flow, task/custom fields, personal privacy, export, conflict recovery and accessible UI acceptance with fictional data.
- **GATE-4 Operational readiness:** independent Preview/Production verification, mail delivery, backup/restore, incident and deletion policy, monitoring, costs and release/rollback documentation.
- **GATE-5 Optional AI:** selected/approved provider and processing agreement, consent/data policy, budgets, document pipeline, strict suggestions, human review, cancellation and no autonomous decision behavior. AI may remain disabled while the non-AI product releases if all other applicable gates pass.
- **GATE-6 Data cutover:** approved dry-run report, migration authorization, reconciliation and recovery plan. No real CV import before the preceding applicable controls are verified.

Each gate shall retain build SHA, environment/resource identities without secrets, test commands/results, exceptions, reviewer and decision date. Blocking/failed/skipped tests shall remain visible. A test waiver must name the risk, owner, scope and expiry; it cannot silently weaken tenant isolation or authorization invariants.

## 14 Traceability and delivery sequencing

SRS IDs define engineering obligations; BRD IDs define the business need. The [companion BRD](recruitmentos-brd.md) is the product-level source for final prioritization. The [Project Brief](recruitmentos-brief.md) summarizes scope and decisions. The mapping below uses the final BRD IDs; SRS numbering deliberately does not imply one-to-one numerical equivalence. P0 technical safeguards apply whenever the related feature is enabled, including features classified Should or Optional in the BRD.

### 14.1 Functional traceability

| BRD requirement                                    | SRS requirements                              | Test suites        |
| -------------------------------------------------- | --------------------------------------------- | ------------------ |
| FR-ACC-01 Verified controlled sign-in              | SRS-ID-01/02                                  | T-ID               |
| FR-ACC-02 Team selection and isolation             | SRS-ID-05; SRS-DATA-01; SRS-SEC-01/02/03      | T-TENANT, T-UI     |
| FR-ACC-03 Role permissions                         | SRS-ARC-01; SRS-ID-04; SRS-API-01; SRS-TOK-02 | T-ID, T-API        |
| FR-ACC-04 Account recovery and sessions            | SRS-ID-02/06                                  | T-ID               |
| FR-ACC-05 Optional federated sign-in               | SRS-ID-03                                     | T-ID               |
| FR-CAN-01 Candidate master record                  | SRS-CAN-01/04; SRS-DATA-02/03                 | T-DOM              |
| FR-CAN-02 Factual search and filters               | SRS-CAN-02                                    | T-DOM, T-UI        |
| FR-CAN-03 Evidence and provenance                  | SRS-CAN-03; SRS-OPS-03/04                     | T-DOM, T-OPS       |
| FR-CAN-04 Unknown and sensitive attributes         | SRS-CAN-01/03; SRS-AI-03/06                   | T-DOM, T-AI        |
| FR-CAN-05 Experience and ambiguity review          | SRS-CAN-03; SRS-DATA-03                       | T-DOM              |
| FR-CAN-06 Personal follow-up and shared discussion | SRS-CAN-05/07; SRS-DATA-01                    | T-DOM, T-TENANT    |
| FR-CAN-07 Saved views and exports                  | SRS-CAN-08; SRS-TASK-04                       | T-DOM, T-UI        |
| FR-CV-01 Multiple private CV references            | SRS-CV-01/05/06/09                            | T-CV, T-TENANT     |
| FR-CV-02 Format and size validation                | SRS-CV-02/04/10                               | T-CV               |
| FR-CV-03 Private Blob delivery target              | SRS-CV-01/03/04/05; SRS-DATA-04               | T-CV, T-QUOTA      |
| FR-CV-04 Quotas and cleanup                        | SRS-CV-07/08; SRS-OPS-07; SRS-NFR-12          | T-QUOTA, T-OPS     |
| FR-BULK-01 Multi-file review queue                 | SRS-BULK-01                                   | T-BULK             |
| FR-BULK-02 Duplicate review                        | SRS-CAN-06; SRS-BULK-03                       | T-BULK             |
| FR-BULK-03 Human approval of facts                 | SRS-BULK-02; SRS-AI-04                        | T-BULK, T-AI       |
| FR-BULK-04 Per-file progress and outcomes          | SRS-BULK-04/05                                | T-BULK             |
| FR-BULK-05 Safe retry and cancellation             | SRS-BULK-04/05; SRS-ARC-04; SRS-API-04        | T-BULK, T-API      |
| FR-BULK-06 Capability and load limits              | SRS-BULK-02/06; SRS-ARC-02; SRS-NFR-05/12     | T-BULK, T-NFR      |
| FR-AI-01 Explicit optional connection              | SRS-AI-01/02                                  | T-AI               |
| FR-AI-02 Limited factual extraction                | SRS-AI-03/06                                  | T-AI               |
| FR-AI-03 Reviewable suggestions                    | SRS-AI-04; SRS-DATA-05                        | T-AI               |
| FR-AI-04 Failures and usage controls               | SRS-AI-05; SRS-ARC-04                         | T-AI, T-NFR        |
| FR-AI-05 Provider governance and document safety   | SRS-AI-01/02/03/07; SRS-SEC-06/08             | T-AI, T-OPS        |
| FR-REC-01 Reusable job roles                       | SRS-REC-01                                    | T-DOM              |
| FR-REC-02 Vacancy management                       | SRS-REC-02                                    | T-DOM              |
| FR-REC-03 Application relationships                | SRS-REC-03/08                                 | T-DOM              |
| FR-REC-04 Bulk vacancy assignment                  | SRS-REC-04                                    | T-DOM, T-API       |
| FR-REC-05 Explicit application pipeline            | SRS-REC-03/09; SRS-DATA-02                    | T-DOM, T-UI        |
| FR-REC-06 Interviews and calendar                  | SRS-REC-05; SRS-NFR-08                        | T-DOM, T-UI        |
| FR-REC-07 Offer tracking                           | SRS-REC-06                                    | T-DOM              |
| FR-REC-08 Onboarding                               | SRS-REC-07                                    | T-DOM              |
| FR-REC-09 Onboarding checklist                     | SRS-REC-07                                    | T-DOM              |
| FR-TASK-01 Task management                         | SRS-TASK-01                                   | T-DOM              |
| FR-TASK-02 Configurable buckets                    | SRS-TASK-02; SRS-REC-09                       | T-DOM, T-UI        |
| FR-TASK-03 Custom task fields                      | SRS-TASK-03                                   | T-DOM              |
| FR-TASK-04 Safe editing and collaboration          | SRS-DATA-02; SRS-REC-09; SRS-CAN-07           | T-DOM, T-UI        |
| FR-OPS-01 Operational overview                     | SRS-OPS-05                                    | T-DOM, T-OPS       |
| FR-OPS-02 Explainable analytics                    | SRS-OPS-05                                    | T-DOM, T-OPS       |
| FR-OPS-03 Personal reminders                       | SRS-OPS-06                                    | T-DOM, T-API       |
| FR-OPS-04 Recruitment audit history                | SRS-DATA-02; SRS-TOK-04; SRS-SEC-07; DEC-15   | T-DOM, T-ID, T-OPS |
| FR-ADM-01 Team administration                      | SRS-ID-04/06                                  | T-ID               |
| FR-ADM-02 Scoped API tokens                        | SRS-TOK-01/02/03/04; SRS-API-01/05            | T-ID, T-API        |
| FR-ADM-03 Legacy dry run and controlled apply      | SRS-OPS-03/04; SRS-DATA-06                    | T-OPS              |
| FR-ADM-04 Archive retention and deletion           | SRS-REC-08; SRS-SEC-08; SRS-CV-08             | T-DOM, T-OPS       |
| FR-ADM-05 Environment and configuration visibility | SRS-ARC-02; SRS-OPS-01/02; SRS-SEC-05         | T-OPS, T-TENANT    |

### 14.2 Nonfunctional traceability

| BRD requirement                               | SRS coverage                                          | Test suites           |
| --------------------------------------------- | ----------------------------------------------------- | --------------------- |
| NFR-01 Isolation and least privilege          | SRS-SEC-01/02/03/04; SRS-DATA-01; SRS-OPS-01          | T-TENANT, T-OPS       |
| NFR-02 Confidentiality and secret handling    | SRS-SEC-05/06/07; SRS-CV-01/05/06; SRS-TOK-01         | T-CV, T-API, T-NFR    |
| NFR-03 Privacy and responsible employment use | SRS-SEC-08; SRS-CAN-03/05; SRS-AI-01/02/06/07         | T-AI, T-OPS           |
| NFR-04 Integrity and recoverability of writes | SRS-DATA-02; SRS-API-04; SRS-TOK-04; SRS-NFR-09       | T-DOM, T-API, T-QUOTA |
| NFR-05 File safety                            | SRS-CV-02/04/05/10; SRS-SEC-06                        | T-CV                  |
| NFR-06 Performance and capacity               | SRS-NFR-01/02/05; SRS-BULK-06                         | T-NFR, T-BULK         |
| NFR-07 Availability and recovery              | SRS-NFR-03/04/10; SRS-OPS-08                          | T-NFR, T-OPS          |
| NFR-08 Accessibility and usability            | SRS-NFR-06/07/08; SRS-REC-09                          | T-UI                  |
| NFR-09 Observability and support              | SRS-OPS-07; SRS-SEC-07; Section 9.5 error catalog     | T-OPS, T-NFR          |
| NFR-10 Cost containment                       | SRS-NFR-12; SRS-CV-07/08; SRS-AI-05                   | T-QUOTA, T-AI, T-NFR  |
| NFR-11 Portability and maintainability        | SRS-ARC-03/04; SRS-NFR-11; SRS-DATA-06; SRS-OPS-03/04 | T-DOM, T-OPS          |
| NFR-12 Release quality and truthful readiness | SRS-ARC-02; SRS-NFR-11; Section 13 release gates      | All applicable suites |

Suggested implementation order: identity/policy boundary → restricted-role verification → Blob reference/accounting schema → storage provider/client/importer integration → core hosted journeys → bulk failure/recovery → optional AI consent/extraction/review → operational acceptance → approved data cutover. Functional work can proceed locally while security gates are closed; closed gates shall not be removed to demonstrate progress.

The implementation register should contain requirement ID, BRD link, priority, owner, status, pull request/commit, tests, evidence, environment and reviewer. Suggested statuses are not started, implementing, locally verified, Preview verified, accepted, deferred and blocked. “Locally verified” shall never be relabeled “accepted” without its applicable release evidence.

## 15 Assumptions and open decisions

| ID     | Decision or assumption                                                                                                               | Required resolution and impact                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEC-01 | Private Blob is the selected testing storage direction; S3 code still exists                                                         | Confirm whether S3 must remain supported long term and whether any actual S3 references need migration. No silent fallback                                                                                  |
| DEC-02 | Trusted tenant boundary is unfinished                                                                                                | Select and independently review principal-bound DB identities or verifiable assertions; settle replay/savepoint/pool behavior before hosted access                                                          |
| DEC-03 | Token/audit operations cross planned privilege boundaries                                                                            | Choose same-transaction reviewed helper or transactional outbox with explicit visibility/retry semantics                                                                                                    |
| DEC-04 | Blob physical allocation guarantees remain unresolved                                                                                | Obtain current provider guarantees for no-overwrite, replay, in-flight expiry, multipart, deletion/recreation and external writers; retain disablement if the required guarantee cannot be established      |
| DEC-05 | Initial 1 GB planning preference differs from source 10 GiB/10,000-file per-team defaults, and retained charges can exhaust capacity | Confirm units, shared/per-store scope, headroom, file limit and recovery policy. Partition Preview/Production allocation within approved provider budgets; never present application quota as a billing cap |
| DEC-06 | No live AI provider selected/connected                                                                                               | Select provider/model/region, processing terms, retention, deletion, allowed data, budget and approved document/OCR pipeline                                                                                |
| DEC-07 | CV format checks are not malware scanning                                                                                            | Choose scan/quarantine service and release policy before real untrusted intake                                                                                                                              |
| DEC-08 | Retention and lawful processing policies are not specified                                                                           | Organization's responsible privacy/legal owner approves candidate retention, notices, access, export, deletion and legal-hold rules; no default legal conclusion                                            |
| DEC-09 | Browser bulk queue is not durable                                                                                                    | Approve batch size/bytes/concurrency, server recovery lifetime and whether durable drafts are required for pilot                                                                                            |
| DEC-10 | Stage enums exist but no approved restrictive transition graph                                                                       | Decide prerequisites, reopening controls and reason requirements without adding automatic employment decisions                                                                                              |
| DEC-11 | Owner/interviewer labels are currently text in several records                                                                       | Decide whether to retain labels or introduce validated team-member assignment IDs with deactivated-user history                                                                                             |
| DEC-12 | Dubai timezone is the current business default                                                                                       | Confirm whether per-user/team timezone or bilingual/RTL UI is required; neither is assumed implemented                                                                                                      |
| DEC-13 | Performance, availability and recovery values are proposed                                                                           | Approve pilot workload, provider plans, monitoring window, service objective, RPO/RTO and budget                                                                                                            |
| DEC-14 | Notifications are in-app derived reminders                                                                                           | Confirm whether later email/calendar integrations are needed; they require separate recipient/consent and delivery contracts                                                                                |
| DEC-15 | Auth/team changes lack equivalent complete business audit feed in baseline                                                           | Approve event coverage and retention, then implement without exposing auth secrets                                                                                                                          |
| DEC-16 | Test status is local/reported, not deployment acceptance                                                                             | Record final remote SHA and rerun required checks/Preview acceptance before release claims                                                                                                                  |

Assumptions are limited to a team-based internal recruitment product, PostgreSQL as canonical data, explicit human decisions and fictional data for pre-production validation. No budget, go-live date, legal compliance status or production service level is approved by this document.

## 16 Glossary

- **Tenant/team:** An organization workspace and its authorized members.
- **Candidate:** A person record; multiple CV references and applications may belong to it.
- **Application:** A candidate-to-vacancy relationship with an explicit hiring stage.
- **Ready CV:** A document reference that passed the configured validation/release policy; ready is not a malware-free guarantee.
- **RLS:** PostgreSQL row-level security, which must use trusted context to provide the intended boundary.
- **Idempotency:** Repeating the same logical operation returns its established result without creating a second effect.
- **RPO/RTO:** Maximum approved data-loss window and recovery duration, respectively.
- **PGlite:** Embedded PostgreSQL-compatible local test/development database; it does not establish hosted concurrency or provider behavior.
- **Logical allocation:** Application-accounted storage allowance; different from actual provider usage and billing.

## 17 Source register

All repository links below are pinned to the inspected commit. The repository README/user guide describe intended workflows; newer explicit guard/design documents and source checks take precedence over broad feature descriptions when judging hosted readiness.

1. [Repository overview](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/README.md) and [workspace user guide](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/user-guide.md).
2. [Domain schemas and record references](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/domain/records.ts), [record services](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/lib/records.ts), [app schema](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/db/schema.ts) and [auth schema](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/db/auth-schema.ts).
3. [Authentication](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/authentication.md), [permissions](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/lib/permissions.ts), [principal resolution](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/lib/principal.ts) and [token policy](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/lib/api-token-policy.ts).
4. [Identity boundary plan](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/identity-boundary-plan.md), [connection checks](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/db/connection-boundary.ts), [security and data flows](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/security.md).
5. [Blob security design](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/blob-security-design.md), [quota design](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/blob-quota-design.md), [storage adapter](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/lib/storage.ts), [CV service](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/lib/cvs.ts).
6. [Bulk intake UI](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/components/workspace/bulk-cv-import.tsx), [suggestion review](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/components/workspace/bulk-cv-suggestions.ts), [extraction adapter](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/domain/cv-extraction.ts).
7. [API examples](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/api-examples.md), [OpenAPI handler](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/app/api/openapi.json/route.ts), [request/error boundary](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/lib/api.ts).
8. [Migration guide](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/migration.md), [environment isolation](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/environment-isolation.md) and [validation history](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/validation.md).
9. RecruitmentOS implementation report, read on 3 November 2026: local cancellation preparation, reported 219 application and 52 storage passes, one skipped application test, no live provider, push or deployment in that completion. Later task activity must be checked before using this document as a live status report.
