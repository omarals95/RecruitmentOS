# 07 — Notifications & Email

## 1. Architecture

```
Domain event (outbox, spec 05 §12)
   └─► Notification Dispatcher
         1. Resolve notification scheme for item's workspace (or instance-level rules for non-item events)
         2. Resolve recipients per channel (scheme rules ∪ mentions ∪ explicit)
         3. Filter: active users, item visibility (PermissionService.canSeeItem), field permissions, user preferences, de-duplication, self-notification setting
         4. Batch/digest window (per user, per item)
         5. Render template (channel × locale × event) with branding
         6. Enqueue per channel ── Email queue ──► Mail sender (SMTP / Graph / API) ──► Delivery log
                                └─ In-app ──────► Notification centre store + real-time push (WebSocket/SSE)
                                └─ Webhook/chat (optional) ──► Teams / Slack connectors
```

| ID | Requirement |
|----|-------------|
| NTF-001 | All sending is **asynchronous** from a durable queue with retry (exponential backoff, max attempts configurable, default 5) and dead-letter. No email is sent inline in an HTTP request. |
| NTF-002 | Every notification attempt is written to the **delivery log** (§7) with status: `queued`, `sent`, `delivered`* (if provider supports), `failed`, `bounced`, `suppressed` (with reason), `read` (in-app). |
| NTF-003 | **Security filter**: a recipient never receives content for an item they cannot see; restricted comments and permission-restricted fields are stripped per recipient. Rendering is per-recipient-permission-set (cache by equivalent permission signature). |

## 2. Outgoing mail servers (`/admin/system/mail/outgoing`) — `scope.system.mail`

| Field | Notes |
|-------|-------|
| Provider type | `SMTP`, `Microsoft 365 (Graph API, OAuth 2.0 client credentials)`, `Google Workspace (OAuth 2.0)`, `Amazon SES API`, `SendGrid API` |
| Name, description | |
| From address | e.g. `no-reply@entity.ae` |
| **From name pattern** | Template e.g. `${actor.displayName} (${instance.title})` — Jira behaviour |
| Reply-to | Optional; for service workspaces, the workspace's incoming address |
| Email subject prefix | e.g. `[ServiceHub]` |
| SMTP: host, port, security (`None`/`STARTTLS`/`SSL/TLS`), auth (none/basic/OAuth2 XOAUTH2), username, secret, timeout | Secrets write-only, stored encrypted (KMS/envelope) |
| OAuth: tenant ID, client ID, client secret/certificate, sending mailbox | |
| Rate limit | Messages/minute to respect provider throttling |
| Format default | HTML + plain-text multipart (always both) |
| Status | Enabled/disabled; **Disable all outgoing mail** global switch (Jira) for non-prod |

| ID | Requirement |
|----|-------------|
| EML-001 | **Test connection** and **Send test email** (to entered address) with full SMTP transcript/provider response shown on failure. |
| EML-002 | Multiple outgoing servers allowed; one **default**; service workspaces can select a specific server (e.g. per-entity sender). |
| EML-003 | **Mail queue page**: queued count, oldest age, sending rate, error queue with *Retry*, *Retry all*, *Delete*, *View message* (rendered + headers). *Flush queue* action. |
| EML-004 | DNS guidance panel: show the instance's sending domain and checklist for SPF, DKIM, DMARC (informational; optional live DNS check). |
| EML-005 | **Non-production safety**: when `environment != production`, outgoing mail defaults to *disabled* or *redirect all to* a capture address, with a banner in admin. |
| EML-006 | **Bounce/complaint handling**: provider webhooks or bounce mailbox parsing → mark address `bouncing`; after N hard bounces, suppress and flag on user profile. |

## 3. Incoming mail (email channel) — `/admin/system/mail/incoming`

