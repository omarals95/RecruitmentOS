# Enterprise Administration Platform — Specification Pack

> **Audience:** Claude Code (implementation agent) and the engineering team.
> **Reference model:** Atlassian Jira Software Data Center + Jira Service Management Data Center (users, groups, roles, permission schemes, workflows, screens, custom fields, notification schemes, system administration).
> **Status:** v1.0 — authoritative target state. The application **already contains partial, inconsistent implementations** of several modules. Every module must be **audited and brought to this spec**, not rebuilt blindly alongside the old code.

---

## 1. How Claude Code must use this pack

1. Read this README, then `01-implementation-playbook.md` **in full** before writing any code.
2. Run **Phase 0 (Discovery & Gap Analysis)** from the playbook. Produce `docs/admin-platform/AS-IS.md` and `docs/admin-platform/GAP-MATRIX.md`. **Stop and present the gap matrix for approval** before Phase 1.
3. Implement module-by-module in the phase order defined in the playbook. Each phase = one or more reviewable PRs.
4. Every requirement carries an ID (e.g. `IAM-012`). Reference IDs in commit messages, PR descriptions, test names and code comments where a non-obvious rule is enforced.
5. When this spec is silent or ambiguous, follow the **Jira Data Center behaviour** as the default, record the decision in `docs/admin-platform/DECISIONS.md` (ADR format), and continue.
6. Never weaken a security rule from this spec to make a test pass or a legacy screen work.

---

## 2. File index

| # | File | Scope | Requirement prefix |
|---|------|-------|--------------------|
| 00 | `00-README.md` | Index, principles, glossary | — |
| 01 | `01-implementation-playbook.md` | Discovery, gap analysis, phasing, migration of legacy features, definition of done | `IMP` |
| 02 | `02-domain-model-and-tenancy.md` | Instance → Workspace → Team hierarchy, item types, scoping rules, schemes concept | `DOM` |
| 03 | `03-identity-users-groups-teams.md` | Users, directories (local/LDAP/AD/Entra ID/SCIM/SAML/OIDC), groups, teams, approval groups, customers, licences, auth policies | `IAM` |
| 04 | `04-roles-and-permissions.md` | Global permissions, admin scopes, workspace roles, permission schemes, item security, permission evaluation engine, permission helper, access reviews | `PRM` |
| 05 | `05-workflow-engine.md` | Statuses, transitions, conditions, validators, post-functions, approvals, SLAs, workflow schemes, designer, versioning, migration | `WFL` |
| 06 | `06-custom-fields-and-screens.md` | Central field registry, field types, contexts, field configurations, screens, screen schemes, request types/portal forms | `FLD` / `SCR` |
| 07 | `07-notifications-and-email.md` | Outgoing/incoming mail servers, email templates, notification events, notification schemes, notification manager, in-app notification centre, delivery log | `NTF` / `EML` |
| 08 | `08-branding-and-system-configuration.md` | White-label look & feel, logos, favicon, colours, base URL, general settings, localisation, announcement banner | `BRD` / `SYS` |
| 09 | `09-observability-health-and-analytics.md` | Health checks, performance analytics, cluster/node monitor, usage insights, configuration hygiene, audit log, background jobs, logging | `OBS` / `AUD` |
| 10 | `10-admin-portal-information-architecture.md` | Full admin sitemap, routes, screen inventory, standard UI patterns, workspace-settings area, end-user settings | `UI` |
| 11 | `11-data-model-and-api.md` | Relational schema, REST API catalogue, domain events, caching, seed data | `DAT` / `API` |
| 12 | `12-testing-and-acceptance.md` | Test strategy, permission test matrix, non-functional targets, acceptance checklist per module | `TST` |

---

## 3. Non-negotiable design principles

| ID | Principle | What it means in code |
|----|-----------|-----------------------|
| P-01 | **Deny by default** | No permission ⇒ no access. No endpoint may be reachable without an explicit permission check. |
| P-02 | **Single permission engine** | All authorisation decisions go through one service (`PermissionService`). No inline `if (user.role === 'admin')` checks anywhere. Legacy checks must be removed (see playbook). |
| P-03 | **Scheme-based configuration** | Workspaces never own raw permission/workflow/screen/notification config. They **reference shared schemes**. Changing a scheme changes every workspace using it. This is the Jira model and is mandatory. |
| P-04 | **Centralised fields** | A custom field is defined **once** globally and scoped via **contexts**. No per-workspace duplicate field definitions. |
| P-05 | **Server is the source of truth** | UI hiding is cosmetic. Every rule (permission, required field, validator, condition) is re-enforced server-side. |
| P-06 | **Draft → Publish** for risky config | Workflows, branding, notification schemes and email templates are edited as drafts with preview, then published. Published versions are immutable and retained. |
| P-07 | **Impact analysis before change** | Any edit/delete of a shared object shows "used by N workspaces / M items / K users" and requires confirmation; destructive changes offer a migration wizard. |
| P-08 | **Everything audited** | Every admin write produces an immutable audit record (who, what, before, after, when, from where). |
| P-09 | **Everything addressable via API** | Every admin screen is a client of a documented REST API. No screen-only capabilities. |
| P-10 | **Explainable access** | For any (user, object, permission) the system can explain *why* access is granted or denied (Permission Helper). |
| P-11 | **Tenant-safe white-labelling** | Branding is data-driven (design tokens), never code forks. |
| P-12 | **Accessibility & i18n** | WCAG 2.2 AA; all strings externalised; RTL-ready (Arabic) layouts. |
| P-13 | **Idempotent, observable background work** | Email, notifications, index rebuilds and migrations run as queued jobs with retry, dead-letter and visibility in the admin portal. |

