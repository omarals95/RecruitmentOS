import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TeamScope,
  WorkspaceProvider,
} from "../src/components/workspace/client";
import { SettingsNavigation } from "../src/components/settings/settings-navigation";
import {
  deviceListMessage,
  ProfileSettings,
  TwoStepPanel,
} from "../src/components/settings/profile-settings";
import { TeamSettings } from "../src/components/settings/team-settings";
import {
  canAssignRoles,
  canResetTwoStep,
  ConfiguredRolesNotice,
  MemberActions,
  MemberRoleControl,
} from "../src/components/settings/team-members";
import { TokenSettings } from "../src/components/settings/token-settings";
import {
  formatStorageBytes,
  parseStorageAmount,
  StorageSettings,
  StorageSettingsForm,
  type StorageSettingsData,
} from "../src/components/settings/storage-settings";
import {
  SpeedPanel,
  SpeedSettings,
  SpeedTab,
} from "../src/components/settings/speed-settings";
import { AboutSettings } from "../src/components/settings/about-settings";
import { rules } from "./helpers/css";

const workspace = {
  user: {
    id: "fictional-user",
    name: "Fictional Settings User",
    email: "settings-user@example.test",
    twoStepEnabled: true,
  },
  team: { id: "fictional-team", name: "Fictional Team", slug: "fictional" },
  role: "owner",
  environment: "Local development",
  canCreateTeam: true,
};

