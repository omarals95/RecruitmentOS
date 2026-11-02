import {
  RESOURCE_CONFIG,
  referencesByKind,
  type ResourceName,
  type RecordDto,
  type ReferenceField,
} from "@/domain/records";

/** Validate separately, then send only user-editable properties. Zod defaults must not add importer-owned source fields. */
export function recordMutation(
  resource: ResourceName,
  values: Record<string, unknown>,
  refs: Partial<Record<ReferenceField, string>>,
  record?: RecordDto,
) {
  const config = RESOURCE_CONFIG[resource];
  const data: Record<string, unknown> = {};
  for (const field of config.fields) {
    if (field.readOnly || field.key === "legacyAuthorLabel") continue;
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
