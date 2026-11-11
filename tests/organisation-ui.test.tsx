import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
}));

import { WorkspaceProvider } from "../src/components/workspace/client";
import {
  adminTabs,
  type AdminTabKey,
} from "../src/components/settings/admin-tabs";
import {
  AdminPortalView,
  NO_ACCESS,
  type MeAccess,
} from "../src/components/settings/admin-portal";
import {
  AddLevelFormView,
  EMPTY_CHART,
  FormDialog,
  LEVELS_PATH,
  LevelsPanel,
  OrgChartPanel,
  loadChart,
  loadHolders,
  loadUnit,
  type ChartState,
} from "../src/components/settings/organisation-tab";
import {
  DirectoryFilterForm,
  DirectoryPaging,
  DirectoryTable,
  EmployeeActionsView,
  NO_FILTERS,
  directoryPath,
  rowActions,
} from "../src/components/settings/directory-tab";
import {
  UnitPickerView,
  pickerPath,
} from "../src/components/settings/unit-picker";
import type { Requester } from "../src/components/workspace/optimistic";
import {
  TREE_START,
  type TreeState,
} from "../src/components/settings/organisation-tab";
import {
  buildTree,
  flattenTree,
  resolveFocus,
  treeKey,
} from "../src/components/settings/org-tree";
import type { Action } from "../src/domain/config";
import type { Employee, Position } from "../src/lib/directory";
import type { OrgLevel, OrgUnit } from "../src/lib/org";
import {
  EMPTY_PEOPLE,
  PeopleTreeView,
  loadReports,
  peopleViewAllowed,
  reportingPath,
  type PeopleState,
} from "../src/components/settings/organisation-tab";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  buildPeopleTree,
} from "../src/components/settings/org-tree";
import type { ReportingPerson } from "../src/lib/directory";
import { readFileSync } from "node:fs";
import {
  AMOUNT_ERROR,
  BRACKET_ORDER_ERROR,
  CONFIDENTIAL_NOTICE,
  JobArchitectureView,
  SalaryBracketsForm,
  aedToFils,
  bracketPrefill,
  checkBracketRows,
  filsToAed,
  gradeError,
  gradesInOrder,
  loadJobArchitecture,
  loadSalaryBrackets,
  saveJobArchitecture,
  saveSalaryBrackets,
  type BracketState,
  type JobArchitectureState,
  type JobView,
} from "../src/components/settings/job-architecture-panel";
import { tabKeys } from "../src/components/ui/tab-keys";
import type { JobArchitectureBody } from "../src/domain/config";
import type { SalaryBracketVersion } from "../src/lib/pay-brackets";

