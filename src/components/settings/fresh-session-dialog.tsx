"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { authClient } from "@/lib/auth-client";
import { ClientError, useWorkspace } from "@/components/workspace/client";
import { Dialog } from "@/components/ui/dialog";

/** What `withFreshSession` resolves to when the user cancels re-authentication. */
export const REAUTH_CANCELLED = "cancelled";
export type ReauthCancelled = typeof REAUTH_CANCELLED;

/**
 * Runs the request; when the server answers 403 SESSION_NOT_FRESH it asks for re-authentication
 * and, once that succeeds, runs the same request once more and returns or throws its result.
 * Cancelling resolves to REAUTH_CANCELLED without a second request; other errors are rethrown.
 */
export async function retryWithFreshSession<T>(
  request: () => Promise<T>,
  reauthenticate: () => Promise<boolean>,
): Promise<T | ReauthCancelled> {
  try {
    return await request();
  } catch (error) {
    if (
      !(error instanceof ClientError) ||
      error.status !== 403 ||
      error.code !== "SESSION_NOT_FRESH"
    )
      throw error;
  }
  if (!(await reauthenticate())) return REAUTH_CANCELLED;
  return request();
}

type AuthResult = {
  data?: unknown;
  error?: { code?: string; status?: number; message?: string } | null;
};
/** The Better Auth client calls re-authentication makes; a parameter so tests can fake it. */
export type ReauthClient = {
  signIn: {
    email: (body: { email: string; password: string }) => Promise<AuthResult>;
  };
  twoFactor: {
    verifyTotp: (body: {
      code: string;
      trustDevice: boolean;
    }) => Promise<AuthResult>;
  };
  organization: {
    setActive: (body: { organizationId: string }) => Promise<AuthResult>;
  };
};
export type ReauthError = {
  message: string;
  /** The field the error is about; general errors describe both. */
  field?: "password" | "code";
  /** The code challenge has ended; show the Go to sign-in link. */
  signInAgain?: boolean;
};
export type ReauthOutcome =
  { done: true } | { done: false; challenged: boolean; error: ReauthError };

function reauthError(error: NonNullable<AuthResult["error"]>): ReauthError {
  const code = error.code;
  if (code === "INVALID_EMAIL_OR_PASSWORD" || code === "INVALID_PASSWORD")
    return { message: "That password is not correct.", field: "password" };
  if (code === "INVALID_CODE")
    return { message: "That code is not correct.", field: "code" };
  if (
    code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" ||
    code === "INVALID_TWO_FACTOR_COOKIE"
  )
    return { message: "Sign in again.", signInAgain: true };
  if (code === "ACCOUNT_TEMPORARILY_LOCKED")
    return {
      message: "Too many incorrect codes. Try again in 15 minutes.",
    };
  if (error.status === 429)
    return {
      message:
        error.message || "Too many attempts. Wait a few seconds and try again.",
    };
  return {
    message: error.message || "Your sign-in could not be checked. Try again.",
  };
}

/**
 * Better Auth's own sign-in, then its code check when it challenges for one (never trusting the
 * device), then the page's team on the new session. With `challenged` the password was already
 * accepted, so only the code is sent against the pending challenge.
 */
export async function reauthenticate(
  client: ReauthClient,
  input: {
    email: string;
    password: string;
    code: string;
    teamId: string;
    challenged: boolean;
  },
): Promise<ReauthOutcome> {
  let challenged = input.challenged;
  try {
    if (!challenged) {
      const signIn = await client.signIn.email({
        email: input.email,
        password: input.password,
      });
      if (signIn.error)
        return { done: false, challenged, error: reauthError(signIn.error) };
      const data = signIn.data as { twoFactorRedirect?: boolean } | null;
      challenged = Boolean(data?.twoFactorRedirect);
    }
    if (challenged) {
      const verified = await client.twoFactor.verifyTotp({
        code: input.code,
        trustDevice: false,
      });
      if (verified.error)
        return { done: false, challenged, error: reauthError(verified.error) };
      challenged = false;
    }
    const active = await client.organization.setActive({
      organizationId: input.teamId,
    });
    if (active.error)
      return { done: false, challenged, error: reauthError(active.error) };
    return { done: true };
  } catch {
    return {
      done: false,
      challenged,
      error: {
        message:
          "Connection interrupted. Check your connection before trying again.",
      },
    };
  }
}

function signInHref() {
  const next =
    typeof window === "undefined"
      ? "/app"
      : `${window.location.pathname}${window.location.search}`;
  return `/sign-in?next=${encodeURIComponent(next)}`;
}

/** The sign-in link of the code screen, for a challenge that has ended. */
function SignInAgain({ children }: { children: ReactNode }) {
  return (
    <>
      {children} <Link href={signInHref()}>Go to sign-in</Link>
    </>
  );
}

