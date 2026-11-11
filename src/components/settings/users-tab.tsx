"use client";

import { useEffect, useRef, useState, type FormEvent, type Ref } from "react";
import type { AdminTeamRow } from "@/lib/admin-teams";
import type { WorkspacePeople, WorkspacePersonRow } from "@/lib/admin-users";
import {
  ClientError,
  humanError,
  requestJson,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";
import { formatDate } from "@/components/workspace/helpers";
import { NO_ACCESS } from "./admin-tabs";

export type { WorkspacePersonRow };
export type UserFilters = {
  team: string;
  status: "" | "active" | "invited";
  level: "" | "owner" | "admin" | "none";
  role: string;
};
export const NO_USER_FILTERS: UserFilters = {
  team: "",
  status: "",
  level: "",
  role: "",
};
const teamRoles: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  recruiter: "Recruiter",
  viewer: "Viewer",
};
const levels: Record<string, string> = {
  owner: "Company owner",
  admin: "Company admin",
};
const usersPath = (filters: UserFilters, cursor?: string) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value) params.set(key, value);
  if (cursor) params.set("cursor", cursor);
  return `/api/v1/admin/users${params.size ? `?${params}` : ""}`;
};
type Loaded = {
  run: number;
  rows: WorkspacePersonRow[];
  hasMore: boolean;
  nextCursor: string | null;
  error: string;
  denied: boolean;
};

