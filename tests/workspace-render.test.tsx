import {
  isValidElement,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/pipeline",
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  useSearchParams: () => navigation.params,
}));

import { WorkspaceProvider } from "../src/components/workspace/client";
import {
  ArchivedTeamNotice,
  TeamOptions,
  WorkspaceShell,
} from "../src/components/workspace/shell";
import { DisplayModeToggle } from "../src/components/workspace/display-mode-toggle";
import {
  ApplicationReference,
  BOARD_UNAVAILABLE,
  ExportControl,
  FilterTags,
  Kanban,
  Loading,
  RecordDetail,
  RecordsScreen,
  TaskBoardNotice,
  TaskBoardSwitcher,
  boardBuckets,
  taskBoardChoice,
  withoutImportLink,
  type TaskBoardOption,
} from "../src/components/workspace/records-screen";
import {
  AssigneePicker,
  RecordEditor,
} from "../src/components/workspace/editor";
import {
  assigneeInput,
  recordMutation,
  vacancyTitleInput,
} from "../src/components/workspace/mutation";
import {
  JobTitlePickerView,
  loadJobTitleChoices,
} from "../src/components/settings/job-title-picker";
import type { Requester } from "../src/components/workspace/optimistic";
import type { JobArchitecture } from "../src/lib/job-architecture";
import type { SalaryBracketVersion } from "../src/lib/pay-brackets";
import {
  defaultListQuery,
  listSearchParams,
} from "../src/components/workspace/tab-requests";
import { addFilterTag } from "../src/components/workspace/helpers";
import WorkspaceLoading from "../src/app/app/loading";
import {
  BulkCvImport,
  BulkCvImportDialog,
  RecentImports,
  SelectedCvList,
  type CvImportState,
  type RecentImportsPage,
} from "../src/components/workspace/bulk-cv-import";
import {
  BULK_INTAKE_MAX_FILES,
  BULK_INTAKE_RECOVERY_HOURS,
  type RecordDto,
  type ResourceName,
} from "../src/domain/records";
import { ConfirmDialog } from "../src/components/ui/confirm-dialog";
import {
  AI_EXTRACTION_DATA_SENT,
  AI_EXTRACTION_LIMITS_TEXT,
  AI_EXTRACTION_PURPOSE,
} from "../src/domain/cv-extraction";
import { AuthForm } from "../src/components/auth/auth-form";
import { versionLabel } from "../src/lib/app-version";
import { rules } from "./helpers/css";
import { contactBody } from "./helpers/kind-schemas";
import type { KindSchemaBody } from "../src/domain/config";

const workspace = {
  user: {
    id: "fictional-user",
    name: "Fictional Recruiter",
    email: "recruiter@example.test",
    twoStepEnabled: true,
  },
  team: { id: "fictional-team", name: "Fictional Team", slug: "fictional" },
  role: "recruiter",
  environment: "Local development",
  canCreateTeam: true,
};
const buttonSvg = (markup: string, label: string) =>
  new RegExp(`aria-label="${label}"[^>]*>(<svg[\\s\\S]*?</svg>)`).exec(
    markup,
  )?.[1];

