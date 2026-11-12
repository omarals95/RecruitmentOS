import { z } from "zod";
import { SCOPES, roleScopes, type Role } from "../lib/permissions";
import { brandingBodySchema } from "./branding";
import {
  CONFIGURABLE_KINDS,
  configHelpText,
  configLabel,
  configOptionValue,
  kindSchemaCustomFieldSchema,
} from "./field-types";
import {
  SENSITIVE_CANDIDATE_FIELDS,
  configKey,
  recordDataSchemas,
  uuidSchema,
} from "./record-schemas";
import type { FieldType, RecordKind, ResourceName } from "./records";
import { screenKey } from "./screens";
import { systemFieldConfig } from "./system-fields";

// The cleaned text schemas and the kind list live in field-types.ts, and the key schema in
// record-schemas.ts, neither of which can import this file.
export {
  CONFIGURABLE_KINDS,
  configHelpText,
  configKey,
  configLabel,
  configOptionValue,
};

/** The object types of the versioned configuration store (drizzle/0030_config_store.sql). */
export const CONFIG_TYPES = [
  "kind-schema",
  "workflow",
  "board",
  "role",
  "template",
  "task-board",
  "job-architecture",
  "branding",
] as const;
export type ConfigType = (typeof CONFIG_TYPES)[number];

/**
 * The company authority area each type is written under. Roles need a company owner; a task board
 * is written by its own team's owners and admins, never by company authority.
 */
export const CONFIG_TYPE_AREAS = {
  "kind-schema": "fields",
  workflow: "workflows",
  board: "boards",
  role: "roles",
  template: "templates",
  "task-board": "task-board",
  "job-architecture": "organisation",
  branding: "branding",
} as const satisfies Record<ConfigType, string>;

/** The one job architecture object of a company is always this key (ADM-24). */
export const JOB_ARCHITECTURE_KEY = "company";
/** The one branding object of a company is always this key (ADM-36). */
export const BRANDING_KEY = "company";

// The minimal envelope for every type until its own build item replaces it. Strict objects refuse
// unknown keys, so a body cannot carry record ids or record values.
const envelope = z
  .object({ label: configLabel, help: configHelpText.optional() })
  .strict();

export type ConfigurableKind = (typeof CONFIGURABLE_KINDS)[number];
export const SCREEN_ACTIONS = ["create", "edit", "view", "transition"] as const;
/** The actions every kind schema has a default (untyped) screen for; transition is optional. */
const DEFAULT_SCREEN_ACTIONS = ["create", "edit", "view"] as const;
/** Most fields one screen lists across its groups, as many as a body holds. */
const SCREEN_ENTRIES_MAX = 150;

// Keyed by FieldType, so the list can neither miss nor add a type.
const fieldTypes = {
  text: true,
  textarea: true,
  number: true,
  date: true,
  "datetime-local": true,
  select: true,
  tags: true,
  checkbox: true,
  json: true,
} satisfies Record<FieldType, true>;
const kindSchemaField = z
  .object({
    key: z.string(),
    system: z.literal(true),
    label: configLabel,
    help: configHelpText.optional(),
    type: z.enum(Object.keys(fieldTypes) as [FieldType, ...FieldType[]]),
    options: z
      .array(configOptionValue)
      .min(1)
      .max(100)
      .refine(
        (options) => new Set(options).size === options.length,
        "Options must be unique.",
      )
      .optional(),
    required: z.boolean(),
    readOnly: z.boolean(),
    sensitive: z.boolean(),
  })
  .strict();
const kindSchemaShape = z
  .object({
    kind: z.enum(CONFIGURABLE_KINDS),
    label: configLabel,
    singular: configLabel,
    fields: z
      .array(
        z.discriminatedUnion("system", [
          kindSchemaField,
          kindSchemaCustomFieldSchema,
        ]),
      )
      .min(1)
      .max(150),
    // A screen's key is the body's kind, its type (absent: the default screen) and its action.
    screens: z
      .array(
        z
          .object({
            type: uuidSchema.optional(),
            action: z.enum(SCREEN_ACTIONS),
            groups: z
              .array(
                z
                  .object({
                    label: configLabel.optional(),
                    fields: z
                      .array(
                        // Absent flags mean false, like archived on a custom field.
                        z
                          .object({
                            key: z.string(),
                            hidden: z.boolean().optional(),
                            mandatory: z.boolean().optional(),
                          })
                          .strict(),
                      )
                      .min(1)
                      .max(SCREEN_ENTRIES_MAX),
                  })
                  .strict(),
              )
              .min(1)
              .max(20),
          })
          .strict(),
      )
      .min(1)
      .max(40),
  })
  .strict();
