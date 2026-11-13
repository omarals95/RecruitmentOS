import { RESOURCE_CONFIG, type RecordDto } from "@/domain/records";
import { csvText, formatDate, type ListFilters } from "@/domain/export";
export {
  DATA_PROTECTION_NOTICE,
  csvText,
  describeFilters,
  exportFilename,
  exportMetadata,
  exportSummary,
  formatDate,
  safeCsvCell,
  type ListFilters,
} from "@/domain/export";

export interface ListResponse {
  data: RecordDto[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

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
    filters.assignedToMe,
  ].filter(Boolean).length;
}
/** Whether a filter tag already holds this value, ignoring case and surrounding spaces. */
export function hasFilterTag(values: string[], value: string) {
  const wanted = value.trim().toLowerCase();
  return values.some((item) => item.trim().toLowerCase() === wanted);
}
/** Adds a typed filter value; an empty value or a case variant of an existing tag is ignored. */
export function addFilterTag(values: string[], draft: string): string[] {
  const value = draft.trim();
  return value && !hasFilterTag(values, value) ? [...values, value] : values;
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
export function toDubaiInput(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Date(date.valueOf() + 4 * 3600000).toISOString().slice(0, 16);
}
export function fromDubaiInput(value: string) {
  return value ? new Date(`${value}:00+04:00`).toISOString() : "";
}
export function saveCsv(
  filename: string,
  headers: string[],
  rows: unknown[][],
  metadata: unknown[][] = [],
) {
  saveBlob(
    filename,
    new Blob([csvText(headers, rows, metadata)], {
      type: "text/csv;charset=utf-8",
    }),
  );
}
export function saveBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
/** The role facts a vacancy copies; later role edits reach it only through a reviewed refresh. */
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
/** Role snapshot fields where the vacancy differs from its role now; skill order counts. */
export function roleDifferences(
  vacancyData: Record<string, unknown>,
  roleData: Record<string, unknown>,
) {
  const vacancy = roleSnapshot(vacancyData);
  const role = roleSnapshot(roleData);
  return (Object.keys(role) as (keyof typeof role)[])
    .filter((key) => JSON.stringify(vacancy[key]) !== JSON.stringify(role[key]))
    .map((key) => ({
      key,
      label:
        RESOURCE_CONFIG.vacancies.fields.find((field) => field.key === key)
          ?.label ?? key,
      vacancy: vacancy[key],
      role: role[key],
    }));
}
/**
 * Every row of a list, 100 per page: page 1 first, nothing more when its total exceeds `limit`.
 * `complete` is false when the unique rows differ from the last page's total, so the list changed.
 */
export async function loadAllPages(
  fetchPage: (page: number) => Promise<ListResponse>,
  limit: number,
): Promise<
  | { tooMany: true; total: number }
  | { tooMany: false; rows: RecordDto[]; total: number; complete: boolean }
> {
  const first = await fetchPage(1);
  if (first.pagination.total > limit)
    return { tooMany: true, total: first.pagination.total };
  let last = first;
  const rows = new Map(first.data.map((row) => [row.id, row]));
  for (let page = 2; page <= first.pagination.totalPages; page++) {
    last = await fetchPage(page);
    for (const row of last.data) if (!rows.has(row.id)) rows.set(row.id, row);
  }
  return {
    tooMany: false,
    rows: [...rows.values()],
    total: last.pagination.total,
    complete: rows.size === last.pagination.total,
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
