import { roleScopes, type Role } from "../lib/permissions";
import {
  ACTIONS,
  CONFIGURABLE_KINDS,
  PAGE_KEYS,
  READ_ACTIONS,
  RECORD_RESOURCES,
  SCREEN_ACTIONS,
  type Action,
  type ActionResource,
  type ConfigurableKind,
  type FieldRule,
  type KindSchemaBody,
  type RoleBody,
} from "./config";
import {
  APPLICATION_STAGES,
  REVIEW_STATUSES,
  SENSITIVE_CANDIDATE_FIELDS,
  TASK_FIELD_TYPES,
  recordDataSchemas,
  systemFieldKeys,
} from "./record-schemas";
import type { FieldType, RecordKind } from "./records";

/** A built-in configuration object: version 1 with a fixed, well-known version id (§2.1). */
export type RoleTemplate = {
  key: string;
  versionId: string;
  version: 1;
  body: RoleBody;
};
/** A default kind schema body: system fields only. */
type DefaultKindSchemaBody = Omit<KindSchemaBody, "fields"> & {
  fields: Extract<KindSchemaBody["fields"][number], { system: true }>[];
};
export type KindSchemaDefault = {
  key: ConfigurableKind;
  versionId: string;
  version: 1;
  body: DefaultKindSchemaBody;
};

const RECORD_WRITES = ACTIONS.filter(
  (action) =>
    !(READ_ACTIONS as readonly Action[]).includes(action) &&
    !["erase", "import", "admin"].includes(action),
);
const everyGroup = (scope: RoleBody["recordScope"]["pipeline"]) => ({
  pipeline: scope,
  candidates: scope,
  tasks: scope,
});

// Today's effect of each team role: its scopes, every page and field, record scope all. Owner and
// admin import on every record resource with imports:write; erasure, two-step reset and team
// creation stay owner-only and storage settings owner-or-admin, in code and mirrored here.
function todaysRole(membership: Role, name: string): RoleBody {
  const writes = membership !== "viewer";
  const manager = membership === "owner" || membership === "admin";
  const actions: Partial<Record<ActionResource, Action[]>> = {};
  for (const resource of RECORD_RESOURCES)
    actions[resource] = [
      ...READ_ACTIONS,
      ...(writes ? RECORD_WRITES : []),
      ...(manager ? (["import"] as const) : []),
      ...(membership === "owner" && resource === "candidates"
        ? (["erase"] as const)
        : []),
    ];
  if (manager) {
    actions.directory = ["view", "create", "edit", "archive"];
    actions["storage-settings"] = ["admin"];
  }
  if (membership === "owner") {
    actions["two-step-reset"] = ["admin"];
    actions.teams = ["admin"];
  }
  return {
    name,
    membership,
    scopes: roleScopes(membership),
    pages: [...PAGE_KEYS],
    actions,
    fields: {},
    recordScope: everyGroup("all"),
    ...(manager ? { directoryRule: "full" as const } : {}),
  };
}

// Templates are shared by every context of the process, so no caller can widen one in place.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
const template = <T extends RoleTemplate | KindSchemaDefault = RoleTemplate>(
  key: T["key"],
  id: number,
  body: T["body"],
): T =>
  deepFreeze({
    key,
    versionId: `00000000-0000-4000-8000-000000000${id}`,
    version: 1,
    body,
  } as T);

export const OWNER_ROLE = template("owner", 101, todaysRole("owner", "Owner"));
export const ADMIN_ROLE = template("admin", 102, todaysRole("admin", "Admin"));
export const RECRUITER_ROLE = template(
  "recruiter",
  103,
  todaysRole("recruiter", "Recruiter"),
);
export const VIEWER_ROLE = template(
  "viewer",
  104,
  todaysRole("viewer", "Viewer"),
);

