# 11 — Data Model, API & Seed Data

> Stack-agnostic. Names are indicative; adapt to the project's ORM conventions discovered in Phase 0, but keep the **relationships and constraints**.

## 1. Conventions

| ID | Rule |
|----|------|
| DAT-001 | Primary keys: UUID (v7 preferred for index locality). Human-facing stable keys (`key`/`slug`) where needed for config transfer (SYS-022). |
| DAT-002 | All config tables carry `created_at`, `created_by`, `updated_at`, `updated_by`, `version` (optimistic locking). |
| DAT-003 | Soft delete via `deleted_at` only for trash-capable objects (workspaces, items, fields); otherwise hard delete guarded by *Where used*. |
| DAT-004 | No string references to names across tables — always FK by ID (rename-safe, IAM-043). |
| DAT-005 | Secrets columns encrypted at application level (envelope encryption, key from KMS/HSM or env-provided KEK) and never returned by APIs. |
| DAT-006 | Translatable text in `translations(object_type, object_id, field, locale, value)`. |

## 2. Schema overview

### 2.1 Identity

| Table | Key columns | Notes |
|-------|-------------|-------|
| `directories` | id, type, name, position, config (encrypted JSON), enabled, last_sync_* | Ordered |
| `users` | id, directory_id, username, email, display_name, account_type, status, external_id, locale, timezone, manager_id, mfa_enrolled, last_login_at, last_active_at | Unique (directory_id, lower(username)) |
| `user_credentials` | user_id, password_hash (Argon2id), password_changed_at, failed_attempts, locked_until | Internal directory only |
| `user_mfa_factors` | id, user_id, type (totp/webauthn), secret/credential (encrypted), created_at, last_used_at | |
| `sessions` | id, user_id, created_at, last_seen_at, ip, user_agent, revoked_at | |
| `api_tokens` | id, user_id, name, token_hash, scopes, expires_at, last_used_at, last_used_ip, revoked_at | |
| `groups` | id, directory_id, name, description, is_approval_group, is_system, approval_rule_default, settings JSON | |
| `group_memberships` | group_id, member_type (`user`/`group`), member_id | Cycle check |
| `group_effective_members` | group_id, user_id | Materialised; rebuilt on change |
| `group_managers` | group_id, principal_type, principal_id | IAM-044 |
| `teams` | id, name, lead_user_id, linked_group_id, calendar_id, status | |
| `team_members` | team_id, user_id, team_role | |
| `customer_organisations` | id, name | |
| `customer_organisation_members` | organisation_id, user_id | |
| `workspace_customer_organisations` | workspace_id, organisation_id | |
| `application_access` | access_type, group_id, is_default | Licences |

### 2.2 Authorisation

| Table | Key columns |
|-------|-------------|
| `global_permission_grants` | permission_key, group_id |
| `admin_scope_grants` | scope_key, group_id |
| `workspace_roles` | id, name, description, is_protected |
| `workspace_role_defaults` | role_id, principal_type, principal_id |
| `workspace_role_members` | workspace_id, role_id, principal_type (`user`/`group`/`team`), principal_id |
| `permission_schemes` | id, key, name, description |
| `permission_scheme_grants` | scheme_id, permission_key, grantee_type, grantee_value (nullable) |
| `item_security_schemes` | id, key, name, default_level_id |
| `item_security_levels` | id, scheme_id, name, description |
| `item_security_level_grants` | level_id, grantee_type, grantee_value |
| `field_permission_rules` | field_configuration_id, field_id, mode (`view`/`edit`), grantee_type, grantee_value |

### 2.3 Workspaces & scheme associations

| Table | Key columns |
|-------|-------------|
| `workspaces` | id, key, name, type, lead_user_id, category_id, avatar, status (active/archived), deleted_at |
| `workspace_key_history` | workspace_id, old_key |
| `workspace_categories` | id, name |
| `workspace_scheme_associations` | workspace_id, scheme_type (`item_type`/`workflow`/`item_type_screen`/`field_config`/`permission`/`item_security`/`notification`/`priority`), scheme_id — unique (workspace_id, scheme_type) |
| `workspace_templates` | id, key, name, type, scheme_defaults JSON |

