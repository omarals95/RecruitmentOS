"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Building2, RefreshCw, UserPlus, Users } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import type { MemberRoles } from "@/lib/member-roles";
import {
  ClientError,
  clearWorkspaceCache,
  humanError,
  requestJson,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";
import { formatDate } from "@/components/workspace/helpers";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { MeAccess } from "./admin-portal";
import { CreateTeam, ensure } from "./create-team";
import { SettingsNavigation } from "./settings-navigation";
import { StorageSettings } from "./storage-settings";

interface TeamSummary {
  id: string;
  name: string;
  slug: string;
}
interface TeamMember {
  id: string;
  role: string;
  userId: string;
  user: { id: string; name: string; email: string; image?: string | null };
}
interface TeamInvitation {
  id: string;
  email: string;
  role?: string | null;
  status: string;
  expiresAt: string | Date;
}
interface TeamDetails extends TeamSummary {
  members: TeamMember[];
  invitations: TeamInvitation[];
}
type TeamRole = "owner" | "admin" | "recruiter" | "viewer";
const roleDescriptions: Record<TeamRole, string> = {
  owner: "Full team administration and recruitment access",
  admin: "Manage members, recruitment and imports",
  recruiter: "Manage recruitment records and CVs",
  viewer: "Read-only recruitment access",
};

/** Only an owner resets two-step sign-in, and never their own (they use backup codes or Account settings). */
export function canResetTwoStep(
  role: string | null,
  memberUserId: string,
  userId: string,
) {
  return role === "owner" && memberUserId !== userId;
}

/** Only a company owner assigns configured roles; a team role never allows it (D1). */
export function canAssignRoles(companyLevel: string | null | undefined) {
  return companyLevel === "owner";
}

/** Row actions in the members table. */
export function MemberActions({
  canEdit,
  canResetTwoStep,
  busy,
  saveDisabled,
  removeDisabled,
  onSave,
  onRemove,
  onResetTwoStep,
}: {
  canEdit: boolean;
  canResetTwoStep: boolean;
  busy: boolean;
  saveDisabled: boolean;
  removeDisabled: boolean;
  onSave: () => void;
  onRemove: () => void;
  onResetTwoStep: () => void;
}) {
  if (!canEdit && !canResetTwoStep) return null;
  return (
    <div className="row">
      {canEdit && (
        <>
          <button
            type="button"
            className="button secondary"
            disabled={busy || saveDisabled}
            onClick={onSave}
          >
            Save role
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || removeDisabled}
            onClick={onRemove}
          >
            Remove
          </button>
        </>
      )}
      {canResetTwoStep && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onResetTwoStep}
        >
          Reset two-step sign-in
        </button>
      )}
    </div>
  );
}

type MemberRoleAssignment = MemberRoles["assignments"][number];

/** Above the members table for a company owner: a load error, if any. */
export function ConfiguredRolesNotice({ error }: { error: string }) {
  return error ? (
    <p className="notice error" role="alert">
      Could not load configured roles. {error}
    </p>
  ) : null;
}

/**
 * A company owner's configured-role control for one member row. Team owners keep the Owner role;
 * an assigned role that is no longer available is named, with reassign and clear.
 */
export function MemberRoleControl({
  name,
  teamOwner,
  assignment,
  roles,
  busy,
  onSave,
}: {
  name: string;
  teamOwner: boolean;
  assignment: MemberRoleAssignment | null;
  roles: MemberRoles["roles"];
  busy: boolean;
  onSave: (roleObjectId: string | null) => void;
}) {
  const current = assignment?.roleObjectId ?? "";
  const [choice, setChoice] = useState(assignment?.available ? current : "");
  if (teamOwner)
    return <span className="muted">Team owners keep the Owner role</span>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {assignment && !assignment.available && (
        <span className="badge warning">
          Role no longer available
          {assignment.roleName ? `: ${assignment.roleName}` : ""}
        </span>
      )}
      <label className="field">
        <span className="sr-only">Configured role for {name}</span>
        <select
          value={choice}
          disabled={busy}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value="">Team role only (no configured role)</option>
          {roles.map((role) => (
            <option key={role.roleObjectId} value={role.roleObjectId}>
              {role.name} ({role.membership})
            </option>
          ))}
        </select>
      </label>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button
          type="button"
          className="button secondary"
          disabled={busy || choice === current}
          onClick={() => onSave(choice || null)}
        >
          Save configured role
        </button>
        {assignment && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => onSave(null)}
          >
            Clear role
          </button>
        )}
      </div>
    </div>
  );
}

