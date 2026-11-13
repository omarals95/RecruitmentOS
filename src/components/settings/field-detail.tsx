"use client";

import Link from "next/link";
import { useEffect, useId, useState, type Ref } from "react";
import type { MeAccess } from "@/lib/authz";
import type { KindSchemaBody } from "@/domain/config";
import { kindSchemaCustomFieldSchema } from "@/domain/field-types";
import { fieldWhereUsed, whereUsedText } from "@/domain/field-where-used";
import { useApi, useWorkspace } from "@/components/workspace/client";
import { tabKeys } from "@/components/ui/tab-keys";
import { AdminPortalView } from "./admin-portal";
import { FIELD_DETAIL_TABS, type FieldDetailTab } from "./field-detail-tabs";
import {
  DraftState,
  FieldBadges,
  PublishDialog,
  Refusal,
  issueText,
  kindView,
  plainJson,
  typeLabel,
  useDraftChanges,
  useKindSchemas,
  withField,
  type Field,
  type KindView,
  type Option,
} from "./fields-tab";
import { actionRow, box } from "./roles-tab";

export type { FieldDetailTab };

export interface FieldDetailProps {
  /** The record kind and field key in the URL; the server allowed the Fields page. */
  kind: string;
  fieldKey: string;
  /** The caller's company level in the active team: only a company owner changes a sensitive mark. */
  companyLevel: string | null;
  tab: FieldDetailTab;
}

export const FIELD_NOT_FOUND = "Field not found.";
export const ONE_DEFINITION =
  "A field has one definition for the whole company. It is never set per team.";
export const BUILT_IN_OPTIONS = "Built-in options cannot be changed.";
export const NO_OPTIONS = "This field type has no options.";
export const NOTHING_USES = "Nothing uses this field.";
export const SYSTEM_COUNT = "Record counts are shown for custom fields only.";
export const DRAFT_ONLY_COUNT =
  "Not published yet, so no record holds a value.";

/**
 * Admin > Fields > one field: the shell and sidebar of the active team, as on every admin page,
 * with the field's tabs beside it. A team switch remounts the detail.
 */
export function FieldDetailPortal(props: FieldDetailProps) {
  const { team } = useWorkspace();
  const result = useApi<{ data: MeAccess }>(team ? "/api/v1/me/access" : null);
  return (
    <AdminPortalView
      tab="fields"
      access={result.data?.data ?? null}
      denied={false}
      error={result.error}
      detail={<FieldDetail key={team?.id ?? "no-team"} {...props} />}
    />
  );
}

/** The field's view: the kind's draft view, the field in it, or null when either is not found. */
function findField(views: KindView[], kind: string, key: string) {
  const view = views.find((item) => item.state.kind === kind);
  const field = view?.body.fields.find((item) => item.key === key);
  return view && field ? { view, field } : null;
}

/**
 * Whether the field's usage is counted: a custom field of the version in force. A system field or a
 * custom field only in the draft sends no request.
 */
export const countsUsage = (view: KindView, field: Field) =>
  !field.system &&
  view.state.current.body.fields.some(
    (item) => !item.system && item.key === field.key,
  );

/** The usage route for one custom field of one kind. */
export const usagePath = (view: KindView, field: Field) =>
  `/api/v1/admin/fields/usage?kind=${encodeURIComponent(view.state.kind)}&fieldId=${encodeURIComponent(field.key)}`;

/** The custom field with these options, every other attribute and every screen unchanged. */
export function withOptions(
  body: KindSchemaBody,
  field: Field,
  options: Option[],
): KindSchemaBody {
  return withField(body, { ...field, options } as Field);
}

/**
 * Why the options are refused before anything is sent: the field's own schema, so a blank or
 * duplicate label and a disabled default name their input. Empty when they may be saved.
 */
export function optionIssues(field: Field, options: Option[]): string[] {
  const parsed = kindSchemaCustomFieldSchema.safeParse(
    plainJson({ ...field, options }),
  );
  return parsed.success ? [] : issueText(parsed.error.issues);
}

/** GET /api/v1/admin/fields for the active team, the field's usage count, and every change. */
function FieldDetail({ kind, fieldKey, companyLevel, tab }: FieldDetailProps) {
  const owner = companyLevel === "owner";
  const { kinds, error, save, publish } = useKindSchemas();
  const changes = useDraftChanges({ owner, onSave: save, onPublish: publish });
  const [publishing, setPublishing] = useState(false);
  const found = kinds ? findField(kinds.map(kindView), kind, fieldKey) : null;
  if (error)
    return (
      <p className="notice error" role="alert">
        Could not load the fields. {error}
      </p>
    );
  if (!kinds) return <p role="status">Loading this field…</p>;
  if (!found)
    return (
      <>
        <p>
          <Link href="/app/admin/fields">Back to Fields</Link>
        </p>
        <section className="panel">
          <p>{FIELD_NOT_FOUND}</p>
        </section>
      </>
    );
  const { view, field } = found;
  return (
    <>
      <FieldDetailView
        view={view}
        field={field}
        tab={tab}
        owner={owner}
        busy={changes.busy}
        refusal={publishing ? [] : changes.refusal}
        notice={changes.notice}
        noticeRef={changes.noticeRef}
        onSaveOptions={async (options) => {
          changes.setNotice("");
          const issues = optionIssues(field, options);
          changes.setRefusal(issues);
          if (issues.length) return;
          if (await changes.save(view, withOptions(view.body, field, options)))
            changes.focusNotice();
        }}
        onArchive={() => void changes.archive(view, field)}
        onPublish={() => {
          changes.setRefusal([]);
          setPublishing(true);
        }}
      />
      {publishing && (
        <PublishDialog
          view={view}
          busy={changes.busy}
          refusal={changes.refusal}
          onCancel={() => {
            setPublishing(false);
            changes.setRefusal([]);
          }}
          onPublish={() =>
            void changes.publish(view, () => setPublishing(false))
          }
        />
      )}
      {changes.dialog}
    </>
  );
}