/** Assigned to nobody until R2a-10; record scope is not enforced until R2a-18. */
export const HIRING_MANAGER_ROLE = template("hiring-manager", 105, {
  name: "Hiring manager",
  membership: "recruiter",
  scopes: roleScopes("recruiter"),
  pages: ["home", "vacancies", "applications", "interviews", "approvals"],
  actions: {
    candidates: ["view", "comment"],
    "job-roles": ["view"],
    vacancies: ["view", "edit", "transition", "comment"],
    applications: ["view", "create", "edit", "transition", "comment"],
    interviews: ["view", "create", "edit", "comment"],
    offers: ["view", "approve"],
    comments: ["view", "create"],
  },
  fields: {
    offer: { amount: "hidden-unless-approver" },
    candidate: {
      email: "read",
      phone: "read",
      explicitGender: "hidden",
      nationalServiceStatus: "hidden",
    },
  },
  recordScope: everyGroup("unit"),
});

/** Sees only the candidate's name and job title; the CV comes from cvs:read in the viewer ceiling. */
export const INTERVIEWER_ROLE = template("interviewer", 106, {
  name: "Interviewer",
  membership: "viewer",
  scopes: roleScopes("viewer"),
  pages: ["home", "interviews"],
  actions: { interviews: ["view"], candidates: ["view"] },
  fields: {
    candidate: Object.fromEntries(
      Object.keys(recordDataSchemas.candidate.shape)
        .filter((key) => key !== "name" && key !== "jobTitle")
        .map((key) => [key, "hidden" satisfies FieldRule]),
    ),
  },
  recordScope: everyGroup("assigned"),
});

export const ROLE_TEMPLATES = [
  OWNER_ROLE,
  ADMIN_ROLE,
  RECRUITER_ROLE,
  VIEWER_ROLE,
  HIRING_MANAGER_ROLE,
  INTERVIEWER_ROLE,
] as const;

const BUILT_IN_ROLES: Record<Role, RoleTemplate> = {
  owner: OWNER_ROLE,
  admin: ADMIN_ROLE,
  recruiter: RECRUITER_ROLE,
  viewer: VIEWER_ROLE,
};
/** The template a member holds today, by member.role. */
export function builtInRoleFor(role: Role): RoleTemplate {
  return BUILT_IN_ROLES[role];
}

/** Plural and singular labels per kind; tasks are team tasks since R2a-20. */
export const KIND_LABELS: Record<RecordKind, [string, string]> = {
  candidate: ["Candidates", "Candidate"],
  "job-role": ["Job roles", "Job role"],
  vacancy: ["Vacancies", "Vacancy"],
  application: ["Applications", "Application"],
  bucket: ["Workflow buckets", "Bucket"],
  "task-field": ["Custom task fields", "Custom field"],
  task: ["Team tasks", "Task"],
  interview: ["Interviews", "Interview"],
  offer: ["Offers", "Offer"],
  onboarding: ["Onboarding", "Onboarding"],
  checklist: ["Checklist items", "Checklist item"],
  "saved-view": ["Saved views", "Saved view"],
  comment: ["Comments", "Comment"],
};
const enumOptions: Record<string, readonly string[]> = {
  "application.stage": APPLICATION_STAGES,
  "candidate.reviewStatus": REVIEW_STATUSES,
  "vacancy.status": ["Draft", "Open", "On hold", "Filled", "Closed"],
  "task-field.type": TASK_FIELD_TYPES,
  "task.priority": ["Low", "Normal", "High", "Urgent"],
  "interview.status": ["Scheduled", "Completed", "Cancelled", "No show"],
  "offer.status": [
    "Draft",
    "Sent",
    "Accepted",
    "Declined",
    "Withdrawn",
    "Expired",
  ],
  "offer.payPeriod": ["Monthly", "Annual", "Hourly", "One-time"],
  "onboarding.status": ["Planned", "In progress", "Completed", "On hold"],
  "checklist.status": ["Pending", "In progress", "Complete", "Waived"],
  "checklist.category": ["Document", "Orientation", "Training", "Other"],
  "saved-view.area": ["directory", "applications"],
};
const fieldLabels: Record<string, string> = {
  explicitGender: "Gender (explicitly stated)",
  nationalServiceStatus: "UAE national service (as stated)",
  folderCategories: "Folder-derived categories",
  yearsExperience: "CV-stated years of experience",
  documentedYearsEstimate: "Documented estimate (years)",
  rawSource: "Original source fields",
  sourceReviews: "Source reviews",
  gpa: "GPA",
  requisitionId: "Requisition ID",
  startAt: "Start time (Dubai)",
  customValues: "Custom task values",
  meetingUrl: "Meeting URL",
  privateOwnerId: "Owner",
  completed: "Counts as completed",
  assigneeIds: "Assignees",
  jobTitleKey: "Job title",
};
// The field type by key, checked in this order after the dropdowns; any other key is text.
const typedKeys: [FieldType, string[]][] = [
  [
    "tags",
    [
      "skills",
      "certifications",
      "languages",
      "folderCategories",
      "options",
      "assigneeIds",
    ],
  ],
  ["json", ["rawSource", "evidence", "sourceReviews", "query", "customValues"]],
  ["checkbox", ["required", "completed"]],
  [
    "number",
    [
      "yearsExperience",
      "documentedYearsEstimate",
      "openings",
      "position",
      "minutes",
    ],
  ],
  [
    "date",
    [
      "targetDate",
      "appliedDate",
      "dueDate",
      "sentDate",
      "expiryDate",
      "startDate",
    ],
  ],
  ["datetime-local", ["startAt"]],
  [
    "textarea",
    [
      "description",
      "requirements",
      "notes",
      "body",
      "sourceNotes",
      "experienceWording",
      "declineReason",
    ],
  ],
];
const REQUIRED_KEYS = ["name", "title", "body", "startAt"];
// A vacancy's job title is never a generic editor field: the editor's own job title picker (ADM-27)
// renders it and sends it only when it changed.
const READ_ONLY_KEYS = [
  "rawSource",
  "evidence",
  "sourceReviews",
  "jobTitleKey",
];

