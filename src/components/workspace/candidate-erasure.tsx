"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Dialog } from "@/components/ui/dialog";
import { dataCache, humanError, requestJson, useWorkspace } from "./client";
import { formatDate } from "./helpers";

/** The fields of POST /api/v1/candidates/{id}/erasure the page shows; counts are not shown. */
export interface CandidateErasureResult {
  erasureId: string;
  alreadyErased: boolean;
  cvStorage: { deleted: number; waiting: number; deleteAfter: string | null };
}

/** Owners only: the one place to start an erasure, after the record details. */
export function CandidateErasureSection({
  role,
  onStart,
}: {
  role: string | null;
  onStart: () => void;
}) {
  if (role !== "owner") return null;
  return (
    <section className="panel stack" aria-labelledby="candidate-erasure-title">
      <h2 id="candidate-erasure-title">Permanently erase candidate</h2>
      <p className="muted">
        For data-protection requests only. This removes the candidate, their
        applications, interviews, offers, onboarding, comments, CV files and
        every member&apos;s follow-up notes, and cannot be undone. To keep the
        record but hide it, archive it instead.
      </p>
      <div>
        <button type="button" className="button danger" onClick={onStart}>
          Permanently erase candidate
        </button>
      </div>
    </section>
  );
}

/** The typed confirmation; it has no state of its own, so the parent owns the request. */
export function CandidateErasureDialogView({
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
      title={`Permanently erase ${name}?`}
      onClose={onCancel}
      busy={busy}
      role="alertdialog"
      describedBy={ids.description}
    >
      <div className="dialog-body stack">
        <div id={ids.description} className="stack">
          <p>
            <strong>Removed:</strong> candidate details, applications,
            interviews, offers, onboarding and checklist items, comments, every
            member&apos;s follow-up notes and shortlist, CV files and AI
            suggestion records.
          </p>
          <p>
            <strong>Kept:</strong> tasks (unlinked from this candidate),
            activity entries without personal details, and a record of who
            erased the candidate and when.
          </p>
          <p>
            <strong>Not covered:</strong> CSV exports already downloaded are not
            affected. Ask whoever downloaded them to delete their copies.
          </p>
        </div>
        <div className="field">
          <label htmlFor={ids.input}>
            Type the candidate&apos;s name to confirm
          </label>
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
          {busy ? "Erasing…" : "Permanently erase"}
        </button>
      </footer>
    </Dialog>
  );
}

/** Sends the erasure; on success the parent replaces the profile, on error the dialog stays open. */
export function CandidateErasureDialog({
  candidateId,
  name,
  onCancel,
  onErased,
}: {
  candidateId: string;
  name: string;
  onCancel: () => void;
  onErased: (result: CandidateErasureResult) => void;
}) {
  const { team } = useWorkspace();
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
    if (!team) return;
    setBusy(true);
    setError("");
    try {
      const body = await requestJson<{ data: CandidateErasureResult }>(
        team.id,
        `/api/v1/candidates/${candidateId}/erasure`,
        { method: "POST", body: JSON.stringify({ confirmName: typed.trim() }) },
      );
      onErased(body.data);
    } catch (caught) {
      setError(humanError(caught));
      setBusy(false);
    }
  }
  return (
    <CandidateErasureDialogView
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

/** The success text, with the CV storage sentence when the erasure had CV files. */
export function erasedMessage(result: CandidateErasureResult): string {
  const { deleted, waiting, deleteAfter } = result.cvStorage;
  const storage =
    waiting > 0
      ? ` ${waiting} CV file(s) will be deleted from storage by the next CV storage cleanup after ${formatDate(deleteAfter, true)}.`
      : deleted > 0
        ? " Their CV files were deleted from storage."
        : "";
  return `Candidate permanently erased.${storage}`;
}

/** The success status, focusable from script, and the way back to the list. */
export function CandidateErasedView({
  message,
  statusRef,
}: {
  message: string;
  statusRef?: RefObject<HTMLParagraphElement | null>;
}) {
  return (
    <div className="stack">
      <p ref={statusRef} className="notice success" role="status" tabIndex={-1}>
        {message}
      </p>
      <div>
        <Link href="/app/candidates" className="text-link">
          Back to candidates
        </Link>
      </div>
    </div>
  );
}

/**
 * What replaces the profile once the erasure succeeded. The status renders empty and gets its
 * text on the next frame, so screen readers announce it; focus then moves to it, after the
 * closed dialog has restored focus to the button that no longer exists.
 */
export function CandidateErased({
  result,
}: {
  result: CandidateErasureResult;
}) {
  const [shown, setShown] = useState(false);
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (shown) status.current?.focus();
  }, [shown]);
  return (
    <CandidateErasedView
      message={shown ? erasedMessage(result) : ""}
      statusRef={status}
    />
  );
}

/** Drops every cached copy of the erased candidate and what hung from it. */
export function forgetErasedCandidate(teamId: string, candidateId: string) {
  dataCache.removeRecord(teamId, candidateId);
  dataCache.clear();
}
