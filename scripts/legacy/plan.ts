import { fromZonedTime } from "date-fns-tz";
import {
  recordDataSchemas,
  resourceToKind,
  referencesByKind,
  CANDIDATE_STATUSES,
  daySchema,
  reviewStatusValue,
  type ResourceName,
  type ReferenceField,
} from "../../src/domain/records";

export type Row = Record<string, unknown>;
export interface Issue {
  severity: "error" | "warning";
  code: string;
  location: string;
  message: string;
}
export interface PersonalState {
  id: string;
  shortlisted: boolean;
  status: string;
  note: string;
  updated: string;
}
export interface LegacyInputs {
  workbooks: Record<string, Record<string, unknown[][]>>;
  states: PersonalState[];
  recovered: Record<string, string>;
  issues: Issue[];
}
export interface LegacyRef {
  resource: ResourceName;
  legacyId: string;
}
export interface PlannedRecord {
  resource: ResourceName;
  legacyId: string;
  data: Row;
  refs: Partial<Record<ReferenceField, LegacyRef>>;
  archived: boolean;
  importMeta: Row;
  sources?: string[];
  customValues?: Row;
}
export interface Source {
  id: string;
  row: Row;
  candidateIds: string[];
  relativePath?: string;
  exists?: boolean;
  sizeBytes?: number;
  mtimeMs?: number;
  uploadable?: boolean;
  mimeType?: string;
  sha256?: string;
}
export interface MigrationPlan {
  formatVersion: 1;
  records: PlannedRecord[];
  sources: Source[];
  states: PersonalState[];
  notificationReads: Row[];
  issues: Issue[];
  stats: Record<string, number>;
  asOf: string;
  root?: string;
}
interface LocatedRow {
  values: Row;
  location: string;
  workbook: string;
  sheet: string;
  rowNumber: number;
}
export const RESOURCE_ORDER: ResourceName[] = [
  "candidates",
  "job-roles",
  "buckets",
  "task-fields",
  "vacancies",
  "applications",
  "tasks",
  "interviews",
  "offers",
  "onboarding",
  "checklist",
  "views",
  "comments",
];
export const text = (value: unknown): string =>
  value === null || value === undefined
    ? ""
    : value instanceof Date
      ? value.toISOString()
      : String(value).trim();
export const known = (value: unknown): boolean =>
  !!text(value) &&
  !/^(not stated|unclear|not available|not found|unknown)(\b|$)/i.test(
    text(value),
  );
export const tags = (value: unknown): string[] => [
  ...new Set(
    text(value)
      .split(";")
      .map((v) => v.trim())
      .filter((v) => known(v)),
  ),
];
const numberOrNull = (value: unknown): number | null =>
  known(value) &&
  text(value) !== "" &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : null;
const numeric = (value: unknown, fallback: number): number =>
  text(value) === "" ? fallback : Number(value);
const day = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : text(value);
function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, jsonValue(v)]),
    );
  return value ?? null;
}

