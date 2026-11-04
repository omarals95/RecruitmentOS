import { getDb, type TeamTx } from "@/db";
import type { Principal } from "./principal";
import { assertTenantContextKey, installTenantContext } from "./tenant-context";
export async function withTeam<T>(
  principal: Principal,
  work: (tx: TeamTx) => Promise<T>,
): Promise<T> {
  assertTenantContextKey();
  const db = await getDb();
  return db.transaction(async (tx) => {
    // The signed context is installed first, before any savepoint can exist.
    await installTenantContext(tx, principal);
    return work(tx);
  });
}
