import { DrizzleQueryError, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { storageUsage } from "@/db/schema";
import type { TeamTx } from "@/db";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";

/**
 * Both storage limits are off (null) or both set; a null rate turns the upload rate limit off.
 * mcpCvTextEnabled is whether connected AI apps can read CV contents over MCP.
 */
export const storageSettingsSchema = z
  .object({
    maxBytes: z
      .number()
      .int()
      .min(1_000_000)
      .max(10_000_000_000_000)
      .nullable(),
    maxFiles: z.number().int().min(1).max(1_000_000).nullable(),
    uploadRequestsPerMinute: z.number().int().min(1).max(600).nullable(),
    mcpCvTextEnabled: z.boolean(),
  })
  .strict()
  .refine((input) => (input.maxBytes === null) === (input.maxFiles === null), {
    message: "Set both storage limits or turn both off.",
    path: ["maxFiles"],
  });
export type StorageSettingsInput = z.infer<typeof storageSettingsSchema>;

const forbidden = () =>
  new ApiError(
    403,
    "storage_settings_forbidden",
    "Only team owners and admins can view or change CV storage settings.",
  );
function requireAdmin(p: Principal) {
  if (p.role !== "owner" && p.role !== "admin") throw forbidden();
}

/**
 * The team's limits, CV text setting and current charges; a team that never reserved storage reads
 * as zero, with the setting on.
 */
async function readSettings(tx: TeamTx, p: Principal) {
  const [row] = await tx
    .select()
    .from(storageUsage)
    .where(eq(storageUsage.teamId, p.teamId));
  return {
    maxBytes: row?.maxBytes ?? null,
    maxFiles: row?.maxFiles ?? null,
    uploadRequestsPerMinute: row?.uploadRequestsPerMinute ?? null,
    mcpCvTextEnabled: row?.mcpCvTextEnabled ?? true,
    usage: {
      usedBytes: row?.usedBytes ?? 0,
      usedFiles: row?.usedFiles ?? 0,
      reservedBytes: row?.reservedBytes ?? 0,
      reservedFiles: row?.reservedFiles ?? 0,
      retainedBytes: row?.retainedBytes ?? 0,
      retainedFiles: row?.retainedFiles ?? 0,
    },
  };
}

export async function getStorageSettings(p: Principal) {
  requireAdmin(p);
  return withTeam(p, (tx) => readSettings(tx, p));
}

/**
 * The owner-run helpers recheck the owner or admin membership and each write their own audit row
 * only when their own value changed. A limit below current usage is accepted: new reservations are
 * then refused.
 */
export async function updateStorageSettings(
  p: Principal,
  input: StorageSettingsInput,
) {
  requireAdmin(p);
  return withTeam(p, async (tx) => {
    try {
      await tx.execute(
        sql`select tenant_context.set_storage_limits(${input.maxBytes}::bigint, ${input.maxFiles}::integer, ${input.uploadRequestsPerMinute}::integer)`,
      );
      await tx.execute(
        sql`select tenant_context.set_mcp_cv_text_access(${input.mcpCvTextEnabled}::boolean)`,
      );
    } catch (error) {
      const cause = error instanceof DrizzleQueryError ? error.cause : error;
      if ((cause as { code?: unknown } | undefined)?.code === "42501")
        throw forbidden();
      throw error;
    }
    return readSettings(tx, p);
  });
}
