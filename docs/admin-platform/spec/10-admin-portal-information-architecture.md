# 10 — Admin Portal Information Architecture & Screen Inventory

## 1. Global layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Header: [Logo] Instance title | Admin search (⌘K) | Help | Notifications | Avatar │
├───────────────┬────────────────────────────────────────────────────────────┤
│ Admin sidebar │ Breadcrumbs › Page title            [Primary action] [⋯]   │
│ (sections by  │ Page description / help link                               │
│  admin scope) │ ─────────────────────────────────────────────────────────  │
│               │ Tabs (detail pages)                                         │
│               │ Content (list / detail / editor)                            │
│               │                                                             │
└───────────────┴────────────────────────────────────────────────────────────┘
```

| ID | Requirement |
|----|-------------|
| UI-001 | Admin portal at `/admin`, separate shell from the end-user app, reachable from the avatar menu ("Administration") only for principals holding any admin scope / global admin permission. |
| UI-002 | **Admin search (⌘K / Ctrl+K)**: jump to any admin page or object (user, group, field, workflow, scheme, workspace) by name or ID — Jira "Administration search" (`gg`). |
| UI-003 | Sidebar shows only sections permitted by scopes (PRM-011); collapsed state remembered; RTL-mirrored. |
| UI-004 | Websudo prompt (IAM-035) on entry and when the window expires; unsaved form state preserved. |

## 2. Sitemap

| Section | Page | Route | Required scope / permission | Spec |
|---------|------|-------|-----------------------------|------|
| **Overview** | Admin home | `/admin` | any admin scope | 09 §1 |
| **Users & access** | Users | `/admin/users` | `scope.users.view` (manage for writes) | 03 §1 |
| | User detail | `/admin/users/:id` | ″ | 03 IAM-005 |
| | Invitations | `/admin/users/invitations` | `scope.users.manage` | 03 |
| | Groups | `/admin/groups` | `scope.users.view` | 03 §4 |
| | Group detail | `/admin/groups/:id` | ″ | 03 IAM-042 |
| | Approval groups | `/admin/groups/approval` | ″ | 03 §6 |
| | Teams | `/admin/teams` | `scope.users.view` | 03 §5 |
| | Customers | `/admin/customers` | `scope.users.manage` | 03 §8 |
| | Customer organisations | `/admin/customers/organisations` | ″ | 03 §8 |
| | Service accounts | `/admin/users/service-accounts` | `scope.users.manage` | 03 IAM-007 |
| | API tokens | `/admin/users/tokens` | `scope.users.manage` | 03 IAM-008 |
| | Licences & application access | `/admin/licences` | `scope.system.general` | 03 §10 |
| **Security** | Global permissions | `/admin/security/global-permissions` | `ADMIN` (System admin for `SYSTEM_ADMIN` row) | 04 §2 |
| | Admin scopes | `/admin/security/admin-scopes` | `SYSTEM_ADMIN` | 04 §3 |
| | Workspace roles | `/admin/security/roles` | `scope.schemes.permission` | 04 §4 |
| | Permission schemes | `/admin/security/permission-schemes` | ″ | 04 §5 |
| | Role permission matrix | `/admin/security/permission-schemes/:id/matrix` | ″ | 04 PRM-025 |
| | Item security schemes | `/admin/security/item-security-schemes` | ″ | 04 §6 |
| | Permission helper | `/admin/security/permission-helper` | `scope.users.view` | 04 PRM-060 |
| | Access review & privileged access | `/admin/security/access-review` | `ADMIN` | 04 PRM-062/063 |
| | User directories | `/admin/security/directories` | `scope.system.security` | 03 §2 |
| | SSO (SAML / OIDC) | `/admin/security/sso` | ″ | 03 IAM-030/031 |
| | Authentication methods & login | `/admin/security/authentication` | ″ | 03 IAM-032 |
| | Password, MFA & session policies | `/admin/security/policies` | ″ | 03 IAM-033–036 |
| | Authentication log | `/admin/security/auth-log` | `scope.audit.view` | 03 IAM-038 |
| **Workspaces** | Workspaces | `/admin/workspaces` | `scope.workspaces.manage` | 02 §1 |
| | Workspace categories | `/admin/workspaces/categories` | ″ | 02 DOM-006 |
| | Workspace templates | `/admin/workspaces/templates` | ″ | 02 DOM-008 |
| | Trash | `/admin/workspaces/trash` | ″ | 02 DOM-005 |
| **Work items** | Item types / item type schemes | `/admin/item-types`, `/admin/item-type-schemes` | `scope.fields.manage` | 02 §3 |
| | Priorities / priority schemes | `/admin/priorities`, `/admin/priority-schemes` | ″ | 06 §7 |
| | Link types | `/admin/link-types` | ″ | 08 §7 |
| | Time tracking | `/admin/time-tracking` | ″ | 08 §7 |
| **Workflows** | Workflows | `/admin/workflows` | `scope.workflows.manage` | 05 |
| | Workflow designer | `/admin/workflows/:id/edit` | ″ | 05 §11 |
| | Workflow schemes | `/admin/workflow-schemes` | ″ | 05 §10 |
| | Statuses | `/admin/statuses` | ″ | 05 §2 |
| | Resolutions | `/admin/resolutions` | ″ | 05 §2 |
| | Events (custom) | `/admin/workflows/events` | ″ | 05 WFL-081 |
| | Approval matrices | `/admin/workflows/approval-matrices` | ″ | 05 §7 |
| | SLA calendars | `/admin/sla/calendars` | ″ | 05 WFL-090 |
| | Migrations (jobs) | `/admin/workflows/migrations` | ″ | 05 WFL-073 |
| **Fields & screens** | Custom fields | `/admin/fields` | `scope.fields.manage` | 06 §2 |
| | Field configurations / schemes | `/admin/field-configurations`, `/admin/field-configuration-schemes` | ″ | 06 §4 |
| | Screens | `/admin/screens` | ″ | 06 §5 |
| | Screen schemes | `/admin/screen-schemes` | ″ | 06 §5.1 |
| | Item type screen schemes | `/admin/item-type-screen-schemes` | ″ | 06 §5.1 |
| | Field explainer | `/admin/fields/explain` | ″ | 06 FLD-001 |
| **Notifications** | Notification manager (overview) | `/admin/notifications` | `scope.notifications.manage` | 07 §6 |
| | Event catalogue | `/admin/notifications/events` | ″ | 07 §4 |
| | Notification schemes | `/admin/notifications/schemes` | ″ | 07 §5 |
| | Channel policy matrix | `/admin/notifications/channels` | ″ | 07 §8 |
| | Templates | `/admin/notifications/templates` | ″ | 07 §9 |
| | Delivery log | `/admin/notifications/log` | ″ | 07 §7 |
| | Digests & batching | `/admin/notifications/digests` | ″ | 07 §8 |
| | Chat integrations | `/admin/notifications/chat` | ″ | 07 §6 |
| | Notification helper | `/admin/notifications/helper` | ″ | 07 NTF-015 |
| | Admin alerts | `/admin/notifications/admin-alerts` | `ADMIN` | 07 §6 |
| **Email** | Outgoing mail servers | `/admin/system/mail/outgoing` | `scope.system.mail` | 07 §2 |
| | Mail queue | `/admin/system/mail/queue` | ″ | 07 EML-003 |
| | Incoming mail & handlers | `/admin/system/mail/incoming` | ″ | 07 §3 |
| | Incoming processing log | `/admin/system/mail/incoming/log` | ″ | 07 EML-012 |
| **Look & feel** | Branding | `/admin/branding` | `scope.branding.manage` | 08 §1 |
| | Login page | `/admin/branding/login` | ″ | 08 §1 |
| | Email branding | `/admin/branding/email` | ″ | 08 §1 |
| | Help centre / portal branding | `/admin/branding/portal` | ″ | 08 §3 |
| | Announcement banner | `/admin/branding/announcement` | ″ | 08 §4 |
| **System** | General configuration | `/admin/system/general` | `scope.system.general` | 08 §7 |
| | Base URL & network | `/admin/system/general/url` | ″ | 08 §5 |
| | Localisation | `/admin/system/general/localisation` | ″ | 08 §6 |
| | Attachments & file scanning | `/admin/system/attachments` | ″ | 08 §7 |
| | Data retention & legal hold | `/admin/system/retention` | ″ | 08 §7 |
| | Configuration import/export | `/admin/system/config-transfer` | `SYSTEM_ADMIN` | 08 SYS-022 |
| | Webhooks | `/admin/system/webhooks` | `ADMIN` | 05 WFL-082 |
| | Feature flags | `/admin/system/feature-flags` | `SYSTEM_ADMIN` | 01 IMP-002 |
| | Scheduled jobs & tasks | `/admin/system/jobs` | `scope.insights.view` (actions: System admin) | 09 §7 |
| | Search index | `/admin/system/indexing` | `SYSTEM_ADMIN` | 09 OBS-053 |
| | Logging & diagnostics | `/admin/system/logging` | `SYSTEM_ADMIN` | 09 §9 |
| | System information | `/admin/system/info` | `scope.insights.view` | 09 §10 |
| **Insights** | Health checks | `/admin/insights/health` | `scope.insights.view` | 09 §2 |
| | Performance | `/admin/insights/performance` | ″ | 09 §3 |
| | Cluster | `/admin/insights/cluster` | ″ | 09 §4 |
| | Usage | `/admin/insights/usage` | ″ | 09 §5 |
| | Configuration hygiene | `/admin/insights/configuration` | ″ | 09 §6 |
| **Audit** | Audit log | `/admin/audit` | `scope.audit.view` | 09 §8 |
| | Audit settings (coverage, retention, streaming) | `/admin/audit/settings` | `SYSTEM_ADMIN` | 09 AUD-002/005 |

## 3. Standard page patterns (build once, reuse everywhere)

### 3.1 List page

| Element | Behaviour |
|---------|-----------|
| Header | Title, description, primary action (*Create …*), overflow (*Import*, *Export*) |
| Toolbar | Search box (debounced, server-side), filter chips, saved views, column chooser, density |
| Table | Server-side sort/pagination (cursor-based), sticky header, row click → detail, row actions menu, multi-select for bulk actions |
| Columns | Always include **Used by** for shared config objects; **Last modified** (by/at) |
| States | Loading skeleton, empty state with explanation + primary action, no-results state, error state with retry and request ID |
| Bulk actions | Confirmation dialog with impact summary; executed as background task when > 50 objects |

### 3.2 Detail page

Header (name, key/ID copy button, status lozenge, owner), tabs (*General*, domain tabs, *Where used*, *Audit*), side metadata panel (created/updated, IDs), actions (*Edit*, *Copy*, *Delete* — disabled with tooltip when in use).

### 3.3 Editor / form

| Rule | Detail |
|------|--------|
| Validation | Inline, on blur + on submit; server errors mapped to fields |
| Unsaved changes | Guard on navigation |
| Secrets | Write-only inputs ("••••• set — *Replace*") |
| Locked by env/directory | Lock icon + tooltip with source |
| Draft/publish objects | Header shows *Draft* badge, *Discard*, *Preview*, *Publish* with impact dialog |

### 3.4 Impact analysis dialog (P-07)

```
Publish changes to "Default permission scheme"?
• Used by 14 workspaces (FIN, HR, IT, … show all)
• Affects ~2,340 users' access
• Changes: + Members → Delete items ; − Viewers → Add comments
[Cancel]   [Publish]
```

### 3.5 Wizards

Stepper for multi-step operations (migration, CSV import, directory setup, SSO setup, workspace creation): steps, *Back/Next*, review step, dry-run results, execute → task progress page.

### 3.6 Shared components inventory

`PrincipalPicker` (user/group/team/role with avatars & type filter), `GranteeChip`, `SchemeAssociationTable`, `WhereUsedPanel`, `ImpactDialog`, `AuditTimeline`, `DiffViewer` (JSON & visual), `JsonSchemaForm` (for rule builders), `ColourPickerWithContrast`, `AssetUploader` (sanitising), `LocalisedTextInput` (en/ar tabs), `CronEditor`, `SearchExpressionInput` (with autocomplete & validation), `KpiTile`, `TimeSeriesChart`, `StatusLozenge`, `TaskProgress`.

## 4. Workspace settings (workspace admins) — `/w/:key/settings`

Visible to holders of `ADMINISTER_WORKSPACE` on the workspace.

| Page | Route | Notes |
|------|-------|-------|
| Details | `/w/:key/settings/details` | Name, key (change via wizard), lead, category, avatar, description, default assignee |
| People | `/w/:key/settings/people` | IAM-070 |
| Configuration summary | `/w/:key/settings/summary` | DOM-033 |
| Item types | `/w/:key/settings/item-types` | View/associate item type scheme |
| Workflows | `/w/:key/settings/workflows` | View; edit if DOM-034 allows |
| Screens | `/w/:key/settings/screens` | SCR-012 wizard |
| Fields | `/w/:key/settings/fields` | View; context options where FLD-024 allows |
| Permissions | `/w/:key/settings/permissions` | View scheme; Permission helper scoped to workspace |
| Item security | `/w/:key/settings/item-security` | View |
| Notifications | `/w/:key/settings/notifications` | View scheme; workspace-level template overrides |
| Components / Versions | `/w/:key/settings/components`, `/versions` | Software |
| Request types | `/w/:key/settings/request-types` | Service — SCR-020 |
| Portal settings | `/w/:key/settings/portal` | Service — BRD-021, IAM-082 |
| Customers & organisations | `/w/:key/settings/customers` | Service |
| Email channel | `/w/:key/settings/email` | Service — linked incoming handler |
| Customer notifications | `/w/:key/settings/customer-notifications` | Service — NTF-013 |
| SLAs | `/w/:key/settings/sla` | Service — WFL-091 |
| Queues | `/w/:key/settings/queues` | Service |
| Audit | `/w/:key/settings/audit` | AUD-004 |

## 5. End-user personal settings — `/me`

| Page | Route | Spec |
|------|-------|------|
| Profile | `/me/profile` | IAM-090 |
| Preferences (language, timezone, theme) | `/me/preferences` | SYS-010 |
| Notifications | `/me/notifications` | NTF-031 |
| Security (password, MFA, sessions) | `/me/security` | IAM-033–035 |
| API tokens | `/me/tokens` | IAM-008 |
| My approvals | `/approvals` | NTF-054 |
| Notification centre | header panel + `/notifications` | NTF-050 |

## 6. Accessibility & responsiveness

| ID | Requirement |
|----|-------------|
| UI-010 | WCAG 2.2 AA: keyboard operable (incl. workflow designer text mode, drag-and-drop alternatives), visible focus using `--brand-focus-ring`, ARIA landmarks, labelled form controls, table semantics, colour never sole carrier of meaning. |
| UI-011 | Admin portal optimised for ≥ 1280 px; usable down to 768 px (tables become cards); end-user & portal fully responsive to 360 px. |
| UI-012 | All dates shown in user's timezone with UTC tooltip; relative times ("5 min ago") with absolute on hover. |
