"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ConfigObject } from "@/lib/config-store";
import {
  configKey,
  taskBoardBodySchema,
  type TaskBoardBody,
} from "@/domain/config";
import {
  RESOURCE_CONFIG,
  TASK_LINK_KINDS,
  kindToResource,
  type RecordDto,
  type RecordKind,
} from "@/domain/records";
import {
  ClientError,
  humanError,
  requestJson,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";
import { ReferencePicker } from "@/components/workspace/editor";
import { dataOf, recordLabel } from "@/components/workspace/helpers";
import { BUCKETS_PATH } from "@/components/workspace/tab-requests";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { roleKeyFor } from "./roles-tab";

const BOARDS_PATH = "/api/v1/task-boards?drafts=true";
const TASK_FIELDS_PATH =
  "/api/v1/task-fields?pageSize=100&sort=position&direction=asc";
/** The linked record a saved draft already names, whose kind the body does not hold. */
const CURRENT_LINK = "current";
const box = {
  border: "1px solid var(--border, #e2e4eb)",
  borderRadius: 10,
  padding: 16,
  minWidth: 0,
} as const;
// Row actions never break inside a word; a narrow table scrolls inside its .table-wrap.
const actionRow = { flexWrap: "wrap", overflowWrap: "normal" } as const;

/** Each refusal of the task-board routes in plain words; anything else keeps the API's message. */
export function taskBoardRefusal(error: unknown): string {
  if (!(error instanceof ClientError)) return humanError(error);
  switch (error.code) {
    case "invalid_reference":
      return "A bucket, vacancy, linked record or task field this board names is not an active record of this team that you can see, or the value is not one of the field's options. Choose it again.";
    case "archived_reference":
      return "A bucket or record this board names has been archived. Choose an active one.";
    case "config_draft_exists":
      return "This board already has a draft. Edit that draft instead.";
    case "config_state_conflict":
      return "This board was published or retired meanwhile, or a retired board used this name. Reload the page, or choose another name.";
    case "invalid_input":
      return `This board cannot be saved as it is: ${error.message}`;
    default:
      return error.message;
  }
}

/** The team's active dropdown task fields, with their options. */
function dropdownFields(fields: RecordDto[]) {
  return fields
    .filter((field) => dataOf(field).type === "Dropdown")
    .map((field) => ({
      id: field.id,
      name: recordLabel(field),
      options: (dataOf(field).options as string[]) ?? [],
    }));
}

/** A board's filter in plain words, from the team's active task fields. */
export function filterText(
  filter: TaskBoardBody["filter"],
  fields: RecordDto[],
): string {
  if (!filter) return "No filter: every task in these buckets.";
  if (filter.by === "vacancy") return "Tasks of one chosen vacancy.";
  if (filter.by === "linked-record")
    return "Tasks linked to one chosen record.";
  const field = fields.find((item) => item.id === filter.fieldId);
  return `Tasks whose ${field ? recordLabel(field) : "task field (no longer active)"} is ${filter.value}.`;
}

/** A column's bucket name among the active buckets; a bucket no longer active says so. */
function bucketName(id: string, buckets: RecordDto[]) {
  const bucket = buckets.find((item) => item.id === id);
  return bucket ? recordLabel(bucket) : "A bucket that is no longer active";
}

type Open = {
  /** Null for a new board, whose key comes from its name. */
  versionId: string | null;
  boardKey: string | null;
  body: TaskBoardBody | null;
};

/** The Task boards tab: the built-in All buckets board and this team's own boards. */
export function TaskBoardsTab() {
  const { team } = useWorkspace();
  const teamId = team?.id ?? null;
  const boards = useApi<{ data: ConfigObject[] }>(teamId ? BOARDS_PATH : null);
  const buckets = useApi<{ data: RecordDto[] }>(teamId ? BUCKETS_PATH : null);
  const fields = useApi<{ data: RecordDto[] }>(
    teamId ? TASK_FIELDS_PATH : null,
  );
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [notice, setNotice] = useState("");
  // The control that had focus is gone after a save, publish or retire: the notice takes it, and
  // the heading takes it when the form is cancelled.
  const heading = useRef<HTMLHeadingElement>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);
  const { confirm, dialog } = useConfirm();
  async function run<T>(
    work: () => Promise<T>,
    onError: (message: string) => void,
  ): Promise<T | undefined> {
    if (busy || !teamId) return;
    setBusy(true);
    setFormError("");
    setRowError(null);
    setNotice("");
    try {
      return await work();
    } catch (e) {
      onError(taskBoardRefusal(e));
    } finally {
      setBusy(false);
    }
  }
  async function save(boardKey: string | null, body: TaskBoardBody) {
    const key = boardKey ?? roleKeyFor(body.name);
    if (!boardKey) {
      if (!configKey.safeParse(key).success) {
        setFormError("Use at least one letter or number in the board name.");
        return;
      }
      if (boards.data?.data.some((board) => board.key === key)) {
        setFormError(
          "A task board with this name already exists. Choose another name.",
        );
        return;
      }
    }
    const saved = await run(
      () =>
        open?.versionId
          ? requestJson(teamId, `/api/v1/task-boards/${open.versionId}`, {
              method: "PUT",
              body: JSON.stringify({ body }),
            })
          : requestJson(teamId, "/api/v1/task-boards", {
              method: "POST",
              body: JSON.stringify({ key, body }),
            }),
      setFormError,
    );
    if (saved) {
      setOpen(null);
      setNotice(
        `Draft of ${body.name} saved. Publish it to show it on the Tasks screen.`,
      );
    }
  }
  async function newDraft(board: ConfigObject) {
    const body = board.current?.body as TaskBoardBody | undefined;
    if (!body) return;
    const created = await run(
      () =>
        requestJson<{ data: { versionId: string } }>(
          teamId,
          "/api/v1/task-boards",
          {
            method: "POST",
            body: JSON.stringify({ key: board.key, body }),
          },
        ),
      (message) => setRowError({ id: board.id, message }),
    );
    if (created)
      setOpen({ versionId: created.data.versionId, boardKey: board.key, body });
  }
  async function publish(board: ConfigObject, name: string) {
    if (!board.draft) return;
    const versionId = board.draft.id;
    const published = await run(
      () =>
        requestJson<{ data: { number: number } }>(
          teamId,
          `/api/v1/task-boards/${versionId}/publish`,
          { method: "POST" },
        ),
      (message) => setRowError({ id: board.id, message }),
    );
    if (published) {
      if (open?.versionId === versionId) setOpen(null);
      setNotice(
        `${name} is published as version ${published.data.number} and shows on the Tasks screen.`,
      );
    }
  }
  async function retire(board: ConfigObject, name: string) {
    if (
      !(await confirm({
        title: "Retire this board?",
        message: `Retire ${name}? It leaves the Tasks screen for everyone in this team and cannot be published again. Tasks and buckets are not changed.`,
        confirmLabel: "Retire board",
        destructive: true,
      }))
    )
      return;
    const retired = await run(
      () =>
        requestJson(teamId, `/api/v1/task-boards/${board.id}`, {
          method: "DELETE",
        }),
      (message) => setRowError({ id: board.id, message }),
    );
    if (retired) {
      if (open && open.boardKey === board.key) setOpen(null);
      setNotice(`${name} is retired.`);
    }
  }
  return (
    <section className="panel stack">
      <h2 ref={heading} tabIndex={-1}>
        Task boards
      </h2>
      <p className="muted">
        A task board shows some of this team&apos;s buckets as its columns, in
        the order you choose, with an optional filter. Members choose a board in
        Task board on the Tasks screen. Boards change no task, bucket or task
        field, and a bucket marked Counts as completed keeps its effect on
        overdue tasks and reminders on every board.
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
      <TaskBoardsList
        boards={boards.data?.data ?? null}
        buckets={buckets.data?.data ?? []}
        fields={fields.data?.data ?? []}
        error={boards.error}
        busy={busy}
        rowError={rowError}
        onCreate={() => {
          setFormError("");
          setOpen({ versionId: null, boardKey: null, body: null });
        }}
        onEdit={(board) =>
          board.draft &&
          setOpen({
            versionId: board.draft.id,
            boardKey: board.key,
            body: board.draft.body as TaskBoardBody,
          })
        }
        onNewDraft={(board) => void newDraft(board)}
        onPublish={(board, name) => void publish(board, name)}
        onRetire={(board, name) => void retire(board, name)}
      />
      {open && (
        <TaskBoardForm
          key={open.versionId ?? "new"}
          boardKey={open.boardKey}
          initial={open.body}
          buckets={buckets.data?.data ?? null}
          fields={fields.data?.data ?? []}
          busy={busy}
          error={formError}
          onSave={(body) => void save(open.boardKey, body)}
          onCancel={() => {
            heading.current?.focus();
            setOpen(null);
          }}
        />
      )}
      {dialog}
    </section>
  );
}

