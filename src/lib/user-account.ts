import { DrizzleQueryError, eq, sql } from "drizzle-orm";
import { getIdentityDb, type AppDb, type TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import { apiRateLimits, member, user } from "@/db/auth-schema";
import { peopleForbidden, userNotFound, withPeopleArea } from "./admin-users";
import { accessContext, authorize } from "./authz";
import { signInBackoffKey } from "./client-ip";
import { ApiError } from "./errors";
import { parseRole } from "./permissions";
import type { Principal } from "./principal";
import { assertTenantContextKey, installTenantContext } from "./tenant-context";

export const cannotChangeSelf = () =>
  new ApiError(
    400,
    "cannot_change_self",
    "You cannot change your own account here.",
  );

/**
 * The owner-run helpers' refusals once the service has allowed the caller: their 42501 means the
 * target holds company authority and the caller is not a company owner (or lost their authority
 * meanwhile). Anything else is rethrown.
 */
export function userAccountError(error: unknown): unknown {
  const code = (
    (error instanceof DrizzleQueryError ? error.cause : error) as
      { code?: unknown } | undefined
  )?.code;
  if (code === "42501")
    return new ApiError(
      403,
      "company_owner_required",
      "Only a company owner can change a company owner or admin.",
    );
  if (code === "RQ006") return userNotFound();
  if (code === "RQ005")
    return new ApiError(
      409,
      "last_company_owner",
      "The last active company owner cannot be deactivated. Make someone else a company owner first.",
    );
  if (code === "RQ018") return cannotChangeSelf();
  if (code === "22023")
    return new ApiError(400, "invalid_input", "Check the supplied fields.");
  return error;
}

/** Sessions only, never the caller's own account: refused before any database call. */
function refuseBeforeDatabase(p: Principal, userId: string) {
  if (p.authType !== "session") throw peopleForbidden();
  if (userId === p.userId) throw cannotChangeSelf();
}

/**
 * Deactivates (active false) or reactivates a person for the whole workspace through the owner-run
 * helper, in one withTeam of a company owner or company admin with the people area. The helper
 * rechecks who may change whom, refuses the last active company owner and writes one audit row per
 * change; changed is false when the person already was in that state.
 */
export async function setUserActive(
  p: Principal,
  userId: string,
  active: boolean,
): Promise<{ active: boolean; changed: boolean }> {
  refuseBeforeDatabase(p, userId);
  const changed = await withPeopleArea(p, async (tx) => {
    try {
      const { rows } = await tx.execute<{ changed: boolean }>(
        sql`select tenant_context.set_user_active(${userId}::text, ${active}::boolean) as changed`,
      );
      return rows[0].changed;
    } catch (error) {
      throw userAccountError(error);
    }
  });
  return { active, changed };
}

/**
 * One identity transaction under the caller's verified session context, as resetMemberTwoStep:
 * the people area check, then the owner-run helper and anything else work does.
 */
async function withIdentityPeopleArea(
  p: Principal,
  work: (tx: TeamTx) => Promise<void>,
): Promise<void> {
  assertTenantContextKey();
  const db = await getIdentityDb();
  await withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
    const access = await installTenantContext(tx, p, snapshot);
    try {
      authorize(accessContext(p, access), {
        adminArea: "people",
        action: "view",
      });
    } catch (error) {
      if (error instanceof ApiError) throw peopleForbidden();
      throw error;
    }
    try {
      await work(tx);
    } catch (error) {
      throw userAccountError(error);
    }
  });
}

/** Ends every Better Auth session of the person; the helper writes the audit row. */
export async function signOutEverywhere(
  p: Principal,
  userId: string,
): Promise<{ signedOut: true }> {
  refuseBeforeDatabase(p, userId);
  await withIdentityPeopleArea(p, async (tx) => {
    await tx.execute(
      sql`select tenant_context.user_account_action(${userId}::text, 'sign_out')`,
    );
  });
  return { signedOut: true };
}

/**
 * Clears the person's per-email sign-in backoff: the helper writes the audit row, then the keyed
 * backoff row of their email, which the database cannot derive, is deleted in the same transaction.
 */
export async function clearSignInLockout(
  p: Principal,
  userId: string,
): Promise<{ cleared: true }> {
  refuseBeforeDatabase(p, userId);
  await withIdentityPeopleArea(p, async (tx) => {
    await tx.execute(
      sql`select tenant_context.user_account_action(${userId}::text, 'clear_lockout')`,
    );
    const [target] = await tx
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId));
    await tx
      .delete(apiRateLimits)
      .where(
        eq(
          apiRateLimits.key,
          signInBackoffKey(target.email, process.env.BETTER_AUTH_SECRET!),
        ),
      );
  });
  return { cleared: true };
}

/**
 * Whether the user is deactivated, for the sign-in check: the identity role cannot read
 * app.workspace_users, so tenant_context.install is asked for a session context in one of their
 * teams, in one transaction on db, the identity pool (one workspace per environment, so any team
 * gives the same answer). Only its account_deactivated refusal means deactivated; any other error
 * propagates, so the request fails closed. A user with no membership is not checked.
 */
export async function accountDeactivated(
  db: AppDb,
  userId: string,
): Promise<boolean> {
  const [membership] = await db
    .select({ teamId: member.organizationId, role: member.role })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);
  if (!membership) return false;
  const principal: Principal = {
    userId,
    teamId: membership.teamId,
    role: parseRole(membership.role),
    scopes: [],
    authType: "session",
  };
  try {
    await withDeadlinesAndSnapshot(db, (tx, snapshot) =>
      installTenantContext(tx, principal, snapshot),
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "account_deactivated")
      return true;
    throw error;
  }
  return false;
}
