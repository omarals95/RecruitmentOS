/**
 * Opt-in live restricted-role isolation harness (WP-02c): `npm run test:live-roles`.
 *
 * - It proves the tenant and identity boundary with independent connections to a real
 *   PostgreSQL database: cross-team reads, writes and guessed identifiers, forged and replayed
 *   tenant contexts, savepoint replay, pooled-connection reuse, private rows within a team, the
 *   data role writing identity rows, the identity role reading candidate data, revoked and
 *   expired tokens, a demoted owner, and concurrent last-owner removal, bootstrap claims,
 *   storage reservations and Blob read leases. Denied mutations must leave no audit row.
 * - It reads only DATABASE_URL (data role), IDENTITY_DATABASE_URL (identity role),
 *   MIGRATION_DATABASE_URL (owner), LIVE_ROLE_TESTS_CONFIRM (must equal the database name),
 *   TENANT_CONTEXT_SIGNING_KEY (the key the database was migrated with) and PGOPTIONS (only to
 *   refuse it) from the process environment. It never loads an env file.
 * - It writes only fictional fixtures under a random run prefix: users, three teams, members and
 *   API tokens as the owner or the identity role; candidates, a vacancy, saved views, candidate
 *   states, reminder reads, idempotency, activity and pending uploads as the data role under
 *   signed contexts; fixture stores and read leases as the owner. It never changes budgets, keys,
 *   roles, grants, policies, migrations or settings.
 * - Cleanup runs after any failure once writing has started. One owner transaction lifts FORCE
 *   ROW LEVEL SECURITY and the immutable_activity trigger on the app tables (ACCESS EXCLUSIVE
 *   locks), deletes the fixture rows and restores both before COMMIT; then the contexts, leases,
 *   stores, teams, users and, in the open bootstrap variant, the setup claim it created go.
 * - It prints one JSON document of counts and static check ids, never a URL, host, port,
 *   username, password, the marker, the key, its id, a payload, a signature, row data or driver
 *   error text. Exit codes: 0 every check passed and no fixture remains; 1 a check failed, an
 *   error occurred or a fixture remains; 2 refused before anything was written.
 * - Only the owner runs it against a non-local database, and only an approved Preview database:
 *   never Production. Agents never run it against Neon or any remote database.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
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
import { runtimeRoleSafetyQuery } from "../src/db/runtime-role.ts";
import { SCOPES } from "../src/lib/permissions.ts";
import { assertTenantContextKey } from "../src/lib/tenant-context.ts";

type Env = Record<string, string | undefined>;
type Row = Record<string, unknown>;
type Db = {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: Row[]; rowCount: number | null }>;
};
type Outcome = { ok: boolean; code?: string; count: number; rows: Row[] };
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

const AUDIENCE = "recruitmentos-tenant-context-v1";
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
] as const;
const ALL_SCOPES = [...SCOPES];
const RECRUITER_SCOPES = SCOPES.filter((scope) => scope !== "imports:write");
const VIEWER_SCOPES = SCOPES.filter((scope) => scope.endsWith(":read"));
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

async function settle(
  pending: Promise<{ rows: Row[]; rowCount: number | null }>,
): Promise<Outcome> {
  try {
    const result = await pending;
    return { ok: true, count: result.rowCount ?? 0, rows: result.rows };
  } catch (error) {
    return { ok: false, code: codeOf(error), count: 0, rows: [] };
  }
}

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

function signerFor(value: string): Signer {
  const key = Buffer.from(value, "base64url");
  return {
    key,
    id: createHash("sha256").update(key).digest("hex").slice(0, 16),
  };
}

const sign = (payload: string, key: Buffer) =>
  createHmac("sha256", key).update(payload).digest("hex");

/** The canonical payload installTenantContext signs, bound to this backend and transaction. */
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
  return { payload, signature: sign(payload, signer.key) };
}

const installSql = "SELECT tenant_context.install($1,$2)";

async function installAs(db: Db, signer: Signer, principal: Principal) {
  const assertion = await assertionFor(db, signer, principal);
  await db.query(installSql, [assertion.payload, assertion.signature]);
  return assertion;
}

