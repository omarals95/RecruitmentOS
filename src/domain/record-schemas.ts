// The record data schemas. This module imports only zod, so the config modules read them without a
// load-time cycle through records.ts. records.ts re-exports the public names; text, optionalDay
// and jsonObject are exported for records.ts only.
import { z } from "zod";

export const APPLICATION_STAGES = [
  "Sourced",
  "Screening",
  "Interview",
  "Offer",
  "Hired",
  "Rejected",
  "Withdrawn",
] as const;
export const CANDIDATE_STATUSES = [
  "New",
  "To contact",
  "Contacted",
  "Interviewing",
  "On hold",
  "Closed",
] as const;
export const TASK_FIELD_TYPES = [
  "Text",
  "Number",
  "Date",
  "Dropdown",
  "Checkbox",
] as const;
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];
/** Source review states; "Needs review" until someone checks the source facts. */
export const REVIEW_STATUSES = ["Needs review", "Reviewed"] as const;
/** Legacy free text: the reviewed words map to "Reviewed", anything else needs review. */
export function reviewStatusValue(
  value: string,
): (typeof REVIEW_STATUSES)[number] {
  return /^(verified|reviewed|complete|completed)$/i.test(value.trim())
    ? "Reviewed"
    : "Needs review";
}
export const uuidSchema = z.uuid();
export const text = (max = 200) => z.string().trim().max(max).default("");
const requiredText = (max = 200) => z.string().trim().min(1).max(max);
const tags = z
  .array(requiredText(200))
  .max(300)
  .default([])
  .transform((values) => [...new Set(values)]);
export const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
    "Invalid calendar date",
  );
export const optionalDay = z.union([daySchema, z.literal("")]).default("");
const notes = () => text(10000);
type JsonValue = z.output<ReturnType<typeof z.json>>;
function boundedJson(value: unknown): value is JsonValue {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  const visited = new Set<object>();
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > 30000 || item.depth > 20) return false;
    if (
      item.value === null ||
      ["string", "boolean"].includes(typeof item.value)
    )
      continue;
    if (typeof item.value === "number") {
      if (!Number.isFinite(item.value)) return false;
      continue;
    }
    if (typeof item.value !== "object" || visited.has(item.value)) return false;
    if (
      !Array.isArray(item.value) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(item.value))
    )
      return false;
    visited.add(item.value);
    for (const child of Object.values(item.value))
      stack.push({ value: child, depth: item.depth + 1 });
  }
  return true;
}
const jsonValue = z.custom<JsonValue>(
  boundedJson,
  "Source metadata must be plain JSON with at most 20 nesting levels",
);
export const jsonObject = z
  .record(z.string().max(200), jsonValue)
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 200000,
    "Source metadata is too large",
  );
const savedQuery = z
  .object({
    search: text(500),
    category: text(),
    categories: z.array(requiredText()).max(100).optional(),
    skills: z.array(requiredText()).max(100).optional(),
    certifications: z.array(requiredText()).max(100).optional(),
    emirate: text(),
    degreeLevel: text(),
    education: text(300),
    minYearsExperience: z.number().min(0).max(100).optional(),
    maxYearsExperience: z.number().min(0).max(100).optional(),
    status: text(),
    stage: z.enum(APPLICATION_STAGES).optional(),
    vacancyId: uuidSchema.optional(),
    reviewStatus: z.union([z.enum(REVIEW_STATUSES), z.literal("")]).default(""),
    shortlisted: z.boolean().optional(),
    needsReview: z.boolean().optional(),
    includeArchived: z.boolean().optional(),
    sort: z
      .enum(["name", "title", "createdAt", "updatedAt", "yearsExperience"])
      .optional(),
    direction: z.enum(["asc", "desc"]).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
  })
  .strict();

/** Optional candidate fields about sensitive traits; MCP tools never return or search them. */
export const SENSITIVE_CANDIDATE_FIELDS = [
  "explicitGender",
  "nationalServiceStatus",
] as const;

/** Most possible-duplicate matches one contact lookup returns. */
export const CANDIDATE_DUPLICATE_LIMIT = 20;
/** Most CV files one bulk import batch can hold. */
export const BULK_INTAKE_MAX_FILES = 200;
/** Hours a bulk import batch's recovery rows stay readable, counted from its creation. */
export const BULK_INTAKE_RECOVERY_HOURS = 24;

