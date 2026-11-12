"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type Ref,
} from "react";
import type { MeAccess } from "@/lib/authz";
import type { KindSchemaState } from "@/lib/config-store";
import { issueList } from "@/lib/errors";
import {
  CONFIGURABLE_KINDS,
  configHelpText,
  configLabel,
  kindSchemaBodySchema,
  type ConfigurableKind,
  type KindSchemaBody,
} from "@/domain/config";
import {
  FIELD_TYPES,
  kindSchemaCustomFieldSchema,
  type CustomFieldType,
} from "@/domain/field-types";
import {
  CHANGE_CATEGORIES,
  kindSchemaChanges,
  kindSchemaDraftIssues,
  sensitiveMarksDiffer,
  type ChangeCategory,
} from "@/domain/kind-schema-changes";
import { SENSITIVE_CANDIDATE_FIELDS } from "@/domain/record-schemas";
import type { FieldType } from "@/domain/records";
import { screenFor, screenKey, type Screen } from "@/domain/screens";
import { systemFieldConfig } from "@/domain/system-fields";
import {
  requestJson,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";
import { Dialog } from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { actionRow, box, checks, plainError, useFocusAfter } from "./roles-tab";

type Field = KindSchemaBody["fields"][number];
type CustomFieldBody = Extract<Field, { system: false }>;
type Option = { id: string; label: string };
/** A kind as the page edits it: its draft when one exists, else the version in force. */
export type KindView = {
  state: KindSchemaState;
  body: KindSchemaBody;
  /** Set when the draft is not a kind schema; the next change replaces it. */
  draftError: string;
};

const ALL = "";
// Row actions wrap to new lines; settings.css sizes their cell.
const rowActions = { ...actionRow, gap: 6 } as const;
const SENSITIVE_OWNER_ONLY =
  "Only a company owner can mark a field sensitive or remove the mark.";
export const OWNER_MUST_PUBLISH =
  "A company owner must publish this draft because it changes which fields are sensitive.";

/** One plain label per custom field type (the engine's fixed list) and per system field type. */
export const CUSTOM_TYPE_LABELS: Record<CustomFieldType, string> = {
  "short-text": "Short text",
  "long-text": "Long text",
  "rich-text": "Rich text",
  number: "Number",
  money: "Money",
  percentage: "Percentage",
  date: "Date",
  "date-time": "Date and time",
  dropdown: "Dropdown",
  "multi-select": "Multi-select",
  checkbox: "Checkbox",
  person: "Person",
  "org-unit": "Org unit",
  url: "Web address",
  email: "Email",
  phone: "Phone",
  file: "File",
  lookup: "Lookup",
};
const SYSTEM_TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  textarea: "Long text",
  number: "Number",
  date: "Date",
  "datetime-local": "Date and time",
  select: "Dropdown",
  tags: "List of values",
  checkbox: "Checkbox",
  json: "Structured data",
};
const typeLabel = (field: Field) =>
  field.system
    ? SYSTEM_TYPE_LABELS[field.type]
    : CUSTOM_TYPE_LABELS[field.type];
const CATEGORY_LABELS: Record<ChangeCategory, string> = {
  added: "Added",
  renamed: "Renamed",
  archived: "Archived",
  regrouped: "Moved to another group",
  madeMandatory: "Made mandatory",
  madeSensitive: "Made sensitive",
  other: "Other changes",
};
const ACTION_LABELS: Record<Screen["action"], string> = {
  create: "Create",
  edit: "Edit",
  view: "View",
  transition: "Transition",
};
const screenLabel = (screen: Screen) =>
  `${ACTION_LABELS[screen.action]} screen${screen.type ? ` (type ${screen.type})` : ""}`;

type Attribute = "bounds" | "pattern" | "options" | "currency" | "target";
/**
 * The validation attributes each type takes, as customFieldSchema accepts them; every type also
 * takes Required, and a default unless DEFAULTLESS lists it.
 */
export const TYPE_ATTRIBUTES: Record<CustomFieldType, Attribute[]> = {
  "short-text": ["bounds", "pattern"],
  "long-text": ["bounds"],
  "rich-text": ["bounds"],
  number: ["bounds"],
  money: ["currency", "bounds"],
  percentage: ["bounds"],
  date: ["bounds"],
  "date-time": ["bounds"],
  dropdown: ["options"],
  "multi-select": ["options", "bounds"],
  checkbox: [],
  person: [],
  "org-unit": [],
  url: [],
  email: [],
  phone: [],
  file: [],
  lookup: ["target"],
};
/** Configuration holds no record ids, so the reference types take no default. */
export const DEFAULTLESS: readonly CustomFieldType[] = [
  "person",
  "org-unit",
  "file",
  "lookup",
];
const BOUND_LABELS: Partial<Record<CustomFieldType, [string, string]>> = {
  "short-text": ["Minimum length", "Maximum length"],
  "long-text": ["Minimum length", "Maximum length"],
  "rich-text": ["Minimum length", "Maximum length"],
  number: ["Minimum", "Maximum"],
  money: ["Minimum amount", "Maximum amount"],
  percentage: ["Minimum", "Maximum"],
  date: ["Earliest date", "Latest date"],
  "date-time": ["Earliest date and time", "Latest date and time"],
  "multi-select": ["Fewest choices", "Most choices"],
};
const INPUT_LABELS: Record<string, string> = {
  label: "Name",
  help: "Help text",
  pattern: "Pattern",
  options: "Options",
  currency: "Currency",
  target: "Record kind to look up",
  default: "Default",
};

