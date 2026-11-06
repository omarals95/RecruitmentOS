import { getDb, type TeamTx } from "@/db";
import { withDeadlines } from "@/db/deadlines";
import type { Principal } from "./principal";
import { assertTenantContextKey, installTenantContext } from "./tenant-context";
export async function withTeam<T>(
  principal: Principal,
  work: (tx: TeamTx) => Promise<T>,
): Promise<T> {
  assertTenantContextKey();
  const db = await getDb();
  return withDeadlines(db, async (tx) => {
    // After the deadlines, the signed context is installed before any other statement or savepoint.
    await installTenantContext(tx, principal);
    return work(tx);
  });
}
