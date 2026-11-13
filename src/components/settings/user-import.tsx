"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import { Dialog } from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  ClientError,
  humanError,
  teamRequester,
  useWorkspace,
} from "@/components/workspace/client";
import type { Requester } from "@/components/workspace/optimistic";
import { XLSX_TYPE } from "@/domain/org";
import type { ImportGroup } from "@/lib/org-import";
import type {
  UserImportCounts,
  UserImportIssue,
  UserImportPart,
  UserImportReport,
  UserImportResult,
} from "@/lib/user-import";
import {
  REAUTH_CANCELLED,
  useFreshSession,
  type ReauthCancelled,
} from "./fresh-session-dialog";

type Busy = "check" | ImportGroup | null;

export const USER_IMPORT_DRY_RUN_PATH = "/api/v1/admin/users/import/dry-run";
export const userImportApplyPath = (sha256: string, group: ImportGroup) =>
  `/api/v1/admin/users/import/apply?sha256=${sha256}${group === "owner" ? "&group=owner" : ""}`;
/** Check file: the raw workbook as the body, never JSON. */
export const checkUserImport = (request: Requester, file: Blob) =>
  request<{ data: UserImportReport }>(USER_IMPORT_DRY_RUN_PATH, {
    method: "POST",
    headers: { "Content-Type": XLSX_TYPE },
    body: file,
  });
/**
 * Apply or the owner step: the same file again with the SHA-256 its check returned. On 403
 * SESSION_NOT_FRESH it asks for re-authentication and sends once more; REAUTH_CANCELLED when the
 * user cancels, which sends nothing more.
 */
export const applyUserImportFile = (
  request: Requester,
  file: Blob,
  sha256: string,
  group: ImportGroup,
  withFreshSession: <T>(work: () => Promise<T>) => Promise<T | ReauthCancelled>,
) =>
  withFreshSession(() =>
    request<{ data: UserImportResult }>(userImportApplyPath(sha256, group), {
      method: "POST",
      headers: { "Content-Type": XLSX_TYPE },
      body: file,
    }),
  );

/**
 * The applied steps after one apply. A cancelled re-authentication applied nothing, so the steps,
 * like the chosen file and its report, stay as they were.
 */
export const afterApply = (
  applied: UserImportResult[],
  outcome: { data: UserImportResult } | ReauthCancelled,
) => (outcome === REAUTH_CANCELLED ? applied : [...applied, outcome.data]);

/** Only the API's own message: humanError adds draft advice to a 409 that does not fit here. */
const plainError = (error: unknown) =>
  error instanceof ClientError ? error.message : humanError(error);
const PARTS: Record<UserImportPart, string> = {
  row: "Whole row",
  invitation: "Invitation",
  group: "Group",
};
// The data-table's last column is sized for buttons; in these lists it holds the text, so it takes
// the free width, and Row and Part stay as narrow as their contents.
const narrow = { width: "1%", whiteSpace: "nowrap" } as const;
const free = { width: "auto", maxWidth: "none" } as const;

/**
 * Admin > Users: the Bulk invite button and its dialog (ADM-15). Check file sends a dry run, Apply
 * applies that same file, and a company owner applies the group adds that need one in a separate
 * step; both applies may ask to confirm it's you, keeping the file and the report. Choosing another
 * file clears the report and results; closing the dialog clears everything.
 */
