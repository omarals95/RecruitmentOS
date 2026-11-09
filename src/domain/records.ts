import { z } from "zod";
import { CONFIGURABLE_KINDS, type ConfigurableKind } from "./config";
import {
  DEFAULT_KIND_SCHEMAS,
  KIND_LABELS,
  systemFieldConfig,
} from "./config-defaults";
import {
  APPLICATION_STAGES,
  CANDIDATE_STATUSES,
  jsonObject,
  optionalDay,
  recordDataSchemas,
  text,
  uuidSchema,
} from "./record-schemas";

export {
  APPLICATION_STAGES,
  BULK_INTAKE_MAX_FILES,
  BULK_INTAKE_RECOVERY_HOURS,
  CANDIDATE_DUPLICATE_LIMIT,
  CANDIDATE_STATUSES,
  REVIEW_STATUSES,
  SENSITIVE_CANDIDATE_FIELDS,
  TASK_FIELD_TYPES,
  daySchema,
  recordDataSchemas,
  reviewStatusValue,
  uuidSchema,
  type ApplicationStage,
} from "./record-schemas";

export type RecordKind = keyof typeof recordDataSchemas;
export type RecordDataMap = {
  [K in RecordKind]: z.output<(typeof recordDataSchemas)[K]>;
};
export const resourceToKind = {
  candidates: "candidate",
  "job-roles": "job-role",
  vacancies: "vacancy",
  applications: "application",
  buckets: "bucket",
  "task-fields": "task-field",
  tasks: "task",
  interviews: "interview",
  offers: "offer",
  onboarding: "onboarding",
  checklist: "checklist",
  views: "saved-view",
  comments: "comment",
} as const;
export type ResourceName = keyof typeof resourceToKind;
export const kindToResource = Object.fromEntries(
  Object.entries(resourceToKind).map(([resource, kind]) => [kind, resource]),
) as { [K in RecordKind]: ResourceName };
export const referenceFields = [
  "candidateId",
  "vacancyId",
  "applicationId",
  "onboardingId",
  "bucketId",
  "jobRoleId",
  "parentRecordId",
] as const;
export type ReferenceField = (typeof referenceFields)[number];
export type RecordReferences = { [K in ReferenceField]: string | null };
export interface RecordDto<
  K extends RecordKind = RecordKind,
> extends RecordReferences {
  id: string;
  kind: K;
  version: number;
  data: RecordDataMap[K];
  legacyId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  createdBy: string;
  privateOwnerId: string | null;
  importMeta?: Record<string, unknown>;
  label?: string;
  /** Applications only: the candidate's name, left out without candidates:read. */
  candidateLabel?: string;
  /** Applications only: the vacancy's title. */
  vacancyLabel?: string;
  authorName?: string | null;
}
export const referencesByKind: Record<
  RecordKind,
  Partial<
    Record<
      ReferenceField,
      { kind: RecordKind | "*"; required?: boolean; immutable?: boolean }
    >
  >
