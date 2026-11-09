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
import {
  AuthorityFields,
  CompanyAuthorityPanel,
  RoleEditor,
  RoleTemplateView,
  RolesList,
  SCOPED_ROLES_LATER,
  roleKeyFor,
  saveRoleDraft,
} from "../src/components/settings/roles-tab";
import type { RoleBody } from "../src/domain/config";
import {
  ADMIN_ROLE,
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
  "Task boards",
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
  it("defines exactly the eight tabs that exist, in order", () => {
    expect(ADMIN_TABS.map((tab) => [tab.key, tab.label])).toEqual([
      ["members", "Members"],
      ["cv-storage", "CV storage"],
      ["speed", "Speed"],
      ["tokens", "API tokens"],
      ["roles", "Roles & permissions"],
      ["organisation", "Organisation"],
      ["directory", "Directory"],
      ["history", "History"],
    ]);
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
          ...(companyLevel === "owner" ? ["roles", "organisation"] : []),
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
  it("shows a company owner who is a team owner all seven tab links and nothing that does not exist yet", () => {
    const markup = render("members", access("owner", "owner"));
    expect(tabLinks(markup)).toEqual([
      ...TEAM_TABS,
      "roles",
      "organisation",
      "history",
    ]);
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
    expect(tabLinks(owner)).toEqual(["roles", "organisation", "history"]);
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

  it("shows the tab and both panels only to a company owner, and the no-access text to everyone else", () => {
    for (const teamRole of TEAM_ROLES)
      for (const companyLevel of COMPANY_LEVELS) {
        const markup = render("roles", access(teamRole, companyLevel));
        if (companyLevel === "owner") {
          expect(tabLinks(markup)).toContain("roles");
          expect(markup).toContain('<h2 tabindex="-1">Roles</h2>');
          expect(markup).toContain("<h2>Company authority</h2>");
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
    for (const template of [ADMIN_ROLE, RECRUITER_ROLE, VIEWER_ROLE]) {
      const markup = renderToStaticMarkup(
        <RoleTemplateView template={template} />,
      );
      expect(markup).toContain(">Copy to a new role</button>");
      expect(markup).not.toMatch(/<input|<select|<textarea/);
      expect(markup).not.toContain("cannot be edited or copied");
    }
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

  it("lists the four built-in templates without Hiring manager or Interviewer, with the scoped-roles note", () => {
    const markup = list([]);
    for (const name of ["Owner", "Admin", "Recruiter", "Viewer"])
      expect(markup).toContain(`>View ${name} template</button>`);
    expect(markup).not.toContain("Hiring manager");
    expect(markup).not.toContain("Interviewer");
    expect(markup).toContain(SCOPED_ROLES_LATER);
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

  it("shows each company role's state, the scoped mark and its actions", () => {
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
    expect(rows[2]).toContain("Published (version 1)");
    expect(rows[2]).toContain("Cannot be assigned yet");
    expect(rows[2]).toContain(">New draft</button>");
    expect(rows[2]).not.toContain("Edit draft");
    for (const row of rows.slice(0, 2))
      expect(row).not.toContain("Cannot be assigned yet");
  });

  it("derives a valid role key from the name", () => {
    expect(roleKeyFor("Copy of Recruiter")).toBe("copy-of-recruiter");
    expect(roleKeyFor("  Fictional -- Lead!  ")).toBe("fictional-lead");
    expect(roleKeyFor("x".repeat(80))).toHaveLength(63);
    expect(roleKeyFor("!!!")).toBe("");
  });

  it("edits pages with a screen, actions without plans or erase, field rules on system fields and All records only", () => {
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
      "Plan access is a per-person grant in Company authority, never part of a role.",
    );
    // Field rules: one labelled select per system field, with the four plain options.
    const candidates = fieldset(markup, "Field rules for Candidates");
    expect(candidates).toContain(
      "<span>Gender (explicitly stated)</span><select>",
    );
    for (const option of ["Default", "Hidden", "Read only", "Can edit"])
      expect(candidates).toContain(`>${option}</option>`);
    expect(markup).not.toContain("Hidden unless approver");
    // Record scope: each group offers only All records.
    const scope = fieldset(markup, "Record scope");
    expect(scope.match(/<select/g)).toHaveLength(3);
    expect(scope.match(/<option[^>]*>[^<]*<\/option>/g)).toEqual(
      Array(3).fill('<option value="all" selected="">All records</option>'),
    );
    expect(scope).toContain(
      "Roles limited to a unit or to assigned records arrive in a later release.",
    );
    // Membership is text, never a control.
    expect(markup).toContain("Membership: Recruiter.");
    expect(markup).not.toMatch(/<option[^>]*>(Owner|Admin|Viewer)<\/option>/);
  });

  it("shows a held hidden-unless-approver rule and a scoped draft's notice", () => {
    const markup = editor(
      copyOf(RECRUITER_ROLE.body as RoleBody, {
        fields: { offer: { amount: "hidden-unless-approver" } },
        recordScope: { pipeline: "unit", candidates: "unit", tasks: "unit" },
      }),
    );
    expect(fieldset(markup, "Field rules for Offers")).toContain(
      '<option value="hidden-unless-approver" selected="">Hidden unless approver</option>',
    );
    expect(markup).toContain("Saving sets every group to All records");
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
  };
  const suspended: CompanyAuthorityHolder = {
    userId: "fictional-suspended",
    name: "Fictional Suspended Admin",
    level: "admin",
    areas: ["fields", "organisation"],
    planAccess: false,
    suspended: true,
  };
  const admin: CompanyAuthorityHolder = {
    userId: "fictional-admin",
    name: "Fictional Company Admin",
    level: "admin",
    areas: [],
    planAccess: true,
    suspended: false,
  };
  const panel = (holders: CompanyAuthorityHolder[] | null) =>
    renderToStaticMarkup(
      <CompanyAuthorityPanel
        holders={holders}
        members={[{ userId: "fictional-member", name: "Fictional Member" }]}
        error=""
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
    expect(rows[0]).toContain('data-label="Plan access">Yes<');
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
    expect(rows[1]).toContain('data-label="Plan access">No<');
    expect(rows[1]).toContain("Suspended: left every team of this company");
    expect(rows[1]).toContain(">Restore authority</button>");
    expect(rows[1]).toMatch(
      /<button type="button" class="button secondary">Remove<\/button>/,
    );
    expect(rows[2]).toContain('data-label="Areas">No areas<');
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

  it("offers areas only for Company admin, plan access only with a level, and only the grantable areas", () => {
    const asAdmin = fields("admin");
    for (const label of [
      "Record fields",
      "Workflows",
      "Boards",
      "Organisation",
      "Templates",
    ])
      expect(asAdmin).toContain(`/>${label}</label>`);
    expect(asAdmin.match(/type="checkbox"/g)).toHaveLength(6);
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
    expect(asAdmin).toContain("Plan access");
    const asOwner = fields("owner");
    expect(asOwner).not.toContain("<legend>Areas</legend>");
    expect(asOwner.match(/type="checkbox"/g)).toHaveLength(1);
    expect(asOwner).toContain("Plan access");
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