/** The validation inputs of a custom field as typed; option lines and defaults by option label. */
export type Inputs = {
  min: string;
  max: string;
  pattern: string;
  options: string;
  currency: string;
  target: string;
  defaultValue: string;
  defaultOptions: string[];
};
/** Empty inputs for a type; money starts with AED. */
export const emptyInputs = (type: CustomFieldType): Inputs => ({
  min: "",
  max: "",
  pattern: "",
  options: "",
  currency: type === "money" ? "AED" : "",
  target: "candidate",
  defaultValue: "",
  defaultOptions: [],
});
const text = (value: unknown) =>
  value === undefined || value === null ? "" : String(value);
/** A stored definition's attributes as inputs, its options' ids shown by label. */
function inputsOf(field: CustomFieldBody): Inputs {
  const options = "options" in field ? field.options : [];
  const labelOf = (id: unknown) =>
    options.find((option) => option.id === id)?.label ?? text(id);
  const stored = "default" in field ? field.default : undefined;
  return {
    min: "min" in field ? text(field.min) : "",
    max: "max" in field ? text(field.max) : "",
    pattern: "pattern" in field ? text(field.pattern) : "",
    options: options.map((option) => option.label).join("\n"),
    currency: "currency" in field ? field.currency : "",
    target: "target" in field ? field.target : "candidate",
    defaultValue: field.type === "dropdown" ? labelOf(stored) : text(stored),
    defaultOptions: Array.isArray(stored) ? stored.map(labelOf) : [],
  };
}
/** The typed option lines, trimmed, without blank lines. */
const optionLines = (inputs: Inputs) =>
  inputs.options
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * A custom field definition from the typed inputs: only the attributes its type takes, numbers as
 * numbers, and a default as a value of the field (an option id for a dropdown or multi-select).
 * Empty inputs are left out. The body schema decides whether it is valid.
 */
export function customDefinition(
  base: {
    key: string;
    label: string;
    help: string;
    required: boolean;
    archived?: boolean;
    sensitive: boolean;
  },
  type: CustomFieldType,
  inputs: Inputs,
  options: Option[],
): Record<string, unknown> {
  const attributes = TYPE_ATTRIBUTES[type];
  const filled = (value: string) => value.trim() !== "";
  const numeric = !["date", "date-time"].includes(type);
  const bound = (value: string) =>
    !filled(value) ? undefined : numeric ? Number(value) : value.trim();
  const idOf = (label: string) =>
    options.find((option) => option.label === label)?.id ?? label;
  const value = (): unknown => {
    if (type === "multi-select")
      return inputs.defaultOptions.length
        ? inputs.defaultOptions.map(idOf)
        : undefined;
    if (!filled(inputs.defaultValue)) return undefined;
    if (type === "number" || type === "percentage")
      return Number(inputs.defaultValue);
    if (type === "checkbox") return inputs.defaultValue === "true";
    if (type === "dropdown") return idOf(inputs.defaultValue);
    return inputs.defaultValue.trim();
  };
  return {
    key: base.key,
    system: false,
    label: base.label,
    ...(base.help.trim() ? { help: base.help } : {}),
    type,
    required: base.required,
    ...(base.archived ? { archived: true } : {}),
    ...(base.sensitive ? { sensitive: true } : {}),
    ...(attributes.includes("currency")
      ? { currency: inputs.currency.trim() }
      : {}),
    ...(attributes.includes("bounds")
      ? { min: bound(inputs.min), max: bound(inputs.max) }
      : {}),
    ...(attributes.includes("pattern") && filled(inputs.pattern)
      ? { pattern: inputs.pattern }
      : {}),
    ...(attributes.includes("options") ? { options } : {}),
    ...(attributes.includes("target") ? { target: inputs.target } : {}),
    ...(DEFAULTLESS.includes(type) ? {} : { default: value() }),
  };
}
/** JSON drops the undefined attributes, as the request would. */
const plainJson = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

/** Each issue as `name: message`, naming the input a path starts with when it has one. */
function issueText(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  bounds?: [string, string],
) {
  const names: Record<string, string> = {
    ...INPUT_LABELS,
    ...(bounds ? { min: bounds[0], max: bounds[1] } : {}),
  };
  return issueList(
    issues.map((issue) => {
      const head = String(issue.path[0] ?? "");
      return Object.hasOwn(names, head)
        ? { path: [names[head]], message: issue.message }
        : issue;
    }),
  ).split("; ");
}

// Body edits: each returns a new body and leaves the one given unchanged.
const cloneBody = (body: KindSchemaBody) => structuredClone(body);
/** The field replaced by `next`, every screen unchanged. */
export function withField(body: KindSchemaBody, next: Field): KindSchemaBody {
  const copy = cloneBody(body);
  copy.fields = copy.fields.map((field) =>
    field.key === next.key ? next : field,
  );
  return copy;
}
/**
 * On every screen that lists the field and does not already have it in a group with this label,
 * its entry with its flags moves to the end of the first group with the label, a group added at the
 * end of the screen when there is none; a group left empty is removed. No label is "no group".
 */
