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
