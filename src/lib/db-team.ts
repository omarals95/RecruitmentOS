import { sql } from "drizzle-orm";
import { getDb, type TeamTx } from "@/db";
import type { Principal } from "./principal";
export async function withTeam<T>(
  principal: Pick<Principal, "teamId" | "userId">,
  work: (tx: TeamTx) => Promise<T>,
): Promise<T> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.team_id',${principal.teamId},true),set_config('app.user_id',${principal.userId},true)`,
    );
    return work(tx);
  });
}
