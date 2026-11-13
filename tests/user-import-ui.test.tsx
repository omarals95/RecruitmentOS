import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
}));

import {
  ClientError,
  teamRequester,
  WorkspaceProvider,
} from "../src/components/workspace/client";
import {
  AdminPortalView,
  type MeAccess,
} from "../src/components/settings/admin-portal";
import {
  REAUTH_CANCELLED,
  retryWithFreshSession,
} from "../src/components/settings/fresh-session-dialog";
import {
  afterApply,
  applyUserImportFile,
  BulkInviteView,
  checkUserImport,
} from "../src/components/settings/user-import";
import { XLSX_TYPE } from "../src/domain/org";
import type {
  UserImportReport,
  UserImportResult,
} from "../src/lib/user-import";

// Fictional people, teams, groups and workbook bytes only (ADM-15).
const workspace = {
  user: {
    id: "fictional-bulk-user",
    name: "Fictional Bulk User",
    email: "bulk-user@example.test",
    twoStepEnabled: true,
  },
  team: { id: "fictional-team", name: "Fictional Team", slug: "fictional" },
  role: "admin",
  environment: "Local development",
  canCreateTeam: true,
};
const access = (companyLevel: MeAccess["companyLevel"]): MeAccess => ({
  teamRole: "admin",
  companyLevel,
  teamArchived: false,
  planAccess: { read: false, write: false },
  role: { name: "Fictional role", membership: "admin" },
  scopes: [],
  pages: [],
  actions: {},
  fields: {},
  adminAreas: companyLevel === "admin" ? ["people"] : [],
});
const SHA = "b".repeat(64);
const report = (changes: Partial<UserImportReport> = {}): UserImportReport => ({
  sha256: SHA,
  counts: { invite: 2, alreadyDone: 1, groupAdd: 1, needsOwner: 1, refused: 2 },
  refused: [
    {
      row: 3,
      part: "invitation",
      reason: 'No team of the company is named "Fictional Nowhere".',
    },
    { row: 4, part: "row", reason: "Team, Team role and Group are all blank." },
  ],
  needsOwner: [
    {
      row: 5,
      part: "group",
      reason:
        'Adds sample@example.test to "Fictional Panel", which gives a role or approvals, itself or through a group it is in.',
    },
  ],
  flagged: [{ row: 6, column: "Group" }],
  ignored: ["Configured role"],
  truncated: false,
  ...changes,
});
const workbook = () =>
  new File([new Uint8Array([0x50, 0x4b, 0x05, 0x06])], "fictional.xlsx", {
    type: XLSX_TYPE,
  });