---

## 4. Glossary (Jira mapping)

| This application | Jira DC / JSM equivalent | Definition |
|------------------|--------------------------|------------|
| **Instance** | Jira instance / site | The whole deployment. Holds global config, users, groups, schemes. |
| **Workspace** | Project / Service desk | Container of work items with its own key (e.g. `FIN`), lead, roles membership and scheme associations. Has a *type*: `software`, `service`, `business`. |
| **Team** | Team (Advanced Roadmaps) | Operational unit of people with a lead; can be granted workspace roles, be assignee pools and approvers. |
| **Group** | Group | Administrative set of users (local or directory-synced) used to grant permissions. Supports nesting. |
| **Approval group** | JSM approver group | A group (flag `is_approval_group = true`) eligible to be targeted by workflow approval steps, with quorum rules. |
| **Workspace role** | Project role | Instance-defined role (e.g. *Administrators*, *Members*, *Agents*). Membership is set **per workspace**. |
| **Global permission** | Global permission | Instance-wide capability (e.g. *Administer instance*, *Create workspaces*). |
| **Admin scope** | (extension beyond Jira) | Granular delegated admin capability (e.g. *Manage users*, *Manage branding*). |
| **Permission scheme** | Permission scheme | Map of workspace permissions → grantees. Associated with workspaces. |
| **Item** | Issue / Request | A unit of work. |
| **Item type** | Issue type / Request type base | Task, Bug, Story, Incident, Service request, etc. |
| **Request type** | JSM request type | Customer-facing portal form mapped to an item type. |
| **Item security scheme** | Issue security scheme | Per-item visibility levels. |
| **Workflow** | Workflow | Statuses + transitions + rules. |
| **Workflow scheme** | Workflow scheme | Item type → workflow mapping. |
| **Custom field** | Custom field | Globally defined field. |
| **Field context** | Custom field context | Scope (workspaces × item types) + default value + options. |
| **Field configuration** | Field configuration | Required/hidden/renderer/description per field. |
| **Field configuration scheme** | Field configuration scheme | Item type → field configuration. |
| **Screen** | Screen | Ordered, tabbed set of fields. |
| **Screen scheme** | Screen scheme | Operation (create/edit/view) → screen. |
| **Item type screen scheme** | Issue type screen scheme | Item type → screen scheme. |
| **Notification scheme** | Notification scheme | Event → recipients × channels. |
| **Customer / Portal user** | JSM customer | External user with portal-only access; may belong to *Customer organisations*. |
| **SLA** | JSM SLA | Time goal with start/pause/stop conditions and calendars. |

---

## 5. Suggested `CLAUDE.md` addition

Paste this block into the repository's root `CLAUDE.md`:

```markdown
## Admin platform specification
- Target-state spec lives in `docs/admin-platform/` (files 00–12). It is authoritative.
- Before changing anything in auth, users, groups, roles, permissions, workflows, fields, screens,
  notifications, email, branding, base URL or admin analytics, read the relevant spec file.
- All authorisation goes through `PermissionService` (spec 04). Never add inline role checks.
- Workspaces reference shared schemes (spec 02 §4). Never store per-workspace copies of config.
- Every admin write must emit an audit event (spec 09 §8).
- Reference requirement IDs (e.g. `PRM-021`) in commits, PRs and tests.
- Record deviations/decisions in `docs/admin-platform/DECISIONS.md`.
- Track progress in `docs/admin-platform/GAP-MATRIX.md` (update status columns as work lands).
```

---

## 6. Out of scope for v1 (do not build unless asked)

| Item | Note |
|------|------|
| Marketplace / third-party app framework | Leave extension points (events, webhooks) only. |
| Full no-code automation rule builder | Workflow post-functions + webhooks cover v1. Design events so an automation engine can subscribe later (spec 05 §12). |
| Multi-instance federation | Single instance, clustered nodes. |
| Billing / commercial licence purchasing | Licence *tracking* only (spec 03 §10). |
