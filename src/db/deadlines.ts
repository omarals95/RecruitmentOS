import { sql } from "drizzle-orm";
import type { AppDb, TeamTx } from "./index";

/** Per-transaction database deadlines (SRS-NFR-05); placeholders until D-12 approves targets. */
export const STATEMENT_TIMEOUT_MS = 10_000;
export const TRANSACTION_TIMEOUT_MS = 20_000;
/**
 * SET LOCAL in one statement. A transaction pooler drops startup parameters, so the deadlines live
 * only inside each transaction and reset at COMMIT or ROLLBACK; no pooled backend keeps them.
 */
export const DEADLINES_SQL = `select set_config('statement_timeout', '${STATEMENT_TIMEOUT_MS}', true), set_config('transaction_timeout', '${TRANSACTION_TIMEOUT_MS}', true)`;

/** Every application transaction opens here, with the deadlines as its first statement. */
export function withDeadlines<T>(
  db: AppDb,
  work: (tx: TeamTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(DEADLINES_SQL));
    return work(tx);
  });
}