export function buildPlan(inputs: LegacyInputs): MigrationPlan {
  const plan: MigrationPlan = {
    formatVersion: 1,
    records: [],
    sources: [],
    states: inputs.states,
    notificationReads: [],
    issues: [...inputs.issues],
    stats: {},
    asOf: "",
  };
  const issue = (
    severity: Issue["severity"],
    code: string,
    location: string,
    message: string,
  ) => plan.issues.push({ severity, code, location, message });
  const bool = (value: unknown, fallback = false, location = ""): boolean => {
    if (value === null || value === undefined || value === "") return fallback;
    if (
      [true, 1, "1", "true", "TRUE", "True", "Yes", "yes"].includes(
        value as string,
      )
    )
      return true;
    if (
      [false, 0, "0", "false", "FALSE", "False", "No", "no"].includes(
        value as string,
      )
    )
      return false;
    issue(
      "error",
      "INVALID_BOOLEAN",
      location,
      "Expected an explicit boolean/0/1/Yes/No value.",
    );
    return fallback;
  };
  const table = (
    workbook: string,
    sheet: string,
    header: string,
    required = false,
  ): LocatedRow[] => {
    const rows = inputs.workbooks[workbook]?.[sheet];
    if (!rows) {
      if (required)
        issue(
          "error",
          "MISSING_SHEET",
          `${workbook}/${sheet}`,
          "Required sheet is missing.",
        );
      return [];
    }
    const index = rows.findIndex((row) => row.some((v) => text(v) === header));
    if (index < 0) {
      issue(
        "error",
        "MISSING_HEADER",
        `${workbook}/${sheet}`,
        `Cannot find the ${header} header.`,
      );
      return [];
    }
    const columns = rows[index].map(text),
      populated = columns.filter(Boolean);
    if (new Set(populated).size !== populated.length)
      issue(
        "error",
        "DUPLICATE_COLUMN",
        `${workbook}/${sheet}`,
        "Duplicate column labels would lose source fields.",
      );
    return rows
      .slice(index + 1)
      .map((row, i) => {
        if (row.some((value, j) => text(value) !== "" && !columns[j]))
          issue(
            "error",
            "UNLABELED_COLUMN",
            `${workbook}/${sheet}:${index + i + 2}`,
            "A populated cell has no column label; label it before import so no fact is lost.",
          );
        return {
          values: Object.fromEntries(
            columns
              .map((key, j) => [key, jsonValue(row[j])])
              .filter(([key]) => key),
          ),
          workbook,
          sheet,
          rowNumber: index + i + 2,
          location: `${workbook}/${sheet}:${index + i + 2}`,
        };
      })
      .filter((row) =>
        Object.values(row.values).some((value) => text(value) !== ""),
      );
  };
  const seen = new Set<string>();
  const add = (
    resource: ResourceName,
    r: LocatedRow,
    idHeader: string,
    data: Row,
    refs: PlannedRecord["refs"] = {},
    extras: Partial<PlannedRecord> = {},
  ): PlannedRecord => {
    const legacyId = text(r.values[idHeader]),
      key = `${resource}:${legacyId}`;
    if (!legacyId || legacyId.length > 200)
      issue(
        "error",
        "INVALID_ID",
        r.location,
        `${idHeader} must be present and at most 200 characters.`,
      );
    if (seen.has(key))
      issue(
        "error",
        "DUPLICATE_ID",
        r.location,
        `Repeated ${resource} legacy ID ${legacyId}.`,
      );
    seen.add(key);
    const parsed = recordDataSchemas[resourceToKind[resource]].safeParse(data);
    if (!parsed.success)
      for (const error of parsed.error.issues)
        issue(
          "error",
          "INVALID_DATA",
          `${r.location}/${error.path.join(".")}`,
          error.message,
        );
    const record: PlannedRecord = {
      resource,
      legacyId,
      data: parsed.success ? (parsed.data as Row) : data,
      refs,
      archived: bool(r.values.Archived, false, r.location),
      importMeta: {
        workbook: r.workbook,
        sheet: r.sheet,
        rowNumber: r.rowNumber,
        row: r.values,
      },
      ...extras,
    };
    plan.records.push(record);
    return record;
  };
  const ref = (resource: ResourceName, id: unknown): LegacyRef => ({
    resource,
    legacyId: text(id),
  });
  const master = "Resume_Master.xlsx",
    tasks = "Recruitment_Tasks.xlsx",
    vacancies = "Recruitment_Vacancies.xlsx",
    ops = "Recruitment_Operations.xlsx";
  const evidence = table(master, "Field Evidence", "Candidate ID"),
    reviews = table(master, "Review Log", "Candidate ID");
  const inventory = table(master, "File Inventory", "Source ID", true);
  const sourceIds = new Set<string>();
  for (const r of inventory) {
    const id = text(r.values["Source ID"]);
    if (!id || sourceIds.has(id))
      issue(
        "error",
        id ? "DUPLICATE_SOURCE_ID" : "INVALID_SOURCE_ID",
        r.location,
        "Source IDs must be nonempty and unique.",
      );
    sourceIds.add(id);
    plan.sources.push({
      id,
      row: r.values,
      candidateIds: text(r.values["Candidate IDs"])
        .split(/[;,\s]+/)
        .filter(Boolean),
    });
  }
  const masterRows = table(master, "Master", "Candidate Full Name", true);
  const headerRows = inputs.workbooks[master]?.Master;
  plan.asOf = text(headerRows?.[2]?.[1]);
  for (const r of masterRows) {
    const v = r.values,
      cid = text(v["Candidate ID"]);
    if (!cid && !known(v["Candidate Full Name"])) continue;
    const sourceList = [
      ...new Set(
        [
          text(v["Primary source ID"]),
          ...tags(v["All resume source IDs"]),
          ...plan.sources
            .filter((s) => s.candidateIds.includes(cid))
            .map((s) => s.id),
        ].filter(Boolean),
      ),
    ];
    for (const sid of sourceList) {
      const source = plan.sources.find((s) => s.id === sid);
      if (!source)
        issue(
          "warning",
          "SOURCE_NOT_IN_INVENTORY",
          r.location,
          `Referenced source ${sid} is absent from File Inventory.`,
        );
      else if (!source.candidateIds.includes(cid))
        source.candidateIds.push(cid);
    }
    const factual = (field: string) => (known(v[field]) ? text(v[field]) : "");
    const candidate = add(
      "candidates",
      r,
      "Candidate ID",
      {
        name: factual("Candidate Full Name") || "Name not stated",
        email: factual("Email"),
        phone: factual("Contact number"),
        university: factual("University (latest listed)"),
        degreeLevel: factual("Degree level"),
        degreeName: factual("Degree name"),
        gpa: factual("GPA"),
        major: factual("Major"),
        yearsExperience: numberOrNull(v["Years of experience"]),
        documentedYearsEstimate: numberOrNull(
          v["Documented work years (estimate)"],
        ),
        employer: factual("Latest work entity name"),
        jobTitle:
          factual("Current job title (CV-reported)") ||
          factual("Latest reported job title"),
        nationalServiceStatus: factual("UAE national service status"),
        explicitGender: factual("Male/Female (explicit only)"),
        residenceEmirate: factual("Residence Emirate"),
        folderCategories: tags(v["Category fit (folder-derived)"]),
        skills: tags(v["Skills tags"]),
        certifications: tags(v["Certifications / qualifications"]),
        languages: tags(v["Languages stated"]),
        educationStatus: factual("Education status"),
        educationDates: factual("Education dates"),
        latestRoleDates: factual("Latest role dates"),
        roleStatus: factual("Role status in source"),
        experienceBasis: factual("Experience basis"),
        experienceWording: factual("Experience wording in source"),
        // The original text stays in rawSource.
        reviewStatus: reviewStatusValue(factual("Source review status")),
        sourceNotes: text(v.Notes),
        rawSource: v,
        evidence: evidence
          .filter((q) => text(q.values["Candidate ID"]) === cid)
          .map((q) => q.values),
        sourceReviews: reviews
          .filter((q) => text(q.values["Candidate ID"]) === cid)
          .map((q) => q.values),
      },
      {},
      { sources: sourceList },
    );
    candidate.importMeta.sourceInventory = plan.sources
      .filter((s) => sourceList.includes(s.id))
      .map((s) => s.row);
    candidate.importMeta.legacyAsOf = plan.asOf;
  }
  for (const r of table(vacancies, "Job Roles", "Role ID")) {
    const v = r.values;
    add("job-roles", r, "Role ID", {
      title: text(v.Title),
      department: text(v.Department),
      location: text(v.Location),
      employmentType: text(v["Employment type"]),
      workMode: text(v["Work mode"]),
      description: text(v["Job description"]),
      requirements: text(v.Requirements),
      skills: tags(v.Skills),
    });
  }
  const bucketNames = new Map<string, string>();
  for (const r of table(tasks, "Buckets", "Bucket ID")) {
    const v = r.values,
      name = text(v.Name),
      key = name.toLowerCase();
    if (bucketNames.has(key))
      issue(
        "error",
        "DUPLICATE_BUCKET_NAME",
        r.location,
        "Bucket names must map unambiguously to task Status.",
      );
    bucketNames.set(key, text(v["Bucket ID"]));
    add(
      "buckets",
      r,
      "Bucket ID",
      {
        name,
        color: text(v.Color) || "#4338CA",
        position: numeric(v.Order, 0),
      },
      {},
      { archived: !bool(v.Active, true, r.location) },
    );
  }
  const fields = table(tasks, "Fields", "Field ID"),
    fieldNames = new Set<string>();
  for (const r of fields) {
    const v = r.values;
    if (text(v["Field ID"]) === "f_sys_vacancy") continue;
    const key = text(v.Name).toLowerCase();
    if (fieldNames.has(key))
      issue(
        "error",
        "DUPLICATE_FIELD_NAME",
        r.location,
        "Custom field names must be unique.",
      );
    fieldNames.add(key);
    let options: unknown = [];
    try {
      options = text(v.Options) ? JSON.parse(text(v.Options)) : [];
    } catch {
      issue(
        "error",
        "INVALID_FIELD_OPTIONS",
        r.location,
        "Options must be a JSON array.",
      );
    }
    const type =
      (
        {
          text: "Text",
          number: "Number",
          date: "Date",
          select: "Dropdown",
          checkbox: "Checkbox",
        } as Record<string, string>
      )[text(v.Type)] || text(v.Type);
    add(
      "task-fields",
      r,
      "Field ID",
      {
        name: text(v.Name),
        type,
        options,
        required: bool(v.Required, false, r.location),
        position: numeric(v.Order, 0),
      },
      {},
      { archived: !bool(v.Active, true, r.location) },
    );
  }
  for (const r of table(vacancies, "Vacancies", "Vacancy ID")) {
    const v = r.values;
    add(
      "vacancies",
      r,
      "Vacancy ID",
      {
        title: text(v.Title),
        requisitionId: text(v["Requisition ID"]),
        department: text(v.Department),
        location: text(v.Location),
        employmentType: text(v["Employment type"]),
        workMode: text(v["Work mode"]),
        description: text(v["Job description"]),
        requirements: text(v.Requirements),
        skills: tags(v.Skills),
        openings: numeric(v.Openings, 1),
        status: text(v.Status) || "Draft",
        hiringManager: text(v["Hiring manager"]),
        recruiter: text(v.Recruiter),
        targetDate: day(v["Target hire date"]),
      },
      text(v["Role ID"]) ? { jobRoleId: ref("job-roles", v["Role ID"]) } : {},
    );
  }
  for (const r of table(ops, "Applications", "Application ID")) {
    const v = r.values;
    add(
      "applications",
      r,
      "Application ID",
      {
        stage: text(v.Stage) || "Sourced",
        source: text(v.Source),
        owner: text(v.Owner),
        notes: text(v.Notes),
        appliedDate: day(v["Applied date"]),
      },
      {
        candidateId: ref("candidates", v["Candidate ID"]),
        vacancyId: ref("vacancies", v["Vacancy ID"]),
      },
    );
  }
  for (const r of table(tasks, "Tasks", "Task ID")) {
    const v = r.values,
      refs: PlannedRecord["refs"] = {
        bucketId: ref(
          "buckets",
          bucketNames.get(text(v.Status).toLowerCase()) || "",
        ),
      };
    const customValues: Row = {};
    for (const f of fields) {
      const fv = f.values,
        id = text(fv["Field ID"]),
        value = v[text(fv.Name)];
      if (id === "f_sys_vacancy") {
        if (text(value)) refs.vacancyId = ref("vacancies", value);
        continue;
      }
      const type = text(fv.Type);
      customValues[id] =
        type === "checkbox"
          ? bool(value, false, r.location)
          : type === "number"
            ? text(value) === ""
              ? null
              : Number(value)
            : type === "date"
              ? day(value)
              : text(value);
      if (
        type === "number" &&
        customValues[id] !== null &&
        !Number.isFinite(customValues[id])
      )
        issue(
          "error",
          "INVALID_CUSTOM_VALUE",
          r.location,
          `Field ${text(fv.Name)} must be numeric.`,
        );
    }
    const explicitCandidate = text(v.Description).match(
      /(?:^|\n)Candidate ID:\s*([^\s\r\n]+)/,
    )?.[1];
    const context = text(v["Candidate / vacancy"]);
    if (explicitCandidate)
      refs.candidateId = ref("candidates", explicitCandidate);
    else if (
      plan.records.some(
        (q) => q.resource === "candidates" && q.legacyId === context,
      )
    )
      refs.candidateId = ref("candidates", context);
    add(
      "tasks",
      r,
      "Task ID",
      {
        title: text(v.Title),
        context,
        owner: text(v.Owner),
        dueDate: day(v["Due date"]),
        priority: text(v.Priority) || "Normal",
        description: text(v.Description),
        customValues: {},
      },
      refs,
      { customValues },
    );
  }
  for (const r of table(ops, "Interviews", "Interview ID")) {
    const v = r.values;
    let startAt = text(v["Start at"]);
    if (startAt && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(startAt)) {
      try {
        startAt = fromZonedTime(startAt, "Asia/Dubai").toISOString();
        issue(
          "warning",
          "ASSUMED_TIMEZONE",
          r.location,
          "Interview time had no offset; interpreted as Asia/Dubai and retained original value in provenance.",
        );
      } catch {
        /* schema reports invalid datetime */
      }
    }
    add(
      "interviews",
      r,
      "Interview ID",
      {
        title: text(v.Title),
        startAt,
        minutes: numeric(v["Duration minutes"], 60),
        interviewer: text(v.Interviewer),
        location: text(v.Location),
        meetingUrl: text(v["Meeting url"]),
        status: text(v.Status) || "Scheduled",
        notes: text(v.Notes),
      },
      { applicationId: ref("applications", v["Application ID"]) },
    );
  }
  for (const r of table(ops, "Offers", "Offer ID")) {
    const v = r.values;
    add(
      "offers",
      r,
      "Offer ID",
      {
        title: text(v.Title),
        amount: text(v.Amount) || null,
        currency: text(v.Currency) || "AED",
        payPeriod: text(v["Pay period"]) || "Monthly",
        sentDate: day(v["Sent date"]),
        expiryDate: day(v["Expiry date"]),
        status: text(v.Status) || "Draft",
        declineReason: text(v["Decline reason"]),
        notes: text(v.Notes),
      },
      { applicationId: ref("applications", v["Application ID"]) },
    );
  }
  for (const r of table(ops, "Onboarding", "Onboarding ID")) {
    const v = r.values;
    add(
      "onboarding",
      r,
      "Onboarding ID",
      {
        startDate: day(v["Start date"]),
        owner: text(v.Owner),
        status: text(v.Status) || "Planned",
        notes: text(v.Notes),
      },
      { applicationId: ref("applications", v["Application ID"]) },
    );
  }
  for (const r of table(ops, "Checklist", "Checklist ID")) {
    const v = r.values;
    add(
      "checklist",
      r,
      "Checklist ID",
      {
        title: text(v.Title),
        category: text(v.Category) || "Other",
        dueDate: day(v["Due date"]),
        owner: text(v.Owner),
        status: text(v.Status) || "Pending",
        notes: text(v.Notes),
      },
      { onboardingId: ref("onboarding", v["Onboarding ID"]) },
    );
  }
  const entities: Record<string, ResourceName> = {
    candidate: "candidates",
    vacancy: "vacancies",
    task: "tasks",
    application: "applications",
    interview: "interviews",
    offer: "offers",
    onboarding: "onboarding",
    checklist: "checklist",
    view: "views",
    comment: "comments",
    role: "job-roles",
  };
  for (const r of table(ops, "Saved Views", "View ID")) {
    const v = r.values;
    let query: Row = {};
    try {
      const parsed: unknown = JSON.parse(text(v.Query) || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      query = parsed as Row;
    } catch {
      issue(
        "error",
        "INVALID_VIEW_QUERY",
        r.location,
        "Query must be a JSON object.",
      );
    }
    const knownKeys = new Set([
      "search",
      "category",
      "categories",
      "skills",
      "emirate",
      "degreeLevel",
      "status",
      "stage",
      "reviewStatus",
      "shortlisted",
      "includeArchived",
      "sort",
      "direction",
      "pageSize",
    ]);
    const mapped: Row = {};
    for (const [key, value] of Object.entries(query)) {
      if (key === "dir") mapped.direction = value;
      else if (key === "reviewStatus")
        mapped.reviewStatus = text(value) ? reviewStatusValue(text(value)) : "";
      else if (knownKeys.has(key)) mapped[key] = value;
      else if (key === "vacancyId" && text(value)) {
        /* UUID requires apply-time mapping below */
      } else
        issue(
          "warning",
          "VIEW_FILTERS_NOT_MAPPED",
          r.location,
          `Saved view field ${key} was retained in original Query provenance but is not active.`,
        );
    }
    const record = add("views", r, "View ID", {
      name: text(v.Name),
      area: text(v.Area) || "directory",
      query: mapped,
    });
    if (text(query.vacancyId))
      record.importMeta.viewVacancyLegacyId = text(query.vacancyId);
  }
  for (const r of table(ops, "Comments", "Comment ID")) {
    const v = r.values,
      resource = entities[text(v["Entity type"])];
    if (!resource)
      issue(
        "error",
        "UNKNOWN_ENTITY_TYPE",
        r.location,
        "Comment parent type is not supported.",
      );
    add(
      "comments",
      r,
      "Comment ID",
      { body: text(v.Body), legacyAuthorLabel: text(v.Author) },
      { parentRecordId: ref(resource || "candidates", v["Entity ID"]) },
    );
  }
  for (const r of table(ops, "Activity", "Activity ID")) {
    const v = r.values,
      resource = entities[text(v["Entity type"])],
      id = text(v["Entity ID"]);
    const target = plan.records.find(
      (q) => q.resource === resource && q.legacyId === id,
    );
    if (target) {
      const activity = (target.importMeta.activity || []) as Row[];
      activity.push(v);
      target.importMeta.activity = activity;
    } else
      issue(
        "error",
        "ORPHAN_ACTIVITY",
        r.location,
        `Historical activity cannot be attached to ${text(v["Entity type"])}:${id}; resolve it before applying.`,
      );
  }
  plan.notificationReads = table(ops, "Notification Reads", "Read ID").map(
    (r) => r.values,
  );
  for (const record of plan.records) {
    for (const [field, rule] of Object.entries(
      referencesByKind[resourceToKind[record.resource]],
    )) {
      const link = record.refs[field as ReferenceField];
      if (rule.required && !link?.legacyId)
        issue(
          "error",
          "MISSING_REFERENCE",
          `${record.resource}:${record.legacyId}`,
          `${field} is required.`,
        );
    }
    for (const [field, link] of Object.entries(record.refs)) {
      const parent = plan.records.find(
        (r) => r.resource === link.resource && r.legacyId === link.legacyId,
      );
      if (!parent)
        issue(
          "error",
          "MISSING_REFERENCE",
          `${record.resource}:${record.legacyId}`,
          `${field} references missing ${link.resource}:${link.legacyId}.`,
        );
      else if (
        parent.archived &&
        !record.archived &&
        record.resource !== "comments"
      )
        issue(
          "error",
          "ARCHIVED_PARENT",
          `${record.resource}:${record.legacyId}`,
          `${field} references an archived parent while this child is active.`,
        );
    }
    if (
      record.resource === "offers" &&
      record.data.sentDate &&
      record.data.expiryDate &&
      text(record.data.expiryDate) < text(record.data.sentDate)
    )
      issue(
        "error",
        "INVALID_OFFER_DATES",
        `offers:${record.legacyId}`,
        "Offer expiry date precedes its sent date.",
      );
    if (record.resource === "task-fields") {
      const options = Array.isArray(record.data.options)
        ? record.data.options
        : [];
      if (
        new Set(options.map((v) => text(v).toLowerCase())).size !==
          options.length ||
        (record.data.type === "Dropdown" && !options.length) ||
        (record.data.type !== "Dropdown" && options.length)
      )
        issue(
          "error",
          "INVALID_FIELD_OPTIONS",
          `task-fields:${record.legacyId}`,
          "Dropdown options must be nonempty and unique; other field types must not have options.",
        );
    }
    if (record.resource === "tasks")
      for (const field of plan.records.filter(
        (r) => r.resource === "task-fields" && !r.archived,
      )) {
        const value = record.customValues?.[field.legacyId],
          empty = value === undefined || value === null || value === "";
        let valid = !field.data.required;
        if (!empty) {
          switch (field.data.type) {
            case "Text":
              valid = typeof value === "string" && value.length <= 4000;
              break;
            case "Number":
              valid = typeof value === "number" && Number.isFinite(value);
              break;
            case "Date":
              valid = daySchema.safeParse(value).success;
              break;
            case "Dropdown":
              valid =
                Array.isArray(field.data.options) &&
                field.data.options.includes(value);
              break;
            case "Checkbox":
              valid = typeof value === "boolean";
              break;
            default:
              valid = false;
          }
        }
        if (!valid)
          issue(
            "error",
            "INVALID_CUSTOM_VALUE",
            `tasks:${record.legacyId}/${field.legacyId}`,
            `Missing or invalid value for custom field ${text(field.data.name)}.`,
          );
      }
    if (JSON.stringify(record.importMeta).length > 200000)
      issue(
        "error",
        "METADATA_TOO_LARGE",
        `${record.resource}:${record.legacyId}`,
        "Lossless provenance exceeds the API 200KB importMeta limit; split/review before migration.",
      );
    if (
      Buffer.byteLength(
        JSON.stringify({
          data: record.data,
          importMeta: record.importMeta,
          customValues: record.customValues,
        }),
        "utf8",
      ) > 240000
    )
      issue(
        "error",
        "IMPORT_PAYLOAD_TOO_LARGE",
        `${record.resource}:${record.legacyId}`,
        "Lossless source data exceeds the bounded API byte limit, including multi-byte text; split/review before applying.",
      );
  }
  for (const state of plan.states) {
    if (!seen.has(`candidates:${state.id}`))
      issue(
        "error",
        "ORPHAN_PRIVATE_STATE",
        `SQLite:${state.id}`,
        "Personal state candidate ID is absent from Master.",
      );
    if (
      !(CANDIDATE_STATUSES as readonly string[]).includes(state.status) ||
      state.note.length > 10000
    )
      issue(
        "error",
        "INVALID_PRIVATE_STATE",
        `SQLite:${state.id}`,
        "State has an unsupported status or overlong note.",
      );
  }
  for (const source of plan.sources) {
    for (const cid of source.candidateIds)
      if (!seen.has(`candidates:${cid}`))
        issue(
          "warning",
          "ORPHAN_SOURCE_LINK",
          `Source:${source.id}`,
          `Inventory links to absent candidate ${cid}.`,
        );
    if (source.candidateIds.length > 1)
      issue(
        "warning",
        "SHARED_SOURCE_REQUIRES_REVIEW",
        `Source:${source.id}`,
        "One file links to multiple candidates. Facts and links are preserved; CV upload is skipped until its ownership is resolved.",
      );
  }
  const activeBuckets = plan.records.filter(
    (r) => r.resource === "buckets" && !r.archived,
  );
  if (
    plan.records.some((r) => r.resource === "buckets") &&
    !activeBuckets.length
  )
    issue(
      "error",
      "NO_ACTIVE_BUCKET",
      "Buckets",
      "At least one workflow bucket must be active.",
    );
  for (const resource of ["vacancies", "applications", "onboarding"] as const) {
    const values = new Set<string>();
    for (const record of plan.records.filter((r) => r.resource === resource)) {
      const key =
        resource === "vacancies"
          ? text(record.data.requisitionId).toLowerCase()
          : record.archived
            ? ""
            : resource === "applications"
              ? `${record.refs.candidateId?.legacyId}:${record.refs.vacancyId?.legacyId}`
              : record.refs.applicationId?.legacyId;
      if (key && values.has(key))
        issue(
          "error",
          "DUPLICATE_RELATIONSHIP",
          `${resource}:${record.legacyId}`,
          "Unique requisition/application/onboarding relationship is duplicated.",
        );
      if (key) values.add(key);
    }
  }
  plan.records.sort(
    (a, b) =>
      RESOURCE_ORDER.indexOf(a.resource) - RESOURCE_ORDER.indexOf(b.resource),
  );
  plan.stats = {
    candidateRecords: plan.records.filter((r) => r.resource === "candidates")
      .length,
    sourceRows: plan.sources.length,
    linkedVersions: plan.records.reduce(
      (sum, r) => sum + (r.sources?.length || 0),
      0,
    ),
    privateStates: plan.states.length,
    notificationReads: plan.notificationReads.length,
    records: plan.records.length,
  };
  for (const resource of RESOURCE_ORDER)
    plan.stats[resource] = plan.records.filter(
      (r) => r.resource === resource,
    ).length;
  return plan;
}
