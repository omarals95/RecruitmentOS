import { describe, expect, it, vi } from "vitest";
import {
  CONFIGURABLE_KINDS,
  kindSchemaBodySchema,
  SCREEN_ACTIONS,
  type ConfigurableKind,
} from "@/domain/config";
import {
  DEFAULT_KIND_SCHEMAS,
  INTERVIEWER_ROLE,
  ROLE_TEMPLATES,
} from "@/domain/config-defaults";
import {
  kindToResource,
  RESOURCE_CONFIG,
  SENSITIVE_CANDIDATE_FIELDS,
  recordDataSchemas,
  resourceToKind,
  type FieldType,
  type RecordKind,
  type ResourceConfig,
  type ResourceName,
} from "@/domain/records";
import { kindSchemaFor } from "@/lib/config-store";
import type { TenantAccess } from "@/lib/tenant-context";

// Today's derivation, copied verbatim from src/domain/records.ts at 75de073 (lines 581-707), with
// the enum constants it reads; the snapshot RESOURCE_CONFIG must keep reproducing. R2a-20 (job 062)
// renamed the task label to "Team tasks" and added the task's assigneeIds, a tags field "Assignees".
const APPLICATION_STAGES = [
  "Sourced",
  "Screening",
  "Interview",
  "Offer",
  "Hired",
  "Rejected",
  "Withdrawn",
] as const;
const TASK_FIELD_TYPES = [
  "Text",
  "Number",
  "Date",
  "Dropdown",
  "Checkbox",
] as const;
const REVIEW_STATUSES = ["Needs review", "Reviewed"] as const;
const labels: Record<RecordKind, [string, string]> = {
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
// Today's keys: the shape without the optional customValues R2b-02 added to every configurable kind
// but task.
const todayKeys = (kind: RecordKind) =>
  Object.keys(recordDataSchemas[kind].shape).filter(
    (key) => kind === "task" || key !== "customValues",
  );
const TODAY = Object.fromEntries(
  Object.entries(resourceToKind).map(([resource, kind]) => [
    resource,
    {
      kind,
      label: labels[kind][0],
      singular: labels[kind][1],
      fields: todayKeys(kind).map((key) => {
        const options = enumOptions[`${kind}.${key}`];
        const type: FieldType = options
          ? "select"
          : [
                "skills",
                "certifications",
                "languages",
                "folderCategories",
                "options",
                "assigneeIds",
              ].includes(key)
            ? "tags"
            : [
                  "rawSource",
                  "evidence",
                  "sourceReviews",
                  "query",
                  "customValues",
                ].includes(key)
              ? "json"
              : ["required", "completed"].includes(key)
                ? "checkbox"
                : [
                      "yearsExperience",
                      "documentedYearsEstimate",
                      "openings",
                      "position",
                      "minutes",
                    ].includes(key)
                  ? "number"
                  : [
                        "targetDate",
                        "appliedDate",
                        "dueDate",
                        "sentDate",
                        "expiryDate",
                        "startDate",
                      ].includes(key)
                    ? "date"
                    : key === "startAt"
                      ? "datetime-local"
                      : [
                            "description",
                            "requirements",
                            "notes",
                            "body",
                            "sourceNotes",
                            "experienceWording",
                            "declineReason",
                          ].includes(key)
                        ? "textarea"
                        : "text";
        return {
          key,
          label:
            fieldLabels[key] ||
            key
              .replace(/([A-Z])/g, " $1")
              .replace(/^./, (c) => c.toUpperCase()),
          type,
          options,
          required: ["name", "title", "body", "startAt"].includes(key),
          readOnly: [
            "rawSource",
            "evidence",
            "sourceReviews",
            "jobTitleKey",
          ].includes(key),
        };
      }),
    },
  ]),
) as Record<ResourceName, ResourceConfig>;

/** Every own key in order, at every level, including keys whose value is undefined. */
const keyOrder = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(keyOrder)
    : value && typeof value === "object"
      ? Object.entries(value).map(([key, child]) => [key, keyOrder(child)])
      : value;
const allFrozen = (value: unknown): boolean =>
  !value ||
  typeof value !== "object" ||
  (Object.isFrozen(value) && Object.values(value).every(allFrozen));
const fieldsOf = (kind: ConfigurableKind) =>
  DEFAULT_KIND_SCHEMAS[kind].body.fields;
const keysWhere = (
  kind: ConfigurableKind,
  flag: "required" | "readOnly" | "sensitive",
) =>
  fieldsOf(kind)
    .filter((field) => field[flag])
    .map((field) => field.key);
const ids = (first: number, last: number) =>
  Array.from(
    { length: last - first + 1 },
    (_, index) => `00000000-0000-4000-8000-000000000${first + index}`,
  );

describe("built-in default kind schemas (R2b-01)", () => {
  it("keeps RESOURCE_CONFIG identical to today's, key order included", () => {
    expect(RESOURCE_CONFIG).toStrictEqual(TODAY);
    expect(keyOrder(RESOURCE_CONFIG)).toStrictEqual(keyOrder(TODAY));
    expect(Object.keys(RESOURCE_CONFIG)).toEqual(Object.keys(resourceToKind));
  });

  it("has exactly the nine configurable kinds, in schema order", () => {
    expect(CONFIGURABLE_KINDS).toEqual([
      "candidate",
      "job-role",
      "vacancy",
      "application",
      "task",
      "interview",
      "offer",
      "onboarding",
      "checklist",
    ]);
    expect(Object.keys(DEFAULT_KIND_SCHEMAS)).toEqual([...CONFIGURABLE_KINDS]);
    for (const kind of ["bucket", "task-field", "saved-view", "comment"])
      expect(DEFAULT_KIND_SCHEMAS).not.toHaveProperty(kind);
    for (const kind of CONFIGURABLE_KINDS) {
      expect(DEFAULT_KIND_SCHEMAS[kind].key).toBe(kind);
      expect(DEFAULT_KIND_SCHEMAS[kind].body.kind).toBe(kind);
      expect(Object.keys(DEFAULT_KIND_SCHEMAS[kind].body)).toEqual([
        "kind",
        "label",
        "singular",
        "fields",
        "screens",
      ]);
    }
  });

  it("lists every schema key as a system field with today's label, type and options", () => {
    for (const kind of CONFIGURABLE_KINDS) {
      const keys = todayKeys(kind);
      const today = TODAY[kindToResource[kind]];
      expect(fieldsOf(kind).map((field) => field.key)).toEqual(keys);
      expect(fieldsOf(kind).every((field) => field.system === true)).toBe(true);
      expect(
        fieldsOf(kind).map(({ key, label, type, options }) => ({
          key,
          label,
          type,
          options,
        })),
      ).toEqual(
        today.fields.map(({ key, label, type, options }) => ({
          key,
          label,
          type,
          options,
        })),
      );
      for (const field of fieldsOf(kind))
        expect(Object.hasOwn(field, "options"), `${kind}.${field.key}`).toBe(
          field.type === "select",
        );
    }
  });

  it("keeps today's required, read-only and sensitive sets", () => {
    const required: Record<ConfigurableKind, string[]> = {
      candidate: ["name"],
      "job-role": ["title"],
      vacancy: ["title"],
      application: [],
      task: ["title"],
      interview: ["title", "startAt"],
      offer: ["title"],
      onboarding: [],
      checklist: ["title"],
    };
    for (const kind of CONFIGURABLE_KINDS) {
      expect(keysWhere(kind, "required"), kind).toEqual(required[kind]);
      expect(keysWhere(kind, "readOnly"), kind).toEqual(
        kind === "candidate"
          ? ["rawSource", "evidence", "sourceReviews"]
          : kind === "vacancy"
            ? ["jobTitleKey"]
            : [],
      );
      expect(keysWhere(kind, "sensitive").sort(), kind).toEqual(
        kind === "candidate" ? [...SENSITIVE_CANDIDATE_FIELDS].sort() : [],
      );
    }
    expect(
      fieldsOf("candidate").find((field) => field.key === "residenceEmirate"),
    ).toMatchObject({ sensitive: false });
  });

  it("keeps the fixed enums as dropdown fields with fixed options", () => {
    const option = (kind: ConfigurableKind, key: string) =>
      fieldsOf(kind).find((field) => field.key === key);
    expect(option("offer", "payPeriod")).toMatchObject({
      type: "select",
      options: ["Monthly", "Annual", "Hourly", "One-time"],
    });
    expect(option("checklist", "category")).toMatchObject({
      type: "select",
      options: ["Document", "Orientation", "Training", "Other"],
    });
    expect(option("task", "priority")).toMatchObject({
      type: "select",
      options: ["Low", "Normal", "High", "Urgent"],
    });
    expect(option("candidate", "reviewStatus")).toMatchObject({
      type: "select",
      options: [...REVIEW_STATUSES],
    });
  });

  it("keeps today's labels, with Team tasks and Task", () => {
    for (const kind of CONFIGURABLE_KINDS) {
      const { label, singular } = DEFAULT_KIND_SCHEMAS[kind].body;
      expect([label, singular]).toEqual(labels[kind]);
    }
    expect(DEFAULT_KIND_SCHEMAS.task.body.label).toBe("Team tasks");
    expect(DEFAULT_KIND_SCHEMAS.task.body).toMatchObject({
      label: "Team tasks",
      singular: "Task",
    });
    expect(
      DEFAULT_KIND_SCHEMAS.task.body.fields.find(
        (field) => field.key === "assigneeIds",
      ),
    ).toEqual({
      key: "assigneeIds",
      system: true,
      label: "Assignees",
      type: "tags",
      required: false,
      readOnly: false,
      sensitive: false,
    });
  });

  it("has a default create, edit and view screen, each one unlabelled group of every field in schema order", () => {
    for (const kind of CONFIGURABLE_KINDS)
      expect(DEFAULT_KIND_SCHEMAS[kind].body.screens).toStrictEqual(
        ["create", "edit", "view"].map((action) => ({
          action,
          groups: [{ fields: todayKeys(kind).map((key) => ({ key })) }],
        })),
      );
    expect(SCREEN_ACTIONS).toEqual(["create", "edit", "view", "transition"]);
  });

  it("passes every default through the kind-schema body schema unchanged", () => {
    for (const kind of CONFIGURABLE_KINDS) {
      const body = DEFAULT_KIND_SCHEMAS[kind].body;
      expect(kindSchemaBodySchema.parse(body), kind).toStrictEqual(body);
    }
  });

  it("refuses unknown keys, foreign or repeated keys, misplaced options and over-long text", () => {
    const base = () => structuredClone(DEFAULT_KIND_SCHEMAS.offer.body);
    const refused = (change: (body: Record<string, unknown>) => void) => {
      const body = base() as unknown as Record<string, unknown>;
      change(body);
      return !kindSchemaBodySchema.safeParse(body).success;
    };
    type Field = Record<string, unknown>;
    const fields = (body: Record<string, unknown>) => body.fields as Field[];
    const screens = (body: Record<string, unknown>) =>
      body.screens as (Field & {
        action: string;
        groups: { fields: { key: string }[] }[];
      })[];
    const payPeriod = (body: Record<string, unknown>) =>
      fields(body).find((field) => field.key === "payPeriod")!;
    expect(refused(() => {})).toBe(false);
    // Unknown top-level keys, record ids and values, defaults and types.
    for (const key of ["id", "recordId", "values", "types", "workflow"])
      expect(refused((body) => (body[key] = []))).toBe(true);
    for (const key of ["value", "default", "recordId", "hidden"])
      expect(refused((body) => (fields(body)[0][key] = "Fictional"))).toBe(
        true,
      );
    expect(refused((body) => (screens(body)[0].hidden = []))).toBe(true);
    // Keys outside the kind's shape, a custom uuid key, and repeated keys.
    expect(refused((body) => (fields(body)[0].key = "suitabilityScore"))).toBe(
      true,
    );
    expect(
      refused(
        (body) =>
          (fields(body)[0].key = "00000000-0000-4000-a000-000000000009"),
      ),
    ).toBe(true);
    expect(refused((body) => (fields(body)[1].key = "title"))).toBe(true);
    expect(refused((body) => (body.kind = "bucket"))).toBe(true);
    expect(refused((body) => (fields(body)[0].system = false))).toBe(true);
    // Options only on dropdowns, always on dropdowns, unique and bounded.
    expect(refused((body) => (fields(body)[0].options = ["Fictional"]))).toBe(
      true,
    );
    expect(refused((body) => delete payPeriod(body).options)).toBe(true);
    expect(refused((body) => (payPeriod(body).options = []))).toBe(true);
    expect(
      refused((body) => (payPeriod(body).options = ["Monthly", "Monthly"])),
    ).toBe(true);
    expect(
      refused((body) => (payPeriod(body).options = ["x".repeat(201)])),
    ).toBe(true);
    // Any other options are refused too: a system field keeps its options (R2b-07).
    expect(
      refused((body) => (payPeriod(body).options = ["x".repeat(200)])),
    ).toBe(true);
    expect(refused((body) => (fields(body)[0].type = "rich-text"))).toBe(true);
    // Screens name only fields of the schema, once each, one screen per action.
    expect(
      refused((body) =>
        screens(body)[0].groups[0].fields.push({ key: "suitability" }),
      ),
    ).toBe(true);
    expect(
      refused((body) =>
        screens(body)[0].groups[0].fields.push({ key: "title" }),
      ),
    ).toBe(true);
    expect(refused((body) => (screens(body)[1].action = "create"))).toBe(true);
    expect(refused((body) => (screens(body)[0].action = "approve"))).toBe(true);
    expect(refused((body) => (body.screens = []))).toBe(true);
    expect(refused((body) => (body.fields = []))).toBe(true);
    // Labels are 1 to 120 characters after cleaning.
    for (const label of ["x".repeat(121), ""]) {
      expect(refused((body) => (body.label = label))).toBe(true);
      expect(refused((body) => (body.singular = label))).toBe(true);
      expect(refused((body) => (fields(body)[0].label = label))).toBe(true);
    }
    expect(refused((body) => (fields(body)[0].label = "x".repeat(120)))).toBe(
      false,
    );
  });

  it("freezes every default and gives it a fixed, unique version id at version 1", () => {
    const versionIds = CONFIGURABLE_KINDS.map(
      (kind) => DEFAULT_KIND_SCHEMAS[kind].versionId,
    );
    expect(versionIds).toEqual(ids(201, 209));
    expect(new Set(versionIds).size).toBe(9);
    const roleIds = ROLE_TEMPLATES.map((role) => role.versionId);
    expect(roleIds).toEqual(ids(101, 106));
    for (const id of versionIds) expect(roleIds).not.toContain(id);
    expect(Object.isFrozen(DEFAULT_KIND_SCHEMAS)).toBe(true);
    for (const kind of CONFIGURABLE_KINDS) {
      expect(DEFAULT_KIND_SCHEMAS[kind].version).toBe(1);
      expect(allFrozen(DEFAULT_KIND_SCHEMAS[kind]), kind).toBe(true);
    }
  });

  it("resolves the compiled default when the workspace has published no kind schema", () => {
    const access: TenantAccess = {
      scopes: [],
      workspaceId: "00000000-0000-4000-a000-000000000001",
      memberRole: "viewer",
      companyLevel: null,
      companyAreas: [],
      versions: {},
      teamArchived: false,
      documents: {},
      roleVersionId: null,
      recordScope: null,
      homeUnits: [],
    };
    for (const kind of CONFIGURABLE_KINDS)
      expect(kindSchemaFor(access, kind)).toEqual({
        versionId: DEFAULT_KIND_SCHEMAS[kind].versionId,
        number: 1,
        body: DEFAULT_KIND_SCHEMAS[kind].body,
      });
  });

  it("loads with the defaults, the records or the config module imported first", async () => {
    const loads = {
      defaults: () => import("@/domain/config-defaults"),
      records: () => import("@/domain/records"),
      config: () => import("@/domain/config"),
    };
    for (const [first, load] of Object.entries(loads)) {
      vi.resetModules();
      await load();
      const records = await import("@/domain/records");
      const defaults = await import("@/domain/config-defaults");
      expect(records.RESOURCE_CONFIG, first).toStrictEqual(TODAY);
      expect(Object.keys(defaults.DEFAULT_KIND_SCHEMAS), first).toEqual([
        ...CONFIGURABLE_KINDS,
      ]);
    }
  });

  it("keeps custom values out of the eight kinds' fields and the task's own field (R2b-02)", () => {
    for (const kind of CONFIGURABLE_KINDS) {
      const field = fieldsOf(kind).find(({ key }) => key === "customValues");
      const config = RESOURCE_CONFIG[kindToResource[kind]].fields.find(
        ({ key }) => key === "customValues",
      );
      if (kind === "task") {
        expect(field?.label).toBe("Custom task values");
        expect(config?.label).toBe("Custom task values");
      } else {
        expect(field, kind).toBeUndefined();
        expect(config, kind).toBeUndefined();
        for (const screen of DEFAULT_KIND_SCHEMAS[kind].body.screens)
          expect(
            screen.groups.flatMap((group) =>
              group.fields.map(({ key }) => key),
            ),
            kind,
          ).not.toContain("customValues");
      }
    }
    // The interviewer template hides every candidate key but name and job title, custom values too.
    const candidate = INTERVIEWER_ROLE.body.fields.candidate ?? {};
    expect(candidate.customValues).toBe("hidden");
    expect(
      Object.keys(recordDataSchemas.candidate.shape).filter(
        (key) => candidate[key] !== "hidden",
      ),
    ).toEqual(["name", "jobTitle"]);
  });

  it("gives the vacancy default exactly one more field, the read-only job title, and no other kind any (ADM-24)", () => {
    expect(fieldsOf("vacancy").map((field) => field.key)).toEqual([
      "title",
      "requisitionId",
      "department",
      "location",
      "employmentType",
      "workMode",
      "description",
      "requirements",
      "skills",
      "openings",
      "status",
      "hiringManager",
      "recruiter",
      "targetDate",
      "jobTitleKey",
    ]);
    expect(
      fieldsOf("vacancy").find((field) => field.key === "jobTitleKey"),
    ).toEqual({
      key: "jobTitleKey",
      system: true,
      label: "Job title",
      type: "text",
      required: false,
      readOnly: true,
      sensitive: false,
    });
    expect(
      Object.fromEntries(
        CONFIGURABLE_KINDS.map((kind) => [kind, fieldsOf(kind).length]),
      ),
    ).toEqual({
      candidate: 30,
      "job-role": 8,
      vacancy: 15,
      application: 5,
      task: 8,
      interview: 8,
      offer: 9,
      onboarding: 4,
      checklist: 6,
    });
    for (const kind of CONFIGURABLE_KINDS.filter((name) => name !== "vacancy"))
      expect(
        fieldsOf(kind).map((field) => field.key),
        kind,
      ).not.toContain("jobTitleKey");
  });
});
