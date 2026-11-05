import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceProvider } from "../src/components/workspace/client";
import { SettingsNavigation } from "../src/components/settings/settings-navigation";
import {
  deviceListMessage,
  ProfileSettings,
} from "../src/components/settings/profile-settings";

const workspace = {
  user: {
    id: "fictional-user",
    name: "Fictional Settings User",
    email: "settings-user@example.test",
  },
  team: { id: "fictional-team", name: "Fictional Team", slug: "fictional" },
  role: "owner",
  environment: "Local development",
};
/** Innermost `selector { body }` blocks, so rules inside media queries count too. */
function rules(file: string) {
  const css = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim(),
    body: match[2],
  }));
}

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
