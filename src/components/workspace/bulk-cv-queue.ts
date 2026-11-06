import {
  BULK_INTAKE_MAX_FILES,
  BULK_INTAKE_RECOVERY_HOURS,
} from "@/domain/records";

export function canStartImport(
  available: boolean,
  reviewed: boolean,
  duplicatesReviewed: boolean,
) {
  return available && reviewed && duplicatesReviewed;
}

export function fileProblem(name: string, size: number) {
  if (!/\.(pdf|doc|docx|pages|jpg|jpeg|jfif|png)$/i.test(name))
    return "Unsupported file type.";
  if (size < 1 || size > 10 * 1024 * 1024)
    return "Choose a file between 1 byte and 10 MiB.";
  return "";
}

/** Adds files only up to the batch limit; every queue entry counts, including invalid files. */
export function capSelection<T>(queued: number, files: T[]) {
  const added = files.slice(0, Math.max(0, BULK_INTAKE_MAX_FILES - queued));
  return { added, skipped: files.length - added.length };
}

type Contact = { id: string; fields: { email: string; phone: string } };
/** Other queued drafts that share this draft's email (any case) or phone. */
export function sameQueue<T extends Contact>(entry: Contact, entries: T[]) {
  const email = entry.fields.email.trim().toLowerCase();
  const phone = entry.fields.phone.trim();
  return entries.filter(
    (other) =>
      other.id !== entry.id &&
      ((email && other.fields.email.trim().toLowerCase() === email) ||
        (phone && other.fields.phone.trim() === phone)),
  );
}

/**
 * An uncertain create may be retried only inside the recovery window counted from the batch
 * start, which comes before the server batch exists: after it, a purged batch could be recreated.
 */
export function uncertainRetryTooOld(
  entry: { submitted?: string; candidateId?: string },
  batchStartedAt: number | undefined,
  now: number,
) {
  return (
    !!entry.submitted &&
    !entry.candidateId &&
    batchStartedAt !== undefined &&
    now - batchStartedAt >= BULK_INTAKE_RECOVERY_HOURS * 3_600_000
  );
}

/** Ends a run before the next item when the session, permission or storage setup is gone. */
export function stopsRun(error: { status: number; code: string }) {
  return (
    error.status === 401 ||
    error.status === 403 ||
    (error.status === 503 && error.code === "STORAGE_SETUP_REQUIRED")
  );
}

export type SummaryGroup =
  "imported" | "cv-pending" | "not-imported" | "failed" | "unknown";
export const summaryLabels: Record<SummaryGroup, string> = {
  imported: "Imported",
  "cv-pending": "Candidate created, CV pending",
  "not-imported": "Not imported",
  failed: "Failed",
  unknown: "Outcome unknown",
};
type SummaryItem = {
  name: string;
  done: boolean;
  candidateId?: string;
  /** failed: the server answered with an error; unknown: the request was aborted or lost. */
  result?: "failed" | "unknown";
};
export function summaryGroup(item: SummaryItem): SummaryGroup {
  if (item.done) return "imported";
  if (item.candidateId) return "cv-pending";
  return item.result ?? "not-imported";
}
/** Every group in a fixed order with its file names, including empty groups. */
export function importSummary(items: SummaryItem[]) {
  return (Object.keys(summaryLabels) as SummaryGroup[]).map((group) => ({
    group,
    label: summaryLabels[group],
    names: items
      .filter((item) => summaryGroup(item) === group)
      .map((item) => item.name),
  }));
}
