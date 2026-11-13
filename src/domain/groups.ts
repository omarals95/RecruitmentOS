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
/**
 * What replaces an archived group in each parent group that uses it: another group, or null to
 * remove it from that parent.
 */
export const groupReplacements = z
  .array(
    z
      .object({
        parentGroupId: z.uuid(),
        replacementGroupId: z.uuid().nullable(),
      })
      .strict(),
  )
  .max(200);
/** One change per request: a rename (with an optional description) or an archive. */
export const groupPatch = z.union([
  groupInput,
  z
    .object({
      archived: z.literal(true),
      replacements: groupReplacements.optional(),
    })
    .strict(),
]);
/** One direct member: a person of a team of the workspace, or a child group. */
export const groupMember = z.union([
  z.object({ userId: z.string().min(1).max(128) }).strict(),
  z.object({ childGroupId: z.uuid() }).strict(),
]);
/** A person by user id: a delegated manager, or a member a manager removes. */
export const groupPerson = z
  .object({ userId: z.string().min(1).max(128) })
  .strict();
/** A person a manager adds by the email of their account, matched ignoring case. */
export const managedMemberEmail = z
  .object({ email: z.string().trim().min(1).max(254) })
  .strict();
/** company-owners, company-admins, all-members, team-owners:<team id> or team-admins:<team id>. */
export const computedGroupKey = z.string().min(1).max(200);
