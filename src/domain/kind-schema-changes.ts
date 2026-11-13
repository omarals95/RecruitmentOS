// What a kind schema draft changes against the version in force (R2b-09): the publish summary, the
// sensitive marks, and the rules every save and publish of a kind schema keeps beside the body
// schema. Pure and client-safe, so the Fields page and the configuration store share it.
import type { KindSchemaBody } from "./config";
import { mandatoryKeys, screenKey, type Screen } from "./screens";

type Field = KindSchemaBody["fields"][number];
export type FieldRef = { key: string; label: string };
/** The publish summary's categories, in the order the summary lists them. */
export const CHANGE_CATEGORIES = [
  "added",
  "renamed",
  "archived",
  "regrouped",
  "madeMandatory",
  "madeSensitive",
  "other",
] as const;
export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];
export type KindSchemaChanges = Record<ChangeCategory, FieldRef[]>;

// Absent flags mean false, as in the body schema.
const flag = (value: boolean | undefined) => value === true;
const archivedOf = (field: Field) => !field.system && flag(field.archived);

// Objects without key order or undefined keys, so equal definitions compare equal.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

type Place = {
  group: string | undefined;
  hidden: boolean;
  mandatory: boolean;
};
/** Each listed field's group label and flags, and the keys of each group label in screen order. */
function placesOf(screen: Screen | undefined) {
  const places = new Map<string, Place>();
  const groups = new Map<string | undefined, string[]>();
  for (const group of screen?.groups ?? [])
    for (const entry of group.fields) {
      places.set(entry.key, {
        group: group.label,
        hidden: flag(entry.hidden),
        mandatory: flag(entry.mandatory),
      });
      groups.set(group.label, [...(groups.get(group.label) ?? []), entry.key]);
    }
  return { places, groups };
}

/**
 * The fields a draft changes, by category; a field appears in every category that applies. A field
 * new in `after` counts as added, and as archived, made mandatory or made sensitive when it already
 * is. Regrouped means the field's group label differs on a screen both versions list it on; other is
 * any remaining difference in its definition or screen entries: help text, validation, default,
 * order within its group, the sensitive mark removed, made optional, or added to or removed from a
 * screen. Fields only in `before` are not listed: the store refuses removing a field.
 */
export function kindSchemaChanges(
  before: KindSchemaBody,
  after: KindSchemaBody,
): KindSchemaChanges {
  const found = Object.fromEntries(
    CHANGE_CATEGORIES.map((category) => [category, new Set<string>()]),
  ) as Record<ChangeCategory, Set<string>>;
  const mark = (category: ChangeCategory, key: string) =>
    found[category].add(key);
  const previous = new Map(before.fields.map((field) => [field.key, field]));
  const screens = new Map<string, { before?: Screen; after?: Screen }>();
  for (const screen of before.screens)
    screens.set(screenKey(screen), { before: screen });
  for (const screen of after.screens)
    screens.set(screenKey(screen), {
      ...screens.get(screenKey(screen)),
      after: screen,
    });
  const layouts = [...screens.values()].map((pair) => ({
    before: placesOf(pair.before),
    after: placesOf(pair.after),
  }));
  for (const field of after.fields) {
    const old = previous.get(field.key);
    if (!old) {
      mark("added", field.key);
      if (archivedOf(field)) mark("archived", field.key);
      if (flag(field.sensitive)) mark("madeSensitive", field.key);
      if (
        field.required ||
        layouts.some((layout) => layout.after.places.get(field.key)?.mandatory)
      )
        mark("madeMandatory", field.key);
      continue;
    }
    if (old.label !== field.label) mark("renamed", field.key);
    const archived = !archivedOf(old) && archivedOf(field);
    const required = !old.required && field.required;
    const sensitive = !flag(old.sensitive) && flag(field.sensitive);
    if (archived) mark("archived", field.key);
    if (required) mark("madeMandatory", field.key);
    if (sensitive) mark("madeSensitive", field.key);
    // The definition without the parts a category above already names.
    const rest = (version: Field) =>
      canonical({
        ...version,
        label: undefined,
        archived: archived ? undefined : archivedOf(version),
        required: required ? undefined : version.required,
        sensitive: sensitive ? undefined : flag(version.sensitive),
      });
    if (rest(old) !== rest(field)) mark("other", field.key);
    for (const layout of layouts) {
      const was = layout.before.places.get(field.key);
      const now = layout.after.places.get(field.key);
      if (now?.mandatory && !was?.mandatory) mark("madeMandatory", field.key);
      if (!was || !now) {
        if (was || now) mark("other", field.key);
        continue;
      }
      if (was.group !== now.group) mark("regrouped", field.key);
      else {
        // Order among the fields both versions list under this group label.
        const wasList = layout.before.groups.get(was.group) ?? [];
        const nowList = layout.after.groups.get(now.group) ?? [];
        const common = (list: string[], other: string[]) =>
          list.filter((key) => other.includes(key));
        if (
          common(wasList, nowList).indexOf(field.key) !==
          common(nowList, wasList).indexOf(field.key)
        )
          mark("other", field.key);
      }
      if (was.hidden !== now.hidden || (was.mandatory && !now.mandatory))
        mark("other", field.key);
    }
  }
  return Object.fromEntries(
    CHANGE_CATEGORIES.map((category) => [
      category,
      after.fields
        .filter((field) => found[category].has(field.key))
        .map(({ key, label }) => ({ key, label })),
    ]),
  ) as KindSchemaChanges;
}

/** Whether any field of `after` is marked sensitive differently from `before`; absent is unmarked. */
export function sensitiveMarksDiffer(
  before: Pick<KindSchemaBody, "fields">,
  after: Pick<KindSchemaBody, "fields">,
): boolean {
  const marks = new Map(
    before.fields.map((field) => [field.key, flag(field.sensitive)]),
  );
  return after.fields.some(
    (field) => flag(field.sensitive) !== (marks.get(field.key) ?? false),
  );
}

/**
 * Why the store refuses this body against the version in force, beyond the body schema: every field
 * in force is kept with the same system flag and type (keys are immutable, FLD-013 and FLD-015), and
 * every option in force with its id, since stored values hold option ids (FLD-022), and no custom
 * field is mandatory on a create screen while app forms cannot fill it (R2b-09 assumption 6). Each
 * message starts with the field's key.
 */
export function kindSchemaDraftIssues(
  inForce: KindSchemaBody,
  body: KindSchemaBody,
): string[] {
  const fields = new Map(body.fields.map((field) => [field.key, field]));
  const issues: string[] = [];
  for (const field of inForce.fields) {
    const now = fields.get(field.key);
    if (!now)
      issues.push(
        `${field.key}: a field cannot be removed; archive it instead.`,
      );
    else if (now.system !== field.system || now.type !== field.type)
      issues.push(`${field.key}: a field keeps its type.`);
    else if (
      !field.system &&
      !now.system &&
      "options" in field &&
      "options" in now &&
      field.options.some(
        (option) => !now.options.some((kept) => kept.id === option.id),
      )
    )
      issues.push(
        `${field.key}: an option cannot be removed; disable it instead.`,
      );
  }
  const mandatory = new Set(
    body.screens
      .filter((screen) => screen.action === "create")
      .flatMap((screen) => mandatoryKeys(body, screen)),
  );
  for (const field of body.fields)
    if (!field.system && mandatory.has(field.key))
      issues.push(
        `${field.key}: custom fields cannot be required on a create screen yet.`,
      );
  return issues;
}
