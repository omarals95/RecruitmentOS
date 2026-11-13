"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import { appVersion, formatBuildTime, versionDetails } from "@/lib/app-version";
import { SettingsNavigation, useAdminPortalLink } from "./settings-navigation";

/** Every signed-in member: the version and build of this deployment, nothing secret. */
export function AboutSettings() {
  const adminPortal = useAdminPortalLink();
  return (
    <div className="stack settings-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Workspace settings</p>
          <h1>About</h1>
          <p className="muted">
            The version and build of RecruitmentOS you are using.
          </p>
        </div>
        <Info size={28} aria-hidden="true" />
      </header>
      <SettingsNavigation active="about" adminPortal={adminPortal} />
      <AboutPanel />
    </div>
  );
}

export function AboutPanel() {
  const [notice, setNotice] = useState<{
    copied: boolean;
    text: string;
  } | null>(null);
  const { version, build, commit, environment, builtAt } = appVersion();
  async function copyDetails() {
    try {
      await navigator.clipboard.writeText(versionDetails());
      setNotice({
        copied: true,
        text: "Details copied. Paste them into your bug report.",
      });
    } catch {
      // Neutral, not success: nothing was copied.
      setNotice({
        copied: false,
        text: "Copy is unavailable in this browser. Copy the details shown above instead.",
      });
    }
  }
  return (
    <section className="panel stack">
      <dl className="detail-facts">
        <div>
          <dt>Version</dt>
          <dd>{version}</dd>
        </div>
        <div>
          <dt>Build</dt>
          <dd>{build}</dd>
        </div>
        <div>
          <dt>Commit</dt>
          <dd>{commit}</dd>
        </div>
        <div>
          <dt>Environment</dt>
          <dd>{environment}</dd>
        </div>
        <div>
          <dt>Build time</dt>
          <dd>{formatBuildTime(builtAt)}</dd>
        </div>
      </dl>
      <div>
        <button
          type="button"
          className="button secondary"
          onClick={() => void copyDetails()}
        >
          Copy details
        </button>
      </div>
      {notice && (
        <p
          className={notice.copied ? "notice success" : "notice"}
          role="status"
        >
          {notice.text}
        </p>
      )}
    </section>
  );
}