describe("workspace shell", () => {
  it("names the search button at every width, not only through its hidden text", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <WorkspaceShell identity={workspace}>
          <p>Fictional page</p>
        </WorkspaceShell>
      </WorkspaceProvider>,
    );
    const button = /<button[^>]*class="search-launcher"[^>]*>/.exec(
      markup,
    )?.[0];
    expect(button).toBeDefined();
    expect(button).toContain('aria-label="Search your workspace"');
  });
  it("offers team creation in the switcher only to people who may create a team", () => {
    const switcher = (canCreateTeam: boolean) => {
      const value = { ...workspace, team: null, role: null, canCreateTeam };
      return renderToStaticMarkup(
        <WorkspaceProvider value={value}>
          <WorkspaceShell identity={value}>
            <p>Fictional page</p>
          </WorkspaceShell>
        </WorkspaceProvider>,
      );
    };
    const allowed = switcher(true);
    expect(allowed).toMatch(
      /<option value=""[^>]*>Create or join a team<\/option>/,
    );
    expect(allowed).not.toContain("No team yet");
    const member = switcher(false);
    expect(member).toMatch(/<option value=""[^>]*>No team yet<\/option>/);
    expect(member).not.toContain("Create or join a team");
  });
  // ADM-05 (job 078): a select cannot show a badge, so an archived team says so in its option.
  it("labels each archived team's switcher option (Archived)", () => {
    const options = (team: { id: string; name: string } | null) =>
      renderToStaticMarkup(
        <select>
          <TeamOptions
            team={team}
            teams={[
              { id: "fictional-team", name: "Fictional Team" },
              { id: "fictional-archived", name: "Fictional Archived Team" },
            ]}
            archivedIds={["fictional-archived", "fictional-missing"]}
            canCreateTeam
          />
        </select>,
      );
    expect(options(workspace.team)).toBe(
      '<select><option value="fictional-team">Fictional Team</option><option value="fictional-archived">Fictional Archived Team (Archived)</option></select>',
    );
    // The active team outside the list keeps its own label too.
    expect(
      options({ id: "fictional-missing", name: "Fictional Missing Team" }),
    ).toContain(
      '<option value="fictional-missing">Fictional Missing Team (Archived)</option>',
    );
    expect(options(null)).toContain(
      '<option value="">Create or join a team</option>',
    );
  });
  it("shows one status notice above the page while the active team is archived, none otherwise", () => {
    expect(renderToStaticMarkup(<ArchivedTeamNotice archived />)).toBe(
      '<p class="notice" role="status" style="margin-bottom:16px">This team is archived. You can read everything, but changes are turned off until a team owner restores it.</p>',
    );
    expect(renderToStaticMarkup(<ArchivedTeamNotice archived={false} />)).toBe(
      "",
    );
    // An active team, before the read answers: no notice in the shell.
    const markup = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <WorkspaceShell identity={workspace}>
          <p>Fictional page</p>
        </WorkspaceShell>
      </WorkspaceProvider>,
    );
    expect(markup).not.toContain("This team is archived");
    expect(markup).toContain(
      '<main id="main-content" class="workspace-main"><p>Fictional page</p>',
    );
    // The shell reads the archived teams once per team and places the notice first in main.
    const source = readFileSync(
      new URL("../src/components/workspace/shell.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      'const ARCHIVED_TEAMS_PATH = "/api/v1/me/archived-teams";',
    );
    expect(source).toMatch(
      /<main id="main-content" className="workspace-main">\s*<ArchivedTeamNotice\s*archived=\{!!team && archivedIds\.includes\(team\.id\)\}\s*\/>/,
    );
    expect(source).toContain("<TeamSwitcher archivedIds={archivedIds} />");
  });
  it("shows the version label in the footer, which the phone rule leaves visible", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "1.0.0");
    vi.stubEnv("NEXT_PUBLIC_APP_BUILD", "20261108.1430");
    try {
      const markup = renderToStaticMarkup(
        <WorkspaceProvider value={workspace}>
          <WorkspaceShell identity={workspace}>
            <p>Fictional page</p>
          </WorkspaceShell>
        </WorkspaceProvider>,
      );
      const footer =
        /<footer class="workspace-footer">([\s\S]*?)<\/footer>/.exec(
          markup,
        )?.[1];
      expect(versionLabel()).toBe("Version 1.0.0 (build 20261108.1430)");
      const spans = [...(footer ?? "").matchAll(/<span>(.*?)<\/span>/g)].map(
        (match) => match[1],
      );
      expect(spans).toContain(versionLabel());
      // At phone width .workspace-footer span:last-child hides only the timezone line.
      expect(spans.at(-1)).toBe("Dates and times: Asia/Dubai (UTC+4)");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("sign-in version", () => {
  const options = {
    configured: true,
    google: false,
    microsoft: false,
    emailPassword: true as const,
    publicSignup: false,
    bootstrapConfigured: false,
  };
  it("shows the version label below the auth footer in sign-in mode only", () => {
    const signIn = renderToStaticMarkup(
      <AuthForm mode="sign-in" options={options} />,
    );
    expect(signIn).toMatch(
      new RegExp(
        `</footer><p class="auth-version">${versionLabel().replace(/[().]/g, "\\$&")}</p>`,
      ),
    );
    for (const mode of ["sign-up", "forgot-password"] as const)
      expect(
        renderToStaticMarkup(<AuthForm mode={mode} options={options} />),
      ).not.toContain(versionLabel());
  });
  it("keeps the version line small, outranking the .auth-card > p rule", () => {
    const all = rules("src/app/globals.css");
    const paragraph = all.find((rule) => rule.selector === ".auth-card > p");
    const version = all.find(
      (rule) => rule.selector === ".auth-card > .auth-version",
    );
    expect(paragraph?.body).toMatch(/font-size:\s*13px/);
    expect(version?.body).toMatch(/font-size:\s*10px/);
    expect(version?.body).toMatch(/margin:\s*16px 0 0/);
  });
});

describe("loading skeletons", () => {
  it("renders list-row placeholders with a status and the screen-reader text", () => {
    expect(
      existsSync(new URL("../src/app/app/loading.tsx", import.meta.url)),
    ).toBe(true);
    for (const markup of [
      renderToStaticMarkup(<Loading />),
      renderToStaticMarkup(<WorkspaceLoading />),
    ]) {
      expect(markup).toMatch(/<div class="skeleton-list" role="status">/);
      expect(markup).toContain(
        '<span class="sr-only">Loading your workspace…</span>',
      );
      expect(markup.match(/class="skeleton-row"/g)).toHaveLength(5);
      expect(markup).not.toContain("spin");
    }
  });
  it("draws the placeholders with existing colour variables only", () => {
    const css = rules("src/app/globals.css");
    const block = css.find((item) => item.selector === ".skeleton-block");
    expect(block?.body).toMatch(/background:\s*var\(--surface-subtle\)/);
    for (const item of css.filter((rule) =>
      rule.selector.startsWith(".skeleton"),
    ))
      expect(item.body, item.selector).not.toMatch(
        /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i,
      );
  });
});

describe("workspace accessibility styles", () => {
  const css = rules("src/app/globals.css");
  const rule = (selector: string, media = "") =>
    css.find((item) => item.selector === selector && item.media === media);
  it("keeps visually hidden text inside the board and table scrollers", () => {
    for (const selector of [".kanban", ".table-wrap"])
      expect(rule(selector)?.body, selector).toMatch(
        /(^|;)\s*position:\s*relative\s*;/,
      );
  });
  it("draws outside-month days and cancelled interviews without opacity", () => {
    for (const selector of [
      ".calendar-day.outside-month .calendar-day-number",
      ".calendar-event.cancelled",
    ]) {
      expect(rule(selector), selector).toBeDefined();
      expect(rule(selector)!.body, selector).not.toMatch(/opacity/);
    }
    expect(rule(".calendar-event.cancelled")!.body).toMatch(
      /text-decoration:\s*line-through/,
    );
  });
  it("gives +N more a 24 px target", () => {
    const height = /min-height:\s*(\d+)px/.exec(
      rule(".calendar-more")?.body ?? "",
    );
    expect(Number(height?.[1])).toBeGreaterThanOrEqual(24);
  });
  it("takes the closed phone menu out of the tab order", () => {
    const phone = "@media (max-width: 720px)";
    expect(rule(".workspace-sidebar:not(.is-open)", phone)?.body).toMatch(
      /visibility:\s*hidden/,
    );
    expect(rule(".workspace-sidebar.is-open", phone)?.body).toMatch(
      /visibility:\s*visible/,
    );
    expect(
      css.some(
        (item) =>
          item.media === "" &&
          item.selector.includes(".workspace-sidebar") &&
          /visibility/.test(item.body),
      ),
    ).toBe(false);
  });
});

describe("dark theme controls", () => {
  const css = rules("src/app/globals.css");
  const selectors = (rule: { selector: string }) =>
    rule.selector.split(",").map((part) => part.trim());
  const literal = /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i;
  // The theme variables block also sets color-scheme; this is the rule that names the controls.
  const controlScheme = () =>
    css.find(
      (rule) =>
        /color-scheme:\s*dark/.test(rule.body) &&
        selectors(rule).includes(':root[data-theme="dark"] input'),
    );
  it("gives options and option groups the theme's surface and text colours", () => {
    const list = css.filter(
      (rule) =>
        rule.media === "" &&
        selectors(rule).includes("option") &&
        selectors(rule).includes("optgroup"),
    );
    expect(list).toHaveLength(1);
    expect(list[0].body).toMatch(/background-color:\s*var\(--surface\)/);
    expect(list[0].body).toMatch(/(^|;)\s*color:\s*var\(--text\)/);
    // Nothing overrides them inside the transparent team switcher or theme picker.
    expect(
      css.some((rule) =>
        selectors(rule).some((part) =>
          /\.(team-switcher|theme-picker)\b.*\b(option|optgroup)\b/.test(part),
        ),
      ),
    ).toBe(false);
    const disabled = css.find((rule) =>
      selectors(rule).includes("option:disabled"),
    );
    expect(disabled?.body).toMatch(/color:\s*var\(--muted\)/);
  });
  it("sets a dark color-scheme on every native control in the dark theme", () => {
    const scheme = controlScheme();
    expect(scheme).toBeDefined();
    for (const control of [
      "input",
      "select",
      "textarea",
      "option",
      "optgroup",
      "datalist",
    ])
      expect(selectors(scheme!), control).toContain(
        `:root[data-theme="dark"] ${control}`,
      );
  });
  it("draws file buttons and scrollbars with theme variables only", () => {
    const button = css.filter((rule) =>
      rule.selector.includes("::file-selector-button"),
    );
    expect(button).toHaveLength(1);
    expect(button[0].body).toMatch(/background:\s*var\(--surface-subtle\)/);
    expect(button[0].body).toMatch(/(^|;)\s*color:\s*var\(--text\)/);
    expect(button[0].body).toMatch(
      /border:\s*1px solid var\(--border-strong\)/,
    );
    const scrollbars = css.filter((rule) => /scrollbar-color/.test(rule.body));
    for (const rule of scrollbars)
      expect(rule.body, rule.selector).toMatch(
        /scrollbar-color:\s*var\(--[\w-]+\)\s+(var\(--[\w-]+\)|transparent)\s*;/,
      );
    const dark = scrollbars.find((rule) =>
      selectors(rule).includes(':root[data-theme="dark"]'),
    );
    for (const scroller of [
      ".kanban",
      ".table-wrap",
      ".calendar-scroll",
      ".dialog",
    ])
      expect(selectors(dark!), scroller).toContain(
        `:root[data-theme="dark"] ${scroller}`,
      );
    for (const rule of [
      ...css.filter((item) =>
        selectors(item).some((part) => /\b(option|optgroup)\b/.test(part)),
      ),
      controlScheme()!,
      ...css.filter((item) => item.selector.includes('input[type="file"]')),
      ...scrollbars,
    ])
      expect(rule.body, rule.selector).not.toMatch(literal);
  });
});

describe("skill and certification filters", () => {
  it("ignores a case or spacing variant of a chosen tag and keeps the first spelling", () => {
    expect(addFilterTag(["React"], "react")).toEqual(["React"]);
    expect(addFilterTag(["React"], "  REACT ")).toEqual(["React"]);
    expect(addFilterTag(["React"], "   ")).toEqual(["React"]);
    expect(addFilterTag(["React"], " Go ")).toEqual(["React", "Go"]);
  });
  it("offers suggestions in a linked datalist without the chosen tags", () => {
    const markup = renderToStaticMarkup(
      <FilterTags
        label="All of these skills"
        values={["react"]}
        onChange={() => {}}
        suggestions={["React", "TypeScript", "Go"]}
        onFocus={() => {}}
      />,
    );
    const list = /<input[^>]*list="([^"]+)"/.exec(markup)?.[1];
    expect(list).toBeDefined();
    const datalist = new RegExp(
      `<datalist id="${list}">([\\s\\S]*?)</datalist>`,
    ).exec(markup)?.[1];
    expect(
      [...(datalist ?? "").matchAll(/<option value="([^"]+)"/g)].map(
        (match) => match[1],
      ),
    ).toEqual(["TypeScript", "Go"]);
    // Without suggestions (folder categories) there is no list at all.
    const plain = renderToStaticMarkup(
      <FilterTags
        label="Any of these folder categories"
        values={[]}
        onChange={() => {}}
      />,
    );
    expect(plain).not.toContain("list=");
    expect(plain).not.toContain("<datalist");
  });
});

