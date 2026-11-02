"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Building2, Plus, RefreshCw, UserPlus, Users } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import {
  humanError,
  requestJson,
  useWorkspace,
} from "@/components/workspace/client";
import { SettingsNavigation } from "./settings-navigation";

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
function ensure(result: { error?: { message?: string } | null }) {
  if (result.error)
    throw new Error(
      result.error.message || "The action could not be completed.",
    );
}
function slugFor(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
}
const roleDescriptions: Record<TeamRole, string> = {
  owner: "Full team administration and recruitment access",
  admin: "Manage members, recruitment and imports",
  recruiter: "Manage recruitment records and CVs",
  viewer: "Read-only recruitment access",
};

export function TeamSettings() {
  const { team } = useWorkspace();
  return <TeamSettingsContent key={team?.id ?? "no-team"} />;
}

function TeamSettingsContent() {
  const { team, user, role } = useWorkspace();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [details, setDetails] = useState<TeamDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [teamName, setTeamName] = useState(team?.name || "");
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<TeamRole>("recruiter");
  const [roleDrafts, setRoleDrafts] = useState<Record<string, TeamRole>>({});
  const canAdmin = role === "owner" || role === "admin";
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
        window.location.assign("/app");
      },
      "Team selected.",
    );
  }
  async function createTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await action(
      "create",
      async () => {
        const created = await authClient.organization.create({
          name: newName.trim(),
          slug: newSlug.trim(),
        });
        ensure(created);
        if (!created.data?.id)
          throw new Error(
            "The team response was incomplete. Refresh your teams before trying again.",
          );
        const selected = await authClient.organization.setActive({
          organizationId: created.data.id,
        });
        ensure(selected);
        // Bootstrap is idempotent. If it fails, retain the created team and give a retry path.
        try {
          await requestJson(created.data.id, "/api/v1/teams/bootstrap", {
            method: "POST",
          });
        } catch {
          setError(
            "Your team was created, but default task buckets could not be prepared. Select the team and use “Prepare task board” to retry.",
          );
          await load();
          return;
        }
        window.location.assign("/app");
      },
      "Team created.",
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
      !window.confirm(
        `Change ${person.user.name} from ${person.role} to ${next}? This changes their access and API token permissions.`,
      )
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
  async function removeMember(person: TeamMember) {
    if (
      !team ||
      !window.confirm(
        `Remove ${person.user.name} from ${team.name}? Their team access and API tokens will stop working.`,
      )
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
      <SettingsNavigation active="team" />
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
            You have not joined a team yet. Create your first workspace below,
            or accept an email invitation.
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
                          <td>
                            {canEdit && (
                              <div className="row">
                                <button
                                  type="button"
                                  className="button secondary"
                                  disabled={
                                    !!busy ||
                                    lastOwner ||
                                    !roleDrafts[person.id] ||
                                    roleDrafts[person.id] === person.role
                                  }
                                  onClick={() => void changeRole(person)}
                                >
                                  Save role
                                </button>
                                <button
                                  type="button"
                                  className="button secondary"
                                  disabled={!!busy || lastOwner}
                                  onClick={() => void removeMember(person)}
                                >
                                  Remove
                                </button>
                              </div>
                            )}
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
                                <td>
                                  {new Date(
                                    item.expiresAt,
                                  ).toLocaleDateString()}
                                </td>
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
        </>
      )}
      <section className="panel">
        <h2>
          <Plus
            size={20}
            aria-hidden="true"
            style={{ verticalAlign: "middle" }}
          />{" "}
          Create a team
        </h2>
        <p className="muted">
          A separate team has its own candidate records, CVs, workflow and
          tokens. You can create up to five teams.
        </p>
        <form className="stack" onSubmit={createTeam}>
          <div className="form-grid">
            <label className="field">
              <span>Team name</span>
              <input
                required
                maxLength={100}
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                  if (!slugEdited) setNewSlug(slugFor(e.target.value));
                }}
                placeholder="e.g. Talent acquisition"
              />
            </label>
            <label className="field">
              <span>Team identifier</span>
              <input
                required
                minLength={2}
                maxLength={70}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                value={newSlug}
                onChange={(e) => {
                  setNewSlug(e.target.value);
                  setSlugEdited(true);
                }}
                placeholder="talent-acquisition"
              />
              <small className="muted">
                Lowercase letters, numbers and hyphens.
              </small>
            </label>
          </div>
          <div>
            <button type="submit" className="button" disabled={!!busy}>
              {busy === "create" ? "Creating team…" : "Create team"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