function kindSchemaIssues(
  body: z.output<typeof kindSchemaShape>,
  ctx: z.RefinementCtx,
) {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  const keys = new Set<string>();
  const required = new Set<string>();
  body.fields.forEach((field, index) => {
    if (
      field.system &&
      !Object.hasOwn(recordDataSchemas[body.kind].shape, field.key)
    )
      issue(["fields", index, "key"], `Not a field of ${body.kind}.`);
    else if (keys.has(field.key))
      issue(["fields", index, "key"], "Field keys must be unique.");
    else if (field.system) {
      // Configuration only tightens a system field (§1.5 item 3): relabel it, require it or make
      // it read-only, never change its type or options or loosen it. The sensitive candidate
      // fields stay sensitive (D14).
      const builtIn = systemFieldConfig(body.kind, field.key);
      if (field.type !== builtIn.type)
        issue(["fields", index, "type"], "A system field keeps its type.");
      if (
        field.options !== undefined &&
        builtIn.options !== undefined &&
        (field.options.length !== builtIn.options.length ||
          field.options.some((option, at) => option !== builtIn.options![at]))
      )
        issue(
          ["fields", index, "options"],
          "A system field keeps its options.",
        );
      if (builtIn.required && !field.required)
        issue(
          ["fields", index, "required"],
          "A required field stays required.",
        );
      if (builtIn.readOnly && !field.readOnly)
        issue(
          ["fields", index, "readOnly"],
          "A read-only field stays read-only.",
        );
      if (
        body.kind === "candidate" &&
        (SENSITIVE_CANDIDATE_FIELDS as readonly string[]).includes(field.key) &&
        !field.sensitive
      )
        issue(
          ["fields", index, "sensitive"],
          "A sensitive field stays sensitive.",
        );
    }
    keys.add(field.key);
    if (field.system && field.required) required.add(field.key);
    if (
      field.system &&
      (field.type === "select") !== (field.options !== undefined)
    )
      issue(
        ["fields", index, "options"],
        "Dropdown fields need options, and only dropdown fields have them.",
      );
  });
  const screenKeys = new Set<string>();
  body.screens.forEach((screen, index) => {
    const key = screenKey(screen);
    if (screenKeys.has(key))
      issue(["screens", index, "action"], "One screen per type and action.");
    screenKeys.add(key);
    const listed = new Set<string>();
    screen.groups.forEach((group, groupIndex) =>
      group.fields.forEach((entry, position) => {
        const path = [
          "screens",
          index,
          "groups",
          groupIndex,
          "fields",
          position,
        ];
        if (!keys.has(entry.key))
          issue([...path, "key"], "Not a schema field.");
        else if (listed.has(entry.key))
          issue([...path, "key"], "Listed twice.");
        listed.add(entry.key);
        if (entry.hidden && entry.mandatory)
          issue(path, "A hidden field cannot be mandatory.");
        if (
          screen.action === "create" &&
          entry.hidden &&
          required.has(entry.key)
        )
          issue(
            [...path, "hidden"],
            "A create screen shows every required system field.",
          );
      }),
    );
    if (
      screen.groups.reduce((total, group) => total + group.fields.length, 0) >
      SCREEN_ENTRIES_MAX
    )
      issue(
        ["screens", index, "groups"],
        `A screen lists at most ${SCREEN_ENTRIES_MAX} fields.`,
      );
    if (screen.action === "create")
      for (const field of required)
        if (!listed.has(field))
          issue(
            ["screens", index, "groups"],
            `A create screen lists the required field ${field}.`,
          );
  });
  for (const action of DEFAULT_SCREEN_ACTIONS)
    if (!screenKeys.has(screenKey({ action })))
      issue(["screens"], `A default ${action} screen is required.`);
}
/**
 * A kind schema (architecture §1.4): the kind's system fields, its custom fields (field-types.ts)
 * and its screens per type and action, each of ordered groups of ordered fields with hidden and
 * mandatory flags. Strict on every level, so a body cannot carry record ids or record values; a
 * custom field may carry a default, but no reference type takes one.
 */
