// The built-in presentation of every system field. Its own module so config.ts can check a kind
// schema against it (configuration only tightens, architecture §1.5 item 3) without importing
// config-defaults.ts, which imports config.ts.
import {
  APPLICATION_STAGES,
  REVIEW_STATUSES,
  TASK_FIELD_TYPES,
} from "./record-schemas";
import type { FieldType, RecordKind } from "./records";

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
