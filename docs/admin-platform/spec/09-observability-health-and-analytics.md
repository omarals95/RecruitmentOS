# 09 — Observability, Health, Analytics & Audit

Access: read-only pages require `VIEW_SYSTEM_INSIGHTS` or `scope.insights.view`; actions (log levels, re-index, job control) require `SYSTEM_ADMIN` or `scope.system.general`.

## 1. Admin home / system overview (`/admin`)

| Widget | Content |
|--------|---------|
| Instance status | Overall health (green/amber/red) = worst active health check; version, build, uptime, environment label |
| Health checks summary | Count by status; top failing checks with *View* |
| Performance tiles | p95 API latency (15 min), error rate %, requests/min, active users now |
| Capacity tiles | Licences used / capacity, DB size, file store size, search index size |
| Queues | Mail queue depth, notification queue depth, job queue backlog, dead-letter count |
| Recent admin activity | Last 10 audit events |
| Alerts | Open admin alerts (cert expiry, sync failure, disk space) |

## 2. Health checks (`/admin/insights/health`)

Jira DC-style *Instance health* (supportability checks), each implemented as a pluggable `HealthCheck` with `id`, `category`, `severity`, `run()`, `remediation` (text + doc link), `interval`.

| ID | Check | Category | Warn | Critical |
|----|-------|----------|------|----------|
| OBS-H01 | Database connectivity & latency | Database | latency > 50 ms | unreachable |
| OBS-H02 | DB connection pool utilisation | Database | > 80 % | > 95 % / waits |
| OBS-H03 | Schema migrations up to date | Database | — | pending / failed |
| OBS-H04 | DB collation/encoding/version supported | Database | deprecated | unsupported |
| OBS-H05 | Cache (e.g. Redis) connectivity, memory, eviction rate | Cache | evictions high | unreachable |
| OBS-H06 | Search index health: reachable, doc count vs DB count drift, last full reindex | Search | drift > 0.5 % | drift > 5 % / unreachable |
| OBS-H07 | Queue/broker connectivity; backlog age | Queue | oldest > 5 min | oldest > 30 min |
| OBS-H08 | Outgoing mail server reachable; mail queue errors | Mail | errors > 0 | server down / queue stuck |
| OBS-H09 | Incoming mail handlers last success | Mail | > 15 min | > 1 h |
| OBS-H10 | Disk space (app nodes, shared home/file store) | Storage | < 20 % free | < 10 % free |
| OBS-H11 | File store read/write test | Storage | slow | failure |
| OBS-H12 | Cluster node heartbeat & version consistency | Cluster | node stale > 60 s | node lost / mixed versions |
| OBS-H13 | Cluster clock skew | Cluster | > 1 s | > 5 s |
| OBS-H14 | Base URL matches reachable URL (SYS-002) | Configuration | mismatch | — |
| OBS-H15 | TLS certificate expiry (base URL, SMTP, LDAP, IdP signing cert) | Security | < 30 days | < 7 days / expired |
| OBS-H16 | Directory sync status | Identity | last sync failed | 3 consecutive failures |
| OBS-H17 | SSO configuration valid (IdP metadata reachable, signing cert valid) | Identity | cert < 30 days | invalid |
| OBS-H18 | Licence usage | Licensing | > 90 % | > 100 % / expired |
| OBS-H19 | Scheduler running; jobs overdue | Jobs | job overdue | scheduler stopped |
| OBS-H20 | Runtime memory / GC or event-loop lag | Runtime | > 80 % heap / lag > 100 ms | OOM risk / lag > 500 ms |
| OBS-H21 | Thread/worker pool saturation | Runtime | > 80 % | exhausted |
| OBS-H22 | Backup recency (if reported by ops integration) | Operations | > 26 h | > 50 h |
| OBS-H23 | Security: anonymous access enabled, `PUBLIC` grants present, admins without MFA, default credentials | Security | any present | default credentials |
| OBS-H24 | Outgoing webhooks failing / auto-disabled | Integrations | failures | disabled |
| OBS-H25 | Antivirus scanner reachable (if enabled) | Security | slow | unreachable |

| ID | Requirement |
|----|-------------|
| OBS-001 | Health page: grouped by category, status badges, last run, duration, *Run now*, *Run all*, history sparkline (last 7 days), remediation panel. *Snooze* (with reason & expiry) for known issues — audited. |
| OBS-002 | Endpoints for infrastructure: `GET /status` (public, minimal: `{state: RUNNING|MAINTENANCE|STARTING|ERROR}` — Jira `/status` equivalent), `GET /health/live`, `GET /health/ready` (load-balancer probes), `GET /api/v1/admin/health` (detailed, authenticated). |
| OBS-003 | Critical checks raise **admin alerts** (spec 07 §4 instance events) with de-duplication and recovery notifications. |

