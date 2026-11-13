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
/**
 * The same deadlines plus the backend, transaction, environment marker and clock that a signed
 * tenant context binds to, in one statement. Reading pg_current_xact_id() here assigns the xid the
 * rest of the transaction keeps, so the snapshot still matches when tenant_context.install checks it.
 */
export const DEADLINES_AND_SNAPSHOT_SQL = `select set_config('statement_timeout', '${STATEMENT_TIMEOUT_MS}', true) as statement_timeout, set_config('transaction_timeout', '${TRANSACTION_TIMEOUT_MS}', true) as transaction_timeout, pg_backend_pid() as pid, pg_current_xact_id()::text as xid, (select id::text from db_boundary.connection_marker) as env, floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text as now`;
export type TransactionSnapshot = {
  pid: number;
  xid: string;
  env: string;
  now: string;
};

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

/** For transactions that install a tenant context: deadlines and snapshot are the first statement. */
export function withDeadlinesAndSnapshot<T>(
  db: AppDb,
  work: (tx: TeamTx, snapshot: TransactionSnapshot) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [snapshot] = (
      await tx.execute<TransactionSnapshot>(sql.raw(DEADLINES_AND_SNAPSHOT_SQL))
    ).rows;
    return work(tx, snapshot);
  });
}
