"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  ClientError,
  humanError,
  teamRequester,
  useWorkspace,
} from "@/components/workspace/client";
import type { Requester } from "@/components/workspace/optimistic";
import type { Employee, Position } from "@/lib/directory";
import type { OrgLevel, OrgUnit } from "@/lib/org";
import type { MeAccess } from "./admin-portal";
import { UnitPicker } from "./unit-picker";

export interface Page<T> {
  data: T[];
  pagination: { page: number; pageSize: number; hasMore: boolean };
}
export interface UnitList {
  units: OrgUnit[];
  page: number;
  hasMore: boolean;
}
export interface UnitContents {
  positions: Position[];
  positionsHasMore: boolean;
}
export interface Holders {
  rows: Employee[];
  page: number;
  hasMore: boolean;
}
/** The loaded part of the chart; nothing is loaded until its unit or position is opened. */
export interface ChartState {
  /** One chart level per parent unit id; "" is the top level. */
  lists: Record<string, UnitList>;
  contents: Record<string, UnitContents>;
  expanded: string[];
  holders: Record<string, Holders>;
  holdersOpen: string[];
  /** Load errors and refusals by `load:`, `list:`, `positions:`, `holders:`, `level:`, `unit:` or `position:` and an id. */
  errors: Record<string, string>;
  /** Keys of the requests in flight, in the same form. */
  busy: string[];
}
export type OrgForm =
  | { kind: "rename-level"; level: OrgLevel }
  | { kind: "add-unit"; parent: OrgUnit | null }
  | { kind: "rename-unit"; unit: OrgUnit }
  | { kind: "move-unit"; unit: OrgUnit }
  | { kind: "add-position"; unit: OrgUnit }
  | { kind: "edit-position"; position: Position }
  | { kind: "move-position"; position: Position };
export interface OrgValues {
  name: string;
  code: string;
  levelId: string;
  isManager: boolean;
  /** The chosen unit of a move; null is the top level. */
  target: OrgUnit | null;
}
export interface ChartHandlers {
  toggle: (unit: OrgUnit) => void;
  more: (listKey: string) => void;
  toggleHolders: (position: Position) => void;
  moreHolders: (position: Position) => void;
  open: (form: OrgForm) => void;
  archiveUnit: (unit: OrgUnit) => void;
  archivePosition: (position: Position) => void;
}

export const LEVELS_PATH = "/api/v1/org-units/levels";
export const CHART_PAGE_SIZE = 100;
const POSITIONS_PAGE_SIZE = 200;
const HOLDERS_PAGE_SIZE = 25;
const DEPTHS = [0, 1, 2, 3, 4, 5, 6, 7];
export const unitsPath = (parentId: string | null, page = 1) =>
  `/api/v1/org-units?${parentId ? `parentId=${parentId}&` : ""}page=${page}&pageSize=${CHART_PAGE_SIZE}`;
export const positionsPath = (unitId: string) =>
  `/api/v1/positions?unitId=${unitId}&page=1&pageSize=${POSITIONS_PAGE_SIZE}`;
export const holdersPath = (positionId: string, page = 1) =>
  `/api/v1/employees?positionId=${positionId}&page=${page}&pageSize=${HOLDERS_PAGE_SIZE}`;
/** Opening the tab: the levels and the first page of top-level units, nothing else. */
export const loadChart = (request: Requester) =>
  Promise.all([
    request<{ data: OrgLevel[] }>(LEVELS_PATH),
    request<Page<OrgUnit>>(unitsPath(null)),
  ]);
/** Expanding a unit: its current children and its positions, nothing else. */
export const loadUnit = (request: Requester, unitId: string) =>
  Promise.all([
    request<Page<OrgUnit>>(unitsPath(unitId)),
    request<Page<Position>>(positionsPath(unitId)),
  ]);
/** Show employees on a position: one page of the people who hold it. */
export const loadHolders = (request: Requester, positionId: string, page = 1) =>
  request<Page<Employee>>(holdersPath(positionId, page));
