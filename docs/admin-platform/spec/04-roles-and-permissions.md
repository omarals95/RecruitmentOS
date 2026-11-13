# 04 — Roles & Permissions

## 1. Authorisation layers (evaluated top → bottom)

| Layer | Question answered | Configured in | Jira equivalent |
|-------|-------------------|---------------|-----------------|
| L1 Authentication & account status | Is this an active, authenticated principal? | spec 03 | — |
| L2 Application access (licence) | May this user use the product at all (agent vs customer)? | spec 03 §10 | Application access |
| L3 Global permissions | Instance-wide capabilities | Admin → Security → Global permissions | Global permissions |
| L4 Admin scopes | Which admin areas may they manage? | Admin → Security → Admin scopes | (extension) |
| L5 Workspace permissions | What may they do in this workspace? | Permission scheme | Permission scheme |
| L6 Item security level | May they see this specific item? | Item security scheme | Issue security scheme |
| L7 Workflow rules | May they perform this transition now? | Workflow conditions | Workflow conditions |
| L8 Field-level rules | May they see/edit this field? | Field configuration + field permissions | Field configuration (+ app extensions) |
| L9 Comment/attachment visibility | Restricted comments (role/group) | Per comment | Comment visibility |

All layers are evaluated by **`PermissionService`** (§8). No other code makes access decisions.

---

## 2. Global permissions

| Key | Name | Default grantee | Notes |
|-----|------|-----------------|-------|
| `SYSTEM_ADMIN` | System administrator | `system-administrators` | Everything, including system-level settings (directories, mail servers, base URL, SSO, log levels, backups, impersonation, licences). Only System admins can grant `SYSTEM_ADMIN`. |
| `ADMIN` | Administrator | `instance-administrators` | All admin areas **except** system-level items (Jira distinction). Equivalent to all admin scopes except `scope.system.*`. |
| `CREATE_WORKSPACE` | Create workspaces | `instance-administrators` | |
| `BROWSE_USERS` | Browse users and groups | `app-users` | Required for user pickers & mentions. |
| `CREATE_SHARED_OBJECTS` | Create shared filters/dashboards | `app-users` | |
| `MANAGE_GROUP_FILTER_SUBSCRIPTIONS` | Manage group subscriptions | `instance-administrators` | |
| `BULK_CHANGE` | Bulk change items | `app-users` | Still subject to per-item permissions. |
| `CREATE_TEAMS` | Create teams | `app-users` | |
| `MANAGE_TEAMS` | Manage any team | `instance-administrators` | |
| `VIEW_AUDIT_LOG` | View audit log | `instance-administrators` | Read-only. |
| `VIEW_SYSTEM_INSIGHTS` | View health & performance | `instance-administrators` | Read-only observability for ops staff. |
| `USE_API_TOKENS` | Create personal access tokens | `app-users` | |
| `SERVICE_AGENT` | Service agent access | `service-agents` | Licence-linked; allows agent views in service workspaces. |

| ID | Requirement |
|----|-------------|
| PRM-001 | Global permissions can be granted to **groups** only (Jira rule) — keeps access reviewable. Exception: none. |
| PRM-002 | The last group holding `SYSTEM_ADMIN` cannot be removed; the last active member of that group cannot be removed or deactivated (lock-out protection). |
| PRM-003 | Global permissions page: matrix of permission × granted groups, with *Add group*, *Remove*, and per-permission "effective users" count + drill-down. |

## 3. Admin scopes (delegated administration)

Granular rights for delegated admins who should not hold full `ADMIN`. Grantable to groups.

| Scope key | Grants access to admin areas |
|-----------|------------------------------|
| `scope.users.manage` | Users, groups (non-system), teams, invitations, customer accounts |
| `scope.users.view` | Read-only users/groups/teams |
| `scope.workspaces.manage` | All workspaces' settings, categories, archive/restore |
| `scope.schemes.permission` | Permission & item security schemes, workspace roles definitions |
| `scope.workflows.manage` | Statuses, resolutions, workflows, workflow schemes, SLA calendars |
| `scope.fields.manage` | Custom fields, contexts, field configurations, screens and all screen schemes, item types, priorities |
| `scope.notifications.manage` | Notification schemes, events, email templates, notification manager |
| `scope.branding.manage` | Look & feel, announcement banner, portal branding |
| `scope.insights.view` | Observability dashboards, health checks, usage insights |
| `scope.audit.view` | Audit log |
| `scope.system.mail` *(system)* | Outgoing/incoming mail servers |
| `scope.system.security` *(system)* | Directories, SSO, password/MFA/session policies, IP allow-lists |
| `scope.system.general` *(system)* | Base URL, general configuration, localisation, licences, log levels |

| ID | Requirement |
|----|-------------|
| PRM-010 | `SYSTEM_ADMIN` implies all scopes; `ADMIN` implies all non-`system` scopes. |
| PRM-011 | Admin navigation renders **only** sections the user holds scopes for; server enforces the same per endpoint. |
| PRM-012 | Every admin endpoint declares its required scope via a decorator/annotation, e.g. `@RequiresAdminScope('scope.workflows.manage')`. CI checks coverage (playbook §6). |
| PRM-013 | Admin pages require **re-authentication** within the websudo window (spec 03 IAM-035). |

