"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { MeAccess } from "@/lib/authz";
import { Dialog } from "@/components/ui/dialog";
import { humanError, useApi } from "@/components/workspace/client";
import { teamRequests } from "./team-members";

/**
 * The team's state and what archiving does, then Archive team or Restore team for its owners; an
 * admin sees the state only. No state of its own, so the parent owns the request.
 */
export function TeamArchiveView({
  role,
  archived,
  loadError,
  busy,
  error,
  onArchive,
  onRestore,
}: {
  role: string | null;
  /** Null while the state loads. */
  archived: boolean | null;
  loadError: string;
  busy: boolean;
  error: string;
  onArchive: () => void;
  onRestore: () => void;
}) {
  return (
    <section className="panel stack" aria-labelledby="team-archive-title">
      <h2 id="team-archive-title">Archive</h2>
      {loadError ? (
        <p className="notice error" role="alert">
          Could not load the team&apos;s state. {loadError}
        </p>
      ) : archived === null ? (
        <p role="status">Loading the team&apos;s state…</p>
      ) : (
        <p>
          State: <strong>{archived ? "Archived" : "Active"}</strong>
        </p>
      )}
      <p className="muted">
        Archiving makes the team read-only: members keep read access to
        everything, nothing is deleted, and a team owner can restore it at any
        time.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {archived !== null &&
        (role === "owner" ? (
          <div>
            {archived ? (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={onRestore}
              >
                {busy ? "Restoring…" : "Restore team"}
              </button>
            ) : (
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={onArchive}
              >
                Archive team
              </button>
            )}
          </div>
        ) : (
          <p>Only a team owner can archive or restore this team.</p>
        ))}
    </section>
  );
}

/** The typed confirmation, modelled on the candidate erasure dialog; it sends nothing itself. */
export function TeamArchiveDialogView({
  name,
  typed,
  busy,
  error,
  ids,
  cancelRef,
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
  onTyped: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const matches = typed.trim() !== "" && typed.trim() === name.trim();
  return (
    <Dialog
      title={`Archive ${name}?`}
      onClose={onCancel}
      busy={busy}
      role="alertdialog"
      describedBy={ids.description}
    >
      <div className="dialog-body stack">
        <div id={ids.description} className="stack">
          <p>
            <strong>Read-only:</strong> members keep reading everything, but
            nothing in the team can be changed: records, CVs, imports, task
            boards and connected AI apps.
          </p>
          <p>
            <strong>Kept:</strong> nothing is deleted. Members, roles, the team
            name, CV storage settings, API tokens and candidate erasure keep
            working, and a team owner can restore the team at any time.
          </p>
        </div>
        <div className="field">
          <label htmlFor={ids.input}>Type the team name to confirm</label>
          <input
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
          {busy ? "Archiving…" : "Archive team"}
        </button>
      </footer>
    </Dialog>
  );
}

/** Sends the archive once the name matches; on error the dialog stays open with the refusal. */
function TeamArchiveDialog({
  name,
  onCancel,
  onArchive,
}: {
  name: string;
  onCancel: () => void;
  onArchive: () => Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  const description = useId();
  const input = useId();
  const hint = useId();
  // Runs after Dialog has opened, so focus lands inside the modal.
  useEffect(() => cancel.current?.focus(), []);
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await onArchive();
    } catch (caught) {
      setError(humanError(caught));
      setBusy(false);
    }
  }
  return (
    <TeamArchiveDialogView
      name={name}
      typed={typed}
      busy={busy}
      error={error}
      ids={{ description, input, name: hint }}
      cancelRef={cancel}
      onTyped={setTyped}
      onCancel={onCancel}
      onConfirm={() => void confirm()}
    />
  );
}

/**
 * Team detail > Archive, for the team in the URL (its TeamScope): the state from GET
 * /api/v1/me/access, and for owners the change. The page reloads on this tab after a change, as
 * rename reloads, so the shell, switcher and this tab show the new state.
 */
export function TeamArchiveTab({
  team,
  role,
}: {
  team: { id: string; name: string };
  role: string | null;
}) {
  const requests = useMemo(() => teamRequests(team.id), [team.id]);
  const access = useApi<{ data: MeAccess }>("/api/v1/me/access");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(archived: boolean) {
    await requests.setArchived(archived);
    // Reloads on this tab, which switching tabs does not put in the address.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "archive");
    window.location.assign(url);
  }
  async function restore() {
    setBusy(true);
    setError("");
    try {
      await change(false);
    } catch (caught) {
      setError(humanError(caught));
      setBusy(false);
    }
  }
  return (
    <>
      <TeamArchiveView
        role={role}
        archived={access.data?.data.teamArchived ?? null}
        loadError={access.error}
        busy={busy}
        error={error}
        onArchive={() => {
          setError("");
          setConfirming(true);
        }}
        onRestore={() => void restore()}
      />
      {confirming && (
        <TeamArchiveDialog
          name={team.name}
          onCancel={() => setConfirming(false)}
          onArchive={() => change(true)}
        />
      )}
    </>
  );
}