### 2.4 Items, types, workflow

| Table | Key columns |
|-------|-------------|
| `item_types` | id, name, icon, hierarchy_level |
| `item_type_schemes` / `item_type_scheme_entries` | scheme_id, item_type_id, position, is_default |
| `statuses` | id, name, category |
| `resolutions` | id, name, position, is_default |
| `priorities` / `priority_schemes` / `priority_scheme_entries` | |
| `workflows` | id, key, name, description, state, published_version |
| `workflow_versions` | workflow_id, version, definition JSONB, published_at, published_by, checksum |
| `workflow_statuses` | workflow_id, version, status_id (normalised for queries) |
| `workflow_schemes` / `workflow_scheme_entries` | scheme_id, item_type_id (null = default), workflow_id; plus `draft_of_scheme_id` |
| `items` | id, workspace_id, number, key, item_type_id, status_id, resolution_id, priority_id, summary, description, reporter_id, assignee_id, team_id, security_level_id, parent_id, workflow_id, workflow_version, version, created_at, updated_at, resolved_at, deleted_at |
| `item_history` | item_id, actor, at, field_id, from_value, to_value |
| `approval_steps` | id, item_id, approval_def_id, status, rule, started_at, decided_at, outcome, approvers_snapshot JSON |
| `approval_decisions` | step_id, approver_id, on_behalf_of, decision, comment, channel, at |
| `approval_matrices` / `approval_matrix_rows` | match field/value → approver principal |
| `sla_calendars`, `sla_metrics`, `sla_goals`, `item_sla_cycles` | |
| `custom_events` | id, key, name, description |
| `webhooks`, `webhook_deliveries` | |
| `outbox_events` | id, aggregate_type, aggregate_id, event_type, payload JSONB, schema_version, created_at, dispatched_at, attempts |

### 2.5 Fields & screens

| Table | Key columns |
|-------|-------------|
| `fields` | id (e.g. `cf_10042` / system key), name, description, type_key, searcher_key, is_system, is_locked, deleted_at |
| `field_contexts` | id, field_id, name, all_workspaces bool, all_item_types bool, default_value JSONB |
| `field_context_workspaces` / `field_context_item_types` | context_id, workspace_id / item_type_id |
| `field_options` | id, context_id, parent_option_id, value, position, disabled |
| `item_field_values` | item_id, field_id, value_text, value_number, value_date, value_option_id, value_user_id, value_json (typed columns; index per type) |
| `field_configurations` | id, key, name |
| `field_configuration_items` | config_id, field_id, required, hidden, renderer, description_override, display_rules JSON |
| `field_configuration_schemes` / `_entries` | scheme_id, item_type_id (null = default), config_id |
| `screens` | id, key, name, layout JSON |
| `screen_tabs` | id, screen_id, name, position |
| `screen_tab_fields` | tab_id, field_id, position, layout_hints JSON |
| `screen_schemes` / `screen_scheme_entries` | scheme_id, operation (`default`/`create`/`edit`/`view`), screen_id |
| `item_type_screen_schemes` / `_entries` | scheme_id, item_type_id (null = default), screen_scheme_id |
| `request_types` | id, workspace_id, item_type_id, name, icon, groups, visibility, form JSON, status_labels JSON |

### 2.6 Notifications & email

| Table | Key columns |
|-------|-------------|
| `notification_schemes` / `notification_scheme_rules` | scheme_id, event_key, recipient_type, recipient_value, channels[] |
| `notification_channel_policies` | event_key, channel, enabled, user_overridable, mandatory |
| `user_notification_preferences` | user_id, event_category, channel, enabled, digest_mode, quiet_hours JSON |
| `notification_templates` / `notification_template_versions` | event_key, channel, audience, locale, workspace_id (nullable), version, subject, body, state |
| `notifications` (in-app) | id, user_id, event_key, item_id, payload JSON, group_key, read_at, created_at |
| `notification_deliveries` | id, event_id, recipient (user_id/email), channel, template_version, status, attempts, provider_message_id, error, trace JSON, created_at, sent_at |
| `mail_servers_outgoing` / `mail_servers_incoming` | id, type, config (encrypted), is_default, enabled |
| `mail_handlers` / `mail_processing_log` | |
| `email_suppressions` | address, reason, created_at |