export const EMPTY_CHART: ChartState = {
  lists: {},
  contents: {},
  expanded: [],
  holders: {},
  holdersOpen: [],
  errors: {},
  busy: [],
};
const unitList = (page: Page<OrgUnit>): UnitList => ({
  units: page.data,
  page: page.pagination.page,
  hasMore: page.pagination.hasMore,
});
const without = (errors: Record<string, string>, key: string) => {
  const rest = { ...errors };
  delete rest[key];
  return rest;
};
/** Only the API's own message: humanError adds draft advice to a 409 that does not fit here. */
const plainError = (error: unknown) =>
  error instanceof ClientError ? error.message : humanError(error);
const send = (
  request: Requester,
  path: string,
  method: string,
  body: unknown,
) => request(path, { method, body: JSON.stringify(body) });
// Row actions never break inside a word.
const actionRow = { flexWrap: "wrap", overflowWrap: "normal", gap: 8 } as const;
const treeList = (nested: boolean) =>
  ({
    listStyle: "none",
    margin: nested ? "8px 0 0" : 0,
    padding: nested ? "0 0 0 14px" : 0,
    borderLeft: nested ? "1px solid var(--border)" : undefined,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  }) as const;
const plainList = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
} as const;

/**
 * The Organisation tab (R2a-16), for company owners and company admins with the organisation area:
 * levels, and an org chart that loads one level at a time. Moving and archiving units and moving
 * positions are offered to company owners only; the service and the database refuse them anyway.
 */
