import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
}));

import {
  teamRequester,
  WorkspaceProvider,
} from "../src/components/workspace/client";
import {
  AdminPortalView,
  type MeAccess,
} from "../src/components/settings/admin-portal";
import {
  applyImport,
  checkImport,
  OrgImportView,
  type AppliedImport,
} from "../src/components/settings/org-import-panel";
import { XLSX_TYPE } from "../src/domain/org";
import type { ImportReport } from "../src/lib/org-import";

// Fictional people, codes and workbook bytes only (R2a-17).
const workspace = {
  user: {
    id: "fictional-import-user",
    name: "Fictional Import User",
    email: "import-user@example.test",
    twoStepEnabled: true,
  },
  team: { id: "fictional-team", name: "Fictional Team", slug: "fictional" },
  role: "owner",
  environment: "Local development",
  canCreateTeam: true,
};
const access = (
  companyLevel: MeAccess["companyLevel"],
  organisation = false,
): MeAccess => ({
  teamRole: "admin",
  companyLevel,
  teamArchived: false,
  planAccess: { read: false, write: false },
  role: { name: "Fictional role", membership: "admin" },
  scopes: [],
  pages: [],
  actions: {},
  fields: {},
  adminAreas: organisation ? ["organisation"] : [],
});
const SHA = "a".repeat(64);
const counts = (create: number, update: number, needsOwner = 0) => ({
  create,
  update,
  unchanged: 1,
  reject: 1,
  needsOwner,
});
const report = (changes: Partial<ImportReport> = {}): ImportReport => ({
  sha256: SHA,
  sheets: {
    units: counts(1, 0, 1),
    positions: counts(0, 1),
    employees: counts(1, 0),
  },
  rejected: [
    {
      sheet: "Units",
      row: 5,
      reason: 'Unit BAD-LVL: unknown level "Fictional Region".',
    },
  ],
  needsOwner: [
    {
      sheet: "Units",
      row: 3,
      reason: "Unit DIV-B: moves the unit to another parent.",
    },
  ],
  flagged: [{ sheet: "Employees", row: 2, column: "Work phone" }],
  truncated: false,
  ...changes,
});
const workbook = () =>
  new File([new Uint8Array([0x50, 0x4b, 0x05, 0x06])], "fictional.xlsx", {
    type: XLSX_TYPE,
  });
const view = (
  props: Partial<Parameters<typeof OrgImportView>[0]> = {},
): string =>
  renderToStaticMarkup(
    <OrgImportView
      file={workbook()}
      report={null}
      applied={[]}
      busy={null}
      error=""
      owner
      {...props}
    />,
  );
const button = (markup: string, label: string) =>
  new RegExp(`<button[^>]*>${label}</button>`).exec(markup)?.[0] ?? null;

afterEach(() => vi.unstubAllGlobals());

describe("Import from Excel panel", () => {
  it("shows on the Organisation tab for a company owner and a company admin with the organisation area", () => {
    for (const value of [access("owner"), access("admin", true)]) {
      const markup = renderToStaticMarkup(
        <WorkspaceProvider value={workspace}>
          <AdminPortalView
            tab="organisation"
            access={value}
            denied={false}
            error=""
          />
        </WorkspaceProvider>,
      );
      expect(markup).toContain("<h2>Import from Excel</h2>");
      expect(markup).toContain(
        "Units (Code, Name, Level, Parent code), Positions (Code, Title, Unit code, Manager) and Employees (Employee number, Name, Work email, Work phone, Position codes, Primary position)",
      );
      expect(markup).toMatch(/<input type="file" accept="\.xlsx,/);
      expect(button(markup, "Check file")).toContain("disabled");
    }
  });

  it("sends Check file as the raw workbook with the xlsx content type", async () => {
    const fetch = vi.fn(async () => Response.json({ data: report() }));
    vi.stubGlobal("fetch", fetch);
    const file = workbook();
    const result = await checkImport(teamRequester("fictional-team"), file);
    expect(result.data.sha256).toBe(SHA);
    const [path, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toBe("/api/v1/org-import/dry-run");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(file);
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe(XLSX_TYPE);
    expect(headers.get("x-team-id")).toBe("fictional-team");
  });

  it("keeps Apply import disabled until a dry run counts a change, then sends its sha256 with the same file", async () => {
    expect(button(view(), "Apply import")).toContain("disabled");
    expect(
      button(
        view({
          report: report({
            sheets: {
              units: counts(0, 0),
              positions: counts(0, 0),
              employees: counts(0, 0),
            },
          }),
        }),
        "Apply import",
      ),
    ).toContain("disabled");
    expect(button(view({ report: report() }), "Apply import")).not.toContain(
      "disabled",
    );
    const applied: AppliedImport = { ...report(), group: "normal" };
    expect(
      button(view({ report: report(), applied: [applied] }), "Apply import"),
    ).toContain("disabled");
    const fetch = vi.fn(async () => Response.json({ data: applied }));
    vi.stubGlobal("fetch", fetch);
    const file = workbook();
    await applyImport(teamRequester("fictional-team"), file, SHA, "normal");
    await applyImport(teamRequester("fictional-team"), file, SHA, "owner");
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([path]) => path)).toEqual([
      `/api/v1/org-import/apply?sha256=${SHA}`,
      `/api/v1/org-import/apply?sha256=${SHA}&group=owner`,
    ]);
    for (const [, init] of calls) {
      expect(init.body).toBe(file);
      expect(new Headers(init.headers).get("content-type")).toBe(XLSX_TYPE);
    }
  });

  it("shows the counts, rejected rows, flagged cells and the owner group", () => {
    const markup = view({ report: report({ truncated: true }) });
    expect(markup).toContain(
      "<caption>What the import would change, by sheet</caption>",
    );
    expect(markup).toContain("<th>Needs a company owner</th>");
    expect(markup).toContain("<h3>Rejected rows</h3>");
    expect(markup).toContain(
      "Unit BAD-LVL: unknown level &quot;Fictional Region&quot;.",
    );
    expect(markup).toContain("<h3>Flagged cells</h3>");
    expect(markup).toMatch(/<td data-label="Column"[^>]*>Work phone<\/td>/);
    expect(markup).toContain("<h3>Needs a company owner</h3>");
    expect(markup).toContain("Unit DIV-B: moves the unit to another parent.");
    expect(markup).toContain("Each list below shows its first 500 rows");
    expect(view({ error: "The file is larger than 5 MiB." })).toContain(
      '<p class="notice error" role="alert">The file is larger than 5 MiB.</p>',
    );
  });

  it("offers Apply company owner changes only to company owners, and tells company admins who applies them", () => {
    const owner = view({ report: report() });
    expect(button(owner, "Apply company owner changes")).not.toBeNull();
    expect(owner).not.toContain("A company owner must apply these rows.");
    const admin = view({ report: report(), owner: false });
    expect(admin).not.toContain("Apply company owner changes");
    expect(admin).toContain("A company owner must apply these rows.");
    // No owner group, no owner button.
    expect(
      view({
        report: report({
          needsOwner: [],
          sheets: {
            units: counts(1, 0),
            positions: counts(0, 1),
            employees: counts(1, 0),
          },
        }),
      }),
    ).not.toContain("Apply company owner changes");
  });
});
