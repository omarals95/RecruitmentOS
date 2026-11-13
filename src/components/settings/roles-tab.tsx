"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import type { ConfigObject } from "@/lib/config-store";
import {
  ACTION_RESOURCES,
  ACTIONS,
  FIELD_RULE_KINDS,
  PAGE_KEYS,
  RECORD_SCOPES,
  configKey,
  roleBodySchema,
  type Action,
  type ActionResource,
  type FieldRule,
  type PageKey,
  type RecordScope,
  type RoleBody,
} from "@/domain/config";
import {
  ADMIN_ROLE,
  HIRING_MANAGER_ROLE,
  INTERVIEWER_ROLE,
  KIND_LABELS,
  OWNER_ROLE,
  RECRUITER_ROLE,
  VIEWER_ROLE,
  systemFieldConfig,
  type RoleTemplate,
} from "@/domain/config-defaults";
import { systemFieldKeys } from "@/domain/record-schemas";
import { resourceToKind, type ResourceName } from "@/domain/records";
import type { Requester } from "@/components/workspace/optimistic";
import {
  ClientError,
  humanError,
  requestJson,
  teamRequester,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { REAUTH_CANCELLED, useFreshSession } from "./fresh-session-dialog";

type Membership = RoleBody["membership"];
type FieldKind = (typeof FIELD_RULE_KINDS)[number];
type RecordGroup = keyof RoleBody["recordScope"];
export interface RoleIssue {
  /** The control group the issue belongs to: name, pages, actions.<resource>, fields.<kind> or other. */
  group: string;
  message: string;
}

/** The built-in templates offered. */
export const ROLE_TEMPLATE_LIST: readonly RoleTemplate[] = [
  OWNER_ROLE,
  ADMIN_ROLE,
  RECRUITER_ROLE,
  VIEWER_ROLE,
  HIRING_MANAGER_ROLE,
  INTERVIEWER_ROLE,
];
const membershipLabels: Record<Membership, string> = {
  owner: "Owner",
  admin: "Admin",
  recruiter: "Recruiter",
  viewer: "Viewer",
};
const pageLabels: Record<PageKey, string> = {
  home: "Overview",
  candidates: "Candidates",
  vacancies: "Vacancies",
  "job-roles": "Job roles",
  applications: "Applications",
  tasks: "Team tasks",
  interviews: "Interviews",
  offers: "Offers",
  onboarding: "Onboarding",
  analytics: "Analytics",
  insights: "Talent insights",
  "source-review": "Source review",
  activity: "Activity",
  settings: "Team & settings",
  approvals: "Approvals",
  directory: "Directory",
  plan: "Plan",
  admin: "Admin portal",
};
/** Page keys with a screen today; the others keep the value the body already holds. */
const EDITABLE_PAGES = PAGE_KEYS.filter(
  (page) => !["approvals", "directory", "plan"].includes(page),
);
/** The page keys a service checks today (src/lib/insights.ts, src/lib/mcp/tools.ts). */
const ENFORCED_PAGES: readonly PageKey[] = ["home", "analytics", "activity"];
/** The directory actions src/lib/directory.ts checks today. */
const ENFORCED_DIRECTORY: readonly Action[] = [
  "view",
  "create",
  "edit",
  "archive",
];
/** Actions no service checks yet; they are saved with the role and shown as taking effect later. */
const takesEffectLater = (resource: ActionResource, action: Action) =>
  resource === "teams" ||
  resource === "two-step-reset" ||
  (resource === "directory" && !ENFORCED_DIRECTORY.includes(action));
const actionLabels: Record<Action, string> = {
  view: "View",
  create: "Create",
  edit: "Edit",
  transition: "Move stage or status",
  archive: "Archive",
  export: "Export",
  erase: "Erase",
  approve: "Approve",
  import: "Import",
  comment: "Comment",
  "share-view": "Share views",
  admin: "Manage",
};
const resourceLabel = (resource: ActionResource) =>
  Object.hasOwn(resourceToKind, resource)
    ? KIND_LABELS[resourceToKind[resource as ResourceName]][0]
    : {
        directory: "Directory",
        plans: "Plans",
        "two-step-reset": "Two-step sign-in reset",
        teams: "Teams",
        "storage-settings": "CV storage settings",
      }[resource as "directory"];
/** Plan & pay access is a per-person grant; erase and the owner-only team actions no configured role holds. */
const EDITABLE_RESOURCES = ACTION_RESOURCES.filter(
  (resource) => resource !== "plans",
);
const editableActions = (resource: ActionResource) =>
  ACTIONS.filter(
    (action) =>
      action !== "erase" &&
      !(
        action === "admin" &&
        (resource === "two-step-reset" || resource === "teams")
      ),
  );
const fieldRuleLabels: Record<FieldRule, string> = {
  hidden: "Hidden",
  read: "Read only",
  edit: "Can edit",
  "hidden-unless-approver": "Hidden unless approver",
};
const recordGroups: [RecordGroup, string][] = [
  ["pipeline", "Vacancies, applications, interviews, offers and onboarding"],
  ["candidates", "Candidates"],
  ["tasks", "Team tasks"],
];
const scopeLabels: Record<RecordScope, string> = {
  all: "All records",
  unit: "My org unit and below",
  assigned: "Assigned records",
};
export const box = {
  border: "1px solid var(--border, #e2e4eb)",
  borderRadius: 10,
  padding: 16,
  minWidth: 0,
} as const;
export const checks = {
  display: "flex",
  flexWrap: "wrap",
  columnGap: 18,
} as const;
const laterHeading = { fontSize: 13, margin: "12px 0 0" } as const;
// Row actions never break inside a word; a narrow table scrolls inside its .table-wrap.
export const actionRow = { flexWrap: "wrap", overflowWrap: "normal" } as const;

/** Only the API's own message: humanError adds draft advice to a 409 that does not fit here. */
export const plainError = (error: unknown) =>
  error instanceof ClientError ? error.message : humanError(error);
const groupOf = (path: readonly PropertyKey[]) =>
  path[0] === "actions" || path[0] === "fields"
    ? `${String(path[0])}.${String(path[1])}`
    : path[0] === "name" || path[0] === "pages"
      ? path[0]
      : "other";
const groupLabel = (group: string) => {
  const [head, rest] = group.split(".");
  return head === "actions"
    ? `Actions on ${resourceLabel(rest as ActionResource)}`
    : head === "fields"
      ? `Field rules for ${KIND_LABELS[rest as FieldKind]?.[0] ?? rest}`
      : head === "name"
        ? "Name"
        : head === "pages"
          ? "Pages"
          : "Role";
};

/** Why the strict role schema refuses this body, one message per control group, or none. */
export function roleIssues(body: unknown): RoleIssue[] {
  const parsed = roleBodySchema.safeParse(body);
  if (parsed.success) return [];
  const seen = new Set<string>();
  return parsed.error.issues.flatMap((issue) => {
    const group = groupOf(issue.path);
    const key = `${group}:${issue.message}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ group, message: issue.message }];
  });
}

/** Saves a role draft only when the schema accepts it; otherwise sends nothing and returns why. */
export async function saveRoleDraft(
  send: Requester,
  versionId: string,
  body: RoleBody,
): Promise<RoleIssue[]> {
  const issues = roleIssues(body);
  if (!issues.length)
    await send(`/api/v1/roles/${versionId}`, {
      method: "PUT",
      body: JSON.stringify({ body }),
    });
  return issues;
}

/** A role key from its name: lowercase letters, digits and hyphens, at most 63 characters. */
export function roleKeyFor(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

// Arrays as sets and objects without key order, so re-ticking a box is not an unsaved change.
function canonical(value: unknown): string {
  if (Array.isArray(value))
    return JSON.stringify(value.map((item) => canonical(item)).sort());
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The Roles & permissions tab: company roles, for company owners only. */
export function RolesTab() {
  return (
    <>
      <RolesPanel />
      <section className="panel">
        <p>
          Company authority has its own page.{" "}
          <Link href="/app/admin/company-authority">
            Open Company authority
          </Link>
        </p>
      </section>
    </>
  );
}

/**
 * A ref and a request that focuses its element after the next render: where focus goes when the
 * control that had it is removed.
 */
export function useFocusAfter<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [requested, setRequested] = useState(0);
  useEffect(() => {
    if (requested) ref.current?.focus();
  }, [requested]);
  return [ref, () => setRequested((count) => count + 1)] as const;
}

type Open =
  | { kind: "template" | "copy"; template: RoleTemplate }
  | { kind: "editor"; roleKey: string; versionId: string; body: RoleBody };

function RolesPanel() {
  const { team } = useWorkspace();
  const teamId = team?.id ?? null;
  const roles = useApi<{ data: ConfigObject[] }>(
    teamId ? "/api/v1/roles" : null,
  );
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { confirm, dialog } = useConfirm();
  const freshSession = useFreshSession();
  const [headingRef, focusHeading] = useFocusAfter<HTMLHeadingElement>();
  const [noticeRef, focusNotice] = useFocusAfter<HTMLParagraphElement>();
  const close = () => {
    focusHeading();
    setOpen(null);
  };
  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (busy || !teamId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      return await work();
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  }
  async function createDraft(roleKey: string, body: RoleBody) {
    const created = await run(() =>
      requestJson<{ data: { versionId: string } }>(teamId, "/api/v1/roles", {
        method: "POST",
        body: JSON.stringify({ key: roleKey, body }),
      }),
    );
    if (created)
      setOpen({
        kind: "editor",
        roleKey,
        versionId: created.data.versionId,
        body,
      });
  }
  async function copy(template: RoleTemplate, name: string) {
    const roleKey = roleKeyFor(name);
    if (!configKey.safeParse(roleKey).success) {
      setError("Use at least one letter or number in the role name.");
      return;
    }
    if (roles.data?.data.some((role) => role.key === roleKey)) {
      setError(
        "A company role with this name already exists. Choose another name.",
      );
      return;
    }
    await createDraft(roleKey, structuredClone({ ...template.body, name }));
  }
  async function publish(name: string, versionId: string) {
    if (
      !(await confirm({
        title: "Publish this role?",
        message: `Publish ${name}? Publishing changes access for every member who holds this role.`,
        confirmLabel: "Publish role",
      }))
    )
      return;
    const published = await run(() =>
      freshSession.withFreshSession(() =>
        requestJson<{ data: { number: number } }>(
          teamId,
          `/api/v1/roles/${versionId}/publish`,
          { method: "POST" },
        ),
      ),
    );
    if (published && published !== REAUTH_CANCELLED) {
      focusNotice();
      setOpen(null);
      setNotice(`${name} is published as version ${published.data.number}.`);
    }
  }
  return (
    <section className="panel stack">
      <h2 ref={headingRef} tabIndex={-1}>
        Roles
      </h2>
      <p className="muted">
        A role narrows what its members can do inside their team role&apos;s
        membership. Copy a built-in template, change it as a draft, then publish
        it to assign it in Team &amp; access.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p
          ref={noticeRef}
          tabIndex={-1}
          className="notice success"
          role="status"
        >
          {notice}
        </p>
      )}
      {freshSession.dialog}
      <RolesList
        roles={roles.data?.data ?? null}
        error={roles.error}
        busy={busy}
        onView={(template) => setOpen({ kind: "template", template })}
        onEdit={(role, draft) =>
          setOpen({
            kind: "editor",
            roleKey: role.key,
            versionId: draft.id,
            body: draft.body as unknown as RoleBody,
          })
        }
        onNewDraft={(role, body) => void createDraft(role.key, body)}
        onPublish={(name, versionId) => void publish(name, versionId)}
      />
      {open?.kind === "template" && (
        <RoleTemplateView
          template={open.template}
          onCopy={() => setOpen({ kind: "copy", template: open.template })}
          onClose={close}
        />
      )}
      {open?.kind === "copy" && (
        <RoleCopyForm
          template={open.template}
          busy={busy || !roles.data}
          onSubmit={(name) => void copy(open.template, name)}
          onCancel={close}
        />
      )}
      {open?.kind === "editor" && (
        <RoleEditor
          key={open.versionId}
          roleKey={open.roleKey}
          body={open.body}
          busy={busy}
          onSave={async (body) => {
            const issues = await run(() =>
              saveRoleDraft(teamRequester(teamId!), open.versionId, body),
            );
            if (issues && !issues.length) setNotice("Draft saved.");
            return !!issues && !issues.length;
          }}
          onPublish={(name) => void publish(name, open.versionId)}
          onClose={close}
        />
      )}
      {dialog}
    </section>
  );
}

/** The built-in templates, the scoped-roles note and the company's roles with their states. */
export function RolesList({
  roles,
  error,
  busy,
  onView,
  onEdit,
  onNewDraft,
  onPublish,
}: {
  roles: ConfigObject[] | null;
  error: string;
  busy: boolean;
  onView: (template: RoleTemplate) => void;
  onEdit: (
    role: ConfigObject,
    draft: NonNullable<ConfigObject["draft"]>,
  ) => void;
  onNewDraft: (role: ConfigObject, body: RoleBody) => void;
  onPublish: (name: string, versionId: string) => void;
}) {
  return (
    <>
      <h3>Built-in templates</h3>
      <ul
        className="stack"
        style={{ listStyle: "none", padding: 0, margin: 0 }}
      >
        {ROLE_TEMPLATE_LIST.map((template) => (
          <li
            key={template.key}
            className="row"
            style={{ justifyContent: "space-between", flexWrap: "wrap" }}
          >
            <span>
              <strong>{template.body.name}</strong>{" "}
              <span className="muted">
                {membershipLabels[template.body.membership]} membership
              </span>
            </span>
            <button
              type="button"
              className="button secondary"
              onClick={() => onView(template)}
            >
              View {template.body.name} template
            </button>
          </li>
        ))}
      </ul>
      <h3>Company roles</h3>
      {error ? (
        <p className="notice error" role="alert">
          Could not load the company roles. {error}
        </p>
      ) : !roles ? (
        <p role="status">Loading company roles…</p>
      ) : !roles.length ? (
        <p role="status">No company roles yet. Copy a template to start.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">Company roles</caption>
            <thead>
              <tr>
                <th>Role</th>
                <th>State</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => {
                const { current, draft } = role;
                const currentBody = current?.body as RoleBody | undefined;
                const name = String((draft ?? current)?.body.name ?? role.key);
                return (
                  <tr key={role.id}>
                    <td data-label="Role">
                      <strong>{name}</strong>
                      <br />
                      <span className="muted">{role.key}</span>
                    </td>
                    <td data-label="State">
                      {current
                        ? `Published (version ${current.number})${draft ? ", draft in progress" : ""}`
                        : "Draft"}
                    </td>
                    <td data-label="Actions">
                      <div className="row" style={actionRow}>
                        {draft ? (
                          <>
                            <button
                              type="button"
                              className="button secondary"
                              disabled={busy}
                              onClick={() => onEdit(role, draft)}
                            >
                              Edit draft
                            </button>
                            <button
                              type="button"
                              className="button secondary"
                              disabled={busy}
                              onClick={() =>
                                onPublish(String(draft.body.name), draft.id)
                              }
                            >
                              Publish
                            </button>
                          </>
                        ) : (
                          currentBody && (
                            <button
                              type="button"
                              className="button secondary"
                              disabled={busy}
                              onClick={() => onNewDraft(role, currentBody)}
                            >
                              New draft
                            </button>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Focuses a heading when its view opens, so keyboard and screen reader users land on it. */
function useFocusOnOpen() {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}

/** A built-in template as text only: no control changes it, and Owner has no Copy action. */
export function RoleTemplateView({
  template,
  onCopy = () => {},
  onClose = () => {},
}: {
  template: RoleTemplate;
  onCopy?: () => void;
  onClose?: () => void;
}) {
  const heading = useFocusOnOpen();
  const { body } = template;
  const actions = Object.entries(body.actions) as [ActionResource, Action[]][];
  const fields = Object.entries(body.fields) as [
    FieldKind,
    Record<string, FieldRule>,
  ][];
  return (
    <section className="stack" style={box} aria-label={`${body.name} template`}>
      <h3 ref={heading} tabIndex={-1}>
        {body.name} template
      </h3>
      <dl className="stack" style={{ margin: 0 }}>
        <div>
          <dt>
            <strong>Membership</strong>
          </dt>
          <dd>{membershipLabels[body.membership]}</dd>
        </div>
        <div>
          <dt>
            <strong>Pages</strong>
          </dt>
          <dd>{body.pages.map((page) => pageLabels[page]).join(", ")}</dd>
        </div>
        <div>
          <dt>
            <strong>Actions per resource</strong>
          </dt>
          <dd>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {actions.map(([resource, list]) => (
                <li key={resource}>
                  {resourceLabel(resource)}:{" "}
                  {list.map((action) => actionLabels[action]).join(", ")}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>
            <strong>Field rules</strong>
          </dt>
          <dd>
            {fields.length
              ? fields
                  .map(
                    ([kind, rules]) =>
                      `${KIND_LABELS[kind][0]}: ${Object.entries(rules)
                        .map(
                          ([key, rule]) =>
                            `${systemFieldConfig(kind, key).label} ${fieldRuleLabels[rule].toLowerCase()}`,
                        )
                        .join(", ")}`,
                  )
                  .join("; ")
              : "None: every field follows the actions."}
          </dd>
        </div>
        <div>
          <dt>
            <strong>Record scope</strong>
          </dt>
          <dd>
            {recordGroups
              .map(
                ([group, label]) =>
                  `${label}: ${scopeLabels[body.recordScope[group]]}`,
              )
              .join("; ")}
          </dd>
        </div>
      </dl>
      {body.membership === "owner" && (
        <p>The Owner template cannot be edited or copied.</p>
      )}
      <div className="row" style={{ flexWrap: "wrap" }}>
        {body.membership !== "owner" && (
          <button type="button" className="button" onClick={onCopy}>
            Copy to a new role
          </button>
        )}
        <button type="button" className="button secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

/** Asks for the new role's name; its key is derived from the name. */
export function RoleCopyForm({
  template,
  busy,
  onSubmit,
  onCancel,
}: {
  template: RoleTemplate;
  busy: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const heading = useFocusOnOpen();
  const [name, setName] = useState(`Copy of ${template.body.name}`);
  return (
    <form
      className="stack"
      style={box}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(name.trim());
      }}
    >
      <h3 ref={heading} tabIndex={-1}>
        Copy the {template.body.name} template
      </h3>
      <label className="field">
        <span>Role name</span>
        <input
          required
          minLength={1}
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <small className="muted">
          1 to 120 characters. The role keeps the{" "}
          {membershipLabels[template.body.membership]} membership.
        </small>
      </label>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button
          type="submit"
          className="button"
          disabled={busy || !name.trim()}
        >
          Create draft role
        </button>
        <button type="button" className="button secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * A collapsed group that a refusal opens; fixing the refusal never closes it, so the control that
 * fixed it keeps its focus.
 */
function Disclosure({
  summary,
  refused,
  children,
}: {
  summary: string;
  refused: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(refused);
  if (refused && !open) setOpen(true);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

/** A visually grouped fieldset; issues are linked to it with aria-describedby. */
function Group({
  legend,
  issues,
  children,
  hiddenLegend = false,
}: {
  legend: string;
  issues: string[];
  children: ReactNode;
  hiddenLegend?: boolean;
}) {
  const id = useId();
  return (
    <fieldset
      style={
        hiddenLegend
          ? { border: 0, padding: "8px 0 0", margin: 0, minWidth: 0 }
          : box
      }
      aria-describedby={issues.length ? `${id}-issue` : undefined}
    >
      <legend className={hiddenLegend ? "sr-only" : undefined}>{legend}</legend>
      {children}
      {issues.length > 0 && (
        <p id={`${id}-issue`} className="field-error">
          {issues.join(" ")}
        </p>
      )}
    </fieldset>
  );
}

/**
 * A role draft in standard labelled controls. The membership, scopes and directory rule stay as
 * copied; record scope is chosen per group. The schema runs on every change, and a refused body is
 * never sent.
 */
export function RoleEditor({
  roleKey,
  body: initial,
  busy,
  onSave,
  onPublish,
  onClose,
}: {
  roleKey: string;
  body: RoleBody;
  busy: boolean;
  onSave: (body: RoleBody) => Promise<boolean>;
  onPublish: (name: string) => void;
  onClose: () => void;
}) {
  const heading = useFocusOnOpen();
  const summary = useRef<HTMLDivElement>(null);
  const later = useId();
  const [body, setBody] = useState<RoleBody>(() => structuredClone(initial));
  const [saved, setSaved] = useState(() => canonical(initial));
  const issues = roleIssues(body);
  const issuesOf = (group: string) =>
    issues.filter((issue) => issue.group === group).map((i) => i.message);
  const dirty = canonical(body) !== saved;
  const togglePage = (page: PageKey, on: boolean) =>
    setBody((current) => ({
      ...current,
      pages: on
        ? [...current.pages, page]
        : current.pages.filter((item) => item !== page),
    }));
  const toggleAction = (
    resource: ActionResource,
    action: Action,
    on: boolean,
  ) =>
    setBody((current) => {
      const list = current.actions[resource] ?? [];
      const actions = {
        ...current.actions,
        [resource]: on
          ? [...list, action]
          : list.filter((item) => item !== action),
      };
      if (!actions[resource]?.length) delete actions[resource];
      return { ...current, actions };
    });
  const setRule = (kind: FieldKind, key: string, rule: FieldRule | "") =>
    setBody((current) => {
      const rules = { ...(current.fields[kind] ?? {}) };
      if (rule) rules[key] = rule;
      else delete rules[key];
      const fields = { ...current.fields, [kind]: rules };
      if (!Object.keys(rules).length) delete fields[kind];
      return { ...current, fields };
    });
  const setScope = (group: RecordGroup, scope: RecordScope) =>
    setBody((current) => ({
      ...current,
      recordScope: { ...current.recordScope, [group]: scope },
    }));
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (issues.length) {
      summary.current?.focus();
      return;
    }
    if (await onSave(body)) setSaved(canonical(body));
  }
  const pageCheck = (page: PageKey, describedBy?: string) => (
    <label key={page} className="checkbox-label">
      <input
        type="checkbox"
        checked={body.pages.includes(page)}
        aria-describedby={describedBy}
        onChange={(e) => togglePage(page, e.target.checked)}
      />
      {pageLabels[page]}
    </label>
  );
  return (
    <form className="stack" style={box} onSubmit={save} noValidate>
      <h3 ref={heading} tabIndex={-1}>
        Edit draft: {body.name || roleKey}
      </h3>
      <p className="muted">
        Membership: {membershipLabels[body.membership]}. A role can only narrow
        its membership, so its permissions stay as copied from the template.
      </p>
      {issues.length > 0 && (
        <div ref={summary} tabIndex={-1} className="notice error" role="alert">
          <p style={{ margin: 0 }}>
            This role cannot be saved, because the{" "}
            {membershipLabels[body.membership]} membership does not allow it:
          </p>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {issues.map((issue) => (
              <li key={`${issue.group}:${issue.message}`}>
                {groupLabel(issue.group)}: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <label className="field">
        <span>Name</span>
        <input
          required
          maxLength={120}
          value={body.name}
          aria-invalid={issuesOf("name").length > 0 || undefined}
          onChange={(e) =>
            setBody((current) => ({ ...current, name: e.target.value }))
          }
        />
        {issuesOf("name").length > 0 && (
          <small className="field-error">{issuesOf("name").join(" ")}</small>
        )}
      </label>
      <Group legend="Pages" issues={issuesOf("pages")}>
        <div style={checks}>
          {EDITABLE_PAGES.filter((page) => ENFORCED_PAGES.includes(page)).map(
            (page) => pageCheck(page),
          )}
        </div>
        <h4 id={`${later}-pages`} style={laterHeading}>
          Takes effect later
        </h4>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          These screens do not check page rules yet. The choice is saved with
          the role.
        </p>
        <div style={checks}>
          {EDITABLE_PAGES.filter((page) => !ENFORCED_PAGES.includes(page)).map(
            (page) => pageCheck(page, `${later}-pages`),
          )}
        </div>
      </Group>
      <fieldset style={box}>
        <legend>Actions per resource</legend>
        <p className="muted">
          Plan & pay access is a per-person grant in Company authority, never
          part of a role.
        </p>
        <div className="stack">
          {EDITABLE_RESOURCES.map((resource) => {
            const held = body.actions[resource] ?? [];
            const refused = issuesOf(`actions.${resource}`);
            const actions = editableActions(resource);
            const now = actions.filter(
              (action) => !takesEffectLater(resource, action),
            );
            const deferred = actions.filter((action) =>
              takesEffectLater(resource, action),
            );
            const actionCheck = (action: Action, describedBy?: string) => (
              <label key={action} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={held.includes(action)}
                  aria-describedby={describedBy}
                  onChange={(e) =>
                    toggleAction(resource, action, e.target.checked)
                  }
                />
                {actionLabels[action]}
              </label>
            );
            return (
              <Disclosure
                key={resource}
                summary={`${resourceLabel(resource)} (${held.length} allowed)`}
                refused={refused.length > 0}
              >
                <Group
                  legend={`Actions on ${resourceLabel(resource)}`}
                  issues={refused}
                  hiddenLegend
                >
                  {now.length > 0 && (
                    <div style={checks}>
                      {now.map((action) => actionCheck(action))}
                    </div>
                  )}
                  {deferred.length > 0 && (
                    <>
                      <h4 id={`${later}-${resource}`} style={laterHeading}>
                        Takes effect later
                      </h4>
                      <div style={checks}>
                        {deferred.map((action) =>
                          actionCheck(action, `${later}-${resource}`),
                        )}
                      </div>
                    </>
                  )}
                </Group>
              </Disclosure>
            );
          })}
        </div>
      </fieldset>
      <fieldset style={box}>
        <legend>Field rules</legend>
        <p className="muted">
          Default leaves a field to the actions above. Hidden fields are left
          out everywhere, and read-only fields cannot be changed.
        </p>
        <div className="stack">
          {FIELD_RULE_KINDS.map((kind) => {
            const rules = body.fields[kind] ?? {};
            const refused = issuesOf(`fields.${kind}`);
            return (
              <Disclosure
                key={kind}
                summary={`${KIND_LABELS[kind][0]} (${Object.keys(rules).length} rules)`}
                refused={refused.length > 0}
              >
                <Group
                  legend={`Field rules for ${KIND_LABELS[kind][0]}`}
                  issues={refused}
                  hiddenLegend
                >
                  <div className="form-grid">
                    {systemFieldKeys(kind).map((key) => {
                      const rule = Object.hasOwn(rules, key)
                        ? rules[key]
                        : undefined;
                      return (
                        <label key={key} className="field">
                          <span>{systemFieldConfig(kind, key).label}</span>
                          <select
                            value={rule ?? ""}
                            onChange={(e) =>
                              setRule(kind, key, e.target.value as FieldRule)
                            }
                          >
                            <option value="">Default</option>
                            <option value="hidden">Hidden</option>
                            <option value="read">Read only</option>
                            <option value="edit">Can edit</option>
                            {rule === "hidden-unless-approver" && (
                              <option value="hidden-unless-approver">
                                Hidden unless approver
                              </option>
                            )}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                </Group>
              </Disclosure>
            );
          })}
        </div>
      </fieldset>
      <fieldset style={box}>
        <legend>Record scope</legend>
        <p className="muted">
          My org unit and below means the records of the member&rsquo;s org
          units in the directory and every unit below them, plus records
          assigned to them. Assigned records means only records assigned to
          them.
        </p>
        <div className="form-grid">
          {recordGroups.map(([group, label]) => (
            <label key={group} className="field">
              <span>{label}</span>
              <select
                value={body.recordScope[group]}
                onChange={(e) => setScope(group, e.target.value as RecordScope)}
              >
                {RECORD_SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {scopeLabels[scope]}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </fieldset>
      {issuesOf("other").length > 0 && (
        <p className="field-error">{issuesOf("other").join(" ")}</p>
      )}
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button type="submit" className="button" disabled={busy}>
          Save draft
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy || dirty || issues.length > 0}
          onClick={() => onPublish(body.name)}
        >
          Publish
        </button>
        <button type="button" className="button secondary" onClick={onClose}>
          Close
        </button>
      </div>
      {(dirty || issues.length > 0) && (
        <p className="muted">
          Save your changes, with no refusals, before publishing.
        </p>
      )}
    </form>
  );
}
