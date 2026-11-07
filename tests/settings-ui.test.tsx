import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceProvider } from "../src/components/workspace/client";
import { SettingsNavigation } from "../src/components/settings/settings-navigation";
import {
  deviceListMessage,
  ProfileSettings,
} from "../src/components/settings/profile-settings";
import { TeamSettings } from "../src/components/settings/team-settings";
import {
  formatStorageBytes,
  parseStorageAmount,
  StorageSettingsForm,
  type StorageSettingsData,
} from "../src/components/settings/storage-settings";
import {
  SpeedPanel,
  SpeedSettings,
} from "../src/components/settings/speed-settings";
import { rules } from "./helpers/css";

const workspace = {
  user: {
    id: "fictional-user",
    name: "Fictional Settings User",
    email: "settings-user@example.test",
  },
  team: { id: "fictional-team", name: "Fictional Team", slug: "fictional" },
  role: "owner",
  environment: "Local development",
  canCreateTeam: true,
};

describe("settings navigation", () => {
  it("marks one current tab with the primary button style", () => {
    const markup = renderToStaticMarkup(<SettingsNavigation active="team" />);
    const current = [...markup.matchAll(/<a [^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => tag.includes('aria-current="page"'));
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/app/settings/team"');
    expect(current[0]).not.toMatch(/class="[^"]*secondary/);
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

  it("shows the CV storage panel only to owners and admins", () => {
    const sentence = "These are application limits, not hard provider caps.";
    for (const role of ["owner", "admin", "recruiter", "viewer"]) {
      const markup = renderToStaticMarkup(
        <WorkspaceProvider value={{ ...workspace, role }}>
          <TeamSettings />
        </WorkspaceProvider>,
      );
      const admin = role === "owner" || role === "admin";
      expect(markup.includes("CV storage</h2>"), role).toBe(admin);
      expect(markup.includes(sentence), role).toBe(admin);
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
        usage,
      }),
    ).toContain(belowNotice);
    expect(
      form({
        maxBytes: 1_000_000_000,
        maxFiles: 5,
        uploadRequestsPerMinute: null,
        usage,
      }),
    ).not.toContain(belowNotice);
  });
});

describe("speed settings", () => {
  const speedLinks = (role: string | null) =>
    renderToStaticMarkup(
      <SettingsNavigation active="team" role={role} />,
    ).includes('href="/app/settings/speed"');
  it("lists Speed in the settings navigation for owners and admins only", () => {
    expect(speedLinks("owner")).toBe(true);
    expect(speedLinks("admin")).toBe(true);
    expect(speedLinks("recruiter")).toBe(false);
    expect(speedLinks("viewer")).toBe(false);
    expect(speedLinks(null)).toBe(false);
  });
  it("tells recruiters and viewers who opens the page that only owners and admins can view it", () => {
    for (const role of ["recruiter", "viewer"]) {
      const markup = renderToStaticMarkup(
        <WorkspaceProvider value={{ ...workspace, role }}>
          <SpeedSettings />
        </WorkspaceProvider>,
      );
      expect(markup).toContain(
        "Only team owners and admins can view speed timings.",
      );
      expect(markup).not.toMatch(/<input|<select|<table/);
    }
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
});