describe("settings navigation", () => {
  const links = (markup: string) =>
    [...markup.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(
      (match) => [match[1], match[2]],
    );
  it("marks one current tab with the primary button style", () => {
    const markup = renderToStaticMarkup(
      <SettingsNavigation active="api-tokens" adminPortal={false} />,
    );
    const current = [...markup.matchAll(/<a [^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => tag.includes('aria-current="page"'));
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/app/settings/api-tokens"');
    expect(current[0]).not.toMatch(/class="[^"]*secondary/);
  });
  // ADM-04 (job 075): Team & access and Speed left personal settings.
  it("lists only My profile, API tokens and About, in that order", () => {
    for (const active of ["profile", "api-tokens", "about", undefined] as const)
      expect(
        links(
          renderToStaticMarkup(
            <SettingsNavigation active={active} adminPortal={false} />,
          ),
        ),
        String(active),
      ).toEqual([
        ["/app/settings/profile", "My profile"],
        ["/app/settings/api-tokens", "API tokens"],
        ["/app/settings/about", "About"],
      ]);
  });
  it("marks no section on the Team & access and Speed pages", () => {
    for (const [name, page] of [
      ["Team & access", <TeamSettings key="team" />],
      ["Speed", <SpeedSettings key="speed" />],
    ] as const) {
      const markup = renderToStaticMarkup(
        <WorkspaceProvider value={{ ...workspace, role: "recruiter" }}>
          {page}
        </WorkspaceProvider>,
      );
      expect(markup, name).toContain('aria-label="Settings sections"');
      expect(markup, name).not.toContain('aria-current="page"');
      expect(markup, name).not.toMatch(/href="\/app\/settings\/(team|speed)"/);
    }
  });
  it("gives the current tab primary colours and no surface override", () => {
    const all = [
      ...rules("src/app/globals.css"),
      ...rules("src/styles/settings.css"),
    ];
    const navLinks = all.filter((rule) =>
      rule.selector
        .split(",")
        .some((part) => /\.settings-nav a\b/.test(part.trim())),
    );
    const current = navLinks.find((rule) =>
      rule.selector.includes('.settings-nav a[aria-current="page"]'),
    );
    expect(current?.body).toMatch(/background:\s*var\(--primary\)/);
    for (const rule of navLinks)
      if (!/aria-current|:not\(/.test(rule.selector))
        expect(rule.body).not.toMatch(/\b(background|border)\s*:/);
  });
});

describe("profile devices", () => {
  it("does not load devices on page load", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <ProfileSettings providers={{ google: false, microsoft: false }} />
      </WorkspaceProvider>,
    );
    expect(markup).toContain("Show signed-in devices");
    expect(markup).not.toContain("Loading devices");
    expect(markup).toContain("Sign out all other devices");
    expect(markup).not.toContain('role="alert"');
  });
  it("explains a stale session calmly and leaves other errors alone", () => {
    expect(deviceListMessage({ code: "SESSION_NOT_FRESH", status: 403 })).toBe(
      "For your security, the device list needs a recent sign-in. Sign out and sign in again to view your devices.",
    );
    expect(deviceListMessage({ code: "UNAUTHORIZED" })).toBeNull();
    expect(deviceListMessage(null)).toBeNull();
  });
  it("never lists sessions from an effect", () => {
    const source = readFileSync(
      new URL(
        "../src/components/settings/profile-settings.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).not.toContain("useEffect");
  });
});

describe("CV storage settings", () => {
  it("converts MB and GB to decimal bytes with at most 3 decimal places", () => {
    expect(parseStorageAmount("1.5", "GB")).toBe(1_500_000_000);
    expect(parseStorageAmount("250", "MB")).toBe(250_000_000);
    expect(parseStorageAmount(" 0.5 ", "GB")).toBe(500_000_000);
    expect(parseStorageAmount("1.001", "MB")).toBe(1_001_000);
    expect(parseStorageAmount("1", "MB")).toBe(1_000_000);
    expect(parseStorageAmount("10000", "GB")).toBe(10_000_000_000_000);
    for (const value of ["1.2345", "-1", "-0.5", "abc", "", "1e3", "1,5"])
      expect(() => parseStorageAmount(value, "GB"), value).toThrow(
        "Enter the maximum storage as a positive number with at most 3 decimal places.",
      );
    for (const [value, unit] of [
      ["0", "MB"],
      ["0.999", "MB"],
      ["10000.001", "GB"],
      ["20000", "GB"],
    ] as const)
      expect(() => parseStorageAmount(value, unit), value).toThrow(
        "Maximum storage must be between 1 MB and 10,000 GB.",
      );
  });

  it("formats bytes in decimal units", () => {
    expect(formatStorageBytes(0)).toBe("0 MB");
    expect(formatStorageBytes(1000)).toBe("0.001 MB");
    expect(formatStorageBytes(250_000_000)).toBe("250 MB");
    expect(formatStorageBytes(1_000_000_000)).toBe("1 GB");
    expect(formatStorageBytes(1_500_000_000)).toBe("1.5 GB");
    expect(formatStorageBytes(10_000_000_000_000)).toBe("10,000 GB");
  });

  it("shows the CV storage panel on the team detail tab, for the page's team", () => {
    const sentence = "These are application limits, not hard provider caps.";
    const markup = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <TeamScope teamId="fictional-other-team">
          <StorageSettings busy="" onAction={async () => {}} />
        </TeamScope>
      </WorkspaceProvider>,
    );
    expect(markup).toContain('<section class="panel" id="cv-storage">');
    expect(markup).toContain("CV storage</h2>");
    expect(markup).toContain(sentence);
    expect(markup).toContain(
      '<p role="status">Loading CV storage settings…</p>',
    );
  });

  // ADM-04 (job 075): rename, Prepare task board and CV storage live on team detail now.
  it("shows Team & access without CV storage, rename or Prepare task board for every role", () => {
    for (const value of [
      ...["owner", "admin", "recruiter", "viewer"].map((role) => ({
        ...workspace,
        role,
      })),
      { ...workspace, team: null, role: null },
    ]) {
      const markup = renderToStaticMarkup(
        <WorkspaceProvider value={value}>
          <TeamSettings />
        </WorkspaceProvider>,
      );
      const label = String(value.role);
      expect(markup, label).toContain("<h1>Team &amp; access</h1>");
      expect(markup, label).toContain("<h2>Your teams</h2>");
      expect(markup, label).not.toContain("CV storage");
      expect(markup, label).not.toContain("application limits");
      expect(markup, label).not.toContain('value="Fictional Team"');
      expect(markup, label).not.toContain("Save team name");
      expect(markup, label).not.toContain("Prepare task board");
      if (value.team) {
        expect(markup, label).toContain("<h2>Fictional Team</h2>");
        expect(markup, label).toContain(
          "You can view team membership. An owner or admin can change access and invitations.",
        );
        expect(markup, label).toContain("<h2>Members</h2>");
      } else expect(markup, label).not.toContain("<h2>Members</h2>");
    }
  });

  it("shows the Create a team panel only when the user may create a team", () => {
    for (const canCreateTeam of [true, false]) {
      const markup = renderToStaticMarkup(
        <WorkspaceProvider value={{ ...workspace, canCreateTeam }}>
          <TeamSettings />
        </WorkspaceProvider>,
      );
      expect(markup.includes("Create a team</h2>"), String(canCreateTeam)).toBe(
        canCreateTeam,
      );
      expect(markup.includes(">Create team</button>")).toBe(canCreateTeam);
    }
  });

  const usage = {
    usedBytes: 600_000_000,
    usedFiles: 3,
    reservedBytes: 1_000_000,
    reservedFiles: 1,
    retainedBytes: 2_000_000,
    retainedFiles: 1,
  };
  const form = (settings: StorageSettingsData) =>
    renderToStaticMarkup(
      <StorageSettingsForm
        settings={settings}
        busy={false}
        onSave={() => {}}
      />,
    );
  const belowNotice =
    "This limit is below the team&#x27;s current usage. Existing CVs stay available, but new CV uploads will be refused until usage is below the limit.";
  it("shows usage, both limit toggles and Save, and warns when a limit is below usage", () => {
    const unlimited = form({
      maxBytes: null,
      maxFiles: null,
      uploadRequestsPerMinute: null,
      mcpCvTextEnabled: true,
      usage,
    });
    for (const text of [
      "Current usage",
      "3 files, 600 MB",
      "1 file, 1 MB",
      "1 file, 2 MB",
      "Limit this team&#x27;s CV storage",
      "Limit CV upload requests",
      ">Save</button>",
    ])
      expect(unlimited).toContain(text);
    expect(unlimited).not.toContain("Maximum storage");
    expect(unlimited).not.toContain("Requests per minute");
    expect(unlimited).not.toContain(belowNotice);
    // Unchanged settings cannot be saved.
    expect(unlimited).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
    const below = form({
      maxBytes: 500_000_000,
      maxFiles: 100,
      uploadRequestsPerMinute: 10,
      mcpCvTextEnabled: true,
      usage,
    });
    expect(below).toContain("Maximum storage");
    expect(below).toContain('value="0.5"');
    expect(below).toContain("Maximum CV files");
    expect(below).toContain('value="100"');
    expect(below).toContain("Requests per minute");
    expect(below).toContain(belowNotice);
    expect(
      form({
        maxBytes: 1_000_000_000,
        maxFiles: 4,
        uploadRequestsPerMinute: null,
        mcpCvTextEnabled: true,
        usage,
      }),
    ).toContain(belowNotice);
    expect(
      form({
        maxBytes: 1_000_000_000,
        maxFiles: 5,
        uploadRequestsPerMinute: null,
        mcpCvTextEnabled: true,
        usage,
      }),
    ).not.toContain(belowNotice);
  });

  it("shows the CV contents checkbox, checked by the saved setting, with its hint", () => {
    const settings = {
      maxBytes: null,
      maxFiles: null,
      uploadRequestsPerMinute: null,
      usage,
    };
    const checkbox = (markup: string) =>
      /<input type="checkbox"([^>]*)\/>\s*Connected AI apps can read CV contents<\/label>/.exec(
        markup,
      )?.[1];
    const on = form({ ...settings, mcpCvTextEnabled: true });
    expect(checkbox(on)).toContain('checked=""');
    expect(checkbox(on)).toContain('aria-describedby="storage-cv-text-hint"');
    expect(on).toContain(
      "Apps connected through MCP with CV permission can read the text of this team&#x27;s CVs. Each read is recorded in Activity.",
    );
    const off = form({ ...settings, mcpCvTextEnabled: false });
    expect(checkbox(off)).toBeDefined();
    expect(checkbox(off)).not.toContain("checked");
  });
});

describe("speed settings", () => {
  it("lists no Speed in the settings navigation, whatever the Admin portal link", () => {
    for (const adminPortal of [true, false])
      expect(
        renderToStaticMarkup(
          <SettingsNavigation active="profile" adminPortal={adminPortal} />,
        ),
      ).not.toContain('href="/app/settings/speed"');
  });
  // Owners and admins of the current team are redirected to the team detail Speed tab.
  it("tells recruiters, viewers and people with no team who open the page that only owners and admins can view it", () => {
    for (const value of [
      { ...workspace, role: "recruiter" },
      { ...workspace, role: "viewer" },
      { ...workspace, team: null, role: null },
    ]) {
      const markup = renderToStaticMarkup(
        <WorkspaceProvider value={value}>
          <SpeedSettings />
        </WorkspaceProvider>,
      );
      expect(markup).toContain("<h1>Speed</h1>");
      expect(markup).toContain(
        '<p class="notice" role="status">Only team owners and admins can view speed timings.</p>',
      );
      expect(markup).not.toMatch(/<input|<select|<table|<button/);
    }
  });
  it("shows the Speed tab's panel, for the page's team, while its timings load", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <TeamScope teamId="fictional-other-team">
          <SpeedTab />
        </TeamScope>
      </WorkspaceProvider>,
    );
    expect(markup).toContain('<section class="panel stack"><h2>Speed</h2>');
    expect(markup).toContain('<p role="status">Loading speed timings…</p>');
  });
  it("shows typical and slow times with sample counts, db times for routes and what is kept", () => {
    const markup = renderToStaticMarkup(
      <SpeedPanel
        error=""
        rows={[
          {
            kind: "action",
            name: "task.move",
            samples: 5,
            medianMs: 300,
            p95Ms: 480,
          },
          {
            kind: "route",
            name: "GET /api/v1/tasks",
            samples: 4,
            medianMs: 20,
            p95Ms: 30,
            medianDbMs: 3,
            p95DbMs: null,
          },
        ]}
      />,
    );
    for (const text of [
      "last 30 days of timings and route names only",
      "no names, ids or content",
      "task.move",
      "300 ms",
      "480 ms",
      "GET /api/v1/tasks",
      "Typical database",
      "3 ms",
      "Not reported",
    ])
      expect(markup).toContain(text);
    expect(markup).not.toMatch(/<input|<select|<button/);
    expect(renderToStaticMarkup(<SpeedPanel error="" rows={[]} />)).toContain(
      "No timings have been recorded yet.",
    );
  });
  it("keeps action and route names on one line inside the scrolling table area", () => {
    const markup = renderToStaticMarkup(
      <SpeedPanel
        error=""
        rows={[
          {
            kind: "route",
            name: "PATCH /api/v1/task-workflow-items/[id]",
            samples: 1,
            medianMs: 20,
            p95Ms: 30,
          },
        ]}
      />,
    );
    expect(markup).toMatch(
      /<div class="table-wrap"><table class="data-table speed-table">/,
    );
    const names = rules("src/styles/settings.css").find(
      (rule) => rule.selector === ".settings-page .speed-table code",
    );
    expect(names?.body).toMatch(/white-space:\s*nowrap/);
    expect(names?.body).toMatch(/overflow-wrap:\s*normal/);
  });
});

