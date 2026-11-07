"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { Copy, KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import { SCOPES, roleScopes, type Role, type Scope } from "@/lib/permissions";
import { scopeDescriptions } from "@/lib/scope-descriptions";
import type { TokenDto } from "@/lib/api-tokens";
import {
  humanError,
  isAbortError,
  requestJson,
  useWorkspace,
} from "@/components/workspace/client";
import { formatDate } from "@/components/workspace/helpers";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { SettingsNavigation } from "./settings-navigation";

const date = (value: string | null) =>
  value ? formatDate(value, true) : "Never";

export function TokenSettings() {
  const { team } = useWorkspace();
  return <TokenSettingsContent key={team?.id ?? "no-team"} />;
}

function TokenSettingsContent() {
  const { team, user, role } = useWorkspace();
  const [tokens, setTokens] = useState<TokenDto[]>([]);
  const [all, setAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [days, setDays] = useState(30);
  const [scopes, setScopes] = useState<Scope[]>(["candidates:read"]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [secret, setSecret] = useState("");
  const secretRef = useRef<HTMLTextAreaElement>(null);
  const [now, setNow] = useState(0);
  const { confirm, dialog } = useConfirm();
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );
  const admin = role === "owner" || role === "admin";
  const available =
    role && ["owner", "admin", "recruiter", "viewer"].includes(role)
      ? roleScopes(role as Role)
      : [];
  const refresh = useCallback(async () => {
    if (!team) return;
    try {
      const result = await requestJson<{ data: TokenDto[] }>(
        team.id,
        `/api/settings/tokens${all ? "?all=true" : ""}`,
      );
      setTokens(result.data);
      setNow(Date.now());
      setError("");
    } catch (e) {
      setError(humanError(e));
    } finally {
      setLoading(false);
    }
  }, [team, all]);
  useEffect(() => {
    let active = true;
    if (team)
      requestJson<{ data: TokenDto[] }>(
        team.id,
        `/api/settings/tokens${all ? "?all=true" : ""}`,
      )
        .then((result) => {
          if (active) {
            setTokens(result.data);
            setNow(Date.now());
            setError("");
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
  }, [team, all]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!team || busy) return;
    setBusy("create");
    setError("");
    setNotice("");
    try {
      const result = await requestJson<{ data: TokenDto; token: string }>(
        team.id,
        "/api/settings/tokens",
        {
          method: "POST",
          body: JSON.stringify({ name, scopes, expiresInDays: days }),
        },
      );
      setSecret(result.token);
      setTokens((previous) => [result.data, ...previous]);
      setName("");
      setNow(Date.now());
      setNotice(
        "Your token is ready. Copy it now; it cannot be displayed again.",
      );
      requestAnimationFrame(() => secretRef.current?.focus());
    } catch (e) {
      if (isAbortError(e)) return;
      setError(
        `${humanError(e)} If the connection was interrupted, refresh the token list before creating another token. Your form is retained.`,
      );
    } finally {
      setBusy("");
    }
  }
  async function revoke(token: TokenDto) {
    if (
      !team ||
      busy ||
      !(await confirm({
        title: "Revoke token?",
        message: `Revoke “${token.name}”? Integrations using this token will lose access.`,
        confirmLabel: "Revoke token",
        destructive: true,
      }))
    )
      return;
    setBusy(token.id);
    setError("");
    setNotice("");
    try {
      await requestJson(team.id, `/api/settings/tokens/${token.id}`, {
        method: "DELETE",
      });
      setTokens((previous) =>
        previous.map((item) =>
          item.id === token.id
            ? { ...item, revokedAt: new Date().toISOString() }
            : item,
        ),
      );
      setNotice("API token revoked.");
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy("");
    }
  }
  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      setNotice("Token copied. Store it in your integration’s secret store.");
    } catch {
      secretRef.current?.focus();
      secretRef.current?.select();
      setNotice(
        "Copy is unavailable in this browser. The token is selected for manual copying.",
      );
    }
  }
  return (
    <div className="stack settings-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Workspace settings</p>
          <h1>API tokens</h1>
          <p className="muted">
            Give your AI tools and integrations only the access they need.
          </p>
        </div>
        <KeyRound aria-hidden="true" size={28} />
      </header>
      <SettingsNavigation active="api-tokens" />
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice success" role="status">
          {notice}
        </div>
      )}
      {!team ? (
        <div className="panel">
          <h2>Select a team first</h2>
          <p>Every token belongs to one team and your user account.</p>
          <Link className="button" href="/app/settings/team">
            Create or select a team
          </Link>
        </div>
      ) : (
        <>
          {secret && (
            <section
              className="panel"
              aria-labelledby="new-token-title"
              style={{ borderColor: "var(--primary)" }}
            >
              <h2 id="new-token-title">Copy your token once</h2>
              <p>
                Save this secret somewhere secure. It will disappear when you
                leave this page.
              </p>
              <label className="field">
                <span>New API token</span>
                <textarea
                  ref={secretRef}
                  value={secret}
                  readOnly
                  rows={2}
                  spellCheck={false}
                  autoComplete="off"
                  style={{ fontFamily: "monospace", overflowWrap: "anywhere" }}
                />
              </label>
              <div className="row">
                <button
                  className="button"
                  type="button"
                  onClick={() => void copySecret()}
                >
                  <Copy size={16} aria-hidden="true" />
                  Copy token
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setSecret("")}
                >
                  I have saved it
                </button>
              </div>
            </section>
          )}
          <section className="panel">
            <h2>Create a personal token</h2>
            <p className="muted">
              Team: <strong>{team.name}</strong>. Access follows your current
              role and stops if your membership is removed. Default expiry is 30
              days.
            </p>
            <form className="stack" onSubmit={create}>
              <div className="form-grid">
                <label className="field">
                  <span>Token name</span>
                  <input
                    required
                    maxLength={100}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Candidate import assistant"
                    autoComplete="off"
                  />
                </label>
                <label className="field">
                  <span>Expires in days</span>
                  <input
                    required
                    type="number"
                    min={1}
                    max={365}
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                  />
                </label>
              </div>
              <fieldset
                style={{
                  border: "1px solid var(--border, #e2e4eb)",
                  borderRadius: 10,
                  padding: 16,
                }}
              >
                <legend>Permissions</legend>
                <div className="form-grid">
                  {SCOPES.filter((scope) => available.includes(scope)).map(
                    (scope) => (
                      <label
                        key={scope}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 10,
                          padding: 8,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={scopes.includes(scope)}
                          onChange={(e) =>
                            setScopes((previous) =>
                              e.target.checked
                                ? [...previous, scope]
                                : previous.filter((item) => item !== scope),
                            )
                          }
                        />
                        <span>
                          <strong>{scope}</strong>
                          <br />
                          <span className="muted">
                            {scopeDescriptions[scope]}
                          </span>
                        </span>
                      </label>
                    ),
                  )}
                </div>
              </fieldset>
              <p className="muted">
                <ShieldCheck
                  size={16}
                  aria-hidden="true"
                  style={{ verticalAlign: "middle" }}
                />{" "}
                Tokens cannot administer users, teams, roles or other tokens.
                Read and write scopes are selected separately.
              </p>
              <div>
                <button
                  type="submit"
                  className="button"
                  disabled={!!busy || scopes.length === 0 || !!secret}
                >
                  {busy === "create" ? "Creating token…" : "Create token"}
                </button>
                {secret && (
                  <span className="muted">
                    {" "}
                    Save and dismiss the previous token before creating another.
                  </span>
                )}
              </div>
            </form>
          </section>
          <section className="panel">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <h2>{all ? "Team tokens" : "My tokens"}</h2>
                <p className="muted">
                  Revoked and expired tokens remain visible for reference.
                </p>
              </div>
              <div className="row">
                {admin && (
                  <label>
                    <input
                      type="checkbox"
                      checked={all}
                      onChange={(e) => {
                        setLoading(true);
                        setAll(e.target.checked);
                      }}
                    />{" "}
                    Show all team tokens
                  </label>
                )}
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => {
                    setLoading(true);
                    void refresh();
                  }}
                  disabled={loading}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                  Refresh
                </button>
              </div>
            </div>
            {loading ? (
              <p role="status">Loading tokens…</p>
            ) : tokens.length === 0 ? (
              <p className="muted">
                No tokens yet. Create one above when an integration needs
                access.
              </p>
            ) : (
              <div className="table-wrap">
                <table className="data-table settings-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      {all && <th>Owner</th>}
                      <th>Permissions</th>
                      <th>Expiry</th>
                      <th>Last used</th>
                      <th>Status</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.map((token) => {
                      const status = token.revokedAt
                        ? "Revoked"
                        : new Date(token.expiresAt).getTime() <= now
                          ? "Expired"
                          : "Active";
                      return (
                        <tr key={token.id}>
                          <td>
                            <strong>{token.name}</strong>
                            <br />
                            {token.oauthClient ? (
                              <span className="badge">OAuth app</span>
                            ) : (
                              <code>{token.prefix}…</code>
                            )}
                          </td>
                          {all && (
                            <td>
                              {token.userId === user.id ? "You" : token.userId}
                            </td>
                          )}
                          <td>
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: 4,
                              }}
                            >
                              {token.scopes.map((scope) => (
                                <span key={scope} className="badge">
                                  {scope}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td>{date(token.expiresAt)}</td>
                          <td>{date(token.lastUsedAt)}</td>
                          <td>
                            <span className="badge">{status}</span>
                          </td>
                          <td>
                            {status === "Active" && (
                              <button
                                type="button"
                                className="button secondary"
                                disabled={!!busy}
                                onClick={() => void revoke(token)}
                              >
                                {busy === token.id ? "Revoking…" : "Revoke"}
                              </button>
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
          <section className="panel">
            <h2>Connect an AI tool or integration</h2>
            <p>
              Use the deployed HTTPS URL. Send your token as an Authorization
              header; never paste it into a URL or a prompt.
            </p>
            <pre
              style={{
                overflowX: "auto",
                padding: 16,
                background: "var(--surface-subtle)",
                borderRadius: 8,
              }}
            >{`GET /api/v1/candidates?page=1&pageSize=25\nAuthorization: Bearer <your-token>`}</pre>
            <p>
              For a new candidate, send JSON to{" "}
              <code>POST /api/v1/candidates</code> with{" "}
              <code>candidates:write</code> and a stable{" "}
              <code>Idempotency-Key</code>. CVs use a three-step private upload:
              reserve an upload, send the file to the configured private
              storage, then complete validation.
            </p>
            <p>
              AI assistants such as Claude connect to{" "}
              <code>{origin}/api/mcp</code>, either with an API token sent as an
              Authorization header (Claude Code) or by signing in through the
              connector (Claude.ai). Connected apps appear in this list.
            </p>
            <a
              className="button secondary"
              href="/api/openapi.json"
              target="_blank"
              rel="noreferrer"
            >
              Open API reference
            </a>
          </section>
        </>
      )}
      {dialog}
    </div>
  );
}