export const kindSchemaBodySchema =
  kindSchemaShape.superRefine(kindSchemaIssues);
export type KindSchemaBody = z.output<typeof kindSchemaBodySchema>;

/** The actions a role grants per resource (architecture §3.2). */
export const ACTIONS = [
  "view",
  "create",
  "edit",
  "transition",
  "archive",
  "export",
  "erase",
  "approve",
  "import",
  "comment",
  "share-view",
  "admin",
] as const;
export type Action = (typeof ACTIONS)[number];
/** Actions that only read; every other action is a write. */
export const READ_ACTIONS = ["view", "export"] as const;

/**
 * One key per screen. The caller's own private screens (My shortlist, notifications) are not page
 * keys: they keep today's per-user rules and no role can name them.
 */
export const PAGE_KEYS = [
  "home",
  "candidates",
  "vacancies",
  "job-roles",
  "applications",
  "tasks",
  "interviews",
  "offers",
  "onboarding",
  "analytics",
  "insights",
  "source-review",
  "activity",
  "settings",
  "approvals",
  "directory",
  "plan",
  "admin",
] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export const FIELD_RULES = [
  "hidden",
  "read",
  "edit",
  "hidden-unless-approver",
] as const;
export type FieldRule = (typeof FIELD_RULES)[number];

export const RECORD_SCOPES = ["all", "unit", "assigned"] as const;
export type RecordScope = (typeof RECORD_SCOPES)[number];

/** basic: name, position and unit; full: also work email and phone (architecture §6.3, D16). */
export const DIRECTORY_RULES = ["basic", "full"] as const;
export type DirectoryRule = (typeof DIRECTORY_RULES)[number];

/**
 * Company areas a company owner may grant to a company admin (drizzle/0028, people drizzle/0042,
 * branding drizzle/0053).
 */
export const GRANTABLE_ADMIN_AREAS = [
  "fields",
  "workflows",
  "boards",
  "organisation",
  "templates",
  "people",
  "branding",
] as const;
/** Company areas only a company owner holds, whatever companyAreas says. */
export const OWNER_ADMIN_AREAS = ["roles", "ai", "plan", "home-units"] as const;
export const ADMIN_AREAS = [
  ...GRANTABLE_ADMIN_AREAS,
  ...OWNER_ADMIN_AREAS,
] as const;
export type AdminArea = (typeof ADMIN_AREAS)[number];

/** Every record resource except private saved views, which no role can name. */
export const RECORD_RESOURCES = [
  "candidates",
  "job-roles",
  "vacancies",
  "applications",
  "buckets",
  "task-fields",
  "tasks",
  "interviews",
  "offers",
  "onboarding",
  "checklist",
  "comments",
] as const satisfies readonly Exclude<ResourceName, "views">[];
export const COMPANY_RESOURCES = ["directory", "plans"] as const;
/** Today's owner-only and owner-or-admin team rules, mirrored as the admin action. */
export const TEAM_ADMIN_RESOURCES = [
  "two-step-reset",
  "teams",
  "storage-settings",
] as const;
export const ACTION_RESOURCES = [
  ...RECORD_RESOURCES,
  ...COMPANY_RESOURCES,
  ...TEAM_ADMIN_RESOURCES,
] as const;
export type ActionResource = (typeof ACTION_RESOURCES)[number];

/** Record kinds a role can set field rules for; saved views are private and have none. */
export const FIELD_RULE_KINDS = Object.keys(recordDataSchemas).filter(
  (kind) => kind !== "saved-view",
) as Exclude<RecordKind, "saved-view">[];

const uniqueList = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .array(z.enum(values))
    .max(values.length * 4)
    .transform((list) => [...new Set(list)]);
