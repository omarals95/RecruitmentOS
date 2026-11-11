import type { Position } from "@/lib/directory";
import type { OrgUnit } from "@/lib/org";
import type { ChartState, Page } from "./organisation-tab";

/*
 * The org tree by units (ADM-22): a second, read-only presentation of what the org chart has
 * loaded. Pure and React-free: the visible tree, its counts, Expand all, the keyboard moves and the
 * layout the image export draws.
 */

/** Expand all never leaves more units than this in the chart. */
export const EXPAND_ALL_LIMIT = 500;
/** Units Expand all loads at once: two requests each. */
export const EXPAND_ALL_PARALLEL = 4;
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 150;
export const ZOOM_STEP = 25;

interface NodeBase {
  /** Unique in the tree: "unit:", "position:" or "more:" and the id or list key. */
  key: string;
  level: number;
  setSize: number;
  posInSet: number;
  /** The keys of the units above, top first. */
  path: string[];
  /** The accessible name. */
  label: string;
  /** An expanded, loaded unit's positions, then its units, then its Show more item. */
  children: TreeNode[];
}
export type UnitNode = NodeBase & {
  kind: "unit";
  unit: OrgUnit;
  levelName: string;
  expanded: boolean;
  loading: boolean;
  failed: boolean;
  /** Null until the unit is loaded. */
  positions: number | null;
  /** Null while the vacancy of its positions is unknown. */
  vacant: number | null;
  positionsHasMore: boolean;
};
export type PositionNode = NodeBase & { kind: "position"; position: Position };
export type MoreNode = NodeBase & {
  kind: "more";
  listKey: string;
  busy: boolean;
};
export type TreeNode = UnitNode | PositionNode | MoreNode;
/** The roving tab stop: an item's key and the keys of the units above it. */
export type TreeFocus = Pick<NodeBase, "key" | "path">;

type ChartData = Pick<
  ChartState,
  "lists" | "contents" | "expanded" | "errors" | "busy"
>;

export const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;
/** Vacancy is known only when every position says true or false; the server sends null otherwise. */
const vacantOf = (positions: Position[]) =>
  positions.length && positions.every((p) => typeof p.vacant === "boolean")
    ? positions.filter((p) => p.vacant === true).length
    : null;

/** "2 positions · 1 vacant", the vacant part only when it is known. */
export const unitCounts = (node: UnitNode) =>
  node.positions === null
    ? ""
    : `${plural(node.positions, "position")}${node.vacant !== null ? ` · ${node.vacant} vacant` : ""}`;

function unitLabel(
  node: Pick<
    UnitNode,
    "unit" | "levelName" | "positions" | "vacant" | "loading" | "failed"
  >,
) {
  return [
    node.unit.name,
    node.unit.code,
    node.levelName,
    ...(node.positions !== null
      ? [
          plural(node.positions, "position"),
          ...(node.vacant !== null ? [`${node.vacant} vacant`] : []),
        ]
      : []),
    ...(node.loading ? ["loading"] : []),
    ...(node.failed ? ["could not load"] : []),
  ].join(", ");
}
const positionLabel = (position: Position) =>
  [
    position.title,
    position.code,
    ...(position.isManager ? ["Manager"] : []),
    ...(position.vacant === true ? ["Vacant"] : []),
  ].join(", ");

/**
 * The visible tree from the loaded chart: each unit, then (once expanded and loaded) its positions,
 * its units and a Show more item, depth first in the loaded order.
 */
export function buildTree(
  chart: ChartData,
  levelNames: ReadonlyMap<string, string>,
): TreeNode[] {
  return group(chart, levelNames, "", "", [], 1);
}