describe("admin portal link", () => {
  // The rule over every team role and company level is in tests/admin-portal-ui.test.tsx.
  it("lists the Admin portal after the sections when the caller can open an admin page, never as current", () => {
    for (const adminPortal of [true, false]) {
      const markup = renderToStaticMarkup(
        <SettingsNavigation active="about" adminPortal={adminPortal} />,
      );
      const link = /<a [^>]*href="\/app\/admin"[^>]*>Admin portal<\/a>/.exec(
        markup,
      );
      expect(!!link, String(adminPortal)).toBe(adminPortal);
      if (!link) continue;
      expect(link[0]).not.toContain("aria-current");
      expect(link[0]).toMatch(/class="button secondary"/);
      expect(markup.indexOf("Admin portal")).toBeGreaterThan(
        markup.indexOf('href="/app/settings/about"'),
      );
    }
  });
  it("hides the link while the access loads, for every team role", () => {
    for (const role of ["owner", "admin", "recruiter", "viewer"])
      for (const page of [
        <AboutSettings key="about" />,
        <TokenSettings key="tokens" />,
        <ProfileSettings
          key="profile"
          providers={{ google: false, microsoft: false }}
        />,
      ])
        expect(
          renderToStaticMarkup(
            <WorkspaceProvider value={{ ...workspace, role }}>
              {page}
            </WorkspaceProvider>,
          ),
          role,
        ).not.toContain('href="/app/admin"');
  });
});