export function moveToGroup(
  body: KindSchemaBody,
  key: string,
  label: string | undefined,
): KindSchemaBody {
  const copy = cloneBody(body);
  for (const screen of copy.screens) {
    const from = screen.groups.find((group) =>
      group.fields.some((entry) => entry.key === key),
    );
    if (!from || from.label === label) continue;
    const entry = from.fields.find((item) => item.key === key)!;
    from.fields = from.fields.filter((item) => item.key !== key);
    let to = screen.groups.find((group) => group.label === label);
    if (!to) {
      to = label === undefined ? { fields: [] } : { label, fields: [] };
      screen.groups.push(to);
    }
    to.fields.push(entry);
    screen.groups = screen.groups.filter((group) => group.fields.length);
  }
  return copy;
}
/** Whether moving by `step` (-1 up, 1 down) swaps the field's entry on any screen. */
export function canMove(body: KindSchemaBody, key: string, step: -1 | 1) {
  return body.screens.some((screen) =>
    screen.groups.some((group) => {
      const at = group.fields.findIndex((entry) => entry.key === key);
      return at >= 0 && at + step >= 0 && at + step < group.fields.length;
    }),
  );
}
/** On every screen that lists the field, its entry swaps with the previous or next one in its group. */
export function moveField(
  body: KindSchemaBody,
  key: string,
  step: -1 | 1,
): KindSchemaBody {
  const copy = cloneBody(body);
  for (const screen of copy.screens)
    for (const group of screen.groups) {
      const at = group.fields.findIndex((entry) => entry.key === key);
      if (at < 0 || at + step < 0 || at + step >= group.fields.length) continue;
      [group.fields[at], group.fields[at + step]] = [
        group.fields[at + step],
        group.fields[at],
      ];
    }
  return copy;
}
/** The new field appended to the body's fields and to the last group of each chosen screen. */
export function addField(
  body: KindSchemaBody,
  field: Field,
  screens: string[],
): KindSchemaBody {
  const copy = cloneBody(body);
  copy.fields.push(field);
  for (const screen of copy.screens)
    if (screens.includes(screenKey(screen)))
      screen.groups[screen.groups.length - 1].fields.push({ key: field.key });
  return copy;
}

/** The kind as the page edits it; a draft that is no kind schema is reported and replaced on save. */
export function kindView(state: KindSchemaState): KindView {
  if (!state.draft) return { state, body: state.current.body, draftError: "" };
  const parsed = kindSchemaBodySchema.safeParse(state.draft.body);
  return parsed.success
    ? { state, body: parsed.data, draftError: "" }
    : {
        state,
        body: state.current.body,
        draftError: `The ${state.current.body.singular} draft is not a valid set of fields, so the list shows the published fields; your next change replaces the draft.`,
      };
}

/** Each kind's plural label as its schema names it. */
export const kindLabels = (views: KindView[]) =>
  Object.fromEntries(
    views.map((view) => [view.state.kind, view.body.label]),
  ) as Record<ConfigurableKind, string>;

type Row = { kind: KindView; field: Field; group: string };
/** One kind's rows: its default edit screen's fields by group and entry, then the rest in body order. */
export function kindRows(kind: KindView): Row[] {
  const fields = new Map(kind.body.fields.map((field) => [field.key, field]));
  const edit = screenFor(kind.body, null, "edit");
  const rows: Row[] = edit.groups.flatMap((group) =>
    group.fields.flatMap((entry) => {
      const field = fields.get(entry.key);
      return field ? [{ kind, field, group: group.label ?? "No group" }] : [];
    }),
  );
  const listed = new Set(rows.map((row) => row.field.key));
  return [
    ...rows,
    ...kind.body.fields
      .filter((field) => !listed.has(field.key))
      .map((field) => ({ kind, field, group: "Not on a screen" })),
  ];
}
const nameKey = (label: string) => label.trim().toLowerCase();
/** Whether another field of the kind, archived ones included, has this name. */
const sharesName = (body: KindSchemaBody, key: string, label: string) =>
  !!nameKey(label) &&
  body.fields.some(
    (field) => field.key !== key && nameKey(field.label) === nameKey(label),
  );
const duplicateText = (body: KindSchemaBody) =>
  `Another ${body.singular.toLowerCase()} field has this name`;
/** The group labels the kind's screens use, in order, for the Group input's suggestions. */
const groupLabels = (body: KindSchemaBody) => [
  ...new Set(
    body.screens.flatMap((screen) =>
      screen.groups.flatMap((group) => (group.label ? [group.label] : [])),
    ),
  ),
];
/** The field's group on the kind's default edit screen: its label, or "" for none. */
const editGroup = (body: KindSchemaBody, key: string) =>
  screenFor(body, null, "edit").groups.find((group) =>
    group.fields.some((entry) => entry.key === key),
  )?.label ?? "";

/**
 * Why the page does not send this body: the body schema, the store's rules against the version in
 * force, and a sensitive mark changed by anyone but a company owner. Empty when it may be sent.
 */
export function draftRefusal(
  kind: KindView,
  next: KindSchemaBody,
  owner: boolean,
): string[] {
  const parsed = kindSchemaBodySchema.safeParse(plainJson(next));
  if (!parsed.success) return issueList(parsed.error.issues).split("; ");
  const issues = kindSchemaDraftIssues(kind.state.current.body, parsed.data);
  if (issues.length) return issues;
  if (!owner && sensitiveMarksDiffer(kind.body, parsed.data))
    return [SENSITIVE_OWNER_ONLY];
  return [];
}
const unchanged = (before: KindSchemaBody, after: KindSchemaBody) =>
  JSON.stringify(plainJson(before)) === JSON.stringify(plainJson(after));