describe("application names on the board and table", () => {
  const application = (
    index: number,
    labels: Partial<RecordDto>,
    stage = "Sourced",
  ): RecordDto =>
    ({
      id: `00000000-0000-4000-8000-00000000010${index}`,
      kind: "application",
      data: { stage },
      version: 1,
      legacyId: null,
      createdBy: "fictional-user",
      privateOwnerId: null,
      createdAt: "2026-11-08T10:00:00.000Z",
      updatedAt: "2026-11-08T10:00:00.000Z",
      archivedAt: null,
      candidateId: `00000000-0000-4000-8000-00000000020${index}`,
      vacancyId: "00000000-0000-4000-8000-000000000301",
      applicationId: null,
      onboardingId: null,
      bucketId: null,
      jobRoleId: null,
      parentRecordId: null,
      ...labels,
    }) as RecordDto;
  const records = [
    application(1, {
      candidateLabel: "Alex Example",
      vacancyLabel: "Fictional Engineer",
    }),
    application(
      2,
      {
        candidateLabel: "Sam Sample (archived)",
        vacancyLabel: "Fictional Engineer",
      },
      "Screening",
    ),
    application(3, { vacancyLabel: "Fictional Engineer" }, "Interview"),
  ];
  it("shows the names from the list and requests no candidate or vacancy", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const board = renderToStaticMarkup(
        <WorkspaceProvider value={workspace}>
          <Kanban
            resource="applications"
            records={records}
            buckets={[]}
            onOpen={() => {}}
            onMove={() => {}}
            canWrite
          />
        </WorkspaceProvider>,
      );
      const cards = [
        ...board.matchAll(/<article class="kanban-card"[\s\S]*?<\/article>/g),
      ].map((match) => match[0]);
      expect(cards).toHaveLength(3);
      expect(cards[0]).toContain("<span>Alex Example</span>");
      expect(cards[1]).toContain("<span>Sam Sample (archived)</span>");
      // Without candidates:read the name is left out, as a refused read showed it.
      expect(cards[2]).toContain("<span>Unavailable record</span>");
      for (const card of cards)
        expect(card).toContain("<span>Fictional Engineer</span>");
      const table = renderToStaticMarkup(
        <WorkspaceProvider value={workspace}>
          <table>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>
                    <ApplicationReference record={record} field="candidate" />
                  </td>
                  <td>
                    <ApplicationReference record={record} field="vacancy" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </WorkspaceProvider>,
      );
      expect(table).toContain(
        `<a href="/app/candidates/${records[0].candidateId}">Alex Example</a>`,
      );
      expect(table).toContain("<span>Unavailable record</span>");
      expect(table).not.toContain(
        `href="/app/candidates/${records[2].candidateId}"`,
      );
      for (const markup of [board, table]) {
        expect(markup).not.toContain("Loading…");
        expect(markup).not.toContain("Could not load record");
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
    // The Applications screen's table cells and cards use the list's names, not a GET each.
    const source = readFileSync(
      new URL(
        "../src/components/workspace/records-screen.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).not.toMatch(
      /<ReferenceLabel\s+resource="(candidates|vacancies)"/,
    );
    expect(source.match(/<ApplicationReference\b/g)).toHaveLength(4);
  });
});

describe("display mode toggle", () => {
  it("uses a distinct board icon and hides every icon from assistive technology", () => {
    const markup = renderToStaticMarkup(
      <DisplayModeToggle board mode="board" onChange={() => {}} />,
    );
    const board = buttonSvg(markup, "Board view");
    const cards = buttonSvg(markup, "Card view");
    expect(board).toBeDefined();
    expect(cards).toBeDefined();
    expect(board).not.toBe(cards);
    const svgs = markup.match(/<svg[^>]*>/g) ?? [];
    expect(svgs).toHaveLength(3);
    for (const svg of svgs) expect(svg).toContain('aria-hidden="true"');
  });
});

describe("confirm dialog", () => {
  it("is a labelled, described alertdialog that starts on Cancel", () => {
    const markup = renderToStaticMarkup(
      <ConfirmDialog
        title="Revoke token?"
        message="Revoke “Fictional token”? Integrations using this token will lose access."
        confirmLabel="Revoke token"
        destructive
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const dialog = /<dialog[^>]*>/.exec(markup)![0];
    expect(dialog).toContain('role="alertdialog"');
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(dialog)![1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(dialog)![1];
    expect(markup).toContain(`<h2 id="${labelledBy}">Revoke token?</h2>`);
    expect(markup).toContain(
      `<p id="${describedBy}">Revoke “Fictional token”? Integrations using this token will lose access.</p>`,
    );
    const buttons = [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)];
    const cancel = buttons.findIndex((match) => match[1] === "Cancel");
    const confirm = buttons.findIndex((match) => match[1] === "Revoke token");
    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(cancel).toBeLessThan(confirm);
    expect(buttons[cancel][0]).toContain("autofocus");
    expect(buttons[confirm][0]).toContain('class="button danger"');
    expect(
      renderToStaticMarkup(
        <ConfirmDialog
          title="Switch team?"
          message="Fictional message"
          confirmLabel="Switch team"
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      ),
    ).not.toContain("button danger");
  });
});

describe("Import CVs", () => {
  it("opens from /app/candidates?import=cvs for a member who can import, and not for a viewer", () => {
    const candidates = (role: string, search: string) => {
      navigation.params = new URLSearchParams(search);
      try {
        return renderToStaticMarkup(
          <WorkspaceProvider value={{ ...workspace, role }}>
            <RecordsScreen section="candidates" />
          </WorkspaceProvider>,
        );
      } finally {
        navigation.params = new URLSearchParams();
      }
    };
    const dialogTitle = ">Import CVs</h2>";
    expect(candidates("recruiter", "import=cvs")).toContain(dialogTitle);
    expect(candidates("recruiter", "")).not.toContain(dialogTitle);
    expect(candidates("recruiter", "import=other")).not.toContain(dialogTitle);
    const page = candidates("viewer", "import=cvs");
    expect(page).not.toContain(dialogTitle);
    // The page itself still shows, with the button disabled as usual.
    expect(page).toMatch(
      /<button[^>]*disabled=""[^>]*>[\s\S]*?Import CVs<\/button>/,
    );
    // After opening, the parameter leaves the address, so a reload does not open it again.
    expect(
      withoutImportLink(
        "http://localhost:3000/app/candidates?import=cvs&record=fictional",
      ),
    ).toBe("http://localhost:3000/app/candidates?record=fictional");
    expect(
      withoutImportLink("http://localhost:3000/app/candidates?import=cvs"),
    ).toBe("http://localhost:3000/app/candidates");
  });

  it("shows only the capability check before the availability answer arrives", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <BulkCvImport onClose={() => {}} onChanged={() => {}} />
      </WorkspaceProvider>,
    );
    expect(markup).toContain("Checking CV import availability");
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain("unavailable");
    expect(markup).not.toContain("not set up");
  });

  const dialog = (importState: CvImportState) =>
    renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <BulkCvImportDialog
          importState={importState}
          capabilityError={importState === "error" ? "Network unavailable" : ""}
          onCapabilityLost={() => {}}
          onClose={() => {}}
          onChanged={() => {}}
        />
      </WorkspaceProvider>,
    );
  it.each(["checking", "not-set-up", "unavailable", "error"] as const)(
    "shows only the explanation and Close while %s",
    (importState) => {
      const markup = dialog(importState);
      expect(markup).not.toContain('type="file"');
      expect(markup).not.toContain("Import reviewed");
      expect(markup).not.toContain("prepare a review draft");
      expect(markup).not.toContain("Recent imports");
      expect(markup).toContain(">Close</button>");
    },
  );
  it("explains each unavailable state in plain words", () => {
    expect(dialog("not-set-up")).toContain("CV uploads are not set up yet.");
    expect(dialog("unavailable")).toContain(
      "CV import is not available right now. You can still add and edit candidate details in the candidate directory.",
    );
    expect(dialog("error")).toContain(
      "Could not check import availability. Network unavailable",
    );
  });
  it("shows the limits before any work once uploads are ready", () => {
    const markup = dialog("ready");
    expect(BULK_INTAKE_MAX_FILES).toBe(200);
    const limits = `Up to ${BULK_INTAKE_MAX_FILES} files per import, 10 MiB each. One CV uploads at a time in this browser. Import progress is kept on the server for ${BULK_INTAKE_RECOVERY_HOURS} hours; selected files and drafts stay only in this browser.`;
    expect(markup).toContain(`<p>${limits}</p>`);
    expect(markup.indexOf(limits)).toBeLessThan(markup.indexOf('type="file"'));
    expect(markup).toContain(
      `Recent imports (kept for ${BULK_INTAKE_RECOVERY_HOURS} hours)`,
    );
    expect(markup).toContain("Import reviewed (0)");
    expect(markup).not.toContain("Cancel import");
  });
  // A fictional disclosure; no provider is configured in this build.
  const disclosure = {
    version: "c".repeat(64),
    provider: "Fictional Extraction Service",
    model: "fictional-model-1",
    region: "Fictional region (test only)",
    retention: "Fictional: deleted after 30 days",
    trainingUse: "Fictional: not used for training",
    costNote: "Fictional: no charge in tests",
    purpose: AI_EXTRACTION_PURPOSE,
    dataSent: AI_EXTRACTION_DATA_SENT,
    limits: AI_EXTRACTION_LIMITS_TEXT,
  };
  const aiDialog = (
    importState: CvImportState,
    consent: "none" | "granted" | "withdrawn" | "outdated",
  ) =>
    renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <BulkCvImportDialog
          importState={importState}
          capabilityError=""
          onCapabilityLost={() => {}}
          onClose={() => {}}
          onChanged={() => {}}
          ai={{ disclosure, consent }}
          onAiChanged={() => {}}
        />
      </WorkspaceProvider>,
    );
  const changedTerms = "The AI service or its terms changed since you agreed.";
  it("keeps the not-configured text and no AI controls without an AI provider", () => {
    for (const markup of [
      dialog("ready"),
      renderToStaticMarkup(
        <WorkspaceProvider value={workspace}>
          <BulkCvImportDialog
            importState="ready"
            capabilityError=""
            onCapabilityLost={() => {}}
            onClose={() => {}}
            onChanged={() => {}}
            ai={null}
          />
        </WorkspaceProvider>,
      ),
    ]) {
      expect(markup).toContain(
        "AI extraction is not configured. Enter details from each CV and verify them yourself. No CV content is sent to an AI service.",
      );
      expect(markup).not.toContain("Allow AI suggestions");
      expect(markup).not.toContain("Withdraw AI consent");
      expect(markup).not.toContain("AI suggestions</h3>");
    }
  });
  it("shows the full disclosure and Allow AI suggestions before the file input", () => {
    const markup = aiDialog("ready", "none");
    const file = markup.indexOf('type="file"');
    expect(file).toBeGreaterThan(0);
    for (const value of [
      disclosure.provider,
      disclosure.model,
      disclosure.region,
      disclosure.retention,
      disclosure.trainingUse,
      disclosure.costNote,
      disclosure.purpose,
      disclosure.dataSent,
      disclosure.limits,
      "Selecting files sends nothing to the AI service",
      "continue manually",
      ">Allow AI suggestions</button>",
    ]) {
      expect(markup, value).toContain(value);
      expect(markup.indexOf(value), value).toBeLessThan(file);
    }
    expect(markup).not.toContain("AI extraction is not configured");
    expect(markup).not.toContain("Withdraw AI consent");
    expect(markup).not.toContain(changedTerms);
    expect(aiDialog("ready", "withdrawn")).toContain("Allow AI suggestions");
  });
  it("explains changed terms for an outdated consent", () => {
    const markup = aiDialog("ready", "outdated");
    expect(markup).toContain(changedTerms);
    expect(markup).toContain("Allow AI suggestions");
  });
  it("offers withdrawal once consent is granted", () => {
    const markup = aiDialog("ready", "granted");
    expect(markup).toContain(">Withdraw AI consent</button>");
    expect(markup).not.toContain("Allow AI suggestions");
    expect(markup).toContain(disclosure.retention);
  });
  it.each(["checking", "not-set-up", "unavailable", "error"] as const)(
    "renders no AI text or control while %s",
    (importState) => {
      for (const consent of ["none", "granted", "outdated"] as const) {
        const markup = aiDialog(importState, consent);
        for (const text of [
          "AI suggestions",
          "AI extraction",
          "AI consent",
          disclosure.provider,
          disclosure.purpose,
          "Unverified suggestion",
        ])
          expect(markup).not.toContain(text);
      }
    },
  );
  const recentPage = (totalPages: number): RecentImportsPage => ({
    data: [
      {
        id: "00000000-0000-4000-8000-0000000000b1",
        createdAt: "2030-01-01T09:00:00.000Z",
        expiresAt: "2030-01-02T09:00:00.000Z",
        items: [
          {
            id: "00000000-0000-4000-8000-0000000000c1",
            originalName: "fictional-cv.pdf",
            sizeBytes: 200,
            candidateId: "00000000-0000-4000-8000-0000000000d1",
            outcome: "cv-rejected",
          },
        ],
      },
    ],
    pagination: { page: 1, pageSize: 10, total: totalPages * 10, totalPages },
  });
  const recent = (page: RecentImportsPage) =>
    renderToStaticMarkup(
      <RecentImports
        page={page}
        error=""
        loading={false}
        currentBatchId="00000000-0000-4000-8000-0000000000b2"
        onPage={() => {}}
      />,
    );
  it("pages Recent imports only when there is more than one page", () => {
    const markup = recent(recentPage(2));
    const nav =
      /<nav class="pagination" aria-label="Recent import pages">[\s\S]*?<\/nav>/.exec(
        markup,
      )?.[0];
    expect(nav).toBeDefined();
    expect(nav).toContain("Page 1 of 2");
    expect(nav).toContain(">Next</button>");
    expect(nav).toMatch(/<button[^>]*disabled=""[^>]*>Previous<\/button>/);
    expect(markup).toContain("Candidate created, CV rejected");
    expect(markup).toContain("Open the candidate to attach the CV");
    const single = recent(recentPage(1));
    expect(single).toContain("fictional-cv.pdf");
    expect(single).not.toContain("<nav");
    expect(single).not.toContain("Recent import pages");
  });
  const emptyPage = (page: number): RecentImportsPage => ({
    data: [],
    pagination: { page, pageSize: 10, total: 3, totalPages: 1 },
  });
  /** The button with this label in an element tree; the component has no hooks, so it runs directly. */
  const buttonIn = (
    node: ReactNode,
    label: string,
  ): ReactElement<ButtonHTMLAttributes<HTMLButtonElement>> | undefined => {
    if (Array.isArray(node))
      return node.map((child) => buttonIn(child, label)).find(Boolean);
    if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
    if (node.type === "button" && node.props.children === label)
      return node as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
    return buttonIn(node.props.children, label);
  };
  it("offers Go to first page when a later Recent imports page is empty", () => {
    const markup = recent(emptyPage(2));
    expect(markup).toContain("No recent imports on this page.");
    expect(markup).not.toContain("No other recent imports.");
    const button = /<button[^>]*>Go to first page<\/button>/.exec(markup)?.[0];
    expect(button).toBeDefined();
    expect(button).toContain('class="button secondary small"');
    expect(button).not.toContain("disabled");
    expect(markup).not.toContain("<nav");
    // A later page holding only the batch this dialog is running counts as empty as well.
    const onlyCurrent = recent({
      ...emptyPage(2),
      data: [
        {
          ...recentPage(1).data[0],
          id: "00000000-0000-4000-8000-0000000000b2",
        },
      ],
    });
    expect(onlyCurrent).toContain("No recent imports on this page.");
    expect(onlyCurrent).toContain("Go to first page");
    expect(onlyCurrent).not.toContain("fictional-cv.pdf");

    const onPage = vi.fn();
    const tree = RecentImports({
      page: emptyPage(2),
      error: "",
      loading: false,
      currentBatchId: "00000000-0000-4000-8000-0000000000b2",
      onPage,
    });
    const first = buttonIn(tree, "Go to first page");
    expect(first).toBeDefined();
    first!.props.onClick!({} as MouseEvent<HTMLButtonElement>);
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledWith(1);

    const loading = renderToStaticMarkup(
      <RecentImports
        page={emptyPage(2)}
        error=""
        loading
        currentBatchId="00000000-0000-4000-8000-0000000000b2"
        onPage={() => {}}
      />,
    );
    expect(loading).toMatch(
      /<button[^>]*disabled=""[^>]*>Go to first page<\/button>/,
    );
  });
  it("keeps the plain empty text on the first Recent imports page", () => {
    const markup = recent(emptyPage(1));
    expect(markup).toContain("No other recent imports.");
    expect(markup).not.toContain("No recent imports on this page.");
    expect(markup).not.toContain("Go to first page");
  });
  describe("200-file batches", () => {
    const entries = Array.from({ length: 200 }, (_, index) => ({
      id: `entry-${index}`,
      file: { name: `fictional-cv-${String(index).padStart(3, "0")}.pdf` },
    }));
    const selected = (focusId: string) =>
      renderToStaticMarkup(
        <SelectedCvList
          entries={entries}
          focusId={focusId}
          selected={focusId}
          busy={false}
          status={() => "Awaiting review"}
          onSelect={() => {}}
        />,
      );
    const rows = (markup: string) =>
      [...markup.matchAll(/fictional-cv-(\d{3})\.pdf/g)].map((match) =>
        Number(match[1]),
      );
    it("shows 25 selected CVs per page with a page control", () => {
      const markup = selected("");
      expect(rows(markup)).toEqual(Array.from({ length: 25 }, (_, n) => n));
      expect(markup).toContain(
        '<nav class="pagination" aria-label="Selected CV pages">',
      );
      expect(markup).toContain("Page 1 of 8");
      expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Previous<\/button>/);
      // The page follows the entry under review or being imported.
      const later = selected("entry-130");
      expect(rows(later)).toEqual(
        Array.from({ length: 25 }, (_, n) => 125 + n),
      );
      expect(later).toContain("Page 6 of 8");
      const few = renderToStaticMarkup(
        <SelectedCvList
          entries={entries.slice(0, 25)}
          focusId=""
          selected=""
          busy={false}
          status={() => "Awaiting review"}
          onSelect={() => {}}
        />,
      );
      expect(rows(few)).toHaveLength(25);
      expect(few).not.toContain("<nav");
    });
    const batch = (count: number, id: string) => ({
      id,
      createdAt: "2030-01-01T09:00:00.000Z",
      expiresAt: "2030-01-02T09:00:00.000Z",
      items: Array.from({ length: count }, (_, index) => ({
        id: `${id}-item-${index}`,
        originalName: `fictional-cv-${String(index).padStart(3, "0")}.pdf`,
        sizeBytes: 200,
        candidateId: null,
        outcome: "not-imported" as const,
      })),
    });
    it("pages a 200-item recent import by 25 and shows no control for 10 items", () => {
      const render = (count: number) =>
        renderToStaticMarkup(
          <RecentImports
            page={{
              data: [batch(count, "00000000-0000-4000-8000-0000000000e1")],
              pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 },
            }}
            error=""
            loading={false}
            currentBatchId="00000000-0000-4000-8000-0000000000e2"
            onPage={() => {}}
          />,
        );
      const large = render(200);
      expect(rows(large)).toEqual(Array.from({ length: 25 }, (_, n) => n));
      expect(large).toContain(
        '<nav class="pagination" aria-label="Import file pages">',
      );
      expect(large).toContain("Page 1 of 8");
      expect(large).not.toContain("Recent import pages");
      const small = render(10);
      expect(rows(small)).toHaveLength(10);
      expect(small).not.toContain("<nav");
    });
  });
});

