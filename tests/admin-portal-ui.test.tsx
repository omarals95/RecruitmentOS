import { readFileSync } from "node:fs";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
}));
// ADM-04 (job 075): every read a rendered component starts, with the cache and team it reads
// from, since a static render never subscribes.
const reads = vi.hoisted(
  () =>
    [] as {
      path: string;
      scope: ReturnType<
        typeof import("../src/components/workspace/client").useQueryScope
      >;
    }[],
);
vi.mock("../src/components/workspace/client", async (original) => {
  const actual =
    await original<typeof import("../src/components/workspace/client")>();
  return {
    ...actual,
    useApi: (path: string | null) => {
      const scope = actual.useQueryScope();
      if (path) reads.push({ path, scope });
      return actual.useApi(path);
    },
  };
});

import {
  clearWorkspaceCache,
  dataCache,
  TeamScope,
  WorkspaceProvider,
} from "../src/components/workspace/client";
import {
  ADMIN_GROUPS,
  ADMIN_TABS,
  adminTabs,
  type AdminTabKey,
} from "../src/components/settings/admin-tabs";
import { ADMIN_AREAS } from "../src/domain/config";
import {
  AccessChangesPanel,
  AdminPortal,
  AdminPortalView,
  ConfigHistoryPanel,
  NO_ACCESS,
  type ConfigHistoryRow,
  type MeAccess,
} from "../src/components/settings/admin-portal";
import {
  AuthorityFields,
  CompanyAuthorityPanel,
} from "../src/components/settings/company-authority-tab";
import {
  RoleEditor,
  RoleTemplateView,
  RolesList,
  roleKeyFor,
  saveRoleDraft,
} from "../src/components/settings/roles-tab";
import type { RoleBody, TaskBoardBody } from "../src/domain/config";
import type { RecordDto } from "../src/domain/records";
import { ClientError } from "../src/components/workspace/client";
import {
  TaskBoardForm,
  TaskBoardsList,
  taskBoardRefusal,
  taskBoardRequests,
} from "../src/components/settings/task-boards-tab";
import {
  ADMIN_ROLE,
  HIRING_MANAGER_ROLE,
  INTERVIEWER_ROLE,
  OWNER_ROLE,
  RECRUITER_ROLE,
  VIEWER_ROLE,
} from "../src/domain/config-defaults";
import type { ConfigObject } from "../src/lib/config-store";
import type { CompanyAuthorityHolder } from "../src/lib/company-authority";
import {
  ERASED_NOTICE,
  EmployeeErasureDialogView,
  RetentionReviewPanel,
} from "../src/components/settings/employee-erasure";
import {
  DirectoryTable,
  EmployeeActionsView,
} from "../src/components/settings/directory-tab";
import type { Employee, RetentionReviewRow } from "../src/lib/directory";
import { formatDate } from "../src/components/workspace/helpers";
import {
  TeamsPanel,
  type AdminTeamRow,
} from "../src/components/settings/teams-tab";
import { NOT_A_MEMBER } from "../src/components/settings/admin-tabs";
import {
  TeamDetail,
  TeamDetailPortal,
  type TeamDetailProps,
} from "../src/components/settings/team-detail";
import {
  TEAM_DETAIL_TABS,
  teamDetailTab,
} from "../src/components/settings/team-detail-tabs";
import { saveStorageSettings } from "../src/components/settings/storage-settings";
import {
  TeamArchiveDialogView,
  TeamArchiveView,
} from "../src/components/settings/team-archive";
import {
  canOpenAdminPortal,
  SettingsNavigation,
} from "../src/components/settings/settings-navigation";
import {
  ActivityList,
  ActivityScreen,
} from "../src/components/workspace/overview";
import {
  MembersTable,
  TeamMembers,
  teamRequests,
  type TeamClient,
  type TeamMember,
} from "../src/components/settings/team-members";
import {
  FreshSessionDialog,
  REAUTH_CANCELLED,
  reauthenticate,
  retryWithFreshSession,
  type ReauthClient,
} from "../src/components/settings/fresh-session-dialog";
import {
  InviteToTeamsPanel,
  NO_INVITE_TEAMS,
  NO_USER_FILTERS,
  UsersPanel,
  inviteTeams,
  sendInvitations,
  type InviteDraft,
  type WorkspacePersonRow,
} from "../src/components/settings/users-tab";
import {
  USER_NOT_FOUND,
  UserDetailPortal,
  UserDetailRefusal,
  UserDetailView,
  eventLabel,
  resetTeam,
  resetTwoStep,
  type WorkspacePerson,
} from "../src/components/settings/user-detail";
import {
  USER_DETAIL_TABS,
  userDetailTab,
} from "../src/components/settings/user-detail-tabs";
import { tabKeys } from "../src/components/ui/tab-keys";

// Fictional people, teams and ids only.
const workspace = {
  user: {
    id: "fictional-portal-user",
    name: "Fictional Portal User",
    email: "portal-user@example.test",
    twoStepEnabled: true,
  },
  team: { id: "fictional-team", name: "Fictional Team", slug: "fictional" },
  role: "owner",
  environment: "Local development",
  canCreateTeam: true,
};
const TEAM_ROLES = ["owner", "admin", "recruiter", "viewer"] as const;
const COMPANY_LEVELS = ["owner", "admin", null] as const;
const TEAM_TABS = ["tokens"];
// ADM-04 (job 075): the old team pages live only as team detail tabs now.
const OLD_TEAM_KEYS = ["members", "cv-storage", "speed", "task-boards"];
const NOT_YET = [
  "Fields",
  "Screens",
  "Workflows",
  "Boards",
  "Templates",
  "AI connections",
  "Plan",
];
// Pages of architecture §14.1 that are not built, or deferred by D29: no link, card or entry.
const UNBUILT = [
  "groups",
  "permissions",
  "permission-helper",
  "sign-in",
  "fields",
  "screens",
  "workflows",
  "boards",
  "templates",
  "config-transfer",
  "branding",
  "domain",
  "notifications",
  "mail",
  "integrations",
  "health",
  "audit",
];
const access = (
  teamRole: string,
  companyLevel: MeAccess["companyLevel"],
  extra: Partial<MeAccess> = {},
): MeAccess => ({
  teamRole,
  companyLevel,
  teamArchived: false,
  role: { name: "Fictional role", membership: "recruiter" },
  scopes: [],
  pages: [],
  actions: {},
  fields: {},
  adminAreas: [],
  ...extra,
});
/** The directory actions of the built-in owner and admin roles. */
const directory: Partial<MeAccess> = {
  actions: { directory: ["view", "create", "edit", "archive"] },
};
const render = (
  tab: AdminTabKey | null,
  value: MeAccess | null,
  options: { denied?: boolean; error?: string } = {},
) =>
  renderToStaticMarkup(
    <WorkspaceProvider value={workspace}>
      <AdminPortalView
        tab={tab}
        access={value}
        denied={options.denied ?? false}
        error={options.error ?? ""}
      />
    </WorkspaceProvider>,
  );
/** The sidebar: `<nav aria-label="Admin portal sections">`. */
const sidebar = (markup: string) =>
  /<nav class="admin-nav" aria-label="Admin portal sections">([\s\S]*?)<\/nav>/.exec(
    markup,
  )?.[1] ?? "";
/** The page keys the sidebar links to, in order (Admin home is `/app/admin`, not a key). */
const tabLinks = (markup: string) =>
  [...sidebar(markup).matchAll(/href="\/app\/admin\/([^"]+)"/g)].map(
    (link) => link[1],
  );
const sidebarHrefs = (markup: string) =>
  [...sidebar(markup).matchAll(/href="([^"]+)"/g)].map((link) => link[1]);
const sidebarGroups = (markup: string) =>
  [...sidebar(markup).matchAll(/<p id="[^"]+">([^<]+)<\/p>/g)].map((group) =>
    group[1].replaceAll("&amp;", "&"),
  );
/** Everything after the sidebar: the Admin home or the current page. */
const content = (markup: string) => markup.split("</nav>").slice(1).join("");
const onlyHeadingAndNoAccess = (markup: string) => {
  expect(markup).toContain("<h1>Admin portal</h1>");
  expect(markup).toContain(`<p>${NO_ACCESS}</p>`);
  expect(markup).not.toContain("Admin portal sections");
  expect(markup).not.toContain("<nav");
  expect(markup).not.toMatch(/<h2|<table|role="status"/);
};
/** Every subset of a list, the empty one first. */
const subsets = <T,>(list: readonly T[]): T[][] =>
  list.reduce<T[][]>(
    (all, item) => [...all, ...all.map((subset) => [...subset, item])],
    [[]],
  );

describe("admin portal tabs", () => {
  it("defines exactly the eight pages that exist, by group, in order", () => {
    expect(ADMIN_GROUPS).toEqual([
      "Overview",
      "People",
      "Access",
      "Configuration",
      "Look & feel",
      "Communication",
      "Integrations",
      "Monitoring",
    ]);
    expect(ADMIN_TABS.map((tab) => [tab.key, tab.label, tab.group])).toEqual([
      ["users", "Users", "People"],
      ["teams", "Teams", "People"],
      ["organisation", "Organisation", "People"],
      ["directory", "Directory", "People"],
      ["company-authority", "Company authority", "Access"],
      ["roles", "Roles & permissions", "Access"],
      ["tokens", "API tokens", "Integrations"],
      ["history", "History", "Monitoring"],
    ]);
    // Rows are in group order, and each has one level and one sentence describing it.
    const order = ADMIN_TABS.map((tab) => ADMIN_GROUPS.indexOf(tab.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const tab of ADMIN_TABS) {
      expect(
        [
          "team",
          "teams",
          "people",
          "owner",
          "organisation",
          "directory",
          "company",
        ],
        tab.key,
      ).toContain(tab.level);
      expect(tab.description, tab.key).toMatch(/^[A-Z][^.]*\.$/);
    }
  });

  it("gives team tabs from the team role, History from company authority only, and Teams from either", () => {
    for (const teamRole of TEAM_ROLES)
      for (const companyLevel of COMPANY_LEVELS) {
        const keys = adminTabs({ teamRole, companyLevel }).map(
          (tab) => tab.key,
        );
        const team = teamRole === "owner" || teamRole === "admin";
        expect(keys, `${teamRole} / ${companyLevel}`).toEqual(
          ADMIN_TABS.map((tab) => tab.key).filter((key) =>
            TEAM_TABS.includes(key)
              ? team
              : key === "teams"
                ? team || companyLevel !== null
                : key === "users" ||
                    key === "company-authority" ||
                    key === "roles" ||
                    key === "organisation"
                  ? companyLevel === "owner"
                  : key === "history"
                    ? companyLevel !== null
                    : false,
          ),
        );
      }
    expect(adminTabs({ teamRole: null, companyLevel: null })).toEqual([]);
    expect(
      adminTabs({ teamRole: "superuser", companyLevel: "member" }),
    ).toEqual([]);
  });

  it("never gives a company page for a team role or a team page for company authority, and Teams for either, over every team role, company level, area set and directory action", () => {
    const directories: MeAccess["actions"][] = [
      {},
      { directory: ["create", "edit", "archive"] },
      { directory: ["view"] },
      { directory: ["view", "create", "edit", "archive"] },
    ];
    const areaSets = subsets(ADMIN_AREAS);
    expect(areaSets).toHaveLength(2 ** ADMIN_AREAS.length);
    for (const teamRole of [...TEAM_ROLES, null, "superuser"])
      for (const companyLevel of COMPANY_LEVELS)
        for (const adminAreas of areaSets)
          for (const actions of directories) {
            const tabs = adminTabs({
              teamRole,
              companyLevel,
              adminAreas,
              actions,
            });
            const label = `${teamRole} / ${companyLevel} / ${adminAreas.join(",")} / ${actions.directory?.join(",") ?? "-"}`;
            const team = teamRole === "owner" || teamRole === "admin";
            const shown: Record<AdminTabKey, boolean> = {
              users:
                companyLevel === "owner" ||
                (companyLevel === "admin" && adminAreas.includes("people")),
              teams: team || companyLevel !== null,
              tokens: team,
              organisation:
                companyLevel === "owner" ||
                (companyLevel === "admin" &&
                  adminAreas.includes("organisation")),
              directory: !!actions.directory?.includes("view"),
              "company-authority": companyLevel === "owner",
              roles: companyLevel === "owner",
              history: companyLevel !== null,
            };
            expect(
              tabs.map((tab) => tab.key),
              label,
            ).toEqual(
              ADMIN_TABS.map((tab) => tab.key).filter((key) => shown[key]),
            );
            for (const tab of tabs)
              expect(
                ADMIN_TABS.filter((row) => row.key === tab.key),
                label,
              ).toEqual([tab]);
            for (const key of OLD_TEAM_KEYS)
              expect(
                tabs.map((tab) => tab.key as string),
                label,
              ).not.toContain(key);
          }
  });
});

describe("admin home", () => {
  const callers: [string, MeAccess][] = [
    ["team owner and company owner", access("owner", "owner", directory)],
    ["team admin", access("admin", null, directory)],
    ["company owner as recruiter", access("recruiter", "owner")],
    ["company admin", access("viewer", "admin")],
    [
      "company admin with organisation",
      access("recruiter", "admin", { adminAreas: ["organisation"] }),
    ],
    ["directory reader", access("recruiter", null, directory)],
  ];

  it("shows one card per page the caller can open, under its group, and nothing else", () => {
    for (const [name, value] of callers) {
      const tabs = adminTabs(value);
      const markup = render(null, value);
      const home = content(markup);
      const cards = [
        ...home.matchAll(/<li class="panel admin-card">([\s\S]*?)<\/li>/g),
      ].map((card) => card[1]);
      expect(cards, name).toHaveLength(tabs.length);
      tabs.forEach((tab, index) => {
        expect(cards[index], `${name}: ${tab.key}`).toContain(
          `<h3><a href="/app/admin/${tab.key}">${tab.label.replace("&", "&amp;")}</a></h3>`,
        );
        expect(cards[index], `${name}: ${tab.key}`).toContain(
          `<p class="muted">${tab.description.replaceAll("&", "&amp;").replaceAll("'", "&#x27;")}</p>`,
        );
      });
      expect(
        [...home.matchAll(/href="(\/app\/admin[^"]*)"/g)].map(
          (link) => link[1],
        ),
        name,
      ).toEqual(tabs.map((tab) => `/app/admin/${tab.key}`));
      expect(
        [...home.matchAll(/<h2>([^<]+)<\/h2>/g)].map((h) => h[1]),
        name,
      ).toEqual(
        ADMIN_GROUPS.filter((group) => tabs.some((tab) => tab.group === group)),
      );
      expect(markup.match(/<h1>/g), name).toHaveLength(1);
      expect(markup, name).not.toContain(NO_ACCESS);
      expect(markup, name).not.toContain('role="status"');
      for (const key of UNBUILT)
        expect(markup, `${name}: ${key}`).not.toContain(`/app/admin/${key}"`);
      for (const text of ["Invite user", "Needs your attention", "Search"])
        expect(markup, name).not.toContain(text);
    }
  });

  it("shows the Users card first under People to company owners, then Teams to team owners and admins and to company owners and admins", () => {
    for (const [name, value] of [
      ...callers,
      [
        "company admin with people",
        access("viewer", "admin", { adminAreas: ["people"] }),
      ] as [string, MeAccess],
    ]) {
      const home = content(render(null, value));
      const shown =
        value.teamRole === "owner" ||
        value.teamRole === "admin" ||
        value.companyLevel !== null;
      const users =
        value.companyLevel === "owner" ||
        (value.companyLevel === "admin" && value.adminAreas.includes("people"));
      expect(home.includes('href="/app/admin/teams">Teams</a>'), name).toBe(
        shown,
      );
      expect(home.includes('href="/app/admin/users">Users</a>'), name).toBe(
        users,
      );
      if (shown)
        expect(home, name).toMatch(
          users
            ? /<h2>People<\/h2><ul class="admin-cards"><li class="panel admin-card"><h3><a href="\/app\/admin\/users">Users<\/a><\/h3>[\s\S]*?<\/li><li class="panel admin-card"><h3><a href="\/app\/admin\/teams">Teams<\/a><\/h3>/
            : /<h2>People<\/h2><ul class="admin-cards"><li class="panel admin-card"><h3><a href="\/app\/admin\/teams">Teams<\/a><\/h3>/,
        );
    }
  });

  it("gives the API tokens panel the same description as its home card", () => {
    const markup = render(null, access("owner", null));
    const text = ADMIN_TABS.find((tab) => tab.key === "tokens")!.description;
    const panel = render("tokens", access("owner", null));
    expect(markup).toContain(text);
    expect(panel).toContain(`<p>${text}</p>`);
  });

  it("shows no Members, CV storage, Speed or Task boards card or link", () => {
    for (const [name, value] of callers) {
      const markup = render(null, value);
      for (const key of OLD_TEAM_KEYS)
        expect(markup, `${name}: ${key}`).not.toContain(`/app/admin/${key}"`);
      for (const label of ["Members", "CV storage", "Speed", "Task boards"])
        expect(markup, `${name}: ${label}`).not.toContain(`>${label}</a>`);
    }
  });

  it("shows only the heading and the no-access text to a caller with no page", () => {
    for (const teamRole of ["recruiter", "viewer", null, "superuser"])
      onlyHeadingAndNoAccess(
        render(null, access(teamRole as string, null, { adminAreas: [] })),
      );
  });
});

describe("admin sidebar", () => {
  const callers: [string, MeAccess][] = [
    ["team owner and company owner", access("owner", "owner", directory)],
    ["team owner", access("owner", null, directory)],
    ["company owner as recruiter", access("recruiter", "owner")],
    ["company admin", access("viewer", "admin")],
    [
      "company admin with organisation",
      access("recruiter", "admin", { adminAreas: ["organisation"] }),
    ],
    ["directory reader", access("recruiter", null, directory)],
  ];

  it("lists Admin home and the caller's pages in group order, and hides every group without a page", () => {
    for (const [name, value] of callers) {
      const tabs = adminTabs(value);
      for (const tab of [null, ...tabs.map((item) => item.key)]) {
        const markup = render(tab, value);
        const label = `${name} on ${tab ?? "home"}`;
        expect(sidebarHrefs(markup), label).toEqual([
          "/app/admin",
          ...tabs.map((item) => `/app/admin/${item.key}`),
        ]);
        expect(sidebarGroups(markup), label).toEqual([
          "Overview",
          ...ADMIN_GROUPS.filter(
            (group) =>
              group !== "Overview" && tabs.some((item) => item.group === group),
          ),
        ]);
        for (const group of ["Configuration", "Look & feel", "Communication"])
          expect(sidebarGroups(markup), label).not.toContain(group);
        expect(sidebar(markup), label).toContain(">Admin home</a>");
        for (const item of tabs)
          expect(sidebar(markup), label).toContain(
            `>${item.label.replace("&", "&amp;")}</a>`,
          );
        const current = [...markup.matchAll(/<a [^>]*>/g)]
          .map((match) => match[0])
          .filter((link) => link.includes('aria-current="page"'));
        expect(current, label).toEqual([
          `<a aria-current="page" href="/app/admin${tab ? `/${tab}` : ""}">`,
        ]);
        for (const key of UNBUILT)
          expect(markup, `${label}: ${key}`).not.toContain(
            `/app/admin/${key}"`,
          );
        expect(markup.match(/<h1>/g), label).toHaveLength(1);
        expect(markup, label).not.toContain("settings-nav");
        expect(markup, label).not.toMatch(/\bdir=/);
      }
    }
  });

  it("starts the People group with Teams for a team owner and for a company admin", () => {
    for (const value of [access("owner", null), access("viewer", "admin")])
      expect(sidebar(render(null, value))).toMatch(
        /<p id="[^"]+">People<\/p><ul aria-labelledby="[^"]+"><li><a href="\/app\/admin\/teams">Teams<\/a><\/li>/,
      );
  });

  it("names each group's list by its visible group name", () => {
    const nav = sidebar(render(null, access("owner", "owner", directory)));
    const groups = [
      ...nav.matchAll(
        /<p id="([^"]+)">[^<]+<\/p><ul aria-labelledby="([^"]+)">/g,
      ),
    ];
    expect(groups).toHaveLength(5);
    for (const group of groups) expect(group[2]).toBe(group[1]);
  });
});

