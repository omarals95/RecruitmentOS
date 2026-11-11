"use client";

import { useMemo, useState, type FormEvent } from "react";
import type { MeAccess } from "@/lib/authz";
import {
  humanError,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";
import { tabKeys } from "@/components/ui/tab-keys";
import { AdminPortalView } from "./admin-portal";
import { TeamMembers, teamRequests } from "./team-members";

export type TeamDetailTab = "members" | "settings";
const TABS: { key: TeamDetailTab; label: string }[] = [
  { key: "members", label: "Members" },
  { key: "settings", label: "Settings" },
];

export interface TeamDetailProps {
  /** The team in the URL, which the server allowed. */
  team: { id: string; name: string };
  /** The caller's team role in that team. */
  role: string | null;
  companyLevel: string | null;
  tab: TeamDetailTab;
}

/**
 * Admin > Teams > one team: the shell and sidebar of the active team, as on every admin page, with
 * the team's own Members and Settings beside it. Only the detail follows the team in the URL.
 */
export function TeamDetailPortal(props: TeamDetailProps) {
  const { team } = useWorkspace();
  const result = useApi<{ data: MeAccess }>(team ? "/api/v1/me/access" : null);
  return (
    <AdminPortalView
      tab="teams"
      access={result.data?.data ?? null}
      denied={false}
      error={result.error}
      detail={<TeamDetail {...props} />}
    />
  );
}

export function TeamDetail({ team, role, companyLevel, tab }: TeamDetailProps) {
  const [current, setCurrent] = useState(tab);
  return (
    <>
      <h2>{team.name}</h2>
      <div
        className="tabs"
        role="tablist"
        aria-label="Team details"
        onKeyDown={tabKeys}
      >
        {TABS.map((item) => (
          <button
            type="button"
            role="tab"
            id={`team-tab-${item.key}`}
            aria-controls={`team-panel-${item.key}`}
            tabIndex={current === item.key ? 0 : -1}
            aria-selected={current === item.key}
            key={item.key}
            onClick={() => setCurrent(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`team-panel-${current}`}
        aria-labelledby={`team-tab-${current}`}
        tabIndex={0}
        className="stack"
      >
        {current === "members" ? (
          <TeamMembers team={team} role={role} companyLevel={companyLevel} />
        ) : (
          <TeamNameForm team={team} />
        )}
      </div>
    </>
  );
}

/** The team rename of Team & access, for the team in the URL; the page reloads to show the name. */
function TeamNameForm({ team }: { team: { id: string; name: string } }) {
  const requests = useMemo(() => teamRequests(team.id), [team.id]);
  const [teamName, setTeamName] = useState(team.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function renameTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await requests.rename(teamName.trim());
      window.location.reload();
      setNotice("Team name updated.");
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && (
        <div className="notice error" role="alert">
          {error} Your unsaved fields are retained.
        </div>
      )}
      {notice && (
        <div className="notice success" role="status">
          {notice}
        </div>
      )}
      <section className="panel">
        <h2>Rename team</h2>
        <form className="stack" onSubmit={renameTeam}>
          <label className="field">
            <span>Team name</span>
            <input
              required
              maxLength={100}
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
            />
          </label>
          <div className="row">
            <button
              type="submit"
              className="button"
              disabled={busy || teamName.trim() === team.name}
            >
              {busy ? "Saving…" : "Save team name"}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
