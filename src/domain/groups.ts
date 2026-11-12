import { z } from "zod";
import { configHelpText, configLabel } from "./config";

// Company groups (drizzle/0052_company_groups.sql). Names and descriptions are text facts under the
// configuration label and help text rules, an empty description is none; strict objects refuse
// unknown keys.
const description = configHelpText.transform((value) => value || null);
export const groupInput = z
  .object({ name: configLabel, description: description.optional() })
  .strict();
export const groupApproval = z.object({ approval: z.boolean() }).strict();
/** One change per request: a rename (with an optional description) or an archive. */
export const groupPatch = z.union([
  groupInput,
  z.object({ archived: z.literal(true) }).strict(),
]);
/** One direct member: a person of a team of the workspace, or a child group. */
export const groupMember = z.union([
  z.object({ userId: z.string().min(1).max(128) }).strict(),
  z.object({ childGroupId: z.uuid() }).strict(),
]);
/** company-owners, company-admins, all-members, team-owners:<team id> or team-admins:<team id>. */
export const computedGroupKey = z.string().min(1).max(200);
