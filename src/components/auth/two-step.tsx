"use client";

import Link from "next/link";
import {
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type Ref,
} from "react";
import { ArrowRight, Copy, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { QrCode } from "./qr-code";

type AuthResult = {
  error?: { code?: string; status?: number; message?: string } | null;
};

/** The auth-card layout of the sign-in pages, with one h1. */
function Frame({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
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
          <p className="eyebrow">TWO-STEP SIGN-IN</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </header>
        {children}
      </div>
    </main>
  );
}

/** The base32 key from an otpauth:// URI, in groups of four for typing. */
export function setupKey(totpURI: string) {
  const key = new URL(totpURI).searchParams.get("secret") ?? "";
  return key.match(/.{1,4}/g)?.join(" ") ?? "";
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function SignOut() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="button secondary"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void authClient
          .signOut()
          .finally(() => window.location.assign("/sign-in"));
      }}
    >
      Sign out
    </button>
  );
}

/** Steps 2 and 3: the QR code and typed key, then one code from the app to confirm. */
export function SetupKeyStep({
  totpURI,
  email,
  busy = false,
  headingRef,
  onCopied,
  onConfirm,
}: {
  totpURI: string;
  email: string;
  busy?: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
  onCopied?: (copied: boolean) => void;
  onConfirm?: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const key = setupKey(totpURI);
  return (
    <div className="auth-form">
      <section className="stack" aria-labelledby="two-step-scan">
        <h2 id="two-step-scan" tabIndex={-1} ref={headingRef}>
          Step 2 of 4: Add RecruitmentOS to your authenticator app
        </h2>
        <p>
          Scan this QR code with your authenticator app. If you cannot scan it,
          add an account in the app and type the setup key instead.
        </p>
        <QrCode value={totpURI} />
        <dl className="two-step-details">
          <dt>Setup key</dt>
          <dd>
            <code className="two-step-key">{key}</code>
          </dd>
          <dt>Account</dt>
          <dd>{email}</dd>
          <dt>Issuer</dt>
          <dd>RecruitmentOS</dd>
          <dt>Type</dt>
          <dd>Time-based, 6 digits</dd>
        </dl>
        <div>
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              void copy(key.replaceAll(" ", "")).then((copied) =>
                onCopied?.(copied),
              )
            }
          >
            <Copy size={16} aria-hidden="true" />
            Copy setup key
          </button>
        </div>
      </section>
      <form
        className="auth-form"
        aria-labelledby="two-step-confirm"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm?.(code.trim());
        }}
      >
        <h2 id="two-step-confirm">Step 3 of 4: Confirm a code</h2>
        <label className="auth-field">
          6-digit code from your authenticator app
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={code}
            disabled={busy}
            onChange={(event) => setCode(event.target.value)}
          />
        </label>
        <button className="button" type="submit" disabled={busy}>
          {busy ? "Checking…" : "Confirm code"}
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}

/** Password, QR code and key, one code, then the backup codes, shown once. */
export function TwoStepSetup({
  email,
  required,
  next,
}: {
  email: string;
  required: boolean;
  next: string;
}) {
  const [step, setStep] = useState<"password" | "key" | "codes">("password");
  const [password, setPassword] = useState("");
  const [totpURI, setTotpURI] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const moveTo = (next: typeof step) => {
    setStep(next);
    requestAnimationFrame(() => heading.current?.focus());
  };
  async function run(work: () => Promise<AuthResult>, done: () => void) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await work();
      if (!result.error) done();
      else
        setError(
          result.error.code === "INVALID_PASSWORD"
            ? "That password is not correct."
            : result.error.code === "INVALID_CODE"
              ? "That code is not correct. Check the time on your device and try the newest code."
              : result.error.status === 429
                ? "Too many attempts. Wait a few seconds and try again."
                : result.error.message ||
                  "Two-step sign-in could not be set up. Please try again.",
        );
    } catch {
      setError(
        "Connection interrupted. Check your connection before trying again.",
      );
    } finally {
      setBusy(false);
    }
  }
  function enable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let secrets: { totpURI?: string; backupCodes?: string[] } | null = null;
    void run(
      async () => {
        const result = await authClient.twoFactor.enable({ password });
        secrets = result.data && "totpURI" in result.data ? result.data : null;
        return result;
      },
      () => {
        setPassword("");
        setTotpURI(secrets?.totpURI ?? "");
        setBackupCodes(secrets?.backupCodes ?? []);
        moveTo("key");
      },
    );
  }
  function confirm(code: string) {
    void run(
      () => authClient.twoFactor.verifyTotp({ code }),
      () => {
        // The secret is no longer needed once the app has proved it holds it.
        setTotpURI("");
        setStatus("Code accepted. Two-step sign-in is on.");
        moveTo("codes");
      },
    );
  }
  return (
    <Frame
      title="Set up two-step sign-in"
      description={
        required
          ? "Two-step sign-in is required for your role. Owners and admins must use it before they can continue."
          : "Add a code from an authenticator app to every sign-in, so a password alone is not enough."
      }
    >
      {error && (
        <div className="auth-notice auth-error" role="alert">
          {error}
        </div>
      )}
      {status && (
        <div className="auth-notice auth-success" role="status">
          {status}
        </div>
      )}
      {step === "password" && (
        <form className="auth-form" onSubmit={enable}>
          <h2 tabIndex={-1} ref={heading}>
            Step 1 of 4: Confirm your password
          </h2>
          <label className="auth-field">
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={128}
              required
              value={password}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button className="button" type="submit" disabled={busy}>
            {busy ? "Please wait…" : "Continue"}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </form>
      )}
      {step === "key" && totpURI && (
        <SetupKeyStep
          totpURI={totpURI}
          email={email}
          busy={busy}
          headingRef={heading}
          onCopied={(copied) =>
            setStatus(
              copied
                ? "Setup key copied."
                : "Copy is unavailable in this browser. Type the setup key shown above.",
            )
          }
          onConfirm={confirm}
        />
      )}
      {step === "codes" && (
        <section className="auth-form" aria-labelledby="two-step-codes">
          <h2 id="two-step-codes" tabIndex={-1} ref={heading}>
            Step 4 of 4: Save your backup codes
          </h2>
          <p>
            Each code signs you in once if you lose your authenticator app. They
            are shown only now; keep them somewhere safe.
          </p>
          <ul className="two-step-codes">
            {backupCodes.map((code) => (
              <li key={code}>
                <code>{code}</code>
              </li>
            ))}
          </ul>
          <div>
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                void copy(backupCodes.join("\n")).then((copied) =>
                  setStatus(
                    copied
                      ? "Backup codes copied."
                      : "Copy is unavailable in this browser. Write the codes down instead.",
                  ),
                )
              }
            >
              <Copy size={16} aria-hidden="true" />
              Copy backup codes
            </button>
          </div>
          <label className="two-step-check">
            <input
              type="checkbox"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
            />
            I have saved my backup codes
          </label>
          <button
            type="button"
            className="button"
            disabled={!saved}
            onClick={() => window.location.assign(next)}
          >
            Continue
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </section>
      )}
      <footer className="auth-footer">
        {!required && step !== "codes" && (
          <Link href="/app/settings/profile">Cancel</Link>
        )}
        <SignOut />
      </footer>
    </Frame>
  );
}

