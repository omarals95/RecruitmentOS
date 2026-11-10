# 12 — Testing Strategy & Acceptance

## 1. Test layers

| Layer | Scope | Tooling (adapt to stack) | Gate |
|-------|-------|--------------------------|------|
| Unit | Permission resolution, condition/validator evaluators, template rendering, contrast calculator, URL builder, cron/SLA calendar maths | Project unit framework | PR |
| Integration | API + DB: every admin endpoint (allowed/denied), migrations, scheme association changes, outbox dispatch | Containerised DB/cache/queue | PR |
| Contract | OpenAPI conformance; SCIM compliance suite; webhook payload schemas | Schema validators | PR |
| E2E | Critical admin journeys (§4) in real browser, LTR + RTL, light + dark | Playwright/Cypress | Merge to main |
| Security | Permission matrix (§2), leak tests (§3), SAST, dependency scan, DAST on staging | | Release |
| Performance | Load & soak (§5) | k6/Gatling/JMeter | Release |
| Accessibility | axe automated on all admin routes + manual keyboard/screen-reader pass on designer, scheme editors, forms | axe-core | Release |

## 2. Permission test matrix (generated)

| ID | Requirement |
|----|-------------|
| TST-001 | A **table-driven test generator** enumerates: every workspace permission × each grantee type × (granted / not granted) × (item security level: none / matching / non-matching) and asserts `PermissionService` results and the corresponding API endpoint status codes (200/403/404). |
| TST-002 | Every `/api/v1/admin/**` endpoint tested with: anonymous (401), user without scope (403), user with a different scope (403), user with correct scope (2xx), `ADMIN` (2xx unless system scope), `SYSTEM_ADMIN` (2xx). |
| TST-003 | Nested group depth/cycle tests; role via team; role via group via nested group; deactivated user retains memberships but gets no access. |
| TST-004 | Lock-out protection tests (PRM-002). |
| TST-005 | `SYSTEM_ADMIN` without workspace role **cannot** browse workspace items (PermissionService §8.2 step 2). |

## 3. Data-leak tests (must all pass before release)

| ID | Vector | Assertion |
|----|--------|-----------|
| TST-010 | Search results & counts | Hidden items not returned and not counted |
| TST-011 | Pagination totals | `total` excludes hidden items or is omitted |
| TST-012 | Item links / parent / sub-items | Hidden linked items rendered as "restricted item" without summary |
| TST-013 | Notifications | No email/in-app for items the recipient cannot see; restricted comments/fields stripped |
| TST-014 | Mentions & user pickers | Respect `BROWSE_USERS`; mention of a user who can't see the item doesn't notify |
| TST-015 | Exports (CSV/API bulk) | Same filtering as UI |
| TST-016 | Webhooks | Payload filtered per webhook's configured actor permissions |
| TST-017 | Error messages | 404 (not 403) for items the caller cannot see, to avoid existence disclosure |
| TST-018 | Branding/announcement public endpoints | No confidential data |
| TST-019 | Host header injection | Emails/links always use configured base URL |

## 4. Critical E2E journeys

| # | Journey |
|---|---------|
| E2E-01 | Configure LDAP directory → test → sync → user logs in → appears with groups |
| E2E-02 | Configure SAML SSO with JIT → new user logs in → default groups applied → break-glass local admin still works |
| E2E-03 | Create group → nest into another → grant role in workspace via group → user gains access → Permission Helper explains chain |
| E2E-04 | Create approval group → workflow with 2-stage approval (manager then group `count:2`) → request raised on portal → approvals via email link and inbox → auto-transition → timeline correct |
| E2E-05 | Create custom field (select) → context scoped to 2 workspaces → add to create screen → mark required → create item → field validated server-side; API create without field → 422 |
| E2E-06 | Edit published workflow → remove a status in use → publish → migration wizard → items migrated → audit records present |
| E2E-07 | Change workspace workflow scheme → migration dry run → execute → verify |
| E2E-08 | Configure SMTP → test email → notification scheme rule → event triggers email with branded wrapper and base-URL links → delivery log shows `sent` |
| E2E-09 | User disables a non-mandatory notification → not sent → shown as `suppressed (preference)` |
| E2E-10 | Branding: upload logo/favicon, set accent with poor contrast → blocked with suggestion → accept → preview → publish → visible on login, app, email, portal; revert works |
| E2E-11 | Change base URL → verification → impact checklist → SAML SP metadata reflects new ACS |
| E2E-12 | Health check failure (stop mail server) → check turns red → admin alert sent → recovery notification |
| E2E-13 | Delegated admin with only `scope.fields.manage` sees only Fields & screens section; direct URL to `/admin/users` → 403 page |
| E2E-14 | Audit log filters/export; hash-chain verification passes; tampering simulation detected |
| E2E-15 | Arabic locale: admin & portal RTL, localised statuses/request types, Arabic email template preview |

## 5. Non-functional targets

| Metric | Target (reference load: 10k licensed users, 500 workspaces, 2M items, 300 custom fields) |
|--------|------------------------------------------------------------------------------------------|
| API p95 (reads) | < 300 ms |
| API p95 (writes / transitions) | < 600 ms |
| Item view page LCP | < 2.0 s (p75) |
| Admin list pages p95 | < 800 ms |
| Permission check p95 | < 2 ms warm / < 20 ms cold |
| Notification: event → email handed to provider | < 60 s p95 (non-digest) |
| In-app notification latency | < 5 s p95 |
| Health endpoint `/status` | < 50 ms |
| Workflow migration throughput | ≥ 1,000 items/min without degrading p95 API by > 20 % |
| Availability (clustered) | 99.9 % monthly, rolling upgrades without downtime |
| Audit write overhead | < 5 ms per admin write |

## 6. Module acceptance checklist

| Module | Accept when |
|--------|-------------|
| Identity (03) | All IAM-* rows `Done`; E2E-01/02 pass; SCIM compliance suite passes; licence counting verified |
| Permissions (04) | All PRM-* rows `Done`; TST-001–005 and TST-010–019 pass; **zero** inline role checks (CI guard green, allow-list empty) |
| Workflow (05) | All WFL-* `Done`; E2E-04/06/07 pass; designer a11y text mode works; loop guard verified |
| Fields & screens (06) | All FLD-*/SCR-* `Done`; E2E-05 pass; field explainer correct for all four failure reasons |
| Notifications & email (07) | All NTF-*/EML-* `Done`; E2E-08/09 pass; non-prod mail safety verified |
| Branding & system (08) | All BRD-*/SYS-* `Done`; E2E-10/11/15 pass; no hard-coded brand colours (lint green) |
| Observability & audit (09) | All OBS-*/AUD-* `Done`; E2E-12/14 pass; `/metrics` scraped successfully by Prometheus in staging |
| Admin IA (10) | All routes in sitemap exist, guarded, and pass axe with zero serious/critical violations |
| Legacy removal (01 Phase 9) | Feature flags removed; v1 legacy endpoints removed or formally deprecated; `migration_exceptions` all resolved or accepted |
