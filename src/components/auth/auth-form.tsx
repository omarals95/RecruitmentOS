"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import type { AuthOptions } from "@/lib/auth";

type Mode =
  | "sign-in"
  | "sign-up"
  | "create-admin"
  | "forgot-password"
  | "reset-password"
  | "verify-email"
  | "accept-invitation";
const headings: Record<Mode, [string, string]> = {
  "sign-in": ["Welcome back", "Sign in to your recruitment workspace."],
  "sign-up": [
    "Create your account",
    "Use the email address on your team invitation.",
  ],
  "create-admin": [
    "Create the first administrator",
    "Use the administrator email and setup token supplied by your deployment administrator. Verify your email, then create your team.",
  ],
  "forgot-password": [
    "Reset your password",
    "We'll send a secure reset link if an account is available.",
  ],
  "reset-password": [
    "Choose a new password",
    "Use at least 12 characters. Resetting signs out existing sessions.",
  ],
  "verify-email": [
    "Verify your email",
    "Check your inbox for a verification link before accessing team data.",
  ],
  "accept-invitation": [
    "Join your team",
    "Accept your invitation using the same verified email address.",
  ],
};

export function safeNext(value?: string) {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return "/app";
  const url = new URL(value, "https://recruitment.invalid");
  return url.origin === "https://recruitment.invalid" &&
    (url.pathname === "/app" ||
      url.pathname.startsWith("/app/") ||
      url.pathname === "/accept-invitation" ||
      url.pathname === "/oauth/authorize")
    ? `${url.pathname}${url.search}`
    : "/app";
}