describe("admin portal", () => {
  it("shows a company owner who is a team owner all seven tab links and nothing that does not exist yet", () => {
    const markup = render("tokens", access("owner", "owner"));
    expect(tabLinks(markup)).toEqual([
      "users",
      "teams",
      "organisation",
      "company-authority",
      "roles",
      "tokens",
      "history",
    ]);
    const current = [...markup.matchAll(/<a [^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => tag.includes('aria-current="page"'));
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/app/admin/tokens"');
    expect(current[0]).not.toMatch(/class="[^"]*secondary/);
    expect(markup).toContain('aria-label="Admin portal sections"');
    expect(markup.match(/<h1>/g)).toHaveLength(1);
    for (const name of NOT_YET) expect(markup, name).not.toContain(name);
  });

  it("shows the tabs each caller holds", () => {
    for (const teamRole of TEAM_ROLES)
      for (const companyLevel of COMPANY_LEVELS) {
        const tabs = adminTabs({ teamRole, companyLevel });
        const markup = render(
          tabs[0]?.key ?? "tokens",
          access(teamRole, companyLevel),
        );
        if (!tabs.length) onlyHeadingAndNoAccess(markup);
        else
          expect(tabLinks(markup), `${teamRole} / ${companyLevel}`).toEqual(
            tabs.map((tab) => tab.key),
          );
        for (const name of NOT_YET) expect(markup, name).not.toContain(name);
      }
  });

  it("links API tokens to its existing settings page, and no other page to a settings page", () => {
    const markup = render("tokens", access("admin", null));
    expect(markup).toContain("<h2>API tokens</h2>");
    expect(markup).toContain('class="button" href="/app/settings/api-tokens"');
    expect(markup).not.toContain("<table");
    for (const value of [access("owner", "owner", directory)])
      for (const tab of adminTabs(value).filter(
        (item) => item.key !== "tokens",
      ))
        expect(render(tab.key, value), tab.key).not.toMatch(
          /href="\/app\/settings\/(team|speed)/,
        );
  });

  it("shows only the heading and the no-access text for a 403, no tabs and a tab outside the caller's", () => {
    onlyHeadingAndNoAccess(render("tokens", null, { denied: true }));
    onlyHeadingAndNoAccess(render(null, null, { denied: true }));
    onlyHeadingAndNoAccess(render(null, access("recruiter", null)));
    onlyHeadingAndNoAccess(render("history", access("viewer", null)));
    onlyHeadingAndNoAccess(render("tokens", access("recruiter", "owner")));
    onlyHeadingAndNoAccess(render("tokens", access("viewer", "admin")));
    // A team owner without company authority asks for History.
    onlyHeadingAndNoAccess(render("history", access("owner", null)));
  });

  it("shows loading and other errors plainly, never a blank page", () => {
    const loading = render("tokens", null);
    expect(loading).toContain('<p role="status">Loading…</p>');
    expect(loading).not.toContain(NO_ACCESS);
    const failed = render("tokens", null, {
      error: "The request could not be completed.",
    });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("The request could not be completed.");
    expect(failed).not.toContain(NO_ACCESS);
    const portal = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <AdminPortal tab={null} />
      </WorkspaceProvider>,
    );
    expect(portal).toContain("<h1>Admin portal</h1>");
    expect(portal).toContain('<p role="status">Loading…</p>');
    const noTeam = renderToStaticMarkup(
      <WorkspaceProvider value={{ ...workspace, team: null, role: null }}>
        <AdminPortal tab="tokens" />
      </WorkspaceProvider>,
    );
    onlyHeadingAndNoAccess(noTeam);
  });

  it("shows the access changes panel in History only for a company owner", () => {
    const owner = render("history", access("recruiter", "owner"));
    expect(tabLinks(owner)).toEqual([
      "users",
      "teams",
      "organisation",
      "company-authority",
      "roles",
      "history",
    ]);
    expect(owner).toContain("<h2>Configuration history</h2>");
    expect(owner).toContain("<h2>Recent access changes (last 7 days)</h2>");
    const admin = render("history", access("owner", "admin"));
    expect(admin).toContain("<h2>Configuration history</h2>");
    expect(admin).not.toContain("Recent access changes");
  });
});

// ADM-04 (job 075): the link in personal settings follows the rule /app/admin applies.
describe("admin portal link in personal settings", () => {
  const link = (adminPortal: boolean) =>
    /<a [^>]*href="\/app\/admin"[^>]*>Admin portal<\/a>/.test(
      renderToStaticMarkup(
        <SettingsNavigation active="profile" adminPortal={adminPortal} />,
      ),
    );

  it("shows for anyone with an admin page, over every team role, company level and directory action", () => {
    for (const teamRole of [...TEAM_ROLES, null])
      for (const companyLevel of COMPANY_LEVELS)
        for (const actions of [{}, directory.actions!]) {
          const value = access(teamRole as string, companyLevel, { actions });
          const label = `${teamRole} / ${companyLevel} / ${actions.directory?.join(",") ?? "-"}`;
          const shown = canOpenAdminPortal(value);
          expect(shown, label).toBe(adminTabs(value).length > 0);
          expect(shown, label).toBe(
            teamRole === "owner" ||
              teamRole === "admin" ||
              companyLevel !== null ||
              !!actions.directory,
          );
          expect(link(shown), label).toBe(shown);
        }
  });

  it("shows for a company admin whose team role is recruiter, and not for a recruiter or viewer without company authority", () => {
    expect(canOpenAdminPortal(access("recruiter", "admin"))).toBe(true);
    expect(canOpenAdminPortal(access("viewer", "owner"))).toBe(true);
    expect(canOpenAdminPortal(access("recruiter", null))).toBe(false);
    expect(canOpenAdminPortal(access("viewer", null))).toBe(false);
    // Loading, failed or no team: no access state, no link.
    expect(canOpenAdminPortal(null)).toBe(false);
  });
});

describe("configuration history", () => {
  const rows: ConfigHistoryRow[] = [
    {
      occurredAt: "2026-11-08T10:15:00.000Z",
      action: "config.published",
      objectType: "workflow",
      objectKey: "fictional-hiring",
      versionNumber: 2,
      fromVersionNumber: 1,
      actorName: "Fictional Company Owner",
    },
    {
      occurredAt: "2026-11-07T08:00:00.000Z",
      action: "config.draft_created",
      objectType: "kind-schema",
      objectKey: "candidate",
      versionNumber: null,
      fromVersionNumber: null,
      actorName: null,
    },
    {
      occurredAt: "2026-11-06T08:00:00.000Z",
      action: "config.future_action",
      objectType: "future-type",
      objectKey: "fictional-key",
      versionNumber: 1,
      fromVersionNumber: null,
      actorName: "Fictional Company Admin",
    },
  ];
  it("lists time, action, type and key, versions and actor in plain words", () => {
    const markup = renderToStaticMarkup(
      <ConfigHistoryPanel rows={rows} hasMore={false} error="" />,
    );
    expect(markup).toMatch(
      /<div class="table-wrap"><table class="data-table"><caption class="sr-only">/,
    );
    for (const text of [
      "8 Nov 2026, 14:15",
      'data-label="Time"',
      "Published",
      "Workflow: fictional-hiring",
      "Version 2 from version 1",
      "Fictional Company Owner",
      "Draft created",
      "Record fields: candidate",
      "Not numbered",
      "Not recorded",
      "config.future_action",
      "future-type: fictional-key",
      "Version 1<",
    ])
      expect(markup, text).toContain(text);
    expect(markup).not.toContain("Show older changes");
  });
  it("offers Show older changes only while there are more, and shows the empty, loading and error states", () => {
    expect(
      renderToStaticMarkup(<ConfigHistoryPanel rows={rows} hasMore error="" />),
    ).toMatch(
      /<button type="button" class="button secondary">Show older changes<\/button>/,
    );
    expect(
      renderToStaticMarkup(
        <ConfigHistoryPanel rows={[]} hasMore={false} error="" />,
      ),
    ).toContain("No configuration changes have been recorded yet.");
    expect(
      renderToStaticMarkup(
        <ConfigHistoryPanel rows={null} hasMore={false} error="" />,
      ),
    ).toContain('<p role="status">Loading configuration history…</p>');
    const failed = renderToStaticMarkup(
      <ConfigHistoryPanel
        rows={null}
        hasMore={false}
        error="You do not have company authority to change this configuration."
      />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).not.toContain("<table");
  });
});

describe("recent access changes", () => {
  const memberId = "fictional-member-id-1";
  const otherId = "fictional-other-team-id-2";
  const changes = {
    truncated: false,
    data: [
      {
        occurredAt: "2026-11-08T09:00:00.000Z",
        kind: "role-assignment" as const,
        action: "role.assigned",
        affectedUserIds: [memberId],
        roleName: "Fictional Hiring Manager",
        actorName: "Fictional Company Owner",
      },
      {
        occurredAt: "2026-11-07T09:00:00.000Z",
        kind: "home-units" as const,
        action: "scope.home_units_changed",
        affectedUserIds: [memberId, otherId],
        roleName: null,
        actorName: null,
      },
      {
        occurredAt: "2026-11-06T09:00:00.000Z",
        kind: "role-assignment" as const,
        action: "role.cleared",
        affectedUserIds: [otherId],
        roleName: null,
        actorName: "Fictional Company Owner",
      },
    ],
  };
  const members = new Map([[memberId, "Fictional Team Member"]]);
  it("names members of this team, says another team otherwise and never shows a user id", () => {
    const markup = renderToStaticMarkup(
      <AccessChangesPanel changes={changes} members={members} error="" />,
    );
    for (const text of [
      "Recent access changes (last 7 days)",
      "Role assigned",
      "Home units changed",
      "Role cleared",
      "Fictional Hiring Manager",
      "Fictional Team Member, A member of another team",
      'data-label="Members affected">A member of another team<',
      "Not applicable",
      "Not recorded",
      "Fictional Company Owner",
    ])
      expect(markup, text).toContain(text);
    for (const id of [memberId, otherId]) expect(markup).not.toContain(id);
    expect(markup).not.toContain("Only the latest changes are shown");
  });
  it("says when only the latest changes are shown, and shows the empty and loading states", () => {
    expect(
      renderToStaticMarkup(
        <AccessChangesPanel
          changes={{ ...changes, truncated: true }}
          members={members}
          error=""
        />,
      ),
    ).toContain("Only the latest changes are shown");
    expect(
      renderToStaticMarkup(
        <AccessChangesPanel
          changes={{ data: [], truncated: false }}
          members={members}
          error=""
        />,
      ),
    ).toContain("No access changes in the last 7 days.");
    expect(
      renderToStaticMarkup(
        <AccessChangesPanel changes={null} members={members} error="" />,
      ),
    ).toContain('<p role="status">Loading recent access changes…</p>');
  });
});

// R2a-12 (job 056): the Roles & permissions tab, for company owners only.
describe("roles and permissions tab", () => {
  const editor = (body: RoleBody) =>
    renderToStaticMarkup(
      <RoleEditor
        roleKey="fictional-role"
        body={body}
        busy={false}
        onSave={async () => true}
        onPublish={() => {}}
        onClose={() => {}}
      />,
    );
  const fieldset = (markup: string, legend: string) =>
    new RegExp(`<legend[^>]*>${legend}</legend>([\\s\\S]*?)</fieldset>`).exec(
      markup,
    )?.[1] ?? "";
  const copyOf = (body: RoleBody, changes: Partial<RoleBody>): RoleBody =>
    structuredClone({ ...body, ...changes });
  const list = (roles: ConfigObject[] | null, error = "") =>
    renderToStaticMarkup(
      <RolesList
        roles={roles}
        error={error}
        busy={false}
        onView={() => {}}
        onEdit={() => {}}
        onNewDraft={() => {}}
        onPublish={() => {}}
      />,
    );

  it("shows the tab, the roles panel and the Company authority link only to a company owner, and the no-access text to everyone else", () => {
    for (const teamRole of TEAM_ROLES)
      for (const companyLevel of COMPANY_LEVELS) {
        const markup = render("roles", access(teamRole, companyLevel));
        if (companyLevel === "owner") {
          expect(tabLinks(markup)).toContain("roles");
          expect(markup).toContain('<h2 tabindex="-1">Roles</h2>');
          // ADM-16 (job 077): the panel has its own page; one sentence links to it.
          expect(markup).not.toContain("<h2>Company authority</h2>");
          expect(content(markup)).toContain(
            '<p>Company authority has its own page. <a href="/app/admin/company-authority">Open Company authority</a></p>',
          );
          expect(markup).toContain(
            'aria-current="page" href="/app/admin/roles"',
          );
        } else onlyHeadingAndNoAccess(markup);
      }
    // A company admin, team owners and admins without company authority and a recruiter.
    for (const [teamRole, companyLevel] of [
      ["recruiter", "admin"],
      ["owner", "admin"],
      ["owner", null],
      ["admin", null],
      ["recruiter", null],
    ] as const)
      onlyHeadingAndNoAccess(render("roles", access(teamRole, companyLevel)));
  });

  it("shows the Owner template read only, with no control and no Copy action", () => {
    const owner = renderToStaticMarkup(
      <RoleTemplateView template={OWNER_ROLE} />,
    );
    expect(owner).toContain("Owner template");
    expect(owner).toContain("The Owner template cannot be edited or copied.");
    expect(owner).not.toMatch(/<input|<select|<textarea/);
    expect(owner).not.toContain("Copy");
    expect(owner).not.toContain("Save");
    for (const text of [
      "Membership",
      "Pages",
      "Actions per resource",
      "Field rules",
      "Record scope",
      "All records",
    ])
      expect(owner, text).toContain(text);
    for (const template of [
      ADMIN_ROLE,
      RECRUITER_ROLE,
      VIEWER_ROLE,
      HIRING_MANAGER_ROLE,
      INTERVIEWER_ROLE,
    ]) {
      const markup = renderToStaticMarkup(
        <RoleTemplateView template={template} />,
      );
      expect(markup).toContain(">Copy to a new role</button>");
      expect(markup).not.toMatch(/<input|<select|<textarea/);
      expect(markup).not.toContain("cannot be edited or copied");
    }
    // R2a-18 (job 060): the scoped templates name their record scope in the editor's words.
    expect(
      renderToStaticMarkup(<RoleTemplateView template={HIRING_MANAGER_ROLE} />),
    ).toContain("Candidates: My org unit and below");
    expect(
      renderToStaticMarkup(<RoleTemplateView template={INTERVIEWER_ROLE} />),
    ).toContain("Candidates: Assigned records");
  });

  it("uses the Owner template only for display in the new components", () => {
    for (const file of [
      "../src/components/settings/roles-tab.tsx",
      "../src/components/settings/team-settings.tsx",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      // The import and the read-only template list only.
      expect((source.match(/OWNER_ROLE/g) ?? []).length, file).toBe(
        file.includes("roles-tab") ? 2 : 0,
      );
    }
  });

  it("lists the six built-in templates, Hiring manager and Interviewer included", () => {
    const markup = list([]);
    for (const name of [
      "Owner",
      "Admin",
      "Recruiter",
      "Viewer",
      "Hiring manager",
      "Interviewer",
    ])
      expect(markup).toContain(`>View ${name} template</button>`);
    expect(markup).not.toContain("later release");
    expect(markup).toContain(
      '<p role="status">No company roles yet. Copy a template to start.</p>',
    );
    expect(list(null)).toContain('<p role="status">Loading company roles…</p>');
    const failed = list(
      null,
      "You do not have company authority to change this configuration.",
    );
    expect(failed).toContain('role="alert"');
    expect(failed).not.toContain("<table");
  });

  it("shows each company role's state and its actions, with no mark on a scoped role", () => {
    const version = (number: number | null, body: RoleBody) => ({
      id: `00000000-0000-4000-a000-00000000000${number ?? 9}`,
      number,
      state: number === null ? ("draft" as const) : ("published" as const),
      body: body as unknown as Record<string, unknown>,
      bodySha256: "fictional",
      note: null,
      createdAt: "2026-11-08T10:00:00.000Z",
      publishedAt: null,
    });
    const role = (
      key: string,
      current: ConfigObject["current"],
      draft: ConfigObject["draft"],
    ): ConfigObject => ({
      id: `fictional-object-${key}`,
      type: "role",
      key,
      createdAt: "2026-11-08T10:00:00.000Z",
      archivedAt: null,
      current,
      draft,
    });
    const recruiter = RECRUITER_ROLE.body as RoleBody;
    const named = (name: string, changes: Partial<RoleBody> = {}) =>
      copyOf(recruiter, { name, ...changes });
    const markup = list([
      role("fictional-draft", null, version(null, named("Fictional draft"))),
      role(
        "fictional-both",
        version(2, named("Fictional published")),
        version(null, named("Fictional published")),
      ),
      role(
        "fictional-unit",
        version(
          1,
          named("Fictional unit", {
            recordScope: { pipeline: "unit", candidates: "all", tasks: "all" },
          }),
        ),
        null,
      ),
    ]);
    const rows = [...markup.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .map((match) => match[1])
      .slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('data-label="State">Draft<');
    expect(rows[0]).toContain(">Edit draft</button>");
    expect(rows[0]).toContain(">Publish</button>");
    expect(rows[1]).toContain("Published (version 2), draft in progress");
    expect(rows[1]).toContain(">Edit draft</button>");
    expect(rows[2]).toContain('data-label="State">Published (version 1)<');
    expect(rows[2]).toContain(">New draft</button>");
    expect(rows[2]).not.toContain("Edit draft");
    for (const row of rows) expect(row).not.toContain("badge");
  });

  it("derives a valid role key from the name", () => {
    expect(roleKeyFor("Copy of Recruiter")).toBe("copy-of-recruiter");
    expect(roleKeyFor("  Fictional -- Lead!  ")).toBe("fictional-lead");
    expect(roleKeyFor("x".repeat(80))).toHaveLength(63);
    expect(roleKeyFor("!!!")).toBe("");
  });

  it("edits pages with a screen, actions without plans or erase, field rules on system fields and the record scope", () => {
    const markup = editor(RECRUITER_ROLE.body as RoleBody);
    expect(markup).not.toContain('role="alert"');
    const pages = fieldset(markup, "Pages");
    for (const label of [
      "Overview",
      "Candidates",
      "Talent insights",
      "Admin portal",
    ])
      expect(pages, label).toContain(`/>${label}</label>`);
    for (const label of ["Approvals", "Directory", "Plan"])
      expect(pages, label).not.toContain(`/>${label}</label>`);
    expect(pages.match(/type="checkbox"/g)).toHaveLength(15);
    expect(markup).not.toContain("Actions on Plans");
    expect(markup).not.toContain("<summary>Plans");
    expect(markup).toContain("<summary>Directory");
    expect(markup).not.toContain(">Erase</label>");
    expect(fieldset(markup, "Actions on Teams")).not.toContain(
      ">Manage</label>",
    );
    expect(fieldset(markup, "Actions on Two-step sign-in reset")).not.toContain(
      ">Manage</label>",
    );
    expect(fieldset(markup, "Actions on CV storage settings")).toContain(
      ">Manage</label>",
    );
    expect(markup).toContain(
      "Plan &amp; pay access is a per-person grant in Company authority, never part of a role.",
    );
    // Field rules: one labelled select per system field, with the four plain options.
    const candidates = fieldset(markup, "Field rules for Candidates");
    expect(candidates).toContain(
      "<span>Gender (explicitly stated)</span><select>",
    );
    for (const option of ["Default", "Hidden", "Read only", "Can edit"])
      expect(candidates).toContain(`>${option}</option>`);
    expect(markup).not.toContain("Hidden unless approver");
    // Record scope: each group offers the three scopes, the role's own selected (R2a-18).
    const scope = fieldset(markup, "Record scope");
    expect(scope.match(/<select/g)).toHaveLength(3);
    expect(scope.match(/<option[^>]*>[^<]*<\/option>/g)).toEqual(
      Array(3)
        .fill([
          '<option value="all" selected="">All records</option>',
          '<option value="unit">My org unit and below</option>',
          '<option value="assigned">Assigned records</option>',
        ])
        .flat(),
    );
    for (const label of [
      "Vacancies, applications, interviews, offers and onboarding",
      "Candidates",
      "Team tasks",
    ])
      expect(scope).toContain(`<span>${label}</span><select>`);
    expect(scope).not.toContain("later release");
    // Membership is text, never a control.
    expect(markup).toContain("Membership: Recruiter.");
    expect(markup).not.toMatch(/<option[^>]*>(Owner|Admin|Viewer)<\/option>/);
  });

  it("shows a held hidden-unless-approver rule and keeps a scoped draft's record scope", () => {
    const markup = editor(
      copyOf(RECRUITER_ROLE.body as RoleBody, {
        fields: { offer: { amount: "hidden-unless-approver" } },
        recordScope: { pipeline: "unit", candidates: "assigned", tasks: "all" },
      }),
    );
    expect(fieldset(markup, "Field rules for Offers")).toContain(
      '<option value="hidden-unless-approver" selected="">Hidden unless approver</option>',
    );
    expect(markup).not.toContain("Saving sets every group to All records");
    const selected = [
      ...fieldset(markup, "Record scope").matchAll(
        /<option value="(\w+)" selected="">/g,
      ),
    ].map((match) => match[1]);
    expect(selected).toEqual(["unit", "assigned", "all"]);
  });

  // R2a-16 (job 058): checkboxes no service checks yet are labelled, never hidden.
  it("points the page and action checkboxes that take effect later to a visible sub-heading, with their labels unchanged", () => {
    const markup = editor(RECRUITER_ROLE.body as RoleBody);
    const checkboxes = (group: string) =>
      [
        ...group.matchAll(
          /<label class="checkbox-label"><input type="checkbox"([^>]*)\/>([^<]+)<\/label>/g,
        ),
      ].map((match) => ({ attributes: match[1], label: match[2] }));
    /** The labels pointing to the group's "Takes effect later" heading. */
    const later = (group: string) => {
      const heading = /<h4 id="([^"]+)"[^>]*>Takes effect later<\/h4>/.exec(
        group,
      );
      expect(heading).not.toBeNull();
      return checkboxes(group)
        .filter((box) =>
          box.attributes.includes(`aria-describedby="${heading![1]}"`),
        )
        .map((box) => box.label);
    };
    const pages = fieldset(markup, "Pages");
    const labels = checkboxes(pages).map((box) => box.label);
    expect(labels).toHaveLength(15);
    for (const label of ["Approvals", "Directory", "Plan"])
      expect(labels).not.toContain(label);
    expect(later(pages)).toEqual(
      labels.filter(
        (label) => !["Overview", "Analytics", "Activity"].includes(label),
      ),
    );
    expect(later(pages)).toHaveLength(12);
    for (const [resource, effective] of [
      ["Teams", []],
      ["Two-step sign-in reset", []],
      ["Directory", ["View", "Create", "Edit", "Archive"]],
    ] as const) {
      const group = fieldset(markup, `Actions on ${resource}`);
      const all = checkboxes(group).map((box) => box.label);
      expect(later(group).length, resource).toBeGreaterThan(0);
      expect(
        all.filter((label) => !later(group).includes(label)),
        resource,
      ).toEqual(effective);
    }
    for (const resource of ["Candidates", "CV storage settings"])
      expect(fieldset(markup, `Actions on ${resource}`)).not.toContain(
        "Takes effect later",
      );
  });

  it("refuses a grant outside the membership ceiling next to its resource, with an alert summary, and sends nothing", async () => {
    const viewer = copyOf(VIEWER_ROLE.body as RoleBody, {
      actions: { ...VIEWER_ROLE.body.actions, candidates: ["view", "edit"] },
    });
    const recruiter = copyOf(RECRUITER_ROLE.body as RoleBody, {
      actions: {
        ...RECRUITER_ROLE.body.actions,
        candidates: [
          ...(RECRUITER_ROLE.body.actions.candidates ?? []),
          "import",
        ],
      },
    });
    for (const [body, message] of [
      [viewer, "Viewer membership cannot hold a write action."],
      [recruiter, "recruiter membership cannot import."],
    ] as const) {
      const markup = editor(body);
      expect(markup).toMatch(
        /<div tabindex="-1" class="notice error" role="alert"><p[^>]*>This role cannot be saved/,
      );
      expect(markup).toContain(`Actions on Candidates: ${message}`);
      const resource =
        /<details open=""><summary>Candidates[^<]*<\/summary><fieldset[^>]*aria-describedby="([^"]+)"[^>]*><legend class="sr-only">Actions on Candidates<\/legend>([\s\S]*?)<\/fieldset>/.exec(
          markup,
        );
      expect(resource, message).not.toBeNull();
      expect(resource![2]).toContain(
        `<p id="${resource![1]}" class="field-error">${message}</p>`,
      );
      expect(markup).toMatch(
        /<button type="button" class="button secondary" disabled="">Publish<\/button>/,
      );
      const send = vi.fn();
      expect(await saveRoleDraft(send, "fictional-version", body)).toEqual([
        { group: "actions.candidates", message },
      ]);
      expect(send).not.toHaveBeenCalled();
    }
    const send = vi.fn().mockResolvedValue({ data: {} });
    const plain = copyOf(VIEWER_ROLE.body as RoleBody, {
      name: "Fictional viewer",
    });
    expect(await saveRoleDraft(send, "fictional-version", plain)).toEqual([]);
    expect(send).toHaveBeenCalledWith("/api/v1/roles/fictional-version", {
      method: "PUT",
      body: JSON.stringify({ body: plain }),
    });
  });
});

