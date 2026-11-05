import type { RecordDto } from "@/domain/records";

export function dataOf(record: RecordDto): Record<string, unknown> {
  return record.data as unknown as Record<string, unknown>;
}
export function recordLabel(record: RecordDto) {
  const data = dataOf(record);
  return String(
    record.label ||
      data.name ||
      data.title ||
      data.body ||
      `${record.kind} ${record.id.slice(0, 8)}`,
  );
}
export function display(value: unknown): string {
  if (value === null || value === undefined || value === "")
    return "Not recorded";
  if (Array.isArray(value))
    return value.map(display).join(", ") || "Not recorded";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}
export function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0))
      .join("")
      .toUpperCase() || "?"
  );
}
export function formatDate(value: unknown, includeTime = false) {
  if (!value) return "Not recorded";
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}
export function formatNumber(value: number) {
  return new Intl.NumberFormat("en-GB").format(value);
}
export function formatMoney(amount: unknown, currency: string) {
  if (amount === null || amount === undefined || amount === "")
    return "Not recorded";
  // Intl separates the code and amount with a no-break space; use a normal one.
  return new Intl.NumberFormat("en-GB", { style: "currency", currency })
    .format(Number(amount))
    .replace(/[\u00a0\u202f]/g, " ");
}
/** One display rule per field type, so detail facts and table cells agree. */
export function formatField(
  field: { key: string; type: string },
  data: Record<string, unknown>,
) {
  const value = data[field.key];
  if (field.key === "amount") return formatMoney(value, String(data.currency));
  if (field.type === "date") return formatDate(value);
  if (field.type === "datetime-local") return formatDate(value, true);
  if (field.type === "number" && typeof value === "number")
    return formatNumber(value);
  return display(value);
}
/** Imported comments keep their source label; a user ID is never shown. */
export function commentAuthor(comment: RecordDto) {
  const legacy = dataOf(comment).legacyAuthorLabel;
  if (legacy) return `${String(legacy)} · imported label`;
  return comment.authorName || "Author not recorded";
}
export interface ListFilters {
  status: string;
  category: string;
  categories: string[];
  skills: string[];
  certifications: string[];
  shortlisted: boolean;
  reviewStatus: string;
  emirate: string;
  degree: string;
  education: string;
  minYears: string;
  maxYears: string;
  vacancy: string;
  archived: boolean;
}
/** Filters hidden behind the phone "Filters" button; search and sorting are not counted. */
export function activeFilterCount(
  filters: ListFilters,
  shortlistSection = false,
) {
  return [
    filters.status,
    filters.category,
    filters.categories.length > 0,
    filters.skills.length > 0,
    filters.certifications.length > 0,
    filters.shortlisted && !shortlistSection,
    filters.reviewStatus,
    filters.emirate,
    filters.degree,
    filters.education.trim(),
    filters.minYears || filters.maxYears,
    filters.vacancy,
    filters.archived,
  ].filter(Boolean).length;
}
/** The forced My shortlist and Source review constraints are not user filters. */
export function isFiltered(
  search: string,
  filters: ListFilters,
  shortlistSection = false,
) {
  return (
    search.trim() !== "" || activeFilterCount(filters, shortlistSection) > 0
  );
}
/** A readable list of the applied filters for export labels. */
export function describeFilters(
  search: string,
  filters: ListFilters,
  statusLabel = "Status",
  shortlistSection = false,
) {
  const parts = [
    search.trim() && `Search: "${search.trim()}"`,
    filters.status && `${statusLabel}: ${filters.status}`,
    filters.category && `Folder category: ${filters.category}`,
    filters.categories.length > 0 &&
      `Any of these folder categories: ${filters.categories.join(", ")}`,
    filters.skills.length > 0 && `Skills: ${filters.skills.join(", ")}`,
    filters.certifications.length > 0 &&
      `Certifications: ${filters.certifications.join(", ")}`,
    filters.shortlisted && !shortlistSection && "My shortlist only",
    filters.reviewStatus && `Review status: ${filters.reviewStatus}`,
    filters.emirate && `Residence emirate: ${filters.emirate}`,
    filters.degree && `Degree level: ${filters.degree}`,
    filters.education.trim() &&
      `Education contains: "${filters.education.trim()}"`,
    (filters.minYears || filters.maxYears) &&
      `Stated experience: ${
        filters.minYears && filters.maxYears
          ? `${filters.minYears} to ${filters.maxYears} years`
          : filters.minYears
            ? `at least ${filters.minYears} years`
            : `at most ${filters.maxYears} years`
      }`,
    filters.vacancy && `Vacancy ID: ${filters.vacancy}`,
    filters.archived && "Include archived",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : "None";
}
export function toDubaiInput(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Date(date.valueOf() + 4 * 3600000).toISOString().slice(0, 16);
}
export function fromDubaiInput(value: string) {
  return value ? new Date(`${value}:00+04:00`).toISOString() : "";
}
export function safeCsvCell(value: unknown) {
  let text = Array.isArray(value)
    ? value.join("; ")
    : value && typeof value === "object"
      ? JSON.stringify(value)
      : String(value ?? "");
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function csvText(
  headers: string[],
  rows: unknown[][],
  metadata: unknown[][] = [],
) {
  return (
    "\uFEFF" +
    [...metadata, headers, ...rows]
      .map((row) => row.map(safeCsvCell).join(","))
      .join("\r\n")
  );
}
export function saveCsv(
  filename: string,
  headers: string[],
  rows: unknown[][],
  metadata: unknown[][] = [],
) {
  const blob = new Blob([csvText(headers, rows, metadata)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const DATA_PROTECTION_NOTICE =
  "This file contains personal data from RecruitmentOS. Store and share it only as your team's data-protection rules allow.";
/** Rows value and in-app notice; a changed total during paging is reported, not hidden. */
export function exportSummary(written: number, total: number) {
  const changed = written !== total;
  const detail = `the matching records changed during the export; ${total} matched when it finished`;
  return {
    changed,
    rows: changed ? `${written} (${detail})` : String(written),
    notice: changed
      ? `Exported ${written} records (${detail}). The file contains personal data; store and share it with care.`
      : `Exported ${written} records matching the current filters. The file contains personal data; store and share it with care.`,
  };
}
/** Two-cell label rows written above an export's header row. */
export function exportMetadata(input: {
  title: string;
  now: Date;
  environment: string;
  filters: string;
  written: number;
  total: number;
}): unknown[][] {
  return [
    ["RecruitmentOS export", input.title],
    ["Exported at", `${formatDate(input.now, true)} (Asia/Dubai)`],
    ["Environment", input.environment],
    ["Filters", input.filters],
    ["Rows", exportSummary(input.written, input.total).rows],
    ["Data protection", DATA_PROTECTION_NOTICE],
    [],
  ];
}
export function analyticsExportMetadata(input: {
  title: string;
  from: string;
  to: string;
  now: Date;
  environment: string;
}): unknown[][] {
  return [
    ["RecruitmentOS export", input.title],
    ["Date range", `${formatDate(input.from)} to ${formatDate(input.to)}`],
    ["Timezone", "Asia/Dubai (UTC+4)"],
    ["Exported at", `${formatDate(input.now, true)} (Asia/Dubai)`],
    ["Environment", input.environment],
    [],
  ];
}
/** `RecruitmentOS-{resource}-{YYYY-MM-DD-HHmm}.csv` in Asia/Dubai time. */
export function exportFilename(resource: string, now: Date) {
  const dubai = new Date(now.valueOf() + 4 * 3600000).toISOString();
  return `RecruitmentOS-${resource}-${dubai.slice(0, 10)}-${dubai.slice(11, 13)}${dubai.slice(14, 16)}.csv`;
}
export function analyticsRange(from: string, to: string) {
  return `Showing observed activity from ${formatDate(from)} to ${formatDate(to)} · Asia/Dubai (UTC+4)`;
}
/** Visible text for a linked parent; never a record ID. */
export function referenceText(state: {
  data: RecordDto | null;
  loading: boolean;
  status?: number;
}) {
  if (state.data) {
    const data = dataOf(state.data);
    const label = String(
      state.data.label ||
        data.name ||
        data.title ||
        data.body ||
        `Untitled ${state.data.kind}`,
    );
    return state.data.archivedAt ? `${label} (archived)` : label;
  }
  if (state.loading) return "Loading…";
  if (state.status === 404 || state.status === 403) return "Unavailable record";
  return "Could not load record";
}
/** The role facts a vacancy copies once; later role edits never reach the vacancy. */
export function roleSnapshot(role: Record<string, unknown>) {
  return {
    title: String(role.title ?? ""),
    department: String(role.department ?? ""),
    location: String(role.location ?? ""),
    employmentType: String(role.employmentType ?? ""),
    workMode: String(role.workMode ?? ""),
    description: String(role.description ?? ""),
    requirements: String(role.requirements ?? ""),
    skills: Array.isArray(role.skills) ? role.skills.map(String) : [],
  };
}
/** Complete or Waived items out of the non-archived checklist items. */
export function checklistProgress(items: RecordDto[]) {
  const current = items.filter((item) => !item.archivedAt);
  return {
    done: current.filter((item) =>
      ["Complete", "Waived"].includes(String(dataOf(item).status)),
    ).length,
    total: current.length,
  };
}
export function badgeTone(value: unknown) {
  const text = String(value).toLowerCase();
  if (/accepted|hired|complete|filled|open$|ready/.test(text)) return "success";
  if (/reject|declin|cancel|urgent|expired|overdue/.test(text)) return "danger";
  if (/hold|pending|screen|sent|high|progress/.test(text)) return "warning";
  return "neutral";
}
