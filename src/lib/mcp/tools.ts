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
  createRecord,
  getRecord,
  listRecords,
  recordKindOf,
} from "@/lib/records";
import {
  APPLICATION_STAGES,
  REVIEW_STATUSES,
  SENSITIVE_CANDIDATE_FIELDS,
  recordDataSchemas,
  type RecordDto,
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
interface ToolDefinition<S extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  scopes: Scope[];
  writes: boolean;
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
    archived: row.archivedAt !== null,
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

export const TOOLS: McpTool[] = [
  tool({
    name: "search_candidates",
    title: "Search candidates",
    description:
      "Search active candidates by stated facts: words, quoted phrases and -exclusions, plus skill, certification, folder category, emirate, degree, education (degree name, major or university) and review filters, and a stated-experience range in years (candidates without stated experience never match it). Returns factual fields only; nothing is ranked or scored.",
    scopes: ["candidates:read"],
    writes: false,
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
    writes: false,
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
    name: "list_vacancies",
    title: "List vacancies",
    description:
      "Active vacancies with optional status, department and text filters.",
    scopes: ["recruitment:read"],
    writes: false,
    input: z
      .object({
        status: recordDataSchemas.vacancy.shape.status.unwrap().optional(),
        department: filter.optional(),
        query: query.optional(),
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
      "One vacancy's facts, including description, requirements, skills, hiring manager and recruiter.",
    scopes: ["recruitment:read"],
    writes: false,
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
    name: "list_applications",
    title: "List applications",
    description:
      "Applications for exactly one candidate or one vacancy, optionally by stage. Labels name the candidate only with candidates:read.",
    scopes: ["recruitment:read"],
    writes: false,
    input: z
      .object({
        candidateId: z.uuid().optional(),
        vacancyId: z.uuid().optional(),
        stage: z.enum(APPLICATION_STAGES).optional(),
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
    name: "list_tasks",
    title: "List tasks",
    description:
      "Active recruitment tasks, optionally by bucket, candidate, vacancy or priority.",
    scopes: ["recruitment:read"],
    writes: false,
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
    name: "list_interviews",
    title: "List interviews",
    description:
      "Interviews with start times in UTC and Asia/Dubai, optionally by application, status or start range (ISO 8601 with offset). Meeting links are not returned.",
    scopes: ["recruitment:read"],
    writes: false,
    input: z
      .object({
        applicationId: z.uuid().optional(),
        status: recordDataSchemas.interview.shape.status.unwrap().optional(),
        startFrom: z.iso.datetime({ offset: true }).optional(),
        startTo: z.iso.datetime({ offset: true }).optional(),
        page,
        pageSize,
      })
      .strict(),
    run: async (p, input) => {
      const result = await listRecords(p, "interviews", listQuery(input));
      return success(listed(result.data.map(interviewItem)), result.pagination);
    },
  }),
  tool({
    name: "get_overview",
    title: "Get overview",
    description:
      "Team inventory counts, data coverage, stage and category totals, upcoming interviews and overdue tasks.",
    scopes: ["candidates:read", "recruitment:read"],
    writes: false,
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
    name: "create_candidate",
    title: "Create candidate",
    description:
      "Create one candidate from stated facts. Requires an idempotencyKey: retrying with the same key and input returns the same candidate; the same key with different input is refused.",
    scopes: ["candidates:write"],
    writes: true,
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
    name: "add_comment",
    title: "Add comment",
    description:
      "Append a comment to an active candidate, vacancy or application. Requires an idempotencyKey; comments cannot be edited or deleted.",
    scopes: ["recruitment:write"],
    writes: true,
    input: z
      .object({
        idempotencyKey,
        parentRecordId: z.uuid(),
        body: recordDataSchemas.comment.shape.body,
      })
      .strict(),
    run: async (p, input) => {
      const parent = await recordKindOf(p, input.parentRecordId);
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
      annotations: definition.writes
        ? {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          }
        : { readOnlyHint: true, openWorldHint: false },
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
    return failureFrom(error);
  }
}
