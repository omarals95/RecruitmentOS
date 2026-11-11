import {
  RESOURCE_CONFIG,
  referencesByKind,
  type ResourceName,
  type RecordDto,
  type ReferenceField,
} from "@/domain/records";

/**
 * Validate separately, then send only user-editable properties. Zod defaults must not add
 * importer-owned source fields. A task's assigneeIds is left out: assigneeInput adds it.
 */
export function recordMutation(
  resource: ResourceName,
  values: Record<string, unknown>,
  refs: Partial<Record<ReferenceField, string>>,
  record?: RecordDto,
) {
  const config = RESOURCE_CONFIG[resource];
  const data: Record<string, unknown> = {};
  for (const field of config.fields) {
    if (
      field.readOnly ||
      field.key === "legacyAuthorLabel" ||
      field.key === "assigneeIds"
    )
      continue;
    let value = values[field.key];
    if (field.type === "tags" && typeof value === "string")
      value = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    if (field.key === "amount" && value === "") value = null;
    if (field.type === "number" && value === "") value = null;
    data[field.key] = value;
  }
  const references: Record<string, unknown> = {};
  for (const [key, details] of Object.entries(referencesByKind[config.kind])) {
    if (record && details.immutable) continue;
    references[key] = refs[key as ReferenceField] || null;
  }
  return record
    ? { version: record.version, data, ...references }
    : { data, ...references };
}
/**
 * A task's assignees for its save: sent only when the selection changed, as a vacancy's org unit,
 * so a save never clears assignees the editor did not load.
 */
export function assigneeInput(
  saved: readonly string[],
  selected: readonly string[],
): { assigneeIds?: string[] } {
  const changed =
    saved.length !== selected.length ||
    selected.some((userId) => !saved.includes(userId));
  return changed ? { assigneeIds: [...selected] } : {};
}
/**
 * A vacancy's job title for its save: sent only when another title was chosen, so a save never
 * re-sends a saved key a newer version removed. The API cannot clear it, so "" is never sent.
 */
export function vacancyTitleInput(
  saved: string | undefined,
  chosen: string,
): { jobTitleKey?: string } {
  return chosen && chosen !== saved ? { jobTitleKey: chosen } : {};
}
export function personalStateMutation(state: {
  version: number;
  shortlisted: boolean;
  status: string;
  note: string;
}) {
  return {
    version: state.version,
    shortlisted: state.shortlisted,
    status: state.status,
    note: state.note,
  };
}
export function customValueDefaults(
  values: Record<string, unknown>,
  fields: RecordDto<"task-field">[],
) {
  const result = { ...values };
  for (const field of fields) {
    if (result[field.id] === undefined) {
      if (field.data.type === "Checkbox") result[field.id] = false;
      else if (field.data.type === "Dropdown")
        result[field.id] = field.data.options[0] || "";
    }
  }
  return result;
}
