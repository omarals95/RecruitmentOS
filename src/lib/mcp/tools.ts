import { sql } from "drizzle-orm";
import { z } from "zod";
import type {
  CallToolResult,
  Tool as ListedTool,
} from "@modelcontextprotocol/sdk/types.js";
import { listCandidateCvsPage } from "@/lib/cvs";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import { overview } from "@/lib/insights";
import { requireScope, type Scope } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import {
  bulkApplications,
  createRecord,
  getRecord,
  listRecords,
  recordKindOf,
  updateRecord,
} from "@/lib/records";
import {
  APPLICATION_STAGES,
  REVIEW_STATUSES,
  SENSITIVE_CANDIDATE_FIELDS,
  bulkApplicationsSchema,
  recordDataSchemas,
  referenceFields,
  referencesByKind,
  type RecordDto,
  type ReferenceField,
  type ResourceName,
} from "@/domain/records";
import {
  GET_TEXT_LIMIT,
  LIST_TEXT_LIMIT,
  capRecord,
  clip,
  dubaiDateTime,
  failure,
  failureFrom,
  success,
} from "./results";

type Data = Record<string, unknown>;
/** read: changes nothing; create: only adds records; change: changes an existing record. */
type Effect = "read" | "create" | "change";
interface ToolDefinition<S extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  scopes: Scope[];
  effect: Effect;
  input: S;
  run: (p: Principal, input: z.output<S>) => Promise<CallToolResult>;
}
type McpTool = ToolDefinition<z.ZodType>;
const tool = <S extends z.ZodType>(definition: ToolDefinition<S>) =>
  definition as unknown as McpTool;

const page = z.number().int().min(1).max(1000).default(1);
const pageSize = z.number().int().min(1).max(25).default(10);
const filter = z.string().trim().max(300);
const query = z.string().max(500);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const tags = z.array(z.string().trim().min(1).max(200)).max(20);
const version = z.number().int().min(1);
const archived = z.boolean().optional();
/** Stages a new application can start at; outcomes go through move_application_stage. */
const startStage = recordDataSchemas.application.shape.stage
  .unwrap()
  .exclude(["Rejected", "Withdrawn"]);
const REREAD =
  "This record changed since you read it. Read it again for its current version and values, check the change still applies, then retry.";

