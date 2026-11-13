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
 *   of the target's last membership never leave unsuspended authority for a user in no team, and a
 *   company owner's grant of a level to a member without two-step sign-in is refused and writes
 *   nothing.
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
 *   A context without directory:read reads no employee or position row; a context reads no
 *   position, employee or position row of another workspace and writes none there; a team owner
 *   without company authority cannot change their own employee row's user link or positions, nor
 *   link another employee; a company admin with the organisation area cannot change a linked
 *   employee's positions or move or archive the position they hold, but places unlinked employees;
 *   a token context, even one holding the directory scopes, writes no directory row; and a
 *   position names only a current job role of the writer's own team. A member's configured role
 *   narrows the scopes install stores and returns, never widening them; a company admin, a team
 *   owner without company authority and a token context of the company owner write no
 *   app.member_roles row, and the token gets no owner-only list of role assignments. A company
 *   admin, the team B owner and a token context of the company owner cannot call
 *   tenant_context.erase_employee, the data role cannot insert, update or delete
 *   app.employee_erasures, and a company owner session erases one fixture employee and gets the
 *   same erasure back on a retry. The data role cannot insert, update or delete
 *   app.record_assignments or insert an assignment activity row, even under the company owner's
 *   session, and a member whose role limits records to their unit cannot assign or unassign
 *   themselves through tenant_context.add_assignment or remove_assignment (RQ014), while they can
 *   assign another member and a company owner session can assign itself. Under that member's
 *   unit-limited context (0038), direct SQL reads only the records, activity, uploads and
 *   assignments of records in its scope, cannot insert a record outside it, update an
 *   out-of-scope record, or insert activity or an upload for one, and reads, changes and deletes
 *   no other actor's app.idempotency row nor writes one under another actor's key. The team B
 *   owner, who holds no company authority, cannot call tenant_context.workspace_team_list (0041).
 *   Neither the team B owner nor a company admin without the people area (the team C owner, given
 *   the organisation area by the owner for that check and then removed) can call
 *   tenant_context.workspace_people (0042) or tenant_context.workspace_person (0046).
 *   A team owner's session archives their team through tenant_context.set_team_archived; every
 *   context of that team then stores only read scopes, so a member's record insert and the
 *   owner's task-board insert are refused, a team admin cannot call the helper, and after the
 *   owner restores the team the same inserts succeed (0044).
 *   Neither runtime role can insert, update or delete app.workspace_users, even under the company
 *   owner's session. While the team A recruiter is deactivated, tenant_context.install refuses
 *   their session context with 42501 on the data and the identity role alike, and accepts it
 *   again once they are reactivated. A company admin without the people area (the team B owner,
 *   given the organisation area for that check) cannot call tenant_context.set_user_active, and
 *   with the people area cannot deactivate the company owner, while they can deactivate a member
 *   without company authority (rolled back) (0047).
 *   Salary brackets (0048): on one owner-written draft version with one bracket, the team B owner
 *   and a company owner without Plan & pay access read no version or bracket and cannot insert a
 *   draft, update the fixture or call tenant_context.publish_bracket_version; a grant holder whose
 *   context lacks plans:write reads the fixture but writes nothing; and the team A owner holding
 *   the grant and both plan scopes reads it, inserts a draft and edits it (rolled back), while
 *   an API token of theirs holding every scope reads and writes nothing.
 *   Record files (0049): the data role holds SELECT, INSERT and UPDATE on app.record_files and no
 *   DELETE or TRUNCATE, and the identity role nothing. Under the unit-limited context of the team A
 *   recruiter, direct SQL reads no fixture record file of the out-of-scope candidate and cannot
 *   insert one for it, while it can for the vacancy in scope; the team A owner reads it, and a team
 *   B owner context reads no record file of team A.
 *   Job title usage (0050): the team B owner, who holds no company authority, the team B owner made
 *   a company admin with the fields area only, and an API token of the company owner holding every
 *   scope cannot call tenant_context.job_title_usage, while the team A owner's company owner session
 *   gets its one row of three counts, and nothing else, for a key no fixture uses.
 *   User anonymisation (0051): the team B owner without company authority, the same person as a
 *   company admin with the people area, and a token context of the company owner holding every
 *   scope cannot call tenant_context.anonymise_user (42501), while the company owner's session
 *   reaches its name check (RQ003, rolled back); the data role cannot select, insert or update
 *   app.user_anonymisations, nor set app.activity.user_anonymisation_id, even under the company
 *   owner's session.
 *   Company groups (0052): the team B owner made a company admin with the people area cannot add a
 *   member to an approval group by direct SQL (42501), while the company owner's session can (rolled
 *   back); the data role cannot insert, update or delete app.group_effective_members, even under
 *   the company owner's session, which reads the fixture's effective row. Once a group gives a
 *   configured role (0057), that company admin cannot add a member to it, nor give or remove a
 *   group role, by direct SQL (42501); the team B owner without company authority cannot give
 *   one (42501) and reaches no grant to remove; the company owner's session removes it (rolled
 *   back).
 *   Field usage (0055): the team B owner, who holds no company authority, the team B owner made a
 *   company admin with the organisation area only, and an API token of the company owner holding
 *   every scope cannot call tenant_context.field_usage (42501), while the team A owner's company
 *   owner session gets its one count, 0, and nothing else, for a fresh uuid.
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
 *   states, reminder reads, idempotency, activity, pending uploads, pending record files and bulk
 *   intake batches and items as the data role under signed contexts; fixture stores and read leases as the owner. The
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
 *   the team A owner's context. As the owner it writes fixture positions, employees (one linked to
 *   the team B owner) and position rows keyed by the run prefix, inserts the second workspace a
 *   last time with one of each, removing them in that check, briefly makes the team C owner a
 *   company admin with the organisation area, and briefly adds an API token holding every scope
 *   for the team A owner, removing both in their checks. As the owner it writes one published
 *   fixture role keyed by the run prefix and, in each member-role check, one app.member_roles
 *   row giving it to the team A recruiter (the owner's own SQL writes no activity row), removing
 *   the row in that check, and briefly adds one more API token holding every scope for the team
 *   A owner. As the owner it writes one more fixture employee, linked to the team C member and
 *   holding one fixture position, which the data role erases under the team A owner's company
 *   owner session: that commits one employee tombstone, one scope.home_units_changed row and one
 *   employee.erased row in team A, and briefly adds one more API token holding every scope for the
 *   team A owner. As the owner it writes one more published fixture role limited to the unit,
 *   gives it to the team A recruiter and one assignment of them on the team A fixture vacancy,
 *   removing all three in that check; the data role's assignment writes are rolled back. In each
 *   of the two record-scope checks it writes one more such role, gives it to the team A recruiter
 *   and assigns them to the team A fixture vacancy and the team A owner to the fixture candidate,
 *   removing all four in that check; the data role's writes there are rolled back. As the
 *   identity role it briefly makes the team A fixture recruiter a viewer and restores the role,
 *   and once an admin and restores the role. The team A owner's session archives and restores
 *   team A once, writing two team-archive activity rows there; if the restore did not run, the
 *   owner clears the two archive columns. As the owner it briefly marks the team A recruiter
 *   deactivated in app.workspace_users and reactivates them, and briefly makes the team B owner a
 *   company admin, removing the row in that check. In each salary bracket check it writes one draft
 *   bracket version, created_by the team A owner, with one bracket, removing both in that check,
 *   and briefly sets the Plan & pay access of the team A or team C owner, setting it back; the
 *   last of them briefly adds one more API token holding every scope for the team A owner. In the
 *   job title usage checks it briefly makes the team B owner a company admin with the fields area,
 *   and briefly adds one more API token holding every scope for the team A owner, removing each in
 *   its check. In the field usage checks it briefly makes the team B owner a company admin with
 *   the organisation area, and briefly adds one more API token holding every scope for the team A
 *   owner, removing each in its check. In the first anonymisation check it briefly makes the team B owner a company admin
 *   with the people area and adds one more API token holding every scope for the team A owner,
 *   removing both in that check; nothing of an anonymisation commits. In each group check it writes
 *   one approval group named by the run prefix with the team A owner as its member (the trigger
 *   writes their effective row), removing the group, which cascades the rest, in that check; the
 *   first also briefly makes the team B owner a company admin with the people area. The manager
 *   check instead writes one plain group named by the run prefix with the team A member as its
 *   manager and flags it as an approval group half way, removing the group, which cascades the
 *   manager row, in that check; the member's inserts there are rolled back. The group role check
 *   writes one plain group named by the run prefix, with the team A owner as its member, that
 *   gives the published fixture role in team B (the owner's own SQL writes no activity row), and
 *   briefly makes the team B owner a company admin with the people area, removing the group,
 *   which cascades the grant, and the admin row in that check; every data-role write there is
 *   rolled back.
 *   It never changes budgets, keys, roles, grants, policies, migrations or settings beyond
 *   transaction-local deadlines.
 * - Cleanup runs after any failure once writing has started. One owner transaction lifts FORCE
 *   ROW LEVEL SECURITY and the immutable_activity trigger on the app tables (ACCESS EXCLUSIVE
 *   locks), deletes the fixture rows and restores both before COMMIT; then the fixture member
 *   roles, configuration objects, position rows, employees, employee tombstones (with FORCE ROW
 *   LEVEL SECURITY lifted on app.employee_erasures inside that transaction), positions,
 *   organisation units (with their closure rows) and levels, the contexts,
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
import { RECRUITER_ROLE } from "../src/domain/config-defaults.ts";
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
  "record_files",
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
/** Positions and employees (0034), under FORCE RLS with allows_workspace and allows_directory. */
const DIRECTORY_TABLES = [
  "positions",
  "employees",
  "employee_positions",
] as const;
/** The employee erasure tombstones (0036), owner-only under FORCE RLS with no DELETE policy. */
const ERASURE_TABLES = ["employee_erasures"] as const;
/** Salary brackets (0048), under FORCE RLS with allows_plan policies and no runtime delete. */
const BRACKET_TABLES = ["salary_bracket_versions", "salary_brackets"] as const;
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

/** A pending Blob record file (0049), with the same parameters as INSERT_UPLOAD; $2 is the record. */
const INSERT_RECORD_FILE = `INSERT INTO app.record_files(id,team_id,record_id,original_name,mime_type,size_bytes,status,object_key,
    storage_provider,storage_environment,storage_store,created_by,expires_at)
  VALUES(gen_random_uuid(),$1,$2,$3,'application/pdf',$4,'pending',$5,'blob','development',$6,$7,now() + interval '15 minutes') RETURNING id::text AS id`;

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
 * and the bodies the hint did not name (0032) and the team's archived state (0044).
 */
type Access = {
  scopes: string[];
  workspaceId: string;
  memberRole: string;
  companyLevel: string | null;
  companyAreas: string[];
  versions: Record<string, string>;
  roleVersionId: string | null;
  recordScope: Record<string, string> | null;
  homeUnits: string[];
  teamArchived: boolean;
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
  recordFile: string;
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
    // Fixture record files by team or fixture store (0049); removed before their records.
    [
      "app.record_files",
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
    // Fixture member roles by team (0035); removed before the role objects they name.
    ["app.member_roles", ...team],
    // Fixture assignments by team (0037); they also cascade from the fixture records.
    ["app.record_assignments", ...team],
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
    // Fixture bracket versions by their fixture creator (0048); brackets cascade from them.
    ["app.salary_bracket_versions", "created_by LIKE $1", [f.pattern]],
    // Fixture position rows by their employee, employees by number and positions by code.
    [
      "app.employee_positions",
      "employee_id IN (SELECT e.id FROM app.employees e WHERE e.employee_number LIKE $1)",
      [f.pattern],
    ],
    ["app.employees", "employee_number LIKE $1", [f.pattern]],
    // Fixture employee tombstones by their erasing fixture owner (0036); their activity goes first.
    ["app.employee_erasures", "erased_by LIKE $1", [f.pattern]],
    ["app.positions", "code LIKE $1", [f.pattern]],
    // Fixture units by code and levels by name; closure rows cascade from their units.
    [
      "app.org_unit_closure",
      "descendant_id IN (SELECT u.id FROM app.org_units u WHERE u.code LIKE $1)",
      [f.pattern],
    ],
    ["app.org_units", "code LIKE $1", [f.pattern]],
    ["app.org_levels", "name LIKE $1", [f.pattern]],
    // Fixture groups by name (0052); member, manager and effective rows cascade from them.
    [
      "app.group_effective_members",
      "group_id IN (SELECT g.id FROM app.groups g WHERE g.name LIKE $1)",
      [f.pattern],
    ],
    [
      "app.group_members",
      "group_id IN (SELECT g.id FROM app.groups g WHERE g.name LIKE $1)",
      [f.pattern],
    ],
    ["app.groups", "name LIKE $1", [f.pattern]],
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
          "record_files",
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
        // No runtime role and no policy deletes a tombstone; only the owner, with FORCE lifted here.
        for (const table of ERASURE_TABLES)
          await owner.query(
            `ALTER TABLE app.${table} NO FORCE ROW LEVEL SECURITY`,
          );
        for (const table of [
          // The guard lets the owner delete published versions; the second workspace goes after
          // its objects and org rows, position rows before employees and positions, positions
          // before their units, units before their levels, and employees and tombstones before
          // their users.
          "app.member_roles",
          "app.config_objects",
          "app.salary_bracket_versions",
          "app.employee_positions",
          "app.employees",
          "app.employee_erasures",
          "app.positions",
          "app.org_units",
          "app.org_levels",
          "app.groups",
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
        for (const table of ERASURE_TABLES)
          await owner.query(
            `ALTER TABLE app.${table} FORCE ROW LEVEL SECURITY`,
          );
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
    [
      [
        ...APP_TABLES,
        ...WORKSPACE_TABLES,
        ...CONFIG_TABLES,
        ...ORG_TABLES,
        ...DIRECTORY_TABLES,
        ...ERASURE_TABLES,
        ...BRACKET_TABLES,
      ],
    ],
  );
  return {
    restored:
      failure === undefined &&
      rows[0].forced ===
        APP_TABLES.length +
          WORKSPACE_TABLES.length +
          CONFIG_TABLES.length +
          ORG_TABLES.length +
          DIRECTORY_TABLES.length +
          ERASURE_TABLES.length +
          BRACKET_TABLES.length &&
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
          // The key idempotencyActorKey builds, the only one the actor-only policy accepts (0038).
          `${actor}:${principal.auth}:${principal.token ?? "session"}`,
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
      const recordFile = (
        await data.query(INSERT_RECORD_FILE, [
          team,
          candidate,
          `${f.prefix}-${label}-file.pdf`,
          UPLOAD_BYTES,
          `${f.prefix}/${label}/files/file.pdf`,
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
      return { candidate, vacancy, savedView, upload, recordFile, batch, item };
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
        [
          INSERT_RECORD_FILE,
          [
            B,
            b.candidate,
            `${f.prefix}-cross-file.pdf`,
            UPLOAD_BYTES,
            `${f.prefix}/cross/file.pdf`,
            f.stores.seed,
            f.users.a1,
          ],
        ],
        ["INSERT INTO app.storage_usage(team_id) VALUES($1)", [B]],
        [
          "INSERT INTO app.idempotency(team_id,actor_key,operation,key,payload_hash,response,expires_at) VALUES($1,$2,'fixture',$3,$4,'{}'::jsonb,now() + interval '1 hour')",
          [B, `${f.users.a1}:session:session`, `${B}-cross`, "0".repeat(64)],
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
            "SELECT count(*)::int AS n FROM app.record_files WHERE id = $1",
            [b.recordFile],
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
          "UPDATE app.record_files SET original_name = original_name WHERE id = $1",
          [b.recordFile],
        ],
        ["DELETE FROM app.record_files WHERE id = $1", [b.recordFile]],
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

  // Record files (0049): SELECT, INSERT and UPDATE for the data role, no DELETE or TRUNCATE, and
  // nothing for the identity role.
  await check("record-files-grants", async (probe) => {
    // Read by the owner for each runtime role: the identity role cannot even resolve the table.
    const privileges = async (db: Db) => {
      const role = (await db.query("SELECT current_user AS name")).rows[0].name;
      const { rows } = await owner.query(
        `SELECT has_table_privilege($1, 'app.record_files', 'SELECT') AS "select",
          has_table_privilege($1, 'app.record_files', 'INSERT') AS "insert",
          has_table_privilege($1, 'app.record_files', 'UPDATE') AS "update",
          has_table_privilege($1, 'app.record_files', 'DELETE') AS "delete",
          has_table_privilege($1, 'app.record_files', 'TRUNCATE') AS "truncate"`,
        [role],
      );
      return JSON.stringify(rows[0]);
    };
    probe.at("outcome");
    const dataGrants = await privileges(data);
    const identityGrants = await privileges(identity);
    const deleted = await transaction(data, async () => {
      await installAs(data, signer, p.ownerA);
      return attempt(data, "DELETE FROM app.record_files WHERE id = $1", [
        a.recordFile,
      ]);
    });
    const read = await transaction(identity, async () => {
      await installAs(identity, signer, p.ownerA);
      return attempt(identity, "SELECT count(*) FROM app.record_files");
    });
    return probe.all(
      [
        "outcome",
        dataGrants ===
          JSON.stringify({
            select: true,
            insert: true,
            update: true,
            delete: false,
            truncate: false,
          }),
      ],
      [
        "outcome",
        identityGrants ===
          JSON.stringify({
            select: false,
            insert: false,
            update: false,
            delete: false,
            truncate: false,
          }),
      ],
      denial(deleted),
      denial(read),
    );
  });

  // The company workspace tables (0028): the owner, its triggers and its helper write them.
  const workspaceRows = () =>
    transaction(owner, async () => {
      const { rows } = await owner.query(
        `SELECT (SELECT string_agg(row_to_json(w)::text, ',' ORDER BY w.id) FROM app.workspaces w) AS workspaces,
          (SELECT string_agg(row_to_json(t)::text, ',' ORDER BY t.team_id) FROM app.workspace_teams t) AS teams,
          (SELECT string_agg(row_to_json(a)::text, ',' ORDER BY a.workspace_id, a.user_id) FROM app.workspace_admins a) AS admins,
          (SELECT string_agg(row_to_json(u)::text, ',' ORDER BY u.workspace_id, u.user_id) FROM app.workspace_users u) AS users,
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
    // Deactivation is written only by tenant_context.set_user_active (0047).
    [
      "INSERT INTO app.workspace_users(workspace_id,user_id,deactivated_at,deactivated_by) VALUES($1::uuid,$2,now(),$3)",
      [COMPANY_WORKSPACE, f.users.a2, f.users.a1],
    ],
    [
      "UPDATE app.workspace_users SET deactivated_at = now(), deactivated_by = $2 WHERE user_id LIKE $1",
      [f.pattern, f.users.a1],
    ],
    ["DELETE FROM app.workspace_users WHERE user_id LIKE $1", [f.pattern]],
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

  // Positions and employees (0034). The owner writes the fixture positions, employees and position
  // rows directly, with no context and so no audit: two positions in the fixture unit p1, an
  // employee linked to the team B owner holding one of them, and an unlinked employee. Positions go
  // by code and employees by employee number, both under the run prefix.
  const dirCode = (name: string) => `${f.prefix}-dir-${name}`;
  const dirPosition = async (workspace: string, unit: string, name: string) =>
    (
      await owner.query(
        "INSERT INTO app.positions(workspace_id,org_unit_id,title,code) VALUES($1::uuid,$2::uuid,'Fictional position',$3) RETURNING id::text AS id",
        [workspace, unit, dirCode(name)],
      )
    ).rows[0].id as string;
  const dirEmployee = async (
    workspace: string,
    name: string,
    userId: string | null = null,
  ) =>
    (
      await owner.query(
        "INSERT INTO app.employees(workspace_id,display_name,employee_number,user_id) VALUES($1::uuid,'Fictional employee',$2,$3) RETURNING id::text AS id",
        [workspace, dirCode(name), userId],
      )
    ).rows[0].id as string;
  const dirHold = (workspace: string, employeeId: string, positionId: string) =>
    owner.query(
      `INSERT INTO app.employee_positions(employee_id,position_id,workspace_id,"primary") VALUES($1::uuid,$2::uuid,$3::uuid,true)`,
      [employeeId, positionId, workspace],
    );
  const dir = {
    held: await dirPosition(COMPANY_WORKSPACE, org.p1, "held"),
    free: await dirPosition(COMPANY_WORKSPACE, org.p1, "free"),
    linked: await dirEmployee(COMPANY_WORKSPACE, "linked", f.users.b1),
    unlinked: await dirEmployee(COMPANY_WORKSPACE, "unlinked"),
  };
  await dirHold(COMPANY_WORKSPACE, dir.linked, dir.held);
  /** The fixture directory rows and the fixture teams' directory, org and scope activity, as one string. */
  const dirSeen = async (db: Db) =>
    JSON.stringify(
      (
        await db.query(
          `SELECT (SELECT coalesce(json_agg(json_build_object('id', p.id, 'unit', p.org_unit_id, 'title', p.title, 'archived', p.archived_at IS NOT NULL) ORDER BY p.id), '[]') FROM app.positions p WHERE p.code LIKE $1)::text AS positions,
            (SELECT coalesce(json_agg(json_build_object('id', e.id, 'user', e.user_id, 'name', e.display_name) ORDER BY e.id), '[]') FROM app.employees e WHERE e.employee_number LIKE $1)::text AS employees,
            (SELECT coalesce(json_agg(json_build_object('e', ep.employee_id, 'p', ep.position_id, 'primary', ep."primary", 'ended', ep.valid_to IS NOT NULL) ORDER BY ep.employee_id, ep.position_id), '[]')
              FROM app.employee_positions ep JOIN app.employees e ON e.id = ep.employee_id WHERE e.employee_number LIKE $1)::text AS held,
            (SELECT count(*) FROM app.activity a WHERE a.team_id LIKE $1 AND a.kind IN ('directory', 'org', 'scope'))::int AS audits`,
          [f.pattern],
        )
      ).rows[0],
    );
  /** The same as the owner, who reads activity only with FORCE RLS lifted in a rolled-back transaction. */
  const dirCommitted = () =>
    transaction(owner, async () => {
      await owner.query("ALTER TABLE app.activity NO FORCE ROW LEVEL SECURITY");
      return dirSeen(owner);
    });
  const dirRows = (db: Db, workspace: string) =>
    count(
      db,
      `SELECT ((SELECT count(*) FROM app.positions WHERE workspace_id = $1::uuid)
        + (SELECT count(*) FROM app.employees WHERE workspace_id = $1::uuid)
        + (SELECT count(*) FROM app.employee_positions WHERE workspace_id = $1::uuid))::int AS n`,
      [workspace],
    );
  const people = (db: Db) =>
    count(
      db,
      "SELECT ((SELECT count(*) FROM app.employees WHERE employee_number LIKE $1) + (SELECT count(*) FROM app.employee_positions ep JOIN app.employees e ON e.id = ep.employee_id WHERE e.employee_number LIKE $1))::int AS n",
      [f.pattern],
    );

  // A context without directory:read reads no employee or position row and writes none; positions
  // stay readable, as company structure.
  await check("directory-scope", async (probe) => {
    const before = await dirCommitted();
    const seeded = await people(owner);
    const pass = await transaction(data, async () => {
      probe.at("install");
      // The team A recruiter: a company admin with the organisation area, but no directory scope.
      await installAs(data, signer, p.memberA);
      probe.at("outcome");
      const read = await people(data);
      const inserted = await attempt(
        data,
        "INSERT INTO app.employees(workspace_id,display_name,employee_number) VALUES($1::uuid,'Fictional employee',$2)",
        [COMPANY_WORKSPACE, dirCode("scope")],
      );
      const updated = await attempt(
        data,
        "UPDATE app.employees SET display_name = 'Denied' WHERE id = $1::uuid",
        [dir.unlinked],
      );
      probe.at("positive-control");
      const positions = await count(
        data,
        "SELECT count(*)::int AS n FROM app.positions WHERE code LIKE $1",
        [f.pattern],
      );
      return probe.all(
        ["setup", seeded === 3],
        ["outcome", read === 0],
        denial(inserted),
        leftAlone(updated),
        ["positive-control", positions === 2],
      );
    });
    probe.at("positive-control");
    const owned = await transaction(data, async () => {
      await installAs(data, signer, p.ownerA);
      return people(data);
    });
    probe.at("end-state");
    return (
      pass &&
      probe.all(
        ["positive-control", owned === seeded],
        ["end-state", (await dirCommitted()) === before],
      )
    );
  });

  // A context reads no position, employee or position row of another workspace and writes none there.
  await check("directory-cross-workspace", async (probe) => {
    probe.at("setup");
    // A second fixture workspace briefly makes team creation fail on this database (D15).
    const other = randomUUID();
    await owner.query(
      "INSERT INTO app.workspaces(id,name) VALUES($1::uuid,$2)",
      [other, `${f.prefix}-directory-workspace`],
    );
    let pass: boolean;
    try {
      const level = await orgLevel(other, "dir-other", 0);
      const unit = await orgUnit(other, level, orgCode("dir-other"));
      const position = await dirPosition(other, unit, "other");
      const person = await dirEmployee(other, "other");
      await dirHold(other, person, position);
      const seeded = await dirRows(owner, other);
      pass = await transaction(data, async () => {
        probe.at("install");
        await installAs(data, signer, p.ownerA);
        probe.at("outcome");
        const read = await dirRows(data, other);
        const plantedEmployee = await attempt(
          data,
          "INSERT INTO app.employees(workspace_id,display_name,employee_number) VALUES($1::uuid,'Planted',$2)",
          [other, dirCode("planted")],
        );
        const plantedHold = await attempt(
          data,
          "INSERT INTO app.employee_positions(employee_id,position_id,workspace_id) VALUES($1::uuid,$2::uuid,$3::uuid)",
          [person, position, other],
        );
        const renamed = await attempt(
          data,
          "UPDATE app.employees SET display_name = 'Denied' WHERE id = $1::uuid",
          [person],
        );
        probe.at("positive-control");
        return probe.all(
          ["setup", seeded === 3],
          ["outcome", read === 0],
          denial(plantedEmployee),
          denial(plantedHold),
          leftAlone(renamed),
          [
            "positive-control",
            (await dirRows(data, COMPANY_WORKSPACE)) > 0 &&
              (await people(data)) === 3,
          ],
        );
      });
    } finally {
      await owner.query(
        "DELETE FROM app.employee_positions WHERE workspace_id = $1::uuid",
        [other],
      );
      for (const table of ["employees", "positions", "org_units", "org_levels"])
        await owner.query(
          `DELETE FROM app.${table} WHERE workspace_id = $1::uuid`,
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
        (await dirRows(owner, other)) +
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

  // The team B owner holds directory:write but no company authority: their own employee row's link
  // and positions, and any other link, are refused; a fact change of an unlinked employee is not.
  await check("directory-self-link-denied", async (probe) => {
    const before = await dirCommitted();
    const pass = await transaction(data, async () => {
      probe.at("install");
      await installAs(data, signer, p.ownerB);
      probe.at("outcome");
      const seen = await dirSeen(data);
      const unlinked = await attempt(
        data,
        "UPDATE app.employees SET user_id = NULL WHERE id = $1::uuid",
        [dir.linked],
      );
      const linked = await attempt(
        data,
        "UPDATE app.employees SET user_id = $2 WHERE id = $1::uuid",
        [dir.unlinked, f.users.b2],
      );
      const created = await attempt(
        data,
        "INSERT INTO app.employees(workspace_id,display_name,employee_number,user_id) VALUES($1::uuid,'Fictional employee',$2,$3)",
        [COMPANY_WORKSPACE, dirCode("self"), f.users.b2],
      );
      const added = await attempt(
        data,
        "INSERT INTO app.employee_positions(employee_id,position_id,workspace_id) VALUES($1::uuid,$2::uuid,$3::uuid)",
        [dir.linked, dir.free, COMPANY_WORKSPACE],
      );
      const ended = await attempt(
        data,
        "UPDATE app.employee_positions SET valid_to = now() WHERE employee_id = $1::uuid",
        [dir.linked],
      );
      const unchanged = (await dirSeen(data)) === seen;
      probe.at("positive-control");
      const renamed = await attempt(
        data,
        "UPDATE app.employees SET display_name = 'Fictional renamed employee' WHERE id = $1::uuid",
        [dir.unlinked],
      );
      return probe.all(
        denial(unlinked),
        denial(linked),
        denial(created),
        denial(added),
        denial(ended),
        ["outcome", unchanged],
        outcomeIs(
          renamed.ok && renamed.count === 1,
          renamed,
          "positive-control",
        ),
      );
    });
    probe.at("end-state");
    return pass && probe.all(["end-state", (await dirCommitted()) === before]);
  });

  // The team C owner, made a company admin with the organisation area for this check only, may
  // place unlinked employees and rename positions, but not change the linked employee's positions
  // or move or archive the position they hold.
  await check("directory-admin-linked-positions-denied", async (probe) => {
    const before = await dirCommitted();
    probe.at("setup");
    const granted = await owner.query(
      "INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES($1::uuid,$2,'admin','{organisation}')",
      [COMPANY_WORKSPACE, f.users.c1],
    );
    let pass: boolean;
    try {
      pass = await transaction(data, async () => {
        probe.at("install");
        const { access } = await installAs(data, signer, p.ownerC);
        probe.at("outcome");
        const seen = await dirSeen(data);
        const added = await attempt(
          data,
          "INSERT INTO app.employee_positions(employee_id,position_id,workspace_id) VALUES($1::uuid,$2::uuid,$3::uuid)",
          [dir.linked, dir.free, COMPANY_WORKSPACE],
        );
        const demoted = await attempt(
          data,
          `UPDATE app.employee_positions SET "primary" = false WHERE employee_id = $1::uuid`,
          [dir.linked],
        );
        const ended = await attempt(
          data,
          "UPDATE app.employee_positions SET valid_to = now() WHERE employee_id = $1::uuid",
          [dir.linked],
        );
        const moved = await attempt(
          data,
          "UPDATE app.positions SET org_unit_id = $2::uuid WHERE id = $1::uuid",
          [dir.held, org.p2],
        );
        const archived = await attempt(
          data,
          "UPDATE app.positions SET archived_at = now() WHERE id = $1::uuid",
          [dir.held],
        );
        const unchanged = (await dirSeen(data)) === seen;
        probe.at("positive-control");
        // Rolled back with the transaction.
        const placed = await attempt(
          data,
          "INSERT INTO app.employee_positions(employee_id,position_id,workspace_id) VALUES($1::uuid,$2::uuid,$3::uuid)",
          [dir.unlinked, dir.free, COMPANY_WORKSPACE],
        );
        const renamed = await attempt(
          data,
          "UPDATE app.positions SET title = 'Fictional renamed position' WHERE id = $1::uuid",
          [dir.held],
        );
        return probe.all(
          [
            "setup",
            access.companyLevel === "admin" &&
              access.companyAreas.includes("organisation"),
          ],
          denial(added),
          denial(demoted),
          denial(ended),
          denial(moved),
          denial(archived),
          ["outcome", unchanged],
          outcomeIs(
            placed.ok && placed.count === 1,
            placed,
            "positive-control",
          ),
          outcomeIs(
            renamed.ok && renamed.count === 1,
            renamed,
            "positive-control",
          ),
        );
      });
    } finally {
      await owner.query(
        "DELETE FROM app.workspace_admins WHERE workspace_id = $1::uuid AND user_id = $2",
        [COMPANY_WORKSPACE, f.users.c1],
      );
    }
    probe.at("end-state");
    return (
      pass &&
      probe.all(
        ["setup", granted.rowCount === 1],
        [
          "end-state",
          (await dirCommitted()) === before &&
            (await count(
              owner,
              "SELECT count(*)::int AS n FROM app.workspace_admins WHERE user_id = $1",
              [f.users.c1],
            )) === 0,
        ],
      )
    );
  });

  // A token context, here one whose stored scopes include the directory ones the app never grants
  // a token, reads the directory but writes no position, employee or position row.
  await check("directory-token-write-denied", async (probe) => {
    const before = await dirCommitted();
    probe.at("setup");
    const tokenId = `${f.prefix}-token-directory`;
    const stored = await owner.query(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now() + interval '1 hour')`,
      [
        tokenId,
        f.teams.a,
        f.users.a1,
        `Fictional token ${tokenId}`,
        createHash("sha256").update(tokenId).digest("hex"),
        tokenId,
        JSON.stringify(ALL_SCOPES),
      ],
    );
    const token: Principal = {
      team: f.teams.a,
      actor: f.users.a1,
      auth: "token",
      token: tokenId,
      scopes: ALL_SCOPES,
    };
    let pass: boolean;
    try {
      pass = await transaction(data, async () => {
        probe.at("install");
        const { access } = await installAs(data, signer, token);
        probe.at("outcome");
        const read = await people(data);
        const created = await attempt(
          data,
          "INSERT INTO app.employees(workspace_id,display_name,employee_number) VALUES($1::uuid,'Fictional employee',$2)",
          [COMPANY_WORKSPACE, dirCode("token")],
        );
        const renamed = await attempt(
          data,
          "UPDATE app.employees SET display_name = 'Denied' WHERE id = $1::uuid",
          [dir.unlinked],
        );
        const linked = await attempt(
          data,
          "UPDATE app.employees SET user_id = $2 WHERE id = $1::uuid",
          [dir.unlinked, f.users.b2],
        );
        const added = await attempt(
          data,
          "INSERT INTO app.employee_positions(employee_id,position_id,workspace_id) VALUES($1::uuid,$2::uuid,$3::uuid)",
          [dir.unlinked, dir.free, COMPANY_WORKSPACE],
        );
        const retitled = await attempt(
          data,
          "UPDATE app.positions SET title = 'Denied' WHERE id = $1::uuid",
          [dir.free],
        );
        const position = await attempt(
          data,
          "INSERT INTO app.positions(workspace_id,org_unit_id,title,code) VALUES($1::uuid,$2::uuid,'Denied',$3)",
          [COMPANY_WORKSPACE, org.p1, dirCode("token")],
        );
        return probe.all(
          [
            "setup",
            stored.rowCount === 1 &&
              access.scopes.includes("directory:write") &&
              access.companyLevel === "owner",
          ],
          ["outcome", read === 3],
          denial(created),
          denial(renamed),
          denial(linked),
          denial(added),
          denial(retitled),
          denial(position),
        );
      });
    } finally {
      await owner.query("DELETE FROM auth.api_tokens WHERE id = $1", [tokenId]);
    }
    probe.at("end-state");
    return pass && probe.all(["end-state", (await dirCommitted()) === before]);
  });

  // A position names only a current job role of the writer's own team: not another team's record,
  // not a record of another kind (here a candidate, which erasure deletes), not an archived job role.
  await check("directory-job-role-denied", async (probe) => {
    const before = await dirCommitted();
    const pass = await transaction(data, async () => {
      probe.at("install");
      // The team A recruiter, a company admin with the organisation area; rolled back at the end.
      await installAs(data, signer, p.memberA);
      probe.at("setup");
      const jobRole = async (archived: boolean) =>
        (
          await data.query(
            `INSERT INTO app.records(team_id,kind,data,created_by,archived_at) VALUES($1,'job-role',$2::jsonb,$3,${archived ? "now()" : "NULL"}) RETURNING id::text AS id`,
            [
              f.teams.a,
              JSON.stringify({ title: `Fictional job role ${f.prefix}` }),
              f.users.a2,
            ],
          )
        ).rows[0].id as string;
      const current = await jobRole(false);
      const archived = await jobRole(true);
      const position = (team: string, record: string, name: string) =>
        attempt(
          data,
          "INSERT INTO app.positions(workspace_id,org_unit_id,title,code,job_role_team_id,job_role_id) VALUES($1::uuid,$2::uuid,'Fictional position',$3,$4,$5::uuid)",
          [COMPANY_WORKSPACE, org.p1, dirCode(name), team, record],
        );
      probe.at("outcome");
      const otherTeam = await position(f.teams.b, b.vacancy, "role-b");
      const otherKind = await position(f.teams.a, a.candidate, "role-kind");
      const old = await position(f.teams.a, archived, "role-old");
      const relinked = await attempt(
        data,
        "UPDATE app.positions SET job_role_team_id = $2, job_role_id = $3::uuid WHERE id = $1::uuid",
        [dir.free, f.teams.a, a.candidate],
      );
      probe.at("positive-control");
      const own = await position(f.teams.a, current, "role-own");
      return probe.all(
        denial(otherTeam),
        denial(otherKind),
        denial(old),
        denial(relinked),
        outcomeIs(own.ok && own.count === 1, own, "positive-control"),
      );
    });
    probe.at("end-state");
    return pass && probe.all(["end-state", (await dirCommitted()) === before]);
  });

  // Configured member roles (0035). The owner writes one published fixture role, narrowed to the
  // recruiter scopes without cvs:write, and in each check one row giving it to the team A
  // recruiter, removed in that check; the owner's own SQL writes no activity row. Every data-role
  // write is rolled back.
  const roleObject = (
    await owner.query(
      "INSERT INTO app.config_objects(workspace_id,type,key,created_by) VALUES($1::uuid,'role',$2,$3) RETURNING id::text AS id",
      [COMPANY_WORKSPACE, configKey("role"), f.users.a1],
    )
  ).rows[0].id as string;
  const NARROW_SCOPES = RECRUITER_SCOPES.filter(
    (scope) => scope !== "cvs:write",
  );
  const roleVersion = (
    await owner.query(
      "INSERT INTO app.config_versions(object_id,workspace_id,state,number,body,created_by,published_at) VALUES($1::uuid,$2::uuid,'published',1,$3::jsonb,$4,now()) RETURNING id::text AS id",
      [
        roleObject,
        COMPANY_WORKSPACE,
        JSON.stringify({
          ...RECRUITER_ROLE.body,
          name: "Fictional narrowed recruiter",
          scopes: NARROW_SCOPES,
        }),
        f.users.a1,
      ],
    )
  ).rows[0].id as string;
  await owner.query(
    "UPDATE app.config_objects SET current_version_id = $2::uuid WHERE id = $1::uuid",
    [roleObject, roleVersion],
  );
  const memberRoles = () =>
    count(
      owner,
      "SELECT count(*)::int AS n FROM app.member_roles WHERE team_id LIKE $1",
      [f.pattern],
    );
  /** The owner gives the team A recruiter the fixture role for the work, and removes it after. */
  async function withAssignment(work: () => Promise<boolean>) {
    const assigned = await owner.query(
      "INSERT INTO app.member_roles(team_id,user_id,role_object_id) VALUES($1,$2,$3::uuid)",
      [f.teams.a, f.users.a2, roleObject],
    );
    try {
      return assigned.rowCount === 1 && (await work());
    } finally {
      await owner.query("DELETE FROM app.member_roles WHERE team_id LIKE $1", [
        f.pattern,
      ]);
    }
  }
  /** An insert into the team, then an update and a delete of every fixture row, in order. */
  const memberRoleWrites = async (db: Db, team: string) => [
    await attempt(
      db,
      "INSERT INTO app.member_roles(team_id,user_id,role_object_id) VALUES($1,$2,$3::uuid)",
      [team, f.users.a2, roleObject],
    ),
    await attempt(
      db,
      "UPDATE app.member_roles SET role_object_id = role_object_id WHERE team_id LIKE $1",
      [f.pattern],
    ),
    await attempt(db, "DELETE FROM app.member_roles WHERE team_id LIKE $1", [
      f.pattern,
    ]),
  ];

  // Install narrows the asserted scopes to the assigned role's, never widening them.
  await check("member-role-narrowing", async (probe) => {
    probe.at("setup");
    const pass = await withAssignment(async () => {
      const assigned = await transaction(data, async () => {
        probe.at("install");
        return (await installAs(data, signer, p.memberA)).access;
      });
      const asserted = await transaction(data, async () =>
        installAs(data, signer, {
          ...p.memberA,
          scopes: ["candidates:read", "cvs:write"],
        }),
      );
      probe.at("positive-control");
      const plain = await transaction(data, async () =>
        installAs(data, signer, p.ownerA),
      );
      probe.at("outcome");
      return probe.all(
        [
          "outcome",
          JSON.stringify(assigned.scopes) === JSON.stringify(NARROW_SCOPES) &&
            assigned.roleVersionId === roleVersion,
        ],
        [
          "outcome",
          JSON.stringify(asserted.access.scopes) ===
            JSON.stringify(["candidates:read"]),
        ],
        [
          "positive-control",
          plain.access.scopes.length === ALL_SCOPES.length &&
            plain.access.roleVersionId ===
              "00000000-0000-4000-8000-000000000101",
        ],
      );
    });
    probe.at("end-state");
    return pass && probe.all(["end-state", (await memberRoles()) === 0]);
  });

  // A company admin (the team A recruiter, with the organisation area) writes no member role, while
  // the company owner's session updates the row.
  await check("member-role-company-admin-denied", async (probe) => {
    probe.at("setup");
    const pass = await withAssignment(async () => {
      const denials = await transaction(data, async () => {
        probe.at("install");
        const { access } = await installAs(data, signer, p.memberA);
        probe.at("outcome");
        const outcomes = await memberRoleWrites(data, f.teams.a);
        return { access, outcomes };
      });
      const changed = await transaction(data, async () => {
        probe.at("positive-control");
        await installAs(data, signer, p.ownerA);
        return attempt(
          data,
          "UPDATE app.member_roles SET role_object_id = role_object_id WHERE team_id = $1",
          [f.teams.a],
        );
      });
      const [inserted, updated, deleted] = denials.outcomes;
      return probe.all(
        ["setup", denials.access.companyLevel === "admin"],
        denial(inserted),
        outcomeIs(updated.ok && updated.count === 0, updated),
        outcomeIs(deleted.ok && deleted.count === 0, deleted),
        outcomeIs(
          changed.ok && changed.count === 1,
          changed,
          "positive-control",
        ),
      );
    });
    probe.at("end-state");
    return pass && probe.all(["end-state", (await memberRoles()) === 0]);
  });

  // The team B owner, who holds no company authority, writes no member role in their own team or
  // another, and reads none of team A's.
  await check("member-role-team-b-owner-denied", async (probe) => {
    probe.at("setup");
    const pass = await withAssignment(() =>
      transaction(data, async () => {
        probe.at("install");
        const { access } = await installAs(data, signer, p.ownerB);
        probe.at("outcome");
        const read = await count(
          data,
          "SELECT count(*)::int AS n FROM app.member_roles WHERE team_id LIKE $1",
          [f.pattern],
        );
        const own = await attempt(
          data,
          "INSERT INTO app.member_roles(team_id,user_id,role_object_id) VALUES($1,$2,$3::uuid)",
          [f.teams.b, f.users.b2, roleObject],
        );
        const outcomes = await memberRoleWrites(data, f.teams.a);
        const [inserted, updated, deleted] = outcomes;
        return probe.all(
          ["setup", access.companyLevel === null],
          ["outcome", read === 0],
          denial(own),
          denial(inserted),
          leftAlone(updated),
          leftAlone(deleted),
        );
      }),
    );
    probe.at("end-state");
    return pass && probe.all(["end-state", (await memberRoles()) === 0]);
  });

  // The team B owner, who holds no company authority, gets no workspace team list (0041).
  await check("workspace-team-list-team-b-owner-denied", async (probe) => {
    probe.at("setup");
    return transaction(data, async () => {
      probe.at("install");
      const { access } = await installAs(data, signer, p.ownerB);
      probe.at("outcome");
      const listed = await attempt(
        data,
        "SELECT * FROM tenant_context.workspace_team_list()",
      );
      return probe.all(["setup", access.companyLevel === null], denial(listed));
    });
  });

  // The team B owner, who holds no company authority, gets no workspace people list (0042).
  await check("workspace-people-team-b-owner-denied", async (probe) => {
    probe.at("setup");
    return transaction(data, async () => {
      probe.at("install");
      const { access } = await installAs(data, signer, p.ownerB);
      probe.at("outcome");
      const listed = await attempt(
        data,
        "SELECT * FROM tenant_context.workspace_people(NULL, NULL, NULL, NULL, NULL, NULL)",
      );
      return probe.all(["setup", access.companyLevel === null], denial(listed));
    });
  });

  // The team C owner, made a company admin with the organisation area only for this check, gets no
  // workspace people list either: it needs the people area (0042).
  await check("workspace-people-admin-without-people-denied", async (probe) => {
    probe.at("setup");
    const granted = await owner.query(
      "INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES($1::uuid,$2,'admin','{organisation}')",
      [COMPANY_WORKSPACE, f.users.c1],
    );
    let pass: boolean;
    try {
      pass = await transaction(data, async () => {
        probe.at("install");
        const { access } = await installAs(data, signer, p.ownerC);
        probe.at("outcome");
        const listed = await attempt(
          data,
          "SELECT * FROM tenant_context.workspace_people(NULL, NULL, NULL, NULL, NULL, NULL)",
        );
        return probe.all(
          [
            "setup",
            access.companyLevel === "admin" &&
              access.companyAreas.join(",") === "organisation",
          ],
          denial(listed),
        );
      });
    } finally {
      await owner.query(
        "DELETE FROM app.workspace_admins WHERE workspace_id = $1::uuid AND user_id = $2",
        [COMPANY_WORKSPACE, f.users.c1],
      );
    }
    probe.at("end-state");
    return (
      pass &&
      probe.all(
        ["setup", granted.rowCount === 1],
        [
          "end-state",
          (await count(
            owner,
            "SELECT count(*)::int AS n FROM app.workspace_admins WHERE user_id = $1",
            [f.users.c1],
          )) === 0,
        ],
      )
    );
  });

  // The team B owner, who holds no company authority, reads no workspace person, not even a member
  // of their own team (0046).
  await check("workspace-person-team-b-owner-denied", async (probe) => {
    probe.at("setup");
    return transaction(data, async () => {
      probe.at("install");
      const { access } = await installAs(data, signer, p.ownerB);
      probe.at("outcome");
      const read = await attempt(
        data,
        "SELECT * FROM tenant_context.workspace_person($1)",
        [f.users.b2],
      );
      return probe.all(["setup", access.companyLevel === null], denial(read));
    });
  });

  // The team C owner, made a company admin with the organisation area only for this check, reads
  // no workspace person either: it needs the people area (0046).
  await check("workspace-person-admin-without-people-denied", async (probe) => {
    probe.at("setup");
    const granted = await owner.query(
      "INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES($1::uuid,$2,'admin','{organisation}')",
      [COMPANY_WORKSPACE, f.users.c1],
    );
    let pass: boolean;
    try {
      pass = await transaction(data, async () => {
        probe.at("install");
        const { access } = await installAs(data, signer, p.ownerC);
        probe.at("outcome");
        const read = await attempt(
          data,
          "SELECT * FROM tenant_context.workspace_person($1)",
          [f.users.a1],
        );
        return probe.all(
          [
            "setup",
            access.companyLevel === "admin" &&
              access.companyAreas.join(",") === "organisation",
          ],
          denial(read),
        );
      });
    } finally {
      await owner.query(
        "DELETE FROM app.workspace_admins WHERE workspace_id = $1::uuid AND user_id = $2",
        [COMPANY_WORKSPACE, f.users.c1],
      );
    }
    probe.at("end-state");
    return (
      pass &&
      probe.all(
        ["setup", granted.rowCount === 1],
        [
          "end-state",
          (await count(
            owner,
            "SELECT count(*)::int AS n FROM app.workspace_admins WHERE user_id = $1",
            [f.users.c1],
          )) === 0,
        ],
      )
    );
  });

  // A token context of the company owner, holding every scope, writes no member role and gets no
  // owner-only list of role assignments.
  await check("member-role-token-denied", async (probe) => {
    probe.at("setup");
    const tokenId = `${f.prefix}-token-member-roles`;
    const stored = await owner.query(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now() + interval '1 hour')`,
      [
        tokenId,
        f.teams.a,
        f.users.a1,
        `Fictional token ${tokenId}`,
        createHash("sha256").update(tokenId).digest("hex"),
        tokenId,
        JSON.stringify(ALL_SCOPES),
      ],
    );
    const token: Principal = {
      team: f.teams.a,
      actor: f.users.a1,
      auth: "token",
      token: tokenId,
      scopes: ALL_SCOPES,
    };
    let pass: boolean;
    try {
      pass = await withAssignment(() =>
        transaction(data, async () => {
          probe.at("install");
          const { access } = await installAs(data, signer, token);
          probe.at("outcome");
          const outcomes = await memberRoleWrites(data, f.teams.a);
          const listed = await attempt(
            data,
            "SELECT * FROM tenant_context.role_assignment_changes(NULL, 50)",
          );
          const [inserted, updated, deleted] = outcomes;
          return probe.all(
            ["setup", stored.rowCount === 1 && access.companyLevel === "owner"],
            denial(inserted),
            leftAlone(updated),
            leftAlone(deleted),
            denial(listed),
          );
        }),
      );
    } finally {
      await owner.query("DELETE FROM auth.api_tokens WHERE id = $1", [tokenId]);
    }
    probe.at("end-state");
    return pass && probe.all(["end-state", (await memberRoles()) === 0]);
  });

  // Employee erasure (0036). The owner writes one more fixture employee, linked to the team C
  // member and holding the free fixture position; only a company owner session erases it.
  const eraseTarget = await dirEmployee(COMPANY_WORKSPACE, "erase", f.users.c2);
  await dirHold(COMPANY_WORKSPACE, eraseTarget, dir.free);
  const eraseSql =
    "SELECT tenant_context.erase_employee($1::uuid, $2, 'app') AS result";
  /** The fixture directory rows, activity and employee tombstones, as one string. */
  const erasureCommitted = async () =>
    JSON.stringify({
      directory: await dirCommitted(),
      tombstones: await count(
        owner,
        "SELECT count(*)::int AS n FROM app.employee_erasures WHERE erased_by LIKE $1",
        [f.pattern],
      ),
    });

  // A company admin (the team A recruiter), the team B owner without company authority and a
  // token context of the company owner holding every scope cannot call the helper; the company
  // owner's session reaches it (a wrong name, rolled back).
  await check("employee-erasure-owner-only", async (probe) => {
    const before = await erasureCommitted();
    probe.at("setup");
    const tokenId = `${f.prefix}-token-erasure`;
    const stored = await owner.query(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now() + interval '1 hour')`,
      [
        tokenId,
        f.teams.a,
        f.users.a1,
        `Fictional token ${tokenId}`,
        createHash("sha256").update(tokenId).digest("hex"),
        tokenId,
        JSON.stringify(ALL_SCOPES),
      ],
    );
    const token: Principal = {
      team: f.teams.a,
      actor: f.users.a1,
      auth: "token",
      token: tokenId,
      scopes: ALL_SCOPES,
    };
    const refusedFor = (principal: Principal) =>
      transaction(data, async () => {
        probe.at("install");
        const { access } = await installAs(data, signer, principal);
        probe.at("outcome");
        return {
          access,
          outcome: await attempt(data, eraseSql, [
            eraseTarget,
            "Fictional employee",
          ]),
        };
      });
    let pass: boolean;
    try {
      const admin = await refusedFor(p.memberA);
      const teamOwner = await refusedFor(p.ownerB);
      const tokenOutcome = await refusedFor(token);
      const control = await transaction(data, async () => {
        probe.at("positive-control");
        await installAs(data, signer, p.ownerA);
        return attempt(data, eraseSql, [eraseTarget, "Fictional someone else"]);
      });
      pass = probe.all(
        [
          "setup",
          stored.rowCount === 1 &&
            admin.access.companyLevel === "admin" &&
            teamOwner.access.companyLevel === null &&
            tokenOutcome.access.companyLevel === "owner",
        ],
        denial(admin.outcome),
        denial(teamOwner.outcome),
        denial(tokenOutcome.outcome),
        outcomeIs(
          control.ok === false && control.code === "RQ003",
          control,
          "positive-control",
        ),
      );
    } finally {
      await owner.query("DELETE FROM auth.api_tokens WHERE id = $1", [tokenId]);
    }
    probe.at("end-state");
    return (
      pass && probe.all(["end-state", (await erasureCommitted()) === before])
    );
  });

  // The data role inserts, updates and deletes no employee tombstone, even under the company
  // owner's session; the same transaction still reads the fixture directory rows.
  await check("employee-erasure-tombstone-write-denied", async (probe) => {
    const before = await erasureCommitted();
    const pass = await transaction(data, async () => {
      probe.at("install");
      await installAs(data, signer, p.ownerA);
      probe.at("outcome");
      const inserted = await attempt(
        data,
        "INSERT INTO app.employee_erasures(id,workspace_id,employee_id,erased_by,erased_at,erasure_source) VALUES(gen_random_uuid(),$1::uuid,$2::uuid,$3,now(),'app')",
        [COMPANY_WORKSPACE, eraseTarget, f.users.a1],
      );
      const updated = await attempt(
        data,
        "UPDATE app.employee_erasures SET erased_at = now() WHERE erased_by LIKE $1",
        [f.pattern],
      );
      const deleted = await attempt(
        data,
        "DELETE FROM app.employee_erasures WHERE erased_by LIKE $1",
        [f.pattern],
      );
      probe.at("positive-control");
      const read = await people(data);
      return probe.all(denial(inserted), denial(updated), denial(deleted), [
        "positive-control",
        read === 5,
      ]);
    });
    probe.at("end-state");
    return (
      pass && probe.all(["end-state", (await erasureCommitted()) === before])
    );
  });

  // A company owner session erases the fixture employee: the employee and its position row go,
  // one tombstone, one scope.home_units_changed and one employee.erased row commit, and a retry in
  // a later transaction returns the same erasure, writing nothing.
  await check("employee-erasure-owner", async (probe) => {
    const erased = await transaction(
      data,
      async () => {
        probe.at("install");
        await installAs(data, signer, p.ownerA);
        probe.at("outcome");
        return attempt(data, eraseSql, [eraseTarget, " Fictional employee "]);
      },
      true,
    );
    const after = await erasureCommitted();
    const retried = await transaction(data, async () => {
      await installAs(data, signer, p.ownerA);
      return attempt(data, eraseSql, [eraseTarget, "Any name"]);
    });
    probe.at("end-state");
    const first = erased.rows[0]?.result as
      | {
          erasureId: string;
          alreadyErased: boolean;
          erasedAt: string;
          removed: Record<string, number>;
        }
      | undefined;
    const again = retried.rows[0]?.result as typeof first;
    const rows = await transaction(owner, async () => {
      await owner.query("ALTER TABLE app.activity NO FORCE ROW LEVEL SECURITY");
      const { rows } = await owner.query(
        `SELECT action, employee_erasure_id::text AS erasure FROM app.activity
          WHERE team_id = $1 AND action IN ('scope.home_units_changed', 'employee.erased')
            AND (employee_erasure_id IS NOT NULL OR metadata->'affectedUserIds' = $2::jsonb)
          ORDER BY created_at, id`,
        [f.teams.a, JSON.stringify([f.users.c2])],
      );
      return rows;
    });
    return probe.all(
      outcomeIs(
        erased.ok &&
          first?.alreadyErased === false &&
          first.removed.positionRows === 1 &&
          first.removed.activityRedacted === 0 &&
          first.removed.userLinks === 1,
        erased,
      ),
      outcomeIs(
        retried.ok &&
          again?.alreadyErased === true &&
          again.erasureId === first?.erasureId &&
          again.erasedAt === first?.erasedAt &&
          JSON.stringify(again.removed) === JSON.stringify(first?.removed),
        retried,
      ),
      [
        "end-state",
        (await count(
          owner,
          "SELECT ((SELECT count(*) FROM app.employees WHERE id = $1::uuid) + (SELECT count(*) FROM app.employee_positions WHERE employee_id = $1::uuid))::int AS n",
          [eraseTarget],
        )) === 0,
      ],
      ["end-state", JSON.parse(after).tombstones === 1],
      ["end-state", (await erasureCommitted()) === after],
      [
        "end-state",
        JSON.stringify(rows) ===
          JSON.stringify([
            { action: "scope.home_units_changed", erasure: null },
            { action: "employee.erased", erasure: first?.erasureId },
          ]),
      ],
    );
  });

  // Record assignments (0037): only the owner-run helpers write them. Every data-role write here
  // is rolled back.
  const assignmentRows = () =>
    count(
      owner,
      "SELECT count(*)::int AS n FROM app.record_assignments WHERE team_id LIKE $1",
      [f.pattern],
    );

  // The data role inserts, updates and deletes no assignment and inserts no assignment activity
  // row, even under the company owner's session; the same transaction reads its team's
  // assignments and reaches the helper.
  await check("record-assignments-direct-write-denied", async (probe) => {
    const before = await assignmentRows();
    const pass = await transaction(data, async () => {
      probe.at("install");
      await installAs(data, signer, p.ownerA);
      probe.at("outcome");
      const inserted = await attempt(
        data,
        "INSERT INTO app.record_assignments(team_id,record_id,user_id,relation) VALUES($1,$2::uuid,$3,'assignee')",
        [f.teams.a, a.vacancy, f.users.a2],
      );
      const updated = await attempt(
        data,
        "UPDATE app.record_assignments SET relation = 'assignee' WHERE team_id LIKE $1",
        [f.pattern],
      );
      const deleted = await attempt(
        data,
        "DELETE FROM app.record_assignments WHERE team_id LIKE $1",
        [f.pattern],
      );
      const forged = await attempt(
        data,
        `INSERT INTO app.activity(team_id,record_id,actor_id,actor_type,action,kind,summary,metadata)
          VALUES($1,$2::uuid,$3,'session','assignment.added','assignment','Forged','{}')`,
        [f.teams.a, a.vacancy, f.users.a1],
      );
      probe.at("positive-control");
      const read = await attempt(
        data,
        "SELECT count(*)::int AS n FROM app.record_assignments WHERE team_id = $1",
        [f.teams.a],
      );
      const helper = await attempt(
        data,
        "SELECT tenant_context.add_assignment($1::uuid, $2, 'assignee') AS changed",
        [a.vacancy, f.users.a2],
      );
      return probe.all(
        denial(inserted),
        denial(updated),
        denial(deleted),
        denial(forged),
        outcomeIs(read.ok && read.rows[0]?.n === 0, read, "positive-control"),
        outcomeIs(
          helper.ok && helper.rows[0]?.changed === true,
          helper,
          "positive-control",
        ),
      );
    });
    probe.at("end-state");
    return (
      pass &&
      probe.all(["end-state", before === 0 && (await assignmentRows()) === 0])
    );
  });

  // The owner writes one more published fixture role limited to the unit, gives it to the team A
  // recruiter and assigns them to the team A fixture vacancy, removing all three in this check. That
  // member cannot assign or unassign themselves, but assigns the team A owner; the company owner's
  // session, whose record scope is all, assigns itself.
  await check(
    "record-assignments-scoped-self-assignment-denied",
    async (probe) => {
      probe.at("setup");
      const scopedObject = (
        await owner.query(
          "INSERT INTO app.config_objects(workspace_id,type,key,created_by) VALUES($1::uuid,'role',$2,$3) RETURNING id::text AS id",
          [COMPANY_WORKSPACE, configKey("scoped-role"), f.users.a1],
        )
      ).rows[0].id as string;
      let pass: boolean;
      try {
        const scopedVersion = (
          await owner.query(
            "INSERT INTO app.config_versions(object_id,workspace_id,state,number,body,created_by,published_at) VALUES($1::uuid,$2::uuid,'published',1,$3::jsonb,$4,now()) RETURNING id::text AS id",
            [
              scopedObject,
              COMPANY_WORKSPACE,
              JSON.stringify({
                ...RECRUITER_ROLE.body,
                name: "Fictional unit recruiter",
                recordScope: {
                  pipeline: "unit",
                  candidates: "unit",
                  tasks: "unit",
                },
              }),
              f.users.a1,
            ],
          )
        ).rows[0].id as string;
        await owner.query(
          "UPDATE app.config_objects SET current_version_id = $2::uuid WHERE id = $1::uuid",
          [scopedObject, scopedVersion],
        );
        const assigned = await owner.query(
          "INSERT INTO app.member_roles(team_id,user_id,role_object_id) VALUES($1,$2,$3::uuid)",
          [f.teams.a, f.users.a2, scopedObject],
        );
        const placed = await owner.query(
          "INSERT INTO app.record_assignments(team_id,record_id,user_id,relation) VALUES($1,$2::uuid,$3,'interviewer')",
          [f.teams.a, a.vacancy, f.users.a2],
        );
        const helper = (fn: string, user: string, relation: string) =>
          attempt(
            data,
            `SELECT tenant_context.${fn}($1::uuid, $2, $3) AS changed`,
            [a.vacancy, user, relation],
          );
        const scoped = await transaction(data, async () => {
          probe.at("install");
          const { access } = await installAs(data, signer, p.memberA);
          probe.at("outcome");
          const self = await helper("add_assignment", f.users.a2, "assignee");
          const unself = await helper(
            "remove_assignment",
            f.users.a2,
            "interviewer",
          );
          probe.at("positive-control");
          const other = await helper("add_assignment", f.users.a1, "assignee");
          return { access, self, unself, other };
        });
        const all = await transaction(data, async () => {
          await installAs(data, signer, p.ownerA);
          return helper("add_assignment", f.users.a1, "assignee");
        });
        pass = probe.all(
          [
            "setup",
            assigned.rowCount === 1 &&
              placed.rowCount === 1 &&
              scoped.access.roleVersionId === scopedVersion &&
              scoped.access.recordScope?.pipeline === "unit",
          ],
          failsWith(scoped.self, "RQ014"),
          failsWith(scoped.unself, "RQ014"),
          outcomeIs(
            scoped.other.ok && scoped.other.rows[0]?.changed === true,
            scoped.other,
            "positive-control",
          ),
          outcomeIs(
            all.ok && all.rows[0]?.changed === true,
            all,
            "positive-control",
          ),
        );
      } finally {
        await owner.query(
          "DELETE FROM app.record_assignments WHERE team_id LIKE $1",
          [f.pattern],
        );
        await owner.query(
          "DELETE FROM app.member_roles WHERE team_id LIKE $1",
          [f.pattern],
        );
        await owner.query(
          "DELETE FROM app.config_objects WHERE id = $1::uuid",
          [scopedObject],
        );
      }
      probe.at("end-state");
      return (
        pass &&
        probe.all([
          "end-state",
          (await assignmentRows()) === 0 && (await memberRoles()) === 0,
        ])
      );
    },
  );

  // Record scope in row-level security (0038). The owner writes one more published fixture role
  // limited to the unit, gives it to the team A recruiter, who holds no position and so no home
  // unit, assigns them to the team A fixture vacancy and the team A owner to the fixture candidate,
  // and removes all four in each check. Every data-role write here is rolled back.
  async function withUnitScopedMember(
    probe: Probe,
    name: string,
    work: () => Promise<boolean>,
  ) {
    probe.at("setup");
    const object = (
      await owner.query(
        "INSERT INTO app.config_objects(workspace_id,type,key,created_by) VALUES($1::uuid,'role',$2,$3) RETURNING id::text AS id",
        [COMPANY_WORKSPACE, configKey(name), f.users.a1],
      )
    ).rows[0].id as string;
    try {
      const version = (
        await owner.query(
          "INSERT INTO app.config_versions(object_id,workspace_id,state,number,body,created_by,published_at) VALUES($1::uuid,$2::uuid,'published',1,$3::jsonb,$4,now()) RETURNING id::text AS id",
          [
            object,
            COMPANY_WORKSPACE,
            JSON.stringify({
              ...RECRUITER_ROLE.body,
              name: "Fictional unit recruiter",
              recordScope: {
                pipeline: "unit",
                candidates: "unit",
                tasks: "unit",
              },
            }),
            f.users.a1,
          ],
        )
      ).rows[0].id as string;
      await owner.query(
        "UPDATE app.config_objects SET current_version_id = $2::uuid WHERE id = $1::uuid",
        [object, version],
      );
      const assigned = await owner.query(
        "INSERT INTO app.member_roles(team_id,user_id,role_object_id) VALUES($1,$2,$3::uuid)",
        [f.teams.a, f.users.a2, object],
      );
      const placed = await owner.query(
        "INSERT INTO app.record_assignments(team_id,record_id,user_id,relation) VALUES($1,$2::uuid,$3,'interviewer'),($1,$4::uuid,$5,'interviewer')",
        [f.teams.a, a.vacancy, f.users.a2, a.candidate, f.users.a1],
      );
      return (
        probe.all([
          "setup",
          assigned.rowCount === 1 && placed.rowCount === 2,
        ]) && (await work())
      );
    } finally {
      await owner.query(
        "DELETE FROM app.record_assignments WHERE team_id LIKE $1",
        [f.pattern],
      );
      await owner.query("DELETE FROM app.member_roles WHERE team_id LIKE $1", [
        f.pattern,
      ]);
      await owner.query("DELETE FROM app.config_objects WHERE id = $1::uuid", [
        object,
      ]);
    }
  }
  const scopedEnd = async (probe: Probe, pass: boolean) => {
    probe.at("end-state");
    return (
      pass &&
      probe.all([
        "end-state",
        (await assignmentRows()) === 0 && (await memberRoles()) === 0,
      ])
    );
  };

  // Under the unit-scoped context, direct SQL reads and writes only records in scope, here the
  // assigned vacancy: not the candidate (no application), its activity, upload or assignment.
  await check("record-scope-direct-sql", async (probe) => {
    // The fixture candidate's upload, by the given user.
    const upload = (userId: string) =>
      attempt(data, INSERT_UPLOAD, [
        f.teams.a,
        a.candidate,
        `${f.prefix}-scope.pdf`,
        UPLOAD_BYTES,
        `${f.prefix}/scope/cv.pdf`,
        f.stores.seed,
        userId,
      ]);
    const event = (recordId: string, kind: string) =>
      attempt(
        data,
        "INSERT INTO app.activity(team_id,record_id,actor_id,actor_type,action,kind,summary) VALUES($1,$2::uuid,$3,'session','updated',$4,$5)",
        [f.teams.a, recordId, f.users.a2, kind, `Fictional event ${f.prefix}`],
      );
    const pass = await withUnitScopedMember(probe, "rls-direct", async () => {
      const scoped = await transaction(data, async () => {
        probe.at("install");
        const { access } = await installAs(data, signer, p.memberA);
        await data.query(
          "SELECT tenant_context.lock_storage_allocation('blob','development',$1)",
          [f.stores.seed],
        );
        probe.at("outcome");
        const ids = (text: string) =>
          attempt(data, text, [f.teams.a]).then((outcome) => ({
            outcome,
            ids: outcome.rows.map((row) => row.id),
          }));
        const records = await ids(
          "SELECT id::text AS id FROM app.records WHERE team_id = $1",
        );
        const assignments = await ids(
          "SELECT record_id::text AS id FROM app.record_assignments WHERE team_id = $1",
        );
        const events = await attempt(
          data,
          "SELECT count(*)::int AS n FROM app.activity WHERE record_id = $1::uuid",
          [a.candidate],
        );
        const uploads = await attempt(
          data,
          "SELECT count(*)::int AS n FROM app.uploads WHERE id = $1::uuid",
          [a.upload],
        );
        const insert = await attempt(
          data,
          "INSERT INTO app.records(team_id,kind,data,created_by) VALUES($1,'vacancy',$2::jsonb,$3)",
          [
            f.teams.a,
            JSON.stringify({ title: `Fictional vacancy ${f.prefix} out` }),
            f.users.a2,
          ],
        );
        const update = await attempt(
          data,
          "UPDATE app.records SET updated_at = updated_at WHERE id = $1::uuid",
          [a.candidate],
        );
        const otherEvent = await event(a.candidate, "candidate");
        const otherUpload = await upload(f.users.a2);
        probe.at("positive-control");
        const own = await attempt(
          data,
          "UPDATE app.records SET updated_at = updated_at WHERE id = $1::uuid",
          [a.vacancy],
        );
        const ownEvent = await event(a.vacancy, "vacancy");
        return {
          access,
          conditions: [
            outcomeIs(
              records.outcome.ok &&
                JSON.stringify(records.ids) === JSON.stringify([a.vacancy]),
              records.outcome,
            ),
            outcomeIs(
              assignments.outcome.ok &&
                JSON.stringify(assignments.ids) === JSON.stringify([a.vacancy]),
              assignments.outcome,
            ),
            outcomeIs(events.ok && events.rows[0]?.n === 0, events),
            outcomeIs(uploads.ok && uploads.rows[0]?.n === 0, uploads),
            denial(insert),
            leftAlone(update),
            denial(otherEvent),
            denial(otherUpload),
            outcomeIs(own.ok && own.count === 1, own, "positive-control"),
            outcomeIs(
              ownEvent.ok && ownEvent.count === 1,
              ownEvent,
              "positive-control",
            ),
          ] as Condition[],
        };
      });
      // The team A owner's context, whose record scope is all, reaches the same rows.
      const all = await transaction(data, async () => {
        await installAs(data, signer, p.ownerA);
        await data.query(
          "SELECT tenant_context.lock_storage_allocation('blob','development',$1)",
          [f.stores.seed],
        );
        return {
          records: await count(
            data,
            "SELECT count(*)::int AS n FROM app.records WHERE id = ANY($1::uuid[])",
            [[a.candidate, a.vacancy]],
          ),
          assignments: await count(
            data,
            "SELECT count(*)::int AS n FROM app.record_assignments WHERE team_id = $1",
            [f.teams.a],
          ),
          upload: await upload(f.users.a1),
        };
      });
      return probe.all(
        [
          "setup",
          scoped.access.recordScope?.pipeline === "unit" &&
            scoped.access.homeUnits.length === 0,
        ],
        ...scoped.conditions,
        [
          "positive-control",
          all.records === 2 && all.assignments === 2 && all.upload.ok,
        ],
      );
    });
    return scopedEnd(probe, pass);
  });

  // Record files (0049) under the same unit-scoped context: none of the out-of-scope candidate is
  // read or can be inserted, one for the vacancy in scope can; the team A owner reads the fixture
  // file and a team B owner context reads no record file of team A. Every write is rolled back.
  await check("record-files-scope-direct-sql", async (probe) => {
    const recordFile = (recordId: string, userId: string, key: string) =>
      attempt(data, INSERT_RECORD_FILE, [
        f.teams.a,
        recordId,
        `${f.prefix}-scope-file.pdf`,
        UPLOAD_BYTES,
        `${f.prefix}/scope/files/${key}.pdf`,
        f.stores.seed,
        userId,
      ]);
    const fixtureFile = () =>
      count(
        data,
        "SELECT count(*)::int AS n FROM app.record_files WHERE id = $1::uuid",
        [a.recordFile],
      );
    const pass = await withUnitScopedMember(probe, "rls-files", async () => {
      const scoped = await transaction(data, async () => {
        probe.at("install");
        await installAs(data, signer, p.memberA);
        await data.query(
          "SELECT tenant_context.lock_storage_allocation('blob','development',$1)",
          [f.stores.seed],
        );
        probe.at("outcome");
        const read = await attempt(
          data,
          "SELECT count(*)::int AS n FROM app.record_files WHERE team_id = $1 AND record_id = $2::uuid",
          [f.teams.a, a.candidate],
        );
        const changed = await attempt(
          data,
          "UPDATE app.record_files SET original_name = original_name WHERE id = $1::uuid",
          [a.recordFile],
        );
        const other = await recordFile(a.candidate, f.users.a2, "other");
        probe.at("positive-control");
        const own = await recordFile(a.vacancy, f.users.a2, "own");
        return [
          outcomeIs(read.ok && read.rows[0]?.n === 0, read),
          leftAlone(changed),
          denial(other),
          outcomeIs(own.ok && own.count === 1, own, "positive-control"),
        ] as Condition[];
      });
      const all = await transaction(data, async () => {
        await installAs(data, signer, p.ownerA);
        return fixtureFile();
      });
      const otherTeam = await transaction(data, async () => {
        await installAs(data, signer, p.ownerB);
        return {
          file: await fixtureFile(),
          team: await count(
            data,
            "SELECT count(*)::int AS n FROM app.record_files WHERE team_id = $1",
            [f.teams.a],
          ),
        };
      });
      return probe.all(
        ...scoped,
        ["positive-control", all === 1],
        ["outcome", otherTeam.file === 0 && otherTeam.team === 0],
      );
    });
    return scopedEnd(probe, pass);
  });

  // A scoped context reads, changes and deletes no other actor's cached response, and cannot write
  // one under another actor's key; its own key is accepted.
  await check("record-scope-idempotency-actor-only", async (probe) => {
    const others = () =>
      count(
        owner,
        "SELECT count(*)::int AS n FROM app.idempotency WHERE team_id = $1 AND actor_key = $2",
        [f.teams.a, `${f.users.a1}:session:session`],
      );
    const before = await others();
    const pass = await withUnitScopedMember(probe, "rls-idempotency", () =>
      transaction(data, async () => {
        probe.at("install");
        await installAs(data, signer, p.memberA);
        probe.at("outcome");
        const read = await attempt(
          data,
          "SELECT count(*)::int AS n FROM app.idempotency WHERE team_id = $1",
          [f.teams.a],
        );
        const changed = await attempt(
          data,
          "UPDATE app.idempotency SET response = '{}'::jsonb WHERE team_id = $1",
          [f.teams.a],
        );
        const deleted = await attempt(
          data,
          "DELETE FROM app.idempotency WHERE team_id = $1",
          [f.teams.a],
        );
        const write = (actorKey: string) =>
          attempt(
            data,
            "INSERT INTO app.idempotency(team_id,actor_key,operation,key,payload_hash,response,expires_at) VALUES($1,$2,'fixture',$3,$4,'{}'::jsonb,now() + interval '1 hour')",
            [f.teams.a, actorKey, `${f.teams.a}-scoped`, "0".repeat(64)],
          );
        const forged = await write(`${f.users.a1}:session:session`);
        probe.at("positive-control");
        const own = await write(`${f.users.a2}:session:session`);
        return probe.all(
          outcomeIs(read.ok && read.rows[0]?.n === 0, read),
          leftAlone(changed),
          leftAlone(deleted),
          denial(forged),
          outcomeIs(own.ok && own.count === 1, own, "positive-control"),
        );
      }),
    );
    return (
      (await scopedEnd(probe, pass)) &&
      probe.all(["end-state", before === 1 && (await others()) === 1])
    );
  });

  // Last, because a successful grant writes a workspace-authority activity row. The FOR SHARE lock
  // in set_workspace_authority's membership check (0029) orders a grant and a concurrent removal of
  // the target's last membership: whichever commits second waits for the first.
  await check("workspace-authority-race", async (probe) => {
    probe.at("setup");
    // Targets use two-step sign-in, which a company level needs (0043).
    const target = async (userId: string, memberId: string) => {
      await owner.query(
        `INSERT INTO auth."user"(id,name,email,email_verified,two_factor_enabled) VALUES($1,$2,$3,true,true)`,
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

  // 0043: a company level needs two-step sign-in. After the race, whose company owner row it uses:
  // the data role, under the fixture company owner's session context, grants admin to the team B
  // member without two-step or a company authority row and is refused with RQ017, writing no row
  // and no activity.
  await check("workspace-authority-two-step-required", async (probe) => {
    const before = await workspaceRows();
    const twoStepOff = await count(
      owner,
      `SELECT count(*)::int AS n FROM auth."user" u JOIN auth.member m ON m.user_id = u.id
        WHERE u.id = $1 AND m.organization_id = $2 AND NOT u.two_factor_enabled
          AND NOT EXISTS (SELECT 1 FROM app.workspace_admins a WHERE a.user_id = u.id)`,
      [f.users.b2, f.teams.b],
    );
    const pass = await transaction(
      data,
      async () => {
        probe.at("install");
        const { access } = await installAs(data, signer, p.ownerC);
        probe.at("outcome");
        const refused = await attempt(
          data,
          "SELECT tenant_context.set_workspace_authority($1,'admin',ARRAY['fields'],false)",
          [f.users.b2],
        );
        return probe.all(
          ["setup", twoStepOff === 1 && access.companyLevel === "owner"],
          failsWith(refused, "RQ017"),
        );
      },
      true,
    );
    probe.at("end-state");
    return pass && probe.all(["end-state", (await workspaceRows()) === before]);
  });

  // An archived team is read-only for every context (0044): the team A owner's session archives it
  // through the helper; the recruiter's context then inserts no record and the owner's no task
  // board; the recruiter, made admin for this check, cannot call the helper; and after the owner
  // restores it the same inserts succeed (rolled back). The team is restored even on failure.
  await check("archived-team-write-denied", async (probe) => {
    const setArchived = (principal: Principal, archived: boolean) =>
      transaction(
        data,
        async () => {
          await installAs(data, signer, principal);
          return attempt(
            data,
            "SELECT tenant_context.set_team_archived($1, $2) AS changed",
            [f.teams.a, archived],
          );
        },
        true,
      );
    const recordInsert = () =>
      attempt(
        data,
        "INSERT INTO app.records(team_id,kind,data,created_by) VALUES($1,'candidate',$2::jsonb,$3)",
        [
          f.teams.a,
          JSON.stringify({ name: `Fictional archived ${f.prefix}` }),
          f.users.a2,
        ],
      );
    const boardInsert = () =>
      attempt(
        data,
        "INSERT INTO app.config_objects(workspace_id,team_id,type,key) VALUES($1::uuid,$2,'task-board',$3)",
        [COMPANY_WORKSPACE, f.teams.a, `${f.prefix}-archived-board`],
      );
    /** The recruiter's record insert and the owner's task-board insert, each rolled back. */
    const writes = async () => {
      const record = await transaction(data, async () => {
        const { access } = await installAs(data, signer, p.memberA);
        return { access, outcome: await recordInsert() };
      });
      const board = await transaction(data, async () => {
        const { access } = await installAs(data, signer, p.ownerA);
        return { access, outcome: await boardInsert() };
      });
      return { record, board };
    };
    const setRole = (role: string) =>
      identity.query("UPDATE auth.member SET role = $2 WHERE id = $1", [
        f.members.a2,
        role,
      ]);
    const archivedRows = () =>
      count(
        owner,
        "SELECT count(*)::int AS n FROM app.workspace_teams WHERE team_id = $1 AND archived_at IS NOT NULL",
        [f.teams.a],
      );
    let pass: boolean;
    let restored = false;
    try {
      probe.at("setup");
      const archived = await setArchived(p.ownerA, true);
      probe.at("outcome");
      const refused = await writes();
      const readOnly = [refused.record.access, refused.board.access].every(
        (access) =>
          access.teamArchived === true &&
          access.scopes.every((scope) => scope.endsWith(":read")),
      );
      const changed = await setRole("admin");
      let adminCall: Outcome | undefined;
      try {
        adminCall = await transaction(data, async () => {
          await installAs(data, signer, {
            ...p.memberA,
            scopes: ALL_SCOPES,
          });
          return attempt(
            data,
            "SELECT tenant_context.set_team_archived($1, false)",
            [f.teams.a],
          );
        });
      } finally {
        await setRole("recruiter");
      }
      const stillArchived = (await archivedRows()) === 1;
      probe.at("positive-control");
      const restore = await setArchived(p.ownerA, false);
      restored = restore.ok && restore.rows[0]?.changed === true;
      const allowed = await writes();
      pass = probe.all(
        ["setup", archived.ok && archived.rows[0]?.changed === true],
        ["outcome", readOnly],
        denial(refused.record.outcome),
        denial(refused.board.outcome),
        ["setup", changed.rowCount === 1],
        failsWith(adminCall, "42501"),
        ["outcome", stillArchived],
        ["positive-control", restored],
        outcomeIs(
          allowed.record.outcome.ok && allowed.record.outcome.count === 1,
          allowed.record.outcome,
          "positive-control",
        ),
        outcomeIs(
          allowed.board.outcome.ok && allowed.board.outcome.count === 1,
          allowed.board.outcome,
          "positive-control",
        ),
      );
    } finally {
      // Even on failure: the owner clears the archive, so no later check or run sees it.
      if (!restored)
        await owner
          .query(
            "UPDATE app.workspace_teams SET archived_at = NULL, archived_by = NULL WHERE team_id = $1",
            [f.teams.a],
          )
          .catch(() => {});
    }
    probe.at("end-state");
    return pass && probe.all(["end-state", (await archivedRows()) === 0]);
  });

  // A deactivated person gets no context (0047): while the owner marks the team A recruiter
  // deactivated, install refuses their session on both roles; once reactivated it is accepted.
  const installOutcome = async (db: Db, principal: Principal) => {
    const assertion = await assertionFor(db, signer, principal);
    return attempt(db, installSql, [assertion.payload, assertion.signature]);
  };
  const deactivatedRows = () =>
    count(
      owner,
      "SELECT count(*)::int AS n FROM app.workspace_users WHERE user_id LIKE $1 AND deactivated_at IS NOT NULL",
      [f.pattern],
    );
  await check("deactivated-context-denied", async (probe) => {
    const installs = async () => ({
      data: await transaction(data, () => installOutcome(data, p.memberA)),
      identity: await transaction(identity, () =>
        installOutcome(identity, p.memberA),
      ),
    });
    probe.at("setup");
    const active = await installs();
    let pass: boolean;
    try {
      const marked = await owner.query(
        "INSERT INTO app.workspace_users(workspace_id,user_id,deactivated_at,deactivated_by) VALUES($1::uuid,$2,now(),$3)",
        [COMPANY_WORKSPACE, f.users.a2, f.users.a1],
      );
      probe.at("outcome");
      const refused = await installs();
      probe.at("positive-control");
      const cleared = await owner.query(
        "UPDATE app.workspace_users SET deactivated_at = NULL, deactivated_by = NULL WHERE user_id = $1",
        [f.users.a2],
      );
      const restored = await installs();
      pass = probe.all(
        outcomeIs(active.data.ok, active.data, "setup"),
        outcomeIs(active.identity.ok, active.identity, "setup"),
        ["setup", marked.rowCount === 1],
        failsWith(refused.data, "42501"),
        failsWith(refused.identity, "42501"),
        ["positive-control", cleared.rowCount === 1],
        outcomeIs(restored.data.ok, restored.data, "positive-control"),
        outcomeIs(restored.identity.ok, restored.identity, "positive-control"),
      );
    } finally {
      await owner
        .query("DELETE FROM app.workspace_users WHERE user_id = $1", [
          f.users.a2,
        ])
        .catch(() => {});
    }
    probe.at("end-state");
    return pass && probe.all(["end-state", (await deactivatedRows()) === 0]);
  });

  // tenant_context.set_user_active (0047) needs a company owner, or a company admin with the people
  // area for a person without company authority. The team B owner, a company admin only for this
  // check, is refused on the team B member without people, and with people on the company owner,
  // while with people the same session deactivates the team B member (rolled back).
  await check("user-active-company-admin-denied", async (probe) => {
    const asTeamBOwner = (target: string) =>
      transaction(data, async () => {
        const { access } = await installAs(data, signer, p.ownerB);
        return {
          access,
          outcome: await attempt(
            data,
            "SELECT tenant_context.set_user_active($1, false) AS changed",
            [target],
          ),
        };
      });
    const setAreas = (areas: string) =>
      owner.query(
        "UPDATE app.workspace_admins SET areas = $3::text[] WHERE workspace_id = $1::uuid AND user_id = $2",
        [COMPANY_WORKSPACE, f.users.b1, areas],
      );
    probe.at("setup");
    const granted = await owner.query(
      "INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES($1::uuid,$2,'admin','{organisation}')",
      [COMPANY_WORKSPACE, f.users.b1],
    );
    let pass: boolean;
    try {
      probe.at("outcome");
      const withoutPeople = await asTeamBOwner(f.users.b2);
      const changed = await setAreas("{people}");
      const onOwner = await asTeamBOwner(f.users.a1);
      probe.at("positive-control");
      const onMember = await asTeamBOwner(f.users.b2);
      pass = probe.all(
        ["setup", granted.rowCount === 1 && changed.rowCount === 1],
        [
          "setup",
          withoutPeople.access.companyLevel === "admin" &&
            onOwner.access.companyAreas.join(",") === "people",
        ],
        failsWith(withoutPeople.outcome, "42501"),
        failsWith(onOwner.outcome, "42501"),
        outcomeIs(
          onMember.outcome.ok && onMember.outcome.rows[0]?.changed === true,
          onMember.outcome,
          "positive-control",
        ),
      );
    } finally {
      await owner.query(
        "DELETE FROM app.workspace_admins WHERE workspace_id = $1::uuid AND user_id = $2",
        [COMPANY_WORKSPACE, f.users.b1],
      );
    }
    probe.at("end-state");
    return (
      pass &&
      probe.all([
        "end-state",
        (await count(
          owner,
          "SELECT count(*)::int AS n FROM app.workspace_admins WHERE user_id = $1",
          [f.users.b1],
        )) === 0 &&
          (await deactivatedRows()) === 0 &&
          (await count(
            owner,
            "SELECT count(*)::int AS n FROM app.activity WHERE team_id LIKE $1 AND kind = 'user-account'",
            [f.pattern],
          )) === 0,
      ])
    );
  });

  // tenant_context.anonymise_user (0051) needs a company owner session. The team B owner, a
  // company admin with the people area only for this check, the team B owner without company
  // authority and a token context of the company owner holding every scope are refused on the team
  // A recruiter; the company owner's session reaches the name check (a wrong name, rolled back).
  const anonymiseSql =
    "SELECT tenant_context.anonymise_user($1, $2, 'app') AS result";
  /** Committed tombstones, anonymisation rows and placeholder accounts of the fixture. */
  const anonymisationsCommitted = async () =>
    (await count(
      owner,
      "SELECT count(*)::int AS n FROM app.user_anonymisations WHERE anonymised_by LIKE $1 OR user_id LIKE $1",
      [f.pattern],
    )) +
    (await count(
      owner,
      "SELECT count(*)::int AS n FROM app.activity WHERE team_id LIKE $1 AND (kind = 'user-anonymisation' OR user_anonymisation_id IS NOT NULL)",
      [f.pattern],
    )) +
    (await count(
      owner,
      `SELECT count(*)::int AS n FROM auth."user" WHERE id LIKE $1 AND email LIKE 'anonymised-%'`,
      [f.pattern],
    ));
  await check("user-anonymisation-owner-only", async (probe) => {
    const asPrincipal = (principal: Principal, name: string) =>
      transaction(data, async () => {
        const { access } = await installAs(data, signer, principal);
        return {
          access,
          outcome: await attempt(data, anonymiseSql, [f.users.a2, name]),
        };
      });
    probe.at("setup");
    const tokenId = `${f.prefix}-token-anonymise`;
    const stored = await owner.query(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now() + interval '1 hour')`,
      [
        tokenId,
        f.teams.a,
        f.users.a1,
        `Fictional token ${tokenId}`,
        createHash("sha256").update(tokenId).digest("hex"),
        tokenId,
        JSON.stringify(ALL_SCOPES),
      ],
    );
    const token: Principal = {
      team: f.teams.a,
      actor: f.users.a1,
      auth: "token",
      token: tokenId,
      scopes: ALL_SCOPES,
    };
    let pass: boolean;
    try {
      probe.at("outcome");
      const teamOwner = await asPrincipal(p.ownerB, "Fictional member");
      const tokenOutcome = await asPrincipal(token, "Fictional member");
      probe.at("setup");
      const granted = await owner.query(
        "INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES($1::uuid,$2,'admin','{people}')",
        [COMPANY_WORKSPACE, f.users.b1],
      );
      probe.at("outcome");
      const peopleAdmin = await asPrincipal(p.ownerB, "Fictional member");
      probe.at("positive-control");
      const control = await asPrincipal(p.ownerA, "Fictional someone else");
      pass = probe.all(
        [
          "setup",
          stored.rowCount === 1 &&
            granted.rowCount === 1 &&
            teamOwner.access.companyLevel === null &&
            tokenOutcome.access.companyLevel === "owner" &&
            peopleAdmin.access.companyAreas.join(",") === "people",
        ],
        failsWith(teamOwner.outcome, "42501"),
        failsWith(tokenOutcome.outcome, "42501"),
        failsWith(peopleAdmin.outcome, "42501"),
        outcomeIs(
          control.outcome.ok === false && control.outcome.code === "RQ003",
          control.outcome,
          "positive-control",
        ),
      );
    } finally {
      await owner.query("DELETE FROM auth.api_tokens WHERE id = $1", [tokenId]);
      await owner.query(
        "DELETE FROM app.workspace_admins WHERE workspace_id = $1::uuid AND user_id = $2",
        [COMPANY_WORKSPACE, f.users.b1],
      );
    }
    probe.at("end-state");
    return (
      pass &&
      probe.all([
        "end-state",
        (await anonymisationsCommitted()) === 0 &&
          (await count(
            owner,
            "SELECT count(*)::int AS n FROM app.workspace_admins WHERE user_id = $1",
            [f.users.b1],
          )) === 0,
      ])
    );
  });

  // The data role selects, inserts and updates no anonymisation tombstone, even under the company
  // owner's session; the same transaction still reads the fixture people.
  await check("user-anonymisation-tombstone-denied", async (probe) => {
    const pass = await transaction(data, async () => {
      probe.at("install");
      await installAs(data, signer, p.ownerA);
      probe.at("outcome");
      const read = await attempt(
        data,
        "SELECT count(*)::int AS n FROM app.user_anonymisations",
      );
      const inserted = await attempt(
        data,
        "INSERT INTO app.user_anonymisations(id,workspace_id,user_id,anonymised_by,anonymised_at,erasure_source) VALUES(gen_random_uuid(),$1::uuid,$2,$3,now(),'app')",
        [COMPANY_WORKSPACE, f.users.a2, f.users.a1],
      );
      const updated = await attempt(
        data,
        "UPDATE app.user_anonymisations SET anonymised_at = now() WHERE anonymised_by LIKE $1",
        [f.pattern],
      );
      probe.at("positive-control");
      const people = await count(
        data,
        "SELECT count(*)::int AS n FROM app.records WHERE team_id = $1 AND kind = 'candidate'",
        [f.teams.a],
      );
      return probe.all(denial(read), denial(inserted), denial(updated), [
        "positive-control",
        people > 0,
      ]);
    });
    probe.at("end-state");
    return (
      pass && probe.all(["end-state", (await anonymisationsCommitted()) === 0])
    );
  });

  // The data role cannot point an activity row at an anonymisation tombstone, even under the
  // company owner's session: the statement is refused and no fixture row carries one.
  await check("user-anonymisation-activity-denied", async (probe) => {
    const pass = await transaction(data, async () => {
      probe.at("install");
      await installAs(data, signer, p.ownerA);
      probe.at("outcome");
      const updated = await attempt(
        data,
        "UPDATE app.activity SET user_anonymisation_id = gen_random_uuid() WHERE team_id = $1",
        [f.teams.a],
      );
      probe.at("positive-control");
      const visible = await count(
        data,
        "SELECT count(*)::int AS n FROM app.activity WHERE team_id = $1",
        [f.teams.a],
      );
      return probe.all(outcomeIs(!updated.ok, updated), [
        "positive-control",
        visible > 0,
      ]);
    });
    probe.at("end-state");
    return (
      pass && probe.all(["end-state", (await anonymisationsCommitted()) === 0])
    );
  });

  // Salary brackets (0048) are read only by a session holding Plan & pay access and plans:read, and
  // written only with plans:write by a company owner or admin with organisation who holds the grant.
  // Each check runs on one owner-written draft version with one bracket, created_by the team A owner,
  // and removes it; a grant changed for a check is set back to what it was.
  const bracketFixture = async () =>
    (
      await owner.query(
        "INSERT INTO app.salary_bracket_versions(workspace_id,effective_from,created_by) VALUES($1::uuid,'2027-01-01',$2) RETURNING id::text AS id",
        [COMPANY_WORKSPACE, f.users.a1],
      )
    ).rows[0].id as string;
  const withBrackets = async <T>(work: (version: string) => Promise<T>) => {
    const version = await bracketFixture();
    try {
      await owner.query(
        "INSERT INTO app.salary_brackets(version_id,workspace_id,grade_code,minimum_fils,midpoint_fils,maximum_fils) VALUES($1::uuid,$2::uuid,'G7',1000000,1500000,2000000)",
        [version, COMPANY_WORKSPACE],
      );
      return await work(version);
    } finally {
      await owner
        .query("DELETE FROM app.salary_bracket_versions WHERE id = $1::uuid", [
          version,
        ])
        .catch(() => {});
    }
  };
  /** Runs work with the user's Plan & pay access set to held, then sets it back. */
  const withGrant = async <T>(
    user: string,
    held: boolean,
    work: () => Promise<T>,
  ) => {
    const before = (
      await owner.query(
        "SELECT plan_access FROM app.workspace_admins WHERE workspace_id = $1::uuid AND user_id = $2",
        [COMPANY_WORKSPACE, user],
      )
    ).rows[0]?.plan_access as boolean | undefined;
    const setGrant = (value: boolean) =>
      owner.query(
        "UPDATE app.workspace_admins SET plan_access = $3 WHERE workspace_id = $1::uuid AND user_id = $2",
        [COMPANY_WORKSPACE, user, value],
      );
    if (before === undefined) return { set: false, value: await work() };
    await setGrant(held);
    try {
      return { set: true, value: await work() };
    } finally {
      await setGrant(before).catch(() => {});
    }
  };
  /** What a context reads of the fixture, and its draft insert, update and publish, rolled back. */
  const bracketProbe = (principal: Principal, version: string) =>
    transaction(data, async () => {
      const { access } = await installAs(data, signer, principal);
      const read = await attempt(
        data,
        "SELECT (SELECT count(*) FROM app.salary_bracket_versions WHERE id = $1::uuid)::int AS versions, (SELECT count(*) FROM app.salary_brackets WHERE version_id = $1::uuid)::int AS brackets",
        [version],
      );
      const insert = await attempt(
        data,
        "INSERT INTO app.salary_bracket_versions(workspace_id,effective_from) VALUES($1::uuid,'2027-02-01')",
        [COMPANY_WORKSPACE],
      );
      const update = await attempt(
        data,
        "UPDATE app.salary_bracket_versions SET pay_period = 'annual' WHERE id = $1::uuid",
        [version],
      );
      const publish = await attempt(
        data,
        "SELECT tenant_context.publish_bracket_version($1::uuid) AS number",
        [version],
      );
      return { access, read, insert, update, publish };
    });
  const readsNone = (outcome: Outcome) =>
    outcomeIs(
      outcome.ok &&
        outcome.rows[0]?.versions === 0 &&
        outcome.rows[0]?.brackets === 0,
      outcome,
    );
  const readsFixture = (outcome: Outcome, phase: Phase = "outcome") =>
    outcomeIs(
      outcome.ok &&
        outcome.rows[0]?.versions === 1 &&
        outcome.rows[0]?.brackets === 1,
      outcome,
      phase,
    );
  const fixtureUnchanged = async (version: string) =>
    (await count(
      owner,
      "SELECT count(*)::int AS n FROM app.salary_bracket_versions WHERE id = $1::uuid AND state = 'draft' AND pay_period = 'monthly' AND number IS NULL",
      [version],
    )) === 1;
  const bracketsGone = async () =>
    (await count(
      owner,
      "SELECT count(*)::int AS n FROM app.salary_bracket_versions WHERE created_by LIKE $1",
      [f.pattern],
    )) === 0 &&
    (await count(
      owner,
      "SELECT count(*)::int AS n FROM app.activity WHERE team_id LIKE $1 AND kind = 'salary-brackets'",
      [f.pattern],
    )) === 0;

  // The team B owner holds no company authority, so no grant: reads nothing and writes nothing,
  // while the team A owner holding the grant reads the same fixture.
  await check("salary-brackets-team-b-owner-denied", async (probe) => {
    probe.at("setup");
    const pass = await withBrackets(async (version) => {
      probe.at("outcome");
      const denied = await bracketProbe(p.ownerB, version);
      probe.at("positive-control");
      const holder = await withGrant(f.users.a1, true, () =>
        bracketProbe(p.ownerA, version),
      );
      return probe.all(
        ["setup", denied.access.companyLevel === null && holder.set],
        readsNone(denied.read),
        denial(denied.insert),
        leftAlone(denied.update),
        denial(denied.publish),
        readsFixture(holder.value.read, "positive-control"),
        ["end-state", await fixtureUnchanged(version)],
      );
    });
    probe.at("end-state");
    return pass && probe.all(["end-state", await bracketsGone()]);
  });

  // A company owner who has not granted themselves Plan & pay access reads and writes nothing; with
  // the grant the same session reads the fixture.
  await check("salary-brackets-owner-without-grant-denied", async (probe) => {
    probe.at("setup");
    const pass = await withBrackets(async (version) => {
      probe.at("outcome");
      const denied = await withGrant(f.users.c1, false, () =>
        bracketProbe(p.ownerC, version),
      );
      probe.at("positive-control");
      const granted = await withGrant(f.users.c1, true, () =>
        bracketProbe(p.ownerC, version),
      );
      return probe.all(
        ["setup", denied.set && denied.value.access.companyLevel === "owner"],
        readsNone(denied.value.read),
        denial(denied.value.insert),
        leftAlone(denied.value.update),
        denial(denied.value.publish),
        readsFixture(granted.value.read, "positive-control"),
        ["end-state", await fixtureUnchanged(version)],
      );
    });
    probe.at("end-state");
    return pass && probe.all(["end-state", await bracketsGone()]);
  });

  // A grant holder whose context lacks plans:write reads the fixture but inserts, updates and
  // publishes nothing.
  await check(
    "salary-brackets-holder-without-plans-write-denied",
    async (probe) => {
      probe.at("setup");
      const pass = await withBrackets(async (version) => {
        probe.at("outcome");
        const readOnly = await withGrant(f.users.a1, true, () =>
          bracketProbe(
            {
              ...p.ownerA,
              scopes: ALL_SCOPES.filter((scope) => scope !== "plans:write"),
            },
            version,
          ),
        );
        return probe.all(
          [
            "setup",
            readOnly.set &&
              readOnly.value.access.companyLevel === "owner" &&
              !readOnly.value.access.scopes.includes("plans:write"),
          ],
          readsFixture(readOnly.value.read),
          denial(readOnly.value.insert),
          leftAlone(readOnly.value.update),
          denial(readOnly.value.publish),
          ["end-state", await fixtureUnchanged(version)],
        );
      });
      probe.at("end-state");
      return pass && probe.all(["end-state", await bracketsGone()]);
    },
  );

  // The team A owner, a company owner holding the grant and both plan scopes, reads the fixture,
  // inserts a draft and edits the fixture's pay period (rolled back); an API token of theirs holding
  // every scope, the plan scopes included, reads and writes nothing.
  await check("salary-brackets-holder-reads", async (probe) => {
    probe.at("setup");
    const tokenId = `${f.prefix}-token-brackets`;
    const stored = await owner.query(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now() + interval '1 hour')`,
      [
        tokenId,
        f.teams.a,
        f.users.a1,
        `Fictional token ${tokenId}`,
        createHash("sha256").update(tokenId).digest("hex"),
        tokenId,
        JSON.stringify(ALL_SCOPES),
      ],
    );
    const token: Principal = {
      team: f.teams.a,
      actor: f.users.a1,
      auth: "token",
      token: tokenId,
      scopes: ALL_SCOPES,
    };
    let pass: boolean;
    try {
      pass = await withBrackets(async (version) => {
        probe.at("outcome");
        const holder = await withGrant(f.users.a1, true, async () => ({
          session: await bracketProbe(p.ownerA, version),
          token: await bracketProbe(token, version),
        }));
        const { session, token: viaToken } = holder.value;
        return probe.all(
          [
            "setup",
            stored.rowCount === 1 &&
              holder.set &&
              session.access.companyLevel === "owner" &&
              viaToken.access.scopes.includes("plans:read"),
          ],
          readsFixture(session.read),
          outcomeIs(
            session.insert.ok && session.insert.count === 1,
            session.insert,
          ),
          outcomeIs(
            session.update.ok && session.update.count === 1,
            session.update,
          ),
          readsNone(viaToken.read),
          denial(viaToken.insert),
          leftAlone(viaToken.update),
          denial(viaToken.publish),
          ["end-state", await fixtureUnchanged(version)],
        );
      });
    } finally {
      await owner.query("DELETE FROM auth.api_tokens WHERE id = $1", [tokenId]);
    }
    probe.at("end-state");
    return pass && probe.all(["end-state", await bracketsGone()]);
  });

  // Job title usage (0050) is counts only, for a company owner or a company admin with
  // organisation in a session. Each check calls it for a run-prefixed key no fixture uses, so the
  // company owner's positive control gets exactly one row of three zero counts and nothing else.
  const usageKey = `${f.prefix}-title`.toLowerCase();
  const usage = (principal: Principal) =>
    transaction(data, async () => {
      const { access } = await installAs(data, signer, principal);
      return {
        access,
        outcome: await attempt(
          data,
          "SELECT * FROM tenant_context.job_title_usage($1)",
          [usageKey],
        ),
      };
    });
  const countsOnly = (outcome: Outcome) =>
    outcomeIs(
      outcome.ok &&
        outcome.rows.length === 1 &&
        Object.keys(outcome.rows[0]).join(",") ===
          "positions,open_vacancies,open_offers" &&
        outcome.rows[0].positions === 0 &&
        outcome.rows[0].open_vacancies === 0 &&
        outcome.rows[0].open_offers === 0,
      outcome,
      "positive-control",
    );

  // The team B owner holds no company authority and gets no counts; the company owner does.
  await check("job-title-usage-team-b-owner-denied", async (probe) => {
    probe.at("outcome");
    const denied = await usage(p.ownerB);
    probe.at("positive-control");
    const allowed = await usage(p.ownerA);
    return probe.all(
      [
        "setup",
        denied.access.companyLevel === null &&
          allowed.access.companyLevel === "owner",
      ],
      failsWith(denied.outcome, "42501"),
      countsOnly(allowed.outcome),
    );
  });

  // The team B owner, made a company admin with the fields area only for this check, gets no
  // counts either: the helper needs organisation. The company owner gets them.
  await check(
    "job-title-usage-admin-without-organisation-denied",
    async (probe) => {
      probe.at("setup");
      const granted = await owner.query(
        "INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES($1::uuid,$2,'admin','{fields}')",
        [COMPANY_WORKSPACE, f.users.b1],
      );
      let pass: boolean;
      try {
        probe.at("outcome");
        const denied = await usage(p.ownerB);
        probe.at("positive-control");
        const allowed = await usage(p.ownerA);
        pass = probe.all(
          [
            "setup",
            granted.rowCount === 1 &&
              denied.access.companyLevel === "admin" &&
              denied.access.companyAreas.join(",") === "fields",
          ],
          failsWith(denied.outcome, "42501"),
          countsOnly(allowed.outcome),
        );
      } finally {
        await owner.query(
          "DELETE FROM app.workspace_admins WHERE workspace_id = $1::uuid AND user_id = $2",
          [COMPANY_WORKSPACE, f.users.b1],
        );
      }
      probe.at("end-state");
      return (
        pass &&
        probe.all([
          "end-state",
          (await count(
            owner,
            "SELECT count(*)::int AS n FROM app.workspace_admins WHERE user_id = $1",
            [f.users.b1],
          )) === 0,
        ])
      );
    },
  );

  // An API token of the company owner holding every scope gets no counts: the helper takes
  // sessions only. The same owner's session gets them.
  await check("job-title-usage-token-denied", async (probe) => {
    probe.at("setup");
    const tokenId = `${f.prefix}-token-usage`;
    const stored = await owner.query(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now() + interval '1 hour')`,
      [
        tokenId,
        f.teams.a,
        f.users.a1,
        `Fictional token ${tokenId}`,
        createHash("sha256").update(tokenId).digest("hex"),
        tokenId,
        JSON.stringify(ALL_SCOPES),
      ],
    );
    let pass: boolean;
    try {
      probe.at("outcome");
      const denied = await usage({
        team: f.teams.a,
        actor: f.users.a1,
        auth: "token",
        token: tokenId,
        scopes: ALL_SCOPES,
      });
      probe.at("positive-control");
      const allowed = await usage(p.ownerA);
      pass = probe.all(
        [
          "setup",
          stored.rowCount === 1 && allowed.access.companyLevel === "owner",
        ],
        failsWith(denied.outcome, "42501"),
        countsOnly(allowed.outcome),
      );
    } finally {
      await owner.query("DELETE FROM auth.api_tokens WHERE id = $1", [tokenId]);
    }
    probe.at("end-state");
    return (
      pass &&
      probe.all([
        "end-state",
        (await count(
          owner,
          "SELECT count(*)::int AS n FROM auth.api_tokens WHERE id = $1",
          [tokenId],
        )) === 0,
      ])
    );
  });

  // Field usage (0055) is a count only, for a company owner or a company admin with fields in a
  // session. Each check calls it for a fresh uuid no published kind schema holds, so the company
  // owner's positive control gets exactly one row of one zero count and nothing else.
  const fieldId = randomUUID();
  const fieldUsage = (principal: Principal) =>
    transaction(data, async () => {
      const { access } = await installAs(data, signer, principal);
      return {
        access,
        outcome: await attempt(
          data,
          "SELECT tenant_context.field_usage('candidate', $1::uuid) AS count",
          [fieldId],
        ),
      };
    });
  const countOnly = (outcome: Outcome) =>
    outcomeIs(
      outcome.ok &&
        outcome.rows.length === 1 &&
        Object.keys(outcome.rows[0]).join(",") === "count" &&
        outcome.rows[0].count === 0,
      outcome,
      "positive-control",
    );

  // The team B owner holds no company authority and gets no count; the company owner does.
  await check("field-usage-team-b-owner-denied", async (probe) => {
    probe.at("outcome");
    const denied = await fieldUsage(p.ownerB);
    probe.at("positive-control");
    const allowed = await fieldUsage(p.ownerA);
    return probe.all(
      [
        "setup",
        denied.access.companyLevel === null &&
          allowed.access.companyLevel === "owner",
      ],
      failsWith(denied.outcome, "42501"),
      countOnly(allowed.outcome),
    );
  });

  // The team B owner, made a company admin with the organisation area only for this check, gets no
  // count either: the helper needs fields. The company owner gets it.
  await check("field-usage-admin-without-fields-denied", async (probe) => {
    probe.at("setup");
    const granted = await owner.query(
      "INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES($1::uuid,$2,'admin','{organisation}')",
      [COMPANY_WORKSPACE, f.users.b1],
    );
    let pass: boolean;
    try {
      probe.at("outcome");
      const denied = await fieldUsage(p.ownerB);
      probe.at("positive-control");
      const allowed = await fieldUsage(p.ownerA);
      pass = probe.all(
        [
          "setup",
          granted.rowCount === 1 &&
            denied.access.companyLevel === "admin" &&
            denied.access.companyAreas.join(",") === "organisation",
        ],
        failsWith(denied.outcome, "42501"),
        countOnly(allowed.outcome),
      );
    } finally {
      await owner.query(
        "DELETE FROM app.workspace_admins WHERE workspace_id = $1::uuid AND user_id = $2",
        [COMPANY_WORKSPACE, f.users.b1],
      );
    }
    probe.at("end-state");
    return (
      pass &&
      probe.all([
        "end-state",
        (await count(
          owner,
          "SELECT count(*)::int AS n FROM app.workspace_admins WHERE user_id = $1",
          [f.users.b1],
        )) === 0,
      ])
    );
  });

  // An API token of the company owner holding every scope gets no count: the helper takes sessions
  // only. The same owner's session gets it.
  await check("field-usage-token-denied", async (probe) => {
    probe.at("setup");
    const tokenId = `${f.prefix}-token-field-usage`;
    const stored = await owner.query(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now() + interval '1 hour')`,
      [
        tokenId,
        f.teams.a,
        f.users.a1,
        `Fictional token ${tokenId}`,
        createHash("sha256").update(tokenId).digest("hex"),
        tokenId,
        JSON.stringify(ALL_SCOPES),
      ],
    );
    let pass: boolean;
    try {
      probe.at("outcome");
      const denied = await fieldUsage({
        team: f.teams.a,
        actor: f.users.a1,
        auth: "token",
        token: tokenId,
        scopes: ALL_SCOPES,
      });
      probe.at("positive-control");
      const allowed = await fieldUsage(p.ownerA);
      pass = probe.all(
        [
          "setup",
          stored.rowCount === 1 && allowed.access.companyLevel === "owner",
        ],
        failsWith(denied.outcome, "42501"),
        countOnly(allowed.outcome),
      );
    } finally {
      await owner.query("DELETE FROM auth.api_tokens WHERE id = $1", [tokenId]);
    }
    probe.at("end-state");
    return (
      pass &&
      probe.all([
        "end-state",
        (await count(
          owner,
          "SELECT count(*)::int AS n FROM auth.api_tokens WHERE id = $1",
          [tokenId],
        )) === 0,
      ])
    );
  });

  // Company groups (0052): one owner-written approval group named by the run prefix, holding the
  // team A owner as a member, removed with its member and effective rows at the end of each check.
  // The owner's own SQL has no context, so it writes no group activity row.
  const withApprovalGroup = async <T>(work: (group: string) => Promise<T>) => {
    const group = (
      await owner.query(
        "INSERT INTO app.groups(workspace_id,name,approval) VALUES($1::uuid,$2,true) RETURNING id::text AS id",
        [COMPANY_WORKSPACE, `${f.prefix}-group-approval`],
      )
    ).rows[0].id as string;
    try {
      await owner.query(
        "INSERT INTO app.group_members(group_id,workspace_id,user_id) VALUES($1::uuid,$2::uuid,$3)",
        [group, COMPANY_WORKSPACE, f.users.a1],
      );
      return await work(group);
    } finally {
      await owner
        .query("DELETE FROM app.groups WHERE id = $1::uuid", [group])
        .catch(() => {});
    }
  };
  const groupsGone = async () =>
    (await count(
      owner,
      "SELECT count(*)::int AS n FROM app.groups WHERE name LIKE $1",
      [f.pattern],
    )) === 0 &&
    (await count(
      owner,
      "SELECT count(*)::int AS n FROM app.activity WHERE team_id LIKE $1 AND kind = 'group'",
      [f.pattern],
    )) === 0;
  const memberSql =
    "INSERT INTO app.group_members(group_id,workspace_id,user_id) VALUES($1::uuid,$2::uuid,$3)";

  // The team B owner, made a company admin with the people area for this check, cannot add a member
  // to an approval group by direct SQL (42501 from app.guard_group_write); the company owner can
  // (rolled back).
  await check("groups-admin-approval-insert-denied", async (probe) => {
    probe.at("setup");
    const granted = await owner.query(
      "INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES($1::uuid,$2,'admin','{people}')",
      [COMPANY_WORKSPACE, f.users.b1],
    );
    let pass: boolean;
    try {
      pass = await withApprovalGroup(async (group) => {
        const insertAs = (principal: Principal) =>
          transaction(data, async () => {
            const { access } = await installAs(data, signer, principal);
            return {
              access,
              outcome: await attempt(data, memberSql, [
                group,
                COMPANY_WORKSPACE,
                f.users.a2,
              ]),
            };
          });
        probe.at("outcome");
        const admin = await insertAs(p.ownerB);
        probe.at("positive-control");
        const control = await insertAs(p.ownerA);
        probe.at("end-state");
        const members = await count(
          owner,
          "SELECT count(*)::int AS n FROM app.group_members WHERE group_id = $1::uuid",
          [group],
        );
        return probe.all(
          [
            "setup",
            granted.rowCount === 1 &&
              admin.access.companyLevel === "admin" &&
              admin.access.companyAreas.join(",") === "people" &&
              control.access.companyLevel === "owner",
          ],
          failsWith(admin.outcome, "42501"),
          outcomeIs(
            control.outcome.ok && control.outcome.count === 1,
            control.outcome,
            "positive-control",
          ),
          ["end-state", members === 1],
        );
      });
    } finally {
      await owner.query(
        "DELETE FROM app.workspace_admins WHERE workspace_id = $1::uuid AND user_id = $2",
        [COMPANY_WORKSPACE, f.users.b1],
      );
    }
    probe.at("end-state");
    return (
      pass &&
      probe.all([
        "end-state",
        (await groupsGone()) &&
          (await count(
            owner,
            "SELECT count(*)::int AS n FROM app.workspace_admins WHERE user_id = $1",
            [f.users.b1],
          )) === 0,
      ])
    );
  });

  // No runtime role writes effective membership, even under the company owner's session: the
  // insert, update and delete are not granted, while the same context reads the fixture's row.
  await check("groups-effective-insert-denied", async (probe) => {
    probe.at("setup");
    const pass = await withApprovalGroup((group) =>
      transaction(data, async () => {
        probe.at("install");
        await installAs(data, signer, p.ownerA);
        probe.at("outcome");
        const inserted = await attempt(
          data,
          "INSERT INTO app.group_effective_members(workspace_id,group_id,user_id) VALUES($1::uuid,$2::uuid,$3)",
          [COMPANY_WORKSPACE, group, f.users.a2],
        );
        const updated = await attempt(
          data,
          "UPDATE app.group_effective_members SET user_id = user_id WHERE group_id = $1::uuid",
          [group],
        );
        const deleted = await attempt(
          data,
          "DELETE FROM app.group_effective_members WHERE group_id = $1::uuid",
          [group],
        );
        probe.at("positive-control");
        const visible = await count(
          data,
          "SELECT count(*)::int AS n FROM app.group_effective_members WHERE group_id = $1::uuid AND user_id = $2",
          [group, f.users.a1],
        );
        return probe.all(denial(inserted), denial(updated), denial(deleted), [
          "positive-control",
          visible === 1,
        ]);
      }),
    );
    probe.at("end-state");
    return pass && probe.all(["end-state", await groupsGone()]);
  });

  // A delegated manager (0056): the team A member, with neither company owner level nor the people
  // area (an earlier check leaves them a company admin with fields), is named manager of
  // a plain owner-written group and adds a user member by direct SQL as the data role (rolled
  // back); once the owner flags that group as an approval group, the same insert is 42501 from
  // app.guard_group_write.
  await check("groups-manager-granting-denied", async (probe) => {
    probe.at("setup");
    const group = (
      await owner.query(
        "INSERT INTO app.groups(workspace_id,name) VALUES($1::uuid,$2) RETURNING id::text AS id",
        [COMPANY_WORKSPACE, `${f.prefix}-group-managed`],
      )
    ).rows[0].id as string;
    let pass: boolean;
    try {
      const named = await owner.query(
        "INSERT INTO app.group_managers(group_id,workspace_id,user_id) VALUES($1::uuid,$2::uuid,$3)",
        [group, COMPANY_WORKSPACE, f.users.a2],
      );
      const insertAsManager = () =>
        transaction(data, async () => {
          const { access } = await installAs(data, signer, p.memberA);
          return {
            access,
            outcome: await attempt(data, memberSql, [
              group,
              COMPANY_WORKSPACE,
              f.users.a1,
            ]),
          };
        });
      probe.at("positive-control");
      const control = await insertAsManager();
      const flagged = await owner.query(
        "UPDATE app.groups SET approval = true WHERE id = $1::uuid",
        [group],
      );
      probe.at("outcome");
      const manager = await insertAsManager();
      probe.at("end-state");
      const members = await count(
        owner,
        "SELECT count(*)::int AS n FROM app.group_members WHERE group_id = $1::uuid",
        [group],
      );
      // Below the company owner or people bar either way: the manager rules decide.
      const belowBar = ({ access }: { access: Access }) =>
        access.companyLevel !== "owner" &&
        !access.companyAreas.includes("people");
      pass = probe.all(
        [
          "setup",
          named.rowCount === 1 &&
            flagged.rowCount === 1 &&
            belowBar(manager) &&
            belowBar(control),
        ],
        outcomeIs(
          control.outcome.ok && control.outcome.count === 1,
          control.outcome,
          "positive-control",
        ),
        failsWith(manager.outcome, "42501"),
        ["end-state", members === 0],
      );
    } finally {
      await owner
        .query("DELETE FROM app.groups WHERE id = $1::uuid", [group])
        .catch(() => {});
    }
    probe.at("end-state");
    return pass && probe.all(["end-state", await groupsGone()]);
  });

  // Groups as role grantees (0057): once a plain owner-written group gives the fixture role in
  // team B (a team its only member, the team A owner, is not in, so it reaches nobody), it is
  // company owner only. Under the team B owner made a company admin with people, a user member
  // insert into it and a grant insert and delete are 42501 (app.guard_group_write, the
  // app.group_roles insert policy and app.guard_group_role); under the team B owner with no company
  // authority the grant insert is 42501 and the delete reaches no row (row-level security hides
  // the grants). The company owner's grant delete is the positive control (rolled back).
  await check("groups-role-granting-insert-denied", async (probe) => {
    probe.at("setup");
    const group = (
      await owner.query(
        "INSERT INTO app.groups(workspace_id,name) VALUES($1::uuid,$2) RETURNING id::text AS id",
        [COMPANY_WORKSPACE, `${f.prefix}-group-role`],
      )
    ).rows[0].id as string;
    let pass: boolean;
    try {
      await owner.query(memberSql, [group, COMPANY_WORKSPACE, f.users.a1]);
      const given = await owner.query(
        "INSERT INTO app.group_roles(group_id,workspace_id,team_id,role_object_id) VALUES($1::uuid,$2::uuid,$3,$4::uuid)",
        [group, COMPANY_WORKSPACE, f.teams.b, roleObject],
      );
      const grantWrites = async () => [
        await attempt(
          data,
          "INSERT INTO app.group_roles(group_id,workspace_id,team_id,role_object_id) VALUES($1::uuid,$2::uuid,$3,$4::uuid)",
          [group, COMPANY_WORKSPACE, f.teams.a, roleObject],
        ),
        await attempt(
          data,
          "DELETE FROM app.group_roles WHERE group_id = $1::uuid",
          [group],
        ),
      ];
      probe.at("outcome");
      const teamOnly = await transaction(data, async () => {
        const { access } = await installAs(data, signer, p.ownerB);
        return { access, outcomes: await grantWrites() };
      });
      const granted = await owner.query(
        "INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES($1::uuid,$2,'admin','{people}')",
        [COMPANY_WORKSPACE, f.users.b1],
      );
      let admin;
      try {
        admin = await transaction(data, async () => {
          const { access } = await installAs(data, signer, p.ownerB);
          return {
            access,
            member: await attempt(data, memberSql, [
              group,
              COMPANY_WORKSPACE,
              f.users.a2,
            ]),
            outcomes: await grantWrites(),
          };
        });
      } finally {
        await owner.query(
          "DELETE FROM app.workspace_admins WHERE workspace_id = $1::uuid AND user_id = $2",
          [COMPANY_WORKSPACE, f.users.b1],
        );
      }
      probe.at("positive-control");
      const control = await transaction(data, async () => {
        await installAs(data, signer, p.ownerA);
        return attempt(
          data,
          "DELETE FROM app.group_roles WHERE group_id = $1::uuid",
          [group],
        );
      });
      probe.at("end-state");
      const rows = await count(
        owner,
        "SELECT (SELECT count(*) FROM app.group_roles WHERE group_id = $1::uuid) + (SELECT count(*) FROM app.group_members WHERE group_id = $1::uuid) AS n",
        [group],
      );
      const [teamInsert, teamDelete] = teamOnly.outcomes;
      const [adminInsert, adminDelete] = admin.outcomes;
      pass = probe.all(
        [
          "setup",
          given.rowCount === 1 &&
            granted.rowCount === 1 &&
            teamOnly.access.companyLevel === null &&
            admin.access.companyLevel === "admin" &&
            admin.access.companyAreas.join(",") === "people",
        ],
        failsWith(admin.member, "42501"),
        failsWith(adminInsert, "42501"),
        failsWith(adminDelete, "42501"),
        failsWith(teamInsert, "42501"),
        leftAlone(teamDelete),
        outcomeIs(
          control.ok && control.count === 1,
          control,
          "positive-control",
        ),
        ["end-state", rows === 2],
      );
    } finally {
      await owner
        .query("DELETE FROM app.groups WHERE id = $1::uuid", [group])
        .catch(() => {});
    }
    probe.at("end-state");
    return (
      pass &&
      probe.all([
        "end-state",
        (await groupsGone()) &&
          (await count(
            owner,
            "SELECT count(*)::int AS n FROM app.workspace_admins WHERE user_id = $1",
            [f.users.b1],
          )) === 0,
      ])
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
