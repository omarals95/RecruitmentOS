import { getDb, type TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import type { Principal } from "./principal";
import {
  assertTenantContextKey,
  installTenantContext,
  type TenantAccess,
} from "./tenant-context";
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
    return work(tx, access);
  });
}