### 2.7 System, branding, observability

| Table | Key columns |
|-------|-------------|
| `settings` | key, scope, type, value JSONB, version, updated_by, updated_at, locked_by_env |
| `branding_versions` | version, state, tokens JSON, assets JSON, published_at, published_by |
| `assets` | id, content_hash, mime, size, purpose, storage_path |
| `announcements` | id, severity, content (translations), audience, starts_at, ends_at, dismissible |
| `audit_events` | spec 09 §8 fields; partitioned by month; append-only |
| `health_check_results` | check_id, status, message, duration_ms, ran_at, node_id |
| `health_check_snoozes` | check_id, reason, until, by |
| `metrics_rollups` | metric, labels JSON, bucket_start, resolution, count, sum, p50, p95, p99 |
| `usage_daily` | date, metric, dimension, value |
| `config_findings` | finding_type, object_type, object_id, detected_at, resolved_at |
| `jobs`, `job_runs`, `long_running_tasks` | |
| `migration_exceptions` | source, legacy_ref, reason, payload JSON, resolved_at |

## 3. API conventions

| ID | Rule |
|----|------|
| API-001 | REST + JSON under `/api/v1`; admin APIs under `/api/v1/admin/...`; SCIM under `/scim/v2`. OpenAPI 3.1 generated and published at `/api/docs` (authenticated). |
| API-002 | Auth: session cookie (browser, CSRF token required for unsafe methods) or `Authorization: Bearer <PAT>`. |
| API-003 | Errors: RFC 9457 Problem Details `{type, title, status, detail, instance, errors[{field, code, message}], requestId}`. |
| API-004 | Pagination: cursor-based `?limit=&cursor=`; response `{values, nextCursor, total?}` (total only where cheap and permission-safe). |
| API-005 | Optimistic locking: `If-Match: <version>` on PUT/PATCH for config objects; `409` on conflict. |
| API-006 | `Idempotency-Key` header honoured on POST for creates, transitions and bulk operations. |
| API-007 | Rate limiting per token/user with `429` + `Retry-After`; admin can view and tune limits. |
| API-008 | Long operations return `202 Accepted` + `Location: /api/v1/admin/tasks/{id}`. |
| API-009 | Every response carries `X-Request-Id`; audit and logs link by it. |

## 4. Endpoint catalogue (admin)