function group(
  chart: ChartData,
  levelNames: ReadonlyMap<string, string>,
  listKey: string,
  parentName: string,
  path: string[],
  level: number,
): TreeNode[] {
  const list = chart.lists[listKey];
  const positions = listKey ? (chart.contents[listKey]?.positions ?? []) : [];
  const units = list?.units ?? [];
  const setSize = positions.length + units.length + (list?.hasMore ? 1 : 0);
  let posInSet = 0;
  const base = (key: string) => ({
    key,
    level,
    setSize,
    posInSet: ++posInSet,
    path,
    children: [] as TreeNode[],
  });
  const nodes: TreeNode[] = positions.map((position) => ({
    ...base(`position:${position.id}`),
    kind: "position",
    position,
    label: positionLabel(position),
  }));
  for (const unit of units) {
    const key = `unit:${unit.id}`;
    const contents = chart.contents[unit.id];
    const loaded = !!contents && !!chart.lists[unit.id];
    const expanded = chart.expanded.includes(unit.id);
    const failed = !!chart.errors[`load:${unit.id}`];
    const node = {
      ...base(key),
      kind: "unit" as const,
      unit,
      levelName: levelNames.get(unit.levelId) ?? "Unknown level",
      expanded,
      loading: expanded && !loaded && !failed,
      failed,
      positions: loaded ? contents.positions.length : null,
      vacant: loaded ? vacantOf(contents.positions) : null,
      positionsHasMore: loaded && contents.positionsHasMore,
    };
    nodes.push({
      ...node,
      label: unitLabel(node),
      children:
        expanded && loaded
          ? group(
              chart,
              levelNames,
              unit.id,
              unit.name,
              [...path, key],
              level + 1,
            )
          : [],
    });
  }
  if (list?.hasMore)
    nodes.push({
      ...base(`more:${listKey}`),
      kind: "more",
      listKey,
      busy: chart.busy.includes(`list:${listKey}`),
      label: listKey
        ? `Show more units below ${parentName}`
        : "Show more top-level units",
    });
  return nodes;
}

/** Every visible item in reading order. */
export const flattenTree = (nodes: TreeNode[]): TreeNode[] =>
  nodes.flatMap((node) => [node, ...flattenTree(node.children)]);

/** Every unit in the chart's lists, and every loaded position. */
export function treeCounts(chart: Pick<ChartState, "lists" | "contents">) {
  const positions = Object.values(chart.contents).flatMap(
    (contents) => contents.positions,
  );
  return {
    units: Object.values(chart.lists).reduce(
      (sum, list) => sum + list.units.length,
      0,
    ),
    positions: positions.length,
    vacant: vacantOf(positions),
    /** A loaded position whose vacancy the caller may not see. */
    unknown: positions.some((p) => typeof p.vacant !== "boolean"),
  };
}

export const countsText = (counts: ReturnType<typeof treeCounts>) =>
  `Loaded: ${plural(counts.units, "unit")} · ${plural(counts.positions, "position")}${counts.vacant !== null ? ` · ${counts.vacant} vacant` : ""}`;

export type ExpandStatus =
  | { state: "idle" }
  | { state: "running"; units: number }
  | { state: "finished"; units: number }
  | { state: "limit"; units: number }
  | { state: "failed"; unit: string; units: number };

export function expandMessage(status: ExpandStatus) {
  switch (status.state) {
    case "idle":
      return "";
    case "running":
      return `Expand all is loading units: ${plural(status.units, "unit")} loaded so far.`;
    case "finished":
      return `Expand all finished: ${plural(status.units, "unit")} loaded.`;
    case "limit":
      return `Expand all stopped at the limit of ${EXPAND_ALL_LIMIT} units. Expand a unit to see the units below it.`;
    case "failed":
      return `Expand all stopped because ${status.unit} could not load.`;
  }
}

export interface ExpandAllEvents {
  /** A unit's first page of units and its positions fit: add them and expand the unit. */
  loaded: (
    unit: OrgUnit,
    units: Page<OrgUnit>,
    positions: Page<Position>,
  ) => void;
  /** A unit loaded before Expand all is expanded. */
  expanded: (unit: OrgUnit) => void;
  failed: (unit: OrgUnit, error: unknown) => void;
  progress: (units: number) => void;
}

/**
 * Expands breadth first from the loaded units: a loaded unit expands at once, any other loads
 * through `load` (the org chart's loadUnit), at most EXPAND_ALL_PARALLEL at a time, and never
 * through Show more. A unit whose units would take the chart over EXPAND_ALL_LIMIT is not added and
 * stays collapsed; no further load starts, and results still arriving are added only if they fit.
 * The first load error also stops it.
 */
