"use client";

import Link from "next/link";
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
import {
  roleDescriptions,
  rolesFor,
  teamRequests,
  type TeamClient,
  type TeamRole,
} from "./team-members";

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
export const teamRoles: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  recruiter: "Recruiter",
  viewer: "Viewer",
};
export const levels: Record<string, string> = {
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
    <>
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
      <InviteToTeams
        teams={teams.data ? inviteTeams(teams.data.data) : null}
        teamsError={teams.error}
        // The invited rows appear in the list, with the filters already applied.
        onInvited={() =>
          setApplied((value) => ({
            filters: value.filters,
            run: value.run + 1,
          }))
        }
      />
    </>
  );
}

/**
 * The users list: names, emails, teams and roles of everyone in every team of the company and of
 * every pending invitation. A person's name links to their detail page; invited rows are text
 * only, and no row changes anything.
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
                      <td data-label="Name">
                        {row.userId ? (
                          <Link
                            href={`/app/admin/users/${encodeURIComponent(row.userId)}`}
                          >
                            {row.name ?? row.email}
                          </Link>
                        ) : (
                          (row.name ?? "Invited")
                        )}
                      </td>
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

/** A team the caller may invite to: one where they are team owner or admin (D1, TST-005). */
export type InviteTeam = {
  teamId: string;
  name: string;
  teamRole: "owner" | "admin";
};
export type InviteDraft = {
  email: string;
  /** Per offered team id: whether it is chosen and the team role to give. */
  teams: Record<string, { checked: boolean; role: TeamRole }>;
};
export type InviteOutcome = {
  teamId: string;
  team: string;
  sent: boolean;
  /** Better Auth's refusal, in plain words, when not sent. */
  message: string;
};
export const NO_INVITE_TEAMS =
  "You can invite people only to teams where you are an owner or admin.";
export const NO_TEAM_CHOSEN = "Choose at least one team.";

/** The caller's own GET /api/v1/teams rows where they are team owner or admin, in list order. */
export function inviteTeams(rows: AdminTeamRow[]): InviteTeam[] {
  return rows.flatMap((row) =>
    row.teamId && (row.teamRole === "owner" || row.teamRole === "admin")
      ? [{ teamId: row.teamId, name: row.name, teamRole: row.teamRole }]
      : [],
  );
}
/** A team's entry in the draft: not chosen, Recruiter, until the user changes it. */
export const draftTeam = (draft: InviteDraft, teamId: string) =>
  draft.teams[teamId] ?? { checked: false, role: "recruiter" as TeamRole };

/**
 * One ordinary Better Auth invitation per chosen team, in list order and one at a time, exactly as
 * Team & access sends it; Better Auth checks each role and team. Sent teams are unchosen, and the
 * email is cleared only when every team was sent. `onSent` runs once after any success.
 */
export async function sendInvitations(
  draft: InviteDraft,
  offered: InviteTeam[],
  options: { client?: TeamClient; onSent?: () => void } = {},
): Promise<{ draft: InviteDraft; outcomes: InviteOutcome[]; error: string }> {
  const chosen = offered.filter(
    (team) => draftTeam(draft, team.teamId).checked,
  );
  if (!chosen.length) return { draft, outcomes: [], error: NO_TEAM_CHOSEN };
  const outcomes: InviteOutcome[] = [];
  for (const team of chosen) {
    try {
      await teamRequests(team.teamId, options.client).invite(
        draft.email.trim(),
        draftTeam(draft, team.teamId).role,
      );
      outcomes.push({
        teamId: team.teamId,
        team: team.name,
        sent: true,
        message: "",
      });
    } catch (e) {
      outcomes.push({
        teamId: team.teamId,
        team: team.name,
        sent: false,
        message: humanError(e),
      });
    }
  }
  const next: InviteDraft = {
    email: outcomes.every((item) => item.sent) ? "" : draft.email,
    teams: { ...draft.teams },
  };
  for (const item of outcomes)
    if (item.sent)
      next.teams[item.teamId] = {
        ...draftTeam(draft, item.teamId),
        checked: false,
      };
  if (outcomes.some((item) => item.sent)) options.onSent?.();
  return { draft: next, outcomes, error: "" };
}

