"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AdminTeamRow } from "@/lib/admin-teams";
import {
  humanError,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";
import { formatDate } from "@/components/workspace/helpers";
import { CreateTeam } from "./create-team";

export type { AdminTeamRow };
const access: Record<NonNullable<AdminTeamRow["teamRole"]>, string> = {
  owner: "Owner",
  admin: "Admin",
  recruiter: "Recruiter",
  viewer: "Viewer",
};
// The column is as narrow as its control, which stays on one line.
const actionCell = {
  width: "1%",
  whiteSpace: "nowrap",
  overflowWrap: "normal",
} as const;

/** Admin > Teams: the list from GET /api/v1/teams, then Create a team when the caller may. */
export function TeamsTab() {
  const { team } = useWorkspace();
  const teams = useApi<{ data: AdminTeamRow[] }>(team ? "/api/v1/teams" : null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const outcome = useRef<HTMLDivElement>(null);
  const [outcomeFocus, setOutcomeFocus] = useState(0);
  useEffect(() => {
    if (outcomeFocus) outcome.current?.focus();
  }, [outcomeFocus]);
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
      setOutcomeFocus((count) => count + 1);
    }
  }
  return (
    <>
      {error && (
        <div ref={outcome} tabIndex={-1} className="notice error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div
          ref={outcome}
          tabIndex={-1}
          className="notice success"
          role="status"
        >
          {notice}
        </div>
      )}
      <TeamsPanel rows={teams.data?.data ?? null} error={teams.error} />
      <CreateTeam
        busy={busy}
        onAction={action}
        onBootstrapFailed={async (message) => {
          setError(message);
          teams.refresh();
        }}
      />
    </>
  );
}

/**
 * The teams list. Only a team where the caller is owner or admin has a control: Open, to that
 * team's detail page, without switching teams. Any other row is text only, so it opens nothing of
 * that team.
 */
export function TeamsPanel({
  rows,
  error,
}: {
  rows: AdminTeamRow[] | null;
  error: string;
}) {
  return (
    <section className="panel stack">
      <h2>Teams</h2>
      <p className="muted">
        The teams you own or administer, and with company authority every team
        of the company, showing only the name, identifier and created date of a
        team you are not a member of.
      </p>
      {error ? (
        <p className="notice error" role="alert">
          Could not load the teams. {error}
        </p>
      ) : !rows ? (
        <p role="status">Loading teams…</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">Teams, by name</caption>
            <thead>
              <tr>
                <th>Team</th>
                <th>Identifier</th>
                <th>Created</th>
                <th>Your access</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.slug}>
                  <td data-label="Team">
                    {row.name}
                    {row.archived && (
                      <>
                        {" "}
                        <span className="badge warning">Archived</span>
                      </>
                    )}
                  </td>
                  <td data-label="Identifier">{row.slug}</td>
                  <td data-label="Created">{formatDate(row.createdAt)}</td>
                  <td data-label="Your access">
                    {row.teamRole ? access[row.teamRole] : "Not a member"}
                  </td>
                  <td data-label="Actions" style={actionCell}>
                    {(row.teamRole === "owner" || row.teamRole === "admin") &&
                      row.teamId && (
                        <Link
                          href={`/app/admin/teams/${encodeURIComponent(row.teamId)}`}
                          className="button secondary"
                        >
                          Open<span className="sr-only"> {row.name}</span>
                        </Link>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
