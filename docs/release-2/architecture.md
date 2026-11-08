# Release 2 architecture: configurable platform

_Design only (R2-00, job 041), 8 November 2026. Nothing here is built yet. The owner reviews this design and decides the open decisions in section 13 before any Release 2 build job is queued. The build order is in [build-plan.md](build-plan.md)._

This document designs Release 2 as described in [ROADMAP.md](../ROADMAP.md#release-2--configurable-platform): epics R2-01 to R2-12, milestones R2a to R2d, the merged R1.6 workflow-designer requirements (R16-01 to R16-10) and the R1.2 items delivered through Release 2 (R12-01, R12-02, R12-03, R12-07). Every section starts from the code as it is on main at migration `0027`, then states the proposed design as specific choices.

**Conventions.** Anything marked _proposed_ or _new_ does not exist yet: files, tables, columns, functions, scopes and settings. Everything else is cited from the repository. SQL and TypeScript shapes are illustrative and proposed. Examples use fictional names only (for example the fictional company "Fictional Holdings" and the fictional candidate "Sample Candidate"). Migrations are named by the build item that adds them and numbered after the highest on main at build time, never by a fixed number here.

**Principles carried over.** Facts, not verdicts: no rule ranks, scores or hires anyone. Private stays private: personal follow-up, private saved views and reminder read state are never shared by any role. Gated by evidence: every milestone ships to Preview with fictional data only and is tested there by the owner. Owner approval for new data recipients: candidate email through Resend is covered by owner decision 4; no other recipient is added.

## Tenancy decision

**Today.** A team is a Better Auth organization: `organization` and `member` in `src/db/auth-schema.ts`, with `member.role` a plain string limited to the four roles in `src/lib/auth-roles.ts`. Nothing sits above a team. Every business row carries `team_id` (`src/db/schema.ts`), and every policy checks it: first `drizzle/0002_rls.sql`, then the signed per-transaction context of `drizzle/0006_trusted_tenant_context.sql`, where `tenant_context.install` stores one context row per backend pid and transaction id and the `context_read`, `context_insert`, `context_update` and `context_delete` policies call `tenant_context.allows`, `allows_activity` and `allows_event`. `withTeam` (`src/lib/db-team.ts`) installs that context right after the transaction's first statement, which sets the deadlines and reads the snapshot it is signed for (`src/lib/tenant-context.ts`).

**The conflict.** Owner decision 3 says one workspace is one company and fields, workflows, roles and the org chart are configured once for the company and shared by its teams. Team-keyed tables and team-keyed policies cannot hold one row that several teams read.

**Recommendation: a company workspace above teams, with team isolation unchanged.**

- **Where company configuration lives.** Two new tables (proposed): `app.workspaces` (`id uuid`, `name`, `created_at`; section 8 adds the AI connection switches) and `app.workspace_teams` (`team_id text PRIMARY KEY REFERENCES auth.organization(id)`, `workspace_id uuid NOT NULL`). Every company-level row (configuration objects and versions, org levels and units, positions, employees, templates, recruitment plans) carries `workspace_id` and no `team_id`. Team data (records, candidate states, uploads, activity, notification reads, generated documents, outbound messages) keeps `team_id` and its existing policies.
- **One workspace per environment in Release 2.** The migration creates one workspace ("the company") and maps every existing team to it. A new owner-owned trigger function (proposed) `app.map_new_team()` on `auth.organization` inserts the mapping for every new team. It refuses when more than one workspace exists, so a second company is a later, explicit decision. Neither runtime role is granted any write on `app.workspace_teams`; only the trigger and the migration owner write it.
- **How teams read it.** `tenant_context.install` reads the caller's team mapping and stores the `workspace_id` in its context row (a new column, proposed, on `tenant_context.contexts`). The signed payload does not change: the workspace is derived inside the database from the verified team, so it cannot be forged. A new policy helper (proposed) `tenant_context.allows_workspace(row_workspace uuid, access text, area text)` returns true only for the current context of this pid and xid, unexpired, whose derived `workspace_id` equals the row's, and, for `write`, only for a session context whose derived configuration rights include `area` (section 3). Company tables use `context_read`, `context_insert`, `context_update` and `context_delete` policies built on it, in the same pattern as the existing `allows` policies.
- **What does not change.** Every team-keyed table keeps its `allows` policies exactly. A member of team A still cannot read a single record, candidate state, upload or activity row of team B, even though both teams read the same company field definitions. Company tables hold configuration and directory data only, never a team's record values (section 1 rules out record references in configuration).
- **Rejected alternatives.** Copying configuration into every team breaks decision 3 (teams drift apart). Treating one team as the company removes team isolation between, for example, a graduate-hiring team and an executive-search team. Per-workspace database roles were already rejected for teams in `docs/identity-boundary-plan.md`.

This is recorded as open decision D1 in section 13.

## 1. Configuration data model

### 1.1 Starting point

All business records live in `app.records` (`src/db/schema.ts`): `kind`, a JSON `data` column validated by the strict zod schemas `recordDataSchemas` in `src/domain/records.ts`, `version` for optimistic locking, typed references (`candidateId`, `vacancyId`, `applicationId`, `onboardingId`, `bucketId`, `jobRoleId`, `parentRecordId`), `privateOwnerId`, `importMeta` and `archivedAt`. The only configurable structure today is per team: `bucket` records (with `completed` from `drizzle/0012_completed_done_buckets.sql`), `task-field` records (`TASK_FIELD_TYPES`, five types) and the `customValues` map on tasks keyed by field id, checked by `checkCustomValues` in `src/lib/records.ts`. Labels and form fields come from `RESOURCE_CONFIG` in `src/domain/records.ts`, derived from the zod shapes.

### 1.2 Where configuration lives

**Choice: new company-level tables, not `app.records.data`.** `app.records` rows are team-keyed (`team_id NOT NULL`) and protected by team policies, so a company-wide definition cannot live there (tenancy decision). Configuration also needs immutable versions, a single draft, publish states and a stable identity across versions, which `app.records.version` (an edit counter) does not give. High-cardinality structures that need indexes and erasure (org units, positions, employees, plan lines) get typed tables. Small, document-shaped definitions (fields, screens, types, workflows, boards, roles, templates) share one versioned store whose bodies are validated by zod schemas in TypeScript.

The versioned store (all proposed):

| Table                     | Columns                                                                                                                                                                                                                   | Purpose                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `app.config_objects`      | `id uuid`, `workspace_id uuid`, `type text`, `key text`, `current_version_id uuid null`, `draft_version_id uuid null`, `created_by`, `created_at`, `archived_at`; unique `(workspace_id, type, key)`                      | Stable identity of one definition, for example the application workflow        |
| `app.config_versions`     | `id uuid`, `object_id uuid`, `workspace_id uuid`, `number int`, `state text` (`draft`, `published`, `retired`), `body jsonb`, `body_sha256 text`, `created_by`, `created_at`, `published_by`, `published_at`, `note text` | One immutable published body per number, plus at most one draft per object     |
| `app.config_layouts`      | `version_id uuid PRIMARY KEY`, `workspace_id uuid`, `layout jsonb`, `updated_by`, `updated_at`                                                                                                                            | Editor-only layout (the workflow canvas), kept apart from semantics (§4.8)     |
| `app.member_roles`        | `team_id text`, `user_id text`, `role_object_id uuid`, `assigned_by`, `assigned_at`; primary key `(team_id, user_id)`                                                                                                     | Which configured role a member holds in a team (section 3)                     |
| `app.record_assignments`  | `team_id text`, `record_id uuid`, `user_id text`, `relation text`, `scope_application_id uuid null`, `scope_vacancy_id uuid null`, `created_by`, `created_at`                                                             | Assigned and stakeholder relations used by record scope (section 3, section 6) |
| `app.org_levels` and more | See section 6 (org), section 7 (templates) and section 9 (plans)                                                                                                                                                          | Typed company tables                                                           |

**Immutability.** A new trigger function (proposed) `app.guard_config_version()` refuses any update of `body`, `body_sha256`, `number` or `object_id` once `state` is `published`, allows only `draft → published` and `published → retired`, and refuses every delete of a published or retired version. Drafts may be edited and deleted.

**Bounds.** Every body is validated against its zod schema in a new file (proposed) `src/domain/config.ts` before it is written, and the trigger refuses bodies over 512 KiB. Labels are at most 120 characters, help text 500, option values 200, all trimmed, with control, format, bidi and zero-width characters removed as `src/lib/client-name.ts` does for OAuth client names (section 11).

**No record values in configuration.** Configuration bodies may name record kinds, field keys, status keys, role ids, org unit ids and user ids. They may not hold record ids or record values (a lookup field's default value is refused), so company configuration cannot carry one team's data to another team.

### 1.3 Versioning, drafts and pinning

- **One draft, many published versions.** Editing creates the object's single draft (a copy of the current published body). Publishing validates the draft (section 4.6 for workflows), assigns the next `number`, sets `state = published`, moves `current_version_id` to it and retires nothing: older versions stay readable for records pinned to them.
- **Pinning.** Two new nullable columns on `app.records` (proposed): `schema_version_id uuid` and `workflow_version_id uuid`, plus `type_id uuid` for the record's category or type (section 1.5). A record pins the kind schema version it was last validated against and, for workflow kinds, the workflow version it runs on. `null` means the built-in default version compiled from code (section 2), so no existing row needs rewriting on day one.
- **Re-pinning.** A successful create or update validates against the current published kind schema and stores its id. A workflow pin changes only through the in-flight migration (section 4.7).
- **Audit.** Every create of a draft, publish, retire, archive and layout change writes one `app.activity` row through a new owner-run `SECURITY DEFINER` helper (proposed) `tenant_context.audit_config(version_id uuid, action text)`. The row is written to the acting member's team with `kind = 'config'`, `action` one of `config.draft_created`, `config.published`, `config.retired`, `config.archived`, `config.layout_changed`, and metadata built by the helper from the version row: `{workspaceId, objectId, type, key, versionId, number, fromVersionId}`, never the body. The `app.activity` insert policy gains one owner-only branch for `kind = 'config'`, in the pattern `drizzle/0026_mcp_cv_tools.sql` uses for `storage-settings`, so a runtime role cannot forge a configuration event. A new owner-run read helper (proposed) `tenant_context.config_history(object_id uuid, before timestamptz, page_size int)` returns `config` rows of every team in the caller's workspace to members with any configuration right, because a company change made from team A must be visible to the admins of team B.

### 1.4 Each configuration object

| Object                         | Lives in                                                                               | Why there                                                          | Versioning and pin                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Field definitions              | `config_versions.body` of one `kind-schema` object per kind (proposed)                 | Company-wide, small, edited together with screens                  | Published kind schema versions; records pin `schema_version_id`                                               |
| Screens                        | Same `kind-schema` body: screens per type and action                                   | A screen only makes sense against one field set                    | Same version as the fields; transition screens are referenced by workflow versions by screen key              |
| Categories and types           | `kind-schema` body: `types[]` with stable ids                                          | A type selects screens and a workflow                              | Same version; records hold `type_id`, which stays stable across versions                                      |
| Workflows                      | One `workflow` object per workflow (proposed)                                          | Large, edited and published on their own                           | Published workflow versions; records pin `workflow_version_id`                                                |
| Boards                         | One `board` object per board                                                           | Company-defined; refer to a workflow by object id                  | Published versions; a board follows its workflow's current version (section 5)                                |
| Roles and permission schemes   | One `role` object per role; the permission scheme is the role body                     | Owners edit them; must be versioned and audited                    | Published versions; the context stores the role version it used (section 3)                                   |
| Org levels and units           | Typed tables `app.org_levels`, `app.org_units`, `app.org_unit_closure` (proposed)      | Up to 2,000 units, hierarchy queries in row policies               | Effective-dated rows: a change closes the old row and inserts a new one; records reference the stable unit id |
| Positions                      | Typed table `app.positions` (proposed)                                                 | Joined to employees and vacancies; indexes needed                  | Effective-dated rows like units                                                                               |
| Employees                      | Typed tables `app.employees`, `app.employee_positions` (proposed)                      | Personal data under erasure and retention (section 11)             | Not versioned: changes are audited by field name only, so an erasure leaves no copies of old values           |
| Templates                      | One `template` object per template; uploaded files in `app.template_files` (proposed)  | Versioned bodies; files go through CV storage validation           | Published versions; a generated document pins the template version (section 7)                                |
| Recruitment plans              | Typed tables `app.plans`, `app.plan_versions`, `app.plan_lines` (proposed)             | Confidential figures need their own row policy; up to 50,000 lines | Scenario versions `draft`, `submitted`, `approved`, `superseded`; approved versions immutable (section 9)     |
| Task boards and projects       | One `task-board` object per board (proposed)                                           | Company definitions, applied per team                              | Published versions (section 10)                                                                               |
| Team-level task custom fields  | Existing `task-field` records in `app.records`, unchanged                              | They are team data today and stay so (section 10)                  | Record `version` as today                                                                                     |
| Shared views and private views | `app.records`: existing `saved-view` (private) and a new `shared-view` kind (proposed) | They are team data, not company configuration                      | Record `version` as today                                                                                     |
| AI connection limits, switches | `auth.api_tokens.limits` (proposed column) and `app.workspaces` switches               | Enforced where tokens are verified (section 8)                     | Audited changes; not versioned                                                                                |

### 1.5 Dynamic validation with the strict schemas authoritative

1. **System fields stay in `recordDataSchemas`.** Every key in today's zod shapes is a system field. The strict zod schema runs first on every create and update, exactly as in `createRecord` and `updateRecord` in `src/lib/records.ts`, and its bounds (lengths, enums, number ranges, date formats) cannot be loosened by configuration.
2. **Custom values in `data.customValues`.** Every configurable kind (candidate, job-role, vacancy, application, task, interview, offer, onboarding, checklist) gains an optional `customValues` system key of the same shape tasks already use: a map from field definition id to a bounded JSON value. Tasks keep theirs unchanged. A field id is a stable uuid across versions, so renaming a field never rewrites data.
3. **Configuration can only tighten system fields.** A system field may be relabelled, given help text, reordered, grouped, hidden on a screen, or made mandatory on a screen or transition. Its type, bounds, options and existence cannot change. Removing a system field is refused (R2-02: "Built-in system fields can be relabelled but not removed").
4. **A compiled validator per kind schema version.** A new pure module (proposed) `src/domain/field-types.ts` defines the 19 R2-02 data types (short text, long text, rich text, number, money with currency, percentage, date, date-time, dropdown, multi-select, checkbox, person, org unit, URL, email, phone, file, lookup), each with a zod builder from its definition (min/max, pattern, options, default). `compileKindSchema(version)` returns one zod object for `customValues` plus the mandatory rules per screen and action. It is cached in process by version id (immutable, so the cache cannot be stale).
5. **Mandatory rules on edit.** Creation enforces the create screen's mandatory fields. An edit may not clear a mandatory field, but a field that became mandatory after the record's pinned version may stay empty until a transition validator requires it, so publishing a new mandatory field never blocks unrelated edits of older records.
6. **Archived fields keep values.** As `checkCustomValues` does for archived task fields today, a value of an archived field must be preserved unchanged and cannot be removed.
7. **References in fields.** Person fields hold a user id that must be a member of the record's team; org unit fields an id of a unit in the workspace; lookup fields a record id of the named kind in the same team, checked like `checkReferences` (a record the caller cannot see is answered as missing).

## 2. Today's fixed elements become defaults

### 2.1 The built-in default version

The defaults are compiled from code, not inserted as rows: a new module (proposed) `src/domain/config-defaults.ts` builds the default kind schemas, workflows, boards and role templates from today's constants, each with a fixed, well-known version id (for example `00000000-0000-4000-8000-000000000001` for the default application workflow). A workspace with no published object of a type uses the default. The first edit in the Admin portal creates a draft that starts as a copy of the default, and its first publish becomes version 2 (version 1 is the default). This makes the in-place migration trivial: nothing to insert, nothing to rewrite, idempotent by construction.

### 2.2 Mapping table

| Today (`src/domain/records.ts` unless noted)                                                                               | Default configuration                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordDataSchemas.candidate` (name, email, phone, education, experience, sensitive, source and review fields)             | Default candidate kind schema: one system field per key in schema order, type from `RESOURCE_CONFIG` (`text`, `textarea`, `number`, `tags`, `json`, `select`), labels from `fieldLabels`, `name` mandatory, `rawSource`, `evidence`, `sourceReviews` read-only, `explicitGender` and `nationalServiceStatus` flagged sensitive (`SENSITIVE_CANDIDATE_FIELDS`). One screen per action with every field |
| `recordDataSchemas["job-role"]`, `vacancy`, `application`, `interview`, `offer`, `onboarding`, `checklist`, `task`         | The same rule per kind: every key a system field, today's `required` set (`name`, `title`, `body`, `startAt`) mandatory, today's editor order on every screen. Labels "Recruitment tasks" and "Task" stay until R2a-20 changes them (section 10)                                                                                                                                                      |
| `bucket`, `task-field`, `saved-view`, `comment` kinds                                                                      | Not configurable kinds. Their schemas and REST resources stay as they are                                                                                                                                                                                                                                                                                                                             |
| `APPLICATION_STAGES` (Sourced, Screening, Interview, Offer, Hired, Rejected, Withdrawn)                                    | Default application workflow: seven statuses with keys equal to the stage names and reporting category equal to the stage; one global transition into every status from every other status (today any stage can be set); no condition, validator or post-action                                                                                                                                       |
| Vacancy status (Draft, Open, On hold, Filled, Closed)                                                                      | Default vacancy workflow: five statuses, category equal to the status, global transitions                                                                                                                                                                                                                                                                                                             |
| Offer status (Draft, Sent, Accepted, Declined, Withdrawn, Expired)                                                         | Default offer workflow, same rule                                                                                                                                                                                                                                                                                                                                                                     |
| Interview status (Scheduled, Completed, Cancelled, No show)                                                                | Default interview status list: a workflow with global transitions, same rule                                                                                                                                                                                                                                                                                                                          |
| Onboarding status (Planned, In progress, Completed, On hold) and checklist status (Pending, In progress, Complete, Waived) | Default onboarding and checklist status lists, same rule                                                                                                                                                                                                                                                                                                                                              |
| Other enums (`offer.payPeriod`, `checklist.category`, `task.priority`, `REVIEW_STATUSES`, `CANDIDATE_STATUSES`)            | System dropdown fields with fixed options. `CANDIDATE_STATUSES` stays private follow-up in `app.candidate_states` and is never configurable                                                                                                                                                                                                                                                           |
| Task buckets with `completed`                                                                                              | Unchanged team records. The default task board shows every active bucket in `position` order; "Counts as completed" keeps its meaning for overdue lists and reminders                                                                                                                                                                                                                                 |
| `task-field` records and `TASK_FIELD_TYPES`                                                                                | Unchanged team records; they become team-level task fields validated by the shared field-type engine. The five types map to short text, number, date, dropdown and checkbox                                                                                                                                                                                                                           |
| Roles owner, admin, recruiter, viewer (`src/lib/auth-roles.ts`, `roleScopes()` in `src/lib/permissions.ts`)                | Four built-in role templates with exactly today's effect: owner and admin every scope, recruiter every scope but `imports:write`, viewer read scopes only and no writes; every page; every field editable; record scope all. Owner-only rules (erasure, two-step reset, storage settings, team creation) stay in code and are mirrored as actions only the owner template holds                       |
| New: hiring manager and interviewer                                                                                        | Two more built-in templates (R2-06), assigned to nobody on day one (section 3.3)                                                                                                                                                                                                                                                                                                                      |

**Statuses keep the stored values.** A workflow status is stored in a new column (proposed) `app.records.workflow_status text`, while the system field (`data.stage` for applications, `data.status` for the others) keeps holding the status's reporting category. With the default workflows the two are equal. This keeps every query that reads `data->>'stage'` or `data->>'status'` working unchanged: `src/lib/insights.ts` (stage counts, analytics, reminders), saved-view `stage` filters, the export filters, the REST `stage` query and the MCP `move_application_stage` tool.

### 2.3 The in-place migration

- **Schema only.** New tables and nullable columns. No `UPDATE` of `app.records.data`, `app.candidate_states` or `app.activity`; `null` pins mean the default version. The migration is idempotent (`CREATE … IF NOT EXISTS`, the workspace insert `ON CONFLICT DO NOTHING` keyed by a fixed id, the team mapping `INSERT … SELECT … ON CONFLICT DO NOTHING`).
- **No visible change on day one.** REST request and response shapes, OpenAPI, MCP tool names, inputs and outputs, UI labels and layout are identical until an owner publishes a change. `customValues` appears on a non-task record only after a custom field is defined and filled; it is never added to existing rows by the migration.
- **How the existing tests prove it.** Every existing suite runs unchanged and must pass: `tests/records-postgres.test.ts`, `tests/records-domain.test.ts`, `tests/mcp-pipeline-tools.test.ts`, `tests/mcp-candidate-task-tools.test.ts`, `tests/mcp-cv-tools.test.ts`, `tests/openapi-contract.test.ts`, `tests/insights-postgres.test.ts`, `tests/record-export.test.ts`, `tests/tenant-context.test.ts`, `tests/round-trip-budget.test.ts` and `tests/migration-upgrade.test.ts`. A new test file (proposed) `tests/config-defaults.test.ts` asserts that the compiled defaults reproduce `recordDataSchemas` keys and order, `RESOURCE_CONFIG` labels and types, the seven stages and five enums, and `roleScopes()` for each role. `tests/migration-upgrade.test.ts` gains a case that applies the Release 2 migrations to a populated fictional `0027` baseline and compares every REST list and get response before and after, byte for byte.

## 3. Permission engine

### 3.1 Starting point

The checks are spread over several places:

- `permission()` in `src/lib/records.ts` (lines 53-65) maps a resource to `candidates:*` or `recruitment:*` and refuses writes for viewers.
- `owned()` (lines 268-280) filters every query by team and kind, restricts saved views to their private owner and hides candidate comments without `candidates:read`.
- `importPermission()` (lines 66-76) requires an owner or admin with `imports:write`.
- `roleScopes()` in `src/lib/permissions.ts` gives each role its scopes. `requirePrincipal()` in `src/lib/principal.ts` builds the `Principal`; token scopes are intersected with the holder's current role in `src/lib/api-tokens.ts`, and OAuth consent offers only `MCP_SCOPES` the role holds (`src/lib/oauth.ts`).
- Insights call `requireScope` directly (`overview`, `analytics`, `listActivity`, `searchWorkspace`, `notifications` in `src/lib/insights.ts`). MCP tools declare `scopes` and the dispatcher checks them before running (`src/lib/mcp/tools.ts`).
- In the database, `tenant_context.install` checks the asserted scopes against a hard-coded `known` list and a hard-coded ceiling per role, and the coarse write gate in `allows` needs any write scope (`docs/identity-boundary-plan.md`, "Coarse write gate").

### 3.2 One authorization function

A new module (proposed) `src/lib/authz.ts` holds the only authorization decision. Its core (proposed):

```ts
// Proposed. One decision for UI, REST, exports, search, notifications, insights, activity, templates and MCP.
type Action =
  | "view"
  | "create"
  | "edit"
  | "transition"
  | "archive"
  | "export"
  | "erase"
  | "approve"
  | "import"
  | "comment"
  | "share-view"
  | "admin";
interface AccessRequest {
  page?: PageKey; // overview, candidates, vacancies, …, directory, plan, admin
  resource?: ResourceName | CompanyResource; // "candidates", "org-units", "plans", …
  action: Action;
  record?: { kind: RecordKind; typeId: string | null; status?: string };
  adminArea?: AdminArea; // fields, workflows, boards, roles, organisation, templates, ai, plan
}
export function authorize(
  access: AccessContext,
  request: AccessRequest,
): AccessDecision;
// AccessDecision: { scope: RecordScopeFilter; fields: FieldRules } or throws ApiError(403, "forbidden")
export function redact<T extends RecordDto>(access: AccessContext, row: T): T;
```

`AccessContext` is the `Principal` plus what `tenant_context.install` returns for this transaction (section 3.6): the effective scopes, the role version and its compiled permissions, the record scope and the home org units.

**Call sites it replaces or wraps.**

| Today                                                                                                                                      | Release 2                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permission(p, resource, write)` in `src/lib/records.ts`                                                                                   | `authorize(access, { resource, action })`; the scope check it did is the first step inside `authorize`                                                   |
| `owned(p, kind)` in `src/lib/records.ts`                                                                                                   | `scopeFilter(access, kind)` (proposed, in `src/lib/authz.ts`): today's three predicates unchanged, plus the record-scope predicate of section 3.5        |
| `importPermission(p)` in `src/lib/records.ts`                                                                                              | `authorize(access, { action: "import" })`; only the owner and admin templates hold it, with `imports:write`                                              |
| `checkReferences`, `recordKindOf`, `decorate` in `src/lib/records.ts`                                                                      | Parent lookups use `scopeFilter`, so a parent outside scope is answered as missing; labels pass through `redact`                                         |
| `roleScopes()` in `src/lib/permissions.ts`                                                                                                 | Kept as the membership ceiling for `member.role`; no longer the whole answer                                                                             |
| `requireScope` in `overview`, `analytics`, `listActivity`, `searchWorkspace`, `notifications`, `markNotifications` (`src/lib/insights.ts`) | `authorize` with the page and action, then `scopeFilter` inside each SQL source and `redact` on every returned row                                       |
| `exportRecords` in `src/lib/records.ts`, `exportTable` in `src/domain/export.ts`                                                           | `authorize(…, "export")`, `scopeFilter` in the export query, export columns limited to fields visible to the caller                                      |
| MCP `allowed(p, definition)` and the `requireScope` loop in `src/lib/mcp/tools.ts`                                                         | Each tool declares an `AccessRequest`; the dispatcher calls `authorize` (plus the connection limits of section 8) before `tenant_context.audit_mcp_call` |
| CV reads and uploads (`src/lib/cvs.ts`, `src/lib/mcp/cv-files.ts`)                                                                         | `authorize` on the candidate with the CV scopes; a candidate outside scope is answered as missing                                                        |

**How rules combine.** The effective permission for one request is the intersection of five layers, each of which can only remove access:

1. **Membership ceiling:** `roleScopes(member.role)`, as today.
2. **Configured role:** the role's scopes, pages, actions per resource, field rules and record scope (section 3.3).
3. **Token scopes:** for an API token or OAuth grant, its stored scopes, intersected with the role at use, as today in `src/lib/api-tokens.ts`.
4. **Connection limits and workspace switches** for AI connections (section 8).
5. **Fixed code rules** that no role can grant: private per-user state (below), Hired and Rejected only by a person (section 4.9), sensitive fields never in MCP results or conditions.

Each action needs a scope as well as a role grant: viewing candidates needs `candidates:read`, editing a vacancy `recruitment:write`, directory reads `directory:read` (new), plan reads `plans:read` (new). So a token can never do more than its scopes, and a role can never do more than its membership ceiling.

**Page, action, field and record-scope rules.**

- **Page:** a page key per screen. A page off hides the tab and its route returns 403; it does not by itself grant any action.
- **Action:** per resource, the R2-06 actions: view, create, edit, transition, archive, export, erase, approve, plus import, comment and share-view. `transition` can be narrowed per workflow transition by the transition's own condition (section 4.3).
- **Field:** per kind and field id: `hidden`, `read` or `edit` (default `edit` for roles that may edit the resource, `read` otherwise), optionally per type. System fields in `SENSITIVE_CANDIDATE_FIELDS` default to `hidden` for the new hiring manager and interviewer templates.
- **Record scope:** per kind group (pipeline, candidates, tasks): `all`, `unit` (my org unit and below, plus assigned) or `assigned` (assigned to me or I am a stakeholder).

**Private per-user state is never grantable.** `app.candidate_states` (shortlist, personal follow-up status, private note), private saved views (`saved-view` records with `private_owner_id`) and `app.notification_reads` have no key in the role schema, so no role, template, token or connection limit can name them. The zod schema for role bodies in `src/domain/config.ts` (proposed) is strict and refuses any unknown key. Their access stays keyed to the caller's own user id in the service layer and in the existing `allows(team_id, user_id, …)` policies, which this design does not change. `tests/authz.test.ts` (new) asserts that no role body, including an owner template, can make another member's candidate state, private view or read marker visible.

### 3.3 Roles, assignment and escalation guards

- A configured role body (proposed) holds `name`, `membership` (`admin`, `recruiter` or `viewer`; `owner` is reserved for the Owner template), `scopes`, `pages`, `actions`, `fields`, `recordScope`, `adminAreas` and `planAccess`.
- A member's role is the row in `app.member_roles`; a member without a row holds the template that matches `member.role`. Choosing a role in Team settings (`src/components/settings/team-settings.tsx`) sets `member.role` to the role's `membership` through Better Auth and writes the `app.member_roles` row. If the two disagree (for example one write failed), the database uses the narrower: effective scopes are `roleScopes(member.role)` intersected with the role's scopes.
- **Hiring manager template:** membership `recruiter`; pages home, vacancies, applications, interviews, approvals; record scope `unit`; offer `amount` hidden unless the member approves the offer (section 4.5); candidate contact fields read-only; no export, erase or import.
- **Interviewer template:** membership `viewer` plus write for feedback only once R1.1 scorecards exist; record scope `assigned`; sees the interviews assigned to them and the candidate's name, job title and CV only through those.
- **Escalation guards:** only members with `member.role = 'owner'` edit roles or assign them (admin area `roles`); the Owner template cannot be edited or narrowed; a role's grants are always inside its membership ceiling; an admin cannot grant an admin area they do not hold; a workflow post-action cannot change roles or assignments of type `approver`; every role publish and assignment is audited (section 1.3) and listed on the owners' home screen for seven days.

### 3.4 Field redaction in every output

`redact(access, row)` removes hidden fields from `data` and from `data.customValues`, and marks read-only fields so editors render them disabled. It is applied at these points:

| Output                | Rule                                                                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI data               | The UI reads REST, so it gets redacted rows. A new route (proposed) `GET /api/v1/me/access` returns the caller's pages, actions and field rules so screens hide what the server would refuse                                                                   |
| REST                  | Every list, get, create, update and bulk response is redacted. A write that names a hidden or read-only field is refused with 403 `field_forbidden`; a write that omits it preserves the stored value                                                          |
| OpenAPI               | `src/app/api/openapi.json/route.ts` stays one static contract for every caller: system fields become optional in responses with a note that fields the caller may not see are left out, and `customValues` is a map. Configured labels never appear in it      |
| Exports               | Columns are only the fields visible to the caller, in screen order; custom fields add columns headed by their label; every cell still goes through `safeCsvCell` in `src/domain/export.ts`                                                                     |
| Search matching       | The `recordQuery` search expression removes hidden system keys (as `omitFromSearch` does today) and hidden custom values (`#- '{customValues,<id>}'`), so a search term cannot test a hidden value. Filtering or sorting by a hidden field is refused with 400 |
| Notifications         | Due items come only from records in scope, and their titles only from visible fields                                                                                                                                                                           |
| Activity summaries    | Rows about records outside scope are left out by the service query; metadata keys that carry field values (for example `fromStage` and `toStage`) are dropped when that field is hidden from the caller                                                        |
| MCP results           | Tools return `redact`ed rows inside the `success()` wrapper of `src/lib/mcp/results.ts`; `SENSITIVE_CANDIDATE_FIELDS` and the source fields stay excluded for every role, as today                                                                             |
| Template merge fields | Resolved from `redact`ed rows of the requesting user (section 7.4)                                                                                                                                                                                             |
| Labels and counts     | `decorate` labels (`candidateLabel`, `vacancyLabel`) only from visible fields of records in scope; analytics and overview counts only over records in scope                                                                                                    |

### 3.5 Record scope in the service and in the database

**Service layer.** `scopeFilter` adds one SQL predicate to the same statement (no extra query). For `all` it adds nothing. For `unit` and `assigned` it adds the predicate of the table below, built from the context's home units and the caller's user id.

**Database layer: yes, as a restrictive policy.** A scoped principal (hiring managers and interviewers are new, less-trusted users) must not read out-of-scope records even through arbitrary SQL on the data role, which is the threat the signed context already covers for teams (SRS §10.1, SRS-SEC-03). The design adds (all proposed):

- **Columns on `app.records`:** `org_unit_id uuid` (the vacancy's unit; copied to applications, interviews, offers, onboarding, checklist items and comments on them), `scope_vacancy_id uuid` and `scope_application_id uuid`, maintained by a new owner-owned trigger function `app.maintain_record_scope()` before insert and update, which reads the parent in the same team. A change of a vacancy's unit updates its pipeline rows in the same transaction.
- **Context columns:** `tenant_context.contexts` gains `workspace_id`, `member_role`, `role_version_id`, `record_scope jsonb` (per kind group), `home_units uuid[]`, `plan_access boolean`, `admin_areas text[]` and `connection_limits jsonb`, all derived inside `install` from database rows, never from the payload.
- **Two helpers:** `tenant_context.scope_is_all()` (no arguments) and `tenant_context.in_scope(row_team text, row_kind text, row_id uuid, row_org_unit uuid, row_candidate uuid, row_scope_vacancy uuid, row_scope_application uuid, row_created_by text)`.
- **One restrictive policy** on `app.records` for all commands: `USING ((SELECT tenant_context.scope_is_all()) OR tenant_context.in_scope(…))` and the same `WITH CHECK`. The scalar subquery is an InitPlan, evaluated once per statement, so principals with scope `all` (every existing member on day one) pay no per-row cost. Like the erasure policies of `drizzle/0021_candidate_erasure.sql`, the helper returns true for the migration owner, so owner-run helpers keep working.

| Kind                                                 | In scope for a `unit` principal                                                                                                           | For an `assigned` principal                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| vacancy                                              | `org_unit_id` under a home unit, or an assignment on it                                                                                   | An assignment on it                                    |
| application, interview, offer, onboarding, checklist | `org_unit_id` under a home unit, or an assignment on the row, its `scope_application_id` or its `scope_vacancy_id`                        | An assignment on the row or its application or vacancy |
| candidate                                            | An application of the candidate is in scope (one index probe on a new partial index `(team_id, candidate_id) WHERE kind = 'application'`) | The same, through assigned applications                |
| comment                                              | Its parent is in scope (copied scope columns; a candidate parent uses the candidate rule)                                                 | The same                                               |
| task                                                 | Created by the caller, an assignee, or linked to a record in scope                                                                        | Created by or assigned to the caller                   |
| job-role, bucket, task-field, shared-view            | Always (no personal data)                                                                                                                 | Always                                                 |
| saved-view                                           | Unchanged: only its private owner, by the existing policy                                                                                 | Unchanged                                              |

**Signed context and the hard-coded scope list.** The signed payload keeps its fields and the audience `recruitmentos-tenant-context-v1`; only `install` changes:

- The `known` list grows by four scopes (new): `directory:read`, `directory:write`, `plans:read`, `plans:write`, appended after `imports:write` in both `SCOPES` (`src/lib/permissions.ts`) and `known`, in the same order, so the canonical-order check still holds.
- The per-role ceilings become explicit arrays instead of the slice `known[1:6]`, because appended scopes would otherwise change the recruiter ceiling. Recruiter and viewer get none of the four new scopes by default; owner and admin get all of them at the membership level, and the configured role decides.
- After every existing check passes, `install` reads the workspace mapping, the `app.member_roles` row and the role's current version, the caller's home units (section 6.5) and, for a token, `auth.api_tokens.limits`, and stores them in the context row. It **narrows** the stored scopes to `asserted ∩ role scopes ∩ connection limits`; it never widens them, and it still rejects any asserted scope outside the membership ceiling as today.
- `install` returns `jsonb` instead of `void` (section 3.6). The return type change means `DROP FUNCTION` and `CREATE FUNCTION` in the migration, the role template's grants re-issued for the new signature, and the helper lists in `src/db/connection-boundary.ts` updated.

Team isolation is untouched: every existing check in `install` (signature, environment, pid, xid, expiry, membership, verified email, token state) runs first and unchanged, every existing `allows` policy stays, and the new policy is restrictive, so it can only remove rows.

### 3.6 Cost: no extra round trip

The P1-18 baseline is recorded in `docs/validation.md` and enforced by `tests/round-trip-budget.test.ts`: 6 round trips for a simple read, 11 for a simple write, 15 for the overview. The design keeps them:

- **No new statement.** Today `install` is round trip 4 of a simple read. It now also returns the access state as `jsonb` in the same round trip: `{scopes, roleVersionId, recordScope, homeUnits, versions, documents}`, where `versions` maps each configuration object the request may need (kind schemas, workflows, the caller's role) to its current version id.
- **Configuration bodies by cache hint.** `install` gains a third, unsigned argument (proposed) `cached text[]`: the version ids this server instance already holds. `documents` carries only the bodies of current versions not in that list. The hint can only make the response smaller; it grants nothing, and the bodies come from the database under the verified context. Published versions are immutable, so an in-process cache keyed by version id is never stale, and a publish is seen by the next transaction because `versions` comes from the database each time.
- **In-memory checks.** `authorize`, `scopeFilter` and `redact` are pure functions over the compiled role: about 0.1 ms per call and under 2 ms to redact a 100-row page with the largest configuration (section 12).
- **Scope predicates inside existing statements.** The list, get, `find … FOR UPDATE`, export and insights statements carry the scope predicate themselves.

So a simple read stays at 6 round trips, a simple write at 11 and the overview at 15. `tests/round-trip-budget.test.ts` gains cases for a hiring-manager principal, a custom role and a cold configuration cache, all with the same counts. Database time rises by the extra rows `install` reads (index probes, estimated under 1 ms) and, for scoped principals only, the per-row `in_scope` probe.

## 4. Workflow engine

### 4.1 Starting point

An application's stage is a system field, `stage` in `recordDataSchemas.application`, set by any update (`updateRecord` in `src/lib/records.ts`), which audits `{fromStage, toStage}` metadata that analytics read back (`src/lib/insights.ts`). The MCP tool `move_application_stage` in `src/lib/mcp/tools.ts` is the only way MCP sets Rejected or Withdrawn; a new application cannot start there. Offers audit `{fromStatus, toStatus}`. There are no conditions, validators, approvals or versions.

### 4.2 Workflow body

A workflow version body (proposed, validated in a new file `src/domain/workflow.ts`):

```json
{
  "kind": "application",
  "statuses": [
    {
      "key": "screening",
      "name": "Screening",
      "category": "Screening",
      "stageType": "work",
      "screen": "edit"
    },
    {
      "key": "finance-approval",
      "name": "Finance approval",
      "category": "Offer",
      "stageType": "approval",
      "screen": "edit"
    }
  ],
  "initial": ["sourced"],
  "transitions": [
    {
      "key": "to-finance",
      "name": "Send to finance",
      "from": ["offer-draft"],
      "to": "finance-approval",
      "condition": {
        "all": [{ "field": "offer.amount", "op": "gt", "value": "50000" }]
      },
      "who": { "roles": ["role-uuid"], "assignees": ["recruiter"] },
      "validators": [{ "type": "required", "fields": ["field-uuid"] }],
      "screen": "transition-finance",
      "postActions": [{ "type": "require-approval", "group": "finance" }]
    }
  ],
  "approvalGroups": [
    {
      "key": "finance",
      "name": "Finance",
      "members": { "roles": ["role-uuid"], "users": [] },
      "rule": "majority",
      "slaHours": 48,
      "onApprove": "offer-approved",
      "onReject": "offer-draft"
    }
  ]
}
```

- **Statuses** have a stable `key`, a display name, a `stageType` (work, approval, interview, offer, onboarding, closed; R16-02) and a reporting `category`. For applications the category is one of the seven `APPLICATION_STAGES`; for the other kinds it is one of that kind's current status values. The category is what the system field stores (section 2.2), so analytics, reminders and exports stay comparable across workflows (R16-02).
- **Transitions** have a key, from-statuses (or `"*"` for a global transition), a target, an optional condition, a `who` rule (roles, assignment relations, or any member with `transition`), validators, an optional transition screen and post-actions.
- **Archive** stays the existing `archived` flag, not a status.

### 4.3 Conditions, validators and post-actions

- **Conditions** (R16-04) are a small JSON tree: `all`, `any`, `not`, and leaves `{field, op, value}` with `op` in `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `empty`, `notEmpty`, over fields of the record, its vacancy, its type and its org unit. No expressions, no code, no regular expressions from configuration. Conditions decide whether a transition is offered, whether a field shows or is mandatory on a screen, which approval groups are added, and whether a status is skipped.
- **Validators** run on the server before the transition commits: required fields, field value rules (as conditions), "an interview in status Completed exists", "an offer in category Accepted exists".
- **Post-actions** run in the same transaction as the transition when they only write rows: assign (adds an `app.record_assignments` row), create a task, require an approval group, notify (an in-app notification row). Actions with an outside effect (send a template email) write a row to a new table (proposed) `app.outbox` and are delivered after commit (section 7.6). A post-action failure rolls the transition back; delivery failures are retried and shown, never hidden.
- **Every decision is recorded** (R16-09): the transition's activity row carries `{fromStage, toStage, fromStatus, toStatus, transition, workflowVersionId, conditionsMatched, validatorsPassed, postActions}` with keys only, never field values.

### 4.4 Server-side validation of every transition

A new module (proposed) `src/lib/workflow-engine.ts` exposes `applyTransition(tx, access, record, transitionKey, input, initiatedBy)`. Every path that changes a status goes through it: the REST `PATCH` (a `stage` or `status` change is mapped to the matching transition from the current status; with the default workflows that is always the global transition), `POST /api/v1/applications/bulk`, a new route (proposed) `POST /api/v1/[resource]/[id]/transitions`, the MCP tools `move_application_stage`, `update_offer`, `update_vacancy`, `update_interview`, `update_onboarding` and `update_checklist_item`, approval decisions and the in-flight migration. The canvas and step-list editors only edit configuration; they never move records.

### 4.5 Approval groups

New tables (proposed): `app.approval_requests` (`id`, `team_id`, `record_id`, `workflow_version_id`, `group_key`, `rule`, `state` pending, approved, rejected, cancelled, `due_at`, `created_by`, `created_at`, `closed_at`) and `app.approval_decisions` (`request_id`, `team_id`, `approver_id`, `on_behalf_of`, `decision`, `comment`, `decided_at`, `sequence`).

- **Rules:** any-one (first approval closes it), all (every member approves), majority (more than half of the members at request time), sequential (members in order; each is notified when the previous one approves). One rejection closes any rule as rejected.
- **Delegates and out-of-office cover** (R16-05): a member sets a delegate and a date range (a new table, proposed, `app.approval_delegates`); a delegate's decision is recorded with `on_behalf_of`. Delegation never lets the requester approve their own request.
- **SLA reminders and escalation:** `due_at` from `slaHours`; overdue requests appear in the reminders of `notifications()` in `src/lib/insights.ts` with a stable key, and after a second period in the group's escalation contact's reminders.
- **Field visibility for approvers:** an approver of a pending request can read the fields the group's rule names (for example the offer amount, R12-03) for that record only, even if their role hides them elsewhere.

### 4.6 Publish-time checks

Publishing a workflow draft runs these checks (R16-07) and refuses with a list of problems:

- every status is reachable from an initial status;
- no cycle that cannot be left (a loop with no transition out to a closed status), and no automatic loop of post-actions;
- every approval group has at least one member and an outcome for approve and reject;
- every condition, validator and screen names a field that exists in the current published kind schema and is not archived;
- every category is valid for the kind, and the categories Hired and Rejected (and Withdrawn) are reached only by person-initiated transitions (section 4.9);
- no condition names a sensitive field (section 4.9);
- in-flight applications have a complete status mapping (section 4.7).

### 4.7 Publishing a new version and in-flight applications

**The conflict.** R16-01 says records in flight keep the version they started with. R2-04 says publishing migrates in-flight applications with an explicit status mapping.

**Recommendation: migrate, with an explicit mapping (R2-04), and keep closed records on their version.**

- When publishing, the editor lists every status of the current version that holds active applications (not archived, category not Hired, Rejected or Withdrawn) with its count. The publisher must map each one to a status of the new version; publishing is refused until every mapping is set.
- Applications in a closed category keep their pinned version for history (R16-01's intent for finished records).
- A new table (proposed) `app.workflow_migrations` (`id`, `workspace_id`, `object_id`, `from_version_id`, `to_version_id`, `mapping jsonb`, `state`, `created_by`, counts) holds the run. Each team's applications are migrated in batches of 500 per transaction under the team lock (`lockTeam`), each with a version bump and one activity row `workflow.migrated` carrying the from and to status keys. Until a row is migrated, reads show its mapped status and a write migrates it first, so no application is ever in a status that does not exist.
- Why not keep many live versions: boards, filters, analytics and approvals would have to understand every old version at once, and teams would see two pipelines for one vacancy type. The owner decides (section 13, D2).

### 4.8 Test mode, the canvas and the step list

- **Test mode with no writes** (R16-07): a new route (proposed) `POST /api/v1/admin/workflows/[id]/test` runs the draft against either sample values typed into the screen or a copy of an existing application the caller can read. It runs inside a transaction set `READ ONLY` and rolls back, so a bug cannot write. It returns the path taken, the conditions that matched, the validators that would fail, the approval groups that would be added and the post-actions that would run, none of them executed.
- **What the canvas editor stores: layout only.** `app.config_layouts.layout` for the draft or published version holds, and only holds:

  ```json
  {
    "viewport": { "x": 0, "y": 0, "zoom": 1 },
    "nodes": { "screening": { "x": 240, "y": 80, "lane": "recruiter" } },
    "edges": {
      "to-finance": {
        "points": [
          [360, 80],
          [360, 200]
        ]
      }
    },
    "lanes": ["requester", "hiring-manager", "recruiter", "approvers"]
  }
  ```

  Nodes and edges are keyed by status and transition keys. The layout is excluded from `body_sha256`, can change without a new semantic version, and a layout naming a key that no longer exists is ignored. The engine never reads it.

- **Accessible step-list editor** (R16-06, SRS-NFR-06): the default editor is a list of statuses in order, each with its transitions as a table (from, to, who, condition summary, validators, post-actions), edited through standard form controls and dialogs, fully keyboard-operable with announced changes. The canvas is a second view of the same draft; nothing can be done only by dragging (SRS-NFR-07).

### 4.9 Guardrails as enforced rules

1. **No rule moves an application to Hired or Rejected.** `applyTransition` takes `initiatedBy: "person" | "rule"`. Any transition whose target category is Hired or Rejected is refused when `initiatedBy` is `rule`, whatever the configuration says. Post-actions have no "transition" type at all, and publish-time checks refuse a workflow that would need one. Approval outcomes (`onApprove`, `onReject`) may not target the Hired or Rejected categories either: an approval routes work back to a person, who then makes the decision. `tests/workflow-engine.test.ts` (new) covers each path.
2. **Sensitive attributes are never conditions.** Conditions, validators, swimlanes and board quick filters cannot name a field in `SENSITIVE_CANDIDATE_FIELDS` or any field the owner marks `sensitive` in a kind schema. The publish check and the engine both refuse it, and the condition schema in `src/domain/workflow.ts` (proposed) has no way to reference candidate source fields (`rawSource`, `evidence`, `sourceReviews`).
3. **Rules route work; people decide.** Conditions may add or skip statuses, require fields and add approval groups, and nothing else (R16 guardrails).

## 5. Boards and views

**Starting point.** The Applications and Tasks screens in `src/components/workspace/records-screen.tsx` show fixed boards: applications by the seven stages, tasks by bucket. Saved views are private `saved-view` records with `area` `directory` or `applications`.

**Board body** (proposed, one `board` configuration object per board):

- `kind` (`application` or `task`), `workflowObjectId` (applications), `columns[]` each with `key`, `name`, `statusKeys[]` (one or more statuses; for tasks, bucket ids) and an optional `wipLimit`;
- `swimlane`: `none`, `vacancy`, `recruiter` (assignment relation), `type`, `department` (the vacancy's org unit at a chosen level) or a dropdown field;
- `quickFilters[]`: named saved queries in the existing list query language (`LIST_QUERY_KEYS` in `src/lib/records.ts`) plus `type`, `orgUnit` and custom dropdown fields;
- `cardFields[]` (field ids shown on cards), `defaultMode` (`board` or `list`) and `pageSizePerColumn` (default 25, at most 100).

A board follows its workflow's current version: a status added to the workflow and not yet on a column shows in an "Unmapped" column for admins.

**Board query.** One statement per board page: the scoped list query with `row_number() over (partition by column)` to take the first page of each column and `count(*) over (partition by column)` for column totals and WIP warnings. It reuses `recordQuery` and `scopeFilter`, so a board costs the same 6 round trips as a list. A WIP limit is a warning, never a block: the column header shows "7 of 5".

**Views.**

- **Private saved views** stay exactly as they are: `saved-view` records with `private_owner_id`, visible only to their owner by `owned()` and the `private_views` rule of the policies. No role can share them.
- **Shared views** are a new team-level kind (proposed) `shared-view` in `app.records` with `private_owner_id` null, created by members with the `share-view` action. The owner of a private view may copy it into a shared view; that is a new record, never a change to the private one.
- A shared view stores a query, a board id and a mode. Running it re-applies the viewer's own scope and field rules, so sharing a view never shares records the viewer may not see. A shared view cannot use private filters (`shortlisted` and the candidates' `status`, `PRIVATE_EXPORT_FILTER_KEYS` in `src/lib/records.ts`).

**List and board modes** switch on the same query; the existing `src/components/workspace/display-mode-toggle.tsx` is reused.

## 6. Organisation model and directory

### 6.1 Starting point

Nothing models the organisation. Vacancies and job roles hold a free-text `department`; `hiringManager` and `recruiter` on vacancies and `owner` on several kinds are free-text labels (R11-01 plans real user references).

### 6.2 Tables (all proposed, company level)

| Table                    | Columns                                                                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.org_levels`         | `id`, `workspace_id`, `name`, `depth` (0 = top), unique `(workspace_id, depth)`; for example Company > Division > Department > Section > Unit                                                                         |
| `app.org_units`          | `id`, `workspace_id`, `parent_id null`, `level_id`, `name`, `code`, `valid_from`, `valid_to null`, `created_by`, `archived_at`; a unit's level must be deeper than its parent's                                       |
| `app.org_unit_closure`   | `workspace_id`, `ancestor_id`, `descendant_id`, `depth`; primary key `(ancestor_id, descendant_id)`, index `(descendant_id)`; every unit is its own ancestor at depth 0                                               |
| `app.positions`          | `id`, `workspace_id`, `org_unit_id`, `title`, `code`, `job_role_team_id null`, `job_role_id null`, `is_manager boolean`, `valid_from`, `valid_to`, `archived_at`                                                      |
| `app.employees`          | `id`, `workspace_id`, `display_name`, `work_email`, `work_phone`, `employee_number`, `user_id null REFERENCES auth."user"`, `status` (active, left), `source` (app, excel), `created_at`, `updated_at`, `archived_at` |
| `app.employee_positions` | `employee_id`, `position_id`, `workspace_id`, `primary boolean`, `valid_from`, `valid_to`                                                                                                                             |
| `app.employee_erasures`  | `id`, `workspace_id`, `employee_id`, `erased_by`, `erased_at` (tombstone, section 11)                                                                                                                                 |

Employees hold only work contact facts. There is no date of birth, nationality, gender, photo or home address column, and the field builder does not apply to employees in Release 2.

The closure table is maintained by a new owner-owned trigger function (proposed) `app.maintain_org_closure()` on insert and on a `parent_id` change, which refuses a move under the unit's own subtree. With at most 2,000 units and 8 levels, the table has at most about 16,000 rows.

### 6.3 Org chart, directory and vacancies

- **Org chart:** a tree of units by level with their positions and the employees in them, loaded one level at a time (a unit's children on expand), so no screen loads the whole directory (SRS-NFR-02). Open vacancies show as open positions on their unit: a vacancy carries `org_unit_id` (the new typed column of section 3.5) and an optional `positionId` system field.
- **Directory:** a searchable, paged list of employees with filters for unit (including everything below it), level, position and status. Reads need the `directory` page, `directory:read` (new) and the role's directory rule (`basic`: name, position, unit; `full`: also work email and phone).
- **Linking to users:** an owner or admin links an employee to a member's user id. A user can be linked to at most one employee per workspace.

### 6.4 Excel import

- Upload a `.xlsx` workbook with three sheets: Units (code, name, level, parent code), Positions (code, title, unit code, manager yes or no) and Employees (employee number, name, work email, work phone, position codes, primary position). The server parses it with `read-excel-file`, already a dependency (used by `scripts/legacy/files.ts`), with at most 5 MiB and 20,000 rows.
- **Dry run first:** the import shows counts of units, positions and employees to create, update, leave unchanged and reject, with the row and the reason for each rejection, before anything is written (as SRS-OPS-03 asks for legacy imports).
- **Apply** is idempotent by code and employee number, in one transaction per sheet, and audited with counts only.
- Cell values are text facts. A value that starts with `=`, `+`, `-` or `@` is stored as text and every later export passes it through `safeCsvCell` (section 11). Real employee data never goes to Preview (section 11).

### 6.5 How record scope follows the hierarchy

- **Home units.** A member's home units are the units of the current positions held by the employee linked to their user (`app.employees.user_id` → `app.employee_positions` → `app.positions.org_unit_id`), read by `install` (section 3.5). A member with no linked employee has no home units, so a `unit` role gives them only their assigned records.
- **"My org unit and below"** is every unit `d` with a closure row `(a, d)` where `a` is a home unit. The service predicate is `exists (select 1 from app.org_unit_closure c where c.ancestor_id = any(:home_units) and c.descendant_id = records.org_unit_id)`, and `in_scope` uses the same probe.
- **Cost.** One primary-key probe per home unit per row checked, about 5-10 µs for a member with one to three home units, and only for scoped principals. `install` adds one indexed three-table join for the home units. Moving a unit changes the closure rows once; nothing is copied into records, so a reorganisation takes effect at the next transaction without rewriting any record.

## 7. Document and message templates

### 7.1 Starting point

Mail goes only through `sendAuthMail` in `src/lib/mail.ts` (Resend's HTTP API with `RESEND_API_KEY` and `EMAIL_FROM`, or the local console mode). Files go through the CV storage path: validation in `src/lib/storage-format.ts` (`validateCvMetadata`, `validateCvBytes`), Blob tickets in `src/lib/blob-put-ticket.ts`, upload inspection in `src/lib/blob-upload-validation.ts`, the ledger described in `docs/blob-quota-design.md`, and downloads only as attachments (DEC-07, `docs/blob-security-design.md`). `mammoth` and `unpdf` are already dependencies, for text extraction only.

### 7.2 Template body

A `template` configuration version body (proposed): `name`, `channel` (`email` or `document`), `source` (`builder`, `docx` or `pdf`), `subject` (email), `blocks` (builder), `fileId` (docx or pdf), `placements` (pdf), `mergeFields[]` (the allowlisted paths it uses), `requiredFields[]`, `output` (`pdf` or `docx` for documents), `attachTemplateIds[]` (an email may attach generated documents) and `approvalGroup` (optional).

**Merge field syntax.** `{{candidate.name}}`, `{{vacancy.title}}`, `{{offer.amount}}`, `{{interview.startAt}}`, `{{orgUnit.name}}`, `{{interviewer.name}}`, `{{sender.name}}`, and conditional blocks `{{#if offer.amount}}…{{/if}}` and `{{#unless …}}`. Paths come from an allowlist built from the kind schemas, checked at publish. Sensitive fields and source fields are never in the allowlist. There are no expressions, helpers, loops over arbitrary data, file includes or code.

### 7.3 The three ways to create a template

- **Upload a Word file** with `{{…}}` placeholders. It goes through the CV storage path (7.5); at publish the server lists the placeholders found and refuses unknown paths.
- **Upload a PDF and place fields.** The editor shows each page and lets the admin draw a box per merge field (page, x, y, width, height in PDF points, font size, alignment). `placements` stores those coordinates.
- **Builder.** A drag-and-drop list of blocks (heading, paragraph with merge fields, table of fields, signature line, conditional block, page break) with a keyboard alternative (move up, move down). The same blocks render to an email (plain text plus escaped HTML), a PDF or a DOCX.

**Preview with real data** renders the template for one record the caller can read, with the caller's permissions (7.4), as a downloadable attachment (never inline, as DEC-07 requires for CVs), marked "Preview".

### 7.4 Merge-field resolution under permissions

A new module (proposed) `src/lib/templates.ts` builds the merge context for one record and one requesting user: it loads the record and its related records (application, candidate, vacancy, offer, interviews, org unit) through the same service functions REST uses, so each goes through `scopeFilter` and `redact` for that user. A field hidden from the user resolves to nothing and the preview marks it "hidden from you". Generation and sending are refused when a field in `requiredFields` is empty or hidden for the user, so an offer letter is never sent with a silently blank amount. Templates run with the requesting user's access, never with a system identity. Values are formatted with the app's single date, number and money format (Asia/Dubai dates, AED amounts).

### 7.5 Uploaded templates reuse the CV storage and validation path

- Template files are stored in Blob through the same ticket, size, digest and ledger checks as CVs, charged to the uploading team's storage usage, in a new table (proposed) `app.template_files` that mirrors the reference fields of `app.uploads` (provider, store, environment, object key, digest, size, status) with `workspace_id` and `team_id`, and no candidate.
- Accepted types are `.docx` and `.pdf` only, at most 10 MiB (`MAX_CV_BYTES` in `src/lib/storage-format.ts`), checked by the existing magic-byte validators plus template rules: a DOCX may not contain macros (`vbaProject.bin`, `.docm`), external relationships (`TargetMode="External"`), embedded objects or more than 2,000 zip entries or 50 MiB uncompressed; a PDF may not contain JavaScript, launch, open or submit actions or embedded files.
- Downloads of template files and generated documents are attachments only (`application/octet-stream`, `Content-Disposition: attachment`, `nosniff`), as for CVs.
- **Generated documents** go to a new team-level table (proposed) `app.generated_documents` (`id`, `team_id`, `record_id`, `candidate_id`, `template_version_id`, `format`, Blob reference fields, `created_by`, `created_at`, `sent_at`) through the same storage path, so they are covered by candidate erasure (section 11).

### 7.6 Sending through Resend, and approvals

- Owner decision 4: emails go through the app's own sender (Resend, `recruitmentos.ae`). A new function (proposed) `sendRecordMail` in `src/lib/mail.ts` reuses `RESEND_API_KEY`, `EMAIL_FROM` and the local console mode, adds an optional reply-to (the sending member's address), HTML and attachments, and sends Resend's `Idempotency-Key` header with the outbox row id so a retry never sends twice.
- Sending is a post-commit delivery from `app.outbox`: the send action writes the outbound message and its outbox row in the record's transaction, and delivery runs after commit with `waitUntil`, as `dispatchAuthMail` does. A new team-level log (proposed) `app.outbound_messages` holds `record_id`, `candidate_id`, `template_version_id`, recipient address, subject, rendered text body, attachment document ids, `state` (queued, sent, failed), the provider message id and times (R12-07: logged outbound email). It is shown on the candidate's timeline to members who can read the candidate.
- Recipients are only the candidate's email or the email of a member or employee on the record; there is no free-text recipient. Subjects lose CR and LF. Each team may send at most 200 template emails per hour (an open number, section 13).
- **Approvals:** a template with `approvalGroup` creates an `app.approval_requests` row instead of sending; the message is sent when the request is approved, and cancelled when it is rejected (R2-08 "optional approval before an offer letter goes out").

### 7.7 Libraries (each to be escalated before install)

No library is installed by this job. Each one below is to be escalated before install, pinned to an exact version like the existing dependencies in `package.json`, checked with `npm audit --audit-level=moderate`, and imported only from server code (route handlers and `src/lib`), except the one editor library marked as browser-side.

| Purpose                                      | Proposed library                                             | Justification                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DOCX placeholders                            | `docxtemplater` with `pizzip`                                | Widely used and actively released for over ten years; core licence MIT (`pizzip` MIT or GPL-3, used under MIT); pure JavaScript on in-memory buffers, server-side only; no network or file access; the default parser does plain path lookups (no expression parser is installed) and escapes XML, so values cannot inject Word markup or field codes. To be escalated before install                                                                        |
| PDF field placement and builder PDF output   | `@pdfme/generator` with `@pdfme/common` and `@pdfme/schemas` | Built for placing fields on an existing PDF by coordinates; MIT; actively maintained TypeScript; runs in Node on in-memory buffers, server-side only; no file access. It must be given fonts from the repository so it never fetches a default font over the network: the escalation must confirm this. Chosen over `pdf-lib` (MIT, well known, but no release for several years) and `pdfkit` (cannot fill an existing PDF). To be escalated before install |
| DOCX output from the builder                 | `docx`                                                       | Well known, MIT, actively maintained, declarative; builds documents in memory, server-side only, with no network or file access. To be escalated before install                                                                                                                                                                                                                                                                                              |
| Page images in the PDF placement editor only | `pdfjs-dist`                                                 | Mozilla's PDF renderer, Apache-2.0, maintained. Browser-side, used only in the admin placement editor with scripting, forms and eval disabled; the same approach R11-10 plans for the CV viewer. To be escalated before install                                                                                                                                                                                                                              |

**Known limit.** A Word template can produce DOCX only. Converting DOCX to PDF needs an office engine (for example LibreOffice), which cannot run in the Vercel functions; PDF output comes from the builder and from PDF templates (section 13, D6).

## 8. AI connections tab

### 8.1 Starting point

API tokens and OAuth grants are rows in `auth.api_tokens` (`src/lib/api-tokens.ts`, `src/lib/oauth.ts`), listed and revoked in Settings > API tokens (`src/components/settings/token-settings.tsx`). Every MCP call writes an `mcp-tool` activity row through `tenant_context.audit_mcp_call`, and CV text reads write `mcp.cv_text_read` through `tenant_context.audit_mcp_cv_read`, which refuses when the team setting `mcpCvTextEnabled` (`app.storage_usage`, `drizzle/0026_mcp_cv_tools.sql`) is off (`docs/mcp.md`).

### 8.2 The tab

The Admin portal's AI connections tab lists every API token and OAuth grant of the team: who connected it, the client name and id, scopes, created, last used, expiry, calls per day for the last 30 days (counted from `mcp-tool` activity rows per token, in one aggregate query), the tool-call audit for that connection (the activity rows filtered by token) and Revoke (the existing `revokeToken`). Owners and admins see every connection; other members see their own, as today. Never shown: token values, hashes or tool arguments.

### 8.3 Per-connection limits on top of role and token scopes

A new column (proposed) `auth.api_tokens.limits jsonb NOT NULL DEFAULT '{}'` holds `{readOnly: boolean, noCvText: boolean}`. R2-09's "read-only" and "no writes" are one limit, `readOnly`, here (section 13, D9). Limits are set by the connection's holder or by an owner or admin, and audited as `api-token` activity rows `token.limits_changed`.

The effective access of one MCP call is the intersection, in this order:

1. the holder's membership ceiling and configured role (section 3);
2. the token's scopes;
3. the connection limits: `readOnly` removes every `:write` scope, `noCvText` removes CV text access;
4. the workspace switches on `app.workspaces` (new): `ai_connections_enabled` off refuses every OAuth access token and MCP call; `ai_writes_enabled` off removes every `:write` scope from AI connections;
5. the team's existing `mcpCvTextEnabled`, which stays as it is ("Allow CV contents" is that setting, shown in this tab).

Enforcement is in the database as well as the dispatcher. `install` reads the limits and the switches and stores the narrowed scopes, so the coarse write gate of `allows` refuses writes for a read-only connection even if the dispatcher had a bug. `tenant_context.audit_mcp_cv_read` additionally refuses when the token has `noCvText`, in the same place it checks `mcpCvTextEnabled`.

## 9. Recruitment plan

### 9.1 Model (all proposed, company level)

| Table               | Columns                                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.plans`         | `id`, `workspace_id`, `name`, `start_year`, `end_year` (any span; 5, 10 or more years, at most 30), `granularity` (`year` or `quarter`), `created_by`, `created_at`, `archived_at`                                                        |
| `app.plan_versions` | `id`, `plan_id`, `workspace_id`, `number`, `label` (for example "Base scenario"), `state` (`draft`, `submitted`, `approved`, `superseded`), `approval_request_id null`, `created_by`, `created_at`, `approved_at`                         |
| `app.plan_lines`    | `id`, `plan_version_id`, `workspace_id`, `org_unit_id`, `year`, `quarter null` (1-4), `position_id null`, `job_role_team_id null`, `job_role_id null`, `headcount int`, `cost_fils bigint`, `note text`; at most 50,000 lines per version |

- **All amounts are in AED.** There is no currency column: `cost_fils` is the yearly or quarterly cost in fils (1 AED = 100 fils) as an integer, so there is no floating-point money (SRS-DATA-03). The UI shows AED with the app's money format.
- **By org unit at any level:** a line names a unit of any level; totals roll up through `app.org_unit_closure`.
- **Scenario versions:** several drafts per plan; submitting a draft creates an approval request for the configured approvers (section 4.5); an approved version is immutable and becomes the plan of record; the previous approved version becomes `superseded`. Every state change is audited without figures.

### 9.2 Confidential by default (owner decision 5)

Plan figures are hidden from everyone without explicit access. Reading any plan table needs all three of `plans:read` (new scope), the `plan` page and `planAccess` in the configured role, and the plan tables' row policies check them through a new helper (proposed) `tenant_context.allows_plan(row_workspace uuid, access text)` that reads `plan_access` and the scopes from the context row. Writing needs `plans:write`. No built-in template other than Owner grants plan access (section 13, D10). Plan figures never appear in search, notifications, activity metadata, overview or analytics, and are not offered over MCP in Release 2. An export of a plan version is a separate audited action.

### 9.3 Plan versus actual

For a unit (and everything below it), a year or quarter and the approved version:

- **Plan:** headcount and cost from `app.plan_lines`.
- **Actual:** open vacancies (category Open, `openings` summed) and their target dates; offers in categories Sent and Accepted; hires (applications whose `Hired` stage event falls in the period, from activity metadata, so imported history without an observed event is not counted, SRS-OPS-05); spend as accepted offers in AED annualised by `payPeriod` (Monthly × 12, Annual × 1, One-time × 1). Hourly offers and offers in other currencies are left out and counted ("2 offers not included: other currency").
- **Variance:** plan minus actual for headcount and cost, shown as facts with their counts. No score, ranking or forecast.
- Actuals are computed over the team records of every team in the workspace, but only for members with plan access, and only as aggregates: a plan screen never lists a candidate.

## 10. General team tasks migration

**Starting point.** Tasks are `task` records with `bucketId` (required), optional `candidateId` and `vacancyId`, `owner` as free text, `priority`, `dueDate` and `customValues`. Buckets carry `completed`; `bootstrapTeam` in `src/lib/records.ts` creates To do, In progress, Waiting and Done. `RESOURCE_CONFIG` labels tasks "Recruitment tasks".

**Existing tasks, buckets and custom fields migrate as they are.** No task, bucket or `task-field` record is rewritten, renumbered or moved; their ids, versions, `customValues` keys and the `completed` flag keep their meaning, and the REST resources `tasks`, `buckets` and `task-fields` and the MCP task tools keep their names, inputs and outputs.

**What changes (R2-12):**

- Labels: "Recruitment tasks" becomes "Team tasks" in `RESOURCE_CONFIG` (`src/domain/records.ts`) and `docs/user-guide.md`. Nothing else is renamed.
- **Assignees:** a new optional system field `assigneeIds` (user ids, members of the team, at most 10), and each assignee as an `app.record_assignments` row with relation `assignee`, so scoped members see tasks assigned to them. `owner` stays a free-text label.
- **Links to any record:** tasks may set the existing `parentRecordId` reference to any record kind except `saved-view`, `shared-view` and `comment`; `candidateId` and `vacancyId` stay as they are.
- **Task boards per team or project:** a `task-board` configuration object names a subset of the team's buckets as columns and an optional filter (for example linked to one vacancy, or a dropdown custom field "Project"). Every team keeps its default board of all buckets. Boards are applied per team, because buckets are team records.
- **Custom fields:** company-level task fields come from the task kind schema (section 1); team-level `task-field` records stay and are validated by the same field-type engine, so both kinds of field show on the task form.

## 11. Security and privacy review

### 11.1 Employee and directory personal data under erasure and retention

- **Minimal data:** work contact facts only (section 6.2), no sensitive traits.
- **Erasure:** a new owner-only helper (proposed) `tenant_context.erase_employee(target uuid, confirm_name text, erasure_source text)`, in the pattern of `tenant_context.erase_candidate`: it deletes the employee and their position history, unlinks the user, writes a tombstone in `app.employee_erasures` and redacts every activity row about the employee to type, time and actor. Plan lines name positions and units, never employees, so plans are unaffected. `docs/erasure-runbook.md` gains an "Erase an employee" section with the same request log, restore and verification steps.
- **Candidate erasure extended:** `tenant_context.erase_candidate` also removes the candidate's `app.generated_documents` (files deleted through the Blob cleanup like CVs), `app.outbound_messages`, approval requests and decisions on their applications, `app.record_assignments` and workflow migration rows naming them. `customValues` go with the records.
- **Retention (R1.5 interface):** each kind schema and the employee table get a `retentionClass` (proposed) that R1.5 enforces later; Release 2 only stores and shows it. An employee with status `left` is listed for review after a period the owner sets (section 13, D11).

### 11.2 Confidential plan figures

Database policies (section 9.2), not only hidden screens; no MCP, search, notification or activity exposure; aggregates only in plan versus actual; exports audited.

### 11.3 Template injection

- Merge values are inserted as text: XML-escaped in DOCX by `docxtemplater`, drawn as text in PDFs, HTML-escaped in emails. A value can never become markup, a Word field code, a hyperlink or a script.
- Template syntax has no expressions, includes or helpers; merge paths are allowlisted at publish.
- Uploaded templates are checked for macros, external relationships, embedded objects, PDF actions and zip bombs (section 7.5), so a generated document cannot call home or run code.
- Email subjects lose CR and LF; recipients come only from records.

### 11.4 Formula injection in exports and Excel import

Every CSV cell, including custom fields, directory exports and plan exports, goes through `safeCsvCell` in `src/domain/export.ts`, which prefixes cells starting with `=`, `+`, `-`, `@`, tab or CR. Excel import reads values, not formulas, stores formula-like cells as text and flags them in the dry run. Any future XLSX export writes every value as a string cell.

### 11.5 Prompt injection through configurable labels

Field labels, help text, option values, status and transition names, board, role and template names are company-written text that can reach AI assistants. Controls:

- the bounds and character clean-up of section 1.2;
- configured text reaches MCP only inside the `success()` result of `src/lib/mcp/results.ts`, which carries `untrustedData: true` and the `NOTICE`; it is never placed in tool names, tool descriptions, input schemas or the server instructions, which stay static code;
- a new tool (proposed) `describe_fields` returns field metadata for a kind as data in that wrapper;
- MCP inputs take status keys and field ids, validated server-side, not free text interpreted as instructions.

### 11.6 Configuration as a privilege-escalation path

Only owners edit roles and assignments; a role cannot exceed its membership ceiling; admin areas are granted separately and an admin cannot grant one they lack; workflows cannot change roles; approvals cannot be self-approved; every publish and assignment is audited and shown to owners; the database narrows scopes in `install` from the stored role, so a forged or stale client view of the role grants nothing (section 3.3).

### 11.7 Additions to the SRS §10.1 threat model

| ID      | New threat                                                                                                                         | Controls                                                                                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-R2-1  | A member widens their own or others' access through configuration                                                                  | Owner-only roles area; membership ceiling; narrowing in `install`; audited publishes and assignments; `tests/authz.test.ts` (new) escalation matrix                        |
| T-R2-2  | A scoped member reads records outside their org unit or assignments (IDOR, references, direct SQL)                                 | `scopeFilter` in every query; restrictive `in_scope` policy on `app.records`; parents outside scope answered as missing; `scripts/live-role-tests.ts` scoped-context cases |
| T-R2-3  | A hidden field leaks through a secondary output (search, sort, filter, export, labels, counts, activity, notifications, templates) | `redact` at every output of section 3.4; hidden-field filters and sorts refused; `tests/field-redaction.test.ts` (new) covers each output                                  |
| T-R2-4  | Template injection or a malicious uploaded template                                                                                | Section 11.3 and 7.5                                                                                                                                                       |
| T-R2-5  | Formula injection through custom fields, the directory or Excel import                                                             | Section 11.4                                                                                                                                                               |
| T-R2-6  | Prompt injection through configured labels and option values                                                                       | Section 11.5                                                                                                                                                               |
| T-R2-7  | Employee personal data kept too long or left behind after erasure                                                                  | Section 11.1; erasure helper, tombstone and runbook; retention class                                                                                                       |
| T-R2-8  | Plan figures read without access                                                                                                   | Section 9.2 row policies and exclusions                                                                                                                                    |
| T-R2-9  | Email abuse: phishing or spam through template sending, header injection, wrong recipients                                         | Recipients only from records; CR and LF stripped; per-team send limit; logged outbound messages; approval for offer letters; Resend idempotency                            |
| T-R2-10 | Automation makes a hiring decision or uses a sensitive attribute                                                                   | Section 4.9 guardrails in the engine and at publish                                                                                                                        |
| T-R2-11 | Stale permissions from caches                                                                                                      | Only immutable versions are cached; current version ids and the role come from `install` in every transaction                                                              |
| T-R2-12 | Company configuration carries one team's data to another team                                                                      | No record ids or values in configuration bodies (section 1.2); team tables keep team policies                                                                              |
| T-R2-13 | Denial of service through oversized configuration or imports                                                                       | Body, label, field-count and import bounds (sections 1.2, 6.4, 12)                                                                                                         |
| T-R2-14 | An AI connection does more than its holder intended                                                                                | Connection limits and workspace switches enforced in `install` and the CV read helper (section 8)                                                                          |

`docs/requirements/recruitmentos-srs.md` itself is not changed by this design job; the build item R2d-15 proposes the §10.1 text for owner review.

## 12. Performance and scale targets

**Round trips per action** (counted as `tests/round-trip-budget.test.ts` does, session lookup mocked):

| Action                                                                            | Today | Release 2 target |
| --------------------------------------------------------------------------------- | ----: | ---------------: |
| Simple read (`GET /api/v1/tasks`, `GET /api/v1/candidates/:id`)                   |     6 |                6 |
| Simple write (task bucket move, application stage change on the default workflow) |    11 |               11 |
| Overview                                                                          |    15 |               15 |
| Board page (all columns)                                                          |   n/a |                6 |
| Transition with conditions and validators, no approval                            |   n/a |               11 |
| Transition that opens an approval request                                         |   n/a |               13 |
| Approval decision                                                                 |   n/a |               11 |
| Admin: save a draft                                                               |   n/a |                9 |
| Admin: publish a workflow (before in-flight batches)                              |   n/a |               14 |
| Directory page, org chart level                                                   |   n/a |                6 |
| Plan versus actual for one unit and year                                          |   n/a |                7 |

The same round trip counts hold for a scoped principal, a custom role and a cold configuration cache (section 3.6). New actions with no measured baseline get their target as a ceiling in `tests/round-trip-budget.test.ts` when they are built; an item that cannot meet one stops and reports it rather than raising the number.

**Server time** (hosted, `fra1`, warm): p95 at most 1 s for reads and 1.5 s for writes (SRS-NFR-01). In process: `authorize` at most 0.1 ms, `redact` at most 2 ms per 100-row page, compiling the largest kind schema at most 20 ms once per version per instance, template rendering at most 2 s for a 10-page PDF. Database: `install` at most 1 ms more than today; the `in_scope` probe at most 10 µs per row for scoped principals and none for scope `all`.

**Largest expected configuration** (the bounds the schemas enforce and the tests use):

| Item                                 | Largest |
| ------------------------------------ | ------: |
| Fields per kind (system plus custom) |     150 |
| Screens per kind                     |      40 |
| Types per kind                       |      30 |
| Statuses per workflow                |      40 |
| Transitions per workflow             |     200 |
| Workflows                            |      30 |
| Approval groups per workflow         |      20 |
| Boards                               |      50 |
| Roles                                |      30 |
| Org levels                           |       8 |
| Org units                            |   2,000 |
| Positions                            |   5,000 |
| Employees                            |   5,000 |
| Templates                            |     200 |
| Plan years per plan                  |      30 |
| Plan lines per version               |  50,000 |

**Record and fixture sizes the tests use.**

- Unit tests of `authorize`, `redact`, the field-type engine and the workflow engine run with the largest configuration above.
- PGlite integration tests use a fixture of 2,000 candidates (as the P1-25 benchmark fixture in `scripts/benchmark-round-trips.ts`), 6,000 applications, 500 vacancies, 10,000 activity rows, 500 org units in 6 levels, 2,000 employees and one 20,000-line plan version, all fictional.
- `npm run bench:round-trips -- --fixture` gains scoped and custom-role runs. The SRS-NFR-01 load test (10,000 candidates, 30,000 applications, 100,000 task and history records) stays an owner-run measurement on Preview with fictional data.

## 13. Risks, unknowns and open decisions

### 13.1 Open decisions for the owner

| ID  | Decision                                                                                      | Recommendation                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Tenancy: how company-wide configuration (decision 3) sits on team-scoped tenancy              | One workspace per environment above teams (`app.workspaces`, `app.workspace_teams`), derived inside `install`, company tables under `allows_workspace`, team tables unchanged (tenancy decision)            |
| D2  | In-flight applications when a workflow is published: R16-01 (keep version) or R2-04 (migrate) | Migrate active applications with a mandatory explicit status mapping, in batches with read-through mapping; closed applications keep their version (section 4.7)                                            |
| D3  | Version numbers for the four Preview drops                                                    | R2a ships `1.1.0`, R2b `1.2.0`, R2c `1.3.0`, R2d `2.0.0`: the minor number per Preview feature drop, and `2.0.0` when Release 2 is complete, the version Production launches with                           |
| D4  | Offer amount protection: service-layer redaction only, or a separate protected table          | Service-layer redaction in Release 2 (section 3.4), with the residual risk that SQL on the data role under a valid context can read the JSON value; revisit before real offers are stored                   |
| D5  | Which libraries to approve (section 7.7)                                                      | Approve `docxtemplater` with `pizzip`, `@pdfme/generator` with `@pdfme/common` and `@pdfme/schemas`, `docx` and `pdfjs-dist`, each after the escalation confirms licence, maintenance and no network access |
| D6  | PDF output from Word templates                                                                | Not in Release 2: Word templates produce DOCX; PDF comes from the builder and PDF templates                                                                                                                 |
| D7  | Hiring managers' membership level                                                             | `recruiter` membership narrowed by the Hiring manager role, so they can approve and comment; `viewer` would block approvals                                                                                 |
| D8  | User references versus R1.1 (R11-01)                                                          | Release 2 adds assignments with user ids beside today's free-text labels; R11-01 later turns the labels into references using the same assignment table                                                     |
| D9  | R2-09 "read-only" and "no writes"                                                             | Treat them as one limit (`readOnly`), plus `noCvText`                                                                                                                                                       |
| D10 | Who sees plan figures by default                                                              | Only the Owner template; admins and every other role only when an owner grants plan access                                                                                                                  |
| D11 | Employee retention after leaving                                                              | Owner sets the period with R1.5; until then employees who left are listed for review after 12 months and erased only by the owner                                                                           |
| D12 | Template email send limit                                                                     | 200 per team per hour, owner-adjustable later                                                                                                                                                               |
| D13 | Directory and plan data over MCP                                                              | Not in Release 2: MCP gets org unit names and field metadata only; employees and plan figures stay off MCP until a separate decision                                                                        |
| D14 | Which further fields count as sensitive                                                       | Keep `SENSITIVE_CANDIDATE_FIELDS` and let the owner mark more fields sensitive in the field builder; decide on `residenceEmirate` (open since WP-16b) when reviewing the default candidate schema           |
| D15 | A second company in one environment                                                           | Not in Release 2; the mapping trigger refuses a second workspace until a later decision                                                                                                                     |

### 13.2 Risks and unknowns

| Risk or unknown                                                                                                    | Recommendation                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope: about 66 build items is a large release; later milestones may slip                                          | Keep the milestone order; each milestone is usable on its own; cut R2d items before weakening any check                                                           |
| Changing `tenant_context.install` (return type, derived state, scope list) touches the most security-critical code | Its own build items (R2a-02, R2a-03) with live-role tests on a throwaway PostgreSQL and the pooler, and an independent security review before R2a reaches Preview |
| The per-row cost of `tenant_context.allows` (about 23 µs a row, P1-25) already dominates big aggregates            | Keep `in_scope` behind the InitPlan fast path; measure with the fixture; any change to `allows` is a separate, reviewed item                                      |
| A lot of existing code reads `data->>'stage'` and `data->>'status'` literally                                      | The category-in-system-field rule (section 2.2) keeps them valid; `tests/insights-postgres.test.ts` runs against a custom workflow too                            |
| Mandatory-field and validator changes could block daily work after a publish                                       | The edit rule of section 1.5 and test mode before publish                                                                                                         |
| In-flight migration of many applications                                                                           | Batches of 500, read-through mapping, resumable runs, counts shown                                                                                                |
| PDF fonts: Arabic and right-to-left text in templates                                                              | Bundle one open-licence font with Latin and Arabic glyphs; full right-to-left layout waits for R20-03                                                             |
| The PDF library may fetch fonts or assets over the network by default                                              | The escalation checks it; the generator is configured with explicit font data, and a test runs generation with network access blocked                             |
| Canvas editors are hard to make accessible                                                                         | The step list is the primary editor; the canvas is optional (section 4.8)                                                                                         |
| Better Auth's organization roles are fixed strings                                                                 | Keep the four membership roles and put configured roles in `app.member_roles` (section 3.3)                                                                       |
| Real employee data is needed to test the org chart                                                                 | Fictional workbooks only, on Preview and locally; real data only after Production go-live and the owner's migration approval                                      |
| R1.1 to R1.5 follow Release 2 (decision 1), so scorecards, user references and retention arrive later              | Release 2 builds only the interfaces they need (assignments, retention class, workflow events) and documents them                                                 |

## Appendix: traceability

| Requirement | Designed in            | Delivered by build items                                                               |
| ----------- | ---------------------- | -------------------------------------------------------------------------------------- |
| R2-01       | Tenancy decision, 1, 3 | R2a-01, R2a-04, R2a-05, R2a-11, R2a-12, R2a-16, R2b-09, R2c-09, R2c-16, R2d-09, R2d-10 |
| R2-02       | 1, 2                   | R2b-01, R2b-02, R2b-03, R2b-04, R2b-05, R2b-06, R2b-07, R2b-09, R2b-10, R2b-12         |
| R2-03       | 1.4, 2                 | R2b-11                                                                                 |
| R2-04       | 4                      | R2c-01, R2c-02, R2c-03, R2c-04, R2c-06, R2c-07, R2c-08, R2c-09, R2c-10                 |
| R2-05       | 5                      | R2c-15, R2c-16, R2c-17                                                                 |
| R2-06       | 3                      | R2a-02, R2a-03, R2a-05, R2a-06, R2a-07, R2a-08, R2a-09, R2a-10, R2a-18, R2a-19, R2b-08 |
| R2-07       | 6                      | R2a-13, R2a-14, R2a-15, R2a-16, R2a-17                                                 |
| R2-08       | 7                      | R2d-01, R2d-02, R2d-03, R2d-04, R2d-05, R2d-06, R2d-07, R2d-08, R2d-09                 |
| R2-09       | 8                      | R2a-09, R2b-12, R2d-10, R2d-11                                                         |
| R2-10       | 9                      | R2d-12, R2d-13, R2d-14                                                                 |
| R2-11       | 3.5, 6.5               | R2c-18                                                                                 |
| R2-12       | 10                     | R2a-20, R2a-21                                                                         |
| R16-01      | 1.3, 4.7               | R2c-01, R2c-07                                                                         |
| R16-02      | 2.2, 4.2               | R2c-01                                                                                 |
| R16-03      | 1.5, 4.3               | R2b-07, R2b-10, R2c-02                                                                 |
| R16-04      | 4.3                    | R2c-02                                                                                 |
| R16-05      | 4.5                    | R2c-04, R2c-05                                                                         |
| R16-06      | 4.8                    | R2c-09, R2c-10                                                                         |
| R16-07      | 4.6, 4.8               | R2c-06, R2c-08                                                                         |
| R16-08      | 4                      | R2c-11                                                                                 |
| R16-09      | 1.3, 4.3, 3.3          | R2a-04, R2c-06                                                                         |
| R16-10      | 4.3                    | R2c-14                                                                                 |
| R12-01      | 3.3, 6.5               | R2c-18                                                                                 |
| R12-02      | 4.5                    | R2c-12                                                                                 |
| R12-03      | 3.4, 4.5               | R2c-13                                                                                 |
| R12-07      | 7.6                    | R2d-01, R2d-02                                                                         |