/** Admin > Fields: every configurable kind's fields, edited through drafts and published by kind. */
export function FieldsTab({ access }: { access: MeAccess }) {
  const { team } = useWorkspace();
  const teamId = team?.id ?? null;
  const result = useApi<{ data: KindSchemaState[] }>(
    teamId ? "/api/v1/admin/fields" : null,
  );
  const kinds = result.data?.data ?? null;
  const replace = (next: KindSchemaState) =>
    result.setData({
      data: (kinds ?? []).map((item) =>
        item.kind === next.kind ? next : item,
      ),
    });
  async function save(state: KindSchemaState, body: KindSchemaBody) {
    if (state.draft) {
      await requestJson(
        teamId,
        `/api/v1/admin/fields/drafts/${state.draft.versionId}`,
        { method: "PUT", body: JSON.stringify({ body }) },
      );
      replace({ ...state, draft: { ...state.draft, body } });
      result.refresh();
      return;
    }
    const created = await requestJson<{ data: { versionId: string } }>(
      teamId,
      "/api/v1/admin/fields",
      { method: "POST", body: JSON.stringify({ kind: state.kind, body }) },
    );
    replace({
      ...state,
      draft: {
        versionId: created.data.versionId,
        body,
        note: null,
        createdAt: new Date().toISOString(),
      },
    });
    result.refresh();
  }
  async function publish(state: KindSchemaState, body: KindSchemaBody) {
    const published = await requestJson<{ data: { number: number } }>(
      teamId,
      `/api/v1/admin/fields/drafts/${state.draft!.versionId}/publish`,
      { method: "POST" },
    );
    replace({
      ...state,
      current: {
        versionId: state.draft!.versionId,
        number: published.data.number,
        body,
      },
      draft: null,
    });
    result.refresh();
    return published.data.number;
  }
  return (
    <FieldsPanel
      kinds={kinds}
      error={result.error}
      owner={access.companyLevel === "owner"}
      onSave={save}
      onPublish={publish}
    />
  );
}

type Open =
  | { kind: "edit"; view: KindView; field: Field }
  | { kind: "create" }
  | { kind: "publish"; view: KindView };