/** The sign-in challenge: an authenticator code, or a backup code instead. */
export function TwoStepCode({ next }: { next: string }) {
  const [method, setMethod] = useState<"totp" | "backup">("totp");
  const [code, setCode] = useState("");
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>("");
  const heading = useRef<HTMLHeadingElement>(null);
  const signInAgain = (
    <>
      Sign in again.{" "}
      <Link href={`/sign-in?next=${encodeURIComponent(next)}`}>
        Go to sign-in
      </Link>
    </>
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { code: code.trim(), trustDevice: trust };
      const result: AuthResult =
        method === "totp"
          ? await authClient.twoFactor.verifyTotp(body)
          : await authClient.twoFactor.verifyBackupCode(body);
      if (!result.error) {
        window.location.assign(next);
        return;
      }
      const failure = result.error.code;
      setError(
        failure === "INVALID_CODE" || failure === "INVALID_BACKUP_CODE"
          ? "That code is not correct."
          : failure === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" ||
              failure === "INVALID_TWO_FACTOR_COOKIE"
            ? signInAgain
            : failure === "ACCOUNT_TEMPORARILY_LOCKED"
              ? "Too many incorrect codes. Try again in 15 minutes."
              : result.error.status === 429
                ? "Too many attempts. Wait a few seconds and try again."
                : result.error.message ||
                  "The code could not be checked. Please try again.",
      );
    } catch {
      setError(
        "Connection interrupted. Check your connection before trying again.",
      );
    }
    setBusy(false);
  }
  return (
    <Frame
      title="Enter your sign-in code"
      description="Your account uses two-step sign-in. Enter the code from your authenticator app to finish signing in."
    >
      {error && (
        <div className="auth-notice auth-error" role="alert">
          {error}
        </div>
      )}
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <h2 tabIndex={-1} ref={heading}>
          {method === "totp" ? "Authenticator code" : "Backup code"}
        </h2>
        {method === "totp" ? (
          <label className="auth-field">
            6-digit code from your authenticator app
            <input
              key="totp"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              disabled={busy}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
        ) : (
          <label className="auth-field">
            Backup code
            <input
              key="backup"
              name="code"
              autoComplete="off"
              spellCheck={false}
              maxLength={32}
              required
              value={code}
              disabled={busy}
              onChange={(event) => setCode(event.target.value)}
            />
            <small>
              One of the codes you saved when you set up two-step sign-in.
            </small>
          </label>
        )}
        <label className="two-step-check">
          <input
            type="checkbox"
            checked={trust}
            disabled={busy}
            onChange={(event) => setTrust(event.target.checked)}
          />
          Trust this device for 30 days
        </label>
        <button className="button" type="submit" disabled={busy}>
          {busy ? "Checking…" : "Verify"}
          <ArrowRight size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => {
            setMethod(method === "totp" ? "backup" : "totp");
            setCode("");
            setError("");
            requestAnimationFrame(() => heading.current?.focus());
          }}
        >
          {method === "totp"
            ? "Use a backup code instead"
            : "Use your authenticator app instead"}
        </button>
      </form>
      <footer className="auth-footer">
        <Link href={`/sign-in?next=${encodeURIComponent(next)}`}>
          Back to sign in
        </Link>
      </footer>
    </Frame>
  );
}
