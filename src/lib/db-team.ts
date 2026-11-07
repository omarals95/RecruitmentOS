import { getDb, type TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import type { Principal } from "./principal";
import { assertTenantContextKey, installTenantContext } from "./tenant-context";
export async function withTeam<T>(
  principal: Principal,
  work: (tx: TeamTx) => Promise<T>,
): Promise<T> {
  assertTenantContextKey();
  const db = await getDb();
  return withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
    // The first statement set the deadlines and read the snapshot; the signed context is installed
    // next, before any other statement or savepoint.
    await installTenantContext(tx, principal, snapshot);
    return work(tx);
  });
}
