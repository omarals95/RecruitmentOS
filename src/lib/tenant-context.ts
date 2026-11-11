import { createHash, createHmac } from "node:crypto";
import { DrizzleQueryError, sql } from "drizzle-orm";
import type { TeamTx } from "@/db";
import type { TransactionSnapshot } from "@/db/deadlines";
import type { RoleBody } from "@/domain/config";
import {
  configBodyCache,
  type ConfigBodyCache,
  type ConfigDocument,
  type ConfigDocumentRow,
} from "./config-cache";
import { ApiError } from "./errors";
import { SCOPES, type Role, type Scope } from "./permissions";
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
 * The access state tenant_context.install stored for this transaction: the verified scopes, and the
 * workspace, team role and company authority it derived from database rows, never from the payload.
 * versions maps each configuration object of the workspace (company objects and this team's task
 * boards) to its current published version id; documents holds exactly those versions, verified.
 * scopes are already narrowed to the member's configured role, whose version roleVersionId names:
 * a built-in template's fixed id without an assigned role, null for an assigned role install could
 * not use (no scopes are then stored). recordScope is that role's record scope per group (all in
 * every group without an assigned role, null when it failed closed); homeUnits are the actor's home
 * org units, sorted, from the employee linked to their user. teamArchived is the team's archived
 * state; scopes then hold only read scopes.
 */
export type TenantAccess = {
  scopes: Scope[];
  workspaceId: string;
  memberRole: Role;
  companyLevel: "owner" | "admin" | null;
  companyAreas: string[];
  versions: Record<string, string>;
  documents: Record<string, ConfigDocument>;
  roleVersionId: string | null;
  recordScope: RoleBody["recordScope"] | null;
  homeUnits: string[];
  teamArchived: boolean;
};
type InstallResult = Omit<TenantAccess, "documents"> & {
  documents: ConfigDocumentRow[];
};

const unverified = () =>
  new Error(
    "The configuration versions of this context could not be verified.",
  );

/**
 * The document of every current version, from the response or from the entries the hint named.
 * Nothing from the response is cached unless the whole set is complete and verified.
 */
function mergeDocuments(
  cache: ConfigBodyCache,
  held: Map<string, ConfigDocument>,
  versions: Record<string, string>,
  returned: ConfigDocumentRow[],
): Record<string, ConfigDocument> {
  const fresh = new Map(returned.map((row) => [row.versionId, row]));
  for (const [objectId, versionId] of Object.entries(versions)) {
    const document = fresh.get(versionId) ?? held.get(versionId);
    if (document?.objectId !== objectId) throw unverified();
  }
  const added = new Map(
    cache.add(...returned).map((document) => [document.versionId, document]),
  );
  const documents: Record<string, ConfigDocument> = {};
  for (const versionId of Object.values(versions)) {
    const document = added.get(versionId);
    if (document) documents[versionId] = document;
    else {
      documents[versionId] = held.get(versionId)!;
      cache.use(versionId);
    }
  }
  return documents;
}

/**
 * Signs exactly one assertion for this transaction and installs it. Only withTeam and the
 * identity-side token transactions call this, with the snapshot their first statement read
 * (withDeadlinesAndSnapshot: deadlines, pid, xid, marker and clock). withTeam calls it as the next
 * statement, before any other statement or savepoint; tenant_context.install rechecks pid and xid.
 * The third argument, an unsigned hint, names every version id the cache holds; install leaves
 * those bodies out, and the entries are kept for this request so a concurrent eviction loses none.
 */
export async function installTenantContext(
  tx: TeamTx,
  principal: Principal,
  snapshot: TransactionSnapshot,
  cache: ConfigBodyCache = configBodyCache,
): Promise<TenantAccess> {
  const held = cache.entries();
  const { key, id } = signingKey();
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
  let result: InstallResult;
  try {
    const { rows } = await tx.execute<{ access: InstallResult }>(
      sql`select tenant_context.install(${payload}, ${signature}, ${sql.param([...held.keys()])}::text[]) as access`,
    );
    result = rows[0].access;
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
  const { documents, ...access } = result;
  return {
    ...access,
    documents: mergeDocuments(cache, held, access.versions, documents),
  };
}
