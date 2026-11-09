import { getDb, type TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import {
  markRoleUnavailable,
  passedScopes,
  requireScope,
  type Scope,
} from "./permissions";
import type { Principal } from "./principal";
import {
  assertTenantContextKey,
  installTenantContext,
  type TenantAccess,
} from "./tenant-context";

/**
 * Binds the principal to the scopes install stored, which a configured role may have narrowed: a
 * scope already checked with requireScope that was not stored refuses the request with today's
 * scope_required, and every later check of this request sees only stored scopes. Without a role
 * row, and for tokens, the stored scopes equal the asserted ones and nothing changes.
 */
function narrowToStored(principal: Principal, stored: readonly Scope[]) {
  if (principal.scopes.some((scope) => !stored.includes(scope)))
    principal.scopes = principal.scopes.filter((scope) =>
      stored.includes(scope),
    );
  for (const scope of passedScopes(principal)) requireScope(principal, scope);
}

export async function withTeam<T>(
  principal: Principal,
  work: (tx: TeamTx, access: TenantAccess) => Promise<T>,
): Promise<T> {
  assertTenantContextKey();
  const db = await getDb();
  return withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
    // The first statement set the deadlines and read the snapshot; the signed context is installed
    // next, before any other statement or savepoint, and returns the access state in that round trip.
    const access = await installTenantContext(tx, principal, snapshot);
    // An assigned role install could not use: every scope refusal says so in plain words.
    if (access.roleVersionId === null) markRoleUnavailable(principal);
    narrowToStored(principal, access.scopes);
    return work(tx, access);
  });
}