> = {
  candidate: {},
  "job-role": {},
  vacancy: { jobRoleId: { kind: "job-role" } },
  application: {
    candidateId: { kind: "candidate", required: true, immutable: true },
    vacancyId: { kind: "vacancy", required: true, immutable: true },
  },
  bucket: {},
  "task-field": {},
  task: {
    bucketId: { kind: "bucket", required: true },
    candidateId: { kind: "candidate" },
    vacancyId: { kind: "vacancy" },
  },
  interview: {
    applicationId: { kind: "application", required: true, immutable: true },
  },
  offer: {
    applicationId: { kind: "application", required: true, immutable: true },
  },
  onboarding: {
    applicationId: { kind: "application", required: true, immutable: true },
  },
  checklist: {
    onboardingId: { kind: "onboarding", required: true, immutable: true },
  },
  "saved-view": {},
  comment: { parentRecordId: { kind: "*", required: true, immutable: true } },
};
const referenceShape = Object.fromEntries(
  referenceFields.map((key) => [key, uuidSchema.nullable().optional()]),
) as { [K in ReferenceField]: z.ZodOptional<z.ZodNullable<typeof uuidSchema>> };
export const createRecordSchemas = Object.fromEntries(
  Object.entries(recordDataSchemas).map(([kind, data]) => [
    kind,
    z
      .object({
        data,
        ...referenceShape,
        legacyId: z.string().trim().min(1).max(200).optional(),
        importMeta: jsonObject.optional(),
        archived: z.boolean().optional(),
      })
      .strict(),
  ]),
) as unknown as Record<RecordKind, z.ZodType>;
function partialDataSchema(data: z.ZodObject) {
  // Zod 4 applies defaults inside optional fields. Retain only submitted keys so
  // a partial save cannot reset an existing stage, field type or factual value.
  return z.record(z.string(), z.unknown()).transform((value, context) => {
    const result = data.partial().safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues)
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
      return z.NEVER;
    }
    const parsed = result.data as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(value).map((key) => [key, parsed[key]]),
    );
  });
}
export const updateRecordSchemas = Object.fromEntries(
  Object.entries(recordDataSchemas).map(([kind, data]) => [
    kind,
    z
      .object({
        version: z.number().int().min(1),
        data: partialDataSchema(data).optional(),
        ...referenceShape,
        archived: z.boolean().optional(),
        moveToBucketId: uuidSchema.optional(),
        importMeta: jsonObject.optional(),
      })
      .strict(),
  ]),
) as unknown as Record<RecordKind, z.ZodType>;
export const bulkApplicationsSchema = z
  .object({
    candidateIds: z.array(uuidSchema).min(1).max(500),
    vacancyId: uuidSchema,
    stage: z.enum(APPLICATION_STAGES).default("Sourced"),
    owner: text(),
    source: text(),
    appliedDate: optionalDay,
  })
  .strict();
export const candidateStateSchema = z
  .object({
    version: z.number().int().min(0),
    shortlisted: z.boolean().optional(),
    status: z.enum(CANDIDATE_STATUSES).optional(),
    note: z.string().trim().max(10000).optional(),
    importMeta: jsonObject.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.shortlisted !== undefined ||
      value.status !== undefined ||
      value.note !== undefined ||
      value.importMeta !== undefined,
    "At least one state change is required",
  );
export function dubaiToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function searchTerms(
  query: string,
): { value: string; excluded: boolean }[] {
  return [...query.matchAll(/(-?)(?:"([^"]+)"|(\S+))/g)]
    .map((match) => ({
      value: (match[2] || match[3]).toLocaleLowerCase(),
      excluded: match[1] === "-",
    }))
    .filter((term) => !!term.value);
}
export function factualText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object")
    return Object.values(value).map(factualText).join(" ");
  return String(value).toLocaleLowerCase();
}
/** An absolute http(s) URL to link to, or null; stored values stay untrusted when rendered. */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function matchesSearch(value: unknown, query: string): boolean {
  const haystack = factualText(value);
  return searchTerms(query).every((term) =>
    term.excluded
      ? !haystack.includes(term.value)
      : haystack.includes(term.value),
  );
}

export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "datetime-local"
  | "select"
  | "tags"
  | "checkbox"
  | "json";
export interface FieldConfig {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: readonly string[];
  readOnly?: boolean;
}
export interface ResourceConfig {
  kind: RecordKind;
  label: string;
  singular: string;
  fields: FieldConfig[];
}
// The configurable kinds take their entries from the compiled default kind schemas; buckets,
// task fields, saved views and comments are not configurable and use the same field builder.
function resourceConfig(kind: RecordKind): ResourceConfig {
  if ((CONFIGURABLE_KINDS as readonly RecordKind[]).includes(kind)) {
    const { label, singular, fields } =
      DEFAULT_KIND_SCHEMAS[kind as ConfigurableKind].body;
    return {
      kind,
      label,
      singular,
      fields: fields.map(
        ({ key, label, type, options, required, readOnly }) => ({
          key,
          label,
          type,
          options,
          required,
          readOnly,
        }),
      ),
    };
  }
  return {
    kind,
    label: KIND_LABELS[kind][0],
    singular: KIND_LABELS[kind][1],
    fields: Object.keys(recordDataSchemas[kind].shape).map((key) =>
      systemFieldConfig(kind, key),
    ),
  };
}
export const RESOURCE_CONFIG = Object.fromEntries(
  Object.entries(resourceToKind).map(([resource, kind]) => [
    resource,
    resourceConfig(kind),
  ]),
) as Record<ResourceName, ResourceConfig>;
