"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Dialog } from "@/components/ui/dialog";
import {
  ClientError,
  humanError,
  requestJson,
} from "@/components/workspace/client";
import { formatDate } from "@/components/workspace/helpers";
import type { RetentionReviewRow } from "@/lib/directory";

interface Page<T> {
  data: T[];
  pagination: { page: number; pageSize: number; hasMore: boolean };
}
/** The employee an erasure dialog is open for. */
export interface ErasureTarget {
  id: string;
  name: string;
}

const REVIEW_PAGE_SIZE = 25;
export const ERASED_NOTICE = "Employee permanently erased.";
const classLabels = { standard: "Standard", extended: "Extended" } as const;
const reviewPath = (page: number) =>
  `/api/v1/employees/retention-review?page=${page}&pageSize=${REVIEW_PAGE_SIZE}`;
// Row actions never break inside a word; a narrow table scrolls inside its .table-wrap.
const actionRow = { flexWrap: "wrap", overflowWrap: "normal" } as const;
/** Only the API's own message: humanError adds draft advice to a 409 that does not fit here. */
const plainError = (error: unknown) =>
  error instanceof ClientError ? error.message : humanError(error);

// Employee erasure and the retention review (R2a-15), for company owners only; the Directory tab
// (R2a-16) shows them.

function EraseButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <div className="row" style={actionRow}>
      <button type="button" className="button danger" onClick={onClick}>
        Permanently erase employee<span className="sr-only">: {name}</span>
      </button>
    </div>
  );
}

export function RetentionReview({
  teamId,
  reloads,
  onErase,
}: {
  teamId: string | null;
  reloads: number;
  onErase: (target: ErasureTarget) => void;
}) {
  const [pages, setPages] = useState<Page<RetentionReviewRow>[] | null>(null);
  const [error, setError] = useState("");
  const [moreError, setMoreError] = useState("");
  const [busy, setBusy] = useState(false);
  // The first page, again after each erasure.
  useEffect(() => {
    if (!teamId) return;
    let active = true;
    requestJson<Page<RetentionReviewRow>>(teamId, reviewPath(1))
      .then((page) => {
        if (!active) return;
        setError("");
        setMoreError("");
        setPages([page]);
      })
      .catch((e) => {
        if (active) setError(humanError(e));
      });
    return () => {
      active = false;
    };
  }, [teamId, reloads]);
  const last = pages?.at(-1);
  async function showMore() {
    if (!teamId || !last) return;
    setBusy(true);
    setMoreError("");
    try {
      const page = await requestJson<Page<RetentionReviewRow>>(
        teamId,
        reviewPath(last.pagination.page + 1),
      );
      setPages((list) => [...(list ?? []), page]);
    } catch (e) {
      setMoreError(humanError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <RetentionReviewPanel
      rows={pages ? pages.flatMap((page) => page.data) : null}
      hasMore={!!last?.pagination.hasMore}
      error={error}
      moreError={moreError}
      busy={busy}
      onShowMore={() => void showMore()}
      onErase={onErase}
    />
  );
}

export function RetentionReviewPanel({
  rows,
  hasMore,
  error,
  moreError = "",
  busy = false,
  onShowMore = () => {},
  onErase = () => {},
}: {
  rows: RetentionReviewRow[] | null;
  hasMore: boolean;
  error: string;
  moreError?: string;
  busy?: boolean;
  onShowMore?: () => void;
  onErase?: (target: ErasureTarget) => void;
}) {
  return (
    <section className="panel stack">
      <h2>Retention review</h2>
      <p className="muted">
        Employees whose status has been Left for 12 months or more, for your
        review. Nothing is erased automatically; erase an employee only after
        you have decided their data is no longer needed.
      </p>
      {error ? (
        <p className="notice error" role="alert">
          Could not load the retention review. {error}
        </p>
      ) : !rows ? (
        <p role="status">Loading the retention review…</p>
      ) : !rows.length ? (
        <p role="status">No employees are due for review.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">
                Employees due for retention review, oldest first
              </caption>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Employee number</th>
                  <th>Left on</th>
                  <th>Retention class</th>
                  <th>Archived</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Name">{row.displayName}</td>
                    <td data-label="Employee number">{row.employeeNumber}</td>
                    <td data-label="Left on">{formatDate(row.leftAt)}</td>
                    <td data-label="Retention class">
                      {classLabels[row.retentionClass]}
                    </td>
                    <td data-label="Archived">
                      {row.archivedAt ? "Yes" : "No"}
                    </td>
                    <td data-label="Actions">
                      <EraseButton
                        name={row.displayName}
                        onClick={() =>
                          onErase({ id: row.id, name: row.displayName })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {moreError && (
            <p className="notice error" role="alert">
              Could not load more employees. {moreError}
            </p>
          )}
          {hasMore && (
            <div className="row">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={onShowMore}
              >
                Show more
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** The typed confirmation; it has no state of its own, so the parent owns the request. */
export function EmployeeErasureDialogView({
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
            <strong>Removed:</strong> the employee&apos;s directory entry (name,
            employee number, work email and phone, status and retention class),
            their position history and their link to a user account.
          </p>
          <p>
            <strong>Kept:</strong> positions and units, the user&apos;s account
            and team memberships, activity entries without personal details, a
            home-unit change entry for the unlinked user, and a record of who
            erased the employee and when.
          </p>
          <p>
            <strong>Not covered:</strong> copies outside the app, such as
            spreadsheets the directory was imported from.
          </p>
        </div>
        <div className="field">
          <label htmlFor={ids.input}>
            Type the employee&apos;s name to confirm
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

/**
 * Sends the erasure with one Idempotency-Key for this opened dialog, reused on a retry; on an
 * error the dialog stays open with the message.
 */
export function EmployeeErasureDialog({
  teamId,
  target,
  onCancel,
  onErased,
}: {
  teamId: string;
  target: ErasureTarget;
  onCancel: () => void;
  onErased: () => void;
}) {
  const [key] = useState(() => crypto.randomUUID());
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
      await requestJson(teamId, `/api/v1/employees/${target.id}/erasure`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({ confirmName: typed.trim() }),
      });
      onErased();
    } catch (caught) {
      setError(plainError(caught));
      setBusy(false);
    }
  }
  return (
    <EmployeeErasureDialogView
      name={target.name}
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