## 4. Workspace roles

| ID | Requirement |
|----|-------------|
| PRM-020 | Roles are defined **globally** (name, description, default members) and membership is set **per workspace**. |
| PRM-021 | **Default members** (users/groups/teams) are applied when a new workspace is created; changing defaults does not alter existing workspaces. |
| PRM-022 | Seeded roles: **Administrators**, **Members**, **Viewers**, **Agents** (service), **Approvers**, **Developers** (software). Roles are editable; only *Administrators* is protected from deletion. |
| PRM-023 | Role membership principals: **user**, **group**, **team**. |
| PRM-024 | Deleting a role shows *Where used* (permission schemes, notification schemes, workflow conditions, comment visibility, item security) and requires a replacement or explicit removal. |
| PRM-025 | **Role-centric view**: a "Role permissions" matrix page (rows = workspace permissions, columns = roles) for a selected permission scheme. Editing a cell adds/removes the role grant in that scheme. This is the main UX answer to "each role has different permissions and actions" while keeping the Jira scheme model underneath. |

## 5. Permission schemes

### 5.1 Workspace permission catalogue

| Category | Key | Name |
|----------|-----|------|
| Workspace | `ADMINISTER_WORKSPACE` | Administer workspace (settings, roles membership, components, versions, request types, queues) |
| Workspace | `BROWSE_WORKSPACE` | Browse workspace (see workspace and its items) |
| Workspace | `VIEW_DEV_TOOLS` | View development tools |
| Workspace | `VIEW_WORKFLOW_READONLY` | View read-only workflow |
| Workspace | `MANAGE_SPRINTS` | Manage sprints |
| Workspace | `MANAGE_QUEUES` | Manage queues (service) |
| Workspace | `VIEW_REPORTS` | View reports & SLA dashboards |
| Items | `CREATE_ITEMS` | Create items |
| Items | `EDIT_ITEMS` | Edit items |
| Items | `TRANSITION_ITEMS` | Transition items |
| Items | `SCHEDULE_ITEMS` | Schedule items (due date) |
| Items | `MOVE_ITEMS` | Move items between workspaces |
| Items | `ASSIGN_ITEMS` | Assign items |
| Items | `ASSIGNABLE_USER` | Be assignable |
| Items | `RESOLVE_ITEMS` | Resolve items / set resolution |
| Items | `CLOSE_ITEMS` | Close items |
| Items | `MODIFY_REPORTER` | Modify reporter |
| Items | `DELETE_ITEMS` | Delete items |
| Items | `LINK_ITEMS` | Link items |
| Items | `SET_ITEM_SECURITY` | Set item security level |
| Items | `BULK_EXPORT` | Export items |
| Voters & watchers | `VIEW_VOTERS_WATCHERS` | View voters and watchers |
| Voters & watchers | `MANAGE_WATCHERS` | Manage watchers |
| Comments | `ADD_COMMENTS` | Add comments |
| Comments | `EDIT_ALL_COMMENTS` / `EDIT_OWN_COMMENTS` | Edit comments |
| Comments | `DELETE_ALL_COMMENTS` / `DELETE_OWN_COMMENTS` | Delete comments |
| Comments | `ADD_INTERNAL_COMMENTS` | Add internal (agent-only) comments (service) |
| Attachments | `CREATE_ATTACHMENTS` | Create attachments |
| Attachments | `DELETE_ALL_ATTACHMENTS` / `DELETE_OWN_ATTACHMENTS` | Delete attachments |
| Time tracking | `WORK_ON_ITEMS` | Log work |
| Time tracking | `EDIT_OWN_WORKLOGS` / `EDIT_ALL_WORKLOGS` | Edit worklogs |
| Time tracking | `DELETE_OWN_WORKLOGS` / `DELETE_ALL_WORKLOGS` | Delete worklogs |
| Approvals | `VIEW_APPROVALS` | View approval details |
| Approvals | `OVERRIDE_APPROVALS` | Override/force-decide an approval (audited) |

### 5.2 Grantee types

| Grantee type | Resolves to |
|--------------|-------------|
| `WORKSPACE_ROLE` | Members of role in the item's workspace |
| `GROUP` | Effective (nested) members of group |
| `TEAM` | Members of team |
| `USER` | A single user (discouraged; UI warns) |
| `REPORTER` | Item reporter |
| `ASSIGNEE` | Item assignee |
| `ASSIGNEE_TEAM` | Members of the team in the item's *Team* field |
| `WORKSPACE_LEAD` | Workspace lead |
| `CURRENT_USER` | Any authenticated user (used e.g. for *Create items* on open workspaces) |
| `ANYONE_LOGGED_IN` | Any licensed, logged-in user |
| `PUBLIC` | Anonymous access (requires instance setting `allowAnonymousAccess = true`; UI shows red warning) |
| `USER_FIELD` | Users in a user-picker custom field |
| `GROUP_FIELD` | Members of groups in a group-picker custom field |
| `SERVICE_CUSTOMER` | Customers with portal access to the workspace (service) |
| `APPROVERS` | Users who are approvers on the item's current/previous approval steps |