// Team tasks (R2a-20, job 062): assignees by name and the linked record on the card and profile,
// the editor's assignee picker, and the Assigned to me filter. Fictional members and ids only.
describe("team tasks", () => {
  const members = [
    { userId: "fictional-member-alex", name: "Alex Example" },
    { userId: "fictional-member-sam", name: "Sam Sample" },
  ];
  const FORMER = "fictional-former-member";
  const bucket = "00000000-0000-4000-8000-000000000401";
  const task = (
    index: number,
    data: Record<string, unknown>,
    links: Partial<RecordDto> = {},
  ): RecordDto =>
    ({
      id: `00000000-0000-4000-8000-00000000050${index}`,
      kind: "task",
      data: {
        title: `Fictional team task ${index}`,
        priority: "Normal",
        ...data,
      },
      version: 1,
      legacyId: null,
      createdBy: "fictional-user",
      privateOwnerId: null,
      createdAt: "2026-11-08T10:00:00.000Z",
      updatedAt: "2026-11-08T10:00:00.000Z",
      archivedAt: null,
      candidateId: null,
      vacancyId: null,
      applicationId: null,
      onboardingId: null,
      bucketId: bucket,
      jobRoleId: null,
      parentRecordId: null,
      ...links,
    }) as RecordDto;
  const linked = task(
    1,
    { assigneeIds: ["fictional-member-alex", FORMER] },
    {
      parentRecordId: "00000000-0000-4000-8000-000000000301",
      parentKind: "vacancy",
      parentLabel: "Fictional Engineer",
    },
  );
  const hidden = task(
    2,
    { assigneeIds: [] },
    { parentRecordId: "00000000-0000-4000-8000-000000000302" },
  );

  it("names assignees and the linked record on the task card and profile, never by id", () => {
    const board = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <Kanban
          resource="tasks"
          records={[linked, hidden]}
          buckets={[
            {
              ...task(9, {}),
              id: bucket,
              kind: "bucket",
              data: { name: "Fictional to do", color: "#4338CA" },
            } as RecordDto,
          ]}
          onOpen={() => {}}
          onMove={() => {}}
          canWrite
          members={members}
        />
      </WorkspaceProvider>,
    );
    expect(board).toContain('aria-label="Team task board"');
    const cards = [
      ...board.matchAll(/<article class="kanban-card"[\s\S]*?<\/article>/g),
    ].map((match) => match[0]);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain("Assigned: Alex Example, Former member");
    expect(cards[0]).toContain("Linked record: Vacancy · Fictional Engineer");
    expect(cards[1]).not.toContain("Assigned:");
    expect(cards[1]).toContain("Linked record: Unavailable record");
    expect(board).not.toContain(FORMER);
    expect(board).not.toContain("fictional-member-alex");

    const profile = (record: RecordDto) =>
      renderToStaticMarkup(
        <WorkspaceProvider value={workspace}>
          <RecordDetail
            record={record}
            inline
            members={members}
            onClose={() => {}}
            onEdit={() => {}}
            onRefresh={() => {}}
            onCreate={() => {}}
            onUpdated={() => {}}
          />
        </WorkspaceProvider>,
      );
    const shown = profile(linked);
    expect(shown).toContain("Assigned: Alex Example, Former member");
    expect(shown).toContain("Linked record: Vacancy · Fictional Engineer");
    // No raw id chips and no generic parent reference; the owner line stays.
    expect(shown).not.toContain(FORMER);
    expect(shown).not.toContain("fictional-member-alex");
    expect(shown).not.toContain("<dt>Assignees</dt>");
    expect(shown).not.toContain("<dt> Parent Record</dt>");
    expect(shown).toContain("<dt>Owner</dt>");
    expect(profile(hidden)).toContain("Linked record: Unavailable record");
  });

  it("offers members as checkboxes, at most ten, keeps a former member and sends no untouched selection", () => {
    const picker = (selected: string[], list = members) =>
      renderToStaticMarkup(
        <AssigneePicker
          members={list}
          error=""
          selected={selected}
          onChange={() => {}}
        />,
      );
    const two = picker(["fictional-member-alex", FORMER]);
    expect(two).toMatch(/<fieldset[^>]*class="assignee-picker"/);
    expect(two).toContain("<legend>Assignees</legend>");
    expect(two).toContain("Filter members");
    expect(two).toContain("2 of 10 selected");
    const boxes = [
      ...two.matchAll(/<label class="checkbox-label">([\s\S]*?)<\/label>/g),
    ].map((match) => match[1]);
    expect(boxes).toHaveLength(3);
    // The former member: checked, with no control to remove them.
    expect(boxes[0]).toMatch(/^<input type="checkbox"[^>]*\/>Former member$/);
    expect(boxes[0]).toContain('checked=""');
    expect(boxes[0]).toContain('disabled=""');
    expect(boxes[1]).toMatch(/checked=""[^>]*\/>Alex Example/);
    expect(boxes[2]).not.toContain("checked");
    expect(boxes[2]).not.toContain("disabled");
    expect(two).not.toContain(FORMER);
    // At ten, every unchecked box is disabled.
    const many = Array.from({ length: 11 }, (_, index) => ({
      userId: `fictional-member-${index}`,
      name: `Fictional Member ${index}`,
    }));
    const full = picker(
      many.slice(0, 10).map((member) => member.userId),
      many,
    );
    expect(full).toContain("10 of 10 selected");
    expect(full).toMatch(
      /<input type="checkbox" disabled=""\/>Fictional Member 10/,
    );
    // A load failure disables only the picker and says so.
    const failed = renderToStaticMarkup(
      <AssigneePicker
        members={null}
        error="Network unavailable"
        selected={[]}
        onChange={() => {}}
      />,
    );
    expect(failed).toMatch(/<fieldset[^>]*disabled=""/);
    expect(failed).toContain("Network unavailable");

    // The editor shows the picker for a task, and a save sends assigneeIds only when changed.
    const editor = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <RecordEditor
          resource="tasks"
          record={linked}
          onClose={() => {}}
          onSaved={() => {}}
        />
      </WorkspaceProvider>,
    );
    expect(editor).toContain("<legend>Assignees</legend>");
    expect(editor).toContain("Linked record type");
    // Not the generic comma-separated tags input.
    expect(editor).not.toContain('for="editor-assigneeIds"');
    const body = recordMutation(
      "tasks",
      { ...linked.data },
      { bucketId: bucket },
      linked,
    );
    expect(body.data).not.toHaveProperty("assigneeIds");
    const saved = ["fictional-member-alex", FORMER];
    expect(assigneeInput(saved, [FORMER, "fictional-member-alex"])).toEqual({});
    expect(assigneeInput(saved, [...saved, "fictional-member-sam"])).toEqual({
      assigneeIds: [...saved, "fictional-member-sam"],
    });
    expect(assigneeInput(saved, [FORMER])).toEqual({ assigneeIds: [FORMER] });
  });

  it("filters the Tasks screen by Assigned to me and then disables the export", () => {
    const screen = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <RecordsScreen section="tasks" />
      </WorkspaceProvider>,
    );
    expect(screen).toContain("<h1>Team tasks");
    expect(screen).toMatch(
      /<label class="checkbox-label"><input type="checkbox"\/>Assigned to me<\/label>/,
    );
    expect(
      listSearchParams("tasks", {
        ...defaultListQuery("tasks"),
        assignedToMe: true,
      }).get("assignedToMe"),
    ).toBe("true");
    expect(
      listSearchParams("tasks", defaultListQuery("tasks")).has("assignedToMe"),
    ).toBe(false);
    const control = (assignedToMe: boolean) =>
      renderToStaticMarkup(
        <ExportControl
          exporting={false}
          loading={false}
          assignedToMe={assignedToMe}
          onExport={() => {}}
        />,
      );
    const off = control(true);
    expect(off).toMatch(
      /<button[^>]*disabled=""[^>]*aria-describedby="([^"]+)"/,
    );
    const note = /aria-describedby="([^"]+)"/.exec(off)![1];
    expect(off).toContain(
      `<small id="${note}" class="muted">Turn off Assigned to me to export.</small>`,
    );
    const on = control(false);
    expect(on).not.toContain("disabled");
    expect(on).not.toContain("Turn off Assigned to me");
  });
});