// Fictional people, units and ids only (R2a-16, job 058).
const workspace = {
  user: {
    id: "fictional-org-user",
    name: "Fictional Org User",
    email: "org-user@example.test",
    twoStepEnabled: true,
  },
  team: { id: "fictional-team", name: "Fictional Team", slug: "fictional" },
  role: "owner",
  environment: "Local development",
  canCreateTeam: true,
};
const TEAM_ROLES = ["owner", "admin", "recruiter", "viewer", null] as const;
const COMPANY_LEVELS = ["owner", "admin", null] as const;
const ALL_DIRECTORY: Action[] = ["view", "create", "edit", "archive"];
const id = (n: number) =>
  `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
const access = (
  teamRole: string | null,
  companyLevel: MeAccess["companyLevel"],
  options: {
    organisation?: boolean;
    directory?: Action[];
    planAccess?: MeAccess["planAccess"];
  } = {},
): MeAccess => ({
  teamRole,
  companyLevel,
  teamArchived: false,
  planAccess: options.planAccess ?? { read: false, write: false },
  role: { name: "Fictional role", membership: "recruiter" },
  scopes: [],
  pages: [],
  actions: options.directory ? { directory: options.directory } : {},
  fields: {},
  adminAreas: options.organisation ? ["organisation"] : [],
});
const render = (tab: AdminTabKey | null, value: MeAccess) =>
  renderToStaticMarkup(
    <WorkspaceProvider value={workspace}>
      <AdminPortalView tab={tab} access={value} denied={false} error="" />
    </WorkspaceProvider>,
  );

const levels: OrgLevel[] = [
  { id: id(1), name: "Fictional Company", depth: 0, archivedAt: null },
  { id: id(2), name: "Fictional Division", depth: 1, archivedAt: null },
  {
    id: id(3),
    name: "Fictional Old Level",
    depth: 3,
    archivedAt: "2026-10-01T09:00:00.000Z",
  },
];
const unit = (
  n: number,
  name: string,
  parentId: string | null,
  levelId = id(1),
): OrgUnit => ({
  id: id(n),
  parentId,
  levelId,
  name,
  code: `FU-${n}`,
  validFrom: "2026-11-01T09:00:00.000Z",
  archivedAt: null,
  hasChildren: false,
});
const holdings = { ...unit(10, "Fictional Holdings", null), hasChildren: true };
const sample = unit(11, "Sample Group", null);
const sales = unit(12, "Fictional Sales", holdings.id, id(2));
const position = (
  n: number,
  title: string,
  orgUnitId: string,
  isManager = false,
): Position => ({
  id: id(n),
  orgUnitId,
  title,
  code: `FP-${n}`,
  isManager,
  jobRoleId: null,
  jobTitleKey: null,
  validFrom: "2026-11-01T09:00:00.000Z",
  archivedAt: null,
});
const lead = position(20, "Fictional Lead", holdings.id, true);
const analyst = position(21, "Fictional Analyst", holdings.id);
const employee = (
  n: number,
  displayName: string,
  changes: Partial<Employee> = {},
): Employee => ({
  id: id(n),
  displayName,
  employeeNumber: `EMP-${n}`,
  status: "active",
  retentionClass: "standard",
  source: "app",
  userId: null,
  positions: [],
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-01T09:00:00.000Z",
  archivedAt: null,
  ...changes,
});
/** Holdings expanded with its positions and one collapsed child; Sample Group collapsed. */
const chart = (changes: Partial<ChartState> = {}): ChartState => ({
  ...EMPTY_CHART,
  lists: {
    "": { units: [holdings, sample], page: 1, hasMore: true },
    [holdings.id]: { units: [sales], page: 1, hasMore: false },
  },
  contents: {
    [holdings.id]: { positions: [lead, analyst], positionsHasMore: false },
  },
  expanded: [holdings.id],
  ...changes,
});
const orgChart = (
  owner: boolean,
  directoryView = true,
  state: ChartState = chart(),
) =>
  renderToStaticMarkup(
    <OrgChartPanel
      levels={levels}
      chart={state}
      owner={owner}
      directoryView={directoryView}
    />,
  );
/** A fake request that records each path and answers an empty page. */
function recorder() {
  const paths: string[] = [];
  const request = (async (path: string) => {
    paths.push(path);
    return {
      data: [],
      pagination: { page: 1, pageSize: 25, hasMore: false },
    };
  }) as Requester;
  return { paths, request };
}

describe("organisation and directory tab visibility", () => {
  it("lists Organisation for a company owner, and for a company admin only with the organisation area, and Directory only with directory view", () => {
    for (const teamRole of TEAM_ROLES)
      for (const companyLevel of COMPANY_LEVELS)
        for (const organisation of [false, true])
          for (const directory of [undefined, ["view"], ["edit"]] as (
            Action[] | undefined
          )[]) {
            const keys = adminTabs({
              teamRole,
              companyLevel,
              adminAreas: organisation ? ["organisation"] : [],
              actions: directory ? { directory } : {},
            }).map((tab) => tab.key);
            const label = `${teamRole} / ${companyLevel} / ${organisation} / ${directory}`;
            expect(keys.includes("organisation"), label).toBe(
              companyLevel === "owner" ||
                (companyLevel === "admin" && organisation),
            );
            expect(keys.includes("directory"), label).toBe(
              !!directory?.includes("view"),
            );
          }
  });

  it("never lists Organisation for a team owner or admin without company authority", () => {
    for (const teamRole of ["owner", "admin"])
      expect(
        adminTabs({
          teamRole,
          companyLevel: null,
          adminAreas: ["organisation"],
        }).map((tab) => tab.key),
      ).not.toContain("organisation");
  });

  it("gives exactly the no-access text to a caller without the tab", () => {
    for (const [tab, value] of [
      ["organisation", access("owner", "admin")],
      ["organisation", access("owner", null, { organisation: true })],
      ["organisation", access("recruiter", null, { directory: ["view"] })],
      ["directory", access("owner", "owner")],
      ["directory", access("admin", "admin", { directory: ["edit"] })],
    ] as const) {
      const markup = render(tab, value);
      expect(markup, tab).toContain(`<p>${NO_ACCESS}</p>`);
      expect(markup, tab).not.toContain("Admin portal sections");
      expect(markup, tab).not.toMatch(/<h2|<table|role="status"/);
    }
  });

  it("opens the Organisation tab for a company admin with the area and the Directory with view", () => {
    const admin = render(
      "organisation",
      access("viewer", "admin", { organisation: true }),
    );
    expect(admin).toContain(
      'aria-current="page" href="/app/admin/organisation"',
    );
    expect(admin).toContain("<h2>Levels</h2>");
    expect(admin).toContain("<h2>Org chart</h2>");
    expect(admin).toContain('<p role="status">Loading the org chart…</p>');
    const reader = render(
      "directory",
      access("recruiter", null, { directory: ["view"] }),
    );
    expect(reader).toContain('aria-current="page" href="/app/admin/directory"');
    expect(reader).toContain("<h2>Directory</h2>");
    expect(reader).not.toContain("Add employee");
  });
});

describe("org chart loading", () => {
  it("loads only the levels and the top-level units when the tab opens", async () => {
    const { paths, request } = recorder();
    await loadChart(request);
    expect(LEVELS_PATH).toBe("/api/v1/org-units/levels");
    expect(paths).toEqual([
      "/api/v1/org-units/levels",
      "/api/v1/org-units?page=1&pageSize=100",
    ]);
  });

  it("loads only a unit's children and positions on expand, and employees only for a position", async () => {
    const { paths, request } = recorder();
    await loadUnit(request, holdings.id);
    expect(paths).toEqual([
      `/api/v1/org-units?parentId=${holdings.id}&page=1&pageSize=100`,
      `/api/v1/positions?unitId=${holdings.id}&page=1&pageSize=200`,
    ]);
    await loadHolders(request, lead.id);
    await loadHolders(request, lead.id, 2);
    expect(paths.slice(2)).toEqual([
      `/api/v1/employees?positionId=${lead.id}&page=1&pageSize=25`,
      `/api/v1/employees?positionId=${lead.id}&page=2&pageSize=25`,
    ]);
    // No chart request reaches the employees route without a position.
    for (const path of paths.filter((item) =>
      item.startsWith("/api/v1/employees"),
    ))
      expect(
        new URL(path, "http://localhost").searchParams.get("positionId"),
      ).toBe(lead.id);
  });

  it("loads the unit picker one level at a time, 200 units per level", () => {
    expect(pickerPath(null)).toBe("/api/v1/org-units?page=1&pageSize=200");
    expect(pickerPath(holdings.id)).toBe(
      `/api/v1/org-units?parentId=${holdings.id}&page=1&pageSize=200`,
    );
    const markup = renderToStaticMarkup(
      <UnitPickerView
        levels={[
          {
            parentId: null,
            parentName: "",
            units: [holdings, sample],
            hasMore: true,
            chosen: holdings.id,
          },
          {
            parentId: holdings.id,
            parentName: holdings.name,
            units: [sales],
            hasMore: false,
            chosen: "",
          },
        ]}
        label="Unit"
        emptyLabel="Any unit"
        error=""
      />,
    );
    expect(markup).toMatch(/<label class="field"><span>Unit<\/span><select/);
    expect(markup).toContain(
      "<span>Unit below Fictional Holdings</span><select",
    );
    expect(markup).toContain('<option value="">Any unit</option>');
    expect(markup).toContain(
      "Only the first 200 units at this level are listed.",
    );
    expect(markup.match(/Only the first 200/g)).toHaveLength(1);
  });
});

describe("org chart", () => {
  it("renders a nested list with a native expand button per unit and no child list for a collapsed unit", () => {
    const markup = orgChart(true);
    for (const item of [holdings, sample, sales]) {
      const expanded = item.id === holdings.id;
      expect(markup, item.name).toMatch(
        new RegExp(
          `<button type="button" class="button secondary small" aria-expanded="${expanded}" aria-controls="org-unit-${item.id}">`,
        ),
      );
    }
    // Collapsed units render an empty, hidden region.
    for (const item of [sample, sales])
      expect(markup).toContain(
        `<div id="org-unit-${item.id}" hidden=""></div>`,
      );
    expect(markup).toContain(`<div id="org-unit-${holdings.id}">`);
    expect(markup).toContain('<ul aria-label="Top-level units"');
    expect(markup).toContain('<ul aria-label="Units below Fictional Holdings"');
    expect(markup).toContain(
      '<ul aria-label="Positions in Fictional Holdings"',
    );
    expect(markup).not.toContain("Units below Sample Group");
    expect(markup.match(/<ul /g)).toHaveLength(3);
    // Name, code and level per unit; title, code and the manager marker per position.
    expect(markup).toContain("FU-10 · Fictional Company");
    expect(markup).toContain("FU-12 · Fictional Division");
    expect(markup).toContain(
      '<strong>Fictional Lead</strong> <span class="muted small-text">FP-20</span> <span class="tag">Manager</span>',
    );
    expect(markup).not.toMatch(
      /Fictional Analyst<\/strong>[^<]*<span[^>]*>FP-21<\/span> <span class="tag">/,
    );
    expect(markup).toContain(">Show more units<");
  });

  it("offers Move and Archive on units and Move on positions only to a company owner", () => {
    const owner = orgChart(true);
    const admin = orgChart(false);
    const control = (label: string, name: string) =>
      `>${label}<span class="sr-only">: ${name}</span></button>`;
    for (const [label, name] of [
      ["Move", holdings.name],
      ["Archive", holdings.name],
      ["Move", sales.name],
      ["Archive", sales.name],
      ["Move", lead.title],
    ]) {
      expect(owner, `${label} ${name}`).toContain(control(label, name));
      expect(admin, `${label} ${name}`).not.toContain(control(label, name));
    }
    for (const markup of [owner, admin]) {
      expect(markup).toContain(">Add top-level unit</button>");
      for (const [label, name] of [
        ["Rename", holdings.name],
        ["Add unit below", holdings.name],
        ["Rename", sales.name],
        ["Add position", holdings.name],
        ["Edit", lead.title],
        ["Archive", lead.title],
        ["Archive", analyst.title],
      ])
        expect(markup, `${label} ${name}`).toContain(control(label, name));
    }
    // The level controls are the same for both.
    const panel = renderToStaticMarkup(
      <LevelsPanel levels={levels} errors={{}} />,
    );
    for (const name of ["Fictional Company", "Fictional Division"]) {
      expect(panel).toContain(control("Rename", name));
      expect(panel).toContain(control("Archive", name));
    }
    expect(panel).not.toContain(control("Rename", "Fictional Old Level"));
    expect(panel).toContain('data-label="Status">Archived<');
    expect(panel).toContain("<h3>Add level</h3>");
  });

  it("offers only the free depths when adding a level", () => {
    const form = renderToStaticMarkup(
      <AddLevelFormView
        name=""
        depth="2"
        free={[2, 4, 5, 6, 7]}
        busy={false}
        error=""
      />,
    );
    expect(form).toContain("<span>Level name</span><input required");
    expect(
      [...form.matchAll(/<option value="(\d)"/g)].map((match) => match[1]),
    ).toEqual(["2", "4", "5", "6", "7"]);
    expect(
      renderToStaticMarkup(
        <AddLevelFormView name="" depth="" free={[]} busy={false} error="" />,
      ),
    ).toContain("All eight depths, 0 to 7, have a level.");
  });

  it("shows who holds a position only with directory view, never contact fields", () => {
    const held = chart({
      holdersOpen: [lead.id],
      holders: {
        [lead.id]: {
          rows: [
            employee(30, "Fictional Holder", {
              workEmail: "holder@example.test",
              workPhone: "+00 0000 0000",
            }),
          ],
          page: 1,
          hasMore: true,
        },
      },
    });
    const reader = orgChart(false, true, held);
    expect(reader).toMatch(
      new RegExp(
        `<button type="button" class="button secondary small" aria-expanded="true" aria-controls="org-position-${lead.id}">Show employees`,
      ),
    );
    expect(reader).toMatch(
      new RegExp(
        `aria-expanded="false" aria-controls="org-position-${analyst.id}">Show employees`,
      ),
    );
    expect(reader).toContain("Fictional Holder (EMP-30)");
    expect(reader).toContain(
      '>Show more<span class="sr-only">: Fictional Lead</span>',
    );
    expect(reader).not.toContain("holder@example.test");
    expect(reader).not.toContain("+00 0000 0000");
    expect(reader).not.toContain("You need directory access");
    const blind = orgChart(false, false, held);
    expect(blind).not.toContain("Show employees");
    expect(blind).not.toContain("Fictional Holder");
    expect(blind).toContain(
      "You need directory access to see who holds these positions.",
    );
  });

  it("shows a refusal inline, with role alert, next to the row or form that caused it", () => {
    const refusal =
      "Only a company owner can move or archive a unit, because it changes who can see the records under it.";
    const row = orgChart(
      true,
      true,
      chart({ errors: { [`unit:${sales.id}`]: refusal } }),
    );
    expect(row).toContain(
      `Archive<span class="sr-only">: Fictional Sales</span></button></div></div><p class="notice error" role="alert">${refusal}</p><div id="org-unit-${sales.id}" hidden="">`,
    );
    const positionRefusal =
      "Only a company owner can link an employee to a user, change a linked employee&#x27;s positions, or move or archive a position a linked employee holds, because these set who can see which records.";
    expect(
      orgChart(
        false,
        true,
        chart({
          errors: {
            [`position:${analyst.id}`]:
              "Only a company owner can link an employee to a user, change a linked employee's positions, or move or archive a position a linked employee holds, because these set who can see which records.",
          },
        }),
      ),
    ).toContain(
      `Archive<span class="sr-only">: Fictional Analyst</span></button></div></div><p class="notice error" role="alert">${positionRefusal}</p>`,
    );
    const dialog = renderToStaticMarkup(
      <FormDialog
        title="Move unit: Fictional Sales"
        submitLabel="Move unit"
        busy={false}
        error="A unit cannot be moved under itself or under a unit below it."
        onSubmit={() => {}}
        onClose={() => {}}
      >
        <label className="field">
          <span>New parent unit</span>
          <select />
        </label>
      </FormDialog>,
    );
    expect(dialog).toMatch(
      /<form aria-describedby="([^"]+)"><div class="dialog-body stack"[^>]*><label class="field"><span>New parent unit<\/span><select><\/select><\/label><p id="\1" class="notice error" role="alert">A unit cannot be moved under itself or under a unit below it.<\/p><\/div>/,
    );
    const level = renderToStaticMarkup(
      <LevelsPanel
        levels={levels}
        errors={{
          [`level:${id(1)}`]:
            "The level or unit is archived, or still has current units below it. Reload the organisation and try again.",
        }}
      />,
    );
    // The refusal sits in its own full-width row right below the level's row.
    expect(level).toContain(
      'Archive<span class="sr-only">: Fictional Company</span></button></div></td></tr><tr><td colSpan="4"><p class="notice error" role="alert">The level or unit is archived',
    );
    const directoryRefusal = renderToStaticMarkup(
      <DirectoryTable
        rows={[employee(42, "Fictional Refused Person")]}
        owner={false}
        actions={ALL_DIRECTORY}
        errors={{
          [id(42)]:
            "Only a company owner can link an employee to a user, change a linked employee's positions, or move or archive a position a linked employee holds, because these set who can see which records.",
        }}
      />,
    );
    expect(directoryRefusal).toContain(
      `Actions<span class="sr-only">: Fictional Refused Person</span></button></td></tr><tr><td colSpan="8"><p class="notice error" role="alert">${positionRefusal}</p>`,
    );
  });
});

describe("directory", () => {
  const rows = [
    employee(40, "Fictional Unlinked Person", {
      positions: [
        {
          positionId: lead.id,
          title: "Fictional Lead",
          orgUnitId: holdings.id,
          primary: true,
          validFrom: "2026-11-01T09:00:00.000Z",
        },
        {
          positionId: analyst.id,
          title: "Fictional Analyst",
          orgUnitId: holdings.id,
          primary: false,
          validFrom: "2026-11-01T09:00:00.000Z",
        },
      ],
    }),
    employee(41, "Fictional Linked Person", {
      userId: "fictional-linked-user",
      status: "left",
      retentionClass: "extended",
    }),
  ];
  const table = (
    list: Employee[],
    owner: boolean,
    actions: Action[] = ALL_DIRECTORY,
  ) =>
    renderToStaticMarkup(
      <DirectoryTable rows={list} owner={owner} actions={actions} />,
    );
  const rowsOf = (markup: string) =>
    [...markup.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => row[1]).slice(1);
  const button = (label: string, name: string) =>
    `${label}<span class="sr-only">: ${name}</span></button>`;

  it("builds the filter query with only the filters set and 25 rows per page", () => {
    expect(directoryPath(NO_FILTERS, 1)).toBe(
      "/api/v1/employees?page=1&pageSize=25",
    );
    const path = directoryPath(
      {
        search: "  Fictional Person ",
        unitId: holdings.id,
        levelId: id(2),
        positionId: lead.id,
        status: "left",
        includeArchived: true,
      },
      3,
    );
    const url = new URL(path, "http://localhost");
    expect(url.pathname).toBe("/api/v1/employees");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      search: "Fictional Person",
      unitId: holdings.id,
      levelId: id(2),
      positionId: lead.id,
      status: "left",
      includeArchived: "true",
      page: "3",
      pageSize: "25",
    });
  });

  it("labels every filter control and enables Position once a unit is chosen", () => {
    const form = (unitId: string) =>
      renderToStaticMarkup(
        <DirectoryFilterForm
          filters={{ ...NO_FILTERS, unitId }}
          levels={levels}
          positions={unitId ? [lead] : null}
          request={null}
          error=""
        />,
      );
    const none = form("");
    for (const label of [
      "Name or employee number",
      "Level",
      "Status",
      "Position",
    ])
      expect(none).toContain(`<span>${label}</span>`);
    expect(none).toContain("Include archived employees</label>");
    expect(none).toContain(
      '<button type="submit" class="button">Search</button>',
    );
    for (const option of [
      "Any level",
      "Fictional Old Level (archived)",
      "Any",
      "Active",
      "Left",
    ])
      expect(none).toContain(`>${option}</option>`);
    expect(none).toMatch(/<span>Position<\/span><select disabled="">/);
    const chosen = form(holdings.id);
    expect(chosen).toMatch(/<span>Position<\/span><select>/);
    expect(chosen).toContain(
      `<option value="${lead.id}">Fictional Lead (FP-20)</option>`,
    );
  });

  it("offers Previous only after page 1 and Next only while there are more, with a status line naming the page", () => {
    const paging = (page: number, hasMore: boolean) =>
      renderToStaticMarkup(
        <DirectoryPaging page={page} hasMore={hasMore} busy={false} />,
      );
    const first = paging(1, true);
    expect(first).toContain('role="status"');
    expect(first).toContain(">Page 1</p>");
    expect(first).toContain(">Next page</button>");
    expect(first).not.toContain("Previous page");
    const last = paging(2, false);
    expect(last).toContain(">Previous page</button>");
    expect(last).not.toContain("Next page");
    expect(paging(3, true)).toMatch(/Previous page[\s\S]*Next page/);
    expect(paging(1, false)).not.toMatch(/Previous page|Next page/);
    expect(
      renderToStaticMarkup(<DirectoryPaging page={2} hasMore busy />),
    ).toContain(">Loading employees…</p>");
  });

  it("shows no contact column, cell or value for rows without the keys, and both columns for rows with them", () => {
    const basic = table(rows, true);
    expect(basic).not.toContain("Work email");
    expect(basic).not.toContain("Work phone");
    expect(basic).not.toContain("example.test");
    for (const header of [
      "Name",
      "Employee number",
      "Positions",
      "Status",
      "Retention class",
      "User account",
      "Archived",
    ])
      expect(basic).toContain(`<th>${header}</th>`);
    const [unlinked, linked] = rowsOf(basic);
    expect(unlinked).toContain(
      'data-label="Positions">Fictional Lead, Fictional Analyst<',
    );
    expect(unlinked).toContain('data-label="User account">Not linked<');
    expect(linked).toContain('data-label="User account">Linked<');
    expect(linked).toContain('data-label="Positions">None<');
    expect(basic).not.toContain("fictional-linked-user");
    const full = table(
      rows.map((row, index) => ({
        ...row,
        workEmail: index ? null : "unlinked@example.test",
        workPhone: index ? null : "+00 1111 1111",
      })),
      true,
    );
    expect(full).toContain("<th>Work email</th>");
    expect(full).toContain("<th>Work phone</th>");
    // An email wraps only after its local part.
    expect(full).toContain(
      'data-label="Work email">unlinked<wbr/>@example.test<',
    );
    expect(full).toContain(
      'data-label="Work phone" style="white-space:nowrap">+00 1111 1111<',
    );
    expect(full).toContain('data-label="Work email">Not recorded<');
  });

  it("gives each row one Actions button, only when the row has an action", () => {
    for (const markup of [table(rows, true), table(rows, false)])
      for (const [index, row] of rowsOf(markup).entries()) {
        expect(row.match(/<button/g)).toHaveLength(1);
        expect(row).toContain(
          `<td data-label="Actions" style="width:1%;white-space:nowrap"><button type="button" class="button secondary small" aria-haspopup="dialog">${button("Actions", rows[index].displayName)}`,
        );
      }
    expect(table(rows, true)).toContain('<table class="data-table compact">');
    for (const row of rowsOf(table(rows, false, ["view"])))
      expect(row).not.toMatch(/<button/);
  });

  it("offers erase, link, unlink and a linked row's positions only to a company owner", () => {
    const view = (row: Employee, owner: boolean, actions = ALL_DIRECTORY) =>
      renderToStaticMarkup(
        <EmployeeActionsView row={row} owner={owner} actions={actions} />,
      );
    const labels = (markup: string) =>
      [...markup.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map(
        (match) => match[1],
      );
    expect(labels(view(rows[0], true))).toEqual([
      "Edit",
      "Positions",
      "Link to user",
      "Archive",
      "Permanently erase employee",
    ]);
    expect(labels(view(rows[1], true))).toEqual([
      "Edit",
      "Positions",
      "Unlink user",
      "Archive",
      "Permanently erase employee",
    ]);
    expect(view(rows[0], true)).toContain(
      '<button type="button" class="button danger">Permanently erase employee</button>',
    );
    // An unlinked row's positions need directory edit only; a linked row's need a company owner.
    expect(labels(view(rows[0], false))).toEqual([
      "Edit",
      "Positions",
      "Archive",
    ]);
    expect(labels(view(rows[1], false))).toEqual(["Edit", "Archive"]);
    expect(labels(view(rows[0], false, ["view"]))).toEqual([]);
    // A company owner without directory edit cannot link or place.
    expect(labels(view(rows[0], true, ["view"]))).toEqual([
      "Permanently erase employee",
    ]);
    expect(rowActions(rows[1], false, ALL_DIRECTORY)).toEqual([
      "edit",
      "archive",
    ]);
  });

  it("shows the retention review only to a company owner", () => {
    for (const companyLevel of COMPANY_LEVELS) {
      const markup = render(
        "directory",
        access("owner", companyLevel, { directory: ALL_DIRECTORY }),
      );
      expect(
        markup.includes("<h2>Retention review</h2>"),
        `${companyLevel}`,
      ).toBe(companyLevel === "owner");
      expect(markup).toContain(">Add employee</button>");
    }
  });
});

describe("org tree by units (ADM-22)", () => {
  const treeView = (state: ChartState, tree: Partial<TreeState> = {}) =>
    renderToStaticMarkup(
      <OrgChartPanel
        levels={levels}
        chart={state}
        owner
        directoryView
        view="tree"
        tree={{ ...TREE_START, ...tree }}
      />,
    );
  const withVacancy = (
    leadVacant: boolean | null | undefined,
    analystVacant: boolean | null | undefined,
  ) =>
    chart({
      contents: {
        [holdings.id]: {
          positions: [
            { ...lead, vacant: leadVacant },
            { ...analyst, vacant: analystVacant },
          ],
          positionsHasMore: false,
        },
      },
    });
  /** Each treeitem's opening tag, in document order. */
  const treeItems = (markup: string) =>
    [...markup.matchAll(/<li ([^>]*)>/g)].map((match) => match[1]);
  const attribute = (tag: string, name: string) =>
    new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
  const toolButton = (label: string, disabled: boolean) =>
    `<button type="button" class="button secondary small"${disabled ? ' disabled=""' : ""}>${label}</button>`;

  it("switches between List, the default, and Org tree, with Add top-level unit above both", () => {
    const list = orgChart(true);
    expect(list).toContain(
      '<div class="view-toggle" role="group" aria-label="Org chart view"><button type="button" aria-pressed="true">List</button><button type="button" aria-pressed="false">Org tree</button></div>',
    );
    expect(list).not.toContain('role="tree"');
    expect(list).toContain('<ul aria-label="Top-level units"');
    const tree = treeView(chart());
    expect(tree).toContain(
      '<button type="button" aria-pressed="false">List</button><button type="button" aria-pressed="true">Org tree</button>',
    );
    expect(tree).toContain(
      '<ul role="tree" aria-label="Org tree by units" class="org-tree" data-org-tree="" style="zoom:1">',
    );
    expect(tree).not.toContain("Top-level units");
    for (const markup of [list, tree])
      expect(markup.indexOf(">Add top-level unit</button>")).toBeLessThan(
        markup.search(/<ul /),
      );
    // The tree view has no row actions.
    for (const label of ["Rename", "Add unit below", "Move", "Archive", "Edit"])
      expect(tree).not.toContain(`>${label}<`);
  });

  it("renders a nested tree of treeitems with level, set size, position and expanded state, and no controls inside", () => {
    const markup = treeView(chart());
    const items = treeItems(markup);
    expect(items.every((tag) => tag.startsWith('role="treeitem"'))).toBe(true);
    expect(
      items.map((tag) => [
        attribute(tag, "aria-label"),
        attribute(tag, "aria-level"),
        attribute(tag, "aria-setsize"),
        attribute(tag, "aria-posinset"),
        attribute(tag, "aria-expanded"),
      ]),
    ).toEqual([
      [
        "Fictional Holdings, FU-10, Fictional Company, 2 positions",
        "1",
        "3",
        "1",
        "true",
      ],
      ["Fictional Lead, FP-20, Manager", "2", "3", "1", undefined],
      ["Fictional Analyst, FP-21", "2", "3", "2", undefined],
      ["Fictional Sales, FU-12, Fictional Division", "2", "3", "3", "false"],
      ["Sample Group, FU-11, Fictional Company", "1", "3", "2", "false"],
      ["Show more top-level units", "1", "3", "3", undefined],
    ]);
    // One roving tab stop, on the first item until another is focused.
    expect(items.map((tag) => attribute(tag, "tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
      "-1",
      "-1",
      "-1",
    ]);
    expect(
      treeItems(
        treeView(chart(), {
          focused: {
            key: `position:${lead.id}`,
            path: [`unit:${holdings.id}`],
          },
        }),
      ).map((tag) => attribute(tag, "tabindex")),
    ).toEqual(["-1", "0", "-1", "-1", "-1", "-1"]);
    expect(
      markup.match(/<ul role="group" class="org-tree-group"/g),
    ).toHaveLength(1);
    const tree = markup.slice(markup.indexOf('<ul role="tree"'));
    expect(tree).not.toMatch(/<button|<a |<input|<select/);
    expect(markup).toContain(
      '<span class="org-tree-meta">FP-20 · Manager</span>',
    );
    expect(markup).toContain("Loaded: 3 units · 2 positions</p>");
  });

  it("draws a vacant position dashed with the text Vacant, and counts it", () => {
    const markup = treeView(withVacancy(false, true));
    expect(markup).toMatch(
      /aria-label="Fictional Analyst, FP-21, Vacant"[^>]*class="org-tree-position org-tree-vacant"><div class="org-tree-box"><span class="org-tree-title">Fictional Analyst<\/span><span class="org-tree-meta">FP-21<\/span><span class="org-tree-vacant-label">Vacant<\/span><\/div><\/li>/,
    );
    expect(markup).toMatch(
      /aria-label="Fictional Lead, FP-20, Manager"[^>]*class="org-tree-position">/,
    );
    expect(markup.match(/org-tree-vacant"/g)).toHaveLength(1);
    expect(markup).toContain(
      'aria-label="Fictional Holdings, FU-10, Fictional Company, 2 positions, 1 vacant"',
    );
    expect(markup).toContain(
      '<p role="status" class="small-text">Loaded: 3 units · 2 positions · 1 vacant</p>',
    );
    expect(markup).not.toContain("You need directory access");
  });

  it("marks nothing Vacant and says once that vacancy needs directory access when it is unknown", () => {
    for (const unknown of [null, undefined]) {
      const markup = treeView(withVacancy(unknown, unknown));
      expect(markup).not.toContain("Vacant");
      expect(markup).not.toContain("org-tree-vacant");
      expect(markup).not.toMatch(/\d vacant/);
      expect(
        markup.match(
          /You need directory access to see which positions are vacant\./g,
        ),
      ).toHaveLength(1);
      expect(markup).toContain(
        '<p role="status" class="small-text">Loaded: 3 units · 2 positions</p>',
      );
    }
  });

  it("says in the status line when Expand all runs, stops at the limit, fails or finishes", () => {
    const status = (expandAll: TreeState["expandAll"]) =>
      treeView(chart(), { expandAll });
    const limit = status({ state: "limit", units: 480 });
    expect(limit).toContain(
      '<p role="status" class="small-text">Loaded: 3 units · 2 positions. Expand all stopped at the limit of 500 units. Expand a unit to see the units below it.</p>',
    );
    expect(limit).toContain(toolButton("Expand all", false));
    const running = status({ state: "running", units: 120 });
    expect(running).toContain(toolButton("Expand all", true));
    expect(running).toContain(
      "Expand all is loading units: 120 units loaded so far.",
    );
    expect(status({ state: "finished", units: 3 })).toContain(
      "Expand all finished: 3 units loaded.",
    );
    expect(
      status({ state: "failed", unit: "Fictional Sales", units: 3 }),
    ).toContain("Expand all stopped because Fictional Sales could not load.");
    expect(status({ state: "idle" })).not.toContain("Expand all stopped");
    // A unit that could not load says so in its box and next to the tree.
    const failed = treeView(
      chart({
        expanded: [holdings.id, sample.id],
        errors: { [`load:${sample.id}`]: "Fictional refusal." },
      }),
    );
    expect(failed).toMatch(
      /<p class="notice error" role="alert">Could not load (<!-- -->)?Sample Group(<!-- -->)?\. (<!-- -->)?Fictional refusal\.(<!-- -->)? Collapse and expand the unit to try again\.<\/p>/,
    );
    expect(failed).toContain(
      '<span class="org-tree-error">Could not load this unit.</span>',
    );
    expect(treeView(chart({ expanded: [holdings.id, sample.id] }))).toMatch(
      /<span class="org-tree-meta">Loading (<!-- -->)?Sample Group(<!-- -->)?…<\/span>/,
    );
  });

  it("moves focus and expands or collapses for every tree key", () => {
    const items = flattenTree(
      buildTree(
        chart(),
        new Map(levels.map((level) => [level.id, level.name])),
      ),
    );
    const [holdingsKey, leadKey, analystKey, salesKey, sampleKey, moreKey] =
      items.map((item) => item.key);
    expect(moreKey).toBe("more:");
    const key = (current: string, pressed: string) =>
      treeKey(items, current, pressed);
    expect(key(holdingsKey, "ArrowDown")).toEqual({ focus: leadKey });
    expect(key(moreKey, "ArrowDown")).toEqual({ focus: moreKey });
    expect(key(analystKey, "ArrowUp")).toEqual({ focus: leadKey });
    expect(key(holdingsKey, "ArrowUp")).toEqual({ focus: holdingsKey });
    expect(key(salesKey, "Home")).toEqual({ focus: holdingsKey });
    expect(key(leadKey, "End")).toEqual({ focus: moreKey });
    // Right expands a collapsed unit, enters an expanded one and does nothing on a position.
    expect(key(salesKey, "ArrowRight")).toEqual({ toggle: sales });
    expect(key(holdingsKey, "ArrowRight")).toEqual({ focus: leadKey });
    expect(key(leadKey, "ArrowRight")).toEqual({});
    // Left collapses an expanded unit, otherwise moves to the parent unit.
    expect(key(holdingsKey, "ArrowLeft")).toEqual({ toggle: holdings });
    expect(key(analystKey, "ArrowLeft")).toEqual({ focus: holdingsKey });
    expect(key(salesKey, "ArrowLeft")).toEqual({ focus: holdingsKey });
    expect(key(sampleKey, "ArrowLeft")).toEqual({});
    // Enter and Space toggle a unit and activate Show more.
    for (const pressed of ["Enter", " "]) {
      expect(key(sampleKey, pressed)).toEqual({ toggle: sample });
      expect(key(holdingsKey, pressed)).toEqual({ toggle: holdings });
      expect(key(moreKey, pressed)).toEqual({ more: "" });
      expect(key(leadKey, pressed)).toEqual({});
    }
    expect(key(leadKey, "a")).toBeNull();
    // A hidden focused item gives the tab stop to its nearest visible unit.
    const collapsed = flattenTree(
      buildTree(chart({ expanded: [] }), new Map()),
    );
    expect(resolveFocus(collapsed, { key: leadKey, path: [holdingsKey] })).toBe(
      holdingsKey,
    );
    expect(resolveFocus(items, { key: analystKey, path: [holdingsKey] })).toBe(
      analystKey,
    );
    expect(resolveFocus(items, null)).toBe(holdingsKey);
  });

  it("shows no employee name, number or contact fact, even with holders loaded", () => {
    const held = chart({
      holdersOpen: [lead.id],
      holders: {
        [lead.id]: {
          rows: [
            employee(30, "Fictional Holder", {
              workEmail: "holder@example.test",
              workPhone: "+00 0000 0000",
            }),
          ],
          page: 1,
          hasMore: false,
        },
      },
    });
    const markup = treeView(held);
    for (const fact of [
      "Fictional Holder",
      "EMP-30",
      "holder@example.test",
      "+00 0000 0000",
      "Show employees",
    ])
      expect(markup).not.toContain(fact);
    expect(markup).toContain("Fictional Lead");
  });

  it("zooms between 50% and 150%, disabling each button at its bound", () => {
    const at = (zoom: number) => treeView(chart(), { zoom });
    const low = at(50);
    expect(low).toContain(toolButton("Zoom out", true));
    expect(low).toContain(toolButton("Zoom in", false));
    expect(low).toMatch(/<span class="small-text">50(<!-- -->)?%<\/span>/);
    expect(low).toContain('style="zoom:0.5"');
    const high = at(150);
    expect(high).toContain(toolButton("Zoom out", false));
    expect(high).toContain(toolButton("Zoom in", true));
    expect(high).toContain('style="zoom:1.5"');
    const normal = at(100);
    for (const label of ["Zoom out", "Zoom in", "Reset zoom", "Export image"])
      expect(normal).toContain(toolButton(label, false));
  });
});

describe("org tree by people (ADM-23)", () => {
  const person = (
    n: number,
    displayName: string,
    reports = 0,
    changes: Partial<ReportingPerson> = {},
  ): ReportingPerson => ({
    id: id(n),
    displayName,
    title: `Fictional Title ${n}`,
    unitName: "Fictional Holdings",
    otherPositions: 0,
    reports,
    ...changes,
  });
  const chief = person(50, "Fictional Chief", 2, { otherPositions: 1 });
  const deputy = person(51, "Fictional Deputy", 1);
  const helper = person(52, "Fictional Helper");
  const loner = person(53, "Fictional Loner");
  /** The chief expanded with two reports; the deputy collapsed; the top level has more. */
  const people = (changes: Partial<PeopleState> = {}): PeopleState => ({
    ...EMPTY_PEOPLE,
    lists: {
      "": { people: [chief, loner], page: 1, hasMore: true },
      [chief.id]: { people: [deputy, helper], page: 1, hasMore: false },
    },
    expanded: [chief.id],
    ...changes,
  });
  const panel = (
    options: {
      allowed?: boolean;
      mode?: "units" | "people";
      view?: "list" | "tree";
      state?: PeopleState;
      tree?: Partial<TreeState>;
    } = {},
  ) =>
    renderToStaticMarkup(
      <OrgChartPanel
        levels={levels}
        chart={chart()}
        owner
        directoryView
        view={options.view ?? "tree"}
        tree={{ ...TREE_START, ...options.tree }}
        peopleAllowed={options.allowed ?? true}
        treeMode={options.mode ?? "people"}
        people={options.state ?? people()}
      />,
    );
  const treeItems = (markup: string) =>
    [...markup.matchAll(/<li ([^>]*)>/g)].map((match) => match[1]);
  const attribute = (tag: string, name: string) =>
    new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
  const toolButton = (label: string, disabled: boolean) =>
    `<button type="button" class="button secondary small"${disabled ? ' disabled=""' : ""}>${label}</button>`;
  const switchMarkup = (people: boolean) =>
    `<div class="view-toggle" role="group" aria-label="Org tree shows"><button type="button" aria-pressed="${!people}">By units</button><button type="button" aria-pressed="${people}">By people</button></div>`;
  const RULE =
    "Each person reports to whoever holds a manager position in their unit, or in the nearest unit above it that has one.";

  it("offers By units, pressed by default, and By people in the Org tree view only to callers allowed people", () => {
    const units = panel({ mode: "units" });
    expect(units).toContain(switchMarkup(false));
    expect(units).toContain('aria-label="Org tree by units"');
    expect(units).not.toContain("Org tree by people");
    expect(units).not.toContain(RULE);
    const byPeople = panel();
    expect(byPeople).toContain(switchMarkup(true));
    expect(byPeople).toContain(
      '<ul role="tree" aria-label="Org tree by people" class="org-tree" data-org-tree="" style="zoom:1">',
    );
    expect(byPeople).toContain(`<p class="muted small-text">${RULE}</p>`);
    expect(byPeople).not.toContain("Org tree by units");
    // The chart view switch and Add top-level unit stay as they are.
    expect(byPeople).toContain(
      '<button type="button" aria-pressed="false">List</button><button type="button" aria-pressed="true">Org tree</button>',
    );
    expect(byPeople.indexOf(">Add top-level unit</button>")).toBeLessThan(
      byPeople.search(/<ul /),
    );
    // Not allowed: no switch, no people text, whatever the mode says.
    for (const markup of [
      panel({ allowed: false }),
      panel({ allowed: false, mode: "units" }),
      panel({ view: "list" }),
    ]) {
      expect(markup).not.toContain("Org tree shows");
      expect(markup).not.toContain("By people");
      expect(markup).not.toContain("By units");
      expect(markup).not.toContain("Org tree by people");
      expect(markup).not.toContain("Fictional Chief");
      expect(markup).not.toContain(RULE);
    }
    expect(panel({ allowed: false })).toContain(
      'aria-label="Org tree by units"',
    );
    // A default render, as before ADM-23, has no people markup either.
    expect(orgChart(true)).not.toContain("By people");
  });

  it("allows people only with both the directory page and directory view", () => {
    const allowed = (pages: MeAccess["pages"], directory?: Action[]) =>
      peopleViewAllowed({
        pages,
        actions: directory ? { directory } : {},
      });
    expect(allowed(["directory"], ["view"])).toBe(true);
    expect(allowed(["admin", "directory"], ALL_DIRECTORY)).toBe(true);
    expect(allowed(["directory"])).toBe(false);
    expect(allowed(["directory"], ["create", "edit"])).toBe(false);
    expect(allowed(["admin"], ["view"])).toBe(false);
    expect(allowed([], ALL_DIRECTORY)).toBe(false);
  });

  it("loads the top level, and one person's reports, from the reporting lines route only", async () => {
    const { paths, request } = recorder();
    await loadReports(request, null);
    await loadReports(request, chief.id);
    await loadReports(request, chief.id, 2);
    expect(paths).toEqual([
      "/api/v1/employees/reporting-lines?page=1&pageSize=100",
      `/api/v1/employees/reporting-lines?managerId=${chief.id}&page=1&pageSize=100`,
      `/api/v1/employees/reporting-lines?managerId=${chief.id}&page=2&pageSize=100`,
    ]);
    expect(reportingPath(null)).toBe(paths[0]);
  });

  it("renders a nested tree of person treeitems with level, set size, position, and expanded state only with reports", () => {
    const markup = panel();
    const items = treeItems(markup);
    expect(items.every((tag) => tag.startsWith('role="treeitem"'))).toBe(true);
    expect(
      items.map((tag) => [
        attribute(tag, "aria-label"),
        attribute(tag, "aria-level"),
        attribute(tag, "aria-setsize"),
        attribute(tag, "aria-posinset"),
        attribute(tag, "aria-expanded"),
      ]),
    ).toEqual([
      [
        "Fictional Chief, Fictional Title 50, Fictional Holdings, and 1 more position, 2 direct reports",
        "1",
        "3",
        "1",
        "true",
      ],
      [
        "Fictional Deputy, Fictional Title 51, Fictional Holdings, 1 direct report",
        "2",
        "2",
        "1",
        "false",
      ],
      [
        "Fictional Helper, Fictional Title 52, Fictional Holdings",
        "2",
        "2",
        "2",
        undefined,
      ],
      [
        "Fictional Loner, Fictional Title 53, Fictional Holdings",
        "1",
        "3",
        "2",
        undefined,
      ],
      ["Show more top-level people", "1", "3", "3", undefined],
    ]);
    expect(items.map((tag) => attribute(tag, "tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
      "-1",
      "-1",
    ]);
    // People mode keeps its own tab stop.
    expect(
      treeItems(
        panel({
          state: people({
            focused: {
              key: `person:${deputy.id}`,
              path: [`person:${chief.id}`],
            },
          }),
          tree: {
            focused: { key: `unit:${holdings.id}`, path: [] },
          },
        }),
      ).map((tag) => attribute(tag, "tabindex")),
    ).toEqual(["-1", "0", "-1", "-1", "-1"]);
    expect(
      markup.match(/<ul role="group" class="org-tree-group"/g),
    ).toHaveLength(1);
    const tree = markup.slice(markup.indexOf('<ul role="tree"'));
    expect(tree).not.toMatch(/<button|<a |<input|<select/);
    expect(markup).toMatch(
      /class="org-tree-node org-tree-person org-tree-first"><div class="org-tree-box"><span class="org-tree-title"><svg[^>]*>.*?<\/svg>Fictional Chief<\/span><span class="org-tree-meta">Fictional Title 50 · Fictional Holdings<\/span><span class="org-tree-meta">\+1 more position<\/span><span class="org-tree-meta">2 direct reports<\/span><\/div>/,
    );
    expect(markup).toMatch(
      /class="org-tree-node org-tree-person org-tree-last"><div class="org-tree-box"><span class="org-tree-title">Fictional Helper<\/span><span class="org-tree-meta">Fictional Title 52 · Fictional Holdings<\/span><\/div><\/li>/,
    );
    expect(markup).toContain(
      '<p role="status" class="small-text">Loaded: 4 people</p>',
    );
  });

  it("shows no work email, phone, employee number or user, even when the rows carry them", () => {
    const leaky = {
      ...chief,
      workEmail: "chief@example.test",
      workPhone: "+00 0000 0050",
      employeeNumber: "EMP-50",
      userId: "fictional-chief-user",
      status: "active",
    } as ReportingPerson;
    const markup = panel({
      state: people({
        lists: {
          "": { people: [leaky], page: 1, hasMore: false },
          [chief.id]: {
            people: [
              {
                ...helper,
                workEmail: "helper@example.test",
              } as ReportingPerson,
            ],
            page: 1,
            hasMore: false,
          },
        },
      }),
    });
    for (const fact of [
      "chief@example.test",
      "helper@example.test",
      "+00 0000 0050",
      "EMP-50",
      "fictional-chief-user",
      "active",
    ])
      expect(markup).not.toContain(fact);
    expect(markup).toContain("Fictional Chief");
    expect(markup).toContain("Fictional Helper");
  });

  it("says while the top level loads, when it fails or is empty, and while a person's reports load or fail", () => {
    expect(panel({ state: EMPTY_PEOPLE })).toContain(
      '<p role="status">Loading the org tree by people…</p>',
    );
    expect(
      panel({
        state: { ...EMPTY_PEOPLE, errors: { "load:": "Fictional refusal." } },
      }),
    ).toMatch(
      /<p class="notice error" role="alert">Could not load the org tree by people\. (<!-- -->)?Fictional refusal\.<\/p>/,
    );
    const empty = panel({
      state: {
        ...EMPTY_PEOPLE,
        lists: { "": { people: [], page: 1, hasMore: false } },
      },
    });
    expect(empty).toContain(
      '<p class="muted">No one holds a current position yet.</p>',
    );
    expect(empty).not.toContain('role="tree"');
    const loading = panel({
      state: people({ expanded: [chief.id, deputy.id] }),
    });
    expect(loading).toMatch(
      /<span class="org-tree-meta">Loading the people reporting to (<!-- -->)?Fictional Deputy(<!-- -->)?…<\/span>/,
    );
    expect(loading).toContain(
      'aria-label="Fictional Deputy, Fictional Title 51, Fictional Holdings, 1 direct report, loading"',
    );
    const failed = panel({
      state: people({
        expanded: [chief.id, deputy.id],
        errors: { [`load:${deputy.id}`]: "Fictional refusal." },
      }),
    });
    expect(failed.replace(/<!-- -->/g, "")).toContain(
      '<p class="notice error" role="alert">Could not load the people reporting to Fictional Deputy. Fictional refusal. Collapse and expand Fictional Deputy to try again.</p>',
    );
    expect(failed).toContain(
      'aria-label="Fictional Deputy, Fictional Title 51, Fictional Holdings, 1 direct report, could not load"',
    );
    expect(panel({ state: people({ busy: ["list:"] }) })).toContain(
      '<div class="org-tree-box">Loading more people…</div>',
    );
    expect(panel({ tree: { exportFailed: true } })).toContain(
      '<p class="notice error" role="alert">Could not make the image. Collapse some people and try again.</p>',
    );
  });

  it("says in the status line when Expand all runs, stops at the limit, fails or finishes", () => {
    const status = (expandAll: PeopleState["expandAll"]) =>
      panel({ state: people({ expandAll }) });
    const limit = status({ state: "limit", people: 480 });
    expect(limit).toContain(
      '<p role="status" class="small-text">Loaded: 4 people. Expand all stopped at the limit of 500 people. Expand a person to see who reports to them.</p>',
    );
    expect(limit).toContain(toolButton("Expand all", false));
    const running = status({ state: "running", people: 120 });
    expect(running).toContain(toolButton("Expand all", true));
    expect(running).toContain(
      "Expand all is loading people: 120 people loaded so far.",
    );
    expect(status({ state: "finished", people: 4 })).toContain(
      "Expand all finished: 4 people loaded.",
    );
    expect(
      status({ state: "failed", person: "Fictional Deputy", people: 4 }),
    ).toContain(
      "Expand all stopped because the people reporting to Fictional Deputy could not load.",
    );
    // The units status stays out of people mode.
    expect(
      panel({ tree: { expandAll: { state: "finished", units: 3 } } }),
    ).not.toContain("units loaded");
  });

  it("moves focus and expands or collapses people for every tree key", () => {
    const items = flattenTree(buildPeopleTree(people()));
    const [chiefKey, deputyKey, helperKey, lonerKey, moreKey] = items.map(
      (item) => item.key,
    );
    expect(moreKey).toBe("more:");
    const key = (current: string, pressed: string) =>
      treeKey(items, current, pressed);
    expect(key(chiefKey, "ArrowDown")).toEqual({ focus: deputyKey });
    expect(key(moreKey, "ArrowDown")).toEqual({ focus: moreKey });
    expect(key(helperKey, "ArrowUp")).toEqual({ focus: deputyKey });
    expect(key(chiefKey, "ArrowUp")).toEqual({ focus: chiefKey });
    expect(key(lonerKey, "Home")).toEqual({ focus: chiefKey });
    expect(key(deputyKey, "End")).toEqual({ focus: moreKey });
    // Right expands a collapsed person with reports, enters an expanded one, and does nothing on a
    // person without reports.
    expect(key(deputyKey, "ArrowRight")).toEqual({ togglePerson: deputy });
    expect(key(chiefKey, "ArrowRight")).toEqual({ focus: deputyKey });
    expect(key(helperKey, "ArrowRight")).toEqual({});
    expect(key(lonerKey, "ArrowRight")).toEqual({});
    // Left collapses an expanded person, otherwise moves to the person above.
    expect(key(chiefKey, "ArrowLeft")).toEqual({ togglePerson: chief });
    expect(key(helperKey, "ArrowLeft")).toEqual({ focus: chiefKey });
    expect(key(deputyKey, "ArrowLeft")).toEqual({ focus: chiefKey });
    expect(key(lonerKey, "ArrowLeft")).toEqual({});
    for (const pressed of ["Enter", " "]) {
      expect(key(chiefKey, pressed)).toEqual({ togglePerson: chief });
      expect(key(deputyKey, pressed)).toEqual({ togglePerson: deputy });
      expect(key(helperKey, pressed)).toEqual({});
      expect(key(moreKey, pressed)).toEqual({ more: "" });
    }
    expect(key(helperKey, "a")).toBeNull();
    // A hidden focused person gives the tab stop to the nearest visible person above.
    const collapsed = flattenTree(buildPeopleTree(people({ expanded: [] })));
    expect(resolveFocus(collapsed, { key: helperKey, path: [chiefKey] })).toBe(
      chiefKey,
    );
    expect(resolveFocus(items, { key: helperKey, path: [chiefKey] })).toBe(
      helperKey,
    );
    expect(resolveFocus(items, null)).toBe(chiefKey);
  });

  it("zooms between 50% and 150% in people mode, disabling each button at its bound", () => {
    const at = (zoom: number) =>
      renderToStaticMarkup(
        <PeopleTreeView
          people={people()}
          zoom={zoom}
          focused={null}
          expandAll={{ state: "idle" }}
        />,
      );
    const low = at(ZOOM_MIN);
    expect(low).toContain(toolButton("Zoom out", true));
    expect(low).toContain(toolButton("Zoom in", false));
    expect(low).toMatch(/<span class="small-text">50(<!-- -->)?%<\/span>/);
    expect(low).toContain('style="zoom:0.5"');
    const high = at(ZOOM_MAX);
    expect(high).toContain(toolButton("Zoom out", false));
    expect(high).toContain(toolButton("Zoom in", true));
    expect(high).toContain('style="zoom:1.5"');
    for (const label of ["Zoom out", "Zoom in", "Reset zoom", "Export image"])
      expect(at(100)).toContain(toolButton(label, false));
    // Export image waits for a loaded person.
    expect(
      renderToStaticMarkup(
        <PeopleTreeView
          people={{
            ...EMPTY_PEOPLE,
            lists: { "": { people: [], page: 1, hasMore: false } },
          }}
          zoom={100}
          focused={null}
          expandAll={{ state: "idle" }}
        />,
      ),
    ).not.toContain("Export image");
  });
});

describe("job architecture (ADM-26)", () => {
  // Fictional families, grades, titles and AED figures only (job 086).
  const body: JobArchitectureBody = {
    families: [{ key: "fictional-finance", name: "Fictional Finance" }],
    grades: [
      { code: "FG2", name: "Fictional Senior", order: 20 },
      { code: "FG1", name: "Fictional Junior", order: 10 },
    ],
    titles: [
      {
        key: "fictional-payroll-lead",
        name: "Fictional Payroll Lead",
        familyKey: "fictional-finance",
        gradeCode: "FG2",
      },
    ],
  };
  const draftBody: JobArchitectureBody = {
    ...body,
    grades: [
      ...body.grades,
      { code: "FG3", name: "Fictional Draft Grade", order: 30 },
    ],
  };
  const published: JobArchitectureState = {
    current: { versionId: id(70), number: 3, body },
    draft: null,
  };
  const withDraft: JobArchitectureState = {
    ...published,
    draft: {
      id: id(71),
      body: draftBody,
      note: null,
      createdAt: "2026-11-10T09:00:00.000Z",
    },
  };
  const version = (
    n: number,
    state: SalaryBracketVersion["state"],
    codes: string[],
  ): SalaryBracketVersion => ({
    versionId: id(n),
    number: state === "published" ? 2 : null,
    state,
    payPeriod: "monthly",
    covers: "basic",
    effectiveFrom: "2027-01-01",
    createdAt: "2026-11-10T09:00:00.000Z",
    publishedAt: state === "published" ? "2026-11-10T10:00:00.000Z" : null,
    brackets: codes.map((gradeCode) =>
      gradeCode === "FG1"
        ? {
            gradeCode,
            minimumFils: 1_234_500,
            midpointFils: 1_500_050,
            maximumFils: 1_800_000,
          }
        : {
            gradeCode,
            minimumFils: 2_100_000,
            midpointFils: 2_600_000,
            maximumFils: 3_200_000,
          },
    ),
  });
  const brackets: BracketState = {
    current: version(80, "published", ["FG1", "FG2"]),
    draft: version(81, "draft", ["FG1", "FG2"]),
  };
  const FIGURES = [
    "12,345",
    "15,000.50",
    "18,000",
    "21,000",
    "26,000",
    "32,000",
  ];
  const owner = access("owner", "owner", { organisation: true });
  const orgAdmin = access("recruiter", "admin", { organisation: true });
  const holder = access("owner", "owner", {
    organisation: true,
    planAccess: { read: true, write: true },
  });
  const reader = access("owner", "owner", {
    organisation: true,
    planAccess: { read: true, write: false },
  });
  const member = access("recruiter", null);
  const view = (
    value: MeAccess,
    state: JobArchitectureState | null = published,
    extra: {
      view?: JobView;
      showBrackets?: boolean;
      brackets?: BracketState | null;
    } = {},
  ) =>
    renderToStaticMarkup(
      <JobArchitectureView access={value} state={state} {...extra} />,
    );
  /** Records each request's method and path; reads answer an empty state. */
  function requests() {
    const sent: string[] = [];
    const request = (async (path: string, init?: RequestInit) => {
      sent.push(`${init?.method ?? "GET"} ${path}`);
      return { data: { current: null, draft: null } };
    }) as Requester;
    return { sent, request };
  }
  const notice = `<p class="notice"><strong>Confidential.</strong> ${CONFIDENTIAL_NOTICE.replace(/&/g, "&amp;")}</p>`;

  it("shows grades without pay, no switch and requests no brackets without Plan & pay access", async () => {
    expect(CONFIDENTIAL_NOTICE).toBe(
      "Salary brackets are visible only to people a company owner has given Plan & pay access in Company authority; company owners need it too. Everyone else sees grades without pay. Brackets are never sent to AI tools, exports, notifications, search or activity.",
    );
    for (const value of [owner, orgAdmin]) {
      // Even with brackets handed in, nothing of them renders.
      const markup = view(value, published, { showBrackets: true, brackets });
      expect(markup).toContain(notice);
      expect(markup).toContain("Add grade");
      expect(markup).toContain('Edit<span class="sr-only">: FG1</span>');
      for (const text of [
        "Show salary brackets",
        'role="switch"',
        "Minimum",
        "Edit salary brackets",
        "AED",
        ...FIGURES,
      ])
        expect(markup, text).not.toContain(text);
      const { sent, request } = requests();
      await loadJobArchitecture(request);
      expect(sent).toEqual(["GET /api/v1/job-architecture"]);
      expect(await loadSalaryBrackets(request, value)).toBeNull();
      expect(sent).toEqual(["GET /api/v1/job-architecture"]);
    }
  });

  it("lists grades by order with their title counts, and shows loading and load errors", () => {
    const markup = view(owner);
    expect(markup.indexOf(">FG1<")).toBeLessThan(markup.indexOf(">FG2<"));
    expect(markup).toContain(
      '<td data-label="Grade">FG2</td><td data-label="Name">Fictional Senior</td><td data-label="Order">20</td><td data-label="Job titles">1</td>',
    );
    expect(markup).toContain("Published version 3");
    expect(view(owner, null)).toContain(
      '<p role="status">Loading job architecture…</p>',
    );
    expect(
      renderToStaticMarkup(
        <JobArchitectureView
          access={owner}
          state={null}
          loadError="Fictional failure."
        />,
      ),
    ).toMatch(
      /role="alert">Could not load the job architecture\. Fictional failure\./,
    );
    expect(gradesInOrder(body).map((grade) => grade.code)).toEqual([
      "FG1",
      "FG2",
    ]);
  });

  it("shows the switch, figures, band and summary to a holder, and Edit salary brackets only with write", async () => {
    const off = view(holder);
    expect(off).toContain(
      '<input type="checkbox" role="switch"/>Show salary brackets',
    );
    expect(off).not.toContain("Minimum");
    const markup = view(holder, published, { showBrackets: true, brackets });
    expect(markup).toContain(
      '<input type="checkbox" role="switch" checked=""/>Show salary brackets',
    );
    for (const header of [
      "<th>Minimum (AED a month)</th>",
      "<th>Midpoint (AED a month)</th>",
      "<th>Maximum (AED a month)</th>",
      "<th>Range</th>",
    ])
      expect(markup).toContain(header);
    for (const figure of FIGURES) expect(markup).toContain(figure);
    expect(markup).toContain(
      'role="img" aria-label="AED 12,345 to AED 18,000, midpoint AED 15,000.50"',
    );
    expect(markup).toContain(
      "Brackets in AED, monthly, basic salary only · effective 1 Jan 2027 · version 2",
    );
    expect(markup).toContain("Edit salary brackets");
    expect(markup).toContain("Publish salary brackets");
    expect(markup).toContain(
      "A salary bracket draft is saved and not published yet.",
    );
    // The band is scaled to the highest maximum, with the midpoint marked.
    expect(markup).toContain('style="left:65.625%;right:0%"');
    expect(markup).toContain('style="left:81.25%"');
    const readOnly = view(reader, published, { showBrackets: true, brackets });
    expect(readOnly).toContain('role="switch"');
    for (const figure of FIGURES) expect(readOnly).toContain(figure);
    expect(readOnly).not.toContain("Edit salary brackets");
    expect(readOnly).not.toContain("Publish salary brackets");
    // The bracket columns are on the grades table only.
    expect(
      view(holder, published, { view: "titles", showBrackets: true, brackets }),
    ).not.toContain("AED");
    const { sent, request } = requests();
    await loadSalaryBrackets(request, holder);
    expect(sent).toEqual(["GET /api/v1/salary-brackets"]);
  });

  it("shows No bracket, the empty summary and the stale-draft note", () => {
    const partial: BracketState = {
      current: version(82, "published", ["FG1"]),
      draft: version(83, "draft", ["FG1"]),
    };
    const markup = view(holder, published, {
      showBrackets: true,
      brackets: partial,
    });
    expect(markup).toContain(">No bracket</td>");
    expect(markup).toContain(
      "This draft was made for other job grades. Saving brackets makes a new draft.",
    );
    expect(markup).not.toContain("Publish salary brackets");
    const none = view(holder, published, {
      showBrackets: true,
      brackets: { current: null, draft: null },
    });
    expect(none).toContain("No salary brackets are published yet.");
    expect(none).not.toContain("Minimum");
    const ungraded = view(
      holder,
      { current: null, draft: null },
      { showBrackets: true, brackets: { current: null, draft: null } },
    );
    expect(ungraded).toContain(
      "Publish a job architecture with at least one grade first.",
    );
    expect(ungraded).not.toContain("Edit salary brackets");
  });

  it("renders the bracket dialog with AED fixed, Monthly and Basic salary only by default", () => {
    const values = bracketPrefill(gradesInOrder(body), {
      current: null,
      draft: null,
    });
    expect(values).toEqual({
      payPeriod: "monthly",
      covers: "basic",
      effectiveFrom: "",
      rows: [
        { gradeCode: "FG1", minimum: "", midpoint: "", maximum: "" },
        { gradeCode: "FG2", minimum: "", midpoint: "", maximum: "" },
      ],
    });
    const markup = renderToStaticMarkup(
      <SalaryBracketsForm values={values} grades={gradesInOrder(body)} />,
    );
    expect(markup).toContain(">Salary brackets</h2>");
    expect(markup).toContain("<legend>Bracket settings</legend>");
    expect(markup).toContain("<legend>Brackets</legend>");
    expect(markup).toContain("<p>Currency: AED</p>");
    expect(markup.match(/<select/g)).toHaveLength(2);
    expect(markup).not.toMatch(/Currency<\/span><select/);
    expect(markup).toMatch(
      /<span>Pay period<\/span><select><option value="monthly" selected="">Monthly<\/option><option value="annual">Annual<\/option>/,
    );
    expect(markup).toMatch(
      /<span>What the bracket covers<\/span><select><option value="basic" selected="">Basic salary only<\/option>/,
    );
    expect(markup).toContain(
      '<span>Effective from</span><input type="date" aria-required="true"',
    );
    expect(markup).toContain(
      '<span><span class="sr-only">FG1 </span>Minimum (AED)</span><input aria-required="true" inputMode="decimal"',
    );
    // A published version prefills, matched by code; a draft for the published grades wins.
    expect(bracketPrefill(gradesInOrder(body), brackets).rows[0]).toEqual({
      gradeCode: "FG1",
      minimum: "12345",
      midpoint: "15000.50",
      maximum: "18000",
    });
  });

  it("converts AED to fils by string arithmetic and refuses anything else", () => {
    expect(aedToFils("15000")).toBe(1_500_000);
    expect(aedToFils("15000.5")).toBe(1_500_050);
    expect(aedToFils("15000.50")).toBe(1_500_050);
    expect(aedToFils("0.01")).toBe(1);
    expect(aedToFils("1000000000")).toBe(100_000_000_000);
    for (const text of [
      "1.234",
      "-5",
      "abc",
      "0",
      "1000000000.01",
      "",
      "1,000",
    ])
      expect(() => aedToFils(text), text).toThrow(AMOUNT_ERROR);
    expect(AMOUNT_ERROR).toBe(
      "Enter each amount in AED, such as 15000 or 15000.50, from 0.01 to 1,000,000,000.",
    );
    expect(filsToAed(1_500_000)).toBe("15,000");
    expect(filsToAed(1_500_050)).toBe("15,000.50");
    expect(filsToAed(1)).toBe("0.01");
  });

  it("refuses brackets out of order in plain words before any request", () => {
    expect(BRACKET_ORDER_ERROR).toBe(
      "The minimum must be at most the midpoint, and the midpoint at most the maximum.",
    );
    const row = (
      gradeCode: string,
      minimum: string,
      midpoint: string,
      maximum: string,
    ) => ({ gradeCode, minimum, midpoint, maximum });
    const minAbove = checkBracketRows([row("FG1", "16000", "15000", "18000")]);
    expect(minAbove.error).toBe(`Grade FG1: ${BRACKET_ORDER_ERROR}`);
    expect(minAbove.brackets).toEqual([]);
    const midAbove = checkBracketRows([
      row("FG1", "12000", "15000", "18000"),
      row("FG2", "21000", "33000", "32000"),
    ]);
    expect(midAbove.error).toBe(`Grade FG2: ${BRACKET_ORDER_ERROR}`);
    expect(checkBracketRows([row("FG1", "12000", "", "18000")]).error).toBe(
      `Grade FG1: ${AMOUNT_ERROR}`,
    );
    expect(checkBracketRows([row("FG1", "12000", "15000.5", "18000")])).toEqual(
      {
        error: "",
        brackets: [
          {
            gradeCode: "FG1",
            minimumFils: 1_200_000,
            midpointFils: 1_500_050,
            maximumFils: 1_800_000,
          },
        ],
      },
    );
    const markup = renderToStaticMarkup(
      <SalaryBracketsForm
        values={bracketPrefill(gradesInOrder(body), brackets)}
        grades={gradesInOrder(body)}
        error={midAbove.error}
        newGrades
      />,
    );
    expect(markup).toContain(
      'role="alert">Grade FG2: The minimum must be at most the midpoint, and the midpoint at most the maximum.</p>',
    );
    expect(markup).toContain(
      "Brackets follow the published job grades. Publish the job architecture first to add brackets for new grades.",
    );
  });

  it("shows a plain member the published names only, read-only", () => {
    for (const tab of ["grades", "titles", "families"] as const) {
      const markup = view(member, withDraft, {
        view: tab,
        showBrackets: true,
        brackets,
      });
      expect(markup).toContain("Published version 3");
      for (const text of [
        "Fictional Draft Grade",
        "FG3",
        "A draft is saved",
        "Add ",
        ">Edit<",
        "Publish job architecture",
        "Publish salary brackets",
        'role="switch"',
        "AED",
      ])
        expect(markup, `${tab}: ${text}`).not.toContain(text);
    }
    expect(view(member)).toContain("Fictional Senior");
    expect(view(member, withDraft, { view: "titles" })).toContain(
      '<td data-label="Job title">Fictional Payroll Lead</td><td data-label="Key">fictional-payroll-lead</td><td data-label="Family">Fictional Finance</td><td data-label="Grade">FG2 · Fictional Senior</td>',
    );
    expect(view(member, withDraft, { view: "families" })).toContain(
      '<td data-label="Family">Fictional Finance</td><td data-label="Key">fictional-finance</td><td data-label="Job titles">1</td>',
    );
    const nothing = view(member, { current: null, draft: null });
    expect(nothing).toContain("No job architecture is published yet.");
    expect(nothing).not.toContain('role="tablist"');
  });

  it("shows an editor the draft with Publish, and Add job title only with a family and a grade", () => {
    const markup = view(owner, withDraft);
    expect(markup).toContain("Fictional Draft Grade");
    expect(markup).toContain("A draft is saved and not published yet");
    expect(markup).toContain("Publish job architecture");
    const empty = view(
      owner,
      { current: null, draft: null },
      { view: "titles" },
    );
    expect(empty).toContain("No job architecture is published yet.");
    expect(empty).toContain(
      '<button type="button" class="button secondary" disabled="" aria-describedby="job-add-hint">Add job title</button><p id="job-add-hint" class="muted">Add a job family and a job grade first.</p>',
    );
    expect(view(owner, published, { view: "titles" })).toContain(
      '<button type="button" class="button secondary">Add job title</button>',
    );
    expect(view(owner, published, { view: "families" })).toContain(
      "Add job family",
    );
  });

  it("saves into the draft with PUT, or makes one with POST, and routes bracket saves the same way", async () => {
    const put = requests();
    await saveJobArchitecture(put.request, withDraft, body);
    expect(put.sent).toEqual([`PUT /api/v1/job-architecture/${id(71)}`]);
    const post = requests();
    await saveJobArchitecture(post.request, published, body);
    expect(post.sent).toEqual(["POST /api/v1/job-architecture"]);
    const input = {
      payPeriod: "monthly" as const,
      covers: "basic" as const,
      effectiveFrom: "2027-01-01",
      brackets: brackets.current!.brackets,
    };
    const codes = ["FG1", "FG2"];
    const cases: [BracketState, string][] = [
      [brackets, `PUT /api/v1/salary-brackets/${id(81)}`],
      [
        { ...brackets, draft: version(84, "draft", ["FG1"]) },
        "POST /api/v1/salary-brackets",
      ],
      [{ ...brackets, draft: null }, "POST /api/v1/salary-brackets"],
    ];
    for (const [state, expected] of cases) {
      const { sent, request } = requests();
      await saveSalaryBrackets(request, state, codes, input);
      expect(sent).toEqual([expected]);
    }
  });

  it("refuses a repeated grade code and a 201st grade before sending", () => {
    const values = { name: "Fictional Lead", code: "FG1", order: "30" };
    expect(gradeError(body, values, null)).toBe(
      "Another grade already uses this code.",
    );
    const full: JobArchitectureBody = {
      ...body,
      grades: Array.from({ length: 200 }, (_, index) => ({
        code: `FG${index + 1}`,
        name: `Fictional Grade ${index + 1}`,
        order: index + 1,
      })),
    };
    expect(gradeError(full, { ...values, code: "FG999" }, null)).toBe(
      "A job architecture holds at most 200 grades.",
    );
    expect(gradeError(body, { ...values, code: "FG3" }, null)).toBe("");
    expect(
      gradeError(body, { ...values, code: "FG3", order: "10" }, null),
    ).toBe("Another grade already uses this order.");
    expect(gradeError(body, { ...values, code: "fg3" }, null)).toContain(
      "capital letters",
    );
    expect(gradeError(body, { ...values, code: "FG3", name: " " }, null)).toBe(
      "Enter a name.",
    );
    expect(
      gradeError(body, { ...values, code: "FG3", order: "1.5" }, null),
    ).toBe("Enter the order as a whole number from 1 to 1000.");
    // Editing keeps the code and may keep the grade's own order.
    expect(gradeError(body, { ...values, order: "10" }, body.grades[1])).toBe(
      "",
    );
  });

  it("moves between the three sub-views with the arrow keys, Home and End", () => {
    const source = readFileSync(
      new URL(
        "../src/components/settings/job-architecture-panel.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toMatch(
      /role="tablist"\s+aria-label="Job architecture"\s+onKeyDown=\{tabKeys\}/,
    );
    const markup = view(owner);
    const tablist = markup.slice(
      markup.indexOf('role="tablist"'),
      markup.indexOf('role="tabpanel"'),
    );
    expect(tablist.match(/role="tab"/g)).toHaveLength(3);
    for (const label of [
      "Job grades &amp; salary brackets",
      "Job titles",
      "Job families",
    ])
      expect(tablist).toContain(`>${label}</button>`);
    expect(tablist.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(tablist.match(/tabindex="0"/g)).toHaveLength(1);
    expect(tablist).toContain(
      'id="job-tab-grades" aria-controls="job-panel-grades" tabindex="0" aria-selected="true"',
    );
    expect(markup).toContain(
      'role="tabpanel" id="job-panel-grades" aria-labelledby="job-tab-grades"',
    );
    const clicked: string[] = [];
    const doc = { activeElement: null as unknown };
    const buttons = ["grades", "titles", "families"].map((key) => ({
      key,
      focus() {
        doc.activeElement = this;
      },
      click() {
        clicked.push(key);
      },
    }));
    vi.stubGlobal("document", doc);
    try {
      const press = (key: string, from: number) => {
        doc.activeElement = buttons[from];
        const prevented = vi.fn();
        tabKeys({
          key,
          currentTarget: { querySelectorAll: () => buttons },
          preventDefault: prevented,
        } as unknown as Parameters<typeof tabKeys>[0]);
        return prevented.mock.calls.length;
      };
      expect(press("ArrowRight", 0)).toBe(1);
      expect(press("ArrowRight", 2)).toBe(1);
      expect(press("ArrowLeft", 0)).toBe(1);
      expect(press("ArrowLeft", 2)).toBe(1);
      expect(press("Home", 2)).toBe(1);
      expect(press("Enter", 1)).toBe(0);
      expect(press("End", 0)).toBe(1);
      expect(clicked).toEqual([
        "titles",
        "grades",
        "families",
        "titles",
        "grades",
        "families",
      ]);
      expect(doc.activeElement).toBe(buttons[2]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
