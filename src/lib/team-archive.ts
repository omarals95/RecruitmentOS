import { DrizzleQueryError, sql } from "drizzle-orm";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import type { Principal } from "@/lib/principal";

const forbidden = () =>
  new ApiError(
    403,
    "team_archive_forbidden",
    "Only an owner of this team can archive or restore it.",
  );

/**
 * Archives or restores the principal's team through the owner-run helper, which rechecks that the
 * session is an owner of that team, locks its row and writes one audit row per change. Nothing is
 * deleted; changed is false when the team already was in that state.
 */
export async function setTeamArchived(
  p: Principal,
  archived: boolean,
): Promise<{ archived: boolean; changed: boolean }> {
  if (p.authType !== "session" || p.role !== "owner") throw forbidden();
  const changed = await withTeam(p, async (tx) => {
    try {
      const { rows } = await tx.execute<{ changed: boolean }>(
        sql`select tenant_context.set_team_archived(${p.teamId}, ${archived}::boolean) as changed`,
      );
      return rows[0].changed;
    } catch (error) {
      const cause = error instanceof DrizzleQueryError ? error.cause : error;
      if ((cause as { code?: unknown } | undefined)?.code === "42501")
        throw forbidden();
      throw error;
    }
  });
  return { archived, changed };
}

/** The ids of the archived teams the signed-in caller is a member of, from the read helper. */
export async function memberArchivedTeams(p: Principal): Promise<string[]> {
  return withTeam(p, async (tx) =>
    (
      await tx.execute<{ team_id: string }>(
        sql`select team_id from tenant_context.member_archived_teams()`,
      )
    ).rows.map((row) => row.team_id),
  );
}
