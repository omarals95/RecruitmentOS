"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Dialog } from "@/components/ui/dialog";
import {
  ClientError,
  humanError,
  requestJson,
} from "@/components/workspace/client";
import type { UserAnonymisation } from "@/lib/user-anonymisation";
import { REAUTH_CANCELLED, type ReauthCancelled } from "./fresh-session-dialog";

/** The person an anonymisation dialog is open for. */
export interface AnonymisationTarget {
  id: string;
  name: string;
}

/** Only the API's own message: humanError adds draft advice to a 409 that does not fit here. */
const plainError = (error: unknown) =>
  error instanceof ClientError ? error.message : humanError(error);

// User account anonymisation (ADM-10), for company owners only; the Security tab of the user
// detail page opens it.

/**
 * The request with the dialog's key and trimmed typed name to the page's team; on 403
 * SESSION_NOT_FRESH "Confirm it's you" opens and the same request runs once more. REAUTH_CANCELLED
 * when the re-authentication was cancelled, which sends nothing more.
 */
export function sendAnonymisation(
  teamId: string,
  userId: string,
  typed: string,
  key: string,
  withFreshSession: <T>(work: () => Promise<T>) => Promise<T | ReauthCancelled>,
) {
  return withFreshSession(() =>
    requestJson<{ data: UserAnonymisation }>(
      teamId,
      `/api/v1/admin/users/${encodeURIComponent(userId)}/anonymise`,
      {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({ confirmName: typed.trim() }),
      },
    ),
  );
}

/** The typed confirmation; it has no state of its own, so the parent owns the request. */
export function UserAnonymisationDialogView({
  name,
  typed,
  busy,
  error,
  ids,
  cancelRef,
  inputRef,
  onTyped,
  onCancel,
  onConfirm,
}: {
  name: string;
  typed: string;
  busy: boolean;
  error: string;
  ids: { description: string; input: string; name: string };
  cancelRef?: RefObject<HTMLButtonElement | null>;
  inputRef?: RefObject<HTMLInputElement | null>;
  onTyped: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const matches = typed.trim() !== "" && typed.trim() === name.trim();
  return (
    <Dialog
      title={`Anonymise ${name}?`}
      onClose={onCancel}
      busy={busy}
      role="alertdialog"
      describedBy={ids.description}
    >
      <div className="dialog-body stack">
        <div id={ids.description} className="stack">
          <p>
            <strong>Removed:</strong> their team memberships, sign-in (password,
            sessions and devices), API tokens and connected AI apps, two-step
            sign-in, configured roles, record assignments, company authority,
            pending invitations to their email, and the details of activity
            entries about them.
          </p>
          <p>
            <strong>Kept:</strong> records, candidates, comments and files they
            created; activity they performed, shown under the placeholder name;
            and a record of who anonymised the account and when.
          </p>
          <p>
            <strong>Not covered:</strong> copies outside the app, their
            directory entry (erase it separately under Directory), and names or
            emails typed into records.
          </p>
        </div>
        <div className="field">
          <label htmlFor={ids.input}>
            Type the person&apos;s name to confirm
          </label>
          <input
            ref={inputRef}
            id={ids.input}
            value={typed}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={ids.name}
            onChange={(event) => onTyped(event.target.value)}
          />
          <small id={ids.name} className="muted">
            Name: <strong>{name}</strong>
          </small>
        </div>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="dialog-footer">
        <button
          ref={cancelRef}
          type="button"
          className="button secondary"
          autoFocus
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy || !matches}
          onClick={onConfirm}
        >
          {busy ? "Anonymising…" : "Anonymise account"}
        </button>
      </footer>
    </Dialog>
  );
}

/**
 * Sends the anonymisation with one Idempotency-Key for this opened dialog, reused on the retry
 * after "Confirm it's you", which opens over this dialog and leaves the typed name in place. A
 * cancelled re-authentication or a refusal keeps the dialog open, the refusal's message shown.
 */
export function UserAnonymisationDialog({
  teamId,
  target,
  withFreshSession,
  onCancel,
  onAnonymised,
}: {
  teamId: string;
  target: AnonymisationTarget;
  withFreshSession: <T>(work: () => Promise<T>) => Promise<T | ReauthCancelled>;
  onCancel: () => void;
  onAnonymised: () => void;
}) {
  const [key] = useState(() => crypto.randomUUID());
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refocus, setRefocus] = useState(0);
  const cancel = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const description = useId();
  const field = useId();
  const hint = useId();
  // Runs after Dialog has opened, so focus lands inside the modal.
  useEffect(() => cancel.current?.focus(), []);
  // Back in the name field once it is enabled again after a cancel or a refusal.
  useEffect(() => {
    if (refocus) input.current?.focus();
  }, [refocus]);
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const outcome = await sendAnonymisation(
        teamId,
        target.id,
        typed,
        key,
        withFreshSession,
      );
      if (outcome !== REAUTH_CANCELLED) {
        onAnonymised();
        return;
      }
    } catch (caught) {
      setError(plainError(caught));
    }
    setBusy(false);
    setRefocus((count) => count + 1);
  }
  return (
    <UserAnonymisationDialogView
      name={target.name}
      typed={typed}
      busy={busy}
      error={error}
      ids={{ description, input: field, name: hint }}
      cancelRef={cancel}
      inputRef={input}
      onTyped={setTyped}
      onCancel={onCancel}
      onConfirm={() => void confirm()}
    />
  );
}

/** What the detail area shows once the person is anonymised: they are no longer in Users. */
export function UserAnonymisedPanel({ name }: { name: string }) {
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => status.current?.focus(), []);
  return (
    <section className="panel stack">
      <p ref={status} tabIndex={-1} className="notice success" role="status">
        {name}&apos;s account was anonymised. They no longer appear in Users.
      </p>
      <p>
        <Link href="/app/admin/users">Back to Users</Link>
      </p>
    </section>
  );
}
