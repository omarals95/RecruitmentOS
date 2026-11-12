// The field type engine (architecture §1.5 item 4): the fixed R2-02 data types, a bounded value
// schema per custom field definition and compileKindSchema. Pure: no I/O, no environment, and the
// compile cache is its only state. It imports ./config for types only, since config.ts imports it,
// and ./screens, which imports nothing at run time.
import { z } from "zod";
import { cleanClientName } from "../lib/client-name";
import {
  TASK_FIELD_TYPES,
  daySchema,
  recordDataSchemas,
  uuidSchema,
} from "./record-schemas";
import type { KindSchemaBody } from "./config";
import {
  mandatoryKeys,
  screenFor,
  screenKey,
  type ScreenAction,
} from "./screens";

// Invisible, control, format and bidi characters are removed first, then the length is checked.
const cleanText = (min: number, max: number) =>
  z.string().overwrite(cleanClientName).min(min).max(max);
export const configLabel = cleanText(1, 120);
export const configHelpText = cleanText(0, 500);
export const configOptionValue = cleanText(1, 200);

/** Record kinds with a kind schema; buckets, task fields, saved views and comments have none. */
export const CONFIGURABLE_KINDS = [
  "candidate",
  "job-role",
  "vacancy",
  "application",
  "task",
  "interview",
  "offer",
  "onboarding",
  "checklist",
] as const satisfies readonly (keyof typeof recordDataSchemas)[];

/**
 * The R2-02 data types, in R2-02 order. A fixed set with no registry or plug-in (architecture
 * §14.6); a field's type never changes after creation (FLD-013).
 */
export const FIELD_TYPES = [
  "short-text",
  "long-text",
  "rich-text",
  "number",
  "money",
  "percentage",
  "date",
  "date-time",
  "dropdown",
  "multi-select",
  "checkbox",
  "person",
  "org-unit",
  "url",
  "email",
  "phone",
  "file",
  "lookup",
] as const;
export type CustomFieldType = (typeof FIELD_TYPES)[number];

/** Today's task field types as engine types (architecture §2.2). */
export const TASK_FIELD_TYPE_MAP = {
  Text: "short-text",
  Number: "number",
  Date: "date",
  Dropdown: "dropdown",
  Checkbox: "checkbox",
} as const satisfies Record<(typeof TASK_FIELD_TYPES)[number], CustomFieldType>;

const PATTERN_MAX = 200;
// The quantifier at the start of rest: its text, its upper bound and whether its count can vary.
function quantifierAt(rest: string) {
  const match = /^(?:[*+?]|\{(\d+)(,(\d*))?\})/.exec(rest);
  if (!match) return null;
  const [token, low, comma, high] = match;
  const lower = token === "+" ? 1 : token.startsWith("{") ? Number(low) : 0;
  const upper =
    token === "?"
      ? 1
      : token === "*" || token === "+" || high === ""
        ? Infinity
        : Number(comma === undefined ? low : high);
  return { token, upper, varies: upper > lower };
}
/**
 * Why a pattern is refused, or null when it is safe. The rules are static and conservative, and
 * refuse some safe patterns too. A repeated group may hold no quantifier or alternation, which
 * rules out exponential backtracking. The whole pattern may hold one choice point (one quantifier
 * whose count varies, or one |), so a full match of a 4000-character value costs at most about
 * n × n steps: two side by side with a long fixed tail already take most of a second.
 */
