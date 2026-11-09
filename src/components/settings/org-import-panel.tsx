"use client";

import { useRef, useState, type FormEvent } from "react";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ClientError, humanError } from "@/components/workspace/client";
import type { Requester } from "@/components/workspace/optimistic";
import { XLSX_TYPE } from "@/domain/org";
import type {
  ImportCounts,
  ImportGroup,
  ImportIssue,
  ImportReport,
} from "@/lib/org-import";

export type AppliedImport = ImportReport & { group: ImportGroup };
type Busy = "check" | ImportGroup | null;

export const DRY_RUN_PATH = "/api/v1/org-import/dry-run";
export const applyPath = (sha256: string, group: ImportGroup) =>
  `/api/v1/org-import/apply?sha256=${sha256}${group === "owner" ? "&group=owner" : ""}`;
/** Check file: the raw workbook as the body, never JSON. */
export const checkImport = (request: Requester, file: Blob) =>
  request<{ data: ImportReport }>(DRY_RUN_PATH, {
    method: "POST",
    headers: { "Content-Type": XLSX_TYPE },
    body: file,
  });
/** Apply: the same file again, with the SHA-256 its check returned. */
export const applyImport = (
  request: Requester,
  file: Blob,
  sha256: string,
  group: ImportGroup,
) =>
  request<{ data: AppliedImport }>(applyPath(sha256, group), {
    method: "POST",
    headers: { "Content-Type": XLSX_TYPE },
    body: file,
  });

/** Only the API's own message: humanError adds draft advice to a 409 that does not fit here. */
const plainError = (error: unknown) =>
  error instanceof ClientError ? error.message : humanError(error);
const SHEETS = [
  ["units", "Units"],
  ["positions", "Positions"],
  ["employees", "Employees"],
] as const;
// The data-table's last column is sized for buttons; in these lists it holds the text, so it takes
// the free width, and Sheet and Row stay as narrow as their contents.
const narrow = { width: "1%", whiteSpace: "nowrap" } as const;
const free = { width: "auto", maxWidth: "none" } as const;
const total = (report: ImportReport, key: keyof ImportCounts) =>
  SHEETS.reduce((sum, [sheet]) => sum + report.sheets[sheet][key], 0);

/**
 * Import from Excel (R2a-17) on the Organisation tab: Check file sends a dry run, Apply import
 * applies that same file, and a company owner applies the rows that need one in a separate step.
 * Choosing another file clears the result.
 */
export function OrgImportPanel({
  request,
  owner,
  onApplied,
}: {
  request: Requester | null;
  owner: boolean;
  onApplied: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [applied, setApplied] = useState<AppliedImport[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const chosen = useRef<File | null>(null);
  const { confirm, dialog } = useConfirm();

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
      const { data } = await checkImport(request, file);
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
                "This moves the units and positions and changes the positions of the employees listed under Needs a company owner. It changes who can see which records.",
              confirmLabel: "Apply changes",
            }
          : {
              title: "Apply the import?",
              message:
                "This creates and updates the units, positions and employees the check counted, one sheet at a time. Rejected rows and rows that need a company owner are not changed.",
              confirmLabel: "Apply import",
            },
      ))
    )
      return;
    setBusy(group);
    setError("");
    try {
      const { data } = await applyImport(request, file, report.sha256, group);
      setApplied((current) => [...current, data]);
      onApplied();
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <OrgImportView
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
    </>
  );
}

export function OrgImportView({
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
  report: ImportReport | null;
  applied: AppliedImport[];
  busy: Busy;
  error: string;
  owner: boolean;
  onFile?: (file: File | null) => void;
  onCheck?: (event: FormEvent) => void;
  onApply?: (group: ImportGroup) => void;
}) {
  const writes = report ? total(report, "create") + total(report, "update") : 0;
  const ownerRows = report ? total(report, "needsOwner") : 0;
  const done = (group: ImportGroup) =>
    applied.some((result) => result.group === group);
  return (
    <section className="panel stack">
      <h2>Import from Excel</h2>
      <p className="muted">
        One .xlsx workbook, row 1 naming the columns: Units (Code, Name, Level,
        Parent code), Positions (Code, Title, Unit code, Manager) and Employees
        (Employee number, Name, Work email, Work phone, Position codes, Primary
        position).
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
            caption="What the import would change, by sheet"
            report={report}
            owner
          />
          {report.truncated && (
            <p className="muted">
              Each list below shows its first 500 rows; the counts include every
              row.
            </p>
          )}
          <IssueTable title="Rejected rows" rows={report.rejected} />
          {!!report.flagged.length && (
            <>
              <h3>Flagged cells</h3>
              <p className="muted">
                These cells start with =, +, -, @, a tab or a line break. They
                are stored as plain text, never as formulas.
              </p>
              <div className="table-wrap">
                <table className="data-table compact">
                  <caption className="sr-only">Flagged cells</caption>
                  <thead>
                    <tr>
                      <th style={narrow}>Sheet</th>
                      <th style={narrow}>Row</th>
                      <th style={free}>Column</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.flagged.map((cell) => (
                      <tr key={`${cell.sheet}:${cell.row}:${cell.column}`}>
                        <td data-label="Sheet" style={narrow}>
                          {cell.sheet}
                        </td>
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
                ? "These rows change who can see which records. Apply them with Apply company owner changes."
                : "A company owner must apply these rows."
            }
            rows={report.needsOwner}
          />
        </>
      )}
      <div className="row">
        <button
          type="button"
          className="button"
          disabled={!report || !writes || !!busy || done("normal")}
          onClick={() => onApply("normal")}
        >
          Apply import
        </button>
        {owner && ownerRows > 0 && (
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
              : "The import was applied."}
          </p>
          <CountsTable
            caption={
              result.group === "owner"
                ? "What the company owner changes wrote, by sheet"
                : "What the import wrote, by sheet"
            }
            report={result}
            owner={result.group === "normal"}
          />
          <IssueTable title="Rejected rows" rows={result.rejected} />
        </div>
      ))}
    </section>
  );
}

function CountsTable({
  caption,
  report,
  owner,
}: {
  caption: string;
  report: ImportReport;
  owner: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th>Sheet</th>
            <th>Create</th>
            <th>Update</th>
            <th>Unchanged</th>
            <th>Rejected</th>
            {owner && <th>Needs a company owner</th>}
          </tr>
        </thead>
        <tbody>
          {SHEETS.map(([key, label]) => {
            const counts = report.sheets[key];
            return (
              <tr key={key}>
                <td data-label="Sheet">{label}</td>
                <td data-label="Create">{counts.create}</td>
                <td data-label="Update">{counts.update}</td>
                <td data-label="Unchanged">{counts.unchanged}</td>
                <td data-label="Rejected">{counts.reject}</td>
                {owner && (
                  <td data-label="Needs a company owner">
                    {counts.needsOwner}
                  </td>
                )}
              </tr>
            );
          })}
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
  rows: ImportIssue[];
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
              <th style={narrow}>Sheet</th>
              <th style={narrow}>Row</th>
              <th style={free}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.sheet}:${row.row}`}>
                <td data-label="Sheet" style={narrow}>
                  {row.sheet}
                </td>
                <td data-label="Row" style={narrow}>
                  {row.row}
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
