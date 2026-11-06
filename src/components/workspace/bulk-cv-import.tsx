"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import {
  BULK_INTAKE_MAX_FILES,
  BULK_INTAKE_RECOVERY_HOURS,
  recordDataSchemas,
} from "@/domain/records";
import type { ExtractedCandidateFields } from "@/domain/cv-extraction";
import {
  storeCv,
  withUploadLock,
  type UploadTicket,
} from "@/components/cv-transfer";
import {
  canStartImport,
  capSelection,
  fileProblem,
  importSummary,
  sameQueue,
  stopsRun,
  uncertainRetryTooOld,
} from "./bulk-cv-queue";
import {
  hasPendingSuggestions,
  resolveSuggestion,
} from "./bulk-cv-suggestions";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  ClientError,
  humanError,
  isAbortError,
  requestJson,
  useApi,
  useUnsavedWork,
  useWorkspace,
} from "./client";

type Fields = {
  name: string;
  email: string;
  phone: string;
  jobTitle: string;
  employer: string;
  university: string;
  degreeName: string;
  major: string;
  skills: string;
  certifications: string;
};
type Match = {
  id: string;
  name: string;
  email: string;
  phone: string;
  matches: string[];
};
type Entry = {
  /** Also the server item ID; the server chooses each CV upload's clientUploadId. */
  id: string;
  file: File;
  fields: Fields;
  suggestions?: ExtractedCandidateFields;
  suggestionRequestId?: string;
  checked: boolean;
  duplicates: Match[];
  duplicatesReviewed: boolean;
  reviewed: boolean;
  candidateId?: string;
  submitted?: string;
  /** failed: the server answered with an error; unknown: the request was aborted or lost. */
  result?: "failed" | "unknown";
  phase: string;
  error: string;
  done: boolean;
};
type UploadResponse = {
  data: { id: string };
  upload: UploadTicket | null;
};
export type RecentBatch = {
  id: string;
  createdAt: string;
  expiresAt: string;
  items: {
    id: string;
    originalName: string;
    sizeBytes: number;
    candidateId: string | null;
    outcome: "not-imported" | "cv-pending" | "imported" | "cv-rejected";
  }[];
};
const outcomeLabels: Record<RecentBatch["items"][number]["outcome"], string> = {
  "not-imported": "Not imported",
  "cv-pending": "Candidate created, CV pending",
  imported: "Imported",
  "cv-rejected": "Candidate created, CV rejected",
};
const summaryNotes: Record<string, string> = {
  "cv-pending":
    "Retry to attach the CV, or open the candidate later to attach it.",
  failed: "The server refused these. Check the message on each draft.",
  unknown:
    "The server did not confirm these. Retry each unchanged draft; it will not create a second candidate.",
};
const emptyFields: Fields = {
  name: "",
  email: "",
  phone: "",
  jobTitle: "",
  employer: "",
  university: "",
  degreeName: "",
  major: "",
  skills: "",
  certifications: "",
};
const labels: [keyof Fields, string][] = [
  ["name", "Full name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["jobTitle", "Latest job title"],
  ["employer", "Latest employer"],
  ["university", "Latest university"],
  ["degreeName", "Degree"],
  ["major", "Major"],
  ["skills", "Skills (comma separated)"],
  ["certifications", "Certifications (comma separated)"],
];
const tags = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
export const BULK_IMPORT_LIMITS = `Up to ${BULK_INTAKE_MAX_FILES} files per import, 10 MiB each. One CV uploads at a time in this browser. Import progress is kept on the server for ${BULK_INTAKE_RECOVERY_HOURS} hours; selected files and drafts stay only in this browser.`;

export type CvImportState =
  "checking" | "not-set-up" | "unavailable" | "error" | "ready";
/** Controls render only once the capability check has an answer. */
export function cvImportState(capability: {
  data: {
    data: { uploadsAvailable: boolean; storageConfigured: boolean };
  } | null;
  error: string;
}): CvImportState {
  if (capability.error) return "error";
  const data = capability.data?.data;
  if (!data) return "checking";
  if (!data.storageConfigured) return "not-set-up";
  return data.uploadsAvailable ? "ready" : "unavailable";
}

export function BulkCvImport({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const capability = useApi<{
    data: {
      uploadsAvailable: boolean;
      aiAvailable: boolean;
      storageConfigured: boolean;
    };
  }>("/api/v1/cvs/bulk-capabilities");
  return (
    <BulkCvImportDialog
      importState={cvImportState(capability)}
      capabilityError={capability.error}
      onCapabilityLost={capability.refresh}
      onClose={onClose}
      onChanged={onChanged}
    />
  );
}

/** The import dialog for one capability answer; only the ready state renders import controls. */
export function BulkCvImportDialog({
  importState,
  capabilityError,
  onCapabilityLost,
  onClose,
  onChanged,
}: {
  importState: CvImportState;
  capabilityError: string;
  onCapabilityLost: () => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { team } = useWorkspace();
  const available = importState === "ready";
  // One server batch per dialog session; recovery rows are kept per batch.
  const [batchId] = useState(() => crypto.randomUUID());
  // Taken just before the first item POST, so it is never later than the server batch's start.
  const batchStartedAt = useRef<number | undefined>(undefined);
  const [recentPage, setRecentPage] = useState(1);
  const recent = useApi<RecentImportsPage>(
    available ? `/api/v1/cvs/bulk-batches?page=${recentPage}` : null,
  );
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectionNotice, setSelectionNotice] = useState("");
  const [showSummary, setShowSummary] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);
  const { confirm, dialog } = useConfirm();
  useUnsavedWork(entries.some((item) => !item.done));
  const entry = entries.find((item) => item.id === selected);
  const update = (id: string, patch: Partial<Entry>) =>
    setEntries((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  const close = async () => {
    if (
      entries.some((item) => !item.done) &&
      !(await confirm({
        title: "Close import?",
        message: `Close this import? The selected files and unfinished review drafts will be lost. Candidates already created will remain in your directory. Import progress is shown under Recent imports for ${BULK_INTAKE_RECOVERY_HOURS} hours.`,
        confirmLabel: "Close import",
        destructive: true,
      }))
    )
      return;
    onClose();
  };
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (entries.some((item) => !item.done)) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [entries]);
  const selectFiles = (files: FileList | null) => {
    if (!files) return;
    const { added: chosen, skipped } = capSelection(
      entries.length,
      Array.from(files),
    );
    const added = chosen.map((file) => ({
      id: crypto.randomUUID(),
      file,
      fields: { ...emptyFields },
      checked: false,
      duplicates: [],
      duplicatesReviewed: false,
      reviewed: false,
      phase: "",
      error: fileProblem(file.name, file.size),
      done: false,
    }));
    setEntries((current) => [...current, ...added]);
    setSelectionNotice(
      skipped
        ? `${skipped} ${skipped === 1 ? "file was" : "files were"} not added. An import can include up to ${BULK_INTAKE_MAX_FILES} files; start a new import for the rest.`
        : "",
    );
    if (!selected && added[0]) setSelected(added[0].id);
  };
  const checkDuplicates = async () => {
    if (!entry || !team || busy) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    update(entry.id, { error: "", phase: "Checking for existing candidates" });
    try {
      let matches: Match[] = [];
      if (entry.fields.email.trim() || entry.fields.phone.trim()) {
        const response = await requestJson<{ data: Match[] }>(
          team.id,
          "/api/v1/candidates/duplicates",
          {
            method: "POST",
            signal: controller.signal,
            body: JSON.stringify({
              email: entry.fields.email.trim(),
              phone: entry.fields.phone.trim(),
            }),
          },
        );
        matches = response.data;
      }
      if (controller.signal.aborted) return;
      update(entry.id, {
        checked: true,
        duplicates: matches,
        duplicatesReviewed: false,
        phase: "",
      });
    } catch (error) {
      if (!controller.signal.aborted && !isAbortError(error))
        update(entry.id, { phase: "", error: humanError(error) });
    } finally {
      setBusy(false);
    }
  };
  const ready = (item: Entry) =>
    !item.done &&
    !hasPendingSuggestions(item) &&
    !!item.fields.name.trim() &&
    !fileProblem(item.file.name, item.file.size) &&
    canStartImport(
      available,
      item.reviewed,
      item.checked && item.duplicatesReviewed,
    );
  /** Imports one entry; resolves true when the run must stop before the next one. */
  const importEntry = async (
    entry: Entry,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!team || !ready(entry)) return false;
    if (uncertainRetryTooOld(entry, batchStartedAt.current, Date.now())) {
      update(entry.id, {
        error:
          "This uncertain attempt is too old to retry safely. Check the candidate directory before starting a new import.",
      });
      return false;
    }
    const candidate = {
      ...entry.fields,
      email: entry.fields.email.trim(),
      skills: tags(entry.fields.skills),
      certifications: tags(entry.fields.certifications),
    };
    const parsed = recordDataSchemas.candidate.safeParse(candidate);
    if (!parsed.success) {
      update(entry.id, {
        error: `Please correct the candidate details: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      });
      return false;
    }
    // The draft is locked after the first attempt so a retry sends the same item.
    const submitted = entry.submitted || JSON.stringify(candidate);
    const item = `/api/v1/cvs/bulk-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(entry.id)}`;
    let candidateId = entry.candidateId;
    let sent = false;
    update(entry.id, {
      error: "",
      result: undefined,
      phase: candidateId ? "Preparing CV upload" : "Creating candidate",
      submitted,
    });
    try {
      if (!candidateId) {
        sent = true;
        batchStartedAt.current ??= Date.now();
        const result = await requestJson<{ data: { candidateId: string } }>(
          team.id,
          item,
          {
            method: "POST",
            signal,
            body: JSON.stringify({
              file: {
                originalName: entry.file.name,
                mimeType: entry.file.type,
                sizeBytes: entry.file.size,
              },
              data: JSON.parse(submitted),
              factsReviewed: entry.reviewed,
              duplicatesReviewed: entry.duplicatesReviewed,
              acknowledgedDuplicateIds: entry.duplicates.map(
                (match) => match.id,
              ),
            }),
          },
        );
        candidateId = result.data.candidateId;
        update(entry.id, { candidateId, phase: "Preparing CV upload" });
        onChanged();
        if (signal.aborted) {
          update(entry.id, { phase: "" });
          return true;
        }
      }
      const ticket = await requestJson<UploadResponse>(
        team.id,
        `${item}/upload`,
        { method: "POST", signal },
      );
      if (ticket.upload) {
        update(entry.id, { phase: "Uploading CV" });
        await storeCv(
          ticket.upload,
          entry.file,
          () => {
            update(entry.id, { phase: "Checking document format" });
            return requestJson(
              team.id,
              `/api/v1/cvs/uploads/${encodeURIComponent(ticket.data.id)}/complete`,
              { method: "POST", signal },
            );
          },
          signal,
        );
      }
      update(entry.id, { done: true, phase: "", error: "" });
      onChanged();
      return false;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        update(entry.id, {
          candidateId,
          phase: "",
          result: !candidateId && sent ? "unknown" : undefined,
        });
        return true;
      }
      // A JSON error body is the server's answer; anything else may have been lost on the way.
      const answered =
        error instanceof ClientError && error.code !== "invalid_response";
      if (answered && error.code === "bulk_duplicates_changed") {
        // The server created nothing, so the draft unlocks for a new duplicate check.
        update(entry.id, {
          phase: "",
          error: error.message,
          result: "failed",
          checked: false,
          duplicates: [],
          duplicatesReviewed: false,
          submitted: undefined,
        });
        return false;
      }
      const message =
        error instanceof ClientError && error.status === 409
          ? error.message
          : humanError(error);
      update(entry.id, {
        candidateId,
        phase: "",
        result: candidateId ? undefined : answered ? "failed" : "unknown",
        error: candidateId
          ? `${message} The candidate was created. Retry to upload this CV again, or open the candidate to attach a different file.`
          : answered
            ? message
            : `${message} The result of candidate creation may be uncertain. Retry this unchanged draft to avoid creating a duplicate.`,
      });
      return answered && stopsRun(error);
    }
  };
  /** Adopts the server's view of this batch: created candidates and finished CVs. */
  const reconcile = async () => {
    if (!team) return;
    try {
      const result = await requestJson<{ data: RecentBatch }>(
        team.id,
        `/api/v1/cvs/bulk-batches/${encodeURIComponent(batchId)}`,
      );
      const items = new Map(result.data.items.map((item) => [item.id, item]));
      setEntries((current) =>
        current.map((entry) => {
          const item = items.get(entry.id);
          if (!item?.candidateId) return entry;
          return item.outcome === "imported"
            ? {
                ...entry,
                candidateId: item.candidateId,
                result: undefined,
                done: true,
                phase: "",
                error: "",
              }
            : { ...entry, candidateId: item.candidateId, result: undefined };
        }),
      );
    } catch {
      // A missing batch (404) adopts nothing. The summary then shows what this browser saw;
      // unconfirmed items stay unknown.
    }
  };
  const importReviewed = async (items: Entry[]) => {
    if (busy || !team || !available) return;
    const queue = items.filter(ready);
    if (!queue.length) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    setRunning(true);
    setShowSummary(false);
    setNotice("");
    let stopped = false;
    try {
      const refused = await withUploadLock(async () => {
        for (const item of queue) {
          if (controller.signal.aborted) break;
          if (await importEntry(item, controller.signal)) {
            stopped = !controller.signal.aborted;
            break;
          }
        }
      }, navigator.locks);
      if (refused) {
        setNotice(refused);
        return;
      }
      if (stopped) onCapabilityLost();
      setNotice(
        controller.signal.aborted
          ? "Import cancelled. Candidates already created stay in your directory."
          : stopped
            ? "Import stopped because CV import is no longer available to you. The remaining CVs were not started."
            : "",
      );
      await reconcile();
      setShowSummary(true);
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
      setBusy(false);
      setRunning(false);
    }
  };
  const queueMatches = entry ? sameQueue(entry, entries) : [];
  const status = (item: Entry) =>
    item.done
      ? "Imported"
      : item.phase ||
        (item.candidateId
          ? "Candidate created, CV pending"
          : item.result === "unknown"
            ? "Outcome unknown"
            : item.error
              ? "Needs attention"
              : ready(item)
                ? "Not started"
                : "Awaiting review");
  const summary = importSummary(
    entries.map((item) => ({
      name: item.file.name,
      done: item.done,
      candidateId: item.candidateId,
      result: item.result,
    })),
  );
  const imported = entries.filter((item) => item.done).length;
  return (
    <Dialog title="Import CVs" wide onClose={close} busy={busy}>
      <div className="dialog-body stack">
        {importState === "checking" && (
          <p className="muted" role="status">
            Checking CV import availability…
          </p>
        )}
        {importState === "not-set-up" && (
          <div className="notice" role="status">
            <strong>CV uploads are not set up yet.</strong>
            <p>
              Importing CV files needs file storage that an administrator has to
              finish setting up. You can still add and edit candidate details in
              the candidate directory.
            </p>
          </div>
        )}
        {importState === "unavailable" && (
          <p className="notice error" role="status">
            CV import is not available right now. You can still add and edit
            candidate details in the candidate directory.
          </p>
        )}
        {importState === "error" && (
          <p className="notice error" role="alert">
            Could not check import availability. {capabilityError}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {showSummary && (
          <section className="stack" aria-label="Import summary">
            <h3>Import summary</h3>
            <p>
              {imported === entries.length
                ? `All ${entries.length} selected CVs were imported.`
                : `${imported} of ${entries.length} selected CVs were fully imported. Check the groups below.`}
            </p>
            {summary.map((group) => (
              <div key={group.group}>
                <strong>{`${group.label} (${group.names.length})`}</strong>
                {group.names.length > 0 && (
                  <>
                    <p>{group.names.join(", ")}</p>
                    {summaryNotes[group.group] && (
                      <small>{summaryNotes[group.group]}</small>
                    )}
                  </>
                )}
              </div>
            ))}
          </section>
        )}
        {available && (
          <>
            <p>
              Select several CVs, then review each candidate before adding them.
              Drafts stay in this browser until you close this window or switch
              teams.
            </p>
            <p className="muted">
              AI extraction is not configured. Enter details from each CV and
              verify them yourself. No CV content is sent to an AI service.
            </p>
            <p className="muted">
              Duplicate checks compare exact normalized email and phone within
              your team and show up to 20 matches. They do not check names or
              guarantee that a candidate is unique.
            </p>
            <p>{BULK_IMPORT_LIMITS}</p>
            <div className="field">
              <label htmlFor="bulk-cv-files">Choose CV files</label>
              <input
                id="bulk-cv-files"
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.pages,.jpg,.jpeg,.jfif,.png"
                disabled={busy}
                onChange={(event) => {
                  selectFiles(event.target.files);
                  event.currentTarget.value = "";
                }}
              />
              <small>
                PDF, Word, Pages, JPG or PNG; up to 10 MiB per file.
              </small>
            </div>
            {selectionNotice && (
              <p className="notice error" role="alert">
                {selectionNotice}
              </p>
            )}
            {entries.length > 0 && (
              <div className="related-list" aria-label="Selected CVs">
                {entries.map((item) => (
                  <div className="related-item" key={item.id}>
                    <span>
                      <strong>{item.file.name}</strong>
                      <small>{status(item)}</small>
                    </span>
                    <button
                      type="button"
                      className="button secondary small"
                      aria-pressed={selected === item.id}
                      disabled={busy}
                      onClick={() => setSelected(item.id)}
                    >
                      Review
                    </button>
                  </div>
                ))}
              </div>
            )}
            {entry && (
              <section
                className="stack"
                aria-label={`Review ${entry.file.name}`}
              >
                <div className="row space-between">
                  <h3>Review {entry.file.name}</h3>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={busy}
                    onClick={async () => {
                      if (
                        entry.submitted &&
                        !(await confirm({
                          title: "Remove draft?",
                          message:
                            "Remove this draft? A candidate may already have been created; check the directory before starting again.",
                          confirmLabel: "Remove draft",
                          destructive: true,
                        }))
                      )
                        return;
                      setEntries((items) =>
                        items.filter((item) => item.id !== entry.id),
                      );
                      setSelected("");
                    }}
                  >
                    Remove from list
                  </button>
                </div>
                {entry.done ? (
                  <p className="notice success">
                    Candidate and CV imported. Format checks do not scan for
                    malware.
                  </p>
                ) : (
                  <>
                    {entry.submitted && (
                      <p className="muted">
                        This draft is locked after the first import attempt so
                        retrying cannot create a second candidate.{" "}
                        {entry.candidateId &&
                          `Candidate ID: ${entry.candidateId}`}
                      </p>
                    )}
                    <div className="form-grid">
                      {labels.map(([key, label]) => (
                        <div className="field" key={key}>
                          <label htmlFor={`bulk-${key}`}>
                            {label}
                            {key === "name" ? " *" : ""}
                          </label>
                          <input
                            id={`bulk-${key}`}
                            type={key === "email" ? "email" : "text"}
                            value={entry.fields[key]}
                            disabled={busy || !!entry.submitted}
                            required={key === "name"}
                            onChange={(event) => {
                              const value = event.target.value;
                              setEntries((items) =>
                                items.map((item) =>
                                  item.id === entry.id
                                    ? {
                                        ...item,
                                        fields: {
                                          ...item.fields,
                                          [key]: value,
                                        },
                                        suggestionRequestId: undefined,
                                        checked: false,
                                        duplicatesReviewed: false,
                                        reviewed: false,
                                      }
                                    : (key === "email" || key === "phone") &&
                                        !item.submitted &&
                                        !item.done
                                      ? { ...item, duplicatesReviewed: false }
                                      : item,
                                ),
                              );
                            }}
                          />
                          {entry.suggestions?.[key] != null && (
                            <div
                              className="notice"
                              aria-label={`Suggested ${label}`}
                            >
                              <p>
                                Suggested:{" "}
                                {Array.isArray(entry.suggestions[key])
                                  ? entry.suggestions[key].join(", ")
                                  : entry.suggestions[key]}
                              </p>
                              <button
                                type="button"
                                className="button secondary small"
                                disabled={busy || !!entry.submitted}
                                onClick={() =>
                                  setEntries((items) =>
                                    resolveSuggestion(
                                      items,
                                      entry.id,
                                      key,
                                      true,
                                    ),
                                  )
                                }
                              >
                                Use suggestion
                              </button>{" "}
                              <button
                                type="button"
                                className="button secondary small"
                                disabled={busy || !!entry.submitted}
                                onClick={() =>
                                  setEntries((items) =>
                                    resolveSuggestion(
                                      items,
                                      entry.id,
                                      key,
                                      false,
                                    ),
                                  )
                                }
                              >
                                Keep my entry
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    {queueMatches.length > 0 && (
                      <p className="notice error">
                        A selected draft shares this email or phone:{" "}
                        {queueMatches
                          .map((other) => other.file.name)
                          .join(", ")}
                        . Review both before importing.
                      </p>
                    )}
                    {!entry.submitted && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        onClick={checkDuplicates}
                      >
                        {entry.result === "failed" && !entry.checked
                          ? "Check for possible duplicates again"
                          : "Check for possible duplicates"}
                      </button>
                    )}
                    {entry.checked && (
                      <div className="stack">
                        <p>
                          {entry.fields.email.trim() ||
                          entry.fields.phone.trim()
                            ? entry.duplicates.length
                              ? "Possible existing candidates:"
                              : "No exact contact matches found."
                            : "No email or phone provided, so existing candidates cannot be checked by contact."}
                        </p>
                        {entry.duplicates.map((match) => (
                          <p key={match.id}>
                            <a
                              href={`/app/candidates/${encodeURIComponent(match.id)}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {match.name}
                            </a>{" "}
                            — {match.matches.join(" and ")} match
                          </p>
                        ))}
                        <label>
                          <input
                            type="checkbox"
                            checked={entry.duplicatesReviewed}
                            disabled={busy || !!entry.submitted}
                            onChange={(event) =>
                              update(entry.id, {
                                duplicatesReviewed: event.target.checked,
                              })
                            }
                          />{" "}
                          I reviewed possible duplicates, including other
                          selected drafts.
                        </label>
                      </div>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={entry.reviewed}
                        disabled={busy || !!entry.submitted}
                        onChange={(event) =>
                          update(entry.id, { reviewed: event.target.checked })
                        }
                      />{" "}
                      I reviewed these details against the CV.
                    </label>
                    {fileProblem(entry.file.name, entry.file.size) && (
                      <p className="notice error" role="alert">
                        {fileProblem(entry.file.name, entry.file.size)}
                      </p>
                    )}
                    {entry.error &&
                      entry.error !==
                        fileProblem(entry.file.name, entry.file.size) && (
                        <p className="notice error" role="alert">
                          {entry.error}
                        </p>
                      )}
                    {entry.phase && <p role="status">{entry.phase}…</p>}
                    <button
                      type="button"
                      className="button"
                      disabled={busy || !ready(entry)}
                      onClick={() => importReviewed([entry])}
                    >
                      {entry.submitted
                        ? "Retry import"
                        : "Add reviewed candidate and CV"}
                    </button>
                  </>
                )}
              </section>
            )}
            <RecentImports
              page={recent.data}
              error={recent.error}
              loading={recent.loading}
              currentBatchId={batchId}
              onPage={setRecentPage}
            />
          </>
        )}
      </div>
      <footer className="dialog-footer">
        {available && (
          <button
            type="button"
            className="button"
            disabled={busy || !entries.some(ready)}
            onClick={() => importReviewed(entries)}
          >
            Import reviewed ({entries.filter(ready).length})
          </button>
        )}
        {running && (
          <button
            type="button"
            className="button secondary"
            onClick={() => activeRequest.current?.abort()}
          >
            Cancel import
          </button>
        )}
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={close}
        >
          Close
        </button>
      </footer>
      {dialog}
    </Dialog>
  );
}

