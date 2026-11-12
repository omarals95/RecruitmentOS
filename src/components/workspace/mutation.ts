import {
  CONFIGURABLE_KINDS,
  type ConfigurableKind,
  type KindSchemaBody,
} from "@/domain/config";
import { DEFAULT_KIND_SCHEMAS } from "@/domain/config-defaults";
import {
  RESOURCE_CONFIG,
  referencesByKind,
  type FieldConfig,
  type RecordKind,
  type ResourceName,
  type RecordDto,
  type ReferenceField,
} from "@/domain/records";
import { screenFor, shownKeys, type Screen } from "@/domain/screens";

/**
 * The kind schema body a configurable kind's editor and profile render from: the given one, else
 * the compiled default. Other kinds have none and render from RESOURCE_CONFIG.
 */
export function kindSchemaBodyOf(
  kind: RecordKind,
  schema?: KindSchemaBody,
): KindSchemaBody | undefined {
  return (CONFIGURABLE_KINDS as readonly RecordKind[]).includes(kind)
    ? (schema ?? DEFAULT_KIND_SCHEMAS[kind as ConfigurableKind].body)
    : undefined;
}
/** The system fields of the body that a screen shows, in body order, as the editor takes them. */
export function shownSystemFields(
  body: KindSchemaBody,
  screen: Screen,
): FieldConfig[] {
  const shown = new Set(shownKeys(screen));
  return body.fields.flatMap((field) =>
    field.system && shown.has(field.key) ? [field] : [],
  );
}

/**
 * Validate separately, then send only user-editable properties. Zod defaults must not add
 * importer-owned source fields. A task's assigneeIds is left out: assigneeInput adds it. A
 * configurable kind sends only the system fields its create or edit screen shows, and a task's
 * custom values leave out the kind schema's custom fields that screen does not show (R2b-07).
 */
export function recordMutation(
  resource: ResourceName,
  values: Record<string, unknown>,
  refs: Partial<Record<ReferenceField, string>>,
  record?: RecordDto,
  schema?: KindSchemaBody,
) {
  const config = RESOURCE_CONFIG[resource];
  const body = kindSchemaBodyOf(config.kind, schema);
  const screen = body && screenFor(body, null, record ? "edit" : "create");
  const shown = new Set(screen ? shownKeys(screen) : []);
  const data: Record<string, unknown> = {};
  for (const field of body && screen
    ? shownSystemFields(body, screen)
    : config.fields) {
    if (
      field.readOnly ||
      field.key === "legacyAuthorLabel" ||
      field.key === "assigneeIds"
    )
      continue;
    let value = values[field.key];
    if (field.key === "customValues" && body && value)
      value = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          ([key]) =>
            shown.has(key) ||
            !body.fields.some((custom) => !custom.system && custom.key === key),
        ),
      );
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