export function AuthForm({
  mode,
  options,
  token,
  invitationId,
  next,
  initialError,
}: {
  mode: Mode;
  options: AuthOptions;
  token?: string;
  invitationId?: string;
  next?: string;
  initialError?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState(
    initialError
      ? "This link could not be verified. Request a new link below."
      : "",
  );
  const identity = authClient.useSession();
  const target = safeNext(next);
  const [title, description] = headings[mode];
  const inviteNext = invitationId
    ? `/accept-invitation?id=${encodeURIComponent(invitationId)}`
    : "/app";
  const action = async (
    work: () => Promise<{ error?: { message?: string | undefined } | null }>,
    success?: () => void,
  ) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await work();
      if (result.error)
        setError(
          result.error.message ||
            "Unable to complete this request. Please try again.",
        );
      else success?.();
    } catch {
      setError(
        "Connection interrupted. Check your connection before trying again.",
      );
    } finally {
      setBusy(false);
    }
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const setupTokenInput = event.currentTarget.elements.namedItem(
      "setupToken",
    ) as HTMLInputElement | null;
    const email = String(fields.get("email") ?? "").trim();
    const password = String(fields.get("password") ?? "");
    if (mode === "sign-in")
      return action(
        () => authClient.signIn.email({ email, password, callbackURL: target }),
        () => {
          window.location.assign(target);
        },
      );
    if (mode === "sign-up" || mode === "create-admin")
      return action(
        () =>
          authClient.signUp.email(
            {
              name: String(fields.get("name") ?? "").trim(),
              email,
              password,
              callbackURL: `/sign-in?next=${encodeURIComponent(target)}`,
            },
            mode === "create-admin"
              ? {
                  headers: {
                    "x-bootstrap-token": String(fields.get("setupToken") ?? ""),
                  },
                }
              : undefined,
          ),
        () => {
          if (setupTokenInput) setupTokenInput.value = "";
          setNotice(
            "Check your email for a verification link. If you already have an account, sign in or reset your password.",
          );
        },
      );
    if (mode === "forgot-password")
      return action(
        () =>
          authClient.requestPasswordReset({
            email,
            redirectTo: `${window.location.origin}/reset-password`,
          }),
        () =>
          setNotice(
            "If an account is available, a reset link will arrive shortly. Check your spam folder too.",
          ),
      );
    if (mode === "reset-password") {
      if (password !== String(fields.get("confirmPassword") ?? ""))
        return setError("The passwords do not match.");
      return action(
        () =>
          authClient.resetPassword({
            newPassword: password,
            token: token ?? "",
          }),
        () =>
          setNotice(
            "Your password has been reset. Sign in with your new password.",
          ),
      );
    }
    if (mode === "verify-email")
      return action(
        () =>
          authClient.sendVerificationEmail({ email, callbackURL: "/sign-in" }),
        () =>
          setNotice(
            "If verification is available, a new link will arrive shortly.",
          ),
      );
  }
  const socialSignIn = (provider: "google" | "microsoft") =>
    action(() =>
      authClient.signIn.social({
        provider,
        callbackURL: target,
        errorCallbackURL: "/sign-in?error=provider",
      }),
    );
  return (
    <main className="auth-shell">
      <div className="auth-card">
        <Link href="/" className="auth-brand">
          <span aria-hidden="true">
            <ShieldCheck size={24} />
          </span>
          RecruitmentOS
        </Link>
        <header className="auth-header">
          <p className="eyebrow">YOUR RECRUITMENT WORKSPACE</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </header>
        {!options.configured && (
          <div className="auth-notice" role="status">
            <strong>Setup required</strong>
            <p>
              Your administrator needs to configure the database, authentication
              secret, app URL, and email delivery before sign-in is available.
            </p>
          </div>
        )}
        {mode === "create-admin" &&
          options.configured &&
          !options.bootstrapConfigured && (
            <div className="auth-notice" role="status">
              The initial administrator email and setup token must be configured
              by the deployment administrator.
            </div>
          )}
        {error && (
          <div className="auth-notice auth-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="auth-notice auth-success" role="status">
            {notice}
          </div>
        )}
        {mode === "accept-invitation" ? (
          <div className="auth-form">
            {!invitationId ? (
              <p>
                This invitation link is incomplete. Ask your team administrator
                for a new invitation.
              </p>
            ) : identity.isPending ? (
              <p role="status">Checking your account…</p>
            ) : !identity.data ? (
              <>
                <Link
                  className="button"
                  href={`/sign-in?next=${encodeURIComponent(inviteNext)}`}
                >
                  Sign in to accept
                </Link>
                <Link
                  className="button secondary"
                  href={`/sign-up?next=${encodeURIComponent(inviteNext)}`}
                >
                  Create an invited account
                </Link>
              </>
            ) : !identity.data.user.emailVerified ? (
              <>
                <p>
                  Verify {identity.data.user.email} before joining this team.
                </p>
                <Link className="button" href="/verify-email">
                  Verify email
                </Link>
              </>
            ) : (
              <>
                <p>
                  Signed in as <strong>{identity.data.user.email}</strong>. This
                  must match your invitation.
                </p>
                <button
                  className="button"
                  disabled={busy || !options.configured}
                  onClick={() =>
                    void action(
                      () =>
                        authClient.organization.acceptInvitation({
                          invitationId,
                        }),
                      () => {
                        window.location.assign("/app/settings/team");
                      },
                    )
                  }
                >
                  {busy ? "Joining…" : "Accept invitation"}
                  <ArrowRight size={16} />
                </button>
              </>
            )}
          </div>
        ) : (
          <form className="auth-form" onSubmit={(event) => void submit(event)}>
            {(mode === "sign-up" || mode === "create-admin") && (
              <label className="auth-field">
                Full name
                <input
                  name="name"
                  autoComplete="name"
                  maxLength={120}
                  required
                  disabled={busy || !options.configured}
                />
              </label>
            )}
            {mode !== "reset-password" && (
              <label className="auth-field">
                Email address
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  maxLength={254}
                  defaultValue={
                    mode === "verify-email"
                      ? (identity.data?.user.email ?? "")
                      : ""
                  }
                  required
                  disabled={busy || !options.configured}
                />
              </label>
            )}
            {["sign-in", "sign-up", "create-admin", "reset-password"].includes(
              mode,
            ) && (
              <label className="auth-field">
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete={
                    mode === "sign-in" ? "current-password" : "new-password"
                  }
                  minLength={mode === "sign-in" ? undefined : 12}
                  maxLength={128}
                  required
                  disabled={busy || !options.configured}
                />
                {mode !== "sign-in" && <small>At least 12 characters.</small>}
              </label>
            )}
            {mode === "create-admin" && (
              <label className="auth-field">
                Setup token
                <input
                  name="setupToken"
                  type="password"
                  autoComplete="off"
                  minLength={43}
                  maxLength={128}
                  required
                  disabled={
                    busy || !options.configured || !options.bootstrapConfigured
                  }
                />
                <small>
                  Provided securely by your deployment administrator.
                </small>
              </label>
            )}
            {mode === "reset-password" && (
              <label className="auth-field">
                Confirm password
                <input
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                  disabled={busy || !options.configured}
                />
              </label>
            )}
            {mode === "reset-password" && !token && (
              <p role="alert">
                The reset token is missing.{" "}
                <Link href="/forgot-password">Request a new link</Link>.
              </p>
            )}
            <button
              className="button"
              disabled={
                busy ||
                !options.configured ||
                (mode === "create-admin" && !options.bootstrapConfigured) ||
                (mode === "reset-password" && !token)
              }
              type="submit"
            >
              {busy
                ? "Please wait…"
                : {
                    "sign-in": "Sign in",
                    "sign-up": "Create account",
                    "create-admin": "Create administrator",
                    "forgot-password": "Send reset link",
                    "reset-password": "Reset password",
                    "verify-email": "Resend verification link",
                  }[mode]}
              <ArrowRight size={16} />
            </button>
          </form>
        )}
        {["sign-in", "sign-up"].includes(mode) &&
          (options.google || options.microsoft) && (
            <div className="auth-social">
              <p>Or continue with</p>
              {options.google && (
                <button
                  className="button secondary"
                  disabled={busy || !options.configured}
                  onClick={() => void socialSignIn("google")}
                >
                  Google
                </button>
              )}
              {options.microsoft && (
                <button
                  className="button secondary"
                  disabled={busy || !options.configured}
                  onClick={() => void socialSignIn("microsoft")}
                >
                  Microsoft
                </button>
              )}
            </div>
          )}
        <footer className="auth-footer">
          {mode === "sign-in" ? (
            <>
              <Link href={`/sign-up?next=${encodeURIComponent(target)}`}>
                Create an invited account
              </Link>
              <Link href="/forgot-password">Forgot password?</Link>
              <Link href="/verify-email">Verify email</Link>
              <Link href="/create-admin">First-time administrator setup</Link>
            </>
          ) : (
            <Link href={`/sign-in?next=${encodeURIComponent(target)}`}>
              Back to sign in
            </Link>
          )}
        </footer>
        {mode === "sign-up" && !options.publicSignup && (
          <p className="auth-help">
            Registration is by invitation. The configured first administrator
            can also create an account.
          </p>
        )}
      </div>
      <aside className="auth-aside">
        <span className="auth-aside-mark" aria-hidden="true">
          R.
        </span>
        <h2>One place for your next great hire.</h2>
        <p>
          Your candidates, vacancies, recruitment workflow, and team, working
          together.
        </p>
        <div className="auth-trust">
          <ShieldCheck size={18} />
          Private workspaces. Access managed by your team.
        </div>
      </aside>
    </main>
  );
}