describe("about settings", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("shows version, build, commit, environment and UTC build time with Copy details to any member", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "1.0.0");
    vi.stubEnv("NEXT_PUBLIC_APP_BUILD", "20261108.1430");
    vi.stubEnv("NEXT_PUBLIC_APP_COMMIT", "f09caa4");
    vi.stubEnv("NEXT_PUBLIC_APP_ENVIRONMENT", "Preview");
    vi.stubEnv("NEXT_PUBLIC_APP_BUILT_AT", "2026-11-08T14:30:59.000Z");
    for (const value of [
      workspace,
      { ...workspace, role: "viewer" },
      { ...workspace, team: null, role: null },
    ]) {
      const markup = renderToStaticMarkup(
        <WorkspaceProvider value={value}>
          <AboutSettings />
        </WorkspaceProvider>,
      );
      expect(markup).toContain("<h1>About</h1>");
      expect(markup).toMatch(
        /<a [^>]*aria-current="page" href="\/app\/settings\/about"/,
      );
      for (const [label, text] of [
        ["Version", "1.0.0"],
        ["Build", "20261108.1430"],
        ["Commit", "f09caa4"],
        ["Environment", "Preview"],
        ["Build time", "2026-11-08 14:30 UTC"],
      ])
        expect(markup).toContain(`<dt>${label}</dt><dd>${text}</dd>`);
      expect(markup).toMatch(
        /<button type="button"[^>]*>Copy details<\/button>/,
      );
    }
  });
});

