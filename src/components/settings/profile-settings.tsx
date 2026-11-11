"use client";

import Link from "next/link";
import { useCallback, useState, type FormEvent } from "react";
import {
  Copy,
  Laptop,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { humanError, useWorkspace } from "@/components/workspace/client";
import { formatDate } from "@/components/workspace/helpers";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { SettingsNavigation, useAdminPortalLink } from "./settings-navigation";

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

/** Account settings panel: two-step sign-in state, new backup codes and turning it off. */
export function TwoStepPanel({
  enabled,
  required,
}: {
  enabled: boolean;
  required: boolean;
}) {
  const [password, setPassword] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { confirm, dialog } = useConfirm();
  async function run(
    key: string,
    work: () => Promise<{
      error?: { code?: string; status?: number; message?: string } | null;
    }>,
    done: () => void,
  ) {
    if (busy) return;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const result = await work();
      if (!result.error) done();
      else
        setError(
          deviceListMessage(result.error)
            ? "For your security, this needs a recent sign-in. Sign out and sign in again, then try again."
            : result.error.code === "INVALID_PASSWORD"
              ? "That password is not correct."
              : result.error.message ||
                "The action could not be completed. Please try again.",
        );
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy("");
    }
  }
  function createCodes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let created: string[] = [];
    void run(
      "codes",
      async () => {
        const result = await authClient.twoFactor.generateBackupCodes({
          password,
        });
        created = result.data?.backupCodes ?? [];
        return result;
      },
      () => {
        setPassword("");
        setCodes(created);
        setNotice(
          "New backup codes created. Your old codes and trusted devices no longer work.",
        );
      },
    );
  }
  async function turnOff() {
    if (
      !password ||
      !(await confirm({
        title: "Turn off two-step sign-in?",
        message: required
          ? "Owners and admins must use two-step sign-in, so you will be asked to set it up again straight away with a new authenticator key. Your backup codes and trusted devices stop working."
          : "Sign-in will ask only for your password. Your backup codes and trusted devices stop working, and you cannot create API tokens or connect apps until you turn it on again.",
        confirmLabel: "Turn off",
        destructive: true,
      }))
    ) {
      if (!password)
        setError("Enter your password to turn off two-step sign-in.");
      return;
    }
    await run(
      "off",
      () => authClient.twoFactor.disable({ password }),
      () => window.location.reload(),
    );
  }
  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setNotice("Backup codes copied.");
    } catch {
      setNotice(
        "Copy is unavailable in this browser. Write the codes down instead.",
      );
    }
  }
  return (
    <section className="panel" aria-labelledby="two-step-title">
      <h2 id="two-step-title">
        <ShieldCheck
          size={20}
          aria-hidden="true"
          style={{ verticalAlign: "middle" }}
        />{" "}
        Two-step sign-in
      </h2>
      <p>
        Status: <strong>{enabled ? "On" : "Off"}</strong>
      </p>
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
      {!enabled ? (
        <>
          <p className="muted">
            Sign-in asks for a code from an authenticator app as well as your
            password. Owners and admins must use it; everyone needs it to create
            API tokens or connect apps.
          </p>
          <div>
            <Link
              className="button"
              href="/two-step-setup?next=/app/settings/profile"
            >
              Turn on
            </Link>
          </div>
        </>
      ) : (
        <form className="stack" onSubmit={createCodes}>
          <p className="muted">
            Creating new backup codes or turning two-step sign-in off needs your
            password. Both forget your trusted devices.
          </p>
          <label className="field">
            <span>
              Password to create new backup codes or turn off two-step sign-in
            </span>
            <input
              required
              type="password"
              autoComplete="current-password"
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="row">
            <button type="submit" className="button" disabled={!!busy}>
              {busy === "codes" ? "Creating codes…" : "Create new backup codes"}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!!busy}
              onClick={() => void turnOff()}
            >
              {busy === "off" ? "Turning off…" : "Turn off"}
            </button>
          </div>
          {codes.length > 0 && (
            <div className="stack" aria-labelledby="new-backup-codes">
              <h3 id="new-backup-codes">Your new backup codes</h3>
              <p className="muted">
                Each code works once. They are shown only now.
              </p>
              <ul className="two-step-codes">
                {codes.map((code) => (
                  <li key={code}>
                    <code>{code}</code>
                  </li>
                ))}
              </ul>
              <div className="row">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void copyCodes()}
                >
                  <Copy size={16} aria-hidden="true" />
                  Copy backup codes
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setCodes([])}
                >
                  I have saved them
                </button>
              </div>
            </div>
          )}
        </form>
      )}
      {dialog}
    </section>
  );
}

export function ProfileSettings({
  providers,
}: {
  providers: { google: boolean; microsoft: boolean };
}) {
  const { user, role } = useWorkspace();
  const adminPortal = useAdminPortalLink();
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
  const { confirm, dialog } = useConfirm();
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
      !(await confirm({
        title: "Sign out device?",
        message: "Sign out this device?",
        confirmLabel: "Sign out device",
        destructive: true,
      }))
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
      <SettingsNavigation active="profile" adminPortal={adminPortal} />
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
      <TwoStepPanel
        enabled={user.twoStepEnabled}
        required={role === "owner" || role === "admin"}
      />
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
      {dialog}
    </div>
  );
}