/** Only defined filters are passed to the shared list function. */
function listQuery(values: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined)
      params.set(
        key,
        Array.isArray(value) ? JSON.stringify(value) : String(value),
      );
  return params;
}
function fields(row: RecordDto, keys: string[]): Data {
  const data = row.data as Data;
  return Object.fromEntries(keys.map((key) => [key, data[key] ?? null]));
}
function listed(rows: Data[]) {
  return rows.map((row) => capRecord(row, LIST_TEXT_LIMIT));
}
/** The version an update needs and whether the record is archived. */
function state(row: RecordDto) {
  return { version: row.version, archived: row.archivedAt !== null };
}
/** A write result: the record's identity, version, times and references, never its text. */
function written(row: RecordDto): Data {
  return {
    id: row.id,
    ...state(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...Object.fromEntries(
      (Object.keys(referencesByKind[row.kind]) as ReferenceField[]).map(
        (key) => [key, row[key]],
      ),
    ),
  };
}
/** Tool input as the services take it: reference IDs beside the record's data. */
function writeInput(input: Data) {
  const reference = ([key]: [string, unknown]) =>
    (referenceFields as readonly string[]).includes(key);
  const entries = Object.entries(input);
  return {
    ...Object.fromEntries(entries.filter(reference)),
    data: Object.fromEntries(entries.filter((entry) => !reference(entry))),
  };
}
/** A field schema without its default, so an update sends only the fields the caller gave. */
function withoutDefault(field: z.ZodType): z.ZodType {
  if (field instanceof z.ZodDefault) return field.unwrap() as z.ZodType;
  if (field instanceof z.ZodPipe && field.in instanceof z.ZodDefault)
    return z.pipe(field.in.unwrap() as z.ZodType, field.out);
  return field;
}
/** Update input: id, version and at least one of the fields, none of them defaulted. */
function changeInput(
  shape: Record<string, z.ZodType>,
  extra: Record<string, z.ZodType> = {},
) {
  return z
    .object({
      id: z.uuid(),
      version,
      ...Object.fromEntries(
        Object.entries(shape).map(([key, field]) => [
          key,
          withoutDefault(field).optional(),
        ]),
      ),
      ...extra,
    })
    .strict()
    .refine(
      (value) => Object.keys(value).length > 2,
      "Send at least one field to change.",
    );
}
const creates =
  (resource: ResourceName) =>
  async (p: Principal, { idempotencyKey: key, ...input }: Data) =>
    success(
      written(
        await createRecord(p, resource, writeInput(input), key as string),
      ),
    );
const changes =
  (resource: ResourceName) =>
  async (p: Principal, { id, version, ...input }: Data) =>
    success(
      written(
        await updateRecord(p, resource, id as string, {
          version,
          ...writeInput(input),
        }),
      ),
    );
/** The record types archive_record and restore_record take, with their services' resources. */
const RECORD_TYPES = [
  "job_role",
  "vacancy",
  "application",
  "interview",
  "offer",
  "onboarding",
  "checklist_item",
] as const;
const ARCHIVABLE: Record<(typeof RECORD_TYPES)[number], ResourceName> = {
  job_role: "job-roles",
  vacancy: "vacancies",
  application: "applications",
  interview: "interviews",
  offer: "offers",
  onboarding: "onboarding",
  checklist_item: "checklist",
};
const archiveInput = z
  .object({ recordType: z.enum(RECORD_TYPES), id: z.uuid(), version })
  .strict();
const archives =
  (archived: boolean) =>
  async (p: Principal, input: z.output<typeof archiveInput>) =>
    success(
      written(
        await updateRecord(p, ARCHIVABLE[input.recordType], input.id, {
          version: input.version,
          archived,
        }),
      ),
    );
function taskItem(row: RecordDto): Data {
  return {
    id: row.id,
    ...fields(row, ["title", "context", "owner", "dueDate", "priority"]),
    bucketId: row.bucketId,
    candidateId: row.candidateId,
    vacancyId: row.vacancyId,
    updatedAt: row.updatedAt,
  };
}
function interviewItem(row: RecordDto): Data {
  const data = row.data as Data;
  const startAt = new Date(String(data.startAt)).toISOString();
  return {
    id: row.id,
    ...state(row),
    applicationId: row.applicationId,
    title: data.title,
    startAt,
    startAtDubai: dubaiDateTime(startAt),
    timezone: "Asia/Dubai",
    ...fields(row, ["minutes", "interviewer", "location", "status"]),
    hasMeetingUrl: Boolean(data.meetingUrl),
  };
}
function factsOf(row: RecordDto, omit: string[] = []) {
  return {
    id: row.id,
    ...state(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    facts: fields(
      row,
      Object.keys(recordDataSchemas[row.kind].shape).filter(
        (key) => !omit.includes(key),
      ),
    ),
  };
}
/** Source fields that may hold copies of the sensitive fields, as legacy imports do. */
const SOURCE_FIELDS = ["rawSource", "evidence", "sourceReviews"];
const SENSITIVE_EVIDENCE = [
  "gender",
  "national service",
  "nationalservice",
  "male/female",
];
/** Whether any key or string value of an evidence entry mentions a sensitive field. */
function sensitiveEvidence(entry: unknown) {
  if (!entry || typeof entry !== "object") return false;
  return Object.entries(entry as Data).some(([key, value]) =>
    [key, typeof value === "string" ? value : ""].some((text) =>
      SENSITIVE_EVIDENCE.some((word) => text.toLowerCase().includes(word)),
    ),
  );
}
/** The first ten non-sensitive evidence entries, each reduced to ten short scalar pairs. */
function evidenceSummary(data: Data) {
  const evidence = (Array.isArray(data.evidence) ? data.evidence : []).filter(
    (entry) => !sensitiveEvidence(entry),
  );
  const reviews = Array.isArray(data.sourceReviews) ? data.sourceReviews : [];
  return {
    evidenceCount: evidence.length,
    sourceReviewCount: reviews.length,
    items: evidence.slice(0, 10).map((entry) =>
      Object.fromEntries(
        Object.entries(
          entry && typeof entry === "object" ? (entry as Data) : {},
        )
          .filter(([, value]) =>
            ["string", "number", "boolean"].includes(typeof value),
          )
          .slice(0, 10)
          .map(([key, value]) => [
            clip(key, 100),
            typeof value === "string" ? clip(value, 300) : value,
          ]),
      ),
    ),
  };
}

const candidateInput = recordDataSchemas.candidate.pick({
  email: true,
  phone: true,
  university: true,
  degreeLevel: true,
  degreeName: true,
  major: true,
  yearsExperience: true,
  employer: true,
  jobTitle: true,
  residenceEmirate: true,
  skills: true,
  certifications: true,
  languages: true,
  sourceNotes: true,
}).shape;

/**
 * Grouped by area. Keep the names in step with the allowlist in tenant_context.audit_mcp_call
 * (drizzle/0024_mcp_pipeline_tools.sql): a tool whose name is not on it is refused before it runs.
 */
export const TOOLS: McpTool[] = [
  tool({
    name: "search_candidates",
    title: "Search candidates",
    description:
      "Search active candidates by stated facts: words, quoted phrases and -exclusions, plus skill, certification, folder category, emirate, degree, education and review filters, and a range of stated years of experience (unstated never matches). Returns factual fields only; nothing is ranked or scored.",
    scopes: ["candidates:read"],
    effect: "read",
    input: z
      .object({
        query: query.optional(),
        skills: tags.optional(),
        certifications: tags.optional(),
        categories: tags.optional(),
        residenceEmirate: filter.optional(),
        degreeLevel: filter.optional(),
        education: filter.optional(),
        minYearsExperience: z.number().min(0).max(100).optional(),
        maxYearsExperience: z.number().min(0).max(100).optional(),
        reviewStatus: z.enum(REVIEW_STATUSES).optional(),
        needsReview: z.boolean().optional(),
        sort: z.enum(["name", "updatedAt", "yearsExperience"]).optional(),
        direction: z.enum(["asc", "desc"]).optional(),
        page,
        pageSize,
      })
      .strict(),
    run: async (p, input) => {
      const { query: search, ...rest } = input;
      const result = await listRecords(
        p,
        "candidates",
        listQuery({ search, ...rest }),
        { omitFromSearch: [...SENSITIVE_CANDIDATE_FIELDS, ...SOURCE_FIELDS] },
      );
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            ...fields(row, [
              "name",
              "jobTitle",
              "employer",
              "residenceEmirate",
              "degreeLevel",
              "yearsExperience",
              "skills",
              "folderCategories",
              "reviewStatus",
            ]),
            updatedAt: row.updatedAt,
          })),
        ),
        result.pagination,
      );
    },
  }),
  tool({
    name: "get_candidate",
    title: "Get candidate",
    description:
      "One candidate's stated facts, an evidence summary and, with cvs:read, CV file metadata. Never returns personal shortlists, follow-up statuses, private notes or CV contents.",
    scopes: ["candidates:read"],
    effect: "read",
    input: z.object({ id: z.uuid() }).strict(),
    run: async (p, input) => {
      const row = await getRecord(p, "candidates", input.id);
      const data = row.data as Data;
      let cvs: Data[] | null = null;
      if (p.scopes.includes("cvs:read"))
        cvs = (
          await listCandidateCvsPage(p, input.id, { pageSize: 20 })
        ).data.map((cv) => ({
          id: cv.id,
          originalName: cv.originalName,
          mimeType: cv.mimeType,
          sizeBytes: cv.sizeBytes,
          status: cv.status,
          createdAt: cv.createdAt,
          completedAt: cv.completedAt,
        }));
      return success(
        capRecord(
          {
            ...factsOf(row, [...SOURCE_FIELDS, ...SENSITIVE_CANDIDATE_FIELDS]),
            evidenceSummary: evidenceSummary(data),
            cvs,
            ...(cvs ? {} : { cvsNote: "cvs:read scope required" }),
          },
          GET_TEXT_LIMIT,
        ),
      );
    },
  }),
  tool({
    name: "create_candidate",
    title: "Create candidate",
    description:
      "Create one candidate from stated facts. Requires an idempotencyKey: retrying with the same key and input returns the same candidate; the same key with different input is refused.",
    scopes: ["candidates:write"],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        name: recordDataSchemas.candidate.shape.name,
        ...candidateInput,
      })
      .strict(),
    run: async (p, input) => {
      const { idempotencyKey: key, ...data } = input;
      const row = await createRecord(p, "candidates", { data }, key);
      return success({
        id: row.id,
        name: (row.data as Data).name,
        createdAt: row.createdAt,
      });
    },
  }),
  tool({
    name: "list_job_roles",
    title: "List job roles",
    description:
      "List job roles, optionally by department or text. Pass archived: true to list only archived job roles, for example to restore one. Each item has the version an update needs.",
    scopes: ["recruitment:read"],
    effect: "read",
    input: z
      .object({
        department: filter.optional(),
        query: query.optional(),
        archived,
        page,
        pageSize,
      })
      .strict(),
    run: async (p, input) => {
      const { query: search, ...rest } = input;
      const result = await listRecords(
        p,
        "job-roles",
        listQuery({ search, ...rest }),
      );
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            ...state(row),
            ...fields(row, [
              "title",
              "department",
              "location",
              "employmentType",
              "workMode",
              "skills",
            ]),
            updatedAt: row.updatedAt,
          })),
        ),
        result.pagination,
      );
    },
  }),
  tool({
    name: "create_job_role",
    title: "Create job role",
    description:
      "Create one job role, a reusable template for vacancies. Requires an idempotencyKey: retrying with the same key and input returns the same job role; the same key with different input is refused.",
    scopes: ["recruitment:write"],
    effect: "create",
    input: z
      .object({ idempotencyKey, ...recordDataSchemas["job-role"].shape })
      .strict(),
    run: creates("job-roles"),
  }),
  tool({
    name: "update_job_role",
    title: "Update job role",
    description:
      "Change the fields you send on one job role; other fields stay as they are. Vacancies made from it do not change. Requires the version from list_job_roles; if the record changed since, the tool returns version_conflict.",
    scopes: ["recruitment:write"],
    effect: "change",
    input: changeInput(recordDataSchemas["job-role"].shape),
    run: changes("job-roles"),
  }),
  tool({
    name: "list_vacancies",
    title: "List vacancies",
    description:
      "List vacancies with optional status, department and text filters. Pass archived: true to list only archived vacancies. Each item has the version an update needs.",
    scopes: ["recruitment:read"],
    effect: "read",
    input: z
      .object({
        status: recordDataSchemas.vacancy.shape.status.unwrap().optional(),
        department: filter.optional(),
        query: query.optional(),
        archived,
        page,
        pageSize,
      })
      .strict(),
    run: async (p, input) => {
      const { query: search, ...rest } = input;
      const result = await listRecords(
        p,
        "vacancies",
        listQuery({ search, ...rest }),
      );
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            ...state(row),
            ...fields(row, [
              "title",
              "requisitionId",
              "department",
              "location",
              "employmentType",
              "workMode",
              "status",
              "openings",
              "targetDate",
            ]),
            updatedAt: row.updatedAt,
          })),
        ),
        result.pagination,
      );
    },
  }),
  tool({
    name: "get_vacancy",
    title: "Get vacancy",
    description:
      "One vacancy's facts, including description, requirements, skills, hiring manager and recruiter, and its version.",
    scopes: ["recruitment:read"],
    effect: "read",
    input: z.object({ id: z.uuid() }).strict(),
    run: async (p, input) =>
      success(
        capRecord(
          factsOf(await getRecord(p, "vacancies", input.id)),
          GET_TEXT_LIMIT,
        ),
      ),
  }),
  tool({
    name: "create_vacancy",
    title: "Create vacancy",
    description:
      "Create one vacancy, optionally from a job role and with a status (Draft unless you send another, such as Open). Requires an idempotencyKey: retrying with the same key and input returns the same vacancy; the same key with different input is refused.",
    scopes: ["recruitment:write"],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        jobRoleId: z.uuid().optional(),
        ...recordDataSchemas.vacancy.shape,
      })
      .strict(),
    run: creates("vacancies"),
  }),
  tool({
    name: "update_vacancy",
    title: "Update vacancy",
    description:
      "Change the fields you send on one vacancy, such as its status (Draft, Open, On hold, Filled or Closed) or jobRoleId (null clears it). Requires the version from list_vacancies or get_vacancy; if the record changed since, the tool returns version_conflict.",
    scopes: ["recruitment:write"],
    effect: "change",
    input: changeInput(recordDataSchemas.vacancy.shape, {
      jobRoleId: z.uuid().nullable().optional(),
    }),
    run: changes("vacancies"),
  }),
  tool({
    name: "list_applications",
    title: "List applications",
    description:
      "List applications for exactly one candidate or one vacancy, optionally by stage. Pass archived: true to list only archived ones. Labels name the candidate only with candidates:read.",
    scopes: ["recruitment:read"],
    effect: "read",
    input: z
      .object({
        candidateId: z.uuid().optional(),
        vacancyId: z.uuid().optional(),
        stage: z.enum(APPLICATION_STAGES).optional(),
        archived,
        page,
        pageSize,
      })
      .strict()
      .refine(
        (value) =>
          (value.candidateId === undefined) !== (value.vacancyId === undefined),
        "Provide exactly one of candidateId or vacancyId.",
      ),
    run: async (p, input) => {
      const result = await listRecords(p, "applications", listQuery(input));
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            ...state(row),
            candidateId: row.candidateId,
            vacancyId: row.vacancyId,
            label: row.label ?? null,
            ...fields(row, ["stage", "source", "owner", "appliedDate"]),
            updatedAt: row.updatedAt,
          })),
        ),
        result.pagination,
      );
    },
  }),
  tool({
    name: "get_application",
    title: "Get application",
    description:
      "Get one application's facts, candidate and vacancy IDs, label and version. The label names the candidate only with candidates:read.",
    scopes: ["recruitment:read"],
    effect: "read",
    input: z.object({ id: z.uuid() }).strict(),
    run: async (p, input) => {
      const row = await getRecord(p, "applications", input.id);
      return success(
        capRecord(
          {
            ...factsOf(row),
            candidateId: row.candidateId,
            vacancyId: row.vacancyId,
            label: row.label ?? null,
          },
          GET_TEXT_LIMIT,
        ),
      );
    },
  }),
  tool({
    name: "create_application",
    title: "Create application",
    description:
      "Add one candidate to a vacancy, at any stage but Rejected or Withdrawn (Sourced unless you send another). A candidate has one active application per vacancy. Requires an idempotencyKey: retrying with the same key and input returns the same application.",
    scopes: ["recruitment:write"],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        candidateId: z.uuid(),
        vacancyId: z.uuid(),
        stage: startStage.optional(),
        ...recordDataSchemas.application.omit({ stage: true }).shape,
      })
      .strict(),
    run: creates("applications"),
  }),
  tool({
    name: "bulk_create_applications",
    title: "Bulk create applications",
    description:
      "Add up to 500 candidates to one vacancy; candidates already active on it are skipped. Returns counts and IDs only. Requires an idempotencyKey: retrying with the same key and input returns the same result; the same key with different input is refused.",
    scopes: ["recruitment:write", "candidates:read"],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        vacancyId: z.uuid(),
        candidateIds: bulkApplicationsSchema.shape.candidateIds,
        stage: startStage.optional(),
        owner: bulkApplicationsSchema.shape.owner.optional(),
        source: bulkApplicationsSchema.shape.source.optional(),
        appliedDate: bulkApplicationsSchema.shape.appliedDate.optional(),
      })
      .strict(),
    run: async (p, input) => {
      const { idempotencyKey: key, ...rest } = input;
      // A stored replay holds the full records too; both are reduced to IDs.
      const result = await bulkApplications(p, rest, key);
      return success({
        created: result.created,
        skipped: result.skipped,
        createdIds: result.data.map((row) => row.id),
        existingIds: result.existing.map((row) => row.id),
      });
    },
  }),
  tool({
    name: "update_application",
    title: "Update application",
    description:
      "Change the source, owner, notes or applied date you send on one application. To change its stage, reject or withdraw, use move_application_stage. Requires the version from list_applications or get_application; if the record changed since, the tool returns version_conflict.",
    scopes: ["recruitment:write"],
    effect: "change",
    input: changeInput(
      recordDataSchemas.application.omit({ stage: true }).shape,
    ),
    run: changes("applications"),
  }),
  tool({
    name: "move_application_stage",
    title: "Move application stage",
    description:
      "Move one application to a stage; this is also how to reject or withdraw, which need a reason. A reason is saved as a comment on the application in the same change. Requires the current version; if the record changed since, the tool returns version_conflict.",
    scopes: ["recruitment:write"],
    effect: "change",
    input: z
      .object({
        id: z.uuid(),
        version,
        stage: z.enum(APPLICATION_STAGES),
        reason: z.string().trim().min(1).max(2000).optional(),
      })
      .strict()
      .refine(
        (value) =>
          value.reason !== undefined ||
          !["Rejected", "Withdrawn"].includes(value.stage),
        { message: "Give a reason to reject or withdraw.", path: ["reason"] },
      ),
    run: async (p, input) => {
      const row = await updateRecord(
        p,
        "applications",
        input.id,
        { version: input.version, data: { stage: input.stage } },
        input.reason === undefined
          ? {}
          : { comment: `Moved to ${input.stage}. Reason: ${input.reason}` },
      );
      return success({
        ...written(row),
        stage: input.stage,
        ...(row.commentId ? { commentId: row.commentId } : {}),
      });
    },
  }),
  tool({
    name: "list_interviews",
    title: "List interviews",
    description:
      "List interviews with start times in UTC and Asia/Dubai, optionally by application, candidate, status or start range; for calendar questions use startFrom and startTo (ISO 8601 with offset). Pass archived: true for archived ones. Meeting links are not returned.",
    scopes: ["recruitment:read"],
    effect: "read",
    input: z
      .object({
        applicationId: z.uuid().optional(),
        candidateId: z.uuid().optional(),
        status: recordDataSchemas.interview.shape.status.unwrap().optional(),
        startFrom: z.iso.datetime({ offset: true }).optional(),
        startTo: z.iso.datetime({ offset: true }).optional(),
        archived,
        page,
        pageSize,
      })
      .strict(),
    run: async (p, input) => {
      const { candidateId, ...rest } = input;
      const result = await listRecords(
        p,
        "interviews",
        listQuery({ ...rest, applicationCandidateId: candidateId }),
      );
      return success(listed(result.data.map(interviewItem)), result.pagination);
    },
  }),
  tool({
    name: "schedule_interview",
    title: "Schedule interview",
    description:
      "Schedule one interview for an application; startAt is ISO 8601 with an offset, and it starts as Scheduled. A meeting link is stored, never opened. Requires an idempotencyKey: retrying with the same key and input returns the same interview.",
    scopes: ["recruitment:write"],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        applicationId: z.uuid(),
        ...recordDataSchemas.interview.omit({ status: true }).shape,
      })
      .strict(),
    run: creates("interviews"),
  }),
  tool({
    name: "update_interview",
    title: "Update interview",
    description:
      "Change the fields you send on one interview: reschedule it with a new startAt, add notes, or set its status to Completed, Cancelled or No show. Requires the version from list_interviews; if the record changed since, the tool returns version_conflict.",
    scopes: ["recruitment:write"],
    effect: "change",
    input: changeInput(recordDataSchemas.interview.shape),
    run: changes("interviews"),
  }),
  tool({
    name: "list_offers",
    title: "List offers",
    description:
      "List offers, optionally by application, candidate or status. Pass archived: true to list only archived offers. Each item has the version an update needs.",
    scopes: ["recruitment:read"],
    effect: "read",
    input: z
      .object({
        applicationId: z.uuid().optional(),
        candidateId: z.uuid().optional(),
        status: recordDataSchemas.offer.shape.status.unwrap().optional(),
        archived,
        page,
        pageSize,
      })
      .strict(),
    run: async (p, input) => {
      const { candidateId, ...rest } = input;
      const result = await listRecords(
        p,
        "offers",
        listQuery({ ...rest, applicationCandidateId: candidateId }),
      );
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            ...state(row),
            applicationId: row.applicationId,
            ...fields(row, [
              "title",
              "amount",
              "currency",
              "payPeriod",
              "sentDate",
              "expiryDate",
              "status",
              "declineReason",
            ]),
            updatedAt: row.updatedAt,
          })),
        ),
        result.pagination,
      );
    },
  }),
  tool({
    name: "create_offer",
    title: "Create offer",
    description:
      'Create one draft offer for an application; amount is a decimal string such as "15000.00". Set its status later with update_offer. Requires an idempotencyKey: retrying with the same key and input returns the same offer.',
    scopes: ["recruitment:write"],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        applicationId: z.uuid(),
        ...recordDataSchemas.offer.omit({ status: true, declineReason: true })
          .shape,
      })
      .strict(),
    run: creates("offers"),
  }),
  tool({
    name: "update_offer",
    title: "Update offer",
    description:
      "Change the fields you send on one offer, such as its status (Draft, Sent, Accepted, Declined, Withdrawn or Expired) and a declineReason when declined. Requires the version from list_offers; if the record changed since, the tool returns version_conflict.",
    scopes: ["recruitment:write"],
    effect: "change",
    input: changeInput(recordDataSchemas.offer.shape),
    run: changes("offers"),
  }),
  tool({
    name: "list_onboarding",
    title: "List onboarding",
    description:
      "List onboarding records, optionally by application, candidate or status. Pass archived: true to list only archived ones. Labels name the candidate only with candidates:read.",
    scopes: ["recruitment:read"],
    effect: "read",
    input: z
      .object({
        applicationId: z.uuid().optional(),
        candidateId: z.uuid().optional(),
        status: recordDataSchemas.onboarding.shape.status.unwrap().optional(),
        archived,
        page,
        pageSize,
      })
      .strict(),
    run: async (p, input) => {
      const { candidateId, ...rest } = input;
      const result = await listRecords(
        p,
        "onboarding",
        listQuery({ ...rest, applicationCandidateId: candidateId }),
      );
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            ...state(row),
            applicationId: row.applicationId,
            label: row.label ?? null,
            ...fields(row, ["startDate", "owner", "status"]),
            updatedAt: row.updatedAt,
          })),
        ),
        result.pagination,
      );
    },
  }),
  tool({
    name: "create_onboarding",
    title: "Create onboarding",
    description:
      "Start onboarding for one application; it starts as Planned, and an application has at most one active onboarding. Requires an idempotencyKey: retrying with the same key and input returns the same onboarding.",
    scopes: ["recruitment:write"],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        applicationId: z.uuid(),
        ...recordDataSchemas.onboarding.omit({ status: true }).shape,
      })
      .strict(),
    run: creates("onboarding"),
  }),
  tool({
    name: "update_onboarding",
    title: "Update onboarding",
    description:
      "Change the fields you send on one onboarding record; set status Completed to complete it. Requires the version from list_onboarding; if the record changed since, the tool returns version_conflict.",
    scopes: ["recruitment:write"],
    effect: "change",
    input: changeInput(recordDataSchemas.onboarding.shape),
    run: changes("onboarding"),
  }),
  tool({
    name: "list_checklist_items",
    title: "List checklist items",
    description:
      "List onboarding checklist items, optionally by onboarding record or status. Pass archived: true to list only archived items. Each item has the version an update needs.",
    scopes: ["recruitment:read"],
    effect: "read",
    input: z
      .object({
        onboardingId: z.uuid().optional(),
        status: recordDataSchemas.checklist.shape.status.unwrap().optional(),
        archived,
        page,
        pageSize,
      })
      .strict(),
    run: async (p, input) => {
      const result = await listRecords(p, "checklist", listQuery(input));
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            ...state(row),
            onboardingId: row.onboardingId,
            ...fields(row, ["title", "category", "dueDate", "owner", "status"]),
            updatedAt: row.updatedAt,
          })),
        ),
        result.pagination,
      );
    },
  }),
  tool({
    name: "create_checklist_item",
    title: "Create checklist item",
    description:
      "Add one checklist item to an onboarding record; it starts as Pending. Requires an idempotencyKey: retrying with the same key and input returns the same item; the same key with different input is refused.",
    scopes: ["recruitment:write"],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        onboardingId: z.uuid(),
        ...recordDataSchemas.checklist.omit({ status: true }).shape,
      })
      .strict(),
    run: creates("checklist"),
  }),
  tool({
    name: "update_checklist_item",
    title: "Update checklist item",
    description:
      "Change the fields you send on one checklist item; set status Complete to complete it, or Waived. Requires the version from list_checklist_items; if the record changed since, the tool returns version_conflict.",
    scopes: ["recruitment:write"],
    effect: "change",
    input: changeInput(recordDataSchemas.checklist.shape),
    run: changes("checklist"),
  }),
  tool({
    name: "list_tasks",
    title: "List tasks",
    description:
      "Active recruitment tasks, optionally by bucket, candidate, vacancy or priority.",
    scopes: ["recruitment:read"],
    effect: "read",
    input: z
      .object({
        bucketId: z.uuid().optional(),
        candidateId: z.uuid().optional(),
        vacancyId: z.uuid().optional(),
        priority: recordDataSchemas.task.shape.priority.unwrap().optional(),
        page,
        pageSize,
      })
      .strict(),
    run: async (p, input) => {
      const result = await listRecords(p, "tasks", listQuery(input));
      return success(listed(result.data.map(taskItem)), result.pagination);
    },
  }),
  tool({
    name: "get_overview",
    title: "Get overview",
    description:
      "Team inventory counts, data coverage, stage and category totals, upcoming interviews and overdue tasks.",
    scopes: ["candidates:read", "recruitment:read"],
    effect: "read",
    input: z.object({}).strict(),
    run: async (p) => {
      const result = await overview(p);
      const { shortlisted: _personal, ...counts } = result.counts;
      return success({
        counts,
        coverage: result.coverage,
        stages: result.stages,
        departments: result.departments,
        categories: result.categories,
        upcomingInterviews: listed(
          result.upcomingInterviews.map(interviewItem),
        ),
        overdueTasks: listed(result.overdueTasks.map(taskItem)),
        asOf: result.asOf,
        timezone: result.timezone,
      });
    },
  }),
  tool({
    name: "add_comment",
    title: "Add comment",
    description:
      "Append a comment to an active candidate, vacancy or application. Comments on a candidate also require candidates:read and candidates:write. Requires an idempotencyKey; comments cannot be edited or deleted.",
    scopes: ["recruitment:write"],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        parentRecordId: z.uuid(),
        body: recordDataSchemas.comment.shape.body,
      })
      .strict(),
    run: async (p, input) => {
      // Without candidates:read, a candidate parent is answered as a missing record.
      const parent = await recordKindOf(p, input.parentRecordId);
      if (parent.kind === "candidate") requireScope(p, "candidates:write");
      if (
        parent.archived ||
        !["candidate", "vacancy", "application"].includes(parent.kind)
      )
        throw new ApiError(
          400,
          "invalid_reference",
          "Comment on an active candidate, vacancy or application.",
        );
      const row = await createRecord(
        p,
        "comments",
        { parentRecordId: input.parentRecordId, data: { body: input.body } },
        input.idempotencyKey,
      );
      return success({
        id: row.id,
        parentRecordId: row.parentRecordId,
        createdAt: row.createdAt,
      });
    },
  }),
  tool({
    name: "archive_record",
    title: "Archive record",
    description:
      "Archive one job role, vacancy, application, interview, offer, onboarding record or checklist item. It leaves active lists but is kept and can be restored with restore_record; nothing is deleted. Requires the current version; if the record changed since, the tool returns version_conflict.",
    scopes: ["recruitment:write"],
    effect: "change",
    input: archiveInput,
    run: archives(true),
  }),
  tool({
    name: "restore_record",
    title: "Restore record",
    description:
      "Restore one archived job role, vacancy, application, interview, offer, onboarding record or checklist item; find it with a list tool and archived: true. Refused if it would duplicate an active record. Requires the current version; a changed record returns version_conflict.",
    scopes: ["recruitment:write"],
    effect: "change",
    input: archiveInput,
    run: archives(false),
  }),
];