const view = (
  props: Partial<Parameters<typeof BulkInviteView>[0]> = {},
): string =>
  renderToStaticMarkup(
    <BulkInviteView
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

describe("Bulk invite", () => {
  it("shows the Bulk invite button on the Users page for a company owner and a company admin with people", () => {
    for (const level of ["owner", "admin"] as const) {
      const markup = renderToStaticMarkup(
        <WorkspaceProvider value={workspace}>
          <AdminPortalView
            tab="users"
            access={{ ...access(level), pages: [] }}
            denied={false}
            error=""
          />
        </WorkspaceProvider>,
      );
      expect(markup, level).toContain("<h2>Users</h2>");
      expect(button(markup, "Bulk invite"), level).toBe(
        '<button type="button" class="button secondary">Bulk invite</button>',
      );
      // The dialog opens only from the button.
      expect(markup, level).not.toContain("<dialog");
    }
  });

  it("offers a workbook input and Check file, and describes the columns and what is ignored", () => {
    const markup = view({ file: null });
    expect(markup).toMatch(/<input type="file" accept="\.xlsx,/);
    expect(button(markup, "Check file")).toContain("disabled");
    expect(button(view(), "Check file")).not.toContain("disabled");
    expect(markup).toContain(
      "names the columns Email, Team, Team role and Group in row 1",
    );
    expect(markup).toContain(
      "Configured role, company authority, area and any other columns are ignored.",
    );
    // Before a check there is nothing to apply.
    expect(button(markup, "Apply")).toContain("disabled");
    expect(markup).not.toContain("Apply company owner changes");
  });

  it("shows the busy status with every control disabled, and the API's own refusal as an alert", () => {
    for (const [busy, text] of [
      ["check", "Checking the file…"],
      ["normal", "Applying…"],
      ["owner", "Applying…"],
    ] as const) {
      const markup = view({ busy, report: report() });
      expect(markup).toContain(`<p role="status">${text}</p>`);
      expect(markup).toMatch(/<input type="file"[^>]*disabled/);
      for (const label of [
        "Check file",
        "Apply",
        "Apply company owner changes",
      ])
        expect(button(markup, label), label).toContain("disabled");
    }
    for (const message of [
      "Only a company owner, or a company admin with the People area, can see the users list.",
      "This file is not the one you checked. Choose the file again and run Check file before applying it.",
      "The file is larger than 5 MiB. Split the workbook and import each part.",
    ])
      expect(view({ error: message })).toContain(
        `<p class="notice error" role="alert">${message}</p>`,
      );
  });

  it("shows the counts, refused rows, ignored columns, flagged cells and Needs a company owner, with the owner and the admin wording", () => {
    const owner = view({ report: report() });
    expect(owner).toContain(
      "<caption>What applying the file would do</caption>",
    );
    for (const header of [
      "Invitations to send",
      "Already invited or a member",
      "Group adds",
      "Needs a company owner",
      "Refused",
    ])
      expect(owner, header).toContain(`<th>${header}</th>`);
    expect(owner).toContain('<td data-label="Invitations to send">2</td>');
    expect(owner).toContain("<h3>Refused rows</h3>");
    expect(owner).toContain(
      "No team of the company is named &quot;Fictional Nowhere&quot;.",
    );
    expect(owner).toContain(
      '<td data-label="Part" style="width:1%;white-space:nowrap">Whole row</td>',
    );
    expect(owner).toContain("<h3>Ignored columns</h3>");
    expect(owner).toContain("Configured role");
    expect(owner).toContain("<h3>Flagged cells</h3>");
    expect(owner).toContain("<h3>Needs a company owner</h3>");
    expect(owner).toContain("Apply them with Apply company owner changes.");
    expect(button(owner, "Apply")).not.toContain("disabled");
    expect(button(owner, "Apply company owner changes")).not.toContain(
      "disabled",
    );
    const admin = view({ report: report(), owner: false });
    expect(admin).toContain("A company owner must apply these rows.");
    expect(admin).not.toContain("Apply company owner changes");
    // The phone layout labels each cell; no new colour or class is needed for the dark theme.
    expect(owner).toContain('class="table-wrap"');
    expect(owner).toContain('class="data-table compact"');
  });

  it("keeps Apply disabled with a line saying so when there is nothing to send or add, and the owner step only with owner rows", () => {
    const empty = view({
      report: report({
        counts: {
          invite: 0,
          alreadyDone: 3,
          groupAdd: 0,
          needsOwner: 0,
          refused: 1,
        },
        needsOwner: [],
      }),
    });
    expect(button(empty, "Apply")).toContain("disabled");
    expect(empty).toContain(
      "There are no invitations to send or group adds to make, so there is nothing to apply.",
    );
    expect(empty).not.toContain("Apply company owner changes");
  });

  it("shows each applied step's result and keeps it from being applied twice", () => {
    const result: UserImportResult = {
      ...report(),
      counts: {
        invite: 2,
        alreadyDone: 1,
        groupAdd: 1,
        needsOwner: 1,
        refused: 3,
      },
      group: "normal",
    };
    const markup = view({ report: report(), applied: [result] });
    expect(markup).toContain(
      '<p role="status">The bulk invite was applied.</p>',
    );
    expect(markup).toContain("<caption>What the bulk invite did</caption>");
    expect(markup).toContain('<td data-label="Invitations sent">2</td>');
    expect(markup).toContain('<td data-label="Refused">3</td>');
    expect(button(markup, "Apply")).toContain("disabled");
    const owner = view({
      report: report(),
      applied: [result, { ...result, group: "owner" }],
    });
    expect(owner).toContain(
      '<p role="status">The company owner changes were applied.</p>',
    );
    expect(button(owner, "Apply company owner changes")).toContain("disabled");
  });

  it("sends Check file and apply as the raw workbook, apply with the dry run's sha256", async () => {
    const result: UserImportResult = { ...report(), group: "normal" };
    const fetch = vi.fn(async (path: string) =>
      Response.json({ data: path.includes("dry-run") ? report() : result }),
    );
    vi.stubGlobal("fetch", fetch);
    const file = workbook();
    const request = teamRequester("fictional-team");
    const plain = <T,>(work: () => Promise<T>) => work();
    expect((await checkUserImport(request, file)).data.sha256).toBe(SHA);
    await applyUserImportFile(request, file, SHA, "normal", plain);
    await applyUserImportFile(request, file, SHA, "owner", plain);
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([path]) => path)).toEqual([
      "/api/v1/admin/users/import/dry-run",
      `/api/v1/admin/users/import/apply?sha256=${SHA}`,
      `/api/v1/admin/users/import/apply?sha256=${SHA}&group=owner`,
    ]);
    for (const [, init] of calls) {
      expect(init.method).toBe("POST");
      expect(init.body).toBe(file);
      const headers = new Headers(init.headers);
      expect(headers.get("content-type")).toBe(XLSX_TYPE);
      expect(headers.get("x-team-id")).toBe("fictional-team");
    }
  });

  it("retries apply once after re-authentication, and sends nothing more when it is cancelled, keeping the report", async () => {
    const result: UserImportResult = { ...report(), group: "owner" };
    const stale = () =>
      Response.json(
        {
          error: {
            code: "SESSION_NOT_FRESH",
            message:
              "This change needs a recent sign-in. Confirm your password and two-step code, then try again.",
          },
        },
        { status: 403 },
      );
    const request = teamRequester("fictional-team");
    const file = workbook();
    const earlier: UserImportResult[] = [{ ...report(), group: "normal" }];
    for (const confirmed of [true, false]) {
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          calls++ ? Response.json({ data: result }) : stale(),
        ),
      );
      const ask = vi.fn(async () => confirmed);
      const outcome = await applyUserImportFile(
        request,
        file,
        SHA,
        "owner",
        (work) => retryWithFreshSession(work, ask),
      );
      expect(ask).toHaveBeenCalledTimes(1);
      expect(calls).toBe(confirmed ? 2 : 1);
      expect(outcome).toEqual(confirmed ? { data: result } : REAUTH_CANCELLED);
      // A cancelled re-authentication leaves the applied steps as they were; the report stays.
      const applied = afterApply(earlier, outcome);
      if (confirmed) expect(applied).toEqual([...earlier, result]);
      else expect(applied).toBe(earlier);
      const markup = view({ report: report(), applied });
      expect(markup).toContain("<h3>Needs a company owner</h3>");
      expect(button(markup, "Apply company owner changes")).toBe(
        confirmed
          ? '<button type="button" class="button secondary" disabled="">Apply company owner changes</button>'
          : '<button type="button" class="button secondary">Apply company owner changes</button>',
      );
    }
    // Any other refusal is the API's own error.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "user_import_forbidden",
              message: "Fictional refusal.",
            },
          },
          { status: 403 },
        ),
      ),
    );
    await expect(
      applyUserImportFile(request, file, SHA, "normal", (work) =>
        retryWithFreshSession(work, async () => true),
      ),
    ).rejects.toBeInstanceOf(ClientError);
  });
});
