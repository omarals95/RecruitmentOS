import { DrizzleQueryError, inArray, sql } from "drizzle-orm";
import { getIdentityDb } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import { member } from "@/db/auth-schema";
import { ApiError } from "./errors";
import type { Principal } from "./principal";
import { assertTenantContextKey, installTenantContext } from "./tenant-context";

const ownerRequired = () =>
  new ApiError(
    403,
    "owner_required",
    "Only a team owner can reset another member's two-step sign-in.",
  );

// Removing a second factor in a team the actor does not own would bypass that team's owners.
const memberInOtherTeam = () =>
  new ApiError(
    409,
    "member_in_other_team",
    "This member also belongs to a team you do not own, so you cannot reset their two-step sign-in. They can use a backup code, or the RecruitmentOS owner can reset it.",
  );

/**
 * An owner of the active team, who also owns every other team the member belongs to, resets the
 * member's two-step sign-in. The owner-run helper deletes the member's secret, backup codes,
 * sessions and trusted devices and writes the audit row in this identity transaction, under a
 * verified session context.
 */
export async function resetMemberTwoStep(
  p: Principal,
  targetUserId: string,
): Promise<void> {
  if (p.authType !== "session")
    throw new ApiError(
      403,
      "session_required",
      "Sign in to manage accounts, teams and API tokens.",
    );
  assertTenantContextKey();
  const db = await getIdentityDb();
  await withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
    // Both people's memberships in every team: the reset is account-wide.
    const rows = await tx
      .select({
        userId: member.userId,
        teamId: member.organizationId,
        role: member.role,
      })
      .from(member)
      .where(inArray(member.userId, [p.userId, targetUserId]));
    const owned = new Set(
      rows
        .filter((row) => row.userId === p.userId && row.role === "owner")
        .map((row) => row.teamId),
    );
    if (!owned.has(p.teamId)) throw ownerRequired();
    if (targetUserId === p.userId)
      throw new ApiError(
        400,
        "cannot_reset_self",
        "You cannot reset your own two-step sign-in. Use a backup code, or turn it off in your profile.",
      );
    const targetTeams = rows
      .filter((row) => row.userId === targetUserId)
      .map((row) => row.teamId);
    if (!targetTeams.includes(p.teamId))
      throw new ApiError(
        404,
        "member_not_found",
        "That person is not a member of this team.",
      );
    if (targetTeams.some((teamId) => !owned.has(teamId)))
      throw memberInOtherTeam();
    await installTenantContext(tx, p, snapshot);
    try {
      await tx.execute(
        sql`select tenant_context.reset_two_step(${targetUserId})`,
      );
    } catch (error) {
      const code = (
        (error instanceof DrizzleQueryError ? error.cause : error) as
          { code?: unknown } | undefined
      )?.code;
      if (code === "RQ003")
        throw new ApiError(
          409,
          "two_step_not_enabled",
          "This member has not set up two-step sign-in, so there is nothing to reset.",
        );
      if (code === "RQ004") throw memberInOtherTeam();
      if (code === "42501") throw ownerRequired();
      throw error;
    }
  });
}