function allowed(p: Principal, definition: McpTool) {
  return definition.scopes.every((scope) => p.scopes.includes(scope));
}
function inputSchema(definition: McpTool): ListedTool["inputSchema"] {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(definition.input, {
    io: "input",
  }) as Record<string, unknown>;
  return schema as ListedTool["inputSchema"];
}
/** Only the tools the principal's current effective scopes allow. */
export function listTools(p: Principal): ListedTool[] {
  return TOOLS.filter((definition) => allowed(p, definition)).map(
    (definition) => ({
      name: definition.name,
      title: definition.title,
      description: `${definition.description} Requires ${definition.scopes.join(" and ")}.`,
      inputSchema: inputSchema(definition),
      // A repeated change with the same version is refused, so it changes nothing more.
      annotations:
        definition.effect === "read"
          ? { readOnlyHint: true, openWorldHint: false }
          : {
              readOnlyHint: false,
              destructiveHint: definition.effect === "change",
              idempotentHint: true,
              openWorldHint: false,
            },
    }),
  );
}

/**
 * Audits, then runs, one known tool. The audit row is written in its own transaction before the
 * tool runs and records only the tool name and decision; if it fails, the tool does not run.
 */
export async function callTool(
  p: Principal,
  definition: McpTool,
  args: unknown,
): Promise<CallToolResult> {
  const decision = allowed(p, definition) ? "allowed" : "denied";
  try {
    await withTeam(p, async (tx) => {
      await tx.execute(
        sql`select tenant_context.audit_mcp_call(${definition.name}, ${decision})`,
      );
    });
  } catch (error) {
    return failureFrom(error);
  }
  if (decision === "denied")
    return failure(
      "scope_required",
      `This tool requires ${definition.scopes.join(" and ")}.`,
    );
  try {
    for (const scope of definition.scopes) requireScope(p, scope);
    const parsed = definition.input.safeParse(args ?? {});
    if (!parsed.success)
      return failure(
        "invalid_input",
        parsed.error.issues
          .slice(0, 8)
          .map(
            (issue) => `${issue.path.join(".") || "input"}: ${issue.message}`,
          )
          .join("; "),
      );
    return await definition.run(p, parsed.data);
  } catch (error) {
    // An assistant cannot review a draft, so it is told to reread rather than to refresh.
    if (error instanceof ApiError && error.code === "version_conflict")
      return failure("version_conflict", REREAD);
    return failureFrom(error);
  }
}
