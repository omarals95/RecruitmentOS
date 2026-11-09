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
  NO_FILTERS,
  directoryPath,
} from "../src/components/settings/directory-tab";
import {
  UnitPickerView,
  pickerPath,
} from "../src/components/settings/unit-picker";
import type { Requester } from "../src/components/workspace/optimistic";
import type { Action } from "../src/domain/config";
import type { Employee, Position } from "../src/lib/directory";
import type { OrgLevel, OrgUnit } from "../src/lib/org";

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
  options: { organisation?: boolean; directory?: Action[] } = {},
): MeAccess => ({
  teamRole,
  companyLevel,
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
      expect(markup, tab).not.toContain("settings-nav");
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
    expect(level).toContain(
      'Archive<span class="sr-only">: Fictional Company</span></button></div><p class="notice error" role="alert">The level or unit is archived',
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
    expect(full).toContain('data-label="Work email">unlinked@example.test<');
    expect(full).toContain('data-label="Work phone">+00 1111 1111<');
    expect(full).toContain('data-label="Work email">Not recorded<');
  });

  it("offers erase, link, unlink and a linked row's positions only to a company owner", () => {
    const owner = rowsOf(table(rows, true));
    const admin = rowsOf(table(rows, false));
    const [unlinked, linked] = rows.map((row) => row.displayName);
    expect(owner[0]).toContain(button("Permanently erase employee", unlinked));
    expect(owner[1]).toContain(button("Permanently erase employee", linked));
    expect(owner[0]).toContain(button("Link to user", unlinked));
    expect(owner[0]).not.toContain("Unlink user");
    expect(owner[1]).toContain(button("Unlink user", linked));
    expect(owner[1]).not.toContain(">Link to user");
    expect(owner[1]).toContain(button("Positions", linked));
    for (const row of admin) {
      expect(row).not.toContain("Permanently erase");
      expect(row).not.toContain("Link to user");
      expect(row).not.toContain("Unlink user");
    }
    expect(admin[1]).not.toContain(">Positions");
    // An unlinked row's positions need directory edit only.
    expect(admin[0]).toContain(button("Positions", unlinked));
    expect(admin[0]).toContain(button("Edit", unlinked));
    expect(admin[0]).toContain(button("Archive", unlinked));
    const viewOnly = rowsOf(table(rows, false, ["view"]));
    for (const row of viewOnly) expect(row).not.toMatch(/<button/);
    // A company owner without directory edit cannot link or place.
    const ownerView = rowsOf(table(rows, true, ["view"]));
    expect(ownerView[0]).not.toMatch(/>(Link to user|Positions|Edit)<span/);
    expect(ownerView[0]).toContain("Permanently erase employee");
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