/** Whether the owner sees every listed backend waiting on a lock it has not been granted. */
async function waitForWaiters(owner: Db, pids: number[], expected: number) {
  const deadline = Date.now() + OVERLAP_WAIT_MS;
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
    },
    teams: { a: id("team-a"), b: id("team-b"), c: id("team-c") },
    members: {
      a1: id("member-a1"),
      a2: id("member-a2"),
      b1: id("member-b1"),
      b2: id("member-b2"),
      c1: id("member-c1"),
      c2: id("member-c2"),
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
};

type Run = {
  owner: Client;
  data: Client;
  data2: Client;
  identity: Client;
  identity2: Client;
  workers: Client[];
  pids: Map<Client, number>;
  dataUrl: string;
  signer: Signer;
  f: Fixtures;
  variant: Variant;
  check: (id: string, run: () => Promise<boolean>) => Promise<void>;
};

function principals(f: Fixtures) {
  const session = (team: string, actor: string, scopes: readonly string[]) =>
    ({ team, actor, auth: "session", token: null, scopes }) as Principal;
  const tokenScopes = ["candidates:read", "recruitment:read"];
  return {
    ownerA: session(f.teams.a, f.users.a1, ALL_SCOPES),
    memberA: session(f.teams.a, f.users.a2, RECRUITER_SCOPES),
    ownerB: session(f.teams.b, f.users.b1, ALL_SCOPES),
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

/** Removes only fixture rows; returns whether FORCE RLS and the activity trigger are restored. */
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
  let done = true;
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
  } catch {
    done = false;
  }
  try {
    await transaction(
      owner,
      async () => {
        for (const table of [
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
  } catch {
    done = false;
  }
  const { rows } = await owner.query(
    `SELECT (SELECT count(*) FILTER (WHERE c.relforcerowsecurity) FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY($1::text[]))::int AS forced,
      (SELECT t.tgenabled::text FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid = 'app.activity'::regclass AND t.tgname = 'immutable_activity') AS trigger`,
    [[...APP_TABLES]],
  );
  return (
    done && rows[0].forced === APP_TABLES.length && rows[0].trigger === "O"
  );
}

/** Concurrent transactions; the lock holder waits at the gate until the others are seen waiting. */
async function gatedRace<T>(
  run: Run,
  clients: Client[],
  work: (
    client: Client,
    index: number,
  ) => Promise<{ value: T; commit: boolean }>,
) {
  let open = () => {};
  const gate = new Promise<void>((done) => {
    open = done;
  });
  const settled = Promise.allSettled(
    clients.map(async (client, index) => {
      await client.query("BEGIN");
      let commit = false;
      try {
        const outcome = await work(client, index);
        await gate;
        commit = outcome.commit;
        return outcome.value;
      } finally {
        await client.query(commit ? "COMMIT" : "ROLLBACK");
      }
    }),
  );
  let overlapped: boolean;
  try {
    overlapped = await waitForWaiters(
      run.owner,
      clients.map((client) => run.pids.get(client)!),
      clients.length - 1,
    );
  } finally {
    open();
  }
  const results = await settled;
  if (results.some((result) => result.status === "rejected"))
    throw new Error("A concurrent transaction failed.");
  return {
    overlapped,
    distinct: distinct(clients.map((client) => run.pids.get(client)!)),
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
  let firstEnded = false;
  try {
    // A failed statement aborts its transaction and frees the setup lock at once, so in the closed
    // variant the first transaction holds the lock through a plain user insert it rolls back.
    if (closed) holder = await insert(first, f.users.holder, false);
    else firstOutcome = await insert(first, f.users.a1);
    // The first transaction holds the setup advisory lock; the rival must wait on it.
    const pending = insert(second, f.users.rival);
    try {
      overlapped = await waitForWaiters(owner, [run.pids.get(second)!], 1);
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
  const pids = distinct([run.pids.get(first)!, run.pids.get(second)!]);
  if (closed) {
    await run.check(
      "bootstrap-claim-race",
      async () =>
        pids &&
        holder?.ok === true &&
        overlapped &&
        firstOutcome?.code === "23514" &&
        secondOutcome.code === "23514" &&
        users === 0 &&
        JSON.stringify(after) === before,
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
  await run.check(
    "bootstrap-claim-race",
    async () =>
      pids &&
      overlapped &&
      secondOutcome.code === "23514" &&
      users === 1 &&
      after.length === 1 &&
      after[0].user_id === f.users.a1 &&
      after[0].completed_at === null &&
      completed.length === 1 &&
      completed[0].completed_at !== null,
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
      return { candidate, vacancy, savedView, upload };
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

  await check("cross-team-read", () =>
    transaction(data, async () => {
      await installAs(data, signer, p.ownerA);
      let pass = true;
      for (const table of APP_TABLES) {
        const { rows } = await data.query(
          `SELECT count(*) FILTER (WHERE team_id = $1)::int AS own, count(*) FILTER (WHERE team_id <> $1)::int AS other FROM app.${table}`,
          [f.teams.a],
        );
        pass &&= Number(rows[0].own) > 0 && Number(rows[0].other) === 0;
      }
      return pass;
    }),
  );

  await check("cross-team-write", () =>
    transaction(data, async () => {
      await installAs(data, signer, p.ownerA);
      await data.query(
        "SELECT tenant_context.lock_storage_allocation('blob','development',$1)",
        [f.stores.seed],
      );
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
      ];
      let pass = true;
      for (const [text, params] of inserts)
        pass &&= denied(await attempt(data, text, params));
      for (const table of APP_TABLES) {
        pass &&= untouched(
          await attempt(
            data,
            `UPDATE app.${table} SET team_id = team_id WHERE team_id = $1`,
            [B],
          ),
        );
        pass &&= untouched(
          await attempt(data, `DELETE FROM app.${table} WHERE team_id = $1`, [
            B,
          ]),
        );
      }
      const own = await attempt(
        data,
        "UPDATE app.records SET updated_at = updated_at WHERE id = $1",
        [a.candidate],
      );
      return pass && own.ok && own.count === 1;
    }),
  );

  await check("identifier-guessing", async () => {
    const guessed = await transaction(data, async () => {
      await installAs(data, signer, p.ownerA);
      const ids = [b.candidate, b.vacancy, b.savedView];
      let pass =
        (await count(
          data,
          "SELECT count(*)::int AS n FROM app.records WHERE id = ANY($1::uuid[])",
          [ids],
        )) === 0 &&
        (await count(
          data,
          "SELECT count(*)::int AS n FROM app.uploads WHERE id = $1",
          [b.upload],
        )) === 0;
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
      ] as [string, unknown[]][])
        pass &&= untouched(await attempt(data, text, params));
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
      pass &&= !(await application(b.candidate, b.vacancy)).ok;
      pass &&= (await application(a.candidate, a.vacancy)).ok;
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
      pass &&= !(await reserve(b.candidate, "other")).ok;
      pass &&= (await reserve(a.candidate, "own")).ok;
      return pass;
    });
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
    if (!ownLease) return false;
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
    const leases = await owner.query(
      "SELECT id::text AS id FROM storage_ledger.blob_read_leases WHERE id = ANY($1::uuid[])",
      [[guessLease, ownLease]],
    );
    return (
      guessed && leases.rows.length === 1 && leases.rows[0].id === guessLease
    );
  });

  // A valid install afterwards on the same connection is the positive control for each forgery.
  const forged = (
    id: string,
    forge: () => Promise<{ payload: string; signature: string }>,
  ) =>
    check(id, () =>
      transaction(data, async () => {
        const assertion = await forge();
        const rejected = denied(
          await attempt(data, installSql, [
            assertion.payload,
            assertion.signature,
          ]),
        );
        await installAs(data, signer, p.ownerA);
        return rejected && (await ownRecords(data, f.teams.a)) > 0;
      }),
    );
  await check("forged-settings", () =>
    transaction(data, async () => {
      await data.query(
        "SELECT set_config('app.team_id',$1,true), set_config('app.user_id',$2,true)",
        [f.teams.a, f.users.a1],
      );
      let pass = true;
      for (const table of APP_TABLES)
        pass &&=
          (await count(data, `SELECT count(*)::int AS n FROM app.${table}`)) ===
          0;
      pass &&= denied(
        await attempt(
          data,
          "INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary) VALUES($1,$2,'session','created','candidate',$3)",
          [f.teams.a, f.users.a1, `Fictional event ${f.prefix}`],
        ),
      );
      await installAs(data, signer, p.ownerA);
      return pass && (await ownRecords(data, f.teams.a)) > 0;
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
  await check("replay-other-connection", async () => {
    const pass = await transaction(
      data,
      async () => {
        const assertion = await installAs(data, signer, p.ownerA);
        replayed = assertion;
        const other = await transaction(data2, async () => {
          const replayed = denied(
            await attempt(data2, installSql, [
              assertion.payload,
              assertion.signature,
            ]),
          );
          await installAs(data2, signer, p.ownerA);
          return replayed && (await ownRecords(data2, f.teams.a)) > 0;
        });
        return other && (await ownRecords(data, f.teams.a)) > 0;
      },
      true,
    );
    return pass && distinct([run.pids.get(data)!, run.pids.get(data2)!]);
  });
  // The assertion committed above, installed again in a later transaction on the same backend.
  await check("replay-later-transaction", async () => {
    const assertion = replayed;
    if (!assertion) return false;
    return transaction(data, async () => {
      const rejected = denied(
        await attempt(data, installSql, [
          assertion.payload,
          assertion.signature,
        ]),
      );
      await installAs(data, signer, p.ownerA);
      return rejected && (await ownRecords(data, f.teams.a)) > 0;
    });
  });

  await check("savepoint-replay", () =>
    transaction(data, async () => {
      const first = await installAs(data, signer, p.ownerA);
      await data.query("SAVEPOINT replay");
      const again = denied(
        await attempt(data, installSql, [first.payload, first.signature]),
      );
      await data.query("ROLLBACK TO SAVEPOINT replay");
      const fresh = await assertionFor(data, signer, p.ownerB);
      const second = denied(
        await attempt(data, installSql, [fresh.payload, fresh.signature]),
      );
      const replay = denied(
        await attempt(data, installSql, [first.payload, first.signature]),
      );
      return (
        again &&
        second &&
        replay &&
        (await ownRecords(data, f.teams.a)) > 0 &&
        (await ownRecords(data, f.teams.b)) === 0
      );
    }),
  );

  await check("pooled-connection-reuse", async () => {
    const pool = new Pool({ ...clientConfig(run.dataUrl), max: 1 });
    pool.on("error", () => {});
    try {
      const first = await pool.connect();
      let firstPid: number;
      let granted: boolean;
      try {
        firstPid = Number(
          (await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        );
        granted = await transaction(
          first,
          async () => {
            await installAs(first, signer, p.ownerA);
            return (await ownRecords(first, f.teams.a)) > 0;
          },
          true,
        );
      } finally {
        first.release();
      }
      const next = await pool.connect();
      try {
        const nextPid = Number(
          (await next.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        );
        let unseen = true;
        await transaction(next, async () => {
          for (const table of APP_TABLES)
            unseen &&=
              (await count(
                next,
                `SELECT count(*)::int AS n FROM app.${table}`,
              )) === 0;
        });
        return granted && nextPid === firstPid && unseen;
      } finally {
        next.release();
      }
    } finally {
      await pool.end();
    }
  });

  // The second member of team A against the first member's private rows; both are positive-controlled.
  const privateCheck = (
    id: string,
    probes: [string, unknown[]][],
    visible: string,
    own: [string, unknown[]][],
  ) =>
    check(id, async () => {
      const member = await transaction(data, async () => {
        await installAs(data, signer, p.memberA);
        const [read, ...writes] = probes;
        let pass = (await count(data, read[0], read[1])) === 0;
        for (const [text, params] of writes)
          pass &&= untouched(await attempt(data, text, params));
        return (
          pass &&
          (await count(data, visible, [f.teams.a])) > 0 &&
          (
            await attempt(
              data,
              "INSERT INTO app.notification_reads(team_id,user_id,key) VALUES($1,$2,$3)",
              [f.teams.a, f.users.a2, `${f.teams.a}:${id}`],
            )
          ).ok
        );
      });
      const owner = await transaction(data, async () => {
        await installAs(data, signer, p.ownerA);
        let pass = (await count(data, probes[0][0], probes[0][1])) > 0;
        for (const [text, params] of own) {
          const outcome = await attempt(data, text, params);
          pass &&= outcome.ok && outcome.count > 0;
        }
        return pass;
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
  await check("data-role-identity-writes", async () => {
    const before = await identityRows();
    const pass = await transaction(data, async () => {
      await installAs(data, signer, p.ownerA);
      let denials = true;
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
        denials &&= denied(await attempt(data, text, params));
      return denials && (await ownRecords(data, f.teams.a)) > 0;
    });
    return pass && (await identityRows()) === before;
  });

  await check("identity-role-candidate-reads", () =>
    transaction(identity, async () => {
      await installAs(identity, signer, p.ownerA);
      const members = await count(
        identity,
        "SELECT count(*)::int AS n FROM auth.member WHERE organization_id = $1",
        [f.teams.a],
      );
      const records = await attempt(
        identity,
        "SELECT count(*) FROM app.records",
      );
      const states = await attempt(
        identity,
        "SELECT count(*) FROM app.candidate_states",
      );
      return members > 0 && denied(records) && denied(states);
    }),
  );

  /** A rejected install, then a valid session install and a read on the same connection. */
  const rejectedThenSession = (principal: Principal, fallback: Principal) =>
    transaction(data, async () => {
      const assertion = await assertionFor(data, signer, principal);
      const rejected = denied(
        await attempt(data, installSql, [
          assertion.payload,
          assertion.signature,
        ]),
      );
      await installAs(data, signer, fallback);
      return rejected && (await ownRecords(data, fallback.team)) > 0;
    });
  const granted = (principal: Principal) =>
    transaction(data, async () => {
      await installAs(data, signer, principal);
      return (await ownRecords(data, principal.team)) > 0;
    });
  await check("revoked-token", async () => {
    const before = await granted(p.liveToken);
    const revoked = await identity.query(
      "UPDATE auth.api_tokens SET revoked_at = now() WHERE id = $1",
      [f.tokens.live],
    );
    return (
      before &&
      revoked.rowCount === 1 &&
      (await rejectedThenSession(p.liveToken, p.ownerA))
    );
  });
  await check("expired-token", () =>
    rejectedThenSession(p.expiredToken, p.ownerA),
  );
  await check("demoted-owner", async () => {
    const before = await granted(p.demotedB);
    const demoted = await identity.query(
      "UPDATE auth.member SET role = 'viewer' WHERE id = $1",
      [f.members.b2],
    );
    return (
      before &&
      demoted.rowCount === 1 &&
      (await rejectedThenSession(p.demotedB, p.viewerB))
    );
  });

  await check("last-owner-race", async () => {
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
    let firstEnded = false;
    try {
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
        overlapped = await waitForWaiters(owner, [run.pids.get(identity2)!], 1);
      } finally {
        await identity.query(first.ok ? "COMMIT" : "ROLLBACK");
        firstEnded = true;
      }
      demoted = await pending;
    } finally {
      if (!firstEnded) await identity.query("ROLLBACK").catch(() => {});
      // The demotion must fail; it is committed only if it unexpectedly succeeded, so the count shows it.
      await identity2.query(demoted?.ok ? "COMMIT" : "ROLLBACK");
    }
    return (
      distinct([run.pids.get(identity)!, run.pids.get(identity2)!]) &&
      overlapped &&
      before === 2 &&
      removed.ok &&
      removed.count === 1 &&
      demoted.code === "23514" &&
      (await owners()) === 1
    );
  });

  const sides = [
    { principal: p.ownerA, candidate: a.candidate },
    { principal: p.ownerB, candidate: b.candidate },
  ];
  const side = (index: number) => sides[index % 2];
  await check("store-budget-race", async () => {
    const teamReserved = async () =>
      (
        await owner.query(
          "SELECT coalesce(sum(reserved_bytes),0)::text AS bytes, coalesce(sum(reserved_files),0)::int AS files FROM app.storage_usage WHERE team_id = ANY($1::text[])",
          [[f.teams.a, f.teams.b]],
        )
      ).rows[0];
    const before = await teamReserved();
    const race = await gatedRace(run, run.workers, async (client, index) => {
      const { principal, candidate } = side(index);
      await installAs(client, signer, principal);
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
    });
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
    return (
      race.distinct &&
      race.overlapped &&
      succeeded === STORE_ROOM &&
      refused === WORKERS - STORE_ROOM &&
      store.within === true &&
      Number(store.files) === STORE_ROOM &&
      Number(store.pending) === STORE_ROOM &&
      store.bytes === store.pending_bytes &&
      Number(after.bytes) - Number(before.bytes) === Number(store.bytes) &&
      Number(after.files) - Number(before.files) === Number(store.files)
    );
  });

  const leaseRace = async (store: string) => {
    const race = await gatedRace(run, run.workers, async (client, index) => {
      const { principal } = side(index);
      await installAs(client, signer, principal);
      const { rows } = await client.query(
        "SELECT tenant_context.acquire_blob_read($1)::text AS lease",
        [store],
      );
      return {
        value: { team: principal.team, lease: rows[0].lease as string | null },
        commit: true,
      };
    });
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
      ok: race.distinct && race.overlapped,
      a: grantedTo(f.teams.a),
      b: grantedTo(f.teams.b),
      live: {
        total: Number(live.total),
        a: Number(live.a),
        b: Number(live.b),
      },
    };
  };
  await check("read-lease-team-cap", async () => {
    const race = await leaseRace(f.stores.lease);
    return (
      race.ok &&
      race.a === 2 &&
      race.b === 2 &&
      race.live.a <= 2 &&
      race.live.b <= 2 &&
      race.live.total === 4
    );
  });
  await check("read-lease-store-cap", async () => {
    const race = await leaseRace(f.stores.cap);
    return (
      race.ok &&
      race.a <= 2 &&
      race.b <= 2 &&
      race.a + race.b === 3 &&
      race.live.total === 8
    );
  });

  await check("denied-mutations-no-audit", async () => {
    const end = await activityCounts(owner, f);
    return (
      baseline.private > 0 &&
      baseline.token === 1 &&
      end.total === baseline.total &&
      end.private === baseline.private &&
      end.token === baseline.token
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
async function preflight(
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
  let connections: Omit<
    Run,
    "pids" | "dataUrl" | "signer" | "f" | "variant" | "check"
  >;
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
    const pids = new Map<Client, number>();
    for (const client of clients)
      pids.set(
        client,
        Number(
          (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        ),
      );
    const f = fixtureNames(`lrt${randomBytes(6).toString("hex")}`);
    const results: { id: string; pass: boolean }[] = [];
    const run: Run = {
      ...connections,
      pids,
      dataUrl: targets.data,
      signer,
      f,
      variant: ready.variant,
      async check(id, work) {
        let pass: boolean;
        try {
          pass = (await work()) === true;
        } catch {
          pass = false;
        }
        results.push({ id, pass });
      },
    };
    let error = false;
    let created: Counts = {};
    let remaining: Counts = {};
    let restored = false;
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
        restored = await cleanup(run.owner, f, run.variant);
      } catch {
        restored = false;
      }
      try {
        remaining = await fixtureCounts(run.owner, f, run.variant);
      } catch {
        error = true;
      }
    }
    results.push({ id: "cleanup-restored", pass: restored });
    const failedChecks = results
      .filter((result) => !result.pass)
      .map((result) => result.id);
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