/** Admin > Users: Invite to teams, for the teams where the caller is team owner or admin. */
function InviteToTeams({
  teams,
  teamsError,
  onInvited,
}: {
  teams: InviteTeam[] | null;
  teamsError: string;
  onInvited: () => void;
}) {
  const [draft, setDraft] = useState<InviteDraft>({ email: "", teams: {} });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    outcomes: InviteOutcome[];
    error: string;
  }>({ outcomes: [], error: "" });
  const outcomeRef = useRef<HTMLDivElement>(null);
  const [outcomeFocus, setOutcomeFocus] = useState(0);
  // The outcome replaces the last one, so focus moves to it and a screen reader reads it.
  useEffect(() => {
    if (outcomeFocus) outcomeRef.current?.focus();
  }, [outcomeFocus]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!teams || busy) return;
    setBusy(true);
    setResult({ outcomes: [], error: "" });
    try {
      const sent = await sendInvitations(draft, teams, { onSent: onInvited });
      setDraft(sent.draft);
      setResult({ outcomes: sent.outcomes, error: sent.error });
    } finally {
      setBusy(false);
      setOutcomeFocus((count) => count + 1);
    }
  }
  return (
    <InviteToTeamsPanel
      teams={teams}
      teamsError={teamsError}
      draft={draft}
      busy={busy}
      outcomes={result.outcomes}
      error={result.error}
      outcomeRef={outcomeRef}
      onDraft={setDraft}
      onSubmit={(event) => void submit(event)}
    />
  );
}

/**
 * The Invite to teams form: an email, and per offered team a checkbox and a team role; only a team
 * owner gives Owner. No company level, area, plan access or configured role is ever sent.
 */
export function InviteToTeamsPanel({
  teams,
  teamsError = "",
  draft,
  busy = false,
  outcomes = [],
  error = "",
  outcomeRef,
  onDraft = () => {},
  onSubmit = (event) => event.preventDefault(),
}: {
  /** Null while the caller's teams load. */
  teams: InviteTeam[] | null;
  teamsError?: string;
  draft: InviteDraft;
  busy?: boolean;
  outcomes?: InviteOutcome[];
  /** NO_TEAM_CHOSEN after a submit with no team chosen. */
  error?: string;
  outcomeRef?: Ref<HTMLDivElement>;
  onDraft?: (draft: InviteDraft) => void;
  onSubmit?: (event: FormEvent) => void;
}) {
  const failed = outcomes.some((item) => !item.sent);
  const setTeam = (
    teamId: string,
    change: Partial<{ checked: boolean; role: TeamRole }>,
  ) =>
    onDraft({
      ...draft,
      teams: {
        ...draft.teams,
        [teamId]: { ...draftTeam(draft, teamId), ...change },
      },
    });
  return (
    <section className="panel stack">
      <h2>Invite to teams</h2>
      {teamsError ? (
        <p className="notice error" role="alert">
          Could not load your teams. {teamsError}
        </p>
      ) : !teams ? (
        <p role="status">Loading your teams…</p>
      ) : !teams.length ? (
        <p>{NO_INVITE_TEAMS}</p>
      ) : (
        <>
          <p className="muted">
            Sends one invitation for each team you choose, with its team role.
            The recipient must verify the invited email before joining.
          </p>
          <form className="stack" onSubmit={onSubmit}>
            <label className="field">
              <span>Email address</span>
              <input
                type="email"
                required
                maxLength={320}
                value={draft.email}
                onChange={(e) => onDraft({ ...draft, email: e.target.value })}
                autoComplete="email"
              />
            </label>
            <fieldset className="stack" style={{ gap: 12 }}>
              <legend>Teams</legend>
              {teams.map((team) => {
                const entry = draftTeam(draft, team.teamId);
                return (
                  <div
                    key={team.teamId}
                    className="row"
                    style={{ alignItems: "flex-end", flexWrap: "wrap" }}
                  >
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={entry.checked}
                        onChange={(e) =>
                          setTeam(team.teamId, { checked: e.target.checked })
                        }
                      />
                      {team.name}
                    </label>
                    <label className="field">
                      <span>Team role in {team.name}</span>
                      <select
                        value={entry.role}
                        onChange={(e) =>
                          setTeam(team.teamId, {
                            role: e.target.value as TeamRole,
                          })
                        }
                      >
                        {rolesFor(team.teamRole).map((role) => (
                          <option key={role} value={role}>
                            {teamRoles[role]}
                          </option>
                        ))}
                      </select>
                      <small className="muted">
                        {roleDescriptions[entry.role]}
                      </small>
                    </label>
                  </div>
                );
              })}
            </fieldset>
            <div className="row">
              <button type="submit" className="button" disabled={busy}>
                {busy ? "Sending invitations…" : "Send invitations"}
              </button>
            </div>
          </form>
          {error ? (
            <div
              ref={outcomeRef}
              tabIndex={-1}
              className="notice error"
              role="alert"
            >
              {error}
            </div>
          ) : (
            outcomes.length > 0 && (
              <div
                ref={outcomeRef}
                tabIndex={-1}
                className={`notice ${failed ? "error" : "success"}`}
                role={failed ? "alert" : "status"}
              >
                {outcomes.map((item) => (
                  <p key={item.teamId} style={{ margin: 0 }}>
                    {item.sent
                      ? `Invitation sent to ${item.team}.`
                      : `Not sent to ${item.team}: ${item.message}`}
                  </p>
                ))}
              </div>
            )
          )}
        </>
      )}
    </section>
  );
}
