import type { KindSchemaBody } from "./config";
import { RESOURCE_CONFIG, type RecordDto, type ResourceName } from "./records";
import { screenFor, shownKeys } from "./screens";

/** Pure export helpers shared by the export endpoint and the workspace; no browser or server APIs. */
export const EXPORT_RESOURCES = [
  "candidates",
  "job-roles",
  "vacancies",
  "applications",
  "tasks",
  "interviews",
  "offers",
  "onboarding",
] as const satisfies readonly ResourceName[];
export type ExportResource = (typeof EXPORT_RESOURCES)[number];

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
  /** Tasks only; never exported, so never described. */
  assignedToMe?: boolean;
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
/** The Filters cell for an export query: the list screen's wording, then any other key as `key: value`. */
export function describeExportQuery(
  resource: ExportResource,
  query: URLSearchParams,
) {
  const statusKey = resource === "applications" ? "stage" : "status";
  const text = (key: string) => query.get(key) ?? "";
  const list = (key: string) => {
    try {
      const value: unknown = JSON.parse(text(key) || "[]");
      return Array.isArray(value) ? value.map(String) : [];
    } catch {
      return [];
    }
  };
  const described = [
    "search",
    statusKey,
    "folderCategory",
    "categories",
    "skills",
    "certifications",
    "reviewStatus",
    "residenceEmirate",
    "degreeLevel",
    "education",
    "minYearsExperience",
    "maxYearsExperience",
    "vacancyId",
  ];
  const flags = ["shortlisted", "includeArchived", "needsReview"];
  const base = describeFilters(
    text("search"),
    {
      status: text(statusKey),
      category: text("folderCategory"),
      categories: list("categories"),
      skills: list("skills"),
      certifications: list("certifications"),
      shortlisted: text("shortlisted") === "true",
      reviewStatus: text("reviewStatus"),
      emirate: text("residenceEmirate"),
      degree: text("degreeLevel"),
      education: text("education"),
      minYears: text("minYearsExperience"),
      maxYears: text("maxYearsExperience"),
      vacancy: text("vacancyId"),
      archived: text("includeArchived") === "true",
    },
    resource === "applications"
      ? "Stage"
      : resource === "candidates"
        ? "Follow-up status"
        : "Status",
  );
  const other = [
    ...(text("needsReview") === "true" ? ["Needs source review"] : []),
    ...[...query.entries()]
      .filter(
        ([key, value]) =>
          !["sort", "direction"].includes(key) &&
          !described.includes(key) &&
          !(flags.includes(key) && value === "true") &&
          value.trim() !== "",
      )
      .map(([key, value]) => `${key}: ${value}`),
  ];
  if (!other.length) return base;
  return base === "None" ? other.join("; ") : `${base}; ${other.join("; ")}`;
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
function csvLines(rows: unknown[][]) {
  return rows.map((row) => row.map(safeCsvCell).join(",")).join("\r\n");
}
export function csvText(
  headers: string[],
  rows: unknown[][],
  metadata: unknown[][] = [],
) {
  return "\uFEFF" + csvLines([...metadata, headers, ...rows]);
}
/** The same text as csvText, in pieces of at most `size` data rows for a streamed response. */
export function* csvChunks(
  headers: string[],
  rows: unknown[][],
  metadata: unknown[][] = [],
  size = 500,
) {
  yield "\uFEFF" + csvLines([...metadata, headers]);
  for (let start = 0; start < rows.length; start += size)
    yield "\r\n" + csvLines(rows.slice(start, start + size));
}
/**
 * Record ID, every field of the resource the caller may see in its order (`hidden` names the keys
 * left out), then the creation and update times. A task's assignees are not stored in its data and
 * are never exported. With a kind schema `body`, the fields are the body's: first in the order of
 * its default view screen, then the rest in body order, each headed by its label; a custom field's
 * cell is its custom value, and archived custom fields, and every custom field when customValues is
 * hidden, are left out.
 */
export function exportTable(
  resource: ResourceName,
  records: RecordDto[],
  hidden: ReadonlySet<string> = new Set(),
  body?: KindSchemaBody,
) {
  const fields: { key: string; label: string; system: boolean }[] = body
    ? viewOrder(body).filter(
        (field) =>
          field.system || (!field.archived && !hidden.has("customValues")),
      )
    : RESOURCE_CONFIG[resource].fields.map((field) => ({
        ...field,
        system: true,
      }));
  const columns = fields.filter(
    (field) => !hidden.has(field.key) && field.key !== "assigneeIds",
  );
  return {
    headers: [
      "Record ID",
      ...columns.map((field) => field.label),
      "Created at",
      "Updated at",
    ],
    rows: records.map((record) => {
      const data = record.data as Record<string, unknown>;
      const custom = (data.customValues ?? {}) as Record<string, unknown>;
      return [
        record.id,
        ...columns.map((field) =>
          field.system ? data[field.key] : custom[field.key],
        ),
        record.createdAt,
        record.updatedAt,
      ];
    }),
  };
}
/** The body's fields, the default view screen's shown keys first in screen order, then body order. */
function viewOrder(body: KindSchemaBody) {
  const shown = shownKeys(screenFor(body, null, "view"));
  const rank = (key: string) =>
    shown.includes(key) ? shown.indexOf(key) : shown.length;
  return [...body.fields].sort((a, b) => rank(a.key) - rank(b.key));
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
/** `RecruitmentOS-{resource}-{YYYY-MM-DD-HHmm}.csv` in Asia/Dubai time. */
export function exportFilename(resource: string, now: Date) {
  const dubai = new Date(now.valueOf() + 4 * 3600000).toISOString();
  return `RecruitmentOS-${resource}-${dubai.slice(0, 10)}-${dubai.slice(11, 13)}${dubai.slice(14, 16)}.csv`;
}