export function patternIssue(source: string): string | null {
  if (source.length === 0 || source.length > PATTERN_MAX)
    return `A pattern has 1 to ${PATTERN_MAX} characters.`;
  // The scan below relies on this: a pattern that compiles closes every class, group and brace.
  try {
    new RegExp(source, "u");
    new RegExp(`^(?:${source})$`, "u");
  } catch {
    return "The pattern is not a valid regular expression.";
  }
  // Each open group records whether its body, nested groups included, holds a quantifier or |.
  const groups: boolean[] = [false];
  const mark = () => (groups[groups.length - 1] = true);
  let choices = 0;
  // A ? right after a quantifier makes it lazy; it is not a quantifier of its own.
  let afterQuantifier = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const quantifier = "*+?{".includes(char)
      ? quantifierAt(source.slice(i))
      : null;
    if (quantifier) {
      const lazy: boolean = char === "?" && afterQuantifier;
      if (!lazy) {
        mark();
        if (quantifier.varies) choices++;
      }
      i += quantifier.token.length - 1;
      afterQuantifier = !lazy;
      continue;
    }
    afterQuantifier = false;
    if (char === "\\") {
      const next = source[i + 1];
      if (/[1-9]/.test(next) || (next === "k" && source[i + 2] === "<"))
        return "A pattern may not hold a backreference.";
      // \p{…}, \P{…} and \u{…} carry braces that are not a quantifier.
      if ("pPu".includes(next) && source[i + 2] === "{")
        i = source.indexOf("}", i);
      else i++;
    } else if (char === "[") {
      for (i++; source[i] !== "]"; i++) if (source[i] === "\\") i++;
    } else if (char === "(") {
      if (/^\?<?[=!]/.test(source.slice(i + 1, i + 4)))
        return "A pattern may not hold a lookahead or lookbehind.";
      groups.push(false);
      // The ? of (?:, (?<name> and modifier groups is group syntax, not a quantifier.
      if (source[i + 1] === "?")
        i = source.indexOf(source[i + 2] === "<" ? ">" : ":", i);
    } else if (char === ")") {
      const repeats = groups.pop()!;
      if (repeats && (quantifierAt(source.slice(i + 1))?.upper ?? 0) > 1)
        return "A repeated group may not hold a quantifier or an alternation.";
      if (repeats) mark();
    } else if (char === "|") {
      mark();
      choices++;
    }
  }
  if (choices > 1)
    return "A pattern may hold only one quantifier of varying count or one alternation.";
  return null;
}

const length = z.number().int().min(0).max(4000);
const amountSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/)
  .refine((value) => Number(value) <= 1000000000);
const dateTimeSchema = z.iso.datetime({ offset: true });
const phoneSchema = z
  .string()
  .regex(/^\+?[0-9 ().-]{3,40}$/)
  .refine((value) => (value.match(/[0-9]/g)?.length ?? 0) >= 3);
const options = z
  .array(z.object({ id: configOptionValue, label: configOptionValue }).strict())
  .min(1)
  .max(100)
  .superRefine((list, ctx) => {
    for (const key of ["id", "label"] as const) {
      const seen = new Set<string>();
      list.forEach((option, index) => {
        if (seen.has(option[key]))
          ctx.addIssue({
            code: "custom",
            path: [index, key],
            message: `Option ${key}s must be unique.`,
          });
        seen.add(option[key]);
      });
    }
  });