## 3. Performance analytics (`/admin/insights/performance`)

| Panel | Metrics | Breakdown |
|-------|---------|-----------|
| API performance | Requests/min, p50/p95/p99 latency, error rate (4xx, 5xx) | By endpoint (route template), method, node, workspace (top N) |
| Slowest endpoints | Top 20 by p95 and by total time | Click → trace samples |
| Page performance (RUM) | Time to first byte, LCP, INP, CLS, full page load for key pages (item view, board, queue, search, dashboard, portal) | Browser, region, page |
| Database | Query rate, p95 query time, slow queries (> 500 ms; normalised SQL fingerprint, count, mean, max), pool usage, locks/deadlocks | |
| Search | Query latency, indexing lag, index operations/min | |
| Background processing | Queue throughput, processing latency, retries, dead letters | By queue |
| Workflow engine | Transitions/min, p95 transition time, post-function failure rate, approval decision latency | By workflow |
| Permission engine | Checks/sec, cache hit ratio, p95 check time (target PRM §8.3) | |
| Notifications | Emails/min, send latency, failures | By provider |
| Runtime | CPU, memory, GC/event-loop lag, threads/workers, open file handles | By node |

| ID | Requirement |
|----|-------------|
| OBS-010 | Time ranges: last 15 min / 1 h / 24 h / 7 d / 30 d / custom; auto-refresh; compare-to-previous-period overlay. |
| OBS-011 | Instrumentation via **OpenTelemetry** (traces, metrics, logs) with route-template naming; metrics also exposed at `/metrics` (Prometheus format, authenticated or network-restricted) so ops can use Grafana/Datadog/Azure Monitor alongside the built-in dashboards. |
| OBS-012 | Built-in dashboards read from an internal metrics store (time-series table or embedded TSDB) with downsampling: raw 1 min for 7 days, 15 min for 90 days, 1 h for 13 months. |
| OBS-013 | **Trace sampling**: 1–10 % default (configurable), 100 % for errors and requests > slow threshold; trace viewer shows spans (HTTP → service → DB/search/cache). PII is not recorded in span attributes. |
| OBS-014 | **SLO definitions** (optional): e.g. "95 % of item view requests < 1 s"; show error-budget burn. |

## 4. Cluster & infrastructure (`/admin/insights/cluster`)

| ID | Requirement |
|----|-------------|
| OBS-020 | Node table: node ID, host/IP, version, state (active/offline/draining), uptime, last heartbeat, CPU, memory, active requests, sessions, cache status. Actions: *Drain* / *Remove offline node* (System admin). |
| OBS-021 | Shared resources panel: DB (version, size, connections), cache, search cluster, file store, queue broker — each with status and key metrics. |

## 5. Usage insights (`/admin/insights/usage`)

| Panel | Metrics |
|-------|---------|
| Users | DAU / WAU / MAU, active vs licensed, logins by method (local/SSO), MFA adoption %, inactive > 90 days, new users trend |
| Workspaces | Count by type/category, items per workspace, most/least active, archived count, growth trend |
| Items | Created/resolved per day, backlog trend, items by status category, average cycle time by workspace |
| Service | Requests by channel (portal/email/API), SLA met %, breaches by workspace, top request types, approval turnaround (median/p90) |
| Features | Usage of boards, dashboards, filters, API (calls by token/client), integrations |
| Storage | Attachments size by workspace, growth trend, largest attachments |

| ID | Requirement |
|----|-------------|
| OBS-030 | All panels exportable (CSV) and shareable as a scheduled report email to admins (weekly). |
| OBS-031 | Usage metrics computed by nightly aggregation jobs into summary tables (no heavy queries on live tables during business hours). |

## 6. Configuration hygiene ("Optimiser")

Jira DC admins rely on clean-up insights; make them first-class (`/admin/insights/configuration`).

| Finding | Detection | Action offered |
|---------|-----------|----------------|
| Unused custom fields | No values / not on any screen / not in any context | Trash |
| Custom fields with global context & many options | Context = global, options > 100 | Scope context |
| Duplicate-named fields | Same normalised name | Review / merge values |
| Unused schemes (all types) | Not associated | Delete |
| Inactive workflows | Not in any scheme | Delete |
| Unused statuses/resolutions/item types/screens | Not referenced | Delete |
| Empty or orphan groups | 0 members / not used anywhere | Delete |
| Single-user grants | Permission/notification rules granted to individual users | Replace with role/group |
| Over-privileged | `PUBLIC`, `ANYONE_LOGGED_IN` browse, many admins | Review |
| Stale workspaces | No activity > N days | Archive |
| Inactive licensed users | No login > N days | Deactivate |