export function BulkInvite({
  owner,
  onApplied,
}: {
  owner: boolean;
  onApplied: () => void;
}) {
  const { team } = useWorkspace();
  const teamId = team?.id ?? null;
  const request = useMemo(
    () => (teamId ? teamRequester(teamId) : null),
    [teamId],
  );
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<UserImportReport | null>(null);
  const [applied, setApplied] = useState<UserImportResult[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const chosen = useRef<File | null>(null);
  const { confirm, dialog } = useConfirm();
  const fresh = useFreshSession();

  function choose(next: File | null) {
    chosen.current = next;
    setFile(next);
    setReport(null);
    setApplied([]);
    setError("");
  }
  async function check(event: FormEvent) {
    event.preventDefault();
    if (!request || !file) return;
    setBusy("check");
    setError("");
    setReport(null);
    setApplied([]);
    try {
      const { data } = await checkUserImport(request, file);
      // A result belongs only to the file that is still chosen.
      if (chosen.current === file) setReport(data);
    } catch (e) {
      if (chosen.current === file) setError(plainError(e));
    } finally {
      setBusy(null);
    }
  }
  async function apply(group: ImportGroup) {
    if (!request || !file || !report) return;
    if (
      !(await confirm(
        group === "owner"
          ? {
              title: "Apply the company owner changes?",
              message:
                "This adds the people listed under Needs a company owner to groups that give a role or approvals, which changes what they can do.",
              confirmLabel: "Apply changes",
            }
          : {
              title: "Apply the bulk invite?",
              message:
                "This sends the invitations and makes the group adds the check counted, one at a time. Refused rows and rows that need a company owner are not applied.",
              confirmLabel: "Apply",
            },
      ))
    )
      return;
    setBusy(group);
    setError("");
    try {
      const result = await applyUserImportFile(
        request,
        file,
        report.sha256,
        group,
        fresh.withFreshSession,
      );
      setApplied((current) => afterApply(current, result));
      if (result !== REAUTH_CANCELLED) onApplied();
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <button
        type="button"
        className="button secondary"
        onClick={() => setOpen(true)}
      >
        Bulk invite
      </button>
      {open && (
        <Dialog
          title="Bulk invite"
          wide
          busy={!!busy}
          onClose={() => {
            choose(null);
            setOpen(false);
          }}
        >
          <BulkInviteView
            file={file}
            report={report}
            applied={applied}
            busy={busy}
            error={error}
            owner={owner}
            onFile={choose}
            onCheck={(event) => void check(event)}
            onApply={(group) => void apply(group)}
          />
          {dialog}
          {fresh.dialog}
        </Dialog>
      )}
    </>
  );
}

export function BulkInviteView({
  file,
  report,
  applied,
  busy,
  error,
  owner,
  onFile = () => {},
  onCheck = (event) => event.preventDefault(),
  onApply = () => {},
}: {
  file: File | null;
  report: UserImportReport | null;
  applied: UserImportResult[];
  busy: Busy;
  error: string;
  owner: boolean;
  onFile?: (file: File | null) => void;
  onCheck?: (event: FormEvent) => void;
  onApply?: (group: ImportGroup) => void;
}) {
  const changes = report ? report.counts.invite + report.counts.groupAdd : 0;
  const done = (group: ImportGroup) =>
    applied.some((result) => result.group === group);
  return (
    <div className="dialog-body stack">
      <p className="muted">
        One .xlsx workbook whose first sheet names the columns Email, Team, Team
        role and Group in row 1. Each row invites the email to the team with
        that team role (Owner, Admin, Recruiter or Viewer), adds the person to
        the company group, or both; teams and groups are matched by name,
        ignoring case. Configured role, company authority, area and any other
        columns are ignored.
      </p>
      <form
        className="row"
        style={{ alignItems: "flex-end" }}
        onSubmit={onCheck}
      >
        <label className="field">
          <span>Workbook</span>
          <input
            type="file"
            accept={`.xlsx,${XLSX_TYPE}`}
            disabled={!!busy}
            onChange={(event) => onFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <button type="submit" className="button" disabled={!file || !!busy}>
          Check file
        </button>
      </form>
      {busy && (
        <p role="status">
          {busy === "check" ? "Checking the file…" : "Applying…"}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {report && (
        <>
          <CountsTable
            caption="What applying the file would do"
            counts={report.counts}
          />
          {report.truncated && (
            <p className="muted">
              Each list below shows its first 500 rows; the counts include every
              row.
            </p>
          )}
          <IssueTable title="Refused rows" rows={report.refused} />
          {!!report.ignored.length && (
            <>
              <h3>Ignored columns</h3>
              <p className="muted">
                These columns are not read; roles and authority are never
                changed by a bulk invite.
              </p>
              <div className="table-wrap">
                <table className="data-table compact">
                  <caption className="sr-only">Ignored columns</caption>
                  <thead>
                    <tr>
                      <th style={free}>Column</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.ignored.map((column, i) => (
                      <tr key={i}>
                        <td data-label="Column" style={free}>
                          {column}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {!!report.flagged.length && (
            <>
              <h3>Flagged cells</h3>
              <p className="muted">
                These cells start with =, +, -, @, a tab or a line break. They
                are read as plain text, never as formulas.
              </p>
              <div className="table-wrap">
                <table className="data-table compact">
                  <caption className="sr-only">Flagged cells</caption>
                  <thead>
                    <tr>
                      <th style={narrow}>Row</th>
                      <th style={free}>Column</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.flagged.map((cell) => (
                      <tr key={`${cell.row}:${cell.column}`}>
                        <td data-label="Row" style={narrow}>
                          {cell.row}
                        </td>
                        <td data-label="Column" style={free}>
                          {cell.column}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <IssueTable
            title="Needs a company owner"
            note={
              owner
                ? "These group adds give a role or approvals. Apply them with Apply company owner changes."
                : "These group adds give a role or approvals. A company owner must apply these rows."
            }
            rows={report.needsOwner}
          />
          {!changes && (
            <p className="muted">
              There are no invitations to send or group adds to make, so there
              is nothing to apply.
            </p>
          )}
        </>
      )}
      <div className="row">
        <button
          type="button"
          className="button"
          disabled={!report || !changes || !!busy || done("normal")}
          onClick={() => onApply("normal")}
        >
          Apply
        </button>
        {owner && !!report?.counts.needsOwner && (
          <button
            type="button"
            className="button secondary"
            disabled={!!busy || done("owner")}
            onClick={() => onApply("owner")}
          >
            Apply company owner changes
          </button>
        )}
      </div>
      {applied.map((result) => (
        <div key={result.group} className="stack">
          <p role="status">
            {result.group === "owner"
              ? "The company owner changes were applied."
              : "The bulk invite was applied."}
          </p>
          <CountsTable
            caption={
              result.group === "owner"
                ? "What the company owner changes did"
                : "What the bulk invite did"
            }
            counts={result.counts}
            applied
          />
          <IssueTable title="Refused rows" rows={result.refused} />
        </div>
      ))}
    </div>
  );
}

function CountsTable({
  caption,
  counts,
  applied = false,
}: {
  caption: string;
  counts: UserImportCounts;
  /** The counts of an applied step: what it actually sent and added. */
  applied?: boolean;
}) {
  const columns: [keyof UserImportCounts, string][] = [
    ["invite", applied ? "Invitations sent" : "Invitations to send"],
    ["alreadyDone", "Already invited or a member"],
    ["groupAdd", applied ? "Group adds made" : "Group adds"],
    ["needsOwner", "Needs a company owner"],
    ["refused", "Refused"],
  ];
  return (
    <div className="table-wrap">
      <table className="data-table compact">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map(([key, label]) => (
              <th key={key}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {columns.map(([key, label]) => (
              <td key={key} data-label={label}>
                {counts[key]}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function IssueTable({
  title,
  note,
  rows,
}: {
  title: string;
  note?: string;
  rows: UserImportIssue[];
}) {
  if (!rows.length) return null;
  return (
    <>
      <h3>{title}</h3>
      {note && <p className="muted">{note}</p>}
      <div className="table-wrap">
        <table className="data-table compact">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th style={narrow}>Row</th>
              <th style={narrow}>Part</th>
              <th style={free}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.row}:${row.part}`}>
                <td data-label="Row" style={narrow}>
                  {row.row}
                </td>
                <td data-label="Part" style={narrow}>
                  {PARTS[row.part]}
                </td>
                <td data-label="Reason" style={free}>
                  {row.reason}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