/** Asks for the password and, for two-step accounts, the current code; Escape cancels. */
export function FreshSessionDialog({
  email,
  teamId,
  twoStepEnabled,
  client = authClient,
  onDone,
  onCancel,
}: {
  email: string;
  teamId: string;
  twoStepEnabled: boolean;
  client?: ReauthClient;
  onDone: () => void;
  /** `challenged` when the password was accepted but no code was: the browser is signed out. */
  onCancel: (challenged: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenged, setChallenged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReauthError | null>(null);
  const ids = {
    description: useId(),
    password: useId(),
    code: useId(),
    error: useId(),
  };
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  // Runs after Dialog has opened, so focus lands inside the modal.
  useEffect(() => passwordRef.current?.focus(), []);
  // After a refusal the fields are enabled again: focus the one to correct.
  useEffect(() => {
    if (!error) return;
    const onCode = error.field === "code" || (!error.field && challenged);
    (onCode && codeRef.current ? codeRef : passwordRef).current?.focus();
  }, [error, challenged]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const outcome = await reauthenticate(client, {
      email,
      password,
      code: code.trim(),
      teamId,
      challenged,
    });
    setBusy(false);
    if (outcome.done) {
      onDone();
      return;
    }
    setChallenged(outcome.challenged);
    setError(outcome.error);
    if (outcome.error.field === "code") setCode("");
  }
  const describes = (field: "password" | "code") =>
    error && (!error.field || error.field === field) ? ids.error : undefined;
  return (
    <Dialog
      title="Confirm it's you"
      onClose={() => onCancel(challenged)}
      busy={busy}
      describedBy={ids.description}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="dialog-body stack">
          <p id={ids.description}>
            This change needs a recent sign-in, so enter your password
            {twoStepEnabled ? " and your two-step code" : ""}.
          </p>
          {error && (
            <p id={ids.error} className="notice error" role="alert">
              {error.signInAgain ? (
                <SignInAgain>{error.message}</SignInAgain>
              ) : (
                error.message
              )}
            </p>
          )}
          <div className="field">
            <label htmlFor={ids.password}>Password</label>
            <input
              ref={passwordRef}
              id={ids.password}
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={128}
              required
              value={password}
              disabled={busy || challenged}
              aria-invalid={error?.field === "password" || undefined}
              aria-describedby={describes("password")}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {twoStepEnabled && (
            <div className="field">
              <label htmlFor={ids.code}>Two-step code</label>
              <input
                ref={codeRef}
                id={ids.code}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                disabled={busy}
                aria-invalid={error?.field === "code" || undefined}
                aria-describedby={describes("code")}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
          )}
        </div>
        <footer className="dialog-footer">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => onCancel(challenged)}
          >
            Cancel
          </button>
          <button type="submit" className="button" disabled={busy}>
            {busy ? "Checking…" : "Confirm"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

/**
 * `await withFreshSession(() => request)` runs a guarded change and, on 403 SESSION_NOT_FRESH,
 * opens "Confirm it's you" and retries once; it resolves REAUTH_CANCELLED when the user cancels.
 * Render `dialog`. Focus returns to the control that started the change once it is enabled again.
 */
export function useFreshSession() {
  const { user, team } = useWorkspace();
  const [request, setRequest] = useState<{
    resolve: (done: boolean) => void;
    opener: HTMLElement | null;
  } | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const lastFocused = useRef<HTMLElement | null>(null);
  const restore = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // The page control that last had focus: a busy page disables it before the refusal arrives.
    const track = (event: FocusEvent) => {
      if (
        event.target instanceof HTMLElement &&
        !event.target.closest("dialog")
      )
        lastFocused.current = event.target;
    };
    document.addEventListener("focusin", track);
    return () => document.removeEventListener("focusin", track);
  }, []);
  // After every render: refocus the opener once it is back and enabled, unless focus moved on.
  useEffect(() => {
    const opener = restore.current;
    if (!opener) return;
    const active = document.activeElement;
    if (
      !opener.isConnected ||
      (active && active !== document.body && active !== opener)
    ) {
      restore.current = null;
      return;
    }
    if (opener.matches(":disabled")) return;
    restore.current = null;
    opener.focus();
  });
  const withFreshSession = useCallback(
    <T,>(work: () => Promise<T>) =>
      retryWithFreshSession(
        work,
        () =>
          new Promise<boolean>((resolve) => {
            setSignedOut(false);
            setRequest({ resolve, opener: lastFocused.current });
          }),
      ),
    [],
  );
  const settle = (done: boolean, challenged = false) => {
    restore.current = request?.opener ?? null;
    request?.resolve(done);
    setRequest(null);
    setSignedOut(!done && challenged);
  };
  const dialog = (
    <>
      {signedOut && (
        <p className="notice error" role="alert">
          <SignInAgain>
            You are signed out on this device. Sign in again to make this
            change.
          </SignInAgain>
        </p>
      )}
      {request && (
        <FreshSessionDialog
          email={user.email}
          teamId={team?.id ?? ""}
          twoStepEnabled={user.twoStepEnabled}
          onDone={() => settle(true)}
          onCancel={(challenged) => settle(false, challenged)}
        />
      )}
    </>
  );
  return { withFreshSession, dialog };
}