/** Row keys outside data that a field rule of any kind may name; redact applies them to the row. */
export const TOP_LEVEL_FIELD_KEYS = [
  "importMeta",
  "legacyId",
  "label",
  "candidateLabel",
  "vacancyLabel",
] as const;
const fieldKey = (kind: RecordKind) =>
  z
    .string()
    .refine(
      (key) =>
        Object.hasOwn(recordDataSchemas[kind].shape, key) ||
        (TOP_LEVEL_FIELD_KEYS as readonly string[]).includes(key) ||
        uuidSchema.safeParse(key).success,
      `Not a field of ${kind}.`,
    );
const optionalShape = <K extends string, S extends z.ZodType>(
  keys: readonly K[],
  schema: (key: K) => S,
) =>
  Object.fromEntries(keys.map((key) => [key, schema(key).optional()])) as {
    [P in K]: z.ZodOptional<S>;
  };

type RoleGrants = {
  membership: Role;
  scopes: string[];
  actions: Partial<Record<ActionResource, Action[]>>;
};
/** Why a grant is outside the membership ceiling, or null when it is inside. */
function ceilingIssue(
  membership: Role,
  resource: ActionResource,
  action: Action,
): string | null {
  const ceiling = roleScopes(membership);
  const write = !(READ_ACTIONS as readonly string[]).includes(action);
  if (resource === "plans")
    return "Plan & pay access is a per-person company grant, never part of a role.";
  if (write && membership === "viewer")
    return "Viewer membership cannot hold a write action.";
  if (action === "import" && !ceiling.includes("imports:write"))
    return `${membership} membership cannot import.`;
  if (
    membership !== "owner" &&
    (action === "erase" ||
      (action === "admin" &&
        (resource === "two-step-reset" || resource === "teams")))
  )
    return "Only the Owner template holds this action.";
  if (
    action === "admin" &&
    resource === "storage-settings" &&
    membership !== "owner" &&
    membership !== "admin"
  )
    return "Only owner and admin membership manage storage settings.";
  if (resource === "directory" && write && !ceiling.includes("directory:write"))
    return `${membership} membership cannot change the directory.`;
  return null;
}
function insideCeiling(body: RoleGrants, ctx: z.RefinementCtx) {
  const ceiling = roleScopes(body.membership);
  body.scopes.forEach((scope, index) => {
    if (!(ceiling as string[]).includes(scope))
      ctx.addIssue({
        code: "custom",
        path: ["scopes", index],
        message: `${scope} is outside the ${body.membership} membership.`,
      });
  });
  for (const [resource, actions] of Object.entries(body.actions))
    for (const action of actions ?? []) {
      const issue = ceilingIssue(
        body.membership,
        resource as ActionResource,
        action,
      );
      if (issue)
        ctx.addIssue({
          code: "custom",
          path: ["actions", resource],
          message: issue,
        });
    }
}
// Strict on every level: candidate states, private saved views, notification reads, company areas
// and plan access have no key, so no role body can name them.
const roleBody = <M extends z.ZodType<Role>>(membership: M) =>
  z
    .object({
      name: configLabel,
      membership,
      scopes: uniqueList(SCOPES),
      pages: uniqueList(PAGE_KEYS),
      actions: z
        .object(optionalShape(ACTION_RESOURCES, () => uniqueList(ACTIONS)))
        .strict(),
      fields: z
        .object(
          optionalShape(FIELD_RULE_KINDS, (kind) =>
            z.record(fieldKey(kind), z.enum(FIELD_RULES)),
          ),
        )
        .strict(),
      recordScope: z
        .object({
          pipeline: z.enum(RECORD_SCOPES),
          candidates: z.enum(RECORD_SCOPES),
          tasks: z.enum(RECORD_SCOPES),
        })
        .strict(),
      /** The directory contact rule; absent means basic. */
      directoryRule: z.enum(DIRECTORY_RULES).optional(),
    })
    .strict()
    .superRefine((body, ctx) => insideCeiling(body as RoleGrants, ctx));
/** A configured role body; membership owner is reserved for the code-defined Owner template. */
export const roleBodySchema = roleBody(
  z.enum(["admin", "recruiter", "viewer"]),
);
const ownerTemplateSchema = roleBody(z.literal("owner"));
export type RoleBody = Omit<z.output<typeof roleBodySchema>, "membership"> & {
  membership: Role;
};
/** The Owner template's check, the same strict rules with membership owner; it yields no body. */
export function isOwnerTemplateBody(body: unknown): boolean {
  return ownerTemplateSchema.safeParse(body).success;
}