export type RecentImportsPage = {
  data: RecentBatch[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};
/** One page of the user's recent imports, without the batch this dialog is running. */
export function RecentImports({
  page,
  error,
  loading,
  currentBatchId,
  onPage,
}: {
  page: RecentImportsPage | null;
  error: string;
  loading: boolean;
  currentBatchId: string;
  onPage: (page: number) => void;
}) {
  const others = (page?.data ?? []).filter(
    (batch) => batch.id !== currentBatchId,
  );
  return (
    <section className="stack" aria-label="Recent imports">
      <h3>{`Recent imports (kept for ${BULK_INTAKE_RECOVERY_HOURS} hours)`}</h3>
      {error ? (
        <p className="notice error" role="status">
          Could not load recent imports.
        </p>
      ) : !page ? (
        <p className="muted">Loading recent imports…</p>
      ) : others.length === 0 && page.pagination.page > 1 ? (
        // A later page can empty as batches expire; the user goes back by choice.
        <div className="row">
          <p className="muted">No recent imports on this page.</p>
          <button
            type="button"
            className="button secondary small"
            disabled={loading}
            onClick={() => onPage(1)}
          >
            Go to first page
          </button>
        </div>
      ) : others.length === 0 ? (
        <p className="muted">No other recent imports.</p>
      ) : (
        others.map((batch) => (
          <div className="stack" key={batch.id}>
            <strong>{`Started ${new Date(batch.createdAt).toLocaleString()}`}</strong>
            <div className="related-list">
              {batch.items.map((item) => (
                <div className="related-item" key={item.id}>
                  <span>
                    <strong>{item.originalName}</strong>
                    <small>
                      {outcomeLabels[item.outcome]}
                      {(item.outcome === "cv-pending" ||
                        item.outcome === "cv-rejected") &&
                        ". Open the candidate to attach the CV"}
                    </small>
                  </span>
                  {item.candidateId && (
                    <a
                      href={`/app/candidates/${encodeURIComponent(item.candidateId)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open candidate
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
      {!error && page && page.pagination.totalPages > 1 && (
        <nav className="pagination" aria-label="Recent import pages">
          <div className="row">
            <button
              type="button"
              className="button secondary small"
              disabled={page.pagination.page <= 1 || loading}
              onClick={() => onPage(page.pagination.page - 1)}
            >
              Previous
            </button>
            <span>
              Page {page.pagination.page} of {page.pagination.totalPages}
            </span>
            <button
              type="button"
              className="button secondary small"
              disabled={
                page.pagination.page >= page.pagination.totalPages || loading
              }
              onClick={() => onPage(page.pagination.page + 1)}
            >
              Next
            </button>
          </div>
        </nav>
      )}
    </section>
  );
}
