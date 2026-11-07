# RecruitmentOS Project Brief

**Document version:** 1.0  
**Prepared:** 3 November 2026  
**Document status:** Evidence-based project baseline and proposed delivery plan  
**Audience:** Project owner, recruitment stakeholders, implementation team, security reviewer and service operator  
**Project owner:** Omar Alshair, subject to confirmation of the formal business sponsor  
**Repository:** [omarals95/RecruitmentOS](https://github.com/omarals95/RecruitmentOS)  
**Repository baseline inspected:** `main`, commit `d67828ed0889849ea0fc431949288f7c10061dda`

> **Status note (7 November 2026, not part of the approved baseline):** this note supersedes the hosted-access statements in §1; the approved text below is unchanged. The blanket block on hosted database access has been removed and replaced by precise fail-closed startup checks ([identity-boundary-plan.md](../identity-boundary-plan.md)). In the owner's run on the Neon Preview database the split runtime role template is applied, `scripts/db-role-evidence.ts` passes with zero drift, and `npm run test:live-roles` passes 27/27 through the transaction-mode pooler and 27/27 direct; the template has changed since that run, and the owner's pending re-applies are listed in the register. Hosted sign-in opens only when every readiness check in [authentication.md](../authentication.md#hosted-sign-in-readiness) holds. A protected Preview deployment exists ([ROADMAP.md](../ROADMAP.md)); there is no Production deployment. Independent review (DEC-02/DEC-03), Production verification and the owner's release decision are still open, Blob CV storage stays disabled and no AI provider is connected. The [requirement register](register.md) is the current status source.

> **Status note (7 November 2026, job 030, not part of the approved baseline):** this note supersedes the statement in the earlier status note above that Blob CV storage stays disabled; the approved text below is unchanged. Private Vercel Blob is now the hosted CV storage provider, enabled in code through Vercel OIDC (owner decision DEC-01, 7 November 2026: Blob only, S3 a dormant legacy option). The Preview switch-on waits for the owner's environment settings, migration `0018` and the role template rerun ([deployment.md §5](../deployment.md#5-cv-storage), [blob-security-design.md](../blob-security-design.md)). Production verification and the owner's release decision remain open.

## 1 Executive summary

RecruitmentOS is a web-based recruitment workspace intended to replace a fragmented desktop workflow built around CV folders, Excel workbooks and a local dashboard. It brings candidate records, source evidence, CV versions, vacancies, applications, recruitment tasks, interviews, offers and onboarding into a team-controlled application. PostgreSQL is intended to become the authoritative data store. Excel remains an import and export format rather than a second live database.

The project has substantial application code and synthetic test coverage. Its first pull request has been merged into `main`. However, it is **not a verified operational cloud service**. Hosted authentication and database access are deliberately blocked while the trusted identity and tenant boundary is completed. The bulk CV interface and extraction contract exist, but live uploads and AI extraction remain disabled. The latest recorded implementation result reports no deployment and no transmission of real CVs to an AI provider. Publishing the current build would not, by itself, provide a functional production recruitment system.

The selected direction is Next.js and TypeScript on Vercel, separate Neon databases and private Vercel Blob stores for Preview and Production, and Resend for transactional email. The existing storage implementation and some documentation still describe Amazon S3. Blob is an adaptation in progress, not a completed configuration switch. Its authorization, accounting and validated-download requirements must be resolved before activation.

The immediate delivery objective is a protected, synthetic-data test environment with reliable sign-in, secure initial administrator creation, team isolation and the core recruitment workflows. The next objective is secure CV ingestion, followed by optional AI-assisted extraction with human review. Real-data migration and business production use require separate readiness decisions, operational controls and acceptance evidence.

## 2 How to read this brief

This document distinguishes four kinds of statement:

- **Verified repository state:** Directly observed in the inspected repository revision. Presence of code or tests does not mean that a live service works.
- **Recorded project state:** Reported in the project conversation or implementation task. This is historical evidence, not a new live-service verification.
- **Intended requirement:** A requested or established product outcome that may not yet be implemented.
- **Proposal or open decision:** A recommended delivery approach or a question that still needs agreement.

This brief defines purpose, boundaries, delivery sequencing and readiness. The accompanying business requirements document should expand business rules and outcomes. The software requirements specification should define detailed functional behavior, interfaces, data constraints and testable requirements. These documents should use the same implementation-status distinctions.

No dates, staffing commitments, service-level agreements, subscription purchases or production approvals are created by this brief. No credentials, real candidate records or CV contents are included.

## 3 Background and problem

The documented legacy workflow uses a master candidate workbook, related recruitment workbooks, CV folders and local SQLite state. Information is split between factual records, document inventories, recruiter notes and operational tracking. That structure creates several practical problems:

1. A candidate can have multiple source documents, making file counts different from candidate counts.
2. Recruiters need to preserve personal notes and shortlist choices without accidentally making them team-visible.
3. Relationships between candidates, vacancies, tasks and interviews need consistent identifiers and explicit updates.
4. Missing or ambiguous CV facts require evidence and review rather than guesses.
5. A local file path and Windows File Explorer workflow do not translate directly to a hosted application.
6. A cloud application adds authentication, storage permissions, environment isolation and operational responsibilities that the local workflow did not address in the same way.

RecruitmentOS addresses these problems through a shared web workspace, structured records, explicit role permissions and traceable document provenance. A one-way, dry-run-first migration tool is included to transfer existing information while retaining source relationships. [Sources S1, S3 and S8]

## 4 Product vision and objectives

### 4.1 Product vision

Provide a practical recruitment workspace in which authorized team members can find reliable candidate information, manage recruitment activity and review supporting CVs without losing provenance or exposing another team's data.

### 4.2 Intended objectives

- Establish one authoritative database for candidates and recruitment operations.
- Make candidate records searchable by factual fields and source categories.
- Keep source evidence, review history and multiple CV versions attached to the correct person.
- Support the workflow from vacancy creation through application tracking, interviews, offers and onboarding.
- Preserve a clear distinction between a shared team record and a user's private follow-up state.
- Allow CVs to be added in bulk, with visible progress, recoverable failures and deliberate duplicate resolution.
- Offer AI extraction only when configured and authorized, producing reviewable factual suggestions before database changes.
- Provide a secure, recoverable first-administrator setup followed by invitation-based team access.
- Keep Preview and Production databases, storage and secrets separate.
- Establish evidence-based readiness rather than treating successful builds as proof of operational security.

### 4.3 Proposed success measures

The following are proposed measures, not measured current results or approved numeric targets:

| Outcome                     | Measurement                                                                  | Acceptance direction                                                                       |
| --------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Usable recruitment workflow | End-to-end completion of agreed recruiter scenarios                          | All release-critical scenarios pass with fictional data before pilot                       |
| Correct migration           | Reconciliation of source candidates, documents, relationships and exceptions | Every difference explained; no silent loss or guessed relationships                        |
| Trustworthy facts           | Sample review of saved values against source evidence                        | AI suggestions and source uncertainties remain distinguishable from approved facts         |
| Controlled access           | Positive and negative access tests across users, teams and environments      | No unauthorized access in the defined test suite; unresolved critical issues block release |
| Reliable bulk ingestion     | Per-file completion, rejection, retry and duplicate-resolution results       | Partial failure cannot silently create duplicate or incomplete accepted records            |
| Recoverable operation       | Backup restoration and interruption/retry exercises                          | Recovery procedure demonstrated against an agreed recovery objective                       |
| Sustainable cost            | Storage, transfer, email and optional AI usage reporting                     | Limits and alert thresholds agreed before real-data use                                    |

Recruiter time saved, adoption, support burden and extraction correction rate should be baselined during the pilot. No percentage improvement is claimed in this brief.

## 5 Stakeholders and responsibilities

Only the project owner is identified by name in the available context. The following operating responsibilities are proposed role assignments and require confirmation.

| Stakeholder or role            | Primary responsibility                                     | Decisions or evidence needed                                                       |
| ------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Project owner and sponsor      | Product scope, priorities, budget and release acceptance   | Confirm pilot participants, production purpose and spending limits                 |
| Recruitment lead               | Operational workflow and data quality                      | Approve field definitions, workflow stages and representative acceptance scenarios |
| Recruiters                     | Candidate review and recruitment processing                | Test search, record editing, CV review, tasks and candidate-to-vacancy flows       |
| Team owner                     | Membership and ownership administration                    | Verify invitations, role changes and last-owner protection                         |
| Team administrator             | Permitted team administration and data management          | Validate admin capabilities without owner-only privileges                          |
| Viewer                         | Read-only operational access                               | Validate that write and administration actions are denied                          |
| Engineering owner              | Implementation, testing and release artifacts              | Maintain requirements traceability and evidence for each enabled capability        |
| Database and security reviewer | Independent review of identity, privileges and isolation   | Assess the incomplete hosted boundary and proposed migration approach              |
| Service operator               | Environments, secrets, backups, monitoring and recovery    | Approve runbooks and demonstrate recovery and environment separation               |
| Privacy or data owner          | Candidate-data handling, retention and external processing | Confirm permitted collection, access, retention and AI processing arrangements     |

Application roles already represented in the code are owner, admin, recruiter and viewer. Organizational responsibilities above do not imply that all these roles are staffed today. [Sources S3 and S4]

## 6 Scope

### 6.1 Core workspace

The project scope includes:

- Public landing and authentication screens, with light, dark and system themes.
- Verified email/password access, password reset, invitations, teams and role-controlled access.
- Optional Google and Microsoft identity providers when explicitly configured and tested.
- Candidate directory, search and factual filters, saved personal views, private shortlist and follow-up notes.
- Candidate profiles with contact and professional facts, evidence, source review, CV references and shared discussion.
- Reusable job roles and separate vacancies.
- Applications linking candidates to vacancies, with explicit pipeline-stage changes.
- Recruitment tasks with configurable buckets, custom fields, owners, priorities and due dates.
- Interviews and calendar views; offers and onboarding checklists.
- Notifications, operational overview, analytics and audit history.
- Explicit exports and controlled API access through scoped, expiring and revocable user/team tokens.
- A dry-run-first migration path from the documented Excel and local-dashboard sources.

These capabilities are represented in the repository. Their production readiness varies and is addressed in Section 8. [Sources S1 through S4]

### 6.2 Bulk CV ingestion and optional AI

The user requested adding CVs in bulk and optionally using a connected AI service to analyze the documents and add information to the database. The delivery approach includes a human review step before extracted values are saved.

The intended flow is:

1. Select multiple supported documents and display a per-file queue.
2. Validate each file and obtain authorized private-storage access.
3. Record successful ingestion separately from extraction and candidate-record acceptance.
4. If AI is configured and the processing is authorized, extract supported factual fields through a provider adapter.
5. Present the original source and suggested values for review, including missing or rejected values.
6. Check possible duplicates and let the reviewer choose the appropriate candidate association.
7. Save only the reviewed values and record the source and reviewing actor.
8. Report partial success and allow safe retry or cancellation without repeating completed changes.

The currently inspected extraction schema accepts name, email, phone, job title, employer, university, degree, major, skills and certifications. It rejects unexpected fields and treats missing/null values as unknown rather than invented facts. That schema is narrower than the entire candidate data model. A concrete AI provider, OCR/document-processing approach, operational cost limits and provider data-handling arrangements are still open. No automated candidate ranking or hiring decision is part of this extraction scope. [Sources S6, S7 and C3]

### 6.3 Environment and platform work

- Separate Preview and Production Neon resources.
- Separate private Preview and Production Vercel Blob stores.
- Environment-specific secrets, canonical application origins and administrator setup configuration.
- Resend transactional email for verification, resets and invitations.
- Trusted identity and data access boundaries, migration controls and independent verification.
- Protected synthetic-data deployment before real CV use.
- Secure operational documentation, recovery procedures and release evidence.

### 6.4 Outside the current baseline

The following are not promised by the current scope:

- Automatic rejection, hiring recommendations, candidate suitability scoring or decisions based on sensitive characteristics.
- Inferring gender, nationality, residency or other unstated facts from names, photos or source-folder labels.
- Autonomous candidate outreach, interview invitations to external calendars or job-board publishing.
- Payroll, a full HR information system, background-check services or legal employment-contract management.
- Two-way synchronization with old Excel files or desktop SQLite state.
- Public candidate self-service and unrestricted self-registration.
- Native mobile applications.
- Full multilingual/OCR support, including scanned and password-protected CVs, until requirements and an implementation are agreed.
- A hard storage or billing cap that has not been demonstrated against provider behavior.
- A claim that the application is vulnerability-free, legally compliant in every jurisdiction or production-ready solely because tests pass.

## 7 Principal workflows and business boundaries

### 7.1 First administrator and team setup

The intended first administrator provides the configured email and a secure setup token, verifies the email, signs in and creates the first team as owner. The setup claim is designed to be durable, so deleting the first account does not reopen unrestricted bootstrap. Invitations govern subsequent membership by default. Hosted execution remains disabled until the database boundary and recovery cases are validated. [Source S4]

### 7.2 Recruiter daily work

A recruiter selects an authorized team, reviews the operational overview, searches candidates, checks source evidence and updates records or creates related work. Creating a task does not automatically create an application. Application stage, vacancy status, task bucket, offer status and onboarding status remain independent concepts. Offer acceptance does not silently mark an application hired. [Source S3]

### 7.3 Candidate documents and facts

A candidate may have multiple CV versions and source references. The record must retain which source supports a fact, distinguish unknown information from confirmed information and avoid overwriting a reviewed field merely because a later extraction suggests another value. Historical source-folder names remain descriptive categories, not a hiring assessment.

Private personal notes and shortlists remain user-scoped. Shared comments are explicitly team-visible. Exports inherit the sensitivity of the underlying records and require deliberate handling.

### 7.4 Migration

Migration begins with a private reconciliation report before any application writes or CV transfer. Original workbooks, files and SQLite state remain unchanged. Candidate and source identifiers preserve relationships; exceptions are surfaced rather than silently fixed. Apply mode is explicit and uses controlled authorization. The cloud database becomes canonical afterward. Imported historical records must not be presented as newly observed hiring transitions. [Source S8]

## 8 Current state and readiness

### 8.1 Evidence summary

| Area                         | Verified or recorded state                                                                                                                                                                    | What remains                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Source repository            | Public repository; PR #1 merged into `main` at `d67828e`                                                                                                                                      | Keep source publication separate from deployment and data migration                                                    |
| Core workspace               | Routes, components, domain logic, schema and tests exist                                                                                                                                      | Complete signed-in browser, accessibility and live-provider acceptance tests                                           |
| Local validation             | Repository records synthetic tests and local HTTP workflow checks; post-merge CI was reported passed                                                                                          | Re-run required checks on the exact release revision; validate actual service behavior                                 |
| Latest local preparation     | Implementation task reports bounded CV-read cancellation and extraction timeout/cancellation changes, with 219 application tests and 52 storage tests passed and one application test skipped | These later changes were reported local-only, not pushed or deployed; reconcile before release                         |
| Hosted identity and database | Explicit fail-closed guard remains; separate identity/data interfaces are staged                                                                                                              | Complete trusted tenant context, atomic token/audit behavior, restricted roles and real Neon tests                     |
| First administrator          | Page and local setup behavior exist                                                                                                                                                           | Independently review database safeguards and verify concurrent/recovery cases in the intended environment              |
| Neon resources               | Conversation records separate resources and matching environment scoping; Secrets status was verified in metadata                                                                             | Reverify actual database contents, roles, privileges and migrations before use                                         |
| Database credential rotation | User confirmed rotation after reconnection                                                                                                                                                    | Treat as user-confirmed history, not a new independent credential-rotation audit                                       |
| Private Blob                 | Separate stores reported created; isolated components and designs exist                                                                                                                       | Authorization, immutable-content verification, quotas, replay/retry behavior and live-provider tests remain incomplete |
| Bulk CV workflow             | Review UI, queue helpers and duplicate-related work exist                                                                                                                                     | Capability endpoint currently returns both uploads and AI unavailable                                                  |
| AI extraction                | Provider-neutral adapter contract and validation exist                                                                                                                                        | No selected/live provider integration; document processing, consent and usage limits remain open                       |
| Resend                       | Mail integration code exists; conversation records an installed integration and a Secret API key                                                                                              | Verify sender/domain readiness and actual delivered verification/reset/invitation flows                                |
| Deployment                   | Latest recorded outcome states no deployment                                                                                                                                                  | No verified functional live URL or production-readiness claim is made                                                  |

The latest implementation work is newer than the merged repository baseline. Test totals therefore refer to different revisions and must not be combined into one purported release result. This documentation exercise did not rerun the application test suite or inspect live cloud credentials. [Sources S5 through S7, S9, S10 and C4 through C6]

### 8.2 Known security dependency

The repository documents a design limitation: a caller with arbitrary SQL execution using the current shared/data-role context can choose tenant/user settings that are not independently trusted identity evidence. Synthetic tests also informed the separation of identity and recruitment-data access. This is a defined defensive boundary problem, not evidence that an exposed HTTP SQL-injection vulnerability has been demonstrated.

Splitting database roles affects token issuance/revocation, audit atomicity, membership checks and activity-name access. The incomplete boundary cannot be solved by simply turning off the guard or adding an isolated quota signature. The user asked to defer the Neon security review, but that does not establish technical readiness or remove the dependency. [Source S5; conversation decision on 3 November 2026]

## 9 Architecture

### 9.1 Application structure

The inspected application uses Next.js 16, React 19 and TypeScript, with Node.js 24 as the specified runtime. Better Auth provides the authentication framework. Drizzle ORM and PostgreSQL provide persistence, and PGlite supports explicitly local synthetic development and tests. Zod validates structured inputs. Vitest, native storage tests and GitHub Actions support validation. Exact dependency versions are pinned in the release files and should be reviewed from those files rather than inferred from this brief. [Source S2]

The high-level structure is:

```text
Browser workspace
    |
    | HTTPS requests and authenticated actions
    v
Next.js application and API routes on Vercel
    |
    +-- Better Auth and controlled identity operations
    |
    +-- Recruitment services and permission checks
    |       |
    |       +-- Neon PostgreSQL for team and recruitment records
    |
    +-- Private CV storage service
    |       |
    |       +-- Target Vercel Blob integration, currently disabled
    |       +-- Existing S3-oriented implementation and references
    |
    +-- Resend transactional email
    |
    +-- Optional AI extraction adapter, not connected to a live provider
```

This diagram describes logical responsibilities. It does not assert that all connections are active.

### 9.2 Data organization

Identity data includes accounts, sessions, verification, organizations, memberships, invitations and API-token lifecycle state. Recruitment data covers candidates and their evidence, roles, vacancies, applications, tasks, interviews, offers, onboarding and related records. Supporting structures hold private candidate state, activity, upload state, storage accounting, idempotency and notification-read state.

Relationships and permissions must be enforced on the server, including when requests come through API tokens. A selected team is not sufficient proof of membership. A candidate ID supplied by the browser must never grant access by itself.

### 9.3 Required environment separation

Preview and Production must use independent database resources, private file stores, runtime credentials, application secrets and setup tokens. Production data must not be copied into Preview for routine testing. Database-owner or migration credentials must remain outside application runtime configuration. Configuration values that are credentials must remain server-only Secrets.

The user has stated that the current setup is for testing and that approximately 1 GB is sufficient for current CV volume. This is a capacity-planning input, not a guarantee of a current vendor allowance, a per-store entitlement or zero cost. Current plan limits and suitability must be confirmed before operational use. [Source C2]

There is a specific configuration mismatch to resolve: the existing schema defaults to **10 GiB and 10,000 files per team**, while the user's testing expectation is approximately **1 GB of storage overall**. Per-team database counters do not establish an account-wide physical Blob limit, especially across two stores, multiple teams, abandoned uploads and external writers. The release plan must reconcile these defaults with the approved total budget, provider allowances and verified accounting behavior before enabling uploads. [Source S11]

### 9.4 Storage transition

The S3-oriented implementation validates uploaded content and uses version-pinned references. The Blob proposal attempts to ensure that downloaded bytes match previously validated content, while acknowledging that changed or deleted Blob objects may be rejected rather than recoverable as an earlier version.

Outstanding work includes binding each reference to its provider and store, authenticating every read/write, enforcing size and format rules, preserving accounting through uncertain outcomes and establishing safe behavior when upload capabilities are replayed or complete late. Private storage alone is not enough. The proposed integrity checks are not a malware-scanning solution. [Source S6]

### 9.5 Optional AI boundary

The extraction provider receives only approved document content for the defined purpose. Provider output is untrusted input: it must pass the field schema and human review before becoming a candidate fact. CV text must not be treated as executable instructions or authorization to call other tools. Provider availability, cancellation and output errors must not prevent manual review or silently discard a successfully stored document.

A production design still needs the selected provider, region and retention arrangements, document-processing route, supported languages and formats, concurrency policy, usage budget and operational error handling. Automatic ranking or decisions about hiring are outside this extraction feature.

## 10 Delivery plan and gates

The following sequencing is proposed. No calendar estimate is assigned because security-review availability, provider decisions and acceptance capacity are not established.

### Phase 0 Confirm the baseline

**Deliverables:** Agreed brief, BRD and SRS; source/revision inventory; open-decision register; explicit pilot scope.

**Exit gate:** Stakeholders agree what is implemented, what is disabled, which local changes are not yet in `main`, and which capabilities belong in the first usable test release.

### Phase 1 Complete hosted identity and data access

**Deliverables:** Reviewed privilege and tenant-boundary design; implementation and migrations; first-admin recovery behavior; token/audit transaction handling; environment-specific provisioning instructions.

**Exit gate:** Independent review and synthetic multi-connection tests against the intended Preview Neon database demonstrate authorized workflows and rejected cross-team, role and private-state access. Actual roles and grants are verified. No guard is removed solely to obtain a working login page.

### Phase 2 Establish a protected core test release

**Deliverables:** Environment configuration, Resend verification, protected deployment and exact release evidence; recruiter acceptance script.

**Exit gate:** Verified admin setup, email delivery, sign-in, invitations, role enforcement, core record workflows and deployment protection using fictional data. Browser testing covers desktop/mobile layouts, keyboard operation, cancellation, conflicts and failed requests.

### Phase 3 Complete private CV handling

**Deliverables:** Provider-bound CV references, safe upload and completion, validated download behavior, durable accounting, cleanup/reconciliation and bulk per-file processing.

**Exit gate:** Synthetic live-provider tests pass for environment/team isolation, file constraints, unauthorized access, changed objects, retries, expiry, cancellation, replay and concurrent/late completion. Storage claims match what provider guarantees and evidence actually support.

### Phase 4 Add optional AI extraction

**Deliverables:** Approved provider configuration, document-processing flow, explicit processing consent, structured extraction, source-linked human review and usage/error controls.

**Exit gate:** Fictional CV cases demonstrate valid extraction, unknown fields, invalid provider responses, timeout/cancellation, duplicates and reviewed saves. No real CV is transmitted before the relevant data-processing authorization and arrangements are established.

### Phase 5 Pilot and migrate

**Deliverables:** Agreed pilot users, reconciled dry-run report, backups, controlled migration, training and support instructions.

**Exit gate:** Migration counts and relationships reconcile; private notes remain private; unresolved exceptions are accepted explicitly; restore and rollback procedures are demonstrated. Real-data use receives the responsible owner's approval.

### Phase 6 Operate and improve

**Deliverables:** Operational ownership, monitoring, retention/deletion routines, incident procedure, measured usage and improvement backlog.

**Exit gate:** Production acceptance, suitable hosting/service arrangements and documented support ownership. Optional enhancements are prioritized from actual pilot results rather than assumed needs.

## 11 Deliverables

The project should produce the following controlled artifacts:

1. Project brief, business requirements and software requirements with aligned scope and status.
2. Versioned source code and migration files, including documented differences between local and published revisions.
3. Reviewable identity, tenant-boundary and storage designs with evidence of resolved blockers.
4. Separate environment configuration and secret-handling runbooks, without secret values in documents.
5. Protected test release tied to an exact source revision and deployment identifier.
6. Core workflow and bulk-ingestion acceptance results.
7. Optional AI integration documentation and review/processing controls, if that capability is selected.
8. Migration reconciliation and rollback procedure kept privately with authorized operators.
9. User guide, administrator guide and support/runbook handover.
10. Release checklist, known limitations and formal acceptance record.

## 12 Dependencies and constraints

| Dependency or constraint                    | Impact                                                              | Required resolution                                                   |
| ------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Incomplete trusted identity boundary        | Hosted private operations cannot be considered ready                | Finish reviewed implementation and live isolation evidence            |
| Independent database review                 | Certain database work remains unresolved                            | Obtain authorized review; do not reclassify deferred review as passed |
| Blob guarantees and accounting              | Secure uploads/downloads and capacity claims remain blocked         | Resolve provider behavior and implement verified control path         |
| Resend sender readiness                     | Initial-admin verification and account recovery depend on mail      | Verify sender configuration and delivered messages                    |
| AI provider undecided                       | No live extraction integration can be specified as final            | Select provider and agree processing, formats and usage limits        |
| Free/testing-oriented setup                 | Capacity and intended use may differ from business production needs | Confirm plan suitability and budget before production operation       |
| Legacy data quality and source access       | Migration may contain missing files, duplicates or uncertain facts  | Reconcile and review exceptions before apply                          |
| Local changes after merge                   | Published source may not include latest fixes                       | Reconcile, review and validate exact release revision                 |
| Browser and live-service testing incomplete | Local test pass does not establish user-facing readiness            | Complete acceptance and provider checks                               |
| Operational policy not finalized            | Retention, deletion, recovery and support obligations unresolved    | Assign owners and approve practical policies                          |

## 13 Risks and responses

| Risk                                                                   | Consequence                                                     | Planned response                                                                           |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Treating scaffolding as a finished service                             | Users encounter nonfunctional or unsafe workflows               | Maintain capability gates and an explicit readiness matrix                                 |
| Cross-team access through an untrusted database context                | Candidate or identity data exposure                             | Complete independent boundary review and negative tests before activation                  |
| First-admin takeover or unrecoverable setup interruption               | Loss of control or inability to access the system               | Verify one-time claim, email verification, concurrency and recovery behavior               |
| CV bytes change after validation                                       | A download could differ from reviewed source                    | Bind trusted content identity to each ready CV and reject mismatches                       |
| Replay, abandoned uploads or late completion                           | Quota exhaustion and orphaned objects                           | Durable accounting, controlled capabilities and provider-backed cleanup evidence           |
| AI supplies plausible but unsupported facts                            | Incorrect candidate records                                     | Strict schemas, provenance, visible uncertainty and human approval                         |
| CV text contains malicious instructions                                | Unintended actions or disclosure through processing             | Treat documents as data; isolate extraction from operational privileges                    |
| Candidate data leaks through exports, logs or public source control    | Privacy and reputational harm                                   | Minimize logging, prohibit real data in the public repository and control exports          |
| Migration silently merges the wrong people                             | Corrupted history and candidate decisions                       | Stable identifiers, duplicate review and reconciliation reports                            |
| Private notes become shared                                            | Breach of recruiter expectations                                | Preserve user ownership through migration and access tests                                 |
| Test and production resources are mixed                                | Unexpected exposure or destructive testing                      | Verify environment binding, independent secrets and no production-data cloning             |
| Low-cost limits are mistaken for guaranteed headroom                   | Service interruption or unexpected operating cost               | Monitor combined usage, define budgets and verify current provider terms                   |
| Existing 10 GiB per-team default exceeds the expected testing envelope | Application allocations can outgrow the intended total capacity | Reconcile team/store/global budgets before enabling Blob; do not claim a hard physical cap |
| Operational ownership is unclear                                       | Incidents, failed mail or broken backups remain unresolved      | Assign named support and recovery owners before launch                                     |

## 14 Decisions and open questions

### 14.1 Established direction

- A cloud recruitment workspace is the target, with PostgreSQL as the canonical data store.
- Preview and Production resources must remain separate.
- Private Vercel Blob is the chosen testing direction, replacing the earlier S3 provisioning request; implementation is incomplete.
- The application needs a secure first-time administrator page.
- Bulk CV ingestion and optional AI extraction are required, with a review step in the agreed implementation approach.
- The email sending domain changes to `recruitmentos.ae`; that change does not change the administrator's login identity.
- Database variables were reported verified as Secrets in their matching environments, and the user confirmed credential rotation.
- The current hosted-feature safeguards remain in place.

### 14.2 Decisions still needed

1. Who is the formal release approver, recruitment acceptance owner and long-term operator?
2. What constitutes the first usable pilot: core records only, or core records plus CV ingestion?
3. When and by whom will the deferred database/security review be completed?
4. Which AI provider, model and document-processing method should be supported first?
5. Which document formats, languages and scanned-CV cases are mandatory, and what are acceptable extraction limits?
6. What are the approved data-retention, deletion, malware/quarantine and AI-processing policies?
7. What usage, storage, email and AI budgets apply, and who approves an increase?
8. What recovery-time and recovery-point objectives are appropriate for the first operational release?
9. Which candidate and workflow fields are mandatory for the pilot, and which remain optional?
10. What jurisdictions, data-location expectations and production hosting arrangements apply to business use?

These are decision requests for planning. They do not block documenting the current system, and they should not be filled with assumptions presented as agreement.

## 15 Release acceptance principles

A release should be accepted only for the capabilities actually enabled and tested. The evidence pack should identify the exact commit, environment, migrations, configuration review, test data and results.

Minimum principles are:

- Required automated checks pass on the intended release revision, with skipped checks and their impact disclosed.
- Live identity, database, email and storage behavior is verified where those services are enabled.
- Access-denial scenarios are tested alongside successful workflows.
- Real candidate data is excluded from Preview testing and public source control.
- Bulk operations preserve completed work and expose failures without silent duplication.
- AI remains optional and cannot silently replace reviewed candidate facts.
- Browser acceptance includes keyboard use, interrupted operations, stale edits, mobile layouts and failure states.
- Backups, restoration, retention, monitoring and operating ownership are documented and tested to the agreed level.
- Known limitations and unresolved risks are explicitly accepted by the responsible owner rather than omitted.

The recommended next planning action is to agree the pilot boundary and assign the owner of the unresolved identity/security review. That establishes a credible path to a usable protected release without implying that deployment, migration or AI processing has already occurred.

## 16 Sources and evidence

Repository links below are pinned to the inspected commit where practical. They describe this baseline, not every later local change.

| ID  | Source                                                                                                                                                                                                                                                                                                          | Used for                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| S1  | [README](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/README.md)                                                                                                                                                                                                    | Product modules, local/cloud distinction and validation approach                                 |
| S2  | [Package manifest](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/package.json)                                                                                                                                                                                       | Technology stack and scripts                                                                     |
| S3  | [Workspace user guide](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/user-guide.md)                                                                                                                                                                             | Recruitment workflow semantics, privacy and source evidence                                      |
| S4  | [Authentication and team setup](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/authentication.md)                                                                                                                                                                | Hosted guard, setup, roles, invitations and identity providers                                   |
| S5  | [Identity boundary plan](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/identity-boundary-plan.md)                                                                                                                                                               | Incomplete boundary, dependencies and review requirements                                        |
| S6  | [Blob security design](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/blob-security-design.md) and [quota design](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/blob-quota-design.md)                            | Proposed storage controls and unresolved provider/accounting issues                              |
| S7  | [Bulk capability route](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/app/api/v1/cvs/bulk-capabilities/route.ts) and [extraction contract](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/domain/cv-extraction.ts) | Disabled capabilities and current extraction field schema                                        |
| S8  | [Legacy migration guide](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/migration.md)                                                                                                                                                                            | One-way migration, reconciliation and preservation rules                                         |
| S9  | [Validation record](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/docs/validation.md)                                                                                                                                                                                | Synthetic/local evidence and outstanding staging tests                                           |
| S10 | [Merged PR 1](https://github.com/omarals95/RecruitmentOS/pull/1) and [reported post-merge CI](https://github.com/omarals95/RecruitmentOS/actions/runs/41629231131)                                                                                                                                              | Published-source milestone; CI result is also recorded in project history                        |
| S11 | [Application schema](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/src/db/schema.ts) and [initial application migration](https://github.com/omarals95/RecruitmentOS/blob/d67828ed0889849ea0fc431949288f7c10061dda/drizzle/0001_app.sql)                              | Existing per-team storage defaults and accounting structure                                      |
| C1  | User conversation, 3 November 2026, 05:18 UTC                                                                                                                                                                                                                                                                   | Separate environments and initial-admin request                                                  |
| C2  | User conversation, 3 November 2026, 05:19–05:26 UTC                                                                                                                                                                                                                                                             | Testing purpose, Blob direction and approximate current capacity need                            |
| C3  | User conversation, 3 November 2026, 09:39 UTC                                                                                                                                                                                                                                                                   | Bulk CV and optional AI request; review-step implementation response                             |
| C4  | User conversation, 3 November 2026, 09:21–09:39 UTC                                                                                                                                                                                                                                                             | Sending-domain distinction, environment-secret verification and user-confirmed rotation          |
| C5  | User conversation, 3 November 2026, 10:48–11:42 UTC                                                                                                                                                                                                                                                             | Deferred database review, merge request and continuing hosted-feature limitations                |
| C6  | Latest completed implementation report inspected on 3 November 2026                                                                                                                                                                                                                                             | Local-only cancellation preparation, latest test totals, disabled capabilities and no deployment |

**Evidence limitation:** Cloud resource state, credential contents, external email delivery, live tenant isolation and an operational deployment were not independently revalidated while preparing this brief. Existing documentation contains both the older S3 path and the newer Blob direction; where they differ, the intended direction and implementation gap are stated explicitly.
