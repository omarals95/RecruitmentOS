"use client";

import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { MeAccess } from "@/lib/authz";
import type { KindSchemaState } from "@/lib/config-store";
import type { ConfigurableKind, KindSchemaBody } from "@/domain/config";
import { screenLabel } from "@/domain/field-where-used";
import {
  mandatoryKeys,
  readOnlyKeys,
  screenKey,
  shownGroups,
  type Screen,
  type ScreenAction,
  type ScreenEntry,
  type ScreenGroup,
} from "@/domain/screens";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  DraftState,
  FieldBadges,
  PublishDialog,
  Refusal,
  RequiredOffCreateList,
  kindView,
  typeLabel,
  unchanged,
  useDraftChanges,
  useKindSchemas,
  type Field,
} from "./fields-tab";
import { actionRow } from "./roles-tab";
import {
  RULES,
  RULE_LABELS,
  SECTIONS_MAX,
  UNNAMED_SECTION,
  addEntry,
  addSection,
  addedText,
  canMoveEntry,
  designerRefusal,
  entryRule,
  moveEntry,
  moveEntryTo,
  moveSection,
  movedText,
  removeEntry,
  removeSection,
  removedText,
  renameSection,
  ruleLimits,
  ruleText,
  sectionMovedText,
  sectionTitle,
  setEntryRule,
  type Place,
  type Rule,
} from "./screen-designer";

const ACTION_LABELS: Record<ScreenAction, string> = {
  create: "Create",
  edit: "Edit",
  view: "View",
  transition: "Transition",
};
/** The record type select's value for the default (untyped) screens. */
const DEFAULT_TYPE = "";
export const HIDDEN_FROM_YOU = "A field hidden from you";
// Drag payloads: an entry of the screen, a field from the picker, a section by index.
const ENTRY = "text/recruitmentos-screen-entry";
const PICKED = "text/recruitmentos-screen-field";
const SECTION = "text/recruitmentos-screen-section";

type Choice = { type: string; action: ScreenAction };
/** The chosen screen of the body, else its default create screen, which every body has. */
const chosenScreen = (body: KindSchemaBody, choice: Choice) =>
  body.screens.find(
    (screen) =>
      (screen.type ?? DEFAULT_TYPE) === choice.type &&
      screen.action === choice.action,
  ) ??
  body.screens.find(
    (screen) => screen.type === undefined && screen.action === "create",
  )!;
/** The record types the body has screens for, default first, each once. */
const screenTypes = (body: KindSchemaBody) => [
  DEFAULT_TYPE,
  ...new Set(body.screens.flatMap((screen) => screen.type ?? [])),
];
/** The actions with a screen of exactly this type, in action order. */
const screenActions = (body: KindSchemaBody, type: string) =>
  (Object.keys(ACTION_LABELS) as ScreenAction[]).filter((action) =>
    body.screens.some(
      (screen) =>
        (screen.type ?? DEFAULT_TYPE) === type && screen.action === action,
    ),
  );

/**
 * The picker's fields: the kind's fields that are not archived and not on this screen, whose label,
 * key or type label holds the query, ignoring case.
 */
export function pickerFields(
  body: KindSchemaBody,
  screen: Screen,
  query: string,
): Field[] {
  const listed = new Set(
    screen.groups.flatMap((group) => group.fields.map((entry) => entry.key)),
  );
  const wanted = query.trim().toLowerCase();
  return body.fields.filter(
    (field) =>
      !listed.has(field.key) &&
      !(!field.system && field.archived) &&
      [field.label, field.key, typeLabel(field)].some((text) =>
        text.toLowerCase().includes(wanted),
      ),
  );
}

/** The preview's title for the screen's action. */
export function previewTitle(body: KindSchemaBody, action: ScreenAction) {
  return action === "create"
    ? `New ${body.singular.toLowerCase()}`
    : action === "edit"
      ? `Edit ${body.singular.toLowerCase()}`
      : action === "view"
        ? body.singular
        : `${body.singular} transition`;
}

