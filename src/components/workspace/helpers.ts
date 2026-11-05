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
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(
    Number(amount),
  );
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
/** Filters hidden behind the phone "Filters" button; search and sorting are not counted. */
export function activeFilterCount(
  filters: {
    status: string;
    category: string;
    categories: string[];
    skills: string[];
    shortlisted: boolean;
    reviewStatus: string;
    emirate: string;
    degree: string;
    vacancy: string;
    archived: boolean;
  },
  shortlistSection = false,
) {
  return [
    filters.status,
    filters.category,
    filters.categories.length > 0,
    filters.skills.length > 0,
    filters.shortlisted && !shortlistSection,
    filters.reviewStatus,
    filters.emirate,
    filters.degree,
    filters.vacancy,
    filters.archived,
  ].filter(Boolean).length;
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
export function csvText(headers: string[], rows: unknown[][]) {
  return (
    "\uFEFF" +
    [headers, ...rows].map((row) => row.map(safeCsvCell).join(",")).join("\r\n")
  );
}
export function saveCsv(
  filename: string,
  headers: string[],
  rows: unknown[][],
) {
  const blob = new Blob([csvText(headers, rows)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function badgeTone(value: unknown) {
  const text = String(value).toLowerCase();
  if (/accepted|hired|complete|filled|open$|ready/.test(text)) return "success";
  if (/reject|declin|cancel|urgent|expired|overdue/.test(text)) return "danger";
  if (/hold|pending|screen|sent|high|progress/.test(text)) return "warning";
  return "neutral";
}