export async function expandAll(
  chart: Pick<ChartState, "lists" | "contents">,
  load: (unitId: string) => Promise<[Page<OrgUnit>, Page<Position>]>,
  on: Partial<ExpandAllEvents> = {},
): Promise<ExpandStatus> {
  let units = treeCounts(chart).units;
  let stop: "limit" | OrgUnit | null = null;
  const queue = [...(chart.lists[""]?.units ?? [])];
  const running = new Set<Promise<void>>();
  while (running.size || (queue.length && !stop)) {
    while (queue.length && running.size < EXPAND_ALL_PARALLEL && !stop) {
      const unit = queue.shift()!;
      const below = chart.lists[unit.id];
      if (chart.contents[unit.id] && below) {
        on.expanded?.(unit);
        queue.push(...below.units);
        continue;
      }
      const task: Promise<void> = load(unit.id)
        .then(
          ([page, positions]) => {
            if (units + page.data.length > EXPAND_ALL_LIMIT) {
              stop ??= "limit";
              return;
            }
            units += page.data.length;
            on.loaded?.(unit, page, positions);
            on.progress?.(units);
            queue.push(...page.data);
          },
          (error) => {
            stop ??= unit;
            on.failed?.(unit, error);
          },
        )
        .finally(() => running.delete(task));
      running.add(task);
    }
    if (running.size) await Promise.race(running);
  }
  // The callbacks above set it; control flow analysis cannot see that.
  const ended = stop as "limit" | OrgUnit | null;
  return ended === "limit"
    ? { state: "limit", units }
    : ended
      ? { state: "failed", unit: ended.name, units }
      : { state: "finished", units };
}

/** What a key does: the item to focus, the unit to expand or collapse, the list to show more of. */
export type TreeMove = { focus?: string; toggle?: OrgUnit; more?: string };

/**
 * The WAI-ARIA tree keys on the visible items. Null for a key the tree does not use; an empty move
 * for one it uses that does nothing here.
 */
export function treeKey(
  items: TreeNode[],
  current: string,
  key: string,
): TreeMove | null {
  const index = items.findIndex((item) => item.key === current);
  const item = items[index];
  if (!item) return null;
  switch (key) {
    case "ArrowDown":
      return { focus: items[Math.min(index + 1, items.length - 1)].key };
    case "ArrowUp":
      return { focus: items[Math.max(index - 1, 0)].key };
    case "Home":
      return { focus: items[0].key };
    case "End":
      return { focus: items[items.length - 1].key };
    case "ArrowRight":
      if (item.kind !== "unit") return {};
      if (!item.expanded) return { toggle: item.unit };
      return item.children.length ? { focus: item.children[0].key } : {};
    case "ArrowLeft":
      if (item.kind === "unit" && item.expanded) return { toggle: item.unit };
      return item.path.length ? { focus: item.path[item.path.length - 1] } : {};
    case "Enter":
    case " ":
      if (item.kind === "unit") return { toggle: item.unit };
      if (item.kind === "more") return { more: item.listKey };
      return {};
    default:
      return null;
  }
}

/** The tab stop: the focused item while visible, else its nearest visible unit, else the first item. */
export function resolveFocus(
  items: TreeNode[],
  focused: TreeFocus | null,
): string | null {
  const shown = new Set(items.map((item) => item.key));
  if (focused && shown.has(focused.key)) return focused.key;
  const ancestor = focused?.path.findLast((key) => shown.has(key));
  return ancestor ?? items[0]?.key ?? null;
}

export const zoomTo = (zoom: number) =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/** CSS pixels of the exported image's layout. */
export const LAYOUT = {
  width: 200,
  unit: 66,
  position: 46,
  more: 36,
  gapX: 16,
  gapY: 32,
  stack: 8,
  margin: 24,
  line: 18,
};
export interface LayoutBox {
  key: string;
  kind: TreeNode["kind"];
  x: number;
  y: number;
  width: number;
  height: number;
  /** Bold first line, then the details. */
  lines: string[];
  dashed: boolean;
}
export interface TreeLayout {
  width: number;
  height: number;
  boxes: LayoutBox[];
  /** Connector lines as [x1, y1, x2, y2]. */
  lines: [number, number, number, number][];
}

const boxLines = (node: TreeNode): string[] =>
  node.kind === "unit"
    ? [
        node.unit.name,
        `${node.unit.code} · ${node.levelName}`,
        ...(node.positions !== null ? [unitCounts(node)] : []),
      ]
    : node.kind === "position"
      ? [
          node.position.title,
          [
            node.position.code,
            ...(node.position.isManager ? ["Manager"] : []),
            ...(node.position.vacant === true ? ["Vacant"] : []),
          ].join(" · "),
        ]
      : [node.label];

/**
 * The tree as drawn top-down: each unit's box with its positions stacked under it, and its units
 * side by side below, centred over them. Boxes never overlap.
 */
