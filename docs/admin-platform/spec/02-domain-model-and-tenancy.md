# 02 — Domain Model & Tenancy

## 1. Hierarchy

```
Instance (1)
├── Global configuration (branding, base URL, mail, security policies, global permissions)
├── Directories → Users, Groups (nested), Customer accounts
├── Teams (global; can work across workspaces)
├── Shared configuration objects (schemes, workflows, fields, screens, item types, statuses, calendars)
├── Workspace categories
└── Workspaces (N)  — type: software | service | business
     ├── Key, name, lead, avatar, category, description
     ├── Role memberships (role → users / groups / teams)
     ├── Scheme associations (one of each type)
     ├── Components, versions/releases (software)
     ├── Request types, queues, SLAs, portal settings, customer organisations (service)
     └── Items
```

| ID | Requirement |
|----|-------------|
| DOM-001 | There is exactly one **Instance**. It is not a database row users can create; it is the root configuration context. |
| DOM-002 | A **Workspace** has a unique, immutable-after-items-exist **key** (`^[A-Z][A-Z0-9_]{1,9}$`) used for item keys (`FIN-123`). Key change is allowed only via an admin "Change key" wizard that retains old keys as redirects (Jira behaviour). |
| DOM-003 | Workspace **types**: `software` (boards, sprints, versions), `service` (portal, request types, queues, SLAs, customers), `business` (simple task tracking). Type governs which settings pages and templates appear; permissions/schemes model is common to all. |
| DOM-004 | A Workspace has exactly one **lead** (user) used as default assignee option and as notification recipient type. |
| DOM-005 | Workspaces can be **archived** (read-only, hidden from navigation, excluded from licence-relevant search) and **restored**. Deletion moves to a 30-day **trash** before permanent purge (configurable). |
| DOM-006 | **Workspace categories** group workspaces for navigation, reporting and filtering. |
| DOM-007 | **Teams** are global objects (not owned by a workspace). A team can be granted roles in many workspaces. |
| DOM-008 | **Workspace templates**: creating a workspace from a template pre-selects schemes, item types, request types and default roles membership. Option "Share settings with an existing workspace" associates the **same** schemes (does not copy) — Jira behaviour. |

## 2. Entity summary

| Entity | Scope | Owned by | Notes |
|--------|-------|----------|-------|
| User | Instance | Directory | Licensed or customer-only |
| Group | Instance | Directory | Nested; may be flagged as approval group |
| Team | Instance | Admin / team lead | Has members and a lead |
| Workspace role | Instance (definition) / Workspace (membership) | Admin | |
| Global permission grant | Instance | System admin | |
| Admin scope grant | Instance | System admin | |
| Item type | Instance | Admin | Standard + sub-task types |
| Item type scheme | Instance | Admin | Allowed item types per workspace + default |
| Status | Instance | Admin | Shared across workflows |
| Resolution | Instance | Admin | Done, Won't do, Duplicate, Cannot reproduce… |
| Priority (+ priority scheme) | Instance | Admin | |
| Workflow / workflow scheme | Instance | Admin | |
| Custom field / context | Instance | Admin | |
| Field configuration / scheme | Instance | Admin | |
| Screen / screen scheme / item type screen scheme | Instance | Admin | |
| Permission scheme | Instance | Admin | |
| Item security scheme | Instance | Admin | |
| Notification scheme | Instance | Admin | |
| SLA calendar | Instance | Admin | Working hours, holidays (supports UAE weekend Sat–Sun and regional holiday sets) |
| SLA definitions | Workspace (service) | Workspace admin | |
| Request type | Workspace (service) | Workspace admin | |
| Queue | Workspace (service) | Workspace admin | Saved filter + columns |
| Customer organisation | Instance (shared) / linked to workspaces | Admin / workspace admin | |

## 3. Item types

| ID | Requirement |
|----|-------------|
| DOM-020 | Item types are global: name, description, icon, hierarchy level (`epic` = 1, `standard` = 0, `subtask` = -1). |
| DOM-021 | **Item type schemes** define which item types a workspace may use and the default type. |
| DOM-022 | Deleting an item type in use requires a migration wizard (choose replacement type per workspace; remap workflow statuses and fields where they differ). |
| DOM-023 | Default seeded types: Epic, Story, Task, Bug, Sub-task (software/business); Incident, Service request, Change, Problem, Access request (service). |

## 4. Schemes — the central configuration pattern

Every workspace references exactly **one** of each scheme below. Schemes are shared; editing one affects every associated workspace.

| Scheme | Resolves | Defined in spec |
|--------|----------|-----------------|
| Item type scheme | Which item types are allowed | 02 §3 |
| Workflow scheme | Item type → Workflow | 05 |
| Item type screen scheme | Item type → Screen scheme → (Create / Edit / View) → Screen | 06 |
| Field configuration scheme | Item type → Field configuration | 06 |
| Permission scheme | Workspace permission → grantees | 04 |
| Item security scheme (optional) | Security levels → grantees | 04 |
| Notification scheme | Event → recipients × channels | 07 |
| Priority scheme | Allowed priorities + default | 02 |

| ID | Requirement |
|----|-------------|
| DOM-030 | Each scheme list page shows **"Used by"** (count + workspace names) and supports *Copy*, *Edit*, *Delete* (only if unused), *Associate to workspaces*. |
| DOM-031 | The system provides a **"Default"** scheme of each type; it cannot be deleted and is used when a workspace is created without a template. |
| DOM-032 | Changing a workspace's workflow scheme, item type scheme or field configuration scheme triggers a **migration wizard** when existing items would become invalid (status not in new workflow, type not allowed, required field empty). Migration runs as a background job with progress and audit. |
| DOM-033 | The **Workspace configuration summary** page (workspace settings) shows the fully resolved configuration: per item type → workflow, screens per operation, field configuration, plus permission/notification/security schemes, each linked to its editor. |
| DOM-034 | **Shared-configuration indicator**: workspace admins see "This scheme is shared by N workspaces" and, if they hold only workspace-admin rights, can edit only workspace-scoped elements (Jira "extended project administration" behaviour: workspace admins may edit a workflow/screen **only** if it is used solely by their workspace and the setting `allowWorkspaceAdminConfigEdit` is on). |

## 5. Scoping rules

| ID | Rule |
|----|------|
| DOM-040 | Every query for workspace-scoped data must include a workspace filter derived from permission-checked context. Repository methods without a workspace parameter are forbidden for workspace-scoped tables. |
| DOM-041 | Cross-workspace search (JQL-equivalent) applies *Browse workspace* and item security per row; results never leak counts of hidden items. |
| DOM-042 | Global objects referenced by a workspace (e.g. field, status) may be **read** by anyone with *Browse workspace* on that workspace, but only edited by holders of the matching admin scope. |
