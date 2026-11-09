/**
 * Opt-in live restricted-role isolation harness (WP-02c): `npm run test:live-roles`.
 *
 * - It proves the tenant and identity boundary with independent connections to a real
 *   PostgreSQL database: cross-team reads, writes and guessed identifiers, forged and replayed
 *   tenant contexts, savepoint replay, pooled-connection reuse, private rows within a team, the
 *   data role writing identity rows, the identity role reading candidate data, revoked and
 *   expired tokens, a demoted owner, and concurrent last-owner removal, bootstrap claims,
 *   storage reservations and Blob read leases. Denied mutations must leave no audit row. Both
 *   runtime roles are denied every write on the company workspace tables, and a team owner without
 *   company authority cannot call tenant_context.set_workspace_authority. tenant_context.install
 *   refuses a signed payload with an extra workspace or company field and a team without a
 *   workspace mapping, and returns the mapped workspace with no company level, areas or plan access
 *   for a team owner without company authority. A company authority grant and a concurrent removal
 *   of the target's last membership never leave unsuspended authority for a user in no team.
 *   A context reads no configuration row of another workspace, the data role cannot insert a
 *   config activity row and tenant_context.audit_config refuses a duplicate publish audit, and a
 *   team owner without company authority cannot write company configuration (direct SQL or
 *   tenant_context.publish_config_version) but can write their own team's task board, which
 *   another team cannot read. A recruiter or viewer asserting any directory or plan scope is
 *   refused, and an owner asserting all eleven scopes is accepted. An unsigned cache hint naming
 *   another workspace's and another team's published versions returns neither their ids nor
 *   their bodies and changes no scope, workspace or company authority; it only drops the bodies
 *   of the context's own current versions. A context reads no organisation level, unit or closure
 *   row of another workspace and cannot insert one there; the data role cannot insert, update or
 *   delete app.org_unit_closure; a company admin with the organisation area is refused a unit's
 *   parent change, archive and a same-code insert under a new parent, with no closure or activity
 *   change, while a company owner session's move writes one org.unit_moved and one
 *   scope.home_units_changed row; and two owner sessions moving A under B and B under A at once
 *   commit at most once, the second waiting and then refused with RQ009, leaving an acyclic closure.
 *   While such a move holds the workspace lock, an insert keyed to the workspace does not wait.
 * - On the data role it proves the app's per-transaction deadlines from src/db/deadlines.ts: the
 *   shared statement sets them, a statement timeout cancels with 57014, a transaction timeout ends
 *   its session, and the next transaction on the same pooled backend reads its earlier values.
 * - It reads only DATABASE_URL (data role), IDENTITY_DATABASE_URL (identity role),
 *   MIGRATION_DATABASE_URL (owner), LIVE_ROLE_TESTS_CONFIRM (must equal the database name),
 *   TENANT_CONTEXT_SIGNING_KEY (the key the database was migrated with), LIVE_ROLE_TESTS_DIAGNOSE
 *   (only the exact value 1 enables diagnostics) and PGOPTIONS (only to refuse it) from the
 *   process environment. It never loads an env file.
 * - It writes only fictional fixtures under a random run prefix: users, three teams, members and
 *   API tokens as the owner or the identity role; candidates, a vacancy, saved views, candidate
 *   states, reminder reads, idempotency, activity, pending uploads and bulk intake batches and
 *   items as the data role under signed contexts; fixture stores and read leases as the owner. The
 *   owner-run triggers map each fixture team to the company workspace and, in the open bootstrap
 *   variant, make the fixture initial administrator company owner. As the owner it also removes
 *   and restores one fixture team's workspace mapping and makes one fixture user company owner,
 *   who grants company authority to two fixture members through the helper (one audit row, and
 *   the trigger suspends it). As the owner it makes the team A fixture owner company owner, writes
 *   fixture configuration objects keyed by the run prefix, and briefly inserts a second fixture
 *   workspace (team creation fails on the database while it exists) with one object, removing
 *   both in the same check; the data role commits one task board in fixture team B. In one more
 *   check the owner inserts the second workspace again with one published object, a published
 *   team B task board and a published company object, and removes all of them there. As the
 *   owner it makes the team A fixture recruiter a company admin with the organisation area, writes
 *   two fixture organisation levels at the two lowest free depths of the company workspace and
 *   fixture units coded by the run prefix, and inserts the second workspace once more with one
 *   level and unit, removing them in that check; the data role commits one fixture unit move under
 *   the team A owner's context. As the
 *   identity role it briefly makes the team A fixture recruiter a viewer and restores the role.
 *   It never changes budgets, keys, roles, grants, policies, migrations or settings beyond
 *   transaction-local deadlines.
 * - Cleanup runs after any failure once writing has started. One owner transaction lifts FORCE
 *   ROW LEVEL SECURITY and the immutable_activity trigger on the app tables (ACCESS EXCLUSIVE
 *   locks), deletes the fixture rows and restores both before COMMIT; then the fixture
 *   configuration objects, organisation units (with their closure rows) and levels, the contexts,
 *   leases, stores, teams, users (with their cascaded workspace mappings and company authority) and, in
 *   the open bootstrap variant, the setup claim it created go.
 * - It prints one JSON document of counts and static check ids, never a URL, host, port,
 *   username, password, the marker, the key, its id, a payload, a signature, row data or driver
 *   error text. Exit codes: 0 every check passed and no fixture remains; 1 a check failed, an
 *   error occurred or a fixture remains; 2 refused before anything was written.
 * - With LIVE_ROLE_TESTS_DIAGNOSE=1 the document also has `diagnostics`: one
 *   { check, phase, error } entry per failed check, in the order of failedChecks. The phase is
 *   setup, install, backend-identity, lock-overlap, outcome, positive-control, end-state or
 *   cleanup; the error is a SQLSTATE or one of assertion (a false condition, no database error),
 *   connection (a client connection or network failure) and harness-error (anything else).
 * - Only the owner runs it against a non-local database, and only an approved Preview database:
 *   never Production. Agents never run it against Neon or any remote database.
 * - Before writing it refuses (exit 2) any database whose schema db_boundary does not carry
 *   exactly the PREVIEW_MARK comment, which only the schema owner can set, by hand, with the
 *   statement in docs/neon-database-runbook.md §3 item 4. Migrations, the role template and this
 *   code never set it, so Production has none unless someone sets it there; a copy or branch of
 *   Preview carries it. The comment's value is never printed.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, Pool } from "pg";
import {
  dataRoleBoundaryQuery,
  identityRoleBoundaryQuery,
  isLoopbackHost,
  markerRoleBoundaryQuery,
  prepareConnectionTargets,
  verifyPoolPair,
} from "../src/db/connection-boundary.ts";
import {
  DEADLINES_SQL,
  STATEMENT_TIMEOUT_MS as APP_STATEMENT_TIMEOUT_MS,
  TRANSACTION_TIMEOUT_MS as APP_TRANSACTION_TIMEOUT_MS,
} from "../src/db/deadlines.ts";
import { runtimeRoleSafetyQuery } from "../src/db/runtime-role.ts";
import { SCOPES, roleScopes } from "../src/lib/permissions.ts";
import { assertTenantContextKey } from "../src/lib/tenant-context.ts";

type Env = Record<string, string | undefined>;
type Row = Record<string, unknown>;
type Db = {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: Row[]; rowCount: number | null }>;
};
type Outcome = {
  ok: boolean;
  code?: string;
  error?: string;
  count: number;
  rows: Row[];
};
type Signer = { key: Buffer; id: string };
type Principal = {
  team: string;
  actor: string;
  auth: "session" | "token";
  token: string | null;
  scopes: readonly string[];
};
type Variant = "open" | "closed";
type Counts = Record<string, number>;
type Phase =
  | "setup"
  | "install"
  | "backend-identity"
  | "lock-overlap"
  | "outcome"
  | "positive-control"
  | "end-state"
  | "cleanup";
/** A condition, the phase it belongs to and the SQLSTATE or category reported when it is false. */
type Condition = [phase: Phase, holds: boolean, error?: string];
type Probe = {
  /** The phase a check has reached; an error thrown from here on is reported in it. */
  at: (phase: Phase) => void;
  /** Whether every condition holds; the first one that does not becomes the diagnostic. */
  all: (...conditions: Condition[]) => boolean;
};

const AUDIENCE = "recruitmentos-tenant-context-v1";
/** The db_boundary comment only its owner can set; migrations and the role template never set it. */
const PREVIEW_MARK = "recruitmentos-environment=preview";
const LIFETIME_MS = 60_000;
const STATEMENT_TIMEOUT_MS = 20_000;
const OVERLAP_WAIT_MS = 10_000;
const WORKERS = 6;
const STORE_ROOM = 3;
const UPLOAD_BYTES = 1000;
const APP_TABLES = [
  "records",
  "candidate_states",
  "activity",
  "uploads",
  "storage_usage",
  "idempotency",
  "notification_reads",
  "bulk_intake_batches",
  "bulk_intake_items",
] as const;
/** The company workspace tables (0028), under FORCE RLS with owner-only writes. */
const WORKSPACE_TABLES = [
  "workspaces",
  "workspace_teams",
  "workspace_admins",
] as const;
/** The configuration store (0030), under FORCE RLS with allows_workspace policies. */
const CONFIG_TABLES = [
  "config_objects",
  "config_versions",
  "config_layouts",
] as const;
/** The organisation hierarchy (0033), under FORCE RLS with allows_workspace policies. */
const ORG_TABLES = ["org_levels", "org_units", "org_unit_closure"] as const;
/** The one company workspace every team maps to. */
const COMPANY_WORKSPACE = "00000000-0000-4000-a000-000000000001";
const ALL_SCOPES = [...SCOPES];
const RECRUITER_SCOPES = roleScopes("recruiter");
const VIEWER_SCOPES = roleScopes("viewer");
/** The directory and plan scopes (0031): owner and admin membership ceilings only. */
const CEILING_SCOPES = [
  "directory:read",
  "directory:write",
  "plans:read",
  "plans:write",
] as const;
const INSERT_UPLOAD = `INSERT INTO app.uploads(team_id,candidate_id,original_name,mime_type,size_bytes,object_key,
    storage_provider,storage_environment,storage_store,created_by,expires_at)
  VALUES($1,$2,$3,'application/pdf',$4,$5,'blob','development',$6,$7,now() + interval '1 hour') RETURNING id::text AS id`;

function refuse(reason: string, after = "Nothing was contacted."): number {
  console.error(`Refused: ${reason} ${after}`);
  return 2;
}

/** assertTenantContextKey reads process.env; the harness checks the key from its own env. */
function keyAccepted(value: string): boolean {
  const previous = process.env.TENANT_CONTEXT_SIGNING_KEY;
  process.env.TENANT_CONTEXT_SIGNING_KEY = value;
  try {
    assertTenantContextKey();
    return true;
  } catch {
    return false;
  } finally {
    if (previous === undefined) delete process.env.TENANT_CONTEXT_SIGNING_KEY;
    else process.env.TENANT_CONTEXT_SIGNING_KEY = previous;
  }
}

/** The runtime TLS rule from createDbPair, with a bounded statement timeout per session. */
function clientConfig(connectionString: string) {
  const url = new URL(connectionString);
  const local = isLoopbackHost(url.hostname);
  if (!local) url.searchParams.set("sslmode", "verify-full");
  return {
    connectionString: url.toString(),
    connectionTimeoutMillis: 10000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    ...(!local ? { ssl: { rejectUnauthorized: true } } : {}),
  };
}

