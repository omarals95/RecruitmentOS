"use client";

import Link from "next/link";
import { useCallback, useState, type FormEvent } from "react";
import { Laptop, LockKeyhole, RefreshCw, UserRound } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { humanError, useWorkspace } from "@/components/workspace/client";
import { formatDate } from "@/components/workspace/helpers";
import { SettingsNavigation } from "./settings-navigation";

interface SessionItem {
  id: string;
  token: string;
  createdAt: Date | string;
  expiresAt: Date | string;
  ipAddress?: string | null;
  userAgent?: string | null;
}
function ensure(result: { error?: { message?: string } | null }) {
  if (result.error)
    throw new Error(
      result.error.message || "The action could not be completed.",
    );
}
/** Listing devices needs a recent sign-in; that refusal is explained inline, not as a failure. */
export function deviceListMessage(
  error?: { code?: string; status?: number } | null,
) {
  return error?.code === "SESSION_NOT_FRESH"
    ? "For your security, the device list needs a recent sign-in. Sign out and sign in again to view your devices."
    : null;
}

export function ProfileSettings({
  providers,
}: {
  providers: { google: boolean; microsoft: boolean };
}) {
  const { user } = useWorkspace();
  const [name, setName] = useState(user.name);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [currentSession, setCurrentSession] = useState("");
  const [devices, setDevices] = useState<"hidden" | "loading" | "shown">(
    "hidden",
  );
  const [devicesMessage, setDevicesMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setDevices("loading");
    setDevicesMessage("");
    try {
      const results = await Promise.all([
        authClient.listSessions(),
        authClient.getSession(),
      ]);
      const message = deviceListMessage(results[0].error);
      if (message) {
        setSessions([]);
        setDevicesMessage(message);
        return;
      }
      ensure(results[0]);
      ensure(results[1]);
      setSessions((results[0].data as SessionItem[]) ?? []);
      setCurrentSession(results[1].data?.session.id ?? "");
    } catch (e) {
      setError(humanError(e));
    } finally {
      setDevices("shown");
    }
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
  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await action(
      "name",
      async () => {
        const result = await authClient.updateUser({ name: name.trim() });
        ensure(result);
        window.location.reload();
      },
      "Profile saved.",
    );
  }
  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("The new passwords do not match.");
      return;
    }
    await action(
      "password",
      async () => {
        const result = await authClient.changePassword({
          currentPassword,
          newPassword,
          revokeOtherSessions: true,
        });
        ensure(result);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        if (devices === "shown") await load();
      },
      "Password changed. Other sessions have been signed out.",
    );
  }
  async function revokeSession(session: SessionItem) {
    if (
      session.id === currentSession ||
      !window.confirm("Sign out this device?")
    )
      return;
    await action(
      session.id,
      async () => {
        const result = await authClient.revokeSession({ token: session.token });
        ensure(result);
        await load();
      },
      "Device signed out.",
    );
  }
  return (
    <div className="stack settings-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Workspace settings</p>
          <h1>My profile</h1>
          <p className="muted">Manage your account and signed-in devices.</p>
        </div>
        <UserRound size={28} aria-hidden="true" />
      </header>
      <SettingsNavigation active="profile" />
      {error && (
        <div className="notice error" role="alert">
          {error} Your unsaved form is retained.
        </div>
      )}
      {notice && (
        <div className="notice success" role="status">
          {notice}
        </div>
      )}
      <section className="panel">
        <h2>Account details</h2>
        <form className="stack" onSubmit={saveName}>
          <div className="form-grid">
            <label className="field">
              <span>Full name</span>
              <input
                required
                minLength={1}
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            </label>
            <label className="field">
              <span>Verified email</span>
              <input
                type="email"
                value={user.email}
                readOnly
                autoComplete="email"
              />
              <small className="muted">
                Your verified email identifies team invitations.
              </small>
            </label>
          </div>
          <div>
            <button
              className="button"
              type="submit"
              disabled={!!busy || name.trim() === user.name}
            >
              {busy === "name" ? "Saving…" : "Save profile"}
            </button>
          </div>
        </form>
      </section>
      <section className="panel">
        <h2>
          <LockKeyhole
            size={20}
            aria-hidden="true"
            style={{ verticalAlign: "middle" }}
          />{" "}
          Change password
        </h2>
        <p className="muted">
          Use at least 12 characters. Changing your password signs out other
          devices.
        </p>
        <form className="stack" onSubmit={savePassword}>
          <label className="field">
            <span>Current password</span>
            <input
              required
              type="password"
              autoComplete="current-password"
              maxLength={128}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </label>
          <div className="form-grid">
            <label className="field">
              <span>New password</span>
              <input
                required
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Confirm new password</span>
              <input
                required
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
          </div>
          <div>
            <button type="submit" className="button" disabled={!!busy}>
              {busy === "password" ? "Changing password…" : "Change password"}
            </button>
          </div>
        </form>
        <p className="muted">
          Signed up through Google or Microsoft without a password?{" "}
          <Link href="/forgot-password">Use password reset</Link> to establish
          one through your verified email.
        </p>
      </section>
      <section className="panel">
        <h2>Sign-in methods</h2>
        <p>
          Email and password sign-in is available.{" "}
          {providers.google
            ? "Google sign-in is configured."
            : "Google sign-in is not configured."}{" "}
          {providers.microsoft
            ? "Microsoft sign-in is configured."
            : "Microsoft sign-in is not configured."}
        </p>
        <p className="muted">
          Accounts are not silently linked by matching email addresses. Provider
          credentials are configured by the deployment administrator.
        </p>
      </section>
      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2>
              <Laptop
                size={20}
                aria-hidden="true"
                style={{ verticalAlign: "middle" }}
              />{" "}
              Signed-in devices
            </h2>
            <p className="muted">Only sessions for your account appear here.</p>
          </div>
          {devices !== "hidden" && (
            <button
              className="button secondary"
              type="button"
              disabled={!!busy || devices === "loading"}
              onClick={() => void load()}
            >
              <RefreshCw size={16} aria-hidden="true" />
              Refresh
            </button>
          )}
        </div>
        {devices === "hidden" ? (
          <button
            className="button secondary"
            type="button"
            disabled={!!busy}
            onClick={() => void load()}
          >
            Show signed-in devices
          </button>
        ) : devices === "loading" ? (
          <p role="status">Loading devices…</p>
        ) : devicesMessage ? (
          <p className="muted" role="status">
            {devicesMessage}
          </p>
        ) : sessions.length === 0 ? (
          <p className="muted">No active device sessions were returned.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table settings-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Signed in</th>
                  <th>Expires</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td>
                      <strong>
                        {session.id === currentSession
                          ? "This device"
                          : "Other device"}
                      </strong>
                      <br />
                      <span
                        className="muted"
                        style={{
                          display: "inline-block",
                          maxWidth: 420,
                          overflowWrap: "anywhere",
                        }}
                      >
                        {session.userAgent || "Device information unavailable"}
                      </span>
                      {session.ipAddress && (
                        <>
                          <br />
                          <small className="muted">{session.ipAddress}</small>
                        </>
                      )}
                    </td>
                    <td>{formatDate(session.createdAt, true)}</td>
                    <td>{formatDate(session.expiresAt, true)}</td>
                    <td>
                      {session.id !== currentSession && (
                        <button
                          className="button secondary"
                          type="button"
                          disabled={!!busy}
                          onClick={() => void revokeSession(session)}
                        >
                          Sign out device
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="button secondary"
            disabled={!!busy}
            onClick={() =>
              void action(
                "others",
                async () => {
                  const result = await authClient.revokeOtherSessions();
                  ensure(result);
                  if (devices === "shown") await load();
                },
                "All other devices signed out.",
              )
            }
          >
            Sign out all other devices
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!!busy}
            onClick={() =>
              void action(
                "signout",
                async () => {
                  const result = await authClient.signOut();
                  ensure(result);
                  window.location.assign("/sign-in");
                },
                "Signed out.",
              )
            }
          >
            Sign out
          </button>
        </div>
      </section>
    </div>
  );
}