/** Admin > Screens: the screen designer of each record kind, saved to its draft and published. */
export function ScreensTab({ access }: { access: MeAccess }) {
  const { kinds, error, save, publish } = useKindSchemas();
  return (
    <ScreensPanel
      kinds={kinds}
      error={error}
      access={access}
      onSave={save}
      onPublish={publish}
    />
  );
}

export function ScreensPanel({
  kinds,
  error,
  access,
  initial = { kind: "candidate", type: DEFAULT_TYPE, action: "create" },
  onSave = async () => {},
  onPublish = async () => 0,
}: {
  kinds: KindSchemaState[] | null;
  error: string;
  /** The caller's access: company owner or not, and their own field rules for the preview. */
  access: MeAccess;
  /** The screen shown first. */
  initial?: { kind: ConfigurableKind } & Choice;
  onSave?: (state: KindSchemaState, body: KindSchemaBody) => Promise<void>;
  onPublish?: (state: KindSchemaState, body: KindSchemaBody) => Promise<number>;
}) {
  const owner = access.companyLevel === "owner";
  const [kind, setKind] = useState<ConfigurableKind>(initial.kind);
  const [choice, setChoice] = useState<Choice>({
    type: initial.type,
    action: initial.action,
  });
  // The kind's whole body as the designer changed it; null while it equals the loaded body.
  const [working, setWorking] = useState<KindSchemaBody | null>(null);
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [publishing, setPublishing] = useState(false);
  const {
    busy,
    refusal,
    setRefusal,
    notice,
    setNotice,
    noticeRef,
    focusNotice,
    save,
    publish,
    dialog,
  } = useDraftChanges({ owner, onSave, onPublish });
  const { confirm, dialog: confirmDialog } = useConfirm();
  // Focus after an edit: the pressed control, else the other control named, when it is enabled.
  const controls = useRef(new Map<string, HTMLElement>());
  const [focus, setFocus] = useState<{ id: string; other?: string } | null>(
    null,
  );
  useEffect(() => {
    if (!focus) return;
    const usable = (id?: string) => {
      const element = id ? controls.current.get(id) : undefined;
      return element && !(element as HTMLButtonElement).disabled
        ? element
        : undefined;
    };
    (usable(focus.id) ?? usable(focus.other))?.focus();
  }, [focus]);
  const control = (id: string) => (element: HTMLElement | null) => {
    if (element) controls.current.set(id, element);
    else controls.current.delete(id);
  };

  const views = (kinds ?? []).map(kindView);
  const view = views.find((item) => item.state.kind === kind);
  const body = working ?? view?.body;
  const unsaved = !!view && !!working && !unchanged(view.body, working);

  async function chooseKind(next: ConfigurableKind) {
    if (
      unsaved &&
      !(await confirm({
        title: `Discard your unsaved changes to ${view!.body.singular} screens?`,
        message:
          "They are not saved to the draft, and choosing another record kind discards them.",
        confirmLabel: "Discard changes",
      }))
    )
      return;
    setWorking(null);
    setKind(next);
    setChoice({ type: DEFAULT_TYPE, action: "create" });
    setRefusal([]);
    setNotice("");
    setAnnouncement("");
  }

  return (
    <section className="panel stack">
      <h2>Screens</h2>
      <p className="muted">
        The create, edit and view screens of every record kind: their sections,
        field order and required, read-only and hidden fields. Changes are kept
        here until you save them to the kind&apos;s draft, and take effect when
        you publish it: saving and validation use the published screens at once,
        while forms in the app still show the built-in screens.
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
      {!publishing && refusal.length > 0 && <Refusal issues={refusal} />}
      {error ? (
        <p className="notice error" role="alert">
          Could not load the screens. {error}
        </p>
      ) : !kinds || !view || !body ? (
        <p role="status">Loading screens…</p>
      ) : (
        (() => {
          const screen = chosenScreen(body, choice);
          const key = screenKey(screen);
          const type = screen.type ?? DEFAULT_TYPE;
          const fields = new Map(
            body.fields.map((field) => [field.key, field]),
          );
          const labelOf = (fieldKey: string) =>
            fields.get(fieldKey)?.label ?? fieldKey;
          /** Applies an edit to the working copy and says what it did. */
          const change = (
            next: KindSchemaBody,
            say: (screen: Screen) => string,
          ) => {
            setWorking(next);
            setNotice("");
            setAnnouncement(say(chosenScreen(next, choice)));
          };
          const moveField = (fieldKey: string, step: -1 | 1) => {
            change(moveEntry(body, key, fieldKey, step), (next) =>
              movedText(next, labelOf(fieldKey), fieldKey),
            );
            setFocus({
              id: `entry:${fieldKey}:${step}`,
              other: `entry:${fieldKey}:${-step}`,
            });
          };
          const moveGroup = (group: number, to: number) => {
            change(moveSection(body, key, group, to), (next) =>
              sectionMovedText(next, to),
            );
            const step = to < group ? -1 : 1;
            setFocus({
              id: `section:${to}:${step}`,
              other: `section:${to}:${-step}`,
            });
          };
          const add = (fieldKey: string, to?: Place) =>
            change(addEntry(body, key, fieldKey, to), (next) =>
              addedText(next, labelOf(fieldKey), fieldKey),
            );
          async function removeGroup(group: number) {
            const section = screen.groups[group];
            const count = section.fields.length;
            if (
              count &&
              !(await confirm({
                title: "Remove this section?",
                message: `Remove ${section.label ?? UNNAMED_SECTION}? Its ${count === 1 ? "1 field comes" : `${count} fields come`} off this screen. The fields and their stored values are kept.`,
                confirmLabel: "Remove section",
              }))
            )
              return;
            change(
              removeSection(body!, key, group),
              () => `${sectionTitle(section)} removed.`,
            );
            setFocus({ id: "add-section" });
          }
          /** A drop at a place of a section: an entry moves there, a picked field is added there. */
          function drop(event: DragEvent, place: Place) {
            const entry = event.dataTransfer.getData(ENTRY);
            const picked = event.dataTransfer.getData(PICKED);
            if (!entry && !picked) return false;
            event.preventDefault();
            event.stopPropagation();
            if (entry)
              change(moveEntryTo(body!, key, entry, place), (next) =>
                movedText(next, labelOf(entry), entry),
              );
            else add(picked, place);
            return true;
          }
          async function saveDraft() {
            const issues = working!.screens.flatMap((item) =>
              designerRefusal(working!, screenKey(item)),
            );
            setRefusal(issues);
            if (issues.length) return;
            if (await save(view!, working!)) {
              setWorking(null);
              setAnnouncement("");
              // Save draft is disabled now; the saved notice takes focus.
              focusNotice();
            }
          }
          return (
            <>
              <div className="row" style={{ ...actionRow, alignItems: "end" }}>
                <label className="field">
                  <span>Record kind</span>
                  <select
                    value={kind}
                    disabled={busy}
                    onChange={(e) =>
                      void chooseKind(e.target.value as ConfigurableKind)
                    }
                  >
                    {views.map((item) => (
                      <option key={item.state.kind} value={item.state.kind}>
                        {item.body.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Record type</span>
                  <select
                    value={type}
                    onChange={(e) => {
                      const actions = screenActions(body, e.target.value);
                      setChoice({
                        type: e.target.value,
                        action: actions.includes(choice.action)
                          ? choice.action
                          : actions[0],
                      });
                    }}
                  >
                    {screenTypes(body).map((item) => (
                      <option key={item} value={item}>
                        {item === DEFAULT_TYPE ? "Default" : `Type ${item}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Action</span>
                  <select
                    value={screen.action}
                    onChange={(e) =>
                      setChoice({
                        type,
                        action: e.target.value as ScreenAction,
                      })
                    }
                  >
                    {screenActions(body, type).map((action) => (
                      <option key={action} value={action}>
                        {ACTION_LABELS[action]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {view.state.draft && (
                <DraftState
                  view={view}
                  owner={owner}
                  busy={busy}
                  unsaved={unsaved}
                  onPublish={() => {
                    setRefusal([]);
                    setPublishing(true);
                  }}
                />
              )}
              <RequiredOffCreateList body={body} />
              <div className="row" style={actionRow}>
                <button
                  type="button"
                  className="button"
                  disabled={busy || !unsaved}
                  onClick={() => void saveDraft()}
                >
                  Save draft
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || !unsaved}
                  onClick={() => {
                    setWorking(null);
                    setRefusal([]);
                    setAnnouncement("Changes discarded.");
                    setFocus({ id: "screen-heading" });
                  }}
                >
                  Discard changes
                </button>
                {unsaved && <span className="muted">Unsaved changes.</span>}
              </div>
              <p className="sr-only" aria-live="polite">
                {announcement}
              </p>
              <div className="screen-designer-wrap">
                <div className="screen-designer">
                  <FieldPicker
                    body={body}
                    screen={screen}
                    query={query}
                    searchRef={control("picker:search")}
                    onQuery={setQuery}
                    onAdd={(fieldKey) => {
                      add(fieldKey);
                      setFocus({ id: "picker:search" });
                    }}
                  />
                  <section className="stack screen-canvas">
                    <h3 ref={control("screen-heading")} tabIndex={-1}>
                      {screenLabel(screen)}
                    </h3>
                    <ol className="screen-sections">
                      {screen.groups.map((group, index) => (
                        <SectionCard
                          key={index}
                          body={body}
                          screen={screen}
                          group={group}
                          index={index}
                          control={control}
                          onDragOver={(event) => {
                            const types = event.dataTransfer.types;
                            if (
                              types.includes(ENTRY) ||
                              types.includes(PICKED) ||
                              types.includes(SECTION)
                            )
                              event.preventDefault();
                          }}
                          onDrop={(event, place) => {
                            if (drop(event, place)) return;
                            const from = event.dataTransfer.getData(SECTION);
                            if (from === "") return;
                            event.preventDefault();
                            event.stopPropagation();
                            if (Number(from) !== index)
                              change(
                                moveSection(body, key, Number(from), index),
                                (next) => sectionMovedText(next, index),
                              );
                          }}
                          onRename={(label) =>
                            setWorking(renameSection(body, key, index, label))
                          }
                          onMove={(step) => moveGroup(index, index + step)}
                          onRemove={() => void removeGroup(index)}
                          onMoveEntry={moveField}
                          onRule={(fieldKey, rule) =>
                            change(
                              setEntryRule(body, key, fieldKey, rule),
                              () => ruleText(labelOf(fieldKey), rule),
                            )
                          }
                          onRemoveEntry={(fieldKey) => {
                            change(removeEntry(body, key, fieldKey), () =>
                              removedText(labelOf(fieldKey)),
                            );
                            setFocus({ id: `section:${index}:name` });
                          }}
                        />
                      ))}
                    </ol>
                    <div>
                      <button
                        ref={control("add-section")}
                        type="button"
                        className="button secondary small"
                        disabled={screen.groups.length >= SECTIONS_MAX}
                        onClick={() => {
                          change(
                            addSection(body, key),
                            () => "New section added.",
                          );
                          setFocus({
                            id: `section:${screen.groups.length}:name`,
                          });
                        }}
                      >
                        Add section
                      </button>
                    </div>
                  </section>
                  <ScreenPreview body={body} screen={screen} access={access} />
                </div>
              </div>
            </>
          );
        })()
      )}
      {publishing && view && (
        <PublishDialog
          view={view}
          busy={busy}
          refusal={refusal}
          onCancel={() => {
            setPublishing(false);
            setRefusal([]);
          }}
          onPublish={() => void publish(view, () => setPublishing(false))}
        />
      )}
      {dialog}
      {confirmDialog}
    </section>
  );
}

/** Search to add: the fields not on the screen, each with its key and type, to add or drag. */
export function FieldPicker({
  body,
  screen,
  query,
  searchRef,
  onQuery,
  onAdd,
}: {
  body: KindSchemaBody;
  screen: Screen;
  query: string;
  searchRef: (element: HTMLElement | null) => void;
  onQuery: (query: string) => void;
  onAdd: (fieldKey: string) => void;
}) {
  const id = useId();
  const found = pickerFields(body, screen, query);
  return (
    <section className="stack screen-picker" aria-labelledby={id}>
      <h3 id={id}>Fields</h3>
      <label className="field">
        <span>Search fields</span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </label>
      {found.length ? (
        <ul className="screen-picker-list">
          {found.map((field) => (
            <li
              key={field.key}
              draggable
              onDragStart={(e) => e.dataTransfer.setData(PICKED, field.key)}
            >
              <span className="screen-entry-name">
                {field.label}
                <small className="muted">
                  <code>{field.key}</code> · {typeLabel(field)}
                </small>
              </span>
              <button
                type="button"
                className="button secondary small"
                aria-label={`Add ${field.label}`}
                onClick={() => onAdd(field.key)}
              >
                Add
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No field matches.</p>
      )}
      <p className="muted">
        Add a field to the last section, or drag it into a section.
      </p>
    </section>
  );
}

/** One section: its name, moves and remove, its field rows, and a place to drop a field. */
function SectionCard({
  body,
  screen,
  group,
  index,
  control,
  onDragOver,
  onDrop,
  onRename,
  onMove,
  onRemove,
  onMoveEntry,
  onRule,
  onRemoveEntry,
}: {
  body: KindSchemaBody;
  screen: Screen;
  group: ScreenGroup;
  index: number;
  control: (id: string) => (element: HTMLElement | null) => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent, place: Place) => void;
  onRename: (label: string) => void;
  onMove: (step: -1 | 1) => void;
  onRemove: () => void;
  onMoveEntry: (fieldKey: string, step: -1 | 1) => void;
  onRule: (fieldKey: string, rule: Rule) => void;
  onRemoveEntry: (fieldKey: string) => void;
}) {
  const title = sectionTitle(group);
  const fields = new Map(body.fields.map((field) => [field.key, field]));
  return (
    <li
      className="screen-section"
      onDragOver={onDragOver}
      onDrop={(event) =>
        onDrop(event, { group: index, index: group.fields.length })
      }
    >
      <div className="screen-section-head">
        <span
          className="screen-grip"
          draggable
          aria-hidden="true"
          title="Drag to move this section"
          onDragStart={(e) => e.dataTransfer.setData(SECTION, String(index))}
        >
          ⋮⋮
        </span>
        <label className="field">
          <span>Section name</span>
          <input
            ref={control(`section:${index}:name`)}
            value={group.label ?? ""}
            maxLength={120}
            placeholder={UNNAMED_SECTION}
            onChange={(e) => onRename(e.target.value)}
          />
        </label>
        <div className="row screen-actions">
          <button
            ref={control(`section:${index}:-1`)}
            type="button"
            className="icon-button"
            disabled={index === 0}
            aria-label={`Move ${title} up`}
            title={`Move ${title} up`}
            onClick={() => onMove(-1)}
          >
            <ArrowUp size={17} aria-hidden="true" />
          </button>
          <button
            ref={control(`section:${index}:1`)}
            type="button"
            className="icon-button"
            disabled={index === screen.groups.length - 1}
            aria-label={`Move ${title} down`}
            title={`Move ${title} down`}
            onClick={() => onMove(1)}
          >
            <ArrowDown size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={screen.groups.length === 1}
            aria-label={`Remove ${title}`}
            onClick={onRemove}
          >
            Remove
          </button>
        </div>
      </div>
      {group.fields.length ? (
        <ol className="screen-entries">
          {group.fields.map((entry, position) => {
            const field = fields.get(entry.key);
            return field ? (
              <EntryRow
                key={entry.key}
                field={field}
                body={body}
                screen={screen}
                entry={entry}
                control={control}
                onDrop={(event) =>
                  onDrop(event, { group: index, index: position })
                }
                onMove={(step) => onMoveEntry(entry.key, step)}
                onRule={(rule) => onRule(entry.key, rule)}
                onRemove={() => onRemoveEntry(entry.key)}
              />
            ) : null;
          })}
        </ol>
      ) : (
        <p className="screen-drop">
          Drag a field here, or add one from the field list.
        </p>
      )}
    </li>
  );
}

/** One field of a section: its name, key and type, its rule, and its moves and remove. */
function EntryRow({
  field,
  body,
  screen,
  entry,
  control,
  onDrop,
  onMove,
  onRule,
  onRemove,
}: {
  field: Field;
  body: KindSchemaBody;
  screen: Screen;
  entry: ScreenEntry;
  control: (id: string) => (element: HTMLElement | null) => void;
  onDrop: (event: DragEvent) => void;
  onMove: (step: -1 | 1) => void;
  onRule: (rule: Rule) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const checked = entryRule(field, entry);
  const limits = ruleLimits(field, screen);
  return (
    <li
      className="screen-entry"
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.setData(ENTRY, entry.key);
      }}
      onDrop={onDrop}
    >
      <span className="screen-entry-name">
        <span className="row" style={{ ...actionRow, gap: 6 }}>
          {field.label}
          <FieldBadges body={body} field={field} />
        </span>
        <small className="muted">
          <code>{field.key}</code> · {typeLabel(field)}
        </small>
      </span>
      <span className="screen-entry-rule">
        <span
          role="radiogroup"
          aria-label={`${field.label} rule`}
          aria-describedby={limits.reasons.length ? `${id}-reason` : undefined}
          className="screen-rule"
        >
          {RULES.map((rule) => (
            <label key={rule}>
              <input
                type="radio"
                name={`${id}-rule`}
                value={rule}
                checked={checked === rule}
                disabled={limits.disabled.includes(rule)}
                onChange={() => onRule(rule)}
              />
              {RULE_LABELS[rule]}
            </label>
          ))}
        </span>
        {limits.reasons.length > 0 && (
          <small id={`${id}-reason`} className="muted">
            {limits.reasons.join(" ")}
          </small>
        )}
      </span>
      <span className="row screen-actions">
        <button
          ref={control(`entry:${entry.key}:-1`)}
          type="button"
          className="icon-button"
          disabled={!canMoveEntry(screen, entry.key, -1)}
          aria-label={`Move ${field.label} up`}
          title={`Move ${field.label} up`}
          onClick={() => onMove(-1)}
        >
          <ArrowUp size={17} aria-hidden="true" />
        </button>
        <button
          ref={control(`entry:${entry.key}:1`)}
          type="button"
          className="icon-button"
          disabled={!canMoveEntry(screen, entry.key, 1)}
          aria-label={`Move ${field.label} down`}
          title={`Move ${field.label} down`}
          onClick={() => onMove(1)}
        >
          <ArrowDown size={17} aria-hidden="true" />
        </button>
        {limits.removable && (
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${field.label}`}
            title={`Remove ${field.label}`}
            onClick={onRemove}
          >
            <X size={17} aria-hidden="true" />
          </button>
        )}
      </span>
    </li>
  );
}

type FieldRule = "hidden" | "read" | "edit";
/** One preview control: empty and disabled, by the field's type; never a value or a default. */
function PreviewControl({ field, id }: { field: Field; id: string }) {
  const props = { id, disabled: true };
  const options = field.system
    ? (field.options ?? [])
    : "options" in field
      ? field.options
          .filter((option) => !option.disabled)
          .map((option) => option.label)
      : [];
  const kind = field.system
    ? field.type
    : (
        {
          "short-text": "text",
          "long-text": "textarea",
          "rich-text": "textarea",
          number: "number",
          money: "number",
          percentage: "number",
          date: "date",
          "date-time": "datetime-local",
          dropdown: "select",
          "multi-select": "multiple",
          checkbox: "checkbox",
          person: "reference",
          "org-unit": "reference",
          url: "text",
          email: "text",
          phone: "text",
          file: "reference",
          lookup: "reference",
        } as const
      )[field.type];
  if (kind === "textarea" || kind === "json")
    return <textarea {...props} rows={2} />;
  if (kind === "select" || kind === "multiple")
    return (
      <select {...props} multiple={kind === "multiple"}>
        {kind === "select" && <option value="">Choose an option</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  if (kind === "checkbox") return <input {...props} type="checkbox" />;
  return (
    <input
      {...props}
      type={
        kind === "number" || kind === "date" || kind === "datetime-local"
          ? kind
          : "text"
      }
      placeholder={kind === "reference" ? typeLabel(field) : undefined}
    />
  );
}

/**
 * The chosen screen as its form will render, under the editing person's own field rules: a field
 * their role hides is named only as "A field hidden from you". Hidden entries, archived fields and
 * fields of other record types are left out; it shows no record value or default and sends nothing.
 */
export function ScreenPreview({
  body,
  screen,
  access,
}: {
  body: KindSchemaBody;
  screen: Screen;
  access: MeAccess;
}) {
  const id = useId();
  const rules = access.fields[body.kind];
  // A kind the caller cannot view counts as hidden, and so does a key it does not name.
  const ruleOf = (field: Field): FieldRule =>
    (rules &&
      (field.system
        ? rules[field.key]
        : (rules[field.key] ?? rules.customValues))) ??
    "hidden";
  const fields = new Map(body.fields.map((field) => [field.key, field]));
  const mandatory = new Set(mandatoryKeys(body, screen));
  const readOnly = new Set(readOnlyKeys(screen));
  const leftOut: string[] = [];
  const sections = shownGroups(screen).map((group) => ({
    label: group.label,
    items: group.fields.flatMap(({ key }) => {
      const field = fields.get(key);
      if (!field || (!field.system && field.archived)) return [];
      const rule = ruleOf(field);
      if (
        !field.system &&
        field.types &&
        !(screen.type && field.types.includes(screen.type))
      ) {
        leftOut.push(rule === "hidden" ? HIDDEN_FROM_YOU : field.label);
        return [];
      }
      return [
        {
          field,
          hidden: rule === "hidden",
          required: mandatory.has(key),
          readOnly:
            readOnly.has(key) ||
            (field.system && field.readOnly) ||
            rule === "read",
        },
      ];
    }),
  }));
  let count = 0;
  return (
    <section className="stack screen-preview" aria-labelledby={id}>
      <h3 id={id}>Preview</h3>
      <div className="screen-preview-frame stack">
        <p>
          <strong>{previewTitle(body, screen.action)}</strong>
        </p>
        {sections.map((section, index) =>
          section.items.length ? (
            <div key={index} className="stack">
              {section.label && <h4>{section.label}</h4>}
              {section.items.map((item) => {
                const control = `${id}-${count++}`;
                if (item.hidden)
                  return (
                    <p key={control} className="muted">
                      {HIDDEN_FROM_YOU}
                    </p>
                  );
                const label = (
                  <>
                    {item.field.label}
                    {item.required && <span aria-label="required"> *</span>}
                    {item.readOnly && (
                      <span className="muted"> (read only)</span>
                    )}
                  </>
                );
                return screen.action === "view" ? (
                  <dl key={control} className="field">
                    <dt>{label}</dt>
                    <dd>—</dd>
                  </dl>
                ) : (
                  <div key={control} className="field">
                    <label htmlFor={control}>{label}</label>
                    <PreviewControl field={item.field} id={control} />
                    {item.field.help && <small>{item.field.help}</small>}
                  </div>
                );
              })}
            </div>
          ) : null,
        )}
        {sections.every((section) => !section.items.length) && (
          <p className="muted">This screen shows no fields.</p>
        )}
      </div>
      {leftOut.length > 0 && (
        <p className="muted">
          Left out because it applies only to other record types:{" "}
          {leftOut.join(", ")}
        </p>
      )}
    </section>
  );
}
