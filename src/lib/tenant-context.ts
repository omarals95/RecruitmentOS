import { createHash, createHmac } from "node:crypto";
import { DrizzleQueryError, sql } from "drizzle-orm";
import type { TeamTx } from "@/db";
import { ApiError } from "./errors";
import { SCOPES } from "./permissions";
import type { Principal } from "./principal";

const AUDIENCE = "recruitmentos-tenant-context-v1";
const LIFETIME_MS = 60_000;

// Server-only; the key, its pads, payloads and signatures are never logged, returned or put in settings.
function signingKey(): { key: Buffer; id: string } {
  const value = process.env.TENANT_CONTEXT_SIGNING_KEY ?? "";
  const key = Buffer.from(value, "base64url");
  if (
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    key.length < 32 ||
    key.toString("base64url") !== value
  )
    throw new ApiError(
      503,
      "tenant_context_unavailable",
      "Configure TENANT_CONTEXT_SIGNING_KEY with a base64url value of at least 32 random bytes.",
    );
  return {
    key,
    id: createHash("sha256").update(key).digest("hex").slice(0, 16),
  };
}

export function assertTenantContextKey(): void {
  signingKey();
}

/** Owner-run setup: upserts the HMAC pads for the configured key by key id. */
export async function installTenantContextKey(client: {
  query: (query: string, params: unknown[]) => Promise<unknown>;
}): Promise<void> {
  const { key, id } = signingKey();
  const block = Buffer.alloc(64);
  (key.length > 64 ? createHash("sha256").update(key).digest() : key).copy(
    block,
  );
  const pad = (byte: number) =>
    Buffer.from(block.map((value) => value ^ byte)).toString("hex");
  await client.query(
    "INSERT INTO tenant_context.keys(id,inner_pad,outer_pad) VALUES($1,decode($2,'hex'),decode($3,'hex')) ON CONFLICT(id) DO UPDATE SET inner_pad=excluded.inner_pad,outer_pad=excluded.outer_pad",
    [id, pad(0x36), pad(0x5c)],
  );
}

/**
 * Signs exactly one assertion for this transaction and installs it. Only withTeam and the
 * identity-side token transaction call this; withTeam calls it before any other statement.
 */
export async function installTenantContext(
  tx: TeamTx,
  principal: Principal,
): Promise<void> {
  const { key, id } = signingKey();
  const [snapshot] = (
    await tx.execute<{ pid: number; xid: string; env: string; now: string }>(
      sql`select pg_backend_pid() as pid, pg_current_xact_id()::text as xid, (select id::text from db_boundary.connection_marker) as env, floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text as now`,
    )
  ).rows;
  const payload = JSON.stringify({
    aud: AUDIENCE,
    kid: id,
    env: snapshot.env,
    pid: Number(snapshot.pid),
    xid: snapshot.xid,
    team: principal.teamId,
    actor: principal.userId,
    auth: principal.authType,
    token: principal.authType === "token" ? (principal.tokenId ?? null) : null,
    scopes: SCOPES.filter((scope) => principal.scopes.includes(scope)),
    exp: Number(snapshot.now) + LIFETIME_MS,
  });
  const signature = createHmac("sha256", key).update(payload).digest("hex");
  try {
    await tx.execute(
      sql`select tenant_context.install(${payload}, ${signature})`,
    );
  } catch (error) {
    // The query wrapper carries the bound assertion; surface only the database error.
    const cause = error instanceof DrizzleQueryError ? error.cause : error;
    if ((cause as { code?: unknown } | undefined)?.code === "42501")
      throw new ApiError(
        403,
        "tenant_context_denied",
        "Your team access could not be confirmed. Sign in again or ask a team owner.",
      );
    throw cause ?? new Error("Tenant context installation failed.");
  }
}