/** Today's presentation of one system field of any kind, as RESOURCE_CONFIG lists it. */
export function systemFieldConfig(kind: RecordKind, key: string) {
  const options = enumOptions[`${kind}.${key}`];
  const type: FieldType = options
    ? "select"
    : (typedKeys.find(([, keys]) => keys.includes(key))?.[0] ?? "text");
  return {
    key,
    label:
      fieldLabels[key] ||
      key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()),
    type,
    options,
    required: REQUIRED_KEYS.includes(key),
    readOnly: READ_ONLY_KEYS.includes(key),
  };
}

// Every key a system field in schema order, every screen in today's editor order (§2.2).
function defaultKindSchema(kind: ConfigurableKind): DefaultKindSchemaBody {
  const keys = systemFieldKeys(kind);
  const sensitive: readonly string[] =
    kind === "candidate" ? SENSITIVE_CANDIDATE_FIELDS : [];
  return {
    kind,
    label: KIND_LABELS[kind][0],
    singular: KIND_LABELS[kind][1],
    fields: keys.map((key) => {
      const { label, type, options, required, readOnly } = systemFieldConfig(
        kind,
        key,
      );
      return {
        key,
        system: true,
        label,
        type,
        ...(options ? { options: [...options] } : {}),
        required,
        readOnly,
        sensitive: sensitive.includes(key),
      };
    }),
    screens: SCREEN_ACTIONS.map((action) => ({ action, fields: [...keys] })),
  };
}
const KIND_SCHEMA_IDS = {
  candidate: 201,
  "job-role": 202,
  vacancy: 203,
  application: 204,
  task: 205,
  interview: 206,
  offer: 207,
  onboarding: 208,
  checklist: 209,
} satisfies Record<ConfigurableKind, number>;
/** The compiled default kind schema of each configurable kind, used until a workspace publishes one. */
export const DEFAULT_KIND_SCHEMAS = Object.freeze(
  Object.fromEntries(
    CONFIGURABLE_KINDS.map((kind) => [
      kind,
      template<KindSchemaDefault>(
        kind,
        KIND_SCHEMA_IDS[kind],
        defaultKindSchema(kind),
      ),
    ]),
  ) as Record<ConfigurableKind, KindSchemaDefault>,
);
