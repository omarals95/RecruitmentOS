# 06 — Centralised Custom Fields & Screen Configuration

## 1. Resolution chain (how a field ends up on a form)

```
Workspace ──(item type screen scheme)──► Item type ──► Screen scheme ──► Operation (Create | Edit | View) ──► Screen ──► Tabs ──► Fields
Workspace ──(field configuration scheme)──► Item type ──► Field configuration ──► per field: required | hidden | renderer | description | field permissions
Custom field ──(contexts)──► applies only where context scope matches (workspace × item type) → default value + options
Workflow transition ──► Transition screen (optional)
Service request type ──► Portal form (subset of fields with customer-facing labels)
```

A field **renders** on a form only if **all** are true:
1. It is on the resolved screen for that operation (or transition/portal form);
2. A context exists for the item's (workspace, item type) — system fields always pass;
3. The field configuration does not mark it **hidden**;
4. Field permissions (spec 04 PRM-050) allow the user to view it (and edit it for editable rendering).

| ID | Requirement |
|----|-------------|
| FLD-001 | The **Field resolution explainer** ("Where is my field?" — Jira *Where is my field*): from an item create/edit form or admin, select a field → show which of the four checks pass/fail with links to fix. |

## 2. Field registry

### 2.1 System fields (built-in, non-deletable)

Summary, Description, Item type, Status, Resolution, Priority, Assignee, Team, Reporter, Created, Updated, Due date, Resolved date, Labels, Components, Affects/Fix versions, Environment, Attachments, Linked items, Parent, Sub-items, Original/Remaining estimate, Time spent, Security level, Watchers, Votes, Request type (service), Request participants (service), Organisations (service), Approvers (service), SLA fields (service).

### 2.2 Custom field types

| Category | Type key | Notes / config |
|----------|----------|----------------|
| Text | `text_short` | max length, regex mask |
| Text | `text_paragraph` | renderer: plain / rich text (Markdown/WYSIWYG) |
| Text | `url`, `email`, `phone` | validation |
| Number | `number` | decimals, min/max, unit suffix |
| Number | `currency` | ISO 4217 currency (default AED), decimals |
| Number | `percentage` | |
| Date/time | `date`, `datetime` | min/max relative to today |
| Choice | `select_single`, `select_multi`, `radio`, `checkbox` | options managed per context; option ordering; disable (not delete) options in use |
| Choice | `select_cascading` | parent → child options |
| People | `user_single`, `user_multi` | filter: groups/roles allowed |
| People | `group_single`, `group_multi` | filter: approval groups only, etc. |
| People | `team` | |
| Reference | `workspace_picker`, `version_picker`, `item_picker` (search-scoped) | |
| Structured | `labels` (custom label set), `table` (repeating rows, typed columns, max rows) | |
| Computed | `calculated` | read-only sandboxed expression over other fields (e.g. total = qty × unit price) |
| Lookup | `external_lookup` | options from a registered external data source (REST, cached, admin-configured); v1 optional |
| Service | `asset_ref` | placeholder for future asset/CMDB module |

