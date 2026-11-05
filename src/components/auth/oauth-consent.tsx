"use client";

import { useState, type FormEvent } from "react";
import type { McpScope } from "@/lib/permissions";
import { mcpScopeDescriptions } from "@/lib/scope-descriptions";
import { humanError, requestJson } from "@/components/workspace/client";

export interface ConsentTeam {
  id: string;
  name: string;
  allowed: McpScope[];
}

export function OAuthConsent({
  client,
  teams,
  defaultTeamId,
  requested,
  params,
}: {
  client: { name: string; redirectHost: string };
  teams: ConsentTeam[];
  defaultTeamId: string;
  requested: McpScope[];
  params: Record<string, string>;
}) {
  const ticked = (teamId: string) => {
    const team = teams.find((item) => item.id === teamId);
    return requested.filter((scope) => team?.allowed.includes(scope));
  };
  const [teamId, setTeamId] = useState(defaultTeamId);
  const [selected, setSelected] = useState<McpScope[]>(() =>
    ticked(defaultTeamId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const allowed = teams.find((item) => item.id === teamId)?.allowed ?? [];

  async function decide(decision: "approve" | "deny") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await requestJson<{ data: { redirectTo: string } }>(
        teamId,
        "/api/oauth/consent",
        {
          method: "POST",
          body: JSON.stringify({
            ...params,
            scopes: decision === "approve" ? selected : [],
            decision,
          }),
        },
      );
      // The CSP allows forms to post only here, so the app is reached by navigation.
      window.location.assign(result.data.redirectTo);
    } catch (e) {
      setError(humanError(e));
      setBusy(false);
    }
  }
  function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void decide("approve");
  }
  return (
    <form className="auth-form" onSubmit={approve}>
      <p>
        <strong>{client.name}</strong>{" "}
        <span className="muted">(name supplied by the app)</span> wants to use
        RecruitmentOS with your account.
      </p>
      <p>
        After you decide, you return to <strong>{client.redirectHost}</strong>.
        Continue only if you started this connection there.
      </p>
      <div className="auth-field">
        <label htmlFor="consent-team">Team</label>
        <select
          id="consent-team"
          value={teamId}
          disabled={busy}
          onChange={(event) => {
            setTeamId(event.target.value);
            setSelected(ticked(event.target.value));
          }}
        >
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="stack" style={{ border: 0, padding: 0 }}>
        <legend>
          <strong>Permissions requested</strong>
        </legend>
        {requested.map((scope) =>
          allowed.includes(scope) ? (
            <label
              key={scope}
              style={{ display: "flex", alignItems: "flex-start", gap: 10 }}
            >
              <input
                type="checkbox"
                checked={selected.includes(scope)}
                disabled={busy}
                onChange={(event) =>
                  setSelected((previous) =>
                    event.target.checked
                      ? [...previous, scope]
                      : previous.filter((item) => item !== scope),
                  )
                }
              />
              <span>
                <strong>{scope}</strong>
                <br />
                <span className="muted">{mcpScopeDescriptions[scope]}</span>
              </span>
            </label>
          ) : (
            <p key={scope} className="muted" style={{ margin: 0 }}>
              <strong>{scope}</strong>: {mcpScopeDescriptions[scope]}. Not
              available to your role.
            </p>
          ),
        )}
      </fieldset>
      <p className="muted">
        Access follows your current role, lasts up to 30 days and can be revoked
        at any time in Settings → API tokens.
      </p>
      {error && (
        <div className="auth-notice auth-error" role="alert">
          {error}
        </div>
      )}
      <div className="row">
        <button
          type="submit"
          className="button"
          disabled={busy || selected.length === 0}
        >
          Approve
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void decide("deny")}
        >
          Deny
        </button>
      </div>
    </form>
  );
}
