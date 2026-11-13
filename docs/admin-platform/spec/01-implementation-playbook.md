# 01 — Implementation Playbook (Brownfield)

> The application already has partial versions of users, roles, groups, permissions, workflows, fields, notifications and admin pages, "but not created properly". This playbook tells Claude Code **how to converge the existing code onto the target spec safely**, without a big-bang rewrite and without losing data.

---

## 1. Phase 0 — Discovery & gap analysis (mandatory, no feature code)

### 1.1 Discovery steps

| Step | Action | Output |
|------|--------|--------|
| D-1 | Identify stack: language(s), framework(s), ORM, DB, cache, queue, front-end framework, component library, test framework, CI. | `AS-IS.md` §Stack |
| D-2 | Inventory **all data models/tables** touching: user, account, profile, role, group, team, member, permission, org, workspace/project, workflow, status, transition, field, form, screen, notification, email, template, setting, config, theme, branding, audit, log. | `AS-IS.md` §Data model (table, columns, row counts if DB available) |
| D-3 | Inventory **all authorisation checks**. Search for patterns such as: `role ==`, `role ===`, `isAdmin`, `is_admin`, `hasRole`, `can(`, `authorize`, `@PreAuthorize`, `@Roles`, `permission`, `policy`, middleware guards, route guards, UI `v-if`/`*ngIf`/`{user.role &&` checks. | `AS-IS.md` §Auth checks — table: file, line, check, what it protects |
| D-4 | Inventory **admin routes and screens** (front-end routes + back-end endpoints). | `AS-IS.md` §Admin surface |
| D-5 | Inventory **workflow/status logic**: hard-coded status enums, status transition code, approval logic, state machines. | `AS-IS.md` §Workflow |
| D-6 | Inventory **field/form definitions**: hard-coded form schemas, JSON-schema forms, dynamic field tables, per-workspace duplicated fields. | `AS-IS.md` §Fields |
| D-7 | Inventory **email/notification sending**: every call site that sends an email or creates a notification; templates; SMTP config source (env vs DB). | `AS-IS.md` §Notifications |
| D-8 | Inventory **settings/config**: env vars, config files, settings tables; base URL usage (hard-coded hosts, `localhost`, string-concatenated links). | `AS-IS.md` §Config |
| D-9 | Inventory **monitoring**: health endpoints, metrics, logging, existing dashboards. | `AS-IS.md` §Observability |
| D-10 | Run existing tests; record pass/fail baseline and coverage. | `AS-IS.md` §Test baseline |

### 1.2 Gap matrix format (`GAP-MATRIX.md`)

One row per requirement ID from specs 02–12.

| Req ID | Requirement (short) | Current state | Evidence (file:line / table) | Classification | Action | Phase | Status |
|--------|--------------------|---------------|------------------------------|----------------|--------|-------|--------|
| PRM-012 | Every admin endpoint declares required scope | Some admin routes unguarded | `api/routes/items.ts:44` | **Defective** | Add guard via PermissionService | 1 | Not started |

**Classification values (use exactly):**

| Value | Meaning | Default action |
|-------|---------|----------------|
| `Compliant` | Exists and meets spec | Add tests only |
| `Defective` | Exists but violates spec (security, logic, UX) | Refactor in place; migrate data |
| `Partial` | Exists, missing sub-capabilities | Extend |
| `Divergent` | Exists with a materially different model (e.g. per-workspace fields) | Migrate to spec model via adapter + data migration; deprecate old |
| `Missing` | Does not exist | Build |

### 1.3 Phase 0 exit criteria

- [ ] `AS-IS.md` and `GAP-MATRIX.md` committed.
- [ ] Top-10 risk list (security holes first) at top of `GAP-MATRIX.md`.
- [ ] Proposed legacy → target **data mapping** for roles, groups, statuses and fields (see §4).
- [ ] **Human approval obtained** before Phase 1.

---

## 2. Delivery phases

Phases are ordered by dependency. Do not start a phase until its predecessors' exit criteria pass.

| Phase | Name | Specs | Key deliverables | Depends on |
|-------|------|-------|------------------|------------|
| 1 | **Foundations** | 02, 09 §8, 11 | Domain model (Instance/Workspace/Team), audit log service, admin shell (layout, nav, routing, admin scopes guard), settings store, feature-flag mechanism | 0 |
| 2 | **Identity** | 03 | Users, user directories, groups (nested), teams, approval groups, customers & organisations, auth policies (password, MFA, session, SSO), licences | 1 |
| 3 | **Authorisation** | 04 | Global permissions, admin scopes, workspace roles, permission schemes, item security, `PermissionService`, Permission Helper, access review export. **Remove all legacy inline checks.** | 2 |
| 4 | **Fields & screens** | 06 | Field registry, field types, contexts, field configurations + schemes, screens, screen schemes, item type screen schemes, request types | 3 |
| 5 | **Workflow engine** | 05 | Statuses, workflows, transitions, conditions/validators/post-functions, approvals, workflow schemes, designer, versioning & migration, SLAs | 4 |
| 6 | **Notifications & email** | 07 | Mail servers, templates, events, notification schemes, delivery pipeline, notification centre, user preferences, incoming mail | 5 |
| 7 | **Branding & system config** | 08 | Look & feel, base URL, general config, localisation, announcement banner | 1 (can run in parallel with 3–6) |
| 8 | **Observability & insights** | 09 | Health checks, performance analytics, cluster monitor, usage insights, config hygiene, job monitor, log levels | 1 (can run in parallel with 3–7) |
| 9 | **Hardening** | 12 | Full permission matrix tests, performance targets, a11y audit, security review, legacy code deletion | All |