export const recordDataSchemas = {
  candidate: z
    .object({
      name: requiredText(300),
      email: z.union([z.email().max(320), z.literal("")]).default(""),
      phone: text(100),
      university: text(500),
      degreeLevel: text(100),
      degreeName: text(500),
      gpa: text(100),
      major: text(500),
      yearsExperience: z.number().min(0).max(100).nullable().default(null),
      documentedYearsEstimate: z
        .number()
        .min(0)
        .max(100)
        .nullable()
        .default(null),
      employer: text(500),
      jobTitle: text(500),
      nationalServiceStatus: text(200),
      explicitGender: text(100),
      residenceEmirate: text(100),
      folderCategories: tags,
      skills: tags,
      certifications: tags,
      languages: tags,
      educationStatus: text(300),
      educationDates: text(500),
      latestRoleDates: text(500),
      roleStatus: text(300),
      experienceBasis: text(1000),
      experienceWording: text(2000),
      reviewStatus: z.enum(REVIEW_STATUSES).default("Needs review"),
      sourceNotes: notes(),
      rawSource: jsonObject.default({}),
      evidence: z.array(jsonObject).max(1000).default([]),
      sourceReviews: z.array(jsonValue).max(1000).default([]),
    })
    .strict(),
  "job-role": z
    .object({
      title: requiredText(),
      department: text(),
      location: text(300),
      employmentType: text(100),
      workMode: text(100),
      description: notes(),
      requirements: notes(),
      skills: tags,
    })
    .strict(),
  vacancy: z
    .object({
      title: requiredText(),
      requisitionId: text(100),
      department: text(),
      location: text(300),
      employmentType: text(100),
      workMode: text(100),
      description: notes(),
      requirements: notes(),
      skills: tags,
      openings: z.number().int().min(1).max(10000).default(1),
      status: z
        .enum(["Draft", "Open", "On hold", "Filled", "Closed"])
        .default("Draft"),
      hiringManager: text(),
      recruiter: text(),
      targetDate: optionalDay,
    })
    .strict(),
  application: z
    .object({
      stage: z.enum(APPLICATION_STAGES).default("Sourced"),
      source: text(),
      owner: text(),
      notes: notes(),
      appliedDate: optionalDay,
    })
    .strict(),
  bucket: z
    .object({
      name: requiredText(120),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default("#4338CA"),
      position: z.number().int().min(0).max(10000).default(0),
      completed: z.boolean().default(false),
    })
    .strict(),
  "task-field": z
    .object({
      name: requiredText(120),
      type: z.enum(TASK_FIELD_TYPES).default("Text"),
      options: z.array(requiredText(200)).max(100).default([]),
      required: z.boolean().default(false),
      position: z.number().int().min(0).max(10000).default(0),
    })
    .strict(),
  task: z
    .object({
      title: requiredText(),
      context: text(2000),
      owner: text(),
      dueDate: optionalDay,
      priority: z.enum(["Low", "Normal", "High", "Urgent"]).default("Normal"),
      description: notes(),
      customValues: z
        .record(
          uuidSchema,
          z.union([
            z.string().max(4000),
            z.number().finite(),
            z.boolean(),
            z.null(),
          ]),
        )
        .default({}),
    })
    .strict(),
  interview: z
    .object({
      title: requiredText(),
      startAt: z.iso
        .datetime({ offset: true })
        .transform((value) => new Date(value).toISOString()),
      minutes: z.number().int().min(15).max(480).default(60),
      interviewer: text(),
      location: text(300),
      meetingUrl: z
        .union([z.url({ protocol: /^https?$/ }).max(2000), z.literal("")])
        .default(""),
      status: z
        .enum(["Scheduled", "Completed", "Cancelled", "No show"])
        .default("Scheduled"),
      notes: notes(),
    })
    .strict(),
  offer: z
    .object({
      title: requiredText(),
      amount: z
        .string()
        .regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/)
        .refine((value) => Number(value) <= 1000000000)
        .nullable()
        .default(null),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .default("AED"),
      payPeriod: z
        .enum(["Monthly", "Annual", "Hourly", "One-time"])
        .default("Monthly"),
      sentDate: optionalDay,
      expiryDate: optionalDay,
      status: z
        .enum(["Draft", "Sent", "Accepted", "Declined", "Withdrawn", "Expired"])
        .default("Draft"),
      declineReason: text(2000),
      notes: notes(),
    })
    .strict(),
  onboarding: z
    .object({
      startDate: optionalDay,
      owner: text(),
      status: z
        .enum(["Planned", "In progress", "Completed", "On hold"])
        .default("Planned"),
      notes: notes(),
    })
    .strict(),
  checklist: z
    .object({
      title: requiredText(),
      category: z
        .enum(["Document", "Orientation", "Training", "Other"])
        .default("Other"),
      dueDate: optionalDay,
      owner: text(),
      status: z
        .enum(["Pending", "In progress", "Complete", "Waived"])
        .default("Pending"),
      notes: notes(),
    })
    .strict(),
  "saved-view": z
    .object({
      name: requiredText(120),
      area: z.enum(["directory", "applications"]),
      query: savedQuery,
    })
    .strict(),
  comment: z
    .object({
      body: requiredText(4000),
      legacyAuthorLabel: z.string().trim().max(200).optional(),
    })
    .strict(),
} as const;