| ID | Requirement |
|----|-------------|
| OBS-040 | Findings computed by a scheduled job (daily) with counts trend; each finding links to the impacted objects and supports bulk action with impact analysis and audit. |

## 7. Background jobs & queues (`/admin/system/jobs`)

| ID | Requirement |
|----|-------------|
| OBS-050 | Scheduled jobs list: name, schedule (cron), last run (status, duration), next run, *Run now*, *Pause/Resume*, history. Includes: directory sync, SLA checker, digest sender, usage aggregation, hygiene scan, retention purge, trash purge, cert expiry check, search index consistency. |
| OBS-051 | Long-running tasks (migrations, re-index, bulk changes, anonymisation, config import) shown with progress %, ETA, initiator, *Cancel* where safe, and downloadable result report. |
| OBS-052 | Queue view: per queue depth, rate, oldest age, dead letters with *Inspect*, *Retry*, *Purge* (audited). |
| OBS-053 | **Search index management**: full re-index (background, zero-downtime via alias swap), workspace re-index, consistency check. |

## 8. Audit log (`/admin/audit`) — `VIEW_AUDIT_LOG` / `scope.audit.view`

| Field | Notes |
|-------|-------|
| `id`, `timestamp` (UTC, ms) | |
| `actor` | user ID + display name snapshot; or `system`, `automation`, `scim`, `directory-sync` |
| `actor_ip`, `user_agent`, `node_id`, `request_id`, `session_id` | |
| `category` | `security`, `users`, `groups`, `permissions`, `workspaces`, `workflows`, `fields`, `screens`, `notifications`, `email`, `branding`, `system`, `integrations`, `items` (coverage level dependent) |
| `action` | e.g. `group.member.added`, `permission_scheme.grant.removed`, `workflow.published` |
| `object_type`, `object_id`, `object_name` | |
| `scope` | instance / workspace ID |
| `changes` | JSON array of `{field, from, to}` (secrets masked) |
| `outcome` | success / failure (+ reason) |
| `integrity_hash` | Hash chain (`hash(prev_hash + record)`) for tamper evidence |

| ID | Requirement |
|----|-------------|
| AUD-001 | Audit records are **append-only** (no update/delete API; DB role used by the app has no UPDATE/DELETE on the audit table). Retention purge only via the retention job, itself audited. |
| AUD-002 | **Coverage levels** (Jira DC *audit log coverage*): `off` / `base` / `advanced` / `full` per category; `security`, `permissions`, `users`, `system` are always ≥ `base`. |
| AUD-003 | UI: search (free text), filters (date range, actor, category, action, object, workspace, outcome), saved views, record drawer with change diff, export CSV/JSON (export itself audited). |
| AUD-004 | **Workspace audit**: workspace admins see audit records scoped to their workspace. |
| AUD-005 | **Streaming** to external SIEM: syslog (RFC 5424, TLS), HTTPS webhook, or file output (JSON lines) for log shippers. Delivery status shown in admin. |
| AUD-006 | Hash-chain verification job (daily) raises a critical alert on mismatch. |
| AUD-007 | Retention default 3 years (configurable; respects legal hold). |

## 9. Logging & diagnostics (`/admin/system/logging`) — System admin

| ID | Requirement |
|----|-------------|
| OBS-060 | View and change **log levels** per logger/package at runtime (auto-revert after a chosen duration, default 1 h), cluster-wide. |
| OBS-061 | **Mark logs** (insert a marker line across all nodes — Jira feature) to bracket a reproduction. |
| OBS-062 | **Support zip**: generate diagnostic bundle (sanitised config, health results, recent logs, thread dumps, metrics snapshot, versions) — secrets and PII redacted; downloadable by System admin; audited. |
| OBS-063 | Structured JSON logs with `request_id`, `trace_id`, `user_id` (pseudonymised option), `workspace_id`. |

## 10. System information (`/admin/system/info`)

Read-only: product version/build/commit, environment, runtime versions, OS, DB type/version/driver, cache/search/queue versions, node list, timezone, default locale, installed language packs, enabled feature flags, licence summary, base URL, file store path/type, uptime. *Copy as text* for support tickets.
