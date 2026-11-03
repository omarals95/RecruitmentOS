"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { recordDataSchemas, type RecordDto } from "@/domain/records";
import type { ExtractedCandidateFields } from "@/domain/cv-extraction";
import { canStartImport, fileProblem } from "./bulk-cv-queue";
import {
  hasPendingSuggestions,
  resolveSuggestion,
} from "./bulk-cv-suggestions";
import { humanError, requestJson, useApi, useWorkspace } from "./client";

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
  id: string;
  uploadId: string;
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
  startedAt?: number;
  phase: string;
  error: string;
  done: boolean;
};
type UploadTicket = {
  data: { id: string };
  upload: { url: string; fields: Record<string, string> } | null;
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

export function BulkCvImport({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const { team } = useWorkspace();
  const capability = useApi<{
    data: { uploadsAvailable: boolean; aiAvailable: boolean };
  }>("/api/v1/cvs/bulk-capabilities");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);
  const entry = entries.find((item) => item.id === selected);
  const update = (id: string, patch: Partial<Entry>) =>
    setEntries((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  const close = () => {
    if (
      entries.some((item) => !item.done) &&
      !window.confirm(
        "Close this import? The selected files and unfinished review drafts will be lost. Candidates already created will remain in your directory.",
      )
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
    const added = Array.from(files).map((file) => ({
      id: crypto.randomUUID(),
      uploadId: crypto.randomUUID(),
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
      if (!controller.signal.aborted)
        update(entry.id, { phase: "", error: humanError(error) });
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const ready = (item: Entry) =>
    !item.done &&
    !hasPendingSuggestions(item) &&
    !!item.fields.name.trim() &&
    !fileProblem(item.file.name, item.file.size) &&
    canStartImport(
      capability.data?.data.uploadsAvailable === true,
      item.reviewed,
      item.checked && item.duplicatesReviewed,
    );
  const importEntry = async (entry: Entry, signal: AbortSignal) => {
    if (
      !team ||
      hasPendingSuggestions(entry) ||
      !canStartImport(
        capability.data?.data.uploadsAvailable === true,
        entry.reviewed,
        entry.checked && entry.duplicatesReviewed,
      ) ||
      fileProblem(entry.file.name, entry.file.size)
    )
      return;
    if (
      entry.submitted &&
      !entry.candidateId &&
      entry.startedAt &&
      Date.now() - entry.startedAt >= 86400000
    ) {
      update(entry.id, {
        error:
          "This uncertain attempt is too old to retry safely. Check the candidate directory before starting a new import.",
      });
      return;
    }
    const parsed = recordDataSchemas.candidate.safeParse({
      ...entry.fields,
      email: entry.fields.email.trim(),
      skills: tags(entry.fields.skills),
      certifications: tags(entry.fields.certifications),
      reviewStatus: "Reviewed",
    });
    if (!parsed.success) {
      update(entry.id, {
        error: `Please correct the candidate details: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      });
      return;
    }
    const payload = entry.submitted || JSON.stringify({ data: parsed.data });
    let candidateId = entry.candidateId;
    update(entry.id, {
      error: "",
      phase: candidateId ? "Preparing CV upload" : "Creating candidate",
      submitted: payload,
      startedAt: entry.startedAt ?? Date.now(),
    });
    try {
      if (!candidateId) {
        const result = await requestJson<{ data: RecordDto }>(
          team.id,
          "/api/v1/candidates",
          {
            method: "POST",
            signal,
            headers: { "Idempotency-Key": entry.id },
            body: payload,
          },
        );
        if (signal.aborted) return;
        candidateId = result.data.id;
        update(entry.id, { candidateId, phase: "Preparing CV upload" });
        onChanged();
      }
      const ticket = await requestJson<UploadTicket>(
        team.id,
        `/api/v1/candidates/${encodeURIComponent(candidateId)}/cvs/uploads`,
        {
          method: "POST",
          signal,
          body: JSON.stringify({
            originalName: entry.file.name,
            mimeType: entry.file.type,
            sizeBytes: entry.file.size,
            clientUploadId: entry.uploadId,
          }),
        },
      );
      if (signal.aborted) return;
      if (ticket.upload) {
        update(entry.id, { phase: "Uploading CV" });
        const form = new FormData();
        for (const [key, value] of Object.entries(ticket.upload.fields))
          form.append(key, value);
        form.append("file", entry.file);
        const sent = await fetch(ticket.upload.url, {
          method: "POST",
          signal,
          body: form,
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
        if (signal.aborted) return;
        if (!sent.ok)
          throw new Error(
            `Private storage did not accept the CV (HTTP ${sent.status}).`,
          );
        update(entry.id, { phase: "Checking document format" });
        await requestJson(
          team.id,
          `/api/v1/cvs/uploads/${encodeURIComponent(ticket.data.id)}/complete`,
          { method: "POST", signal },
        );
      }
      if (signal.aborted) return;
      update(entry.id, { done: true, phase: "", error: "" });
      onChanged();
    } catch (error) {
      if (!signal.aborted)
        update(entry.id, {
          candidateId,
          phase: "",
          error: `${humanError(error)} ${candidateId ? "The candidate was created; retry to attach this CV." : "The result of candidate creation may be uncertain. Retry this unchanged draft to avoid creating a duplicate."}`,
        });
    }
  };
  const importReviewed = async (items: Entry[]) => {
    if (busy || !team || capability.data?.data.uploadsAvailable !== true)
      return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setBusy(true);
    try {
      for (const item of items.filter(ready)) {
        if (controller.signal.aborted) break;
        await importEntry(item, controller.signal);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const sameQueue = entry
    ? entries.filter(
        (other) =>
          other.id !== entry.id &&
          ((entry.fields.email.trim() &&
            other.fields.email.trim().toLowerCase() ===
              entry.fields.email.trim().toLowerCase()) ||
            (entry.fields.phone.trim() &&
              other.fields.phone.trim() === entry.fields.phone.trim())),
      )
    : [];
  return (
    <Dialog title="Import CVs" wide onClose={close} busy={busy}>
      <div className="dialog-body stack">
        <p>
          Select several CVs, then review each candidate before adding them.
          Drafts stay in this browser until you close this window or switch
          teams.
        </p>
        {!capability.data?.data.uploadsAvailable && (
          <p className="notice error" role="status">
            CV import is unavailable while private storage safeguards are being
            verified. You can prepare a review draft, but candidates cannot be
            imported yet.
          </p>
        )}
        {capability.error && (
          <p className="notice error" role="alert">
            Could not check import availability. {capability.error}
          </p>
        )}
        <p className="muted">
          AI extraction is not configured. Enter details from each CV and verify
          them yourself. No CV content is sent to an AI service.
        </p>
        <p className="muted">
          Duplicate checks compare exact normalized email and phone within your
          team and show up to 20 matches. They do not check names or guarantee
          that a candidate is unique.
        </p>
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
          <small>PDF, Word, Pages, JPG or PNG; up to 10 MiB per file.</small>
        </div>
        {entries.length > 0 && (
          <div className="related-list" aria-label="Selected CVs">
            {entries.map((item) => (
              <div className="related-item" key={item.id}>
                <span>
                  <strong>{item.file.name}</strong>
                  <small>
                    {item.done
                      ? "Imported"
                      : item.phase ||
                        (item.error ? "Needs attention" : "Awaiting review")}
                  </small>
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
          <section className="stack" aria-label={`Review ${entry.file.name}`}>
            <div className="row space-between">
              <h3>Review {entry.file.name}</h3>
              <button
                type="button"
                className="button secondary small"
                disabled={busy}
                onClick={() => {
                  if (
                    entry.submitted &&
                    !window.confirm(
                      "Remove this draft? A candidate may already have been created; check the directory before starting again.",
                    )
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
                    {entry.candidateId && `Candidate ID: ${entry.candidateId}`}
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
                                    fields: { ...item.fields, [key]: value },
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
                                resolveSuggestion(items, entry.id, key, true),
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
                                resolveSuggestion(items, entry.id, key, false),
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
                {sameQueue.length > 0 && (
                  <p className="notice error">
                    A selected draft shares this email or phone:{" "}
                    {sameQueue.map((other) => other.file.name).join(", ")}.
                    Review both before importing.
                  </p>
                )}
                {!entry.submitted && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={checkDuplicates}
                  >
                    Check for possible duplicates
                  </button>
                )}
                {entry.checked && (
                  <div className="stack">
                    <p>
                      {entry.fields.email.trim() || entry.fields.phone.trim()
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
                      I reviewed possible duplicates, including other selected
                      drafts.
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
                  disabled={
                    busy ||
                    !ready(entry) ||
                    !entry.fields.name.trim() ||
                    !!fileProblem(entry.file.name, entry.file.size) ||
                    !canStartImport(
                      capability.data?.data.uploadsAvailable === true,
                      entry.reviewed,
                      entry.checked && entry.duplicatesReviewed,
                    )
                  }
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
      </div>
      <footer className="dialog-footer">
        <button
          type="button"
          className="button"
          disabled={busy || !entries.some(ready)}
          onClick={() => importReviewed(entries)}
        >
          Import reviewed ({entries.filter(ready).length})
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={close}
        >
          Close
        </button>
      </footer>
    </Dialog>
  );
}
