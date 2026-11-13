// The Screens page designer's edits (R2b-10): pure functions that take a kind schema body and the
// key of one of its screens, and return a new body with only that screen changed; the body given
// stays unchanged, and so do the field definitions, the sensitive marks and every other screen. The
// move buttons, the drag handlers and Save draft all go through them.
import type { KindSchemaBody } from "@/domain/config";
import { screenLabel } from "@/domain/field-where-used";
import {
  screenKey,
  type Screen,
  type ScreenEntry,
  type ScreenGroup,
} from "@/domain/screens";

type Field = KindSchemaBody["fields"][number];
/** A position on a screen: the section's index and the entry's index within it. */
export type Place = { group: number; index: number };

/** The four rules of an entry, in the order the radiogroup offers them. */
export const RULES = ["required", "optional", "readOnly", "hidden"] as const;
export type Rule = (typeof RULES)[number];
export const RULE_LABELS: Record<Rule, string> = {
  required: "Required",
  optional: "Optional",
  readOnly: "Read only",
  hidden: "Hidden",
};
/** Most sections a screen holds, as the body schema allows. */
export const SECTIONS_MAX = 20;
export const NEW_SECTION = "New section";
export const UNNAMED_SECTION = "Section without a name";

/** A section's name as the page shows it. */
export const sectionName = (group: ScreenGroup) =>
  group.label ?? UNNAMED_SECTION;
/** A section as announcements and button names call it. */
export const sectionTitle = (group: ScreenGroup) =>
  group.label ? `${group.label} section` : UNNAMED_SECTION;

export const findScreen = (body: KindSchemaBody, key: string) =>
  body.screens.find((screen) => screenKey(screen) === key);

/** A copy of the body with `change` applied to its screen with this key. */
function onScreen(
  body: KindSchemaBody,
  key: string,
  change: (screen: Screen) => void,
): KindSchemaBody {
  const copy = structuredClone(body);
  const screen = findScreen(copy, key);
  if (screen) change(screen);
  return copy;
}

/** Where the screen lists the field, or null. */
export function placeOf(screen: Screen, fieldKey: string): Place | null {
  for (const [group, item] of screen.groups.entries()) {
    const index = item.fields.findIndex((entry) => entry.key === fieldKey);
    if (index >= 0) return { group, index };
  }
  return null;
}

/** The field appended as `{key}` to the last section, or placed at `to`; once per screen. */
export function addEntry(
  body: KindSchemaBody,
  key: string,
  fieldKey: string,
  to?: Place,
): KindSchemaBody {
  return onScreen(body, key, (screen) => {
    if (placeOf(screen, fieldKey)) return;
    const fields = screen.groups[to?.group ?? screen.groups.length - 1]?.fields;
    fields?.splice(to?.index ?? fields.length, 0, { key: fieldKey });
  });
}

/** The field's entry taken off the screen; the field and its stored values are kept. */
export function removeEntry(
  body: KindSchemaBody,
  key: string,
  fieldKey: string,
): KindSchemaBody {
  return onScreen(body, key, (screen) => {
    for (const group of screen.groups)
      group.fields = group.fields.filter((entry) => entry.key !== fieldKey);
  });
}

/** Whether a move by `step` (-1 up, 1 down) has somewhere to go: not the screen's first or last. */
export function canMoveEntry(screen: Screen, fieldKey: string, step: -1 | 1) {
  const at = placeOf(screen, fieldKey);
  if (!at) return false;
  return step < 0
    ? at.group > 0 || at.index > 0
    : at.group < screen.groups.length - 1 ||
        at.index < screen.groups[at.group].fields.length - 1;
}

/**
 * The entry swapped with its neighbour in its section; at a section's first position up moves it
 * to the end of the previous section, and at its last position down to the start of the next.
 */
export function moveEntry(
  body: KindSchemaBody,
  key: string,
  fieldKey: string,
  step: -1 | 1,
): KindSchemaBody {
  return onScreen(body, key, (screen) => {
    const at = placeOf(screen, fieldKey);
    if (!at || !canMoveEntry(screen, fieldKey, step)) return;
    const fields = screen.groups[at.group].fields;
    const next = at.index + step;
    if (next >= 0 && next < fields.length) {
      [fields[at.index], fields[next]] = [fields[next], fields[at.index]];
      return;
    }
    const [entry] = fields.splice(at.index, 1);
    if (step < 0) screen.groups[at.group - 1].fields.push(entry);
    else screen.groups[at.group + 1].fields.unshift(entry);
  });
}

/**
 * The entry, with its flags, placed before the entry at `to.index` of section `to.group` as the
 * screen lists them before the move, or at the section's end when `to.index` is its length (a drop).
 */
export function moveEntryTo(
  body: KindSchemaBody,
  key: string,
  fieldKey: string,
  to: Place,
): KindSchemaBody {
  return onScreen(body, key, (screen) => {
    const at = placeOf(screen, fieldKey);
    if (!at || !screen.groups[to.group]) return;
    const index = at.group === to.group && at.index < to.index ? -1 : 0;
    const [entry] = screen.groups[at.group].fields.splice(at.index, 1);
    screen.groups[to.group].fields.splice(to.index + index, 0, entry);
  });
}