const selections = z.number().int().min(0).max(100);
const bounds = <S extends z.ZodType>(schema: S) => ({
  min: schema.optional(),
  max: schema.optional(),
});
// Configuration holds no record ids or values, so the reference types take no default (§1.2).
const withDefault = { default: z.unknown().optional() };
/** The definitions of every type; `extra` adds the attributes a kind schema holds beside them. */
function definitions<E extends z.ZodRawShape>(extra: E) {
  const definition = <T extends CustomFieldType, S extends z.ZodRawShape>(
    type: T,
    shape: S,
  ) =>
    z
      .object({
        key: uuidSchema,
        system: z.literal(false),
        label: configLabel,
        help: configHelpText.optional(),
        type: z.literal(type),
        required: z.boolean(),
        // Absent means active. An archived field keeps its values and is never mandatory (§1.5).
        archived: z.boolean().optional(),
        ...extra,
        ...shape,
      })
      .strict();
  return z.discriminatedUnion("type", [
    definition("short-text", {
      ...bounds(length),
      pattern: z
        .string()
        .superRefine((source, ctx) => {
          const reason = patternIssue(source);
          if (reason) ctx.addIssue({ code: "custom", message: reason });
        })
        .optional(),
      ...withDefault,
    }),
    definition("long-text", { ...bounds(length), ...withDefault }),
    definition("rich-text", { ...bounds(length), ...withDefault }),
    definition("number", { ...bounds(z.number()), ...withDefault }),
    definition("money", {
      currency: z.string().regex(/^[A-Z]{3}$/),
      ...bounds(z.number().min(0).max(1000000000)),
      ...withDefault,
    }),
    definition("percentage", { ...bounds(z.number()), ...withDefault }),
    definition("date", { ...bounds(daySchema), ...withDefault }),
    definition("date-time", { ...bounds(dateTimeSchema), ...withDefault }),
    definition("dropdown", { options, ...withDefault }),
    definition("multi-select", {
      options,
      ...bounds(selections),
      ...withDefault,
    }),
    definition("checkbox", withDefault),
    definition("person", {}),
    definition("org-unit", {}),
    definition("url", withDefault),
    definition("email", withDefault),
    definition("phone", withDefault),
    definition("file", {}),
    definition("lookup", { target: z.enum(CONFIGURABLE_KINDS) }),
  ]);
}
const customFieldShape = definitions({});
export type CustomField = z.output<typeof customFieldShape>;

// Days (read as UTC midnight) and date-times compare as instants, every other bound as a number.
const instant = (bound: number | string) =>
  typeof bound === "number" ? bound : Date.parse(bound);
const within = (
  { min, max }: { min?: number | string; max?: number | string },
  value: number | string,
) =>
  (min === undefined || instant(value) >= instant(min)) &&
  (max === undefined || instant(value) <= instant(max));

// Each cross-attribute check runs only on a definition with no issue yet, so a refused pattern is
// never compiled or run against the default.
const noIssues = (payload: { issues: unknown[] }) =>
  payload.issues.length === 0;
const checked = <S extends z.ZodType<CustomField>>(schema: S) =>
  schema
    .refine(
      (field: CustomField) =>
        !("min" in field) ||
        field.min === undefined ||
        field.max === undefined ||
        instant(field.min) <= instant(field.max),
      {
        path: ["max"],
        message: "The maximum may not be below the minimum.",
        when: noIssues,
      },
    )
    .refine(
      (field: CustomField) =>
        !("default" in field) ||
        field.default === undefined ||
        fieldValueSchema(field).safeParse(field.default).success,
      {
        path: ["default"],
        message: "The default must be a valid value of the field.",
        when: noIssues,
      },
    );
/**
 * One custom field definition (architecture §1.5): a uuid key, a cleaned label and help, and only
 * the attributes its type lists. Its default must be a valid value of the field itself.
 */
export const customFieldSchema = checked(customFieldShape);
/**
 * A custom field as a kind schema holds it: its definition and the company owner's sensitive mark,
 * absent meaning false (R2b-09).
 */
export const kindSchemaCustomFieldSchema = checked(
  definitions({ sensitive: z.boolean().optional() }),
);

