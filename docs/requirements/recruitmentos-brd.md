# RecruitmentOS Business Requirements Document

**Version:** 1.0  
**Date:** 3 November 2026  
**Status:** Requirements baseline for review, not production acceptance  
**Audience:** Product owner, recruitment team, delivery team, security reviewer and service operator  
**Related documents:** [Project brief](recruitmentos-brief.md) and [Software requirements specification](recruitmentos-srs.md)

> **Status note (7 November 2026, not part of the approved baseline):** this note supersedes the hosted-access statements in §1, the §4.3 "Identity and team isolation" row and §16 D-02; the approved text below is unchanged. The blanket block on hosted database access has been removed and replaced by precise fail-closed startup checks ([identity-boundary-plan.md](../identity-boundary-plan.md)). In the owner's run on the Neon Preview database the split runtime role template is applied, `scripts/db-role-evidence.ts` passes with zero drift, and `npm run test:live-roles` passes 27/27 through the transaction-mode pooler and 27/27 direct; the template has changed since that run, and the owner's pending re-applies are listed in the register. Hosted sign-in opens only when every readiness check in [authentication.md](../authentication.md#hosted-sign-in-readiness) holds. A protected Preview deployment exists ([ROADMAP.md](../ROADMAP.md)); there is no Production deployment. Independent review (DEC-02/DEC-03), Production verification and the owner's release decision are still open, Blob CV storage stays disabled and no AI provider is connected. The [requirement register](register.md) is the current status source.

## 1 Purpose and business conclusion

RecruitmentOS is intended to replace a fragmented recruitment process built around CV folders, Excel workbooks and a local dashboard with a shared, controlled recruitment workspace. It must let authorized staff find factual candidate information, preserve the evidence behind it, organize vacancies and applications, manage recruitment work, and track interviews, offers and onboarding. Optional AI should reduce transcription work without making hiring decisions or silently converting uncertain suggestions into facts.

The project has a substantial source-code and locally tested foundation. It is **not yet an accepted hosted service**. Hosted sign-in and database access are deliberately blocked pending identity and tenant-isolation work. The chosen private Vercel Blob path, bulk CV import and external AI extraction remain disabled or unconnected. Passing local tests, connected infrastructure and a successful application build do not establish that these workflows work safely in a deployed environment.

This BRD separates business needs from the current implementation. It defines the outcomes and acceptance evidence required before each capability may be considered delivered. It does not authorize a deployment, a new provider contract, real-CV processing, hiring decisions or disclosure to a third party.

## 2 Baseline and evidence

### 2.1 Baseline rules

- The repository reviewed is [omarals95/RecruitmentOS](https://github.com/omarals95/RecruitmentOS), main revision `d67828ed0889849ea0fc431949288f7c10061dda`.
- The later local implementation report described cancellation and timeout work that had not been pushed or deployed. Those changes are not assumed to be part of the repository baseline.
- Source code establishes what exists in the reviewed revision. Documentation describes intended use, but older deployment instructions can lag later decisions.
- User decisions establish requested direction. Recommendations and proposed acceptance targets in this document are not treated as approved commitments.
- No real CV, candidate record, credential or private attachment is reproduced here. This document does not certify security, legal compliance or absence of vulnerabilities.

### 2.2 Source register

| ID   | Evidence                                                                                                                                                                                                                                                                                                                | Use in this BRD                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E-01 | [Repository README](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/README.md)                                                                                                                                                                                                 | Application scope, cloud transition, migration principles                                                                                                          |
| E-02 | [Workspace user guide](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/user-guide.md)                                                                                                                                                                                     | User journeys and workflow separation                                                                                                                              |
| E-03 | [Domain definitions](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/domain/records.ts)                                                                                                                                                                                    | Actual fields, relationships and status values                                                                                                                     |
| E-04 | [Security and data flows](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/security.md)                                                                                                                                                                                    | Data boundaries, safeguards and known limits                                                                                                                       |
| E-05 | [Validation scope](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/validation.md)                                                                                                                                                                                         | Local evidence versus outstanding live checks                                                                                                                      |
| E-06 | [Migration guide](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/migration.md)                                                                                                                                                                                           | Dry run, provenance, reconciliation and recovery                                                                                                                   |
| E-07 | [API integration guide](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/api-examples.md) and [permissions](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/lib/permissions.ts)                                               | Scoped integration access and role boundaries                                                                                                                      |
| E-08 | [Bulk CV interface](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/components/workspace/bulk-cv-import.tsx) and [capability gate](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/app/api/v1/cvs/bulk-capabilities/route.ts) | Queue, duplicate and review controls; disabled capability                                                                                                          |
| E-09 | [Extraction contract](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/domain/cv-extraction.ts)                                                                                                                                                                             | Provider-neutral suggestions, bounded schema                                                                                                                       |
| E-10 | [Insights implementation](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/lib/insights.ts)                                                                                                                                                                                 | Metric definitions, reminders and historical limitations                                                                                                           |
| E-11 | [Database schema](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/db/schema.ts)                                                                                                                                                                                            | Data entities, private state and quota defaults                                                                                                                    |
| E-12 | User conversation, 3 November 2026, 09:39 UTC                                                                                                                                                                                                                                                                           | Explicit request for bulk CV addition and optional connected AI to extract information into the database                                                           |
| E-13 | User conversation and development status, 3 November 2026                                                                                                                                                                                                                                                               | Private Vercel Blob chosen for testing, separate Preview and Production resources, initial 1 GB planning preference, protected fictional-data deployment direction |
| E-14 | Latest development-task outcome reviewed on 3 November 2026                                                                                                                                                                                                                                                             | Hosted safeguards incomplete; later local changes unpushed; no real CV transmission; live provider acceptance outstanding                                          |

### 2.3 Requirement labels

**C - Source baseline:** The reviewed source or its documentation includes the behavior. This is not a statement of live acceptance.  
**P - Partial or gated:** Some implementation exists, but the capability is disconnected, disabled or incomplete.  
**R - Required target:** A requested capability or necessary business safeguard to deliver it. Implementation or full evidence is not established.  
**D - Decision required:** Scope, policy, operating target or ownership must be confirmed.

Priorities use **Must** for a release prerequisite, **Should** for useful scope that can be scheduled separately and **Optional** for explicitly optional functionality. These are recommended delivery priorities. The product owner must approve the release scope.

## 3 Business problem and objectives

### 3.1 Problems to solve

The earlier process separates candidate facts, source evidence, CV versions, private follow-up and recruitment operations across different files and interfaces. This creates repeated entry, ambiguity over the latest version, weak visibility into work in progress and a risk that source-folder labels or incomplete extraction are mistaken for reliable candidate assessments.

A cloud replacement also creates new responsibilities: authenticated access, separation between teams and environments, private document handling, safe recovery from partial imports, traceable edits and control over external processing. The original offline dashboard's no-network constraint is not a description of the later cloud target. Only the cloud service connections needed for the agreed functionality should be enabled and documented.

### 3.2 Business objectives

| ID    | Objective                                                         | Success evidence                                                                                                                  |
| ----- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| BR-01 | Establish one authoritative recruitment record                    | Approved migration reconciles records and documents; users understand that PostgreSQL is canonical and Excel is a transfer format |
| BR-02 | Reduce time spent locating and transcribing candidate information | Recruiters complete representative search and import tasks; baseline and improvement targets are agreed rather than invented      |
| BR-03 | Make recruitment work visible from vacancy to onboarding          | A fictional candidate can be traced through an application, interview, offer and onboarding with clear owners and statuses        |
| BR-04 | Preserve factual accuracy and human accountability                | Every imported or AI-assisted fact can be reviewed; unknown facts remain unknown; hiring transitions require an authorized person |
| BR-05 | Protect candidate and team information                            | Isolation, role, file-access, export and privacy tests pass in the intended hosted environment                                    |
| BR-06 | Make reporting explainable                                        | Dashboard counts reconcile to source records; historical measures disclose their population, dates and missing evidence           |
| BR-07 | Operate within a controlled cost and recovery envelope            | Storage, extraction budgets, recovery procedures and operating ownership are approved and exercised                               |
| BR-08 | Support controlled growth and integrations                        | Scoped access, revocation, stable imports and environment separation are verified without expanding permissions silently          |

### 3.3 Measures to establish before rollout

Measure current time to locate a candidate, prepare a usable candidate profile, reconcile a batch and produce a vacancy report. Track duplicate-review frequency, failed imports, incomplete profiles, unreviewed AI suggestions, overdue tasks and exception resolution time. Targets, evaluation sample sizes and an observation period are open decisions. The product should not claim a percentage improvement, hiring-quality gain or financial return without measured evidence.

## 4 Scope and boundaries

### 4.1 In scope

- A browser-based, team-scoped workspace with controlled sign-in and account administration.
- Candidate directory, factual search and filters, source evidence, review state, multiple CV versions, private follow-up, shared discussion, saved views and exports.
- Reusable job-role definitions, vacancies, candidate applications and explicit pipeline updates.
- Configurable recruitment task buckets and custom fields.
- Interviews and calendar views, offer tracking, onboarding checklists and reminders.
- Operational overview, analytics and recruitment activity history.
- Restricted API tokens and a controlled, dry-run-first legacy Excel/SQLite migration.
- Bulk CV intake with per-file outcomes, duplicate review, human verification and recoverable partial completion.
- Optional external AI extraction of permitted factual fields after provider selection, authorization and data-handling review.
- Separate local, Preview and Production operation and staged release gates.

### 4.2 Outside the current scope

- Automated hiring, rejection, suitability ranking, personality inference or employment decisions based on protected or sensitive personal traits.
- Unattended AI publication of extracted facts without the review process defined here.
- Payroll, employee HR administration, background-check ordering, visa processing or legal offer execution.
- A public applicant portal, job-board syndication, résumé scraping, unsolicited outreach or automatic email campaigns.
- Two-way synchronization with old Excel workbooks or a cloud button that opens Windows File Explorer.
- Calendar-provider synchronization, automatic meeting invitations or interview recording unless separately requested.
- Electronic signatures, offer-contract generation and financial approvals merely because an offer record exists.
- Guaranteed malware detection through file-format checks alone.
- An enterprise compliance certification, zero-vulnerability guarantee or a contracted availability commitment.

### 4.3 Current capability assessment

| Area                                | Evidence-backed position                                                                    | Remaining business acceptance                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Candidate and recruitment workspace | Broad source implementation and local test history                                          | Hosted role-based, browser and end-to-end validation                                       |
| Identity and team isolation         | Local controls and experiments exist; hosted access deliberately blocked                    | Trusted identity boundary, restricted live roles, concurrency and first-admin verification |
| Storage                             | S3 adapter exists; private Blob is the chosen test direction; Blob gateway remains disabled | Safe authorized upload, immutable validated download, quota and live-provider checks       |
| Bulk intake                         | Browser queue, form review, duplicate checks and retry logic exist                          | Connected storage and enabled server gate; complete end-to-end flow                        |
| AI extraction                       | Strict provider-neutral field contract and review helpers exist                             | Provider, consent/data-processing flow, OCR strategy, budget and connected execution       |
| Legacy migration                    | Dry-run and apply tooling with reconciliation are present                                   | Authorized source selection, backup, real-data approval and final reconciliation           |
| Email                               | Account email flows are implemented around Resend                                           | Current configuration and delivery tests in the actual environment                         |
| Reporting                           | Source supports inventory and observed-history analytics                                    | Reconciled hosted fixtures, permission checks and acceptance by recruiters                 |
| Hosting                             | GitHub merge and checks reported; latest task reports no accepted deployment                | Protected Preview workflow and subsequent production readiness gates                       |

## 5 Stakeholders and actors

The product owner approves scope, policy choices and acceptance. Recruitment representatives validate that the workflows support their daily work. Security and privacy reviewers approve the handling controls within their responsibilities. The operator owns environments, backup, recovery, provider configuration and incident procedures. Named owners and approvers are not yet assigned in this BRD.

| Actor                         | Intended responsibility                                                     | Boundary                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Team owner                    | Team ownership, membership administration and recruitment work              | Only an owner changes ownership; at least one owner must remain                                   |
| Administrator                 | Manage permitted team settings, invitations, imports and integration access | Does not gain unrestricted cross-team or infrastructure access                                    |
| Recruiter                     | Maintain candidate and recruitment records, CVs and personal follow-up      | No legacy import scope or ownership management by default                                         |
| Viewer                        | Read permitted recruitment records                                          | No ordinary recruitment or CV writes; personal read-state behavior is not general edit permission |
| Hiring manager or interviewer | Business participant referenced on vacancies, tasks or interviews           | Current names can be text labels, not dedicated accounts or additional roles                      |
| Candidate                     | Subject of records and source documents                                     | No candidate-facing account or self-service portal is established                                 |
| Authorized integration client | Perform explicitly scoped API operations                                    | Bound to an existing user's current role and one team; cannot administer accounts or tokens       |
| Service operator              | Configure, monitor and recover the service                                  | Privileged operational access is separate from ordinary application roles                         |
| AI extraction service         | Return factual suggestions from authorized documents                        | No independent hiring authority, team administration or direct unreviewed record approval         |

## 6 End to end business workflows

### WF-01 Prepare a safe workspace

1. The operator confirms the environment, exact origin, service configuration and restricted data access.
2. The initial owner completes the approved setup flow and verifies the account email.
3. The owner invites staff with appropriate roles. Each staff member accepts the invitation and signs in.
4. The user selects a team; every displayed and modified record belongs to that context.
5. If a prerequisite is missing or unsafe, the feature stays unavailable and a clear message explains what is blocked.

**Outcome:** An authorized staff member reaches an isolated workspace. **Exceptions:** incomplete first-owner setup, expired invitation, undelivered email, revoked membership or invalid environment configuration.

### WF-02 Migrate existing records

1. An administrator selects approved, stable legacy sources and creates a backup of the destination.
2. A dry run produces counts, mappings, unsupported files, missing evidence and conflicts without uploading data.
3. A responsible reviewer resolves ambiguous links and approves application of the reviewed plan.
4. The importer applies authorized records and private CV uploads with stable identifiers and an exception report.
5. The reviewer compares counts, samples source evidence, verifies private notes and checks document associations.
6. The operator revokes the temporary import token. Originals remain until the retention and recovery policy permits removal.

**Outcome:** Reconciled records in the canonical store. **Exceptions:** changed source files, conflicting destination edits, unsupported formats, uncertain writes or partial upload failure. Partial success is reported, not represented as an all-or-nothing transaction.

### WF-03 Add and review candidate information

1. A recruiter searches existing records before creating a candidate.
2. The recruiter enters or imports factual information, leaving absent values blank or unknown.
3. The recruiter links source evidence and CV versions, resolves ambiguous extraction and records review status.
4. Private follow-up and shortlist state are kept separate from shared discussion and vacancy applications.
5. The recruiter explicitly saves. If another user changed the record, the draft is retained for reconciliation.

**Outcome:** A usable, evidence-backed profile. **Exceptions:** missing contact details, duplicates, contradictory versions, inaccessible CVs and concurrent edits.

### WF-04 Process a bulk CV batch

1. The recruiter selects several supported files; each file receives its own visible status.
2. Invalid or oversized files are flagged without invalidating unrelated files.
3. The recruiter enters permitted fields manually or explicitly chooses an available, approved AI extraction option.
4. Suggested values are reviewed field by field. Duplicate checks compare team contacts and also warn about matching drafts in the selected batch.
5. The recruiter confirms that facts and possible duplicates have been reviewed.
6. Only eligible reviewed items are submitted. The application distinguishes candidate creation from CV attachment and validation.
7. Results identify success, failure and incomplete records. Safe retries reuse the same logical operation rather than creating duplicate candidates.

**Outcome:** Reviewed candidate records with validated CV references. **Current limitation:** import and AI capability flags are false. Queue drafts are browser-held and are lost when closed or switched away; they are not a durable background job.

### WF-05 Manage a vacancy and applications

1. A recruiter creates a reusable role or starts a vacancy directly.
2. Role details may be copied into a vacancy draft; later role edits do not silently change existing vacancies.
3. The vacancy is opened with its requisition, requirements, openings, responsibility labels and target date.
4. Candidates are linked individually or in bulk through applications.
5. Authorized staff explicitly move applications through the pipeline and retain an activity history.
6. Vacancy closure, offer acceptance and hiring stage remain independent updates, with the relevant person responsible for making each decision.

**Outcome:** The team can explain which candidates are being considered for which vacancies and their recorded state. **Exceptions:** duplicate links, archived records, stale edits or an incorrect vacancy association.

### WF-06 Coordinate interviews offers and onboarding

1. An interview is linked to an application with time, duration, interviewer and location or meeting URL.
2. Staff use the calendar and reminders, then manually record completion, cancellation or no-show.
3. An offer record tracks terms and status separately from any legal document or communication.
4. A human records the appropriate application stage. Accepting an offer does not automatically mark an application Hired.
5. Onboarding and its checklist are linked to the application; owners record completed or waived items.

**Outcome:** Recruitment operations can be followed without hidden state changes. **Exceptions:** rescheduling, offer expiry, declined offers, incomplete documents or an empty checklist.

### WF-07 Review performance and operate the service

1. Staff review current inventory, upcoming interviews, overdue work and source-review needs.
2. Analysts select an appropriate date range and read the metric definitions and sample sizes.
3. Administrators review access, tokens, import exceptions, storage and processing budgets.
4. Operators investigate failures with redacted diagnostics and exercise backup and recovery procedures.

**Outcome:** Operational decisions use explainable records rather than inferred historical events or hidden processing.

## 7 Functional requirements and acceptance criteria

The criteria below define required behavior in the accepted environment. A source-baseline label does not close its acceptance tests. All tests involving documents or live services must use fictional data until real-data use is separately authorized.

### 7.1 Access and workspace control

**FR-ACC-01 Verified controlled sign-in - Must - P**  
The service shall require a verified identity and live team membership before granting access to recruitment data. Invitation-based registration and controlled first-owner setup shall be supported.  
**Acceptance:** An unverified, uninvited or removed user cannot read team records. Valid invited users can verify and sign in. Repeating or interrupting first-owner setup does not create competing owners or give unauthorized access. Sources: E-04, E-05.

**FR-ACC-02 Team selection and isolation - Must - P**  
Every business operation shall use a trusted team context. Switching teams shall replace the workspace context and prevent draft or file selection leakage.  
**Acceptance:** Users in two fictional teams cannot read, change, export, download or reference the other team's data by changing identifiers. A team switch cannot submit the previous team's pending draft. Sources: E-04, E-08.

**FR-ACC-03 Role permissions - Must - C**  
Owner, admin, recruiter and viewer permissions shall be enforced on the server, not solely by hiding controls.  
**Acceptance:** A viewer's direct write attempts fail; a recruiter cannot use administrative import privileges; an admin cannot independently transfer ownership; the final owner cannot be removed. Demotion changes access on subsequent requests. Sources: E-04, E-07.

**FR-ACC-04 Account recovery and sessions - Must - C**  
Users shall manage profile information, password recovery and sessions without exposing credentials or account-existence information unnecessarily.  
**Acceptance:** Verification/reset links work only as intended for the correct environment, invalid or expired links fail safely, and session revocation prevents further authorized use. Real delivery remains a required test. Sources: E-02, E-04.

**FR-ACC-05 Optional federated sign-in - Optional - C**  
Google or Microsoft sign-in may be enabled after configuration and testing. It shall not silently grant team membership or link unrelated accounts solely on an email match.  
**Acceptance:** An unconfigured provider is not offered as available. Configured provider flows preserve account and invitation boundaries in staging. Source: E-04.

### 7.2 Candidate records and evidence

**FR-CAN-01 Candidate master record - Must - C**  
The service shall maintain a candidate record with stable identity, factual contact, education, employment, skills and certification information.  
**Acceptance:** A name is required; invalid supplied values are rejected; omitted optional facts remain unknown. A partial edit does not reset unrelated existing fields. Sources: E-03, E-11.

**FR-CAN-02 Factual search and filters - Must - C**  
Users shall find candidates through factual search, quoted phrases, exclusions and available filters including skills, education, experience, source categories and review status.  
**Acceptance:** A controlled fixture returns the expected candidate set; hidden field names are not searchable evidence; empty and no-match states are clear; results remain team-scoped. Sources: E-02, E-03.

**FR-CAN-03 Evidence and provenance - Must - C**  
The service shall preserve original source fields, source reviews, evidence, historical relative paths and import identifiers where relevant.  
**Acceptance:** A reviewer can distinguish original wording, a recorded value and a later correction. Source-folder labels are presented as provenance, not independent suitability assessments. Source: E-06.

**FR-CAN-04 Unknown and sensitive attributes - Must - C/R**  
The service shall not infer gender, nationality, residence, national-service completion or other sensitive personal facts from names, photographs or source-folder placement. Retaining any explicit optional attributes requires an approved business purpose and access policy.  
**Acceptance:** Missing attributes remain empty; extraction rejects unapproved fields; no ranking, suitability score or automatic hiring decision is produced from those attributes. Tests include conflicting and absent evidence. Sources: E-02, E-03, E-09.

**FR-CAN-05 Experience and ambiguity review - Must - C**  
CV-stated years of experience and a documented estimate shall remain distinct, with wording and basis preserved.  
**Acceptance:** An estimated value cannot silently replace a stated value; an incomplete or contradictory source can be marked for review; reports disclose which value they use. Sources: E-03, E-06.

**FR-CAN-06 Personal follow-up and shared discussion - Must - C**  
Shortlist, follow-up status and personal notes shall be private to the user. Shared discussion shall be visibly separate and attributed to its actual author.  
**Acceptance:** Another team member cannot retrieve personal state through the UI, API or activity feed. Importing a private note does not turn it into a shared comment. Shared comments remain attributable. Sources: E-02, E-04, E-06.

**FR-CAN-07 Saved views and exports - Should - C**  
Users shall save supported personal filters and export permitted candidate information for authorized business use.  
**Acceptance:** Restoring a view reproduces supported criteria without revealing another user's view. Exported records match the selected authorized population, and the UI warns that exported data needs candidate-data protection. Export audit and deletion obligations are covered by the approved operating policy. Sources: E-01, E-02.

### 7.3 CV documents

**FR-CV-01 Multiple private CV references - Must - P**  
A candidate may have multiple CV versions. Files shall be private and linked to the correct candidate and team.  
**Acceptance:** Two CV versions can be distinguished and retrieved by an authorized user; another team and an unauthenticated browser cannot retrieve them. A download refers to the validated file content, not a later substituted upload. Sources: E-04, E-11.

**FR-CV-02 Format and size validation - Must - P**  
The initial source baseline supports PDF, DOC, DOCX, PAGES, JPG, JPEG, JFIF and PNG up to 10 MiB per file. File names, declared types and content shall be validated rather than trusted independently.  
**Acceptance:** Empty, oversized, unsupported, malformed and mismatched files are rejected with a useful reason. A file does not become ready before validation. Format validation is never described as malware scanning. Sources: E-06, E-08.

**FR-CV-03 Private Blob delivery target - Must for chosen test route - P**  
The chosen private Vercel Blob route shall provide authorized upload and download, immutable validated-content guarantees and environment separation before activation. Existing S3 code is not evidence that Blob works.  
**Acceptance:** Selecting an unavailable provider fails closed rather than silently switching providers. Live fictional tests cover unauthorized access, replay/replacement, expiry, interrupted reads, malformed documents and cross-environment access. Sources: E-13, E-14.

**FR-CV-04 Quotas and cleanup - Must - P/D**  
The system shall enforce an approved quota against completed and reserved storage, report limit failures and safely reconcile abandoned files.  
**Acceptance:** Concurrent requests cannot exceed the agreed logical quota. Expired reservations are recoverable without deleting a referenced CV. The user preference for an initial 1 GB envelope is reconciled with the source's 10 GiB default and provider billing controls before release. Sources: E-11, E-13.

### 7.4 Bulk CV intake

**FR-BULK-01 Multi-file review queue - Must - P**  
Recruiters shall select multiple supported CVs and review each file independently.  
**Acceptance:** Every selected file has a visible name and status; one invalid file does not conceal other items; removing a draft does not delete a candidate already created. The current loss of browser-held drafts on close or team switch is disclosed. Source: E-08.

**FR-BULK-02 Duplicate review - Must - P**  
The workflow shall check for possible existing candidates and matching drafts before import.  
**Acceptance:** Exact normalized email or phone matches within the team are shown; no-match is not described as proof of uniqueness; missing contacts produce an explicit limitation. Candidate identities are never automatically merged because a contact value matches. Source: E-08.

**FR-BULK-03 Human approval of facts - Must - P**  
The recruiter shall verify candidate fields against the CV and explicitly acknowledge duplicate review before adding that candidate and document.  
**Acceptance:** Unreviewed items and unresolved suggestions cannot be imported. Changing a field invalidates applicable prior review acknowledgments. A batch command processes only eligible reviewed items. Sources: E-08, E-09.

**FR-BULK-04 Per-file progress and outcomes - Must - P**  
The workflow shall distinguish candidate creation, upload preparation, transfer, validation and completion.  
**Acceptance:** A failed upload after candidate creation reports that the record exists but the CV remains incomplete. The batch provides counts and item-level outcomes that reconcile to actual records; a partial batch is never labeled wholly successful. Source: E-08.

**FR-BULK-05 Safe retry and cancellation - Must - P**  
Retries shall reuse the original logical request and attachment identity. Cancellation shall stop new work where possible and preserve accurate information about already completed work.  
**Acceptance:** Retrying an uncertain create does not create another candidate. Already-created candidates are not silently rolled back. Expired reconciliation windows require checking the directory rather than blind recreation. Later local cancellation work requires integration testing before being claimed as delivered. Sources: E-08, E-14.

**FR-BULK-06 Capability and load limits - Must - P/D**  
The interface shall reflect server-confirmed availability and bounded processing capacity. Maximum batch size, aggregate size, concurrency and durable-resume behavior require a product and operating decision.  
**Acceptance:** A disabled or failed availability check does not enable submission. The chosen limits are displayed, enforced and tested on mixed valid/invalid batches. A local queue is not presented as a persistent background service. Sources: E-08, E-13.

### 7.5 Optional AI extraction

**FR-AI-01 Explicit optional connection - Optional - R**  
AI extraction shall be optional, off when unconfigured and enabled only for an approved provider and processing flow. Manual entry shall remain available.  
**Acceptance:** Selecting files alone causes no AI transmission. Before processing, the user can see the recipient service and the data to be sent, and applicable authorization is recorded. When disabled, the interface clearly states that no AI service is processing the CV. Sources: E-09, E-12.

**FR-AI-02 Limited factual extraction - Must if AI enabled - P**  
The initial extraction contract is limited to name, email, phone, job title, employer, university, degree name, major, skills and certifications. Additional fields require deliberate review and scope change.  
**Acceptance:** Unexpected fields, invalid types and excessive values are rejected. Missing and explicit-unknown values do not erase verified information. No suitability, protected-trait, personality or hiring-decision output is accepted. Source: E-09.

**FR-AI-03 Reviewable suggestions - Must if AI enabled - P/R**  
AI output shall appear as suggestions, separate from existing values and human edits. Each proposed change shall be accepted, rejected or corrected before final save.  
**Acceptance:** Late responses cannot overwrite newer human work; pending suggestions prevent import; a reviewer can identify the source document and relevant evidence for a suggestion. Persisting review provenance is required even where the current interface only holds it in memory. Sources: E-08, E-09.

**FR-AI-04 Failures and usage controls - Must if AI enabled - R**  
Processing shall use approved budgets, bounded timeouts and limits with safe handling of provider failure, unsupported files and uncertain responses.  
**Acceptance:** A timeout or invalid response does not create approved facts or an application. The item remains manually reviewable. Retries do not produce uncontrolled repeated charges, and usage is measurable without logging raw CV content. Source: E-14.

**FR-AI-05 Provider governance and document safety - Must if AI enabled - R/D**  
Provider selection shall address retention, training use, region, deletion, subcontractors and supported extraction/OCR behavior. Uploaded content shall be treated as data, not as instructions to change the workflow.  
**Acceptance:** Provider terms and the authorized data flow are documented; an adversarial CV cannot direct unrelated external calls, reveal another record or approve itself. Provider credentials remain server-side. No real CV is sent before the required approval. Sources: E-04, E-12.

### 7.6 Roles vacancies and recruitment operations

**FR-REC-01 Reusable job roles - Should - C**  
Users shall maintain reusable titles, departments, location, employment/work mode, descriptions, requirements and skills.  
**Acceptance:** A role can seed a vacancy draft; subsequent role changes do not silently modify that vacancy. Sources: E-02, E-03.

**FR-REC-02 Vacancy management - Must - C**  
Vacancies shall include title, requisition, requirements, opening count, responsibility labels and target date, with Draft, Open, On hold, Filled and Closed statuses.  
**Acceptance:** Invalid opening counts or dates fail validation. Status updates are explicit and audited. Closing a vacancy does not silently reject applications. Sources: E-03, E-04.

**FR-REC-03 Application relationships - Must - C**  
An application shall connect one candidate with one vacancy within the same team.  
**Acceptance:** Cross-team and invalid references fail. The accepted uniqueness rule prevents unintended duplicate candidate-vacancy applications. Immutable relationships cannot be silently relinked by editing another field. Sources: E-03, E-05.

**FR-REC-04 Bulk vacancy assignment - Should - C**  
Users shall link selected candidates to a vacancy with explicit stage, source, owner label and applicable date.  
**Acceptance:** The result identifies created and existing relationships, preserves idempotency and does not exceed the current source limit of 500 candidate IDs per request. Candidate selection alone does not imply a hiring decision. Sources: E-03, E-05.

**FR-REC-05 Explicit application pipeline - Must - C**  
Applications shall use Sourced, Screening, Interview, Offer, Hired, Rejected and Withdrawn. Human-authorized movement shall be possible with a keyboard-accessible alternative to dragging.  
**Acceptance:** A stage change is recorded with actor and time; changing personal follow-up, task bucket, offer or vacancy status does not silently change the application. Approval restrictions and allowed transition rules beyond the existing enumeration require a separate decision. Sources: E-02, E-03.

**FR-REC-06 Interviews and calendar - Must - C**  
Interviews shall attach to an application and include time, duration, interviewer label, location/meeting URL, notes and Scheduled, Completed, Cancelled or No show status.  
**Acceptance:** Day/week/month/list views show the same instant in Asia/Dubai; rescheduling changes the related reminder; invalid dates and unsafe URL schemes fail. Saving an interview does not claim that an external invitation was sent. Sources: E-02, E-03, E-10.

**FR-REC-07 Offer tracking - Must - C**  
Offer records shall track amount, currency, pay period, dates, decline reason and Draft, Sent, Accepted, Declined, Withdrawn or Expired state.  
**Acceptance:** Negative or malformed amounts fail; currency and pay period remain explicit; recorded Accepted does not auto-hire, send an offer, sign a contract or commit payroll. Sources: E-02, E-03.

**FR-REC-08 Onboarding - Must - C**  
An application may have onboarding details, responsibility, start date, notes and Planned, In progress, Completed or On hold state.  
**Acceptance:** Onboarding remains linked to its application; changing its status does not alter application or offer state. It can be found from the candidate profile. Sources: E-02, E-03.

**FR-REC-09 Onboarding checklist - Must - C**  
Checklist items shall support Document, Orientation, Training and Other categories with due date, owner and Pending, In progress, Complete or Waived state.  
**Acceptance:** Progress uses active complete/waived items over active configured items. An empty checklist is not represented as automatically complete; archived items do not distort the denominator. Sources: E-02, E-03.

### 7.7 Recruitment tasks

**FR-TASK-01 Task management - Must - C**  
Tasks shall include title, context, owner label, due date, priority and description, with optional candidate and vacancy links.  
**Acceptance:** A task can exist without an application; creating or moving a task does not create an application or alter its stage. Priority is Low, Normal, High or Urgent. Sources: E-02, E-03.

**FR-TASK-02 Configurable buckets - Must - C**  
Teams shall configure task bucket names, colors and order. The bucket is the task's workflow status.  
**Acceptance:** Tasks can be moved by keyboard as well as dragging. Archiving a populated bucket requires a valid destination and moves its tasks consistently; at least one bucket remains. Source: E-02.

**FR-TASK-03 Custom task fields - Should - C**  
Teams shall configure Text, Number, Date, Dropdown and Checkbox fields, including required fields and order.  
**Acceptance:** Values are validated against their definition; archived definitions preserve historical values; changes do not silently reinterpret existing data. Sources: E-02, E-03.

**FR-TASK-04 Safe editing and collaboration - Must - C**  
Forms shall require explicit saving and preserve draft work when an update conflicts with another edit.  
**Acceptance:** A stale save reports conflict, does not overwrite the newer record and lets the user review the latest data before retrying. Shared comments identify their author and remain separate from private notes. Sources: E-02, E-04.

### 7.8 Overview reporting and reminders

**FR-OPS-01 Operational overview - Must - C**  
The overview shall show actual authorized inventory, upcoming interviews, overdue tasks, recent activity and review/data-coverage indicators.  
**Acceptance:** Candidate counts represent people; CV counts represent ready files; pending files are not counted as ready. Each figure reconciles to a known fixture and indicates the applicable team/time context. Sources: E-02, E-10.

**FR-OPS-02 Explainable analytics - Must - C**  
Reports shall distinguish current inventory from historical events observed by RecruitmentOS.  
**Acceptance:** Imports do not manufacture historical stage transitions or time-to-hire. Rates show a defined denominator; empty or insufficient samples are not shown as meaningful zero-duration performance. Date range and timezone are visible. Source: E-10.

**FR-OPS-03 Personal reminders - Should - C**  
Reminders shall include relevant due tasks, interviews, expiring offers, vacancy targets, onboarding starts and checklist items.  
**Acceptance:** Read state is per user and applies only to genuine current reminders. Rescheduled items can become unread with their new due identity. The service does not claim external email or push delivery solely because an in-app reminder exists. Source: E-10.

**FR-OPS-04 Recruitment audit history - Must - C/P**  
Recruitment and token actions shall have an attributable history while protecting personal note and comment contents.  
**Acceptance:** The business change and its required audit event commit together or both fail. Imported activity is identified as imported. The known gap in equivalent application-level authentication/membership audit coverage is documented and resolved or explicitly accepted before production. Sources: E-04, E-05.

### 7.9 Administration and integration

**FR-ADM-01 Team administration - Must - C**  
Owners and admins shall manage permitted details, invitations and membership; ownership changes remain owner-only.  
**Acceptance:** Last-owner protection holds under concurrent changes; a failed team-creation flow cannot be mistaken for a usable team and has an operator reconciliation path. Sources: E-02, E-04.

**FR-ADM-02 Scoped API tokens - Should - C/P**  
Users shall create named, expiring tokens with the smallest required read/write/CV/import scopes available to their role.  
**Acceptance:** Plaintext is shown only once; revocation, expiry, membership removal and role reduction affect subsequent calls. Tokens cannot manage accounts, memberships or other tokens. Write scope does not silently include read scope. Sources: E-04, E-07.

**FR-ADM-03 Legacy dry run and controlled apply - Must for migration - C**  
The importer shall analyze approved sources locally before an explicit apply step and retain source mappings, exceptions and private-state ownership.  
**Acceptance:** Dry run makes no application writes or uploads. Apply uses approved source and destination scope. Repeating unchanged input skips reconciled records, preserves later destination edits by default and reports conflicts. Sources: E-06, E-07.

**FR-ADM-04 Archive retention and deletion - Must - C/R/D**  
Ordinary archival shall preserve necessary references and recoverability. Permanent deletion and retention shall follow an approved policy covering database rows, documents, versions, exports, audit and backups.  
**Acceptance:** Archived items are excluded from ordinary active views where appropriate. A retention test identifies every related artifact and documents exceptions. No automatic permanent-deletion period is assumed from the source. Sources: E-03, E-04.

**FR-ADM-05 Environment and configuration visibility - Must - P**  
Operators shall keep local, Preview and Production resources isolated and make disabled features and environment-specific prerequisites clear.  
**Acceptance:** Preview cannot reach production data or storage. Secrets are server-only, scoped to the correct environment and absent from public source. A tested release identifies its revision, configuration and outstanding disabled features. Sources: E-04, E-13, E-14.

## 8 Business data requirements

### 8.1 Principal information groups

| Data group                     | Required business meaning                                  | Important rules                                                                                       |
| ------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Team, user and membership      | Who can use which workspace and in what capacity           | Live membership governs access; role labels are not interchangeable with hiring responsibility labels |
| Candidate                      | One person's recorded factual profile                      | Unknown is not zero or false; duplicate identity needs human review                                   |
| Source evidence and review     | Where a fact originated and whether ambiguity was resolved | Preserve original wording and distinct stated/estimated values                                        |
| CV reference                   | One selected document/version belonging to a candidate     | Private object, validated-content identity, original name and status; multiple versions are allowed   |
| Personal candidate state       | User's shortlist, follow-up status and private note        | Keyed by team, user and candidate; never shared by default                                            |
| Job role                       | Reusable description of a role                             | Copying creates a vacancy draft rather than a live synchronized template                              |
| Vacancy                        | An actual recruitment opening/requisition                  | Separate status, opening count, target date and responsibility labels                                 |
| Application                    | Candidate-vacancy relationship                             | Holds recruitment stage; does not share its state machine with a task or offer                        |
| Task and bucket                | Work to be done and its team-defined status                | Optional context links; required bucket; custom values tied to definitions                            |
| Interview                      | Scheduled recruitment event against an application         | Store a precise instant; display in Asia/Dubai; manual outcome                                        |
| Offer                          | Recorded proposed terms and outcome                        | Explicit amount/currency/pay period; not proof of delivery or signature                               |
| Onboarding and checklist       | Post-selection preparation and tasks                       | Progress denominator uses active configured items                                                     |
| Saved view and reminder read   | Personal navigation and attention state                    | User-private; only supported filters and genuine reminder identities                                  |
| Activity and import provenance | Who changed what, when and through which route             | Append-only history; imported timestamps are not observed events                                      |
| Token and storage usage        | Integration access and resource consumption                | Secret stored as a hash; quota accounting is separate from provider billing                           |

### 8.2 Data quality rules

1. Preserve stable IDs and explicit parent relationships. Do not link a task to a candidate merely because free text resembles a name.
2. Do not merge candidates, replace reviewed facts or map legacy owner names to user accounts by guessing.
3. Keep original source metadata without turning every imported column into a validated current fact.
4. Preserve valid contact formatting while using documented normalization for duplicate comparison. Shared contacts can represent different people.
5. Validate dates, enumerations, numbers, URLs and field sizes. Record invalid source values as review exceptions rather than silently coercing them into credible data.
6. Keep imported, created and observed-change timestamps distinguishable. Historical claims require historical evidence.
7. Review records lacking a usable CV separately from records whose CV is uploaded and ready.
8. Maintain one canonical database. An export is a snapshot; editing it does not update the application.

### 8.3 State definitions

| Object             | Source-baseline states                                           |
| ------------------ | ---------------------------------------------------------------- |
| Personal follow-up | New, To contact, Contacted, Interviewing, On hold, Closed        |
| Vacancy            | Draft, Open, On hold, Filled, Closed                             |
| Application        | Sourced, Screening, Interview, Offer, Hired, Rejected, Withdrawn |
| Task               | Team-configured bucket                                           |
| Interview          | Scheduled, Completed, Cancelled, No show                         |
| Offer              | Draft, Sent, Accepted, Declined, Withdrawn, Expired              |
| Onboarding         | Planned, In progress, Completed, On hold                         |
| Checklist item     | Pending, In progress, Complete, Waived                           |

These values describe the current implementation, not an approved organizational hiring policy. Required rejection reasons, transition approval, reapplication, reopening and irreversible-final-state rules remain decisions if the organization needs stronger controls.

## 9 Reports and metric definitions

| ID     | Report                                 | Population and interpretation                                                           | Acceptance check                                                                                                                    |
| ------ | -------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| RPT-01 | Workspace overview                     | Current active team records, ready CVs, pending files, upcoming and overdue work        | Counts match a known fixture and respect role scopes                                                                                |
| RPT-02 | Candidate data coverage                | Presence of contact and CV-stated experience fields; review-needed indicator            | Missing fields are not treated as completed or correct; review labels use documented rules                                          |
| RPT-03 | Vacancy and pipeline inventory         | Current active vacancies and applications grouped by status/stage, department or source | Totals reconcile to current records; distinct candidates and applications are not conflated                                         |
| RPT-04 | Applications and first hires over time | New application and first-Hired events actually observed by the system                  | Imported historical records do not create false old events; date boundaries use Dubai time                                          |
| RPT-05 | Time to hire                           | Elapsed time from observed application creation to first observed Hired event           | Missing starts are excluded; sample count accompanies the average                                                                   |
| RPT-06 | Stage duration                         | Observed, matching entry/exit transition pairs                                          | Missing or invalid transitions do not produce invented durations                                                                    |
| RPT-07 | Stage reach rate                       | Share of distinct observed applications reaching each stage through the end date        | Disclose that the current calculation is all observed history through the end date, not necessarily a selected-period cohort funnel |
| RPT-08 | Offer outcomes and decline reasons     | Current offer records grouped by recorded values                                        | No inference of offer delivery or legal acceptance from a chart alone                                                               |
| RPT-09 | Source categories and experience       | Factual categories and CV-stated experience bands, including Not recorded               | Folder tags are not suitability ratings; multi-tag populations can overlap                                                          |
| RPT-10 | Import and processing reconciliation   | Created, updated, skipped, conflicted, failed and document-ready outcomes               | Counts sum to the input/result model; incomplete items remain visible                                                               |
| RPT-11 | Storage and optional AI usage          | Logical reservations/ready files and provider consumption where measurable              | Distinguish application quota from physical versions, requests, transfer and billable provider usage                                |

RPT-10 is supported by legacy import reporting and required for the completed bulk workflow. RPT-11 is a target operating requirement, not a claim that a full billing dashboard already exists. Export formats, report scheduling and additional analytical cohorts require confirmation.

## 10 Nonfunctional requirements

**NFR-01 Isolation and least privilege - Must - P**  
Team, user-private and environment boundaries shall hold across UI, API, background processing, storage and reporting. **Acceptance:** Negative isolation tests pass against actual restricted hosted roles, including concurrent requests and revoked membership. Local embedded-database tests alone do not close the requirement.

**NFR-02 Confidentiality and secret handling - Must - C/P**  
Use private storage, protected transmission and server-only secrets. Minimize personal data in logs and error messages. **Acceptance:** Public bundles, repository, URLs and diagnostics contain no credentials or real CV payloads; unauthorized document retrieval fails; deployment protection is verified on the exact test URL.

**NFR-03 Privacy and responsible employment use - Must - R/D**  
Collect, retain and disclose only data supported by an approved recruitment purpose. **Acceptance:** The responsible owner approves the data inventory, access, retention, data-subject handling and provider-processing policy before real data; no automatic employment decision relies on sensitive traits. Applicable jurisdictions and obligations require qualified review, not assumption from the Dubai timezone or domain name.

**NFR-04 Integrity and recoverability of writes - Must - C/P**  
Use explicit saves, conflict detection, idempotent creates and atomic required audit changes. **Acceptance:** Duplicate submissions, stale updates, service interruption and uncertain responses are tested without silent data loss or duplicated logical records.

**NFR-05 File safety - Must - P/D**  
Validate format and bounded content; adopt the approved quarantine/malware policy. **Acceptance:** Unsafe formats remain unavailable; a referenced validated object cannot be replaced silently; scanning is tested if selected. Residual risks are documented if a limited initial policy is accepted.

**NFR-06 Performance and capacity - Must - D**  
Agree supported record volume, concurrent users, maximum batch, document size, upload/extraction latency and percentile response targets. **Acceptance:** A representative load plan and measured results meet approved targets. The 10 MiB source limit is known; a response-time SLA or production capacity is not yet approved.

**NFR-07 Availability and recovery - Must - D**  
Define availability expectations, backup frequency, recovery point, recovery time and operator coverage. **Acceptance:** A restore exercise recovers an internally consistent fictional database/document set within approved targets. A provider backup feature alone is not proof of application recovery.

**NFR-08 Accessibility and usability - Must - C/R/D**  
Core workflows shall be operable with keyboard, clear labels, visible focus, accessible errors and alternatives to drag gestures; layouts shall work on supported desktop and mobile browsers. **Acceptance:** An end-to-end accessibility and browser checklist passes. The conformance level and browser matrix remain to be approved; no completed accessibility audit is claimed.

**NFR-09 Observability and support - Must - R/D**  
Operators shall identify failed sign-ins, unavailable services, failed uploads/imports and cost-limit events without collecting unnecessary CV content. **Acceptance:** Redacted diagnostics link a user-visible incident to its operation and revision; alert ownership and escalation procedures are assigned and exercised.

**NFR-10 Cost containment - Must - P/D**  
Use separate provider budgets and usage controls in addition to application quotas. **Acceptance:** Limit, warning and stop behavior are tested; storage replay/orphan usage is accounted for; free-plan assumptions are verified at provisioning rather than promised as permanent zero cost.

**NFR-11 Portability and maintainability - Should - C/R**  
Keep domain records, exports, provenance and provider boundaries understandable and supportable. **Acceptance:** A documented export/migration exercise preserves key relationships and private-state ownership; changing an extraction provider does not remove human review or widen the accepted field schema.

**NFR-12 Release quality and truthful readiness - Must - P**  
Releases shall have a known revision, repeatable tests, documented feature gates and clear unresolved risks. **Acceptance:** Build, static checks, unit/integration and appropriate end-to-end tests pass for the exact release; skipped tests and unverified providers are listed. No security or production-ready claim is based solely on a green build.

## 11 Privacy security and administration policy decisions

### 11.1 Data flow boundary

The intended basic flow is browser to application, application to team-scoped PostgreSQL, and authorized CV transfer to private storage. Resend supports account verification, resets and invitations rather than CV processing. Google or Microsoft is optional sign-in. An AI provider is a distinct, optional data recipient and must not become active merely because an API token feature exists.

The public GitHub repository shall contain code, documentation and fictional fixtures only. Candidate records, original workbooks, database copies, CVs, credentials and sensitive deployment reports do not belong there. Migration reports and exports must be protected like the data they describe.

### 11.2 Policies needed before real data

- Responsible data owner, permitted users and lawful business purpose.
- Which candidate attributes are necessary; justification and restrictions for optional sensitive information.
- Candidate notice, correction, access, deletion and other applicable request handling.
- Retention for active, rejected, withdrawn, archived and duplicate records, source files, exports, audit and backups.
- Rules for downloads, forwarding, devices and sharing outside the team.
- Chosen document scanning/quarantine controls and incident handling.
- AI recipient, processing region, retention/training terms and approval mechanism.
- Offboarding, privileged access review, token review and emergency revocation.
- Backup, recovery, breach/incident response and communications ownership.

These are release decisions, not a legal opinion or a claim that current implementation supplies all policy workflows.

## 12 Exceptions and recovery requirements

| Scenario                                     | Required business outcome                                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Hosted service or provider is disabled       | Explain unavailability and preserve safe manual work; never imply completion                                               |
| No email or phone on a CV                    | Permit a factual draft, disclose duplicate-check limitation and require human review                                       |
| Shared contact or duplicate match            | Present possible matches; do not merge, reject or overwrite automatically                                                  |
| Unsupported or encrypted/unreadable document | Mark the file for attention; keep other files usable; use a reviewed manual path where permitted                           |
| Candidate created but CV failed              | Identify the created candidate and pending document; attach safely on retry                                                |
| Browser closes or team changes               | Warn about loss of unfinished local drafts; do not claim persistence or reverse completed records                          |
| AI output is malformed or unsafe             | Reject suggestions, retain human edits and allow manual entry                                                              |
| AI request is slow or cancelled              | End bounded work, avoid false completion and expose any uncertain billable outcome for reconciliation                      |
| Concurrent edit                              | Retain the draft, show a version conflict and require reconciliation                                                       |
| Invitation/reset email fails                 | Do not fabricate delivery; support a safe retry/recovery path without duplicate privileged setup                           |
| A membership changes mid-work                | Re-evaluate access; disallow new unauthorized operations and explain what completed already                                |
| Storage quota is exhausted                   | Reject new reservations cleanly, preserve accepted documents and report the actionable limit                               |
| Legacy import partly succeeds                | Preserve a reconciliation report and stable identifiers; do not delete originals or run destructive rollback automatically |
| Incorrect linkage or immutable relationship  | Require an explicit correction process with audit; do not rewrite unrelated history silently                               |
| No observed historical events                | Show unavailable/insufficient history, not invented conversion or time-to-hire values                                      |
| Backup or provider restore is incomplete     | Keep service gated until record/document references reconcile and the operator accepts recovery                            |

## 13 Delivery phases and acceptance gates

Dates, budget and named owners remain unapproved. The order below is dependency-based, not a promised schedule.

### Phase 0 Confirm the baseline and open decisions

Approve the BRD/SRS scope; reconcile local and repository revisions; confirm Blob direction, 1 GB planning envelope, initial user population, supported browsers and operating ownership. Record decisions without changing production data.

**Gate G-00:** A signed-off scope and decision register identify what must be enabled for the first release and what stays optional or disabled.

### Phase 1 Establish protected hosted access

Complete the authorized database/security review, trusted identity boundary, first-owner setup and transactional safeguards. Validate restricted live Preview roles, pooling/concurrency, email and deployment protection using fictional users and records.

**Gate G-01:** Negative isolation tests, account flows and protected access pass on the intended hosted environment. Unresolved review blocks are not bypassed. The exact deployed URL and revision are recorded.

### Phase 2 Accept core recruitment workflows

Exercise candidates, evidence, private/shared state, roles, vacancies, applications, tasks, interviews, offers, onboarding, reports and tokens in signed-in browsers. Resolve usability, accessibility and data-integrity issues.

**Gate G-02:** Recruitment representatives complete the agreed end-to-end UAT cases, reports reconcile and permission tests pass.

### Phase 3 Enable private documents and bulk manual intake

Finish the Blob integration and immutability/authorization controls, quotas, validation, cleanup and the approved file-safety policy. Connect bulk intake and demonstrate retry, cancellation and partial-result behavior.

**Gate G-03:** Fictional uploads and downloads pass live provider checks, a reviewed batch reconciles fully, and no unauthorized caller can obtain another team's file. AI may remain disabled.

### Phase 4 Enable optional AI extraction

Choose and authorize the provider, define extraction/OCR coverage and budget, connect reviewable suggestions and test failure, adversarial content, conflicts and human approval.

**Gate G-04:** Approved data processing and governance, measured extraction evaluation and human-review tests pass. Manual intake remains usable when AI is unavailable.

### Phase 5 Migrate and release for real recruitment data

Complete privacy, retention, backup, incident and support decisions; review a migration dry run; authorize the real-data apply separately; reconcile candidate records and CV associations; revoke temporary credentials.

**Gate G-05:** Production readiness, recovery exercise, migration reconciliation and business acceptance are documented. No real-data release is inferred from a successful fictional Preview test.

## 14 User acceptance scenarios

| ID     | Scenario                                               | Expected result                                                         | Primary requirement coverage           |
| ------ | ------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------- |
| UAT-01 | Owner invites recruiter and viewer                     | Verified users access only permitted functions; viewer writes fail      | FR-ACC-01 to 05, FR-ADM-01             |
| UAT-02 | Two teams attempt cross-access                         | Records, private notes, CVs and exports remain isolated                 | FR-ACC-02, FR-CAN-06, FR-CV-01, NFR-01 |
| UAT-03 | Recruiter reviews incomplete candidate                 | Unknown values stay unknown and provenance remains accessible           | FR-CAN-01 to 05                        |
| UAT-04 | Two people edit one candidate                          | Second stale save preserves draft and does not overwrite                | FR-TASK-04, NFR-04                     |
| UAT-05 | Candidate moves from vacancy application to onboarding | Every linked object is findable; all state changes are explicit         | FR-REC-01 to 09                        |
| UAT-06 | Task buckets and required fields change                | Valid work moves safely and historical values survive archival          | FR-TASK-01 to 03                       |
| UAT-07 | Mixed bulk batch includes duplicates and invalid files | Only reviewed eligible items import; every outcome is visible           | FR-BULK-01 to 06                       |
| UAT-08 | Network fails after candidate creation                 | Retry attaches the document without duplicate candidate creation        | FR-BULK-04 to 05, NFR-04               |
| UAT-09 | AI suggests wrong or late data                         | Human edits survive; suggestions require review; no autonomous decision | FR-AI-01 to 05                         |
| UAT-10 | File is replaced or accessed by another team           | Validation/download identity holds and unauthorized access fails        | FR-CV-01 to 04, NFR-01 to 05           |
| UAT-11 | Legacy data is imported twice                          | Unchanged data is skipped; conflicting corrections are preserved        | FR-ADM-03, BR-01                       |
| UAT-12 | Analyst reviews imported and new applications          | Inventory and observed history remain distinct; samples reconcile       | FR-OPS-01 to 04, RPT-01 to 10          |
| UAT-13 | Token is revoked or owner demoted                      | Subsequent requests lose access without exposing the secret             | FR-ADM-02, FR-ACC-03                   |
| UAT-14 | Operator restores a fictional environment              | Data and document references reconcile under approved recovery targets  | NFR-07, FR-ADM-05                      |

Acceptance records should capture test revision, environment, role, fixture, steps, expected/actual outcome, evidence and reviewer. A failed Must criterion blocks the related gate until fixed or explicitly respecified by authorized stakeholders without weakening required privacy/security controls.

## 15 Assumptions constraints and dependencies

### 15.1 Assumptions requiring confirmation

- The initial audience is an internal recruitment team rather than the public or external agencies.
- English is the initial interface language. Arabic, right-to-left layout and multilingual/OCR coverage are not established requirements.
- Asia/Dubai is the initial scheduling/reporting timezone in source. Per-user or multi-region behavior is not yet agreed.
- Responsibility fields such as recruiter and hiring manager may remain free-text labels initially; account assignment and notification routing need a separate choice.
- The initial 1 GB storage preference is a planning envelope, not a verified hard billing or application limit.
- Manual extraction remains a viable initial release if optional AI is not yet approved.

### 15.2 Constraints

- Hosted access and Blob safeguards are incomplete; deployment must not bypass their gates.
- Existing S3 behavior and documentation must not be mistaken for completed Blob support.
- The public repository cannot contain real records, service credentials or source CVs.
- Local PGlite and fake-provider tests cannot prove live Neon, Blob, email, OAuth or production concurrency behavior.
- Browser-held bulk drafts are temporary; current UI does not establish durable job storage or cross-device resume.
- The existing file ceiling is 10 MiB. Scanned documents, legacy formats and OCR may need additional processing not yet implemented.
- Data and objects span separate services; imports and upload workflows are not one global transaction.
- Resource creation, code merge and CI success do not constitute business acceptance or a verified hosted URL.

### 15.3 Dependencies

The project depends on Vercel hosting/protection, Neon database access with suitable roles, the chosen private storage integration, working email delivery, approved account setup, optional OAuth configuration and the security review needed to finish the hosted identity boundary. AI additionally depends on a selected provider, authorized processing terms, input extraction/OCR and a budget. Real migration depends on approved source access, stable inputs, backup and a reviewer able to reconcile exceptions.

## 16 Open decision register

| ID   | Decision                                                                     | Why it matters                                                                     | Needed before |
| ---- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------- |
| D-01 | Approve first-release scope and business approvers                           | Separates required core from optional follow-on work                               | G-00          |
| D-02 | Complete authorized identity/database review and accept its remediation      | Hosted data access is currently blocked                                            | G-01          |
| D-03 | Confirm canonical Preview/Production origins and initial-owner identity      | Email links, authentication and isolation depend on them                           | G-01          |
| D-04 | Finalize Blob implementation and reconcile outdated S3 instructions          | Provider selection is decided for testing; safe implementation is not complete     | G-03          |
| D-05 | Translate 1 GB preference into logical quotas and provider budgets           | Source defaults differ; logical quota is not a hard bill cap                       | G-03          |
| D-06 | Set batch size, concurrency, aggregate limit and durable-resume expectations | Prevents misleading bulk experience and unbounded work                             | G-03          |
| D-07 | Approve duplicate handling and linking-to-existing behavior                  | Current bulk flow checks matches but does not establish an automatic merge process | G-03          |
| D-08 | Choose document scanning/quarantine and unsupported-file policy              | Format checks alone do not address malicious content                               | G-03/G-05     |
| D-09 | Choose AI provider, region, retention/training terms and budget              | No connected provider is approved or evidenced here                                | G-04          |
| D-10 | Set extraction quality, evidence and OCR acceptance coverage                 | Prevents claims of accuracy without a defined test set                             | G-04          |
| D-11 | Approve privacy purpose, optional attributes, retention and deletion         | Required before handling real candidate data                                       | G-05          |
| D-12 | Define performance, capacity, availability, backup RPO and RTO               | No approved numerical operating targets exist                                      | G-05          |
| D-13 | Approve accessibility conformance and browser/device matrix                  | Current automated and HTTP checks are insufficient                                 | G-02/G-05     |
| D-14 | Decide hiring transition approval, required reasons and reapplication rules  | Source states are not a complete HR decision policy                                | G-02          |
| D-15 | Decide whether hiring owner labels become actual user assignments            | Affects accountability and notification delivery                                   | G-02 or later |
| D-16 | Decide expanded auth/membership audit coverage and audit retention           | Current application audit coverage has known gaps                                  | G-05          |
| D-17 | Name operations, incident, privacy and cost owners                           | A hosted service needs accountable support                                         | G-05          |
| D-18 | Approve migration scope and exception tolerance                              | Real migration cannot be accepted by counts alone                                  | G-05          |

## 17 Business risk register

| Risk                                      | Business consequence                             | Required response                                                             |
| ----------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Treating source-complete as live-ready    | Real data enters an unverified service           | Enforce gates and distinguish local from hosted evidence                      |
| Weak tenant/identity boundary             | Unauthorized candidate disclosure or changes     | Keep hosted feature disabled until independent live isolation evidence passes |
| File replacement or unauthorized download | Wrong or exposed CV associated with a candidate  | Validate exact content identity and private access end to end                 |
| AI errors or instruction-like CV content  | False facts or inappropriate automated decisions | Strict extraction schema, isolated processing and mandatory human review      |
| Duplicate or partial imports              | Lost confidence and repeated recruiter work      | Stable identifiers, per-item outcomes, duplicate review and reconciliation    |
| Uncontrolled storage or extraction usage  | Unexpected costs and service disruption          | Quotas plus provider budgets, safe cleanup and cost ownership                 |
| Excessive personal-data retention         | Privacy exposure and difficult deletion          | Approved purpose and retention policy across all copies                       |
| Misleading historical analytics           | Incorrect performance conclusions                | Observed-event definitions, sample disclosure and import boundaries           |
| Unclear responsibility labels             | Tasks appear assigned but no one acts            | Distinguish free text from accounts and agree ownership expectations          |
| Unexercised recovery                      | Inability to restore CV/record consistency       | Reconciled restore exercise before production acceptance                      |

## 18 Traceability

| Business objective                | Requirements                                                      | Workflows and reports | Acceptance evidence                               |
| --------------------------------- | ----------------------------------------------------------------- | --------------------- | ------------------------------------------------- |
| BR-01 Canonical records           | FR-CAN-01/03/05, FR-ADM-03/04                                     | WF-02/03, RPT-10      | UAT-03/11, G-05                                   |
| BR-02 Efficient finding and entry | FR-CAN-02/07, FR-BULK-01 to 06, FR-AI-01 to 04                    | WF-03/04              | UAT-07/08/09; measured before/after task baseline |
| BR-03 Workflow visibility         | FR-REC-01 to 09, FR-TASK-01 to 04, FR-OPS-03                      | WF-05/06, RPT-01/03   | UAT-05/06, G-02                                   |
| BR-04 Accuracy and human control  | FR-CAN-03 to 06, FR-BULK-02/03, FR-AI-02/03/05                    | WF-03/04              | UAT-03/09, G-04                                   |
| BR-05 Privacy and security        | FR-ACC-01 to 05, FR-CV-01 to 03, FR-ADM-01/02/04/05, NFR-01 to 05 | WF-01/07              | UAT-01/02/10/13, G-01/G-03/G-05                   |
| BR-06 Explainable reports         | FR-OPS-01 to 04, FR-CAN-05                                        | WF-07, RPT-01 to 10   | UAT-12, G-02                                      |
| BR-07 Controlled operation        | FR-CV-04, FR-BULK-05/06, FR-AI-04, NFR-06 to 10/12                | WF-07, RPT-11         | UAT-08/14, G-03/G-05                              |
| BR-08 Controlled growth           | FR-ADM-02/03/05, FR-AI-01/05, NFR-11/12                           | WF-01/02/07           | UAT-11/13/14, G-05                                |

The SRS should map its detailed software requirements and tests to these stable business IDs. If a requirement changes, retain its ID, record the reason and affected tests, and update the decision register. New scope should receive a new ID rather than reusing one with a different meaning.

## 19 Approval and change control

Business acceptance requires the product owner's scope approval, recruitment-user UAT acceptance, completion of the relevant security/privacy review, and operator approval of recovery and support readiness. Names, dates and signatures remain unfilled until those people actually approve.

Approving this BRD means approving a requirements baseline. It does not mean that every feature is implemented, that a provider may receive real CVs, that migration may run, or that production is authorized. Deployment, processing and migration approvals must identify their actual environment, data and scope.

Changes to provider, sensitive data fields, tenancy model, automation authority, retention, public exposure, operating costs or hiring-decision behavior require an impact review. That review should update the requirements, data flows, tests, rollout gates and user-facing documentation before the change is treated as part of the accepted product.