| ID | Requirement |
|----|-------------|
| FLD-010 | Field type registry is **pluggable**: each type implements `validate`, `serialise`, `deserialise`, `searchIndexMapping`, `renderView`, `renderEdit`, `renderPortal`, `toEmailText`, `exportValue`, and `compareForSort`. |
| FLD-011 | Field attributes: ID (stable, e.g. `cf_10042`), **name**, description, type, **searcher** (how it is searchable), localised names (en/ar), help text, icon, created/updated, `is_locked` (system/app-managed; not editable). |
| FLD-012 | Names need not be unique but the UI warns on duplicates and always shows the field ID in admin pickers (prevents Jira's duplicate-name confusion). |
| FLD-013 | Type change is **not** allowed after creation; provide *Migrate values to a new field* utility instead. |
| FLD-014 | Field values are stored in a typed value table (`item_field_values` with typed columns or JSONB + typed index tables) — **not** as untyped strings; search uses the search index mapping from FLD-010. |
| FLD-015 | Deleting a field: shows *Where used* (contexts, screens, field configs, workflows, filters, queues, SLAs, notification templates, request types, reports) and item count with values; deletion moves to **trash** (restorable 30 days) and then purges values by background job. |
| FLD-016 | **Field usage analytics** (feeds spec 09): items with value, last value update, screens count, contexts count — supports a "Custom field optimiser" clean-up list (unused, global-context-heavy, duplicates). |

## 3. Field contexts

| ID | Requirement |
|----|-------------|
| FLD-020 | A context has: name, **scope** = (all workspaces **or** list of workspaces) × (all item types **or** list of item types), **default value**, **options** (for choice types). |
| FLD-021 | A field may have multiple contexts; scopes must not overlap for the same (workspace, item type) — validated on save. A workspace-specific context overrides the global context. |
| FLD-022 | Options: add, rename (propagates; value stored by option ID), reorder, sort A–Z, **disable** (hidden from new selection, kept on existing items), delete (only if unused, or with value migration to another option). |
| FLD-023 | Admin UI warns when a field has a **global context** with many options (performance & clutter) — Jira best practice. |
| FLD-024 | Workspace admins may manage **options** of contexts scoped only to their workspace if `allowWorkspaceAdminOptionEdit = true`. |

## 4. Field configurations & schemes

| ID | Requirement |
|----|-------------|
| FLD-030 | A **field configuration** lists every field with: *Required* toggle, *Hidden* toggle, *Renderer* (where type supports more than one), *Description override* (help text), *Field permissions* (view/edit by roles/groups; PRM-050). |
| FLD-031 | **Field configuration scheme**: item type → field configuration, with default. Associated to workspaces. |
| FLD-032 | Required fields must also be on the **Create** screen; on save the admin UI flags "Required but not on create screen for item types X, Y" (prevents un-creatable items). |
| FLD-033 | System fields Summary, Item type, Reporter (when auto-set) cannot be hidden; Summary is always required. |

## 5. Screens

| ID | Requirement |
|----|-------------|
| SCR-001 | A **screen** = ordered **tabs**, each with an ordered list of fields. Name, description, *Used by* (screen schemes, workflow transitions). |
| SCR-002 | Screen editor: drag-and-drop fields between tabs, search-to-add field picker (shows field ID, type, contexts), remove, add/rename/reorder/delete tabs. Live preview panel rendering the form for a chosen workspace + item type (applies contexts & field configuration). |
| SCR-003 | **Layout extensions** (beyond Jira core, optional per screen): section headers, two-column layout for short fields, field width hints. Stored as layout metadata, not code. |
| SCR-004 | **Conditional display rules** (optional v1.1): show/require field B when field A = value. Server re-validates (P-05). Stored in field configuration as rules, not in screens, so API clients get the same behaviour. |
| SCR-005 | Copy screen; delete only if unused. |

### 5.1 Screen schemes & item type screen schemes

| ID | Requirement |
|----|-------------|
| SCR-010 | **Screen scheme**: operation → screen for `Default`, `Create`, `Edit`, `View`. Unset operations fall back to Default. |
| SCR-011 | **Item type screen scheme**: item type → screen scheme with default. Associated to workspaces. |
| SCR-012 | Admin UX simplification: the **Workspace configuration summary** (spec 02 DOM-033) and a **"Configure screens for this workspace" wizard** that hides the three-level scheme indirection: choose item type → see create/edit/view screens → *Edit* (if shared, prompt "Edit shared screen (affects N workspaces)" or "Copy and use for this workspace only" — which creates the copies and new scheme associations automatically). |

## 6. Request types & portal forms (service workspaces)

| ID | Requirement |
|----|-------------|
| SCR-020 | **Request type**: name, description, icon, **item type** mapping, **request group(s)** (portal categories), portal visibility (all customers / organisations / hidden — internal only), **portal form** (ordered subset of fields with customer-facing label, help text, required override (stricter only), hidden-with-preset-value fields), **customer-facing status names** per workflow status, **default approvers** override. |
| SCR-021 | Portal form fields must exist in the item type's field context for the workspace; otherwise the editor shows a fix action. |
| SCR-022 | Request type **workflow status mapping** table: internal status → customer-visible label (Jira JSM behaviour). |
| SCR-023 | Request types support **localisation** (en/ar) for names, descriptions, field labels and help text. |

## 7. Admin pages (fields & screens area)

| Page | Route | Key actions |
|------|-------|------------|
| Custom fields | `/admin/fields` | List (name, ID, type, contexts, screens, items with value, last used), filters (type, unused, global context), create wizard (type → name/description → contexts → screens to add) |
| Field detail | `/admin/fields/:id` | Tabs: General, Contexts & options, Screens, Field configurations, Where used, Usage, Audit |
| Field configurations | `/admin/field-configurations` | List + editor |
| Field configuration schemes | `/admin/field-configuration-schemes` | List + editor + associate |
| Screens | `/admin/screens` | List + designer |
| Screen schemes | `/admin/screen-schemes` | List + editor |
| Item type screen schemes | `/admin/item-type-screen-schemes` | List + editor + associate |
| Item types / item type schemes | `/admin/item-types`, `/admin/item-type-schemes` | CRUD + migrate |
| Priorities / priority schemes | `/admin/priorities`, `/admin/priority-schemes` | CRUD, icons, colours |
| Field explainer | `/admin/fields/explain` | "Where is my field?" |