| Resource | Endpoints |
|----------|-----------|
| Users | `GET/POST /admin/users`, `GET/PATCH /admin/users/{id}`, `POST /admin/users/{id}/deactivate`, `/reactivate`, `/reset-password`, `/revoke-sessions`, `/reset-mfa`, `/unlock`, `/anonymise`; `POST /admin/users/import` (dry-run flag); `GET /admin/users/{id}/effective-access` |
| Invitations | `GET/POST /admin/invitations`, `DELETE /admin/invitations/{id}`, `POST /admin/invitations/{id}/resend` |
| Groups | `GET/POST /admin/groups`, `GET/PATCH/DELETE /admin/groups/{id}`, `GET/POST/DELETE /admin/groups/{id}/members`, `GET /admin/groups/{id}/where-used` |
| Teams | `GET/POST /admin/teams`, `GET/PATCH/DELETE /admin/teams/{id}`, `.../members` |
| Directories | `GET/POST /admin/directories`, `PATCH/DELETE /admin/directories/{id}`, `POST .../test`, `POST .../sync`, `PUT /admin/directories/order` |
| SSO | `GET/PUT /admin/sso/saml`, `GET /admin/sso/saml/sp-metadata`, `GET/PUT /admin/sso/oidc`, `GET/PUT /admin/security/policies` |
| Global permissions | `GET /admin/global-permissions`, `POST/DELETE /admin/global-permissions/{key}/groups/{groupId}` |
| Admin scopes | `GET /admin/admin-scopes`, `POST/DELETE /admin/admin-scopes/{key}/groups/{groupId}` |
| Roles | `GET/POST /admin/roles`, `PATCH/DELETE /admin/roles/{id}`, `GET/PUT /admin/roles/{id}/defaults` |
| Workspace roles membership | `GET/POST/DELETE /workspaces/{key}/roles/{roleId}/members` |
| Permission schemes | `GET/POST /admin/permission-schemes`, `GET/PATCH/DELETE /{id}`, `POST/DELETE /{id}/grants`, `POST /{id}/copy`, `GET /admin/permission-schemes/compare?a=&b=` |
| Item security | `GET/POST /admin/item-security-schemes`, `.../levels`, `.../levels/{id}/grants` |
| Permission helper | `POST /admin/permission-helper/explain` `{userId, workspaceId?, itemKey?, permission}` |
| Access review | `POST /admin/access-review/exports` (202 → task) |
| Workspaces | `GET/POST /admin/workspaces`, `PATCH /{id}`, `POST /{id}/archive`, `/restore`, `/change-key`, `DELETE` (trash); `GET/PUT /admin/workspaces/{id}/schemes/{schemeType}` (202 when migration needed) |
| Item types / schemes | standard CRUD + `POST /admin/item-types/{id}/migrate` |
| Statuses / resolutions / priorities | standard CRUD |
| Workflows | `GET/POST /admin/workflows`, `GET /{id}`, `GET /{id}/versions`, `GET /{id}/versions/{v}`, `PUT /{id}/draft`, `DELETE /{id}/draft`, `POST /{id}/draft/validate`, `POST /{id}/draft/publish` (body: status mappings), `POST /{id}/simulate`, `POST /admin/workflows/import`, `GET /{id}/export` |
| Workflow schemes | CRUD + `PUT /{id}/draft`, `POST /{id}/draft/publish` |
| Events | `GET/POST /admin/events`, `PATCH/DELETE /{id}` |
| Approval matrices | CRUD |
| SLA | `GET/POST /admin/sla/calendars`; `GET/POST /workspaces/{key}/sla/metrics`, `POST .../recalculate` |
| Fields | `GET/POST /admin/fields`, `GET/PATCH/DELETE /{id}`, `.../contexts` CRUD, `.../contexts/{cid}/options` CRUD + reorder, `GET /{id}/where-used`, `GET /{id}/usage`, `POST /admin/fields/explain` |
| Field configs / schemes | CRUD + associate |
| Screens / screen schemes / item type screen schemes | CRUD + `POST /admin/screens/{id}/preview` `{workspaceId, itemTypeId}` |
| Request types | `GET/POST /workspaces/{key}/request-types`, `PATCH/DELETE /{id}` |
| Notifications | `GET /admin/notifications/overview`, `GET /admin/notification-events`, schemes CRUD + rules, `GET/PUT /admin/notification-policies`, templates CRUD + `/draft`, `/publish`, `/preview`, `/test-send`; `GET /admin/notification-deliveries`, `POST /{id}/resend`; `POST /admin/notifications/helper` |
| Mail | outgoing/incoming servers CRUD + `/test`, `POST /admin/mail/test-email`, `GET /admin/mail/queue`, `POST /admin/mail/queue/retry`, `/flush`; handlers CRUD; `GET /admin/mail/incoming/log` |
| Branding | `GET /branding/tokens` (public), `GET/PUT /admin/branding/draft`, `POST /admin/branding/draft/publish`, `POST /admin/branding/reset`, `POST /admin/assets` (multipart), `GET /admin/branding/versions` |
| Announcements | CRUD `/admin/announcements`; `GET /announcements/active` (public/filtered) |
| Settings | `GET /admin/settings?prefix=`, `PATCH /admin/settings`; `GET/PUT /admin/settings/base-url` (+ `POST /admin/settings/base-url/verify`) |
| Config transfer | `POST /admin/config/export`, `POST /admin/config/import` (dry-run, 202) |
| Webhooks | CRUD + `GET /{id}/deliveries`, `POST /{id}/test` |
| Health | `GET /status`, `/health/live`, `/health/ready`, `GET /admin/health`, `POST /admin/health/{checkId}/run`, `POST /admin/health/{checkId}/snooze` |
| Insights | `GET /admin/insights/performance?metric=&range=&groupBy=`, `/cluster`, `/usage`, `/configuration-findings` |
| Jobs & tasks | `GET /admin/jobs`, `POST /admin/jobs/{id}/run`, `/pause`, `/resume`; `GET /admin/tasks/{id}`, `POST /admin/tasks/{id}/cancel` |
| Logging | `GET/PUT /admin/logging/levels`, `POST /admin/logging/mark`, `POST /admin/support-zip` |
| Audit | `GET /admin/audit` (filters), `GET /admin/audit/{id}`, `POST /admin/audit/exports`, `GET/PUT /admin/audit/settings` |

