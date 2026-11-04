/**
 * Read-only evidence for the split runtime database roles (recruitmentos_data and
 * recruitmentos_identity) after infrastructure/postgres-split-runtime-roles.sql.
 *
 * - It reads only DATABASE_URL (data role) and IDENTITY_DATABASE_URL (identity role) from the
 *   process environment and never loads .env.local, so it inspects exactly what the app uses.
 * - It opens one connection per URL with the runtime TLS rule and runs every query inside a
 *   READ ONLY transaction that is rolled back.
 * - It compares each role's effective privileges with the grants the template declares and
 *   lists every difference as drift.
 * - It prints one JSON document and never a password, URL, host, port, the marker value, row
 *   data or driver error text.
 * - Exit codes: 0 every check passes and nothing drifts; 1 a check fails, a privilege drifts, or
 *   a connection or query error; 2 configuration refused before any connection is opened.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  dataRoleBoundaryQuery,
  identityRoleBoundaryQuery,
  isLoopbackHost,
  markerRoleBoundaryQuery,
  prepareConnectionTargets,
} from "../src/db/connection-boundary.ts";
import { runtimeRoleSafetyQuery } from "../src/db/runtime-role.ts";
import { assertStorageSchema } from "../src/db/storage-schema.ts";
import {
  readRuntimeRoleTemplate,
  runtimeRoleNames,
  templateGrantMatrix,
  type RoleMatrix,
} from "./runtime-role-template.ts";

type Queryable = {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
};
type Kind = "data" | "identity";

export type RoleEvidence = {
  kind: Kind;
  currentUser: string;
  sessionUser: string;
  sessionMatchesCurrentUser: boolean;
  database: string;
  attributes: Record<string, boolean>;
  memberOf: string[];
  databasePrivileges: { connect: boolean; create: boolean; temporary: boolean };
  schemaPrivileges: Record<
    string,
    { exists: boolean; usage: boolean; create: boolean }
  >;
  tablePrivileges: Record<string, string[]>;
  sequencePrivileges: Record<string, string[]>;
  /** Column privileges the role holds without the same table-level privilege. */
  columnPrivileges: Record<string, string[]>;
  execute: string[];
  /** Explicit default privileges for future objects granted to this role or PUBLIC. */
  defaultPrivileges: string[];
  /** What PUBLIC holds that the template revokes; every value should be false. */
  publicPrivileges: Record<string, boolean>;
  /** Every difference from the template's grant matrix. */
  drift: string[];
  checks: Record<string, boolean>;
  pass: boolean;
};
/** The marker stays beside the evidence so the pair check can compare it; it is never printed. */
export type CollectedRole = { evidence: RoleEvidence; marker: string | null };

const userSchemas = `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'`;
const listedSchemas = [
  "app",
  "auth",
  "tenant_context",
  "db_boundary",
  "storage_ledger",
  "public",
];

function privilegeMap(rows: Record<string, unknown>[]) {
  return Object.fromEntries(
    rows.map((row) => [row.object as string, row.privileges as string[]]),
  );
}

function differences(object: string, held: string[], expected: string[]) {
  return [
    ...held
      .filter((privilege) => !expected.includes(privilege))
      .map((privilege) => `extra ${privilege} on ${object}`),
    ...expected
      .filter((privilege) => !held.includes(privilege))
      .map((privilege) => `missing ${privilege} on ${object}`),
  ];
}

