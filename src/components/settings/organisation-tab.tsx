"use client";

import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
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
import { saveBlob } from "@/components/workspace/helpers";
import type { Requester } from "@/components/workspace/optimistic";
import type { Employee, Position, ReportingPerson } from "@/lib/directory";
import type { OrgLevel, OrgUnit } from "@/lib/org";
import type { MeAccess } from "./admin-portal";
import { JobArchitecturePanel } from "./job-architecture-panel";
import { JobTitlePicker } from "./job-title-picker";
import { OrgImportPanel } from "./org-import-panel";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  buildPeopleTree,
  buildTree,
  countsText,
  drawLayout,
  expandAll,
  expandAllPeople,
  expandMessage,
  exportScale,
  flattenTree,
  imageFilename,
  peopleCount,
  peopleCountsText,
  peopleExpandMessage,
  personDetails,
  resolveFocus,
  treeCounts,
  treeKey,
  treeLayout,
  unitCounts,
  zoomTo,
  type ExpandStatus,
  type MoreNode,
  type PeopleExpandStatus,
  type PersonNode,
  type TreeFocus,
  type TreeLayout,
  type TreeNode,
  type UnitNode,
} from "./org-tree";
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
  /** A position's chosen job title key; "" is no job title. */
  jobTitleKey: string;
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
export type ChartView = "list" | "tree";
/** The tree view's own state (ADM-22); the tab holds it and the view renders it from props. */
export interface TreeState {
  zoom: number;
  /** The treeitem holding the tab stop; null is the first item. */
  focused: TreeFocus | null;
  expandAll: ExpandStatus;
  exportFailed: boolean;
}
export interface TreeHandlers {
  view: (view: ChartView) => void;
  /** Makes the item the tab stop; with move, focus goes to it too. */
  focus: (node: TreeNode, move?: boolean) => void;
  expandAll: () => void;
  collapseAll: () => void;
  zoom: (zoom: number) => void;
  exportImage: () => void;
}
export const TREE_START: TreeState = {
  zoom: 100,
  focused: null,
  expandAll: { state: "idle" },
  exportFailed: false,
};
/** What the org tree shows (ADM-23): units, the default, or people with their reporting lines. */
export type TreeMode = "units" | "people";
export interface PeopleList {
  people: ReportingPerson[];
  page: number;
  hasMore: boolean;
}
/** The org tree by people, loaded apart from the chart; nothing loads until By people is chosen. */
export interface PeopleState {
  /** One level per manager id; "" is the top level. */
  lists: Record<string, PeopleList>;
  expanded: string[];
  /** Load errors by `load:` (a person's first page) or `list:` (Show more) and a manager id. */
  errors: Record<string, string>;
  /** Keys of the requests in flight, in the same form. */
  busy: string[];
  /** People mode's own tab stop; null is the first item. */
  focused: TreeFocus | null;
  expandAll: PeopleExpandStatus;
}
export interface PeopleHandlers {
  treeMode: (mode: TreeMode) => void;
  togglePerson: (person: ReportingPerson) => void;
  morePeople: (listKey: string) => void;
  /** Makes the item people mode's tab stop; with move, focus goes to it too. */
  focusPerson: (node: TreeNode, move?: boolean) => void;
  expandAllPeople: () => void;
  collapseAllPeople: () => void;
  exportPeopleImage: () => void;
}
export const EMPTY_PEOPLE: PeopleState = {
  lists: {},
  expanded: [],
  errors: {},
  busy: [],
  focused: null,
  expandAll: { state: "idle" },
};
/** The org tree by people needs the directory page and directory view (directory:read). */
export const peopleViewAllowed = (
  access: Pick<MeAccess, "pages" | "actions">,
) =>
  access.pages.includes("directory") &&
  !!access.actions.directory?.includes("view");

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
export const PEOPLE_PAGE_SIZE = 100;
export const reportingPath = (managerId: string | null, page = 1) =>
  `/api/v1/employees/reporting-lines?${managerId ? `managerId=${managerId}&` : ""}page=${page}&pageSize=${PEOPLE_PAGE_SIZE}`;
/** Expanding a person: one page of the people reporting to them; null is the top level. */
export const loadReports = (
  request: Requester,
  managerId: string | null,
  page = 1,
) => request<Page<ReportingPerson>>(reportingPath(managerId, page));
/** Show employees on a position: one page of the people who hold it. */
export const loadHolders = (request: Requester, positionId: string, page = 1) =>
  request<Page<Employee>>(holdersPath(positionId, page));