export function TeamSettings() {
  const { team } = useWorkspace();
  return <TeamSettingsContent key={team?.id ?? "no-team"} />;
}

function TeamSettingsContent() {
  const { team, user, role, canCreateTeam } = useWorkspace();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [details, setDetails] = useState<TeamDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [teamName, setTeamName] = useState(team?.name || "");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamRole>("recruiter");
  const [roleDrafts, setRoleDrafts] = useState<Record<string, TeamRole>>({});
  const { confirm, dialog } = useConfirm();
  const canAdmin = role === "owner" || role === "admin";
  // Only a company owner assigns configured roles; nobody else requests them.
  const me = useApi<{ data: MeAccess }>(team ? "/api/v1/me/access" : null);
  const companyOwner = canAssignRoles(me.data?.data.companyLevel);
  const memberRoles = useApi<{ data: MemberRoles }>(
    team && companyOwner ? "/api/v1/teams/member-roles" : null,
  );
  const outcome = useRef<HTMLDivElement>(null);
  const [outcomeFocus, setOutcomeFocus] = useState(0);
  useEffect(() => {
    if (outcomeFocus) outcome.current?.focus();
  }, [outcomeFocus]);
  const load = useCallback(async () => {
    try {
      const teamResult = await authClient.organization.list();
      ensure(teamResult);
      setTeams((teamResult.data ?? []) as TeamSummary[]);
      if (team) {
        const result = await authClient.organization.getFullOrganization({
          query: { organizationId: team.id },
        });
        ensure(result);
        setDetails(result.data as unknown as TeamDetails);
      } else setDetails(null);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setLoading(false);
    }
  }, [team]);
  useEffect(() => {
    let active = true;
    Promise.all([
      authClient.organization.list(),
      team
        ? authClient.organization.getFullOrganization({
            query: { organizationId: team.id },
          })
        : Promise.resolve(null),
    ])
      .then(([list, full]) => {
        ensure(list);
        if (full) ensure(full);
        if (active) {
          setTeams((list.data ?? []) as TeamSummary[]);
          setDetails((full?.data as unknown as TeamDetails) ?? null);
        }
      })
      .catch((e) => {
        if (active) setError(humanError(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [team]);

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
  async function switchTeam(id: string) {
    await action(
      `switch-${id}`,
      async () => {
        const result = await authClient.organization.setActive({
          organizationId: id,
        });
        ensure(result);
        clearWorkspaceCache();
        window.location.assign("/app");
      },
      "Team selected.",
    );
  }
  async function renameTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!team) return;
    await action(
      "rename",
      async () => {
        const result = await authClient.organization.update({
          organizationId: team.id,
          data: { name: teamName.trim() },
        });
        ensure(result);
        window.location.reload();
      },
      "Team name updated.",
    );
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!team) return;
    await action(
      "invite",
      async () => {
        const result = await authClient.organization.inviteMember({
          email: inviteEmail.trim(),
          role: inviteRole,
          organizationId: team.id,
        });
        ensure(result);
        setInviteEmail("");
        await load();
      },
      "Invitation sent. The recipient must verify the invited email before joining.",
    );
  }
  async function changeRole(person: TeamMember) {
    if (!team) return;
    const next = roleDrafts[person.id] || (person.role as TeamRole);
    if (next === person.role) return;
    if (
      !(await confirm({
        title: "Change member role?",
        message: `Change ${person.user.name} from ${person.role} to ${next}? This changes their access and API token permissions.${next === "owner" || next === "admin" ? " They will need to set up two-step sign-in before they can continue." : ""}`,
        confirmLabel: "Change role",
        destructive: true,
      }))
    )
      return;
    await action(
      `role-${person.id}`,
      async () => {
        const result = await authClient.organization.updateMemberRole({
          memberId: person.id,
          role: next,
          organizationId: team.id,
        });
        ensure(result);
        await load();
        if (person.userId === user.id) window.location.reload();
      },
      "Member role updated.",
    );
  }
  const assignmentOf = (person: TeamMember) =>
    memberRoles.data?.data.assignments.find(
      (item) => item.userId === person.userId,
    ) ?? null;
  async function saveMemberRole(
    person: TeamMember,
    roleObjectId: string | null,
  ) {
    if (!team) return;
    const chosen = memberRoles.data?.data.roles.find(
      (item) => item.roleObjectId === roleObjectId,
    );
    if (
      !(await confirm(
        chosen
          ? {
              title: "Give a configured role?",
              message: `Give ${person.user.name} the ${chosen.name} role? Their access narrows to the role, and their team role becomes ${chosen.membership} when it differs.`,
              confirmLabel: "Give role",
            }
          : {
              title: "Clear configured role?",
              message: `Clear ${person.user.name}'s configured role? They keep their team role, ${person.role}.`,
              confirmLabel: "Clear role",
              destructive: true,
            },
      ))
    )
      return;
    await action(
      `member-role-${person.id}`,
      async () => {
        try {
          await requestJson(team.id, "/api/v1/teams/member-roles", {
            method: "POST",
            body: JSON.stringify({ userId: person.userId, roleObjectId }),
          });
        } catch (e) {
          // The service's own words: the role may be saved even when the team role is not.
          throw e instanceof ClientError ? new Error(e.message) : e;
        } finally {
          memberRoles.refresh();
          await load();
        }
        if (person.userId === user.id) window.location.reload();
      },
      roleObjectId ? "Configured role saved." : "Configured role cleared.",
    );
    // The row's control is replaced with the new assignment, so focus moves to the outcome.
    setOutcomeFocus((count) => count + 1);
  }
  async function removeMember(person: TeamMember) {
    if (
      !team ||
      !(await confirm({
        title: "Remove member?",
        message: `Remove ${person.user.name} from ${team.name}? Their team access and API tokens will stop working.`,
        confirmLabel: "Remove member",
        destructive: true,
      }))
    )
      return;
    await action(
      `remove-${person.id}`,
      async () => {
        const result = await authClient.organization.removeMember({
          memberIdOrEmail: person.id,
          organizationId: team.id,
        });
        ensure(result);
        if (person.userId === user.id)
          window.location.assign("/app/settings/team");
        else await load();
      },
      "Member removed.",
    );
  }
  async function resetTwoStep(person: TeamMember) {
    if (
      !team ||
      !(await confirm({
        title: "Reset two-step sign-in?",
        message: `Reset ${person.user.name}'s two-step sign-in? Their authenticator key and backup codes stop working, they are signed out everywhere and their trusted devices are forgotten. If their role requires it, they must set it up again at their next sign-in.`,
        confirmLabel: "Reset two-step sign-in",
        destructive: true,
      }))
    )
      return;
    await action(
      `two-step-${person.id}`,
      async () => {
        await requestJson(team.id, "/api/v1/teams/two-step-reset", {
          method: "POST",
          body: JSON.stringify({ userId: person.userId }),
        });
      },
      `${person.user.name}'s two-step sign-in was reset. They have been signed out everywhere.`,
    );
  }
  const ownerCount =
    details?.members.filter((person) => person.role === "owner").length ?? 0;
  const selectableRoles: TeamRole[] =
    role === "owner"
      ? ["owner", "admin", "recruiter", "viewer"]
      : ["admin", "recruiter", "viewer"];
  return (
    <div className="stack settings-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Workspace settings</p>
          <h1>Team & access</h1>
          <p className="muted">
            Keep recruitment records, CVs and collaboration inside the right
            team.
          </p>
        </div>
        <Users size={28} aria-hidden="true" />
      </header>
      <SettingsNavigation active="team" role={role} />
      {error && (
        <div ref={outcome} tabIndex={-1} className="notice error" role="alert">
          {error} Your unsaved fields are retained.
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
      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Your teams</h2>
          <button
            className="button secondary"
            type="button"
            disabled={loading || !!busy}
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            <RefreshCw size={16} aria-hidden="true" />
            Refresh
          </button>
        </div>
        {loading ? (
          <p role="status">Loading teams…</p>
        ) : teams.length === 0 ? (
          <p className="muted">
            {canCreateTeam
              ? "You have not joined a team yet. Create your first workspace below, or accept an email invitation."
              : "You have not joined a team yet. Accept the email invitation from your team owner."}
          </p>
        ) : (
          <div className="form-grid">
            {teams.map((item) => (
              <div
                key={item.id}
                style={{
                  border: "1px solid var(--border, #e2e4eb)",
                  borderRadius: 10,
                  padding: 16,
                }}
              >
                <div className="row">
                  <Building2 size={20} aria-hidden="true" />
                  <strong>{item.name}</strong>
                  {team?.id === item.id && (
                    <span className="badge">Current team</span>
                  )}
                </div>
                <p className="muted">{item.slug}</p>
                <button
                  type="button"
                  className="button secondary"
                  disabled={team?.id === item.id || !!busy}
                  onClick={() => void switchTeam(item.id)}
                >
                  {busy === `switch-${item.id}`
                    ? "Switching…"
                    : team?.id === item.id
                      ? "Selected"
                      : "Open team"}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      {team && (
        <>
          <section className="panel">
            <h2>{team.name}</h2>
            <p className="muted">
              Your role: <strong>{role}</strong>.{" "}
              {role && role in roleDescriptions
                ? roleDescriptions[role as TeamRole]
                : ""}
            </p>
            {canAdmin ? (
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
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!!busy}
                    onClick={() =>
                      void action(
                        "bootstrap",
                        async () => {
                          await requestJson(
                            team.id,
                            "/api/v1/teams/bootstrap",
                            { method: "POST" },
                          );
                        },
                        "Task board prepared. Existing tasks and buckets were kept.",
                      )
                    }
                  >
                    Prepare task board
                  </button>
                </div>
              </form>
            ) : (
              <p>
                You can view team membership. An owner or admin can change
                access and invitations.
              </p>
            )}
          </section>
          <section className="panel">
            <h2>Members</h2>
            <p className="muted">
              At least one owner must remain. Access changes also apply to each
              member’s API tokens.
            </p>
            {companyOwner && (
              <ConfiguredRolesNotice error={memberRoles.error} />
            )}
            {!details ? (
              <p>
                {loading
                  ? "Loading members…"
                  : "Team details are unavailable. Refresh to try again."}
              </p>
            ) : (
              <div className="table-wrap">
                <table className="data-table settings-table">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Role</th>
                      {companyOwner && <th>Configured role</th>}
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.members.map((person) => {
                      const lastOwner =
                        person.role === "owner" && ownerCount <= 1;
                      const canEdit =
                        canAdmin &&
                        (role === "owner" || person.role !== "owner");
                      return (
                        <tr key={person.id}>
                          <td>
                            <strong>{person.user.name}</strong>
                            {person.userId === user.id && " (you)"}
                            <br />
                            <span className="muted">{person.user.email}</span>
                          </td>
                          <td>
                            {canEdit ? (
                              <label className="field">
                                <span className="sr-only">
                                  Role for {person.user.name}
                                </span>
                                <select
                                  value={roleDrafts[person.id] || person.role}
                                  disabled={!!busy || lastOwner}
                                  onChange={(e) =>
                                    setRoleDrafts((previous) => ({
                                      ...previous,
                                      [person.id]: e.target.value as TeamRole,
                                    }))
                                  }
                                >
                                  {selectableRoles.map((value) => (
                                    <option key={value} value={value}>
                                      {value}
                                    </option>
                                  ))}
                                </select>
                                {lastOwner && (
                                  <small className="muted">Last owner</small>
                                )}
                              </label>
                            ) : (
                              <span className="badge">{person.role}</span>
                            )}
                          </td>
                          {companyOwner && (
                            <td>
                              {memberRoles.data ? (
                                <MemberRoleControl
                                  key={JSON.stringify(assignmentOf(person))}
                                  name={person.user.name}
                                  teamOwner={person.role === "owner"}
                                  assignment={assignmentOf(person)}
                                  roles={memberRoles.data.data.roles}
                                  busy={!!busy}
                                  onSave={(roleObjectId) =>
                                    void saveMemberRole(person, roleObjectId)
                                  }
                                />
                              ) : (
                                !memberRoles.error && (
                                  <span role="status">Loading…</span>
                                )
                              )}
                            </td>
                          )}
                          <td>
                            <MemberActions
                              canEdit={canEdit}
                              canResetTwoStep={canResetTwoStep(
                                role,
                                person.userId,
                                user.id,
                              )}
                              busy={!!busy}
                              saveDisabled={
                                lastOwner ||
                                !roleDrafts[person.id] ||
                                roleDrafts[person.id] === person.role
                              }
                              removeDisabled={lastOwner}
                              onSave={() => void changeRole(person)}
                              onRemove={() => void removeMember(person)}
                              onResetTwoStep={() => void resetTwoStep(person)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          {canAdmin && (
            <section className="panel">
              <h2>
                <UserPlus
                  size={20}
                  aria-hidden="true"
                  style={{ verticalAlign: "middle" }}
                />{" "}
                Invite a colleague
              </h2>
              <p className="muted">
                Invitation links are emailed to the named recipient. They must
                sign in with a verified account using that email.
              </p>
              <form className="stack" onSubmit={invite}>
                <div className="form-grid">
                  <label className="field">
                    <span>Email address</span>
                    <input
                      type="email"
                      required
                      maxLength={320}
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      autoComplete="email"
                    />
                  </label>
                  <label className="field">
                    <span>Team role</span>
                    <select
                      value={inviteRole}
                      onChange={(e) =>
                        setInviteRole(e.target.value as TeamRole)
                      }
                    >
                      {selectableRoles.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                    <small className="muted">
                      {roleDescriptions[inviteRole]}
                    </small>
                  </label>
                </div>
                <div>
                  <button type="submit" className="button" disabled={!!busy}>
                    {busy === "invite"
                      ? "Sending invitation…"
                      : "Send invitation"}
                  </button>
                </div>
              </form>
              {details && (
                <>
                  <h3 style={{ marginTop: 24 }}>Pending invitations</h3>
                  {details.invitations.filter(
                    (item) => item.status === "pending",
                  ).length === 0 ? (
                    <p className="muted">No pending invitations.</p>
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table settings-table">
                        <thead>
                          <tr>
                            <th>Email</th>
                            <th>Role</th>
                            <th>Expires</th>
                            <th>
                              <span className="sr-only">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {details.invitations
                            .filter((item) => item.status === "pending")
                            .map((item) => (
                              <tr key={item.id}>
                                <td>{item.email}</td>
                                <td>{item.role}</td>
                                <td>{formatDate(item.expiresAt)}</td>
                                <td>
                                  <button
                                    className="button secondary"
                                    type="button"
                                    disabled={!!busy}
                                    onClick={() =>
                                      void action(
                                        `cancel-${item.id}`,
                                        async () => {
                                          const result =
                                            await authClient.organization.cancelInvitation(
                                              { invitationId: item.id },
                                            );
                                          ensure(result);
                                          await load();
                                        },
                                        "Invitation cancelled.",
                                      )
                                    }
                                  >
                                    Cancel invitation
                                  </button>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </section>
          )}
          {canAdmin && <StorageSettings busy={busy} onAction={action} />}
        </>
      )}
      <CreateTeam
        busy={busy}
        onAction={action}
        onBootstrapFailed={async (message) => {
          setError(message);
          await load();
        }}
      />
      {dialog}
    </div>
  );
}