/**
 * The loaded field: Back to Fields, its name, key, type, kind and badges, the kind's draft, the
 * record count, and the Contexts & options and Where used tabs.
 */
export function FieldDetailView({
  view,
  field,
  tab,
  owner,
  busy = false,
  refusal = [],
  notice = "",
  noticeRef,
  onSaveOptions = async () => {},
  onArchive = () => {},
  onPublish = () => {},
}: {
  view: KindView;
  field: Field;
  tab: FieldDetailTab;
  owner: boolean;
  busy?: boolean;
  refusal?: string[];
  notice?: string;
  noticeRef?: Ref<HTMLParagraphElement>;
  onSaveOptions?: (options: Option[]) => Promise<void>;
  onArchive?: () => void;
  onPublish?: () => void;
}) {
  const [current, setCurrent] = useState(tab);
  return (
    <>
      <p>
        <Link href="/app/admin/fields">Back to Fields</Link>
      </p>
      <h2>{field.label}</h2>
      <p className="muted">
        Key <code>{field.key}</code>. Type: {typeLabel(field)}. Record kind:{" "}
        {view.body.singular}.
      </p>
      <FieldBadges body={view.body} field={field} />
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
      {refusal.length > 0 && <Refusal issues={refusal} />}
      {view.state.draft && (
        <section className="stack" style={box}>
          <DraftState
            view={view}
            owner={owner}
            busy={busy}
            onPublish={onPublish}
          />
        </section>
      )}
      <FieldUsage view={view} field={field} />
      <div
        className="tabs"
        role="tablist"
        aria-label="Field details"
        onKeyDown={tabKeys}
      >
        {FIELD_DETAIL_TABS.map((item) => (
          <button
            type="button"
            role="tab"
            id={`field-tab-${item.key}`}
            aria-controls={`field-panel-${item.key}`}
            tabIndex={current === item.key ? 0 : -1}
            aria-selected={current === item.key}
            key={item.key}
            onClick={() => setCurrent(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`field-panel-${current}`}
        aria-labelledby={`field-tab-${current}`}
        tabIndex={0}
        className="stack"
      >
        {current === "contexts" ? (
          <ContextsTab
            view={view}
            field={field}
            busy={busy}
            onSaveOptions={onSaveOptions}
          />
        ) : (
          <WhereUsedTab
            view={view}
            field={field}
            busy={busy}
            onArchive={onArchive}
          />
        )}
      </div>
    </>
  );
}

/** The usage route's count, read only for a custom field in force (countsUsage). */
function FieldUsage({ view, field }: { view: KindView; field: Field }) {
  const usage = useApi<{ data: { count: number } }>(
    countsUsage(view, field) ? usagePath(view, field) : null,
  );
  return (
    <UsageCount
      view={view}
      field={field}
      usage={{ count: usage.data?.data.count ?? null, error: usage.error }}
    />
  );
}

/** Records with a value, for a custom field in force only; never a record, value or breakdown. */
export function UsageCount({
  view,
  field,
  usage,
}: {
  view: KindView;
  field: Field;
  usage: { count: number | null; error: string };
}) {
  if (field.system) return <p className="muted">{SYSTEM_COUNT}</p>;
  if (!countsUsage(view, field))
    return <p className="muted">{DRAFT_ONLY_COUNT}</p>;
  if (usage.error)
    return (
      <p className="notice error" role="alert">
        Records with a value: {usage.error}
      </p>
    );
  if (usage.count === null)
    return <p role="status">Loading the record count…</p>;
  return (
    <p>
      Records with a value: {usage.count} (across every team of the company)
    </p>
  );
}

/** The field's context, read only, and its options. */
function ContextsTab({
  view,
  field,
  busy,
  onSaveOptions,
}: {
  view: KindView;
  field: Field;
  busy: boolean;
  onSaveOptions: (options: Option[]) => Promise<void>;
}) {
  const types = field.system ? undefined : field.types;
  return (
    <>
      <section className="stack">
        <h3>Context</h3>
        <p className="muted">{ONE_DEFINITION}</p>
        <p>Record kind: {view.body.singular}</p>
        {types ? (
          <>
            <p>Applies to these record types only:</p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {types.map((type) => (
                <li key={type}>
                  <code>{type}</code>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>All {view.body.singular.toLowerCase()} records</p>
        )}
      </section>
      <section className="stack">
        <h3>Options</h3>
        {!field.system && "options" in field ? (
          <OptionsEditor
            field={field}
            busy={busy}
            onSaveOptions={onSaveOptions}
          />
        ) : field.system && field.options ? (
          <>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {field.options.map((option) => (
                <li key={option}>{option}</li>
              ))}
            </ul>
            <p className="muted">{BUILT_IN_OPTIONS}</p>
          </>
        ) : (
          <p>{NO_OPTIONS}</p>
        )}
      </section>
    </>
  );
}

type Step = -1 | 1;
/**
 * A dropdown's or multi-select's options in order: rename, Move up, Move down and Disable or
 * Enable, by option id; New option and Add; and one draft save with Save options.
 */
export function OptionsEditor({
  field,
  busy = false,
  onSaveOptions = async () => {},
}: {
  field: Extract<Field, { options: Option[] }>;
  busy?: boolean;
  onSaveOptions?: (options: Option[]) => Promise<void>;
}) {
  const id = useId();
  const [options, setOptions] = useState<Option[]>(field.options);
  const [added, setAdded] = useState("");
  // The control that keeps focus after a move: its own button, or the other one at an end.
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    if (focus) document.getElementById(focus)?.focus();
  }, [focus]);
  const control = (optionId: string, name: string) =>
    `${id}-${optionId}-${name}`;
  const update = (index: number, patch: Partial<Option>) =>
    setOptions(
      options.map((option, at) =>
        at === index ? { ...option, ...patch } : option,
      ),
    );
  function move(index: number, step: Step) {
    const next = [...options];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    setOptions(next);
    const to = index + step;
    const end = step === -1 ? to === 0 : to === next.length - 1;
    setFocus(
      control(
        next[to].id,
        end ? (step === -1 ? "down" : "up") : step === -1 ? "up" : "down",
      ),
    );
  }
  return (
    <div className="stack">
      <ol className="stack field-options">
        {options.map((option, index) => (
          <li key={option.id} className="row" style={actionRow}>
            <label className="field">
              <span>Option {index + 1}</span>
              <input
                value={option.label}
                maxLength={200}
                onChange={(e) => update(index, { label: e.target.value })}
              />
            </label>
            {option.disabled && <span className="tag">Disabled</span>}
            <div className="row" style={{ ...actionRow, gap: 6 }}>
              <button
                type="button"
                id={control(option.id, "up")}
                className="button secondary small"
                disabled={busy || index === 0}
                aria-label={`Move up ${option.label}`}
                onClick={() => move(index, -1)}
              >
                Move up
              </button>
              <button
                type="button"
                id={control(option.id, "down")}
                className="button secondary small"
                disabled={busy || index === options.length - 1}
                aria-label={`Move down ${option.label}`}
                onClick={() => move(index, 1)}
              >
                Move down
              </button>
              <button
                type="button"
                className="button secondary small"
                disabled={busy}
                aria-label={`${option.disabled ? "Enable" : "Disable"} ${option.label}`}
                onClick={() =>
                  update(
                    index,
                    option.disabled
                      ? { disabled: undefined }
                      : { disabled: true },
                  )
                }
              >
                {option.disabled ? "Enable" : "Disable"}
              </button>
            </div>
          </li>
        ))}
      </ol>
      <p className="muted">
        A disabled option is no longer offered for new values; records that
        already hold it keep it. Renaming changes only the label, never a stored
        value.
      </p>
      <form
        className="row"
        style={{ ...actionRow, alignItems: "end" }}
        aria-label="Add an option"
        onSubmit={(event) => {
          event.preventDefault();
          if (!added.trim()) return;
          setOptions([
            ...options,
            { id: crypto.randomUUID(), label: added.trim() },
          ]);
          setAdded("");
        }}
      >
        <label className="field">
          <span>New option</span>
          <input
            value={added}
            maxLength={200}
            onChange={(e) => setAdded(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="button secondary"
          disabled={busy || !added.trim()}
        >
          Add
        </button>
      </form>
      <div className="row">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void onSaveOptions(plainJson(options))}
        >
          Save options
        </button>
      </div>
    </div>
  );
}

/** The field's uses, source by source, and Archive for an active custom field. */
function WhereUsedTab({
  view,
  field,
  busy,
  onArchive,
}: {
  view: KindView;
  field: Field;
  busy: boolean;
  onArchive: () => void;
}) {
  const entries = fieldWhereUsed(view.body, field.key);
  return (
    <>
      {entries.length ? (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {entries.map((entry) => (
            <li key={`${entry.source}:${entry.label}`}>
              {whereUsedText(entry)}
            </li>
          ))}
        </ul>
      ) : (
        <p>{NOTHING_USES}</p>
      )}
      {!field.system && !field.archived && (
        <div className="row">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            aria-label={`Archive ${field.label} (${view.body.singular})`}
            onClick={onArchive}
          >
            Archive
          </button>
        </div>
      )}
    </>
  );
}
