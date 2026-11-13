import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
}));

import {
  EMPTY_CHART,
  loadUnit,
  type ChartState,
} from "../src/components/settings/organisation-tab";
import {
  EXPAND_ALL_LIMIT,
  EXPAND_ALL_PARALLEL,
  buildTree,
  countsText,
  expandAll,
  expandMessage,
  exportScale,
  fitText,
  flattenTree,
  imageFilename,
  treeCounts,
  treeLayout,
  type ExpandStatus,
  type UnitNode,
} from "../src/components/settings/org-tree";
import type { Requester } from "../src/components/workspace/optimistic";
import type { Position } from "../src/lib/directory";
import type { OrgUnit } from "../src/lib/org";
import {
  EMPTY_PEOPLE,
  loadReports,
  type PeopleState,
} from "../src/components/settings/organisation-tab";
import {
  buildPeopleTree,
  expandAllPeople,
  peopleCount,
  peopleCountsText,
  peopleExpandMessage,
  type PeopleExpandStatus,
  type PersonNode,
} from "../src/components/settings/org-tree";
import type { ReportingPerson } from "../src/lib/directory";

// Fictional units, positions and ids only (ADM-22, job 071); no database.
const id = (n: number) =>
  `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
const LEVEL = id(1);
const levelNames = new Map([[LEVEL, "Fictional Level"]]);
const unit = (n: number, parentId: string | null = null): OrgUnit => ({
  id: id(n),
  parentId,
  levelId: LEVEL,
  name: `Fictional Unit ${n}`,
  code: `FU-${n}`,
  validFrom: "2026-11-01T09:00:00.000Z",
  archivedAt: null,
  hasChildren: true,
});
const position = (
  n: number,
  orgUnitId: string,
  vacant?: boolean | null,
): Position => ({
  id: id(n),
  orgUnitId,
  title: `Fictional Position ${n}`,
  code: `FP-${n}`,
  isManager: false,
  jobRoleId: null,
  jobTitleKey: null,
  validFrom: "2026-11-01T09:00:00.000Z",
  archivedAt: null,
  ...(vacant !== undefined ? { vacant } : {}),
});
const top = [unit(10), unit(11)];
const below = [unit(12, top[0].id), unit(13, top[0].id)];
const deeper = [unit(14, below[0].id)];
/** Unit 10 and unit 12 expanded and loaded; unit 13 loaded but collapsed; unit 11 not loaded. */
const chart = (changes: Partial<ChartState> = {}): ChartState => ({
  ...EMPTY_CHART,
  lists: {
    "": { units: top, page: 1, hasMore: true },
    [top[0].id]: { units: below, page: 1, hasMore: false },
    [below[0].id]: { units: deeper, page: 1, hasMore: true },
    [below[1].id]: { units: [unit(15, below[1].id)], page: 1, hasMore: false },
  },
  contents: {
    [top[0].id]: {
      positions: [
        position(20, top[0].id, false),
        position(21, top[0].id, true),
      ],
      positionsHasMore: false,
    },
    [below[0].id]: {
      positions: [position(22, below[0].id, true)],
      positionsHasMore: false,
    },
    [below[1].id]: {
      positions: [position(23, below[1].id, false)],
      positionsHasMore: false,
    },
  },
  expanded: [top[0].id, below[0].id],
  ...changes,
});
const visible = (state: ChartState) =>
  flattenTree(buildTree(state, levelNames));

describe("the visible tree", () => {
  it("lists each unit, then its positions, units and Show more, depth first, with level and set position", () => {
    const items = visible(chart());
    expect(
      items.map((item) => [item.key, item.level, item.posInSet, item.setSize]),
    ).toEqual([
      [`unit:${id(10)}`, 1, 1, 3],
      [`position:${id(20)}`, 2, 1, 4],
      [`position:${id(21)}`, 2, 2, 4],
      [`unit:${id(12)}`, 2, 3, 4],
      [`position:${id(22)}`, 3, 1, 3],
      [`unit:${id(14)}`, 3, 2, 3],
      [`more:${id(12)}`, 3, 3, 3],
      [`unit:${id(13)}`, 2, 4, 4],
      [`unit:${id(11)}`, 1, 2, 3],
      ["more:", 1, 3, 3],
    ]);
    // A collapsed unit hides what was loaded below it; the path names the units above.
    expect(items.map((item) => item.key)).not.toContain(`position:${id(23)}`);
    expect(items.map((item) => item.key)).not.toContain(`unit:${id(15)}`);
    expect(items.find((item) => item.key === `unit:${id(14)}`)?.path).toEqual([
      `unit:${id(10)}`,
      `unit:${id(12)}`,
    ]);
    expect(items.at(-1)?.label).toBe("Show more top-level units");
    expect(items[6].label).toBe("Show more units below Fictional Unit 12");
  });

  it("names units with code, level and, once loaded, their counts", () => {
    const items = visible(
      chart({ expanded: [top[0].id, top[1].id], busy: [`load:${id(11)}`] }),
    );
    const named = (n: number) =>
      items.find((item) => item.key === `unit:${id(n)}`) as UnitNode;
    expect(named(10).label).toBe(
      "Fictional Unit 10, FU-10, Fictional Level, 2 positions, 1 vacant",
    );
    expect(named(10).expanded).toBe(true);
    expect(named(13).label).toBe(
      "Fictional Unit 13, FU-13, Fictional Level, 1 position, 0 vacant",
    );
    expect(named(11)).toMatchObject({
      loading: true,
      positions: null,
      label: "Fictional Unit 11, FU-11, Fictional Level, loading",
    });
    const failed = visible(
      chart({
        expanded: [top[1].id],
        errors: { [`load:${id(11)}`]: "Fictional refusal." },
      }),
    ).find((item) => item.key === `unit:${id(11)}`) as UnitNode;
    expect(failed).toMatchObject({ failed: true, loading: false });
    expect(failed.label).toContain("could not load");
  });
});

describe("vacancy counts", () => {
  it("counts every loaded unit and position, and vacant ones only when vacancy is known", () => {
    const counts = treeCounts(chart());
    expect(counts).toEqual({
      units: 6,
      positions: 4,
      vacant: 2,
      unknown: false,
    });
    expect(countsText(counts)).toBe("Loaded: 6 units · 4 positions · 2 vacant");
    for (const unknown of [null, undefined]) {
      const blind = chart({
        contents: {
          [top[0].id]: {
            positions: [
              position(20, top[0].id, unknown),
              position(21, top[0].id, unknown),
            ],
            positionsHasMore: false,
          },
        },
      });
      const blindCounts = treeCounts(blind);
      expect(blindCounts).toMatchObject({ vacant: null, unknown: true });
      expect(countsText(blindCounts)).toBe("Loaded: 6 units · 2 positions");
      const holding = visible(blind)[0] as UnitNode;
      expect(holding.vacant).toBeNull();
      expect(holding.label).toBe(
        "Fictional Unit 10, FU-10, Fictional Level, 2 positions",
      );
      expect(visible(blind)[1].label).toBe("Fictional Position 20, FP-20");
    }
    expect(visible(chart())[2].label).toBe(
      "Fictional Position 21, FP-21, Vacant",
    );
    expect(
      countsText(
        treeCounts({
          lists: { "": { units: [top[0]], page: 1, hasMore: false } },
          contents: {},
        }),
      ),
    ).toBe("Loaded: 1 unit · 0 positions");
  });
});

describe("the image layout", () => {
  it("places every expanded unit's positions and units, none for a collapsed unit, and no boxes overlap", () => {
    const nodes = buildTree(chart(), levelNames);
    const layout = treeLayout(nodes);
    expect(layout.boxes.map((box) => box.key)).toEqual(
      flattenTree(nodes).map((item) => item.key),
    );
    const keys = layout.boxes.map((box) => box.key);
    expect(keys).not.toContain(`position:${id(23)}`);
    expect(keys).not.toContain(`unit:${id(15)}`);
    const boxOf = (key: string) => layout.boxes.find((box) => box.key === key)!;
    // Positions stack under their unit; child units sit below the last position.
    const holding = boxOf(`unit:${id(10)}`);
    const first = boxOf(`position:${id(20)}`);
    const second = boxOf(`position:${id(21)}`);
    expect(first.x).toBe(holding.x);
    expect(first.y).toBeGreaterThanOrEqual(holding.y + holding.height);
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
    expect(boxOf(`unit:${id(12)}`).y).toBeGreaterThan(second.y + second.height);
    expect(second).toMatchObject({
      dashed: true,
      lines: ["Fictional Position 21", "FP-21 · Vacant"],
    });
    expect(first.dashed).toBe(false);
    expect(holding.lines).toEqual([
      "Fictional Unit 10",
      "FU-10 · Fictional Level",
      "2 positions · 1 vacant",
    ]);
    for (const [index, a] of layout.boxes.entries())
      for (const b of layout.boxes.slice(index + 1))
        expect(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y,
          `${a.key} and ${b.key}`,
        ).toBe(true);
    for (const box of layout.boxes) {
      expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
      expect(box.y + box.height).toBeLessThanOrEqual(layout.height);
    }
    expect(layout.lines.length).toBeGreaterThan(0);
    // Collapsed, the unit is one box.
    expect(
      treeLayout(buildTree(chart({ expanded: [] }), levelNames)).boxes.map(
        (box) => box.key,
      ),
    ).toEqual([`unit:${id(10)}`, `unit:${id(11)}`, "more:"]);
  });

  it("draws at twice the size, at most 16,384 pixels a side, and cuts text with an ellipsis", () => {
    expect(exportScale({ width: 1000, height: 400 })).toBe(2);
    expect(exportScale({ width: 16384, height: 400 })).toBe(1);
    expect(exportScale({ width: 400, height: 32768 })).toBe(0.5);
    const measure = (text: string) => text.length * 10;
    expect(fitText("Short", 100, measure)).toBe("Short");
    expect(fitText("A fictional unit name", 100, measure)).toBe("A fiction…");
    expect(
      measure(fitText("A fictional unit name", 100, measure)),
    ).toBeLessThanOrEqual(100);
    expect(imageFilename(new Date(2026, 10, 9, 23, 30))).toBe(
      "org-tree-by-units-2026-11-09.png",
    );
  });
});

/** A fake request: every unit has `children` units below it and two positions. */
function fakeOrg(children: number) {
  const paths: string[] = [];
  let next = 1000;
  let inFlight = 0;
  let most = 0;
  const request = (async (path: string) => {
    paths.push(path);
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlight--;
    const url = new URL(path, "http://localhost");
    const parent =
      url.searchParams.get("parentId") ?? url.searchParams.get("unitId")!;
    const data = url.pathname.endsWith("/positions")
      ? [position(next++, parent, true), position(next++, parent, false)]
      : Array.from({ length: children }, () => unit(next++, parent));
    return {
      data,
      pagination: { page: 1, pageSize: 100, hasMore: false },
    };
  }) as Requester;
  return { paths, request, most: () => most };
}

/** Runs Expand all on the chart and applies its results as the tab does. */
async function runExpandAll(start: ChartState, request: Requester) {
  let state = start;
  const progress: number[] = [];
  const status: ExpandStatus = await expandAll(
    start,
    (unitId) => loadUnit(request, unitId),
    {
      loaded(item, units, positions) {
        state = {
          ...state,
          lists: {
            ...state.lists,
            [item.id]: { units: units.data, page: 1, hasMore: false },
          },
          contents: {
            ...state.contents,
            [item.id]: { positions: positions.data, positionsHasMore: false },
          },
          expanded: [...state.expanded, item.id],
        };
      },
      expanded(item) {
        state = { ...state, expanded: [...state.expanded, item.id] };
      },
      progress: (units) => progress.push(units),
    },
  );
  return { state, status, progress };
}

describe("Expand all", () => {
  it("stops at 500 units, says so, and requests only units and positions", async () => {
    const fake = fakeOrg(100);
    const start: ChartState = {
      ...EMPTY_CHART,
      lists: { "": { units: [unit(1)], page: 1, hasMore: false } },
    };
    const { state, status, progress } = await runExpandAll(start, fake.request);
    const units = treeCounts(state).units;
    expect(units).toBeLessThanOrEqual(EXPAND_ALL_LIMIT);
    expect(units).toBe(401);
    expect(status).toEqual({ state: "limit", units: 401 });
    expect(expandMessage(status)).toBe(
      "Expand all stopped at the limit of 500 units. Expand a unit to see the units below it.",
    );
    expect(Math.max(...progress)).toBeLessThanOrEqual(EXPAND_ALL_LIMIT);
    // Two requests per unit, at most four units at a time, never the employees route.
    expect(fake.most()).toBeLessThanOrEqual(EXPAND_ALL_PARALLEL * 2);
    for (const path of fake.paths)
      expect(path).toMatch(
        /^\/api\/v1\/(org-units\?parentId=[0-9a-f-]+&page=1&pageSize=100|positions\?unitId=[0-9a-f-]+&page=1&pageSize=200)$/,
      );
    expect(fake.paths.some((path) => path.includes("employees"))).toBe(false);
    // The units that did not fit stay collapsed with nothing loaded.
    for (const unitId of state.expanded)
      expect(state.lists[unitId]).toBeDefined();
  });

  it("finishes a small tree, expanding loaded units without a request, and reports its count", async () => {
    const fake = fakeOrg(0);
    const { state, status } = await runExpandAll(
      chart({ expanded: [] }),
      fake.request,
    );
    expect(status).toEqual({ state: "finished", units: 6 });
    expect(expandMessage(status)).toBe("Expand all finished: 6 units loaded.");
    // Units 10, 12 and 13 were loaded: expanded with no request. 11, 14 and 15 load once each.
    expect(new Set(state.expanded)).toEqual(
      new Set([10, 11, 12, 13, 14, 15].map(id)),
    );
    expect(fake.paths).toHaveLength(6);
    for (const n of [11, 14, 15])
      expect(fake.paths).toContain(
        `/api/v1/positions?unitId=${id(n)}&page=1&pageSize=200`,
      );
    // Show more pages are not loaded.
    expect(fake.paths.some((path) => path.includes("page=2"))).toBe(false);
  });

  it("stops at the first load error and names the unit", async () => {
    const failed: string[] = [];
    const status = await expandAll(
      chart({ expanded: [] }),
      async () => {
        throw new Error("Fictional network error.");
      },
      { failed: (item) => failed.push(item.name) },
    );
    expect(status).toEqual({
      state: "failed",
      unit: "Fictional Unit 11",
      units: 6,
    });
    expect(expandMessage(status)).toBe(
      "Expand all stopped because Fictional Unit 11 could not load.",
    );
    expect(failed[0]).toBe("Fictional Unit 11");
  });
});

// The org tree by people (ADM-23, job 074): fictional people only; no database.
const person = (
  n: number,
  reports = 0,
  changes: Partial<ReportingPerson> = {},
): ReportingPerson => ({
  id: id(n),
  displayName: `Fictional Person ${n}`,
  title: `Fictional Title ${n}`,
  unitName: `Fictional Unit ${n}`,
  otherPositions: 0,
  reports,
  ...changes,
});
const roots = [person(40, 2, { otherPositions: 1 }), person(41), person(42, 1)];
const reportsOf40 = [person(43, 1), person(44)];
/** 40 and 43 expanded and loaded; 42 loaded but collapsed; the top level and 43's level have more. */
const peopleState = (changes: Partial<PeopleState> = {}): PeopleState => ({
  ...EMPTY_PEOPLE,
  lists: {
    "": { people: roots, page: 1, hasMore: true },
    [id(40)]: { people: reportsOf40, page: 1, hasMore: false },
    [id(43)]: { people: [person(45)], page: 1, hasMore: true },
    [id(42)]: { people: [person(46)], page: 1, hasMore: false },
  },
  // 41 has no reports, so listing it as expanded changes nothing.
  expanded: [id(40), id(43), id(41)],
  ...changes,
});

describe("the visible tree by people", () => {
  it("lists each person, then their reports and Show more, depth first, with level, set position, path and label", () => {
    const items = flattenTree(buildPeopleTree(peopleState()));
    expect(
      items.map((item) => [item.key, item.level, item.posInSet, item.setSize]),
    ).toEqual([
      [`person:${id(40)}`, 1, 1, 4],
      [`person:${id(43)}`, 2, 1, 2],
      [`person:${id(45)}`, 3, 1, 2],
      [`more:${id(43)}`, 3, 2, 2],
      [`person:${id(44)}`, 2, 2, 2],
      [`person:${id(41)}`, 1, 2, 4],
      [`person:${id(42)}`, 1, 3, 4],
      ["more:", 1, 4, 4],
    ]);
    // A collapsed person hides what was loaded below them.
    expect(items.map((item) => item.key)).not.toContain(`person:${id(46)}`);
    expect(items[2].path).toEqual([`person:${id(40)}`, `person:${id(43)}`]);
    const named = (n: number) =>
      items.find((item) => item.key === `person:${id(n)}`) as PersonNode;
    expect(named(40).label).toBe(
      "Fictional Person 40, Fictional Title 40, Fictional Unit 40, and 1 more position, 2 direct reports",
    );
    expect(named(43).label).toBe(
      "Fictional Person 43, Fictional Title 43, Fictional Unit 43, 1 direct report",
    );
    expect(named(41).label).toBe(
      "Fictional Person 41, Fictional Title 41, Fictional Unit 41",
    );
    expect([40, 41, 42, 43].map((n) => named(n).expanded)).toEqual([
      true,
      false,
      false,
      true,
    ]);
    expect(items[3].label).toBe(
      "Show more people reporting to Fictional Person 43",
    );
    expect(items.at(-1)?.label).toBe("Show more top-level people");
    // Loading and failed only while expanded.
    const loading = flattenTree(
      buildPeopleTree(peopleState({ expanded: [id(44), id(42)] })),
    );
    expect(
      loading.find((item) => item.key === `person:${id(42)}`),
    ).toMatchObject({ loading: false, expanded: true });
    const pending = flattenTree(
      buildPeopleTree(
        peopleState({
          lists: { "": { people: roots, page: 1, hasMore: false } },
          expanded: [id(40), id(42)],
          errors: { [`load:${id(42)}`]: "Fictional refusal." },
        }),
      ),
    );
    expect(pending[0]).toMatchObject({ loading: true, failed: false });
    expect(pending[0].label).toMatch(/, loading$/);
    expect(pending[2]).toMatchObject({ loading: false, failed: true });
    expect(pending[2].label).toMatch(/, could not load$/);
  });

  it("counts every loaded person", () => {
    expect(peopleCount(peopleState())).toBe(7);
    expect(peopleCountsText(peopleCount(peopleState()))).toBe(
      "Loaded: 7 people",
    );
    expect(peopleCountsText(1)).toBe("Loaded: 1 person");
    expect(peopleCount(EMPTY_PEOPLE)).toBe(0);
  });

  it("places every expanded person's reports below them, none for a collapsed person, and no boxes overlap", () => {
    const nodes = buildPeopleTree(peopleState());
    const layout = treeLayout(nodes);
    expect(layout.boxes.map((box) => box.key)).toEqual(
      flattenTree(nodes).map((item) => item.key),
    );
    const boxOf = (key: string) => layout.boxes.find((box) => box.key === key)!;
    expect(boxOf(`person:${id(40)}`).lines).toEqual([
      "Fictional Person 40",
      "Fictional Title 40 · Fictional Unit 40",
      "+1 more position",
      "2 direct reports",
    ]);
    expect(boxOf(`person:${id(44)}`).lines).toEqual([
      "Fictional Person 44",
      "Fictional Title 44 · Fictional Unit 44",
    ]);
    const top = boxOf(`person:${id(40)}`);
    for (const n of [43, 44])
      expect(boxOf(`person:${id(n)}`).y).toBeGreaterThan(top.y + top.height);
    expect(layout.boxes.map((box) => box.key)).not.toContain(
      `person:${id(46)}`,
    );
    for (const [index, a] of layout.boxes.entries())
      for (const b of layout.boxes.slice(index + 1))
        expect(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y,
          `${a.key} and ${b.key}`,
        ).toBe(true);
    for (const box of layout.boxes) {
      expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
      expect(box.y + box.height).toBeLessThanOrEqual(layout.height);
      expect(box.dashed).toBe(false);
    }
    expect(
      treeLayout(buildPeopleTree(peopleState({ expanded: [] }))).boxes.map(
        (box) => box.key,
      ),
    ).toEqual([
      `person:${id(40)}`,
      `person:${id(41)}`,
      `person:${id(42)}`,
      "more:",
    ]);
    expect(imageFilename(new Date(2026, 10, 9, 23, 30), "people")).toBe(
      "org-tree-by-people-2026-11-09.png",
    );
  });
});

/** A fake request: every person it returns has `reports` reports of their own. */
function fakePeople(size: number, reports: number) {
  const paths: string[] = [];
  let next = 2000;
  let inFlight = 0;
  let most = 0;
  const request = (async (path: string) => {
    paths.push(path);
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlight--;
    return {
      data: Array.from({ length: size }, () => person(next++, reports)),
      pagination: { page: 1, pageSize: 100, hasMore: false },
    };
  }) as Requester;
  return { paths, request, most: () => most };
}

/** Runs Expand all by people and applies its results as the tab does. */
async function runPeopleExpandAll(start: PeopleState, request: Requester) {
  let state = start;
  const progress: number[] = [];
  const status: PeopleExpandStatus = await expandAllPeople(
    start,
    (managerId) => loadReports(request, managerId),
    {
      loaded(item, page) {
        state = {
          ...state,
          lists: {
            ...state.lists,
            [item.id]: { people: page.data, page: 1, hasMore: false },
          },
          expanded: [...state.expanded, item.id],
        };
      },
      expanded(item) {
        state = { ...state, expanded: [...state.expanded, item.id] };
      },
      progress: (count) => progress.push(count),
    },
  );
  return { state, status, progress };
}

describe("Expand all by people", () => {
  it("stops at 500 people, says so, and requests only reporting lines of people with reports", async () => {
    const fake = fakePeople(100, 100);
    const start: PeopleState = {
      ...EMPTY_PEOPLE,
      lists: {
        "": { people: [person(1, 100), person(2)], page: 1, hasMore: false },
      },
    };
    const { state, status, progress } = await runPeopleExpandAll(
      start,
      fake.request,
    );
    const count = peopleCount(state);
    expect(count).toBeLessThanOrEqual(EXPAND_ALL_LIMIT);
    expect(count).toBe(402);
    expect(status).toEqual({ state: "limit", people: 402 });
    expect(peopleExpandMessage(status)).toBe(
      "Expand all stopped at the limit of 500 people. Expand a person to see who reports to them.",
    );
    expect(Math.max(...progress)).toBeLessThanOrEqual(EXPAND_ALL_LIMIT);
    expect(fake.most()).toBeLessThanOrEqual(EXPAND_ALL_PARALLEL);
    for (const path of fake.paths)
      expect(path).toMatch(
        /^\/api\/v1\/employees\/reporting-lines\?managerId=[0-9a-f-]+&page=1&pageSize=100$/,
      );
    // Person 2 has no reports and is never requested.
    expect(fake.paths.some((path) => path.includes(id(2)))).toBe(false);
    for (const managerId of state.expanded)
      expect(state.lists[managerId]).toBeDefined();
  });

  it("finishes a small tree, expanding loaded people without a request, and reports its count", async () => {
    const fake = fakePeople(1, 0);
    const { state, status } = await runPeopleExpandAll(
      peopleState({ expanded: [] }),
      fake.request,
    );
    // 40, 42 and 43 were loaded: expanded with no request; 45 has no reports.
    expect(status).toEqual({ state: "finished", people: 7 });
    expect(peopleExpandMessage(status)).toBe(
      "Expand all finished: 7 people loaded.",
    );
    expect(fake.paths).toEqual([]);
    expect(new Set(state.expanded)).toEqual(new Set([40, 42, 43].map(id)));
    const more = await runPeopleExpandAll(
      {
        ...EMPTY_PEOPLE,
        lists: { "": { people: [person(3, 1)], page: 1, hasMore: false } },
      },
      fake.request,
    );
    expect(more.status).toEqual({ state: "finished", people: 2 });
    expect(fake.paths).toEqual([
      `/api/v1/employees/reporting-lines?managerId=${id(3)}&page=1&pageSize=100`,
    ]);
    expect(peopleExpandMessage({ state: "finished", people: 1 })).toBe(
      "Expand all finished: 1 person loaded.",
    );
    expect(peopleExpandMessage({ state: "running", people: 120 })).toBe(
      "Expand all is loading people: 120 people loaded so far.",
    );
  });

  it("stops at the first load error and names the person", async () => {
    const failed: string[] = [];
    const status = await expandAllPeople(
      {
        lists: {
          "": { people: [person(5, 3), person(6, 2)], page: 1, hasMore: false },
        },
      },
      async () => {
        throw new Error("Fictional network error.");
      },
      { failed: (item) => failed.push(item.displayName) },
    );
    expect(status).toEqual({
      state: "failed",
      person: "Fictional Person 5",
      people: 2,
    });
    expect(peopleExpandMessage(status)).toBe(
      "Expand all stopped because the people reporting to Fictional Person 5 could not load.",
    );
    expect(failed[0]).toBe("Fictional Person 5");
  });
});