/** The built-in All buckets board as text, and the team's boards with their states and actions. */
export function TaskBoardsList({
  boards,
  buckets,
  fields,
  error,
  busy,
  rowError,
  onCreate,
  onEdit,
  onNewDraft,
  onPublish,
  onRetire,
}: {
  boards: ConfigObject[] | null;
  buckets: RecordDto[];
  fields: RecordDto[];
  error: string;
  busy: boolean;
  rowError: { id: string; message: string } | null;
  onCreate: () => void;
  onEdit: (board: ConfigObject) => void;
  onNewDraft: (board: ConfigObject) => void;
  onPublish: (board: ConfigObject, name: string) => void;
  onRetire: (board: ConfigObject, name: string) => void;
}) {
  return (
    <>
      <h3>Built-in board</h3>
      <div style={box}>
        <p style={{ margin: 0 }}>
          <strong>All buckets</strong>
        </p>
        <p style={{ margin: "6px 0 0" }}>
          Every active bucket of this team, in position order, with no filter.
          It is the board the Tasks screen shows until a member chooses another.
          It cannot be changed or retired.
        </p>
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>This team&apos;s boards</h3>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={onCreate}
        >
          New board
        </button>
      </div>
      {error ? (
        <p className="notice error" role="alert">
          Could not load this team&apos;s task boards. {error}
        </p>
      ) : !boards ? (
        <p role="status">Loading task boards…</p>
      ) : !boards.length ? (
        <p className="muted">
          No task boards yet. Choose New board to make one.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">This team&apos;s task boards</caption>
            <thead>
              <tr>
                <th>Board</th>
                <th>State</th>
                <th>Columns</th>
                <th>Filter</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {boards.map((board) => {
                const { current, draft } = board;
                const shown = (current ?? draft)?.body as
                  TaskBoardBody | undefined;
                const name = String((draft ?? current)?.body.name ?? board.key);
                const refusal =
                  rowError?.id === board.id ? rowError.message : "";
                return (
                  <tr key={board.id}>
                    <td data-label="Board">
                      <strong>{name}</strong>
                      <br />
                      <span className="muted">{board.key}</span>
                    </td>
                    <td data-label="State">
                      {current
                        ? `Published (version ${current.number})${draft ? ", draft in progress" : ""}`
                        : "Draft"}
                    </td>
                    <td data-label="Columns">
                      {shown
                        ? shown.columns
                            .map((id) => bucketName(id, buckets))
                            .join(", ")
                        : ""}
                    </td>
                    <td data-label="Filter">
                      {shown ? filterText(shown.filter, fields) : ""}
                    </td>
                    <td data-label="Actions">
                      <div className="row" style={actionRow}>
                        {draft ? (
                          <>
                            <button
                              type="button"
                              className="button secondary"
                              disabled={busy}
                              onClick={() => onEdit(board)}
                            >
                              Edit draft
                            </button>
                            <button
                              type="button"
                              className="button secondary"
                              disabled={busy}
                              onClick={() => onPublish(board, name)}
                            >
                              Publish
                            </button>
                          </>
                        ) : (
                          current && (
                            <button
                              type="button"
                              className="button secondary"
                              disabled={busy}
                              onClick={() => onNewDraft(board)}
                            >
                              New draft
                            </button>
                          )
                        )}
                        <button
                          type="button"
                          className="button secondary"
                          disabled={busy}
                          onClick={() => onRetire(board, name)}
                        >
                          Retire board
                        </button>
                      </div>
                      {refusal && (
                        <p className="field-error" role="alert">
                          {refusal}
                        </p>
                      )}
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

type FilterChoice = "" | "vacancy" | "linked-record" | "field";

/**
 * Creates or edits a board draft: its name, the team's active buckets as ordered columns and one
 * optional filter. The strict schema runs before sending, and a refused body is never sent.
 */
export function TaskBoardForm({
  boardKey,
  initial,
  buckets,
  fields,
  busy,
  error,
  onSave,
  onCancel,
}: {
  boardKey: string | null;
  initial: TaskBoardBody | null;
  /** The team's active buckets in position order; null while they load. */
  buckets: RecordDto[] | null;
  fields: RecordDto[];
  busy: boolean;
  error: string;
  onSave: (body: TaskBoardBody) => void;
  onCancel: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const filter = initial?.filter;
  const [name, setName] = useState(initial?.name ?? "");
  const [columns, setColumns] = useState<string[]>(initial?.columns ?? []);
  const [by, setBy] = useState<FilterChoice>(filter?.by ?? "");
  const [vacancyId, setVacancyId] = useState(
    filter?.by === "vacancy" ? filter.vacancyId : "",
  );
  const [linkKind, setLinkKind] = useState(
    filter?.by === "linked-record" ? CURRENT_LINK : "",
  );
  const [recordId, setRecordId] = useState(
    filter?.by === "linked-record" ? filter.recordId : "",
  );
  const [fieldId, setFieldId] = useState(
    filter?.by === "field" ? filter.fieldId : "",
  );
  const [value, setValue] = useState(
    filter?.by === "field" ? filter.value : "",
  );
  const [issues, setIssues] = useState<string[]>([]);
  const dropdowns = dropdownFields(fields);
  const chosenField = dropdowns.find((field) => field.id === fieldId);
  const active = buckets ?? [];
  // Ticked columns first in board order, a bucket no longer active included, then the others.
  const rows = [
    ...columns.map((id) => ({ id, label: bucketName(id, active) })),
    ...active
      .filter((bucket) => !columns.includes(bucket.id))
      .map((bucket) => ({ id: bucket.id, label: recordLabel(bucket) })),
  ];
  // A moved column keeps focus on its button, or on its other one when it reaches an end.
  const moveButtons = useRef(new Map<string, HTMLButtonElement | null>());
  const [moved, setMoved] = useState<{ key: string } | null>(null);
  useEffect(() => {
    if (moved) moveButtons.current.get(moved.key)?.focus();
  }, [moved]);
  const move = (index: number, offset: number) => {
    const target = index + offset;
    const end =
      target === 0 ? "up" : target === columns.length - 1 ? "down" : "";
    const direction = offset < 0 ? "up" : "down";
    setMoved({
      key: `${columns[index]}:${end === direction ? (offset < 0 ? "down" : "up") : direction}`,
    });
    setColumns((list) => {
      const next = [...list];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const chosen =
      by === "vacancy"
        ? vacancyId && { by, vacancyId }
        : by === "linked-record"
          ? recordId && { by, recordId }
          : by === "field"
            ? fieldId && value && { by, fieldId, value }
            : undefined;
    const found: string[] = [];
    if (!name.trim()) found.push("Enter a name for the board.");
    if (!columns.length) found.push("Tick at least one bucket as a column.");
    if (by && !chosen)
      found.push(
        "Choose what the filter keeps, or set Filter tasks by to None.",
      );
    const body = {
      name: name.trim(),
      columns,
      ...(chosen ? { filter: chosen } : {}),
    };
    if (!found.length && !taskBoardBodySchema.safeParse(body).success)
      found.push(
        "This board cannot be saved: use a name of at most 120 characters and at most 100 columns.",
      );
    setIssues(found);
    if (!found.length) onSave(body as TaskBoardBody);
  }
  return (
    <form className="stack" style={box} onSubmit={submit} noValidate>
      <h3 ref={heading} tabIndex={-1}>
        {boardKey ? `Edit draft: ${initial?.name ?? boardKey}` : "New board"}
      </h3>
      {(issues.length > 0 || error) && (
        <div className="notice error" role="alert">
          {[...issues, ...(error ? [error] : [])].map((message) => (
            <p key={message} style={{ margin: 0 }}>
              {message}
            </p>
          ))}
        </div>
      )}
      <label className="field">
        <span>Board name</span>
        <input
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {!boardKey && (
          <small className="muted">
            1 to 120 characters. The board&apos;s key is made from its name.
          </small>
        )}
      </label>
      <fieldset style={box}>
        <legend>Columns</legend>
        <p className="muted" style={{ marginTop: 0 }}>
          Tick the buckets the board shows. Ticked buckets are columns in the
          order listed; move them up or down to change it.
        </p>
        {!buckets ? (
          <p role="status">Loading buckets…</p>
        ) : !rows.length ? (
          <p className="muted">
            This team has no active buckets. Add them with Customize workflow on
            the Tasks screen.
          </p>
        ) : (
          <ul
            className="stack"
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {rows.map((row) => {
              const index = columns.indexOf(row.id);
              return (
                <li key={row.id} className="row" style={{ gap: 8 }}>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={index >= 0}
                      onChange={(e) =>
                        setColumns((list) =>
                          e.target.checked
                            ? [...list, row.id]
                            : list.filter((id) => id !== row.id),
                        )
                      }
                    />
                    {row.label}
                  </label>
                  {index >= 0 && (
                    <>
                      <button
                        type="button"
                        className="button secondary small"
                        ref={(element) => {
                          moveButtons.current.set(`${row.id}:up`, element);
                        }}
                        aria-label={`Move ${row.label} up`}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        Move up
                      </button>
                      <button
                        type="button"
                        className="button secondary small"
                        ref={(element) => {
                          moveButtons.current.set(`${row.id}:down`, element);
                        }}
                        aria-label={`Move ${row.label} down`}
                        disabled={index === columns.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        Move down
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>
      <fieldset style={box} className="stack">
        <legend>Filter</legend>
        <div className="field">
          <label htmlFor="task-board-filter">Filter tasks by</label>
          <select
            id="task-board-filter"
            value={by}
            onChange={(e) => setBy(e.target.value as FilterChoice)}
          >
            <option value="">None</option>
            <option value="vacancy">Vacancy</option>
            <option value="linked-record">Linked record</option>
            <option value="field">Task field</option>
          </select>
        </div>
        {by === "vacancy" && (
          <div className="field">
            <ReferencePicker
              kind="vacancy"
              label="Vacancy"
              value={vacancyId}
              onChange={setVacancyId}
              id="task-board-vacancy"
            />
          </div>
        )}
        {by === "linked-record" && (
          <>
            <div className="field">
              <label htmlFor="task-board-link-kind">Linked record type</label>
              <select
                id="task-board-link-kind"
                value={linkKind}
                onChange={(e) => {
                  setLinkKind(e.target.value);
                  setRecordId("");
                }}
              >
                <option value="">Choose a type</option>
                {linkKind === CURRENT_LINK && (
                  <option value={CURRENT_LINK}>The saved linked record</option>
                )}
                {TASK_LINK_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {RESOURCE_CONFIG[kindToResource[kind]].singular}
                  </option>
                ))}
              </select>
            </div>
            {linkKind && linkKind !== CURRENT_LINK && (
              <div className="field">
                <ReferencePicker
                  kind={linkKind as RecordKind}
                  label="Linked record"
                  value={recordId}
                  onChange={setRecordId}
                  id="task-board-record"
                />
              </div>
            )}
          </>
        )}
        {by === "field" && (
          <>
            <div className="field">
              <label htmlFor="task-board-field">Task field</label>
              <select
                id="task-board-field"
                value={fieldId}
                onChange={(e) => {
                  setFieldId(e.target.value);
                  setValue("");
                }}
              >
                <option value="">Choose a dropdown field</option>
                {fieldId && !chosenField && (
                  <option value={fieldId}>
                    A task field that is no longer active
                  </option>
                )}
                {dropdowns.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.name}
                  </option>
                ))}
              </select>
              {!dropdowns.length && (
                <small className="muted">
                  This team has no active dropdown task fields.
                </small>
              )}
            </div>
            {fieldId && (
              <div className="field">
                <label htmlFor="task-board-value">Value</label>
                <select
                  id="task-board-value"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                >
                  <option value="">Choose a value</option>
                  {value && !chosenField?.options.includes(value) && (
                    <option value={value}>{value}</option>
                  )}
                  {chosenField?.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}
      </fieldset>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button type="submit" className="button" disabled={busy}>
          Save draft
        </button>
        <button type="button" className="button secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
