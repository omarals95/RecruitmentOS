# 03 — Identity: Users, Directories, Groups, Teams, Approval Groups, Customers

## 1. Users

### 1.1 User attributes

| Attribute | Type | Rules |
|-----------|------|-------|
| `id` | UUID | Immutable, internal |
| `username` | string | Unique (case-insensitive) within directory; immutable for synced users |
| `email` | string | Unique across active licensed users; verified flag |
| `display_name` | string | Required |
| `avatar` | file ref | Optional; generated initials avatar fallback |
| `directory_id` | FK | Owning directory |
| `account_type` | enum | `licensed`, `customer`, `service` (bot/integration), `system` |
| `status` | enum | `active`, `inactive` (deactivated), `pending` (invited), `locked` (security lock), `deleted` (anonymised) |
| `locale`, `timezone` | string | Default from instance settings |
| `external_id` | string | IdP / SCIM identifier |
| `last_login_at`, `last_active_at` | timestamp | For licence & hygiene reports |
| `mfa_enrolled` | bool | |
| `job_title`, `department`, `manager_id`, `location`, `phone` | string/FK | Optional profile, may be synced; `manager_id` enables "Reporter's manager" approver type |
| `created_at`, `created_by`, `updated_at` | audit fields | |

### 1.2 Requirements

| ID | Requirement |
|----|-------------|
| IAM-001 | Admin can **create**, **invite** (email link, expiring 72 h configurable), **edit**, **deactivate**, **reactivate**, **reset password**, **force logout (revoke sessions)**, **reset MFA**, **unlock**, **impersonate (“Log in as”) — System admins only, audited, banner shown, opt-in setting**. |
| IAM-002 | **Deactivation** (not deletion) is the default lifecycle action. Deactivated users: cannot log in; don't consume a licence; remain visible in history; are removed from assignable-user lists; keep group/role memberships (Jira behaviour) but those grant nothing. |
| IAM-003 | **Deletion** is allowed only when the user has no item history, or via **anonymisation** (GDPR / UAE PDPL right to erasure): replace PII with `Former user <hash>`; reassign or keep-as-anonymous references; produce an anonymisation report. Anonymisation is a background job with audit. |
| IAM-004 | **Bulk operations**: CSV import (create/update with dry-run preview and per-row errors), bulk add/remove groups, bulk deactivate, bulk role assignment. |
| IAM-005 | **User detail page** tabs: *Profile*, *Groups* (direct + inherited via nesting), *Teams*, *Workspace roles* (per workspace, with source: direct/group/team), *Global permissions & admin scopes* (effective, with source), *Sessions & devices*, *API tokens*, *Login history*, *Licences*, *Audit trail*. |
| IAM-006 | **User list** columns: name/avatar, username, email, directory, account type, status, groups count, last active, MFA. Filters: directory, status, group, account type, last active range, MFA, licence. Saved filters. Export CSV. |
| IAM-007 | **Service accounts** (`account_type = service`): no interactive login, API tokens only, owner user required, expiry required. |
| IAM-008 | **Personal access tokens**: users create tokens (name, expiry ≤ max set by policy, optional scopes); admins can list & revoke all tokens; tokens are stored hashed; last-used timestamp and IP recorded. |

## 2. User directories

Mirrors Jira's *User Directories*: an ordered list of sources; first match wins for authentication and duplicate usernames.

| Directory type | Capabilities | Sync |
|----------------|--------------|------|
| **Internal** | Local users/groups, passwords stored with Argon2id | n/a |
| **Internal with LDAP authentication** | Users/groups local; password verified against LDAP | Optional on-login sync |
| **LDAP / Active Directory** | Read-only or read-write; user/group schema mapping; nested group support; paged results | Scheduled incremental + full sync; manual sync button |
| **Microsoft Entra ID (via SCIM 2.0)** | Inbound provisioning of users/groups | Push from IdP |
| **Generic SCIM 2.0** | Okta, Ping, OneLogin, etc. | Push from IdP |
| **Customer directory** | Portal customers (self-signup optional) | n/a |