| ID | Requirement |
|----|-------------|
| EML-010 | Incoming mail servers: IMAP/POP3 (TLS), Microsoft Graph (OAuth), Google (OAuth); folder; polling interval (default 1 min); *Test connection*. |
| EML-011 | **Mail handlers**: per mailbox → action: *Create item in workspace X with type Y / request type Z*, *Add comment if subject contains item key*, *Create or comment*. Options: create users for unknown senders (customer accounts only), allow-list/deny-list domains, strip quoted replies, attachments handling (max size, blocked types), CC → request participants, catch-all address. |
| EML-012 | **Processing log**: each message with result (created FIN-123 / commented / rejected + reason), raw headers view, *Reprocess*. |
| EML-013 | Loop protection: ignore auto-replies (`Auto-Submitted`, `X-Autoreply`, `Precedence: bulk`), own outgoing addresses, and rate-limit per sender. |

## 4. Notification events

| Event | Default recipients (Default notification scheme) | Default channels |
|-------|---------------------------------------------------|------------------|
| Item created | Reporter, Assignee, Watchers, Workspace lead | Email + In-app |
| Item updated | Reporter, Assignee, Watchers | In-app (email off by default — reduces noise) |
| Item assigned | Assignee (new + previous), Watchers | Email + In-app |
| Item transitioned (generic) | Reporter, Assignee, Watchers | In-app |
| Item resolved | Reporter, Assignee, Watchers | Email + In-app |
| Item closed / reopened | Reporter, Assignee, Watchers | Email + In-app |
| Item deleted / moved | Reporter, Assignee, Watchers | Email + In-app |
| Comment added / edited | Reporter, Assignee, Watchers | Email + In-app |
| Comment deleted | — | — |
| Mentioned | Mentioned user (if can see item) | Email + In-app (**mandatory**) |
| Work logged / updated / deleted | — | — |
| Approval requested | Approvers of the step | Email + In-app (**mandatory**) |
| Approval reminder / escalated | Pending approvers / escalation target | Email + In-app |
| Approval decided | Reporter, Request participants | Email + In-app |
| SLA warning / breached | Assignee, Assignee team, Workspace lead | In-app + Email |
| Custom events | Configured | Configured |
| **Instance events** (not scheme-based) | | |
| User invited / password reset / MFA changed / new device login / token expiring | Affected user | Email (**mandatory, security**) |
| Added to group / role / team | Affected user | In-app |
| Licence threshold, health check critical, mail queue stuck, directory sync failed, cert expiring | Holders of `ADMIN` or a configured **admin alerts group** | Email + In-app |
| Customer notifications (service) | Customer, participants, organisation | Email (customer templates) |

## 5. Notification schemes

| ID | Requirement |
|----|-------------|
| NTF-010 | A notification scheme = rows of (event, recipient type, recipient value, **channels**: `email`, `in_app`, `chat`*). (Jira schemes are email-only; channel per rule is an enterprise extension.) |
| NTF-011 | **Recipient types**: Current user (actor), Reporter, Assignee, Assignee team, Watchers, Workspace lead, Component lead, Workspace role, Group, Team, Single user, Single email address (external), User custom field, Group custom field, Request participants, Customer organisation members, Approvers (current step), Reporter's manager. |
| NTF-012 | Scheme editor layout: rows = events (grouped: Item, Comments, Work, Approvals, SLA, Custom), columns = recipients chips with channel icons; *Add notification* dialog (multi-event × recipient × channels). |
| NTF-013 | Seeded **Default notification scheme** per §4 and a **Service desk customer notifications** configuration (separate, per service workspace, like JSM *Customer notifications*). |
| NTF-014 | Instance setting **Notify users of their own changes** (default off; Jira user preference equivalent). |
| NTF-015 | **Notification Helper**: given user + item + event → would they be notified, on which channels, and why/why not (scheme rule, permission filter, preference, suppression). |

## 6. Notification manager (`/admin/notifications`) — `scope.notifications.manage`

Central console answering "what is configured, what goes where, what was actually sent".

| Tab | Content |
|-----|---------|
| **Overview** | KPI tiles: sent today (email / in-app), failed (24 h), queue depth, oldest queued age, suppression count, top 10 noisiest events & workspaces; 30-day trend chart by channel. |
| **Event catalogue** | Every system + custom event: description, which schemes use it, channel defaults, *mandatory* flag, template link, enabled/disabled globally. |
| **Schemes** | List with *Used by*, editor (§5). |
| **Channel matrix** | Read-only grid: event × channel × (enabled globally / user-overridable / mandatory). Admin edits the policy here (§8). |
| **Templates** | §9. |
| **Delivery log** | §7. |
| **Digests & batching** | §8 settings. |
| **Chat integrations** (optional) | Teams / Slack incoming-webhook or app connections; per-workspace channel routing. |
| **Admin alerts** | Choose recipients group for system alerts; thresholds per alert type. |