/** Admin > Users: GET /api/v1/admin/users for the applied filters, 25 at a time. */
export function UsersTab() {
  const { team } = useWorkspace();
  const teamId = team?.id ?? null;
  const teams = useApi<{ data: AdminTeamRow[] }>(
    teamId ? "/api/v1/teams" : null,
  );
  const [draft, setDraft] = useState<UserFilters>(NO_USER_FILTERS);
  const [applied, setApplied] = useState({ filters: NO_USER_FILTERS, run: 0 });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [roles, setRoles] = useState<WorkspacePeople["roles"]>([]);
  const [busy, setBusy] = useState(false);
  const [moreError, setMoreError] = useState("");
  const countRef = useRef<HTMLParagraphElement>(null);
  const [countFocus, setCountFocus] = useState(0);
  const current = loaded?.run === applied.run ? loaded : null;

  useEffect(() => {
    if (!teamId) return;
    let active = true;
    const { filters, run } = applied;
    requestJson<WorkspacePeople>(teamId, usersPath(filters))
      .then((page) => {
        if (!active) return;
        setRoles(page.roles);
        setLoaded({
          run,
          rows: page.data,
          hasMore: page.pagination.hasMore,
          nextCursor: page.pagination.nextCursor,
          error: "",
          denied: false,
        });
      })
      .catch((e) => {
        if (active)
          setLoaded({
            run,
            rows: [],
            hasMore: false,
            nextCursor: null,
            error: humanError(e),
            denied: e instanceof ClientError && e.status === 403,
          });
      });
    return () => {
      active = false;
    };
  }, [teamId, applied]);
  // The button is gone once the last page is in, so focus moves to the count line.
  useEffect(() => {
    if (countFocus) countRef.current?.focus();
  }, [countFocus]);

  async function showMore() {
    const cursor = current?.nextCursor;
    if (!teamId || !cursor || busy) return;
    const { filters, run } = applied;
    setBusy(true);
    setMoreError("");
    try {
      const page = await requestJson<WorkspacePeople>(
        teamId,
        usersPath(filters, cursor),
      );
      setLoaded((list) =>
        list?.run === run
          ? {
              ...list,
              rows: [...list.rows, ...page.data],
              hasMore: page.pagination.hasMore,
              nextCursor: page.pagination.nextCursor,
            }
          : list,
      );
      if (!page.pagination.hasMore) setCountFocus((count) => count + 1);
    } catch (e) {
      setMoreError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <UsersPanel
      rows={current && !current.error ? current.rows : null}
      error={current?.error ?? ""}
      denied={!!current?.denied}
      filtered={Object.values(applied.filters).some(Boolean)}
      hasMore={!!current?.hasMore}
      busy={busy}
      moreError={moreError}
      filters={draft}
      teams={teams.data?.data ?? null}
      teamsError={teams.error}
      roles={roles}
      countRef={countRef}
      onFilters={(change) => setDraft((value) => ({ ...value, ...change }))}
      onApply={(event) => {
        event.preventDefault();
        setMoreError("");
        setApplied((value) => ({ filters: draft, run: value.run + 1 }));
      }}
      onShowMore={() => void showMore()}
    />
  );
}

/**
 * The users list: names, emails, teams and roles of everyone in every team of the company and of
 * every pending invitation. Text only, so no row opens or changes anything.
 */
export function UsersPanel({
  rows,
  error,
  denied = false,
  filtered,
  hasMore,
  busy = false,
  moreError = "",
  filters,
  teams,
  teamsError = "",
  roles,
  countRef,
  onFilters = () => {},
  onApply = (event) => event.preventDefault(),
  onShowMore = () => {},
}: {
  /** Null while the first page loads or after it failed. */
  rows: WorkspacePersonRow[] | null;
  error: string;
  /** The route refused the caller (403). */
  denied?: boolean;
  /** Whether any filter was applied, for the empty state. */
  filtered: boolean;
  hasMore: boolean;
  busy?: boolean;
  moreError?: string;
  filters: UserFilters;
  teams: Pick<AdminTeamRow, "name" | "slug">[] | null;
  teamsError?: string;
  roles: WorkspacePeople["roles"];
  countRef?: Ref<HTMLParagraphElement>;
  onFilters?: (change: Partial<UserFilters>) => void;
  onApply?: (event: FormEvent) => void;
  onShowMore?: () => void;
}) {
  if (denied)
    return (
      <section className="panel stack">
        <h2>Users</h2>
        <p>{NO_ACCESS}</p>
      </section>
    );
  return (
    <section className="panel stack">
      <h2>Users</h2>
      <p className="muted">
        Everyone in every team of the company and everyone with a pending
        invitation, with their teams and roles.
      </p>
      <form
        className="stack"
        style={{ gap: 12 }}
        aria-label="User filters"
        onSubmit={onApply}
      >
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label className="field">
            <span>Team</span>
            <select
              value={filters.team}
              onChange={(event) => onFilters({ team: event.target.value })}
            >
              <option value="">Any team</option>
              {(teamsError ? [] : (teams ?? [])).map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Status</span>
            <select
              value={filters.status}
              onChange={(event) =>
                onFilters({
                  status: event.target.value as UserFilters["status"],
                })
              }
            >
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="invited">Invited</option>
            </select>
          </label>
          <label className="field">
            <span>Company level</span>
            <select
              value={filters.level}
              onChange={(event) =>
                onFilters({
                  level: event.target.value as UserFilters["level"],
                })
              }
            >
              <option value="">Any level</option>
              <option value="owner">Company owner</option>
              <option value="admin">Company admin</option>
              <option value="none">No company authority</option>
            </select>
          </label>
          <label className="field">
            <span>Configured role</span>
            <select
              value={filters.role}
              onChange={(event) => onFilters({ role: event.target.value })}
            >
              <option value="">Any configured role</option>
              {roles.map((role) => (
                <option key={role.key} value={role.key}>
                  {role.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {teamsError && (
          <p className="notice error" role="alert">
            Could not load the filter choices. {teamsError}
          </p>
        )}
        <div className="row">
          <button type="submit" className="button">
            Apply filters
          </button>
        </div>
      </form>
      {error ? (
        <p className="notice error" role="alert">
          Could not load the people. {error}
        </p>
      ) : !rows ? (
        <p role="status">Loading people…</p>
      ) : !rows.length ? (
        <p className="muted">
          {filtered
            ? "No people match these filters."
            : "There are no people in the company's teams yet."}
        </p>
      ) : (
        <>
          {/* The record screens' phone layout: one labelled card per person at 720 px and below. */}
          <div className="records-panel">
            <div className="table-wrap">
              <table className="data-table compact">
                <caption className="sr-only">People, by name</caption>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Teams</th>
                    <th>Company level</th>
                    <th>Status</th>
                    <th>Last sign-in</th>
                    <th>Two-step</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.userId ?? `invitation:${row.email}`}>
                      <td data-label="Name">{row.name ?? "Invited"}</td>
                      <td data-label="Email">{row.email}</td>
                      <td data-label="Teams">
                        {row.teams.map((item, index) => (
                          <div key={index}>
                            {item.team} ·{" "}
                            {item.teamRole === null
                              ? "Role not recorded"
                              : (teamRoles[item.teamRole] ?? item.teamRole)}
                            {item.configuredRole && ` · ${item.configuredRole}`}
                          </div>
                        ))}
                      </td>
                      <td data-label="Company level">
                        {row.companyLevel ? levels[row.companyLevel] : "None"}
                      </td>
                      <td data-label="Status">
                        {row.status === "invited" ? "Invited" : "Active"}
                      </td>
                      <td data-label="Last sign-in">
                        {row.status === "invited"
                          ? "Not signed in yet"
                          : row.lastSignInAt
                            ? formatDate(row.lastSignInAt, true)
                            : "Not recorded"}
                      </td>
                      <td data-label="Two-step">
                        {row.twoStep ? "On" : "Off"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p ref={countRef} tabIndex={-1} role="status" className="muted">
            Showing {rows.length} {rows.length === 1 ? "person" : "people"}
          </p>
          {moreError && (
            <p className="notice error" role="alert">
              Could not load more people. {moreError}
            </p>
          )}
          {hasMore && (
            <div className="row">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={onShowMore}
              >
                Show more
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
