# Release 2 build plan

_Design only (R2-00, job 041), 8 November 2026. The owner reviews this plan and [architecture.md](architecture.md), and decides its open decisions (section 13), before any item is added to the factory backlog or queued._

This is the ordered list of factory backlog items for Release 2, grouped by the roadmap's milestones ([ROADMAP.md](../ROADMAP.md#release-2--configurable-platform)): R2a foundations, R2b configurable records, R2c workflows and boards, R2d documents, AI and planning. Each item is sized for one reviewable job of about 1-3 hours of build. Section references such as "§3.5" point to [architecture.md](architecture.md).

**Rules for every item.**

- **Dependencies** point only to earlier items. An item is queued only when every item it depends on is merged.
- **Migrations** are numbered after the highest on main at build time, never with a fixed number. Each migration names the role-template change in `infrastructure/postgres-split-runtime-roles.sql` (and the matching lists in `scripts/runtime-role-template.ts` and `src/db/connection-boundary.ts`), and whether it raises the storage schema marker (`STORAGE_SCHEMA_VERSION` in `src/db/storage-schema.ts` and the migration's last statement) by one. Every migration the code depends on raises the marker, so hosted startup refuses a database without it.
- **Validation** for every item: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:storage`, `npm run build`, Prettier on changed files, with fictional data only. Where the request path changes, `tests/round-trip-budget.test.ts` keeps 6 round trips for a simple read, 11 for a simple write and 15 for the overview. Where routes change, `tests/openapi-contract.test.ts` is updated. Where MCP tools change, the MCP suites are updated and the `tenant_context.audit_mcp_call` allowlist stays equal to the tool list. Where the tenant boundary changes, `scripts/live-role-tests.ts` is extended and run against a throwaway local PostgreSQL cluster in the worktree `.data` folder, as `AGENTS.md` requires.
- **Docs** named per item are updated in the same job, plus a `### <item> (job NNN)` entry in section 4 of `docs/requirements/register.md`.
- No item weakens a security guard, adds a dependency without escalation, or uses real candidate or employee data.

Each milestone ends with a checkpoint on Preview that the owner runs.

## R2a: Foundations

Contents: R2-01 Admin portal shell, R2-06 roles and permissions engine, R2-07 organisation model, R2-12 general team tasks.

### R2a-01 Workspace, team mapping and company authority

- **Epics:** R2-01, R2-06 (tenancy decision).
- **Size:** 3 h.
- **Depends on:** none.
- **Migration:** adds `app.workspaces`, `app.workspace_teams` and `app.workspace_admins` (new). It inserts one workspace with a fixed id, maps every team to it (`ON CONFLICT DO NOTHING`) and makes the initial administrator (`auth."user".initial_admin`) the first company owner. It also adds:
  - the owner-owned trigger function `app.map_new_team()` (new) on `auth.organization` insert, which refuses when more than one workspace exists;
  - the owner-run helper `tenant_context.set_workspace_authority(text, text, text[], boolean)` (new), callable only from a session context whose actor is a company owner, which refuses to remove or demote the last company owner;
  - the owner-owned trigger function `app.suspend_workspace_authority()` (new) on `auth.member` delete, which sets `app.workspace_admins.suspended_at` when the user is no longer a member of any team of the workspace;
  - an owner-only `workspace-authority` branch in the `app.activity` insert policy.

  FORCE row-level security on the three tables; `app.workspace_admins` is readable in full by company owners and admins and otherwise only one's own row. Role template: `SELECT` on the three tables and `EXECUTE` on the helper for `recruitmentos_data`, no write grant on any of them for either runtime role. Marker: +1.

- **Acceptance criteria:**
  1. After `npm run db:migrate` on a fictional `0027` baseline with two teams, both teams map to the one workspace, the initial administrator is the only company owner, and running the migration twice changes nothing.
  2. Creating a team through Better Auth maps it to the workspace in the same transaction; with a second workspace inserted by the owner, team creation fails.
  3. Neither runtime role can insert, update or delete in any of the three tables.
  4. The owner of a team created later is not a company owner; their call of the helper is refused, and so is a company admin's.
  5. A company owner grants a fictional member the `fields` area and plan access, and each change writes one audit row; removing the last company owner is refused.
  6. A member without company authority reads only their own `app.workspace_admins` row, if any.
  7. A company admin removed from every team is suspended; re-inviting them restores no company authority until a company owner clears the suspension, which is audited.
  8. No existing test changes.
- **Test approach:** `tests/workspace-tenancy.test.ts` (new, PGlite); `tests/migration-upgrade.test.ts` and `tests/runtime-role-grants.test.ts` extended; `scripts/live-role-tests.ts` gains the write-denied cases and a team-B owner calling the helper.
- **Docs:** `docs/identity-boundary-plan.md` (new "Company workspace" part), `docs/deployment.md`.

### R2a-02 Signed context derives the workspace and returns the access state

- **Epics:** R2-06.
- **Size:** 3 h.
- **Depends on:** R2a-01.
- **Migration:** adds `workspace_id`, `member_role`, `company_level`, `company_areas` and `plan_access` columns to `tenant_context.contexts`; replaces `tenant_context.install(text, text)` by `tenant_context.install(text, text, text[])` (new signature) returning `jsonb` with `{scopes, workspaceId, memberRole, companyLevel, companyAreas}`. The company columns come from `app.workspace_admins` only, never from `member.role`. Every existing check runs first and unchanged; the payload format and audience stay. Role template: the `EXECUTE` grants move to the new signature for every role that held the old one. Marker: +1.
- **Acceptance criteria:**
  1. `src/lib/tenant-context.ts` passes the third argument (an empty array for now) and `withTeam` makes the returned access state available to the work function.
  2. A context for a team with no workspace mapping is rejected with `42501`.
  3. A team owner without an `app.workspace_admins` row, or with a suspended one, gets a context with no company level, areas or plan access.
  4. Every existing rejection case in `tests/tenant-context.test.ts` still fails the same way.
  5. `tests/round-trip-budget.test.ts` still counts 6, 11 and 15.
- **Test approach:** `tests/tenant-context.test.ts`, `tests/round-trip-budget.test.ts`, `tests/runtime-role-grants.test.ts`, `tests/connection-boundary.test.ts`; `scripts/live-role-tests.ts` gains forged-workspace, missing-mapping and team-owner-without-company-authority cases, run directly and through a throwaway PgBouncer in transaction mode.
- **Docs:** `docs/identity-boundary-plan.md` ("Signed tenant context"), `docs/validation.md`.

### R2a-03 New scopes and explicit role ceilings

- **Epics:** R2-06, R2-07, R2-10.
- **Size:** 2 h.
- **Depends on:** R2a-02.
- **Migration:** a new body for `tenant_context.install` (same signature) whose `known` list appends `directory:read`, `directory:write`, `plans:read`, `plans:write` (new) and whose per-role ceilings are explicit arrays instead of `known[1:6]`. Role template: unchanged. Marker: +1.
- **Acceptance criteria:**
  1. `SCOPES` in `src/lib/permissions.ts` appends the four scopes in the same order as `known`.
  2. `roleScopes()` gives owner and admin all eleven, recruiter today's six, viewer today's three.
  3. `MCP_SCOPES` and the OAuth consent page (`src/lib/scope-descriptions.ts`) are unchanged.
  4. A recruiter context asserting `plans:read` is rejected.
- **Test approach:** `tests/tenant-context.test.ts`, `tests/token-role-boundary.test.ts`, `tests/api-token-policy.test.ts`; `scripts/live-role-tests.ts` scope-ceiling cases.
- **Docs:** `docs/identity-boundary-plan.md`, `docs/api-examples.md`.

### R2a-04 Versioned configuration store and configuration audit

- **Epics:** R2-01, R16-09.
- **Size:** 3 h.
- **Depends on:** R2a-01.
- **Migration:** adds `app.config_objects` (with the nullable `team_id` for team task boards), `app.config_versions` and `app.config_layouts` (new), the trigger function `app.guard_config_version()` (new; it refuses a `state` change from a runtime role), the owner-run publish helper `tenant_context.publish_config_version(uuid)` (new; it checks the context's company authority for the object's area, assigns the number and moves `current_version_id`), the policy helper `tenant_context.allows_workspace(uuid, text, text)` (new; writes need the context's company authority for the area, or, for a `task-board` object of the context's own team, team owner or admin), the audit helper `tenant_context.audit_config(uuid, text)` (new) and the read helper `tenant_context.config_history(uuid, timestamptz, int)` (new); recreates the `app.activity` insert policy with one owner-only `config` branch. Role template: `SELECT, INSERT, UPDATE, DELETE` on the three tables and `EXECUTE` on the four helpers for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. A new service `src/lib/config-store.ts` (new) creates a draft, edits it, publishes it through `tenant_context.publish_config_version` and retires a version. A published body cannot be changed or deleted by any runtime role, and a direct `UPDATE` of `state` by a runtime role is refused.
  2. Each change writes exactly one `config` activity row whose metadata has no body.
  3. A runtime role cannot insert a `config` activity row directly.
  4. A context of a team in another workspace reads no configuration row (two workspaces inserted by the owner in the test).
  5. A team owner or admin without company authority cannot write any company configuration row, by the service or by direct SQL; a company admin can write only the areas granted.
  6. `tenant_context.config_history` returns rows only to company owners and admins, and returns only time, action, object type and key, version numbers and the actor's display name: no team id, user id, record id or body.
- **Test approach:** `tests/config-store.test.ts` (new, PGlite); `tests/runtime-role-grants.test.ts`; `scripts/live-role-tests.ts` cross-workspace, forged-audit and team-B-owner-writes-company-configuration cases.
- **Docs:** `docs/identity-boundary-plan.md` ("Configuration audit"), `docs/security.md`.

### R2a-05 Configuration versions through install, with the instance cache

- **Epics:** R2-01, R2-06.
- **Size:** 2 h.
- **Depends on:** R2a-02, R2a-04.
- **Migration:** a new body for `tenant_context.install` that adds `versions` (current version id per configuration object the request may need) and `documents` (bodies of current versions not in the `cached` argument) to its result. Role template: unchanged. Marker: +1.
- **Acceptance criteria:**
  1. An in-process cache keyed by version id (new, in `src/lib/config-store.ts`) holds bodies, with a size cap of 8 MiB.
  2. A publish is visible to the next transaction of every instance.
  3. A cold-cache request and a warm-cache request both keep the 6, 11 and 15 round-trip counts.
  4. A forged `cached` list cannot return another workspace's body.
- **Test approach:** `tests/config-store.test.ts` (new in R2a-04), `tests/round-trip-budget.test.ts` (cold and warm cases), `tests/tenant-context.test.ts`; `scripts/live-role-tests.ts` cross-workspace hint case.
- **Docs:** `docs/identity-boundary-plan.md`, `docs/validation.md`.

### R2a-06 Authorization engine and the four built-in role templates

- **Epics:** R2-06.
- **Size:** 3 h.
- **Depends on:** R2a-03.
- **Migration:** none.
- **Acceptance criteria:**
  1. `src/lib/authz.ts` (new) exports `authorize`, `scopeFilter` and `redact` (§3.2) as pure functions over an `AccessContext`.
  2. `src/domain/config-defaults.ts` (new) defines the owner, admin, recruiter and viewer templates with today's effect, plus the hiring manager and interviewer templates (§3.3).
  3. A strict role schema in `src/domain/config.ts` (new) refuses any key that names candidate states, private saved views or notification reads.
  4. For every resource, action and built-in role, `authorize` gives the same answer as today's `permission()`, `importPermission()` and `roleScopes()`.
- **Test approach:** `tests/authz.test.ts` (new): the full equivalence matrix against today's functions, the escalation matrix (§11.6) and the private-state rule.
- **Docs:** `docs/security.md` ("Identity and tenancy").

### R2a-07 Records service on the engine

- **Epics:** R2-06.
- **Size:** 3 h.
- **Depends on:** R2a-05, R2a-06.
- **Migration:** none.
- **Acceptance criteria:**
  1. `permission()`, `owned()` and `importPermission()` in `src/lib/records.ts` are removed; every call goes through `authorize` and `scopeFilter`.
  2. `getRecord`, `listRecords`, `createRecord`, `updateRecord`, `bulkApplications`, `recordKindOf`, `checkReferences`, `decorate`, candidate state and candidate suggestions behave exactly as before for the four roles.
  3. Round-trip counts unchanged.
- **Test approach:** `tests/records-postgres.test.ts`, `tests/records-domain.test.ts`, `tests/api-boundaries.test.ts`, `tests/activity-role-boundary.test.ts`, `tests/round-trip-budget.test.ts`, all unchanged and passing.
- **Docs:** `docs/security.md`.

### R2a-08 Insights, search, notifications, activity and exports on the engine

- **Epics:** R2-06.
- **Size:** 3 h.
- **Depends on:** R2a-07.
- **Migration:** none.
- **Acceptance criteria:**
  1. `overview`, `analytics`, `listActivity`, `searchWorkspace`, `notifications` and `markNotifications` in `src/lib/insights.ts`, and `exportRecords`, use `authorize`, `scopeFilter` inside their SQL and `redact` on returned rows.
  2. The export audit keys and `PRIVATE_EXPORT_FILTER_KEYS` are unchanged.
  3. Overview stays at 15 round trips.
- **Test approach:** `tests/insights-postgres.test.ts`, `tests/record-export.test.ts`, `tests/round-trip-budget.test.ts`, unchanged and passing; `tests/authz.test.ts` (new in R2a-06) gains output cases.
- **Docs:** `docs/security.md`.

### R2a-09 MCP tools and OAuth consent on the engine

- **Epics:** R2-06, R2-09.
- **Size:** 2 h.
- **Depends on:** R2a-07.
- **Migration:** none.
- **Acceptance criteria:**
  1. Each tool in `src/lib/mcp/tools.ts` declares an access request; the dispatcher calls `authorize` before `tenant_context.audit_mcp_call`, and a denied call is still audited as `mcp.tool_denied`.
  2. Tool names, inputs, outputs and the 59-name allowlist are unchanged.
  3. OAuth consent offers the same scopes as today for each role.
- **Test approach:** `tests/mcp-endpoint.test.ts`, `tests/mcp-pipeline-tools.test.ts`, `tests/mcp-candidate-task-tools.test.ts`, `tests/mcp-cv-tools.test.ts`, `tests/mcp-oauth.test.ts`, unchanged and passing.
- **Docs:** `docs/mcp.md`.

### R2a-10 Configured roles and member assignment

- **Epics:** R2-06.
- **Size:** 3 h.
- **Depends on:** R2a-05, R2a-06.
- **Migration:** adds `app.member_roles` (new) under FORCE row-level security (read for the team, write only for a session context whose `company_level` is owner); adds `role_version_id` to `tenant_context.contexts`; a new `install` body narrows the stored scopes to the role's scopes and returns the role version. Role template: `SELECT, INSERT, UPDATE, DELETE` on `app.member_roles` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. A member without a row holds the template matching `member.role`.
  2. Assigning the hiring manager template sets `member.role` to `recruiter` through Better Auth and writes the row; a mismatch uses the narrower scopes.
  3. A context asserting a scope the role lacks is stored without it, never widened.
  4. Only company owners assign roles and publish role versions; an attempt by a team owner without company authority (including the owner of a newly created team) or by a company admin is refused by the service and by the policy.
  5. Every assignment is audited and listed on the company owners' home screen.
- **Test approach:** `tests/member-roles.test.ts` (new), `tests/tenant-context.test.ts`, `tests/auth-flows.test.ts`, `tests/round-trip-budget.test.ts` (custom role case); `scripts/live-role-tests.ts` narrowing, admin-denied and team-B-owner-denied cases.
- **Docs:** `docs/identity-boundary-plan.md`, `docs/authentication.md`, `docs/user-guide.md`.

### R2a-11 Admin portal shell and configuration history

- **Epics:** R2-01.
- **Size:** 3 h.
- **Depends on:** R2a-04, R2a-06.
- **Migration:** none.
- **Acceptance criteria:**
  1. A new route `src/app/app/admin/[tab]/page.tsx` (new) shows the R2-01 tabs that exist at this point (Roles & permissions placeholder hidden until R2a-12, members, CV storage, speed and tokens linking to the existing settings pages) and a History tab.
  2. Company owners and admins see the company tabs they hold areas for; team owners and admins see only the team tabs (members, CV storage, speed, tokens, task boards). Other routes return 403 with a plain "You do not have access to this page" state.
  3. History lists `config` events of every team in the workspace through `tenant_context.config_history`, for company owners and admins only.
  4. A new route `GET /api/v1/me/access` (new) returns the caller's pages, actions and field rules.
  5. No tab is shown for a feature that does not exist yet.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (new), `tests/settings-ui.test.tsx`, `tests/openapi-contract.test.ts`; keyboard and dark-theme checks recorded in `docs/accessibility-checklist.md`.
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### R2a-12 Roles and permissions tab

- **Epics:** R2-01, R2-06.
- **Size:** 3 h.
- **Depends on:** R2a-10, R2a-11.
- **Migration:** none.
- **Acceptance criteria:**
  1. Company owners copy a template into a draft role, edit pages, actions per resource, field rules (system fields of today's kinds) and record scope in standard form controls, and publish it.
  2. A grant outside the role's membership ceiling cannot be saved.
  3. The Owner template is read-only.
  4. Members get their role from Team settings, set by a company owner.
  5. A "Company authority" panel lets company owners grant and remove company owner and admin levels, areas and plan access through `tenant_context.set_workspace_authority`.
  6. Every change appears in History.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (new in R2a-11), `tests/authz.test.ts` (new in R2a-06; escalation cases through the API), `tests/member-roles.test.ts` (new in R2a-10).
- **Docs:** `docs/user-guide.md`, `docs/security.md`.

### R2a-13 Org levels, units and closure

- **Epics:** R2-07.
- **Size:** 3 h.
- **Depends on:** R2a-04.
- **Migration:** adds `app.org_levels`, `app.org_units` and `app.org_unit_closure` (new) with the trigger function `app.maintain_org_closure()` (new); read policies for the workspace and write policies for the company `organisation` area through `allows_workspace`; and the owner-owned trigger function `app.guard_scope_sources()` (new) on `app.org_units`, which refuses a `parent_id` change or an archive, and an insert that gives an existing unit a new effective parent (effective-dated rows), unless the context's `company_level` is owner. Role template: `SELECT, INSERT, UPDATE` on the three tables for `recruitmentos_data` (closure rows written only by the trigger). Marker: +1.
- **Acceptance criteria:**
  1. A new service `src/lib/org.ts` (new) and routes under `/api/v1/org-units` (new) create, rename, move and archive units and levels.
  2. A move under the unit's own subtree is refused.
  3. The closure table is correct after every operation for a fictional 500-unit, 6-level tree.
  4. A company admin with the `organisation` area creates and renames units, but cannot move or archive one, either by update or by inserting a new effective row for it; a company owner can, and each move writes a `scope.home_units_changed` row.
  5. Every change is audited.
- **Test approach:** `tests/org-units.test.ts` (new, PGlite); `tests/openapi-contract.test.ts`; `scripts/live-role-tests.ts` cross-workspace, runtime-closure-write and admin-moves-unit-denied cases.
- **Docs:** `docs/api-examples.md`, `docs/user-guide.md`.

### R2a-14 Positions and employees

- **Epics:** R2-07.
- **Size:** 3 h.
- **Depends on:** R2a-03, R2a-13.
- **Migration:** adds `app.positions`, `app.employees` and `app.employee_positions` (new). Employee reads need `directory:read` and write `directory:write` in the context, through a new helper `tenant_context.allows_directory(uuid, text)` (new). `app.guard_scope_sources()` is extended, on inserts as well as updates, to:
  - `app.employees`: any `user_id` change, and an insert with `user_id` already set;
  - `app.employee_positions`: any change for an employee with a user link;
  - `app.positions`: an `org_unit_id` change, or a new effective row with another unit, for a position held by a linked employee.

  Each of these changes each needs a company owner context and writes a `scope.home_units_changed` row. Role template: `SELECT, INSERT, UPDATE` on the three tables and `EXECUTE` on the helper for `recruitmentos_data`. Marker: +1.

- **Acceptance criteria:**
  1. Routes under `/api/v1/positions` and `/api/v1/employees` (new) create, update, archive and page through them, with the directory filters of §6.3 (unit including descendants, level, position, status).
  2. An employee links to at most one user per workspace.
  3. Only a company owner links or unlinks a user, creates an employee already linked to a user, or changes a linked employee's positions (including through a new effective position row). A member with `directory:write`, a company admin and a team owner are refused by the service and by direct SQL, including for their own employee row.
  4. Each such change is listed on the company owners' home screen with role assignments.
  5. A role with directory rule `basic` gets no work email or phone (service-layer rule, D16).
  6. A context without `directory:read` reads no employee row.
- **Test approach:** `tests/directory.test.ts` (new); `tests/openapi-contract.test.ts`; `scripts/live-role-tests.ts` directory-scope and self-link-denied cases.
- **Docs:** `docs/api-examples.md`, `docs/security.md` (employee data).

### R2a-15 Employee erasure and retention hook

- **Epics:** R2-07.
- **Size:** 2 h.
- **Depends on:** R2a-14.
- **Migration:** adds the owner-only tombstone table `app.employee_erasures` (new) and the owner-run helper `tenant_context.erase_employee(uuid, text, text)` (new), with owner-only policies like `drizzle/0021_candidate_erasure.sql`, and a `retention_class` column on `app.employees`. Role template: `EXECUTE` on the helper for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. An owner erases an employee with a typed name confirmation in the app; the row and position history are deleted, the user link is removed, activity about the employee is redacted to type, time and actor, and a tombstone is written.
  2. A retry returns the earlier erasure.
  3. Non-owners are refused.
- **Test approach:** `tests/employee-erasure.test.ts` (new); `scripts/live-role-tests.ts` owner-only cases.
- **Docs:** `docs/erasure-runbook.md` (new "Erase an employee" section), `docs/identity-boundary-plan.md`.

### R2a-16 Organisation tab: org chart and directory

- **Epics:** R2-07, R2-01.
- **Size:** 3 h.
- **Depends on:** R2a-11, R2a-14.
- **Migration:** none.
- **Acceptance criteria:**
  1. The Organisation tab edits levels, units and positions.
  2. The org chart loads one level at a time and shows positions and employees per unit.
  3. The directory page searches and filters employees with paging.
  4. Both views work by keyboard, at 360 px width and in the dark theme.
- **Test approach:** `tests/organisation-ui.test.tsx` (new); manual keyboard, phone-width and dark checks recorded in `docs/accessibility-checklist.md`.
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### R2a-17 Excel import for the organisation

- **Epics:** R2-07.
- **Size:** 3 h.
- **Depends on:** R2a-14.
- **Migration:** none.
- **Acceptance criteria:**
  1. A fictional workbook with Units, Positions and Employees sheets gives a dry run with create, update, unchanged and reject counts and a reason per rejected row, writing nothing.
  2. Apply is idempotent by code and employee number.
  3. Files over 5 MiB or 20,000 rows, and workbooks over 2,000 zip entries or 50 MiB uncompressed, are refused before parsing.
  4. Formula-like cells are stored as text and flagged.
  5. Rows that would change a user link, a linked employee's positions or a unit's parent are never applied by a normal apply. They are listed in a "Needs a company owner" group, and a company owner applies them in a separate step that writes the home-unit audit rows.
  6. It uses `read-excel-file`, already a dependency, and adds none.
- **Test approach:** `tests/org-import.test.ts` (new) with fictional workbooks built in the test; `npm audit` unchanged.
- **Docs:** `docs/user-guide.md`.

### R2a-18 Record scope in the service: columns, assignments and home units

- **Epics:** R2-06, R2-07, R2-11.
- **Size:** 3 h.
- **Depends on:** R2a-07, R2a-10, R2a-14.
- **Migration:** adds `org_unit_id`, `scope_vacancy_id` and `scope_application_id` to `app.records` with the trigger function `app.maintain_record_scope()` (new) and a partial index `(team_id, candidate_id) WHERE kind = 'application'`; adds `app.record_assignments` (new) with the owner-run helpers `tenant_context.add_assignment(uuid, text, text)` and `tenant_context.remove_assignment(uuid, text, text)` (new); adds `record_scope` and `home_units` to `tenant_context.contexts`, filled by a new `install` body; extends `tenant_context.erase_employee` to remove the assignments of a linked user who is no longer a team member. Existing rows keep `null` scope columns until a vacancy gets a unit. Role template: `SELECT` only on `app.record_assignments` and `EXECUTE` on the two helpers for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. Vacancies take an org unit; their applications, interviews, offers, onboarding, checklist items and comments get it from the trigger, including after the vacancy's unit changes.
  2. `scopeFilter` applies the §3.5 table for `unit` and `assigned` roles in list, get, export, search, notifications, overview and analytics.
  3. A record outside scope is answered as 404, and as a missing parent in references.
  4. Neither runtime role can insert, update or delete `app.record_assignments` directly. The helpers refuse a record outside the caller's scope, a target user outside the team, self-assignment by a caller whose scope for that kind is not `all`, and, until R2c-04 adds approval requests, the `approver` relation outright.
  5. Round-trip counts unchanged for scope `all` and for a scoped principal.
- **Test approach:** `tests/org-scope.test.ts` (new) with the 500-unit fixture; `tests/round-trip-budget.test.ts` (hiring-manager case); `tests/records-postgres.test.ts` unchanged; `scripts/live-role-tests.ts` direct-insert-denied and scoped-self-assignment-denied cases.
- **Docs:** `docs/security.md`, `docs/user-guide.md`.

### R2a-19 Record scope in row-level security

- **Epics:** R2-06, R2-11.
- **Size:** 3 h.
- **Depends on:** R2a-18.
- **Migration:** adds `tenant_context.scope_is_all()`, `tenant_context.in_scope(…)`, `tenant_context.record_in_scope(text, uuid)` and `tenant_context.candidate_in_scope(text, uuid)` (new). All four are owner-owned `SECURITY DEFINER` functions with `SET search_path = pg_catalog, pg_temp`, so their probes of `app.records` run as the owner and never re-enter the policy. It also adds the restrictive scope policies of §3.5, all true for the migration owner:
  - on `app.records` for all commands;
  - on `app.activity` (by `record_id`);
  - on `app.uploads` (by `candidate_id`);
  - on `app.record_assignments` (by `record_id`);
  - on `app.idempotency` for all commands, requiring `actor_key = tenant_context.context_actor_key()` (a fifth new owner-owned helper), plus a new `role_version_id` column on `app.idempotency`.

  Tables added later get theirs in their own items. Role template: `EXECUTE` on the five helpers for `recruitmentos_data`. Marker: +1.

- **Acceptance criteria:**
  1. Under a scoped context, a direct `SELECT` as the data role returns only in-scope rows. This holds for `app.records`, `app.activity`, `app.uploads` and `app.record_assignments`, and an `UPDATE` or `INSERT` of an out-of-scope record is refused.
  2. Under any context, a direct `SELECT` on `app.idempotency` returns only rows of the context's own actor key; another member's cached responses, including the record and CV write paths, are not readable.
  3. `idempotent` in `src/lib/records.ts` stores the role version with each response. A replay after the actor's role version changed discards the cached body and returns the record's current state through the normal read path; every replay is redacted under the current role.
  4. Scope `all` contexts see exactly what they saw before.
  5. Candidate erasure (which updates idempotency rows of every actor as the owner) and every owner-run helper still work, and no policy recurses.
  6. With the 2,000-candidate fixture, the overview and list database times are within 10% of the previous release locally.
- **Test approach:** `tests/record-scope-rls.test.ts` (new); `tests/candidate-erasure.test.ts`; `tests/records-postgres.test.ts` (idempotent replay after a role change); `npm run bench:round-trips -- --fixture`; `scripts/live-role-tests.ts` direct-SQL scope cases per table, and a scoped context reading no other actor's idempotency row, through the pooler.
- **Docs:** `docs/identity-boundary-plan.md` ("Record scope"), `docs/validation.md`.

### R2a-20 Team tasks: label, assignees and links

- **Epics:** R2-12.
- **Size:** 2 h.
- **Depends on:** R2a-18.
- **Migration:** none.
- **Acceptance criteria:**
  1. "Recruitment tasks" reads "Team tasks" everywhere in the UI.
  2. Tasks take `assigneeIds` (team members only, at most 10), stored as assignments.
  3. Tasks may link to any record kind except `saved-view`, `shared-view` and `comment` through `parentRecordId`.
  4. Existing tasks, buckets and `task-field` records are untouched, and the REST and MCP task contracts only gain optional fields.
- **Test approach:** `tests/records-postgres.test.ts` (new task cases), `tests/mcp-candidate-task-tools.test.ts`, `tests/openapi-contract.test.ts`, `tests/workspace-render.test.tsx`.
- **Docs:** `docs/user-guide.md`, `docs/mcp.md`, `docs/api-examples.md`.

### R2a-21 Task boards per team and project

- **Epics:** R2-12.
- **Size:** 2 h.
- **Depends on:** R2a-04, R2a-20.
- **Migration:** none (task boards are `task-board` configuration objects in the store of R2a-04).
- **Acceptance criteria:**
  1. Team owners and admins define task boards for their own team (team-scoped `task-board` objects) with a subset of buckets and an optional filter; another team neither sees nor edits them.
  2. Every team keeps a default board of all buckets.
  3. The Tasks screen switches boards.
  4. "Counts as completed" keeps its effect on overdue lists and reminders.
- **Test approach:** `tests/task-boards.test.ts` (new); `tests/insights-postgres.test.ts` reminders unchanged.
- **Docs:** `docs/user-guide.md`.

### R2a Preview checkpoint

- **Owner steps:** apply the R2a migrations in build order after `0027`, rerun the role template (`infrastructure/postgres-split-runtime-roles.sql`), run `scripts/db-role-evidence.ts` (zero drift) and `npm run test:live-roles` directly and through the pooler, then deploy with the CLI deploy script.
- **Version:** `1.1.0` under the `docs/deployment.md` version rule (the minor number per Preview feature drop; decision D3).
- **What the owner tests on Preview:**
  - every existing screen, API call and MCP tool behaves as in `1.0.0`;
  - the Admin portal shows History and Roles & permissions, and the owner is listed as the only company owner;
  - the owner of a second fictional team cannot change roles or company configuration and does not see the company tabs;
  - a fictional hiring manager linked to a fictional employee sees only their unit's vacancies and candidates, and cannot widen that by editing the directory;
  - org chart, directory and the fictional Excel import, including the "Needs a company owner" group;
  - employee erasure;
  - team tasks with assignees;
  - the Speed panel still shows today's timings.
- **Data:** real candidate and employee data stays out of Preview; only fictional data is used.

## R2b: Configurable records

Contents: R2-02 screen and field builder, R2-03 categories and types.

### R2b-01 Built-in defaults compiled from code

- **Epics:** R2-02, R2-03.
- **Size:** 2 h.
- **Depends on:** R2a-05.
- **Migration:** none.
- **Acceptance criteria:**
  1. `src/domain/config-defaults.ts` (new in R2a-06) also builds the default kind schema of every configurable kind from `recordDataSchemas`, `RESOURCE_CONFIG` labels and types and today's required and read-only sets, with fixed version ids (§2.1).
  2. `RESOURCE_CONFIG` is derived from the default schemas and is identical to today's.
  3. A workspace with no published kind schema uses the default.
- **Test approach:** `tests/config-defaults.test.ts` (new): keys, order, labels, types, required and read-only sets equal today's.
- **Docs:** none beyond the register entry.

### R2b-02 Record pins and custom values on every configurable kind

- **Epics:** R2-02.
- **Size:** 2 h.
- **Depends on:** R2b-01.
- **Migration:** adds nullable `schema_version_id` and `type_id` to `app.records`. No data is rewritten. Role template: unchanged. Marker: +1.
- **Acceptance criteria:**
  1. `recordDataSchemas` gains an optional `customValues` key on candidate, job-role, vacancy, application, interview, offer, onboarding and checklist with the task shape.
  2. Existing rows read and write unchanged, with no `customValues` added.
  3. Created and updated records store the schema version id they were validated against.
  4. REST and MCP responses for existing records are byte-identical.
- **Test approach:** `tests/records-domain.test.ts`, `tests/records-postgres.test.ts`, `tests/migration-upgrade.test.ts` (before and after comparison on a populated fictional baseline).
- **Docs:** `docs/api-examples.md`.

### R2b-03 Field type engine

- **Epics:** R2-02.
- **Size:** 3 h.
- **Depends on:** R2b-01.
- **Migration:** none.
- **Acceptance criteria:**
  1. `src/domain/field-types.ts` (new) defines the 19 types of R2-02 with defaults, help text, min and max, pattern and options, each building a bounded zod schema.
  2. `compileKindSchema` compiles a kind schema version into a `customValues` validator and per-screen mandatory rules, cached by version id.
  3. Patterns are length-limited and checked for catastrophic backtracking before publish.
- **Test approach:** `tests/field-types.test.ts` (new) with the largest configuration of §12.
- **Docs:** none beyond the register entry.

### R2b-04 Dynamic validation on create and update

- **Epics:** R2-02.
- **Size:** 3 h.
- **Depends on:** R2b-02, R2b-03.
- **Migration:** none.
- **Acceptance criteria:**
  1. `createInside` and `updateRecord` run the strict zod schema, then the compiled validator, then the mandatory rules of §1.5.
  2. Archived field values must be preserved.
  3. `checkCustomValues` validates team `task-field` records through the same engine with unchanged messages.
  4. A mandatory field added after a record's pinned version does not block an unrelated edit.
- **Test approach:** `tests/records-postgres.test.ts` (custom-field cases on every kind), `tests/round-trip-budget.test.ts` (11 for a task write).
- **Docs:** `docs/user-guide.md`.

### R2b-05 Person, org unit and lookup fields

- **Epics:** R2-02, R2-07.
- **Size:** 2 h.
- **Depends on:** R2a-14, R2b-04.
- **Migration:** none.
- **Acceptance criteria:**
  1. Person values must be members of the record's team.
  2. Org unit values must be units of the workspace.
  3. Lookup values must be records of the named kind in the same team and in the caller's scope, else the write fails as a missing reference.
  4. Lookup defaults are refused at publish.
- **Test approach:** `tests/records-postgres.test.ts` (reference cases), `tests/org-scope.test.ts` (new in R2a-18).
- **Docs:** `docs/api-examples.md`.

### R2b-06 File fields through the CV storage path

- **Epics:** R2-02.
- **Size:** 3 h.
- **Depends on:** R2b-04.
- **Migration:** adds `app.record_files` (new) with the reference fields of `app.uploads` (provider, store, environment, object key, digest, size, status, `erasure_id`) keyed by team and record; extends `storage_ledger.guard_upload`-style guards and the erasure helper to it; adds the restrictive scope policy of §3.5 keyed by `record_id`. Role template: `SELECT, INSERT, UPDATE` on the table for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. A file field accepts PDF, DOCX and image files through the same tickets, size cap, magic-byte checks, digest and ledger as CVs.
  2. Downloads are attachments only (DEC-07).
  3. Erasing a candidate removes their record files with the Blob cleanup.
  4. A scoped context reads no record file of an out-of-scope record by direct SQL.
- **Test approach:** `npm run test:storage` (new native cases), `tests/cv-blob-transfer.test.ts`, `tests/candidate-erasure.test.ts`, `tests/cv-inline-content.test.ts`; `scripts/live-role-tests.ts` table and scope cases.
- **Docs:** `docs/blob-security-design.md`, `docs/blob-quota-design.md`, `docs/erasure-runbook.md`.

### R2b-07 Screens per kind, type and action

- **Epics:** R2-02, R16-03.
- **Size:** 3 h.
- **Depends on:** R2b-04.
- **Migration:** none.
- **Acceptance criteria:**
  1. Kind schemas hold screens per type and action (create, edit, view, transition) with groups, order, hidden and mandatory flags.
  2. The record editor (`src/components/workspace/editor.tsx`) and profile render from the screen for the record's type and action.
  3. With the default schemas every form looks as today.
  4. A hidden-on-screen field keeps its stored value on save.
- **Test approach:** `tests/workspace-render.test.tsx`, `tests/workspace-ui.test.ts`, `tests/screens.test.ts` (new).
- **Docs:** `docs/user-guide.md`.

### R2b-08 Field permissions and redaction for custom fields in every output

- **Epics:** R2-06, R2-02.
- **Size:** 3 h.
- **Depends on:** R2a-08, R2a-09, R2b-04.
- **Migration:** none.
- **Acceptance criteria:**
  1. Field rules (`hidden`, `read`, `edit`) apply to system and custom fields in REST, exports, search matching, notifications, activity metadata, decorate labels, analytics groups and MCP results (§3.4).
  2. A search term cannot match a hidden value.
  3. Filtering or sorting by a hidden field returns 400.
  4. A write naming a hidden or read-only field returns 403 `field_forbidden`.
- **Test approach:** `tests/field-redaction.test.ts` (new) with one case per output, `tests/record-export.test.ts`, `tests/mcp-pipeline-tools.test.ts`.
- **Docs:** `docs/security.md`, `docs/mcp.md`.

### R2b-09 Screens and fields tab: fields

- **Epics:** R2-02, R2-01.
- **Size:** 3 h.
- **Depends on:** R2a-11, R2b-07.
- **Migration:** none.
- **Acceptance criteria:**
  1. Company admins with the `fields` area (and company owners) add, rename, reorder, group, archive and mark custom fields per kind, choosing one of the 19 types with defaults, help text and validation.
  2. System fields can be relabelled, given help text, grouped and made mandatory, never removed or retyped.
  3. Company owners can mark fields sensitive.
  4. Publishing shows the change summary.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (new in R2a-11; fields cases), `tests/config-store.test.ts` (new in R2a-04).
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### R2b-10 Screens and fields tab: screen layout

- **Epics:** R2-02, R16-03.
- **Size:** 2 h.
- **Depends on:** R2b-09.
- **Migration:** none.
- **Acceptance criteria:**
  1. Admins choose fields, groups, order and mandatory or read-only flags per type and action, with move up and move down buttons as the keyboard alternative to dragging.
  2. A preview shows the form.
  3. A screen that would hide a mandatory field on create is refused.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (new in R2a-11; screen cases).
- **Docs:** `docs/user-guide.md`.

### R2b-11 Categories and types

- **Epics:** R2-03.
- **Size:** 3 h.
- **Depends on:** R2b-07, R2b-09.
- **Migration:** none (`type_id` came with R2b-02).
- **Acceptance criteria:**
  1. Admins define types for applications, vacancies and job roles (for example the fictional "Emiratisation", "Executive", "Internal transfer", "Contractor"), each selecting a screen set.
  2. Records take a type on create; a type change re-validates against the new screens.
  3. Lists filter by `type`.
  4. Records without a type use the default screens.
- **Test approach:** `tests/records-postgres.test.ts` (type cases), `tests/admin-portal-ui.test.tsx` (new in R2a-11), `tests/openapi-contract.test.ts`.
- **Docs:** `docs/user-guide.md`, `docs/api-examples.md`.

### R2b-12 Field metadata in REST, OpenAPI and MCP

- **Epics:** R2-02, R2-09.
- **Size:** 2 h.
- **Depends on:** R2b-08, R2b-11.
- **Migration:** a new body for `tenant_context.audit_mcp_call` whose allowlist adds `describe_fields`, equal to the new tool list. Role template: unchanged. Marker: +1.
- **Acceptance criteria:**
  1. `GET /api/v1/config/fields/[resource]` (new) returns the fields, types and screens visible to the caller.
  2. OpenAPI describes `customValues` and optional fields without any configured label.
  3. The MCP tool `describe_fields` returns the same metadata inside the untrusted-data wrapper.
  4. Tool descriptions stay static.
- **Test approach:** `tests/openapi-contract.test.ts`, `tests/mcp-endpoint.test.ts`, `tests/mcp-pipeline-tools.test.ts`.
- **Docs:** `docs/mcp.md`, `docs/api-examples.md`.

### R2b Preview checkpoint

- **Owner steps:** apply the R2b migrations in build order after the R2a ones, rerun the role template, run `scripts/db-role-evidence.ts` and `npm run test:live-roles`, then deploy.
- **Version:** `1.2.0`.
- **What the owner tests on Preview:**
  - add fictional custom fields of several types to candidates, vacancies and applications;
  - relabel a system field;
  - make a field mandatory on create;
  - define the fictional "Executive" vacancy type with its own screen;
  - hide the offer amount from the hiring manager role and check the UI, an export, search and a connected AI app;
  - attach a fictional file field;
  - every unchanged form still looks as in `1.1.0`.
- **Data:** real candidate and employee data stays out of Preview.

## R2c: Workflows and boards

Contents: R2-04 workflow builder, R2-05 boards and views, R2-11 stakeholder views, with R12-01 to R12-03.

### R2c-01 Workflow model and default workflows

- **Epics:** R2-04, R16-01, R16-02.
- **Size:** 3 h.
- **Depends on:** R2b-02, R2b-11.
- **Migration:** adds nullable `workflow_version_id` and `workflow_status` to `app.records` and an index `(team_id, kind, workflow_status)`. No data is rewritten; `null` means the default workflow and a status equal to the category. Role template: unchanged. Marker: +1.
- **Acceptance criteria:**
  1. `src/domain/workflow.ts` (new) validates workflow bodies (§4.2).
  2. `src/domain/config-defaults.ts` (new in R2a-06) adds the default application, vacancy, offer, interview, onboarding and checklist workflows of §2.2.
  3. The system `stage` and `status` fields keep holding the category.
  4. Types bind to a workflow, with a default.
  5. Every existing stage and status test passes unchanged.
- **Test approach:** `tests/workflow-engine.test.ts` (new), `tests/config-defaults.test.ts`, `tests/insights-postgres.test.ts`, `tests/records-postgres.test.ts`.
- **Docs:** `docs/user-guide.md`.

### R2c-02 Transition engine on the server

- **Epics:** R2-04, R16-03, R16-04.
- **Size:** 3 h.
- **Depends on:** R2c-01.
- **Migration:** none.
- **Acceptance criteria:**
  1. `src/lib/workflow-engine.ts` (new) `applyTransition` validates the from-status, `who` rule, condition and validators on the server, sets `workflow_status` and the category, and audits keys only.
  2. REST `PATCH`, bulk applications, a new `POST /api/v1/[resource]/[id]/transitions` (new) and the MCP update and move tools all go through it.
  3. A rule-initiated transition into Hired or Rejected is refused.
  4. Conditions cannot name sensitive or source fields.
  5. A default-workflow stage change stays at 11 round trips.
- **Test approach:** `tests/workflow-engine.test.ts` (new in R2c-01), `tests/round-trip-budget.test.ts`, `tests/mcp-pipeline-tools.test.ts`, `tests/openapi-contract.test.ts`.
- **Docs:** `docs/api-examples.md`, `docs/mcp.md`.

### R2c-03 Outbox and post-actions

- **Epics:** R2-04.
- **Size:** 3 h.
- **Depends on:** R2c-02.
- **Migration:** adds `app.outbox` (new, team-keyed, FORCE row-level security, rows written in the record's transaction and claimed with `FOR UPDATE SKIP LOCKED`), with the restrictive scope policy of §3.5 keyed by `record_id`. Role template: `SELECT, INSERT, UPDATE` on `app.outbox` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. Post-actions assign (through `tenant_context.add_assignment`), create a task, require an approval group and notify run in the transition's transaction; a failure rolls the transition back.
  2. An assign post-action targets only record-derived people (the person making the transition, the vacancy's assigned recruiter or hiring manager, a named relation on the application); the workflow schema refuses a fixed user id or role.
  3. Outside effects go to the outbox and are delivered after commit with retries; failures are visible in the record's history.
  4. No post-action type can change a status, a role, company authority or an approver assignment.
  5. A scoped context reads no outbox row of an out-of-scope record by direct SQL.
- **Test approach:** `tests/workflow-engine.test.ts` (post-action cases), `tests/outbox.test.ts` (new); `scripts/live-role-tests.ts` outbox cross-team and scope cases.
- **Docs:** `docs/security.md`.

### R2c-04 Approval groups and approval requests

- **Epics:** R2-04, R16-05.
- **Size:** 3 h.
- **Depends on:** R2c-03.
- **Migration:** adds `app.approval_requests` (with `members`, the group's user ids resolved at opening) and `app.approval_decisions` (new; decisions also store `record_id`). Both are team-keyed under FORCE row-level security, each with the restrictive scope policy of §3.5 keyed by `record_id`. It also adds:
  - a decisions insert policy that requires `approver_id` to be the context's actor and in the request's `members` (or their recorded delegate, from R2c-05);
  - requests inserted only with `state = pending`, and no runtime update of `state`;
  - the owner-run helper `tenant_context.close_approval_request(uuid)` (new), which computes the outcome from the stored decisions;
  - a new body of `tenant_context.add_assignment` that accepts the `approver` relation only when an open request for that record names the target user.

  Role template: `SELECT, INSERT` on both tables and `EXECUTE` on the new helper for `recruitmentos_data`. Marker: +1.

- **Acceptance criteria:**
  1. Any-one, all, majority and sequential rules close requests as §4.5 describes; one rejection closes any rule.
  2. Requesters cannot approve their own requests.
  3. Approvers can read the fields their group names for that record only; the engine adds their `approver` assignment through the helper, which refuses an `approver` for a user no open request names.
  4. By direct SQL, a member cannot insert a decision for another approver or for a request that does not name them, and cannot change a request's state.
  5. Approval outcomes cannot target the Hired or Rejected categories.
  6. Every decision is audited with the rule applied.
  7. A scoped context reads no request or decision of an out-of-scope record by direct SQL.
- **Test approach:** `tests/approvals.test.ts` (new); `scripts/live-role-tests.ts` approval, forged-decision, state-flip and scope cases.
- **Docs:** `docs/user-guide.md`, `docs/security.md`.

### R2c-05 Delegates, out-of-office cover and SLA reminders

- **Epics:** R16-05.
- **Size:** 2 h.
- **Depends on:** R2c-04.
- **Migration:** adds `app.approval_delegates` (new), each member writing only their own rows; extends `tenant_context.erase_employee` to remove the delegate rows of a linked user who is no longer a team member. Role template: `SELECT, INSERT, UPDATE, DELETE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. A member sets a delegate for a date range; the delegate's decisions record `on_behalf_of`.
  2. Overdue requests appear in reminders with stable keys and escalate after a second period.
  3. Reading reminders changes no request.
  4. Erasing the employee of a former member removes their delegate rows.
- **Test approach:** `tests/approvals.test.ts` (new in R2c-04), `tests/insights-postgres.test.ts` (reminder cases).
- **Docs:** `docs/user-guide.md`.

### R2c-06 Publish checks and versioning

- **Epics:** R2-04, R16-07, R16-09.
- **Size:** 3 h.
- **Depends on:** R2c-02, R2c-04.
- **Migration:** a new body of `tenant_context.publish_config_version` (same signature). It refuses a workflow, template or plan-settings draft whose approval-group membership (users and roles) differs from the current published version unless the context's `company_level` is owner, and audits such a publish as `config.approvers_changed`. Role template: unchanged. Marker: +1.
- **Acceptance criteria:**
  1. Publishing a workflow refuses, with a list, unreachable statuses, inescapable loops, groups without members or outcomes, conditions on deleted or archived fields, sensitive-field conditions and rule paths into Hired or Rejected.
  2. Saving or publishing a condition on a field hidden from the author's role is refused. The publish screen says when approval-group membership changed and that only a company owner can publish it.
  3. Publishing warns when an offered transition depends on a field the receiving role cannot see.
  4. A company admin with the `workflows` area cannot publish a draft whose approval group names themselves, or that adds or removes any user or role in a group. This holds through the service and by calling the helper directly. A company owner can, and the publish is listed with role assignments on the company owners' home screen.
  5. Published versions are immutable.
  6. Each publish is audited with its version number.
- **Test approach:** `tests/workflow-publish.test.ts` (new), `tests/config-store.test.ts` (new in R2a-04; approver-membership publish cases); `scripts/live-role-tests.ts` company-admin-self-approver-denied case.
- **Docs:** `docs/user-guide.md`.

### R2c-07 In-flight migration with an explicit status mapping

- **Epics:** R2-04, R16-01.
- **Size:** 3 h.
- **Depends on:** R2c-06.
- **Migration:** adds `app.workflow_migrations` (new, company level, under `allows_workspace`). Role template: `SELECT, INSERT, UPDATE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. Publishing requires a mapping for every status holding active applications.
  2. Applications migrate in batches of 500 per transaction per team with one `workflow.migrated` row each.
  3. Unmigrated rows read and write through the mapping.
  4. Closed applications keep their version.
  5. An interrupted run resumes.
- **Test approach:** `tests/workflow-migration.test.ts` (new) with 6,000 fictional applications.
- **Docs:** `docs/user-guide.md`, `docs/validation.md`.

### R2c-08 Test mode with no writes

- **Epics:** R2-04, R16-07.
- **Size:** 2 h.
- **Depends on:** R2c-06.
- **Migration:** none.
- **Acceptance criteria:**
  1. `POST /api/v1/admin/workflows/[id]/test` (new) runs a draft on sample values or a readable application in a read-only transaction.
  2. A real application is refused when the tester cannot see every field the draft's conditions and validators reference.
  3. It returns the path, matched conditions, failing validators, approval groups and post-actions without running any.
  4. A test confirms no row in any table changes.
- **Test approach:** `tests/workflow-engine.test.ts` (new in R2c-01; test-mode cases), `tests/openapi-contract.test.ts`.
- **Docs:** `docs/user-guide.md`.

### R2c-09 Workflows tab: step-list editor

- **Epics:** R2-04, R16-06.
- **Size:** 3 h.
- **Depends on:** R2a-11, R2c-06.
- **Migration:** none.
- **Acceptance criteria:**
  1. Company admins with the `workflows` area (and company owners) edit statuses, transitions, conditions, validators, post-actions and approval groups in lists, tables and dialogs. Approval-group members can be changed in a draft by anyone with the area, but only a company owner can publish that change. Assign post-actions offer only record-derived targets.
  2. The editor shows publish problems inline and the in-flight mapping step.
  3. Everything works by keyboard, with announced changes, at 360 px and 200% zoom.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (new in R2a-11; workflow cases); manual screen-reader and keyboard checks recorded in `docs/accessibility-checklist.md`.
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### R2c-10 Workflows tab: canvas editor

- **Epics:** R2-04, R16-06.
- **Size:** 3 h.
- **Depends on:** R2c-09.
- **Migration:** none (layout uses `app.config_layouts` from R2a-04).
- **Acceptance criteria:**
  1. A drag-and-drop canvas shows statuses as nodes in lanes and transitions as edges, editing the same draft as the step list.
  2. It stores only the §4.8 layout shape.
  3. A layout change does not create a semantic version.
  4. Nothing is possible only by dragging.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (new in R2a-11; canvas cases), `tests/config-store.test.ts` (new in R2a-04; layout kept apart from the body hash).
- **Docs:** `docs/user-guide.md`.

### R2c-11 Workflow templates and type binding

- **Epics:** R2-04, R16-08, R2-03.
- **Size:** 2 h.
- **Depends on:** R2c-09.
- **Migration:** none.
- **Acceptance criteria:**
  1. Ready-made fictional templates (standard hire, Emiratisation role, executive hire, internal transfer, contractor) can be copied into drafts.
  2. Each application type binds to one workflow, with a default.
  3. A new application uses its type's workflow.
- **Test approach:** `tests/workflow-publish.test.ts` (new in R2c-06; every template passes the publish checks).
- **Docs:** `docs/user-guide.md`.

### R2c-12 Requisition approval workflow for vacancies

- **Epics:** R2-04, R12-02.
- **Size:** 2 h.
- **Depends on:** R2c-04, R2c-11.
- **Migration:** none.
- **Acceptance criteria:**
  1. A vacancy workflow template adds the R12-02 requisition chain (department head, finance, HR as approval groups) between Draft and Open.
  2. A vacancy cannot reach Open before approval when the template is in use.
  3. The requester sees the request state.
- **Test approach:** `tests/approvals.test.ts` (new in R2c-04; vacancy cases).
- **Docs:** `docs/user-guide.md`.

### R2c-13 Offer approval with the amount visible to approvers

- **Epics:** R2-04, R12-03.
- **Size:** 2 h.
- **Depends on:** R2b-08, R2c-04.
- **Migration:** none.
- **Acceptance criteria:**
  1. An offer workflow template requires an approval group before Sent.
  2. The offer `amount` is hidden from roles without the field and readable by pending approvers for that offer only, in the UI, REST and MCP.
- **Test approach:** `tests/approvals.test.ts` (new in R2c-04), `tests/field-redaction.test.ts` (new in R2b-08; approver cases).
- **Docs:** `docs/user-guide.md`.

### R2c-14 Workflow events for later integrations

- **Epics:** R16-10.
- **Size:** 1 h.
- **Depends on:** R2c-03.
- **Migration:** none (events are outbox rows of type `event`).
- **Acceptance criteria:**
  1. Status entered, approval needed, approved and rejected write outbox events with ids and keys only, no field values.
  2. With no integration installed they are marked delivered to nobody and purged after 30 days.
- **Test approach:** `tests/outbox.test.ts` (new in R2c-03).
- **Docs:** `docs/security.md` (no new recipient).

### R2c-15 Boards engine

- **Epics:** R2-05.
- **Size:** 3 h.
- **Depends on:** R2c-01.
- **Migration:** none.
- **Acceptance criteria:**
  1. `board` configuration objects hold columns mapped to statuses, swimlanes, quick filters, card fields, WIP limits and a default mode (§5).
  2. One board page is one statement with per-column paging and totals, under `scopeFilter`.
  3. Unmapped statuses show to admins.
  4. A board page costs 6 round trips.
- **Test approach:** `tests/boards.test.ts` (new), `tests/round-trip-budget.test.ts` (board case).
- **Docs:** `docs/api-examples.md`.

### R2c-16 Boards tab and board screens

- **Epics:** R2-05, R2-01.
- **Size:** 3 h.
- **Depends on:** R2a-11, R2c-15.
- **Migration:** none.
- **Acceptance criteria:**
  1. Company admins with the `boards` area (and company owners) create and publish boards.
  2. The Applications screen offers the team's boards with swimlanes, quick filters, chosen card fields, WIP warnings and list and board modes.
  3. The default board looks as today's.
  4. Moving a card runs a transition, with the existing optimistic update and rollback.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (new in R2a-11), `tests/workspace-render.test.tsx`, `tests/optimistic-actions.test.ts`.
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### R2c-17 Shared views

- **Epics:** R2-05.
- **Size:** 2 h.
- **Depends on:** R2c-15.
- **Migration:** none (`shared-view` is a new kind in `app.records`).
- **Acceptance criteria:**
  1. Members with `share-view` save shared views with a query, board and mode.
  2. A private view can be copied into a shared one, never shared itself.
  3. Shared views refuse private filters and re-apply each viewer's scope and field rules.
  4. Private `saved-view` behaviour is unchanged.
- **Test approach:** `tests/records-postgres.test.ts` (shared-view cases and the unchanged private-view cases), `tests/mcp-candidate-task-tools.test.ts` (saved views unchanged).
- **Docs:** `docs/user-guide.md`.

### R2c-18 Stakeholder home and hiring-manager views

- **Epics:** R2-11, R12-01.
- **Size:** 3 h.
- **Depends on:** R2a-19, R2c-04, R2c-15.
- **Migration:** none.
- **Acceptance criteria:**
  1. Members with the hiring manager or interviewer role land on a simple home screen: their vacancies, candidates on them, interviews and feedback, approvals waiting.
  2. Every list comes from scoped queries.
  3. The screen shows nothing outside scope and no tab for pages the role lacks.
- **Test approach:** `tests/stakeholder-home.test.tsx` (new), `tests/org-scope.test.ts`.
- **Docs:** `docs/user-guide.md`.

### R2c Preview checkpoint

- **Owner steps:** apply the R2c migrations in build order after the R2b ones, rerun the role template, run `scripts/db-role-evidence.ts` and `npm run test:live-roles`, then deploy.
- **Version:** `1.3.0`.
- **What the owner tests on Preview:**
  - copy the fictional Emiratisation workflow template;
  - add a finance approval group with the majority rule;
  - run test mode;
  - publish with an in-flight mapping over fictional applications;
  - check that no rule moves anything to Hired or Rejected;
  - approve as a fictional delegate;
  - build a board with swimlanes by vacancy;
  - share a view;
  - sign in as the fictional hiring manager and use the home screen;
  - check the step list by keyboard.
- **Data:** real candidate and employee data stays out of Preview.

## R2d: Documents, AI and planning

Contents: R2-08 templates, R2-09 AI connections tab, R2-10 recruitment plan, with R12-07.

### R2d-01 Template model and merge-field resolver

- **Epics:** R2-08, R12-07.
- **Size:** 3 h.
- **Depends on:** R2b-08, R2c-02.
- **Migration:** none (templates are `template` configuration objects).
- **Acceptance criteria:**
  1. `src/lib/templates.ts` (new) validates template bodies and the merge syntax of §7.2 against an allowlist without sensitive or source fields.
  2. It resolves merge contexts through the service functions with the requesting user's `scopeFilter` and `redact`.
  3. Hidden fields resolve to nothing and are reported.
  4. Generation is refused when a required field is empty or hidden.
- **Test approach:** `tests/templates.test.ts` (new) including a hidden-amount case.
- **Docs:** `docs/security.md` (template injection).

### R2d-02 Email templates and sending through Resend

- **Epics:** R2-08, R12-07.
- **Size:** 3 h.
- **Depends on:** R2c-03, R2d-01.
- **Migration:** adds `app.outbound_messages` (new, team-keyed under FORCE row-level security, with `merge_field_ids` and the restrictive scope policy of §3.5 keyed by `record_id`). It extends `tenant_context.erase_candidate` to the new table, and extends `tenant_context.erase_employee` to redact recipient addresses equal to the erased employee's work email. Role template: `SELECT, INSERT, UPDATE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. `sendRecordMail` (new, in `src/lib/mail.ts`) sends rendered plain-text and escaped-HTML email through the existing Resend settings, or prints metadata only in local console mode.
  2. It uses the outbox row id as Resend's idempotency key and a reply-to of the sending member.
  3. Recipients come only from the record; subjects have no CR or LF; URL, email and phone values appear as plain text, never as links.
  4. Each team is limited to 200 sends per hour.
  5. Every message is logged with the merge field ids it used and appears on the candidate's timeline. Its subject, body and attachments are shown only to readers who can see every one of those fields. Other readers see the template name, state and time, and the recipient only if they can see the candidate's email. This holds in the UI, REST, MCP, search and exports.
  6. A scoped context reads no message of an out-of-scope record by direct SQL.
  7. Tests never contact Resend.
- **Test approach:** `tests/template-mail.test.ts` (new) with a fake delivery, `tests/field-redaction.test.ts` (new in R2b-08; a hiring manager who cannot see `offer.amount` reads a logged offer email), `tests/mail-hosted.test.ts`, `tests/candidate-erasure.test.ts`, `tests/employee-erasure.test.ts` (new in R2a-15); `scripts/live-role-tests.ts` table and scope cases.
- **Docs:** `docs/security.md` ("Intended connections"), `docs/erasure-runbook.md`, `docs/deployment.md`.

### R2d-03 Template file upload through the CV storage path

- **Epics:** R2-08.
- **Size:** 3 h.
- **Depends on:** R2b-06, R2d-01.
- **Migration:** adds `app.template_files` (new, workspace and team keys, upload reference fields) with ledger and guard rules like `app.uploads`. Role template: `SELECT, INSERT, UPDATE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. DOCX and PDF templates upload through the CV tickets, size cap, digest and ledger.
  2. A DOCX with macros, external relationships, embedded objects or a zip bomb is refused; a PDF with JavaScript, actions or embedded files is refused.
  3. Downloads are attachments only.
- **Test approach:** `npm run test:storage` (new native cases with fictional crafted files), `tests/cv-inline-content.test.ts`; `scripts/live-role-tests.ts` table cases.
- **Docs:** `docs/blob-security-design.md`, `docs/blob-quota-design.md`.

### R2d-04 DOCX placeholder generation

- **Epics:** R2-08.
- **Size:** 2 h.
- **Depends on:** R2d-03.
- **Migration:** none.
- **Acceptance criteria:**
  1. After the owner approves the escalation, `docxtemplater` and `pizzip` are added at exact versions with `npm audit --audit-level=moderate` passing; `angular-expressions` is not in `package-lock.json`.
  2. A small custom parser (delimiters `{{ }}`) resolves only allowlisted dotted paths and maps `{{#if}}` and `{{#unless}}` to sections; a Word template using them renders to DOCX from the merge context, and an unknown path is refused at publish.
  3. A value containing Word XML or a field code appears as literal text.
  4. Rendering runs with network access blocked in the test.
- **Test approach:** `tests/template-render.test.ts` (new) with a fictional template built in the test.
- **Docs:** `docs/security.md`, `docs/validation.md`.

### R2d-05 PDF field placement generation

- **Epics:** R2-08.
- **Size:** 3 h.
- **Depends on:** R2d-03.
- **Migration:** none.
- **Acceptance criteria:**
  1. After the owner approves the escalation, `@pdfme/generator`, `@pdfme/common` and `@pdfme/schemas` are added at exact versions with a repository font.
  2. A PDF template with `placements` renders merged text at the stored coordinates.
  3. Generation succeeds with network access blocked.
  4. The output has no JavaScript or actions.
- **Test approach:** `tests/template-render.test.ts` (new in R2d-04; PDF cases).
- **Docs:** `docs/security.md`, `docs/validation.md`.

### R2d-06 PDF placement editor

- **Epics:** R2-08.
- **Size:** 3 h.
- **Depends on:** R2d-05.
- **Migration:** none.
- **Acceptance criteria:**
  1. After the owner approves the escalation, `pdfjs-dist` is pinned at or above the release that fixed CVE-2024-4367 and draws template pages in the admin editor with scripting and forms disabled and `isEvalSupported: false` set explicitly.
  2. Admins draw a box per merge field or enter page, x, y, width and height in a form (the keyboard alternative).
  3. Placements are saved to the draft.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (new in R2a-11; placement form cases).
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### R2d-07 Template builder

- **Epics:** R2-08.
- **Size:** 3 h.
- **Depends on:** R2d-01, R2d-05.
- **Migration:** none.
- **Acceptance criteria:**
  1. Admins compose blocks (heading, paragraph with merge fields, field table, signature line, conditional block, page break), reordered by drag or by move up and down.
  2. The same blocks render to email text and escaped HTML, to PDF, and, after the owner approves the `docx` escalation, to DOCX.
- **Test approach:** `tests/template-render.test.ts` (new in R2d-04; builder cases), `tests/admin-portal-ui.test.tsx` (new in R2a-11).
- **Docs:** `docs/user-guide.md`.

### R2d-08 Generated documents, preview and approval before sending

- **Epics:** R2-08, R12-07.
- **Size:** 3 h.
- **Depends on:** R2c-04, R2d-02, R2d-04, R2d-05.
- **Migration:** adds `app.generated_documents` (new, team-keyed, upload reference fields, `merge_field_ids`, with the restrictive scope policy of §3.5 keyed by `record_id`) and extends `tenant_context.erase_candidate` to it. Role template: `SELECT, INSERT, UPDATE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. Preview renders for one readable record as an attachment marked "Preview".
  2. Generate stores the document pinned to the template version, with the merge field ids it used.
  3. A document is downloadable only by readers who can see the record and every one of its merge fields; others see only template name, format and times, in the UI, REST, MCP, search and exports.
  4. A template with an approval group creates an approval request, sends on approval and cancels on rejection.
  5. Erasing a candidate removes their generated documents.
  6. A scoped context reads no document row of an out-of-scope record by direct SQL.
- **Test approach:** `tests/templates.test.ts` (new in R2d-01), `tests/field-redaction.test.ts` (new in R2b-08; a hiring manager without `offer.amount` cannot download a generated offer letter), `tests/approvals.test.ts` (new in R2c-04), `tests/candidate-erasure.test.ts`; `scripts/live-role-tests.ts` table and scope cases.
- **Docs:** `docs/erasure-runbook.md`, `docs/user-guide.md`.

### R2d-09 Templates tab

- **Epics:** R2-08, R2-01.
- **Size:** 2 h.
- **Depends on:** R2a-11, R2d-07, R2d-08.
- **Migration:** none.
- **Acceptance criteria:**
  1. Company admins with the `templates` area (and company owners) list, create (upload Word, upload PDF, builder), version, preview and publish templates.
  2. They see each template's merge fields and approval group.
  3. Every publish appears in History.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (new in R2a-11; templates cases).
- **Docs:** `docs/user-guide.md`.

### R2d-10 AI connections tab

- **Epics:** R2-09, R2-01.
- **Size:** 2 h.
- **Depends on:** R2a-09, R2a-11.
- **Migration:** none.
- **Acceptance criteria:**
  1. The tab lists the team's API tokens and OAuth grants with holder, client, scopes, created, last used, expiry and calls per day for 30 days from `mcp-tool` activity.
  2. It shows each connection's tool-call audit and revokes through the existing `revokeToken`.
  3. Owners and admins see all connections, others their own.
  4. No token value or hash is shown.
- **Test approach:** `tests/ai-connections-ui.test.tsx` (new), `tests/api-tokens.test.ts`.
- **Docs:** `docs/mcp.md`, `docs/user-guide.md`.

### R2d-11 Per-connection limits and workspace AI switches

- **Epics:** R2-09.
- **Size:** 3 h.
- **Depends on:** R2d-10.
- **Migration:** adds `auth.api_tokens.limits jsonb` and the `app.workspaces` switches `ai_connections_enabled` and `ai_writes_enabled`; a new `install` body narrows token scopes by the limits and switches; a new `tenant_context.audit_mcp_cv_read` body refuses `noCvText` tokens; recreates the `app.activity` insert policy for `token.limits_changed`. Role template: unchanged grants, re-issued for the replaced functions. Marker: +1.
- **Acceptance criteria:**
  1. A `readOnly` connection cannot run any create or change tool, and a direct write under its context is refused by the database.
  2. A `noCvText` connection cannot read CV text even with the team setting on.
  3. AI connections off refuses OAuth access tokens and MCP calls.
  4. AI writes off removes write scopes for AI connections.
  5. Only a company owner changes the two switches; a team owner without company authority is refused by the service and by the policy.
  6. Limits record who set them; anyone may tighten a limit, only the setter's level or higher may relax it, so a holder cannot clear a `readOnly` that an owner set.
  7. Limit changes are audited.
- **Test approach:** `tests/mcp-endpoint.test.ts`, `tests/mcp-cv-tools.test.ts`, `tests/mcp-oauth.test.ts`, `tests/tenant-context.test.ts`; `scripts/live-role-tests.ts` limit and team-B-owner-switch cases.
- **Docs:** `docs/mcp.md`, `docs/identity-boundary-plan.md`.

### R2d-12 Recruitment plan model

- **Epics:** R2-10.
- **Size:** 3 h.
- **Depends on:** R2a-10, R2a-13.
- **Migration:** adds `app.plans`, `app.plan_versions` and `app.plan_lines` (new) and the helper `tenant_context.allows_plan(uuid, text)` (new), which reads `plan_access` (derived from `app.workspace_admins` since R2a-02) and the scopes from the context. Role template: `SELECT, INSERT, UPDATE` on the three tables and `EXECUTE` on the helper for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. `src/lib/plans.ts` (new) and routes under `/api/v1/plans` (new) hold multi-year plans by org unit with yearly or quarterly lines, headcount and cost in AED fils.
  2. Approved versions are immutable.
  3. A context without `plans:read` and a plan-access grant reads no plan row. This holds for a team owner, a company admin and a company owner who has not granted themselves access, by the service and by direct SQL.
  4. Plan figures appear in no search, notification, activity metadata or MCP result.
- **Test approach:** `tests/plans.test.ts` (new); `tests/openapi-contract.test.ts`; `scripts/live-role-tests.ts` plan-confidentiality cases, including a team-B owner.
- **Docs:** `docs/security.md`, `docs/api-examples.md`, `docs/identity-boundary-plan.md`.

### R2d-13 Plan editor, versions and approval

- **Epics:** R2-10.
- **Size:** 3 h.
- **Depends on:** R2c-04, R2d-12.
- **Migration:** none.
- **Acceptance criteria:**
  1. Members with plan access edit draft scenario versions in a year-by-unit grid with quarters optional.
  2. Submitting creates an approval request for the configured approvers; approval makes the version the plan of record and supersedes the previous one.
  3. The Recruitment plan settings tab sets granularity and approvers. Approvers can be changed only by a company owner (the approver-membership rule of R2c-06), and only people who already hold plan access can be named.
  4. Being a plan approver grants no plan access: `allows_plan` ignores approval membership. A plan approval request whose group resolves to any member without plan access is refused when it would open.
  5. Every state change is audited without figures.
- **Test approach:** `tests/plans.test.ts` (new in R2d-12), `tests/approvals.test.ts` (new in R2c-04; a plan-access holder who is not a company owner cannot extend access by naming an approver), `tests/plan-ui.test.tsx` (new).
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### R2d-14 Plan versus actual

- **Epics:** R2-10, R2-11.
- **Size:** 3 h.
- **Depends on:** R2c-01, R2c-18, R2d-12.
- **Migration:** adds `offer_amount_visible` to `tenant_context.contexts`, filled by a new `install` body from the caller's role field rule for `offer.amount`. It also adds the owner-owned `SECURITY DEFINER` aggregate helper `tenant_context.plan_actuals(uuid, uuid, int, int)` (new, `SET search_path = pg_catalog, pg_temp`, PUBLIC `EXECUTE` revoked), the only path that reads team records across the workspace's teams. Role template: `EXECUTE` on the helper for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. For a unit and below, a year or quarter and the approved version, the plan screen shows planned headcount and cost against open vacancies, offers, observed hires and accepted-offer spend in AED (§9.3), all from `tenant_context.plan_actuals`.
  2. The helper refuses a context without plan access and `plans:read`, returns only aggregates (no record id, name, single-record date or per-team breakdown), and works for units of the context's workspace only.
  3. Spend is left out when the caller's role hides `offer.amount`, and is suppressed with "fewer than 5 offers" for a cell built from fewer than 5 accepted offers.
  4. Suppression is complementary: a unit's direct offers form their own cell; a parent's spend is shown only when every child cell (including the direct cell) is shown, and a year's only when every quarter is shown. A test fixture where parent minus children, or year minus quarters, would isolate one offer shows no spend for that parent or year.
  5. Offers in other currencies or hourly pay are left out and counted.
  6. Imported hires without an observed event are not counted.
  7. The stakeholder home shows the member's part of the plan only with plan access.
- **Test approach:** `tests/plans.test.ts` (new in R2d-12; actuals on the fictional fixture, a one-offer cell, a hidden-amount role), `tests/stakeholder-home.test.tsx` (new in R2c-18); `scripts/live-role-tests.ts` cases: helper denied without plan access; no team's rows readable directly across teams.
- **Docs:** `docs/user-guide.md`.

### R2d-15 Release 2 security review and version 2.0.0

- **Epics:** all Release 2 epics.
- **Size:** 2 h.
- **Depends on:** R2d-01 to R2d-14.
- **Migration:** none.
- **Acceptance criteria:**
  1. `docs/security.md` and `docs/identity-boundary-plan.md` describe the final Release 2 boundary.
  2. The proposed SRS §10.1 additions (threats T-R2-1 to T-R2-16 of architecture §11.7) are written into `docs/requirements/register.md` for owner review.
  3. `package.json` and `package-lock.json` say `2.0.0`.
  4. The full validation set and `npm audit --audit-level=moderate` pass.
  5. `npm run bench:round-trips -- --fixture` results are recorded in `docs/validation.md` with the counts of architecture §12.
- **Test approach:** the full suite, the benchmark and `scripts/live-role-tests.ts` on a throwaway cluster and pooler.
- **Docs:** `docs/security.md`, `docs/identity-boundary-plan.md`, `docs/validation.md`, `docs/deployment.md`, `docs/ROADMAP.md`.

### R2d Preview checkpoint

- **Owner steps:** apply the R2d migrations in build order after the R2c ones, rerun the role template, run `scripts/db-role-evidence.ts` and `npm run test:live-roles`, set nothing new for Resend beyond the existing sender, then deploy.
- **Version:** `2.0.0`, Release 2 complete; Production later launches Releases 1 and 2 together after the go-live gate.
- **What the owner tests on Preview:**
  - upload a fictional Word offer letter and a fictional PDF form, place fields and build an email template;
  - preview, generate and send to the owner's own test inbox only, with approval before an offer letter goes out;
  - check that the hidden amount never appears for the hiring manager, including in the logged offer email and the generated letter;
  - use the AI connections tab: limits, read-only, no CV text, the switches and revoke, with Claude or ChatGPT on Preview;
  - build a fictional ten-year plan by division in AED, approve a version and compare plan with actual;
  - confirm plan figures are hidden from anyone without a plan-access grant, including the owner of a second fictional team;
  - confirm a plan cell with fewer than 5 accepted offers shows no spend.
- **Data:** real candidate, employee and plan data stays out of Preview.
