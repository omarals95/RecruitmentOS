import { and, asc, eq, inArray, lt, notExists, sql } from "drizzle-orm";
import { getIdentityDb, type AppDb, type TeamTx } from "@/db";
import { withDeadlines } from "@/db/deadlines";
import {
  apiRateLimits,
  apiTokens,
  oauthClients,
  oauthCodes,
  oauthTokens,
  rateLimit,
} from "@/db/auth-schema";

/** Most rows one purge removes from each table. */
export const PURGE_BATCH = 500;
const PURGE_INTERVAL_MS = 60_000;
let lastPurge = -Infinity;

/** One safe line: the error class and SQLSTATE only, never a key, address, hash or row. */
function logPurgeFailure(error: unknown) {
  const cause =
    (error as { cause?: { code?: unknown } } | null)?.cause ??
    (error as { code?: unknown } | null);
  const code = cause?.code;
  const sqlState =
    typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
      ? ` sqlstate=${code}`
      : "";
  const category =
    (error as { constructor?: { name?: string } } | null)?.constructor?.name ||
    typeof error;
  console.error(`auth_purge_failed category=${category}${sqlState}`);
}

/** Every window is at most 60 seconds, so a row untouched for 10 minutes is spent. */
async function purgeRateLimits(tx: TeamTx) {
  await tx.delete(apiRateLimits).where(
    inArray(
      apiRateLimits.key,
      tx
        .select({ key: apiRateLimits.key })
        .from(apiRateLimits)
        .where(
          lt(
            apiRateLimits.windowStart,
            sql`current_timestamp - interval '10 minutes'`,
          ),
        )
        .orderBy(asc(apiRateLimits.windowStart))
        .limit(PURGE_BATCH)
        .for("update", { skipLocked: true }),
    ),
  );
  await tx.delete(rateLimit).where(
    inArray(
      rateLimit.id,
      tx
        .select({ id: rateLimit.id })
        .from(rateLimit)
        .where(
          lt(
            rateLimit.lastRequest,
            sql`(extract(epoch from current_timestamp) * 1000)::bigint - 600000`,
          ),
        )
        .orderBy(asc(rateLimit.lastRequest))
        .limit(PURGE_BATCH)
        .for("update", { skipLocked: true }),
    ),
  );
}

/**
 * Codes and tokens stay a day past expiry, so replay detection and stale-token recognition keep
 * working. A client older than a day that no grant references was never approved.
 */
async function purgeOAuth(tx: TeamTx) {
  await tx.delete(oauthCodes).where(
    inArray(
      oauthCodes.codeHash,
      tx
        .select({ codeHash: oauthCodes.codeHash })
        .from(oauthCodes)
        .where(
          lt(oauthCodes.expiresAt, sql`current_timestamp - interval '1 day'`),
        )
        .orderBy(asc(oauthCodes.expiresAt))
        .limit(PURGE_BATCH)
        .for("update", { skipLocked: true }),
    ),
  );
  await tx.delete(oauthTokens).where(
    inArray(
      oauthTokens.id,
      tx
        .select({ id: oauthTokens.id })
        .from(oauthTokens)
        .where(
          lt(oauthTokens.expiresAt, sql`current_timestamp - interval '1 day'`),
        )
        .orderBy(asc(oauthTokens.expiresAt))
        .limit(PURGE_BATCH)
        .for("update", { skipLocked: true }),
    ),
  );
  // No row lock here: FOR UPDATE needs UPDATE, which the identity role does not hold on clients.
  // The DELETE locks each row itself, and a concurrent grant's foreign key check blocks it.
  await tx.delete(oauthClients).where(
    inArray(
      oauthClients.id,
      tx
        .select({ id: oauthClients.id })
        .from(oauthClients)
        .where(
          and(
            lt(
              oauthClients.createdAt,
              sql`current_timestamp - interval '1 day'`,
            ),
            notExists(
              tx
                .select({ id: apiTokens.id })
                .from(apiTokens)
                .where(eq(apiTokens.oauthClientId, oauthClients.id)),
            ),
          ),
        )
        .orderBy(asc(oauthClients.createdAt))
        .limit(PURGE_BATCH),
    ),
  );
}

/**
 * Deletes at most PURGE_BATCH spent rows per table, oldest first. Rate-limit and OAuth rows use
 * separate transactions, so a database without the OAuth DELETE grant still purges rate limits.
 * A failure is logged and never reaches the caller.
 */
export async function purgeExpiredAuthRows(db?: AppDb): Promise<void> {
  let target: AppDb;
  try {
    target = db ?? (await getIdentityDb());
  } catch (error) {
    return logPurgeFailure(error);
  }
  for (const purge of [purgeRateLimits, purgeOAuth])
    try {
      await withDeadlines(target, purge);
    } catch (error) {
      logPurgeFailure(error);
    }
}

/**
 * Runs the purge at most once per minute per server instance. Callers await it after their own
 * transaction has committed; there is no scheduler.
 */
export async function purgeExpiredAuthRowsThrottled(db: AppDb): Promise<void> {
  const now = Date.now();
  if (now - lastPurge < PURGE_INTERVAL_MS) return;
  lastPurge = now;
  await purgeExpiredAuthRows(db);
}

/** Test seam: the next request may purge again. */
export function resetAuthPurgeThrottle() {
  lastPurge = -Infinity;
}
