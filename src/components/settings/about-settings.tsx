"use client";

import { useState } from "react";
import { Info } from "lucide-react";
import { useWorkspace } from "@/components/workspace/client";
import { appVersion, formatBuildTime, versionDetails } from "@/lib/app-version";
import { SettingsNavigation } from "./settings-navigation";

/** Every signed-in member: the version and build of this deployment, nothing secret. */
export function AboutSettings() {
  const { role } = useWorkspace();
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
      <SettingsNavigation active="about" role={role} />
      <AboutPanel />
    </div>
  );
}

export function AboutPanel() {
  const [notice, setNotice] = useState("");
  const { version, build, commit, environment, builtAt } = appVersion();
  async function copyDetails() {
    try {
      await navigator.clipboard.writeText(versionDetails());
      setNotice("Details copied. Paste them into your bug report.");
    } catch {
      setNotice(
        "Copy is unavailable in this browser. Copy the details shown above instead.",
      );
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
        <p className="notice success" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