// Task boards (R2a-21, job 064): the Tasks screen's board switcher, a board's columns, the retired
// board fallback and the export note. Fictional boards, buckets and ids only.
describe("task board switcher", () => {
  const bucket = (index: number, name: string): RecordDto =>
    ({
      id: `00000000-0000-4000-8000-00000000080${index}`,
      kind: "bucket",
      data: { name, color: "#4338CA", position: index, completed: false },
      version: 1,
      legacyId: null,
      createdBy: "fictional-user",
      privateOwnerId: null,
      createdAt: "2026-11-08T10:00:00.000Z",
      updatedAt: "2026-11-08T10:00:00.000Z",
      archivedAt: null,
      candidateId: null,
      vacancyId: null,
      applicationId: null,
      onboardingId: null,
      bucketId: null,
      jobRoleId: null,
      parentRecordId: null,
    }) as RecordDto;
  // The active buckets in position order, as BUCKETS_PATH returns them.
  const active = [
    bucket(1, "Fictional to do"),
    bucket(2, "Fictional doing"),
    bucket(3, "Fictional done"),
  ];
  const archivedBucket = "00000000-0000-4000-8000-000000000809";
  const boards: TaskBoardOption[] = [
    {
      id: "00000000-0000-4000-8000-000000000901",
      key: "fictional-project",
      name: "Fictional Project board",
      columns: [active[2].id, archivedBucket, active[0].id],
    },
    {
      id: "00000000-0000-4000-8000-000000000902",
      key: "fictional-sprint",
      name: "Fictional sprint",
      columns: [active[1].id],
    },
  ];
  const task = {
    ...bucket(5, "unused"),
    id: "00000000-0000-4000-8000-000000000851",
    kind: "task",
    data: { title: "Fictional board task", priority: "Normal" },
    bucketId: active[2].id,
  } as RecordDto;

  it("labels the switcher Task board and lists All buckets first, then the boards", () => {
    const markup = renderToStaticMarkup(
      <TaskBoardSwitcher boards={boards} value="" onChange={() => {}} />,
    );
    expect(markup).toMatch(/^<select aria-label="Task board">/);
    expect(
      [
        ...markup.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g),
      ].map((match) => [match[1], match[2]]),
    ).toEqual([
      ["", "All buckets"],
      [boards[0].id, "Fictional Project board"],
      [boards[1].id, "Fictional sprint"],
    ]);
    expect(markup).toMatch(/<option value="" selected="">All buckets/);
    const chosen = renderToStaticMarkup(
      <TaskBoardSwitcher
        boards={boards}
        value={boards[1].id}
        onChange={() => {}}
      />,
    );
    expect(chosen).toContain(
      `<option value="${boards[1].id}" selected="">Fictional sprint</option>`,
    );
    // On the Tasks screen, in the toolbar, with All buckets chosen before any board loads.
    const screen = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <RecordsScreen section="tasks" />
      </WorkspaceProvider>,
    );
    const toolbar = /<div class="row toolbar-options">([\s\S]*?)<\/div>/.exec(
      screen,
    )?.[1];
    expect(toolbar).toContain(
      '<select aria-label="Task board"><option value="" selected="">All buckets</option></select>',
    );
    // The switcher uses the toolbar's own select rules, so it fits 360 px and the dark theme.
    expect(
      rules("src/app/globals.css").some(
        (rule) =>
          rule.selector.includes(".toolbar-options select") &&
          /max-width/.test(rule.body),
      ),
    ).toBe(true);
  });

  it("requests a board's tasks with board and shows only its active buckets, in board order", () => {
    const query = { ...defaultListQuery("tasks"), board: boards[0].id };
    expect(listSearchParams("tasks", query).get("board")).toBe(boards[0].id);
    expect(listSearchParams("tasks", query).get("page")).toBe("1");
    expect(
      listSearchParams("tasks", defaultListQuery("tasks")).has("board"),
    ).toBe(false);
    expect(
      listSearchParams("pipeline", {
        ...defaultListQuery("pipeline"),
        board: boards[0].id,
      }).has("board"),
    ).toBe(false);
    // All buckets keeps every active bucket in position order.
    expect(boardBuckets(active, null)).toBe(active);
    const columns = boardBuckets(active, boards[0]);
    expect(columns.map((item) => item.id)).toEqual([
      active[2].id,
      active[0].id,
    ]);
    expect(
      boardBuckets(active, { ...boards[0], columns: [archivedBucket] }),
    ).toEqual([]);
    const board = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <Kanban
          resource="tasks"
          records={[task]}
          buckets={columns}
          onOpen={() => {}}
          onMove={() => {}}
          canWrite
        />
      </WorkspaceProvider>,
    );
    expect(
      [...board.matchAll(/<h2[^>]*>([^<]+)<span>/g)].map((match) => match[1]),
    ).toEqual(["Fictional done", "Fictional to do"]);
    expect(board).not.toContain("Fictional doing");
    // A card moves only between the board's columns.
    const move =
      /<select aria-label="Move Fictional board task to"[\s\S]*?<\/select>/.exec(
        board,
      )![0];
    expect(
      [...move.matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map(
        (match) => match[1],
      ),
    ).toEqual(["Fictional done", "Fictional to do"]);
  });

  it("falls back to All buckets with a status notice when the chosen board is retired", () => {
    expect(taskBoardChoice(boards, "")).toEqual({
      board: null,
      unavailable: false,
    });
    expect(taskBoardChoice(boards, boards[1].id)).toEqual({
      board: boards[1],
      unavailable: false,
    });
    // Before the boards load nothing is unavailable yet.
    expect(taskBoardChoice(null, boards[1].id).unavailable).toBe(false);
    const retired = taskBoardChoice([boards[0]], boards[1].id);
    expect(retired).toEqual({ board: null, unavailable: true });
    expect(
      renderToStaticMarkup(
        <TaskBoardNotice unavailable={retired.unavailable} />,
      ),
    ).toBe(`<p class="notice" role="status">${BOARD_UNAVAILABLE}</p>`);
    expect(BOARD_UNAVAILABLE).toBe(
      "The task board you chose is no longer available, so All buckets is shown.",
    );
    expect(renderToStaticMarkup(<TaskBoardNotice unavailable={false} />)).toBe(
      "",
    );
  });

  it("disables Export with a note while a board other than All buckets is chosen", () => {
    const control = (board: boolean, assignedToMe = false) =>
      renderToStaticMarkup(
        <ExportControl
          exporting={false}
          loading={false}
          assignedToMe={assignedToMe}
          board={board}
          onExport={() => {}}
        />,
      );
    const off = control(true);
    expect(off).toMatch(
      /<button[^>]*disabled=""[^>]*aria-describedby="([^"]+)"/,
    );
    const note = /aria-describedby="([^"]+)"/.exec(off)![1];
    expect(off).toContain(
      `<small id="${note}" class="muted">Choose All buckets to export.</small>`,
    );
    expect(control(true, true)).toContain(
      "Turn off Assigned to me to export. Choose All buckets to export.",
    );
    const on = control(false);
    expect(on).not.toContain("disabled");
    expect(on).not.toContain("Choose All buckets");
  });
});