End-user: `GET /me`, `PATCH /me/preferences`, `GET/PUT /me/notification-preferences`, `GET/POST/DELETE /me/tokens`, `GET /me/sessions`, `DELETE /me/sessions/{id}`, `GET /notifications`, `POST /notifications/read`, `GET /approvals`, `POST /items/{key}/approvals/{stepId}/decision`.

## 5. Domain events (internal bus + outbox)

| Event | Consumers |
|-------|-----------|
| `user.created/updated/deactivated/anonymised` | Permission cache, licence counter, audit, search |
| `group.membership.changed`, `group.nesting.changed` | Effective-membership rebuild, permission cache, approval recalculation prompts |
| `team.membership.changed` | Permission cache |
| `role.membership.changed` | Permission cache |
| `scheme.updated` (any type), `workspace.scheme.associated` | Config caches, permission cache |
| `workflow.published` | Workflow cache, migration jobs |
| `field.*`, `screen.*` | Form/config caches, search mappings |
| `settings.changed` (incl. base URL) | Cluster config refresh |
| `branding.published` | Token cache, CDN manifest |
| Item events (spec 05 WFL-080) | Notifications, SLA, webhooks, search, usage metrics |

Cluster-wide cache invalidation uses pub/sub (e.g. Redis channels or broker topic) keyed by event type + object ID.

## 6. Seed data (idempotent, keyed by stable `key`)

| Object | Seeded records |
|--------|----------------|
| Groups | `system-administrators`, `instance-administrators`, `app-users`, `service-agents`, `admin-alerts` |
| Global permissions | Per spec 04 §2 default grantees |
| Admin scopes | none granted (System/Instance admins imply all) |
| Application access | `software` → `app-users` (default), `service-agent` → `service-agents` |
| Workspace roles | Administrators, Members, Viewers, Agents, Approvers, Developers |
| Permission schemes | `default-permission-scheme`, `default-service-permission-scheme` |
| Notification schemes | `default-notification-scheme` (spec 07 §4) |
| Channel policies | Per spec 07 §4/§8 (mentions, approvals, security mandatory) |
| Email templates | All events × (email, in-app) × (internal, customer) × `en` (+ `ar` placeholders) |
| Item types & scheme | spec 02 DOM-023; `default-item-type-scheme`, `default-service-item-type-scheme` |
| Statuses | To Do, In Progress, In Review, Done, Open, Waiting for support, Waiting for customer, Waiting for approval, Pending, Resolved, Closed, Cancelled, Declined |
| Resolutions | Done, Won't do, Duplicate, Cannot reproduce, Declined |
| Priorities | Highest, High, Medium (default), Low, Lowest |
| Workflows | `default-workflow` (To Do → In Progress → Done, global transitions), `service-request-with-approval` (Open → Waiting for approval → In Progress → Resolved → Closed; Declined), `incident` (Open → In Progress → Waiting for customer ↔ → Resolved → Closed) |
| Workflow schemes | `default-workflow-scheme`, `default-service-workflow-scheme` |
| Screens & schemes | `default-screen`, `resolve-screen`, `default-screen-scheme`, `default-item-type-screen-scheme`; service equivalents |
| Field configuration | `default-field-configuration` + scheme |
| SLA calendars | `24x7`, `uae-standard-mon-fri` (Asia/Dubai, 08:00–16:00 configurable) |
| Workspace templates | Software (Scrum/Kanban), Business, IT service management, General service |
| Branding | Product defaults (neutral palette), version 1 published |
| Settings | spec 08 §7 defaults |
| Health checks | All registered, enabled |
| Scheduled jobs | spec 09 OBS-050 list |
