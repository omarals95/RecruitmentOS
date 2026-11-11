"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type Ref } from "react";
import type { AdminTeamRow } from "@/lib/admin-teams";
import type { WorkspacePerson, WorkspacePersonEvent } from "@/lib/admin-users";
import type { MeAccess } from "@/lib/authz";
import {
  ClientError,
  humanError,
  requestJson,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";
import { formatDate } from "@/components/workspace/helpers";
import {
  useConfirm,
  type ConfirmOptions,
} from "@/components/ui/confirm-dialog";
import { tabKeys } from "@/components/ui/tab-keys";
import {
  AdminPortalView,
  historyActions,
  objectTypes,
  plain,
} from "./admin-portal";
import { NO_ACCESS } from "./admin-tabs";
import { areaLabels } from "./company-authority-tab";
import {
  REAUTH_CANCELLED,
  useFreshSession,
  type ReauthCancelled,
} from "./fresh-session-dialog";
import { teamRequests } from "./team-members";
import { USER_DETAIL_TABS, type UserDetailTab } from "./user-detail-tabs";
import { levels, teamRoles } from "./users-tab";

export type { UserDetailTab, WorkspacePerson };

export interface UserDetailProps {
  /** The user id in the URL; the server allowed the Users page. */
  userId: string;
  /** The caller's company level in the active team: only a company owner gets the Company authority link. */
  companyLevel: string | null;
  tab: UserDetailTab;
}

export const USER_NOT_FOUND = "This person is not in any team of your company.";
export const EVENT_LIMIT = 50;

/**
 * Admin > Users > one person: the shell and sidebar of the active team, as on every admin page,
 * with the person's tabs beside it. A team switch remounts the detail, since the switch clears
 * every cached read.
 */
export function UserDetailPortal(props: UserDetailProps) {
  const { team } = useWorkspace();
  const result = useApi<{ data: MeAccess }>(team ? "/api/v1/me/access" : null);
  return (
    <AdminPortalView
      tab="users"
      access={result.data?.data ?? null}
      denied={false}
      error={result.error}
      detail={<UserDetail key={team?.id ?? "no-team"} {...props} />}
    />
  );
}

type Loaded = {
  person: WorkspacePerson | null;
  error: string;
  status: number | null;
};

/** GET /api/v1/admin/users/<id> for the active team, and the caller's own teams for Reset. */
export function UserDetail({ userId, companyLevel, tab }: UserDetailProps) {
  const { user, team } = useWorkspace();
  const teamId = team?.id ?? null;
  const teams = useApi<{ data: AdminTeamRow[] }>(
    teamId ? "/api/v1/teams" : null,
  );
  const [run, setRun] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { confirm, dialog } = useConfirm();
  const freshSession = useFreshSession();
  const outcome = useRef<HTMLDivElement>(null);
  const [outcomeFocus, setOutcomeFocus] = useState(0);
  useEffect(() => {
    if (outcomeFocus) outcome.current?.focus();
  }, [outcomeFocus]);

  useEffect(() => {
    if (!teamId) return;
    let active = true;
    requestJson<{ data: WorkspacePerson }>(
      teamId,
      `/api/v1/admin/users/${encodeURIComponent(userId)}`,
    )
      .then((result) => {
        if (active) setLoaded({ person: result.data, error: "", status: null });
      })
      .catch((e) => {
        if (active)
          setLoaded({
            person: null,
            error: humanError(e),
            status: e instanceof ClientError ? e.status : null,
          });
      });
    return () => {
      active = false;
    };
  }, [teamId, userId, run]);

  const person = loaded?.person ?? null;
  const resetTeamId = person
    ? resetTeam(person, user.id, teams.data?.data ?? null)
    : null;
  async function reset() {
    if (!person || !resetTeamId || busy) return;
    setError("");
    setNotice("");
    let done: boolean;
    try {
      done = await resetTwoStep(
        person,
        resetTeamId,
        confirm,
        freshSession.withFreshSession,
        () => setBusy(true),
      );
      if (done) {
        setNotice(
          `${person.name}'s two-step sign-in was reset. They have been signed out everywhere.`,
        );
        setRun((value) => value + 1);
      }
    } catch (e) {
      setError(humanError(e));
      done = true;
    } finally {
      setBusy(false);
    }
    if (done) setOutcomeFocus((count) => count + 1);
  }

  if (!loaded) return <p role="status">Loading this person…</p>;
  if (!person)
    return <UserDetailRefusal status={loaded.status} error={loaded.error} />;
  return (
    <>
      <UserDetailView
        person={person}
        tab={tab}
        callerId={user.id}
        companyOwner={companyLevel === "owner"}
        canReset={resetTeamId !== null}
        busy={busy}
        error={error}
        notice={notice}
        outcomeRef={outcome}
        onReset={() => void reset()}
      />
      {freshSession.dialog}
      {dialog}
    </>
  );
}

/** A person that did not load: the no-access sentence on 403, not found on 404, else the error. */
export function UserDetailRefusal({
  status,
  error,
}: {
  status: number | null;
  error: string;
}) {
  return (
    <section className="panel">
      {status === 403 || status === 404 ? (
        <p>{status === 403 ? NO_ACCESS : USER_NOT_FOUND}</p>
      ) : (
        <p className="notice error" role="alert">
          Could not load this person. {error}
        </p>
      )}
    </section>
  );
}

/**
 * The team whose id the reset names: a team of the person where the caller is team owner, matched
 * by slug against the caller's own GET /api/v1/teams rows. Null for the caller themselves, when
 * two-step sign-in is off or the caller owns none of the person's teams.
 */
export function resetTeam(
  person: Pick<WorkspacePerson, "userId" | "twoStep" | "teams">,
  callerId: string,
  teams: Pick<AdminTeamRow, "teamId" | "slug" | "teamRole">[] | null,
): string | null {
  if (person.userId === callerId || !person.twoStep || !teams) return null;
  const slugs = new Set(person.teams.map((item) => item.slug));
  return (
    teams.find(
      (item) =>
        item.teamRole === "owner" && item.teamId && slugs.has(item.slug),
    )?.teamId ?? null
  );
}

/**
 * Team & access's reset for one team the caller owns: the same confirmation, then the request,
 * which on 403 SESSION_NOT_FRESH opens "Confirm it's you" and retries once. True once reset; false
 * when the confirmation or the re-authentication was cancelled, which sends nothing more.
 */
export async function resetTwoStep(
  person: Pick<WorkspacePerson, "userId" | "name">,
  teamId: string,
  confirm: (options: ConfirmOptions) => Promise<boolean>,
  withFreshSession: <T>(work: () => Promise<T>) => Promise<T | ReauthCancelled>,
  onConfirmed: () => void = () => {},
): Promise<boolean> {
  if (
    !(await confirm({
      title: "Reset two-step sign-in?",
      message: `Reset ${person.name}'s two-step sign-in? Their authenticator key and backup codes stop working, they are signed out everywhere and their trusted devices are forgotten. If their role requires it, they must set it up again at their next sign-in.`,
      confirmLabel: "Reset two-step sign-in",
      destructive: true,
    }))
  )
    return false;
  onConfirmed();
  const outcome = await withFreshSession(() =>
    teamRequests(teamId).resetTwoStep(person.userId),
  );
  return outcome !== REAUTH_CANCELLED;
}

/** The plain words for one event's change. */
export function eventLabel(event: WorkspacePersonEvent) {
  if (event.action.startsWith("config."))
    return `${plain(historyActions, event.action)} · ${plain(objectTypes, event.objectType ?? "")}: ${event.objectKey ?? ""}`;
  if (event.action === "role.assigned")
    return event.roleName === null
      ? "Configured role assigned"
      : `Configured role assigned: ${event.roleName}`;
  if (event.action === "role.cleared") return "Configured role cleared";
  if (event.action === "scope.home_units_changed") return "Home units changed";
  if (event.action === "workspace_authority.changed")
    return "Company authority changed";
  if (event.action === "two_step.reset") return "Two-step sign-in reset";
  return event.action;
}

/** The loaded person: name, the five tabs and the open tab's panel. Read only but for Reset. */
export function UserDetailView({
  person,
  tab,
  callerId,
  companyOwner,
  canReset,
  busy = false,
  error = "",
  notice = "",
  outcomeRef,
  onReset = () => {},
}: {
  person: WorkspacePerson;
  tab: UserDetailTab;
  /** The signed-in user. */
  callerId: string;
  /** The caller is a company owner, who changes company authority on its page. */
  companyOwner: boolean;
  /** Reset two-step sign-in is offered (see resetTeam). */
  canReset: boolean;
  busy?: boolean;
  error?: string;
  notice?: string;
  outcomeRef?: Ref<HTMLDivElement>;
  onReset?: () => void;
}) {
  const [current, setCurrent] = useState(tab);
  return (
    <>
      <h2>{person.name}</h2>
      <div
        className="tabs"
        role="tablist"
        aria-label="User details"
        onKeyDown={tabKeys}
      >
        {USER_DETAIL_TABS.map((item) => (
          <button
            type="button"
            role="tab"
            id={`user-tab-${item.key}`}
            aria-controls={`user-panel-${item.key}`}
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
        id={`user-panel-${current}`}
        aria-labelledby={`user-tab-${current}`}
        tabIndex={0}
        className="stack"
      >
        {current === "profile" ? (
          <ProfileTab person={person} />
        ) : current === "teams" ? (
          <TeamsTab person={person} />
        ) : current === "authority" ? (
          <AuthorityTab person={person} companyOwner={companyOwner} />
        ) : current === "security" ? (
          <SecurityTab
            person={person}
            canReset={canReset && person.userId !== callerId}
            busy={busy}
            error={error}
            notice={notice}
            outcomeRef={outcomeRef}
            onReset={onReset}
          />
        ) : (
          <ActivityTab person={person} />
        )}
      </div>
    </>
  );
}

/** Label and value pairs, as a description list. */
function Facts({ items }: { items: [string, string][] }) {
  return (
    <dl className="stack" style={{ gap: 12, margin: 0 }}>
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="muted">{label}</dt>
          <dd style={{ margin: 0 }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ProfileTab({ person }: { person: WorkspacePerson }) {
  return (
    <section className="panel stack">
      <h3>Profile</h3>
      <Facts
        items={[
          ["Name", person.name],
          ["Email", person.email],
          ["Status", "Active"],
          [
            "Last sign-in",
            person.lastSignInAt
              ? formatDate(person.lastSignInAt, true)
              : "Not recorded",
          ],
        ]}
      />
    </section>
  );
}

function TeamsTab({ person }: { person: WorkspacePerson }) {
  return (
    <section className="panel stack">
      <h3>Teams &amp; roles</h3>
      <p className="muted">
        The teams of your company this person is in. A configured role narrows
        the team role.
      </p>
      <div className="records-panel">
        <div className="table-wrap">
          <table className="data-table compact">
            <caption className="sr-only">Teams and roles, by team name</caption>
            <thead>
              <tr>
                <th>Team</th>
                <th>Team role</th>
                <th>Configured role</th>
              </tr>
            </thead>
            <tbody>
              {person.teams.map((item) => (
                <tr key={item.slug}>
                  <td data-label="Team">{item.team}</td>
                  <td data-label="Team role">
                    {item.teamRole === null
                      ? "Role not recorded"
                      : (teamRoles[item.teamRole] ?? item.teamRole)}
                  </td>
                  <td data-label="Configured role">
                    {item.configuredRole ?? "Team role only"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function AuthorityTab({
  person,
  companyOwner,
}: {
  person: WorkspacePerson;
  companyOwner: boolean;
}) {
  const areas = person.companyAreas ?? [];
  return (
    <section className="panel stack">
      <h3>Company authority</h3>
      {person.companyLevel === null ? (
        <p>No company authority</p>
      ) : (
        <>
          {person.authoritySuspended && (
            <p>
              <span className="badge warning">Suspended</span>
            </p>
          )}
          <Facts
            items={[
              ["Level", levels[person.companyLevel]],
              [
                "Areas",
                person.companyLevel === "owner"
                  ? "All areas"
                  : areas.length
                    ? areas
                        .map((area) =>
                          Object.hasOwn(areaLabels, area)
                            ? areaLabels[area as keyof typeof areaLabels]
                            : area,
                        )
                        .join(", ")
                    : "No areas",
              ],
              ["Plan & pay access", person.planAccess ? "Yes" : "No"],
              [
                "Since",
                person.authoritySince
                  ? formatDate(person.authoritySince)
                  : "Not recorded",
              ],
            ]}
          />
        </>
      )}
      {companyOwner ? (
        <p>
          <Link href="/app/admin/company-authority">
            Change on Company authority
          </Link>
        </p>
      ) : (
        <p className="muted">
          Only a company owner can change company authority.
        </p>
      )}
    </section>
  );
}

function SecurityTab({
  person,
  canReset,
  busy,
  error,
  notice,
  outcomeRef,
  onReset,
}: {
  person: WorkspacePerson;
  canReset: boolean;
  busy: boolean;
  error: string;
  notice: string;
  outcomeRef?: Ref<HTMLDivElement>;
  onReset: () => void;
}) {
  return (
    <>
      {error && (
        <div
          ref={outcomeRef}
          tabIndex={-1}
          className="notice error"
          role="alert"
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          ref={outcomeRef}
          tabIndex={-1}
          className="notice success"
          role="status"
        >
          {notice}
        </div>
      )}
      <section className="panel stack">
        <h3>Security</h3>
        <Facts
          items={[
            ["Two-step sign-in", person.twoStep ? "On" : "Off"],
            ["Signed-in devices", String(person.signedInDevices)],
          ]}
        />
        {canReset && (
          <div className="row">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={onReset}
            >
              Reset two-step sign-in
            </button>
          </div>
        )}
      </section>
    </>
  );
}

function ActivityTab({ person }: { person: WorkspacePerson }) {
  const events = person.events;
  return (
    <section className="panel stack">
      <h3>Activity</h3>
      <p className="muted">
        Configuration changes this person made and changes to their access,
        newest first.
      </p>
      {!events.length ? (
        <p className="muted">No configuration or access changes recorded.</p>
      ) : (
        <>
          <div className="records-panel">
            <div className="table-wrap">
              <table className="data-table compact">
                <caption className="sr-only">Changes, newest first</caption>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>What</th>
                    <th>Who</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event, index) => (
                    <tr key={`${event.occurredAt}:${index}`}>
                      <td data-label="When">
                        {formatDate(event.occurredAt, true)}
                      </td>
                      <td data-label="What">{eventLabel(event)}</td>
                      <td data-label="Who">
                        {event.actorId === person.userId
                          ? "This person"
                          : (event.actorName ?? "Not recorded")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {events.length >= EVENT_LIMIT && (
            <p className="muted">Showing the latest 50 changes.</p>
          )}
        </>
      )}
    </section>
  );
}