| ID | Requirement |
|----|-------------|
| IAM-020 | Directories are **ordered**; admin can reorder with impact preview ("23 duplicate usernames will resolve to a different account"). |
| IAM-021 | Each directory shows: type, status, last sync (start, duration, result, counts added/updated/deactivated), next scheduled sync, **Test connection**, **Synchronise now**, **Disable**. |
| IAM-022 | LDAP configuration screens: connection (host, port, SSL/StartTLS, bind DN, secret), base DN, user schema (object class, filter, username/name/email attributes, unique ID attribute), group schema, membership schema (member attribute, nested groups toggle), advanced (paging size, timeouts, follow referrals), sync interval. Secrets are write-only in UI/API. |
| IAM-023 | Synced users/groups are **read-only** in the UI for directory-owned attributes (show a lock icon with source). Local-only overlays (e.g. avatar, locale) remain editable. |
| IAM-024 | Users removed from the source are **deactivated**, never deleted, on sync. |
| IAM-025 | SCIM endpoint: `/scim/v2/Users`, `/scim/v2/Groups`, bearer token per directory, supports filter, PATCH, pagination; conforms to RFC 7643/7644. |

## 3. Authentication & security policies

| ID | Area | Requirement |
|----|------|-------------|
| IAM-030 | **SSO – SAML 2.0** | IdP metadata import (URL/XML), SP metadata download, ACS URL derived from **base URL** (spec 08), attribute mapping (username, email, display name, groups), JIT provisioning toggle with target directory and default groups, signed assertions required, clock-skew tolerance. |
| IAM-031 | **SSO – OIDC** | Issuer discovery, client ID/secret, scopes, claim mapping, PKCE, JIT provisioning. |
| IAM-032 | **Login options** | Toggles: show username/password form, show SSO button(s), auto-redirect to IdP, "break-glass" local admin login URL (`/login?local=true`) restricted to System admins (Jira *authentication methods* behaviour). |
| IAM-033 | **Password policy** (internal directory) | Min length (default 12), complexity rules, banned-password list, history N, max age (optional), lockout after N failures for M minutes, CAPTCHA after N failures. |
| IAM-034 | **MFA** | TOTP + WebAuthn/passkeys; enforce for: all users / admin-scope holders / selected groups; grace period; recovery codes. Not applied to SSO users when IdP enforces MFA (toggle). |
| IAM-035 | **Session policy** | Idle timeout, absolute timeout, "remember me" max, concurrent session limit, re-authentication ("websudo") required for admin pages with configurable window (default 10 min) — Jira *secure administrator sessions*. |
| IAM-036 | **IP allow-list** (optional) | For admin portal and/or API tokens. |
| IAM-037 | **Public sign-up** | Off by default. If on: allowed email domains, default groups, CAPTCHA, admin approval option. Separate setting for **customer** self-signup on the portal. |
| IAM-038 | All auth events (login success/failure, MFA, token use, lockout, SSO assertion errors) go to the audit log (spec 09) and a dedicated **Authentication log** view. |

## 4. Groups

| ID | Requirement |
|----|-------------|
| IAM-040 | Group attributes: name (unique, case-insensitive), description, directory, `is_approval_group`, `is_system` (protected), member count, created/updated. |
| IAM-041 | **Nested groups**: group may contain groups; cycle detection on save; effective membership computed and cached (invalidated on change). UI shows *direct* vs *inherited* members. Max depth configurable (default 10). |
| IAM-042 | **Group detail** tabs: *Members* (users + nested groups, add/remove, bulk add via paste/CSV), *Member of* (parent groups), *Where used* (global permissions, admin scopes, permission schemes, workspace roles, notification schemes, workflow conditions/approvals, field contexts, filters/dashboards shares, item security levels), *Audit*. |
| IAM-043 | **Rename** propagates by ID (no string references to group names anywhere in config). **Delete** shows *Where used* and requires choosing a replacement group for each scheme usage or explicit removal. |
| IAM-044 | **Group managers** (delegated): a group may designate manager users/groups who can add/remove members without admin rights (useful for approval groups owned by business units). |
| IAM-045 | **System groups** seeded & protected: `system-administrators`, `instance-administrators`, `app-users`, `service-agents`. They can be renamed but not deleted. |

