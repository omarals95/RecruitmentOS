# Release 2 build plan

_Design only (R2-00, job 041), 8 November 2026. The owner reviews this plan and [architecture.md](architecture.md), and decides its open decisions (section 13), before any item is added to the factory backlog or queued._

_Rewritten from R2b onwards on 10 November 2026 (R2-ADM-00, job 065): R2a and R2b-01 are done, and everything not yet built is now the Admin portal plan below, milestones M1 to M13 in the owner's MVP order, with the reconciled R2b to R2d items and the new `ADM-` items. The rules for every item are unchanged._

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

**Status: done.** R2a-01 to R2a-21 are built and merged in jobs 042 to 064 (job 050 built R2b-01, and job 063 the scoped-member speed item R2-PERF-01, both done too). The R2a Preview checkpoint below is the owner's next step.

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

Contents: R2-02 screen and field builder, R2-03 categories and types. R2b-01 is done (job 050); R2b-02 to R2b-12 moved into milestone M5 of the Admin portal plan below.

### R2b-01 Built-in defaults compiled from code

- **Status:** done (job 050).
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

## Admin portal plan (from 10 November 2026)

_R2-ADM-00, job 065. The owner approved the Admin portal mockups on 10 November 2026 with three changes (an org tree, job architecture, and no right-to-left or Arabic). The design is [architecture.md §14](architecture.md#14-admin-portal-one-stop-administration); the reference material and its scope are in [docs/admin-platform/README.md](../admin-platform/README.md)._

Everything not yet built is planned here as milestones M1 to M13. Each item follows the rules at the top of this file and the item format of R2a, with two more lines: **Spec IDs** (the spec-pack or ORG IDs it delivers, or "none") and **Mockup** (the route in `docs/admin-platform/mockups/` it builds, or "none"). New items are numbered `ADM-01` onwards in plan order; in the factory backlog they are `R2-ADM-NN`. An unbuilt earlier item keeps its ID and its work; a **Reconciliation** line in the item says what changed. Open decisions D18 to D35 are in [architecture.md §13.1](architecture.md#131-open-decisions-for-the-owner); the owner decides them before the items that depend on them are queued.

**The MVP order.** The first ten milestones follow the owner's MVP order for the Admin portal:

1. M1: Admin shell and Teams move.
2. M2: Users and groups.
3. M3: Roles and permissions views.
4. M4: Org tree and job architecture.
5. M5: Fields and screens.
6. M6: Workflows.
7. M7: Look and feel and domain.
8. M8: Notifications and mail.
9. M9: Integrations.
10. M10: Health and audit.

**The rest, after its dependencies.**

- **Templates:** R2d-01 (the template model) and R2d-02 (email through Resend) move into M8, because notification emails need them. R2d-03 to R2d-09 (document templates, the builder and the Templates page) form M12, after M8 (R2d-02) and M6 (approvals).
- **Boards, shared views and the stakeholder home** (R2c-15 to R2c-18) form M11. They depend only on M6 and R2a, so the owner may move M11 to straight after M6 without changing any dependency.
- **The recruitment plan** (R2d-12 to R2d-14) forms M13, after M4 (Plan & pay access and `tenant_context.allows_plan`), M6 (approvals) and M11 (the stakeholder home).
- **The Release 2 security review and version 2.0.0** (R2d-15) is the last item of the plan.

Each milestone ends with a Preview checkpoint the owner runs. Version numbers follow D3's rule (the minor number per Preview drop, `2.0.0` when Release 2 is complete), with the mapping of decision D28.

### Earlier items and where they went

Every unbuilt earlier item is kept with its ID and its work; none is dropped or merged, and no earlier ID is reused for different work.

| Item   | Where it went | Fate                                                                                                            |
| ------ | ------------- | --------------------------------------------------------------------------------------------------------------- |
| R2b-02 | M5            | Kept                                                                                                            |
| R2b-03 | M5            | Kept                                                                                                            |
| R2b-04 | M5            | Kept                                                                                                            |
| R2b-05 | M5            | Kept                                                                                                            |
| R2b-06 | M5            | Kept                                                                                                            |
| R2b-07 | M5            | Kept                                                                                                            |
| R2b-08 | M5            | Kept                                                                                                            |
| R2b-09 | M5            | Changed: the central Fields page; contexts, options and Where used are ADM-29                                   |
| R2b-10 | M5            | Changed: the screen designer of the Screens page; the screen list, schemes view, copy and archive are ADM-30    |
| R2b-11 | M5            | Kept; the types list lives on the Fields page                                                                   |
| R2b-12 | M5            | Kept                                                                                                            |
| R2c-01 | M6            | Kept                                                                                                            |
| R2c-02 | M6            | Kept                                                                                                            |
| R2c-03 | M6            | Kept; the outbox also delivers notifications (M8)                                                               |
| R2c-04 | M6            | Changed: approval steps name flagged company groups (M2); adds the Groups page's approval settings              |
| R2c-05 | M6            | Kept                                                                                                            |
| R2c-06 | M6            | Changed: the owner-only publish rule applies to changed group references                                        |
| R2c-07 | M6            | Kept                                                                                                            |
| R2c-08 | M6            | Kept                                                                                                            |
| R2c-09 | M6            | Changed: the designer's step-list editor on the Workflows page; the list, schemes and statuses tabs are ADM-34  |
| R2c-10 | M6            | Kept, as the designer's canvas                                                                                  |
| R2c-11 | M6            | Kept; the binding shows as workflow schemes                                                                     |
| R2c-12 | M6            | Kept                                                                                                            |
| R2c-13 | M6            | Kept; its group is the default for out-of-bracket offers (D24, ADM-35)                                          |
| R2c-14 | M6            | Kept; events have no recipient until webhooks (D31)                                                             |
| R2c-15 | M11           | Kept                                                                                                            |
| R2c-16 | M11           | Changed: the Boards page `/app/admin/boards`                                                                    |
| R2c-17 | M11           | Kept                                                                                                            |
| R2c-18 | M11           | Kept; also holds My approvals (NTF-054)                                                                         |
| R2d-01 | M8            | Changed: moved before the other template items; the resolver also serves notification emails                    |
| R2d-02 | M8            | Changed: moved into M8; `sendRecordMail` also sends notification emails and honours the Preview capture address |
| R2d-03 | M12           | Kept                                                                                                            |
| R2d-04 | M12           | Kept                                                                                                            |
| R2d-05 | M12           | Kept                                                                                                            |
| R2d-06 | M12           | Kept                                                                                                            |
| R2d-07 | M12           | Changed: the builder also edits notification email bodies                                                       |
| R2d-08 | M12           | Kept                                                                                                            |
| R2d-09 | M12           | Changed: the Templates page `/app/admin/templates` in the Configuration group                                   |
| R2d-10 | M9            | Changed: the Team connections tab of the Integrations page                                                      |
| R2d-11 | M9            | Kept; the switches sit on the Integrations page's company tab                                                   |
| R2d-12 | M13           | Changed: `tenant_context.allows_plan` already exists from ADM-25                                                |
| R2d-13 | M13           | Kept                                                                                                            |
| R2d-14 | M13           | Kept                                                                                                            |
| R2d-15 | M13           | Changed: depends on every earlier item, covers T-R2-17 to T-R2-32, and ships `2.0.0` (D28)                      |

### Coverage of the approved screens

One row per mockup page (the 19 ids of `PAGE_FILES` in `docs/admin-platform/mockups/index.html`), per visible sub-view, and per page of the target sitemap that the mockups do not show.

| Screen or sub-view                      | Mockup route                                  | Built by                                                                                                   |
| --------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Admin home (`home`)                     | `#/home`                                      | ADM-01; admin search ADM-61                                                                                |
| Users (`users`)                         | `#/users`                                     | ADM-07, ADM-08, ADM-09, ADM-10, ADM-15; Effective access ADM-21; Tokens ADM-52                             |
| Groups (`groups`)                       | `#/groups`                                    | ADM-11, ADM-12, ADM-13, ADM-14; approval settings R2c-04                                                   |
| Teams (`teams`)                         | `#/teams`                                     | ADM-02, ADM-03, ADM-04, ADM-05; Roles in this team ADM-18; colour and icon ADM-39; Mail log ADM-48, ADM-50 |
| Company authority (`company-authority`) | `#/company-authority`                         | Built as a panel in R2a-12; its own page ADM-16                                                            |
| Roles (`roles`)                         | `#/roles`                                     | Built in R2a-12; holders, copy, archive and defaults ADM-17                                                |
| Permissions (`permissions`)             | `#/permissions`                               | ADM-18, ADM-19                                                                                             |
| Permission helper (`permission-helper`) | `#/permission-helper`                         | ADM-20, ADM-21                                                                                             |
| Organisation (`organisation`)           | `#/organisation`                              | Built in R2a-13, R2a-16, R2a-17; ADM-22 to ADM-28                                                          |
| Fields (`fields`)                       | `#/fields`                                    | R2b-09, ADM-29, ADM-31, R2b-11                                                                             |
| Screens (`screens`)                     | `#/screens`                                   | R2b-07, R2b-10, ADM-30                                                                                     |
| Workflows (`workflows`)                 | `#/workflows`                                 | ADM-34, R2c-09, R2c-10, R2c-11, ADM-32, ADM-33                                                             |
| Branding (`branding`)                   | `#/branding`                                  | ADM-36, ADM-37, ADM-38, ADM-39                                                                             |
| Domain (`domain`)                       | `#/domain`                                    | ADM-40, ADM-41                                                                                             |
| Notifications (`notifications`)         | `#/notifications`                             | ADM-42, ADM-44, ADM-45, ADM-46, ADM-50; bell ADM-43                                                        |
| Mail (`mail`)                           | `#/mail`                                      | ADM-48, ADM-49; SMTP ADM-51 (D25)                                                                          |
| Integrations (`integrations`)           | `#/integrations`                              | R2d-10, ADM-52, R2d-11                                                                                     |
| Health (`health`)                       | `#/health`                                    | ADM-53, ADM-54, ADM-55, ADM-56; Linux mode ADM-57 (D25)                                                    |
| Audit (`audit`)                         | `#/audit`                                     | ADM-58, ADM-59, ADM-60                                                                                     |
| Org tree by units                       | `#/organisation?tab=chart`                    | ADM-22                                                                                                     |
| Org tree by people                      | `#/organisation?tab=chart`                    | ADM-23                                                                                                     |
| Job architecture tab                    | `#/organisation?tab=jobs`                     | ADM-24, ADM-25, ADM-26, ADM-27                                                                             |
| Org import preview                      | `#/organisation?tab=import`                   | Built in R2a-17; Job title and Grade columns ADM-28                                                        |
| Workflow designer                       | `#/workflows` (designer)                      | R2c-09 (step list), R2c-10 (canvas), R2c-06 (problems), R2c-08 (test), R2c-07 (migration), ADM-32          |
| Field contexts                          | `#/fields` (field detail, Contexts & options) | ADM-29                                                                                                     |
| Field wizard                            | `#/fields` (create wizard)                    | R2b-09                                                                                                     |
| Screen schemes                          | `#/screens?tab=schemes`                       | ADM-30                                                                                                     |
| Screens publish                         | `#/screens` (designer, publish)               | R2b-10 (publish checks), ADM-30 (publish summary)                                                          |
| Roles publish, refusal and empty states | `#/roles`                                     | Built in R2a-12; the approved copy and states ADM-17                                                       |
| Permission helper refused state         | `#/permission-helper`                         | ADM-21                                                                                                     |
| Directory (sitemap, not a mockup page)  | none (Organisation > Directory tab)           | Built in R2a-14, R2a-15, R2a-16                                                                            |
| Sign-in and security policy (sitemap)   | none                                          | Deferred by D29; two-step for company authority ADM-16, re-authentication ADM-06                           |
| Boards (sitemap)                        | none                                          | R2c-15, R2c-16                                                                                             |
| Templates (sitemap)                     | none                                          | R2d-01, R2d-03 to R2d-09; notification templates ADM-46                                                    |
| Configuration transfer (sitemap)        | none                                          | Deferred by D29                                                                                            |

## M1: Admin shell and Teams move

Contents: the sidebar shell and Admin home, and Team & access and the team tabs moving into Admin > Teams (architecture §14.1, §14.2). MVP order 1.

### ADM-01 Admin sidebar shell and Admin home

- **Epics:** R2-01.
- **Spec IDs:** UI-001, UI-003, UI-010, UI-011, PRM-011, PRM-012, IMP-004, TST-002.
- **Mockup:** `#/home` (`pages/home.js`) and the shell in `app.js`.
- **Size:** 3 h.
- **Depends on:** R2a-11, R2a-12, R2a-16, R2a-21.
- **Migration:** none.
- **Acceptance criteria:**
  1. `/app/admin` shows the Admin home: one card for each admin page the caller can open, and no card for a page that does not exist yet.
  2. A sidebar replaces the tab row, with the groups of §14.1. It lists today's pages (Organisation, Directory, Roles & permissions, History and the team tabs) in their groups and hides a group with no page the caller can open.
  3. The page table keeps one level per page and `adminTabs()`'s rule: a test over every combination of team role, company level, areas and directory action shows that a team role never yields a company page and company authority never yields a team page.
  4. A new route test lists every page under `src/app/app/admin` and checks that it is in the page table and that its server component checks access through `authorize()` before rendering; a page missing from the table fails the test.
  5. Every admin page answers an anonymous caller, a team role only, a company admin without and with the area, a company owner and a token as §14.1 says.
  6. The shell works by keyboard, at 1280, 768 and 360 px and in the dark theme.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (extended), `tests/admin-routes.test.ts` (new); keyboard, width and dark checks recorded in `docs/accessibility-checklist.md`.
- **Docs:** `docs/user-guide.md` (Admin portal), `docs/accessibility-checklist.md`.

### ADM-02 Teams list and Create team

- **Epics:** R2-01.
- **Spec IDs:** IAM-053, DOM-004, TST-005.
- **Mockup:** `#/teams` (the list).
- **Size:** 3 h.
- **Depends on:** ADM-01.
- **Migration:** adds the owner-run read helper `tenant_context.workspace_team_list()` (new, `SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`). It returns each team's id, name, slug and created date in the context's workspace, to company owners and admins only, and refuses every other context with `42501`. Role template: `EXECUTE` for `recruitmentos_data`; `src/db/connection-boundary.ts` lists it. Marker: +1.
- **Acceptance criteria:**
  1. `/app/admin/teams` lists the teams where the caller is owner or admin, each linking to its detail page.
  2. A company owner or admin also sees every other team of the workspace by name, slug and created date, marked "Not a member", with no link into its data. No member names or counts, record counts, storage figures or activity of such a team appear in the page, its API response or the helper's result.
  3. The helper refuses a team owner without company authority and returns no team of another workspace (two workspaces inserted by the owner in the test).
  4. **Create team** follows `canCreateTeam` as today; the new team is listed, and its creator gets no company authority.
  5. A recruiter or viewer without company authority gets 403.
- **Test approach:** `tests/admin-teams.test.ts` (new, PGlite with split roles), `tests/admin-portal-ui.test.tsx`, `tests/runtime-role-grants.test.ts`, `tests/connection-boundary.test.ts`; `scripts/live-role-tests.ts` gains a team-B owner calling the helper.
- **Docs:** `docs/user-guide.md`, `docs/identity-boundary-plan.md`.

### ADM-03 Team detail: Members and Settings

- **Epics:** R2-01.
- **Spec IDs:** IAM-053, IAM-070, IAM-071.
- **Mockup:** `#/teams` (team detail, Overview and Members tabs).
- **Size:** 3 h.
- **Depends on:** ADM-02.
- **Migration:** none.
- **Acceptance criteria:**
  1. `/app/admin/teams/[team]` opens only for an owner or admin of that team. A company owner who is not a member sees "You are not a member of this team" and no team data; anyone else gets 403.
  2. **Members** holds invitations, the member list, team role changes, the configured role column (company owners), **Reset two-step sign-in** (team owners) and **Remove member**, with the same API calls, refusals and messages as Team & access today.
  3. **Settings** renames the team.
  4. Both tabs work by keyboard, at 360 px and in the dark theme.
- **Test approach:** `tests/settings-ui.test.tsx` (cases moved with the screens), `tests/admin-portal-ui.test.tsx`, `tests/auth-flows.test.ts` unchanged.
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### ADM-04 Team detail: CV storage, Speed, Task boards and Activity; redirects; personal settings

- **Epics:** R2-01.
- **Spec IDs:** IAM-053, IMP-001, AUD-004.
- **Mockup:** `#/teams` (CV storage, Speed and Task boards tabs).
- **Size:** 3 h.
- **Depends on:** ADM-03.
- **Migration:** none.
- **Acceptance criteria:**
  1. The team detail page gains **CV storage**, **Speed** (D33), **Task boards** and **Activity** tabs, rendering today's storage, speed and task-board screens and the team's activity list with unchanged behaviour.
  2. `/app/admin/members`, `/app/admin/cv-storage`, `/app/admin/speed`, `/app/admin/task-boards`, `/app/settings/team` and `/app/settings/speed` redirect to the matching tab of the current team's detail page (IMP-001); bookmarks keep working.
  3. Personal settings show **My profile** (with two-step and devices), **API tokens** (D18) and **About**; Team & access and Speed are gone from them. The Admin portal link shows for anyone who can open an admin page, company admins included.
  4. The old team tab keys leave the sidebar.
- **Test approach:** `tests/settings-ui.test.tsx`, `tests/admin-portal-ui.test.tsx`, `tests/admin-redirects.test.ts` (new).
- **Docs:** `docs/user-guide.md` (Team and account settings, Admin portal), `docs/accessibility-checklist.md`.

### ADM-05 Team archive and restore

- **Epics:** R2-01.
- **Spec IDs:** DOM-005.
- **Mockup:** `#/teams` (Danger zone).
- **Size:** 3 h.
- **Depends on:** ADM-04.
- **Migration:** adds `archived_at` and `archived_by` to `app.workspace_teams`; the owner-run helper `tenant_context.set_team_archived(team_id text, archived boolean)` (new), callable only from a session context of an owner of that team; a new `tenant_context.install` body that stores only read scopes for a context of an archived team and returns `teamArchived`; `tenant_context.workspace_team_list()` also returns the archived state; an owner-only `team-archive` branch in the `app.activity` insert policy. Role template: `EXECUTE` on the helper for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. A team owner archives the team after typing its name; members still read everything, and every write (REST, MCP, bulk, uploads, task boards) is refused with 403 `team_archived`. A direct write by the data role under that team's context is refused by the database.
  2. A team owner restores it, and writes work again.
  3. A team admin, a member and a company owner who is not that team's owner are refused, by the service and by calling the helper directly.
  4. The team switcher and the Teams list show the team as Archived. Nothing is deleted.
  5. Each change writes one audit row.
  6. `tests/round-trip-budget.test.ts` still counts 6, 11 and 15.
- **Test approach:** `tests/team-archive.test.ts` (new), `tests/tenant-context.test.ts`, `tests/round-trip-budget.test.ts`, `tests/runtime-role-grants.test.ts`; `scripts/live-role-tests.ts` archived-team write-denied case, directly and through the pooler.
- **Docs:** `docs/user-guide.md`, `docs/identity-boundary-plan.md`.

### M1 Preview checkpoint

- **Owner steps:** apply the M1 migrations in build order after the R2a ones, rerun the role template (`infrastructure/postgres-split-runtime-roles.sql`), run `scripts/db-role-evidence.ts` (zero drift) and `npm run test:live-roles` directly and through the pooler, then deploy with the CLI deploy script.
- **Version:** `1.2.0` (decision D28).
- **What the owner tests on Preview:**
  - the Admin home and sidebar show only the pages you can open;
  - as company owner, the Teams list shows a second fictional team by name only, with no members or figures;
  - the team detail tabs behave like Team & access, CV storage, Speed and Task boards did;
  - old bookmarks (`/app/settings/team`, `/app/admin/members`) land on the new pages;
  - personal settings show only My profile, API tokens and About;
  - archive a fictional team, check that nothing can be changed in it, then restore it.
- **Data:** real candidate and employee data stays out of Preview; only fictional data is used.

## M2: Users and groups

Contents: re-authentication, the Users page, company-level deactivation and anonymisation, and company groups with nesting, role grants and delegated managers (architecture §14.3, §14.14). MVP order 2.

### ADM-06 Re-authentication for sensitive admin changes

- **Epics:** R2-13.
- **Spec IDs:** IAM-035, UI-004, PRM-013.
- **Mockup:** none.
- **Size:** 2 h.
- **Depends on:** ADM-01.
- **Migration:** none.
- **Acceptance criteria:**
  1. A shared server check (new, in `src/lib/`) refuses with 403 `SESSION_NOT_FRESH` when the session is older than Better Auth's `freshAge`. It guards role publish and assignment, company authority changes and two-step resets now, and every later item that names it.
  2. These routes stay session only; a token is refused as today.
  3. On `SESSION_NOT_FRESH` the page asks for the password and two-step code in a dialog, keeps the form's state, and retries the change once.
  4. Viewing any admin page never asks.
- **Test approach:** `tests/fresh-session.test.ts` (new), `tests/admin-portal-ui.test.tsx` (the dialog keeps the form's state).
- **Docs:** `docs/authentication.md`, `docs/user-guide.md`.

### ADM-07 Users list and the people area

- **Epics:** R2-13.
- **Spec IDs:** IAM-005, IAM-006.
- **Mockup:** `#/users` (the list).
- **Size:** 3 h.
- **Depends on:** ADM-06.
- **Migration:** extends the area check of `app.workspace_admins` and the body of `tenant_context.set_workspace_authority` with `people` (new grantable area); adds the owner-run read helper `tenant_context.workspace_people(...)` (new; filters and a page of 25), which returns user id, name, email, team names with team role and configured role name, company level, status, last sign-in and the two-step flag to company owners and to company admins with `people`, and refuses every other context with `42501`. Role template: `EXECUTE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. `GRANTABLE_ADMIN_AREAS` gains `people`, and Company authority offers it.
  2. `/app/admin/users` lists the people of every team of the workspace with those columns, 25 at a time with **Show more**, filtered by team, status, company level and configured role.
  3. The helper returns no record, candidate, upload, storage or token data, and nobody outside the workspace.
  4. A company admin without `people`, a team owner without company authority and a token are refused by the route and by the helper.
- **Test approach:** `tests/admin-users.test.ts` (new, PGlite), `tests/workspace-tenancy.test.ts` (the area check), `tests/runtime-role-grants.test.ts`; `scripts/live-role-tests.ts` helper-denied cases.
- **Docs:** `docs/user-guide.md`, `docs/identity-boundary-plan.md`.

### ADM-08 User detail and invitations to several teams

- **Epics:** R2-13.
- **Spec IDs:** IAM-005, IAM-072, IAM-090.
- **Mockup:** `#/users` (user detail tabs and Invite).
- **Size:** 3 h.
- **Depends on:** ADM-03, ADM-07.
- **Migration:** none.
- **Acceptance criteria:**
  1. `/app/admin/users/[user]` shows **Profile**, **Teams & roles**, **Company authority** (read, with a link to its page), **Security** (two-step state, signed-in devices count, and **Reset two-step sign-in** for teams where the caller is team owner) and **Activity** (the person's configuration and access-change events).
  2. **Invite to teams** offers only teams where the caller is owner or admin, with a team role for each, and sends one Better Auth invitation per team; the server refuses any other team.
  3. Company owners and admins with `people` open the page; nobody else does.
- **Test approach:** `tests/admin-users.test.ts` (new in ADM-07), `tests/auth-flows.test.ts` (several-team invitation cases).
- **Docs:** `docs/user-guide.md`.

### ADM-09 Company-level deactivate, sign out everywhere and clear lockout

- **Epics:** R2-13.
- **Spec IDs:** IAM-001, IAM-002, TST-003.
- **Mockup:** `#/users` (Security tab and bulk actions).
- **Size:** 3 h.
- **Depends on:** ADM-08.
- **Migration:** adds `app.workspace_users` (new; `workspace_id`, `user_id`, `deactivated_at`, `deactivated_by`) under FORCE row-level security, readable by company owners and admins, with no runtime write grant; the owner-run helper `tenant_context.set_user_active(user_id text, active boolean)` (new), which refuses the last company owner, lets only a company owner change a person with company authority, lets a company admin with `people` change others, and writes a `user.deactivated` or `user.reactivated` row through an owner-only insert branch; a new `tenant_context.install` body that refuses a context for a deactivated user with `42501`. Role template: `SELECT` on the table and `EXECUTE` on the helper for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. A deactivated person cannot sign in, and every existing session and API token of theirs is refused by `install`, including by direct SQL under a context signed before the change.
  2. Memberships, assignments and history stay; reactivating restores access.
  3. The rules on who may deactivate whom hold in the service and in the helper; the last company owner is refused.
  4. **Sign out everywhere** revokes all of the person's sessions; **Clear lockout** resets their sign-in backoff.
  5. Every change needs a fresh session (ADM-06) and writes one audit row.
  6. `tests/round-trip-budget.test.ts` still counts 6, 11 and 15.
- **Test approach:** `tests/user-deactivation.test.ts` (new), `tests/tenant-context.test.ts`, `tests/round-trip-budget.test.ts`, `tests/auth-flows.test.ts`; `scripts/live-role-tests.ts` deactivated-context case.
- **Docs:** `docs/authentication.md`, `docs/identity-boundary-plan.md`, `docs/user-guide.md`.

### ADM-10 User account anonymisation

- **Epics:** R2-13.
- **Spec IDs:** IAM-003.
- **Mockup:** `#/users` (user detail, remove user).
- **Size:** 3 h.
- **Depends on:** ADM-09.
- **Migration:** adds the owner-only tombstone table `app.user_anonymisations` (new) and the owner-run helper `tenant_context.anonymise_user(user_id text, confirm_name text, erasure_source text)` (new), with owner-only policies like `drizzle/0036_employee_erasure.sql`. Role template: `EXECUTE` on the helper for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. A company owner anonymises a fictional person after typing their name. Memberships, sessions, tokens, OAuth grants, two-step secrets, configured roles and record assignments are removed; the name and email become a placeholder; activity about the person is redacted to type, time and an actor placeholder; a tombstone is written.
  2. A retry returns the earlier result.
  3. The last owner of a team and the last company owner are refused until the role passes on; anyone but a company owner is refused, by the service and by the helper.
  4. It needs a fresh session (ADM-06).
- **Test approach:** `tests/user-anonymisation.test.ts` (new), `tests/employee-erasure.test.ts` unchanged; `scripts/live-role-tests.ts` owner-only cases.
- **Docs:** `docs/erasure-runbook.md` (new "Anonymise a user account" section), `docs/identity-boundary-plan.md`, `docs/user-guide.md`.

### ADM-11 Company groups: tables, nesting and effective membership

- **Epics:** R2-13.
- **Spec IDs:** IAM-040, IAM-041, IAM-045, PRM-023, TST-003.
- **Mockup:** none.
- **Size:** 3 h.
- **Depends on:** ADM-07, ADM-10.
- **Migration:** adds `app.groups`, `app.group_members`, `app.group_managers` and `app.group_effective_members` (new, company level, FORCE row-level security); the owner-owned trigger function `app.maintain_group_members()` (new), which refuses a cycle or a depth over 3 (D19) and rebuilds the affected effective rows; the helper `tenant_context.group_grants(group_id uuid)` (new), true when the group or any group it is nested in is flagged as an approval group; write policies that require a company owner when `group_grants` is true, and otherwise a company owner or a company admin with `people`; the read helper for computed groups `tenant_context.computed_group_members(text)` (new); an owner-only `group` branch in the `app.activity` insert policy; and a new `tenant_context.anonymise_user` body that also removes the person's group rows. Role template: `SELECT, INSERT, UPDATE, DELETE` on `app.groups`, `app.group_members` and `app.group_managers`, `SELECT` only on `app.group_effective_members`, and `EXECUTE` on the helpers for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. A new service `src/lib/groups.ts` (new) creates, renames and archives groups and adds and removes users and child groups.
  2. A cycle and a fourth nesting level are refused.
  3. Effective membership is right after every change on a fictional fixture of 200 groups, and neither runtime role can write `app.group_effective_members`.
  4. **Group membership that grants an approval is company owner only, enforced in the database:** for a group flagged as an approval group (set by the owner in the test), or nested under one, a company admin with `people` cannot add or remove a member or child group, clear the flag or archive the group, by the service or by direct SQL as the data role (`42501`); a company owner can.
  5. Computed groups (Company owners, Company admins, All members, Owners and Admins of each team) are correct and read-only.
  6. Every change writes one audit row with ids only.
- **Test approach:** `tests/groups.test.ts` (new, PGlite with split roles), `tests/runtime-role-grants.test.ts`; `scripts/live-role-tests.ts` cases: a company admin adding to an approval group by direct SQL is refused, and a direct insert into `app.group_effective_members` is refused.
- **Docs:** `docs/identity-boundary-plan.md` (new "Company groups" part), `docs/security.md`.

### ADM-12 Groups page: list, detail, members and member of

- **Epics:** R2-13.
- **Spec IDs:** IAM-042, IAM-043, IAM-045, IAM-054.
- **Mockup:** `#/groups` (list and detail).
- **Size:** 3 h.
- **Depends on:** ADM-11.
- **Migration:** none.
- **Acceptance criteria:**
  1. `/app/admin/groups` lists groups with members, nesting and status, and shows "Groups decide who; teams hold the data."
  2. The detail page has **Members** (nested groups as a tree), **Member of** and **Audit**; adding and removing users and child groups shows the cycle and depth refusals in plain words.
  3. Renaming changes nothing that refers to the group.
  4. Computed groups are read-only and say why.
  5. The Users list gains a group filter, and the user detail page a **Groups** tab.
  6. No approval setting is shown yet: R2c-04 adds it with approvals.
  7. Changes to a group that grants something need a fresh session (ADM-06).
  8. Everything works by keyboard, at 360 px and in the dark theme.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (groups cases), `tests/groups.test.ts` (new in ADM-11).
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### ADM-13 Where used, archive with replacement and delegated managers

- **Epics:** R2-13.
- **Spec IDs:** IAM-042, IAM-043, IAM-044, DOM-030.
- **Mockup:** `#/groups` (Where used, delete with impact).
- **Size:** 2 h.
- **Depends on:** ADM-12.
- **Migration:** `0056_group_managers.sql` (job 101, reworking reverted job 099, marker 34). `app.group_managers` came with ADM-11, but its policies and the guard admitted only a company owner or a company admin with `people`, so a delegated manager without company authority needed the manager policies, `tenant_context.manages_group` and new guard rules in the database; the migration also refuses archived groups (`RQ023`) and allows the child replacement that archive uses.
- **Acceptance criteria:**
  1. **Where used** lists every current use of a group: parent groups now, and each later item adds its source (configured role grants in ADM-14, approval steps in R2c-04, notification rules in ADM-42).
  2. Archiving a group in use asks for a replacement for each use and applies it in the same transaction; an archived group takes no new members.
  3. A company owner or a company admin with `people` names **delegated managers** for a group that grants nothing; a manager adds and removes that group's members only.
  4. A manager is refused for a group that grants something, including one that started granting after they were named, by the service and by direct SQL.
- **Test approach:** `tests/groups.test.ts` (new in ADM-11); `scripts/live-role-tests.ts` manager-on-granting-group-denied case.
- **Docs:** `docs/user-guide.md`.

### ADM-14 Groups as role grantees

- **Epics:** R2-13, R2-06.
- **Spec IDs:** PRM-023.
- **Mockup:** `#/groups` (Where used) and `#/roles` (holders).
- **Size:** 3 h.
- **Depends on:** ADM-13.
- **Migration:** `0057_group_roles.sql` (job 103, marker 35). Adds `app.group_roles` (new; `group_id`, `team_id`, `role_object_id`), writable only by a session context whose `company_level` is owner; a new `tenant_context.group_grants` body that is also true for a group with a role grant or nested under one; a new `tenant_context.install` body that takes the direct `app.member_roles` row and otherwise the group grant for the team, in the statement it already runs; and checks in `app.maintain_group_members()` and on `app.group_roles` that refuse any change giving a member two configured roles in one team (D30). Role template: `SELECT, INSERT, DELETE` on `app.group_roles` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. A company owner grants a configured role to a group for a team; every effective member who belongs to that team holds it, and a direct assignment wins.
  2. A grant or membership change that would give someone two roles in one team is refused, listing the people affected.
  3. **Group membership that grants a role is company owner only, enforced in the database:** a company admin with `people` cannot add a member to a role-granting group or to a group nested under it, by the service or by direct SQL as the data role.
  4. A group grant narrows scopes exactly as a direct role does and never exceeds the membership ceiling.
  5. `tests/round-trip-budget.test.ts` still counts 6, 11 and 15, with a group-granted role too.
  6. Roles show holders through groups; a group's **Where used** shows its role grants.
- **Test approach:** `tests/member-roles.test.ts`, `tests/groups.test.ts`, `tests/tenant-context.test.ts`, `tests/round-trip-budget.test.ts`; `scripts/live-role-tests.ts` granting-group-insert-denied case through the pooler.
- **Docs:** `docs/identity-boundary-plan.md`, `docs/security.md`, `docs/user-guide.md`.

### ADM-15 Bulk invite and group add from a workbook

- **Epics:** R2-13.
- **Spec IDs:** IAM-004.
- **Mockup:** `#/users` (bulk invite).
- **Size:** 3 h.
- **Depends on:** ADM-08, ADM-14.
- **Migration:** none.
- **Acceptance criteria:**
  1. A fictional `.xlsx` workbook with email, team, team role and group columns, under the organisation import's caps, gives a dry run with counts and a reason per refused row and writes nothing.
  2. Apply sends invitations only for teams where the caller is owner or admin and adds people only to groups the caller may change; rows for granting groups are listed under "Needs a company owner" and applied only by a company owner in a separate step.
  3. Apply is idempotent by email and team.
  4. The workbook has no role or authority column, and formula-like cells are stored as text and flagged.
- **Test approach:** `tests/user-import.test.ts` (new) with workbooks built in the test; `npm audit` unchanged (it uses `read-excel-file`, already a dependency).
- **Docs:** `docs/user-guide.md`.

### M2 Preview checkpoint

- **Owner steps:** apply the M2 migrations in build order after the M1 ones, rerun the role template, run `scripts/db-role-evidence.ts` and `npm run test:live-roles` directly and through the pooler, then deploy.
- **Version:** `1.3.0` (D28).
- **What the owner tests on Preview:**
  - the Users list across two fictional teams, and a user's detail;
  - invite a fictional person to two teams at once;
  - deactivate a fictional member, check they cannot sign in or use a token, then reactivate them;
  - anonymise a fictional account;
  - build nested fictional groups, see the cycle refusal, and name a delegated manager;
  - grant a role through a group and check that a fictional company admin cannot add people to that group;
  - a sensitive change after 15 minutes asks you to sign in again and keeps your form.
- **Data:** real candidate and employee data stays out of Preview; only fictional data is used.

## M3: Roles and permissions views

Contents: Company authority on its own page, the Roles page additions, the Permissions page, the access review and the permission helper (architecture §14.4). MVP order 3.

### ADM-16 Company authority page and two-step for company authority

- **Epics:** R2-01, R2-06.
- **Spec IDs:** PRM-001, PRM-002, PRM-003, PRM-010, IAM-034.
- **Mockup:** `#/company-authority`.
- **Size:** 3 h.
- **Depends on:** ADM-06, ADM-07.
- **Migration:** a new body of `tenant_context.set_workspace_authority` (same signature) that refuses to grant a level to a user whose two-step flag (`auth."user".two_factor_enabled`) is off. Role template: unchanged. Marker: +1.
- **Acceptance criteria:**
  1. `/app/admin/company-authority` (company owner only) lists company owners and admins with areas, **Plan & pay access**, two-step and since, and grants, changes and removes them; the panel leaves the Roles page, which links to it.
  2. "Plan & pay access" is one switch (D21) describing the confidential figures it opens that exist at the time.
  3. Granting a level to a person without two-step is refused by the service and by the helper; signing in with company authority requires two-step, as for team owners and admins.
  4. The last company owner cannot be removed; every change needs a fresh session and is audited.
- **Test approach:** `tests/workspace-tenancy.test.ts`, `tests/auth-flows.test.ts`, `tests/admin-portal-ui.test.tsx`; `scripts/live-role-tests.ts` helper case.
- **Docs:** `docs/user-guide.md`, `docs/authentication.md`, `docs/security.md`.

### ADM-17 Roles page: holders, copy, archive and default roles

- **Epics:** R2-06, R2-01.
- **Spec IDs:** PRM-020, PRM-021, PRM-022, PRM-024, PRM-031, DOM-030, DOM-031.
- **Mockup:** `#/roles` (list, editor, publish, refusal and empty states).
- **Size:** 3 h.
- **Depends on:** ADM-14, ADM-16.
- **Migration:** none (the `role-defaults` configuration object lives in the store of R2a-04).
- **Acceptance criteria:**
  1. The Roles list shows holders (direct and through groups) and Used by; **Copy** makes a draft of any role or template; **Archive** shows the holders first, and holders of an archived role get no access (fail-closed, built).
  2. A company owner sets a default configured role per team role; an accepted invitation gets that role.
  3. The publish, refusal and empty states read as the approved mockup, in plain words.
  4. Changes need a fresh session.
- **Test approach:** `tests/member-roles.test.ts`, `tests/config-store.test.ts`, `tests/admin-portal-ui.test.tsx`.
- **Docs:** `docs/user-guide.md`.

### ADM-18 Permissions page and the team's role view

- **Epics:** R2-06, R2-01.
- **Spec IDs:** PRM-025, PRM-032, PRM-034, PRM-035.
- **Mockup:** `#/permissions`.
- **Size:** 3 h.
- **Depends on:** ADM-17.
- **Migration:** none.
- **Acceptance criteria:**
  1. `/app/admin/permissions` (company owner only) shows a read-only matrix with roles as columns and pages, actions per resource, field rules and record scope as rows; **Edit** opens the role's draft.
  2. Two roles, or two versions of one role, compare side by side, with differences marked in text as well as colour.
  3. The help text explains that each layer can only remove access.
  4. The team detail page gains **Roles in this team** for that team's owners and admins: the roles their members hold, read-only.
- **Test approach:** `tests/permissions-matrix.test.ts` (new, no database), `tests/admin-portal-ui.test.tsx`.
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### ADM-19 Access review export and privileged access report

- **Epics:** R2-06.
- **Spec IDs:** PRM-062, PRM-063.
- **Mockup:** `#/permissions` (export).
- **Size:** 2 h.
- **Depends on:** ADM-18.
- **Migration:** a new body of `tenant_context.workspace_people` that also returns groups and Plan & pay access, and the owner-run read helper `tenant_context.workspace_tokens()` (new), which returns token and OAuth grant metadata of the workspace (holder, team, scopes, created, last used, expiry) to company owners only, never values or hashes. Role template: `EXECUTE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. The access review CSV lists people × teams × team role × configured role × company authority × groups; every cell goes through `safeCsvCell`; the export is audited with counts only.
  2. The privileged access report lists company owners and admins, team owners and admins, company admins by area (including `people`, which sees every team's staff emails), Plan & pay access holders, and write-scoped tokens and AI apps, with last sign-in.
  3. Both are company owner only; a formula-like fictional name exports as text.
- **Test approach:** `tests/access-review.test.ts` (new), `tests/record-export.test.ts` unchanged; `scripts/live-role-tests.ts` token-helper-denied case.
- **Docs:** `docs/user-guide.md`, `docs/security.md`.

### ADM-20 Permission helper engine

- **Epics:** R2-06.
- **Spec IDs:** PRM-060.
- **Mockup:** none.
- **Size:** 3 h.
- **Depends on:** ADM-05, ADM-09, ADM-14.
- **Migration:** adds the owner-run helpers `tenant_context.access_state_for(user_id text, team_id text)` (new; returns what `install` would derive for that member, to company owners of the same workspace only) and `tenant_context.would_be_in_scope(user_id text, team_id text, record_id uuid)` (new; returns only true or false, and only for a record in the caller's own team and scope). Both are `SECURITY DEFINER` with `SET search_path = pg_catalog, pg_temp`. Role template: `EXECUTE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. `explainAccess` (new, `src/lib/permission-helper.ts`) returns allowed or refused and the deciding layer by running the same `decide()` and `authorize()` on the derived access state; for a matrix of fictional members, roles and actions it matches what `authorize()` decides for that member's own request.
  2. **It writes nothing:** a test shows no row changes in any table.
  3. A record outside the admin's own scope is answered as missing; the answer holds no record values and names a field hidden from the admin only as "a field hidden from you".
  4. Anyone but a company owner is refused by the route and by both helpers.
- **Test approach:** `tests/permission-helper.test.ts` (new); `scripts/live-role-tests.ts` helper-denied cases.
- **Docs:** `docs/security.md`, `docs/identity-boundary-plan.md`.

### ADM-21 Permission helper page and Effective access

- **Epics:** R2-06, R2-01.
- **Spec IDs:** PRM-060, PRM-061.
- **Mockup:** `#/permission-helper` (allowed and refused states).
- **Size:** 2 h.
- **Depends on:** ADM-08, ADM-20.
- **Migration:** none.
- **Acceptance criteria:**
  1. `/app/admin/permission-helper` takes a user, a team, a record kind, an optional record and an action, and shows allowed or refused with the chain of layers and the deciding one.
  2. The refused state names the layer and what would change it, in plain words, as the approved mockup does.
  3. The record picker lists only records in the admin's own scope; a team where the admin is not a member offers no record.
  4. The user detail page gains **Effective access** with the same answer.
  5. Everything works by keyboard, at 360 px and in the dark theme.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (helper cases), `tests/permission-helper.test.ts` (new in ADM-20).
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### M3 Preview checkpoint

- **Owner steps:** apply the M3 migrations in build order after the M2 ones, rerun the role template, run `scripts/db-role-evidence.ts` and `npm run test:live-roles`, then deploy.
- **Version:** `1.4.0` (D28).
- **What the owner tests on Preview:**
  - Company authority on its own page; granting it to a fictional person without two-step is refused;
  - copy and archive a fictional role, and set a default role for new recruiters;
  - the permission matrix and a comparison of two versions of one role;
  - export the access review and open it in Excel;
  - ask the permission helper why a fictional hiring manager cannot export, and see the refused state;
  - a fictional team owner sees their team's roles read-only.
- **Data:** real candidate and employee data stays out of Preview; only fictional data is used.

## M4: Org tree and job architecture

Contents: the org tree by units and by people, job families, titles and grades, salary brackets under Plan & pay access, and the import columns (architecture §14.5, ORG-101 to ORG-106). ORG-107 needs approvals and is ADM-35 in M6. MVP order 4.

### ADM-22 Org tree by units

- **Epics:** R2-14.
- **Spec IDs:** ORG-101.
- **Mockup:** `#/organisation?tab=chart` (tree by units; `screenshots/organisation-tree-units-light.png`).
- **Size:** 3 h.
- **Depends on:** ADM-01.
- **Migration:** none.
- **Acceptance criteria:**
  1. Organisation > Org chart switches between the list and a tree by units with their positions; vacant positions are drawn dashed and labelled "Vacant".
  2. Units load one level at a time; **Expand all** loads at most 500 units and says when it stopped.
  3. Zoom in, zoom out and reset; **Export image** makes a PNG in the browser from what is loaded, with no new server request.
  4. The tree is a nested list with tree keyboard navigation and announced counts, and works at 360 px and in the dark theme.
  5. Who can open it is unchanged from the org chart.
- **Test approach:** `tests/organisation-ui.test.tsx` (extended), `tests/org-tree.test.ts` (new, no database: tree building and vacancy marking).
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### ADM-23 Org tree by people with reporting lines

- **Epics:** R2-14.
- **Spec IDs:** ORG-101.
- **Mockup:** `#/organisation?tab=chart` (tree by people; `screenshots/organisation-tree-people-light.png`).
- **Size:** 3 h.
- **Depends on:** ADM-22.
- **Migration:** none.
- **Acceptance criteria:**
  1. A "By people" view shows employees with reporting lines derived as §14.5 says: the holder of the `is_manager` position of the person's unit or, when they hold it or it is vacant, of the nearest ancestor unit.
  2. It shows only with the directory page, `directory:read` and the role's directory rule; with `basic` it shows names and positions and never contact facts.
  3. It loads one level at a time; one level of the 2,000-employee fixture loads in under 1 s locally.
  4. Export image works as in ADM-22.
- **Test approach:** `tests/org-tree.test.ts` (new in ADM-22; reporting-line cases), `tests/directory.test.ts` (no contact facts with `basic`).
- **Docs:** `docs/user-guide.md`.

### ADM-24 Job families, titles and grades

- **Epics:** R2-14.
- **Spec IDs:** ORG-102, ORG-104, ORG-105.
- **Mockup:** none.
- **Size:** 3 h.
- **Depends on:** ADM-01.
- **Migration:** adds `job_title_key text null` to `app.positions` (new column). Role template: unchanged. Marker: +1.
- **Acceptance criteria:**
  1. A strict `job-architecture` body schema in `src/domain/config.ts` holds families, grades (unique code, name, order) and titles (unique key, family, grade), with at most 200 families, 200 grades and 2,000 titles; company owners and company admins with `organisation` create, publish and version it, with one audit row each.
  2. Every member reads the published job architecture (D22).
  3. A position takes a title of the published version; an unknown key is refused.
  4. Vacancies gain an optional `jobTitleKey` system field; existing rows and responses are unchanged, and the REST, OpenAPI and MCP vacancy shapes gain only that optional field.
- **Test approach:** `tests/job-architecture.test.ts` (new, PGlite), `tests/records-postgres.test.ts`, `tests/openapi-contract.test.ts`, `tests/config-defaults.test.ts` (the vacancy default gains one field).
- **Docs:** `docs/api-examples.md`, `docs/user-guide.md`.

### ADM-25 Salary brackets under Plan & pay access

- **Epics:** R2-14, R2-10.
- **Spec IDs:** ORG-103.
- **Mockup:** none.
- **Size:** 3 h.
- **Depends on:** ADM-16, ADM-24.
- **Migration:** adds `app.salary_bracket_versions` and `app.salary_brackets` (new, company level, FORCE row-level security); the policy helper `tenant_context.allows_plan(row_workspace uuid, access text)` (new; the helper of architecture §9.2, reading `plan_access` and `plans:read` or `plans:write` from the context row), used by every policy on both tables; write policies that also need a company owner or a company admin with `organisation`; an owner-owned trigger that makes published versions immutable; the owner-run publish helper `tenant_context.publish_bracket_version(uuid)` (new); and `pay_bracket_version_id uuid null` on `app.records`. Role template: `SELECT, INSERT, UPDATE` on both tables and `EXECUTE` on the helpers for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. `src/lib/pay-brackets.ts` (new) creates a draft version with a bracket per grade in AED fils (minimum ≤ midpoint ≤ maximum, pay period and coverage per D23), publishes it, and refuses any change to a published version.
  2. **Bracket confidentiality is enforced by the database:** by direct SQL as the data role, a context without Plan & pay access, or without `plans:read`, reads no bracket row. This holds for a team owner, a company admin with `organisation` and a company owner who has not granted themselves access; writes are refused likewise.
  3. **Brackets are absent from MCP and exports:** no MCP tool returns a bracket field (the tool list and allowlist are unchanged), and no export, notification, search result or activity row holds a figure (activity holds the version number only).
  4. An offer created for a vacancy with a job title stores the published bracket version id; a later publish leaves it unchanged.
  5. Approval membership grants no bracket access.
- **Test approach:** `tests/pay-brackets.test.ts` (new, PGlite with split roles), `tests/record-export.test.ts`, `tests/mcp-pipeline-tools.test.ts` (offer outputs hold no bracket field); `scripts/live-role-tests.ts` bracket-confidentiality cases, including a team-B owner and a company owner without the grant, through the pooler.
- **Docs:** `docs/security.md`, `docs/identity-boundary-plan.md`, `docs/api-examples.md`.

### ADM-26 Job architecture tab

- **Epics:** R2-14.
- **Spec IDs:** ORG-102, ORG-103, ORG-104, ORG-105.
- **Mockup:** `#/organisation?tab=jobs` (`screenshots/organisation-jobs-light.png`).
- **Size:** 3 h.
- **Depends on:** ADM-25.
- **Migration:** none.
- **Acceptance criteria:**
  1. Organisation gains **Job architecture** with **Job grades & salary brackets**, **Job titles** and **Job families**: add and edit grades, titles and families, then publish.
  2. The "Show salary brackets" switch, bracket columns and bracket settings appear only to Plan & pay access holders; everyone else sees grades without pay and no switch. The confidentiality notice says who can see brackets.
  3. Bracket settings set pay period, coverage and effective date; AED is shown fixed, with no currency choice.
  4. Bad brackets are refused in plain words ("The minimum must be at most the midpoint, and the midpoint at most the maximum").
  5. Everything works by keyboard, at 360 px and in the dark theme, and the bracket band has a text alternative.
- **Test approach:** `tests/organisation-ui.test.tsx` (job architecture cases, with and without the grant).
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### ADM-27 Positions and vacancies pick a job title; grade-change impact

- **Epics:** R2-14.
- **Spec IDs:** ORG-104.
- **Mockup:** `#/organisation?tab=jobs` (edit job title, impact notice).
- **Size:** 3 h.
- **Depends on:** ADM-26.
- **Migration:** adds the owner-run aggregate helper `tenant_context.job_title_usage(title_key text)` (new, `SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`), which returns counts only (positions, open vacancies, open offers) for the context's workspace to company owners and company admins with `organisation`. Role template: `EXECUTE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. The position form and the vacancy editor pick a job title and show its grade; the bracket only to Plan & pay access holders.
  2. Changing a title's grade first shows the counts of affected positions, open vacancies and open offers, and saves only after confirmation.
  3. The helper returns no id, name, team or date, and refuses every other context.
- **Test approach:** `tests/job-architecture.test.ts` (new in ADM-24), `tests/workspace-render.test.tsx`; `scripts/live-role-tests.ts` helper-denied case.
- **Docs:** `docs/user-guide.md`.

### ADM-28 Excel import: Job title and Grade columns

- **Epics:** R2-14, R2-07.
- **Spec IDs:** ORG-106.
- **Mockup:** `#/organisation?tab=import` (`screenshots/organisation-import-preview.png`).
- **Size:** 2 h.
- **Depends on:** ADM-27.
- **Migration:** none.
- **Acceptance criteria:**
  1. The Positions sheet takes a Job title column (name or key) and an optional Grade column that must agree with the title's grade; an unknown title or a disagreeing grade is refused with the reason.
  2. Any other column, including one that looks like pay, is listed as ignored in the dry run; no bracket figure is read or stored.
  3. The dry-run preview shows the new columns; everything else of R2a-17 is unchanged.
- **Test approach:** `tests/org-import.test.ts` (new cases with fictional workbooks).
- **Docs:** `docs/user-guide.md`.

### M4 Preview checkpoint

- **Owner steps:** apply the M4 migrations in build order after the M3 ones, rerun the role template, run `scripts/db-role-evidence.ts` and `npm run test:live-roles`, then deploy.
- **Version:** `1.5.0` (D28).
- **What the owner tests on Preview:**
  - the org tree by units and by people, zoom, expand and collapse, and Export image;
  - add fictional job families, titles and grades, and pick a title on a fictional vacancy;
  - grant yourself Plan & pay access and see the brackets; a fictional company admin without it sees grades without pay;
  - change a title's grade and read the impact counts;
  - import a fictional workbook with Job title and Grade columns.
- **Data:** real candidate, employee and pay data stays out of Preview; only fictional data is used.

## M5: Fields and screens

Contents: the R2b items, reconciled onto the central Fields and Screens pages (architecture §1, §2, §14.6). MVP order 5.

### R2b-02 Record pins and custom values on every configurable kind

- **Epics:** R2-02.
- **Spec IDs:** FLD-014.
- **Mockup:** none.
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
- **Spec IDs:** FLD-010, FLD-011, FLD-013.
- **Mockup:** none.
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
- **Spec IDs:** FLD-014, WFL-031.
- **Mockup:** none.
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
- **Spec IDs:** none (R2-02 person, org unit and lookup types).
- **Mockup:** none.
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
- **Spec IDs:** none (R2-02 file type).
- **Mockup:** none.
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
- **Spec IDs:** SCR-001, SCR-004, SCR-010, FLD-030.
- **Mockup:** none.
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
- **Spec IDs:** PRM-050, FLD-030.
- **Mockup:** none.
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

### R2b-09 Fields page: the field list and wizard

- **Epics:** R2-02, R2-01.
- **Spec IDs:** FLD-011, FLD-012, FLD-015, FLD-033.
- **Mockup:** `#/fields` (list and create wizard; `screenshots/fields-wizard.png`).
- **Reconciliation:** was "Screens and fields tab: fields". It becomes the central Fields page `/app/admin/fields` listing every kind's fields with a create wizard (architecture §14.6). Contexts, options and Where used are ADM-29. The work below is unchanged.
- **Size:** 3 h.
- **Depends on:** ADM-01, R2b-07.
- **Migration:** none.
- **Acceptance criteria:**
  1. Company admins with the `fields` area (and company owners) add, rename, reorder, group, archive and mark custom fields per kind, choosing one of the 19 types with defaults, help text and validation, from one list of every kind's fields and a create wizard.
  2. System fields can be relabelled, given help text, grouped and made mandatory, never removed or retyped.
  3. Company owners can mark fields sensitive.
  4. Publishing shows the change summary.
  5. The key is always shown, and a duplicate name is warned about.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (new in R2a-11; fields cases), `tests/config-store.test.ts` (new in R2a-04).
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### ADM-29 Field contexts, options and Where used

- **Epics:** R2-02, R2-01.
- **Spec IDs:** FLD-015, FLD-016, FLD-020, FLD-022, FLD-024, DOM-030.
- **Mockup:** `#/fields` (field detail tabs; `screenshots/fields-contexts.png`).
- **Size:** 3 h.
- **Depends on:** R2b-09.
- **Migration:** adds the owner-run aggregate helper `tenant_context.field_usage(kind text, field_id uuid)` (new), which returns the count of records with a value for the field across the workspace's teams, counts only, to company owners and company admins with `fields`. Role template: `EXECUTE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. A field's context is its record kind and, optionally, some of that kind's types; the schema refuses any team key, and there is one definition per field.
  2. Options are added, renamed, reordered and disabled by id; stored values keep their option id, and a disabled option is not offered on new records but still shows on existing ones. Team owners cannot edit options.
  3. **Where used** lists screens and, as later items add them, workflow conditions, templates and notification rules; archiving shows it first.
  4. Each field shows its usage count from the helper, which returns no id, value or team.
- **Test approach:** `tests/field-usage.test.ts` (new), `tests/config-store.test.ts`, `tests/admin-portal-ui.test.tsx`; `scripts/live-role-tests.ts` helper-denied case.
- **Docs:** `docs/user-guide.md`.

### R2b-10 Screens page: the screen designer

- **Epics:** R2-02, R16-03.
- **Spec IDs:** SCR-002, SCR-003, FLD-032.
- **Mockup:** `#/screens` (designer; `screenshots/screens-light.png`).
- **Reconciliation:** was "Screens and fields tab: screen layout". It becomes the designer of the Screens page `/app/admin/screens`, with sections; the screen list, the schemes view, copy and archive are ADM-30. The work below is unchanged.
- **Size:** 2 h.
- **Depends on:** R2b-09.
- **Migration:** none.
- **Acceptance criteria:**
  1. Admins choose fields, sections, order and mandatory or read-only flags per type and action, with move up and move down buttons as the keyboard alternative to dragging.
  2. A preview shows the form.
  3. A screen that would hide a mandatory field on create is refused.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (new in R2a-11; screen cases).
- **Docs:** `docs/user-guide.md`.

### ADM-30 Screens list, schemes view, copy and archive

- **Epics:** R2-02, R2-01.
- **Spec IDs:** SCR-005, SCR-011, SCR-012, DOM-030.
- **Mockup:** `#/screens?tab=screens` and `#/screens?tab=schemes` (`screenshots/screens-list.png`, `screens-schemes.png`, `screens-publish.png`).
- **Size:** 2 h.
- **Depends on:** R2b-10.
- **Migration:** none.
- **Acceptance criteria:**
  1. The Screens page lists screens per kind, type and action with Used by.
  2. **Screen schemes** is a read-only table of kind × type × action → screen.
  3. **Copy** makes a new screen draft; **Archive** works only for a screen nothing uses.
  4. Publishing shows the summary of changed screens.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (screens cases), `tests/screens.test.ts` (new in R2b-07).
- **Docs:** `docs/user-guide.md`.

### R2b-11 Categories and types

- **Epics:** R2-03.
- **Spec IDs:** DOM-020, DOM-022.
- **Mockup:** `#/fields` (record types).
- **Reconciliation:** the types list lives on the Fields page (architecture §14.6); the work is unchanged.
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

### ADM-31 "Where is my field?" and the record kind summary

- **Epics:** R2-02.
- **Spec IDs:** FLD-001, DOM-033.
- **Mockup:** none.
- **Size:** 2 h.
- **Depends on:** ADM-29, R2b-11.
- **Migration:** none.
- **Acceptance criteria:**
  1. On the Fields page, kind + type + role + screen + action tells whether a field shows and why (on the screen or not, the role's field rule, a condition).
  2. Only company owners and company admins with `fields` can use it; it never shows a record value.
  3. A summary per kind lists its types, screens, fields, workflow and the roles that touch it.
- **Test approach:** `tests/admin-portal-ui.test.tsx`, `tests/screens.test.ts`.
- **Docs:** `docs/user-guide.md`.

### R2b-12 Field metadata in REST, OpenAPI and MCP

- **Epics:** R2-02, R2-09.
- **Spec IDs:** none (R2-09 field metadata for AI).
- **Mockup:** none.
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

### M5 Preview checkpoint

- **Owner steps:** apply the M5 migrations in build order after the M4 ones, rerun the role template, run `scripts/db-role-evidence.ts` and `npm run test:live-roles`, then deploy.
- **Version:** `1.6.0` (D28).
- **What the owner tests on Preview:**
  - add fictional custom fields of several types to candidates, vacancies and applications from the Fields page, with contexts and options;
  - relabel a system field and make a field mandatory on create;
  - define the fictional "Executive" vacancy type with its own screen in the screen designer;
  - hide the offer amount from the hiring manager role and check the UI, an export, search and a connected AI app;
  - ask "Where is my field?" for a hidden field;
  - every unchanged form still looks as before.
- **Data:** real candidate and employee data stays out of Preview; only fictional data is used.

## M6: Workflows

Contents: the R2c workflow items, reconciled onto the Workflows page and company approval groups, with outcome reasons and out-of-bracket offer approval (architecture §4, §14.3, §14.5, §14.7). MVP order 6.

### R2c-01 Workflow model and default workflows

- **Epics:** R2-04, R16-01, R16-02.
- **Spec IDs:** WFL-002, WFL-010, WFL-012, WFL-013.
- **Mockup:** none.
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
- **Spec IDs:** WFL-020, WFL-021, WFL-022, WFL-030, WFL-060, WFL-061, WFL-062.
- **Mockup:** none.
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

### ADM-32 Outcome reasons on closing transitions

- **Epics:** R2-04.
- **Spec IDs:** WFL-003.
- **Mockup:** `#/workflows` (designer, transition panel).
- **Size:** 2 h.
- **Depends on:** R2c-02.
- **Migration:** none (reasons live in the workflow body; the chosen key goes on the transition's activity row).
- **Acceptance criteria:**
  1. A workflow lists outcome reasons per closing category (Rejected, Withdrawn, Offer declined); a transition into such a category requires one, through REST, bulk applications and the MCP move tools, and is refused with 400 without it.
  2. The reason key is stored on the activity row; analytics and exports keep working unchanged.
  3. The default workflows need no reason until a company admin adds a list.
- **Test approach:** `tests/workflow-engine.test.ts` (new in R2c-01), `tests/mcp-pipeline-tools.test.ts`, `tests/openapi-contract.test.ts`.
- **Docs:** `docs/user-guide.md`, `docs/api-examples.md`, `docs/mcp.md`.

### R2c-03 Outbox and post-actions

- **Epics:** R2-04.
- **Spec IDs:** WFL-050, WFL-051, NTF-001.
- **Mockup:** none.
- **Reconciliation:** the outbox also delivers notifications from M8 (architecture §14.10); the work is unchanged.
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
- **Spec IDs:** WFL-040, WFL-041, WFL-042, WFL-043, IAM-060, IAM-062.
- **Mockup:** `#/groups` (approval settings) and `#/workflows` (approval step).
- **Reconciliation:** approval steps name a flagged company group (ADM-11) by id instead of listing users and roles in the workflow body, and `members` are resolved from `app.group_effective_members` when the request opens (architecture §14.3). The Groups page gains its approval settings, and a group's Where used lists its approval steps. Membership changes are already company owner only at the group (ADM-11).
- **Size:** 3 h.
- **Depends on:** ADM-13, R2c-03.
- **Migration:** adds `app.approval_requests` (with `members`, the group's effective user ids at opening, and `group_id`) and `app.approval_decisions` (new; decisions also store `record_id`). Both are team-keyed under FORCE row-level security, each with the restrictive scope policy of §3.5 keyed by `record_id`. It also adds:
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
  8. An approval step can name only a flagged, unarchived company group; a request's members are that group's effective members when it opens, and a later group change does not alter an open request.
- **Test approach:** `tests/approvals.test.ts` (new); `tests/groups.test.ts` (new in ADM-11; Where used); `scripts/live-role-tests.ts` approval, forged-decision, state-flip and scope cases.
- **Docs:** `docs/user-guide.md`, `docs/security.md`.

### R2c-05 Delegates, out-of-office cover and SLA reminders

- **Epics:** R16-05.
- **Spec IDs:** IAM-061, WFL-045.
- **Mockup:** `#/groups` (approval settings, delegates).
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
- **Spec IDs:** WFL-011, WFL-070.
- **Mockup:** `#/workflows` (designer, problems and publish).
- **Reconciliation:** approval steps reference company groups (R2c-04), so the company-owner-only publish rule applies to a draft whose approval steps name a different group than the current published version; template and plan-settings approvers follow the same rule. Membership changes inside a group are owner-only at the group (ADM-11).
- **Size:** 3 h.
- **Depends on:** R2c-02, R2c-04.
- **Migration:** a new body of `tenant_context.publish_config_version` (same signature). It refuses a workflow, template or plan-settings draft whose approval steps reference a different group than the current published version unless the context's `company_level` is owner, and audits such a publish as `config.approvers_changed`. Role template: unchanged. Marker: +1.
- **Acceptance criteria:**
  1. Publishing a workflow refuses, with a list, unreachable statuses, inescapable loops, approval steps without a flagged group with members or without outcomes, conditions on deleted or archived fields, sensitive-field conditions and rule paths into Hired or Rejected.
  2. Saving or publishing a condition on a field hidden from the author's role is refused. The publish screen says when an approval step's group changed and that only a company owner can publish it.
  3. Publishing warns when an offered transition depends on a field the receiving role cannot see.
  4. A company admin with the `workflows` area cannot publish a draft that changes an approval step's group, through the service or by calling the helper directly. A company owner can, and the publish is listed with role assignments on the company owners' home screen.
  5. Published versions are immutable.
  6. Each publish is audited with its version number.
- **Test approach:** `tests/workflow-publish.test.ts` (new), `tests/config-store.test.ts` (new in R2a-04; approver-group publish cases); `scripts/live-role-tests.ts` company-admin-changes-approver-group-denied case.
- **Docs:** `docs/user-guide.md`.

### ADM-33 Cancel an approval request and ask again

- **Epics:** R2-04.
- **Spec IDs:** WFL-044.
- **Mockup:** `#/workflows` (approval step).
- **Size:** 2 h.
- **Depends on:** R2c-06.
- **Migration:** adds the owner-run helper `tenant_context.cancel_approval_request(request_id uuid, reason text)` (new), callable only from a session context of a company owner, which sets `state = cancelled` with the reason and writes one audit row. Role template: `EXECUTE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. A company owner cancels a pending request with a reason, after a fresh sign-in (ADM-06); the record shows it.
  2. **Ask again** opens a new request whose members are resolved afresh.
  3. No route, tool or helper can set a request to approved except `tenant_context.close_approval_request` from the recorded decisions; anyone but a company owner is refused cancel by the service and by the helper.
- **Test approach:** `tests/approvals.test.ts` (new in R2c-04); `scripts/live-role-tests.ts` cancel-denied case.
- **Docs:** `docs/user-guide.md`.

### R2c-07 In-flight migration with an explicit status mapping

- **Epics:** R2-04, R16-01.
- **Spec IDs:** WFL-071, WFL-073, DOM-032, API-008.
- **Mockup:** `#/workflows` (publish with migration).
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
- **Spec IDs:** none (R16-07 test mode).
- **Mockup:** `#/workflows` (designer, test run).
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

### ADM-34 Workflows page: list, statuses and workflow schemes

- **Epics:** R2-04, R2-01.
- **Spec IDs:** WFL-001, WFL-002, WFL-072, WFL-075.
- **Mockup:** `#/workflows?tab=workflows`, `?tab=schemes` and `?tab=statuses` (`screenshots/workflows-light.png`).
- **Size:** 3 h.
- **Depends on:** ADM-01, R2c-06.
- **Migration:** adds the owner-run aggregate helper `tenant_context.workflow_status_usage(object_id uuid)` (new), which returns the count of records per status of a workflow across the workspace's teams, counts only, to company owners and company admins with `workflows`. Role template: `EXECUTE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. `/app/admin/workflows` lists workflows with record kind, bound types, version, state and last use, including inactive ones.
  2. **Workflow schemes** shows record kind and type → workflow.
  3. **Statuses** lists every status with category, the workflows that use it and its record count from the helper, which returns no id, name or team.
  4. Company owners and company admins with `workflows` open it; nobody else does.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (workflow list cases), `tests/workflow-publish.test.ts`; `scripts/live-role-tests.ts` helper-denied case.
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### R2c-09 Workflow designer: step-list editor

- **Epics:** R2-04, R16-06.
- **Spec IDs:** none (R16-06 step list).
- **Mockup:** `#/workflows` (designer; `screenshots/workflows-designer-light.png`).
- **Reconciliation:** was "Workflows tab: step-list editor". It is the default editor of the designer on the Workflows page (ADM-34); approval steps pick a flagged company group instead of editing members. The rest of the work is unchanged.
- **Size:** 3 h.
- **Depends on:** R2c-06, ADM-34.
- **Migration:** none.
- **Acceptance criteria:**
  1. Company admins with the `workflows` area (and company owners) edit statuses, transitions, conditions, validators, post-actions and approval steps in lists, tables and dialogs. An approval step picks a flagged company group; changing which group a step uses can be drafted by anyone with the area, but only a company owner can publish it. Assign post-actions offer only record-derived targets.
  2. The editor shows publish problems inline and the in-flight mapping step.
  3. Everything works by keyboard, with announced changes, at 360 px and 200% zoom.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (new in R2a-11; workflow cases); manual screen-reader and keyboard checks recorded in `docs/accessibility-checklist.md`.
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### R2c-10 Workflows tab: canvas editor

- **Epics:** R2-04, R16-06.
- **Spec IDs:** none (R16-06 canvas).
- **Mockup:** `#/workflows` (designer canvas; `screenshots/workflows-designer-light.png`).
- **Reconciliation:** the canvas is the designer's second view on the Workflows page; the work is unchanged.
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
- **Spec IDs:** WFL-072, WFL-075.
- **Mockup:** `#/workflows?tab=schemes`.
- **Reconciliation:** the type binding shows as workflow schemes (ADM-34); the work is unchanged.
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
- **Spec IDs:** none (R12-02 requisition approval).
- **Mockup:** none.
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
- **Spec IDs:** none (R12-03 offer approval).
- **Mockup:** none.
- **Reconciliation:** its approval group is the recommended default for offers outside the bracket (D24, ADM-35); the work is unchanged.
- **Size:** 2 h.
- **Depends on:** R2b-08, R2c-04.
- **Migration:** none.
- **Acceptance criteria:**
  1. An offer workflow template requires an approval group before Sent.
  2. The offer `amount` is hidden from roles without the field and readable by pending approvers for that offer only, in the UI, REST and MCP.
- **Test approach:** `tests/approvals.test.ts` (new in R2c-04), `tests/field-redaction.test.ts` (new in R2b-08; approver cases).
- **Docs:** `docs/user-guide.md`.

### ADM-35 Out-of-bracket offer approval

- **Epics:** R2-14, R2-04.
- **Spec IDs:** ORG-107.
- **Mockup:** `#/organisation?tab=jobs` (the offer-approvers note) and `#/workflows` (Offer approval).
- **Size:** 3 h.
- **Depends on:** ADM-27, R2c-13.
- **Migration:** adds the owner-owned `SECURITY DEFINER` helper `tenant_context.offer_bracket_position(offer_id uuid)` (new, `SET search_path = pg_catalog, pg_temp`), which reads the offer only when it is in the caller's team and scope, compares its annualised amount with its pinned bracket version, and returns only `below`, `within`, `above` or `not_comparable`; and `bracket_position text null` on `app.approval_requests`. Role template: `EXECUTE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. An offer below or above its bracket, or not comparable (D34), cannot move to Sent until the Offer workflow's approval group approves it; the default group is R2c-13's (D24).
  2. **The check reveals no figures:** approvers and recruiters without Plan & pay access see "Below the bracket", "Above the bracket" or "Not comparable" and the reason, never the minimum, midpoint or maximum, in the UI, REST, MCP, notifications and activity.
  3. By direct SQL as the data role, the helper's result holds no number, and it refuses an offer outside the caller's scope.
  4. An open offer keeps the bracket version it was made under after a new bracket version is published.
- **Test approach:** `tests/pay-brackets.test.ts` (new in ADM-25; position cases), `tests/approvals.test.ts`, `tests/mcp-pipeline-tools.test.ts`; `scripts/live-role-tests.ts` helper-output and scope cases.
- **Docs:** `docs/user-guide.md`, `docs/security.md`.

### R2c-14 Workflow events for later integrations

- **Epics:** R16-10.
- **Spec IDs:** WFL-080, WFL-083.
- **Mockup:** none.
- **Reconciliation:** events are recorded with no recipient until outgoing webhooks are built (D31); the work is unchanged.
- **Size:** 1 h.
- **Depends on:** R2c-03.
- **Migration:** none (events are outbox rows of type `event`).
- **Acceptance criteria:**
  1. Status entered, approval needed, approved and rejected write outbox events with ids and keys only, no field values.
  2. With no integration installed they are marked delivered to nobody and purged after 30 days.
- **Test approach:** `tests/outbox.test.ts` (new in R2c-03).
- **Docs:** `docs/security.md` (no new recipient).

### M6 Preview checkpoint

- **Owner steps:** apply the M6 migrations in build order after the M5 ones, rerun the role template, run `scripts/db-role-evidence.ts` and `npm run test:live-roles`, then deploy.
- **Version:** `1.7.0` (D28).
- **What the owner tests on Preview:**
  - copy the fictional Emiratisation workflow template and check the Workflows, schemes and statuses tabs;
  - add a finance approval step on a flagged fictional group with the majority rule;
  - run test mode, then publish with an in-flight mapping over fictional applications;
  - check that no rule moves anything to Hired or Rejected, and that rejecting asks for a reason;
  - approve as a fictional delegate, and cancel a request and ask again as company owner;
  - make a fictional offer above its bracket and see that the approver sees "Above the bracket" and no figures;
  - check the step list by keyboard.
- **Data:** real candidate, employee and pay data stays out of Preview; only fictional data is used.

## M7: Look and feel and domain

Contents: branding as design tokens, the public brand asset store, the banner and team colours, the read-only Domain page and regional settings (architecture §14.8, §14.9). MVP order 7.

### ADM-36 Branding model and design tokens

- **Epics:** R2-15.
- **Spec IDs:** BRD-001, BRD-002, BRD-003, BRD-010, BRD-011, TST-018.
- **Mockup:** none.
- **Size:** 3 h.
- **Depends on:** ADM-01.
- **Migration:** extends the area check of `app.workspace_admins` and `tenant_context.set_workspace_authority` with `branding` (new grantable area); adds the owner-run read helper `tenant_context.public_branding()` (new), which returns only the public token set of the published branding version, for the sign-in page. Role template: `EXECUTE` on the helper for the runtime role that renders the sign-in page. Marker: +1.
- **Acceptance criteria:**
  1. A strict `branding` body schema holds colour tokens (hex only), light and dark values, asset ids, the sign-in message and the email header; it refuses CSS text, URLs and unknown keys. The sign-in message and email header text are plain text, rendered escaped, with no HTML or markdown.
  2. Publishing is refused below 4.5:1 for text and 3:1 for UI parts for any token pair in either theme, with the failing pairs listed.
  3. The root layout writes the published tokens as CSS custom properties on the server; `tests/round-trip-budget.test.ts` still counts 6, 11 and 15.
  4. The sign-in page reads only `tenant_context.public_branding()`, and a test finds no configuration or record data in the pre-sign-in output.
  5. Company authority offers the `branding` area.
- **Test approach:** `tests/branding.test.ts` (new), `tests/round-trip-budget.test.ts`, `tests/workspace-tenancy.test.ts`.
- **Docs:** `docs/security.md`, `docs/user-guide.md`.

### ADM-37 Public brand asset store

- **Epics:** R2-15.
- **Spec IDs:** BRD-004, BRD-005, BRD-006.
- **Mockup:** `#/branding` (logo and favicon upload).
- **Size:** 3 h.
- **Depends on:** ADM-36.
- **Migration:** adds `app.brand_assets` (new, company level, FORCE row-level security, written under `allows_workspace` with the `branding` area). Role template: `SELECT, INSERT, UPDATE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. After the owner approves the escalation (D32), `sharp` is added directly at an exact version with `npm audit --audit-level=moderate` passing.
  2. **The public Blob store is separate:** logos and favicons go to a new public Blob store with its own environment variables (documented in `docs/deployment.md`), hosted with the same OIDC-only credential rule as the CV store. A test shows the brand-asset code cannot address the CV store and the CV code cannot address the brand store. Without the store configured, upload says "Brand asset storage is not configured" and stores nothing, with no fallback to any other store.
  3. PNG, JPEG and WebP up to 1 MiB and 2,000 × 2,000 pixels are re-encoded on the server with EXIF removed (a fictional image carrying EXIF loses it); files are named by their SHA-256.
  4. SVG and every other type are refused by their bytes, whatever the file name; no custom CSS can be uploaded or stored.
  5. Tests never contact Blob.
- **Test approach:** `tests/brand-assets.test.ts` (new, with a fake store), `npm run test:storage` (store-separation cases).
- **Docs:** `docs/blob-security-design.md`, `docs/deployment.md`, `docs/security.md`.

### ADM-38 Branding page with preview and publish

- **Epics:** R2-15, R2-01.
- **Spec IDs:** BRD-001, BRD-002, NTF-045.
- **Mockup:** `#/branding` (Brand, Sign-in page, Emails and Versions tabs).
- **Size:** 3 h.
- **Depends on:** ADM-37.
- **Migration:** none.
- **Acceptance criteria:**
  1. `/app/admin/branding` (company owners and company admins with `branding`) edits a draft and previews the header, buttons, sign-in page and email header in light and dark.
  2. Contrast problems show live, and publish is refused with them listed.
  3. **Versions** lists published versions and reverts to one as a new draft.
  4. Everything works by keyboard, at 360 px and in the dark theme.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (branding cases), `tests/branding.test.ts` (new in ADM-36).
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### ADM-39 Announcement banner and team colour and icon

- **Epics:** R2-15.
- **Spec IDs:** BRD-022, BRD-030, BRD-031.
- **Mockup:** `#/branding` (Announcement tab) and `#/teams` (team colour).
- **Size:** 3 h.
- **Depends on:** ADM-04, ADM-38.
- **Migration:** a new body of `tenant_context.allows_workspace` that treats `team-appearance` objects like `task-board` objects (readable by every team of the workspace, written by that team's owners). Role template: unchanged. Marker: +1.
- **Acceptance criteria:**
  1. A company `banner` object sets severity, audience (everyone or one team), start, end and whether it can be dismissed; the banner shows to that audience in that window. Its text is plain text, rendered escaped, with no HTML or markdown.
  2. A team owner sets the team's colour and icon on the team detail page; they show in the team switcher and the Teams list. Another team cannot change them, by the service or by direct SQL.
  3. A maintenance message is a banner only; nothing switches the app to read-only.
- **Test approach:** `tests/branding.test.ts`, `tests/admin-portal-ui.test.tsx`; `scripts/live-role-tests.ts` team-B-owner-writes-appearance-denied case.
- **Docs:** `docs/user-guide.md`.

### ADM-40 Domain page, mismatch banner and Host-header test

- **Epics:** R2-15.
- **Spec IDs:** SYS-001, SYS-002, SYS-003, SYS-004, SYS-005, SYS-006, SYS-021, TST-019.
- **Mockup:** `#/domain`.
- **Size:** 3 h.
- **Depends on:** ADM-06.
- **Migration:** an owner-only `domain` branch in the `app.activity` insert policy, for the URL-change audit row. Role template: unchanged. Marker: +1.
- **Acceptance criteria:**
  1. `/app/admin/domain` (company owner only) shows the `BETTER_AUTH_URL` of the deployment, the deployment mode and the "Set in deployment" settings; nothing on the page changes them.
  2. When a company owner's browser origin differs from the configured URL, a banner says so; the server never reads the Host header for it.
  3. The optional address check runs in the browser against `<address>/api/version`; a test shows the server makes no outgoing request for it.
  4. **No Host-header links (TST-019):** a new test sends forged `Host`, `X-Forwarded-Host` and `X-Forwarded-Proto` to the password reset, invitation, OAuth metadata and MCP discovery paths, and every link in the responses and emails uses `BETTER_AUTH_URL`.
  5. The impact checklist lists DNS, the Better Auth trusted origin, OAuth and MCP redirect URIs, the Resend domain and links already sent. When a company owner first opens the page after the configured URL changed, one audit row records the old and new origin.
- **Test approach:** `tests/host-header.test.ts` (new), `tests/admin-portal-ui.test.tsx`, `tests/mcp-oauth.test.ts`.
- **Docs:** `docs/security.md`, `docs/deployment.md`, `docs/user-guide.md`.

### ADM-41 Regional settings

- **Epics:** R2-15.
- **Spec IDs:** SYS-010, UI-012.
- **Mockup:** none.
- **Size:** 2 h.
- **Depends on:** ADM-40.
- **Migration:** none (a `regional` configuration object).
- **Acceptance criteria:**
  1. A company owner sets the company timezone (Asia/Dubai by default), date format and week start on the Domain page.
  2. Dates across the app use them, with the UTC time in a tooltip; the app's single date format stays the default.
  3. There is no language choice: English only, left to right.
- **Test approach:** `tests/workspace-render.test.tsx` (date formatting), `tests/config-store.test.ts`.
- **Docs:** `docs/user-guide.md`.

### M7 Preview checkpoint

- **Owner steps:** create the public brand Blob store and set its environment variables for Preview (owner step), apply the M7 migrations in build order after the M6 ones, rerun the role template, run `scripts/db-role-evidence.ts` and `npm run test:live-roles`, then deploy.
- **Version:** `1.8.0` (D28).
- **What the owner tests on Preview:**
  - upload a fictional logo, check that an SVG is refused, preview light and dark, and publish;
  - try a low-contrast accent colour and see the refusal;
  - show a fictional banner to one team, and set a team colour;
  - the Domain page shows the Preview URL read-only; open Preview through another alias and see the mismatch banner;
  - the sign-in page shows the brand and nothing else.
- **Data:** real candidate and employee data stays out of Preview; only fictional data and fictional images are used.

## M8: Notifications and mail

Contents: the template model and Resend sending moved from R2d, company notification rules, the header bell, preferences, notification templates, the outgoing mail page, signed webhooks and the delivery log (architecture §7, §14.10). MVP order 8.

### R2d-01 Template model and merge-field resolver

- **Epics:** R2-08, R12-07.
- **Spec IDs:** NTF-003, NTF-040, NTF-041, NTF-044.
- **Mockup:** none.
- **Reconciliation:** moved into M8, before the other template items, because notification emails use the same model and resolver (architecture §14.10). The work is unchanged.
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

### ADM-42 Notification rules and in-app notifications

- **Epics:** R2-16.
- **Spec IDs:** NTF-001, NTF-003, NTF-010, NTF-011, NTF-013, NTF-014, NTF-030, NTF-052, NTF-053, TST-013.
- **Mockup:** none.
- **Size:** 3 h.
- **Depends on:** ADM-13, R2c-03, R2d-01.
- **Migration:** extends the area check with `notifications` (new grantable area); adds `app.notifications` (new, team-keyed, FORCE row-level security, readable only by its recipient, with the restrictive scope policy of §3.5 keyed by `record_id`) and an owner-run purge helper for rows older than 90 days. Role template: `SELECT, INSERT, UPDATE` on the table and `EXECUTE` on the helper for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. A strict `notification-rules` body holds event × recipient × channel rules, with mandatory events marked; the defaults reproduce today's reminders exactly.
  2. Events from the outbox create one in-app notification per recipient, resolved per recipient through `authorize()`; nobody is notified about a record they cannot see, and titles use only fields they can see.
  3. "Notify people of their own changes" is off by default.
  4. A member reads only their own notifications, by the service and by direct SQL; a scoped context reads none of an out-of-scope record.
  5. A group used in a rule shows the rule in its Where used.
- **Test approach:** `tests/notification-rules.test.ts` (new), `tests/insights-postgres.test.ts` (reminders unchanged); `scripts/live-role-tests.ts` other-recipient and scope cases.
- **Docs:** `docs/security.md`, `docs/user-guide.md`.

### ADM-43 Header bell and panel

- **Epics:** R2-16.
- **Spec IDs:** NTF-050, NTF-051, NTF-052, NTF-053.
- **Mockup:** none.
- **Size:** 2 h.
- **Depends on:** ADM-42.
- **Migration:** none.
- **Acceptance criteria:**
  1. The app header shows a bell with the unread count; the panel lists notifications grouped per record, newest first, and marks them read.
  2. The count refreshes by polling at most once a minute while the tab is visible; there is no long-lived connection.
  3. The Notifications page keeps its reminders.
  4. The bell and panel work by keyboard and with a screen reader, at 360 px and in the dark theme.
- **Test approach:** `tests/workspace-render.test.tsx` (bell cases), `tests/round-trip-budget.test.ts` (the count request within the read budget).
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### ADM-44 My notification preferences and user defaults

- **Epics:** R2-16.
- **Spec IDs:** NTF-030, NTF-031.
- **Mockup:** `#/notifications?tab=defaults`.
- **Size:** 2 h.
- **Depends on:** ADM-42.
- **Migration:** adds `app.notification_preferences` (new; `workspace_id`, `user_id`, `preferences jsonb`), readable and writable by its own user only. Role template: `SELECT, INSERT, UPDATE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. Company owners and admins with `notifications` set default channels per event.
  2. Personal settings gain **My notification preferences**, where each person changes the overridable events; mandatory events show as always on.
  3. Nobody reads or writes another person's preferences, by the service or by direct SQL.
- **Test approach:** `tests/notification-rules.test.ts` (new in ADM-42), `tests/settings-ui.test.tsx`; `scripts/live-role-tests.ts` other-user-preferences-denied case.
- **Docs:** `docs/user-guide.md`.

### ADM-45 Notifications page: rules editor and notification helper

- **Epics:** R2-16, R2-01.
- **Spec IDs:** NTF-012, NTF-015, PRM-061.
- **Mockup:** `#/notifications` (Rules tab).
- **Size:** 3 h.
- **Depends on:** ADM-20, ADM-44.
- **Migration:** none.
- **Acceptance criteria:**
  1. `/app/admin/notifications` edits the rules in rows grouped as Candidates, Pipeline, Interviews, Offers, Tasks and Approvals, with recipients and channels, and publishes them.
  2. The notification helper takes a user, a record and an event and says whether they would be notified, on which channel and why. It is read-only, writes nothing, and its record picker lists only records in the admin's own scope.
  3. Everything works by keyboard, at 360 px and in the dark theme.
- **Test approach:** `tests/admin-portal-ui.test.tsx`, `tests/notification-rules.test.ts`.
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### R2d-02 Email templates and sending through Resend

- **Epics:** R2-08, R12-07.
- **Spec IDs:** NTF-002, NTF-040, NTF-046.
- **Mockup:** none.
- **Reconciliation:** moved into M8. `sendRecordMail` also sends notification emails from the outbox, and on Preview sends every email to the capture address of D27. The rest of the work is unchanged.
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
  8. With the Preview capture address set, every email goes to it and nowhere else; on Preview without it, only sign-in mail is sent.
- **Test approach:** `tests/template-mail.test.ts` (new) with a fake delivery, `tests/field-redaction.test.ts` (new in R2b-08; a hiring manager who cannot see `offer.amount` reads a logged offer email), `tests/mail-hosted.test.ts`, `tests/candidate-erasure.test.ts`, `tests/employee-erasure.test.ts` (new in R2a-15); `scripts/live-role-tests.ts` table and scope cases.
- **Docs:** `docs/security.md` ("Intended connections"), `docs/erasure-runbook.md`, `docs/deployment.md`.

### ADM-46 Notification email templates

- **Epics:** R2-16, R2-08.
- **Spec IDs:** NTF-040, NTF-041, NTF-042, NTF-043, NTF-044, NTF-045, NTF-046.
- **Mockup:** `#/notifications?tab=templates`.
- **Size:** 3 h.
- **Depends on:** ADM-38, ADM-45, R2d-02.
- **Migration:** none (notification templates are `template` configuration objects).
- **Acceptance criteria:**
  1. The Templates tab edits each event's staff email subject and body with allowlisted merge fields, versioned and diffable.
  2. Preview renders with a record the editor can read and their permissions; **Send test** goes only to the editor's own address. The preview shows the admin-authored HTML only escaped or in a sandboxed frame with no scripts.
  3. Every email uses the branded wrapper of the published branding, and links come only from `BETTER_AUTH_URL`.
  4. The HTML compatibility check lists problems before publish.
- **Test approach:** `tests/templates.test.ts` (new in R2d-01), `tests/template-mail.test.ts` (new in R2d-02).
- **Docs:** `docs/user-guide.md`.

### ADM-47 Digest, throttling and unsubscribe

- **Epics:** R2-16.
- **Spec IDs:** NTF-032, NTF-033, NTF-034.
- **Mockup:** `#/notifications?tab=defaults` (digest choice).
- **Size:** 2 h.
- **Depends on:** ADM-46.
- **Migration:** none.
- **Acceptance criteria:**
  1. A person who chose a digest gets one email per period built by a cron job, not one per event.
  2. A per-person hourly cap holds, and bulk CV intake and imports do not notify per row.
  3. Non-mandatory emails carry a link to preferences and a `List-Unsubscribe` header; mandatory ones do not offer unsubscribing.
- **Test approach:** `tests/notification-rules.test.ts`, `tests/template-mail.test.ts`.
- **Docs:** `docs/user-guide.md`, `docs/deployment.md` (the cron entry).

### ADM-48 Outgoing mail page: sender, queue, test email and Preview capture

- **Epics:** R2-16.
- **Spec IDs:** EML-001, EML-002, EML-003, EML-004, EML-005.
- **Mockup:** `#/mail` (Provider & sender, Domain authentication, Mail queue, Limits & safety).
- **Size:** 3 h.
- **Depends on:** ADM-06, R2d-02.
- **Migration:** adds the owner-run aggregate helper `tenant_context.mail_queue_summary()` (new, `SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`), which returns the number of queued and failed emails per team, counts only, to company owners. Role template: `EXECUTE` for `recruitmentos_data`. Marker: +1. Sender names and reply-to per team are a company `mail-settings` configuration object.
- **Acceptance criteria:**
  1. `/app/admin/mail` (company owner only) shows Resend as the provider with "Set in deployment" for the key, and sets the sender name and reply-to per team.
  2. **Domain authentication** shows the Resend domain status and the SPF, DKIM and DMARC checklist.
  3. **Mail queue on the company page is counts only:** it shows queued and failed counts per team from `tenant_context.mail_queue_summary()`, which returns no recipient address, record id, subject or content.
  4. **The queue rows stay with the team:** the team detail page gains a **Mail log** tab, for that team's owners and admins only, listing that team's queued and failed emails about records in the caller's scope, with Retry and Delete (each audited). The rows are read through the team-keyed row-level security and record-scope policies of `app.outbox` and `app.outbound_messages`, with no `SECURITY DEFINER` path.
  5. **Send test email** goes only to the signed-in owner's address.
  6. On Preview the page shows the capture address and a banner (D27).
  7. Changes need a fresh session.
  8. By direct SQL as the data role, a company owner with no role in team B reads no team-B queue row, recipient or record id, through the helper or the tables.
- **Test approach:** `tests/mail-settings.test.ts` (new) with a fake Resend, `tests/admin-portal-ui.test.tsx`; `scripts/live-role-tests.ts` company-owner-without-team-B-role queue cases.
- **Docs:** `docs/user-guide.md`, `docs/deployment.md`.

### ADM-49 Signed Resend webhooks and suppression

- **Epics:** R2-16.
- **Spec IDs:** EML-006, NTF-002.
- **Mockup:** none.
- **Size:** 3 h.
- **Depends on:** ADM-48.
- **Migration:** adds `app.mail_suppressions` (new, company level) and delivery status columns on `app.outbound_messages`, written only by the owner-run helper `tenant_context.record_mail_event(...)` (new), because a webhook has no member context. Role template: `EXECUTE` on the helper for `recruitmentos_data`, no direct write on the table. Marker: +1.
- **Acceptance criteria:**
  1. `POST /api/webhooks/resend` (new) accepts only events whose Resend signature verifies against a secret from the environment and whose timestamp is recent; others get 401 and write nothing.
  2. Delivered and bounced events update the message status; a hard bounce or complaint suppresses the address, and later sends skip it with a visible reason.
  3. A runtime role cannot write `app.mail_suppressions` directly.
  4. No company page lists suppressed addresses: the Mail page shows their count only, and a team's Mail log shows the suppression reason on that team's own messages.
  5. Tests never contact Resend.
- **Test approach:** `tests/resend-webhook.test.ts` (new, signed fictional events), `tests/runtime-role-grants.test.ts`; `scripts/live-role-tests.ts` direct-suppression-write-denied case.
- **Docs:** `docs/security.md` ("Intended connections"), `docs/deployment.md` (the webhook and its secret are owner steps).

### ADM-50 Delivery log with redaction and retention

- **Epics:** R2-16.
- **Spec IDs:** NTF-020, NTF-021, NTF-022, NTF-023.
- **Mockup:** `#/notifications?tab=log` (the company view is counts only; the record-level rows are the team's Mail log).
- **Size:** 3 h.
- **Depends on:** ADM-49.
- **Migration:** adds the owner-run helpers (all `SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`):
  - `tenant_context.delivery_summary(from_date date, to_date date)` (new): counts per team and event (queued, sent, delivered, bounced, failed), counts only, to company owners and company admins with `notifications`;
  - `tenant_context.delivery_content(message_id uuid)` (new): the rendered subject and body, only when the context is of the message's team, the record is in the caller's scope, the caller is a company owner who is also an owner or admin of that team, and the caller can see every merge field the message used;
  - a purge helper that removes content after 90 days and metadata after 1 year (D26).

  Record-level rows use the team-keyed policies of `app.outbound_messages` and `app.outbox`; no helper returns them. Role template: `EXECUTE` for `recruitmentos_data`. Marker: +1.

- **Acceptance criteria:**
  1. The team's **Mail log** tab (from ADM-48) also lists sent, delivered and bounced emails with status, event, record link, recipient and time, for that team's owners and admins and only for records in their scope, with filters and a CSV export through `safeCsvCell`.
  2. **The company Delivery log is counts only:** Notifications > Delivery log shows the numbers per team and event from `tenant_context.delivery_summary`, with no recipient address, record id, subject or content.
  3. **Message content** shows only to a company owner who is also an owner or admin of the message's team and can see every merge field, redacted. Everyone else, including a company owner with no role in that team, gets nothing, by the route and by the helper.
  4. **No cross-team record-level read:** by direct SQL as the data role, a company admin with `notifications` and no team-B role, and a company owner with no team-B role, read no team-B recipient, record id or content, through the helpers or the tables.
  5. Content older than 90 days and metadata older than 1 year are purged.
  6. **Retry** on a failed email is audited.
- **Test approach:** `tests/delivery-log.test.ts` (new), `tests/field-redaction.test.ts`; `scripts/live-role-tests.ts` cases for a company admin with `notifications` and a company owner, both with no team-B role, through the helpers and the tables, directly and through the pooler.
- **Docs:** `docs/user-guide.md`, `docs/security.md`.

### ADM-51 SMTP provider in self-hosted mode

- **Epics:** R2-16.
- **Spec IDs:** EML-001, EML-002, DAT-005.
- **Mockup:** `#/mail` (Provider & sender, SMTP).
- **Size:** 3 h.
- **Depends on:** ADM-48.
- **Queued only if** the owner chooses Release 2 in D25; otherwise it moves after `2.0.0` unchanged.
- **Migration:** adds `app.mail_secrets` (new, company level; ciphertext, set by, set at), written only through an owner-run helper by a company owner. Role template: `SELECT` and `EXECUTE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. After the owner approves the escalation, an SMTP client library is added at an exact version with `npm audit --audit-level=moderate` passing.
  2. SMTP is offered only when the deployment declares self-hosted mode; on Vercel the choice is not shown and the server refuses it.
  3. **Egress limits:** only ports 465 (implicit TLS) and 587 (STARTTLS required) are accepted. The host is resolved at connect time, and every resolved address in a private, loopback, link-local, carrier-grade NAT, multicast or unspecified range, IPv4 or IPv6, is refused before connecting, including a name that resolves to `127.0.0.1` or `169.254.169.254`. There is a short connect timeout, and no fallback to Resend on failure.
  4. **The secret is encrypted and write-only:** the password is encrypted with a key from the environment before it is stored; no route, page, export, log or audit row returns it, and the page shows only that it is set and when.
  5. Send test email works through SMTP to the owner's own address against a local fake server in the test.
- **Test approach:** `tests/smtp-egress.test.ts` (new: port, address-range and DNS cases with a fake resolver), `tests/mail-settings.test.ts`.
- **Docs:** `docs/security.md`, `docs/deployment.md`.

### M8 Preview checkpoint

- **Owner steps:** set the Preview capture address (D27) and the Resend webhook secret, and add the webhook in Resend (owner steps); apply the M8 migrations in build order after the M7 ones, rerun the role template, run `scripts/db-role-evidence.ts` and `npm run test:live-roles`, then deploy.
- **Version:** `1.9.0` (D28).
- **What the owner tests on Preview:**
  - change a fictional notification rule and see the bell and email for a fictional event;
  - set My notification preferences and a digest;
  - edit a notification email template, preview it and send a test to yourself;
  - check that every Preview email reaches the capture address only;
  - as company owner, the Delivery log shows counts per team only; open a fictional team's Mail log as that team's owner to see its emails, and check that a second fictional team's emails appear nowhere for you there;
  - send a test email from the Mail page.
- **Data:** real candidate and employee data stays out of Preview; only fictional data is used.

## M9: Integrations

Contents: the Integrations page with team connections, the company token list and the AI switches (architecture §8, §14.11). MVP order 9.

### R2d-10 Integrations page: Team connections

- **Epics:** R2-09, R2-01.
- **Spec IDs:** IAM-008.
- **Mockup:** `#/integrations?tab=ai` (`screenshots/integrations-light.png`).
- **Reconciliation:** the AI connections tab becomes the **Team connections** tab of the Integrations page `/app/admin/integrations` for the current team (D33), and `/app/admin/tokens` redirects to it. The rest of the work is unchanged.
- **Size:** 2 h.
- **Depends on:** ADM-04, R2a-09.
- **Migration:** none.
- **Acceptance criteria:**
  1. The tab lists the team's API tokens and OAuth grants with holder, client, scopes, created, last used, expiry and calls per day for 30 days from `mcp-tool` activity.
  2. It shows each connection's tool-call audit and revokes through the existing `revokeToken`.
  3. Owners and admins see all connections, others their own.
  4. No token value or hash is shown.
  5. `/app/admin/tokens` redirects to it.
- **Test approach:** `tests/ai-connections-ui.test.tsx` (new), `tests/api-tokens.test.ts`, `tests/admin-redirects.test.ts` (new in ADM-04).
- **Docs:** `docs/mcp.md`, `docs/user-guide.md`.

### ADM-52 Company token list, revoke and limits view

- **Epics:** R2-09, R2-01.
- **Spec IDs:** IAM-008, API-007.
- **Mockup:** `#/integrations?tab=tokens`.
- **Size:** 3 h.
- **Depends on:** ADM-19, R2d-10.
- **Migration:** adds the owner-run helper `tenant_context.revoke_workspace_token(token_id uuid)` (new), callable only from a session context of a company owner, which revokes a token of any team in the workspace and writes one audit row. Role template: `EXECUTE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. The company **API tokens** tab (company owner only) lists every token and AI app of the workspace from `tenant_context.workspace_tokens()` with holder, team, scopes, created, last used and expiry, never values or hashes.
  2. **Revoke** works for any team's token after a fresh sign-in, through the helper, and the token stops working at once.
  3. A read-only view shows rate limits per token and the CV upload rate per team.
  4. The user detail page gains **Tokens and apps** with the same list for one person.
  5. Anyone but a company owner is refused by the route and by the helper.
- **Test approach:** `tests/api-tokens.test.ts`, `tests/admin-portal-ui.test.tsx`; `scripts/live-role-tests.ts` revoke-helper-denied case.
- **Docs:** `docs/user-guide.md`, `docs/mcp.md`.

### R2d-11 Per-connection limits and workspace AI switches

- **Epics:** R2-09.
- **Spec IDs:** none (R2-09 limits and switches).
- **Mockup:** `#/integrations?tab=ai` (limits and company switches).
- **Reconciliation:** the workspace switches sit on the Integrations page's company tab; the work is unchanged.
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

### M9 Preview checkpoint

- **Owner steps:** apply the M9 migrations in build order after the M8 ones, rerun the role template, run `scripts/db-role-evidence.ts` and `npm run test:live-roles`, then deploy.
- **Version:** `1.10.0` (D28).
- **What the owner tests on Preview:**
  - Team connections for a fictional team: limits, read-only, no CV text and revoke, with Claude or ChatGPT on Preview;
  - the company token list as company owner, and revoke a fictional member's token;
  - the AI switches;
  - `/app/admin/tokens` lands on Team connections.
- **Data:** real candidate and employee data stays out of Preview; only fictional data is used.

## M10: Health and audit

Contents: the public health endpoint, health checks and the Health page, scheduled jobs and hygiene, the sign-in log, one audit log, closing AUD-001 and admin search (architecture §14.12, §14.13). MVP order 10.

### ADM-53 Public health endpoint and request ids

- **Epics:** R2-17.
- **Spec IDs:** OBS-002, API-009, OBS-063.
- **Mockup:** none.
- **Size:** 2 h.
- **Depends on:** ADM-01.
- **Migration:** none.
- **Acceptance criteria:**
  1. `GET /api/health` (new, public) returns only `{ "status": "ok" }` or `{ "status": "degraded" }`, with no version, host, database or error detail.
  2. Every API response carries `X-Request-Id`, and every API log line carries the same id, with no personal data.
  3. `/api/version` is unchanged.
- **Test approach:** `tests/health-endpoint.test.ts` (new), `tests/openapi-contract.test.ts`.
- **Docs:** `docs/deployment.md`, `docs/security.md`.

### ADM-54 Health checks, Run now and alerts

- **Epics:** R2-17.
- **Spec IDs:** OBS-001, OBS-003.
- **Mockup:** `#/health` (checks).
- **Size:** 3 h.
- **Depends on:** ADM-42, ADM-53.
- **Migration:** extends the area check with `monitoring` (new grantable area); adds `app.health_checks` (new, company level; check key, state, latency, detail without secrets, time), written only by an owner-run helper. Role template: `SELECT` and `EXECUTE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. Checks cover the database and its latency, the storage schema marker, Blob, Resend configuration, the last cron run, the configured URL and tokens near expiry, run by cron and by **Run now**, with a history.
  2. A failed critical check alerts company owners in the app and by email once until it recovers.
  3. Company owners and company admins with `monitoring` read it; nobody else does.
  4. No check result holds a secret, token or personal data.
- **Test approach:** `tests/health-checks.test.ts` (new), `tests/notification-rules.test.ts`.
- **Docs:** `docs/user-guide.md`, `docs/deployment.md`.

### ADM-55 Health page: Vercel mode, usage, storage and performance

- **Epics:** R2-17.
- **Spec IDs:** OBS-010, OBS-012, OBS-014, OBS-020, OBS-021, OBS-030, OBS-031, OBS-062.
- **Mockup:** `#/health` (`screenshots/health-light.png`).
- **Size:** 3 h.
- **Depends on:** ADM-54.
- **Migration:** adds `app.usage_daily` (new, company level; counts per team and day) and the owner-run roll-up helper (new) that a nightly cron calls, counts only. Role template: `SELECT` and `EXECUTE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. `/app/admin/health` shows the deployment id, commit and region, the database size and connections read from the database, Blob totals and per-team usage, and Speed with 24 h, 7 d and 30 d ranges against the §12 targets.
  2. Usage per team (active users, records, storage) comes from the nightly roll-up; CSV export goes through `safeCsvCell`.
  3. About's **Copy details** adds the latest health results, without secrets or personal data.
  4. Team owners keep their team's Speed tab (D33).
- **Test approach:** `tests/health-page.test.ts` (new), `tests/admin-portal-ui.test.tsx`.
- **Docs:** `docs/user-guide.md`, `docs/validation.md`.

### ADM-56 Scheduled jobs, queue, long-running tasks and configuration hygiene

- **Epics:** R2-17.
- **Spec IDs:** OBS-040, OBS-050, OBS-051, OBS-052, FLD-016.
- **Mockup:** `#/health` (jobs, queue and hygiene).
- **Size:** 3 h.
- **Depends on:** ADM-55, R2c-07.
- **Migration:** none.
- **Acceptance criteria:**
  1. Scheduled jobs list last run, status and **Run now** (audited).
  2. Long-running tasks (workflow migrations, imports, bulk CV intake) show progress.
  3. The queue view shows outbox depth, the oldest item and failures, with audited retry and purge.
  4. Configuration hygiene lists unused fields, unbound workflows, roles nobody holds, empty groups and expired tokens, each linking to its page.
- **Test approach:** `tests/health-page.test.ts` (new in ADM-55), `tests/outbox.test.ts`.
- **Docs:** `docs/user-guide.md`.

### ADM-57 Self-hosted Linux mode and protected metrics

- **Epics:** R2-17.
- **Spec IDs:** OBS-011, OBS-020.
- **Mockup:** `#/health` (self-hosted view).
- **Size:** 3 h.
- **Depends on:** ADM-55.
- **Queued only if** the owner chooses Release 2 in D25; otherwise it moves after `2.0.0` unchanged.
- **Migration:** none.
- **Acceptance criteria:**
  1. In self-hosted mode the Health page shows CPU, memory, disk, uptime and Node version per server, **read from `/proc`** and `fs.statfs`; a test shows no shell command or child process is started.
  2. **Metrics behind authentication:** an optional `/metrics` needs a bearer token from the environment or listens only on a private address; without either it is off. On Vercel it does not exist.
  3. Nothing in the output holds secrets or personal data.
- **Test approach:** `tests/linux-health.test.ts` (new, with fixture `/proc` files).
- **Docs:** `docs/deployment.md`, `docs/security.md`.

### ADM-58 Sign-in log

- **Epics:** R2-17.
- **Spec IDs:** IAM-038.
- **Mockup:** `#/audit` (sign-in entries).
- **Size:** 3 h.
- **Depends on:** ADM-09.
- **Migration:** adds `app.sign_in_events` (new, workspace level; user id, event, outcome, time, coarse client), written only by the owner-run helper `tenant_context.record_sign_in_event(...)` (new) from Better Auth's hooks, readable by company owners and admins through a read helper, and purged after 1 year (D26). Role template: `EXECUTE` for the roles that run sign-in and `recruitmentos_data`; no direct write. Marker: +1.
- **Acceptance criteria:**
  1. Sign-ins, failures, two-step events and token use are recorded without passwords, codes or token values.
  2. A runtime role cannot write or change a row directly.
  3. Company owners and admins read the log; others are refused by the route and by the helper.
  4. Entries older than 1 year are purged.
- **Test approach:** `tests/sign-in-log.test.ts` (new), `tests/auth-flows.test.ts`; `scripts/live-role-tests.ts` direct-write-denied case.
- **Docs:** `docs/authentication.md`, `docs/security.md`.

### ADM-59 Audit page: one audit log with export and retention

- **Epics:** R2-17.
- **Spec IDs:** AUD-003, AUD-004, AUD-007.
- **Mockup:** `#/audit` (`screenshots/audit-light.png`).
- **Size:** 3 h.
- **Depends on:** ADM-58.
- **Migration:** adds the owner-run read helper `tenant_context.workspace_activity(...)` (new; admin actions across the workspace as metadata only, in the pattern of `tenant_context.config_history`) and an owner-run retention helper that deletes entries older than the period (3 years by default, D26) and keeps erasure redaction. Role template: `EXECUTE` for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. `/app/admin/audit` has **Configuration**, **Access changes**, **Activity** and **Sign-in log** tabs, with filters and a before-and-after view of configuration versions that never shows bracket figures or secrets.
  2. **CSV export, itself audited:** company owners export through `safeCsvCell`, and each export writes one audit row.
  3. The Activity tab returns no team id, record id or value of another team.
  4. Retention deletes only entries older than the period; erased entries stay redacted.
  5. `/app/admin/history` redirects to it.
- **Test approach:** `tests/audit-log.test.ts` (new), `tests/config-store.test.ts`, `tests/admin-redirects.test.ts`.
- **Docs:** `docs/user-guide.md`, `docs/security.md`.

### ADM-60 Close AUD-001: drop the runtime UPDATE grant on app.activity

- **Epics:** R2-17.
- **Spec IDs:** AUD-001.
- **Mockup:** none.
- **Size:** 2 h.
- **Depends on:** ADM-10, ADM-59.
- **Migration:** `REVOKE UPDATE ON app.activity FROM recruitmentos_data`. Role template: `infrastructure/postgres-split-runtime-roles.sql` grants only `SELECT, INSERT` on `app.activity` (line 101 today grants `UPDATE` too), with the matching lists in `scripts/runtime-role-template.ts` and `src/db/connection-boundary.ts`. Marker: unchanged (no code depends on the revoke; `scripts/db-role-evidence.ts` reports drift until the role template is rerun).
- **Acceptance criteria:**
  1. Every path that redacts activity is an owner-run helper (`tenant_context.erase_candidate`, `tenant_context.erase_employee`, `tenant_context.anonymise_user`, the retention helper); any that is not is moved into one.
  2. **The runtime `UPDATE` grant on `app.activity` is removed:** an `UPDATE` by the data role fails with `42501` on privileges, not only in `app.prevent_activity_mutation()`.
  3. Candidate erasure, employee erasure and user anonymisation still redact as before.
  4. `scripts/db-role-evidence.ts` shows zero drift after the role template is rerun.
- **Test approach:** `tests/runtime-role-grants.test.ts`, `tests/candidate-erasure.test.ts`, `tests/employee-erasure.test.ts`, `tests/user-anonymisation.test.ts`; `scripts/live-role-tests.ts` activity-update-denied-on-privilege case, directly and through the pooler.
- **Docs:** `docs/security.md`, `docs/identity-boundary-plan.md`, `docs/deployment.md`.

### ADM-61 Admin search

- **Epics:** R2-01.
- **Spec IDs:** UI-002.
- **Mockup:** `#/home` (the "Search admin" box in the shell).
- **Size:** 2 h.
- **Depends on:** ADM-59.
- **Migration:** none.
- **Acceptance criteria:**
  1. Ctrl+K (or the search box) finds admin pages, users, groups, roles, fields and workflows by name or key.
  2. Results list only what the caller can open, and never record data.
  3. It works by keyboard and with a screen reader.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (search cases).
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### M10 Preview checkpoint

- **Owner steps:** apply the M10 migrations in build order after the M9 ones, rerun the role template (it drops the `UPDATE` grant on `app.activity`), run `scripts/db-role-evidence.ts` (zero drift) and `npm run test:live-roles` directly and through the pooler, then deploy.
- **Version:** `1.11.0` (D28).
- **What the owner tests on Preview:**
  - `/api/health` shows only the state;
  - the Health page: checks with Run now, usage, storage and Speed ranges;
  - scheduled jobs and the queue view;
  - the Audit page tabs, the sign-in log and an audited CSV export;
  - erase a fictional candidate and check the audit entries are redacted;
  - find a fictional user and a field with Ctrl+K.
- **Data:** real candidate and employee data stays out of Preview; only fictional data is used.

## M11: Boards, shared views and the stakeholder home

Contents: R2-05 boards and views and R2-11 stakeholder views, with R12-01 (architecture §5). After the MVP; it depends only on M6 and R2a, so it can follow M6 if the owner prefers.

### R2c-15 Boards engine

- **Epics:** R2-05.
- **Spec IDs:** none (R2-05 boards).
- **Mockup:** none.
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

### R2c-16 Boards page and board screens

- **Epics:** R2-05, R2-01.
- **Spec IDs:** none (R2-05 boards).
- **Mockup:** none.
- **Reconciliation:** was "Boards tab and board screens". The admin side becomes the Boards page `/app/admin/boards` in the Configuration group (architecture §14.1). The rest of the work is unchanged.
- **Size:** 3 h.
- **Depends on:** ADM-01, R2c-15.
- **Migration:** none.
- **Acceptance criteria:**
  1. Company admins with the `boards` area (and company owners) create and publish boards on `/app/admin/boards`.
  2. The Applications screen offers the team's boards with swimlanes, quick filters, chosen card fields, WIP warnings and list and board modes.
  3. The default board looks as today's.
  4. Moving a card runs a transition, with the existing optimistic update and rollback.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (new in R2a-11), `tests/workspace-render.test.tsx`, `tests/optimistic-actions.test.ts`.
- **Docs:** `docs/user-guide.md`, `docs/accessibility-checklist.md`.

### R2c-17 Shared views

- **Epics:** R2-05.
- **Spec IDs:** none (R2-05 shared views).
- **Mockup:** none.
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
- **Spec IDs:** NTF-054.
- **Mockup:** none.
- **Reconciliation:** the stakeholder home also holds **My approvals** (NTF-054), the approvals waiting for the member; the work is otherwise unchanged.
- **Size:** 3 h.
- **Depends on:** R2a-19, R2c-04, R2c-15.
- **Migration:** none.
- **Acceptance criteria:**
  1. Members with the hiring manager or interviewer role land on a simple home screen: their vacancies, candidates on them, interviews and feedback, approvals waiting.
  2. Every list comes from scoped queries.
  3. The screen shows nothing outside scope and no tab for pages the role lacks.
- **Test approach:** `tests/stakeholder-home.test.tsx` (new), `tests/org-scope.test.ts`.
- **Docs:** `docs/user-guide.md`.

### M11 Preview checkpoint

- **Owner steps:** apply the M11 migrations, if any, in build order after the M10 ones, rerun the role template, run `scripts/db-role-evidence.ts` and `npm run test:live-roles`, then deploy.
- **Version:** `1.12.0` (D28).
- **What the owner tests on Preview:**
  - build a board with swimlanes by vacancy on the Boards page;
  - share a view, and check a private view cannot be shared;
  - sign in as the fictional hiring manager and use the home screen and My approvals.
- **Data:** real candidate and employee data stays out of Preview; only fictional data is used.

## M12: Templates and documents

Contents: the rest of R2-08 templates with R12-07 (architecture §7). After M8 (R2d-01, R2d-02) and M6 (approvals).

### R2d-03 Template file upload through the CV storage path

- **Epics:** R2-08.
- **Spec IDs:** none (R2-08 template files).
- **Mockup:** none.
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
- **Spec IDs:** none (R2-08 Word templates).
- **Mockup:** none.
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
- **Spec IDs:** none (R2-08 PDF templates).
- **Mockup:** none.
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
- **Spec IDs:** none (R2-08 PDF placement).
- **Mockup:** none.
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
- **Spec IDs:** NTF-043.
- **Mockup:** none.
- **Reconciliation:** the builder also edits notification email bodies on the Notifications > Templates tab (ADM-46); the work is otherwise unchanged.
- **Size:** 3 h.
- **Depends on:** R2d-01, R2d-05, ADM-46.
- **Migration:** none.
- **Acceptance criteria:**
  1. Admins compose blocks (heading, paragraph with merge fields, field table, signature line, conditional block, page break), reordered by drag or by move up and down.
  2. The same blocks render to email text and escaped HTML, to PDF, and, after the owner approves the `docx` escalation, to DOCX.
  3. A notification email template can be edited with the same blocks.
- **Test approach:** `tests/template-render.test.ts` (new in R2d-04; builder cases), `tests/admin-portal-ui.test.tsx` (new in R2a-11).
- **Docs:** `docs/user-guide.md`.

### R2d-08 Generated documents, preview and approval before sending

- **Epics:** R2-08, R12-07.
- **Spec IDs:** none (R2-08 generated documents).
- **Mockup:** none.
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

### R2d-09 Templates page

- **Epics:** R2-08, R2-01.
- **Spec IDs:** NTF-040, NTF-041, NTF-042, NTF-043, NTF-044.
- **Mockup:** none.
- **Reconciliation:** was "Templates tab". It becomes the Templates page `/app/admin/templates` in the Configuration group for candidate emails and documents; staff notification emails stay on Notifications > Templates (ADM-46). The work is otherwise unchanged.
- **Size:** 2 h.
- **Depends on:** ADM-01, R2d-07, R2d-08.
- **Migration:** none.
- **Acceptance criteria:**
  1. Company admins with the `templates` area (and company owners) list, create (upload Word, upload PDF, builder), version, preview and publish templates on `/app/admin/templates`.
  2. They see each template's merge fields and approval group.
  3. Every publish appears in the Audit page's Configuration tab.
- **Test approach:** `tests/admin-portal-ui.test.tsx` (new in R2a-11; templates cases).
- **Docs:** `docs/user-guide.md`.

### M12 Preview checkpoint

- **Owner steps:** apply the M12 migrations in build order after the M11 ones, rerun the role template, run `scripts/db-role-evidence.ts` and `npm run test:live-roles`, set nothing new for Resend beyond M8's settings, then deploy.
- **Version:** `1.13.0` (D28).
- **What the owner tests on Preview:**
  - upload a fictional Word offer letter and a fictional PDF form, place fields and build an email template;
  - preview, generate and send to the capture address, with approval before an offer letter goes out;
  - check that the hidden amount never appears for the hiring manager, including in the logged offer email and the generated letter.
- **Data:** real candidate and employee data stays out of Preview; only fictional data is used.

## M13: Recruitment plan and Release 2 completion

Contents: R2-10 recruitment plan (architecture §9) and the Release 2 security review. After M4 (Plan & pay access and `tenant_context.allows_plan`), M6 and M11. The last item of the plan is R2d-15.

### R2d-12 Recruitment plan model

- **Epics:** R2-10.
- **Spec IDs:** none (R2-10 recruitment plan).
- **Mockup:** none.
- **Reconciliation:** `tenant_context.allows_plan(uuid, text)` already exists from ADM-25 (salary brackets), so this item reuses it rather than adding it. The rest of the work is unchanged.
- **Size:** 3 h.
- **Depends on:** R2a-10, R2a-13, ADM-25.
- **Migration:** adds `app.plans`, `app.plan_versions` and `app.plan_lines` (new) with row policies through the existing `tenant_context.allows_plan(uuid, text)`. Role template: `SELECT, INSERT, UPDATE` on the three tables for `recruitmentos_data`. Marker: +1.
- **Acceptance criteria:**
  1. `src/lib/plans.ts` (new) and routes under `/api/v1/plans` (new) hold multi-year plans by org unit with yearly or quarterly lines, headcount and cost in AED fils.
  2. Approved versions are immutable.
  3. A context without `plans:read` and a plan-access grant reads no plan row. This holds for a team owner, a company admin and a company owner who has not granted themselves access, by the service and by direct SQL.
  4. Plan figures appear in no search, notification, activity metadata or MCP result.
- **Test approach:** `tests/plans.test.ts` (new); `tests/openapi-contract.test.ts`; `scripts/live-role-tests.ts` plan-confidentiality cases, including a team-B owner.
- **Docs:** `docs/security.md`, `docs/api-examples.md`, `docs/identity-boundary-plan.md`.

### R2d-13 Plan editor, versions and approval

- **Epics:** R2-10.
- **Spec IDs:** none (R2-10 plan editor and approval).
- **Mockup:** none.
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
- **Spec IDs:** none (R2-10 plan versus actual).
- **Mockup:** none.
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
- **Spec IDs:** IMP-008, TST-001, TST-011, TST-012, TST-014, TST-017.
- **Mockup:** none.
- **Reconciliation:** depends on every earlier item of this plan, not only R2d-01 to R2d-14; reviews the Admin portal threats T-R2-17 to T-R2-32 of architecture §14.15 as well; and adds the cross-cutting checks the spec pack lists for the whole portal. Items deferred by D25, D29 or D31 are listed as not built.
- **Size:** 3 h.
- **Depends on:** every earlier item in this plan (ADM-01 to ADM-61, R2b-02 to R2b-12, R2c-01 to R2c-18 and R2d-01 to R2d-14), except items the owner deferred by D25, D29 or D31.
- **Migration:** none.
- **Acceptance criteria:**
  1. `docs/security.md` and `docs/identity-boundary-plan.md` describe the final Release 2 boundary, including the Admin portal.
  2. The proposed SRS §10.1 additions (threats T-R2-1 to T-R2-16 of architecture §11.7 and T-R2-17 to T-R2-32 of §14.15) are written into `docs/requirements/register.md` for owner review.
  3. `package.json` and `package-lock.json` say `2.0.0`.
  4. The full validation set and `npm audit --audit-level=moderate` pass.
  5. `npm run bench:round-trips -- --fixture` results are recorded in `docs/validation.md` with the counts of architecture §12.
  6. Tests confirm that hidden records are left out of pagination totals (TST-011), linked records outside scope show as restricted (TST-012), assignee pickers list team members only (TST-014), and every record route answers 404, not 403, for a record outside scope (TST-017).
- **Test approach:** the full suite, the benchmark and `scripts/live-role-tests.ts` on a throwaway cluster and pooler.
- **Docs:** `docs/security.md`, `docs/identity-boundary-plan.md`, `docs/validation.md`, `docs/deployment.md`, `docs/ROADMAP.md`.

### M13 Preview checkpoint

- **Owner steps:** apply the M13 migrations in build order after the M12 ones, rerun the role template, run `scripts/db-role-evidence.ts` and `npm run test:live-roles` directly and through the pooler, then deploy.
- **Version:** `2.0.0`, Release 2 complete (D3, D28); Production later launches Releases 1 and 2 together after the go-live gate.
- **What the owner tests on Preview:**
  - build a fictional ten-year plan by division in AED, approve a version and compare plan with actual;
  - confirm plan figures and salary brackets are hidden from anyone without Plan & pay access, including the owner of a second fictional team;
  - confirm a plan cell with fewer than 5 accepted offers shows no spend;
  - walk the Admin portal end to end as company owner, as a fictional company admin with one area, and as a fictional team owner.
- **Data:** real candidate, employee, pay and plan data stays out of Preview; only fictional data is used.