## 7. Delivery log

| ID | Requirement |
|----|-------------|
| NTF-020 | Columns: timestamp, event, item key, recipient, channel, template version, status, attempts, provider message ID, error. Filters on all columns; export CSV. |
| NTF-021 | Drill-down shows the rendered message (with redaction marker for privileged viewers only), headers, and the **resolution trace** (why this recipient). |
| NTF-022 | Retention configurable (default 90 days content, 1 year metadata). |
| NTF-023 | *Resend* action for failed email (audited). |

## 8. Delivery policy, preferences & digests

| ID | Requirement |
|----|-------------|
| NTF-030 | Per event × channel policy: `enabled` (on/off globally), `user_overridable` (bool), `mandatory` (cannot be turned off — security, approvals, mentions). |
| NTF-031 | **User preferences** page (profile → Notifications): per event category × channel toggles (only overridable ones), **email format** (HTML/text), **digest mode** (immediate / batched every N minutes / daily digest at time), **watch own items automatically**, **quiet hours** (in-app only, email deferred to digest). |
| NTF-032 | **Batching** (Jira *batched email notifications*): changes to the same item by any users within a window (default 10 min) are combined into one email per recipient. |
| NTF-033 | **Throttling**: per-user cap (e.g. 200 emails/hour) → overflow goes to digest; per-workspace bulk-change suppression (bulk operations offer *Send notifications?* checkbox, default off for > 100 items — Jira behaviour). |
| NTF-034 | Unsubscribe link in every non-mandatory email (List-Unsubscribe header, one-click). |

## 9. Templates

| ID | Requirement |
|----|-------------|
| NTF-040 | Templates per (event, channel, audience = `internal` / `customer`, locale). Fallback chain: workspace override → instance template → system default; locale fallback → `en`. |
| NTF-041 | Engine: logic-less, sandboxed (e.g. Handlebars/Mustache/Liquid-safe). Variables documented in an in-editor **variable browser**: `item.*` (key, summary, status, fields by ID), `actor.*`, `recipient.*`, `workspace.*`, `instance.*` (title, baseUrl), `changes[]` (field, from, to), `comment.*`, `approval.*` (step, approve/decline links), `sla.*`, `links.view`, `links.unsubscribe`. |
| NTF-042 | All links are built from the configured **base URL** (spec 08 §5). Never from request host headers. |
| NTF-043 | Template editor: split view (code / rich editor) + **live preview** with sample item picker, desktop/mobile/dark-mode preview, RTL preview for Arabic, *Send test to me*. |
| NTF-044 | Templates are **versioned** (draft/publish), diffable, revertible; publish is audited. |
| NTF-045 | **Branded layout wrapper** (header with logo, accent colour, footer with legal text/address/unsubscribe) is applied automatically from branding settings (spec 08); templates render the body only. |
| NTF-046 | Email HTML must pass a compatibility check (inline CSS, table-based layout, max width 600 px, alt text on images, dark-mode-safe colours). |

## 10. In-app notification centre (end-user)

| ID | Requirement |
|----|-------------|
| NTF-050 | Bell icon with unread count in global header; panel with tabs *Direct* (mentions, assignments, approvals) and *Watching*; filters (unread only, workspace); actions: mark read/unread, mark all read, open, approve/decline inline (approvals), mute item. |
| NTF-051 | Real-time delivery via WebSocket/SSE; falls back to polling (60 s). |
| NTF-052 | Grouping: multiple updates to the same item collapse into one entry with a change list. |
| NTF-053 | Retention: 90 days (configurable); paging with infinite scroll. |
| NTF-054 | **My approvals** inbox (separate route `/approvals`) lists pending approvals across workspaces with SLA/age, bulk approve (where rules allow, requires comment option). |
