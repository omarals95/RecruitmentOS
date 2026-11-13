import { z } from "zod";
import { configLabel } from "./config";

// Organisation levels and units (drizzle/0033_org_levels_units.sql). Names and codes are text
// facts under the configuration label rule; strict objects refuse unknown keys.
export const orgLevelInput = z
  .object({ name: configLabel, depth: z.number().int().min(0).max(7) })
  .strict();
export const orgUnitInput = z
  .object({
    name: configLabel,
    code: configLabel,
    levelId: z.uuid(),
    parentId: z.uuid().nullable().optional(),
  })
  .strict();
export const orgRename = z.object({ name: configLabel }).strict();
export const orgMove = z.object({ parentId: z.uuid().nullable() }).strict();
export const orgArchive = z.object({ archived: z.literal(true) }).strict();
/** One operation per request: a rename, a move (null for top level) or an archive. */
export const orgUnitPatch = z.union([orgRename, orgMove, orgArchive]);
export const orgLevelPatch = z.union([orgRename, orgArchive]);
export const orgUnitListQuery = z
  .object({
    parentId: z.uuid().optional(),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
/** The content type of the raw .xlsx body the organisation import routes accept (R2a-17). */
export const XLSX_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