// The vacancy editor's job title picker (ADM-27, job 088). Fictional titles, grades, figures and
// ids only.
describe("vacancy job title picker", () => {
  const current: JobArchitecture = {
    versionId: "00000000-0000-4000-8000-000000000901",
    number: 4,
    body: {
      families: [{ key: "finance", name: "Fictional Finance" }],
      grades: [
        { code: "G5", name: "Fictional Associate", order: 5 },
        { code: "G7", name: "Fictional Senior", order: 7 },
      ],
      titles: [
        {
          key: "payroll-lead",
          name: "Fictional Payroll Lead",
          familyKey: "finance",
          gradeCode: "G7",
        },
        {
          key: "people-partner",
          name: "Fictional People Partner",
          familyKey: "finance",
          gradeCode: "G5",
        },
      ],
    },
  };
  const brackets: SalaryBracketVersion = {
    versionId: "00000000-0000-4000-8000-000000000902",
    number: 2,
    state: "published",
    payPeriod: "annual",
    covers: "total-cash",
    effectiveFrom: "2027-01-01",
    createdAt: "2026-11-12T09:00:00.000Z",
    publishedAt: "2026-11-12T10:00:00.000Z",
    brackets: [
      {
        gradeCode: "G7",
        minimumFils: 24_000_000,
        midpointFils: 30_000_000,
        maximumFils: 36_000_000,
      },
    ],
  };
  const vacancy = {
    id: "00000000-0000-4000-8000-000000000903",
    kind: "vacancy",
    data: {
      title: "Fictional Payroll Vacancy",
      status: "Open",
      jobTitleKey: "payroll-lead",
    },
    version: 1,
    legacyId: null,
    createdBy: "fictional-user",
    privateOwnerId: null,
    createdAt: "2026-11-12T10:00:00.000Z",
    updatedAt: "2026-11-12T10:00:00.000Z",
    archivedAt: null,
    candidateId: null,
    vacancyId: null,
    applicationId: null,
    onboardingId: null,
    bucketId: null,
    jobRoleId: null,
    parentRecordId: null,
  } as RecordDto;

  it("renders the job title block in the editor and never the generic field", () => {
    const editor = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <RecordEditor
          resource="vacancies"
          record={vacancy}
          onClose={() => {}}
          onSaved={() => {}}
        />
      </WorkspaceProvider>,
    );
    // Effects do not run here, so the picker still waits for the caller's access.
    expect(editor).toContain('<p role="status">Loading job titles…</p>');
    expect(editor).not.toContain('id="editor-jobTitleKey"');
    expect(editor).not.toContain('for="editor-jobTitleKey"');
    expect(editor).toContain("<legend>Org unit</legend>");
  });

  it("offers no No job title once a title is saved, and the bracket only to a holder", async () => {
    const view = (extra: { brackets?: SalaryBracketVersion }) =>
      renderToStaticMarkup(
        <JobTitlePickerView
          current={current}
          value="payroll-lead"
          allowNone={false}
          {...extra}
        />,
      );
    const plain = view({});
    expect(plain).not.toContain("No job title");
    expect(plain).toContain(
      '<option value="payroll-lead" selected="">Fictional Payroll Lead · G7</option>',
    );
    expect(plain).toContain("Grade: G7 · Fictional Senior");
    for (const text of [
      "Salary bracket",
      "AED",
      "240,000",
      "300,000",
      "360,000",
    ])
      expect(plain, text).not.toContain(text);
    expect(view({ brackets })).toContain(
      "Salary bracket: AED 240,000 to AED 360,000 a year, midpoint AED 300,000 · total cash · version 2",
    );
    const sent: string[] = [];
    const request = (async (path: string) => {
      sent.push(path);
      return { data: { current, draft: null } };
    }) as Requester;
    await loadJobTitleChoices(request, {
      planAccess: { read: false, write: false },
    });
    expect(sent).toEqual(["/api/v1/job-architecture"]);
  });

  it("sends the title only when another one is chosen, never through the generic fields", () => {
    expect(vacancyTitleInput(undefined, "")).toEqual({});
    expect(vacancyTitleInput("payroll-lead", "payroll-lead")).toEqual({});
    expect(vacancyTitleInput("payroll-lead", "people-partner")).toEqual({
      jobTitleKey: "people-partner",
    });
    expect(vacancyTitleInput(undefined, "payroll-lead")).toEqual({
      jobTitleKey: "payroll-lead",
    });
    const body = recordMutation("vacancies", { ...vacancy.data }, {}, vacancy);
    expect(body.data).not.toHaveProperty("jobTitleKey");
  });
});