/**
 * A team's task board (architecture §10): its name, an ordered subset of the team's bucket ids as
 * columns and at most one filter. Unlike company bodies it holds ids of the team's own records, which
 * only that team can read (R2a-21). Strict on every level.
 */
export const taskBoardBodySchema = z
  .object({
    name: configLabel,
    columns: z
      .array(uuidSchema)
      .min(1)
      .max(100)
      .refine(
        (columns) => new Set(columns).size === columns.length,
        "A bucket can be a column only once.",
      ),
    filter: z
      .discriminatedUnion("by", [
        z.object({ by: z.literal("vacancy"), vacancyId: uuidSchema }).strict(),
        z
          .object({ by: z.literal("linked-record"), recordId: uuidSchema })
          .strict(),
        z
          .object({
            by: z.literal("field"),
            fieldId: uuidSchema,
            value: configOptionValue,
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
export type TaskBoardBody = z.output<typeof taskBoardBodySchema>;

/** A grade code such as G7: 1 to 20 upper-case letters, digits and hyphens. */
export const gradeCode = z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/);
const jobArchitectureShape = z
  .object({
    families: z
      .array(z.object({ key: configKey, name: configLabel }).strict())
      .max(200),
    grades: z
      .array(
        z
          .object({
            code: gradeCode,
            name: configLabel,
            order: z.number().int().min(1).max(1000),
          })
          .strict(),
      )
      .max(200),
    titles: z
      .array(
        z
          .object({
            key: configKey,
            name: configLabel,
            familyKey: configKey,
            gradeCode,
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();
function jobArchitectureIssues(
  body: z.output<typeof jobArchitectureShape>,
  ctx: z.RefinementCtx,
) {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  // Each list's values must be unique; the paths name the repeated entry.
  const unique = <T>(
    list: T[],
    value: (entry: T) => string | number,
    path: (index: number) => (string | number)[],
    message: string,
  ) => {
    const seen = new Set<string | number>();
    list.forEach((entry, index) => {
      if (seen.has(value(entry))) issue(path(index), message);
      seen.add(value(entry));
    });
    return seen;
  };
  const families = unique(
    body.families,
    (family) => family.key,
    (index) => ["families", index, "key"],
    "Family keys must be unique.",
  );
  const grades = unique(
    body.grades,
    (grade) => grade.code,
    (index) => ["grades", index, "code"],
    "Grade codes must be unique.",
  );
  unique(
    body.grades,
    (grade) => grade.order,
    (index) => ["grades", index, "order"],
    "Grade orders must be unique.",
  );
  unique(
    body.titles,
    (title) => title.key,
    (index) => ["titles", index, "key"],
    "Title keys must be unique.",
  );
  body.titles.forEach((title, index) => {
    if (!families.has(title.familyKey))
      issue(["titles", index, "familyKey"], "Not a family of this body.");
    if (!grades.has(title.gradeCode))
      issue(["titles", index, "gradeCode"], "Not a grade of this body.");
  });
}
/**
 * The company job architecture (architecture §14.5): job families, job grades and job titles, each
 * title in one family and one grade. Names, codes and order only: strict on every level, so a body
 * holds no pay figure, bracket, record id or record value.
 */
export const jobArchitectureBodySchema = jobArchitectureShape.superRefine(
  jobArchitectureIssues,
);
export type JobArchitectureBody = z.output<typeof jobArchitectureBodySchema>;

// Kind schema, role, task-board, job architecture and branding drafts carry real bodies; every other
// type keeps the envelope until its own item.
export const configBodySchemas = {
  "kind-schema": kindSchemaBodySchema,
  workflow: envelope,
  board: envelope,
  role: roleBodySchema,
  template: envelope,
  "task-board": taskBoardBodySchema,
  "job-architecture": jobArchitectureBodySchema,
  branding: brandingBodySchema,
} satisfies Record<ConfigType, z.ZodType>;
export type ConfigBody = z.infer<(typeof configBodySchemas)[ConfigType]>;