| ID | Requirement |
|----|-------------|
| PRM-030 | A permission scheme = set of (permission key, grantee type, grantee value) tuples. |
| PRM-031 | Scheme editor: permissions grouped by category; each row lists grantees as chips with remove; *Grant permission* dialog (multi-select permissions × one grantee). |
| PRM-032 | **Scheme comparison** tool: diff two schemes side by side. |
| PRM-033 | Seeded **Default permission scheme** granting by role (Administrators: all; Members: create/edit/transition/assign/comment/attach/log work; Viewers: browse + comment; Agents: service set; Approvers: browse + view approvals). |
| PRM-034 | There is **no explicit deny** (Jira model). Access = union of grants. Document this in the UI help. |
| PRM-035 | Workspace admins can view (not edit) their scheme unless they hold `scope.schemes.permission`. |

## 6. Item security schemes

| ID | Requirement |
|----|-------------|
| PRM-040 | A scheme has N **security levels**; each level has grantees (same grantee types as §5.2). Optional default level. |
| PRM-041 | An item with a security level is visible only to users matching that level's grantees **and** holding `BROWSE_WORKSPACE`. |
| PRM-042 | Setting a level requires `SET_ITEM_SECURITY` and membership of that level (cannot lock yourself out). |
| PRM-043 | Search, counts, links, notifications, mentions, exports and APIs must all respect item security (leak tests in spec 12). |

## 7. Field-level & comment restrictions

| ID | Requirement |
|----|-------------|
| PRM-050 | **Field permissions** (extension beyond Jira core): per field configuration, a field may be marked *Visible to* and *Editable by* (roles/groups). Default: unrestricted. Enforced in API reads/writes, search, exports and notifications. |
| PRM-051 | **Comment visibility**: comments may be restricted to a role or group; service workspaces distinguish *internal* vs *reply to customer*. |

## 8. Permission evaluation engine (`PermissionService`)

### 8.1 API (language-agnostic)

```
hasGlobalPermission(principal, globalKey) -> bool
hasAdminScope(principal, scopeKey) -> bool
hasWorkspacePermission(principal, workspaceId, permKey, itemContext?) -> bool
canSeeItem(principal, itemId) -> bool
canPerformTransition(principal, itemId, transitionId) -> Decision
filterVisibleItems(principal, query) -> query with security predicates
explain(principal, target, permKey) -> Explanation   // for Permission Helper
```

### 8.2 Algorithm for `hasWorkspacePermission`

1. If principal inactive or lacks application access → **deny**.
2. If `SYSTEM_ADMIN` → still subject to scheme for *item* actions? **No bypass** (Jira: admins do not automatically browse every workspace). Admin bypass is limited to admin endpoints. *(Make this explicit; many legacy apps get it wrong.)*
3. Load the workspace's permission scheme grants for `permKey` (cached by scheme ID).
4. For each grant, resolve the grantee against principal:
   - role → is principal a member (direct user, via effective group, via team) of that role in workspace?
   - group → effective membership (nested, cached).
   - item-context grantees (reporter, assignee, user field…) → require `itemContext`.
5. Return **allow** on first match; otherwise **deny**.
6. If `itemContext` provided and the item has a security level → also require `canSeeItem`.

### 8.3 Caching & invalidation

| Cache | Key | Invalidated by |
|-------|-----|----------------|
| Effective groups per user | `userId` | Group membership change, nested group change, directory sync |
| Role membership per workspace | `workspaceId` | Role membership change, group/team membership change |
| Scheme grants | `schemeId` | Scheme edit |
| Workspace → scheme association | `workspaceId` | Association change |

- Invalidation is event-driven (domain events, spec 11) and cluster-wide (pub/sub).
- Target: p95 permission check < 2 ms warm, < 20 ms cold.

### 8.4 Query-level enforcement

Lists and search must push permission predicates into SQL/search-index queries (`filterVisibleItems`), never post-filter large result sets in memory (prevents both leaks via pagination counts and performance collapse).

## 9. Permission Helper & access reviews

| ID | Requirement |
|----|-------------|
| PRM-060 | **Permission Helper** (Admin → Security → Permission helper; also in workspace settings): inputs user + workspace or item + permission → output allow/deny with the chain of reasons (e.g. "Granted via role *Members* ← group *finance-team* ← nested in *finance-all*"). For deny: lists which grants exist and why each failed (incl. item security / workflow condition). |
| PRM-061 | **Notification helper** analogue lives in spec 07. |
| PRM-062 | **Access review export** (CSV/XLSX): for a scope (instance / workspace / group), list every user with effective global permissions, admin scopes, workspace roles and their source path. Supports quarterly access recertification. |
| PRM-063 | **Privileged access report**: all holders of `SYSTEM_ADMIN`, `ADMIN`, any admin scope, `PUBLIC` grants and `ANYONE_LOGGED_IN` browse grants, with last login. |
| PRM-064 | **"View as user"** (read-only UI simulation) for admins to preview navigation and item visibility as another user, without impersonation side-effects. Audited. |