describe("two-step sign-in in settings", () => {
  it("shows Off with a Turn on link, or On with new backup codes and Turn off", () => {
    const off = renderToStaticMarkup(
      <TwoStepPanel enabled={false} required={false} />,
    );
    expect(off).toContain("Two-step sign-in");
    expect(off).toContain("<strong>Off</strong>");
    expect(off).toMatch(
      /<a[^>]*href="\/two-step-setup\?next=\/app\/settings\/profile"[^>]*>Turn on<\/a>/,
    );
    expect(off).not.toContain("Turn off");
    const on = renderToStaticMarkup(<TwoStepPanel enabled required />);
    expect(on).toContain("<strong>On</strong>");
    expect(on).toContain(">Create new backup codes</button>");
    expect(on).toContain(">Turn off</button>");
    expect(on).toContain('autoComplete="current-password"');
    // One field serves both actions, so its label names both.
    expect(on).toMatch(
      /<label class="field"><span>Password to create new backup codes or turn off two-step sign-in<\/span><input[^>]*type="password"/,
    );
    expect(on).not.toContain("Confirm with your password");
    expect(on).not.toContain(">Turn on</a>");
    const page = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <ProfileSettings providers={{ google: false, microsoft: false }} />
      </WorkspaceProvider>,
    );
    expect(page).toContain("<strong>On</strong>");
  });

  it("replaces the token form with the two-step notice and keeps the token list", () => {
    const without = renderToStaticMarkup(
      <WorkspaceProvider
        value={{
          ...workspace,
          user: { ...workspace.user, twoStepEnabled: false },
        }}
      >
        <TokenSettings />
      </WorkspaceProvider>,
    );
    expect(without).toContain(
      "Turn on two-step sign-in in your profile before creating API tokens or connecting apps.",
    );
    expect(without).toMatch(
      /<a[^>]*href="\/two-step-setup\?next=\/app\/settings\/api-tokens"[^>]*>Turn on two-step sign-in<\/a>/,
    );
    expect(without).not.toContain("Token name");
    expect(without).not.toContain(">Create token</button>");
    expect(without).toContain("My tokens");
    const withTwoStep = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <TokenSettings />
      </WorkspaceProvider>,
    );
    expect(withTwoStep).toContain("Token name");
    expect(withTwoStep).not.toContain("Turn on two-step sign-in</a>");
  });

  it("offers Reset two-step sign-in only to owners and never on their own row", () => {
    expect(canResetTwoStep("owner", "other", "me")).toBe(true);
    expect(canResetTwoStep("owner", "me", "me")).toBe(false);
    for (const role of ["admin", "recruiter", "viewer", null])
      expect(canResetTwoStep(role, "other", "me"), String(role)).toBe(false);
    const actions = (canEdit: boolean, canReset: boolean) =>
      renderToStaticMarkup(
        <MemberActions
          canEdit={canEdit}
          canResetTwoStep={canReset}
          busy={false}
          saveDisabled={false}
          removeDisabled={false}
          onSave={() => {}}
          onRemove={() => {}}
          onResetTwoStep={() => {}}
        />,
      );
    expect(actions(true, true)).toContain(">Reset two-step sign-in</button>");
    expect(actions(true, false)).not.toContain("Reset two-step sign-in");
    expect(actions(true, false)).toContain(">Save role</button>");
    expect(actions(false, false)).toBe("");
  });
});

