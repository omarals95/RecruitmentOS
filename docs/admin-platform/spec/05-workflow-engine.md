# 05 — Workflow Engine

## 1. Concepts

| Concept | Definition |
|---------|------------|
| **Status** | Global object: name, description, **category** (`TODO` grey, `IN_PROGRESS` blue, `DONE` green). Shared across workflows. |
| **Resolution** | Global object set when an item is considered resolved (Done, Won't do, Duplicate, Cannot reproduce, Declined). `resolution != null` ⇔ resolved. |
| **Workflow** | Named, versioned graph: statuses (nodes) + transitions (edges) + initial transition + rules. |
| **Transition** | Directed move from one or more source statuses (or *any*, = global transition) to a target status, with screen, conditions, validators, post-functions, properties, approval config. |
| **Workflow scheme** | Item type → workflow mapping with a default workflow. Associated to workspaces. |

## 2. Statuses & resolutions

| ID | Requirement |
|----|-------------|
| WFL-001 | Status admin page: list with category lozenge, workflows using it, item count; create/edit/delete (delete only if unused). |
| WFL-002 | Status names unique (case-insensitive). Status **colour** is derived from category (consistent UX), optional icon. |
| WFL-003 | Resolutions admin: ordered list, default resolution, *Where used*. Workflows may restrict allowed resolutions per transition via property `allowedResolutions`. |
| WFL-004 | Localised names for statuses/resolutions (en, ar) — spec 08 §6. |

## 3. Workflow definition

Workflows are stored as **versioned JSON documents** (draft + published versions) plus normalised lookup tables for query performance (status ↔ workflow).

```jsonc
{
  "id": "wf_8f2…",
  "name": "Service Request – Approval",
  "description": "Request with manager + budget approval",
  "version": 7,
  "state": "published",          // draft | published | archived
  "initial": { "transitionId": "t_create", "toStatus": "st_waiting_approval",
               "validators": [], "postFunctions": ["pf_create_item", "pf_fire_event:ITEM_CREATED"] },
  "statuses": [
    { "statusId": "st_waiting_approval", "layout": { "x": 120, "y": 80 },
      "properties": { "editable": false } },
    { "statusId": "st_in_progress", "layout": { "x": 360, "y": 80 } },
    { "statusId": "st_done", "layout": { "x": 600, "y": 80 } }
  ],
  "transitions": [
    {
      "id": "t_start", "name": "Start work",
      "from": ["st_open"], "to": "st_in_progress",
      "global": false,
      "screenId": null,
      "conditions": { "op": "AND", "rules": [
        { "type": "permission", "permission": "TRANSITION_ITEMS" },
        { "type": "inRole", "role": "Agents" }
      ]},
      "validators": [ { "type": "fieldRequired", "fieldId": "assignee" } ],
      "postFunctions": [
        { "type": "assignToCurrentUser", "onlyIfUnassigned": true },
        { "type": "fireEvent", "event": "ITEM_TRANSITIONED" }
      ],
      "properties": { "ui.buttonOrder": 1, "ui.hideFromPortal": true }
    }
  ],
  "approvals": [ /* see §7 */ ]
}
```

| ID | Requirement |
|----|-------------|
| WFL-010 | Workflow JSON is validated against a **JSON Schema** (`workflow.schema.json`) on save; designer and API share the schema. |
| WFL-011 | Graph validation on publish: exactly one initial transition; every status reachable from initial; at least one `DONE`-category status; no orphan statuses; every referenced status/field/screen/role/group/event exists; no unreachable transitions. Errors block publish; warnings (e.g. no path back from `DONE`) do not. |
| WFL-012 | **Global transitions** (`from: ["*"]`) are allowed (Jira "All" transition). **Self-loops** allowed. |
| WFL-013 | **Common transitions**: a transition definition may be reused across multiple source statuses with identical rules (single definition, multiple `from`). |

## 4. Transitions

| Element | Notes |
|---------|-------|
| Name / description | Shown as button label / tooltip. Localisable. |
| Screen | Optional transition screen (spec 06) to collect input (e.g. *Resolution*, *Comment*, *Time spent*). |
| Conditions | Who can see/execute it (§5). Evaluated when rendering available transitions **and** again on execution. |
| Validators | Check input before commit (§6). |
| Approval | Optional approval gate (§7). |
| Post-functions | Ordered side-effects after commit (§8). |
| Properties | Key–value metadata (`ui.*` display hints, `allowedResolutions`, `portal.label` for customer-facing name, `opsbar-sequence`). |
| Triggers | External events that auto-run this transition (e.g. *SLA breached*, *Approval completed*, *Customer replied*, *Webhook received*, *Linked item resolved*). |

## 5. Conditions catalogue

| Type | Parameters | Meaning |
|------|-----------|---------|
| `permission` | permission key | User holds workspace permission |
| `inRole` | role | User in workspace role |
| `inGroup` | group | User in group (effective) |
| `inTeam` | team / `itemTeam` | User in a team or the item's team |
| `isReporter` / `isAssignee` / `isWorkspaceLead` | — | Item-relative identity |
| `userInField` | user/group field | User is (in) value of field |
| `fieldValue` | field, operator, value | e.g. `priority IN (High, Critical)` |
| `subtasksStatus` | statuses | All sub-items in given statuses (block parent close) |
| `linkedItemsStatus` | link type, statuses | e.g. all *blocks* links resolved |
| `previousStatus` | status, mostRecentOnly | Item has been in status |
| `approvalState` | step, state | Approval step approved/declined/pending |
| `timeInStatus` | operator, duration | |
| `notReporter` | — | Segregation of duties (cannot transition own item) |
| `hideFromUser` | — | Only automation/trigger can run (Jira "Hide from user") |
| `expression` | safe expression (no code exec) | Sandboxed expression language for advanced rules |

| ID | Requirement |
|----|-------------|
| WFL-020 | Conditions compose with nested `AND`/`OR` groups and `NOT`. |
| WFL-021 | Failed conditions hide the transition in UI; the API returns `403` with a machine-readable reason when invoked anyway. |
| WFL-022 | **Expression language** must be sandboxed (no I/O, bounded execution time ≤ 50 ms, whitelisted functions). No arbitrary script execution (Groovy-style) in v1. |

## 6. Validators catalogue

| Type | Parameters |
|------|-----------|
| `fieldRequired` | field(s), message |
| `fieldChanged` | field, message (must be edited on this transition) |
| `fieldValueMatches` | field, operator, value / regex |
| `dateCompare` | field A, operator, field B / now ± offset |
| `permission` | permission (on a user-field value, e.g. *assignee must be assignable*) |
| `parentStatus` | sub-item cannot move past parent status |
| `attachmentRequired` | min count, file types |
| `commentRequired` | min length |
| `linkRequired` | link type |
| `uniqueValue` | field (unique within workspace) |
| `expression` | sandboxed expression + message |

| ID | Requirement |
|----|-------------|
| WFL-030 | Validators run server-side on submit; all failures are returned together (field-keyed errors) so the UI can highlight every invalid field. |
| WFL-031 | Field-level required rules from the **field configuration** (spec 06) apply in addition to validators; validators cannot relax them. |

## 7. Approvals

Approvals are first-class workflow steps (JSM behaviour, extended for multi-stage enterprise approvals).

```jsonc
"approvals": [
  {
    "id": "ap_manager",
    "status": "st_waiting_manager",         // approval is active while item is in this status
    "approvers": [ { "type": "reportersManager" } ],
    "rule": { "type": "any_one" },
    "onApprove": "t_mgr_approved",          // transition auto-run on decision
    "onDecline": "t_mgr_declined",
    "allowDelegation": true,
    "prohibitSelfApproval": true,
    "reminders": { "after": "PT24H", "repeat": "PT24H", "max": 3 },
    "escalation": { "after": "PT72H", "to": [ { "type": "group", "id": "grp_finance_approvers" } ] },
    "requireCommentOnDecline": true
  }
]
```

| Approver source type | Resolves to |
|----------------------|-------------|
| `user` | Fixed user |
| `group` | Members of an **approval group** (`is_approval_group = true` only) |
| `team` | Team members (or `teamLead`) |
| `role` | Workspace role members |
| `userField` / `groupField` | Value of an *Approvers* custom field (set by form or post-function) |
| `reportersManager` | `manager_id` of reporter (from directory) |
| `fieldDerived` | Mapping table: field value → approver (e.g. *Department = Finance* → *finance-approvers*), maintained in admin as an **approval matrix** |

| Rule | Behaviour |
|------|-----------|
| `any_one` | First approval approves; first decline declines |
| `all` | All must approve; any decline declines |
| `count:N` | N approvals approve; decline when approval becomes impossible |
| `percentage:P` | P % of resolved approvers |

| ID | Requirement |
|----|-------------|
| WFL-040 | Approvers can **Approve / Decline** from: item view, *My approvals* inbox, email (signed one-click links requiring login confirmation), and notification centre. |
| WFL-041 | Approver list is **snapshotted** when the step starts (membership changes later don't silently change who must approve); admins can **Recalculate approvers** explicitly (audited). |
| WFL-042 | Multi-stage approvals = sequential approval statuses; parallel approvals = multiple approval definitions on the same status with combined rule (`allSteps` / `anyStep`). |
| WFL-043 | Approval record: step, approver, decision, comment, timestamp, on-behalf-of (delegation), channel (web/email/API). Immutable. Displayed as an **approval timeline** on the item. |
| WFL-044 | `OVERRIDE_APPROVALS` permission allows forcing a decision with mandatory justification (audited, highlighted in timeline). |
| WFL-045 | Out-of-office: if approver has an active OOO delegation, the request routes to the delegate and records "on behalf of". |

## 8. Post-functions catalogue

**System post-functions** (always present, not removable, fixed order): `updateStatus` → `writeHistory` → `reindexItem` → `fireEvent`.

| Configurable type | Parameters |
|-------------------|-----------|
| `assignToCurrentUser` / `assignToReporter` / `assignToLead` / `assignToTeam` / `assignRoundRobin` / `assignLeastBusy` | team/role for pool |
| `setFieldValue` | field, value / expression / copy-from field |
| `clearField` | field |
| `setResolution` | resolution / clear |
| `addComment` | template, visibility |
| `addWatchers` | users/groups/role |
| `createSubItems` / `createLinkedItem` | template, workspace, type, field mapping |
| `transitionParent` / `transitionLinked` | condition, target transition |
| `setSecurityLevel` | level |
| `startSla` / `stopSla` (implicit via SLA conditions) | — |
| `sendWebhook` | registered webhook, payload template, retry policy (async, outbox) |
| `fireEvent` | system or **custom event** (feeds notification schemes, spec 07) |

| ID | Requirement |
|----|-------------|
| WFL-050 | Post-functions run in the **same DB transaction** as the status change, except external I/O (`sendWebhook`, notifications) which are written to an **outbox** and dispatched after commit. |
| WFL-051 | A post-function failure rolls back the whole transition and returns an error referencing the post-function ID (except async ones which retry/dead-letter). |

## 9. Transition execution pipeline

```
1. Load item (FOR UPDATE / optimistic version check)
2. Authorise: TRANSITION_ITEMS + item visibility                    (PermissionService)
3. Evaluate conditions                                             → 403 + reasons
4. If approval gate: verify approval state permits this transition → 409
5. Validate input: field configuration rules + transition screen + validators → 422 + field errors
6. Apply field changes from transition screen
7. Run system + configured post-functions (transactional)
8. Commit; write audit + history; append outbox events
9. Async: notifications, webhooks, SLA recalculation, search index update, triggers
```

| ID | Requirement |
|----|-------------|
| WFL-060 | Transition API: `POST /api/v1/items/{key}/transitions` with `{ transitionId, fields, comment, expectedVersion }`; idempotency key header supported. |
| WFL-061 | `GET /api/v1/items/{key}/transitions` returns only transitions passing conditions for the caller, including screen metadata for each. |
| WFL-062 | Optimistic concurrency: stale `expectedVersion` → `409` with current state. |
| WFL-063 | Trigger-driven transitions run as the **system automation user** (or a configured actor), are audited with trigger source, and cannot loop more than 10 times per item per minute (loop guard). |

## 10. Workflow schemes, versioning & migration

| ID | Requirement |
|----|-------------|
| WFL-070 | Workflow lifecycle: **Draft** (editable copy) → **Publish** (creates immutable version N+1). The previous published version is retained; *Revert to version* creates a new draft from it. Version diff view (statuses/transitions/rules added/removed/changed). |
| WFL-071 | Publishing a draft that **removes a status** in use requires a status mapping (old status → new status) and runs a migration job over affected items. |
| WFL-072 | Workflow scheme editor: table item type → workflow, default workflow, *Used by* workspaces. Changes are made as a **scheme draft** and published with the migration wizard if needed (Jira behaviour). |
| WFL-073 | Migration wizard steps: (1) summary of affected workspaces/item types/item counts; (2) status mapping per (item type, old status); (3) dry run with counts; (4) execute as background job with progress, pause/resume, and report; (5) audit. |
| WFL-074 | **Import/export** workflow as JSON (includes referenced statuses by name with create-if-missing option). |
| WFL-075 | Inactive (unassociated) workflows listed separately with *Delete* and last-used date (feeds config hygiene, spec 09). |

## 11. Workflow designer (UI)

| Area | Behaviour |
|------|-----------|
| Canvas | Drag statuses, draw transitions, snap-to-grid, zoom, minimap, auto-layout. Status node coloured by category; global transitions drawn as "All" badge. |
| Side panel | Selected status/transition properties; tabs: *General*, *Screen*, *Conditions*, *Validators*, *Approvals*, *Post-functions*, *Triggers*, *Properties*. Rule builders are form-based (no raw JSON required); JSON view available read-only + *Edit JSON* for System admins. |
| Text mode | Tabular view of transitions (from → to, name, rule counts) for accessibility and bulk review. |
| Validation | Live problems panel (errors/warnings with click-to-focus). |
| Simulation | **Test run**: choose an item type and a test user; step through transitions showing which conditions pass/fail and why. |
| Header | Draft/published badge, version, *Discard draft*, *Publish* (with impact summary), *Diff with published*. |
| Read-only view | For users with `VIEW_WORKFLOW_READONLY` on the item's workspace: simplified diagram showing current status highlighted. |

## 12. Events & extensibility

| ID | Requirement |
|----|-------------|
| WFL-080 | Domain events emitted (via outbox): `ITEM_CREATED`, `ITEM_UPDATED`, `ITEM_TRANSITIONED`, `ITEM_ASSIGNED`, `ITEM_RESOLVED`, `ITEM_REOPENED`, `ITEM_CLOSED`, `ITEM_DELETED`, `ITEM_MOVED`, `COMMENT_ADDED/EDITED/DELETED`, `WORKLOG_*`, `ATTACHMENT_*`, `APPROVAL_REQUESTED`, `APPROVAL_DECIDED`, `APPROVAL_ESCALATED`, `SLA_WARNING`, `SLA_BREACHED`, `MENTIONED`, custom events. |
| WFL-081 | **Custom events** are defined in *Admin → Workflows → Events* (name, description, default template) and fired by the `fireEvent` post-function. They appear in notification schemes. |
| WFL-082 | **Outgoing webhooks** admin: URL, secret (HMAC-SHA256 signature header), events filter, workspace filter (search expression), retry with exponential backoff, delivery log, disable after N consecutive failures. |
| WFL-083 | Event payloads are versioned (`schemaVersion`) and documented (spec 11) so a future automation engine can subscribe without changes to the workflow engine. |

## 13. SLAs (service workspaces)

| ID | Requirement |
|----|-------------|
| WFL-090 | **SLA calendars** (global): timezone, working days/hours (multiple ranges per day), holidays (one-off and recurring; import iCal); seeded "UAE standard (Mon–Fri)" and "24×7". |
| WFL-091 | **SLA metric** (per service workspace): name, *Start* conditions (e.g. item created, entered status X), *Pause* conditions (status *Waiting for customer*, resolution set), *Stop* conditions (resolution set, entered status Y, comment by agent); multiple **goals** ordered by matching search expression (e.g. `priority = Critical` → 4 h, calendar 24×7), with default goal. |
| WFL-092 | SLA timers stored as cycles (start, pauses, stop, breached flag, remaining). Recalculated on events; scheduler checks breaches every minute and emits `SLA_WARNING` (configurable threshold, e.g. 75 %) and `SLA_BREACHED`. |
| WFL-093 | SLA fields usable in queues, search, reports, conditions (`slaBreached`) and triggers. |
| WFL-094 | Changing an SLA definition offers *Recalculate for open items* (background job). |