export function OrganisationTab({ access }: { access: MeAccess }) {
  const { team } = useWorkspace();
  const teamId = team?.id ?? null;
  const request = useMemo(
    () => (teamId ? teamRequester(teamId) : null),
    [teamId],
  );
  const owner = access.companyLevel === "owner";
  const directoryView = !!access.actions.directory?.includes("view");
  const [levels, setLevels] = useState<OrgLevel[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [chart, setChart] = useState<ChartState>(EMPTY_CHART);
  const [form, setForm] = useState<OrgForm | null>(null);
  const { confirm, dialog } = useConfirm();
  const patch = (change: (current: ChartState) => Partial<ChartState>) =>
    setChart((current) => ({ ...current, ...change(current) }));
  const setError = (key: string, message: string) =>
    patch((current) => ({
      errors: message
        ? { ...current.errors, [key]: message }
        : without(current.errors, key),
    }));
  const setBusy = (key: string, on: boolean) =>
    patch((current) => ({
      busy: on
        ? [...current.busy, key]
        : current.busy.filter((item) => item !== key),
    }));

  useEffect(() => {
    if (!request) return;
    let active = true;
    loadChart(request)
      .then(([found, top]) => {
        if (!active) return;
        setLevels(found.data);
        setChart((current) => ({
          ...current,
          lists: { ...current.lists, "": unitList(top) },
        }));
      })
      .catch((e) => {
        if (active) setLoadError(humanError(e));
      });
    return () => {
      active = false;
    };
  }, [request]);

  async function reloadLevels() {
    if (!request) return;
    setLevels((await request<{ data: OrgLevel[] }>(LEVELS_PATH)).data);
  }
  /** Reloads one chart level from its first page. */
  async function reloadList(key: string) {
    if (!request) return;
    try {
      const page = await request<Page<OrgUnit>>(unitsPath(key || null));
      patch((current) => ({
        lists: { ...current.lists, [key]: unitList(page) },
        errors: without(current.errors, `list:${key}`),
      }));
    } catch (e) {
      setError(`list:${key}`, humanError(e));
    }
  }
  async function reloadPositions(unitId: string) {
    if (!request) return;
    try {
      const page = await request<Page<Position>>(positionsPath(unitId));
      patch((current) => ({
        contents: {
          ...current.contents,
          [unitId]: {
            positions: page.data,
            positionsHasMore: page.pagination.hasMore,
          },
        },
        errors: without(current.errors, `positions:${unitId}`),
      }));
    } catch (e) {
      setError(`positions:${unitId}`, humanError(e));
    }
  }
  async function loadContents(unitId: string) {
    if (!request) return;
    setBusy(`load:${unitId}`, true);
    setError(`load:${unitId}`, "");
    try {
      const [children, positions] = await loadUnit(request, unitId);
      patch((current) => ({
        lists: { ...current.lists, [unitId]: unitList(children) },
        contents: {
          ...current.contents,
          [unitId]: {
            positions: positions.data,
            positionsHasMore: positions.pagination.hasMore,
          },
        },
      }));
    } catch (e) {
      setError(`load:${unitId}`, humanError(e));
    } finally {
      setBusy(`load:${unitId}`, false);
    }
  }
  const loaded = (unitId: string) =>
    !!chart.contents[unitId] || chart.busy.includes(`load:${unitId}`);

  const handlers: ChartHandlers = {
    toggle(unit) {
      const open = chart.expanded.includes(unit.id);
      patch((current) => ({
        expanded: open
          ? current.expanded.filter((id) => id !== unit.id)
          : [...current.expanded, unit.id],
      }));
      // Once per unit: collapsing and expanding again uses what was loaded.
      if (!open && !loaded(unit.id)) void loadContents(unit.id);
    },
    more(key) {
      const list = chart.lists[key];
      if (!request || !list || chart.busy.includes(`list:${key}`)) return;
      setBusy(`list:${key}`, true);
      request<Page<OrgUnit>>(unitsPath(key || null, list.page + 1))
        .then((page) =>
          patch((current) => ({
            lists: {
              ...current.lists,
              [key]: {
                units: [...current.lists[key].units, ...page.data],
                page: page.pagination.page,
                hasMore: page.pagination.hasMore,
              },
            },
            errors: without(current.errors, `list:${key}`),
          })),
        )
        .catch((e) => setError(`list:${key}`, humanError(e)))
        .finally(() => setBusy(`list:${key}`, false));
    },
    toggleHolders(position) {
      const open = chart.holdersOpen.includes(position.id);
      patch((current) => ({
        holdersOpen: open
          ? current.holdersOpen.filter((id) => id !== position.id)
          : [...current.holdersOpen, position.id],
      }));
      if (!open && !chart.holders[position.id]) handlers.moreHolders(position);
    },
    moreHolders(position) {
      const key = `holders:${position.id}`;
      if (!request || chart.busy.includes(key)) return;
      const next = (chart.holders[position.id]?.page ?? 0) + 1;
      setBusy(key, true);
      setError(key, "");
      loadHolders(request, position.id, next)
        .then((page) =>
          patch((current) => ({
            holders: {
              ...current.holders,
              [position.id]: {
                rows: [
                  ...(current.holders[position.id]?.rows ?? []),
                  ...page.data,
                ],
                page: page.pagination.page,
                hasMore: page.pagination.hasMore,
              },
            },
          })),
        )
        .catch((e) => setError(key, humanError(e)))
        .finally(() => setBusy(key, false));
    },
    open: setForm,
    archiveUnit(unit) {
      void archive(
        `unit:${unit.id}`,
        `/api/v1/org-units/${unit.id}`,
        {
          title: `Archive ${unit.name}?`,
          message:
            "The unit leaves the org chart. A unit with current units below it cannot be archived.",
        },
        () => reloadList(unit.parentId ?? ""),
      );
    },
    archivePosition(position) {
      void archive(
        `position:${position.id}`,
        `/api/v1/positions/${position.id}`,
        {
          title: `Archive the position ${position.title}?`,
          message:
            "The position leaves the org chart and ends for everyone who holds it.",
        },
        () => reloadPositions(position.orgUnitId),
      );
    },
  };

  async function archive(
    key: string,
    path: string,
    text: { title: string; message: string },
    reload: () => Promise<void>,
  ) {
    if (!request) return;
    if (
      !(await confirm({
        ...text,
        confirmLabel: "Archive",
        destructive: true,
      }))
    )
      return;
    setError(key, "");
    try {
      await send(request, path, "PATCH", { archived: true });
    } catch (e) {
      setError(key, plainError(e));
      return;
    }
    await reload();
  }
  async function archiveLevel(level: OrgLevel) {
    await archive(
      `level:${level.id}`,
      `/api/v1/org-units/levels/${level.id}`,
      {
        title: `Archive the level ${level.name}?`,
        message:
          "No new unit can use an archived level. A level that current units still use cannot be archived.",
      },
      () => reloadLevels().catch((e) => setLoadError(humanError(e))),
    );
  }
  async function addLevel(name: string, depth: number) {
    if (!request) return;
    await send(request, LEVELS_PATH, "POST", { name, depth });
    await reloadLevels();
  }

  /** Sends the open form; a refusal throws, so the dialog shows it. Only the changed lists reload. */
  async function submit(current: OrgForm, values: OrgValues) {
    if (!request) return;
    switch (current.kind) {
      case "rename-level":
        await send(
          request,
          `/api/v1/org-units/levels/${current.level.id}`,
          "PATCH",
          { name: values.name },
        );
        await reloadLevels();
        break;
      case "add-unit": {
        const parent = current.parent;
        await send(request, "/api/v1/org-units", "POST", {
          name: values.name,
          code: values.code,
          levelId: values.levelId,
          ...(parent ? { parentId: parent.id } : {}),
        });
        if (!parent) await reloadList("");
        else {
          patch((chartNow) => ({
            expanded: chartNow.expanded.includes(parent.id)
              ? chartNow.expanded
              : [...chartNow.expanded, parent.id],
          }));
          if (loaded(parent.id)) await reloadList(parent.id);
          else await loadContents(parent.id);
        }
        break;
      }
      case "rename-unit":
        await send(request, `/api/v1/org-units/${current.unit.id}`, "PATCH", {
          name: values.name,
        });
        await reloadList(current.unit.parentId ?? "");
        break;
      case "move-unit": {
        const to = values.target?.id ?? "";
        await send(request, `/api/v1/org-units/${current.unit.id}`, "PATCH", {
          parentId: values.target?.id ?? null,
        });
        await reloadList(current.unit.parentId ?? "");
        if (to !== (current.unit.parentId ?? "") && (!to || chart.lists[to]))
          await reloadList(to);
        break;
      }
      case "add-position":
        await send(request, "/api/v1/positions", "POST", {
          title: values.name,
          code: values.code,
          orgUnitId: current.unit.id,
          isManager: values.isManager,
        });
        await reloadPositions(current.unit.id);
        break;
      case "edit-position":
        await send(
          request,
          `/api/v1/positions/${current.position.id}`,
          "PATCH",
          { title: values.name, isManager: values.isManager },
        );
        await reloadPositions(current.position.orgUnitId);
        break;
      case "move-position": {
        const to = values.target!.id;
        await send(
          request,
          `/api/v1/positions/${current.position.id}`,
          "PATCH",
          { orgUnitId: to },
        );
        await reloadPositions(current.position.orgUnitId);
        if (to !== current.position.orgUnitId && chart.contents[to])
          await reloadPositions(to);
        break;
      }
    }
    setForm(null);
  }

  return (
    <>
      {loadError && (
        <p className="notice error" role="alert">
          Could not load the organisation. {loadError}
        </p>
      )}
      <LevelsPanel
        levels={levels}
        errors={chart.errors}
        onAdd={addLevel}
        onRename={(level) => setForm({ kind: "rename-level", level })}
        onArchive={(level) => void archiveLevel(level)}
      />
      <OrgChartPanel
        levels={levels ?? []}
        chart={chart}
        owner={owner}
        directoryView={directoryView}
        on={handlers}
      />
      {form && request && (
        <OrgFormDialog
          form={form}
          levels={levels ?? []}
          request={request}
          onSubmit={(values) => submit(form, values)}
          onClose={() => setForm(null)}
        />
      )}
      {dialog}
    </>
  );
}

/** Every level, top first; Add level offers only the depths no level uses. */
export function LevelsPanel({
  levels,
  errors,
  onAdd = async () => {},
  onRename = () => {},
  onArchive = () => {},
}: {
  levels: OrgLevel[] | null;
  errors: Record<string, string>;
  onAdd?: (name: string, depth: number) => Promise<void>;
  onRename?: (level: OrgLevel) => void;
  onArchive?: (level: OrgLevel) => void;
}) {
  return (
    <section className="panel stack">
      <h2>Levels</h2>
      <p className="muted">
        Levels name the layers of the organisation, top first, such as company,
        division and team. A unit sits on a level below its parent&apos;s.
      </p>
      {!levels ? (
        <p role="status">Loading levels…</p>
      ) : !levels.length ? (
        <p className="muted">No levels yet. Add the top level first.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">Levels, top first</caption>
            <thead>
              <tr>
                <th>Name</th>
                <th>Depth</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {levels.map((level) => (
                <tr key={level.id}>
                  <td data-label="Name">{level.name}</td>
                  <td data-label="Depth">
                    {level.depth === 0 ? "0 (top)" : level.depth}
                  </td>
                  <td data-label="Status">
                    {level.archivedAt ? "Archived" : "Current"}
                  </td>
                  <td data-label="Actions">
                    {!level.archivedAt && (
                      <div className="row" style={actionRow}>
                        <button
                          type="button"
                          className="button secondary small"
                          onClick={() => onRename(level)}
                        >
                          Rename<span className="sr-only">: {level.name}</span>
                        </button>
                        <button
                          type="button"
                          className="button secondary small"
                          onClick={() => onArchive(level)}
                        >
                          Archive<span className="sr-only">: {level.name}</span>
                        </button>
                      </div>
                    )}
                    {errors[`level:${level.id}`] && (
                      <p className="notice error" role="alert">
                        {errors[`level:${level.id}`]}
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {levels && <AddLevelForm levels={levels} onAdd={onAdd} />}
    </section>
  );
}

function AddLevelForm({
  levels,
  onAdd,
}: {
  levels: OrgLevel[];
  onAdd: (name: string, depth: number) => Promise<void>;
}) {
  const free = DEPTHS.filter(
    (depth) => !levels.some((level) => level.depth === depth),
  );
  const [name, setName] = useState("");
  const [depth, setDepth] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosen = free.includes(Number(depth)) && depth !== "" ? depth : "";
  const value = chosen || String(free[0] ?? "");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onAdd(name.trim(), Number(value));
      setName("");
      setDepth("");
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AddLevelFormView
      name={name}
      depth={value}
      free={free}
      busy={busy}
      error={error}
      onName={setName}
      onDepth={setDepth}
      onSubmit={submit}
    />
  );
}

export function AddLevelFormView({
  name,
  depth,
  free,
  busy,
  error,
  onName = () => {},
  onDepth = () => {},
  onSubmit = (event) => event.preventDefault(),
}: {
  name: string;
  depth: string;
  free: number[];
  busy: boolean;
  error: string;
  onName?: (value: string) => void;
  onDepth?: (value: string) => void;
  onSubmit?: (event: FormEvent) => void;
}) {
  return (
    <form className="stack" style={{ gap: 12 }} onSubmit={onSubmit}>
      <h3>Add level</h3>
      {free.length ? (
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field">
            <span>Level name</span>
            <input
              required
              maxLength={120}
              value={name}
              disabled={busy}
              onChange={(event) => onName(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Depth</span>
            <select
              value={depth}
              disabled={busy}
              onChange={(event) => onDepth(event.target.value)}
            >
              {free.map((value) => (
                <option key={value} value={value}>
                  {value === 0 ? "0 (top)" : value}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="button" disabled={busy}>
            Add level
          </button>
        </div>
      ) : (
        <p className="muted">All eight depths, 0 to 7, have a level.</p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

interface ChartContext {
  levelNames: ReadonlyMap<string, string>;
  chart: ChartState;
  owner: boolean;
  directoryView: boolean;
  on: Partial<ChartHandlers>;
}

/** The org chart as a nested list; each unit's button expands it in place. */
export function OrgChartPanel({
  levels,
  chart,
  owner,
  directoryView,
  on = {},
}: {
  levels: OrgLevel[];
  chart: ChartState;
  owner: boolean;
  directoryView: boolean;
  on?: Partial<ChartHandlers>;
}) {
  const ctx: ChartContext = {
    levelNames: new Map(levels.map((level) => [level.id, level.name])),
    chart,
    owner,
    directoryView,
    on,
  };
  const top = chart.lists[""];
  return (
    <section className="panel stack">
      <h2>Org chart</h2>
      <p className="muted">
        Expand a unit to see its positions and the units below it. Each level
        loads when you open it.
      </p>
      <div className="row">
        <button
          type="button"
          className="button"
          onClick={() => on.open?.({ kind: "add-unit", parent: null })}
        >
          Add top-level unit
        </button>
      </div>
      {chart.errors["list:"] && !top ? (
        <p className="notice error" role="alert">
          {chart.errors["list:"]}
        </p>
      ) : !top ? (
        <p role="status">Loading the org chart…</p>
      ) : !top.units.length ? (
        <p className="muted">No units yet. Add a top-level unit first.</p>
      ) : (
        <UnitTree listKey="" label="Top-level units" ctx={ctx} />
      )}
    </section>
  );
}

function UnitTree({
  listKey,
  label,
  ctx,
}: {
  listKey: string;
  label: string;
  ctx: ChartContext;
}) {
  const { chart, on } = ctx;
  const list = chart.lists[listKey];
  const error = chart.errors[`list:${listKey}`];
  return (
    <>
      <ul aria-label={label} style={treeList(listKey !== "")}>
        {list.units.map((unit) => (
          <UnitItem key={unit.id} unit={unit} ctx={ctx} />
        ))}
      </ul>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {list.hasMore && (
        <div className="row">
          <button
            type="button"
            className="button secondary small"
            disabled={chart.busy.includes(`list:${listKey}`)}
            onClick={() => on.more?.(listKey)}
          >
            Show more units<span className="sr-only">: {label}</span>
          </button>
        </div>
      )}
    </>
  );
}

function UnitItem({ unit, ctx }: { unit: OrgUnit; ctx: ChartContext }) {
  const { chart, owner, on } = ctx;
  const open = chart.expanded.includes(unit.id);
  const region = `org-unit-${unit.id}`;
  const contents = chart.contents[unit.id];
  const children = chart.lists[unit.id];
  const loadError = chart.errors[`load:${unit.id}`];
  const refusal = chart.errors[`unit:${unit.id}`];
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li>
      <div className="row" style={{ gap: 8 }}>
        <button
          type="button"
          className="button secondary small"
          aria-expanded={open}
          aria-controls={region}
          onClick={() => on.toggle?.(unit)}
        >
          <Chevron size={16} aria-hidden="true" />
          {unit.name}
        </button>
        <span className="muted small-text">
          {unit.code} · {ctx.levelNames.get(unit.levelId) ?? "Unknown level"}
        </span>
        <div className="row" style={actionRow}>
          <button
            type="button"
            className="button secondary small"
            onClick={() => on.open?.({ kind: "rename-unit", unit })}
          >
            Rename<span className="sr-only">: {unit.name}</span>
          </button>
          <button
            type="button"
            className="button secondary small"
            onClick={() => on.open?.({ kind: "add-unit", parent: unit })}
          >
            Add unit below<span className="sr-only">: {unit.name}</span>
          </button>
          {owner && (
            <>
              <button
                type="button"
                className="button secondary small"
                onClick={() => on.open?.({ kind: "move-unit", unit })}
              >
                Move<span className="sr-only">: {unit.name}</span>
              </button>
              <button
                type="button"
                className="button secondary small"
                onClick={() => on.archiveUnit?.(unit)}
              >
                Archive<span className="sr-only">: {unit.name}</span>
              </button>
            </>
          )}
        </div>
      </div>
      {refusal && (
        <p className="notice error" role="alert">
          {refusal}
        </p>
      )}
      <div id={region} hidden={!open}>
        {open &&
          (loadError ? (
            <p className="notice error" role="alert">
              Could not load {unit.name}. {loadError} Collapse and expand the
              unit to try again.
            </p>
          ) : !contents || !children ? (
            <p role="status">Loading {unit.name}…</p>
          ) : (
            <div className="stack" style={{ gap: 8, paddingLeft: 14 }}>
              <PositionList unit={unit} contents={contents} ctx={ctx} />
              {children.units.length ? (
                <UnitTree
                  listKey={unit.id}
                  label={`Units below ${unit.name}`}
                  ctx={ctx}
                />
              ) : (
                <p className="muted small-text">No units below {unit.name}.</p>
              )}
            </div>
          ))}
      </div>
    </li>
  );
}

function PositionList({
  unit,
  contents,
  ctx,
}: {
  unit: OrgUnit;
  contents: UnitContents;
  ctx: ChartContext;
}) {
  const { chart, directoryView, on } = ctx;
  const error = chart.errors[`positions:${unit.id}`];
  return (
    <div className="stack" style={{ gap: 8, marginTop: 8 }}>
      {contents.positions.length ? (
        <ul aria-label={`Positions in ${unit.name}`} style={plainList}>
          {contents.positions.map((position) => (
            <PositionItem key={position.id} position={position} ctx={ctx} />
          ))}
        </ul>
      ) : (
        <p className="muted small-text">No positions in {unit.name}.</p>
      )}
      {contents.positionsHasMore && (
        <p className="muted small-text">
          Only the first {POSITIONS_PAGE_SIZE} positions are listed.
        </p>
      )}
      {!directoryView && contents.positions.length > 0 && (
        <p className="muted small-text">
          You need directory access to see who holds these positions.
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="button secondary small"
          onClick={() => on.open?.({ kind: "add-position", unit })}
        >
          Add position<span className="sr-only">: {unit.name}</span>
        </button>
      </div>
    </div>
  );
}

function PositionItem({
  position,
  ctx,
}: {
  position: Position;
  ctx: ChartContext;
}) {
  const { chart, owner, directoryView, on } = ctx;
  const shown = chart.holdersOpen.includes(position.id);
  const region = `org-position-${position.id}`;
  const refusal = chart.errors[`position:${position.id}`];
  return (
    <li>
      <div className="row" style={{ gap: 8 }}>
        <span>
          <strong>{position.title}</strong>{" "}
          <span className="muted small-text">{position.code}</span>
          {position.isManager && (
            <>
              {" "}
              <span className="tag">Manager</span>
            </>
          )}
        </span>
        <div className="row" style={actionRow}>
          {directoryView && (
            <button
              type="button"
              className="button secondary small"
              aria-expanded={shown}
              aria-controls={region}
              onClick={() => on.toggleHolders?.(position)}
            >
              Show employees
              <span className="sr-only">: {position.title}</span>
            </button>
          )}
          <button
            type="button"
            className="button secondary small"
            onClick={() => on.open?.({ kind: "edit-position", position })}
          >
            Edit<span className="sr-only">: {position.title}</span>
          </button>
          {owner && (
            <button
              type="button"
              className="button secondary small"
              onClick={() => on.open?.({ kind: "move-position", position })}
            >
              Move<span className="sr-only">: {position.title}</span>
            </button>
          )}
          <button
            type="button"
            className="button secondary small"
            onClick={() => on.archivePosition?.(position)}
          >
            Archive<span className="sr-only">: {position.title}</span>
          </button>
        </div>
      </div>
      {refusal && (
        <p className="notice error" role="alert">
          {refusal}
        </p>
      )}
      {directoryView && (
        <div id={region} hidden={!shown}>
          {shown && <HolderList position={position} ctx={ctx} />}
        </div>
      )}
    </li>
  );
}

/** Name and employee number only; contact fields are never shown in the chart. */
function HolderList({
  position,
  ctx,
}: {
  position: Position;
  ctx: ChartContext;
}) {
  const { chart, on } = ctx;
  const holders = chart.holders[position.id];
  const key = `holders:${position.id}`;
  const error = chart.errors[key];
  return (
    <div className="stack" style={{ gap: 8, margin: "8px 0 0 14px" }}>
      {holders &&
        (holders.rows.length ? (
          <ul
            aria-label={`Employees in ${position.title}`}
            style={{ ...plainList, gap: 4 }}
          >
            {holders.rows.map((row) => (
              <li key={row.id} className="small-text">
                {row.displayName} ({row.employeeNumber})
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small-text">No one holds this position.</p>
        ))}
      {error ? (
        <p className="notice error" role="alert">
          Could not load the employees. {error}
        </p>
      ) : (
        !holders && <p role="status">Loading employees…</p>
      )}
      {holders?.hasMore && (
        <div className="row">
          <button
            type="button"
            className="button secondary small"
            disabled={chart.busy.includes(key)}
            onClick={() => on.moreHolders?.(position)}
          >
            Show more<span className="sr-only">: {position.title}</span>
          </button>
        </div>
      )}
    </div>
  );
}

const formTitles: Record<OrgForm["kind"], [string, string]> = {
  "rename-level": ["Rename level", "Save name"],
  "add-unit": ["Add unit", "Add unit"],
  "rename-unit": ["Rename unit", "Save name"],
  "move-unit": ["Move unit", "Move unit"],
  "add-position": ["Add position", "Add position"],
  "edit-position": ["Edit position", "Save position"],
  "move-position": ["Move position", "Move position"],
};

/** One organisation write in a dialog; a refusal stays in the dialog, next to its fields. */
function OrgFormDialog({
  form,
  levels,
  request,
  onSubmit,
  onClose,
}: {
  form: OrgForm;
  levels: OrgLevel[];
  request: Requester;
  onSubmit: (values: OrgValues) => Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<OrgValues>(() => ({
    name:
      form.kind === "rename-level"
        ? form.level.name
        : form.kind === "rename-unit"
          ? form.unit.name
          : form.kind === "edit-position"
            ? form.position.title
            : "",
    code: "",
    levelId: "",
    isManager: form.kind === "edit-position" && form.position.isManager,
    target: null,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (change: Partial<OrgValues>) =>
    setValues((current) => ({ ...current, ...change }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (form.kind === "move-position" && !values.target) {
      setError("Choose the unit to move the position to.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        ...values,
        name: values.name.trim(),
        code: values.code.trim(),
      });
    } catch (e) {
      setError(plainError(e));
      setBusy(false);
    }
  }
  const [title, submitLabel] = formTitles[form.kind];
  const subject =
    form.kind === "rename-level"
      ? form.level.name
      : form.kind === "add-unit"
        ? (form.parent?.name ?? "")
        : form.kind === "rename-unit" ||
            form.kind === "move-unit" ||
            form.kind === "add-position"
          ? form.unit.name
          : form.position.title;
  const naming = form.kind !== "move-unit" && form.kind !== "move-position";
  const coded = form.kind === "add-unit" || form.kind === "add-position";
  const positional =
    form.kind === "add-position" || form.kind === "edit-position";
  return (
    <FormDialog
      title={subject ? `${title}: ${subject}` : title}
      submitLabel={submitLabel}
      busy={busy}
      error={error}
      onSubmit={submit}
      onClose={onClose}
    >
      {form.kind === "add-unit" && (
        <p className="muted">
          {form.parent
            ? `The new unit sits below ${form.parent.name}.`
            : "The new unit sits at the top of the org chart."}
        </p>
      )}
      {naming && (
        <label className="field">
          <span>{positional ? "Title" : "Name"}</span>
          <input
            required
            maxLength={120}
            value={values.name}
            disabled={busy}
            onChange={(event) => set({ name: event.target.value })}
          />
        </label>
      )}
      {coded && (
        <label className="field">
          <span>Code</span>
          <input
            required
            maxLength={120}
            value={values.code}
            disabled={busy}
            onChange={(event) => set({ code: event.target.value })}
          />
        </label>
      )}
      {form.kind === "add-unit" && (
        <label className="field">
          <span>Level</span>
          <select
            required
            value={values.levelId}
            disabled={busy}
            onChange={(event) => set({ levelId: event.target.value })}
          >
            <option value="">Choose a level</option>
            {levels
              .filter((level) => !level.archivedAt)
              .map((level) => (
                <option key={level.id} value={level.id}>
                  {level.name} (depth {level.depth})
                </option>
              ))}
          </select>
        </label>
      )}
      {positional && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={values.isManager}
            disabled={busy}
            onChange={(event) => set({ isManager: event.target.checked })}
          />
          Manager position
        </label>
      )}
      {!naming && (
        <UnitPicker
          request={request}
          label={form.kind === "move-unit" ? "New parent unit" : "New unit"}
          emptyLabel={form.kind === "move-unit" ? "Top level" : "Choose a unit"}
          disabled={busy}
          onChange={(target) => set({ target })}
        />
      )}
    </FormDialog>
  );
}

/** A form in a dialog: its fields, an inline refusal with role="alert", then Cancel and the action. */
export function FormDialog({
  title,
  submitLabel,
  busy,
  error,
  wide = false,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  submitLabel: string;
  busy: boolean;
  error: string;
  wide?: boolean;
  onSubmit: (event: FormEvent) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const errorId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  // Runs after Dialog has opened, so focus lands on the first field inside the modal.
  useEffect(() => {
    formRef.current
      ?.querySelector<HTMLElement>("input, select, textarea")
      ?.focus();
  }, []);
  return (
    <Dialog title={title} onClose={onClose} busy={busy} wide={wide}>
      <form
        ref={formRef}
        onSubmit={onSubmit}
        aria-describedby={error ? errorId : undefined}
      >
        <div className="dialog-body stack" style={{ gap: 16 }}>
          {children}
          {error && (
            <p id={errorId} className="notice error" role="alert">
              {error}
            </p>
          )}
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
            {submitLabel}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