describe("company authority panel", () => {
  const owner: CompanyAuthorityHolder = {
    userId: "fictional-owner",
    name: "Fictional Company Owner",
    level: "owner",
    areas: [],
    planAccess: true,
    suspended: false,
    twoStep: true,
    since: "2026-11-02T09:30:00.000Z",
  };
  const suspended: CompanyAuthorityHolder = {
    userId: "fictional-suspended",
    name: "Fictional Suspended Admin",
    level: "admin",
    areas: ["fields", "organisation"],
    planAccess: false,
    suspended: true,
    twoStep: false,
    since: "2026-10-15T12:00:00.000Z",
  };
  const admin: CompanyAuthorityHolder = {
    userId: "fictional-admin",
    name: "Fictional Company Admin",
    level: "admin",
    areas: [],
    planAccess: true,
    suspended: false,
    twoStep: true,
    since: "2026-11-05T08:00:00.000Z",
  };
  const panel = (holders: CompanyAuthorityHolder[] | null, actionError = "") =>
    renderToStaticMarkup(
      <CompanyAuthorityPanel
        holders={holders}
        members={[{ userId: "fictional-member", name: "Fictional Member" }]}
        error=""
        actionError={actionError}
        currentUserId="fictional-owner"
      />,
    );
  const fields = (level: "" | "owner" | "admin", lastOwner = false) =>
    renderToStaticMarkup(
      <AuthorityFields
        level={level}
        areas={["fields"]}
        planAccess
        lastOwner={lastOwner}
        onChange={() => {}}
      />,
    );

  it("lists holders with level, areas, plan access and status, Restore on suspended rows and the last owner's disabled Remove", () => {
    const markup = panel([owner, suspended, admin]);
    const rows = [...markup.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .map((match) => match[1])
      .slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Fictional Company Owner (you)");
    expect(rows[0]).toContain('data-label="Level">Company owner<');
    expect(rows[0]).toContain('data-label="Areas">All areas<');
    expect(rows[0]).toContain('data-label="Plan &amp; pay access">Yes<');
    expect(rows[0]).toContain('data-label="Two-step">On<');
    expect(rows[0]).toContain(
      `data-label="Since">${formatDate("2026-11-02T09:30:00.000Z")}<`,
    );
    expect(rows[0]).toContain('data-label="Status">Active<');
    expect(rows[0]).toMatch(
      /<button type="button" class="button secondary" disabled="">Remove<\/button>/,
    );
    expect(rows[0]).toContain(
      "The last company owner cannot be removed. Make someone else a company owner first.",
    );
    expect(rows[0]).not.toContain("Restore authority");
    expect(rows[1]).toContain(
      'data-label="Areas">Record fields, Organisation<',
    );
    expect(rows[1]).toContain('data-label="Plan &amp; pay access">No<');
    expect(rows[1]).toContain('data-label="Two-step">Off<');
    expect(rows[1]).toContain("Suspended: left every team of this company");
    expect(rows[1]).toContain(">Restore authority</button>");
    expect(rows[1]).toMatch(
      /<button type="button" class="button secondary">Remove<\/button>/,
    );
    expect(rows[2]).toContain('data-label="Areas">No areas<');
    // The eight columns, every cell labelled for the narrow layout.
    expect(
      [...markup.matchAll(/<th>([\s\S]*?)<\/th>/g)].map((th) => th[1]),
    ).toEqual([
      "Name",
      "Level",
      "Areas",
      "Plan &amp; pay access",
      "Two-step",
      "Since",
      "Status",
      '<span class="sr-only">Actions</span>',
    ]);
    for (const row of rows)
      expect(row.match(/<td data-label="/g)).toHaveLength(8);
    // The intro names the page's audience, the audit and the two-step rule.
    for (const text of [
      "Only company owners see this page, and every change is recorded in the activity of your team.",
      "Company owners and admins must use two-step sign-in. Someone shown with two-step Off is asked to set it up at their next sign-in, and cannot be given a level until they do.",
    ])
      expect(markup).toContain(text);
    expect(rows[2]).not.toContain("Restore authority");
    expect(markup.match(/Restore authority/g)).toHaveLength(1);
    // The person select lists this team's members and every holder.
    for (const name of [
      "Fictional Member",
      "Fictional Suspended Admin",
      "Fictional Company Admin",
    ])
      expect(markup).toContain(`>${name}</option>`);
    // A second active owner: nobody is the last one.
    const two = panel([owner, { ...admin, level: "owner", areas: [] }]);
    expect(two).not.toContain("The last company owner cannot be removed");
    expect(two).not.toMatch(/disabled="">Remove/);
    expect(panel(null)).toContain(
      '<p role="status">Loading company authority…</p>',
    );
  });

  it("offers areas only for Company admin, Plan & pay access only with a level, and only the grantable areas", () => {
    const asAdmin = fields("admin");
    for (const label of [
      "Record fields",
      "Workflows",
      "Boards",
      "Organisation",
      "Templates",
      "People",
    ])
      expect(asAdmin).toContain(`/>${label}</label>`);
    expect(asAdmin.match(/type="checkbox"/g)).toHaveLength(7);
    for (const area of [
      "roles",
      "ai",
      "plan",
      "home-units",
      "Roles",
      "AI",
      "Home units",
    ])
      expect(asAdmin, area).not.toContain(`/>${area}</label>`);
    expect(asAdmin).toContain("Plan &amp; pay access");
    const asOwner = fields("owner");
    expect(asOwner).not.toContain("<legend>Areas</legend>");
    expect(asOwner.match(/type="checkbox"/g)).toHaveLength(1);
    expect(asOwner).toContain("Plan &amp; pay access");
    // Plan & pay access is one switch, described by what it opens today, and no other control.
    for (const markup of [asAdmin, asOwner]) {
      const control = /<input type="checkbox" role="switch"[^>]*>/.exec(
        markup,
      )?.[0];
      expect(control).toContain('checked=""');
      const described = / aria-describedby="([^"]+)"/.exec(control!)?.[1];
      expect(markup).toContain(
        `${control}Plan &amp; pay access</label><small id="${described}" class="muted">For confidential recruitment plan figures and salary brackets. Neither exists yet, so this opens nothing today. Only a company owner gives it, one person at a time.</small>`,
      );
      expect(markup.match(/role="switch"/g)).toHaveLength(1);
    }
    expect(asOwner.match(/<select/g)).toHaveLength(1);
    const none = fields("");
    expect(none).not.toContain('type="checkbox"');
    for (const option of [
      "No company authority",
      "Company admin",
      "Company owner",
    ])
      expect(none).toContain(`>${option}</option>`);
    // The last owner cannot be demoted or removed from the form either.
    const last = fields("owner", true);
    expect(last).toContain(
      '<option value="" disabled="">No company authority</option>',
    );
    expect(last).toContain(
      '<option value="admin" disabled="">Company admin</option>',
    );
    expect(last).toContain(
      "The last company owner cannot be removed. Make someone else a company owner first.",
    );
  });

  // ADM-16 (job 077): the helper's refusals reach the page as their plain API message.
  it("shows the two-step and last-owner refusals as plain alerts", () => {
    for (const message of [
      "This person must set up two-step sign-in before they can hold company authority. Ask them to turn it on in My profile, then try again.",
      "The last company owner cannot be removed or demoted. Make someone else a company owner first.",
    ])
      expect(panel([owner, admin], message)).toContain(
        `<p class="notice error" role="alert">${message}</p>`,
      );
  });

  it("opens the Company authority page for company owners only, first in Access, and the no-access text to everyone else", () => {
    for (const teamRole of TEAM_ROLES)
      for (const companyLevel of COMPANY_LEVELS) {
        const markup = render(
          "company-authority",
          access(teamRole, companyLevel),
        );
        if (companyLevel === "owner") {
          expect(markup).toContain(
            'aria-current="page" href="/app/admin/company-authority"',
          );
          expect(markup).toContain("<h2>Company authority</h2>");
          expect(markup).toContain(
            '<p role="status">Loading company authority…</p>',
          );
          expect(tabLinks(markup)).toEqual(
            expect.arrayContaining(["company-authority", "roles"]),
          );
          expect(tabLinks(markup).indexOf("company-authority")).toBe(
            tabLinks(markup).indexOf("roles") - 1,
          );
          expect(sidebarGroups(markup)).toContain("Access");
        } else onlyHeadingAndNoAccess(markup);
      }
    // The Admin home card, under Access, before Roles & permissions.
    const home = content(render(null, access("recruiter", "owner")));
    expect(home).toContain(
      '<h3><a href="/app/admin/company-authority">Company authority</a></h3><p class="muted">Choose who holds company authority: company owners, company admins and their areas, and Plan &amp; pay access.</p>',
    );
    expect(home.indexOf("/app/admin/company-authority")).toBeLessThan(
      home.indexOf("/app/admin/roles"),
    );
  });

  it("describes the People area under its checkbox and names it in the holders list (ADM-07)", () => {
    const asAdmin = fields("admin");
    const checkbox =
      /<input type="checkbox" aria-describedby="([^"]+)"\/>People<\/label><small id="([^"]+)" class="muted">([^<]+)<\/small>/.exec(
        asAdmin,
      );
    expect(checkbox).not.toBeNull();
    expect(checkbox![1]).toBe(checkbox![2]);
    expect(checkbox![3]).toBe(
      "Shows the names and email addresses of everyone in every team of the company, with their teams and roles.",
    );
    // The other areas have no description; the Plan & pay access switch below them has its own.
    expect(
      /<fieldset[\s\S]*?<\/fieldset>/
        .exec(asAdmin)![0]
        .match(/aria-describedby=/g),
    ).toHaveLength(1);
    expect(panel([owner, { ...admin, areas: ["fields", "people"] }])).toContain(
      'data-label="Areas">Record fields, People<',
    );
  });
});

// R2a-15 (job 057): employee erasure and the retention review, for company owners only, in the
// Directory tab since R2a-16 (job 058).
describe("directory tab erasure and retention review", () => {
  const match = (
    id: string,
    displayName: string,
    changes: Partial<Employee> = {},
  ): Employee => ({
    id,
    displayName,
    employeeNumber: `EMP-${id}`,
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
  const table = (rows: Employee[], owner = true) =>
    renderToStaticMarkup(
      <DirectoryTable
        rows={rows}
        owner={owner}
        actions={["view", "create", "edit", "archive"]}
      />,
    );
  const reader = (
    teamRole: string,
    companyLevel: MeAccess["companyLevel"],
  ): MeAccess => ({
    ...access(teamRole, companyLevel),
    actions: { directory: ["view"] },
  });
  const reviewRows: RetentionReviewRow[] = [
    {
      id: "fictional-review-1",
      displayName: "Fictional Former Analyst",
      employeeNumber: "EMP-R1",
      leftAt: "2025-03-04T09:00:00.000Z",
      retentionClass: "extended",
      archivedAt: "2025-04-01T09:00:00.000Z",
    },
    {
      id: "fictional-review-2",
      displayName: "Fictional Former Clerk",
      employeeNumber: "EMP-R2",
      leftAt: "2025-06-10T09:00:00.000Z",
      retentionClass: "standard",
      archivedAt: null,
    },
  ];
  const rowsOf = (markup: string) =>
    [...markup.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => row[1]).slice(1);
  type ViewProps = Parameters<typeof EmployeeErasureDialogView>[0];
  const dialog = (overrides: Partial<ViewProps> = {}) =>
    renderToStaticMarkup(
      <EmployeeErasureDialogView
        name="Fictional Erasable Employee"
        typed=""
        busy={false}
        error=""
        ids={{ description: "what", input: "typed", name: "hint" }}
        onTyped={() => {}}
        onCancel={() => {}}
        onConfirm={() => {}}
        {...overrides}
      />,
    );
  const eraseButton = /<button[^>]*>Permanently erase<\/button>/;

  it("shows erasure and the retention review in the Directory tab only to a company owner, and the no-access text without directory view", () => {
    for (const teamRole of TEAM_ROLES)
      for (const companyLevel of COMPANY_LEVELS) {
        const markup = render("directory", reader(teamRole, companyLevel));
        expect(tabLinks(markup)).toContain("directory");
        expect(markup).toContain(
          'aria-current="page" href="/app/admin/directory"',
        );
        expect(markup).toContain("<h2>Directory</h2>");
        expect(markup).toContain("Name or employee number");
        if (companyLevel === "owner") {
          expect(markup).toContain("<h2>Retention review</h2>");
          expect(markup).toContain(
            '<p role="status">Loading the retention review…</p>',
          );
        } else expect(markup).not.toContain("Retention review");
        // Without directory view there is no Directory tab, so no erasure either.
        const denied = render("directory", access(teamRole, companyLevel));
        onlyHeadingAndNoAccess(denied);
        expect(denied).not.toContain("Permanently erase");
      }
  });

  it("lists rows with status, retention class and archived, and an erase action per row for a company owner only", () => {
    const rows = [
      match("1", "Fictional Kept Employee"),
      match("2", "Fictional Former Employee", {
        status: "left",
        retentionClass: "extended",
        archivedAt: "2025-01-01T00:00:00.000Z",
      }),
    ];
    const markup = table(rows);
    for (const header of [
      "Name",
      "Employee number",
      "Status",
      "Retention class",
      "Archived",
    ])
      expect(markup).toContain(`<th>${header}</th>`);
    const [kept, former] = rowsOf(markup);
    expect(kept).toContain('data-label="Status">Active<');
    expect(kept).toContain('data-label="Retention class">Standard<');
    expect(kept).toContain('data-label="Archived">No<');
    expect(former).toContain('data-label="Status">Left<');
    expect(former).toContain('data-label="Retention class">Extended<');
    expect(former).toContain('data-label="Archived">Yes<');
    // Each row's Actions button opens its actions; erase is one of them for a company owner only.
    for (const [index, row] of [kept, former].entries()) {
      expect(row).toContain(
        `Actions<span class="sr-only">: ${rows[index].displayName}</span></button>`,
      );
      const actions = (owner: boolean) =>
        renderToStaticMarkup(
          <EmployeeActionsView
            row={rows[index]}
            owner={owner}
            actions={["view", "create", "edit", "archive"]}
          />,
        );
      expect(actions(true)).toContain(
        '<button type="button" class="button danger">Permanently erase employee</button>',
      );
      expect(actions(false)).not.toContain("Permanently erase");
    }
    expect(table(rows, false)).not.toContain("Permanently erase");
  });

  it("shows the empty state", () => {
    const empty = table([]);
    expect(empty).toContain('<p role="status">No employees match.</p>');
    expect(empty).not.toContain("<table");
  });

  it("lists the retention review with the left date, class and archived, an erase button and Show more", () => {
    const markup = renderToStaticMarkup(
      <RetentionReviewPanel rows={reviewRows} hasMore error="" />,
    );
    expect(markup).toContain(
      "Employees whose status has been Left for 12 months or more, for your review. Nothing is erased automatically; erase an employee only after you have decided their data is no longer needed.",
    );
    for (const header of [
      "Name",
      "Employee number",
      "Left on",
      "Retention class",
      "Archived",
    ])
      expect(markup).toContain(`<th>${header}</th>`);
    const [first, second] = rowsOf(markup);
    expect(first).toContain(
      `data-label="Left on">${formatDate(reviewRows[0].leftAt)}<`,
    );
    expect(first).toContain('data-label="Retention class">Extended<');
    expect(first).toContain('data-label="Archived">Yes<');
    expect(second).toContain('data-label="Archived">No<');
    for (const row of [first, second])
      expect(row).toContain(">Permanently erase employee<");
    expect(markup).toMatch(
      /<button type="button" class="button secondary">Show more<\/button>/,
    );
    expect(
      renderToStaticMarkup(
        <RetentionReviewPanel rows={reviewRows} hasMore={false} error="" />,
      ),
    ).not.toContain("Show more");
    expect(
      renderToStaticMarkup(
        <RetentionReviewPanel rows={[]} hasMore={false} error="" />,
      ),
    ).toContain('<p role="status">No employees are due for review.</p>');
    expect(
      renderToStaticMarkup(
        <RetentionReviewPanel rows={null} hasMore={false} error="" />,
      ),
    ).toContain('<p role="status">Loading the retention review…</p>');
    const failed = renderToStaticMarkup(
      <RetentionReviewPanel
        rows={null}
        hasMore={false}
        error="Only a company owner can see the retention review."
      />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).not.toContain("<table");
  });

  it("confirms in an alert dialog, with Cancel first and Permanently erase disabled until the name is typed exactly", () => {
    const empty = dialog();
    expect(empty).toContain('role="alertdialog"');
    expect(empty).toContain('aria-describedby="what"');
    expect(empty).toContain("Permanently erase Fictional Erasable Employee?");
    for (const text of [
      "<strong>Removed:</strong> the employee&#x27;s directory entry (name, employee number, work email and phone, status and retention class), their position history and their link to a user account.",
      "<strong>Kept:</strong> positions and units, the user&#x27;s account and team memberships, activity entries without personal details, a home-unit change entry for the unlinked user, and a record of who erased the employee and when.",
      "<strong>Not covered:</strong> copies outside the app, such as spreadsheets the directory was imported from.",
      "Name: <strong>Fictional Erasable Employee</strong>",
    ])
      expect(empty).toContain(text);
    expect(empty).toMatch(
      /<button type="button" class="button secondary" autofocus="">Cancel<\/button><button type="button" class="button danger" disabled="">Permanently erase<\/button>/,
    );
    for (const typed of [
      "Fictional Erasable",
      "fictional erasable employee",
      "   ",
    ])
      expect(dialog({ typed })).toMatch(
        /<button type="button" class="button danger" disabled="">Permanently erase<\/button>/,
      );
    const ready = dialog({ typed: "  Fictional Erasable Employee " });
    expect(ready).toMatch(eraseButton);
    expect(ready).not.toMatch(
      /<button type="button" class="button danger" disabled="">Permanently erase/,
    );
    const busy = dialog({ typed: "Fictional Erasable Employee", busy: true });
    expect(busy).toContain(">Erasing…</button>");
    expect(busy).toMatch(/<input id="typed"[^>]*disabled=""/);
    expect(
      dialog({
        error: "Type the employee's name exactly as shown to confirm.",
      }),
    ).toContain('<p class="notice error" role="alert">');
    expect(ERASED_NOTICE).toBe("Employee permanently erased.");
  });
});

// Task boards (R2a-21, job 064): a team tab for team owners and admins, fictional boards and ids.
describe("task boards tab", () => {
  const bucket = (index: number, name: string): RecordDto =>
    ({
      id: `00000000-0000-4000-8000-00000000040${index}`,
      kind: "bucket",
      data: { name, color: "#4338CA", position: index, completed: false },
      version: 1,
    }) as RecordDto;
  const todo = bucket(1, "Fictional to do");
  const doing = bucket(2, "Fictional doing");
  const project = {
    id: "00000000-0000-4000-8000-000000000501",
    kind: "task-field",
    data: {
      name: "Project",
      type: "Dropdown",
      options: ["Fictional Apollo", "Fictional Zephyr"],
    },
    version: 1,
  } as RecordDto;
  const version = (number: number | null, body: TaskBoardBody) => ({
    id: `00000000-0000-4000-8000-0000000006${String(number ?? 0).padStart(2, "0")}`,
    number,
    state: number === null ? ("draft" as const) : ("published" as const),
    body: body as unknown as Record<string, unknown>,
    bodySha256: "0".repeat(64),
    note: null,
    createdAt: "2026-11-08T10:00:00.000Z",
    publishedAt: number === null ? null : "2026-11-08T10:05:00.000Z",
  });
  const object = (
    key: string,
    current: ConfigObject["current"],
    draft: ConfigObject["draft"],
  ): ConfigObject => ({
    id: `00000000-0000-4000-8000-0000000007${String(key.length).padStart(2, "0")}`,
    type: "task-board",
    key,
    createdAt: "2026-11-08T10:00:00.000Z",
    archivedAt: null,
    current,
    draft,
  });
  const fieldBoard: TaskBoardBody = {
    name: "Fictional Project board",
    columns: [doing.id, todo.id],
    filter: { by: "field", fieldId: project.id, value: "Fictional Apollo" },
  };
  const boards = [
    object(
      "fictional-draft",
      null,
      version(null, { ...fieldBoard, name: "Fictional draft board" }),
    ),
    object("fictional-project", version(2, fieldBoard), null),
    object(
      "fictional-gone",
      version(1, {
        name: "Fictional linked board",
        columns: [todo.id, "00000000-0000-4000-8000-000000000499"],
        filter: {
          by: "linked-record",
          recordId: "00000000-0000-4000-8000-000000000301",
        },
      }),
      version(null, { name: "Fictional linked board", columns: [todo.id] }),
    ),
  ];
  const list = (
    rows: ConfigObject[] | null,
    rowError: { id: string; message: string } | null = null,
    error = "",
  ) =>
    renderToStaticMarkup(
      <TaskBoardsList
        boards={rows}
        buckets={[todo, doing]}
        fields={[project]}
        error={error}
        busy={false}
        rowError={rowError}
        onCreate={() => {}}
        onEdit={() => {}}
        onNewDraft={() => {}}
        onPublish={() => {}}
        onRetire={() => {}}
      />,
    );
  const form = (initial: TaskBoardBody | null, error = "") =>
    renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <TaskBoardForm
          boardKey={initial ? "fictional-project" : null}
          initial={initial}
          buckets={[todo, doing]}
          fields={[project]}
          busy={false}
          error={error}
          onSave={() => {}}
          onCancel={() => {}}
        />
      </WorkspaceProvider>,
    );
  const tableRows = (markup: string) =>
    [...markup.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .map((match) => match[1])
      .slice(1);

  // ADM-04 (job 075): a team detail tab, which the server opens for the team's owners and admins
  // only (tests/admin-routes.test.ts); company authority never lists it as a page.
  it("shows the tab on team detail only, never as a page of company authority", () => {
    for (const teamRole of TEAM_ROLES)
      for (const companyLevel of COMPANY_LEVELS)
        expect(
          adminTabs({ teamRole, companyLevel }).map((tab) => tab.key as string),
        ).not.toContain("task-boards");
    for (const role of ["owner", "admin"]) {
      const markup = renderToStaticMarkup(
        <WorkspaceProvider value={workspace}>
          <TeamDetail
            team={{ id: "fictional-other-team", name: "Fictional Other Team" }}
            role={role}
            companyLevel={null}
            tab="task-boards"
          />
        </WorkspaceProvider>,
      );
      expect(markup, role).toContain(
        '<div role="tabpanel" id="team-panel-task-boards" aria-labelledby="team-tab-task-boards" tabindex="0" class="stack"><section class="panel stack"><h2 tabindex="-1">Task boards</h2>',
      );
      expect(markup, role).toContain("<strong>All buckets</strong>");
      expect(markup, role).toContain(
        '<p role="status">Loading task boards…</p>',
      );
      // Its own panel, not a link to a settings page.
      expect(markup, role).not.toContain('class="button" href="/app/settings');
    }
  });

  it("shows the built-in All buckets board as text and each board's state, columns, filter and actions", () => {
    const markup = list(boards);
    expect(markup).toContain("<strong>All buckets</strong>");
    expect(markup).toContain(
      "Every active bucket of this team, in position order, with no filter.",
    );
    expect(markup).toContain("It cannot be changed or retired.");
    // The All buckets text comes before the table and has no control.
    const builtIn = markup.slice(0, markup.indexOf("<table"));
    expect(builtIn.match(/<button/g)).toHaveLength(1);
    expect(builtIn).toContain(">New board</button>");
    const rows = tableRows(markup);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("<strong>Fictional draft board</strong>");
    expect(rows[0]).toContain(">Draft</td>");
    expect(rows[0]).toContain(">Edit draft</button>");
    expect(rows[0]).toContain(">Publish</button>");
    expect(rows[0]).not.toContain(">New draft</button>");
    expect(rows[1]).toContain(">Published (version 2)</td>");
    expect(rows[1]).toContain(">Fictional doing, Fictional to do</td>");
    expect(rows[1]).toContain(">Tasks whose Project is Fictional Apollo.</td>");
    expect(rows[1]).toContain(">New draft</button>");
    expect(rows[1]).not.toContain(">Publish</button>");
    expect(rows[2]).toContain(">Published (version 1), draft in progress</td>");
    expect(rows[2]).toContain(
      ">Fictional to do, A bucket that is no longer active</td>",
    );
    expect(rows[2]).toContain(">Tasks linked to one chosen record.</td>");
    for (const row of rows) expect(row).toContain(">Retire board</button>");
    // Bucket names only, never their ids.
    expect(markup).not.toContain(todo.id);
    expect(list([])).toContain("No task boards yet.");
    expect(list(null)).toContain('<p role="status">Loading task boards…</p>');
    expect(list(null, null, "Network unavailable")).toContain(
      "Network unavailable",
    );
  });

  it("shows each refusal in plain words next to its row or form", () => {
    const refusal = (code: string, message = "Fictional message.") =>
      taskBoardRefusal(new ClientError(400, code, message));
    expect(refusal("invalid_reference")).toContain(
      "is not an active record of this team that you can see",
    );
    expect(refusal("archived_reference")).toBe(
      "A bucket or record this board names has been archived. Choose an active one.",
    );
    expect(refusal("config_draft_exists")).toBe(
      "This board already has a draft. Edit that draft instead.",
    );
    expect(refusal("config_state_conflict")).toContain(
      "a retired board used this name",
    );
    expect(refusal("invalid_input", "name: Too small.")).toBe(
      "This board cannot be saved as it is: name: Too small.",
    );
    const rows = tableRows(
      list(boards, {
        id: boards[1].id,
        message: refusal("archived_reference"),
      }),
    );
    expect(rows[1]).toContain(
      '<p class="field-error" role="alert">A bucket or record this board names has been archived. Choose an active one.</p>',
    );
    expect(rows[0]).not.toContain("field-error");
    expect(rows[2]).not.toContain("field-error");
    const refused = form(fieldBoard, refusal("invalid_reference"));
    expect(refused).toContain(
      '<div tabindex="-1" class="notice error" role="alert">',
    );
    expect(refused).toContain("Choose it again.");
  });

  // Round 1 UX review: at 360 px the form's refusals sat above the viewport while focus stayed
  // on Save draft, far below.
  it("moves focus to the form's refusals after a submit, so they scroll into view", () => {
    const refused = form(
      fieldBoard,
      taskBoardRefusal(new ClientError(400, "archived_reference", "Archived.")),
    );
    const alert =
      /<div tabindex="-1" class="notice error" role="alert">([\s\S]*?)<\/div>/.exec(
        refused,
      );
    expect(alert?.[1]).toContain("has been archived");
    // The alert comes before the form's fields, and the form focuses it on each refusal.
    expect(refused.indexOf("notice error")).toBeLessThan(
      refused.indexOf("Board name"),
    );
    const source = readFileSync(
      new URL(
        "../src/components/settings/task-boards-tab.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*if \(issues\.length \|\| error\) alertRef\.current\?\.focus\(\);\s*\}, \[issues, error\]\);/,
    );
    expect(source).toMatch(/<div\s+ref=\{alertRef\}\s+tabIndex=\{-1\}/);
    // Without a refusal there is no alert to focus.
    expect(form(fieldBoard)).not.toContain("notice error");
  });

  it("edits the name, ticked buckets in order with Move up and Move down, and one filter", () => {
    const created = form(null);
    expect(created).toContain('<h3 tabindex="-1">New board</h3>');
    expect(created).toContain("<span>Board name</span>");
    expect(created).toContain("<legend>Columns</legend>");
    expect(created).not.toContain("Move up");
    for (const option of ["None", "Vacancy", "Linked record", "Task field"])
      expect(created).toContain(`>${option}</option>`);
    expect(created).toContain(">Save draft</button>");
    const edited = form(fieldBoard);
    expect(edited).toContain(
      '<h3 tabindex="-1">Edit draft: Fictional Project board</h3>',
    );
    // The ticked columns in board order, each with its move buttons; the ends are disabled.
    const items = [...edited.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(
      (match) => match[1],
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatch(/checked=""\/>Fictional doing<\/label>/);
    expect(items[0]).toMatch(
      /aria-label="Move Fictional doing up" disabled=""/,
    );
    expect(items[1]).toMatch(/checked=""\/>Fictional to do<\/label>/);
    expect(items[1]).toMatch(
      /aria-label="Move Fictional to do down" disabled=""/,
    );
    expect(edited).toMatch(/<option value="field" selected="">Task field/);
    expect(edited).toContain(
      '<label for="task-board-field">Task field</label>',
    );
    expect(edited).toMatch(
      /<option value="[^"]+" selected="">Project<\/option>/,
    );
    expect(edited).toMatch(
      /<option value="Fictional Apollo" selected="">Fictional Apollo<\/option>/,
    );
    expect(edited).toContain(">Fictional Zephyr</option>");
    const linked = form({
      name: "Fictional linked board",
      columns: [todo.id],
      filter: {
        by: "linked-record",
        recordId: "00000000-0000-4000-8000-000000000301",
      },
    });
    expect(linked).toContain(
      '<label for="task-board-link-kind">Linked record type</label>',
    );
    expect(linked).toMatch(
      /<option value="current" selected="">The saved linked record<\/option>/,
    );
    const vacancy = form({
      name: "Fictional vacancy board",
      columns: [todo.id],
      filter: {
        by: "vacancy",
        vacancyId: "00000000-0000-4000-8000-000000000301",
      },
    });
    expect(vacancy).toContain(
      '<label for="task-board-vacancy">Vacancy</label>',
    );
  });
});

// ADM-02 (job 069): Admin > Teams, the list and Create a team.
describe("teams tab", () => {
  const row = (
    name: string,
    teamRole: AdminTeamRow["teamRole"],
    current = false,
  ): AdminTeamRow => ({
    teamId: teamRole ? `fictional-${name.toLowerCase()}-id` : null,
    name: `Fictional ${name}`,
    slug: `fictional-${name.toLowerCase()}`,
    createdAt: "2026-11-02T09:00:00.000Z",
    teamRole,
    current,
    archived: false,
  });
  const rows = [
    row("Alpha", "owner", true),
    row("Bravo", "admin"),
    row("Charlie", null),
    row("Delta", "recruiter"),
    row("Echo", "viewer"),
  ];
  const rowsOf = (markup: string) =>
    [...markup.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .map((match) => match[1])
      .slice(1);
  const page = (canCreateTeam: boolean, value = access("owner", null)) =>
    renderToStaticMarkup(
      <WorkspaceProvider value={{ ...workspace, canCreateTeam }}>
        <AdminPortalView tab="teams" access={value} denied={false} error="" />
      </WorkspaceProvider>,
    );

  it("lists name, identifier, created date and access, with Open to its detail page on every team the caller owns or administers", () => {
    const markup = renderToStaticMarkup(<TeamsPanel rows={rows} error="" />);
    expect(markup).toContain("<h2>Teams</h2>");
    expect(markup).toMatch(
      /<div class="table-wrap"><table class="data-table"><caption class="sr-only">Teams, by name<\/caption>/,
    );
    for (const header of [
      "Team",
      "Identifier",
      "Created",
      "Your access",
      "Actions",
    ])
      expect(markup).toContain(`<th>${header}</th>`);
    const [alpha, bravo, charlie, delta, echo] = rowsOf(markup);
    const created = `data-label="Created">${formatDate("2026-11-02T09:00:00.000Z")}<`;
    expect(alpha).toContain('data-label="Team">Fictional Alpha<');
    expect(alpha).toContain('data-label="Identifier">fictional-alpha<');
    expect(alpha).toContain(created);
    expect(alpha).toContain('data-label="Your access">Owner<');
    expect(alpha).toContain(
      '<a class="button secondary" href="/app/admin/teams/fictional-alpha-id">Open<span class="sr-only"> Fictional Alpha</span></a>',
    );
    expect(alpha).not.toContain("<button");
    expect(bravo).toContain('data-label="Your access">Admin<');
    expect(bravo).toContain(
      '<a class="button secondary" href="/app/admin/teams/fictional-bravo-id">Open<span class="sr-only"> Fictional Bravo</span></a>',
    );
    expect(bravo).not.toContain("<button");
    // Not a member, Recruiter and Viewer rows are text only: no link, button or other control.
    expect(charlie).toContain('data-label="Team">Fictional Charlie<');
    expect(charlie).toContain('data-label="Identifier">fictional-charlie<');
    expect(charlie).toContain(created);
    expect(charlie).toContain('data-label="Your access">Not a member<');
    expect(delta).toContain('data-label="Your access">Recruiter<');
    expect(echo).toContain('data-label="Your access">Viewer<');
    for (const text of [charlie, delta, echo])
      expect(text).not.toMatch(/<a |<button|<input|<select/);
  });

  // ADM-05 (job 078): the archived state is visible text in the Team cell.
  it("labels an archived team Archived in its Team cell, for members and non-members alike", () => {
    const markup = renderToStaticMarkup(
      <TeamsPanel
        rows={[
          { ...row("Alpha", "owner", true), archived: true },
          { ...row("Charlie", null), archived: true },
          row("Delta", "recruiter"),
        ]}
        error=""
      />,
    );
    const [alpha, charlie, delta] = rowsOf(markup);
    for (const [text, name] of [
      [alpha, "Alpha"],
      [charlie, "Charlie"],
    ])
      expect(text).toContain(
        `data-label="Team">Fictional ${name} <span class="badge warning">Archived</span></td>`,
      );
    expect(delta).toContain('data-label="Team">Fictional Delta</td>');
    expect(delta).not.toContain("Archived");
    // The label adds no control.
    expect(charlie).not.toMatch(/<a |<button/);
  });

  it("opens another team's detail page by link, never switching the active team", () => {
    const markup = renderToStaticMarkup(<TeamsPanel rows={rows} error="" />);
    expect(markup).not.toMatch(/Switch|<button/);
    expect(
      [...markup.matchAll(/href="([^"]+)"/g)].map((link) => link[1]),
    ).toEqual([
      "/app/admin/teams/fictional-alpha-id",
      "/app/admin/teams/fictional-bravo-id",
    ]);
  });

  it("shows the loading and error states plainly", () => {
    expect(renderToStaticMarkup(<TeamsPanel rows={null} error="" />)).toContain(
      '<p role="status">Loading teams…</p>',
    );
    const failed = renderToStaticMarkup(
      <TeamsPanel rows={null} error="The request could not be completed." />,
    );
    expect(failed).toContain(
      '<p class="notice error" role="alert">Could not load the teams. The request could not be completed.</p>',
    );
    expect(failed).not.toContain("<table");
  });

  it("shows the list and, only when the user may create a team, the Create a team panel", () => {
    for (const canCreateTeam of [true, false])
      for (const value of [access("owner", null), access("viewer", "admin")]) {
        const markup = page(canCreateTeam, value);
        expect(markup).toContain("<h2>Teams</h2>");
        expect(markup).toContain('<p role="status">Loading teams…</p>');
        expect(markup).toContain('aria-current="page" href="/app/admin/teams"');
        expect(
          markup.includes("Create a team</h2>"),
          String(canCreateTeam),
        ).toBe(canCreateTeam);
        expect(markup.includes(">Create team</button>")).toBe(canCreateTeam);
        expect(markup).not.toContain("disabled");
      }
  });

  it("shows the no-access text to a recruiter or viewer without company authority", () => {
    for (const teamRole of ["recruiter", "viewer"])
      onlyHeadingAndNoAccess(page(true, access(teamRole, null)));
  });
});

// ADM-03 (job 072): one team's detail page with its Members and Settings tabs.
describe("team detail", () => {
  // Another fictional team than the active one, which the server allowed.
  const other = { id: "fictional-other-team", name: "Fictional Other Team" };
  const detail = (
    props: Partial<TeamDetailProps> = {},
    value: MeAccess | null = access("owner", "owner"),
  ) =>
    renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <AdminPortalView
          tab="teams"
          access={value}
          denied={false}
          error=""
          detail={
            <TeamDetail
              team={other}
              role="owner"
              companyLevel="owner"
              tab="members"
              {...props}
            />
          }
        />
      </WorkspaceProvider>,
    );
  const tabs = (markup: string) =>
    [...markup.matchAll(/<button [^>]*role="tab"[^>]*>([^<]+)<\/button>/g)].map(
      (match) => [match[0], match[1]],
    );

  const SEVEN = [
    ["members", "Members"],
    ["settings", "Settings"],
    ["cv-storage", "CV storage"],
    ["speed", "Speed"],
    ["task-boards", "Task boards"],
    ["activity", "Activity"],
    ["archive", "Archive"],
  ] as const;
  /** The tab panel and what follows it. */
  const panel = (markup: string) =>
    markup.slice(markup.indexOf('<div role="tabpanel"'));

  it("shows the shell, the team's name and a tablist with exactly the seven tabs in order, Archive last", () => {
    const markup = detail();
    expect(markup).toContain("<h1>Admin portal</h1>");
    expect(sidebar(markup)).toContain(
      '<a aria-current="page" href="/app/admin/teams">Teams</a>',
    );
    expect(content(markup)).toContain("<h2>Fictional Other Team</h2>");
    expect(markup).toContain(
      '<div class="tabs" role="tablist" aria-label="Team details">',
    );
    const found = tabs(markup);
    expect(found.map(([, label]) => label)).toEqual(
      SEVEN.map(([, label]) => label),
    );
    SEVEN.forEach(([key, label], index) =>
      expect(found[index][0]).toBe(
        `<button type="button" role="tab" id="team-tab-${key}" aria-controls="team-panel-${key}" tabindex="${index ? -1 : 0}" aria-selected="${!index}">${label}</button>`,
      ),
    );
    expect(markup).toContain(
      '<div role="tabpanel" id="team-panel-members" aria-labelledby="team-tab-members" tabindex="0" class="stack">',
    );
    expect(TEAM_DETAIL_TABS.map((tab) => [tab.key, tab.label])).toEqual(
      SEVEN.map((tab) => [...tab]),
    );
    // No tab of a later item.
    for (const later of [
      "Overview",
      "Roles in this team",
      "Mail log",
      "Danger zone",
    ])
      expect(content(markup), later).not.toContain(later);
  });

  it("opens the tab of ?tab=, and Members for a missing or unknown key", () => {
    for (const [key] of SEVEN) {
      expect(teamDetailTab(key)).toBe(key);
      const markup = detail({ tab: key });
      const selected = tabs(markup).filter(([tag]) =>
        tag.includes('aria-selected="true"'),
      );
      expect(selected, key).toHaveLength(1);
      expect(selected[0][0], key).toContain(`id="team-tab-${key}"`);
      expect(selected[0][0], key).toContain('tabindex="0"');
      expect(markup, key).toContain(
        `<div role="tabpanel" id="team-panel-${key}" aria-labelledby="team-tab-${key}" tabindex="0" class="stack">`,
      );
    }
    for (const value of [
      undefined,
      "",
      "overview",
      "tokens",
      ["speed"],
      "SPEED",
    ])
      expect(teamDetailTab(value), String(value)).toBe("members");
  });

  it("opens Settings with the rename form and Prepare task board, and Members otherwise", () => {
    const settings = detail({ tab: "settings" });
    expect(tabs(settings)[1][0]).toContain('aria-selected="true"');
    expect(settings).toContain('id="team-panel-settings"');
    expect(settings).toMatch(
      /<label class="field"><span>Team name<\/span><input required="" maxLength="100" value="Fictional Other Team"\/><\/label>/,
    );
    expect(settings).toContain(
      '<button type="submit" class="button" disabled="">Save team name</button>',
    );
    // Prepare task board is the second control, under the rename form.
    expect(panel(settings)).toMatch(
      /<h2>Rename team<\/h2>[\s\S]*Save team name<\/button>[\s\S]*<h2>Task board<\/h2><p class="muted">Prepares the team&#x27;s default task buckets when it has none. Existing tasks and buckets are kept.<\/p><div class="row"><button type="button" class="button secondary">Prepare task board<\/button><\/div>/,
    );
    expect(settings).not.toContain("<h2>Members</h2>");
    const members = detail();
    expect(members).toContain("<h2>Members</h2>");
    expect(members).not.toContain("Save team name");
    expect(members).not.toContain("Prepare task board");
  });

  it("shows the CV storage panel with its provider-cap sentence while its settings load", () => {
    const markup = panel(detail({ tab: "cv-storage" }));
    expect(markup).toContain('<section class="panel" id="cv-storage"><h2><svg');
    expect(markup).toContain(" CV storage</h2>");
    expect(markup).toContain(
      "These are application limits, not hard provider caps. The store-wide budget set by the RecruitmentOS owner still applies.",
    );
    expect(markup).toContain(
      '<p role="status">Loading CV storage settings…</p>',
    );
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("<h2>Members</h2>");
  });

  it("shows the Speed panel with what it keeps while its timings load", () => {
    const markup = panel(detail({ tab: "speed" }));
    expect(markup).toContain('<section class="panel stack"><h2>Speed</h2>');
    expect(markup).toContain(
      "This panel holds the last 30 days of timings and route names only, with no names, ids or content.",
    );
    expect(markup).toContain('<p role="status">Loading speed timings…</p>');
    expect(markup).not.toMatch(/<input|<select|<button/);
  });

  it("shows the team's activity list with search, the record-type filter and paging", () => {
    const markup = panel(detail({ tab: "activity" }));
    expect(markup).toContain('<section class="panel"><h2>Activity</h2>');
    expect(markup).toContain(
      '<input aria-label="Search activity" placeholder="Search activity…" value=""/>',
    );
    expect(markup).toContain(
      '<select aria-label="Filter activity by record type">',
    );
    expect(markup).toContain(
      '<option value="" selected="">All record types</option>',
    );
    expect(markup).toContain("<option>candidate</option>");
    expect(markup).toContain("<span>0 events</span>");
    expect(markup).toMatch(
      /<button class="button secondary small" disabled="">Previous<\/button><span>Page 1<\/span><button class="button secondary small" disabled="">Next<\/button>/,
    );
    // The page's own heading and Refresh stay on /app/activity.
    expect(markup).not.toContain("<h1>");
    expect(markup).not.toContain("Refresh");
  });

  it("keeps /app/activity's markup and adds the heading only on the tab", () => {
    const screen = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <ActivityScreen />
      </WorkspaceProvider>,
    );
    expect(screen).toContain("<h1>Activity</h1>");
    expect(screen).toContain(">Refresh</button>");
    expect(screen).toContain(
      '<section class="panel"><div class="records-toolbar">',
    );
    const tab = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <TeamScope teamId={other.id}>
          <ActivityList />
        </TeamScope>
      </WorkspaceProvider>,
    );
    const list = (markup: string) =>
      markup
        .slice(markup.indexOf('<div class="records-toolbar">'))
        .split("</section>")[0];
    expect(list(tab)).toBe(list(screen));
  });

  // ADM-05 (job 078): Archive, last of the team's tabs.
  const archiveView = (
    props: Partial<Parameters<typeof TeamArchiveView>[0]> = {},
  ) =>
    renderToStaticMarkup(
      <TeamArchiveView
        role="owner"
        archived={false}
        loadError=""
        busy={false}
        error=""
        onArchive={() => {}}
        onRestore={() => {}}
        {...props}
      />,
    );
  type ArchiveDialogProps = Parameters<typeof TeamArchiveDialogView>[0];
  const archiveDialogProps = (
    overrides: Partial<ArchiveDialogProps> = {},
  ): ArchiveDialogProps => ({
    name: other.name,
    typed: "",
    busy: false,
    error: "",
    ids: {
      description: "archive-what",
      input: "archive-input",
      name: "archive-name",
    },
    onTyped: () => {},
    onCancel: () => {},
    onConfirm: () => {},
    ...overrides,
  });
  const archiveDialog = (overrides: Partial<ArchiveDialogProps> = {}) =>
    renderToStaticMarkup(
      <TeamArchiveDialogView {...archiveDialogProps(overrides)} />,
    );
  /** Text buttons in document order; the icon-only close button has no text label. */
  const textButtons = (markup: string) =>
    [...markup.matchAll(/<button([^>]*)>([^<]+)<\/button>/g)].map(
      ([, attributes, label]) => ({ attributes, label }),
    );
  const ARCHIVE_SENTENCE =
    "Archiving makes the team read-only: members keep read access to everything, nothing is deleted, and a team owner can restore it at any time.";

  it("opens Archive by ?tab=archive and reads the state of the page's team", () => {
    reads.length = 0;
    const markup = panel(detail({ tab: "archive" }));
    expect(markup).toContain(
      '<section class="panel stack" aria-labelledby="team-archive-title"><h2 id="team-archive-title">Archive</h2>',
    );
    expect(markup).toContain(
      '<p role="status">Loading the team&#x27;s state…</p>',
    );
    expect(markup).toContain(ARCHIVE_SENTENCE);
    // No control until the state is known.
    expect(markup).not.toMatch(/<button|<input/);
    const tabRead = reads.filter(
      (read) =>
        read.path === "/api/v1/me/access" &&
        read.scope.identity?.teamId === other.id,
    );
    expect(tabRead).toHaveLength(1);
    expect(tabRead[0].scope.cache).not.toBe(dataCache);
  });

  it("shows an owner of an active team its state, the sentence and Archive team", () => {
    const markup = archiveView();
    expect(markup).toContain("<p>State: <strong>Active</strong></p>");
    expect(markup).toContain(ARCHIVE_SENTENCE);
    expect(textButtons(markup)).toEqual([
      {
        attributes: ' type="button" class="button danger"',
        label: "Archive team",
      },
    ]);
    expect(markup).not.toContain("Only a team owner");
  });

  it("shows an owner of an archived team Restore team, with no typed confirmation", () => {
    const markup = archiveView({ archived: true });
    expect(markup).toContain("<p>State: <strong>Archived</strong></p>");
    expect(textButtons(markup)).toEqual([
      { attributes: ' type="button" class="button"', label: "Restore team" },
    ]);
    expect(markup).not.toMatch(/<input|Archive team/);
    expect(textButtons(archiveView({ archived: true, busy: true }))).toEqual([
      {
        attributes: ' type="button" class="button" disabled=""',
        label: "Restoring…",
      },
    ]);
  });

  it("shows an admin the state and the owner sentence, with no button", () => {
    for (const archived of [false, true]) {
      const markup = archiveView({ role: "admin", archived });
      expect(markup).toContain(
        `<p>State: <strong>${archived ? "Archived" : "Active"}</strong></p>`,
      );
      expect(markup).toContain(
        "<p>Only a team owner can archive or restore this team.</p>",
      );
      expect(markup).not.toMatch(/<button|<input/);
    }
  });

  it("shows a refused change and a failed read as alerts", () => {
    expect(
      archiveView({ archived: true, error: "Fictional refusal." }),
    ).toContain('<p class="notice error" role="alert">Fictional refusal.</p>');
    const failed = archiveView({ archived: null, loadError: "Offline." });
    expect(failed).toContain(
      '<p class="notice error" role="alert">Could not load the team&#x27;s state. Offline.</p>',
    );
    expect(failed).not.toMatch(/<button/);
  });

  it("confirms Archive in a labelled alertdialog, enabled only for the exact trimmed team name", () => {
    const markup = archiveDialog();
    const opening = /<dialog[^>]*>/.exec(markup)![0];
    expect(opening).toContain('role="alertdialog"');
    expect(opening).toContain('aria-describedby="archive-what"');
    const heading = /aria-labelledby="([^"]+)"/.exec(opening)![1];
    expect(markup).toContain(`<h2 id="${heading}">Archive ${other.name}?</h2>`);
    expect(markup).toContain(
      '<label for="archive-input">Type the team name to confirm</label>',
    );
    expect(markup).toMatch(
      /<input id="archive-input"[^>]*aria-describedby="archive-name"/,
    );
    expect(markup).toContain(
      `<small id="archive-name" class="muted">Name: <strong>${other.name}</strong></small>`,
    );
    const [cancel, confirm] = textButtons(markup);
    expect(cancel.label).toBe("Cancel");
    expect(cancel.attributes).toContain("autofocus");
    expect(confirm.label).toBe("Archive team");
    expect(confirm.attributes).toContain('class="button danger"');
    for (const typed of [
      "",
      "   ",
      "Fictional Other",
      "fictional other team",
      `${other.name}.`,
    ])
      expect(
        textButtons(archiveDialog({ typed }))[1].attributes,
        typed,
      ).toContain("disabled");
    for (const typed of [other.name, `  ${other.name}  `])
      expect(
        textButtons(archiveDialog({ typed }))[1].attributes,
        typed,
      ).not.toContain("disabled");
    const busy = archiveDialog({ typed: other.name, busy: true });
    expect(/<dialog[^>]*>/.exec(busy)![0]).toContain('aria-busy="true"');
    expect(textButtons(busy)[1]).toEqual({
      attributes: ' type="button" class="button danger" disabled=""',
      label: "Archiving…",
    });
    expect(
      archiveDialog({ typed: other.name, error: "Fictional refusal." }),
    ).toContain('<p class="notice error" role="alert">Fictional refusal.</p>');
  });

  it("cancels by Cancel, Escape and the close button without sending a request", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const onCancel = vi.fn();
      const onConfirm = vi.fn();
      const tree = TeamArchiveDialogView(
        archiveDialogProps({ typed: other.name, onCancel, onConfirm }),
      );
      // Dialog calls onClose for Escape (its cancel event) and for its close button.
      (tree.props as { onClose: () => void }).onClose();
      const buttons: { label: ReactNode; onClick: () => void }[] = [];
      const walk = (node: ReactNode) => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!isValidElement(node)) return;
        const props = node.props as {
          children?: ReactNode;
          onClick?: () => void;
        };
        if (node.type === "button" && props.onClick)
          buttons.push({ label: props.children, onClick: props.onClick });
        walk(props.children);
      };
      walk((tree.props as { children: ReactNode }).children);
      buttons.find((button) => button.label === "Cancel")!.onClick();
      expect(onCancel).toHaveBeenCalledTimes(2);
      expect(onConfirm).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("archives and restores the page's team with PUT /api/v1/teams/archive and its X-Team-Id", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init: RequestInit) => {
        sent.push({
          method: init.method ?? "GET",
          path,
          team: new Headers(init.headers).get("X-Team-Id"),
          body: JSON.parse(String(init.body)),
        });
        return new Response(
          JSON.stringify({ data: { archived: true, changed: true } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    try {
      await teamRequests(other.id).setArchived(true);
      await teamRequests(other.id).setArchived(false);
      expect(sent).toEqual(
        [true, false].map((archived) => ({
          method: "PUT",
          path: "/api/v1/teams/archive",
          team: other.id,
          body: { archived },
        })),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends X-Team-Id of the page's team on every read and write of the new tabs and Prepare task board", async () => {
    const sent: { method: string; path: string; team: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init: RequestInit) => {
        sent.push({
          method: init.method ?? "GET",
          path,
          team: new Headers(init.headers).get("X-Team-Id"),
        });
        return new Response(
          JSON.stringify({ data: { versionId: "fictional", number: 1 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    try {
      reads.length = 0;
      renderToStaticMarkup(
        <WorkspaceProvider value={workspace}>
          <TeamDetailPortal
            team={other}
            role="owner"
            companyLevel="owner"
            tab="cv-storage"
          />
        </WorkspaceProvider>,
      );
      for (const tab of ["speed", "task-boards", "activity"] as const)
        detail({ tab });
      // A board's vacancy filter searches the page's team too.
      const vacancyId = "00000000-0000-4000-8000-000000000201";
      renderToStaticMarkup(
        <WorkspaceProvider value={workspace}>
          <TeamScope teamId={other.id}>
            <TaskBoardForm
              boardKey="fictional-board"
              initial={{
                name: "Fictional board",
                columns: [],
                filter: { by: "vacancy", vacancyId },
              }}
              buckets={[]}
              fields={[]}
              busy={false}
              error=""
              onSave={() => {}}
              onCancel={() => {}}
            />
          </TeamScope>
        </WorkspaceProvider>,
      );
      // Only the sidebar's access reads the active team.
      const sidebarRead = reads.filter(
        (read) => read.path === "/api/v1/me/access",
      );
      expect(sidebarRead.map((read) => read.scope.identity)).toEqual([
        { userId: workspace.user.id, teamId: workspace.team.id },
      ]);
      expect(sidebarRead[0].scope.cache).toBe(dataCache);
      const tabReads = reads.filter((read) => !sidebarRead.includes(read));
      expect(tabReads.map((read) => read.path)).toEqual([
        "/api/v1/teams/storage-settings",
        "/api/v1/teams/speed",
        "/api/v1/task-boards?drafts=true",
        "/api/v1/buckets?pageSize=100&sort=position&direction=asc",
        "/api/v1/task-fields?pageSize=100&sort=position&direction=asc",
        "/api/v1/activity?page=1&pageSize=50&search=&kind=",
        "/api/v1/vacancies?pageSize=100&search=",
        `/api/v1/vacancies/${vacancyId}`,
      ]);
      for (const read of tabReads) {
        expect(read.scope.identity, read.path).toEqual({
          userId: workspace.user.id,
          teamId: other.id,
        });
        // Not the active team's cache, whose identity change would drop the entry.
        expect(read.scope.cache, read.path).not.toBe(dataCache);
      }
      // Each read as its cache loads it when the tab is shown.
      for (const read of reads)
        await read.scope.cache.prefetch(read.scope.identity!, read.path);
      const body: TaskBoardBody = { name: "Fictional board", columns: [] };
      await saveStorageSettings(other.id, {
        maxBytes: null,
        maxFiles: null,
        uploadRequestsPerMinute: null,
        mcpCvTextEnabled: false,
      });
      const boards = taskBoardRequests(other.id);
      await boards.create("fictional-board", body);
      await boards.update("fictional-version", body);
      await boards.publish("fictional-version");
      await boards.retire("fictional-board-id");
      await teamRequests(other.id).prepareTaskBoard();
      expect(sent).toEqual([
        {
          method: "GET",
          path: "/api/v1/me/access",
          team: workspace.team.id,
        },
        ...tabReads.map((read) => ({
          method: "GET",
          path: read.path,
          team: other.id,
        })),
        {
          method: "PUT",
          path: "/api/v1/teams/storage-settings",
          team: other.id,
        },
        { method: "POST", path: "/api/v1/task-boards", team: other.id },
        {
          method: "PUT",
          path: "/api/v1/task-boards/fictional-version",
          team: other.id,
        },
        {
          method: "POST",
          path: "/api/v1/task-boards/fictional-version/publish",
          team: other.id,
        },
        {
          method: "DELETE",
          path: "/api/v1/task-boards/fictional-board-id",
          team: other.id,
        },
        { method: "POST", path: "/api/v1/teams/bootstrap", team: other.id },
      ]);
    } finally {
      vi.unstubAllGlobals();
      clearWorkspaceCache();
    }
  });

  it("holds the members list and the invite form for an owner or admin of the team", () => {
    for (const role of ["owner", "admin"]) {
      const markup = detail({ role });
      expect(markup, role).toContain("<h2>Members</h2>");
      expect(markup, role).toContain("<p>Loading members…</p>");
      expect(markup, role).toContain("Invite a colleague</h2>");
      expect(markup, role).toContain(">Send invitation</button>");
      expect(
        markup.includes('<option value="owner">owner</option>'),
        role,
      ).toBe(role === "owner");
    }
  });

  it("shows the detail even when the active team's access lists no page", () => {
    const markup = detail({}, access("recruiter", null));
    expect(markup).not.toContain(NO_ACCESS);
    expect(sidebarHrefs(markup)).toEqual(["/app/admin"]);
    expect(markup).not.toContain('aria-current="page"');
    expect(content(markup)).toContain("<h2>Fictional Other Team</h2>");
    expect(content(markup)).toContain("<h2>Members</h2>");
  });

  it("loads the active team's access for the sidebar and shows the detail meanwhile", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <TeamDetailPortal
          team={other}
          role="admin"
          companyLevel={null}
          tab="members"
        />
      </WorkspaceProvider>,
    );
    expect(markup).toContain("<h1>Admin portal</h1>");
    expect(sidebarHrefs(markup)).toEqual(["/app/admin"]);
    expect(content(markup)).toContain("<h2>Fictional Other Team</h2>");
    expect(markup).not.toContain(NO_ACCESS);
  });

  it("shows only the heading and the not-a-member text, with no team data", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <AdminPortalView
          tab="teams"
          access={null}
          denied
          error=""
          refusal={NOT_A_MEMBER}
        />
      </WorkspaceProvider>,
    );
    expect(NOT_A_MEMBER).toBe("You are not a member of this team");
    expect(markup).toContain("<h1>Admin portal</h1>");
    expect(markup).toContain("<p>You are not a member of this team</p>");
    expect(markup).not.toContain(NO_ACCESS);
    expect(markup).not.toMatch(/<nav|<h2|<table|role="status"|role="tab/);
  });

  const people: TeamMember[] = [
    {
      id: "fictional-member-owner",
      role: "owner",
      userId: workspace.user.id,
      user: {
        id: workspace.user.id,
        name: "Fictional Portal User",
        email: "portal-user@example.test",
      },
    },
    {
      id: "fictional-member-recruiter",
      role: "recruiter",
      userId: "fictional-recruiter",
      user: {
        id: "fictional-recruiter",
        name: "Fictional Recruiter",
        email: "recruiter@example.test",
      },
    },
  ];
  const table = (companyOwner: boolean, role = "owner") =>
    renderToStaticMarkup(
      <MembersTable
        members={people}
        userId={workspace.user.id}
        role={role}
        companyOwner={companyOwner}
        memberRoles={{
          data: {
            assignments: [],
            roles: [
              {
                roleObjectId: "fictional-role",
                name: "Fictional reader",
                membership: "viewer",
              },
            ],
          },
          error: "",
        }}
        busy={false}
        roleDrafts={{}}
        onDraft={() => {}}
        onChangeRole={() => {}}
        onRemove={() => {}}
        onResetTwoStep={() => {}}
        onSaveMemberRole={() => {}}
      />,
    );

  it("lists the members with team roles, the last owner rule and row actions", () => {
    const markup = table(false);
    expect(markup).toContain(
      '<div class="table-wrap"><table class="data-table settings-table">',
    );
    expect(markup).toContain(
      '<strong>Fictional Portal User</strong> (you)<br/><span class="muted">portal-user@example.test</span>',
    );
    expect(markup).toContain('<small class="muted">Last owner</small>');
    expect(markup).toContain(
      '<span class="sr-only">Role for Fictional Recruiter</span>',
    );
    expect(markup.match(/>Save role<\/button>/g)).toHaveLength(2);
    expect(markup.match(/>Remove<\/button>/g)).toHaveLength(2);
    // Reset two-step sign-in for team owners, never on their own row.
    expect(markup.match(/>Reset two-step sign-in<\/button>/g)).toHaveLength(1);
    expect(table(false, "admin")).not.toContain("Reset two-step sign-in");
  });

  it("shows the Configured role column only to a company owner", () => {
    const owner = table(true);
    expect(owner).toContain("<th>Configured role</th>");
    expect(owner).toContain("Team owners keep the Owner role");
    expect(owner).toContain(
      '<span class="sr-only">Configured role for Fictional Recruiter</span>',
    );
    expect(table(false)).not.toContain("Configured role");
    for (const companyLevel of ["admin", null]) {
      const markup = renderToStaticMarkup(
        <WorkspaceProvider value={workspace}>
          <TeamMembers team={other} role="owner" companyLevel={companyLevel} />
        </WorkspaceProvider>,
      );
      expect(markup, String(companyLevel)).not.toContain("Configured role");
    }
  });

  type Call = { name: string; body: unknown };
  /** A fake Better Auth organization client that records every call and answers with success. */
  const fakeTeamClient = () => {
    const calls: Call[] = [];
    const answer = (name: string) => async (body: unknown) => {
      calls.push({ name, body });
      return { data: { members: [], invitations: [] }, error: null };
    };
    const client = {
      getFullOrganization: answer("getFullOrganization"),
      update: answer("update"),
      inviteMember: answer("inviteMember"),
      updateMemberRole: answer("updateMemberRole"),
      removeMember: answer("removeMember"),
      cancelInvitation: answer("cancelInvitation"),
    } as unknown as TeamClient;
    return { client, calls };
  };

  it("names the page's team, not the active one, in every Better Auth call", async () => {
    const { client, calls } = fakeTeamClient();
    const requests = teamRequests(other.id, client);
    await requests.details();
    await requests.rename("Fictional Renamed Team");
    await requests.invite("invitee@example.test", "recruiter");
    await requests.changeRole("fictional-member-recruiter", "viewer");
    await requests.remove("fictional-member-recruiter");
    await requests.cancelInvitation("fictional-invitation");
    expect(calls).toEqual([
      {
        name: "getFullOrganization",
        body: { query: { organizationId: other.id } },
      },
      {
        name: "update",
        body: {
          organizationId: other.id,
          data: { name: "Fictional Renamed Team" },
        },
      },
      {
        name: "inviteMember",
        body: {
          email: "invitee@example.test",
          role: "recruiter",
          organizationId: other.id,
        },
      },
      {
        name: "updateMemberRole",
        body: {
          memberId: "fictional-member-recruiter",
          role: "viewer",
          organizationId: other.id,
        },
      },
      {
        name: "removeMember",
        body: {
          memberIdOrEmail: "fictional-member-recruiter",
          organizationId: other.id,
        },
      },
      // Better Auth checks the invitation against its own team.
      {
        name: "cancelInvitation",
        body: { invitationId: "fictional-invitation" },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain(workspace.team.id);
  });

  it("sends X-Team-Id for the page's team on the configured-role and two-step requests, also on the retry after Confirm it's you", async () => {
    const sent: { method: string; path: string; team: string | null }[] = [];
    const answers: Response[] = [];
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init: RequestInit) => {
        sent.push({
          method: init.method ?? "GET",
          path,
          team: new Headers(init.headers).get("X-Team-Id"),
        });
        return answers.shift() ?? json(200, { data: {} });
      }),
    );
    try {
      const requests = teamRequests(other.id);
      await requests.memberRoles();
      await requests.resetTwoStep("fictional-recruiter");
      answers.push(
        json(403, {
          error: {
            code: "SESSION_NOT_FRESH",
            message: "This change needs a recent sign-in.",
          },
        }),
      );
      const ask = vi.fn(async () => true);
      await retryWithFreshSession(
        () => requests.saveMemberRole("fictional-recruiter", "fictional-role"),
        ask,
      );
      expect(ask).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([
        { method: "GET", path: "/api/v1/teams/member-roles", team: other.id },
        {
          method: "POST",
          path: "/api/v1/teams/two-step-reset",
          team: other.id,
        },
        { method: "POST", path: "/api/v1/teams/member-roles", team: other.id },
        { method: "POST", path: "/api/v1/teams/member-roles", team: other.id },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ADM-06 (job 070): the re-authentication dialog for sensitive admin changes.
describe("re-authentication for sensitive admin changes", () => {
  const stale = () =>
    new ClientError(
      403,
      "SESSION_NOT_FRESH",
      "This change needs a recent sign-in. Confirm your password and two-step code, then try again.",
    );
  /** A request closure that records the body object it sends each time. */
  const recording = (outcomes: (() => unknown)[]) => {
    const body = { userId: "fictional-member", roleObjectId: null };
    const sent: unknown[] = [];
    const request = vi.fn(async () => {
      sent.push(body);
      return outcomes[sent.length - 1]();
    });
    return { body, sent, request };
  };

  it("asks once after a stale refusal and runs the same request once more", async () => {
    const { body, sent, request } = recording([
      () => {
        throw stale();
      },
      () => ({ data: { saved: true } }),
    ]);
    const ask = vi.fn(async () => true);
    expect(await retryWithFreshSession(request, ask)).toEqual({
      data: { saved: true },
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(body);
    expect(sent[1]).toBe(body);
  });

  it("throws the retry's error without asking again", async () => {
    const { request } = recording([
      () => {
        throw stale();
      },
      () => {
        throw stale();
      },
    ]);
    const ask = vi.fn(async () => true);
    await expect(retryWithFreshSession(request, ask)).rejects.toMatchObject({
      status: 403,
      code: "SESSION_NOT_FRESH",
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("ends as cancelled without a second request when the user cancels", async () => {
    const { request } = recording([
      () => {
        throw stale();
      },
    ]);
    const ask = vi.fn(async () => false);
    expect(await retryWithFreshSession(request, ask)).toBe(REAUTH_CANCELLED);
    expect(REAUTH_CANCELLED).toBe("cancelled");
    expect(request).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("rethrows any other error without asking", async () => {
    for (const error of [
      new ClientError(
        403,
        "role_assignment_forbidden",
        "Only a company owner can assign roles.",
      ),
      new ClientError(401, "UNAUTHENTICATED", "Sign in to continue."),
      new Error("Connection interrupted."),
    ]) {
      const ask = vi.fn(async () => true);
      const request = vi.fn(async () => {
        throw error;
      });
      await expect(retryWithFreshSession(request, ask)).rejects.toBe(error);
      expect(request).toHaveBeenCalledTimes(1);
      expect(ask).not.toHaveBeenCalled();
    }
  });

  type Answer = Awaited<ReturnType<ReauthClient["signIn"]["email"]>>;
  /** A fake Better Auth client: each call answers with the next queued result. */
  const fakeClient = (
    answers: {
      signIn?: Answer[];
      verifyTotp?: Answer[];
      setActive?: Answer[];
    } = {},
  ) => {
    const next = (list: Answer[] | undefined) => async (): Promise<Answer> =>
      list?.shift() ?? { data: {}, error: null };
    return {
      signIn: { email: vi.fn(next(answers.signIn)) },
      twoFactor: { verifyTotp: vi.fn(next(answers.verifyTotp)) },
      organization: { setActive: vi.fn(next(answers.setActive)) },
    };
  };
  const input = {
    email: "portal-user@example.test",
    password: "fictional-password",
    code: "123456",
    teamId: "fictional-team",
    challenged: false,
  };

  it("checks the code against Better Auth's challenge without trusting the device, then keeps the page's team", async () => {
    const client = fakeClient({
      signIn: [{ data: { twoFactorRedirect: true }, error: null }],
    });
    expect(await reauthenticate(client, input)).toEqual({ done: true });
    expect(client.signIn.email).toHaveBeenCalledWith({
      email: "portal-user@example.test",
      password: "fictional-password",
    });
    expect(client.twoFactor.verifyTotp).toHaveBeenCalledWith({
      code: "123456",
      trustDevice: false,
    });
    expect(client.organization.setActive).toHaveBeenCalledWith({
      organizationId: "fictional-team",
    });
  });

  it("shows a wrong password plainly, without checking a code, and never retries the change", async () => {
    const wrong: Answer = {
      data: null,
      error: {
        status: 401,
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
      },
    };
    const client = fakeClient({ signIn: [wrong, wrong] });
    expect(await reauthenticate(client, input)).toEqual({
      done: false,
      challenged: false,
      error: { message: "That password is not correct.", field: "password" },
    });
    expect(client.twoFactor.verifyTotp).not.toHaveBeenCalled();
    expect(client.organization.setActive).not.toHaveBeenCalled();
    const request = vi.fn(async () => {
      throw stale();
    });
    const ask = async () => (await reauthenticate(client, input)).done;
    expect(await retryWithFreshSession(request, ask)).toBe(REAUTH_CANCELLED);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("shows a wrong code plainly and sends only the code on the next attempt", async () => {
    const client = fakeClient({
      signIn: [{ data: { twoFactorRedirect: true }, error: null }],
      verifyTotp: [
        {
          data: null,
          error: { status: 401, code: "INVALID_CODE", message: "Invalid code" },
        },
      ],
    });
    expect(await reauthenticate(client, input)).toEqual({
      done: false,
      challenged: true,
      error: { message: "That code is not correct.", field: "code" },
    });
    expect(client.organization.setActive).not.toHaveBeenCalled();
    expect(
      await reauthenticate(client, {
        ...input,
        code: "654321",
        challenged: true,
      }),
    ).toEqual({ done: true });
    expect(client.signIn.email).toHaveBeenCalledTimes(1);
    expect(client.twoFactor.verifyTotp).toHaveBeenCalledTimes(2);
    expect(client.twoFactor.verifyTotp).toHaveBeenLastCalledWith({
      code: "654321",
      trustDevice: false,
    });
    expect(client.organization.setActive).toHaveBeenCalledTimes(1);
  });

  it("uses the code screen's words for an ended challenge, a lock and a 429", async () => {
    const refused = (error: NonNullable<Answer["error"]>) =>
      reauthenticate(fakeClient({ verifyTotp: [{ data: null, error }] }), {
        ...input,
        challenged: true,
      });
    for (const code of [
      "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
      "INVALID_TWO_FACTOR_COOKIE",
    ])
      expect(await refused({ status: 401, code })).toEqual({
        done: false,
        challenged: true,
        error: { message: "Sign in again.", signInAgain: true },
      });
    expect(
      await refused({ status: 401, code: "ACCOUNT_TEMPORARILY_LOCKED" }),
    ).toMatchObject({
      error: { message: "Too many incorrect codes. Try again in 15 minutes." },
    });
    expect(
      await refused({
        status: 429,
        code: "TOO_MANY_REQUESTS",
        message: "Fictional server wait message.",
      }),
    ).toMatchObject({ error: { message: "Fictional server wait message." } });
  });

  it("skips the code when Better Auth does not challenge, as on a trusted device", async () => {
    const client = fakeClient({
      signIn: [{ data: { redirect: false, token: "fictional" }, error: null }],
    });
    expect(await reauthenticate(client, input)).toEqual({ done: true });
    expect(client.twoFactor.verifyTotp).not.toHaveBeenCalled();
    expect(client.organization.setActive).toHaveBeenCalledWith({
      organizationId: "fictional-team",
    });
  });

  const dialog = (twoStepEnabled: boolean) =>
    renderToStaticMarkup(
      <FreshSessionDialog
        email="portal-user@example.test"
        teamId="fictional-team"
        twoStepEnabled={twoStepEnabled}
        client={fakeClient()}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
  /** The input a label names through its `for`, or "" when there is none. */
  const field = (markup: string, label: string) => {
    const id = new RegExp(`<label for="([^"]+)">${label}</label>`).exec(
      markup,
    )?.[1];
    return id
      ? (new RegExp(`<input [^>]*id="${id}"[^>]*>`).exec(markup)?.[0] ?? "")
      : "";
  };

  it("asks for the password and, with two-step sign-in on, the code, with Cancel and Confirm", () => {
    const markup = dialog(true);
    expect(markup).toMatch(/<h2 id="[^"]+">Confirm it&#x27;s you<\/h2>/);
    expect(markup).toContain("This change needs a recent sign-in");
    const password = field(markup, "Password");
    expect(password).toContain('type="password"');
    // HTML attribute names are case-insensitive; React writes them as autoComplete and inputMode.
    expect(password).toMatch(/ autocomplete="current-password"/i);
    expect(password).toContain('required=""');
    const code = field(markup, "Two-step code");
    expect(code).toMatch(/ autocomplete="one-time-code"/i);
    expect(code).toMatch(/ inputmode="numeric"/i);
    expect(code).toContain('required=""');
    expect(markup).toContain(
      '<button type="button" class="button secondary">Cancel</button>',
    );
    expect(markup).toContain(
      '<button type="submit" class="button">Confirm</button>',
    );
    expect(markup).not.toMatch(/trust/i);
    expect(markup).not.toContain('role="alert"');
    const plain = dialog(false);
    expect(field(plain, "Password")).toContain('type="password"');
    expect(plain).not.toContain("Two-step code");
    expect(plain).not.toContain("one-time-code");
  });

  it("never shows the dialog when a company owner opens Company authority", () => {
    const markup = render("company-authority", access("owner", "owner"));
    expect(markup).toContain("<h2>Company authority</h2>");
    expect(markup).not.toContain("Confirm it&#x27;s you");
    expect(markup).not.toContain("You are signed out on this device");
  });
});

// ADM-07 (job 073): Admin > Users, the list of everyone in every team and every pending invitation.
describe("users tab", () => {
  const person = (
    name: string,
    changes: Partial<WorkspacePersonRow> = {},
  ): WorkspacePersonRow => ({
    userId: `fictional-${name.toLowerCase()}`,
    name: `Fictional ${name}`,
    email: `${name.toLowerCase()}@example.test`,
    teams: [
      { team: "Fictional Alpha", teamRole: "recruiter", configuredRole: null },
    ],
    companyLevel: null,
    status: "active",
    lastSignInAt: "2026-11-05T10:30:00.000Z",
    twoStep: true,
    ...changes,
  });
  const rows: WorkspacePersonRow[] = [
    person("Owner", {
      companyLevel: "owner",
      teams: [
        { team: "Fictional Alpha", teamRole: "owner", configuredRole: null },
        {
          team: "Fictional Bravo",
          teamRole: "admin",
          configuredRole: "Fictional Sourcer",
        },
      ],
    }),
    person("Admin", {
      companyLevel: "admin",
      lastSignInAt: null,
      twoStep: false,
    }),
    person("Viewer", {
      teams: [
        { team: "Fictional Alpha", teamRole: "viewer", configuredRole: null },
      ],
    }),
    {
      userId: null,
      name: null,
      email: "invitee@example.test",
      teams: [
        {
          team: "Fictional Alpha",
          teamRole: "recruiter",
          configuredRole: null,
        },
        { team: "Fictional Bravo", teamRole: null, configuredRole: null },
      ],
      companyLevel: null,
      status: "invited",
      lastSignInAt: null,
      twoStep: false,
    },
  ];
  const panel = (props: Partial<Parameters<typeof UsersPanel>[0]> = {}) =>
    renderToStaticMarkup(
      <UsersPanel
        rows={rows}
        error=""
        filtered={false}
        hasMore={false}
        filters={NO_USER_FILTERS}
        teams={[
          { name: "Fictional Alpha", slug: "fictional-alpha" },
          { name: "Fictional Bravo", slug: "fictional-bravo" },
        ]}
        roles={[{ key: "fictional-sourcer", name: "Fictional Sourcer" }]}
        {...props}
      />,
    );
  const rowsOf = (markup: string) =>
    [...markup.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .map((match) => match[1])
      .slice(1);
  const body = (markup: string) =>
    /<tbody>([\s\S]*?)<\/tbody>/.exec(markup)?.[1] ?? "";

  it("lists Users first in People for a company owner and a company admin with people only", () => {
    const areaSets: MeAccess["adminAreas"][] = [
      [],
      ["people"],
      ["fields", "organisation"],
    ];
    for (const teamRole of [...TEAM_ROLES, null])
      for (const companyLevel of COMPANY_LEVELS)
        for (const adminAreas of areaSets) {
          const keys = adminTabs({ teamRole, companyLevel, adminAreas }).map(
            (tab) => tab.key,
          );
          const shown =
            companyLevel === "owner" ||
            (companyLevel === "admin" && adminAreas.includes("people"));
          const label = `${teamRole} / ${companyLevel} / ${adminAreas.join(",")}`;
          expect(keys.includes("users"), label).toBe(shown);
          if (shown) expect(keys[0], label).toBe("users");
        }
    expect(ADMIN_TABS.find((tab) => tab.key === "users")).toEqual({
      key: "users",
      label: "Users",
      level: "people",
      group: "People",
      description:
        "See everyone in every team of the company, with their teams, roles, company level, last sign-in and two-step sign-in.",
    });
  });

  it("renders the columns, the team lines and the invited, not recorded and not signed in texts", () => {
    const markup = panel();
    expect(markup).toContain("<h2>Users</h2>");
    expect(markup).toContain(
      "Everyone in every team of the company and everyone with a pending invitation, with their teams and roles.",
    );
    expect(markup).toMatch(
      /<div class="records-panel"><div class="table-wrap"><table class="data-table compact"><caption class="sr-only">People, by name<\/caption>/,
    );
    expect(
      [...markup.matchAll(/<th>([^<]+)<\/th>/g)].map((th) => th[1]),
    ).toEqual([
      "Name",
      "Email",
      "Teams",
      "Company level",
      "Status",
      "Last sign-in",
      "Two-step",
    ]);
    const [owner, admin, viewer, invited] = rowsOf(markup);
    for (const row of [owner, admin, viewer, invited])
      for (const label of [
        "Name",
        "Email",
        "Teams",
        "Company level",
        "Status",
        "Last sign-in",
        "Two-step",
      ])
        expect(row).toContain(`data-label="${label}"`);
    expect(owner).toContain(
      'data-label="Name"><a href="/app/admin/users/fictional-owner">Fictional Owner</a><',
    );
    expect(owner).toContain('data-label="Email">owner@example.test<');
    expect(owner).toContain(
      "<div>Fictional Alpha · Owner</div><div>Fictional Bravo · Admin · Fictional Sourcer</div>",
    );
    expect(owner).toContain('data-label="Company level">Company owner<');
    expect(owner).toContain('data-label="Status">Active<');
    expect(owner).toContain(
      `data-label="Last sign-in">${formatDate("2026-11-05T10:30:00.000Z", true)}<`,
    );
    expect(owner).toContain('data-label="Two-step">On<');
    expect(admin).toContain('data-label="Company level">Company admin<');
    expect(admin).toContain('data-label="Last sign-in">Not recorded<');
    expect(admin).toContain('data-label="Two-step">Off<');
    expect(viewer).toContain("<div>Fictional Alpha · Viewer</div>");
    expect(viewer).toContain('data-label="Company level">None<');
    expect(invited).toContain('data-label="Name">Invited<');
    expect(invited).toContain('data-label="Email">invitee@example.test<');
    expect(invited).toContain(
      "<div>Fictional Alpha · Recruiter</div><div>Fictional Bravo · Role not recorded</div>",
    );
    expect(invited).toContain('data-label="Status">Invited<');
    expect(invited).toContain('data-label="Last sign-in">Not signed in yet<');
    expect(markup).toContain(
      '<p tabindex="-1" role="status" class="muted">Showing 4 people</p>',
    );
    // No button, checkbox or other control on any row; only names link (ADM-08).
    expect(body(markup)).not.toMatch(/<button|<input|<select|tabindex/);
    for (const text of [
      "Open",
      "Invite ",
      "Export",
      "Deactivate",
      "Select all",
    ])
      expect(markup, text).not.toContain(text);
  });

  it("offers the four filters with their choices and Apply filters", () => {
    const markup = panel();
    expect(markup).toContain('aria-label="User filters"');
    for (const label of ["Team", "Status", "Company level", "Configured role"])
      expect(markup).toContain(`<span>${label}</span><select`);
    for (const option of [
      '<option value="" selected="">Any team</option>',
      '<option value="fictional-alpha">Fictional Alpha</option>',
      '<option value="fictional-bravo">Fictional Bravo</option>',
      '<option value="" selected="">Any status</option>',
      '<option value="active">Active</option>',
      '<option value="invited">Invited</option>',
      '<option value="" selected="">Any level</option>',
      '<option value="owner">Company owner</option>',
      '<option value="admin">Company admin</option>',
      '<option value="none">No company authority</option>',
      '<option value="" selected="">Any configured role</option>',
      '<option value="fictional-sourcer">Fictional Sourcer</option>',
    ])
      expect(markup).toContain(option);
    expect(markup).toContain(
      '<button type="submit" class="button">Apply filters</button>',
    );
    // Teams that cannot be loaded leave only Any team, with the reason.
    const failed = panel({
      teams: null,
      teamsError: "The request could not be completed.",
    });
    expect(failed).toContain(
      '<p class="notice error" role="alert">Could not load the filter choices. The request could not be completed.</p>',
    );
    expect(failed).not.toContain('value="fictional-alpha"');
    expect(failed).toContain("Any team");
  });

  it("shows Show more only while there are more people, busy while loading, and a separate error", () => {
    expect(panel()).not.toContain("Show more");
    expect(panel({ hasMore: true })).toContain(
      '<button type="button" class="button secondary">Show more</button>',
    );
    expect(panel({ hasMore: true, busy: true })).toContain(
      '<button type="button" class="button secondary" disabled="">Show more</button>',
    );
    const failed = panel({
      hasMore: true,
      moreError: "The request could not be completed.",
    });
    expect(failed).toContain(
      '<p class="notice error" role="alert">Could not load more people. The request could not be completed.</p>',
    );
    expect(rowsOf(failed)).toHaveLength(4);
  });

  it("shows the loading, error, refused and both empty states", () => {
    expect(panel({ rows: null })).toContain(
      '<p role="status">Loading people…</p>',
    );
    const failed = panel({
      rows: null,
      error: "The request could not be completed.",
    });
    expect(failed).toContain(
      '<p class="notice error" role="alert">Could not load the people. The request could not be completed.</p>',
    );
    expect(failed).not.toContain("<table");
    const refused = panel({ rows: null, denied: true, error: "Forbidden" });
    expect(refused).toContain(`<p>${NO_ACCESS}</p>`);
    expect(refused).not.toMatch(/<table|<form|<select|Forbidden/);
    expect(panel({ rows: [], filtered: true })).toContain(
      '<p class="muted">No people match these filters.</p>',
    );
    expect(panel({ rows: [] })).toContain(
      '<p class="muted">There are no people in the company&#x27;s teams yet.</p>',
    );
    expect(panel({ rows: [] })).not.toContain("<table");
  });

  it("renders the Users page in the portal for a company owner and refuses a company admin without people", () => {
    const markup = render("users", access("recruiter", "owner"));
    expect(markup).toContain('aria-current="page" href="/app/admin/users"');
    expect(markup).toContain("<h2>Users</h2>");
    expect(markup).toContain('<p role="status">Loading people…</p>');
    onlyHeadingAndNoAccess(render("users", access("owner", "admin")));
  });
});

// ADM-08 (job 076): the user detail page, the Users list links and Invite to teams.
describe("user detail", () => {
  const event = (
    action: string,
    changes: Partial<WorkspacePerson["events"][number]> = {},
  ): WorkspacePerson["events"][number] => ({
    occurredAt: "2026-11-04T09:15:00.000Z",
    action,
    actorId: "fictional-company-owner",
    actorName: "Fictional Company Owner",
    objectType: null,
    objectKey: null,
    roleName: null,
    ...changes,
  });
  const subject: WorkspacePerson = {
    userId: "fictional-subject",
    name: "Fictional Subject",
    email: "subject@example.test",
    status: "active",
    lastSignInAt: "2026-11-05T10:30:00.000Z",
    twoStep: true,
    signedInDevices: 2,
    teams: [
      {
        team: "Fictional Alpha",
        slug: "fictional-alpha",
        teamRole: "recruiter",
        configuredRole: "Fictional Sourcer",
      },
      {
        team: "Fictional Bravo",
        slug: "fictional-bravo",
        teamRole: "viewer",
        configuredRole: null,
      },
    ],
    companyLevel: "admin",
    companyAreas: ["people", "fields"],
    planAccess: true,
    authoritySuspended: false,
    authoritySince: "2026-10-01T08:00:00.000Z",
    events: [
      event("two_step.reset", { actorName: null }),
      event("workspace_authority.changed"),
      event("scope.home_units_changed"),
      event("role.cleared"),
      event("role.assigned", { roleName: "Fictional Sourcer" }),
      event("role.assigned"),
      event("config.published", {
        actorId: "fictional-subject",
        actorName: "Fictional Subject",
        objectType: "workflow",
        objectKey: "fictional-flow",
      }),
    ],
  };
  const view = (
    props: Partial<Parameters<typeof UserDetailView>[0]> = {},
    person: Partial<WorkspacePerson> = {},
  ) =>
    renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <AdminPortalView
          tab="users"
          access={access("owner", "owner")}
          denied={false}
          error=""
          detail={
            <UserDetailView
              person={{ ...subject, ...person }}
              tab="profile"
              callerId={workspace.user.id}
              companyOwner
              canReset={false}
              {...props}
            />
          }
        />
      </WorkspaceProvider>,
    );
  const tabs = (markup: string) =>
    [...markup.matchAll(/<button [^>]*role="tab"[^>]*>([^<]+)<\/button>/g)].map(
      (match) => [match[0], match[1].replaceAll("&amp;", "&")],
    );
  const panel = (markup: string) =>
    markup.slice(markup.indexOf('<div role="tabpanel"'));
  /** The visible names of every button and link in the tab panel. */
  const controls = (markup: string) =>
    [...panel(markup).matchAll(/<(button|a)[^>]*>([\s\S]*?)<\/\1>/g)].map(
      (match) =>
        match[2]
          .replace(/<[^>]+>/g, "")
          .replaceAll("&amp;", "&")
          .trim(),
    );
  const FIVE = [
    ["profile", "Profile"],
    ["teams", "Teams & roles"],
    ["authority", "Company authority"],
    ["security", "Security"],
    ["activity", "Activity"],
  ] as const;

  it("shows the shell, the person's name and a tablist with exactly the five tabs in order", () => {
    const markup = view();
    expect(markup).toContain("<h1>Admin portal</h1>");
    expect(sidebar(markup)).toContain(
      '<a aria-current="page" href="/app/admin/users">Users</a>',
    );
    expect(content(markup)).toContain("<h2>Fictional Subject</h2>");
    expect(markup).toContain(
      '<div class="tabs" role="tablist" aria-label="User details">',
    );
    const found = tabs(markup);
    expect(found.map(([, label]) => label)).toEqual(
      FIVE.map(([, label]) => label),
    );
    FIVE.forEach(([key, label], index) =>
      expect(found[index][0]).toBe(
        `<button type="button" role="tab" id="user-tab-${key}" aria-controls="user-panel-${key}" tabindex="${index ? -1 : 0}" aria-selected="${!index}">${label.replace("&", "&amp;")}</button>`,
      ),
    );
    expect(markup).toContain(
      '<div role="tabpanel" id="user-panel-profile" aria-labelledby="user-tab-profile" tabindex="0" class="stack">',
    );
    expect(USER_DETAIL_TABS.map((tab) => [tab.key, tab.label])).toEqual(
      FIVE.map((tab) => [...tab]),
    );
  });

  it("opens the tab of ?tab=, and Profile for a missing or unknown key", () => {
    for (const [key] of FIVE) {
      expect(userDetailTab(key)).toBe(key);
      const markup = view({ tab: key });
      const selected = tabs(markup).filter(([tag]) =>
        tag.includes('aria-selected="true"'),
      );
      expect(selected, key).toHaveLength(1);
      expect(selected[0][0], key).toContain(`id="user-tab-${key}"`);
      expect(selected[0][0], key).toContain('tabindex="0"');
      expect(markup, key).toContain(
        `<div role="tabpanel" id="user-panel-${key}" aria-labelledby="user-tab-${key}" tabindex="0" class="stack">`,
      );
    }
    for (const value of [
      undefined,
      "",
      "groups",
      "access",
      "SECURITY",
      ["security"],
    ])
      expect(userDetailTab(value), String(value)).toBe("profile");
  });

  it("moves between the tabs with the arrow keys, Home and End", () => {
    const source = readFileSync(
      new URL("../src/components/settings/user-detail.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(
      /role="tablist"\s+aria-label="User details"\s+onKeyDown=\{tabKeys\}/,
    );
    // Five tab buttons, as the tablist renders them.
    const clicked: string[] = [];
    const doc = { activeElement: null as unknown };
    const buttons = USER_DETAIL_TABS.map((tab) => ({
      key: tab.key,
      focus() {
        doc.activeElement = this;
      },
      click() {
        clicked.push(tab.key);
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
      expect(press("ArrowRight", 4)).toBe(1);
      expect(press("ArrowLeft", 0)).toBe(1);
      expect(press("ArrowLeft", 3)).toBe(1);
      expect(press("Home", 3)).toBe(1);
      expect(press("Enter", 1)).toBe(0);
      expect(press("End", 1)).toBe(1);
      expect(clicked).toEqual([
        "teams",
        "profile",
        "activity",
        "authority",
        "profile",
        "activity",
      ]);
      expect(doc.activeElement).toBe(buttons[4]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows the profile as text, with Not recorded when no sign-in is stored", () => {
    const markup = panel(view());
    expect(markup).toContain("<h3>Profile</h3>");
    for (const [label, value] of [
      ["Name", "Fictional Subject"],
      ["Email", "subject@example.test"],
      ["Status", "Active"],
      ["Last sign-in", formatDate("2026-11-05T10:30:00.000Z", true)],
    ])
      expect(markup).toContain(
        `<dt class="muted">${label}</dt><dd style="margin:0">${value}</dd>`,
      );
    expect(markup).not.toMatch(/<input|<select|<button|<a /);
    expect(panel(view({}, { lastSignInAt: null }))).toContain(
      '<dt class="muted">Last sign-in</dt><dd style="margin:0">Not recorded</dd>',
    );
  });

  it("lists each team with the team role and the configured role or Team role only, read only", () => {
    const markup = panel(view({ tab: "teams" }));
    expect(markup).toContain("<h3>Teams &amp; roles</h3>");
    expect(
      [...markup.matchAll(/<th>([^<]+)<\/th>/g)].map((th) => th[1]),
    ).toEqual(["Team", "Team role", "Configured role"]);
    expect(markup).toContain(
      '<td data-label="Team">Fictional Alpha</td><td data-label="Team role">Recruiter</td><td data-label="Configured role">Fictional Sourcer</td>',
    );
    expect(markup).toContain(
      '<td data-label="Team">Fictional Bravo</td><td data-label="Team role">Viewer</td><td data-label="Configured role">Team role only</td>',
    );
    expect(markup).not.toMatch(/<input|<select|<button|<a |fictional-alpha/);
  });

  it("shows company authority read only, with the Roles & permissions link only to a company owner", () => {
    const owner = panel(view({ tab: "authority" }));
    expect(owner).toContain("<h3>Company authority</h3>");
    for (const [label, value] of [
      ["Level", "Company admin"],
      ["Areas", "People, Record fields"],
      ["Plan access", "Yes"],
      ["Since", formatDate("2026-10-01T08:00:00.000Z")],
    ])
      expect(owner).toContain(
        `<dt class="muted">${label}</dt><dd style="margin:0">${value}</dd>`,
      );
    expect(owner).toContain(
      '<p><a href="/app/admin/roles">Change on Roles &amp; permissions</a></p>',
    );
    expect(owner).not.toContain("Only a company owner");
    expect(owner).not.toContain("Suspended");
    const admin = panel(view({ tab: "authority", companyOwner: false }));
    expect(admin).toContain(
      '<p class="muted">Only a company owner can change company authority.</p>',
    );
    expect(admin).not.toMatch(/<a |Change on Roles/);
    expect(
      panel(
        view(
          { tab: "authority" },
          { authoritySuspended: true, planAccess: false },
        ),
      ),
    ).toMatch(
      /<span class="badge warning">Suspended<\/span>[\s\S]*<dd style="margin:0">No<\/dd>/,
    );
    expect(
      panel(
        view({ tab: "authority" }, { companyLevel: "owner", companyAreas: [] }),
      ),
    ).toContain(
      '<dt class="muted">Level</dt><dd style="margin:0">Company owner</dd></div><div><dt class="muted">Areas</dt><dd style="margin:0">All areas</dd>',
    );
    const none = panel(
      view(
        { tab: "authority", companyOwner: false },
        {
          companyLevel: null,
          companyAreas: null,
          planAccess: null,
          authoritySuspended: null,
          authoritySince: null,
        },
      ),
    );
    expect(none).toContain("<p>No company authority</p>");
    expect(none).not.toContain("<dl");
  });

  it("shows two-step and the signed-in device count, and Reset only when it is offered for someone else", () => {
    const markup = panel(view({ tab: "security" }));
    expect(markup).toContain("<h3>Security</h3>");
    expect(markup).toContain(
      '<dt class="muted">Two-step sign-in</dt><dd style="margin:0">On</dd>',
    );
    expect(markup).toContain(
      '<dt class="muted">Signed-in devices</dt><dd style="margin:0">2</dd>',
    );
    expect(markup).not.toContain("Reset two-step sign-in");
    expect(panel(view({ tab: "security", canReset: true }))).toContain(
      '<div class="row"><button type="button" class="button secondary">Reset two-step sign-in</button></div>',
    );
    expect(
      panel(view({ tab: "security", canReset: true, busy: true })),
    ).toContain(
      '<button type="button" class="button secondary" disabled="">Reset two-step sign-in</button>',
    );
    // Never on the caller's own page, whatever the caller's teams.
    expect(
      panel(
        view(
          { tab: "security", canReset: true },
          { userId: workspace.user.id },
        ),
      ),
    ).not.toContain("Reset two-step sign-in");
    expect(
      panel(view({ tab: "security" }, { twoStep: false, signedInDevices: 0 })),
    ).toContain(
      '<dd style="margin:0">Off</dd></div><div><dt class="muted">Signed-in devices</dt><dd style="margin:0">0</dd>',
    );
    // Today's outcome notices.
    expect(
      panel(view({ tab: "security", notice: "Fictional reset notice." })),
    ).toContain(
      '<div tabindex="-1" class="notice success" role="status">Fictional reset notice.</div>',
    );
    expect(
      panel(view({ tab: "security", error: "Only a team owner can do this." })),
    ).toContain(
      '<div tabindex="-1" class="notice error" role="alert">Only a team owner can do this.</div>',
    );
  });

  it("offers Reset only for someone else with two-step on in a team the caller owns", () => {
    const own = (
      slug: string,
      teamRole: AdminTeamRow["teamRole"],
      teamId: string | null = `${slug}-id`,
    ) => ({ slug, teamRole, teamId });
    const owned = [own("fictional-bravo", "owner")];
    expect(resetTeam(subject, workspace.user.id, owned)).toBe(
      "fictional-bravo-id",
    );
    // The first team the caller owns, in their list order.
    expect(
      resetTeam(subject, workspace.user.id, [
        own("fictional-alpha", "admin"),
        own("fictional-other", "owner"),
        own("fictional-alpha-2", "owner"),
        own("fictional-bravo", "owner"),
        own("fictional-alpha", "owner"),
      ]),
    ).toBe("fictional-bravo-id");
    // Self, two-step off, only admin of the shared team, owner of no shared team, not a member,
    // and teams not loaded yet.
    expect(
      resetTeam(
        { ...subject, userId: workspace.user.id },
        workspace.user.id,
        owned,
      ),
    ).toBeNull();
    expect(
      resetTeam({ ...subject, twoStep: false }, workspace.user.id, owned),
    ).toBeNull();
    expect(
      resetTeam(subject, workspace.user.id, [own("fictional-alpha", "admin")]),
    ).toBeNull();
    expect(
      resetTeam(subject, workspace.user.id, [own("fictional-other", "owner")]),
    ).toBeNull();
    expect(
      resetTeam(subject, workspace.user.id, [
        own("fictional-alpha", null, null),
      ]),
    ).toBeNull();
    expect(resetTeam(subject, workspace.user.id, null)).toBeNull();
  });

  it("confirms, posts the reset with that team's X-Team-Id, and retries once after Confirm it's you", async () => {
    const sent: {
      method: string;
      path: string;
      team: string | null;
      body: unknown;
    }[] = [];
    const answers: Response[] = [];
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const stale = () =>
      json(403, {
        error: {
          code: "SESSION_NOT_FRESH",
          message: "This change needs a recent sign-in.",
        },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init: RequestInit) => {
        sent.push({
          method: init.method ?? "GET",
          path,
          team: new Headers(init.headers).get("X-Team-Id"),
          body: JSON.parse(String(init.body)),
        });
        return answers.shift() ?? json(200, { data: { reset: true } });
      }),
    );
    try {
      const asked: string[] = [];
      const confirm = vi.fn(async (options: { message: string }) => {
        asked.push(options.message);
        return true;
      });
      const ask = vi.fn(async () => true);
      const fresh = <T,>(work: () => Promise<T>) =>
        retryWithFreshSession(work, ask);
      const post = {
        method: "POST",
        path: "/api/v1/teams/two-step-reset",
        team: "fictional-bravo-id",
        body: { userId: "fictional-subject" },
      };
      // Fresh: one request.
      await expect(
        resetTwoStep(subject, "fictional-bravo-id", confirm, fresh),
      ).resolves.toBe(true);
      expect(sent).toEqual([post]);
      expect(asked).toEqual([
        "Reset Fictional Subject's two-step sign-in? Their authenticator key and backup codes stop working, they are signed out everywhere and their trusted devices are forgotten. If their role requires it, they must set it up again at their next sign-in.",
      ]);
      expect(ask).not.toHaveBeenCalled();
      // Stale: the dialog opens once and the same request runs once more.
      sent.length = 0;
      answers.push(stale());
      await expect(
        resetTwoStep(subject, "fictional-bravo-id", confirm, fresh),
      ).resolves.toBe(true);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([post, post]);
      // Cancelled re-authentication: nothing more is sent and no notice follows.
      sent.length = 0;
      answers.push(stale());
      ask.mockResolvedValueOnce(false);
      await expect(
        resetTwoStep(subject, "fictional-bravo-id", confirm, fresh),
      ).resolves.toBe(false);
      expect(sent).toEqual([post]);
      // Cancelled confirmation: nothing is sent at all.
      sent.length = 0;
      const confirmed = vi.fn();
      await expect(
        resetTwoStep(
          subject,
          "fictional-bravo-id",
          async () => false,
          fresh,
          confirmed,
        ),
      ).resolves.toBe(false);
      expect(sent).toEqual([]);
      expect(confirmed).not.toHaveBeenCalled();
      // Any other refusal reaches the page as an error.
      answers.push(
        json(403, {
          error: {
            code: "member_in_other_team",
            message: "Fictional refusal.",
          },
        }),
      );
      await expect(
        resetTwoStep(subject, "fictional-bravo-id", confirm, fresh),
      ).rejects.toMatchObject({ status: 403, code: "member_in_other_team" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lists the activity in plain words with who made each change", () => {
    const markup = panel(view({ tab: "activity" }));
    expect(markup).toContain("<h3>Activity</h3>");
    expect(
      [...markup.matchAll(/<th>([^<]+)<\/th>/g)].map((th) => th[1]),
    ).toEqual(["When", "What", "Who"]);
    const rows = [...markup.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .slice(1)
      .map((row) =>
        [...row[1].matchAll(/<td data-label="([^"]+)">([^<]*)<\/td>/g)].map(
          (cell) => [cell[1], cell[2]],
        ),
      );
    const when = formatDate("2026-11-04T09:15:00.000Z", true);
    expect(rows).toEqual(
      [
        ["Two-step sign-in reset", "Not recorded"],
        ["Company authority changed", "Fictional Company Owner"],
        ["Home units changed", "Fictional Company Owner"],
        ["Configured role cleared", "Fictional Company Owner"],
        [
          "Configured role assigned: Fictional Sourcer",
          "Fictional Company Owner",
        ],
        ["Configured role assigned", "Fictional Company Owner"],
        ["Published · Workflow: fictional-flow", "This person"],
      ].map(([what, who]) => [
        ["When", when],
        ["What", what],
        ["Who", who],
      ]),
    );
    expect(
      eventLabel(
        event("config.draft_created", {
          objectType: "task-board",
          objectKey: "fictional-board",
        }),
      ),
    ).toBe("Draft created · Task board: fictional-board");
    expect(markup).not.toContain("Showing the latest 50 changes.");
    expect(panel(view({ tab: "activity" }, { events: [] }))).toContain(
      '<p class="muted">No configuration or access changes recorded.</p>',
    );
    const fifty = panel(
      view(
        { tab: "activity" },
        { events: Array.from({ length: 50 }, () => event("role.cleared")) },
      ),
    );
    expect(fifty.match(/<tr>/g)).toHaveLength(51);
    expect(fifty).toContain(
      '<p class="muted">Showing the latest 50 changes.</p>',
    );
  });

  it("shows no control of a later item on any tab", () => {
    const names = FIVE.flatMap(([key]) =>
      controls(
        view(
          { tab: key, canReset: true, companyOwner: true },
          { authoritySuspended: true },
        ),
      ),
    );
    expect(names).toEqual([
      "Change on Roles & permissions",
      "Reset two-step sign-in",
    ]);
    for (const name of [
      "Deactivate",
      "Suspend",
      "Sign out everywhere",
      "Clear lockout",
      "Anonymise",
      "Groups",
      "Effective access",
      "Bulk invite",
      "Save profile",
      "Resend",
    ])
      expect(
        names.some((item) => item.includes(name)),
        name,
      ).toBe(false);
    for (const later of ["Groups", "Effective access", "Sign out everywhere"])
      expect(content(view()), later).not.toContain(later);
  });

  it("shows the loading, no-access, not found and error states plainly", () => {
    const loading = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <UserDetailPortal
          userId="fictional-subject"
          companyLevel="owner"
          tab="profile"
        />
      </WorkspaceProvider>,
    );
    expect(loading).toContain("<h1>Admin portal</h1>");
    expect(loading).toContain('<p role="status">Loading this person…</p>');
    expect(loading).not.toContain(NO_ACCESS);
    const state = (status: number | null, error = "Fictional failure.") =>
      renderToStaticMarkup(<UserDetailRefusal status={status} error={error} />);
    expect(state(403)).toBe(
      `<section class="panel"><p>${NO_ACCESS}</p></section>`,
    );
    expect(USER_NOT_FOUND).toBe(
      "This person is not in any team of your company.",
    );
    expect(state(404)).toBe(
      '<section class="panel"><p>This person is not in any team of your company.</p></section>',
    );
    expect(state(500)).toBe(
      '<section class="panel"><p class="notice error" role="alert">Could not load this person. Fictional failure.</p></section>',
    );
    expect(state(null, "Connection interrupted.")).toContain(
      "Could not load this person. Connection interrupted.",
    );
  });
});

describe("invite to teams", () => {
  const row = (
    name: string,
    teamRole: AdminTeamRow["teamRole"],
    teamId: string | null = `fictional-${name.toLowerCase()}-id`,
  ): AdminTeamRow => ({
    teamId,
    name: `Fictional ${name}`,
    slug: `fictional-${name.toLowerCase()}`,
    createdAt: "2026-10-01T08:00:00.000Z",
    teamRole,
    current: false,
  });
  const rows = [
    row("Alpha", "owner"),
    row("Bravo", "admin"),
    row("Charlie", "recruiter"),
    row("Delta", "viewer"),
    row("Echo", null, null),
  ];
  const offered = inviteTeams(rows);
  const empty: InviteDraft = { email: "", teams: {} };
  const panel = (
    props: Partial<Parameters<typeof InviteToTeamsPanel>[0]> = {},
  ) =>
    renderToStaticMarkup(
      <InviteToTeamsPanel teams={offered} draft={empty} {...props} />,
    );
  type Call = { name: string; body: unknown };
  /** A fake Better Auth client: inviteMember fails for the named teams, as Better Auth refuses. */
  const fakeClient = (failing: string[] = []) => {
    const calls: Call[] = [];
    const client = {
      inviteMember: async (body: { organizationId: string }) => {
        calls.push({ name: "inviteMember", body });
        return failing.includes(body.organizationId)
          ? {
              data: null,
              error: {
                status: 403,
                message:
                  "You are not allowed to invite users to this organization",
              },
            }
          : { data: { id: "fictional-invitation" }, error: null };
      },
    } as unknown as TeamClient;
    return { client, calls };
  };

  it("offers only the teams where the caller is owner or admin, and Owner only where they are owner", () => {
    expect(offered).toEqual([
      {
        teamId: "fictional-alpha-id",
        name: "Fictional Alpha",
        teamRole: "owner",
      },
      {
        teamId: "fictional-bravo-id",
        name: "Fictional Bravo",
        teamRole: "admin",
      },
    ]);
    const markup = panel();
    expect(markup).toContain(
      '<section class="panel stack"><h2>Invite to teams</h2>',
    );
    expect(markup).toContain(
      '<label class="field"><span>Email address</span><input type="email" required="" maxLength="320" autoComplete="email" value=""/></label>',
    );
    expect(markup).toContain("<legend>Teams</legend>");
    for (const name of ["Charlie", "Delta", "Echo"])
      expect(markup).not.toContain(`Fictional ${name}`);
    const team = (name: string) =>
      new RegExp(
        `<label class="checkbox-label"><input type="checkbox"/>Fictional ${name}</label><label class="field"><span>Team role in Fictional ${name}</span><select>(.*?)</select><small class="muted">([^<]+)</small></label>`,
      ).exec(markup);
    const options = (match: RegExpExecArray | null) =>
      [
        ...(match?.[1] ?? "").matchAll(
          /<option value="([^"]+)"( selected="")?>([^<]+)<\/option>/g,
        ),
      ].map((option) => [option[1], option[3], !!option[2]]);
    const alpha = team("Alpha");
    expect(options(alpha)).toEqual([
      ["owner", "Owner", false],
      ["admin", "Admin", false],
      ["recruiter", "Recruiter", true],
      ["viewer", "Viewer", false],
    ]);
    expect(alpha?.[2]).toBe("Manage recruitment records and CVs");
    expect(options(team("Bravo"))).toEqual([
      ["admin", "Admin", false],
      ["recruiter", "Recruiter", true],
      ["viewer", "Viewer", false],
    ]);
    expect(markup).toContain(
      '<button type="submit" class="button">Send invitations</button>',
    );
    expect(panel({ busy: true })).toContain(
      '<button type="submit" class="button" disabled="">Sending invitations…</button>',
    );
    // The chosen role's hint follows the choice.
    expect(
      panel({
        draft: {
          email: "invitee@example.test",
          teams: { "fictional-alpha-id": { checked: true, role: "viewer" } },
        },
      }),
    ).toContain(
      '<input type="checkbox" checked=""/>Fictional Alpha</label><label class="field"><span>Team role in Fictional Alpha</span><select><option value="owner">Owner</option><option value="admin">Admin</option><option value="recruiter">Recruiter</option><option value="viewer" selected="">Viewer</option></select><small class="muted">Read-only recruitment access</small>',
    );
  });

  it("shows only the sentence when the caller owns or administers no team, and the loading and error states", () => {
    const none = renderToStaticMarkup(
      <InviteToTeamsPanel teams={inviteTeams(rows.slice(2))} draft={empty} />,
    );
    expect(NO_INVITE_TEAMS).toBe(
      "You can invite people only to teams where you are an owner or admin.",
    );
    expect(none).toBe(
      `<section class="panel stack"><h2>Invite to teams</h2><p>${NO_INVITE_TEAMS}</p></section>`,
    );
    expect(panel({ teams: null })).toContain(
      '<p role="status">Loading your teams…</p>',
    );
    const failed = panel({ teams: null, teamsError: "Fictional failure." });
    expect(failed).toContain(
      '<p class="notice error" role="alert">Could not load your teams. Fictional failure.</p>',
    );
    expect(failed).not.toContain("<form");
  });

  it("sends one ordinary invitation per chosen team, one at a time, and keeps a failed team chosen", async () => {
    const { client, calls } = fakeClient(["fictional-bravo-id"]);
    const onSent = vi.fn();
    const draft: InviteDraft = {
      email: " invitee@example.test ",
      teams: {
        "fictional-alpha-id": { checked: true, role: "admin" },
        "fictional-bravo-id": { checked: true, role: "viewer" },
      },
    };
    const result = await sendInvitations(draft, offered, { client, onSent });
    expect(calls).toEqual([
      {
        name: "inviteMember",
        body: {
          email: "invitee@example.test",
          role: "admin",
          organizationId: "fictional-alpha-id",
        },
      },
      {
        name: "inviteMember",
        body: {
          email: "invitee@example.test",
          role: "viewer",
          organizationId: "fictional-bravo-id",
        },
      },
    ]);
    // Exactly these three keys: no company level, area, plan access or configured role.
    for (const call of calls)
      expect(Object.keys(call.body as object).sort()).toEqual([
        "email",
        "organizationId",
        "role",
      ]);
    expect(result.error).toBe("");
    expect(result.outcomes).toEqual([
      {
        teamId: "fictional-alpha-id",
        team: "Fictional Alpha",
        sent: true,
        message: "",
      },
      {
        teamId: "fictional-bravo-id",
        team: "Fictional Bravo",
        sent: false,
        message: "You are not allowed to invite users to this organization",
      },
    ]);
    expect(result.draft).toEqual({
      email: " invitee@example.test ",
      teams: {
        "fictional-alpha-id": { checked: false, role: "admin" },
        "fictional-bravo-id": { checked: true, role: "viewer" },
      },
    });
    // The list reloads once after any success.
    expect(onSent).toHaveBeenCalledTimes(1);
    const markup = panel({ draft: result.draft, outcomes: result.outcomes });
    expect(markup).toContain(
      '<div tabindex="-1" class="notice error" role="alert"><p style="margin:0">Invitation sent to Fictional Alpha.</p><p style="margin:0">Not sent to Fictional Bravo: You are not allowed to invite users to this organization</p></div>',
    );
    expect(markup).toContain('value=" invitee@example.test "');
  });

  it("clears the email when every team was sent, reloads nothing when none was, and sends nothing with no team chosen", async () => {
    const all = fakeClient();
    const onSent = vi.fn();
    const sent = await sendInvitations(
      {
        email: "invitee@example.test",
        teams: { "fictional-bravo-id": { checked: true, role: "recruiter" } },
      },
      offered,
      { client: all.client, onSent },
    );
    expect(all.calls).toHaveLength(1);
    expect(sent.draft).toEqual({
      email: "",
      teams: { "fictional-bravo-id": { checked: false, role: "recruiter" } },
    });
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(panel({ outcomes: sent.outcomes })).toContain(
      '<div tabindex="-1" class="notice success" role="status"><p style="margin:0">Invitation sent to Fictional Bravo.</p></div>',
    );
    const refused = fakeClient(["fictional-alpha-id"]);
    const none = vi.fn();
    const failed = await sendInvitations(
      {
        email: "invitee@example.test",
        teams: { "fictional-alpha-id": { checked: true, role: "owner" } },
      },
      offered,
      { client: refused.client, onSent: none },
    );
    expect(failed.outcomes.map((item) => item.sent)).toEqual([false]);
    expect(failed.draft.email).toBe("invitee@example.test");
    expect(none).not.toHaveBeenCalled();
    // No team chosen: nothing is sent and the form says so.
    const idle = fakeClient();
    const nothing = vi.fn();
    const unchosen = await sendInvitations(
      {
        email: "invitee@example.test",
        teams: { "fictional-alpha-id": { checked: false, role: "admin" } },
      },
      offered,
      { client: idle.client, onSent: nothing },
    );
    expect(unchosen).toEqual({
      draft: {
        email: "invitee@example.test",
        teams: { "fictional-alpha-id": { checked: false, role: "admin" } },
      },
      outcomes: [],
      error: "Choose at least one team.",
    });
    expect(idle.calls).toEqual([]);
    expect(nothing).not.toHaveBeenCalled();
    expect(panel({ error: unchosen.error })).toContain(
      '<div tabindex="-1" class="notice error" role="alert">Choose at least one team.</div>',
    );
  });

  it("shows the panel under the Users list, and links named rows to their detail page only", () => {
    const markup = render("users", access("recruiter", "owner"));
    expect(markup).toMatch(
      /<h2>Users<\/h2>[\s\S]*<section class="panel stack"><h2>Invite to teams<\/h2><p role="status">Loading your teams…<\/p><\/section>/,
    );
    const list = renderToStaticMarkup(
      <UsersPanel
        rows={[
          {
            userId: "fictional user/1",
            name: "Fictional Linked",
            email: "linked@example.test",
            teams: [],
            companyLevel: null,
            status: "active",
            lastSignInAt: null,
            twoStep: false,
          },
          {
            userId: null,
            name: null,
            email: "invitee@example.test",
            teams: [],
            companyLevel: null,
            status: "invited",
            lastSignInAt: null,
            twoStep: false,
          },
        ]}
        error=""
        filtered={false}
        hasMore={false}
        filters={NO_USER_FILTERS}
        teams={[]}
        roles={[]}
      />,
    );
    expect(list).toContain(
      '<td data-label="Name"><a href="/app/admin/users/fictional%20user%2F1">Fictional Linked</a></td>',
    );
    expect(list).toContain('<td data-label="Name">Invited</td>');
    expect(list.match(/<a /g)).toHaveLength(1);
  });
});
