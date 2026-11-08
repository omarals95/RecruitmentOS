import { z } from "zod";
import { cleanClientName } from "../lib/client-name";

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
export const configBodySchemas = {
  "kind-schema": envelope,
  workflow: envelope,
  board: envelope,
  role: envelope,
  template: envelope,
  "task-board": envelope,
} satisfies Record<ConfigType, z.ZodType>;
export type ConfigBody = z.infer<(typeof configBodySchemas)[ConfigType]>;