/** Every way the collected privileges differ from what the template grants this role. */
function templateDrift(
  evidence: Omit<RoleEvidence, "drift" | "checks" | "pass">,
  role: string,
  expected: RoleMatrix,
): string[] {
  const drift: string[] = [];
  if (evidence.currentUser !== role)
    drift.push(`connected as ${evidence.currentUser}, not ${role}`);
  for (const [attribute, value] of Object.entries(expected.attributes))
    if (evidence.attributes[attribute] !== value)
      drift.push(`role attribute ${attribute} is not ${value}`);
  drift.push(...evidence.memberOf.map((name) => `member of role ${name}`));
  const database = evidence.databasePrivileges;
  drift.push(
    ...differences(
      "the database",
      [
        database.connect && "CONNECT",
        database.create && "CREATE",
        database.temporary && "TEMPORARY",
      ].filter((privilege) => typeof privilege === "string"),
      expected.database,
    ),
  );
  const keys = (...maps: object[]) =>
    [...new Set(maps.flatMap((map) => Object.keys(map)))].sort();
  for (const schema of keys(evidence.schemaPrivileges, expected.schemas)) {
    const held = evidence.schemaPrivileges[schema];
    drift.push(
      ...differences(
        `schema ${schema}`,
        [held?.usage && "USAGE", held?.create && "CREATE"].filter(
          (privilege) => typeof privilege === "string",
        ),
        expected.schemas[schema] ?? [],
      ),
    );
  }
  for (const table of keys(evidence.tablePrivileges, expected.tables))
    drift.push(
      ...differences(
        `table ${table}`,
        evidence.tablePrivileges[table] ?? [],
        expected.tables[table] ?? [],
      ),
    );
  for (const [sequence, privileges] of Object.entries(
    evidence.sequencePrivileges,
  ))
    drift.push(...differences(`sequence ${sequence}`, privileges, []));
  for (const [column, privileges] of Object.entries(evidence.columnPrivileges))
    drift.push(...differences(`column ${column}`, privileges, []));
  for (const signature of [
    ...new Set([...evidence.execute, ...expected.execute]),
  ].sort())
    drift.push(
      ...differences(
        `function ${signature}`,
        evidence.execute.includes(signature) ? ["EXECUTE"] : [],
        expected.execute.includes(signature) ? ["EXECUTE"] : [],
      ),
    );
  drift.push(
    ...evidence.defaultPrivileges.map((entry) => `default privilege ${entry}`),
  );
  for (const [privilege, held] of Object.entries(evidence.publicPrivileges))
    if (held) drift.push(`PUBLIC holds ${privilege}`);
  return drift;
}

async function unsafe(client: Queryable, query: string): Promise<boolean> {
  const { rows } = await client.query(query);
  return rows.length !== 1 || rows[0].unsafe !== false;
}

/** A read that may be denied; the savepoint keeps the read-only transaction usable. */
async function attempt<T>(
  client: Queryable,
  read: () => Promise<T>,
): Promise<T | null> {
  await client.query("SAVEPOINT evidence_read");
  try {
    const value = await read();
    await client.query("RELEASE SAVEPOINT evidence_read");
    return value;
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT evidence_read");
    return null;
  }
}