/** The entry with exactly the rule's flag: mandatory, read-only or hidden, none for Optional. */
export function setEntryRule(
  body: KindSchemaBody,
  key: string,
  fieldKey: string,
  rule: Rule,
): KindSchemaBody {
  const flags: Record<Rule, Omit<ScreenEntry, "key">> = {
    required: { mandatory: true },
    optional: {},
    readOnly: { readOnly: true },
    hidden: { hidden: true },
  };
  return onScreen(body, key, (screen) => {
    for (const group of screen.groups)
      group.fields = group.fields.map((entry) =>
        entry.key === fieldKey ? { key: fieldKey, ...flags[rule] } : entry,
      );
  });
}

/** An empty section named "New section" at the end, up to SECTIONS_MAX. */
export function addSection(body: KindSchemaBody, key: string): KindSchemaBody {
  return onScreen(body, key, (screen) => {
    if (screen.groups.length < SECTIONS_MAX)
      screen.groups.push({ label: NEW_SECTION, fields: [] });
  });
}

/** The section's name as typed; an empty name means none. */
export function renameSection(
  body: KindSchemaBody,
  key: string,
  group: number,
  label: string,
): KindSchemaBody {
  return onScreen(body, key, (screen) => {
    const { fields } = screen.groups[group];
    screen.groups[group] = label.trim() ? { label, fields } : { fields };
  });
}

/** The section moved to position `to`, with its fields. */
export function moveSection(
  body: KindSchemaBody,
  key: string,
  group: number,
  to: number,
): KindSchemaBody {
  return onScreen(body, key, (screen) => {
    if (to < 0 || to >= screen.groups.length) return;
    const [moved] = screen.groups.splice(group, 1);
    screen.groups.splice(to, 0, moved);
  });
}

/** The section and its entries taken off the screen; the fields and their stored values are kept. */
export function removeSection(
  body: KindSchemaBody,
  key: string,
  group: number,
): KindSchemaBody {
  return onScreen(body, key, (screen) => {
    screen.groups.splice(group, 1);
  });
}

const archivedOf = (field: Field) => !field.system && !!field.archived;
/** Whether the field counts as required: required and not archived. */
const requiredOf = (field: Field) => field.required && !archivedOf(field);

/**
 * The entry's rule as the radiogroup checks it: Hidden if hidden; else Read only if flagged or the
 * definition is read-only; else Required if flagged mandatory or the field is required; else Optional.
 */
export function entryRule(field: Field, entry: ScreenEntry): Rule {
  if (entry.hidden) return "hidden";
  if (entry.readOnly || (field.system && field.readOnly)) return "readOnly";
  if (entry.mandatory || requiredOf(field)) return "required";
  return "optional";
}

/**
 * The rules not offered for the field on this screen, the reasons shown beside them, and whether
 * its entry can be removed. A required system field stays on a create screen, editable and shown.
 */
export function ruleLimits(field: Field, screen: Screen) {
  const create = screen.action === "create";
  const pinned = create && field.system && requiredOf(field);
  const off = new Set<Rule>();
  const reasons: string[] = [];
  if (requiredOf(field)) off.add("optional");
  if (pinned) {
    off.add("readOnly").add("hidden");
    reasons.push("Required, so it stays on this create screen.");
  }
  if (field.system && field.readOnly) {
    off.add("required").add("optional");
    reasons.push("Always read only.");
  }
  if (!field.system && create) {
    off.add("required");
    reasons.push("Custom fields cannot be required on a create screen yet.");
  }
  if (archivedOf(field)) off.add("required");
  return {
    disabled: RULES.filter((rule) => off.has(rule)),
    reasons,
    removable: !pinned,
  };
}

/**
 * Why the browser does not send this body, in plain words, for the screen with this key: an empty
 * section, and on a create screen a required system field it leaves out, hides or makes read-only.
 * Empty when it may go on to draftRefusal.
 */
export function designerRefusal(body: KindSchemaBody, key: string): string[] {
  const screen = findScreen(body, key);
  if (!screen) return [];
  const issues = screen.groups.flatMap((group) =>
    group.fields.length
      ? []
      : [
          `${sectionName(group)} has no fields. Add a field or remove the section.`,
        ],
  );
  if (screen.action === "create") {
    const entries = screen.groups.flatMap((group) => group.fields);
    for (const field of body.fields) {
      if (!field.system || !field.required) continue;
      const entry = entries.find((item) => item.key === field.key);
      if (!entry || entry.hidden || entry.readOnly)
        issues.push(
          `${field.label} is required, so the ${screenLabel(screen)} must show it and let people fill it.`,
        );
    }
  }
  return issues;
}

// What the live region says after each edit, read from the body after it.
/** "Email moved to position 2 of 3 in Contact." */
export function movedText(screen: Screen, label: string, fieldKey: string) {
  const at = placeOf(screen, fieldKey);
  if (!at) return "";
  const group = screen.groups[at.group];
  return `${label} moved to position ${at.index + 1} of ${group.fields.length} in ${sectionName(group)}.`;
}
/** "Contact section moved to position 1 of 2." */
export const sectionMovedText = (screen: Screen, group: number) =>
  `${sectionTitle(screen.groups[group])} moved to position ${group + 1} of ${screen.groups.length}.`;
/** "Email added to Contact." */
export function addedText(screen: Screen, label: string, fieldKey: string) {
  const at = placeOf(screen, fieldKey);
  return at ? `${label} added to ${sectionName(screen.groups[at.group])}.` : "";
}
/** "Email removed from this screen." */
export const removedText = (label: string) =>
  `${label} removed from this screen.`;
/** "Email is now Read only." */
export const ruleText = (label: string, rule: Rule) =>
  `${label} is now ${RULE_LABELS[rule]}.`;