export function treeLayout(nodes: TreeNode[]): TreeLayout {
  const { width: W, gapX, gapY, stack, margin } = LAYOUT;
  const widths = new Map<TreeNode, number>();
  const row = (node: TreeNode) =>
    node.children.filter((child) => child.kind !== "position");
  const measure = (node: TreeNode): number => {
    const children = row(node);
    const span =
      children.reduce((sum, child) => sum + measure(child), 0) +
      gapX * Math.max(children.length - 1, 0);
    const width = Math.max(W, span);
    widths.set(node, width);
    return width;
  };
  const boxes: LayoutBox[] = [];
  const lines: TreeLayout["lines"] = [];
  let bottom = 0;
  const box = (node: TreeNode, x: number, y: number, height: number) => {
    boxes.push({
      key: node.key,
      kind: node.kind,
      x,
      y,
      width: W,
      height,
      lines: boxLines(node),
      dashed: node.kind === "position" && node.position.vacant === true,
    });
    bottom = Math.max(bottom, y + height);
  };
  const place = (node: TreeNode, left: number, top: number) => {
    const width = widths.get(node)!;
    const x = left + (width - W) / 2;
    const centre = x + W / 2;
    if (node.kind !== "unit") {
      box(node, x, top, node.kind === "more" ? LAYOUT.more : LAYOUT.position);
      return;
    }
    box(node, x, top, LAYOUT.unit);
    let y = top + LAYOUT.unit;
    for (const child of node.children)
      if (child.kind === "position") {
        lines.push([centre, y, centre, y + stack]);
        box(child, x, y + stack, LAYOUT.position);
        y += stack + LAYOUT.position;
      }
    const children = row(node);
    if (!children.length) return;
    const bar = y + gapY / 2;
    const rowTop = y + gapY;
    lines.push([centre, y, centre, bar]);
    const span =
      children.reduce((sum, child) => sum + widths.get(child)!, 0) +
      gapX * (children.length - 1);
    let childLeft = left + (width - span) / 2;
    const centres: number[] = [];
    for (const child of children) {
      const childWidth = widths.get(child)!;
      const childCentre = childLeft + childWidth / 2;
      centres.push(childCentre);
      lines.push([childCentre, bar, childCentre, rowTop]);
      place(child, childLeft, rowTop);
      childLeft += childWidth + gapX;
    }
    if (centres.length > 1)
      lines.push([centres[0], bar, centres[centres.length - 1], bar]);
  };
  let left = margin;
  for (const node of nodes) {
    const width = measure(node);
    place(node, left, margin);
    left += width + gapX * 2;
  }
  return {
    width: Math.max(left - gapX * 2 + margin, W + margin * 2),
    height: bottom + margin,
    boxes,
    lines,
  };
}

/** Twice the CSS size for sharpness, scaled down so neither side passes 16,384 pixels. */
export const exportScale = (layout: Pick<TreeLayout, "width" | "height">) =>
  Math.min(2, 16384 / layout.width, 16384 / layout.height);

/** The text, cut with "…" to fit the width. */
export function fitText(
  text: string,
  width: number,
  measure: (text: string) => number,
) {
  if (measure(text) <= width) return text;
  let end = text.length;
  while (end > 0 && measure(`${text.slice(0, end).trimEnd()}…`) > width) end--;
  return `${text.slice(0, end).trimEnd()}…`;
}

/** Draws the layout on a white background with dark text, at the given scale. */
export function drawLayout(
  context: CanvasRenderingContext2D,
  layout: TreeLayout,
  scale: number,
) {
  context.scale(scale, scale);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, layout.width, layout.height);
  context.strokeStyle = "#8a93a6";
  context.lineWidth = 1.5;
  for (const [x1, y1, x2, y2] of layout.lines) {
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
  }
  context.textBaseline = "alphabetic";
  for (const item of layout.boxes) {
    context.fillStyle = "#ffffff";
    context.fillRect(item.x, item.y, item.width, item.height);
    context.setLineDash(item.dashed ? [6, 4] : []);
    context.strokeStyle =
      item.kind === "unit" ? "#4338ca" : item.dashed ? "#88520c" : "#5b6474";
    context.lineWidth = item.kind === "unit" ? 2 : 1;
    context.strokeRect(item.x, item.y, item.width, item.height);
    context.setLineDash([]);
    item.lines.forEach((text, index) => {
      context.font = `${index ? "400 12px" : "700 13px"} Arial, sans-serif`;
      context.fillStyle = index ? "#454d5c" : "#191c28";
      context.fillText(
        fitText(
          text,
          item.width - 20,
          (part) => context.measureText(part).width,
        ),
        item.x + 10,
        item.y + 20 + index * LAYOUT.line,
      );
    });
  }
}

/** org-tree-by-units-YYYY-MM-DD.png, by the local date. */
export const imageFilename = (now: Date) =>
  `org-tree-by-units-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}.png`;