## 5. Teams

| ID | Requirement |
|----|-------------|
| IAM-050 | Team attributes: name, description, avatar, **lead** (user), members (users with optional team-role label: *Lead, Member, Contributor*), optional linked group (members synced from a group), timezone, working calendar (for capacity/SLA), status (active/archived). |
| IAM-051 | Teams can be: (a) granted **workspace roles**; (b) used as **assignee pools** (a *Team* system field on items); (c) recipients in notification schemes; (d) approvers in workflow approvals; (e) grantees in permission schemes. |
| IAM-052 | Team leads can manage team membership if `teams.leadManagesMembership = true`. |
| IAM-053 | Team page tabs: *Members*, *Workspaces & roles*, *Open work* (items assigned to team), *Settings*, *Audit*. |
| IAM-054 | Team vs Group rule of thumb (show in admin UI help): **Groups** control *access*; **Teams** organise *work*. Both can grant roles. |

## 6. Approval groups

| ID | Requirement |
|----|-------------|
| IAM-060 | Any group can be flagged `is_approval_group`. Only flagged groups appear in approval-step pickers (prevents accidental use of large access groups like `app-users`). |
| IAM-061 | Approval group settings: **default decision rule** (`any_one`, `all`, `count:N`, `percentage:P`), **delegation allowed** (approver can delegate to another member), **out-of-office fallback** (alternate approver/group), **self-approval prohibited** (requester cannot approve own request — default on). Workflow steps may override these (spec 05 §7). |
| IAM-062 | Approval groups have a dedicated admin list (*Admin → Users → Approval groups*) showing members, workflows using them, open approvals count, average decision time. |

## 7. Workspace membership UX

| ID | Requirement |
|----|-------------|
| IAM-070 | Workspace *People* page (workspace settings): table of principals (user/group/team) × roles, with add/remove, filter by role, and "effective members" toggle that expands groups/teams. |
| IAM-071 | Adding a person to a workspace requires choosing at least one role. |
| IAM-072 | Bulk "Add user to workspaces" from user detail page: pick workspaces × role. |

## 8. Customers (service workspaces / portal)

| ID | Requirement |
|----|-------------|
| IAM-080 | **Customer accounts** (`account_type = customer`) access only the help-centre portal; never consume an agent licence; cannot be added to agent groups unless converted. |
| IAM-081 | **Customer organisations**: named sets of customers; can be linked to multiple service workspaces; members can see each other's requests when *Share with organisation* is used. |
| IAM-082 | Portal access setting per service workspace: *Anyone can raise requests* (public), *Customers in the instance*, *Only customers added to this workspace/organisation*. |
| IAM-083 | Converting customer ↔ licensed user is an explicit admin action with audit. |

## 9. User-facing self-service

| ID | Requirement |
|----|-------------|
| IAM-090 | Profile page: edit display name, avatar, locale, timezone, theme (light/dark/system), **notification preferences** (spec 07), **sessions**, **MFA**, **API tokens**, **connected accounts**. |
| IAM-091 | Password reset by email (link expiry 1 h, single-use), not available for SSO-only or LDAP read-only users (show IdP message). |

## 10. Licences

| ID | Requirement |
|----|-------------|
| IAM-100 | Licence types: *Agent/Software user*, *Business user*, *Customer (unlimited)*. Licence capacity configured by System admin (or licence key if commercialised). |
| IAM-101 | **Application access** is granted via groups (Jira *Application access*): a user consumes a licence only if in a group mapped to that application access type. Default group per access type for new users. |
| IAM-102 | Licence page: capacity, used, remaining, trend chart, users approaching inactivity threshold (e.g. no login 90 days) with bulk deactivate. Warn at 90 %, block new-user activation at 100 % (configurable to warn-only). |