// R2a-12 (job 056): the configured-role control in Team & access, company owners only.
describe("configured role control", () => {
  const roles = [
    {
      roleObjectId: "fictional-role-1",
      name: "Fictional sourcing recruiter",
      membership: "recruiter" as const,
    },
    {
      roleObjectId: "fictional-role-2",
      name: "Fictional reader",
      membership: "viewer" as const,
    },
  ];
  const control = (
    assignment: {
      roleObjectId: string;
      roleName: string | null;
      available: boolean;
    } | null,
    teamOwner = false,
  ) =>
    renderToStaticMarkup(
      <MemberRoleControl
        name="Fictional Member"
        teamOwner={teamOwner}
        assignment={assignment && { userId: "fictional-member", ...assignment }}
        roles={roles}
        busy={false}
        onSave={() => {}}
      />,
    );

  it("offers the control only to a company owner, never from the team role", () => {
    expect(canAssignRoles("owner")).toBe(true);
    for (const level of ["admin", null, undefined, "member"])
      expect(canAssignRoles(level), String(level)).toBe(false);
    // Before the access is known nothing is shown, whatever the team role.
    for (const role of ["owner", "admin", "recruiter", "viewer"]) {
      const markup = renderToStaticMarkup(
        <WorkspaceProvider value={{ ...workspace, role }}>
          <TeamSettings />
        </WorkspaceProvider>,
      );
      expect(markup, role).not.toContain("Configured role");
      expect(markup, role).not.toContain("Save configured role");
    }
  });

  it("lists the assignable roles with a labelled select and Save configured role", () => {
    const none = control(null);
    expect(none).toContain(
      '<span class="sr-only">Configured role for Fictional Member</span><select>',
    );
    expect(none).toContain(
      '<option value="" selected="">Team role only (no configured role)</option>',
    );
    expect(none).toContain(
      '<option value="fictional-role-1">Fictional sourcing recruiter (recruiter)</option>',
    );
    expect(none).toContain(
      '<option value="fictional-role-2">Fictional reader (viewer)</option>',
    );
    expect(none).toMatch(
      /<button type="button" class="button secondary" disabled="">Save configured role<\/button>/,
    );
    expect(none).not.toContain("Clear role");
    expect(none).not.toContain("Role no longer available");
    const assigned = control({
      roleObjectId: "fictional-role-2",
      roleName: "Fictional reader",
      available: true,
    });
    expect(assigned).toContain(
      '<option value="fictional-role-2" selected="">Fictional reader (viewer)</option>',
    );
    expect(assigned).toContain(">Clear role</button>");
    expect(assigned).not.toContain("Role no longer available");
  });

  it("names a role that is no longer available, with reassign and Clear role", () => {
    const markup = control({
      roleObjectId: "fictional-archived-role",
      roleName: "Fictional archived role",
      available: false,
    });
    expect(markup).toContain(
      "Role no longer available: Fictional archived role",
    );
    expect(markup).not.toContain('value="fictional-archived-role"');
    expect(markup).toContain(
      '<option value="" selected="">Team role only (no configured role)</option>',
    );
    expect(markup).toContain(
      '<option value="fictional-role-1">Fictional sourcing recruiter (recruiter)</option>',
    );
    expect(markup).toMatch(
      /<button type="button" class="button secondary">Clear role<\/button>/,
    );
    expect(
      control({
        roleObjectId: "fictional-archived-role",
        roleName: null,
        available: false,
      }),
    ).toContain(">Role no longer available</span>");
  });

  it("shows no control on a team owner's row", () => {
    const markup = control(null, true);
    expect(markup).toBe(
      '<span class="muted">Team owners keep the Owner role</span>',
    );
    expect(markup).not.toMatch(/<select|<button/);
  });

  // R2a-18 (job 060): roles limited to a unit or to assigned records are offered like any other.
  it("offers hiring manager and interviewer roles in the select", () => {
    const markup = renderToStaticMarkup(
      <MemberRoleControl
        name="Fictional Member"
        teamOwner={false}
        assignment={null}
        roles={[
          {
            roleObjectId: "fictional-role-hm",
            name: "Fictional hiring manager",
            membership: "recruiter",
          },
          {
            roleObjectId: "fictional-role-int",
            name: "Fictional interviewer",
            membership: "viewer",
          },
        ]}
        busy={false}
        onSave={() => {}}
      />,
    );
    expect(markup).toContain(
      '<option value="fictional-role-hm">Fictional hiring manager (recruiter)</option>',
    );
    expect(markup).toContain(
      '<option value="fictional-role-int">Fictional interviewer (viewer)</option>',
    );
  });

  // R2a-18 (job 060): every role can be assigned, so the notice only reports a load error.
  it("shows only a load error above the members table", () => {
    expect(renderToStaticMarkup(<ConfiguredRolesNotice error="" />)).toBe("");
    expect(
      renderToStaticMarkup(
        <ConfiguredRolesNotice error="Only a company owner can assign roles." />,
      ),
    ).toContain('role="alert"');
  });
});