---

## 3. Rules for touching existing code

| ID | Rule |
|----|------|
| IMP-001 | **Strangler pattern.** Introduce the new service behind an interface; route old call sites through it; delete old code only once every call site is migrated and tests pass. |
| IMP-002 | **Feature flags** (`admin.v2.<module>`) gate new admin screens until parity. Old screens remain reachable under flag-off until Phase 9. |
| IMP-003 | **No data loss.** Every schema change ships with a forward migration and a documented rollback. Destructive column drops happen only in Phase 9. |
| IMP-004 | **Legacy authorisation removal is tracked.** Every check found in D-3 gets a gap-matrix row; Phase 3 is not complete until the count of inline checks is **zero** (enforce with a lint rule or CI grep — see §6). |
| IMP-005 | **Do not change public API contracts silently.** If an existing endpoint must change, version it (`/api/v2/...`) and keep v1 with a deprecation header until Phase 9. |
| IMP-006 | **Seed defaults idempotently.** Seed scripts (spec 11 §6) must be safe to re-run and must not overwrite admin-customised records. |
| IMP-007 | **One module per PR series.** Keep PRs reviewable (< ~800 changed lines excluding generated code/tests where possible). |
| IMP-008 | **Tests first for security.** For each permission rule changed, write the failing test before the fix. |

---

## 4. Legacy data migration patterns

### 4.1 Legacy "role" column on user → target model

Typical legacy shape: `users.role IN ('admin','manager','user','viewer')`.

| Legacy value | Target mapping |
|--------------|----------------|
| `admin` / `superadmin` | Member of group `system-administrators` (holds *System administrator* global permission). Flag for human review — reduce to `instance-administrators` where full system access is not justified. |
| `manager` | Member of group `app-users`; workspace role **Administrators** in each workspace they previously managed (derive from ownership/creator tables if present; otherwise flag). |
| `user` / `member` | Member of group `app-users`; workspace role **Members** in workspaces they previously accessed. |
| `viewer` / `readonly` | Member of group `app-users`; workspace role **Viewers**. |
| `customer` / `external` | Customer account (portal-only, spec 03 §8); not a licensed user. |
| Unknown values | Write to `migration_exceptions` table; never silently drop. |

### 4.2 Legacy hard-coded statuses → workflows

1. Create one **Status** per distinct legacy status value; assign a status category (`TODO`, `IN_PROGRESS`, `DONE`).
2. Build a workflow `Legacy – <entity>` reproducing the implicit transitions found in code (D-5).
3. Assign it via a workflow scheme to all existing workspaces.
4. Migrate items: `items.status_id` ← mapped status.
5. Admins then refine the workflow in the designer.

### 4.3 Legacy per-workspace fields → central fields

1. Group legacy field definitions by (normalised name, type).
2. Create **one** custom field per group; create **one context per distinct option set/default**, scoped to the workspaces that used it.
3. Migrate values to `item_field_values` keyed by the new field ID.
4. Where two fields share a name but differ in type, create two fields and record in `migration_exceptions` for admin renaming.

### 4.4 Legacy env-based SMTP / base URL

Move to DB-backed settings (spec 07, 08). On first boot, **import** env values into the settings store once, then treat DB as authoritative; env vars remain as *bootstrap overrides* only when `CONFIG_LOCKED_BY_ENV=true` (shows a lock icon in the admin UI).

---

## 5. Definition of Done (per requirement)

- [ ] Server-side enforcement implemented through the correct central service.
- [ ] Admin UI implemented per spec 10 patterns (list/detail/editor, impact analysis, empty/error/loading states).
- [ ] REST endpoint documented (OpenAPI) per spec 11.
- [ ] Audit events emitted for all writes.
- [ ] Unit + integration tests; permission tests for allowed **and** denied cases.
- [ ] i18n keys added (en + ar placeholders); RTL verified for new screens.
- [ ] `GAP-MATRIX.md` row status set to `Done` with PR link.

---

## 6. CI guard-rails to add in Phase 1

| Guard | Implementation hint |
|-------|---------------------|
| No inline role checks | Lint rule / CI grep failing on regexes such as `\.role\s*===?\s*['"]`, `isAdmin\b` outside `PermissionService`. Maintain an allow-list file that must shrink to empty by end of Phase 3. |
| Every admin route guarded | Test that enumerates registered routes under `/api/admin/**` and `/admin/**` and asserts each declares a required admin scope or global permission. |
| Audit coverage | Test that every admin mutation endpoint produces exactly one audit event per changed entity. |
| OpenAPI drift | Generate OpenAPI from code; fail CI on undocumented endpoints. |
| Migration safety | Run migrations up/down/up against a copy of seed data in CI. |
