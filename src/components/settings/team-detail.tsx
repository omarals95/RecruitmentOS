"use client";

import { useMemo, useState, type FormEvent } from "react";
import type { MeAccess } from "@/lib/authz";
import {
  humanError,
  TeamScope,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";
import { ActivityList } from "@/components/workspace/overview";
import { tabKeys } from "@/components/ui/tab-keys";
import { AdminPortalView } from "./admin-portal";
import { SpeedTab } from "./speed-settings";
import { StorageSettings } from "./storage-settings";
import { TaskBoardsTab } from "./task-boards-tab";
import { TEAM_DETAIL_TABS, type TeamDetailTab } from "./team-detail-tabs";
import { TeamMembers, teamRequests } from "./team-members";

export type { TeamDetailTab };

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
 * the team's own tabs beside it. Only the detail follows the team in the URL; a team switch
 * remounts it, since the switch clears every cached read.
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
      detail={<TeamDetail key={team?.id ?? "no-team"} {...props} />}
    />
  );
}

/** Every tab reads and writes the team in the URL, through its TeamScope, never the active team. */
export function TeamDetail({ team, role, companyLevel, tab }: TeamDetailProps) {
  const [current, setCurrent] = useState(tab);
  return (
    <TeamScope teamId={team.id}>
      <h2>{team.name}</h2>
      <div
        className="tabs"
        role="tablist"
        aria-label="Team details"
        onKeyDown={tabKeys}
      >
        {TEAM_DETAIL_TABS.map((item) => (
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
        ) : current === "settings" ? (
          <TeamSettingsTab team={team} />
        ) : current === "cv-storage" ? (
          <CvStorageTab />
        ) : current === "speed" ? (
          <SpeedTab />
        ) : current === "task-boards" ? (
          <TaskBoardsTab />
        ) : (
          <ActivityList />
        )}
      </div>
    </TeamScope>
  );
}

/** One action at a time, with its error or success notice, as Team & access ran them. */
function useTeamAction() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function action(
    key: string,
    work: () => Promise<void>,
    message: string,
  ) {
    if (busy) return;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await work();
      setNotice(message);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy("");
    }
  }
  const notices = (
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
    </>
  );
  return { busy, action, notices };
}

/**
 * The rename of Team & access and Prepare task board, for the team in the URL; the page reloads
 * after a rename to show the name.
 */
function TeamSettingsTab({ team }: { team: { id: string; name: string } }) {
  const requests = useMemo(() => teamRequests(team.id), [team.id]);
  const [teamName, setTeamName] = useState(team.name);
  const { busy, action, notices } = useTeamAction();
  function renameTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void action(
      "rename",
      async () => {
        await requests.rename(teamName.trim());
        window.location.reload();
      },
      "Team name updated.",
    );
  }
  return (
    <>
      {notices}
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
              disabled={!!busy || teamName.trim() === team.name}
            >
              {busy === "rename" ? "Saving…" : "Save team name"}
            </button>
          </div>
        </form>
      </section>
      <section className="panel stack">
        <h2>Task board</h2>
        <p className="muted">
          Prepares the team&apos;s default task buckets when it has none.
          Existing tasks and buckets are kept.
        </p>
        <div className="row">
          <button
            type="button"
            className="button secondary"
            disabled={!!busy}
            onClick={() =>
              void action(
                "bootstrap",
                async () => {
                  await requests.prepareTaskBoard();
                },
                "Task board prepared. Existing tasks and buckets were kept.",
              )
            }
          >
            Prepare task board
          </button>
        </div>
      </section>
    </>
  );
}

/** The CV storage panel of Team & access, with this tab's own busy state and notices. */
function CvStorageTab() {
  const { busy, action, notices } = useTeamAction();
  return (
    <>
      {notices}
      <StorageSettings busy={busy} onAction={action} />
    </>
  );
}