export function FieldsPanel({
  kinds,
  error,
  owner,
  onSave = async () => {},
  onPublish = async () => 0,
}: {
  kinds: KindSchemaState[] | null;
  error: string;
  /** A company owner: only they see and change the sensitive mark. */
  owner: boolean;
  onSave?: (state: KindSchemaState, body: KindSchemaBody) => Promise<void>;
  onPublish?: (state: KindSchemaState, body: KindSchemaBody) => Promise<number>;
}) {
  const [filter, setFilter] = useState<ConfigurableKind | typeof ALL>(ALL);
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const { confirm, dialog } = useConfirm();
  // Where focus goes when the control that had it is gone: Archive, or Publish with its draft.
  const [noticeRef, focusNotice] = useFocusAfter<HTMLParagraphElement>();
  const views = (kinds ?? []).map(kindView);
  const shown = views.filter(
    (view) => filter === ALL || view.state.kind === filter,
  );
  const rows = shown.flatMap(kindRows);
  const drafts = views.filter((view) => view.state.draft);
  const labels = kindLabels(views);
  const close = () => {
    setOpen(null);
    setRefusal([]);
  };

  /** Sends the kind's new body to its draft, or refuses it here; true when saved. */
  async function save(view: KindView, next: KindSchemaBody) {
    if (busy) return false;
    setNotice("");
    if (unchanged(view.body, next)) return true;
    const issues = draftRefusal(view, next, owner);
    setRefusal(issues);
    if (issues.length) return false;
    setBusy(true);
    try {
      await onSave(view.state, plainJson(next));
      setNotice(
        `Saved to the ${view.body.singular} draft. Publish it to apply the change.`,
      );
      return true;
    } catch (e) {
      setRefusal([plainError(e)]);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function archive(view: KindView, field: Field) {
    if (
      field.system ||
      !(await confirm({
        title: "Archive this field?",
        message: `Archive ${field.label}? It is no longer required, and every value already stored in it is kept. The field stays in this list as Archived; it cannot be deleted.`,
        confirmLabel: "Archive field",
      }))
    )
      return;
    if (await save(view, withField(view.body, { ...field, archived: true })))
      focusNotice();
  }
  async function publish(view: KindView) {
    if (busy) return;
    setBusy(true);
    setRefusal([]);
    try {
      const number = await onPublish(view.state, view.body);
      focusNotice();
      setOpen(null);
      setNotice(`Published ${view.body.singular} version ${number}.`);
    } catch (e) {
      setRefusal([plainError(e)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel stack">
      <h2>Fields</h2>
      <p className="muted">
        The fields of every record kind, with their keys. Changes are saved to a
        draft of the kind and take effect when you publish it: saving,
        validation and exports use the published fields at once, while forms in
        the app still show the built-in fields. Archived fields keep their
        values; no field can be deleted.
      </p>
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
      {!open && refusal.length > 0 && <Refusal issues={refusal} />}
      {error ? (
        <p className="notice error" role="alert">
          Could not load the fields. {error}
        </p>
      ) : !kinds ? (
        <p role="status">Loading fields…</p>
      ) : (
        <>
          {drafts.length > 0 && (
            <section className="stack" style={box}>
              <h3>Drafts</h3>
              <ul className="stack" style={{ margin: 0, paddingLeft: 18 }}>
                {drafts.map((view) => {
                  const ownerOnly =
                    !owner &&
                    sensitiveMarksDiffer(view.state.current.body, view.body);
                  return (
                    <li key={view.state.kind}>
                      <div className="row" style={actionRow}>
                        <span>
                          <strong>{view.body.label}</strong>: Draft in progress.{" "}
                          {view.state.current.number === null
                            ? "Built-in"
                            : `Version ${view.state.current.number}`}{" "}
                          is in force.
                        </span>
                        {!ownerOnly && (
                          <button
                            type="button"
                            className="button"
                            disabled={busy || !!view.draftError}
                            onClick={() => {
                              setRefusal([]);
                              setOpen({ kind: "publish", view });
                            }}
                          >
                            Publish {view.body.singular} changes
                          </button>
                        )}
                      </div>
                      {ownerOnly && (
                        <p className="muted">{OWNER_MUST_PUBLISH}</p>
                      )}
                      {view.draftError && (
                        <p className="notice error" role="alert">
                          {view.draftError}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <div className="row" style={{ ...actionRow, alignItems: "end" }}>
            <label className="field">
              <span>Record kind</span>
              <select
                value={filter}
                onChange={(e) =>
                  setFilter(e.target.value as ConfigurableKind | typeof ALL)
                }
              >
                <option value={ALL}>All record kinds</option>
                {views.map((view) => (
                  <option key={view.state.kind} value={view.state.kind}>
                    {view.body.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                setRefusal([]);
                setNotice("");
                setOpen({ kind: "create" });
              }}
            >
              Create field
            </button>
          </div>
          {/* The record screens' phone layout: one labelled card per field at 720 px and below. */}
          <div className="records-panel">
            <div className="table-wrap">
              <table className="data-table compact fields-table">
                <caption className="sr-only">
                  Fields of{" "}
                  {filter === ALL ? "every record kind" : shown[0]?.body.label}
                </caption>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Key</th>
                    <th>Type</th>
                    <th>Record kind</th>
                    <th>Group</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ kind: view, field, group }) => {
                    const archived = !field.system && !!field.archived;
                    const name = `${field.label} (${view.body.singular})`;
                    return (
                      <tr key={`${view.state.kind}:${field.key}`}>
                        <td data-label="Name">
                          <div className="stack" style={{ gap: 4 }}>
                            <span>{field.label}</span>
                            <span className="tag-list">
                              <span className="tag">
                                {field.system ? "System" : "Custom"}
                              </span>
                              {archived && (
                                <span className="tag">Archived</span>
                              )}
                              {field.sensitive && (
                                <span className="badge warning">Sensitive</span>
                              )}
                              {field.required && (
                                <span className="tag">Required</span>
                              )}
                              {sharesName(
                                view.body,
                                field.key,
                                field.label,
                              ) && (
                                <span className="badge warning">
                                  {duplicateText(view.body)}
                                </span>
                              )}
                            </span>
                          </div>
                        </td>
                        <td data-label="Key">
                          <code>{field.key}</code>
                        </td>
                        <td data-label="Type">{typeLabel(field)}</td>
                        <td data-label="Record kind">{view.body.singular}</td>
                        <td data-label="Group">{group}</td>
                        <td data-label="Actions" className="fields-actions">
                          <div className="row" style={rowActions}>
                            <button
                              type="button"
                              className="button secondary small"
                              disabled={busy}
                              aria-label={`Edit ${name}`}
                              onClick={() => {
                                setRefusal([]);
                                setNotice("");
                                setOpen({ kind: "edit", view, field });
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="button secondary small"
                              disabled={
                                busy || !canMove(view.body, field.key, -1)
                              }
                              aria-label={`Move up ${name}`}
                              onClick={() =>
                                void save(
                                  view,
                                  moveField(view.body, field.key, -1),
                                )
                              }
                            >
                              Move up
                            </button>
                            <button
                              type="button"
                              className="button secondary small"
                              disabled={
                                busy || !canMove(view.body, field.key, 1)
                              }
                              aria-label={`Move down ${name}`}
                              onClick={() =>
                                void save(
                                  view,
                                  moveField(view.body, field.key, 1),
                                )
                              }
                            >
                              Move down
                            </button>
                            {!field.system && !archived && (
                              <button
                                type="button"
                                className="button secondary small"
                                disabled={busy}
                                aria-label={`Archive ${name}`}
                                onClick={() => void archive(view, field)}
                              >
                                Archive
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {open?.kind === "edit" && (
        <FieldEditor
          body={open.view.body}
          field={open.field}
          labels={labels}
          owner={owner}
          busy={busy}
          refusal={refusal}
          onClose={close}
          onSubmit={async (next) => {
            if (await save(open.view, next)) close();
          }}
        />
      )}
      {open?.kind === "create" && (
        <FieldWizard
          views={views}
          labels={labels}
          initialKind={filter === ALL ? "candidate" : filter}
          owner={owner}
          busy={busy}
          refusal={refusal}
          onRefusal={setRefusal}
          onClose={close}
          onCreate={async (view, next) => {
            if (await save(view, next)) close();
          }}
        />
      )}
      {open?.kind === "publish" && (
        <PublishDialog
          view={open.view}
          busy={busy}
          refusal={refusal}
          onCancel={close}
          onPublish={() => void publish(open.view)}
        />
      )}
      {dialog}
    </section>
  );
}

function Refusal({ issues }: { issues: string[] }) {
  return (
    <div className="notice error" role="alert">
      {issues.length === 1 ? (
        <p style={{ margin: 0 }}>{issues[0]}</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The publish summary of the kind's draft against the version in force, before anything is sent. */
export function PublishDialog({
  view,
  busy = false,
  refusal = [],
  onCancel,
  onPublish,
}: {
  view: KindView;
  busy?: boolean;
  refusal?: string[];
  onCancel: () => void;
  onPublish: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  // Runs after Dialog has opened, so focus lands inside the modal.
  useEffect(() => cancel.current?.focus(), []);
  const changes = kindSchemaChanges(view.state.current.body, view.body);
  const listed = CHANGE_CATEGORIES.filter(
    (category) => changes[category].length,
  );
  return (
    <Dialog
      title={`Publish ${view.body.singular} changes?`}
      onClose={onCancel}
      busy={busy}
    >
      <div className="dialog-body stack">
        <p>
          Publishing makes this draft the {view.body.singular.toLowerCase()}{" "}
          fields in force. Saving, validation and exports use it at once.
        </p>
        {listed.length ? (
          listed.map((category) => (
            <section key={category}>
              <h3>{CATEGORY_LABELS[category]}</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {changes[category].map((field) => (
                  <li key={field.key}>
                    {field.label} <code>{field.key}</code>
                  </li>
                ))}
              </ul>
            </section>
          ))
        ) : (
          <p>No changes from the published version.</p>
        )}
        {refusal.length > 0 && <Refusal issues={refusal} />}
      </div>
      <footer className="dialog-footer">
        <button
          ref={cancel}
          type="button"
          className="button secondary"
          autoFocus
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={onPublish}
        >
          Publish
        </button>
      </footer>
    </Dialog>
  );
}

/** Required, the type's validation attributes and, for a company owner, Sensitive. */
function ValidationInputs({
  type,
  inputs,
  required,
  sensitive,
  owner,
  options,
  labels,
  onChange,
}: {
  type: CustomFieldType;
  inputs: Inputs;
  required: boolean;
  sensitive: boolean;
  owner: boolean;
  /** The option labels a default can choose from; null when options are typed here. */
  options: string[] | null;
  /** Each kind's plural label, for a lookup's target. */
  labels: Record<ConfigurableKind, string>;
  onChange: (next: {
    inputs?: Inputs;
    required?: boolean;
    sensitive?: boolean;
  }) => void;
}) {
  const id = useId();
  const attributes = TYPE_ATTRIBUTES[type];
  const set = (patch: Partial<Inputs>) =>
    onChange({ inputs: { ...inputs, ...patch } });
  const bounds = BOUND_LABELS[type];
  const boundType =
    type === "date" ? "date" : type === "date-time" ? "text" : "number";
  const choices = options ?? optionLines(inputs);
  return (
    <>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={required}
          onChange={(e) => onChange({ required: e.target.checked })}
        />
        Required
      </label>
      {attributes.includes("currency") && (
        <label className="field">
          <span>Currency</span>
          <input
            value={inputs.currency}
            maxLength={3}
            aria-describedby={`${id}-currency`}
            onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
          />
          <small id={`${id}-currency`} className="muted">
            Three capital letters, such as AED.
          </small>
        </label>
      )}
      {attributes.includes("options") && options === null && (
        <label className="field">
          <span>Options</span>
          <textarea
            rows={4}
            value={inputs.options}
            aria-describedby={`${id}-options`}
            onChange={(e) => set({ options: e.target.value })}
          />
          <small id={`${id}-options`} className="muted">
            One option per line.
          </small>
        </label>
      )}
      {attributes.includes("bounds") && bounds && (
        <div className="row" style={actionRow}>
          {(["min", "max"] as const).map((bound, index) => (
            <label key={bound} className="field">
              <span>{bounds[index]}</span>
              <input
                type={boundType}
                value={inputs[bound]}
                aria-describedby={
                  type === "date-time" ? `${id}-instant` : undefined
                }
                onChange={(e) => set({ [bound]: e.target.value })}
              />
            </label>
          ))}
          {type === "date-time" && (
            <small id={`${id}-instant`} className="muted">
              With a time zone, such as 2026-11-12T09:00:00+04:00.
            </small>
          )}
        </div>
      )}
      {attributes.includes("pattern") && (
        <label className="field">
          <span>Pattern</span>
          <input
            value={inputs.pattern}
            aria-describedby={`${id}-pattern`}
            onChange={(e) => set({ pattern: e.target.value })}
          />
          <small id={`${id}-pattern`} className="muted">
            A regular expression the whole value must match. Leave it empty for
            none.
          </small>
        </label>
      )}
      {attributes.includes("target") && (
        <label className="field">
          <span>Record kind to look up</span>
          <select
            value={inputs.target}
            onChange={(e) => set({ target: e.target.value })}
          >
            {CONFIGURABLE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {labels[kind]}
              </option>
            ))}
          </select>
        </label>
      )}
      {!DEFAULTLESS.includes(type) &&
        (type === "multi-select" ? (
          <fieldset style={box}>
            <legend>Default</legend>
            <div style={checks}>
              {choices.map((choice) => (
                <label key={choice} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={inputs.defaultOptions.includes(choice)}
                    onChange={(e) =>
                      set({
                        defaultOptions: e.target.checked
                          ? [...inputs.defaultOptions, choice]
                          : inputs.defaultOptions.filter(
                              (item) => item !== choice,
                            ),
                      })
                    }
                  />
                  {choice}
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <label className="field">
            <span>Default</span>
            {type === "checkbox" || type === "dropdown" ? (
              <select
                value={inputs.defaultValue}
                onChange={(e) => set({ defaultValue: e.target.value })}
              >
                <option value="">No default</option>
                {type === "checkbox" ? (
                  <>
                    <option value="true">Ticked</option>
                    <option value="false">Not ticked</option>
                  </>
                ) : (
                  choices.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}
                    </option>
                  ))
                )}
              </select>
            ) : (
              <input
                type={
                  type === "number" || type === "percentage"
                    ? "number"
                    : type === "date"
                      ? "date"
                      : "text"
                }
                value={inputs.defaultValue}
                onChange={(e) => set({ defaultValue: e.target.value })}
              />
            )}
          </label>
        ))}
      {owner && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={sensitive}
            onChange={(e) => onChange({ sensitive: e.target.checked })}
          />
          Sensitive
        </label>
      )}
    </>
  );
}

/** The Name input with the duplicate-name warning while typing (FLD-012). */
function NameInput({
  body,
  fieldKey,
  value,
  onChange,
}: {
  body: KindSchemaBody;
  fieldKey: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const duplicate = sharesName(body, fieldKey, value);
  return (
    <label className="field">
      <span>Name</span>
      <input
        value={value}
        required
        maxLength={120}
        aria-describedby={duplicate ? id : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {duplicate && (
        <small id={id} className="badge warning">
          {duplicateText(body)}
        </small>
      )}
    </label>
  );
}

/**
 * Edit one field: name, help text, group and Required for every field, the validation attributes
 * of a custom field (never its type or options) and, for a company owner, Sensitive.
 */
export function FieldEditor({
  body,
  field,
  labels,
  owner,
  busy = false,
  refusal = [],
  onClose,
  onSubmit,
}: {
  body: KindSchemaBody;
  field: Field;
  /** Each kind's plural label, for a lookup's target. */
  labels: Record<ConfigurableKind, string>;
  owner: boolean;
  busy?: boolean;
  refusal?: string[];
  onClose: () => void;
  onSubmit: (next: KindSchemaBody) => void;
}) {
  const id = useId();
  const [label, setLabel] = useState(field.label);
  const [help, setHelp] = useState(field.help ?? "");
  const [group, setGroup] = useState(editGroup(body, field.key));
  const [required, setRequired] = useState(field.required);
  const [sensitive, setSensitive] = useState(field.sensitive ?? false);
  const [inputs, setInputs] = useState<Inputs | null>(
    field.system ? null : inputsOf(field),
  );
  const builtInRequired =
    field.system && systemFieldConfig(body.kind, field.key).required;
  const alwaysSensitive =
    field.system &&
    body.kind === "candidate" &&
    (SENSITIVE_CANDIDATE_FIELDS as readonly string[]).includes(field.key);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A sensitive mark the editor never offered stays as it was.
    const mark = owner ? sensitive : (field.sensitive ?? false);
    let next: Field;
    if (field.system) {
      const { help: _help, ...rest } = field;
      next = {
        ...rest,
        label,
        required,
        sensitive: mark,
        ...(help.trim() ? { help } : {}),
      };
    } else
      next = customDefinition(
        {
          key: field.key,
          label,
          help,
          required,
          archived: field.archived,
          sensitive: mark,
        },
        field.type,
        inputs!,
        "options" in field ? field.options : [],
      ) as unknown as Field;
    let changed = withField(body, next);
    const target = group.trim();
    if (target !== editGroup(body, field.key))
      changed = moveToGroup(changed, field.key, target || undefined);
    onSubmit(changed);
  }
  return (
    <Dialog title={`Edit ${field.label}`} onClose={onClose} busy={busy} wide>
      <form onSubmit={submit}>
        <div className="dialog-body stack">
          <p className="muted">
            {field.system ? "System field" : "Custom field"} of{" "}
            {body.label.toLowerCase()}. Key <code>{field.key}</code>. Type:{" "}
            {typeLabel(field)}.
          </p>
          <NameInput
            body={body}
            fieldKey={field.key}
            value={label}
            onChange={setLabel}
          />
          <label className="field">
            <span>Help text</span>
            <textarea
              rows={2}
              value={help}
              maxLength={500}
              onChange={(e) => setHelp(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Group</span>
            <input
              value={group}
              list={`${id}-groups`}
              aria-describedby={`${id}-group`}
              onChange={(e) => setGroup(e.target.value)}
            />
            <datalist id={`${id}-groups`}>
              {groupLabels(body).map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
            <small id={`${id}-group`} className="muted">
              The field moves to the end of this group on every screen that
              shows it. Leave it empty for no group.
            </small>
          </label>
          {field.system ? (
            <>
              {builtInRequired ? (
                <p>Always required</p>
              ) : (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={required}
                    onChange={(e) => setRequired(e.target.checked)}
                  />
                  Required
                </label>
              )}
              {owner && (
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={sensitive}
                    disabled={alwaysSensitive}
                    onChange={(e) => setSensitive(e.target.checked)}
                  />
                  Sensitive
                </label>
              )}
            </>
          ) : (
            <ValidationInputs
              type={field.type}
              inputs={inputs!}
              required={required}
              sensitive={sensitive}
              owner={owner}
              options={
                "options" in field
                  ? field.options.map((option) => option.label)
                  : null
              }
              labels={labels}
              onChange={(next) => {
                if (next.inputs) setInputs(next.inputs);
                if (next.required !== undefined) setRequired(next.required);
                if (next.sensitive !== undefined) setSensitive(next.sensitive);
              }}
            />
          )}
          {!owner && field.sensitive && (
            <p className="muted">
              Sensitive. Only a company owner can change this mark.
            </p>
          )}
          {refusal.length > 0 && <Refusal issues={refusal} />}
        </div>
        <footer className="dialog-footer">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy}>
            Save to draft
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

const STEPS = [
  "Record kind",
  "Type",
  "Name and help text",
  "Validation",
  "Screens",
] as const;
/** The create wizard's choices so far; `step` counts from 1. */
export type WizardState = {
  step: number;
  kind: ConfigurableKind;
  type: CustomFieldType;
  label: string;
  help: string;
  required: boolean;
  sensitive: boolean;
  inputs: Inputs;
  /** The screen keys the field is added to. */
  screens: string[];
};
/** The default create, edit and view screens of a kind are ticked. */
const DEFAULT_SCREENS = ["create", "edit", "view"];
export const newWizard = (kind: ConfigurableKind): WizardState => ({
  step: 1,
  kind,
  type: "short-text",
  label: "",
  help: "",
  required: false,
  sensitive: false,
  inputs: emptyInputs("short-text"),
  screens: DEFAULT_SCREENS,
});
/** The wizard's field with fresh option ids and the given key. */
const wizardField = (state: WizardState, key: string) =>
  customDefinition(
    {
      key,
      label: state.label,
      help: state.help,
      required: state.required,
      sensitive: state.sensitive,
    },
    state.type,
    state.inputs,
    optionLines(state.inputs).map((line) => ({
      id: crypto.randomUUID(),
      label: line,
    })),
  );

/** One step of the create wizard, with its heading. */
export function WizardStep({
  state,
  body,
  labels,
  owner,
  headingRef,
  onChange,
}: {
  state: WizardState;
  /** The chosen kind as the page edits it. */
  body: KindSchemaBody;
  /** Each kind's plural label. */
  labels: Record<ConfigurableKind, string>;
  owner: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
  onChange: (patch: Partial<WizardState>) => void;
}) {
  const id = useId();
  return (
    <div className="stack">
      <p className="muted">
        Step {state.step} of {STEPS.length}
      </p>
      <h3 ref={headingRef} tabIndex={-1}>
        {state.step}. {STEPS[state.step - 1]}
      </h3>
      {state.step === 1 && (
        <label className="field">
          <span>Record kind</span>
          <select
            value={state.kind}
            onChange={(e) =>
              onChange({
                kind: e.target.value as ConfigurableKind,
                screens: DEFAULT_SCREENS,
              })
            }
          >
            {CONFIGURABLE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {labels[kind]}
              </option>
            ))}
          </select>
        </label>
      )}
      {state.step === 2 && (
        <label className="field">
          <span>Type</span>
          <select
            value={state.type}
            aria-describedby={id}
            onChange={(e) => {
              const type = e.target.value as CustomFieldType;
              onChange({ type, inputs: emptyInputs(type) });
            }}
          >
            {FIELD_TYPES.map((type) => (
              <option key={type} value={type}>
                {CUSTOM_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          <small id={id} className="muted">
            A field&apos;s type never changes after it is created.
          </small>
        </label>
      )}
      {state.step === 3 && (
        <>
          <NameInput
            body={body}
            fieldKey=""
            value={state.label}
            onChange={(label) => onChange({ label })}
          />
          <label className="field">
            <span>Help text</span>
            <textarea
              rows={2}
              value={state.help}
              maxLength={500}
              onChange={(e) => onChange({ help: e.target.value })}
            />
          </label>
        </>
      )}
      {state.step === 4 && (
        <ValidationInputs
          type={state.type}
          inputs={state.inputs}
          required={state.required}
          sensitive={state.sensitive}
          owner={owner}
          options={null}
          labels={labels}
          onChange={(next) => onChange(next)}
        />
      )}
      {state.step === 5 && (
        <fieldset style={box}>
          <legend>Add the field to these screens</legend>
          <div style={checks}>
            {body.screens.map((screen) => {
              const key = screenKey(screen);
              return (
                <label key={key} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={state.screens.includes(key)}
                    onChange={(e) =>
                      onChange({
                        screens: e.target.checked
                          ? [...state.screens, key]
                          : state.screens.filter((item) => item !== key),
                      })
                    }
                  />
                  {screenLabel(screen)}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
    </div>
  );
}

/** Why the wizard cannot leave this step, checked on the step itself; empty when it can. */
export function wizardIssues(state: WizardState): string[] {
  if (state.step === 3) {
    const issues = [
      ...(configLabel.safeParse(state.label).error?.issues ?? []).map(
        (issue) => ({ ...issue, path: ["label"] }),
      ),
      ...(configHelpText.safeParse(state.help).error?.issues ?? []).map(
        (issue) => ({ ...issue, path: ["help"] }),
      ),
    ];
    return issues.length ? issueText(issues) : [];
  }
  if (state.step === 4) {
    const parsed = kindSchemaCustomFieldSchema.safeParse(
      plainJson(wizardField(state, crypto.randomUUID())),
    );
    return parsed.success
      ? []
      : issueText(parsed.error.issues, BOUND_LABELS[state.type]);
  }
  return [];
}

/** The create wizard: kind, type, name and help, validation and screens, then Create field. */
function FieldWizard({
  views,
  labels,
  initialKind,
  owner,
  busy,
  refusal,
  onRefusal,
  onClose,
  onCreate,
}: {
  views: KindView[];
  labels: Record<ConfigurableKind, string>;
  initialKind: ConfigurableKind;
  owner: boolean;
  busy: boolean;
  refusal: string[];
  onRefusal: (issues: string[]) => void;
  onClose: () => void;
  onCreate: (view: KindView, next: KindSchemaBody) => void;
}) {
  const [state, setState] = useState(() => newWizard(initialKind));
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [state.step]);
  const view = views.find((item) => item.state.kind === state.kind)!;
  const go = (step: number) => {
    onRefusal([]);
    setState({ ...state, step });
  };
  function next() {
    const issues = wizardIssues(state);
    if (issues.length) onRefusal(issues);
    else go(state.step + 1);
  }
  function create() {
    onCreate(
      view,
      addField(
        view.body,
        plainJson(wizardField(state, crypto.randomUUID())) as Field,
        state.screens,
      ),
    );
  }
  return (
    <Dialog title="Create field" onClose={onClose} busy={busy} wide>
      <div className="dialog-body stack">
        <WizardStep
          state={state}
          body={view.body}
          labels={labels}
          owner={owner}
          headingRef={heading}
          onChange={(patch) => setState({ ...state, ...patch })}
        />
        {refusal.length > 0 && <Refusal issues={refusal} />}
      </div>
      <footer className="dialog-footer">
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={state.step === 1 ? onClose : () => go(state.step - 1)}
        >
          {state.step === 1 ? "Cancel" : "Back"}
        </button>
        {state.step < STEPS.length ? (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={next}
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={create}
          >
            Create field
          </button>
        )}
      </footer>
    </Dialog>
  );
}