export async function collectRoleEvidence(
  client: Queryable,
  kind: Kind,
): Promise<CollectedRole> {
  await client.query("BEGIN TRANSACTION READ ONLY");
  try {
    const principal = (
      await client.query(
        "SELECT current_user::text AS current, session_user::text AS session, pg_catalog.current_database()::text AS database",
      )
    ).rows[0];
    const attributes = (
      await client.query(
        "SELECT rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user",
      )
    ).rows[0] as Record<string, boolean>;
    const memberOf = (
      await client.query(
        "SELECT r.rolname::text AS name FROM pg_catalog.pg_roles r WHERE r.rolname <> current_user AND pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER') ORDER BY 1",
      )
    ).rows.map((row) => row.name as string);
    const databasePrivileges = (
      await client.query(
        `SELECT pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CONNECT') AS connect,
          pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE') AS create,
          pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'TEMPORARY') AS temporary`,
      )
    ).rows[0] as RoleEvidence["databasePrivileges"];
    const schemaRows = (
      await client.query(
        `SELECT s.name, n.oid IS NOT NULL AS exists,
          COALESCE(pg_catalog.has_schema_privilege(current_user, n.oid, 'USAGE'), false) AS usage,
          COALESCE(pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE'), false) AS create
        FROM (SELECT pg_catalog.unnest($1::text[]) AS name
          UNION SELECT n.nspname::text FROM pg_catalog.pg_namespace n WHERE ${userSchemas}) s
        LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = s.name
        ORDER BY 1`,
        [listedSchemas],
      )
    ).rows;
    const tablePrivileges = privilegeMap(
      (
        await client.query(
          `SELECT object, privileges FROM (
            SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname) AS object,
              ARRAY(SELECT p FROM pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
                  || CASE WHEN pg_catalog.current_setting('server_version_num')::int >= 170000 THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END) AS p
                WHERE pg_catalog.has_table_privilege(current_user, c.oid, p) ORDER BY 1) AS privileges
            FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE ${userSchemas} AND c.relkind IN ('r','p','v','m','f')) t
          WHERE pg_catalog.cardinality(privileges) > 0 ORDER BY 1`,
        )
      ).rows,
    );
    const sequencePrivileges = privilegeMap(
      (
        await client.query(
          `SELECT object, privileges FROM (
            SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname) AS object,
              ARRAY(SELECT p FROM pg_catalog.unnest(ARRAY['USAGE','SELECT','UPDATE']) AS p
                WHERE pg_catalog.has_sequence_privilege(current_user, c.oid, p) ORDER BY 1) AS privileges
            FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE ${userSchemas} AND c.relkind = 'S') t
          WHERE pg_catalog.cardinality(privileges) > 0 ORDER BY 1`,
        )
      ).rows,
    );
    const columnPrivileges = privilegeMap(
      (
        await client.query(
          `SELECT object, privileges FROM (
            SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname) || '.' || pg_catalog.quote_ident(a.attname) AS object,
              ARRAY(SELECT p FROM pg_catalog.unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS p
                WHERE pg_catalog.has_column_privilege(current_user, c.oid, a.attnum, p)
                  AND NOT pg_catalog.has_table_privilege(current_user, c.oid, p) ORDER BY 1) AS privileges
            FROM pg_catalog.pg_attribute a
            JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE ${userSchemas} AND c.relkind IN ('r','p','v','m','f') AND a.attnum > 0 AND NOT a.attisdropped) t
          WHERE pg_catalog.cardinality(privileges) > 0 ORDER BY 1`,
        )
      ).rows,
    );
    const execute = (
      await client.query(
        `SELECT pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(p.proname)
            || '(' || pg_catalog.replace(pg_catalog.oidvectortypes(p.proargtypes), ', ', ',') || ')' AS signature
          FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE ${userSchemas} AND pg_catalog.has_function_privilege(current_user, p.oid, 'EXECUTE')
          ORDER BY 1`,
      )
    ).rows.map((row) => row.signature as string);
    const defaultPrivileges = (
      await client.query(
        `SELECT pg_catalog.pg_get_userbyid(d.defaclrole)::text || ' in ' || COALESCE(n.nspname::text, 'every schema')
            || ' on new ' || CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences'
              WHEN 'f' THEN 'functions' WHEN 'T' THEN 'types' WHEN 'n' THEN 'schemas' ELSE d.defaclobjtype::text END
            || ' gives ' || a.privilege_type || ' to '
            || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS entry
          FROM pg_catalog.pg_default_acl d
          LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
          WHERE CASE WHEN a.grantee = 0 THEN true ELSE pg_catalog.pg_has_role(current_user, a.grantee, 'MEMBER') END
          ORDER BY 1`,
      )
    ).rows.map((row) => row.entry as string);
    // The template's REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC leaves an owner default without PUBLIC.
    const publicPrivileges = (
      await client.query(
        `SELECT pg_catalog.has_database_privilege('public', pg_catalog.current_database(), 'CONNECT') AS "databaseConnect",
          pg_catalog.has_database_privilege('public', pg_catalog.current_database(), 'TEMPORARY') AS "databaseTemporary",
          COALESCE((SELECT pg_catalog.has_schema_privilege('public', n.oid, 'USAGE')
            FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'), false) AS "publicSchemaUsage",
          COALESCE((SELECT pg_catalog.has_schema_privilege('public', n.oid, 'CREATE')
            FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'), false) AS "publicSchemaCreate",
          COALESCE((SELECT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(d.defaclacl) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
              FROM pg_catalog.pg_default_acl d
              JOIN pg_catalog.pg_namespace n ON n.nspname = 'tenant_context' AND d.defaclrole = n.nspowner
              WHERE d.defaclnamespace = 0 AND d.defaclobjtype = 'f'), true) AS "futureFunctionExecute"`,
      )
    ).rows[0] as Record<string, boolean>;
    const collected = {
      kind,
      currentUser: principal.current as string,
      sessionUser: principal.session as string,
      sessionMatchesCurrentUser:
        Boolean(principal.current) && principal.current === principal.session,
      database: principal.database as string,
      attributes,
      memberOf,
      databasePrivileges,
      schemaPrivileges: Object.fromEntries(
        schemaRows.map((row) => [
          row.name as string,
          {
            exists: row.exists as boolean,
            usage: row.usage as boolean,
            create: row.create as boolean,
          },
        ]),
      ),
      tablePrivileges,
      sequencePrivileges,
      columnPrivileges,
      execute,
      defaultPrivileges,
      publicPrivileges,
    };
    const role = runtimeRoleNames[kind];
    const drift = templateDrift(
      collected,
      role,
      templateGrantMatrix(await readRuntimeRoleTemplate())[role],
    );
    const checks: Record<string, boolean> = {
      sessionMatchesCurrentUser: collected.sessionMatchesCurrentUser,
      matchesTemplate: drift.length === 0,
      runtimeRoleSafe: !(await unsafe(client, runtimeRoleSafetyQuery)),
      markerBoundarySafe: !(await unsafe(client, markerRoleBoundaryQuery)),
      roleBoundarySafe: !(await unsafe(
        client,
        kind === "data" ? dataRoleBoundaryQuery : identityRoleBoundaryQuery,
      )),
    };
    if (kind === "data")
      checks.storageSchemaCurrent =
        (await attempt(client, async () => {
          await assertStorageSchema(client);
          return true;
        })) === true;
    const marker = await attempt(client, async () => {
      const { rows } = await client.query(
        "SELECT id::text AS marker FROM db_boundary.connection_marker",
      );
      return rows.length === 1 ? (rows[0].marker as string) : null;
    });
    return {
      evidence: {
        ...collected,
        drift,
        checks,
        pass: Object.values(checks).every(Boolean),
      },
      marker,
    };
  } finally {
    await client.query("ROLLBACK");
  }
}

