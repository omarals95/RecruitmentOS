import { cache } from "react";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { publicBrandingSchema, type PublicBranding } from "@/domain/branding";
import { BRANDING_KEY } from "@/domain/config";
import { createConfigDraft, mayWriteConfig } from "@/lib/config-store";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";

/**
 * Starts a new branding draft from a published or retired version of the company's branding: the
 * body is read under the caller's context and write authority, then createConfigDraft writes and
 * audits the draft (409 config_draft_exists when one exists). Publishing it is a normal publish,
 * with the contrast check, and takes the next number.
 */
export async function revertBranding(
  p: Principal,
  versionId: string,
): Promise<{ objectId: string; versionId: string }> {
  const id = z.uuid().parse(versionId);
  const body = await withTeam(p, async (tx, access) => {
    if (!mayWriteConfig(p, access, "branding"))
      throw new ApiError(
        403,
        "config_forbidden",
        "You do not have company authority to change this configuration.",
      );
    const { rows } = await tx.execute<{ body: unknown }>(
      sql`select v.body from app.config_versions v join app.config_objects o on o.id = v.object_id where v.id = ${id}::uuid and v.state in ('published', 'retired') and o.workspace_id = ${access.workspaceId}::uuid and o.team_id is null and o.type = 'branding' and o.key = ${BRANDING_KEY}`,
    );
    if (!rows[0])
      throw new ApiError(404, "not_found", "Configuration not found.");
    return rows[0].body;
  });
  return createConfigDraft(p, { type: "branding", key: BRANDING_KEY, body });
}

/** One safe line: the error class and SQLSTATE only, never a token, text or row. */
function logReadFailure(error: unknown) {
  const cause =
    (error as { cause?: { code?: unknown } } | null)?.cause ??
    (error as { code?: unknown } | null);
  const code = cause?.code;
  const sqlState =
    typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
      ? ` sqlstate=${code}`
      : "";
  const category =
    (error as { constructor?: { name?: string } } | null)?.constructor?.name ||
    typeof error;
  console.error(`branding_read_failed category=${category}${sqlState}`);
}

/**
 * The public token set of the published branding, read once per request with no tenant context
 * through tenant_context.public_branding(), or null when none is published. A failed read or parse
 * is logged and reads as null, so branding never fails a page.
 */
export const publicBranding = cache(
  async (): Promise<PublicBranding | null> => {
    try {
      const db = await getDb();
      const { rows } = await db.execute<{ branding: unknown }>(
        sql`select tenant_context.public_branding() as branding`,
      );
      const branding = rows[0]?.branding ?? null;
      return branding === null ? null : publicBrandingSchema.parse(branding);
    } catch (error) {
      logReadFailure(error);
      return null;
    }
  },
);
