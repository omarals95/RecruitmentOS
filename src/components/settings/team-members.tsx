"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { UserPlus } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import type { MemberRoles } from "@/lib/member-roles";
import {
  ClientError,
  humanError,
  requestJson,
  useWorkspace,
} from "@/components/workspace/client";
import { formatDate } from "@/components/workspace/helpers";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ensure } from "./create-team";
import {
  REAUTH_CANCELLED,
  useFreshSession,
  type ReauthCancelled,
} from "./fresh-session-dialog";

export interface TeamMember {
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
interface TeamDetails {
  id: string;
  name: string;
  slug: string;
  members: TeamMember[];
  invitations: TeamInvitation[];
}
export type TeamRole = "owner" | "admin" | "recruiter" | "viewer";
export const roleDescriptions: Record<TeamRole, string> = {
  owner: "Full team administration and recruitment access",
  admin: "Manage members, recruitment and imports",
  recruiter: "Manage recruitment records and CVs",
  viewer: "Read-only recruitment access",
};

/** The Better Auth organization calls about one team; a parameter so tests can fake it. */
export type TeamClient = Pick<
  typeof authClient.organization,
  | "getFullOrganization"
  | "update"
  | "inviteMember"
  | "updateMemberRole"
  | "removeMember"
  | "cancelInvitation"
>;

/**
 * Every request about one team names that team, whichever team is active: Better Auth calls by
 * organizationId, API calls by X-Team-Id through requestJson.
 */
export function teamRequests(
  teamId: string,
  client: TeamClient = authClient.organization,
) {
  return {
    async details() {
      const result = await client.getFullOrganization({
        query: { organizationId: teamId },
      });
      ensure(result);
      return result.data as unknown as TeamDetails;
    },
    async rename(name: string) {
      ensure(await client.update({ organizationId: teamId, data: { name } }));
    },
    async invite(email: string, role: TeamRole) {
      ensure(
        await client.inviteMember({ email, role, organizationId: teamId }),
      );
    },
    async changeRole(memberId: string, role: TeamRole) {
      ensure(
        await client.updateMemberRole({
          memberId,
          role,
          organizationId: teamId,
        }),
      );
    },
    async remove(memberId: string) {
      ensure(
        await client.removeMember({
          memberIdOrEmail: memberId,
          organizationId: teamId,
        }),
      );
    },
    // Better Auth checks the invitation against its own team.
    async cancelInvitation(invitationId: string) {
      ensure(await client.cancelInvitation({ invitationId }));
    },
    memberRoles: () =>
      requestJson<{ data: MemberRoles }>(teamId, "/api/v1/teams/member-roles"),
    saveMemberRole: (userId: string, roleObjectId: string | null) =>
      requestJson(teamId, "/api/v1/teams/member-roles", {
        method: "POST",
        body: JSON.stringify({ userId, roleObjectId }),
      }),
    resetTwoStep: (userId: string) =>
      requestJson(teamId, "/api/v1/teams/two-step-reset", {
        method: "POST",
        body: JSON.stringify({ userId }),
      }),
  };
}

/** The team roles the caller may give: only an owner gives Owner. */
function rolesFor(role: string | null): TeamRole[] {
  return role === "owner"
    ? ["owner", "admin", "recruiter", "viewer"]
    : ["admin", "recruiter", "viewer"];
}

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

/** The members table of one team: team role, configured role (company owners only) and actions. */
export function MembersTable({
  members,
  userId,
  role,
  companyOwner,
  memberRoles,
  busy,
  roleDrafts,
  onDraft,
  onChangeRole,
  onRemove,
  onResetTwoStep,
  onSaveMemberRole,
}: {
  members: TeamMember[];
  /** The signed-in user, whose row says "(you)". */
  userId: string;
  /** The caller's team role in this team. */
  role: string | null;
  companyOwner: boolean;
  memberRoles: { data: MemberRoles | null; error: string };
  busy: boolean;
  roleDrafts: Record<string, TeamRole>;
  onDraft: (person: TeamMember, role: TeamRole) => void;
  onChangeRole: (person: TeamMember) => void;
  onRemove: (person: TeamMember) => void;
  onResetTwoStep: (person: TeamMember) => void;
  onSaveMemberRole: (person: TeamMember, roleObjectId: string | null) => void;
}) {
  const canAdmin = role === "owner" || role === "admin";
  const ownerCount = members.filter((person) => person.role === "owner").length;
  const selectableRoles = rolesFor(role);
  const assignmentOf = (person: TeamMember) =>
    memberRoles.data?.assignments.find(
      (item) => item.userId === person.userId,
    ) ?? null;
  return (
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
          {members.map((person) => {
            const lastOwner = person.role === "owner" && ownerCount <= 1;
            const canEdit =
              canAdmin && (role === "owner" || person.role !== "owner");
            return (
              <tr key={person.id}>
                <td>
                  <strong>{person.user.name}</strong>
                  {person.userId === userId && " (you)"}
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
                        disabled={busy || lastOwner}
                        onChange={(e) =>
                          onDraft(person, e.target.value as TeamRole)
                        }
                      >
                        {selectableRoles.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                      {lastOwner && <small className="muted">Last owner</small>}
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
                        roles={memberRoles.data.roles}
                        busy={busy}
                        onSave={(roleObjectId) =>
                          onSaveMemberRole(person, roleObjectId)
                        }
                      />
                    ) : (
                      !memberRoles.error && <span role="status">Loading…</span>
                    )}
                  </td>
                )}
                <td>
                  <MemberActions
                    canEdit={canEdit}
                    canResetTwoStep={canResetTwoStep(
                      role,
                      person.userId,
                      userId,
                    )}
                    busy={busy}
                    saveDisabled={
                      lastOwner ||
                      !roleDrafts[person.id] ||
                      roleDrafts[person.id] === person.role
                    }
                    removeDisabled={lastOwner}
                    onSave={() => onChangeRole(person)}
                    onRemove={() => onRemove(person)}
                    onResetTwoStep={() => onResetTwoStep(person)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One team's members and invitations, for Team & access (the active team) and the team detail
 * page (the team in its URL): every request names `team`. `role` is the caller's team role in it;
 * the Configured role column shows for a company owner only.
 */
export function TeamMembers({
  team,
  role,
  companyLevel,
}: {
  team: { id: string; name: string };
  role: string | null;
  companyLevel: string | null;
}) {
  const { user } = useWorkspace();
  const requests = useMemo(() => teamRequests(team.id), [team.id]);
  const [details, setDetails] = useState<TeamDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamRole>("recruiter");
  const [roleDrafts, setRoleDrafts] = useState<Record<string, TeamRole>>({});
  const { confirm, dialog } = useConfirm();
  const freshSession = useFreshSession();
  const canAdmin = role === "owner" || role === "admin";
  // Only a company owner assigns configured roles; nobody else requests them.
  const companyOwner = canAssignRoles(companyLevel);
  const [memberRoles, setMemberRoles] = useState<{
    data: MemberRoles | null;
    error: string;
  }>({ data: null, error: "" });
  const outcome = useRef<HTMLDivElement>(null);
  const [outcomeFocus, setOutcomeFocus] = useState(0);
  useEffect(() => {
    if (outcomeFocus) outcome.current?.focus();
  }, [outcomeFocus]);
  const load = useCallback(async () => {
    try {
      setDetails(await requests.details());
    } catch (e) {
      setError(humanError(e));
    } finally {
      setLoading(false);
    }
  }, [requests]);
  useEffect(() => {
    let active = true;
    requests
      .details()
      .then((full) => {
        if (active) setDetails(full);
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
  }, [requests]);
  const loadMemberRoles = useCallback(async () => {
    try {
      const result = await requests.memberRoles();
      setMemberRoles({ data: result.data, error: "" });
    } catch (e) {
      setMemberRoles((previous) => ({ ...previous, error: humanError(e) }));
    }
  }, [requests]);
  useEffect(() => {
    if (!companyOwner) return;
    let active = true;
    requests
      .memberRoles()
      .then((result) => {
        if (active) setMemberRoles({ data: result.data, error: "" });
      })
      .catch((e) => {
        if (active)
          setMemberRoles((previous) => ({
            ...previous,
            error: humanError(e),
          }));
      });
    return () => {
      active = false;
    };
  }, [requests, companyOwner]);

  async function action(
    key: string,
    work: () => Promise<void | ReauthCancelled>,
    message: string,
  ) {
    if (busy) return;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      // A cancelled re-authentication sent nothing: no notice and no error.
      if ((await work()) !== REAUTH_CANCELLED) setNotice(message);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy("");
    }
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await action(
      "invite",
      async () => {
        await requests.invite(inviteEmail.trim(), inviteRole);
        setInviteEmail("");
        await load();
      },
      "Invitation sent. The recipient must verify the invited email before joining.",
    );
  }
  async function changeRole(person: TeamMember) {
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
        await requests.changeRole(person.id, next);
        await load();
        if (person.userId === user.id) window.location.reload();
      },
      "Member role updated.",
    );
  }
  async function saveMemberRole(
    person: TeamMember,
    roleObjectId: string | null,
  ) {
    const chosen = memberRoles.data?.roles.find(
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
    let outcome: unknown;
    await action(
      `member-role-${person.id}`,
      async () => {
        try {
          outcome = await freshSession.withFreshSession(() =>
            requests.saveMemberRole(person.userId, roleObjectId),
          );
        } catch (e) {
          // The service's own words: the role may be saved even when the team role is not.
          throw e instanceof ClientError ? new Error(e.message) : e;
        } finally {
          // A cancelled re-authentication sent nothing, so the rows and the chosen role stay.
          if (outcome !== REAUTH_CANCELLED) {
            void loadMemberRoles();
            await load();
          }
        }
        if (outcome === REAUTH_CANCELLED) return REAUTH_CANCELLED;
        if (person.userId === user.id) window.location.reload();
      },
      roleObjectId ? "Configured role saved." : "Configured role cleared.",
    );
    // The row's control is replaced with the new assignment, so focus moves to the outcome.
    if (outcome !== REAUTH_CANCELLED) setOutcomeFocus((count) => count + 1);
  }
  async function removeMember(person: TeamMember) {
    if (
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
        await requests.remove(person.id);
        if (person.userId === user.id)
          window.location.assign("/app/settings/team");
        else await load();
      },
      "Member removed.",
    );
  }
  async function resetTwoStep(person: TeamMember) {
    if (
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
        const outcome = await freshSession.withFreshSession(() =>
          requests.resetTwoStep(person.userId),
        );
        if (outcome === REAUTH_CANCELLED) return REAUTH_CANCELLED;
      },
      `${person.user.name}'s two-step sign-in was reset. They have been signed out everywhere.`,
    );
  }
  const selectableRoles = rolesFor(role);
  return (
    <>
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
      {freshSession.dialog}
      <section className="panel">
        <h2>Members</h2>
        <p className="muted">
          At least one owner must remain. Access changes also apply to each
          member’s API tokens.
        </p>
        {companyOwner && <ConfiguredRolesNotice error={memberRoles.error} />}
        {!details ? (
          <p>
            {loading
              ? "Loading members…"
              : "Team details are unavailable. Refresh to try again."}
          </p>
        ) : (
          <MembersTable
            members={details.members}
            userId={user.id}
            role={role}
            companyOwner={companyOwner}
            memberRoles={memberRoles}
            busy={!!busy}
            roleDrafts={roleDrafts}
            onDraft={(person, next) =>
              setRoleDrafts((previous) => ({ ...previous, [person.id]: next }))
            }
            onChangeRole={(person) => void changeRole(person)}
            onRemove={(person) => void removeMember(person)}
            onResetTwoStep={(person) => void resetTwoStep(person)}
            onSaveMemberRole={(person, roleObjectId) =>
              void saveMemberRole(person, roleObjectId)
            }
          />
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
            Invitation links are emailed to the named recipient. They must sign
            in with a verified account using that email.
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
                  onChange={(e) => setInviteRole(e.target.value as TeamRole)}
                >
                  {selectableRoles.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <small className="muted">{roleDescriptions[inviteRole]}</small>
              </label>
            </div>
            <div>
              <button type="submit" className="button" disabled={!!busy}>
                {busy === "invite" ? "Sending invitation…" : "Send invitation"}
              </button>
            </div>
          </form>
          {details && (
            <>
              <h3 style={{ marginTop: 24 }}>Pending invitations</h3>
              {details.invitations.filter((item) => item.status === "pending")
                .length === 0 ? (
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
                                      await requests.cancelInvitation(item.id);
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
      {dialog}
    </>
  );
}