/** The same pairing rules as createDbPair, reported as booleans; the marker is never returned. */
export function checkRolePair(data: CollectedRole, identity: CollectedRole) {
  const uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const checks = {
    distinctRoles:
      Boolean(data.evidence.currentUser) &&
      data.evidence.currentUser !== identity.evidence.currentUser,
    sameDatabase:
      Boolean(data.evidence.database) &&
      data.evidence.database === identity.evidence.database,
    markersMatch:
      typeof data.marker === "string" &&
      uuid.test(data.marker) &&
      data.marker === identity.marker,
    dataCannotAssumeIdentity: !data.evidence.memberOf.includes(
      identity.evidence.currentUser,
    ),
    identityCannotAssumeData: !identity.evidence.memberOf.includes(
      data.evidence.currentUser,
    ),
  };
  return { ...checks, pass: Object.values(checks).every(Boolean) };
}

function refuse(reason: string): number {
  console.error(`Refused: ${reason} Nothing was contacted.`);
  return 2;
}

/** The runtime TLS rule from createDbPair: loopback plain, everything else verify-full. */
function connect(connectionString: string) {
  const url = new URL(connectionString);
  const local = isLoopbackHost(url.hostname);
  if (!local) url.searchParams.set("sslmode", "verify-full");
  const client = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 10000,
    ...(!local ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  client.on("error", () => {});
  return client;
}

export async function main(
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const dataUrl = env.DATABASE_URL;
  const identityUrl = env.IDENTITY_DATABASE_URL;
  if (!dataUrl || !identityUrl)
    return refuse("Set DATABASE_URL and IDENTITY_DATABASE_URL.");
  let targets: { dataUrl: string; identityUrl: string };
  try {
    targets = prepareConnectionTargets(dataUrl, identityUrl, env);
  } catch {
    return refuse(
      "Both URLs must name the same database endpoint with separate credentials, and PGOPTIONS must be unset.",
    );
  }
  const clients: Client[] = [];
  try {
    const dataClient = connect(targets.dataUrl);
    clients.push(dataClient);
    const identityClient = connect(targets.identityUrl);
    clients.push(identityClient);
    await dataClient.connect();
    await identityClient.connect();
    const data = await collectRoleEvidence(dataClient, "data");
    const identity = await collectRoleEvidence(identityClient, "identity");
    const pair = checkRolePair(data, identity);
    const pass = data.evidence.pass && identity.evidence.pass && pair.pass;
    console.log(
      JSON.stringify(
        { data: data.evidence, identity: identity.evidence, pair, pass },
        null,
        2,
      ),
    );
    return pass ? 0 : 1;
  } catch {
    console.error(
      "Role evidence failed. Check both runtime connections and the database setup; credentials and driver errors are never printed.",
    );
    return 1;
  } finally {
    await Promise.allSettled(clients.map((client) => client.end()));
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
      console.error("Role evidence stopped unexpectedly.");
      process.exitCode = 1;
    });
