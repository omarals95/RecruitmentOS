"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, RefreshCw, Users } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import {
  clearWorkspaceCache,
  humanError,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";
import type { MeAccess } from "./admin-portal";
import { CreateTeam, ensure } from "./create-team";
import { SettingsNavigation, useAdminPortalLink } from "./settings-navigation";
import { roleDescriptions, TeamMembers, type TeamRole } from "./team-members";

interface TeamSummary {
  id: string;
  name: string;
  slug: string;
}

/**
 * Team & access for people who are not an owner or admin of the current team, and for creating a
 * first team: the server sends owners and admins to the team detail page, which holds the rename,
 * Prepare task board and CV storage.
 */
export function TeamSettings() {
  const { team } = useWorkspace();
  return <TeamSettingsContent key={team?.id ?? "no-team"} />;
}

function TeamSettingsContent() {
  const { team, role, canCreateTeam } = useWorkspace();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const adminPortal = useAdminPortalLink();
  // The company level decides whether the members list shows the Configured role column.
  const me = useApi<{ data: MeAccess }>(team ? "/api/v1/me/access" : null);
  const load = useCallback(async () => {
    try {
      const teamResult = await authClient.organization.list();
      ensure(teamResult);
      setTeams((teamResult.data ?? []) as TeamSummary[]);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    authClient.organization
      .list()
      .then((list) => {
        ensure(list);
        if (active) setTeams((list.data ?? []) as TeamSummary[]);
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
  }, []);

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
      <SettingsNavigation adminPortal={adminPortal} />
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
            <p>
              You can view team membership. An owner or admin can change access
              and invitations.
            </p>
          </section>
          <TeamMembers
            team={team}
            role={role}
            companyLevel={me.data?.data.companyLevel ?? null}
          />
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
    </div>
  );
}