// One non-empty value of the field. Person, org unit, file and lookup check the shape only; their
// references (a file value is the id of a record file of the record) are checked by the records
// service.
function filledValue(field: CustomField): z.ZodType {
  switch (field.type) {
    case "short-text":
    case "long-text":
    case "rich-text": {
      // A failed length check stops the parse, so the pattern never runs on an over-long value.
      const text = z
        .string()
        .min(field.min ?? 0, { abort: true })
        .max(field.max ?? 4000, { abort: true });
      // Compiled once per definition, matched in full.
      return field.type === "short-text" && field.pattern !== undefined
        ? text.regex(new RegExp(`^(?:${field.pattern})$`, "u"))
        : text;
    }
    case "number":
    case "percentage":
      return z.number().refine((value) => within(field, value));
    case "money":
      return amountSchema.refine((value) => within(field, Number(value)));
    case "date":
      return daySchema.refine((value) => within(field, value));
    case "date-time":
      return dateTimeSchema.refine((value) => within(field, value));
    case "dropdown":
      return z.enum(field.options.map((option) => option.id));
    case "multi-select":
      return z
        .array(z.enum(field.options.map((option) => option.id)))
        .max(Math.min(field.max ?? 100, field.options.length))
        .refine(
          (ids) => new Set(ids).size === ids.length,
          "Each option may appear only once.",
        )
        .refine((ids) => ids.length === 0 || ids.length >= (field.min ?? 0));
    case "checkbox":
      return z.boolean();
    case "person":
      return z.string().min(1).max(128);
    case "org-unit":
    case "file":
    case "lookup":
      return uuidSchema;
    case "url":
      return z.url({ protocol: /^https?$/ }).max(2000);
    case "email":
      return z.email().max(320);
    case "phone":
      return phoneSchema;
  }
}
/**
 * The bounded schema of one value of a custom field. null and "" are empty for every type, and []
 * for a multi-select too; bounds apply only to a filled value. It never rewrites a value.
 */
export function fieldValueSchema(field: CustomField): z.ZodType {
  return z.union([z.null(), z.literal(""), filledValue(field)]);
}

export type CompiledKindSchema = Readonly<{
  versionId: string;
  /** One optional key per custom field of the body; any other key is refused. */
  customValues: z.ZodType<Record<string, unknown>>;
  /** Per screen key (screenKey), the mandatory keys of that screen (mandatoryKeys). */
  mandatory: Readonly<Record<string, readonly string[]>>;
  /**
   * The mandatory keys of the screen screenFor gives a record of `typeId` for `action`; none for a
   * transition without a screen.
   */
  mandatoryFor: (
    typeId: string | null,
    action: ScreenAction,
  ) => readonly string[];
  /** The keys of the archived custom fields, in body order. */
  archived: readonly string[];
}>;

/** The most compiled versions one instance keeps. */
export const KIND_SCHEMA_CACHE_SIZE = 512;
// A published version never changes, so an entry is never stale. Map order is use order: the least
// recently used entry goes first past the bound, and an evicted id is simply compiled again.
const compiled = new Map<string, CompiledKindSchema>();

/**
 * Compiles a kind schema version into its customValues validator and mandatory rules, once per
 * version id. The body is taken as already validated: it is not parsed again.
 */
export function compileKindSchema(version: {
  versionId: string;
  body: KindSchemaBody;
}): CompiledKindSchema {
  const cached = compiled.get(version.versionId);
  if (cached) {
    compiled.delete(version.versionId);
    compiled.set(version.versionId, cached);
    return cached;
  }
  const { fields, screens } = version.body;
  const archived = fields.flatMap((field) =>
    !field.system && field.archived ? [field.key] : [],
  );
  const mandatory: Readonly<Record<string, readonly string[]>> = Object.freeze(
    Object.fromEntries(
      screens.map((screen) => [
        screenKey(screen),
        Object.freeze(mandatoryKeys(version.body, screen)),
      ]),
    ),
  );
  const none: readonly string[] = Object.freeze([]);
  const result: CompiledKindSchema = Object.freeze({
    versionId: version.versionId,
    customValues: z
      .object(
        Object.fromEntries(
          fields.flatMap((field) =>
            field.system
              ? []
              : [[field.key, fieldValueSchema(field).optional()]],
          ),
        ),
      )
      .strict(),
    mandatory,
    mandatoryFor: (typeId, action) => {
      const screen = screenFor(version.body, typeId, action);
      return screen ? mandatory[screenKey(screen)] : none;
    },
    archived: Object.freeze(archived),
  });
  compiled.set(version.versionId, result);
  for (const id of compiled.keys()) {
    if (compiled.size <= KIND_SCHEMA_CACHE_SIZE) break;
    compiled.delete(id);
  }
  return result;
}
