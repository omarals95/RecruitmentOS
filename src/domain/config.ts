import { z } from "zod";
import { cleanClientName } from "../lib/client-name";
import { SCOPES, roleScopes, type Role } from "../lib/permissions";
import { recordDataSchemas, uuidSchema } from "./record-schemas";
import type { FieldType, RecordKind, ResourceName } from "./records";

/** The object types of the versioned configuration store (drizzle/0030_config_store.sql). */
export const CONFIG_TYPES = [
  "kind-schema",
  "workflow",
  "board",
  "role",
  "template",
  "task-board",
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
} as const satisfies Record<ConfigType, string>;

export const configKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

// Invisible, control, format and bidi characters are removed first, then the length is checked.
const cleanText = (min: number, max: number) =>
  z.string().overwrite(cleanClientName).min(min).max(max);
export const configLabel = cleanText(1, 120);
export const configHelpText = cleanText(0, 500);
export const configOptionValue = cleanText(1, 200);

// The minimal envelope for every type until its own build item replaces it. Strict objects refuse
// unknown keys, so a body cannot carry record ids or record values.
const envelope = z
  .object({ label: configLabel, help: configHelpText.optional() })
  .strict();

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
] as const satisfies readonly RecordKind[];
export type ConfigurableKind = (typeof CONFIGURABLE_KINDS)[number];
export const SCREEN_ACTIONS = ["create", "edit", "view"] as const;

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
    fields: z.array(kindSchemaField).min(1).max(150),
    screens: z
      .array(
        z
          .object({
            action: z.enum(SCREEN_ACTIONS),
            fields: z.array(z.string()).min(1).max(150),
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
  body.fields.forEach((field, index) => {
    if (!Object.hasOwn(recordDataSchemas[body.kind].shape, field.key))
      issue(["fields", index, "key"], `Not a field of ${body.kind}.`);
    else if (keys.has(field.key))
      issue(["fields", index, "key"], "Field keys must be unique.");
    keys.add(field.key);
    if ((field.type === "select") !== (field.options !== undefined))
      issue(
        ["fields", index, "options"],
        "Dropdown fields need options, and only dropdown fields have them.",
      );
  });
  const actions = new Set<string>();
  body.screens.forEach((screen, index) => {
    if (actions.has(screen.action))
      issue(["screens", index, "action"], "Screen actions must be unique.");
    actions.add(screen.action);
    const listed = new Set<string>();
    screen.fields.forEach((key, position) => {
      if (!keys.has(key))
        issue(["screens", index, "fields", position], "Not a schema field.");
      else if (listed.has(key))
        issue(["screens", index, "fields", position], "Listed twice.");
      listed.add(key);
    });
  });
}
/**
 * A kind schema (architecture §1.4): the kind's system fields and one screen per action. Strict on
 * every level, so a body cannot carry record ids, record values or default values.
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

/** Company areas a company owner may grant to a company admin (drizzle/0028). */
export const GRANTABLE_ADMIN_AREAS = [
  "fields",
  "workflows",
  "boards",
  "organisation",
  "templates",
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
    return "Plan access is a per-person company grant, never part of a role.";
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

// Role drafts carry real role bodies; every other type keeps the envelope until its own item.
export const configBodySchemas = {
  "kind-schema": envelope,
  workflow: envelope,
  board: envelope,
  role: roleBodySchema,
  template: envelope,
  "task-board": envelope,
} satisfies Record<ConfigType, z.ZodType>;
export type ConfigBody = z.infer<(typeof configBodySchemas)[ConfigType]>;