/**
 * A position's job title to send: nothing when it is unchanged, so a saved key a newer version
 * removed is never sent again; null clears it.
 */
export const positionTitleInput = (
  saved: string | null,
  chosen: string,
): { jobTitleKey?: string | null } =>
  chosen === (saved ?? "") ? {} : { jobTitleKey: chosen || null };
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
const peopleList = (page: Page<ReportingPerson>): PeopleList => ({
  people: page.data,
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
// A table's actions stay on one line; the column is as narrow as its buttons.
const actionCell = { width: "1%", whiteSpace: "nowrap" } as const;
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
 * levels, an org chart that loads one level at a time and the job architecture (ADM-26). Moving and archiving units and moving
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
  const peopleAllowed = peopleViewAllowed(access);
  const [levels, setLevels] = useState<OrgLevel[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [chart, setChart] = useState<ChartState>(EMPTY_CHART);
  const [form, setForm] = useState<OrgForm | null>(null);
  const [view, setView] = useState<ChartView>("list");
  const [tree, setTree] = useState<TreeState>(TREE_START);
  const [treeMode, setTreeMode] = useState<TreeMode>("units");
  const [people, setPeople] = useState<PeopleState>(EMPTY_PEOPLE);
  const peopleMode = peopleAllowed && treeMode === "people";
  const moveTreeFocus = useRef(false);
  const levelNames = useMemo(
    () => new Map((levels ?? []).map((level) => [level.id, level.name])),
    [levels],
  );
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
  const patchPeople = (
    change: (current: PeopleState) => Partial<PeopleState>,
  ) => setPeople((current) => ({ ...current, ...change(current) }));
  const setPeopleBusy = (key: string, on: boolean) =>
    patchPeople((current) => ({
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
  // A move or archive can remove the control that had focus; focus then goes to the first of
  // these on the page: the units' expand buttons, then Add top-level unit.
  const [refocus, setRefocus] = useState<{ selectors: string[] } | null>(null);
  useEffect(() => {
    if (!refocus || document.activeElement !== document.body) return;
    refocus.selectors
      .map((selector) => document.querySelector<HTMLElement>(selector))
      .find(Boolean)
      ?.focus();
  }, [refocus]);
  const focusNear = (...unitIds: (string | null)[]) =>
    setRefocus({
      selectors: [
        ...unitIds
          .filter((id): id is string => !!id)
          .map((id) => `[aria-controls="org-unit-${id}"]`),
        "[data-org-add-top]",
      ],
    });

  // Focus follows a key or a click to the tree's tab stop. When a collapse hides the focused item,
  // the view moves the tab stop to its nearest visible unit or person, and focus follows if it was
  // lost. Each tree mode keeps its own tab stop.
  const treeFocused = peopleMode ? people.focused : tree.focused;
  useEffect(() => {
    if (view !== "tree") return;
    const element = document.querySelector<HTMLElement>(
      '[data-org-tree] [tabindex="0"]',
    );
    const lost =
      !!treeFocused &&
      document.activeElement === document.body &&
      element?.dataset.orgTreeKey !== treeFocused.key;
    if (!element || !(moveTreeFocus.current || lost)) return;
    moveTreeFocus.current = false;
    element.focus({ preventScroll: true });
    element
      .querySelector(".org-tree-box")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [view, chart, people, treeFocused]);

  /** After an import: the levels and the top level again, with every unit collapsed. */
  async function reloadChart() {
    if (!request) return;
    try {
      const [found, top] = await loadChart(request);
      setLevels(found.data);
      setChart({ ...EMPTY_CHART, lists: { "": unitList(top) } });
    } catch (e) {
      setLoadError(humanError(e));
    }
  }
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
        () =>
          reloadList(unit.parentId ?? "").then(() => focusNear(unit.parentId)),
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
        () =>
          reloadPositions(position.orgUnitId).then(() =>
            focusNear(position.orgUnitId),
          ),
      );
    },
  };

  const opened = (ids: string[], id: string) =>
    ids.includes(id) ? ids : [...ids, id];
  const treeHandlers: TreeHandlers = {
    view: setView,
    focus(node, move = false) {
      if (move) moveTreeFocus.current = true;
      setTree((current) =>
        current.focused?.key === node.key && !move
          ? current
          : { ...current, focused: { key: node.key, path: node.path } },
      );
    },
    expandAll() {
      void runExpandAll();
    },
    collapseAll() {
      patch(() => ({ expanded: [] }));
    },
    zoom(zoom) {
      setTree((current) => ({ ...current, zoom: zoomTo(zoom) }));
    },
    exportImage() {
      saveImage(treeLayout(buildTree(chart, levelNames)), "units");
    },
  };
  /** Draws the layout on a canvas in the browser and saves it as a PNG; no request is made. */
  function saveImage(layout: TreeLayout, mode: TreeMode) {
    const failed = () =>
      setTree((current) => ({ ...current, exportFailed: true }));
    const scale = exportScale(layout);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(layout.width * scale));
    canvas.height = Math.max(1, Math.floor(layout.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return failed();
    drawLayout(context, layout, scale);
    canvas.toBlob((blob) => {
      if (!blob) return failed();
      setTree((current) => ({ ...current, exportFailed: false }));
      saveBlob(imageFilename(new Date(), mode), blob);
    }, "image/png");
  }
  /** Expand all through loadUnit; each result goes into the chart as an expand would put it. */
  async function runExpandAll() {
    if (!request || tree.expandAll.state === "running") return;
    const progress = (units: number) =>
      setTree((current) => ({
        ...current,
        expandAll: { state: "running", units },
      }));
    progress(treeCounts(chart).units);
    const result = await expandAll(chart, (id) => loadUnit(request, id), {
      loaded(unit, units, positions) {
        patch((current) => ({
          lists: { ...current.lists, [unit.id]: unitList(units) },
          contents: {
            ...current.contents,
            [unit.id]: {
              positions: positions.data,
              positionsHasMore: positions.pagination.hasMore,
            },
          },
          expanded: opened(current.expanded, unit.id),
          errors: without(current.errors, `load:${unit.id}`),
        }));
      },
      expanded(unit) {
        patch((current) => ({ expanded: opened(current.expanded, unit.id) }));
      },
      failed(unit, error) {
        patch((current) => ({
          expanded: opened(current.expanded, unit.id),
          errors: { ...current.errors, [`load:${unit.id}`]: humanError(error) },
        }));
      },
      progress,
    });
    setTree((current) => ({ ...current, expandAll: result }));
  }

  /** Loads the first page of a person's reports, or of the top level for "". */
  async function loadPeople(managerId: string) {
    if (!request) return;
    const key = `load:${managerId}`;
    patchPeople((current) => ({
      busy: [...current.busy, key],
      errors: without(current.errors, key),
    }));
    try {
      const page = await loadReports(request, managerId || null);
      patchPeople((current) => ({
        lists: { ...current.lists, [managerId]: peopleList(page) },
      }));
    } catch (e) {
      patchPeople((current) => ({
        errors: { ...current.errors, [key]: humanError(e) },
      }));
    } finally {
      setPeopleBusy(key, false);
    }
  }
  const peopleHandlers: PeopleHandlers = {
    treeMode(mode) {
      setTreeMode(mode);
      setTree((current) => ({ ...current, exportFailed: false }));
      // The first switch to By people loads the top level; after a failure, switching retries.
      if (
        mode === "people" &&
        !people.lists[""] &&
        !people.busy.includes("load:")
      )
        void loadPeople("");
    },
    togglePerson(person) {
      if (!person.reports) return;
      const open = people.expanded.includes(person.id);
      patchPeople((current) => ({
        expanded: open
          ? current.expanded.filter((id) => id !== person.id)
          : [...current.expanded, person.id],
      }));
      // Once per person: collapsing and expanding again uses what was loaded.
      if (
        !open &&
        !people.lists[person.id] &&
        !people.busy.includes(`load:${person.id}`)
      )
        void loadPeople(person.id);
    },
    morePeople(key) {
      const list = people.lists[key];
      const busyKey = `list:${key}`;
      if (!request || !list || people.busy.includes(busyKey)) return;
      setPeopleBusy(busyKey, true);
      loadReports(request, key || null, list.page + 1)
        .then((page) =>
          patchPeople((current) => ({
            lists: {
              ...current.lists,
              [key]: {
                people: [...current.lists[key].people, ...page.data],
                page: page.pagination.page,
                hasMore: page.pagination.hasMore,
              },
            },
            errors: without(current.errors, busyKey),
          })),
        )
        .catch((e) =>
          patchPeople((current) => ({
            errors: { ...current.errors, [busyKey]: humanError(e) },
          })),
        )
        .finally(() => setPeopleBusy(busyKey, false));
    },
    focusPerson(node, move = false) {
      if (move) moveTreeFocus.current = true;
      setPeople((current) =>
        current.focused?.key === node.key && !move
          ? current
          : { ...current, focused: { key: node.key, path: node.path } },
      );
    },
    expandAllPeople() {
      void runExpandAllPeople();
    },
    collapseAllPeople() {
      patchPeople(() => ({ expanded: [] }));
    },
    exportPeopleImage() {
      saveImage(treeLayout(buildPeopleTree(people)), "people");
    },
  };
  /** Expand all by people through loadReports; each result goes in as an expand would put it. */
  async function runExpandAllPeople() {
    if (!request || people.expandAll.state === "running") return;
    const progress = (count: number) =>
      patchPeople(() => ({ expandAll: { state: "running", people: count } }));
    progress(peopleCount(people));
    const result = await expandAllPeople(
      people,
      (id) => loadReports(request, id),
      {
        loaded(person, page) {
          patchPeople((current) => ({
            lists: { ...current.lists, [person.id]: peopleList(page) },
            expanded: opened(current.expanded, person.id),
            errors: without(current.errors, `load:${person.id}`),
          }));
        },
        expanded(person) {
          patchPeople((current) => ({
            expanded: opened(current.expanded, person.id),
          }));
        },
        failed(person, error) {
          patchPeople((current) => ({
            expanded: opened(current.expanded, person.id),
            errors: {
              ...current.errors,
              [`load:${person.id}`]: humanError(error),
            },
          }));
        },
        progress,
      },
    );
    patchPeople(() => ({ expandAll: result }));
  }

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
      () =>
        reloadLevels()
          .catch((e) => setLoadError(humanError(e)))
          .then(() => setRefocus({ selectors: ["[data-org-level-name]"] })),
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
        focusNear(current.unit.id, current.unit.parentId);
        break;
      }
      case "add-position":
        await send(request, "/api/v1/positions", "POST", {
          title: values.name,
          code: values.code,
          orgUnitId: current.unit.id,
          isManager: values.isManager,
          ...positionTitleInput(null, values.jobTitleKey),
        });
        await reloadPositions(current.unit.id);
        break;
      case "edit-position":
        await send(
          request,
          `/api/v1/positions/${current.position.id}`,
          "PATCH",
          {
            title: values.name,
            isManager: values.isManager,
            ...positionTitleInput(
              current.position.jobTitleKey,
              values.jobTitleKey,
            ),
          },
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
        focusNear(current.position.orgUnitId);
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
        view={view}
        tree={tree}
        peopleAllowed={peopleAllowed}
        treeMode={treeMode}
        people={people}
        on={{ ...handlers, ...treeHandlers, ...peopleHandlers }}
      />
      <JobArchitecturePanel access={access} request={request} />
      <OrgImportPanel
        request={request}
        owner={owner}
        onApplied={() => void reloadChart()}
      />
      {form && request && (
        <OrgFormDialog
          form={form}
          levels={levels ?? []}
          access={access}
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
                <Fragment key={level.id}>
                  <tr>
                    <td data-label="Name">{level.name}</td>
                    <td data-label="Depth">
                      {level.depth === 0 ? "0 (top)" : level.depth}
                    </td>
                    <td data-label="Status">
                      {level.archivedAt ? "Archived" : "Current"}
                    </td>
                    <td data-label="Actions" style={actionCell}>
                      {!level.archivedAt && (
                        <div
                          className="row"
                          style={{ ...actionRow, flexWrap: "nowrap" }}
                        >
                          <button
                            type="button"
                            className="button secondary small"
                            onClick={() => onRename(level)}
                          >
                            Rename
                            <span className="sr-only">: {level.name}</span>
                          </button>
                          <button
                            type="button"
                            className="button secondary small"
                            onClick={() => onArchive(level)}
                          >
                            Archive
                            <span className="sr-only">: {level.name}</span>
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                  {errors[`level:${level.id}`] && (
                    <tr>
                      <td colSpan={4}>
                        <p className="notice error" role="alert">
                          {errors[`level:${level.id}`]}
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
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
              data-org-level-name=""
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

/**
 * The org chart, as a nested list where each unit's button expands it in place, or as the org tree
 * by units (ADM-22). Both read the same chart state. With the directory page and directory view the
 * org tree can show people instead (ADM-23), from its own state.
 */
export function OrgChartPanel({
  levels,
  chart,
  owner,
  directoryView,
  view = "list",
  tree = TREE_START,
  peopleAllowed = false,
  treeMode = "units",
  people = EMPTY_PEOPLE,
  on = {},
}: {
  levels: OrgLevel[];
  chart: ChartState;
  owner: boolean;
  directoryView: boolean;
  view?: ChartView;
  tree?: TreeState;
  peopleAllowed?: boolean;
  treeMode?: TreeMode;
  people?: PeopleState;
  on?: Partial<ChartHandlers & TreeHandlers & PeopleHandlers>;
}) {
  const ctx: ChartContext = {
    levelNames: new Map(levels.map((level) => [level.id, level.name])),
    chart,
    owner,
    directoryView,
    on,
  };
  const top = chart.lists[""];
  const peopleMode = view === "tree" && peopleAllowed && treeMode === "people";
  return (
    <section className="panel stack">
      <h2>Org chart</h2>
      <p className="muted">
        Expand a unit to see its positions and the units below it. Each level
        loads when you open it.
      </p>
      <div className="row">
        <div className="view-toggle" role="group" aria-label="Org chart view">
          <button
            type="button"
            aria-pressed={view === "list"}
            onClick={() => on.view?.("list")}
          >
            List
          </button>
          <button
            type="button"
            aria-pressed={view === "tree"}
            onClick={() => on.view?.("tree")}
          >
            Org tree
          </button>
        </div>
        {view === "tree" && peopleAllowed && (
          <div className="view-toggle" role="group" aria-label="Org tree shows">
            <button
              type="button"
              aria-pressed={!peopleMode}
              onClick={() => on.treeMode?.("units")}
            >
              By units
            </button>
            <button
              type="button"
              aria-pressed={peopleMode}
              onClick={() => on.treeMode?.("people")}
            >
              By people
            </button>
          </div>
        )}
        <button
          type="button"
          className="button"
          data-org-add-top=""
          onClick={() => on.open?.({ kind: "add-unit", parent: null })}
        >
          Add top-level unit
        </button>
      </div>
      {peopleMode && (
        <p className="muted small-text">
          Each person reports to whoever holds a manager position in their unit,
          or in the nearest unit above it that has one.
        </p>
      )}
      {peopleMode ? (
        <PeopleTreeView
          people={people}
          zoom={tree.zoom}
          focused={people.focused}
          expandAll={people.expandAll}
          exportFailed={tree.exportFailed}
          on={on}
        />
      ) : chart.errors["list:"] && !top ? (
        <p className="notice error" role="alert">
          {chart.errors["list:"]}
        </p>
      ) : !top ? (
        <p role="status">Loading the org chart…</p>
      ) : !top.units.length ? (
        <p className="muted">No units yet. Add a top-level unit first.</p>
      ) : view === "tree" ? (
        <OrgTreeView
          chart={chart}
          levels={levels}
          zoom={tree.zoom}
          focused={tree.focused}
          expandAll={tree.expandAll}
          exportFailed={tree.exportFailed}
          on={on}
        />
      ) : (
        <UnitTree listKey="" label="Top-level units" ctx={ctx} />
      )}
    </section>
  );
}

/**
 * The org tree by units (ADM-22): a read-only nested list with tree keyboard navigation, drawn
 * top-down when wide and as an outline when narrow. No names of people and no contact facts.
 */
export function OrgTreeView({
  chart,
  levels,
  zoom,
  focused,
  expandAll,
  exportFailed = false,
  on = {},
}: {
  chart: ChartState;
  levels: OrgLevel[];
  zoom: number;
  focused: TreeFocus | null;
  expandAll: ExpandStatus;
  exportFailed?: boolean;
  on?: Partial<ChartHandlers & TreeHandlers>;
}) {
  const nodes = buildTree(
    chart,
    new Map(levels.map((level) => [level.id, level.name])),
  );
  const items = flattenTree(nodes);
  const stop = resolveFocus(items, focused);
  const counts = treeCounts(chart);
  const message = expandMessage(expandAll);
  const failures = items.filter(
    (item): item is UnitNode =>
      item.kind === "unit" && item.failed && item.expanded,
  );
  const listErrors = items.filter(
    (item): item is MoreNode =>
      item.kind === "more" && !!chart.errors[`list:${item.listKey}`],
  );
  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = (event.target as HTMLElement).dataset.orgTreeKey;
    const move = key && treeKey(items, key, event.key);
    if (!move) return;
    event.preventDefault();
    if (move.toggle) on.toggle?.(move.toggle);
    if (move.more !== undefined) on.more?.(move.more);
    const target = items.find((item) => item.key === move.focus);
    if (target) on.focus?.(target, true);
  }
  return (
    <div className="stack" style={{ gap: 12 }}>
      <TreeToolbar
        zoom={zoom}
        running={expandAll.state === "running"}
        exportable={!!counts.units}
        onExpandAll={() => on.expandAll?.()}
        onCollapseAll={() => on.collapseAll?.()}
        onZoom={(next) => on.zoom?.(next)}
        onExport={() => on.exportImage?.()}
      />
      <p role="status" className="small-text">
        {message ? `${countsText(counts)}. ${message}` : countsText(counts)}
      </p>
      {counts.unknown && (
        <p className="muted small-text">
          You need directory access to see which positions are vacant.
        </p>
      )}
      {exportFailed && (
        <p className="notice error" role="alert">
          Could not make the image. Collapse some units and try again.
        </p>
      )}
      {failures.map((item) => (
        <p key={item.key} className="notice error" role="alert">
          Could not load {item.unit.name}.{" "}
          {chart.errors[`load:${item.unit.id}`]} Collapse and expand the unit to
          try again.
        </p>
      ))}
      {listErrors.map((item) => (
        <p key={item.key} className="notice error" role="alert">
          {chart.errors[`list:${item.listKey}`]}
        </p>
      ))}
      <div className="org-tree-scroll">
        <ul
          role="tree"
          aria-label="Org tree by units"
          className="org-tree"
          data-org-tree=""
          style={{ zoom: zoom / 100 }}
          onKeyDown={onKeyDown}
        >
          {nodes.map((node) => (
            <OrgTreeItem
              key={node.key}
              node={node}
              edge=""
              stop={stop}
              on={on}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Expand all, Collapse all, zoom and Export image, the same in both tree modes. */
function TreeToolbar({
  zoom,
  running,
  exportable,
  onExpandAll,
  onCollapseAll,
  onZoom,
  onExport,
}: {
  zoom: number;
  running: boolean;
  exportable: boolean;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onZoom: (zoom: number) => void;
  onExport: () => void;
}) {
  return (
    <div className="row" style={{ gap: 8 }}>
      <button
        type="button"
        className="button secondary small"
        disabled={running}
        onClick={onExpandAll}
      >
        Expand all
      </button>
      <button
        type="button"
        className="button secondary small"
        onClick={onCollapseAll}
      >
        Collapse all
      </button>
      <button
        type="button"
        className="button secondary small"
        disabled={zoom <= ZOOM_MIN}
        onClick={() => onZoom(zoom - ZOOM_STEP)}
      >
        Zoom out
      </button>
      <span className="small-text">{zoom}%</span>
      <button
        type="button"
        className="button secondary small"
        disabled={zoom >= ZOOM_MAX}
        onClick={() => onZoom(zoom + ZOOM_STEP)}
      >
        Zoom in
      </button>
      <button
        type="button"
        className="button secondary small"
        onClick={() => onZoom(100)}
      >
        Reset zoom
      </button>
      <button
        type="button"
        className="button secondary small"
        disabled={!exportable}
        onClick={onExport}
      >
        Export image
      </button>
    </div>
  );
}

/**
 * The org tree by people (ADM-23): a read-only nested list of who reports to whom, with the same
 * keys, zoom and export as the tree by units. Each person shows only their name, the title and unit
 * of the position they report from, and two counts; never a contact fact or employee number.
 */
export function PeopleTreeView({
  people,
  zoom,
  focused,
  expandAll,
  exportFailed = false,
  on = {},
}: {
  people: Pick<PeopleState, "lists" | "expanded" | "errors" | "busy">;
  zoom: number;
  focused: TreeFocus | null;
  expandAll: PeopleExpandStatus;
  exportFailed?: boolean;
  on?: Partial<TreeHandlers & PeopleHandlers>;
}) {
  const top = people.lists[""];
  const nodes = buildPeopleTree(people);
  const items = flattenTree(nodes);
  const stop = resolveFocus(items, focused);
  if (!top)
    return people.errors["load:"] ? (
      <p className="notice error" role="alert">
        Could not load the org tree by people. {people.errors["load:"]}
      </p>
    ) : (
      <p role="status">Loading the org tree by people…</p>
    );
  if (!top.people.length)
    return <p className="muted">No one holds a current position yet.</p>;
  const count = peopleCount(people);
  const message = peopleExpandMessage(expandAll);
  const failures = items.filter(
    (item): item is PersonNode => item.kind === "person" && item.failed,
  );
  const listErrors = items.filter(
    (item): item is MoreNode =>
      item.kind === "more" && !!people.errors[`list:${item.listKey}`],
  );
  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = (event.target as HTMLElement).dataset.orgTreeKey;
    const move = key && treeKey(items, key, event.key);
    if (!move) return;
    event.preventDefault();
    if (move.togglePerson) on.togglePerson?.(move.togglePerson);
    if (move.more !== undefined) on.morePeople?.(move.more);
    const target = items.find((item) => item.key === move.focus);
    if (target) on.focusPerson?.(target, true);
  }
  return (
    <div className="stack" style={{ gap: 12 }}>
      <TreeToolbar
        zoom={zoom}
        running={expandAll.state === "running"}
        exportable={count > 0}
        onExpandAll={() => on.expandAllPeople?.()}
        onCollapseAll={() => on.collapseAllPeople?.()}
        onZoom={(next) => on.zoom?.(next)}
        onExport={() => on.exportPeopleImage?.()}
      />
      <p role="status" className="small-text">
        {message
          ? `${peopleCountsText(count)}. ${message}`
          : peopleCountsText(count)}
      </p>
      {exportFailed && (
        <p className="notice error" role="alert">
          Could not make the image. Collapse some people and try again.
        </p>
      )}
      {failures.map((item) => (
        <p key={item.key} className="notice error" role="alert">
          Could not load the people reporting to {item.person.displayName}.{" "}
          {people.errors[`load:${item.person.id}`]} Collapse and expand{" "}
          {item.person.displayName} to try again.
        </p>
      ))}
      {listErrors.map((item) => (
        <p key={item.key} className="notice error" role="alert">
          {people.errors[`list:${item.listKey}`]}
        </p>
      ))}
      <div className="org-tree-scroll">
        <ul
          role="tree"
          aria-label="Org tree by people"
          className="org-tree"
          data-org-tree=""
          style={{ zoom: zoom / 100 }}
          onKeyDown={onKeyDown}
        >
          {nodes.map((node, index) => (
            <PersonTreeItem
              key={node.key}
              node={node}
              edge={edgeOf(index, nodes.length)}
              stop={stop}
              on={on}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function PersonTreeItem({
  node,
  edge,
  stop,
  on,
}: {
  node: TreeNode;
  edge: string;
  stop: string | null;
  on: Partial<PeopleHandlers>;
}) {
  const item = {
    role: "treeitem",
    "aria-level": node.level,
    "aria-setsize": node.setSize,
    "aria-posinset": node.posInSet,
    "aria-label": node.label,
    tabIndex: node.key === stop ? 0 : -1,
    "data-org-tree-key": node.key,
    onFocus: (event: FocusEvent) => {
      if (event.target === event.currentTarget) on.focusPerson?.(node);
    },
  };
  if (node.kind !== "person")
    return (
      <li {...item} className={`org-tree-node org-tree-more${edge}`}>
        <div
          className="org-tree-box"
          onClick={() => {
            on.focusPerson?.(node, true);
            if (node.kind === "more") on.morePeople?.(node.listKey);
          }}
        >
          {node.kind === "more" && node.busy
            ? "Loading more people…"
            : node.label}
        </div>
      </li>
    );
  const { person } = node;
  const Chevron = node.expanded ? ChevronDown : ChevronRight;
  return (
    <li
      {...item}
      aria-expanded={person.reports > 0 ? node.expanded : undefined}
      className={`org-tree-node org-tree-person${edge}`}
    >
      <div
        className="org-tree-box"
        onClick={() => {
          on.focusPerson?.(node, true);
          if (person.reports > 0) on.togglePerson?.(person);
        }}
      >
        <span className="org-tree-title">
          {person.reports > 0 && <Chevron size={14} aria-hidden="true" />}
          {person.displayName}
        </span>
        {personDetails(person).map((line) => (
          <span key={line} className="org-tree-meta">
            {line}
          </span>
        ))}
        {node.loading && (
          <span className="org-tree-meta">
            Loading the people reporting to {person.displayName}…
          </span>
        )}
      </div>
      {node.children.length > 0 && (
        <ul
          role="group"
          className="org-tree-group"
          style={{
            gridTemplateColumns: `repeat(${node.children.length}, auto)`,
          }}
        >
          {node.children.map((child, index) => (
            <PersonTreeItem
              key={child.key}
              node={child}
              edge={edgeOf(index, node.children.length)}
              stop={stop}
              on={on}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** first, last or only among a group's units, for the connector lines. */
const edgeOf = (index: number, count: number) =>
  count === 1
    ? " org-tree-only"
    : index === 0
      ? " org-tree-first"
      : index === count - 1
        ? " org-tree-last"
        : "";

function OrgTreeItem({
  node,
  edge,
  stop,
  on,
}: {
  node: TreeNode;
  edge: string;
  stop: string | null;
  on: Partial<ChartHandlers & TreeHandlers>;
}) {
  const item = {
    role: "treeitem",
    "aria-level": node.level,
    "aria-setsize": node.setSize,
    "aria-posinset": node.posInSet,
    "aria-label": node.label,
    tabIndex: node.key === stop ? 0 : -1,
    "data-org-tree-key": node.key,
    onFocus: (event: FocusEvent) => {
      if (event.target === event.currentTarget) on.focus?.(node);
    },
  };
  if (node.kind === "position") {
    const { position } = node;
    const vacant = position.vacant === true;
    return (
      <li
        {...item}
        className={`org-tree-position${vacant ? " org-tree-vacant" : ""}`}
      >
        <div className="org-tree-box" onClick={() => on.focus?.(node, true)}>
          <span className="org-tree-title">{position.title}</span>
          <span className="org-tree-meta">
            {position.isManager ? `${position.code} · Manager` : position.code}
          </span>
          {vacant && <span className="org-tree-vacant-label">Vacant</span>}
        </div>
      </li>
    );
  }
  if (node.kind === "more")
    return (
      <li {...item} className={`org-tree-node org-tree-more${edge}`}>
        <div
          className="org-tree-box"
          onClick={() => {
            on.focus?.(node, true);
            on.more?.(node.listKey);
          }}
        >
          {node.busy ? "Loading more units…" : node.label}
        </div>
      </li>
    );
  // The tree by units holds no person nodes.
  if (node.kind === "person") return null;
  const { unit } = node;
  const Chevron = node.expanded ? ChevronDown : ChevronRight;
  const row = node.children.filter((child) => child.kind !== "position");
  return (
    <li
      {...item}
      aria-expanded={node.expanded}
      className={`org-tree-node org-tree-unit${edge}`}
    >
      <div
        className="org-tree-box"
        onClick={() => {
          on.focus?.(node, true);
          on.toggle?.(unit);
        }}
      >
        <span className="org-tree-title">
          <Chevron size={14} aria-hidden="true" />
          {unit.name}
        </span>
        <span className="org-tree-meta">
          {unit.code} · {node.levelName}
        </span>
        {node.positions !== null && (
          <span className="org-tree-meta">{unitCounts(node)}</span>
        )}
        {node.loading && (
          <span className="org-tree-meta">Loading {unit.name}…</span>
        )}
        {node.failed && (
          <span className="org-tree-error">Could not load this unit.</span>
        )}
        {node.expanded && node.positionsHasMore && (
          <span className="org-tree-meta">
            Only the first {POSITIONS_PAGE_SIZE} positions are listed.
          </span>
        )}
      </div>
      {node.children.length > 0 && (
        <ul
          role="group"
          className="org-tree-group"
          style={{
            gridTemplateColumns: `repeat(${Math.max(row.length, 1)}, auto)`,
          }}
        >
          {node.children.map((child) => (
            <OrgTreeItem
              key={child.key}
              node={child}
              edge={
                child.kind === "position"
                  ? ""
                  : edgeOf(row.indexOf(child), row.length)
              }
              stop={stop}
              on={on}
            />
          ))}
        </ul>
      )}
    </li>
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
  access,
  request,
  onSubmit,
  onClose,
}: {
  form: OrgForm;
  levels: OrgLevel[];
  access: MeAccess;
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
    jobTitleKey:
      form.kind === "edit-position" ? (form.position.jobTitleKey ?? "") : "",
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
        <JobTitlePicker
          request={request}
          access={access}
          value={values.jobTitleKey}
          allowNone
          disabled={busy}
          onChange={(jobTitleKey) => set({ jobTitleKey })}
        />
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
