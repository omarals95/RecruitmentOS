import { sql } from "drizzle-orm";
import type { TeamTx } from "@/db";
import { activity } from "@/db/schema";
import { usableAuthURL } from "./auth";
import { accessContext, authorize } from "./authz";
import { withTeam } from "./db-team";
import { ApiError } from "./errors";
import type { Principal } from "./principal";

/**
 * The configured application address as the Domain page shows it: the origin only, never the raw
 * value, so credentials or a path in a bad value are never echoed (SYS-001).
 */
export type DomainAddress = {
  /** new URL(value).origin, or null when unset, unparsable or not a web origin. */
  origin: string | null;
  https: boolean;
  /** The raw value is exactly its origin: no trailing slash, path, query, fragment or credentials. */
  originOnly: boolean;
  /** Sign-in readiness accepts it (usableAuthURL). */
  valid: boolean;
};

const domainForbidden = () =>
  new ApiError(
    403,
    "domain_forbidden",
    "Only a company owner can see the Domain page.",
  );

/** The parsed BETTER_AUTH_URL; the raw string is never returned. */
export function configuredAddress(value: string | undefined): DomainAddress {
  let url: URL | null = null;
  try {
    url = new URL(value ?? "");
  } catch {
    /* Unset or not a URL. */
  }
  const origin = url && url.origin !== "null" ? url.origin : null;
  return {
    origin,
    https: url?.protocol === "https:",
    originOnly: origin !== null && value === origin,
    valid: usableAuthURL(value),
  };
}

/**
 * Signed-in company owners only (D20); anyone else gets 403 domain_forbidden. Reads only
 * BETTER_AUTH_URL, never a request header, and makes no outgoing request (SYS-002, SYS-005). When
 * sign-in accepts the address, the first open records it, and the first open after it changed
 * records the old and new origin: one row per change for the whole workspace, whichever team or
 * company owner opens the page.
 */
export async function readDomainSettings(
  p: Principal,
): Promise<{ address: DomainAddress }> {
  const address = configuredAddress(process.env.BETTER_AUTH_URL);
  return withTeam(p, async (tx, access) => {
    try {
      authorize(accessContext(p, access), {
        adminArea: "domain",
        action: "view",
      });
    } catch (error) {
      if (error instanceof ApiError) throw domainForbidden();
      throw error;
    }
    if (address.valid && address.origin)
      await recordOrigin(tx, p, access.workspaceId, address.origin);
    return { address };
  });
}

/**
 * Under a workspace lock, compares the origin with the newest domain row of any team (read through
 * domain_owner_read) and writes a row only when there is none or it differs.
 */
async function recordOrigin(
  tx: TeamTx,
  p: Principal,
  workspaceId: string,
  to: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`domain-origin:${workspaceId}`}, 0))`,
  );
  const [latest] = (
    await tx.execute<{ origin: string | null }>(
      sql`select metadata->>'to' as origin from app.activity where kind = 'domain' and metadata->>'workspaceId' = ${workspaceId} order by created_at desc, id desc limit 1`,
    )
  ).rows;
  if (latest && latest.origin === to) return;
  const from = latest?.origin ?? null;
  await tx.insert(activity).values({
    teamId: p.teamId,
    recordId: null,
    actorId: p.userId,
    actorType: "session",
    tokenId: null,
    action: latest ? "domain.url_changed" : "domain.url_recorded",
    kind: "domain",
    summary: latest
      ? `Changed the web address from ${from} to ${to}`
      : `Recorded the web address ${to}`,
    metadata: latest ? { workspaceId, from, to } : { workspaceId, to },
    // The lock orders writers, so the clock orders their rows; now() is the transaction start.
    createdAt: sql`clock_timestamp()`,
  });
}