function connect(connectionString: string) {
  const client = new Client(clientConfig(connectionString));
  client.on("error", () => {});
  return client;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/**
 * A thrown value as a SQLSTATE or a fixed category: connection for a client connection or network
 * failure (a Node system error), harness-error for anything else. It reads only `code` and the
 * structural `syscall`, never the message.
 */
export function errorCategory(error: unknown): string {
  if (typeof error !== "object" || error === null) return "harness-error";
  const { code, syscall } = error as { code?: unknown; syscall?: unknown };
  if (
    typeof syscall === "string" ||
    (typeof code === "string" && NETWORK_CODES.has(code))
  )
    return "connection";
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  return "harness-error";
}

async function settle(
  pending: Promise<{ rows: Row[]; rowCount: number | null }>,
): Promise<Outcome> {
  try {
    const result = await pending;
    return { ok: true, count: result.rowCount ?? 0, rows: result.rows };
  } catch (error) {
    return {
      ok: false,
      code: codeOf(error),
      error: errorCategory(error),
      count: 0,
      rows: [],
    };
  }
}

/** A statement's condition; when false it reports the statement's error, or assertion if it succeeded. */
const outcomeIs = (
  holds: boolean,
  outcome: Outcome | undefined,
  phase: Phase = "outcome",
): Condition => [
  phase,
  holds,
  outcome?.ok === false ? outcome.error : "assertion",
];
const failsWith = (outcome: Outcome | undefined, code: string) =>
  outcomeIs(outcome?.ok === false && outcome.code === code, outcome);

/** One statement inside the open transaction; a failure rolls back only this statement. */
async function attempt(db: Db, text: string, params?: unknown[]) {
  await db.query("SAVEPOINT attempt");
  const outcome = await settle(db.query(text, params));
  await db.query(
    outcome.ok ? "RELEASE SAVEPOINT attempt" : "ROLLBACK TO SAVEPOINT attempt",
  );
  return outcome;
}

const denied = (outcome: Outcome) => !outcome.ok && outcome.code === "42501";
/** Another user's or team's rows: nothing touched, or the statement itself is not granted. */
const untouched = (outcome: Outcome) =>
  (outcome.ok && outcome.count === 0) || denied(outcome);
const denial = (outcome: Outcome) => outcomeIs(denied(outcome), outcome);
const leftAlone = (outcome: Outcome) => outcomeIs(untouched(outcome), outcome);

async function count(db: Db, text: string, params?: unknown[]) {
  const { rows } = await db.query(text, params);
  return Number(rows[0]?.n);
}

/** Rolled back unless commit is set; the rollback also ends a failed transaction. */
async function transaction<T>(
  db: Db,
  work: () => Promise<T>,
  commit = false,
): Promise<T> {
  await db.query("BEGIN");
  let ended = false;
  try {
    const value = await work();
    if (commit) {
      await db.query("COMMIT");
      ended = true;
    }
    return value;
  } finally {
    if (!ended) await db.query("ROLLBACK").catch(() => {});
  }
}

export function signerFor(value: string): Signer {
  const key = Buffer.from(value, "base64url");
  return {
    key,
    id: createHash("sha256").update(key).digest("hex").slice(0, 16),
  };
}

const sign = (payload: string, key: Buffer) =>
  createHmac("sha256", key).update(payload).digest("hex");

/**
 * The canonical payload installTenantContext signs, bound to this backend and transaction, and the
 * backend pid from the same in-transaction snapshot.
 */
async function assertionFor(
  db: Db,
  signer: Signer,
  principal: Principal,
  lifetime = LIFETIME_MS,
) {
  const { rows } = await db.query(
    "SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid, (SELECT id::text FROM db_boundary.connection_marker) AS marker, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now",
  );
  const payload = JSON.stringify({
    aud: AUDIENCE,
    kid: signer.id,
    env: rows[0].marker,
    pid: Number(rows[0].pid),
    xid: rows[0].xid,
    team: principal.team,
    actor: principal.actor,
    auth: principal.auth,
    token: principal.auth === "token" ? principal.token : null,
    scopes: SCOPES.filter((scope) => principal.scopes.includes(scope)),
    exp: Number(rows[0].now) + lifetime,
  });
  return {
    payload,
    signature: sign(payload, signer.key),
    pid: Number(rows[0].pid),
    xid: rows[0].xid as string,
  };
}

/** The unsigned cache hint (third argument) is empty, as in installTenantContext. */
const installSql =
  "SELECT tenant_context.install($1,$2,'{}'::text[]) AS access";

/**
 * The access state install derived and returned (0029), with the current configuration versions
 * and the bodies the hint did not name (0032).
 */
type Access = {
  scopes: string[];
  workspaceId: string;
  memberRole: string;
  companyLevel: string | null;
  companyAreas: string[];
  versions: Record<string, string>;
  documents: {
    versionId: string;
    objectId: string;
    type: string;
    key: string;
    number: number;
    bodySha256: string;
    body: string;
  }[];
};

async function installAs(db: Db, signer: Signer, principal: Principal) {
  const assertion = await assertionFor(db, signer, principal);
  const { rows } = await db.query(installSql, [
    assertion.payload,
    assertion.signature,
  ]);
  return { ...assertion, access: rows[0].access as Access };
}

/**
 * The backend running the client's open transaction. Behind a transaction pooler only a statement
 * between BEGIN and COMMIT or ROLLBACK is known to run on that backend.
 */
async function backendPid(db: Db) {
  return Number((await db.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
}

/** Whether the owner sees every listed backend waiting on a lock it has not been granted. */
async function waitForWaiters(
  owner: Db,
  pids: number[],
  expected: number,
  deadline = Date.now() + OVERLAP_WAIT_MS,
) {
  while (Date.now() < deadline) {
    const waiting = await count(
      owner,
      "SELECT count(DISTINCT pid)::int AS n FROM pg_catalog.pg_locks WHERE NOT granted AND pid = ANY($1::int[])",
      [pids],
    );
    if (waiting >= expected) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return false;
}

const distinct = (pids: number[]) =>
  pids.every(Number.isInteger) && new Set(pids).size === pids.length;

function fixtureNames(prefix: string) {
  const id = (name: string) => `${prefix}-${name}`;
  return {
    prefix,
    pattern: `${prefix}-%`,
    users: {
      a1: id("user-a1"),
      a2: id("user-a2"),
      b1: id("user-b1"),
      b2: id("user-b2"),
      c1: id("user-c1"),
      c2: id("user-c2"),
      rival: id("user-rival"),
      holder: id("user-holder"),
      // Targets of the company authority grant/removal race, each in team C only.
      grantFirst: id("user-grant-first"),
      removeFirst: id("user-remove-first"),
    },
    teams: { a: id("team-a"), b: id("team-b"), c: id("team-c") },
    members: {
      a1: id("member-a1"),
      a2: id("member-a2"),
      b1: id("member-b1"),
      b2: id("member-b2"),
      c1: id("member-c1"),
      c2: id("member-c2"),
      grantFirst: id("member-grant-first"),
      removeFirst: id("member-remove-first"),
    },
    tokens: { live: id("token-live"), expired: id("token-expired") },
    // Blob store names allow only letters and digits after store_.
    stores: {
      seed: `store_${prefix}seed`,
      race: `store_${prefix}race`,
      lease: `store_${prefix}lease`,
      cap: `store_${prefix}cap`,
    },
  };
}
type Fixtures = ReturnType<typeof fixtureNames>;
type TeamRows = {
  candidate: string;
  vacancy: string;
  savedView: string;
  upload: string;
  batch: string;
  item: string;
};

type Run = {
  owner: Client;
  data: Client;
  data2: Client;
  identity: Client;
  identity2: Client;
  workers: Client[];
  dataUrl: string;
  signer: Signer;
  f: Fixtures;
  variant: Variant;
  check: (id: string, run: (probe: Probe) => Promise<boolean>) => Promise<void>;
};

function principals(f: Fixtures) {
  const session = (team: string, actor: string, scopes: readonly string[]) =>
    ({ team, actor, auth: "session", token: null, scopes }) as Principal;
  const tokenScopes = ["candidates:read", "recruitment:read"];
  return {
    ownerA: session(f.teams.a, f.users.a1, ALL_SCOPES),
    memberA: session(f.teams.a, f.users.a2, RECRUITER_SCOPES),
    viewerA: session(f.teams.a, f.users.a2, VIEWER_SCOPES),
    ownerB: session(f.teams.b, f.users.b1, ALL_SCOPES),
    ownerC: session(f.teams.c, f.users.c1, ALL_SCOPES),
    demotedB: session(f.teams.b, f.users.b2, ALL_SCOPES),
    viewerB: session(f.teams.b, f.users.b2, VIEWER_SCOPES),
    liveToken: {
      team: f.teams.a,
      actor: f.users.a1,
      auth: "token",
      token: f.tokens.live,
      scopes: tokenScopes,
    } as Principal,
    expiredToken: {
      team: f.teams.a,
      actor: f.users.a1,
      auth: "token",
      token: f.tokens.expired,
      scopes: tokenScopes,
    } as Principal,
  };
}

/** Every table the harness writes, with the predicate that selects only its fixtures. */
function fixtureTables(f: Fixtures, variant: Variant) {
  const team: [string, unknown[]] = ["team_id LIKE $1", [f.pattern]];
  const store: [string, unknown[]] = [
    "store = ANY($1::text[])",
    [Object.values(f.stores)],
  ];
  const tables: [string, string, unknown[]][] = [
    ["app.activity", ...team],
    ["app.bulk_intake_items", ...team],
    ["app.bulk_intake_batches", ...team],
    [
      "app.uploads",
      "team_id LIKE $1 OR storage_store = ANY($2::text[])",
      [f.pattern, Object.values(f.stores)],
    ],
    ["app.candidate_states", ...team],
    ["app.notification_reads", ...team],
    ["app.idempotency", ...team],
    ["app.storage_usage", ...team],
    ["app.records", ...team],
    // Both cascade from the fixture teams and users; the owner-only policies let the owner count them.
    ["app.workspace_teams", ...team],
    ["app.workspace_admins", "user_id LIKE $1", [f.pattern]],
    // Fixture configuration: company objects by key, task boards by team; versions and layouts
    // cascade from their object. The owner-only policies let the owner count and delete them.
    [
      "app.config_layouts",
      "version_id IN (SELECT v.id FROM app.config_versions v JOIN app.config_objects o ON o.id = v.object_id WHERE o.key LIKE $1 OR o.team_id LIKE $1)",
      [f.pattern],
    ],
    [
      "app.config_versions",
      "object_id IN (SELECT o.id FROM app.config_objects o WHERE o.key LIKE $1 OR o.team_id LIKE $1)",
      [f.pattern],
    ],
    ["app.config_objects", "key LIKE $1 OR team_id LIKE $1", [f.pattern]],
    // Fixture units by code and levels by name; closure rows cascade from their units.
    [
      "app.org_unit_closure",
      "descendant_id IN (SELECT u.id FROM app.org_units u WHERE u.code LIKE $1)",
      [f.pattern],
    ],
    ["app.org_units", "code LIKE $1", [f.pattern]],
    ["app.org_levels", "name LIKE $1", [f.pattern]],
    ["app.workspaces", "name LIKE $1", [f.pattern]],
    ["tenant_context.contexts", ...team],
    ["storage_ledger.blob_read_leases", ...store],
    ["storage_ledger.stores", ...store],
    ["auth.organization", "id LIKE $1", [f.pattern]],
    ["auth.member", "organization_id LIKE $1 OR user_id LIKE $1", [f.pattern]],
    [
      "auth.invitation",
      "organization_id LIKE $1 OR inviter_id LIKE $1",
      [f.pattern],
    ],
    ["auth.api_tokens", "team_id LIKE $1 OR user_id LIKE $1", [f.pattern]],
    ['auth."user"', "id LIKE $1", [f.pattern]],
  ];
  if (variant === "open")
    tables.push(["auth.initial_admin_claim", "user_id LIKE $1", [f.pattern]]);
  return tables;
}

/** Owner counts in a rolled-back transaction; FORCE RLS is lifted only inside it. */
async function fixtureCounts(owner: Db, f: Fixtures, variant: Variant) {
  return transaction(owner, async () => {
    for (const table of APP_TABLES)
      await owner.query(`ALTER TABLE app.${table} NO FORCE ROW LEVEL SECURITY`);
    const counts: Counts = {};
    for (const [table, where, params] of fixtureTables(f, variant))
      counts[table] = await count(
        owner,
        `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
        params,
      );
    return counts;
  });
}

async function activityCounts(owner: Db, f: Fixtures) {
  return transaction(owner, async () => {
    await owner.query("ALTER TABLE app.activity NO FORCE ROW LEVEL SECURITY");
    const { rows } = await owner.query(
      `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE action = 'personal_state_updated' OR kind = 'saved-view')::int AS private,
        count(*) FILTER (WHERE kind = 'api-token')::int AS token
      FROM app.activity WHERE team_id LIKE $1`,
      [f.pattern],
    );
    return rows[0] as { total: number; private: number; token: number };
  });
}

/**
 * Removes only fixture rows; returns whether FORCE RLS and the activity trigger are restored, and
 * the first error's SQLSTATE or category (assertion when none was thrown).
 */
async function cleanup(owner: Db, f: Fixtures, variant: Variant) {
  const tables = new Map(
    fixtureTables(f, variant).map(([table, where, params]) => [
      table,
      { where, params },
    ]),
  );
  const remove = (table: string) =>
    owner.query(
      `DELETE FROM ${table} WHERE ${tables.get(table)!.where}`,
      tables.get(table)!.params,
    );
  let failure: string | undefined;
  try {
    await transaction(
      owner,
      async () => {
        for (const table of APP_TABLES)
          await owner.query(
            `ALTER TABLE app.${table} NO FORCE ROW LEVEL SECURITY`,
          );
        await owner.query(
          "ALTER TABLE app.activity DISABLE TRIGGER immutable_activity",
        );
        for (const table of [
          "activity",
          "bulk_intake_items",
          "bulk_intake_batches",
          "uploads",
          "candidate_states",
          "notification_reads",
          "idempotency",
          "storage_usage",
          "records",
        ])
          await remove(`app.${table}`);
        await owner.query(
          "ALTER TABLE app.activity ENABLE TRIGGER immutable_activity",
        );
        for (const table of APP_TABLES)
          await owner.query(
            `ALTER TABLE app.${table} FORCE ROW LEVEL SECURITY`,
          );
      },
      true,
    );
  } catch (error) {
    failure = errorCategory(error);
  }
  try {
    await transaction(
      owner,
      async () => {
        for (const table of [
          // The guard lets the owner delete published versions; the second workspace goes after
          // its objects and org rows, and units go before their levels.
          "app.config_objects",
          "app.org_units",
          "app.org_levels",
          "app.workspaces",
          "tenant_context.contexts",
          "storage_ledger.blob_read_leases",
          "storage_ledger.stores",
          // Members, invitations and tokens cascade from the team and the user.
          "auth.organization",
          'auth."user"',
          ...(variant === "open" ? ["auth.initial_admin_claim"] : []),
        ])
          await remove(table);
      },
      true,
    );
  } catch (error) {
    failure ??= errorCategory(error);
  }
  const { rows } = await owner.query(
    `SELECT (SELECT count(*) FILTER (WHERE c.relforcerowsecurity) FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY($1::text[]))::int AS forced,
      (SELECT t.tgenabled::text FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid = 'app.activity'::regclass AND t.tgname = 'immutable_activity') AS trigger`,
    [[...APP_TABLES, ...WORKSPACE_TABLES, ...CONFIG_TABLES, ...ORG_TABLES]],
  );
  return {
    restored:
      failure === undefined &&
      rows[0].forced ===
        APP_TABLES.length +
          WORKSPACE_TABLES.length +
          CONFIG_TABLES.length +
          ORG_TABLES.length &&
      rows[0].trigger === "O",
    error: failure ?? "assertion",
  };
}

/**
 * Concurrent transactions; the lock holder waits at the gate until the others are seen waiting.
 * Each worker reports the backend pid read inside its transaction before its first lock-taking
 * statement, and the owner starts polling only once every worker has reported, within one deadline.
 */
async function gatedRace<T>(
  run: Run,
  probe: Probe,
  clients: Client[],
  work: (
    client: Client,
    index: number,
    report: (pid: number) => void,
  ) => Promise<{ value: T; commit: boolean }>,
) {
  const deadline = Date.now() + OVERLAP_WAIT_MS;
  let open = () => {};
  const gate = new Promise<void>((done) => {
    open = done;
  });
  const pids = clients.map(() => Number.NaN);
  // A worker that fails is reported in the phase it reached.
  const phases = clients.map((): Phase => "setup");
  let reported = 0;
  let failed = false;
  const settled = Promise.allSettled(
    clients.map(async (client, index) => {
      try {
        await client.query("BEGIN");
        phases[index] = "install";
        let commit = false;
        try {
          const outcome = await work(client, index, (pid) => {
            pids[index] = pid;
            phases[index] = "outcome";
            reported += 1;
          });
          await gate;
          commit = outcome.commit;
          return outcome.value;
        } finally {
          await client.query(commit ? "COMMIT" : "ROLLBACK");
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    }),
  );
  let overlapped = false;
  try {
    while (reported < clients.length && !failed && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 50));
    if (reported === clients.length)
      overlapped = await waitForWaiters(
        run.owner,
        pids,
        clients.length - 1,
        deadline,
      );
  } finally {
    open();
  }
  const results = await settled;
  const rejected = results.findIndex((result) => result.status === "rejected");
  // The check reports the worker's own SQLSTATE or category.
  if (rejected >= 0) {
    probe.at(phases[rejected]);
    throw (results[rejected] as PromiseRejectedResult).reason;
  }
  return {
    overlapped,
    distinct: distinct(pids),
    values: results.map(
      (result) => (result as PromiseFulfilledResult<T>).value,
    ),
  };
}

async function claimRow(owner: Db) {
  const { rows } = await owner.query(
    "SELECT user_id, claimed_at::text AS claimed_at, completed_at::text AS completed_at FROM auth.initial_admin_claim",
  );
  return rows;
}

/** Two identity connections insert initial_admin users at once; the second waits on the setup lock. */
async function bootstrapRace(run: Run) {
  const { owner, identity: first, identity2: second, f } = run;
  const before = JSON.stringify(await claimRow(owner));
  const insert = (client: Client, id: string, initialAdmin = true) =>
    settle(
      client.query(
        `INSERT INTO auth."user"(id,name,email,email_verified,initial_admin) VALUES($1,$2,$3,true,$4)`,
        [
          id,
          `Fictional administrator ${f.prefix}`,
          `${id}@example.test`,
          initialAdmin,
        ],
      ),
    );
  const closed = run.variant === "closed";
  await first.query("BEGIN");
  await second.query("BEGIN");
  let holder: Outcome | undefined;
  let firstOutcome: Outcome | undefined;
  let secondOutcome: Outcome;
  let overlapped: boolean;
  let backends: number[];
  let firstEnded = false;
  try {
    // Each transaction's backend, read inside it before its first insert.
    backends = [await backendPid(first), await backendPid(second)];
    // A failed statement aborts its transaction and frees the setup lock at once, so in the closed
    // variant the first transaction holds the lock through a plain user insert it rolls back.
    if (closed) holder = await insert(first, f.users.holder, false);
    else firstOutcome = await insert(first, f.users.a1);
    // The first transaction holds the setup advisory lock; the rival must wait on it.
    const pending = insert(second, f.users.rival);
    try {
      overlapped = await waitForWaiters(owner, [backends[1]], 1);
      if (closed) firstOutcome = await insert(first, f.users.a1);
    } finally {
      await first.query(!closed && firstOutcome?.ok ? "COMMIT" : "ROLLBACK");
      firstEnded = true;
    }
    secondOutcome = await pending;
  } finally {
    if (!firstEnded) await first.query("ROLLBACK").catch(() => {});
    await second.query("ROLLBACK").catch(() => {});
  }
  const users = await count(
    owner,
    `SELECT count(*)::int AS n FROM auth."user" WHERE id LIKE $1`,
    [f.pattern],
  );
  const after = await claimRow(owner);
  const pids = distinct(backends);
  if (closed) {
    await run.check("bootstrap-claim-race", async (probe) =>
      probe.all(
        outcomeIs(holder?.ok === true, holder, "setup"),
        ["backend-identity", pids],
        ["lock-overlap", overlapped],
        failsWith(firstOutcome, "23514"),
        failsWith(secondOutcome, "23514"),
        ["end-state", users === 0 && JSON.stringify(after) === before],
      ),
    );
    return;
  }
  if (!firstOutcome?.ok)
    throw new Error("The first administrator could not be created.");
  // Complete setup for the winner, which owns fixture team A.
  await owner.query(
    "INSERT INTO auth.organization(id,name,slug,created_by) VALUES($1,$2,$1,$3)",
    [f.teams.a, `Fictional team A ${f.prefix}`, f.users.a1],
  );
  await owner.query(
    "INSERT INTO auth.member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",
    [f.members.a1, f.teams.a, f.users.a1],
  );
  const completed = await claimRow(owner);
  await run.check("bootstrap-claim-race", async (probe) =>
    probe.all(
      ["backend-identity", pids],
      ["lock-overlap", overlapped],
      failsWith(secondOutcome, "23514"),
      [
        "end-state",
        users === 1 &&
          after.length === 1 &&
          after[0].user_id === f.users.a1 &&
          after[0].completed_at === null &&
          completed.length === 1 &&
          completed[0].completed_at !== null,
      ],
    ),
  );
}

/** Identity fixtures and storage fixtures, written by the owner. */
async function seedOwnerFixtures(run: Run) {
  const { owner, f } = run;
  const user = (id: string) =>
    owner.query(
      `INSERT INTO auth."user"(id,name,email,email_verified) VALUES($1,$2,$3,true)`,
      [id, `Fictional user ${f.prefix}`, `${id}@example.test`],
    );
  const team = (id: string, creator: string) =>
    owner.query(
      "INSERT INTO auth.organization(id,name,slug,created_by) VALUES($1,$2,$1,$3)",
      [id, `Fictional team ${f.prefix}`, creator],
    );
  const member = (id: string, teamId: string, userId: string, role: string) =>
    owner.query(
      "INSERT INTO auth.member(id,organization_id,user_id,role) VALUES($1,$2,$3,$4)",
      [id, teamId, userId, role],
    );
  if (run.variant === "closed") {
    await user(f.users.a1);
    await team(f.teams.a, f.users.a1);
    await member(f.members.a1, f.teams.a, f.users.a1, "owner");
  }
  for (const id of [f.users.a2, f.users.b1, f.users.b2, f.users.c1, f.users.c2])
    await user(id);
  await team(f.teams.b, f.users.b1);
  await team(f.teams.c, f.users.c1);
  await member(f.members.a2, f.teams.a, f.users.a2, "recruiter");
  await member(f.members.b1, f.teams.b, f.users.b1, "owner");
  await member(f.members.b2, f.teams.b, f.users.b2, "owner");
  await member(f.members.c1, f.teams.c, f.users.c1, "owner");
  await member(f.members.c2, f.teams.c, f.users.c2, "owner");
  for (const [id, expiry] of [
    [f.tokens.live, "now() + interval '1 hour'"],
    [f.tokens.expired, "now() - interval '1 hour'"],
  ])
    await owner.query(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,${expiry})`,
      [
        id,
        f.teams.a,
        f.users.a1,
        `Fictional token ${id}`,
        createHash("sha256").update(id).digest("hex"),
        id,
        JSON.stringify(RECRUITER_SCOPES),
      ],
    );
  const budget = (
    await owner.query(
      "SELECT max_files FROM storage_ledger.budgets WHERE environment = 'development'",
    )
  ).rows[0];
  for (const store of [f.stores.seed, f.stores.lease, f.stores.cap])
    await owner.query(
      "INSERT INTO storage_ledger.stores(provider,store,environment) VALUES('blob',$1,'development')",
      [store],
    );
  // Room for exactly STORE_ROOM more files under the unmodified development budget.
  await owner.query(
    "INSERT INTO storage_ledger.stores(provider,store,environment,used_files) VALUES('blob',$1,'development',$2)",
    [f.stores.race, Number(budget.max_files) - STORE_ROOM],
  );
  const guessLease = (
    await owner.query(
      "INSERT INTO storage_ledger.blob_read_leases(store,team_id,expires_at) VALUES($1,$2,now() + interval '10 minutes') RETURNING id::text AS id",
      [f.stores.seed, f.teams.b],
    )
  ).rows[0].id as string;
  await owner.query(
    `INSERT INTO storage_ledger.blob_read_leases(store,team_id,expires_at)
      SELECT $1, $2 || '-lease-' || g, now() + interval '10 minutes' FROM generate_series(1,5) g`,
    [f.stores.cap, f.prefix],
  );
  return guessLease;
}

/** Recruitment rows for one team, written by the data role under its first member's context. */
async function seedTeam(
  run: Run,
  principal: Principal,
  label: string,
): Promise<TeamRows> {
  const { data, f } = run;
  const team = principal.team;
  const actor = principal.actor;
  return transaction(
    data,
    async () => {
      await installAs(data, run.signer, principal);
      const record = async (kind: string, body: object, owner?: string) =>
        (
          await data.query(
            "INSERT INTO app.records(team_id,kind,data,created_by,private_owner_id) VALUES($1,$2,$3::jsonb,$4,$5) RETURNING id::text AS id",
            [team, kind, JSON.stringify(body), actor, owner ?? null],
          )
        ).rows[0].id as string;
      const candidate = await record("candidate", {
        name: `Fictional candidate ${f.prefix} ${label}`,
      });
      const vacancy = await record("vacancy", {
        title: `Fictional vacancy ${f.prefix} ${label}`,
        requisitionId: `${team}-requisition`,
      });
      const savedView = await record(
        "saved-view",
        { name: `Fictional view ${f.prefix} ${label}` },
        actor,
      );
      await data.query(
        "INSERT INTO app.candidate_states(team_id,user_id,candidate_id,note) VALUES($1,$2,$3,$4)",
        [team, actor, candidate, `Fictional note ${f.prefix}`],
      );
      await data.query(
        "INSERT INTO app.notification_reads(team_id,user_id,key) VALUES($1,$2,$3)",
        [team, actor, `${team}:reminder`],
      );
      await data.query(
        "INSERT INTO app.idempotency(team_id,actor_key,operation,key,payload_hash,response,expires_at) VALUES($1,$2,'fixture',$3,$4,'{}'::jsonb,now() + interval '1 hour')",
        [
          team,
          `session:${actor}`,
          `${team}-idempotency`,
          createHash("sha256").update(team).digest("hex"),
        ],
      );
      for (const [recordId, action, kind] of [
        [candidate, "created", "candidate"],
        [candidate, "personal_state_updated", "candidate"],
        [savedView, "created", "saved-view"],
      ])
        await data.query(
          "INSERT INTO app.activity(team_id,record_id,actor_id,actor_type,action,kind,summary) VALUES($1,$2,$3,'session',$4,$5,$6)",
          [team, recordId, actor, action, kind, `Fictional event ${f.prefix}`],
        );
      await data.query(
        "SELECT tenant_context.lock_storage_allocation('blob','development',$1)",
        [f.stores.seed],
      );
      const upload = (
        await data.query(INSERT_UPLOAD, [
          team,
          candidate,
          `${f.prefix}-${label}-cv.pdf`,
          UPLOAD_BYTES,
          `${f.prefix}/${label}/cv.pdf`,
          f.stores.seed,
          actor,
        ])
      ).rows[0].id as string;
      // One unexpired recovery batch and its reviewed item, holding file metadata and a hash only.
      const batch = (
        await data.query(
          "INSERT INTO app.bulk_intake_batches(id,team_id,created_by,created_at,expires_at) VALUES(gen_random_uuid(),$1,$2,now(),now() + interval '1 hour') RETURNING id::text AS id",
          [team, actor],
        )
      ).rows[0].id as string;
      const item = (
        await data.query(
          "INSERT INTO app.bulk_intake_items(id,team_id,batch_id,created_by,original_name,mime_type,size_bytes,payload_hash,reviewed_at,possible_duplicates,candidate_id,upload_id,created_at,updated_at) VALUES(gen_random_uuid(),$1,$2,$3,$4,'application/pdf',$5,$6,now(),0,$7,$8,now(),now()) RETURNING id::text AS id",
          [
            team,
            batch,
            actor,
            `${f.prefix}-${label}-cv.pdf`,
            UPLOAD_BYTES,
            createHash("sha256").update(`${team}:bulk`).digest("hex"),
            candidate,
            upload,
          ],
        )
      ).rows[0].id as string;
      return { candidate, vacancy, savedView, upload, batch, item };
    },
    true,
  );
}

async function runChecks(run: Run) {
  const { owner, data, data2, identity, identity2, signer, f, check } = run;
  const p = principals(f);
  await bootstrapRace(run);
  const guessLease = await seedOwnerFixtures(run);
  const a = await seedTeam(run, p.ownerA, "a");
  const b = await seedTeam(run, p.ownerB, "b");
  // The one path that writes api-token activity: the identity role under a session context.
  await transaction(
    identity,
    async () => {
      await installAs(identity, signer, p.ownerA);
      await identity.query(
        "SELECT tenant_context.audit_token($1,'token.created')",
        [f.tokens.live],
      );
    },
    true,
  );
  const baseline = await activityCounts(owner, f);
  const ownRecords = (db: Db, team: string) =>
    count(db, "SELECT count(*)::int AS n FROM app.records WHERE team_id = $1", [
      team,
    ]);

  await check("cross-team-read", (probe) =>
    transaction(data, async () => {
      probe.at("install");
      await installAs(data, signer, p.ownerA);
      probe.at("outcome");
      let own = true;
      let other = true;
      for (const table of APP_TABLES) {
        const { rows } = await data.query(
          `SELECT count(*) FILTER (WHERE team_id = $1)::int AS own, count(*) FILTER (WHERE team_id <> $1)::int AS other FROM app.${table}`,
          [f.teams.a],
        );
        own &&= Number(rows[0].own) > 0;
        other &&= Number(rows[0].other) === 0;
      }
      return probe.all(["outcome", other], ["positive-control", own]);
    }),
  );

  await check("cross-team-write", (probe) =>
    transaction(data, async () => {
      probe.at("install");
      await installAs(data, signer, p.ownerA);
      probe.at("setup");
      await data.query(
        "SELECT tenant_context.lock_storage_allocation('blob','development',$1)",
        [f.stores.seed],
      );
      probe.at("outcome");
      const B = f.teams.b;
      const inserts: [string, unknown[]][] = [
        [
          "INSERT INTO app.records(team_id,kind,data,created_by) VALUES($1,'candidate',$2::jsonb,$3)",
          [B, JSON.stringify({ name: `Fictional ${f.prefix}` }), f.users.a1],
        ],
        [
          "INSERT INTO app.candidate_states(team_id,user_id,candidate_id) VALUES($1,$2,$3)",
          [B, f.users.a1, b.candidate],
        ],
        [
          "INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary) VALUES($1,$2,'session','created','candidate',$3)",
          [B, f.users.a1, `Fictional event ${f.prefix}`],
        ],
        [
          INSERT_UPLOAD,
          [
            B,
            b.candidate,
            `${f.prefix}-cross.pdf`,
            UPLOAD_BYTES,
            `${f.prefix}/cross/cv.pdf`,
            f.stores.seed,
            f.users.a1,
          ],
        ],
        ["INSERT INTO app.storage_usage(team_id) VALUES($1)", [B]],
        [
          "INSERT INTO app.idempotency(team_id,actor_key,operation,key,payload_hash,response,expires_at) VALUES($1,$2,'fixture',$3,$4,'{}'::jsonb,now() + interval '1 hour')",
          [B, `session:${f.users.a1}`, `${B}-cross`, "0".repeat(64)],
        ],
        [
          "INSERT INTO app.notification_reads(team_id,user_id,key) VALUES($1,$2,$3)",
          [B, f.users.a1, `${B}:cross`],
        ],
        [
          "INSERT INTO app.bulk_intake_batches(id,team_id,created_by,created_at,expires_at) VALUES(gen_random_uuid(),$1,$2,now(),now() + interval '1 hour')",
          [B, f.users.a1],
        ],
        [
          "INSERT INTO app.bulk_intake_items(id,team_id,batch_id,created_by,original_name,mime_type,size_bytes,payload_hash,created_at,updated_at) VALUES(gen_random_uuid(),$1,$2,$3,$4,'application/pdf',$5,$6,now(),now())",
          [
            B,
            b.batch,
            f.users.a1,
            `${f.prefix}-cross-bulk.pdf`,
            UPLOAD_BYTES,
            "0".repeat(64),
          ],
        ],
      ];
      const conditions: Condition[] = [];
      for (const [text, params] of inserts)
        conditions.push(denial(await attempt(data, text, params)));
      for (const table of APP_TABLES) {
        conditions.push(
          leftAlone(
            await attempt(
              data,
              `UPDATE app.${table} SET team_id = team_id WHERE team_id = $1`,
              [B],
            ),
          ),
        );
        conditions.push(
          leftAlone(
            await attempt(data, `DELETE FROM app.${table} WHERE team_id = $1`, [
              B,
            ]),
          ),
        );
      }
      probe.at("positive-control");
      const own = await attempt(
        data,
        "UPDATE app.records SET updated_at = updated_at WHERE id = $1",
        [a.candidate],
      );
      return probe.all(
        ...conditions,
        outcomeIs(own.ok && own.count === 1, own, "positive-control"),
      );
    }),
  );

  await check("identifier-guessing", async (probe) => {
    const guessed = await transaction(data, async () => {
      probe.at("install");
      await installAs(data, signer, p.ownerA);
      probe.at("outcome");
      const ids = [b.candidate, b.vacancy, b.savedView];
      const conditions: Condition[] = [
        [
          "outcome",
          (await count(
            data,
            "SELECT count(*)::int AS n FROM app.records WHERE id = ANY($1::uuid[])",
            [ids],
          )) === 0,
        ],
        [
          "outcome",
          (await count(
            data,
            "SELECT count(*)::int AS n FROM app.uploads WHERE id = $1",
            [b.upload],
          )) === 0,
        ],
        [
          "outcome",
          (await count(
            data,
            "SELECT count(*)::int AS n FROM app.bulk_intake_batches WHERE id = $1",
            [b.batch],
          )) === 0,
        ],
        [
          "outcome",
          (await count(
            data,
            "SELECT count(*)::int AS n FROM app.bulk_intake_items WHERE id = $1",
            [b.item],
          )) === 0,
        ],
      ];
      for (const [text, params] of [
        [
          "UPDATE app.records SET data = data WHERE id = ANY($1::uuid[])",
          [ids],
        ],
        ["DELETE FROM app.records WHERE id = ANY($1::uuid[])", [ids]],
        [
          "UPDATE app.uploads SET original_name = original_name WHERE id = $1",
          [b.upload],
        ],
        ["DELETE FROM app.uploads WHERE id = $1", [b.upload]],
        [
          "UPDATE app.bulk_intake_batches SET expires_at = expires_at WHERE id = $1",
          [b.batch],
        ],
        ["DELETE FROM app.bulk_intake_batches WHERE id = $1", [b.batch]],
        [
          "UPDATE app.bulk_intake_items SET original_name = original_name WHERE id = $1",
          [b.item],
        ],
        ["DELETE FROM app.bulk_intake_items WHERE id = $1", [b.item]],
      ] as [string, unknown[]][])
        conditions.push(leftAlone(await attempt(data, text, params)));
      const application = (candidate: string, vacancy: string) =>
        attempt(
          data,
          "INSERT INTO app.records(team_id,kind,data,created_by,candidate_id,vacancy_id) VALUES($1,'application',$2::jsonb,$3,$4,$5)",
          [
            f.teams.a,
            JSON.stringify({ stage: `Fictional ${f.prefix}` }),
            f.users.a1,
            candidate,
            vacancy,
          ],
        );
      const otherApplication = await application(b.candidate, b.vacancy);
      const ownApplication = await application(a.candidate, a.vacancy);
      conditions.push(
        outcomeIs(!otherApplication.ok, otherApplication),
        outcomeIs(ownApplication.ok, ownApplication, "positive-control"),
      );
      await data.query(
        "SELECT tenant_context.lock_storage_allocation('blob','development',$1)",
        [f.stores.seed],
      );
      const reserve = (candidate: string, key: string) =>
        attempt(data, INSERT_UPLOAD, [
          f.teams.a,
          candidate,
          `${f.prefix}-guess.pdf`,
          UPLOAD_BYTES,
          `${f.prefix}/guess/${key}`,
          f.stores.seed,
          f.users.a1,
        ]);
      const otherUpload = await reserve(b.candidate, "other");
      const ownUpload = await reserve(a.candidate, "own");
      return probe.all(
        ...conditions,
        outcomeIs(!otherUpload.ok, otherUpload),
        outcomeIs(ownUpload.ok, ownUpload, "positive-control"),
      );
    });
    probe.at("positive-control");
    const ownLease = await transaction(
      data,
      async () => {
        await installAs(data, signer, p.ownerA);
        await data.query("SELECT tenant_context.release_blob_read($1)", [
          guessLease,
        ]);
        const { rows } = await data.query(
          "SELECT tenant_context.acquire_blob_read($1)::text AS lease",
          [f.stores.seed],
        );
        return rows[0].lease as string | null;
      },
      true,
    );
    if (!ownLease) return probe.all(["positive-control", false]);
    await transaction(
      data,
      async () => {
        await installAs(data, signer, p.ownerA);
        await data.query("SELECT tenant_context.release_blob_read($1)", [
          ownLease,
        ]);
      },
      true,
    );
    probe.at("end-state");
    const leases = await owner.query(
      "SELECT id::text AS id FROM storage_ledger.blob_read_leases WHERE id = ANY($1::uuid[])",
      [[guessLease, ownLease]],
    );
    return (
      guessed &&
      probe.all([
        "end-state",
        leases.rows.length === 1 && leases.rows[0].id === guessLease,
      ])
    );
  });

  // A valid install afterwards on the same connection is the positive control for each forgery.
  const forged = (
    id: string,
    forge: () => Promise<{ payload: string; signature: string }>,
  ) =>
    check(id, (probe) =>
      transaction(data, async () => {
        const assertion = await forge();
        probe.at("outcome");
        const rejected = await attempt(data, installSql, [
          assertion.payload,
          assertion.signature,
        ]);
        probe.at("positive-control");
        await installAs(data, signer, p.ownerA);
        return probe.all(denial(rejected), [
          "positive-control",
          (await ownRecords(data, f.teams.a)) > 0,
        ]);
      }),
    );
  await check("forged-settings", (probe) =>
    transaction(data, async () => {
      await data.query(
        "SELECT set_config('app.team_id',$1,true), set_config('app.user_id',$2,true)",
        [f.teams.a, f.users.a1],
      );
      probe.at("outcome");
      let unseen = true;
      for (const table of APP_TABLES)
        unseen &&=
          (await count(data, `SELECT count(*)::int AS n FROM app.${table}`)) ===
          0;
      const insert = await attempt(
        data,
        "INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary) VALUES($1,$2,'session','created','candidate',$3)",
        [f.teams.a, f.users.a1, `Fictional event ${f.prefix}`],
      );
      const batch = await attempt(
        data,
        "INSERT INTO app.bulk_intake_batches(id,team_id,created_by,created_at,expires_at) VALUES(gen_random_uuid(),$1,$2,now(),now() + interval '1 hour')",
        [f.teams.a, f.users.a1],
      );
      probe.at("positive-control");
      await installAs(data, signer, p.ownerA);
      return probe.all(["outcome", unseen], denial(insert), denial(batch), [
        "positive-control",
        (await ownRecords(data, f.teams.a)) > 0,
      ]);
    }),
  );
  await forged("forged-signature", async () => {
    const assertion = await assertionFor(data, signer, p.ownerA);
    const last = assertion.signature.at(-1) === "0" ? "1" : "0";
    return {
      payload: assertion.payload,
      signature: assertion.signature.slice(0, -1) + last,
    };
  });
  await forged("forged-key", async () => {
    const { payload } = await assertionFor(data, signer, p.ownerA);
    return { payload, signature: sign(payload, randomBytes(32)) };
  });
  await forged("expired-assertion", () =>
    assertionFor(data, signer, p.ownerA, -1000),
  );

  let replayed: { payload: string; signature: string } | undefined;
  await check("replay-other-connection", async (probe) => {
    let replay: Outcome | undefined;
    let other = false;
    // Both backends come from the in-transaction snapshots their own assertions were signed for.
    let backends = [Number.NaN, Number.NaN];
    const own = await transaction(
      data,
      async () => {
        probe.at("install");
        const assertion = await installAs(data, signer, p.ownerA);
        replayed = assertion;
        other = await transaction(data2, async () => {
          probe.at("outcome");
          replay = await attempt(data2, installSql, [
            assertion.payload,
            assertion.signature,
          ]);
          probe.at("positive-control");
          const fallback = await installAs(data2, signer, p.ownerA);
          backends = [assertion.pid, fallback.pid];
          return (await ownRecords(data2, f.teams.a)) > 0;
        });
        return (await ownRecords(data, f.teams.a)) > 0;
      },
      true,
    );
    return probe.all(
      ["backend-identity", distinct(backends)],
      outcomeIs(replay !== undefined && denied(replay), replay),
      ["positive-control", other && own],
    );
  });
  // The assertion committed above, installed again in a later transaction on the same backend.
  await check("replay-later-transaction", async (probe) => {
    const assertion = replayed;
    if (!assertion) return false;
    return transaction(data, async () => {
      probe.at("outcome");
      const rejected = await attempt(data, installSql, [
        assertion.payload,
        assertion.signature,
      ]);
      probe.at("positive-control");
      await installAs(data, signer, p.ownerA);
      return probe.all(denial(rejected), [
        "positive-control",
        (await ownRecords(data, f.teams.a)) > 0,
      ]);
    });
  });

  await check("savepoint-replay", (probe) =>
    transaction(data, async () => {
      probe.at("install");
      const first = await installAs(data, signer, p.ownerA);
      probe.at("outcome");
      await data.query("SAVEPOINT replay");
      const again = await attempt(data, installSql, [
        first.payload,
        first.signature,
      ]);
      await data.query("ROLLBACK TO SAVEPOINT replay");
      const fresh = await assertionFor(data, signer, p.ownerB);
      const second = await attempt(data, installSql, [
        fresh.payload,
        fresh.signature,
      ]);
      const replay = await attempt(data, installSql, [
        first.payload,
        first.signature,
      ]);
      return probe.all(
        denial(again),
        denial(second),
        denial(replay),
        ["positive-control", (await ownRecords(data, f.teams.a)) > 0],
        ["outcome", (await ownRecords(data, f.teams.b)) === 0],
      );
    }),
  );

  await check("pooled-connection-reuse", async (probe) => {
    const pool = new Pool({ ...clientConfig(run.dataUrl), max: 1 });
    pool.on("error", () => {});
    try {
      const first = await pool.connect();
      // Each pid is read inside its transaction: the first from its signed snapshot.
      let firstPid = Number.NaN;
      let granted: boolean;
      try {
        probe.at("install");
        granted = await transaction(
          first,
          async () => {
            firstPid = (await installAs(first, signer, p.ownerA)).pid;
            probe.at("positive-control");
            return (await ownRecords(first, f.teams.a)) > 0;
          },
          true,
        );
      } finally {
        first.release();
      }
      probe.at("outcome");
      const next = await pool.connect();
      try {
        let nextPid = Number.NaN;
        let unseen = true;
        await transaction(next, async () => {
          nextPid = await backendPid(next);
          for (const table of APP_TABLES)
            unseen &&=
              (await count(
                next,
                `SELECT count(*)::int AS n FROM app.${table}`,
              )) === 0;
        });
        return probe.all(
          ["positive-control", granted],
          ["backend-identity", nextPid === firstPid],
          ["outcome", unseen],
        );
      } finally {
        next.release();
      }
    } finally {
      await pool.end();
    }
  });

  // The app's deadline statement on the data role, with no fixture rows. Each setting is read
  // inside a transaction, the only place a transaction pooler pins one backend.
  await check("transaction-deadlines", async (probe) => {
    const settings =
      "SELECT current_setting('statement_timeout') AS statement, current_setting('transaction_timeout') AS transaction";
    const app = {
      statement: `${APP_STATEMENT_TIMEOUT_MS / 1000}s`,
      transaction: `${APP_TRANSACTION_TIMEOUT_MS / 1000}s`,
    };
    const same = (row: Row, expected: Row) =>
      row.statement === expected.statement &&
      row.transaction === expected.transaction;
    const pool = new Pool({ ...clientConfig(run.dataUrl), max: 1 });
    pool.on("error", () => {});
    const conditions: Condition[] = [];
    try {
      const reused = await pool.connect();
      try {
        const before = await transaction(
          reused,
          async () => (await reused.query(settings)).rows[0],
        );
        conditions.push(["setup", !same(before, app)]);
        probe.at("install");
        let firstPid = Number.NaN;
        const applied = await transaction(
          reused,
          async () => {
            await reused.query(DEADLINES_SQL);
            firstPid = await backendPid(reused);
            return (await reused.query(settings)).rows[0];
          },
          true,
        );
        conditions.push(["install", same(applied, app)]);
        probe.at("outcome");
        const cancelled = await transaction(reused, async () => {
          await reused.query(DEADLINES_SQL);
          await reused.query("SET LOCAL statement_timeout = '100ms'");
          return settle(reused.query("SELECT pg_sleep(1)"));
        });
        conditions.push(failsWith(cancelled, "57014"));
        probe.at("end-state");
        let nextPid = Number.NaN;
        const after = await transaction(reused, async () => {
          nextPid = await backendPid(reused);
          return (await reused.query(settings)).rows[0];
        });
        conditions.push(
          ["backend-identity", nextPid === firstPid],
          ["end-state", same(after, before)],
        );
      } finally {
        reused.release();
      }
    } finally {
      await pool.end();
    }
    // A transaction timeout ends the whole session, so it runs on its own discarded connection.
    probe.at("outcome");
    const dedicated = connect(run.dataUrl);
    try {
      await dedicated.connect();
      await dedicated.query("BEGIN");
      await dedicated.query("SET LOCAL transaction_timeout = '200ms'");
      const ended = await settle(dedicated.query("SELECT pg_sleep(1)"));
      // A closed connection refuses the next statement without a SQLSTATE.
      const next = ended.ok ? ended : await settle(dedicated.query("SELECT 1"));
      conditions.push(
        outcomeIs(
          !ended.ok &&
            (ended.code === "25P04" || (!next.ok && next.code === undefined)),
          ended,
        ),
      );
    } finally {
      await dedicated.end().catch(() => {});
    }
    return probe.all(...conditions);
  });

  // The second member of team A against the first member's private rows; both are positive-controlled.
  // Each refused statement must fail with an error in the second member's transaction.
  const privateCheck = (
    id: string,
    probes: [string, unknown[]][],
    visible: string,
    own: [string, unknown[]][],
    refused: [string, unknown[]][] = [],
  ) =>
    check(id, async (probe) => {
      const member = await transaction(data, async () => {
        probe.at("install");
        await installAs(data, signer, p.memberA);
        probe.at("outcome");
        const [read, ...writes] = probes;
        const conditions: Condition[] = [
          ["outcome", (await count(data, read[0], read[1])) === 0],
        ];
        for (const [text, params] of writes)
          conditions.push(leftAlone(await attempt(data, text, params)));
        for (const [text, params] of refused) {
          const outcome = await attempt(data, text, params);
          conditions.push(outcomeIs(!outcome.ok, outcome));
        }
        probe.at("positive-control");
        const visibleRows = await count(data, visible, [f.teams.a]);
        const marker = await attempt(
          data,
          "INSERT INTO app.notification_reads(team_id,user_id,key) VALUES($1,$2,$3)",
          [f.teams.a, f.users.a2, `${f.teams.a}:${id}`],
        );
        return probe.all(
          ...conditions,
          ["positive-control", visibleRows > 0],
          outcomeIs(marker.ok, marker, "positive-control"),
        );
      });
      const owner = await transaction(data, async () => {
        probe.at("install");
        await installAs(data, signer, p.ownerA);
        probe.at("positive-control");
        const conditions: Condition[] = [
          [
            "positive-control",
            (await count(data, probes[0][0], probes[0][1])) > 0,
          ],
        ];
        for (const [text, params] of own) {
          const outcome = await attempt(data, text, params);
          conditions.push(
            outcomeIs(
              outcome.ok && outcome.count > 0,
              outcome,
              "positive-control",
            ),
          );
        }
        return probe.all(...conditions);
      });
      return member && owner;
    });
  const a1 = f.users.a1;
  await privateCheck(
    "private-candidate-states",
    [
      [
        "SELECT count(*)::int AS n FROM app.candidate_states WHERE user_id = $1",
        [a1],
      ],
      ["UPDATE app.candidate_states SET note = note WHERE user_id = $1", [a1]],
      ["DELETE FROM app.candidate_states WHERE user_id = $1", [a1]],
    ],
    "SELECT count(*)::int AS n FROM app.records WHERE team_id = $1 AND kind = 'candidate'",
    [
      ["UPDATE app.candidate_states SET note = note WHERE user_id = $1", [a1]],
      ["DELETE FROM app.candidate_states WHERE user_id = $1", [a1]],
    ],
  );
  await privateCheck(
    "private-saved-views",
    [
      [
        "SELECT count(*)::int AS n FROM app.records WHERE id = $1",
        [a.savedView],
      ],
      ["UPDATE app.records SET data = data WHERE id = $1", [a.savedView]],
      ["DELETE FROM app.records WHERE id = $1", [a.savedView]],
    ],
    "SELECT count(*)::int AS n FROM app.records WHERE team_id = $1 AND kind = 'candidate'",
    // The data role holds no DELETE on records, so the owner's control is read and update.
    [["UPDATE app.records SET data = data WHERE id = $1", [a.savedView]]],
  );
  await privateCheck(
    "private-reminder-reads",
    [
      [
        "SELECT count(*)::int AS n FROM app.notification_reads WHERE user_id = $1",
        [a1],
      ],
      [
        "UPDATE app.notification_reads SET read_at = read_at WHERE user_id = $1",
        [a1],
      ],
      ["DELETE FROM app.notification_reads WHERE user_id = $1", [a1]],
    ],
    "SELECT count(*)::int AS n FROM app.records WHERE team_id = $1 AND kind = 'candidate'",
    [
      [
        "UPDATE app.notification_reads SET read_at = read_at WHERE user_id = $1",
        [a1],
      ],
      ["DELETE FROM app.notification_reads WHERE user_id = $1", [a1]],
    ],
  );
  // Activity is append-only for everyone, so the owner's control is the read.
  await privateCheck(
    "private-activity",
    [
      [
        "SELECT count(*)::int AS n FROM app.activity WHERE actor_id = $1 AND (action = 'personal_state_updated' OR kind = 'saved-view')",
        [a1],
      ],
      [
        "UPDATE app.activity SET summary = summary WHERE actor_id = $1 AND (action = 'personal_state_updated' OR kind = 'saved-view')",
        [a1],
      ],
      [
        "DELETE FROM app.activity WHERE actor_id = $1 AND (action = 'personal_state_updated' OR kind = 'saved-view')",
        [a1],
      ],
    ],
    "SELECT count(*)::int AS n FROM app.activity WHERE team_id = $1 AND action = 'created' AND kind = 'candidate'",
    [],
  );
  const teamCandidates =
    "SELECT count(*)::int AS n FROM app.records WHERE team_id = $1 AND kind = 'candidate'";
  await privateCheck(
    "private-bulk-batches",
    [
      [
        "SELECT count(*)::int AS n FROM app.bulk_intake_batches WHERE id = $1",
        [a.batch],
      ],
      [
        "UPDATE app.bulk_intake_batches SET expires_at = expires_at WHERE id = $1",
        [a.batch],
      ],
      ["DELETE FROM app.bulk_intake_batches WHERE id = $1", [a.batch]],
    ],
    teamCandidates,
    [
      [
        "UPDATE app.bulk_intake_batches SET expires_at = expires_at WHERE id = $1",
        [a.batch],
      ],
      ["DELETE FROM app.bulk_intake_batches WHERE id = $1", [a.batch]],
    ],
  );
  // An item belongs to its batch's creator: the second member cannot add one to the first's batch.
  const memberItem = (createdBy: string): [string, unknown[]] => [
    "INSERT INTO app.bulk_intake_items(id,team_id,batch_id,created_by,original_name,mime_type,size_bytes,payload_hash,created_at,updated_at) VALUES(gen_random_uuid(),$1,$2,$3,$4,'application/pdf',$5,$6,now(),now())",
    [
      f.teams.a,
      a.batch,
      createdBy,
      `${f.prefix}-member-bulk.pdf`,
      UPLOAD_BYTES,
      "0".repeat(64),
    ],
  ];
  await privateCheck(
    "private-bulk-items",
    [
      [
        "SELECT count(*)::int AS n FROM app.bulk_intake_items WHERE id = $1",
        [a.item],
      ],
      [
        "UPDATE app.bulk_intake_items SET original_name = original_name WHERE id = $1",
        [a.item],
      ],
      ["DELETE FROM app.bulk_intake_items WHERE id = $1", [a.item]],
    ],
    teamCandidates,
    [
      [
        "UPDATE app.bulk_intake_items SET original_name = original_name WHERE id = $1",
        [a.item],
      ],
      ["DELETE FROM app.bulk_intake_items WHERE id = $1", [a.item]],
    ],
    [memberItem(f.users.a2), memberItem(a1)],
  );

  const identityRows = () =>
    transaction(owner, async () => {
      const { rows } = await owner.query(
        `SELECT (SELECT count(*) FROM auth.api_tokens WHERE team_id LIKE $1)::int AS tokens,
          (SELECT count(*) FROM auth.member WHERE organization_id LIKE $1)::int AS members,
          (SELECT string_agg(id || ':' || role, ',' ORDER BY id) FROM auth.member WHERE organization_id LIKE $1) AS roles`,
        [f.pattern],
      );
      return JSON.stringify(rows[0]);
    });
  await check("data-role-identity-writes", async (probe) => {
    const before = await identityRows();
    const pass = await transaction(data, async () => {
      probe.at("install");
      await installAs(data, signer, p.ownerA);
      probe.at("outcome");
      const conditions: Condition[] = [];
      for (const [text, params] of [
        [
          "INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$1,'[]'::jsonb,now() + interval '1 hour')",
          [
            `${f.prefix}-token-forged`,
            f.teams.a,
            a1,
            `Fictional token ${f.prefix}`,
            "0".repeat(64),
          ],
        ],
        [
          "INSERT INTO auth.member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",
          [`${f.prefix}-member-forged`, f.teams.a, f.users.b1],
        ],
        [
          "UPDATE auth.member SET role = 'owner' WHERE organization_id = $1",
          [f.teams.a],
        ],
        ["DELETE FROM auth.member WHERE organization_id = $1", [f.teams.a]],
        [
          "SELECT tenant_context.audit_token($1,'token.created')",
          [f.tokens.live],
        ],
      ] as [string, unknown[]][])
        conditions.push(denial(await attempt(data, text, params)));
      probe.at("positive-control");
      return probe.all(...conditions, [
        "positive-control",
        (await ownRecords(data, f.teams.a)) > 0,
      ]);
    });
    probe.at("end-state");
    return pass && probe.all(["end-state", (await identityRows()) === before]);
  });

  await check("identity-role-candidate-reads", (probe) =>
    transaction(identity, async () => {
      probe.at("install");
      await installAs(identity, signer, p.ownerA);
      probe.at("positive-control");
      const members = await count(
        identity,
        "SELECT count(*)::int AS n FROM auth.member WHERE organization_id = $1",
        [f.teams.a],
      );
      probe.at("outcome");
      const records = await attempt(
        identity,
        "SELECT count(*) FROM app.records",
      );
      const states = await attempt(
        identity,
        "SELECT count(*) FROM app.candidate_states",
      );
      return probe.all(
        ["positive-control", members > 0],
        denial(records),
        denial(states),
      );
    }),
  );

  // The company workspace tables (0028): the owner, its triggers and its helper write them.
  const workspaceRows = () =>
    transaction(owner, async () => {
      const { rows } = await owner.query(
        `SELECT (SELECT string_agg(row_to_json(w)::text, ',' ORDER BY w.id) FROM app.workspaces w) AS workspaces,
          (SELECT string_agg(row_to_json(t)::text, ',' ORDER BY t.team_id) FROM app.workspace_teams t) AS teams,
          (SELECT string_agg(row_to_json(a)::text, ',' ORDER BY a.workspace_id, a.user_id) FROM app.workspace_admins a) AS admins,
          (SELECT count(*) FROM app.activity WHERE team_id LIKE $1 AND kind = 'workspace-authority')::int AS audits`,
        [f.pattern],
      );
      return JSON.stringify(rows[0]);
    });
  const workspaceWrites: [string, unknown[]][] = [
    [
      "INSERT INTO app.workspaces(id,name) VALUES(gen_random_uuid(),$1)",
      [`Fictional company ${f.prefix}`],
    ],
    ["UPDATE app.workspaces SET name = name", []],
    ["DELETE FROM app.workspaces WHERE id = $1::uuid", [COMPANY_WORKSPACE]],
    [
      "INSERT INTO app.workspace_teams(team_id,workspace_id) VALUES($1,$2::uuid)",
      [`${f.prefix}-team-forged`, COMPANY_WORKSPACE],
    ],
    [
      "UPDATE app.workspace_teams SET workspace_id = workspace_id WHERE team_id = $1",
      [f.teams.a],
    ],
    ["DELETE FROM app.workspace_teams WHERE team_id = $1", [f.teams.a]],
    [
      "INSERT INTO app.workspace_admins(workspace_id,user_id,level) VALUES($1::uuid,$2,'owner')",
      [COMPANY_WORKSPACE, f.users.b1],
    ],
    [
      "UPDATE app.workspace_admins SET plan_access = true WHERE user_id LIKE $1",
      [f.pattern],
    ],
    ["DELETE FROM app.workspace_admins WHERE user_id LIKE $1", [f.pattern]],
  ];
  await check("workspace-write-denied", async (probe) => {
    const before = await workspaceRows();
    const dataPass = await transaction(data, async () => {
      probe.at("install");
      await installAs(data, signer, p.ownerA);
      probe.at("outcome");
      const conditions: Condition[] = [];
      for (const [text, params] of workspaceWrites)
        conditions.push(denial(await attempt(data, text, params)));
      probe.at("positive-control");
      return probe.all(...conditions, [
        "positive-control",
        (await count(
          data,
          "SELECT count(*)::int AS n FROM app.workspace_teams WHERE team_id = $1",
          [f.teams.a],
        )) === 1,
      ]);
    });
    const identityPass = await transaction(identity, async () => {
      probe.at("outcome");
      const conditions: Condition[] = [];
      for (const [text, params] of workspaceWrites)
        conditions.push(denial(await attempt(identity, text, params)));
      return probe.all(...conditions);
    });
    probe.at("end-state");
    return (
      dataPass &&
      identityPass &&
      probe.all(["end-state", (await workspaceRows()) === before])
    );
  });

  await check("workspace-authority-team-owner", async (probe) => {
    const before = await workspaceRows();
    const pass = await transaction(
      data,
      async () => {
        probe.at("install");
        await installAs(data, signer, p.ownerB);
        probe.at("outcome");
        const refused = await attempt(
          data,
          "SELECT tenant_context.set_workspace_authority($1,'admin',ARRAY['fields'],true)",
          [f.users.b2],
        );
        probe.at("positive-control");
        return probe.all(failsWith(refused, "42501"), [
          "positive-control",
          (await ownRecords(data, f.teams.b)) > 0,
        ]);
      },
      true,
    );
    probe.at("end-state");
    return pass && probe.all(["end-state", (await workspaceRows()) === before]);
  });

  // install derives the workspace and company authority from owner-written rows (0029).
  const mappedWorkspace = async (team: string) =>
    (
      await owner.query(
        "SELECT workspace_id::text AS id FROM app.workspace_teams WHERE team_id = $1",
        [team],
      )
    ).rows[0]?.id as string | undefined;
  const noCompanyAuthority = (access: Access) =>
    access.companyLevel === null &&
    Array.isArray(access.companyAreas) &&
    access.companyAreas.length === 0;
  await check("forged-workspace", async (probe) => {
    const mapped = await mappedWorkspace(f.teams.b);
    return transaction(data, async () => {
      probe.at("outcome");
      const claim = JSON.parse(
        (await assertionFor(data, signer, p.ownerB)).payload,
      ) as Row;
      const rejected: Outcome[] = [];
      for (const extra of [
        { workspace: randomUUID() },
        { companyLevel: "owner", companyAreas: ["fields"] },
      ]) {
        const payload = JSON.stringify({ ...claim, ...extra });
        rejected.push(
          await attempt(data, installSql, [payload, sign(payload, signer.key)]),
        );
      }
      probe.at("positive-control");
      const { access } = await installAs(data, signer, p.ownerB);
      return probe.all(...rejected.map(denial), [
        "positive-control",
        mapped !== undefined &&
          access.workspaceId === mapped &&
          noCompanyAuthority(access),
      ]);
    });
  });

  await check("workspace-mapping-missing", async (probe) => {
    const removed = await owner.query(
      "DELETE FROM app.workspace_teams WHERE team_id = $1 RETURNING workspace_id::text AS id",
      [f.teams.c],
    );
    const mapped = removed.rows[0]?.id as string | undefined;
    let rejected: Outcome | undefined;
    try {
      rejected = await transaction(data, async () => {
        probe.at("outcome");
        const assertion = await assertionFor(data, signer, p.ownerC);
        return attempt(data, installSql, [
          assertion.payload,
          assertion.signature,
        ]);
      });
    } finally {
      if (mapped !== undefined)
        await owner.query(
          "INSERT INTO app.workspace_teams(team_id,workspace_id) VALUES($1,$2::uuid)",
          [f.teams.c, mapped],
        );
    }
    probe.at("positive-control");
    const restored = await transaction(
      data,
      async () =>
        (await installAs(data, signer, p.ownerC)).access.workspaceId === mapped,
    );
    return probe.all(
      ["setup", removed.rowCount === 1 && mapped !== undefined],
      failsWith(rejected, "42501"),
      ["positive-control", restored],
    );
  });

  await check("workspace-authority-none", async (probe) => {
    const rows = await count(
      owner,
      "SELECT count(*)::int AS n FROM app.workspace_admins WHERE user_id = $1",
      [f.users.b1],
    );
    probe.at("install");
    const installed = await transaction(
      data,
      () => installAs(data, signer, p.ownerB),
      true,
    );
    probe.at("end-state");
    // Committed context rows stay until purged; the owner reads this transaction's row.
    const stored = (
      await owner.query(
        "SELECT workspace_id::text AS workspace, member_role, company_level, company_areas, plan_access FROM tenant_context.contexts WHERE pid = $1 AND xid = $2::xid8",
        [installed.pid, installed.xid],
      )
    ).rows;
    return probe.all(
      ["setup", rows === 0],
      [
        "outcome",
        noCompanyAuthority(installed.access) &&
          installed.access.memberRole === "owner" &&
          installed.access.workspaceId === (await mappedWorkspace(f.teams.b)),
      ],
      [
        "end-state",
        stored.length === 1 &&
          stored[0].workspace === installed.access.workspaceId &&
          stored[0].member_role === "owner" &&
          stored[0].company_level === null &&
          Array.isArray(stored[0].company_areas) &&
          (stored[0].company_areas as unknown[]).length === 0 &&
          stored[0].plan_access === false,
      ],
    );
  });

  /**
   * Each directory or plan scope on top of the principal's own is refused, each in its own
   * transaction; the principal's own scopes are then accepted.
   */
  const ceilingHolds = async (probe: Probe, principal: Principal) => {
    probe.at("outcome");
    const rejected: Outcome[] = [];
    for (const scope of CEILING_SCOPES)
      rejected.push(
        await transaction(data, async () => {
          const assertion = await assertionFor(data, signer, {
            ...principal,
            scopes: [...principal.scopes, scope],
          });
          return attempt(data, installSql, [
            assertion.payload,
            assertion.signature,
          ]);
        }),
      );
    probe.at("positive-control");
    const { access } = await transaction(data, () =>
      installAs(data, signer, principal),
    );
    return probe.all(...rejected.map(denial), [
      "positive-control",
      JSON.stringify(access.scopes) === JSON.stringify(principal.scopes),
    ]);
  };
  await check("scope-ceiling-recruiter", (probe) =>
    ceilingHolds(probe, p.memberA),
  );
  await check("scope-ceiling-viewer", async (probe) => {
    const setRole = (role: string) =>
      identity.query("UPDATE auth.member SET role = $2 WHERE id = $1", [
        f.members.a2,
        role,
      ]);
    probe.at("setup");
    const changed = await setRole("viewer");
    let held: boolean;
    let restored: number | null;
    try {
      held =
        probe.all(["setup", changed.rowCount === 1]) &&
        (await ceilingHolds(probe, p.viewerA));
    } finally {
      restored = (await setRole("recruiter")).rowCount;
    }
    probe.at("end-state");
    return probe.all(["end-state", restored === 1]) && held;
  });
  await check("scope-ceiling-owner", (probe) =>
    transaction(data, async () => {
      probe.at("outcome");
      const { access } = await installAs(data, signer, p.ownerA);
      return probe.all([
        "outcome",
        ALL_SCOPES.length === 11 &&
          JSON.stringify(access.scopes) === JSON.stringify(ALL_SCOPES),
      ]);
    }),
  );

  /** A rejected install, then a valid session install and a read on the same connection. */
  const rejectedThenSession = (
    probe: Probe,
    principal: Principal,
    fallback: Principal,
  ) =>
    transaction(data, async () => {
      probe.at("outcome");
      const assertion = await assertionFor(data, signer, principal);
      const rejected = await attempt(data, installSql, [
        assertion.payload,
        assertion.signature,
      ]);
      probe.at("positive-control");
      await installAs(data, signer, fallback);
      return probe.all(denial(rejected), [
        "positive-control",
        (await ownRecords(data, fallback.team)) > 0,
      ]);
    });
  const granted = (probe: Probe, principal: Principal) =>
    transaction(data, async () => {
      probe.at("positive-control");
      await installAs(data, signer, principal);
      return (await ownRecords(data, principal.team)) > 0;
    });
  await check("revoked-token", async (probe) => {
    const before = await granted(probe, p.liveToken);
    probe.at("setup");
    const revoked = await identity.query(
      "UPDATE auth.api_tokens SET revoked_at = now() WHERE id = $1",
      [f.tokens.live],
    );
    return (
      probe.all(
        ["positive-control", before],
        ["setup", revoked.rowCount === 1],
      ) && (await rejectedThenSession(probe, p.liveToken, p.ownerA))
    );
  });
  await check("expired-token", (probe) =>
    rejectedThenSession(probe, p.expiredToken, p.ownerA),
  );
  await check("demoted-owner", async (probe) => {
    const before = await granted(probe, p.demotedB);
    probe.at("setup");
    const demoted = await identity.query(
      "UPDATE auth.member SET role = 'viewer' WHERE id = $1",
      [f.members.b2],
    );
    return (
      probe.all(
        ["positive-control", before],
        ["setup", demoted.rowCount === 1],
      ) && (await rejectedThenSession(probe, p.demotedB, p.viewerB))
    );
  });

  await check("last-owner-race", async (probe) => {
    const owners = () =>
      count(
        owner,
        "SELECT count(*)::int AS n FROM auth.member WHERE organization_id = $1 AND role = 'owner'",
        [f.teams.c],
      );
    const before = await owners();
    await identity.query("BEGIN");
    await identity2.query("BEGIN");
    let removed: Outcome | undefined;
    let demoted: Outcome | undefined;
    let overlapped: boolean | undefined;
    let backends: number[];
    let firstEnded = false;
    try {
      // Each transaction's backend, read inside it before its first statement on the members.
      backends = [await backendPid(identity), await backendPid(identity2)];
      probe.at("outcome");
      const first = await settle(
        identity.query("DELETE FROM auth.member WHERE id = $1", [f.members.c2]),
      );
      removed = first;
      const pending = settle(
        identity2.query("UPDATE auth.member SET role = 'admin' WHERE id = $1", [
          f.members.c1,
        ]),
      );
      try {
        probe.at("lock-overlap");
        overlapped = await waitForWaiters(owner, [backends[1]], 1);
      } finally {
        await identity.query(first.ok ? "COMMIT" : "ROLLBACK");
        firstEnded = true;
      }
      probe.at("outcome");
      demoted = await pending;
    } finally {
      if (!firstEnded) await identity.query("ROLLBACK").catch(() => {});
      // The demotion must fail; it is committed only if it unexpectedly succeeded, so the count shows it.
      await identity2.query(demoted?.ok ? "COMMIT" : "ROLLBACK");
    }
    probe.at("end-state");
    return probe.all(
      ["setup", before === 2],
      ["backend-identity", distinct(backends)],
      ["lock-overlap", overlapped === true],
      outcomeIs(removed.ok && removed.count === 1, removed),
      failsWith(demoted, "23514"),
      ["end-state", (await owners()) === 1],
    );
  });

  const sides = [
    { principal: p.ownerA, candidate: a.candidate },
    { principal: p.ownerB, candidate: b.candidate },
  ];
  const side = (index: number) => sides[index % 2];
  await check("store-budget-race", async (probe) => {
    const teamReserved = async () =>
      (
        await owner.query(
          "SELECT coalesce(sum(reserved_bytes),0)::text AS bytes, coalesce(sum(reserved_files),0)::int AS files FROM app.storage_usage WHERE team_id = ANY($1::text[])",
          [[f.teams.a, f.teams.b]],
        )
      ).rows[0];
    const before = await teamReserved();
    const race = await gatedRace(
      run,
      probe,
      run.workers,
      async (client, index, report) => {
        const { principal, candidate } = side(index);
        report((await installAs(client, signer, principal)).pid);
        await client.query(
          "SELECT tenant_context.lock_storage_allocation('blob','development',$1)",
          [f.stores.race],
        );
        const outcome = await settle(
          client.query(INSERT_UPLOAD, [
            principal.team,
            candidate,
            `${f.prefix}-race-${index}.pdf`,
            UPLOAD_BYTES,
            `${f.prefix}/race/${index}`,
            f.stores.race,
            principal.actor,
          ]),
        );
        return { value: outcome, commit: outcome.ok };
      },
    );
    probe.at("end-state");
    const after = await teamReserved();
    const store = (
      await owner.query(
        `SELECT (s.used_bytes + s.reserved_bytes + s.retained_bytes <= b.max_bytes
            AND s.used_files + s.reserved_files + s.retained_files <= b.max_files) AS within,
          s.reserved_bytes::text AS bytes, s.reserved_files AS files,
          (SELECT count(*) FROM app.uploads u WHERE u.storage_store = s.store AND u.status = 'pending')::int AS pending,
          (SELECT coalesce(sum(u.size_bytes),0) FROM app.uploads u WHERE u.storage_store = s.store AND u.status = 'pending')::text AS pending_bytes
        FROM storage_ledger.stores s JOIN storage_ledger.budgets b USING (environment)
        WHERE s.provider = 'blob' AND s.store = $1`,
        [f.stores.race],
      )
    ).rows[0];
    const succeeded = race.values.filter((outcome) => outcome.ok).length;
    const refused = race.values.filter(
      (outcome) => outcome.code === "RQ001",
    ).length;
    // A refusal other than the budget's names its own error; otherwise too many succeeded or too few did.
    const unexpected = race.values.find(
      (outcome) => !outcome.ok && outcome.code !== "RQ001",
    );
    return probe.all(
      ["backend-identity", race.distinct],
      ["lock-overlap", race.overlapped],
      [
        "outcome",
        succeeded === STORE_ROOM && refused === WORKERS - STORE_ROOM,
        unexpected?.error ?? (succeeded > STORE_ROOM ? "assertion" : "RQ001"),
      ],
      [
        "end-state",
        store.within === true &&
          Number(store.files) === STORE_ROOM &&
          Number(store.pending) === STORE_ROOM &&
          store.bytes === store.pending_bytes &&
          Number(after.bytes) - Number(before.bytes) === Number(store.bytes) &&
          Number(after.files) - Number(before.files) === Number(store.files),
      ],
    );
  });

  const leaseRace = async (probe: Probe, store: string) => {
    const race = await gatedRace(
      run,
      probe,
      run.workers,
      async (client, index, report) => {
        const { principal } = side(index);
        report((await installAs(client, signer, principal)).pid);
        const { rows } = await client.query(
          "SELECT tenant_context.acquire_blob_read($1)::text AS lease",
          [store],
        );
        return {
          value: {
            team: principal.team,
            lease: rows[0].lease as string | null,
          },
          commit: true,
        };
      },
    );
    probe.at("end-state");
    const live = (
      await owner.query(
        `SELECT count(*)::int AS total,
          count(*) FILTER (WHERE team_id = $2)::int AS a,
          count(*) FILTER (WHERE team_id = $3)::int AS b
        FROM storage_ledger.blob_read_leases WHERE store = $1 AND expires_at > clock_timestamp()`,
        [store, f.teams.a, f.teams.b],
      )
    ).rows[0];
    const grantedTo = (team: string) =>
      race.values.filter((value) => value.team === team && value.lease).length;
    return {
      race: [
        ["backend-identity", race.distinct],
        ["lock-overlap", race.overlapped],
      ] as Condition[],
      a: grantedTo(f.teams.a),
      b: grantedTo(f.teams.b),
      live: {
        total: Number(live.total),
        a: Number(live.a),
        b: Number(live.b),
      },
    };
  };
  await check("read-lease-team-cap", async (probe) => {
    const race = await leaseRace(probe, f.stores.lease);
    return probe.all(
      ...race.race,
      ["outcome", race.a === 2 && race.b === 2],
      [
        "end-state",
        race.live.a <= 2 && race.live.b <= 2 && race.live.total === 4,
      ],
    );
  });
  await check("read-lease-store-cap", async (probe) => {
    const race = await leaseRace(probe, f.stores.cap);
    return probe.all(
      ...race.race,
      ["outcome", race.a <= 2 && race.b <= 2 && race.a + race.b === 3],
      ["end-state", race.live.total === 8],
    );
  });

  await check("denied-mutations-no-audit", async (probe) => {
    probe.at("end-state");
    const end = await activityCounts(owner, f);
    return probe.all(
      ["setup", baseline.private > 0 && baseline.token === 1],
      [
        "end-state",
        end.total === baseline.total &&
          end.private === baseline.private &&
          end.token === baseline.token,
      ],
    );
  });

  // The configuration store (0030). The owner writes the company fixtures directly; every data-role
  // write that would audit is rolled back, after denied-mutations-no-audit.
  const configKey = (name: string) => `${f.prefix}-cfg-${name}`;
  const ownerConfig = async (workspace: string, key: string) => {
    const { rows } = await owner.query(
      "INSERT INTO app.config_objects(workspace_id,type,key,created_by) VALUES($1::uuid,'workflow',$2,$3) RETURNING id::text AS id",
      [workspace, key, f.users.a1],
    );
    const object = rows[0].id as string;
    const version = (
      await owner.query(
        `INSERT INTO app.config_versions(object_id,workspace_id,body,created_by) VALUES($1::uuid,$2::uuid,'{"label":"Fictional workflow"}',$3) RETURNING id::text AS id`,
        [object, workspace, f.users.a1],
      )
    ).rows[0].id as string;
    await owner.query(
      "UPDATE app.config_objects SET draft_version_id = $2::uuid WHERE id = $1::uuid",
      [object, version],
    );
    return { object, version };
  };
  const companyDraft = await ownerConfig(
    COMPANY_WORKSPACE,
    configKey("company"),
  );
  const configRows = (db: Db, column: string, id: string) =>
    count(
      db,
      `SELECT ((SELECT count(*) FROM app.config_objects WHERE ${column} = $1::uuid)
        + (SELECT count(*) FROM app.config_versions WHERE ${column === "id" ? "object_id" : column} = $1::uuid)
        + (SELECT count(*) FROM app.config_layouts l JOIN app.config_versions v ON v.id = l.version_id
            WHERE v.${column === "id" ? "object_id" : column} = $1::uuid))::int AS n`,
      [id],
    );

  await check("config-cross-workspace", async (probe) => {
    probe.at("setup");
    // A second fixture workspace briefly makes team creation fail on this database (D15).
    const other = randomUUID();
    await owner.query(
      "INSERT INTO app.workspaces(id,name) VALUES($1::uuid,$2)",
      [other, `${f.prefix}-workspace`],
    );
    let pass: boolean;
    try {
      const foreign = await ownerConfig(other, configKey("foreign"));
      await owner.query(
        "INSERT INTO app.config_layouts(version_id,workspace_id,layout) VALUES($1::uuid,$2::uuid,'{}')",
        [foreign.version, other],
      );
      const seeded = await configRows(owner, "workspace_id", other);
      pass = await transaction(data, async () => {
        probe.at("install");
        await installAs(data, signer, p.ownerA);
        probe.at("outcome");
        const read = await configRows(data, "workspace_id", other);
        const planted = await attempt(
          data,
          "INSERT INTO app.config_objects(workspace_id,type,key) VALUES($1::uuid,'workflow',$2)",
          [other, configKey("planted")],
        );
        probe.at("positive-control");
        return probe.all(
          ["setup", seeded === 3],
          ["outcome", read === 0],
          denial(planted),
          [
            "positive-control",
            (await configRows(data, "id", companyDraft.object)) === 2,
          ],
        );
      });
    } finally {
      await owner.query(
        "DELETE FROM app.config_objects WHERE workspace_id = $1::uuid",
        [other],
      );
      await owner.query("DELETE FROM app.workspaces WHERE id = $1::uuid", [
        other,
      ]);
    }
    probe.at("end-state");
    return (
      pass &&
      probe.all([
        "end-state",
        (await count(
          owner,
          "SELECT count(*)::int AS n FROM app.workspaces WHERE id = $1::uuid",
          [other],
        )) === 0,
      ])
    );
  });

  await check("config-forged-audit", async (probe) => {
    probe.at("setup");
    // The fixture team A owner becomes company owner; the row goes with the user at cleanup.
    await owner.query(
      "INSERT INTO app.workspace_admins(workspace_id,user_id,level) VALUES($1::uuid,$2,'owner') ON CONFLICT DO NOTHING",
      [COMPANY_WORKSPACE, f.users.a1],
    );
    const audits = (db: Db) =>
      count(
        db,
        "SELECT count(*)::int AS n FROM app.activity WHERE kind = 'config' AND team_id = $1",
        [f.teams.a],
      );
    const pass = await transaction(data, async () => {
      probe.at("install");
      await installAs(data, signer, p.ownerA);
      probe.at("outcome");
      const forged: Outcome[] = [];
      for (const action of [
        "config.draft_created",
        "config.published",
        "config.retired",
        "config.archived",
        "config.layout_changed",
      ])
        forged.push(
          await attempt(
            data,
            "INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary,metadata) VALUES($1,$2,'session',$3,'config','Forged','{}')",
            [f.teams.a, f.users.a1, action],
          ),
        );
      probe.at("positive-control");
      const published = await attempt(
        data,
        "SELECT tenant_context.publish_config_version($1::uuid) AS number",
        [companyDraft.version],
      );
      probe.at("outcome");
      const duplicate = await attempt(
        data,
        "SELECT tenant_context.audit_config($1::uuid,'config.published')",
        [companyDraft.version],
      );
      return probe.all(
        ...forged.map(denial),
        outcomeIs(
          published.ok && published.rows[0]?.number === 1,
          published,
          "positive-control",
        ),
        failsWith(duplicate, "RQ007"),
        ["outcome", (await audits(data)) === 1],
      );
    });
    probe.at("end-state");
    return pass && probe.all(["end-state", (await audits(owner)) === 0]);
  });

  await check("config-team-owner-write", async (probe) => {
    const draftState = () =>
      owner
        .query(
          "SELECT state, note, body::text AS body FROM app.config_versions WHERE id = $1::uuid",
          [companyDraft.version],
        )
        .then(({ rows }) => JSON.stringify(rows));
    const before = await draftState();
    const companyPass = await transaction(data, async () => {
      probe.at("install");
      await installAs(data, signer, p.ownerB);
      probe.at("outcome");
      return probe.all(
        denial(
          await attempt(
            data,
            "INSERT INTO app.config_objects(workspace_id,type,key) VALUES($1::uuid,'workflow',$2)",
            [COMPANY_WORKSPACE, configKey("denied")],
          ),
        ),
        denial(
          await attempt(
            data,
            `INSERT INTO app.config_versions(object_id,workspace_id,body) VALUES($1::uuid,$2::uuid,'{"label":"Denied"}')`,
            [companyDraft.object, COMPANY_WORKSPACE],
          ),
        ),
        leftAlone(
          await attempt(
            data,
            "UPDATE app.config_versions SET note = 'Denied' WHERE id = $1::uuid",
            [companyDraft.version],
          ),
        ),
        leftAlone(
          await attempt(
            data,
            "UPDATE app.config_objects SET archived_at = now() WHERE id = $1::uuid",
            [companyDraft.object],
          ),
        ),
        failsWith(
          await attempt(
            data,
            "SELECT tenant_context.publish_config_version($1::uuid)",
            [companyDraft.version],
          ),
          "42501",
        ),
      );
    });
    // The same owner's own team task board, committed; it goes with team B at cleanup.
    probe.at("positive-control");
    const board = await transaction(
      data,
      async () => {
        await installAs(data, signer, p.ownerB);
        const { rows } = await data.query(
          "INSERT INTO app.config_objects(workspace_id,team_id,type,key) VALUES($1::uuid,$2,'task-board',$3) RETURNING id::text AS id",
          [COMPANY_WORKSPACE, f.teams.b, configKey("board")],
        );
        await data.query(
          `INSERT INTO app.config_versions(object_id,workspace_id,body) VALUES($1::uuid,$2::uuid,'{"label":"Fictional board"}')`,
          [rows[0].id, COMPANY_WORKSPACE],
        );
        return rows[0].id as string;
      },
      true,
    );
    const seen = async (principal: Principal) =>
      transaction(data, async () => {
        await installAs(data, signer, principal);
        return configRows(data, "id", board);
      });
    probe.at("outcome");
    const teamA = await seen(p.ownerA);
    probe.at("positive-control");
    const teamB = await seen(p.ownerB);
    probe.at("end-state");
    return (
      companyPass &&
      probe.all(
        ["outcome", teamA === 0],
        ["positive-control", teamB === 2],
        ["end-state", (await draftState()) === before],
      )
    );
  });

  // Configuration versions through install (0032): the unsigned hint may only drop bodies.
  await check("config-cached-hint", async (probe) => {
    probe.at("setup");
    const ownerPublished = async (
      workspace: string,
      team: string | null,
      key: string,
      label: string,
    ) => {
      const { rows } = await owner.query(
        "INSERT INTO app.config_objects(workspace_id,team_id,type,key,created_by) VALUES($1::uuid,$2,$3,$4,$5) RETURNING id::text AS id",
        [workspace, team, team ? "task-board" : "workflow", key, f.users.a1],
      );
      const object = rows[0].id as string;
      const version = (
        await owner.query(
          "INSERT INTO app.config_versions(object_id,workspace_id,state,number,body,created_by,published_at) VALUES($1::uuid,$2::uuid,'published',1,jsonb_build_object('label',$3::text),$4,now()) RETURNING id::text AS id",
          [object, workspace, label, f.users.a1],
        )
      ).rows[0].id as string;
      await owner.query(
        "UPDATE app.config_objects SET current_version_id = $2::uuid WHERE id = $1::uuid",
        [object, version],
      );
      return { object, version };
    };
    // A second fixture workspace briefly makes team creation fail on this database (D15).
    const other = randomUUID();
    await owner.query(
      "INSERT INTO app.workspaces(id,name) VALUES($1::uuid,$2)",
      [other, `${f.prefix}-workspace`],
    );
    const created: string[] = [];
    let pass: boolean;
    try {
      const labels = {
        foreign: "Fictional foreign workflow",
        board: "Fictional team B board",
      };
      const foreign = await ownerPublished(
        other,
        null,
        configKey("hint-foreign"),
        labels.foreign,
      );
      created.push(foreign.object);
      const board = await ownerPublished(
        COMPANY_WORKSPACE,
        f.teams.b,
        configKey("hint-board"),
        labels.board,
      );
      created.push(board.object);
      const own = await ownerPublished(
        COMPANY_WORKSPACE,
        null,
        configKey("hint-own"),
        "Fictional own workflow",
      );
      created.push(own.object);
      const install = (cached: (string | null)[]) =>
        transaction(data, async () => {
          const assertion = await assertionFor(data, signer, p.ownerA);
          const { rows } = await data.query(
            "SELECT tenant_context.install($1,$2,$3::text[]) AS access",
            [assertion.payload, assertion.signature, cached],
          );
          return rows[0].access as Access;
        });
      probe.at("install");
      const forged = await install([
        foreign.version,
        board.version,
        own.version,
        "fictional-not-a-uuid",
        null,
      ]);
      const empty = await install([]);
      probe.at("outcome");
      const hidden = [
        foreign.object,
        foreign.version,
        board.object,
        board.version,
        labels.foreign,
        labels.board,
      ];
      const leaked = [forged, empty].some((access) =>
        hidden.some((value) => JSON.stringify(access).includes(value)),
      );
      const authority = (access: Access) =>
        JSON.stringify([
          access.scopes,
          access.workspaceId,
          access.memberRole,
          access.companyLevel,
          access.companyAreas,
        ]);
      const listed = (access: Access) =>
        access.documents.map((document) => document.versionId);
      pass = probe.all(
        ["outcome", !leaked],
        ["outcome", authority(forged) === authority(empty)],
        [
          "positive-control",
          forged.versions[own.object] === own.version &&
            empty.versions[own.object] === own.version &&
            listed(empty).includes(own.version) &&
            !listed(forged).includes(own.version),
        ],
      );
    } finally {
      await owner.query(
        "DELETE FROM app.config_objects WHERE id = ANY($1::uuid[]) OR workspace_id = $2::uuid",
        [created, other],
      );
      await owner.query("DELETE FROM app.workspaces WHERE id = $1::uuid", [
        other,
      ]);
    }
    probe.at("end-state");
    return (
      pass &&
      probe.all([
        "end-state",
        (await count(
          owner,
          "SELECT ((SELECT count(*) FROM app.workspaces WHERE id = $1::uuid) + (SELECT count(*) FROM app.config_objects WHERE id = ANY($2::uuid[])))::int AS n",
          [other, created],
        )) === 0,
      ])
    );
  });

  // The organisation hierarchy (0033). The owner writes the fixture levels and units directly, with
  // no context and so no audit: two levels at the two lowest free depths, units coded by the run
  // prefix. The team A owner is company owner (config-forged-audit) and its recruiter becomes a
  // company admin with the organisation area; both rows go with the users at cleanup.
  const orgCode = (name: string) => `${f.prefix}-org-${name}`;
  await owner.query(
    `INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
      ($1::uuid,$2,'owner','{}'), ($1::uuid,$3,'admin','{organisation}') ON CONFLICT DO NOTHING`,
    [COMPANY_WORKSPACE, f.users.a1, f.users.a2],
  );
  const freeDepths = (
    await owner.query(
      "SELECT d FROM generate_series(0, 7) d WHERE NOT EXISTS (SELECT 1 FROM app.org_levels l WHERE l.workspace_id = $1::uuid AND l.depth = d) ORDER BY d DESC LIMIT 2",
      [COMPANY_WORKSPACE],
    )
  ).rows.map((row) => Number(row.d));
  const orgLevel = async (workspace: string, name: string, depth: number) =>
    (
      await owner.query(
        "INSERT INTO app.org_levels(workspace_id,name,depth) VALUES($1::uuid,$2,$3) RETURNING id::text AS id",
        [workspace, `${f.prefix}-${name}`, depth],
      )
    ).rows[0].id as string;
  const orgUnit = async (
    workspace: string,
    level: string,
    code: string,
    parent: string | null = null,
  ) =>
    (
      await owner.query(
        "INSERT INTO app.org_units(workspace_id,parent_id,level_id,name,code) VALUES($1::uuid,$2::uuid,$3::uuid,'Fictional unit',$4) RETURNING id::text AS id",
        [workspace, parent, level, code],
      )
    ).rows[0].id as string;
  const upper = await orgLevel(COMPANY_WORKSPACE, "org-upper", freeDepths[1]);
  const lower = await orgLevel(COMPANY_WORKSPACE, "org-lower", freeDepths[0]);
  const org = {
    p1: await orgUnit(COMPANY_WORKSPACE, upper, orgCode("p1")),
    p2: await orgUnit(COMPANY_WORKSPACE, upper, orgCode("p2")),
    raceA: await orgUnit(COMPANY_WORKSPACE, lower, orgCode("race-a")),
    raceB: await orgUnit(COMPANY_WORKSPACE, upper, orgCode("race-b")),
  };
  const child = await orgUnit(COMPANY_WORKSPACE, lower, orgCode("x"), org.p1);
  // An archived unit frees its code; reusing it under another parent is a scope-moving insert.
  const freed = await orgUnit(COMPANY_WORKSPACE, lower, orgCode("y"), org.p1);
  await owner.query(
    "UPDATE app.org_units SET archived_at = now() WHERE id = $1::uuid",
    [freed],
  );
  /** The fixture units, their closure rows and the team A org and scope activity, as one string. */
  const orgSeen = async (db: Db) =>
    JSON.stringify(
      (
        await db.query(
          `SELECT (SELECT coalesce(json_agg(json_build_object('id', u.id, 'parent', u.parent_id, 'archived', u.archived_at IS NOT NULL) ORDER BY u.id), '[]') FROM app.org_units u WHERE u.code LIKE $1)::text AS units,
            (SELECT coalesce(json_agg(json_build_object('a', c.ancestor_id, 'd', c.descendant_id, 'depth', c.depth) ORDER BY c.ancestor_id, c.descendant_id), '[]')
              FROM app.org_unit_closure c JOIN app.org_units u ON u.id = c.descendant_id WHERE u.code LIKE $1)::text AS closure,
            (SELECT count(*) FROM app.activity a WHERE a.team_id = $2 AND a.kind IN ('org', 'scope'))::int AS audits`,
          [f.pattern, f.teams.a],
        )
      ).rows[0],
    );
  /** The same as the owner, who reads activity only with FORCE RLS lifted in a rolled-back transaction. */
  const orgCommitted = () =>
    transaction(owner, async () => {
      await owner.query("ALTER TABLE app.activity NO FORCE ROW LEVEL SECURITY");
      return orgSeen(owner);
    });
  const orgRows = (db: Db, workspace: string) =>
    count(
      db,
      `SELECT ((SELECT count(*) FROM app.org_levels WHERE workspace_id = $1::uuid)
        + (SELECT count(*) FROM app.org_units WHERE workspace_id = $1::uuid)
        + (SELECT count(*) FROM app.org_unit_closure WHERE workspace_id = $1::uuid))::int AS n`,
      [workspace],
    );

  await check("org-cross-workspace", async (probe) => {
    probe.at("setup");
    // A second fixture workspace briefly makes team creation fail on this database (D15).
    const other = randomUUID();
    await owner.query(
      "INSERT INTO app.workspaces(id,name) VALUES($1::uuid,$2)",
      [other, `${f.prefix}-workspace`],
    );
    let pass: boolean;
    try {
      const level = await orgLevel(other, "org-other", 0);
      await orgUnit(other, level, orgCode("other"));
      const seeded = await orgRows(owner, other);
      pass = await transaction(data, async () => {
        probe.at("install");
        await installAs(data, signer, p.ownerA);
        probe.at("outcome");
        const read = await orgRows(data, other);
        const plantedLevel = await attempt(
          data,
          "INSERT INTO app.org_levels(workspace_id,name,depth) VALUES($1::uuid,$2,1)",
          [other, `${f.prefix}-org-planted`],
        );
        const plantedUnit = await attempt(
          data,
          "INSERT INTO app.org_units(workspace_id,level_id,name,code) VALUES($1::uuid,$2::uuid,'Planted',$3)",
          [other, level, orgCode("planted")],
        );
        probe.at("positive-control");
        return probe.all(
          ["setup", seeded === 3],
          ["outcome", read === 0],
          denial(plantedLevel),
          denial(plantedUnit),
          [
            "positive-control",
            (await orgRows(data, COMPANY_WORKSPACE)) > 0 &&
              (await count(
                data,
                "SELECT count(*)::int AS n FROM app.org_units WHERE id = $1::uuid",
                [org.p1],
              )) === 1,
          ],
        );
      });
    } finally {
      await owner.query(
        "DELETE FROM app.org_units WHERE workspace_id = $1::uuid",
        [other],
      );
      await owner.query(
        "DELETE FROM app.org_levels WHERE workspace_id = $1::uuid",
        [other],
      );
      await owner.query("DELETE FROM app.workspaces WHERE id = $1::uuid", [
        other,
      ]);
    }
    probe.at("end-state");
    return (
      pass &&
      probe.all([
        "end-state",
        (await orgRows(owner, other)) +
          (await count(
            owner,
            "SELECT count(*)::int AS n FROM app.workspaces WHERE id = $1::uuid",
            [other],
          )) ===
          0,
      ])
    );
  });

  await check("org-closure-write-denied", async (probe) => {
    const before = await orgCommitted();
    const pass = await transaction(data, async () => {
      probe.at("install");
      await installAs(data, signer, p.ownerA);
      probe.at("outcome");
      const inserted = await attempt(
        data,
        "INSERT INTO app.org_unit_closure(workspace_id,ancestor_id,descendant_id,depth) VALUES($1::uuid,$2::uuid,$3::uuid,1)",
        [COMPANY_WORKSPACE, org.p2, child],
      );
      const updated = await attempt(
        data,
        "UPDATE app.org_unit_closure SET depth = depth + 1 WHERE descendant_id = $1::uuid",
        [child],
      );
      const deleted = await attempt(
        data,
        "DELETE FROM app.org_unit_closure WHERE descendant_id = $1::uuid",
        [child],
      );
      probe.at("positive-control");
      return probe.all(denial(inserted), denial(updated), denial(deleted), [
        "positive-control",
        (await count(
          data,
          "SELECT count(*)::int AS n FROM app.org_unit_closure WHERE descendant_id = $1::uuid",
          [child],
        )) === 2,
      ]);
    });
    probe.at("end-state");
    return pass && probe.all(["end-state", (await orgCommitted()) === before]);
  });

  await check("org-admin-move-denied", async (probe) => {
    const before = await orgCommitted();
    const adminPass = await transaction(data, async () => {
      probe.at("install");
      // The team A recruiter, a company admin with the organisation area.
      await installAs(data, signer, p.memberA);
      probe.at("outcome");
      const seen = await orgSeen(data);
      const moved = await attempt(
        data,
        "UPDATE app.org_units SET parent_id = $2::uuid WHERE id = $1::uuid",
        [child, org.p2],
      );
      const archived = await attempt(
        data,
        "UPDATE app.org_units SET archived_at = now() WHERE id = $1::uuid",
        [child],
      );
      const reparented = await attempt(
        data,
        "INSERT INTO app.org_units(workspace_id,parent_id,level_id,name,code) VALUES($1::uuid,$2::uuid,$3::uuid,'Fictional unit',$4)",
        [COMPANY_WORKSPACE, org.p2, lower, orgCode("y")],
      );
      // A planted valid_from would reorder the code's rows for the guard; it is never accepted.
      const dated = await attempt(
        data,
        "INSERT INTO app.org_units(workspace_id,parent_id,level_id,name,code,valid_from) VALUES($1::uuid,$2::uuid,$3::uuid,'Fictional unit',$4,'2999-01-01')",
        [COMPANY_WORKSPACE, org.p1, lower, orgCode("dated")],
      );
      const unchanged = (await orgSeen(data)) === seen;
      probe.at("positive-control");
      // The same admin renames the unit; rolled back with the transaction.
      const renamed = await attempt(
        data,
        "UPDATE app.org_units SET name = 'Fictional renamed unit' WHERE id = $1::uuid",
        [child],
      );
      return probe.all(
        denial(moved),
        denial(archived),
        denial(reparented),
        denial(dated),
        ["outcome", unchanged],
        outcomeIs(
          renamed.ok && renamed.count === 1,
          renamed,
          "positive-control",
        ),
      );
    });
    // A company owner session's move is accepted with one org.unit_moved and one scope row.
    probe.at("positive-control");
    const ownerPass = await transaction(data, async () => {
      await installAs(data, signer, p.ownerA);
      const moved = await attempt(
        data,
        "UPDATE app.org_units SET parent_id = $2::uuid WHERE id = $1::uuid",
        [child, org.p2],
      );
      const audits = await count(
        data,
        `SELECT count(*) FILTER (WHERE action = 'org.unit_moved' AND kind = 'org')::int * 10
           + count(*) FILTER (WHERE action = 'scope.home_units_changed' AND kind = 'scope')::int AS n
         FROM app.activity WHERE team_id = $1 AND metadata->>'unitId' = $2`,
        [f.teams.a, child],
      );
      return probe.all(
        outcomeIs(moved.ok && moved.count === 1, moved, "positive-control"),
        ["positive-control", audits === 11],
      );
    });
    probe.at("end-state");
    return (
      adminPass &&
      ownerPass &&
      probe.all(["end-state", (await orgCommitted()) === before])
    );
  });

  // Two owner sessions move A under B and B under A at once. The workspace row lock in
  // app.maintain_org_closure makes the second wait; it then sees A under B and is refused (RQ009).
  await check("org-concurrent-move", async (probe) => {
    const moveSql =
      "UPDATE app.org_units SET parent_id = $2::uuid WHERE id = $1::uuid";
    await data.query("BEGIN");
    await data2.query("BEGIN");
    let first: Outcome | undefined;
    let second: Outcome | undefined;
    let overlapped: boolean | undefined;
    let backends: number[];
    let firstEnded = false;
    try {
      probe.at("install");
      await installAs(data, signer, p.ownerA);
      await installAs(data2, signer, p.ownerA);
      backends = [await backendPid(data), await backendPid(data2)];
      probe.at("outcome");
      first = await settle(data.query(moveSql, [org.raceA, org.raceB]));
      const pending = settle(data2.query(moveSql, [org.raceB, org.raceA]));
      try {
        probe.at("lock-overlap");
        overlapped = await waitForWaiters(owner, [backends[1]], 1);
      } finally {
        await data.query(first.ok ? "COMMIT" : "ROLLBACK");
        firstEnded = true;
      }
      probe.at("outcome");
      second = await pending;
    } finally {
      if (!firstEnded) await data.query("ROLLBACK").catch(() => {});
      // The second move must fail; it is committed only if it unexpectedly succeeded.
      await data2.query(second?.ok ? "COMMIT" : "ROLLBACK");
    }
    probe.at("end-state");
    const parents = (
      await owner.query(
        "SELECT id::text AS id, parent_id::text AS parent FROM app.org_units WHERE id = ANY($1::uuid[])",
        [[org.raceA, org.raceB]],
      )
    ).rows;
    // The fixture closure equals a recursive recomputation over parent_id, so it is acyclic.
    const drift = await count(
      owner,
      `WITH RECURSIVE units AS (SELECT id, parent_id FROM app.org_units WHERE code LIKE $1),
        tree AS (SELECT id AS a, id AS d, 0 AS depth FROM units
          UNION ALL SELECT t.a, u.id, t.depth + 1 FROM tree t JOIN units u ON u.parent_id = t.d WHERE t.depth < 8),
        closure AS (SELECT c.ancestor_id AS a, c.descendant_id AS d, c.depth FROM app.org_unit_closure c
          JOIN units u ON u.id = c.descendant_id)
      SELECT ((SELECT count(*) FROM (TABLE tree EXCEPT TABLE closure) x)
        + (SELECT count(*) FROM (TABLE closure EXCEPT TABLE tree) y)
        + (SELECT count(*) FROM closure WHERE a = d AND depth > 0))::int AS n`,
      [f.pattern],
    );
    const parentOf = (id: string) =>
      parents.find((row) => row.id === id)?.parent ?? null;
    return probe.all(
      ["backend-identity", distinct(backends)],
      ["lock-overlap", overlapped === true],
      outcomeIs(first?.ok === true && first.count === 1, first),
      failsWith(second, "RQ009"),
      [
        "end-state",
        parentOf(org.raceA) === org.raceB &&
          parentOf(org.raceB) === null &&
          drift === 0,
      ],
    );
  });

  // The org workspace lock is FOR NO KEY UPDATE: while a move holds it, an insert keyed to the
  // workspace (its foreign-key check takes FOR KEY SHARE on the row) does not wait. Both roll back.
  await check("org-lock-key-share", async (probe) => {
    await data.query("BEGIN");
    await data2.query("BEGIN");
    let moved: Outcome | undefined;
    let keyed: Outcome | undefined;
    try {
      probe.at("install");
      await installAs(data, signer, p.ownerA);
      await installAs(data2, signer, p.ownerA);
      probe.at("outcome");
      moved = await settle(
        data.query(
          "UPDATE app.org_units SET parent_id = NULL WHERE id = $1::uuid",
          [org.raceA],
        ),
      );
      await data2.query("SET LOCAL lock_timeout = '2s'");
      keyed = await settle(
        data2.query(
          "INSERT INTO app.config_objects(workspace_id,type,key) VALUES($1::uuid,'workflow',$2)",
          [COMPANY_WORKSPACE, configKey("org-lock")],
        ),
      );
    } finally {
      await data2.query("ROLLBACK").catch(() => {});
      await data.query("ROLLBACK").catch(() => {});
    }
    probe.at("end-state");
    return probe.all(
      outcomeIs(moved?.ok === true && moved.count === 1, moved),
      outcomeIs(keyed?.ok === true && keyed.count === 1, keyed),
      [
        "end-state",
        (await count(
          owner,
          "SELECT count(*)::int AS n FROM app.config_objects WHERE key = $1",
          [configKey("org-lock")],
        )) === 0,
      ],
    );
  });

  // Last, because a successful grant writes a workspace-authority activity row. The FOR SHARE lock
  // in set_workspace_authority's membership check (0029) orders a grant and a concurrent removal of
  // the target's last membership: whichever commits second waits for the first.
  await check("workspace-authority-race", async (probe) => {
    probe.at("setup");
    const target = async (userId: string, memberId: string) => {
      await owner.query(
        `INSERT INTO auth."user"(id,name,email,email_verified) VALUES($1,$2,$3,true)`,
        [userId, `Fictional user ${f.prefix}`, `${userId}@example.test`],
      );
      await owner.query(
        "INSERT INTO auth.member(id,organization_id,user_id,role) VALUES($1,$2,$3,'recruiter')",
        [memberId, f.teams.c, userId],
      );
      return count(
        owner,
        "SELECT count(*)::int AS n FROM auth.member WHERE user_id = $1",
        [userId],
      );
    };
    // The fixture company owner; its row goes with the user at cleanup.
    const ownerRow = await owner.query(
      "INSERT INTO app.workspace_admins(workspace_id,user_id,level) SELECT workspace_id,$2,'owner' FROM app.workspace_teams WHERE team_id = $1",
      [f.teams.c, f.users.c1],
    );
    const memberships = [
      await target(f.users.grantFirst, f.members.grantFirst),
      await target(f.users.removeFirst, f.members.removeFirst),
    ];
    const grantSql =
      "SELECT tenant_context.set_workspace_authority($1,'admin',ARRAY['fields'],false) AS changed";
    const removeSql = "DELETE FROM auth.member WHERE id = $1";
    const authority = async (userId: string) =>
      (
        await owner.query(
          "SELECT suspended_at IS NOT NULL AS suspended FROM app.workspace_admins WHERE user_id = $1",
          [userId],
        )
      ).rows;

    /** The first statement runs and holds its locks; the second must wait until the first commits. */
    const race = async (
      first: { db: Client; text: string; params: unknown[] },
      second: { db: Client; text: string; params: unknown[] },
    ) => {
      await first.db.query("BEGIN");
      await second.db.query("BEGIN");
      let firstOutcome: Outcome | undefined;
      let secondOutcome: Outcome | undefined;
      let overlapped: boolean | undefined;
      let backends: number[];
      let firstEnded = false;
      try {
        // The grant runs on the data connection under the fixture company owner's session context.
        probe.at("install");
        await installAs(data, signer, p.ownerC);
        backends = [await backendPid(first.db), await backendPid(second.db)];
        probe.at("outcome");
        firstOutcome = await settle(first.db.query(first.text, first.params));
        const pending = settle(second.db.query(second.text, second.params));
        try {
          probe.at("lock-overlap");
          overlapped = await waitForWaiters(owner, [backends[1]], 1);
        } finally {
          await first.db.query(firstOutcome.ok ? "COMMIT" : "ROLLBACK");
          firstEnded = true;
        }
        probe.at("outcome");
        secondOutcome = await pending;
      } finally {
        if (!firstEnded) await first.db.query("ROLLBACK").catch(() => {});
        await second.db.query(secondOutcome?.ok ? "COMMIT" : "ROLLBACK");
      }
      return { firstOutcome, secondOutcome, overlapped, backends };
    };

    const grantFirst = await race(
      { db: data, text: grantSql, params: [f.users.grantFirst] },
      { db: identity, text: removeSql, params: [f.members.grantFirst] },
    );
    const grantedThenRemoved = await authority(f.users.grantFirst);
    const removeFirst = await race(
      { db: identity, text: removeSql, params: [f.members.removeFirst] },
      { db: data, text: grantSql, params: [f.users.removeFirst] },
    );
    probe.at("end-state");
    const removedThenGranted = await authority(f.users.removeFirst);
    return probe.all(
      ["setup", ownerRow.rowCount === 1 && memberships.every((n) => n === 1)],
      [
        "backend-identity",
        distinct(grantFirst.backends) && distinct(removeFirst.backends),
      ],
      [
        "lock-overlap",
        grantFirst.overlapped === true && removeFirst.overlapped === true,
      ],
      outcomeIs(
        grantFirst.firstOutcome?.ok === true &&
          grantFirst.firstOutcome.rows[0]?.changed === true,
        grantFirst.firstOutcome,
      ),
      outcomeIs(
        grantFirst.secondOutcome?.ok === true &&
          grantFirst.secondOutcome.count === 1,
        grantFirst.secondOutcome,
      ),
      outcomeIs(
        removeFirst.firstOutcome?.ok === true &&
          removeFirst.firstOutcome.count === 1,
        removeFirst.firstOutcome,
      ),
      failsWith(removeFirst.secondOutcome, "RQ006"),
      [
        "end-state",
        grantedThenRemoved.length === 1 &&
          grantedThenRemoved[0].suspended === true &&
          removedThenGranted.length === 0,
      ],
    );
  });
}

/** The pair checks createDbPair performs, rebuilt from its exported queries. */
async function runtimePairSafe(data: Db, identity: Db) {
  async function inspect(db: Db, boundaryQuery: string) {
    const principal = (
      await db.query(
        'SELECT current_user::text AS role, session_user::text AS "sessionRole", current_database()::text AS database',
      )
    ).rows;
    if (
      principal.length !== 1 ||
      !principal[0].role ||
      principal[0].role !== principal[0].sessionRole
    )
      return null;
    for (const query of [
      runtimeRoleSafetyQuery,
      markerRoleBoundaryQuery,
      boundaryQuery,
    ]) {
      const { rows } = await db.query(query);
      if (rows.length !== 1 || rows[0].unsafe !== false) return null;
    }
    const marker = (
      await db.query(
        "SELECT id::text AS marker FROM db_boundary.connection_marker",
      )
    ).rows;
    if (marker.length !== 1) return null;
    return {
      role: principal[0].role as string,
      sessionRole: principal[0].sessionRole as string,
      database: principal[0].database as string,
      marker: marker[0].marker as string,
    };
  }
  try {
    const dataState = await inspect(data, dataRoleBoundaryQuery);
    const identityState = await inspect(identity, identityRoleBoundaryQuery);
    if (!dataState || !identityState) return null;
    const member =
      "SELECT pg_catalog.pg_has_role(current_user, $1::text, 'MEMBER') AS member";
    const dataMembership = await data.query(member, [identityState.role]);
    const identityMembership = await identity.query(member, [dataState.role]);
    verifyPoolPair(
      { ...dataState, canAssumeOther: dataMembership.rows[0]?.member },
      { ...identityState, canAssumeOther: identityMembership.rows[0]?.member },
    );
    return dataState;
  } catch {
    return null;
  }
}

/** Every check that must pass before the first write; returns a refusal reason or the variant. */
export async function preflight(
  connections: { owner: Db; data: Db; identity: Db },
  signer: Signer,
  confirm: string,
): Promise<{ refusal: string } | { variant: Variant }> {
  const runtime = await runtimePairSafe(connections.data, connections.identity);
  if (!runtime)
    return {
      refusal:
        "The data and identity connections must pass every runtime role and pair check.",
    };
  try {
    const owner = (
      await connections.owner.query(
        `SELECT current_user::text AS role, session_user::text AS "sessionRole",
          (SELECT pg_catalog.pg_get_userbyid(n.nspowner) = current_user FROM pg_catalog.pg_namespace n
            WHERE n.nspname = 'tenant_context') AS owns,
          (SELECT id::text FROM db_boundary.connection_marker) AS marker`,
      )
    ).rows[0];
    const identityRole = (
      await connections.identity.query("SELECT current_user::text AS role")
    ).rows[0].role;
    if (
      owner.role !== owner.sessionRole ||
      owner.owns !== true ||
      owner.role === runtime.role ||
      owner.role === identityRole ||
      owner.marker !== runtime.marker
    )
      return {
        refusal:
          "The migration connection must be the separate owner of schema tenant_context on the same database.",
      };
    const key = (
      await connections.owner.query(
        "SELECT EXISTS (SELECT 1 FROM tenant_context.keys WHERE id = $1 AND retired_at IS NULL) AS present",
        [signer.id],
      )
    ).rows[0];
    if (key.present !== true)
      return {
        refusal:
          "TENANT_CONTEXT_SIGNING_KEY is not the key the database was migrated with.",
      };
    for (const db of [
      connections.owner,
      connections.data,
      connections.identity,
    ])
      if (
        (await db.query("SELECT current_database()::text AS name")).rows[0]
          .name !== confirm
      )
        return {
          refusal: "Every connection must be on the confirmed database.",
        };
    // The database name does not tell Preview from Production; only the owner's mark does.
    const mark = (
      await connections.owner.query(
        "SELECT pg_catalog.obj_description('db_boundary'::regnamespace, 'pg_namespace') AS mark",
      )
    ).rows[0];
    if (mark.mark !== PREVIEW_MARK)
      return {
        refusal: "The database is not marked as an approved Preview database.",
      };
    const setup = (
      await connections.owner.query(
        `SELECT (SELECT count(*) FROM auth.initial_admin_claim)::int AS claims,
          EXISTS (SELECT 1 FROM auth.initial_admin_claim WHERE completed_at IS NULL) AS pending,
          EXISTS (SELECT 1 FROM auth."user") OR EXISTS (SELECT 1 FROM auth.organization) AS populated`,
      )
    ).rows[0];
    if (setup.pending === true)
      return { refusal: "A first-administrator setup is in progress." };
    if (setup.claims === 0 && setup.populated === false)
      return { variant: "open" };
    if (setup.claims === 1) return { variant: "closed" };
    return {
      refusal:
        "The database has users or teams but no completed first-administrator setup.",
    };
  } catch {
    return { refusal: "A connection could not be inspected." };
  }
}

export async function main(env: Env = process.env): Promise<number> {
  const dataUrl = env.DATABASE_URL;
  const identityUrl = env.IDENTITY_DATABASE_URL;
  const migrationUrl = env.MIGRATION_DATABASE_URL;
  const confirm = env.LIVE_ROLE_TESTS_CONFIRM;
  const signingKey = env.TENANT_CONTEXT_SIGNING_KEY;
  const diagnose = env.LIVE_ROLE_TESTS_DIAGNOSE === "1";
  if (!dataUrl || !identityUrl || !migrationUrl || !confirm || !signingKey)
    return refuse(
      "Set DATABASE_URL, IDENTITY_DATABASE_URL, MIGRATION_DATABASE_URL, LIVE_ROLE_TESTS_CONFIRM and TENANT_CONTEXT_SIGNING_KEY.",
    );
  if (!keyAccepted(signingKey))
    return refuse(
      "TENANT_CONTEXT_SIGNING_KEY must be a base64url value of at least 32 bytes.",
    );
  let targets: { data: string; identity: string; owner: string };
  try {
    const options = { PGOPTIONS: env.PGOPTIONS };
    const runtime = prepareConnectionTargets(dataUrl, identityUrl, options);
    const owner = prepareConnectionTargets(dataUrl, migrationUrl, options);
    targets = {
      data: runtime.dataUrl,
      identity: runtime.identityUrl,
      owner: owner.identityUrl,
    };
  } catch {
    return refuse(
      "All three URLs must name the same database endpoint with at most one sslmode parameter, and PGOPTIONS must be unset.",
    );
  }
  const users = [targets.data, targets.identity, targets.owner].map((url) =>
    decodeURIComponent(new URL(url).username),
  );
  if (new Set(users).size !== 3)
    return refuse(
      "The data, identity and migration URLs must use three different roles.",
    );
  if (confirm !== decodeURIComponent(new URL(targets.data).pathname.slice(1)))
    return refuse("LIVE_ROLE_TESTS_CONFIRM must equal the database name.");

  const signer = signerFor(signingKey);
  const clients: Client[] = [];
  const open = (url: string) => {
    const client = connect(url);
    clients.push(client);
    return client;
  };
  const endAll = () =>
    Promise.allSettled(clients.map((client) => client.end()));
  let connections: Omit<Run, "dataUrl" | "signer" | "f" | "variant" | "check">;
  try {
    connections = {
      owner: open(targets.owner),
      data: open(targets.data),
      data2: open(targets.data),
      identity: open(targets.identity),
      identity2: open(targets.identity),
      workers: Array.from({ length: WORKERS }, () => open(targets.data)),
    };
    for (const client of clients) await client.connect();
  } catch {
    await endAll();
    console.error(
      "Live role tests could not connect. Check the three connections and the database setup; credentials and driver errors are never printed.",
    );
    return 1;
  }
  try {
    const ready = await preflight(connections, signer, confirm);
    if ("refusal" in ready)
      return refuse(ready.refusal, "Nothing was written.");
    const f = fixtureNames(`lrt${randomBytes(6).toString("hex")}`);
    const results: {
      id: string;
      pass: boolean;
      phase?: Phase;
      error?: string;
    }[] = [];
    const run: Run = {
      ...connections,
      dataUrl: targets.data,
      signer,
      f,
      variant: ready.variant,
      async check(id, work) {
        let phase: Phase = "setup";
        let failure: Condition | undefined;
        const probe: Probe = {
          at: (next) => {
            phase = next;
          },
          all: (...conditions) => {
            const failed = conditions.find(([, holds]) => !holds);
            failure ??= failed;
            return !failed;
          },
        };
        let pass: boolean;
        try {
          pass = (await work(probe)) === true;
        } catch (error) {
          pass = false;
          failure ??= [phase, false, errorCategory(error)];
        }
        const [failedPhase, , failedError] = failure ?? [phase, false];
        results.push(
          pass
            ? { id, pass }
            : {
                id,
                pass,
                phase: failedPhase,
                error: failedError ?? "assertion",
              },
        );
      },
    };
    let error = false;
    let created: Counts = {};
    let remaining: Counts = {};
    let restored = false;
    let cleanupError = "assertion";
    try {
      await runChecks(run);
    } catch {
      error = true;
    } finally {
      // Closing the runtime sessions ends any open transaction before the owner takes its locks.
      await Promise.allSettled(
        clients
          .filter((client) => client !== run.owner)
          .map((client) => client.end()),
      );
      try {
        created = await fixtureCounts(run.owner, f, run.variant);
      } catch {
        error = true;
      }
      try {
        ({ restored, error: cleanupError } = await cleanup(
          run.owner,
          f,
          run.variant,
        ));
      } catch (error) {
        restored = false;
        cleanupError = errorCategory(error);
      }
      try {
        remaining = await fixtureCounts(run.owner, f, run.variant);
      } catch {
        error = true;
      }
    }
    results.push(
      restored
        ? { id: "cleanup-restored", pass: restored }
        : {
            id: "cleanup-restored",
            pass: restored,
            phase: "cleanup",
            error: cleanupError,
          },
    );
    const failed = results.filter((result) => !result.pass);
    const failedChecks = failed.map((result) => result.id);
    const removed = Object.fromEntries(
      Object.entries(created).map(([table, rows]) => [
        table,
        rows - (remaining[table] ?? 0),
      ]),
    );
    const left = Object.values(remaining).some((rows) => rows !== 0);
    const counted = Object.keys(remaining).length > 0;
    const pass = !error && failedChecks.length === 0 && counted && !left;
    if (error)
      console.error(
        "Live role tests stopped on an unexpected error; fixtures were cleaned up where possible. Driver errors are never printed.",
      );
    console.log(
      JSON.stringify(
        {
          checks: {
            total: results.length,
            passed: results.length - failedChecks.length,
            failed: failedChecks.length,
          },
          failedChecks,
          ...(diagnose
            ? {
                diagnostics: failed.map(({ id, phase, error }) => ({
                  check: id,
                  phase,
                  error,
                })),
              }
            : {}),
          bootstrapVariant: run.variant,
          fixtures: { created, removed, remaining },
          pass,
          ...(left ? { runPrefix: f.prefix } : {}),
        },
        null,
        2,
      ),
    );
    return pass ? 0 : 1;
  } catch {
    console.error(
      "Live role tests stopped on an unexpected error. Driver errors are never printed.",
    );
    return 1;
  } finally {
    await endAll();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error("Live role tests stopped unexpectedly.");
      process.exitCode = 1;
    });
