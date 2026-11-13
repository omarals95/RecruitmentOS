import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type {
  CallToolResult,
  Tool as ListedTool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  beginBulkItemUpload,
  bulkItemSchema,
  createBulkItem,
  getBulkBatch,
} from "@/lib/bulk-intake";
import {
  accessContext,
  decide,
  hiddenKeys,
  readOnlyKeys,
  type AccessContext,
  type AccessRequest,
} from "@/lib/authz";
import {
  beginCvUpload,
  completeCvUpload,
  listCandidateCvsPage,
} from "@/lib/cvs";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import {
  analytics,
  listActivity,
  markNotifications,
  notifications,
  overview,
  searchWorkspace,
} from "@/lib/insights";
import { appOrigin } from "@/lib/oauth";
import { TEAM_ARCHIVED, type Scope } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import {
  bulkApplications,
  candidateDuplicateQuerySchema,
  createRecord,
  findCandidateDuplicates,
  getCandidateState,
  getRecord,
  listRecords,
  recordKindOf,
  updateCandidateState,
  updateRecord,
} from "@/lib/records";
import {
  storageConfigured,
  STORAGE_SETUP_REQUIRED_MESSAGE,
} from "@/lib/storage";
import { MAX_CV_BYTES } from "@/lib/storage-format";
import {
  APPLICATION_STAGES,
  BULK_INTAKE_MAX_FILES,
  BULK_INTAKE_RECOVERY_HOURS,
  CANDIDATE_DUPLICATE_LIMIT,
  CANDIDATE_STATUSES,
  REVIEW_STATUSES,
  SENSITIVE_CANDIDATE_FIELDS,
  bulkApplicationsSchema,
  candidateStateSchema,
  recordDataSchemas,
  referenceFields,
  referencesByKind,
  systemFieldKeys,
  type RecordDto,
  type ReferenceField,
  type ResourceName,
} from "@/domain/records";
import { RECORD_RESOURCES } from "@/domain/config";
import {
  ACCESS_OFF_MESSAGE,
  CvTextAccessOff,
  checkedFile,
  cvSummary,
  cvText,
  cvTextLimits,
  decodedFile,
  derivedId,
  itemError,
  noCv,
  numberedCv,
  numberedCvs,
  requireBlobUpload,
  storeAndComplete,
  textBudget,
  type NumberedCv,
} from "./cv-files";
import {
  CV_TEXT_RESULT_BYTES,
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
  /** The text of the description suffix and of a refusal; the engine checks them too. */
  scopes: Scope[];
  /** Every entry must be allowed; an array entry is allowed when any one of its requests is. */
  access: (AccessRequest | AccessRequest[])[];
  effect: Effect;
  input: S;
  /** `args` are the arguments as sent, before the input schema added its defaults. */
  run: (
    p: Principal,
    input: z.output<S>,
    ctx: AccessContext,
    args: unknown,
  ) => Promise<CallToolResult>;
}
type McpTool = ToolDefinition<z.ZodType>;
const tool = <S extends z.ZodType>(definition: ToolDefinition<S>) =>
  definition as unknown as McpTool;

/** The kinds the overview and analytics count, each viewed on the tool's page. */
const inventory = (page: "home" | "analytics") =>
  (
    [
      "candidates",
      "vacancies",
      "applications",
      "tasks",
      "interviews",
      "offers",
      "onboarding",
    ] as const
  ).map((resource): AccessRequest => ({ page, resource, action: "view" }));
/** The reminder kinds, as the notifications service views them. */
const REMINDER_KINDS = (
  [
    "tasks",
    "interviews",
    "offers",
    "checklist",
    "vacancies",
    "onboarding",
  ] as const
).map((resource): AccessRequest => ({ resource, action: "view" }));
/** The groups search_workspace searches, as the search service views them. */
const SEARCHED_KINDS = (
  ["candidates", "vacancies", "job-roles", "tasks", "applications"] as const
).map((resource): AccessRequest => ({ resource, action: "view" }));
/** The record history of any record kind, viewed on the activity page. */
const ACTIVITY_KINDS = RECORD_RESOURCES.map((resource): AccessRequest => ({
  page: "activity",
  resource,
  action: "view",
}));

type InputCheck = { scope: Scope; requests: AccessRequest[] };
/** The checks some inputs add, each refused in the words of the scope it stands for. */
export const INPUT_CHECKS = {
  /** archive_record and restore_record with recordType candidate. */
  archiveCandidate: {
    scope: "candidates:write",
    requests: [{ resource: "candidates", action: "edit" }],
  },
  /** get_cv_texts with vacancyId. */
  vacancyCvTexts: {
    scope: "recruitment:read",
    requests: [
      { resource: "vacancies", action: "view" },
      { resource: "applications", action: "view" },
    ],
  },
  /** upload_cv with newCandidate. */
  newCandidateUpload: {
    scope: "candidates:write",
    requests: [{ resource: "candidates", action: "create" }],
  },
  /** update_task with customValues. */
  taskCustomValues: {
    scope: "recruitment:read",
    requests: [{ resource: "tasks", action: "view" }],
  },
  /** add_comment on a candidate. */
  candidateComment: {
    scope: "candidates:write",
    requests: [{ resource: "candidates", action: "comment" }],
  },
} satisfies Record<string, InputCheck>;
/** Whether the engine allows every request of a per-input check on the call's context. */
export function inputAllowed(ctx: AccessContext, check: InputCheck) {
  return check.requests.every((request) => decide(ctx, request));
}
function requireAccess(ctx: AccessContext, check: InputCheck) {
  if (!inputAllowed(ctx, check))
    throw new ApiError(
      403,
      "scope_required",
      `Permission ${check.scope} is required.`,
    );
}

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
/** Whether the caller's role shows a key of the row's kind; a result leaves a hidden key out. */
function visible(ctx: AccessContext, row: RecordDto) {
  const hidden = hiddenKeys(ctx, row.kind);
  return (key: string) => !hidden.has(key);
}
/** The visible keys of the row's data in the order given, an empty one as null. */
function fields(ctx: AccessContext, row: RecordDto, keys: string[]): Data {
  const data = row.data as Data;
  return Object.fromEntries(
    keys.filter(visible(ctx, row)).map((key) => [key, data[key] ?? null]),
  );
}
/** The row's label, unless the role hides it. */
function labelled(ctx: AccessContext, row: RecordDto): Data {
  return visible(ctx, row)("label") ? { label: row.label ?? null } : {};
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
/** Every field optional and without its default. */
function optionalFields(shape: Record<string, z.ZodType>) {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      withoutDefault(field).optional(),
    ]),
  );
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
      ...optionalFields(shape),
      ...extra,
    })
    .strict()
    .refine(
      (value) => Object.keys(value).length > 2,
      "Send at least one field to change.",
    );
}
/**
 * The parsed fields the call's arguments name. A field's default is the service's to apply, so it is
 * never a field the caller named for the field rules (R2b-08).
 */