// R2b-07 (job 090): with the default kind schemas, the editor and the profile render exactly as
// before screens. The golden file was written by main's code before the change.
describe("default screens", () => {
  const golden = JSON.parse(
    readFileSync(
      new URL("./fixtures/default-screens-dom.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, { create: string; edit: string; view: string }>;
  const fictional: Record<string, Record<string, unknown>> = {
    candidates: {
      name: "Fictional Candidate",
      email: "candidate@example.test",
      phone: "+971 50 000 0001",
      university: "Fictional University",
      employer: "Fictional Employer",
      jobTitle: "Fictional Analyst",
      yearsExperience: 4,
      skills: ["Excel", "SQL"],
      languages: ["English"],
      reviewStatus: "Needs review",
      sourceNotes: "Fictional note",
      rawSource: { folder: "Fictional" },
      evidence: {},
      sourceReviews: [],
    },
    "job-roles": {
      title: "Fictional Engineer",
      department: "Fictional Department",
      description: "Fictional description",
      skills: ["TypeScript"],
    },
    vacancies: {
      title: "Fictional Engineer",
      requisitionId: "REQ-1",
      openings: 2,
      status: "Open",
      targetDate: "2026-12-01",
      jobTitleKey: "fictional-engineer",
    },
    applications: {
      stage: "Screening",
      source: "Fictional referral",
      appliedDate: "2026-11-01",
    },
    tasks: {
      title: "Fictional task",
      priority: "High",
      assigneeIds: ["fictional-member-alex"],
      dueDate: "2026-11-20",
      customValues: {},
    },
    interviews: {
      title: "Fictional interview",
      startAt: "2026-11-15T06:30:00.000Z",
      minutes: 45,
      status: "Scheduled",
      meetingUrl: "https://example.test/meet",
    },
    offers: {
      title: "Fictional offer",
      amount: "12000",
      currency: "AED",
      payPeriod: "Monthly",
      status: "Draft",
    },
    onboarding: { startDate: "2026-12-01", status: "Planned" },
    checklist: {
      title: "Fictional checklist item",
      category: "Document",
      status: "Pending",
    },
  };
  const kinds: Record<string, string> = {
    candidates: "candidate",
    "job-roles": "job-role",
    vacancies: "vacancy",
    applications: "application",
    tasks: "task",
    interviews: "interview",
    offers: "offer",
    onboarding: "onboarding",
    checklist: "checklist",
  };
  const recordOf = (resource: string, index: number) =>
    ({
      id: `00000000-0000-4000-8000-00000000090${index}`,
      kind: kinds[resource],
      data: fictional[resource],
      version: 3,
      legacyId: null,
      createdBy: "fictional-user",
      privateOwnerId: null,
      createdAt: "2026-11-08T10:00:00.000Z",
      updatedAt: "2026-11-09T10:00:00.000Z",
      archivedAt: null,
      candidateId: null,
      vacancyId: null,
      applicationId: null,
      onboardingId: null,
      bucketId: null,
      jobRoleId: null,
      parentRecordId: null,
    }) as RecordDto;
  const markup = (resource: string, index: number) => {
    const record = recordOf(resource, index);
    const wrap = (node: ReactNode) =>
      renderToStaticMarkup(
        <WorkspaceProvider value={workspace}>{node}</WorkspaceProvider>,
      );
    return {
      create: wrap(
        <RecordEditor
          resource={resource as ResourceName}
          onClose={() => {}}
          onSaved={() => {}}
        />,
      ),
      edit: wrap(
        <RecordEditor
          resource={resource as ResourceName}
          record={record}
          onClose={() => {}}
          onSaved={() => {}}
        />,
      ),
      view: wrap(
        <RecordDetail
          record={record}
          inline
          onClose={() => {}}
          onEdit={() => {}}
          onRefresh={() => {}}
          onCreate={() => {}}
          onUpdated={() => {}}
        />,
      ),
    };
  };

  it("renders every configurable kind's create, edit and view exactly as before screens", () => {
    const resources = Object.keys(fictional);
    expect(Object.keys(golden)).toEqual(resources);
    // A new interview starts now, so the clock is fixed.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T08:00:00.000Z"));
    try {
      resources.forEach((resource, index) => {
        const now = markup(resource, index);
        expect(now.create, `${resource} create`).toBe(golden[resource].create);
        expect(now.edit, `${resource} edit`).toBe(golden[resource].edit);
        expect(now.view, `${resource} view`).toBe(golden[resource].view);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// R2b-07 (job 090): a fictional configured candidate screen with a group, a reordered field, a
// hidden field and a mandatory flag.
describe("configured screens", () => {
  const candidate = (email: string) =>
    ({
      id: "00000000-0000-4000-8000-000000000990",
      kind: "candidate",
      data: {
        name: "Fictional Candidate",
        email,
        phone: "+971 50 000 0002",
        employer: "Fictional Employer",
      },
      version: 2,
      legacyId: null,
      createdBy: "fictional-user",
      privateOwnerId: null,
      createdAt: "2026-11-08T10:00:00.000Z",
      updatedAt: "2026-11-09T10:00:00.000Z",
      archivedAt: null,
      candidateId: null,
      vacancyId: null,
      applicationId: null,
      onboardingId: null,
      bucketId: null,
      jobRoleId: null,
      parentRecordId: null,
    }) as RecordDto;
  const editor = (schema: KindSchemaBody, record?: RecordDto) =>
    renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <RecordEditor
          resource="candidates"
          record={record}
          schema={schema}
          onClose={() => {}}
          onSaved={() => {}}
        />
      </WorkspaceProvider>,
    );
  const emailLabel = (markup: string) =>
    /<label for="editor-email">([\s\S]*?)<\/label><input id="editor-email"([^>]*)\/>/.exec(
      markup,
    );

  it("renders the editor's groups in order, the labelled one as a fieldset, without hidden fields", () => {
    for (const record of [undefined, candidate("candidate@example.test")]) {
      const markup = editor(contactBody(), record);
      expect(markup).toContain(
        '<fieldset class="editor-fieldset full-width"><legend>Fictional contact</legend><div class="form-grid">',
      );
      const phone = markup.indexOf('id="editor-phone"');
      const email = markup.indexOf('id="editor-email"');
      expect(phone).toBeGreaterThan(markup.indexOf("Fictional contact"));
      expect(phone).toBeLessThan(email);
      expect(markup.indexOf('id="editor-name"')).toBeLessThan(phone);
      expect(markup).not.toContain('id="editor-employer"');
      // Without a flag, email is optional.
      expect(emailLabel(markup)![1]).toBe("Email");
      expect(emailLabel(markup)![2]).not.toContain("required");
    }
  });

  it("shows the view screen's groups on the profile, without hidden fields", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <RecordDetail
          record={candidate("candidate@example.test")}
          schema={contactBody()}
          inline
          onClose={() => {}}
          onEdit={() => {}}
          onRefresh={() => {}}
          onCreate={() => {}}
          onUpdated={() => {}}
        />
      </WorkspaceProvider>,
    );
    const heading = markup.indexOf("<h3>Fictional contact</h3>");
    expect(heading).toBeGreaterThan(markup.indexOf("<dt>Name</dt>"));
    expect(markup.slice(heading)).toMatch(
      /^<h3>Fictional contact<\/h3><div class="detail-facts"><div class=""><dt>Phone<\/dt>[\s\S]*?<dt>Email<\/dt>/,
    );
    expect(markup).not.toContain("<dt>Employer</dt>");
    expect(markup).not.toContain("Fictional Employer");
  });

  it("marks a mandatory field required on create, and on edit only when its stored value is filled", () => {
    const schema = contactBody({ mandatory: true });
    for (const markup of [
      editor(schema),
      editor(schema, candidate("candidate@example.test")),
    ]) {
      const [, label, input] = emailLabel(markup)!;
      expect(label).toBe('Email<span aria-label="required"> *</span>');
      expect(input).toContain('required=""');
    }
    const [, label, input] = emailLabel(editor(schema, candidate("")))!;
    expect(label).toBe("Email");
    expect(input).not.toContain("required");
  });
});
