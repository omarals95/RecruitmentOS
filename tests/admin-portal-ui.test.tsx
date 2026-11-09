import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
}));

import { WorkspaceProvider } from "../src/components/workspace/client";
import {
  ADMIN_TABS,
  adminTabs,
  type AdminTabKey,
} from "../src/components/settings/admin-tabs";
import {
  AccessChangesPanel,
  AdminPortal,
  AdminPortalView,
  ConfigHistoryPanel,
  NO_ACCESS,
  type ConfigHistoryRow,
  type MeAccess,
} from "../src/components/settings/admin-portal";

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
const TEAM_TABS = ["members", "cv-storage", "speed", "tokens"];
const NOT_YET = [
  "Roles",
  "Task boards",
  "Organisation",
  "Fields",
  "Screens",
  "Workflows",
  "Boards",
  "Templates",
  "AI connections",
  "Plan",
];
const access = (
  teamRole: string,
  companyLevel: MeAccess["companyLevel"],
): MeAccess => ({
  teamRole,
  companyLevel,
  role: { name: "Fictional role", membership: "recruiter" },
  scopes: [],
  pages: [],
  actions: {},
  fields: {},
  adminAreas: [],
});
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
const tabLinks = (markup: string) =>
  [
    ...markup.matchAll(/<nav class="settings-nav"[^>]*>([\s\S]*?)<\/nav>/g),
  ].flatMap((nav) =>
    [...nav[1].matchAll(/href="\/app\/admin\/([^"]+)"/g)].map(
      (link) => link[1],
    ),
  );
const onlyHeadingAndNoAccess = (markup: string) => {
  expect(markup).toContain("<h1>Admin portal</h1>");
  expect(markup).toContain(`<p>${NO_ACCESS}</p>`);
  expect(markup).not.toContain("settings-nav");
  expect(markup).not.toMatch(/<h2|<table|role="status"/);
};

describe("admin portal tabs", () => {
  it("defines exactly the five tabs that exist, in order", () => {
    expect(ADMIN_TABS.map((tab) => [tab.key, tab.label])).toEqual([
      ["members", "Members"],
      ["cv-storage", "CV storage"],
      ["speed", "Speed"],
      ["tokens", "API tokens"],
      ["history", "History"],
    ]);
    for (const file of [
      "../src/components/settings/admin-tabs.ts",
      "../src/components/settings/admin-portal.tsx",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/roles|Roles & permissions/);
    }
  });

  it("gives team tabs from the team role and History from company authority only", () => {
    for (const teamRole of TEAM_ROLES)
      for (const companyLevel of COMPANY_LEVELS) {
        const keys = adminTabs({ teamRole, companyLevel }).map(
          (tab) => tab.key,
        );
        const team = teamRole === "owner" || teamRole === "admin";
        expect(keys, `${teamRole} / ${companyLevel}`).toEqual([
          ...(team ? TEAM_TABS : []),
          ...(companyLevel ? ["history"] : []),
        ]);
      }
    expect(adminTabs({ teamRole: null, companyLevel: null })).toEqual([]);
    expect(
      adminTabs({ teamRole: "superuser", companyLevel: "member" }),
    ).toEqual([]);
  });
});

describe("admin portal", () => {
  it("shows a company owner who is a team owner all five tab links and nothing that does not exist yet", () => {
    const markup = render("members", access("owner", "owner"));
    expect(tabLinks(markup)).toEqual([...TEAM_TABS, "history"]);
    const current = [...markup.matchAll(/<a [^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => tag.includes('aria-current="page"'));
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/app/admin/members"');
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
          tabs[0]?.key ?? "members",
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

  it("links each team tab to its existing settings page", () => {
    for (const [tab, href, title] of [
      ["members", "/app/settings/team", "Members"],
      ["cv-storage", "/app/settings/team#cv-storage", "CV storage"],
      ["speed", "/app/settings/speed", "Speed"],
      ["tokens", "/app/settings/api-tokens", "API tokens"],
    ] as const) {
      const markup = render(tab, access("admin", null));
      expect(markup).toContain(`<h2>${title}</h2>`);
      expect(markup).toContain(`class="button" href="${href}"`);
      expect(markup).not.toContain("<table");
    }
  });

  it("shows only the heading and the no-access text for a 403, no tabs and a tab outside the caller's", () => {
    onlyHeadingAndNoAccess(render("members", null, { denied: true }));
    onlyHeadingAndNoAccess(render(null, null, { denied: true }));
    onlyHeadingAndNoAccess(render(null, access("recruiter", null)));
    onlyHeadingAndNoAccess(render("history", access("viewer", null)));
    onlyHeadingAndNoAccess(render("members", access("recruiter", "owner")));
    onlyHeadingAndNoAccess(render("speed", access("viewer", "admin")));
    // A team owner without company authority asks for History.
    onlyHeadingAndNoAccess(render("history", access("owner", null)));
  });

  it("shows loading and other errors plainly, never a blank page", () => {
    const loading = render("members", null);
    expect(loading).toContain('<p role="status">Loading…</p>');
    expect(loading).not.toContain(NO_ACCESS);
    const failed = render("members", null, {
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
        <AdminPortal tab="members" />
      </WorkspaceProvider>,
    );
    onlyHeadingAndNoAccess(noTeam);
  });

  it("shows the access changes panel in History only for a company owner", () => {
    const owner = render("history", access("recruiter", "owner"));
    expect(tabLinks(owner)).toEqual(["history"]);
    expect(owner).toContain("<h2>Configuration history</h2>");
    expect(owner).toContain("<h2>Recent access changes (last 7 days)</h2>");
    const admin = render("history", access("owner", "admin"));
    expect(admin).toContain("<h2>Configuration history</h2>");
    expect(admin).not.toContain("Recent access changes");
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