function sent(input: Data, args: unknown): Data {
  const named = args && typeof args === "object" ? (args as Data) : {};
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => Object.hasOwn(named, key)),
  );
}
const creates =
  (resource: ResourceName) =>
  async (
    p: Principal,
    { idempotencyKey: key, ...input }: Data,
    _ctx: AccessContext,
    args: unknown,
  ) =>
    success(
      written(
        await createRecord(
          p,
          resource,
          writeInput(sent(input, args)),
          key as string,
        ),
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
  "candidate",
  "job_role",
  "vacancy",
  "application",
  "interview",
  "offer",
  "onboarding",
  "checklist_item",
  "task",
] as const;
const ARCHIVABLE: Record<(typeof RECORD_TYPES)[number], ResourceName> = {
  candidate: "candidates",
  job_role: "job-roles",
  vacancy: "vacancies",
  application: "applications",
  interview: "interviews",
  offer: "offers",
  onboarding: "onboarding",
  checklist_item: "checklist",
  task: "tasks",
};
const archiveInput = z
  .object({ recordType: z.enum(RECORD_TYPES), id: z.uuid(), version })
  .strict();
/** Every record type but the candidate, which is decided per input. */
const ARCHIVE_ACCESS = RECORD_TYPES.filter((type) => type !== "candidate").map(
  (type): AccessRequest => ({ resource: ARCHIVABLE[type], action: "edit" }),
);
const archives =
  (archived: boolean) =>
  async (
    p: Principal,
    input: z.output<typeof archiveInput>,
    ctx: AccessContext,
  ) => {
    if (input.recordType === "candidate")
      requireAccess(ctx, INPUT_CHECKS.archiveCandidate);
    return success(
      written(
        await updateRecord(p, ARCHIVABLE[input.recordType], input.id, {
          version: input.version,
          archived,
        }),
      ),
    );
  };
/** Assignees as user ids only, when the row carries them and the role shows them; never names. */
function taskItem(ctx: AccessContext, row: RecordDto): Data {
  const data = row.data as Data;
  return {
    id: row.id,
    ...state(row),
    ...fields(ctx, row, [
      "title",
      "context",
      "owner",
      "dueDate",
      "priority",
      "description",
      "customValues",
    ]),
    ...(Object.hasOwn(data, "assigneeIds") && visible(ctx, row)("assigneeIds")
      ? { assigneeIds: data.assigneeIds }
      : {}),
    bucketId: row.bucketId,
    candidateId: row.candidateId,
    vacancyId: row.vacancyId,
    parentRecordId: row.parentRecordId,
    updatedAt: row.updatedAt,
  };
}
/** Times and the meeting-link flag only from visible fields: a hidden one derives nothing. */
function interviewItem(ctx: AccessContext, row: RecordDto): Data {
  const data = row.data as Data;
  const see = visible(ctx, row);
  let start: Data = {};
  if (see("startAt")) {
    const startAt = new Date(String(data.startAt)).toISOString();
    start = {
      startAt,
      startAtDubai: dubaiDateTime(startAt),
      timezone: "Asia/Dubai",
    };
  }
  return {
    id: row.id,
    ...state(row),
    applicationId: row.applicationId,
    ...(see("title") ? { title: data.title } : {}),
    ...start,
    ...fields(ctx, row, ["minutes", "interviewer", "location", "status"]),
    ...(see("meetingUrl") ? { hasMeetingUrl: Boolean(data.meetingUrl) } : {}),
  };
}
function factsOf(ctx: AccessContext, row: RecordDto, omit: string[] = []) {
  return {
    id: row.id,
    ...state(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    facts: fields(
      ctx,
      row,
      systemFieldKeys(row.kind).filter((key) => !omit.includes(key)),
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
/**
 * The first ten non-sensitive evidence entries, each reduced to ten short scalar pairs, with no
 * count or item from a field the role hides.
 */
function evidenceSummary(data: Data, see: (key: string) => boolean) {
  const evidence = (Array.isArray(data.evidence) ? data.evidence : []).filter(
    (entry) => !sensitiveEvidence(entry),
  );
  const reviews = Array.isArray(data.sourceReviews) ? data.sourceReviews : [];
  const items = evidence.slice(0, 10).map((entry) =>
    Object.fromEntries(
      Object.entries(entry && typeof entry === "object" ? (entry as Data) : {})
        .filter(([, value]) =>
          ["string", "number", "boolean"].includes(typeof value),
        )
        .slice(0, 10)
        .map(([key, value]) => [
          clip(key, 100),
          typeof value === "string" ? clip(value, 300) : value,
        ]),
    ),
  );
  return {
    ...(see("evidence") ? { evidenceCount: evidence.length } : {}),
    ...(see("sourceReviews") ? { sourceReviewCount: reviews.length } : {}),
    ...(see("evidence") ? { items } : {}),
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
const DUPLICATE_NOTE =
  "A match is a possible duplicate for a person to review. No match does not prove the candidate is new.";
const fileName = z.string().trim().min(1).max(180);
const fileType = z.string().trim().max(150);
/** Bounded by the request body limit; the decoded file is checked against 3 MiB. */
const contentBase64 = z.string().min(1).max(4_400_000);
const LINK_NEXT_STEP =
  "Send the file's exact bytes to upload.url with upload.method and exactly upload.headers, with no credentials or other headers, then call complete_cv_upload with cv.id.";
const UPLOADED = "This CV is already uploaded.";

/** Task buckets and task fields share three tools; each item type has its own keys. */
const WORKFLOW_ITEMS = {
  bucket: { resource: "buckets", label: "buckets" },
  field: { resource: "task-fields", label: "fields" },
} as const;
const WORKFLOW_SHAPES = {
  bucket: recordDataSchemas.bucket.shape,
  field: recordDataSchemas["task-field"].shape,
};
const itemType = z.enum(["bucket", "field"]);
type ItemType = z.output<typeof itemType>;
/** Refuses a key that belongs only to the other item type. */
function ownKeys(
  value: Data & { itemType: ItemType },
  context: z.RefinementCtx,
) {
  const own = Object.keys(WORKFLOW_SHAPES[value.itemType]);
  for (const [type, shape] of Object.entries(WORKFLOW_SHAPES))
    for (const key of Object.keys(shape))
      if (type !== value.itemType && !own.includes(key) && key in value)
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} applies only to ${WORKFLOW_ITEMS[type as ItemType].label}`,
        });
}
const workflowFields = optionalFields({
  ...WORKFLOW_SHAPES.bucket,
  ...WORKFLOW_SHAPES.field,
});
function workflowItem(
  ctx: AccessContext,
  row: RecordDto,
  type: ItemType,
): Data {
  return {
    id: row.id,
    ...state(row),
    ...fields(ctx, row, Object.keys(WORKFLOW_SHAPES[type])),
  };
}

const OTHER_GROUP = "Other recorded values";
const GROUP_LISTS = [
  "departments",
  "categories",
  "offers",
  "declineReasons",
  "sources",
  "emirates",
] as const;
/** The first 25 groups with clipped names, and every other count summed into one trailing group. */
function foldGroups(groups: { name: string; count: number }[]) {
  const named = groups.filter((group) => group.name !== OTHER_GROUP);
  const kept = named
    .slice(0, 25)
    .map((group) => ({ name: clip(group.name, 200), count: group.count }));
  const rest = groups.filter((group) => !named.slice(0, 25).includes(group));
  if (!rest.length) return { groups: kept, folded: false };
  const count = rest.reduce((sum, group) => sum + group.count, 0);
  return { groups: [...kept, { name: OTHER_GROUP, count }], folded: true };
}

/**
 * Grouped by area. Keep the names in step with the allowlist in tenant_context.audit_mcp_call
 * (drizzle/0026_mcp_cv_tools.sql): a tool whose name is not on it is refused before it runs.
 */
export const TOOLS: McpTool[] = [
  tool({
    name: "search_candidates",
    title: "Search candidates",
    description:
      "Search candidates by stated facts: words, quoted phrases and -exclusions, skill, certification, category, emirate, degree, education, review and stated-experience filters, and your own shortlist or follow-up status. Pass archived: true for archived ones. Nothing is ranked or scored.",
    scopes: ["candidates:read"],
    access: [{ resource: "candidates", action: "view" }],
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
        shortlisted: z.boolean().optional(),
        followUpStatus: z.enum(CANDIDATE_STATUSES).optional(),
        archived,
        sort: z.enum(["name", "updatedAt", "yearsExperience"]).optional(),
        direction: z.enum(["asc", "desc"]).optional(),
        page,
        pageSize,
      })
      .strict(),
    run: async (p, input, ctx) => {
      const { query: search, followUpStatus, ...rest } = input;
      // On candidates, status is the caller's own follow-up status.
      const result = await listRecords(
        p,
        "candidates",
        listQuery({ search, ...rest, status: followUpStatus }),
        {
          omitFromSearch: [...SENSITIVE_CANDIDATE_FIELDS, ...SOURCE_FIELDS],
          channel: "mcp",
        },
      );
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            ...state(row),
            ...fields(ctx, row, [
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
    access: [{ resource: "candidates", action: "view" }],
    effect: "read",
    input: z.object({ id: z.uuid() }).strict(),
    run: async (p, input, ctx) => {
      const row = await getRecord(p, "candidates", input.id, "mcp");
      const data = row.data as Data;
      let cvs: Data[] | null = null;
      if (ctx.scopes.includes("cvs:read"))
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
            ...factsOf(ctx, row, [
              ...SOURCE_FIELDS,
              ...SENSITIVE_CANDIDATE_FIELDS,
            ]),
            evidenceSummary: evidenceSummary(data, visible(ctx, row)),
            cvs,
            ...(cvs ? {} : { cvsNote: "cvs:read scope required" }),
          },
          GET_TEXT_LIMIT,
        ),
      );
    },
  }),
  tool({
    name: "find_duplicate_candidates",
    title: "Find duplicate candidates",
    description:
      "Find possible duplicates by email or by a phone number of at least seven digits. Call it before create_candidate. A match is only possible and needs a person to review; no match does not prove the candidate is new. Changes nothing.",
    scopes: ["candidates:read"],
    access: [{ resource: "candidates", action: "view" }],
    effect: "read",
    input: candidateDuplicateQuerySchema,
    run: async (p, input, ctx) => {
      const result = await findCandidateDuplicates(p, input, "mcp");
      // A match leaves out the contact fields the role hides.
      const hidden = hiddenKeys(ctx, "candidate");
      return success({
        matches: listed(
          result.data.map((match) =>
            Object.fromEntries(
              Object.entries(match).filter(([key]) => !hidden.has(key)),
            ),
          ),
        ),
        limited: result.limited,
        limit: CANDIDATE_DUPLICATE_LIMIT,
        note: DUPLICATE_NOTE,
      });
    },
  }),
  tool({
    name: "create_candidate",
    title: "Create candidate",
    description:
      "Create one candidate from stated facts. Requires an idempotencyKey: retrying with the same key and input returns the same candidate; the same key with different input is refused.",
    scopes: ["candidates:write"],
    access: [{ resource: "candidates", action: "create" }],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        name: recordDataSchemas.candidate.shape.name,
        ...candidateInput,
      })
      .strict(),
    run: async (p, input, ctx, args) => {
      const { idempotencyKey: key, ...data } = input;
      const row = await createRecord(
        p,
        "candidates",
        { data: sent(data, args) },
        key,
      );
      return success({
        id: row.id,
        ...fields(ctx, row, ["name"]),
        createdAt: row.createdAt,
      });
    },
  }),
  tool({
    name: "update_candidate",
    title: "Update candidate",
    description:
      "Change the stated facts you send on one candidate, such as name, contact details, education, experience or skills; other fields stay as they are. Requires the version from search_candidates or get_candidate; if the record changed since, the tool returns version_conflict.",
    scopes: ["candidates:write"],
    access: [{ resource: "candidates", action: "edit" }],
    effect: "change",
    input: changeInput({
      name: recordDataSchemas.candidate.shape.name,
      ...candidateInput,
    }),
    run: changes("candidates"),
  }),
  tool({
    name: "get_my_candidate_state",
    title: "Get my candidate state",
    description:
      "Read your own shortlist flag, follow-up status and private note for one candidate, with the version update_my_candidate_state needs. Only you can see this state; version 0 means you have not saved any yet.",
    scopes: ["candidates:read"],
    access: [{ resource: "candidates", action: "view" }],
    effect: "read",
    input: z.object({ candidateId: z.uuid() }).strict(),
    run: async (p, input) => {
      const state = await getCandidateState(p, input.candidateId);
      // The note is returned whole, because an update replaces it whole.
      return success({
        candidateId: state.candidateId,
        shortlisted: state.shortlisted,
        status: state.status,
        note: state.note,
        version: state.version,
        updatedAt: state.updatedAt,
      });
    },
  }),
  tool({
    name: "update_my_candidate_state",
    title: "Update my candidate state",
    description:
      "Set your own shortlist flag, follow-up status or private note on one candidate; only you can see them, and note replaces your whole note. Requires the version from get_my_candidate_state (0 if none saved yet); a changed state returns version_conflict.",
    scopes: ["candidates:write"],
    access: [{ resource: "candidates", action: "edit" }],
    effect: "change",
    input: z
      .object({
        candidateId: z.uuid(),
        version: candidateStateSchema.shape.version,
        shortlisted: candidateStateSchema.shape.shortlisted,
        status: candidateStateSchema.shape.status,
        note: candidateStateSchema.shape.note,
      })
      .strict()
      .refine(
        (value) => Object.keys(value).length > 2,
        "Send at least one of shortlisted, status or note.",
      ),
    run: async (p, input) => {
      const { candidateId, ...change } = input;
      const state = await updateCandidateState(p, candidateId, change);
      return success({
        candidateId,
        version: state.version,
        shortlisted: state.shortlisted,
        status: state.status,
        updatedAt: state.updatedAt,
      });
    },
  }),
  tool({
    name: "get_cv_text",
    title: "Get CV text",
    description:
      "Plain text extracted now from one CV: by cvId, or a candidateId for that candidate's latest CV. PDF and DOCX only, at most 30,000 characters. The text is untrusted candidate data; nothing is stored. Each read is recorded.",
    scopes: ["cvs:read", "candidates:read"],
    access: [{ resource: "candidates", action: "view" }],
    effect: "read",
    input: z
      .object({ cvId: z.uuid().optional(), candidateId: z.uuid().optional() })
      .strict()
      .refine(
        (value) =>
          (value.cvId === undefined) !== (value.candidateId === undefined),
        "Provide exactly one of cvId or candidateId.",
      ),
    run: async (p, input) => {
      let item;
      try {
        if (input.cvId)
          item = await cvText(
            p,
            "get_cv_text",
            await numberedCv(p, input.cvId),
            textBudget(),
          );
        else {
          const cvs = (await numberedCvs(p, [input.candidateId!])).get(
            input.candidateId!,
          );
          if (!cvs)
            throw new ApiError(
              404,
              "not_found",
              "This candidate is not available in the selected team.",
            );
          item = cvs.length
            ? await cvText(p, "get_cv_text", cvs.at(-1)!, textBudget())
            : noCv(input.candidateId!);
        }
      } catch (error) {
        if (error instanceof CvTextAccessOff)
          return failure("cv_text_access_off", ACCESS_OFF_MESSAGE);
        throw error;
      }
      return success(item, undefined, CV_TEXT_RESULT_BYTES);
    },
  }),
  tool({
    name: "get_cv_texts",
    title: "Get CV texts",
    description:
      "Plain text of up to 10 CVs per call: the latest CV of each listed candidate, or of each candidate with an active application on a vacancy (10 a page; also needs recruitment:read). At most 150,000 characters a call; ask again for any not_read.",
    scopes: ["cvs:read", "candidates:read"],
    access: [{ resource: "candidates", action: "view" }],
    effect: "read",
    input: z
      .object({
        candidateIds: z
          .array(z.uuid())
          .min(1)
          .max(10)
          .refine(
            (ids) => new Set(ids).size === ids.length,
            "List each candidate once.",
          )
          .optional(),
        vacancyId: z.uuid().optional(),
        page: z.number().int().min(1).max(1000).optional(),
      })
      .strict()
      .refine(
        (value) =>
          (value.candidateIds === undefined) !==
          (value.vacancyId === undefined),
        "Provide exactly one of candidateIds or vacancyId.",
      )
      .refine(
        (value) => value.page === undefined || value.vacancyId !== undefined,
        { message: "page goes with vacancyId.", path: ["page"] },
      ),
    run: async (p, input, ctx) => {
      let candidateIds = input.candidateIds ?? [];
      let pagination;
      if (input.vacancyId) {
        requireAccess(ctx, INPUT_CHECKS.vacancyCvTexts);
        // A vacancy the caller cannot see is answered as a missing record.
        await getRecord(p, "vacancies", input.vacancyId, "mcp");
        const result = await listRecords(
          p,
          "applications",
          listQuery({
            vacancyId: input.vacancyId,
            page: input.page ?? 1,
            pageSize: 10,
          }),
          { channel: "mcp" },
        );
        candidateIds = result.data.map((row) => row.candidateId as string);
        pagination = result.pagination;
      }
      const found = candidateIds.length
        ? await numberedCvs(p, candidateIds)
        : new Map<string, NumberedCv[]>();
      const budget = textBudget();
      const cvs: Data[] = [];
      try {
        for (const candidateId of candidateIds) {
          const latest = found.get(candidateId)?.at(-1);
          if (!found.has(candidateId))
            cvs.push(itemError(candidateId, null, "not_found"));
          else if (!latest) cvs.push(noCv(candidateId));
          else
            cvs.push(
              await cvText(p, "get_cv_texts", latest, budget).catch(
                async (error: unknown) => {
                  if (error instanceof CvTextAccessOff) throw error;
                  const { structuredContent } = await failureFrom(error);
                  return itemError(
                    candidateId,
                    latest,
                    (structuredContent as { error: { code: string } }).error
                      .code,
                  );
                },
              ),
            );
        }
      } catch (error) {
        if (error instanceof CvTextAccessOff)
          return failure("cv_text_access_off", ACCESS_OFF_MESSAGE);
        throw error;
      }
      return success(
        {
          cvs,
          charactersReturned:
            cvTextLimits.perCallCharacters - budget.characters,
        },
        pagination,
        CV_TEXT_RESULT_BYTES,
      );
    },
  }),
  tool({
    name: "upload_cv",
    title: "Upload CV",
    description:
      "Attach one CV file, sent as base64 (at most 3 MB), to an existing candidate or to a new candidate created from stated facts (newCandidate, also needs candidates:write). The file is checked like any upload. Retrying with the same idempotencyKey creates nothing new.",
    scopes: ["cvs:write"],
    access: [],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        candidateId: z.uuid().optional(),
        newCandidate: z
          .object({
            name: recordDataSchemas.candidate.shape.name,
            ...candidateInput,
          })
          .strict()
          .optional(),
        originalName: fileName,
        mimeType: fileType.optional(),
        contentBase64,
      })
      .strict()
      .refine(
        (value) =>
          (value.candidateId === undefined) !==
          (value.newCandidate === undefined),
        "Provide exactly one of candidateId or newCandidate.",
      ),
    run: async (p, input, ctx, args) => {
      const bytes = decodedFile(input.contentBase64);
      requireBlobUpload();
      const file = checkedFile(
        input.originalName,
        input.mimeType ?? "",
        bytes.length,
      );
      let candidateId = input.candidateId;
      if (input.newCandidate) {
        requireAccess(ctx, INPUT_CHECKS.newCandidateUpload);
        candidateId = (
          await createRecord(
            p,
            "candidates",
            {
              data: sent(input.newCandidate, (args as Data).newCandidate),
            },
            input.idempotencyKey,
          )
        ).id;
      }
      const reserved = await beginCvUpload(p, candidateId!, {
        ...file,
        clientUploadId: derivedId(`upload_cv:${input.idempotencyKey}`),
      });
      return success(await storeAndComplete(p, reserved, bytes));
    },
  }),
  tool({
    name: "create_cv_upload_link",
    title: "Create CV upload link",
    description:
      "For clients that can send HTTP requests themselves: reserve one CV upload (up to 10 MB) for a candidate and get a one-time upload link. Send the exact bytes to it, then call complete_cv_upload. Retrying with the same idempotencyKey reuses the reservation.",
    scopes: ["cvs:write"],
    access: [],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        candidateId: z.uuid(),
        originalName: fileName,
        sizeBytes: z.number().int().min(1).max(MAX_CV_BYTES),
        mimeType: fileType.optional(),
      })
      .strict(),
    run: async (p, input) => {
      const reserved = await beginCvUpload(p, input.candidateId, {
        originalName: input.originalName,
        mimeType: input.mimeType ?? "",
        sizeBytes: input.sizeBytes,
        clientUploadId: derivedId(
          `create_cv_upload_link:${input.idempotencyKey}`,
        ),
      });
      return success({
        cv: cvSummary(reserved.data),
        upload: reserved.upload,
        nextStep: reserved.upload ? LINK_NEXT_STEP : UPLOADED,
      });
    },
  }),
  tool({
    name: "complete_cv_upload",
    title: "Complete CV upload",
    description:
      "Check a CV sent to its upload link and make it available: its size, type and contents are verified. A file still on its way stays pending; a rejected file returns INVALID_CV.",
    scopes: ["cvs:write"],
    access: [],
    effect: "create",
    input: z.object({ cvId: z.uuid() }).strict(),
    run: async (p, input) =>
      success(cvSummary(await completeCvUpload(p, input.cvId))),
  }),
  tool({
    name: "start_bulk_import",
    title: "Start bulk import",
    description:
      "Get a new batch ID for importing up to 200 reviewed CVs with add_bulk_import_item; to skip a file, do not add it. Changes nothing: the batch starts with its first item and stays open for 24 hours.",
    scopes: ["cvs:write", "candidates:write"],
    access: [{ resource: "candidates", action: "create" }],
    effect: "read",
    input: z.object({}).strict(),
    run: async () => {
      if (!storageConfigured())
        throw new ApiError(
          503,
          "STORAGE_SETUP_REQUIRED",
          STORAGE_SETUP_REQUIRED_MESSAGE,
        );
      return success({
        batchId: randomUUID(),
        maxFiles: BULK_INTAKE_MAX_FILES,
        recoveryHours: BULK_INTAKE_RECOVERY_HOURS,
      });
    },
  }),
  tool({
    name: "add_bulk_import_item",
    title: "Add bulk import item",
    description:
      "Import one CV as a Reviewed candidate in a batch, with the file as contentBase64 (up to 3 MB) or sizeBytes for an upload link. First run find_duplicate_candidates on email and phone and show the matches; pass their IDs as acknowledgedDuplicateIds and set both review flags once the user reviewed.",
    scopes: ["cvs:write", "candidates:write"],
    access: [{ resource: "candidates", action: "create" }],
    effect: "create",
    input: z
      .object({
        batchId: z.uuid(),
        idempotencyKey,
        originalName: fileName,
        mimeType: fileType.optional(),
        contentBase64: contentBase64.optional(),
        sizeBytes: z.number().int().min(1).max(MAX_CV_BYTES).optional(),
        candidate: z
          .object({
            name: recordDataSchemas.candidate.shape.name,
            ...candidateInput,
          })
          .strict(),
        factsReviewed: z
          .boolean()
          .optional()
          .describe(
            "True only after the user reviewed these details against the CV.",
          ),
        duplicatesReviewed: z
          .boolean()
          .optional()
          .describe(
            "True only after the user reviewed the find_duplicate_candidates matches.",
          ),
        acknowledgedDuplicateIds: z
          .array(z.uuid())
          .max(CANDIDATE_DUPLICATE_LIMIT)
          .optional()
          .describe(
            "The IDs of the matches the user reviewed. bulk_duplicates_changed means check again.",
          ),
      })
      .strict()
      .refine(
        (value) =>
          (value.contentBase64 === undefined) !==
          (value.sizeBytes === undefined),
        "Provide exactly one of contentBase64 or sizeBytes.",
      ),
    run: async (p, input, _ctx, args) => {
      const bytes =
        input.contentBase64 === undefined
          ? undefined
          : decodedFile(input.contentBase64);
      if (bytes) requireBlobUpload();
      const itemId = derivedId(
        `bulk-item:${input.batchId}:${input.idempotencyKey}`,
      );
      // The app's bulk item schema, so the reviewed details get its defaults and checks.
      const item = await createBulkItem(
        p,
        input.batchId,
        itemId,
        bulkItemSchema.parse({
          file: {
            originalName: input.originalName,
            mimeType: input.mimeType ?? "",
            sizeBytes: bytes?.length ?? input.sizeBytes,
          },
          data: sent(input.candidate, (args as Data).candidate),
          factsReviewed: input.factsReviewed,
          duplicatesReviewed: input.duplicatesReviewed,
          acknowledgedDuplicateIds: input.acknowledgedDuplicateIds,
        }),
      );
      const reserved = await beginBulkItemUpload(p, input.batchId, itemId);
      const imported = {
        id: item.id,
        batchId: item.batchId,
        candidateId: item.candidateId,
        uploadId: reserved.data.id,
      };
      if (bytes)
        return success({
          item: imported,
          cv: await storeAndComplete(p, reserved, bytes),
        });
      return success({
        item: imported,
        cv: cvSummary(reserved.data),
        upload: reserved.upload,
        nextStep: reserved.upload ? LINK_NEXT_STEP : UPLOADED,
      });
    },
  }),
  tool({
    name: "list_bulk_import_items",
    title: "List bulk import items",
    description:
      "List the items imported into one of your batches, with each item's outcome (not-imported, cv-pending, imported or cv-rejected) and the number of possible duplicates found when it was imported.",
    scopes: ["cvs:write", "candidates:write"],
    access: [{ resource: "candidates", action: "create" }],
    effect: "read",
    input: z.object({ batchId: z.uuid() }).strict(),
    run: async (p, input) => {
      const batch = await getBulkBatch(p, input.batchId);
      return success({
        batchId: batch.id,
        createdAt: batch.createdAt,
        expiresAt: batch.expiresAt,
        items: batch.items.map((item) => ({
          ...item,
          originalName: item.originalName && clip(item.originalName, 80),
        })),
      });
    },
  }),
  tool({
    name: "open_bulk_import_page",
    title: "Open bulk import page",
    description:
      "A link to RecruitmentOS's Import CVs screen, for when you cannot send file bytes: the user uploads and reviews the CVs there. Changes nothing.",
    scopes: ["cvs:write", "candidates:write"],
    access: [{ resource: "candidates", action: "create" }],
    effect: "read",
    input: z.object({}).strict(),
    run: async () =>
      success({
        url: `${appOrigin()}/app/candidates?import=cvs`,
        note: "Open this link in a browser where you are signed in to RecruitmentOS. It opens the import in your currently selected team, which must be the same team as this connection.",
      }),
  }),
  tool({
    name: "list_job_roles",
    title: "List job roles",
    description:
      "List job roles, optionally by department or text. Pass archived: true to list only archived job roles, for example to restore one. Each item has the version an update needs.",
    scopes: ["recruitment:read"],
    access: [{ resource: "job-roles", action: "view" }],
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
    run: async (p, input, ctx) => {
      const { query: search, ...rest } = input;
      const result = await listRecords(
        p,
        "job-roles",
        listQuery({ search, ...rest }),
        { channel: "mcp" },
      );
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            ...state(row),
            ...fields(ctx, row, [
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
    access: [{ resource: "job-roles", action: "create" }],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        ...recordDataSchemas["job-role"].omit({ customValues: true }).shape,
      })
      .strict(),
    run: creates("job-roles"),
  }),
  tool({
    name: "update_job_role",
    title: "Update job role",
    description:
      "Change the fields you send on one job role; other fields stay as they are. Vacancies made from it do not change. Requires the version from list_job_roles; if the record changed since, the tool returns version_conflict.",
    scopes: ["recruitment:write"],
    access: [{ resource: "job-roles", action: "edit" }],
    effect: "change",
    input: changeInput(
      recordDataSchemas["job-role"].omit({ customValues: true }).shape,
    ),
    run: changes("job-roles"),
  }),
  tool({
    name: "list_vacancies",
    title: "List vacancies",
    description:
      "List vacancies with optional status, department and text filters. Pass archived: true to list only archived vacancies. Each item has the version an update needs.",
    scopes: ["recruitment:read"],
    access: [{ resource: "vacancies", action: "view" }],
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
    run: async (p, input, ctx) => {
      const { query: search, ...rest } = input;
      const result = await listRecords(
        p,
        "vacancies",
        listQuery({ search, ...rest }),
        { channel: "mcp" },
      );
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            ...state(row),
            ...fields(ctx, row, [
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
    access: [{ resource: "vacancies", action: "view" }],
    effect: "read",
    input: z.object({ id: z.uuid() }).strict(),
    run: async (p, input, ctx) =>
      success(
        capRecord(
          factsOf(ctx, await getRecord(p, "vacancies", input.id, "mcp")),
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
    access: [{ resource: "vacancies", action: "create" }],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        jobRoleId: z.uuid().optional(),
        ...recordDataSchemas.vacancy.omit({ customValues: true }).shape,
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
    access: [{ resource: "vacancies", action: "edit" }],
    effect: "change",
    input: changeInput(
      recordDataSchemas.vacancy.omit({ customValues: true }).shape,
      {
        jobRoleId: z.uuid().nullable().optional(),
      },
    ),
    run: changes("vacancies"),
  }),
  tool({
    name: "list_applications",
    title: "List applications",
    description:
      "List applications for exactly one candidate or one vacancy, optionally by stage. Pass archived: true to list only archived ones. Labels name the candidate only with candidates:read.",
    scopes: ["recruitment:read"],
    access: [{ resource: "applications", action: "view" }],
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
    run: async (p, input, ctx) => {
      const result = await listRecords(p, "applications", listQuery(input), {
        channel: "mcp",
      });
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            ...state(row),
            candidateId: row.candidateId,
            vacancyId: row.vacancyId,
            ...labelled(ctx, row),
            ...fields(ctx, row, ["stage", "source", "owner", "appliedDate"]),
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
    access: [{ resource: "applications", action: "view" }],
    effect: "read",
    input: z.object({ id: z.uuid() }).strict(),
    run: async (p, input, ctx) => {
      const row = await getRecord(p, "applications", input.id, "mcp");
      return success(
        capRecord(
          {
            ...factsOf(ctx, row),
            candidateId: row.candidateId,
            vacancyId: row.vacancyId,
            ...labelled(ctx, row),
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
    access: [{ resource: "applications", action: "create" }],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        candidateId: z.uuid(),
        vacancyId: z.uuid(),
        stage: startStage.optional(),
        ...recordDataSchemas.application.omit({
          stage: true,
          customValues: true,
        }).shape,
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
    access: [
      { resource: "applications", action: "create" },
      { resource: "candidates", action: "view" },
    ],
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
    run: async (p, input, _ctx, args) => {
      const { idempotencyKey: key, ...rest } = input;
      // A stored replay holds the full records too; both are reduced to IDs.
      const result = await bulkApplications(p, sent(rest, args), key);
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
    access: [{ resource: "applications", action: "edit" }],
    effect: "change",
    input: changeInput(
      recordDataSchemas.application.omit({ stage: true, customValues: true })
        .shape,
    ),
    run: changes("applications"),
  }),
  tool({
    name: "move_application_stage",
    title: "Move application stage",
    description:
      "Move one application to a stage; this is also how to reject or withdraw, which need a reason. A reason is saved as a comment on the application in the same change. Requires the current version; if the record changed since, the tool returns version_conflict.",
    scopes: ["recruitment:write"],
    access: [{ resource: "applications", action: "edit" }],
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
    access: [{ resource: "interviews", action: "view" }],
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
    run: async (p, input, ctx) => {
      const { candidateId, ...rest } = input;
      const result = await listRecords(
        p,
        "interviews",
        listQuery({ ...rest, applicationCandidateId: candidateId }),
        { channel: "mcp" },
      );
      return success(
        listed(result.data.map((row) => interviewItem(ctx, row))),
        result.pagination,
      );
    },
  }),
  tool({
    name: "schedule_interview",
    title: "Schedule interview",
    description:
      "Schedule one interview for an application; startAt is ISO 8601 with an offset, and it starts as Scheduled. A meeting link is stored, never opened. Requires an idempotencyKey: retrying with the same key and input returns the same interview.",
    scopes: ["recruitment:write"],
    access: [{ resource: "interviews", action: "create" }],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        applicationId: z.uuid(),
        ...recordDataSchemas.interview.omit({
          status: true,
          customValues: true,
        }).shape,
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
    access: [{ resource: "interviews", action: "edit" }],
    effect: "change",
    input: changeInput(
      recordDataSchemas.interview.omit({ customValues: true }).shape,
    ),
    run: changes("interviews"),
  }),
  tool({
    name: "list_offers",
    title: "List offers",
    description:
      "List offers, optionally by application, candidate or status. Pass archived: true to list only archived offers. Each item has the version an update needs.",
    scopes: ["recruitment:read"],
    access: [{ resource: "offers", action: "view" }],
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
    run: async (p, input, ctx) => {
      const { candidateId, ...rest } = input;
      const result = await listRecords(
        p,
        "offers",
        listQuery({ ...rest, applicationCandidateId: candidateId }),
        { channel: "mcp" },
      );
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            ...state(row),
            applicationId: row.applicationId,
            ...fields(ctx, row, [
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
    access: [{ resource: "offers", action: "create" }],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        applicationId: z.uuid(),
        ...recordDataSchemas.offer.omit({
          status: true,
          declineReason: true,
          customValues: true,
        }).shape,
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
    access: [{ resource: "offers", action: "edit" }],
    effect: "change",
    input: changeInput(
      recordDataSchemas.offer.omit({ customValues: true }).shape,
    ),
    run: changes("offers"),
  }),
  tool({
    name: "list_onboarding",
    title: "List onboarding",
    description:
      "List onboarding records, optionally by application, candidate or status. Pass archived: true to list only archived ones. Labels name the candidate only with candidates:read.",
    scopes: ["recruitment:read"],
    access: [{ resource: "onboarding", action: "view" }],
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
    run: async (p, input, ctx) => {
      const { candidateId, ...rest } = input;
      const result = await listRecords(
        p,
        "onboarding",
        listQuery({ ...rest, applicationCandidateId: candidateId }),
        { channel: "mcp" },
      );
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            ...state(row),
            applicationId: row.applicationId,
            ...labelled(ctx, row),
            ...fields(ctx, row, ["startDate", "owner", "status"]),
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
    access: [{ resource: "onboarding", action: "create" }],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        applicationId: z.uuid(),
        ...recordDataSchemas.onboarding.omit({
          status: true,
          customValues: true,
        }).shape,
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
    access: [{ resource: "onboarding", action: "edit" }],
    effect: "change",
    input: changeInput(
      recordDataSchemas.onboarding.omit({ customValues: true }).shape,
    ),
    run: changes("onboarding"),
  }),
  tool({
    name: "list_checklist_items",
    title: "List checklist items",
    description:
      "List onboarding checklist items, optionally by onboarding record or status. Pass archived: true to list only archived items. Each item has the version an update needs.",
    scopes: ["recruitment:read"],
    access: [{ resource: "checklist", action: "view" }],
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
    run: async (p, input, ctx) => {
      const result = await listRecords(p, "checklist", listQuery(input), {
        channel: "mcp",
      });
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            ...state(row),
            onboardingId: row.onboardingId,
            ...fields(ctx, row, [
              "title",
              "category",
              "dueDate",
              "owner",
              "status",
            ]),
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
    access: [{ resource: "checklist", action: "create" }],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        onboardingId: z.uuid(),
        ...recordDataSchemas.checklist.omit({
          status: true,
          customValues: true,
        }).shape,
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
    access: [{ resource: "checklist", action: "edit" }],
    effect: "change",
    input: changeInput(
      recordDataSchemas.checklist.omit({ customValues: true }).shape,
    ),
    run: changes("checklist"),
  }),
  tool({
    name: "list_tasks",
    title: "List tasks",
    description:
      "List team tasks with their custom field values, optionally by bucket, candidate, vacancy or priority. Pass archived: true to list only archived tasks. Each item has the version an update needs.",
    scopes: ["recruitment:read"],
    access: [{ resource: "tasks", action: "view" }],
    effect: "read",
    input: z
      .object({
        bucketId: z.uuid().optional(),
        candidateId: z.uuid().optional(),
        vacancyId: z.uuid().optional(),
        priority: recordDataSchemas.task.shape.priority.unwrap().optional(),
        archived,
        page,
        pageSize,
      })
      .strict(),
    run: async (p, input, ctx) => {
      const result = await listRecords(p, "tasks", listQuery(input), {
        channel: "mcp",
      });
      return success(
        listed(result.data.map((row) => taskItem(ctx, row))),
        result.pagination,
      );
    },
  }),
  tool({
    name: "create_task",
    title: "Create task",
    description:
      "Create one task in a bucket. Optional: candidateId, vacancyId, parentRecordId (a job role, vacancy, bucket, task field or task), assigneeIds (up to 10 team member user IDs), customValues by field ID (required ones need one). Needs an idempotencyKey; a retry with the same key and input returns it.",
    scopes: ["recruitment:write"],
    access: [{ resource: "tasks", action: "create" }],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        bucketId: z.uuid(),
        candidateId: z.uuid().optional(),
        vacancyId: z.uuid().optional(),
        parentRecordId: z.uuid().optional(),
        ...recordDataSchemas.task.shape,
      })
      .strict(),
    run: creates("tasks"),
  }),
  tool({
    name: "update_task",
    title: "Update task",
    description:
      "Change the fields you send on one task. Move it with bucketId; a completed bucket completes it. customValues sets only the fields sent (null empties one; needs recruitment:read). assigneeIds replaces the assignees; parentRecordId null unlinks. Needs the version from list_tasks, or version_conflict.",
    scopes: ["recruitment:write"],
    access: [{ resource: "tasks", action: "edit" }],
    effect: "change",
    input: changeInput(recordDataSchemas.task.shape, {
      bucketId: z.uuid().optional(),
      candidateId: z.uuid().nullable().optional(),
      vacancyId: z.uuid().nullable().optional(),
      parentRecordId: z.uuid().nullable().optional(),
    }),
    run: async (p, input, ctx) => {
      const { customValues, ...rest } = input as Data;
      if (customValues === undefined) return changes("tasks")(p, rest);
      // A partial map: read the stored values at this version and keep the ones not sent.
      requireAccess(ctx, INPUT_CHECKS.taskCustomValues);
      const current = await getRecord(p, "tasks", rest.id as string);
      if (current.version !== rest.version)
        throw new ApiError(409, "version_conflict", REREAD);
      // Only the stored values the role lets the caller change: the service keeps the others. A
      // sensitive field the role shows stays in the map, so the update never empties it (R2b-09).
      const { channel: _mcp, ...plain } = ctx;
      const locked = new Set([
        ...hiddenKeys(plain, "task"),
        ...readOnlyKeys(ctx, "task"),
      ]);
      return changes("tasks")(p, {
        ...rest,
        customValues: {
          ...Object.fromEntries(
            Object.entries(
              ((current.data as Data).customValues ?? {}) as Data,
            ).filter(([key]) => !locked.has(key)),
          ),
          ...(customValues as Data),
        },
      });
    },
  }),
  tool({
    name: "list_task_workflow_items",
    title: "List task workflow items",
    description:
      'List task buckets (itemType "bucket") or custom task fields (itemType "field") in position order. A bucket with completed: true counts its tasks as done. Pass archived: true for archived ones. Each item has the version an update needs.',
    scopes: ["recruitment:read"],
    access: [
      { resource: "buckets", action: "view" },
      { resource: "task-fields", action: "view" },
    ],
    effect: "read",
    input: z.object({ itemType, archived, page, pageSize }).strict(),
    run: async (p, input, ctx) => {
      const result = await listRecords(
        p,
        WORKFLOW_ITEMS[input.itemType].resource,
        listQuery({
          archived: input.archived,
          sort: "position",
          page: input.page,
          pageSize: input.pageSize,
        }),
        { channel: "mcp" },
      );
      return success(
        listed(
          result.data.map((row) => workflowItem(ctx, row, input.itemType)),
        ),
        result.pagination,
      );
    },
  }),
  tool({
    name: "create_task_workflow_item",
    title: "Create task workflow item",
    description:
      'Add a task bucket (itemType "bucket": name, color, position, completed) or a custom task field (itemType "field": name, type, options, required, position). Requires an idempotencyKey: retrying with the same key and input returns the same item.',
    scopes: ["recruitment:write"],
    access: [
      { resource: "buckets", action: "create" },
      { resource: "task-fields", action: "create" },
    ],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        itemType,
        ...workflowFields,
        name: recordDataSchemas.bucket.shape.name,
      })
      .strict()
      .superRefine(ownKeys),
    run: async (p, input) => {
      const { idempotencyKey: key, itemType: type, ...data } = input;
      return success(
        written(
          await createRecord(p, WORKFLOW_ITEMS[type].resource, { data }, key),
        ),
      );
    },
  }),
  tool({
    name: "update_task_workflow_item",
    title: "Update task workflow item",
    description:
      "Rename or change the fields you send on one task bucket or custom task field; itemType must match the item. Requires the version from list_task_workflow_items; if the item changed since, the tool returns version_conflict.",
    scopes: ["recruitment:write"],
    access: [
      { resource: "buckets", action: "edit" },
      { resource: "task-fields", action: "edit" },
    ],
    effect: "change",
    input: z
      .object({ itemType, id: z.uuid(), version, ...workflowFields })
      .strict()
      .refine(
        (value) => Object.keys(value).length > 3,
        "Send at least one field to change.",
      )
      .superRefine(ownKeys),
    run: async (p, input) => {
      const { itemType: type, id, version: current, ...data } = input;
      return success(
        written(
          await updateRecord(p, WORKFLOW_ITEMS[type].resource, id, {
            version: current,
            data,
          }),
        ),
      );
    },
  }),
  tool({
    name: "list_saved_views",
    title: "List saved views",
    description:
      'List your own saved views, optionally by area ("directory" for candidates or "applications"), with their saved filters. Only you can see your saved views.',
    scopes: ["recruitment:read"],
    access: [{ resource: "views", action: "view" }],
    effect: "read",
    input: z
      .object({
        area: recordDataSchemas["saved-view"].shape.area.optional(),
        page,
        pageSize,
      })
      .strict(),
    run: async (p, input, ctx) => {
      const result = await listRecords(p, "views", listQuery(input), {
        channel: "mcp",
      });
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            version: row.version,
            ...fields(ctx, row, ["name", "area", "query"]),
            updatedAt: row.updatedAt,
          })),
        ),
        result.pagination,
      );
    },
  }),
  tool({
    name: "create_saved_view",
    title: "Create saved view",
    description:
      'Save a named view of filters for the candidate directory (area "directory") or applications; only you can see it. Requires an idempotencyKey: retrying with the same key and input returns the same view; the same key with different input is refused.',
    scopes: ["recruitment:write"],
    access: [{ resource: "views", action: "create" }],
    effect: "create",
    input: z
      .object({ idempotencyKey, ...recordDataSchemas["saved-view"].shape })
      .strict(),
    run: creates("views"),
  }),
  tool({
    name: "list_comments",
    title: "List comments",
    description:
      "List the comments on one record, oldest first, with each author's name. Comments on a candidate also need candidates:read.",
    scopes: ["recruitment:read"],
    access: [{ resource: "comments", action: "view" }],
    effect: "read",
    input: z.object({ parentRecordId: z.uuid(), page, pageSize }).strict(),
    run: async (p, input, ctx) => {
      // A parent the caller cannot see is answered as a missing record.
      await recordKindOf(p, input.parentRecordId);
      const result = await listRecords(
        p,
        "comments",
        listQuery({ ...input, sort: "createdAt", direction: "asc" }),
        { channel: "mcp" },
      );
      return success(
        listed(
          result.data.map((row) => {
            const data = row.data as Data;
            return {
              id: row.id,
              parentRecordId: row.parentRecordId,
              ...(visible(ctx, row)("body") ? { body: data.body } : {}),
              authorName: row.authorName ?? null,
              ...fields(ctx, row, ["legacyAuthorLabel"]),
              createdAt: row.createdAt,
            };
          }),
        ),
        result.pagination,
      );
    },
  }),
  tool({
    name: "add_comment",
    title: "Add comment",
    description:
      "Append a comment to any active record except a comment or saved view. Comments on a candidate also require candidates:read and candidates:write. Requires an idempotencyKey; comments cannot be edited or deleted.",
    scopes: ["recruitment:write"],
    access: [{ resource: "comments", action: "create" }],
    effect: "create",
    input: z
      .object({
        idempotencyKey,
        parentRecordId: z.uuid(),
        body: recordDataSchemas.comment.shape.body,
      })
      .strict(),
    run: async (p, input, ctx) => {
      // Without candidates:read, a candidate parent is answered as a missing record.
      const parent = await recordKindOf(p, input.parentRecordId);
      if (parent.kind === "candidate")
        requireAccess(ctx, INPUT_CHECKS.candidateComment);
      // Saved views are private and comments are team-visible, so a view takes no comments.
      if (parent.archived || ["comment", "saved-view"].includes(parent.kind))
        throw new ApiError(
          400,
          "invalid_reference",
          "Comment on an active record other than a comment or saved view.",
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
    name: "list_activity",
    title: "List activity",
    description:
      "List the history of one record, newest first: who created, changed, archived or restored it and when. Activity on a candidate also needs candidates:read.",
    scopes: ["recruitment:read"],
    access: [ACTIVITY_KINDS],
    effect: "read",
    input: z.object({ recordId: z.uuid(), page, pageSize }).strict(),
    run: async (p, input) => {
      // A record the caller cannot see is answered as a missing record.
      await recordKindOf(p, input.recordId);
      const result = await listActivity(p, listQuery(input), {
        channel: "mcp",
      });
      return success(
        listed(
          result.data.map((row) => ({
            id: row.id,
            action: row.action,
            kind: row.kind,
            summary: row.summary,
            actorName: row.actorName,
            actorType: row.actorType,
            metadata: row.metadata,
            createdAt: row.createdAt,
          })),
        ),
        result.pagination,
      );
    },
  }),
  tool({
    name: "list_notifications",
    title: "List notifications",
    description:
      "List your reminders for tasks, interviews, offers, onboarding and vacancy dates that are overdue or due within 7 days, unread first, with unread and total counts. Read markers are your own.",
    scopes: ["recruitment:read"],
    access: [REMINDER_KINDS],
    effect: "read",
    input: z.object({ page, pageSize }).strict(),
    run: async (p, input) => {
      const result = await notifications(p, "mcp");
      const start = (input.page - 1) * input.pageSize;
      return success(
        {
          reminders: listed(
            result.data
              .slice(start, start + input.pageSize)
              .map((reminder) => ({
                key: reminder.key,
                title: reminder.title,
                description: reminder.description,
                date: reminder.date,
                severity: reminder.severity,
                read: reminder.read,
                href: reminder.href,
              })),
          ),
          unread: result.unread,
          total: result.total,
          limited: result.limited,
        },
        {
          page: input.page,
          pageSize: input.pageSize,
          total: result.data.length,
          totalPages: Math.ceil(result.data.length / input.pageSize),
        },
      );
    },
  }),
  tool({
    name: "mark_notifications_read",
    title: "Mark notifications read",
    description:
      "Mark reminders read for you only, by their keys from list_notifications; teammates' reminders do not change. A key already read or no longer due changes nothing, so a retry is safe.",
    scopes: ["recruitment:read", "recruitment:write"],
    access: [REMINDER_KINDS],
    effect: "create",
    input: z
      .object({
        keys: z.array(z.string().min(1).max(300)).min(1).max(500),
      })
      .strict(),
    run: async (p, input) =>
      success({ updated: (await markNotifications(p, input.keys)).updated }),
  }),
  tool({
    name: "get_overview",
    title: "Get overview",
    description:
      "Team inventory counts, data coverage, stage and category totals, upcoming interviews and overdue tasks.",
    scopes: ["candidates:read", "recruitment:read"],
    access: inventory("home"),
    effect: "read",
    input: z.object({}).strict(),
    run: async (p, _input, ctx) => {
      const result = await overview(p, "mcp");
      const { shortlisted: _personal, ...counts } = result.counts;
      return success({
        counts,
        coverage: result.coverage,
        stages: result.stages,
        departments: result.departments,
        categories: result.categories,
        upcomingInterviews: listed(
          result.upcomingInterviews.map((row) => interviewItem(ctx, row)),
        ),
        overdueTasks: listed(
          result.overdueTasks.map((row) => taskItem(ctx, row)),
        ),
        asOf: result.asOf,
        timezone: result.timezone,
      });
    },
  }),
  tool({
    name: "get_analytics",
    title: "Get analytics",
    description:
      "The dashboard's analytics for a date range (from and to as YYYY-MM-DD, Asia/Dubai, at most 367 days; the last 30 days by default): inventory, stages, daily series, hires, time to hire, stage durations, conversions and grouped totals. Groups after the first 25 are summed.",
    scopes: ["candidates:read", "recruitment:read"],
    access: inventory("analytics"),
    effect: "read",
    input: z
      .object({
        from: z.string().max(10).optional(),
        to: z.string().max(10).optional(),
      })
      .strict(),
    run: async (p, input) => {
      const result = await analytics(p, listQuery(input), "mcp");
      // Folded so a team with many long group names stays under the result limit.
      const folded = GROUP_LISTS.map((name) => ({
        name,
        ...foldGroups(result[name]),
      }));
      return success({
        ...result,
        ...Object.fromEntries(folded.map((item) => [item.name, item.groups])),
        foldedGroups: folded
          .filter((item) => item.folded)
          .map((item) => item.name),
      });
    },
  }),
  tool({
    name: "search_workspace",
    title: "Search workspace",
    description:
      "Search candidates, vacancies, job roles, tasks and applications at once, up to 8 results each, as the app's global search does. Candidates appear only with candidates:read. Sensitive and source fields are never matched.",
    scopes: ["recruitment:read"],
    access: [SEARCHED_KINDS],
    effect: "read",
    input: z.object({ query: query.min(1) }).strict(),
    run: async (p, input) => {
      const result = await searchWorkspace(p, input.query, {
        omitCandidateFields: [...SENSITIVE_CANDIDATE_FIELDS, ...SOURCE_FIELDS],
        channel: "mcp",
      });
      return success({
        groups: result.groups.map((group) => ({
          type: group.type,
          label: group.label,
          results: listed(group.results),
        })),
        total: result.total,
        limited: result.limited,
      });
    },
  }),
  tool({
    name: "archive_record",
    title: "Archive record",
    description:
      "Archive one candidate, task, job role, vacancy, application, interview, offer, onboarding record or checklist item; a candidate also needs candidates:write. It can be restored with restore_record; nothing is deleted. Requires the current version; a changed record returns version_conflict.",
    scopes: ["recruitment:write"],
    access: ARCHIVE_ACCESS,
    effect: "change",
    input: archiveInput,
    run: archives(true),
  }),
  tool({
    name: "restore_record",
    title: "Restore record",
    description:
      "Restore one archived record that archive_record takes; a candidate also needs candidates:write. Find it with a list or search tool and archived: true. Refused if it would duplicate an active record. Requires the current version; a changed record returns version_conflict.",
    scopes: ["recruitment:write"],
    access: ARCHIVE_ACCESS,
    effect: "change",
    input: archiveInput,
    run: archives(false),
  }),
];

/**
 * The one decision for a tool: every scope it names is among the engine's effective scopes, so the
 * stored ones, and the engine allows every entry of its access, an array entry when any one of its
 * requests is allowed.
 */
export function toolAllowed(ctx: AccessContext, definition: McpTool) {
  return (
    // An archived team is read-only: no write tool, whatever the scopes say.
    (definition.effect === "read" || !ctx.access.teamArchived) &&
    definition.scopes.every((scope) => ctx.scopes.includes(scope)) &&
    definition.access.every((entry) =>
      (Array.isArray(entry) ? entry : [entry]).some((request) =>
        decide(ctx, request),
      ),
    )
  );
}
function inputSchema(definition: McpTool): ListedTool["inputSchema"] {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(definition.input, {
    io: "input",
  }) as Record<string, unknown>;
  return schema as ListedTool["inputSchema"];
}
/**
 * Only the tools the engine allows under the access state install returned. Without one, for
 * in-process callers only, under the principal's built-in template and its own scopes.
 */
export function listTools(
  p: Principal,
  access: AccessContext["access"] = {
    scopes: p.scopes,
    workspaceId: "",
    memberRole: p.role,
    companyLevel: null,
    companyAreas: [],
    versions: {},
  },
): ListedTool[] {
  const ctx = accessContext(p, access, { channel: "mcp" });
  return TOOLS.filter((definition) => toolAllowed(ctx, definition)).map(
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
 * tools/list: one transaction with no statement beyond the install, so the list follows the scopes
 * and role install stored for the member. Not audited.
 */
export async function listStoredTools(p: Principal): Promise<ListedTool[]> {
  return withTeam(p, async (_tx, access) => listTools(p, access));
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
  let ctx: AccessContext;
  let decision: "allowed" | "denied";
  try {
    ({ ctx, decision } = await withTeam(p, async (tx, access) => {
      // After install, so the engine decides under the scopes and role it stored for this principal.
      const context = accessContext(p, access, { channel: "mcp" });
      const decision = toolAllowed(context, definition) ? "allowed" : "denied";
      await tx.execute(
        sql`select tenant_context.audit_mcp_call(${definition.name}, ${decision})`,
      );
      return { ctx: context, decision };
    }));
  } catch (error) {
    return failureFrom(error);
  }
  if (
    decision === "denied" &&
    definition.effect !== "read" &&
    ctx.access.teamArchived
  )
    return failure("team_archived", TEAM_ARCHIVED);
  if (decision === "denied")
    return failure(
      "scope_required",
      `This tool requires ${definition.scopes.join(" and ")}.`,
    );
  try {
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
    return await definition.run(p, parsed.data, ctx, args);
  } catch (error) {
    // An assistant cannot review a draft, so it is told to reread rather than to refresh.
    if (error instanceof ApiError && error.code === "version_conflict")
      return failure("version_conflict", REREAD);
    return failureFrom(error);
  }
}
