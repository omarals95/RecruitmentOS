import { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The evidence script must refuse before it ever builds a database client. When a PGlite is
// bridged in, each client runs as the login named in its URL, one client at a time. The
// database in the URL picks the PGlite: fictional_db is the bridged one, any other name a
// fictional database registered for the test; an unregistered name cannot be connected to.
const bridge = vi.hoisted(() => ({
  constructed: vi.fn(),
  pg: null as PGlite | null,
  databases: new Map<string, PGlite>(),
  users: new Map<PGlite, string>(),
}));
const constructed = bridge.constructed;
vi.mock("pg", () => ({
  Client: class {
    user: string;
    database: string;
    constructor({ connectionString }: { connectionString: string }) {
      bridge.constructed();
      if (!bridge.pg)
        throw new Error(
          "fictional driver failure for postgresql://recruitmentos_data:fictional-data-secret@127.0.0.1:55432/fictional_db",
        );
      const url = new URL(connectionString);
      this.user = url.username;
      this.database = decodeURIComponent(url.pathname.slice(1));
    }
    get target() {
      return this.database === "fictional_db"
        ? bridge.pg
        : bridge.databases.get(this.database);
    }
    on() {}
    async connect() {
      if (!this.target)
        throw new Error(
          `fictional driver failure for postgresql://${this.user}:fictional-data-secret@127.0.0.1:55432/${this.database}`,
        );
    }
    async end() {}
    async query(text: string, params?: unknown[]) {
      const pg = this.target!;
      if (bridge.users.get(pg) !== this.user) {
        await pg.exec(`SET SESSION AUTHORIZATION ${this.user}`);
        bridge.users.set(pg, this.user);
      }
      return pg.query(text, params);
    }
  },
}));

import { applyMigrations } from "../src/db";
import {
  dataRoleBoundaryQuery,
  dataRoleHelpers,
  identityRoleBoundaryQuery,
  identityRoleHelpers,
  markerRoleBoundaryQuery,
} from "../src/db/connection-boundary";
import { runtimeRoleSafetyQuery } from "../src/db/runtime-role";
import {
  checkRolePair,
  collectRoleEvidence,
  main,
  platformDatabaseReason,
} from "../scripts/db-role-evidence";
import { templateGrantMatrix } from "../scripts/runtime-role-template";
import {
  createSplitRoleDb,
  readRuntimeRoleTemplate,
  splitRoles,
} from "./helpers/db";

const roles = ["recruitmentos_data", "recruitmentos_identity"] as const;
const appTables = [
  "records",
  "candidate_states",
  "activity",
  "uploads",
  "storage_usage",
  "idempotency",
  "notification_reads",
];
const authTables = [
  '"user"',
  "organization",
  "session",
  "account",
  "verification",
  "member",
  "invitation",
  "rate_limit",
  "api_tokens",
  "api_rate_limits",
];
const deletable = ["candidate_states", "notification_reads", "idempotency"];
const expectedData = {
  tablePrivileges: {
    ...Object.fromEntries(
      appTables.map((table) => [
        `app.${table}`,
        deletable.includes(table)
          ? ["DELETE", "INSERT", "SELECT", "UPDATE"]
          : ["INSERT", "SELECT", "UPDATE"],
      ]),
    ),
    "db_boundary.connection_marker": ["SELECT"],
    "db_boundary.storage_schema": ["SELECT"],
  },
  schemas: { app: true, auth: false, tenant_context: true, db_boundary: true },
  helpers: dataRoleHelpers,
};
const expectedIdentity = {
  tablePrivileges: {
    ...Object.fromEntries(
      authTables.map((table) => [
        `auth.${table}`,
        ["DELETE", "INSERT", "SELECT", "UPDATE"],
      ]),
    ),
    "auth.oauth_clients": ["INSERT", "SELECT"],
    "auth.oauth_codes": ["INSERT", "SELECT", "UPDATE"],
    "auth.oauth_tokens": ["INSERT", "SELECT", "UPDATE"],
    "auth.initial_admin_claim": ["SELECT"],
    "db_boundary.connection_marker": ["SELECT"],
  },
  schemas: { app: false, auth: true, tenant_context: true, db_boundary: true },
  helpers: identityRoleHelpers,
};
const loginOnly = {
  rolcanlogin: true,
  rolsuper: false,
  rolinherit: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolreplication: false,
  rolbypassrls: false,
};
/** Requirement 7 of the reviewed spec, which the template's GRANT statements must declare. */
const reviewedMatrix = Object.fromEntries(
  (
    [
      [splitRoles.data, expectedData],
      [splitRoles.identity, expectedIdentity],
    ] as const
  ).map(([role, expected]) => [
    role,
    {
      attributes: loginOnly,
      database: ["CONNECT"],
      schemas: Object.fromEntries(
        Object.entries(expected.schemas)
          .filter(([, usage]) => usage)
          .map(([schema]) => [schema, ["USAGE"]]),
      ),
      tables: expected.tablePrivileges,
      execute: [...expected.helpers].sort(),
    },
  ]),
);
const closedToPublic = {
  databaseConnect: false,
  databaseTemporary: false,
  publicSchemaUsage: false,
  publicSchemaCreate: false,
  futureFunctionExecute: false,
};

/** Every ACL, default ACL, role attribute and membership that the template could change. */
const catalogSnapshot = `
  WITH acl AS (
    SELECT 'relation ' || c.oid::regclass::text AS object, c.relacl AS acl
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
    UNION ALL SELECT 'column ' || a.attrelid::regclass::text || '.' || a.attname, a.attacl
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%' AND a.attacl IS NOT NULL
    UNION ALL SELECT 'function ' || p.oid::regprocedure::text, p.proacl
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
    UNION ALL SELECT 'schema ' || nspname, nspacl FROM pg_namespace
    UNION ALL SELECT 'database ' || datname, datacl FROM pg_database
    UNION ALL SELECT 'default ' || defaclrole::regrole::text || ' ' || defaclnamespace::text || ' ' || defaclobjtype::text, defaclacl FROM pg_default_acl
  )
  SELECT object, ARRAY(SELECT item::text FROM unnest(acl) item ORDER BY 1) AS acl FROM acl
  UNION ALL SELECT 'role ' || rolname, ARRAY[concat_ws(',', rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolpassword IS NULL)]
    FROM pg_authid WHERE rolname LIKE 'recruitmentos\\_%'
  UNION ALL SELECT 'membership ' || roleid::regrole::text || ' ' || member::regrole::text, ARRAY[admin_option::text]
    FROM pg_auth_members
  ORDER BY 1, 2`;

describe("split runtime role template", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  beforeAll(async () => {
    harness = await createSplitRoleDb();
  });
  afterAll(async () => harness?.close());

  async function collect(kind: "data" | "identity") {
    await harness[kind === "data" ? "dataDb" : "identityDb"]();
    // The harness closes every other database, so nothing is ever inspected here.
    return collectRoleEvidence(harness.client, kind, async () => false);
  }
  async function applyAsOwner() {
    await harness.asOwner();
    await harness.client.exec(await readRuntimeRoleTemplate());
  }
  async function expectDenied(statements: string[]) {
    for (const statement of statements)
      await expect(
        harness.client.query(statement),
        statement,
      ).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/permission denied/),
      });
  }

  it("is idempotent: a second run leaves identical catalog state", async () => {
    await harness.asSuperuser();
    const first = (await harness.client.query(catalogSnapshot)).rows;
    expect(first.length).toBeGreaterThan(0);
    await applyAsOwner();
    await harness.asSuperuser();
    expect((await harness.client.query(catalogSnapshot)).rows).toEqual(first);
  });

  it("creates LOGIN roles without elevated attributes, passwords or memberships", async () => {
    await harness.asSuperuser();
    for (const role of roles) {
      const { rows } = await harness.client.query(
        `SELECT rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls,
           rolpassword IS NULL AS no_password,
           NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = a.oid) AS no_membership
         FROM pg_authid a WHERE rolname = $1`,
        [role],
      );
      expect(rows, role).toEqual([
        {
          rolcanlogin: true,
          rolsuper: false,
          rolinherit: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
          rolbypassrls: false,
          no_password: true,
          no_membership: true,
        },
      ]);
    }
  });

  it("declares exactly the reviewed matrix in its GRANT statements, which the evidence script reads", async () => {
    const template = await readRuntimeRoleTemplate();
    expect(templateGrantMatrix(template)).toEqual(reviewedMatrix);
    for (const unreadable of [
      "GRANT SELECT ON ALL TABLES IN SCHEMA app TO recruitmentos_data;",
      "GRANT SELECT ON TABLE app.records TO fictional_other_role;",
      "GRANT USAGE ON FUNCTION tenant_context.install(text, text) TO recruitmentos_data;",
      "GRANT recruitmentos_identity TO recruitmentos_data;",
      "GRANT SELECT ON TABLE app.records TO recruitmentos_data WITH GRANT OPTION;",
      "GRANT SET ON PARAMETER session_replication_role TO recruitmentos_data;",
      "GRANT USAGE ON TYPE app.fictional_type TO recruitmentos_data;",
      "GRANT USAGE ON LANGUAGE plpgsql TO recruitmentos_identity;",
      "GRANT USAGE ON FOREIGN SERVER fictional_server TO recruitmentos_data;",
      "ALTER ROLE recruitmentos_data SET work_mem = '8MB';",
    ])
      expect(
        () => templateGrantMatrix(template.replace("COMMIT;", unreadable)),
        unreadable,
      ).toThrow(/cannot be read/);
  });

  it("grants exactly the reviewed matrix, reported by the evidence collector", async () => {
    for (const [kind, expected] of [
      ["data", expectedData],
      ["identity", expectedIdentity],
    ] as const) {
      const { evidence } = await collect(kind);
      expect(evidence.drift, kind).toEqual([]);
      expect(evidence.currentUser).toBe(splitRoles[kind]);
      expect(evidence.sessionMatchesCurrentUser).toBe(true);
      expect(evidence.attributes).toEqual(loginOnly);
      expect(evidence.memberOf).toEqual([]);
      expect(evidence.databasePrivileges).toEqual({
        connect: true,
        create: false,
        temporary: false,
      });
      expect(evidence.defaultPrivileges, kind).toEqual([]);
      expect(evidence.publicPrivileges, kind).toEqual(closedToPublic);
      // template0 keeps PUBLIC CONNECT but accepts no connections.
      expect(evidence.databases, kind).toEqual({
        postgres: { connect: true, acceptsConnections: true },
        template0: { connect: true, acceptsConnections: false },
        template1: { connect: false, acceptsConnections: true },
      });
      expect(evidence.grantOptions, kind).toEqual([]);
      expect(evidence.otherPrivileges, kind).toEqual([]);
      expect(evidence.roleSettings, kind).toEqual([]);
      expect(evidence.tablePrivileges, kind).toEqual(expected.tablePrivileges);
      expect(evidence.sequencePrivileges, kind).toEqual({});
      expect(evidence.columnPrivileges, kind).toEqual({});
      expect([...evidence.execute].sort(), kind).toEqual(
        [...expected.helpers].sort(),
      );
      for (const [schema, usage] of Object.entries(expected.schemas))
        expect(evidence.schemaPrivileges[schema], `${kind} ${schema}`).toEqual({
          exists: true,
          usage,
          create: false,
        });
      expect(evidence.schemaPrivileges.storage_ledger).toEqual({
        exists: true,
        usage: false,
        create: false,
      });
      expect(evidence.schemaPrivileges.public).toEqual({
        exists: true,
        usage: false,
        create: false,
      });
    }
  });

  it("covers every app table for the data role and every auth table for the identity role", async () => {
    await harness.asSuperuser();
    const tables = async (schema: string) =>
      (
        await harness.client.query<{ name: string }>(
          `SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS name
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') ORDER BY 1`,
          [schema],
        )
      ).rows.map((row) => row.name);
    const data = (await collect("data")).evidence;
    const identity = (await collect("identity")).evidence;
    for (const table of await tables("app"))
      expect(data.tablePrivileges[table], table).toEqual(
        expect.arrayContaining(["INSERT", "SELECT", "UPDATE"]),
      );
    for (const table of await tables("auth"))
      expect(identity.tablePrivileges[table], table).toContain("SELECT");
  });

  it("passes every safety and boundary check and neither role can assume the other", async () => {
    for (const [kind, boundary, other] of [
      ["data", dataRoleBoundaryQuery, splitRoles.identity],
      ["identity", identityRoleBoundaryQuery, splitRoles.data],
    ] as const) {
      await harness[kind === "data" ? "dataDb" : "identityDb"]();
      for (const query of [
        runtimeRoleSafetyQuery,
        markerRoleBoundaryQuery,
        boundary,
      ])
        expect(
          (await harness.client.query<{ unsafe: boolean }>(query)).rows,
          kind,
        ).toEqual([{ unsafe: false }]);
      expect(
        (
          await harness.client.query<{ member: boolean }>(
            "SELECT pg_has_role(current_user, $1, 'MEMBER') AS member",
            [other],
          )
        ).rows[0].member,
      ).toBe(false);
    }
    const data = await collect("data");
    const identity = await collect("identity");
    expect(data.evidence.checks).toEqual({
      sessionMatchesCurrentUser: true,
      matchesTemplate: true,
      runtimeRoleSafe: true,
      markerBoundarySafe: true,
      roleBoundarySafe: true,
      storageSchemaCurrent: true,
    });
    expect(identity.evidence.checks).toEqual({
      sessionMatchesCurrentUser: true,
      matchesTemplate: true,
      runtimeRoleSafe: true,
      markerBoundarySafe: true,
      roleBoundarySafe: true,
    });
    expect(data.evidence.pass && identity.evidence.pass).toBe(true);
    expect(checkRolePair(data, identity)).toEqual({
      distinctRoles: true,
      sameDatabase: true,
      markersMatch: true,
      dataCannotAssumeIdentity: true,
      identityCannotAssumeData: true,
      pass: true,
    });
    expect(JSON.stringify([data.evidence, identity.evidence])).not.toContain(
      data.marker,
    );
  });

  it("denies the data role TRUNCATE, role switching, identity, key, ledger and marker writes", async () => {
    await harness.dataDb();
    await expectDenied([
      ...appTables.map((table) => `TRUNCATE app.${table}`),
      `SET ROLE ${splitRoles.identity}`,
      `SET ROLE ${splitRoles.owner}`,
      'SELECT * FROM auth."user"',
      "SELECT * FROM auth.session",
      "SELECT * FROM auth.account",
      "SELECT * FROM auth.api_tokens",
      "SELECT * FROM tenant_context.keys",
      "SELECT * FROM tenant_context.contexts",
      "SELECT * FROM storage_ledger.stores",
      "SELECT * FROM storage_ledger.blob_read_leases",
      "SELECT tenant_context.audit_token('fictional','token.created')",
      "UPDATE db_boundary.connection_marker SET singleton = true",
      "INSERT INTO db_boundary.storage_schema(version) VALUES (2)",
      "UPDATE db_boundary.storage_schema SET version = 2",
      "CREATE TABLE app.runtime_role_probe (id integer)",
    ]);
  });

  it("denies the identity role TRUNCATE, role switching, recruitment data, keys, data helpers and claim writes", async () => {
    await harness.identityDb();
    await expectDenied([
      ...[...authTables, "initial_admin_claim"].map(
        (table) => `TRUNCATE auth.${table}`,
      ),
      `SET ROLE ${splitRoles.data}`,
      `SET ROLE ${splitRoles.owner}`,
      "SELECT * FROM app.records",
      "SELECT * FROM app.activity",
      "SELECT * FROM tenant_context.keys",
      "SELECT * FROM db_boundary.storage_schema",
      "SELECT tenant_context.lock_storage_allocation('s3','development','fictional-bucket')",
      "SELECT tenant_context.acquire_blob_read('store_fictional0001')",
      "INSERT INTO auth.initial_admin_claim(id) VALUES (true)",
      "UPDATE auth.initial_admin_claim SET completed_at = NULL",
      "DELETE FROM auth.initial_admin_claim",
      "CREATE TABLE auth.runtime_role_probe (id integer)",
    ]);
  });

  it("converges: a rerun removes privileges granted since the last run", async () => {
    await harness.asOwner();
    await harness.client.exec(`
      GRANT TRUNCATE ON app.records TO ${splitRoles.data};
      GRANT EXECUTE ON FUNCTION tenant_context.audit_token(text,text) TO ${splitRoles.data};
      GRANT SELECT ON app.records TO ${splitRoles.identity};
      GRANT UPDATE (completed_at) ON auth.initial_admin_claim TO ${splitRoles.identity};
    `);
    const extras = `SELECT has_table_privilege('${splitRoles.data}','app.records','TRUNCATE') AS truncate,
      has_function_privilege('${splitRoles.data}','tenant_context.audit_token(text,text)','EXECUTE') AS audit,
      has_table_privilege('${splitRoles.identity}','app.records','SELECT') AS records,
      has_column_privilege('${splitRoles.identity}','auth.initial_admin_claim','completed_at','UPDATE') AS claim`;
    expect((await harness.client.query(extras)).rows[0]).toEqual({
      truncate: true,
      audit: true,
      records: true,
      claim: true,
    });
    await applyAsOwner();
    expect((await harness.client.query(extras)).rows[0]).toEqual({
      truncate: false,
      audit: false,
      records: false,
      claim: false,
    });
    for (const [kind, expected] of [
      ["data", expectedData],
      ["identity", expectedIdentity],
    ] as const) {
      const { evidence } = await collect(kind);
      expect(evidence.tablePrivileges, kind).toEqual(expected.tablePrivileges);
      expect(evidence.columnPrivileges, kind).toEqual({});
      expect([...evidence.execute].sort(), kind).toEqual(
        [...expected.helpers].sort(),
      );
    }
  });

  it("keeps new owner tables and definer functions closed to both roles and PUBLIC", async () => {
    await harness.asOwner();
    await harness.client.exec(`
      CREATE TABLE app.future_probe (id integer, team_id text);
      CREATE FUNCTION tenant_context.future_helper() RETURNS integer LANGUAGE sql
        SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS 'SELECT 1';
    `);
    try {
      for (const grantee of [...roles, "public"]) {
        const { rows } = await harness.client.query(
          `SELECT has_table_privilege($1,'app.future_probe','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table,
             has_any_column_privilege($1,'app.future_probe','SELECT,INSERT,UPDATE,REFERENCES') AS columns,
             has_function_privilege($1,'tenant_context.future_helper()','EXECUTE') AS function`,
          [grantee],
        );
        expect(rows[0], grantee).toEqual({
          table: false,
          columns: false,
          function: false,
        });
      }
      for (const [kind, boundary] of [
        ["data", dataRoleBoundaryQuery],
        ["identity", identityRoleBoundaryQuery],
      ] as const) {
        await harness[kind === "data" ? "dataDb" : "identityDb"]();
        expect(
          (await harness.client.query<{ unsafe: boolean }>(boundary)).rows,
          kind,
        ).toEqual([{ unsafe: false }]);
      }
      await harness.dataDb();
      await expectDenied([
        "SELECT * FROM app.future_probe",
        "SELECT tenant_context.future_helper()",
      ]);
    } finally {
      await harness.asOwner();
      await harness.client.exec(`
        DROP TABLE app.future_probe;
        DROP FUNCTION tenant_context.future_helper();
      `);
    }
  });

  it("reports a role granted the other runtime role, or CREATE on tenant_context, as failing", async () => {
    await harness.asSuperuser();
    await harness.client.exec(
      `GRANT ${splitRoles.identity} TO ${splitRoles.data}`,
    );
    try {
      const data = await collect("data");
      const identity = await collect("identity");
      expect(data.evidence.memberOf).toEqual([splitRoles.identity]);
      expect(data.evidence.checks.roleBoundarySafe).toBe(false);
      expect(data.evidence.pass).toBe(false);
      expect(checkRolePair(data, identity)).toMatchObject({
        dataCannotAssumeIdentity: false,
        pass: false,
      });
    } finally {
      await harness.asSuperuser();
      await harness.client.exec(
        `REVOKE ${splitRoles.identity} FROM ${splitRoles.data}`,
      );
    }
    await harness.asOwner();
    await harness.client.exec(
      `GRANT CREATE ON SCHEMA tenant_context TO ${splitRoles.identity}`,
    );
    const identity = await collect("identity");
    expect(identity.evidence.schemaPrivileges.tenant_context.create).toBe(true);
    expect(identity.evidence.checks.runtimeRoleSafe).toBe(false);
    expect(identity.evidence.pass).toBe(false);
    await applyAsOwner();
    expect((await collect("identity")).evidence.pass).toBe(true);
    expect((await collect("data")).evidence.pass).toBe(true);
  });
});

describe("split runtime role template refusals", () => {
  async function refused(setup: string, role?: string) {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await pg.exec(setup);
      if (role) await pg.exec(`SET ROLE ${role}`);
      await expect(pg.exec(await readRuntimeRoleTemplate())).rejects.toThrow(
        /runtime role template|existing runtime role/,
      );
      await pg.exec("ROLLBACK; RESET ROLE");
      const { rows } = await pg.query<{ name: string; grants: number }>(
        `SELECT r.rolname AS name, (
           (SELECT count(*) FROM pg_class c, aclexplode(c.relacl) a WHERE a.grantee = r.oid)
           + (SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE a.grantee = r.oid)
           + (SELECT count(*) FROM pg_namespace n, aclexplode(n.nspacl) a WHERE a.grantee = r.oid)
           + (SELECT count(*) FROM pg_database d, aclexplode(d.datacl) a WHERE a.grantee = r.oid))::int AS grants
         FROM pg_roles r WHERE r.rolname LIKE 'recruitmentos\\_%' ORDER BY 1`,
      );
      return rows;
    } finally {
      await pg.close();
    }
  }

  it("refuses an existing data role with INHERIT and changes nothing", async () => {
    expect(
      await refused(
        "CREATE ROLE recruitmentos_data LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS NOREPLICATION",
      ),
    ).toEqual([{ name: "recruitmentos_data", grants: 0 }]);
  });

  it("refuses an existing data role that is a member of another role and changes nothing", async () => {
    expect(
      await refused(`
        CREATE ROLE fictional_parent NOLOGIN;
        CREATE ROLE recruitmentos_data LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
        GRANT fictional_parent TO recruitmentos_data;
      `),
    ).toEqual([{ name: "recruitmentos_data", grants: 0 }]);
  });

  it("refuses to run as a role that does not own tenant_context", async () => {
    expect(
      await refused(
        "CREATE ROLE fictional_operator NOLOGIN CREATEROLE",
        "fictional_operator",
      ),
    ).toEqual([]);
  });
});

const data =
  "postgresql://recruitmentos_data:fictional-data-secret@127.0.0.1:55432/fictional_db";
const identity =
  "postgresql://recruitmentos_identity:fictional-identity-secret@127.0.0.1:55432/fictional_db";

/** Run the evidence script's main and check its output never carries a secret. */
async function run(
  env: Record<string, string | undefined>,
  secrets: string[] = [],
) {
  const output: string[] = [];
  const capture = (...args: unknown[]) => void output.push(args.join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  bridge.users.clear();
  const code = await main(env);
  vi.restoreAllMocks();
  const text = output.join("\n");
  for (const secret of [
    "fictional-data-secret",
    "fictional-identity-secret",
    "postgresql://",
    "127.0.0.1",
    "55432",
    "fictional driver failure",
    ...secrets,
  ])
    expect(text).not.toContain(secret);
  return { code, text };
}

describe("db-role-evidence configuration refusals", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    constructed.mockClear();
  });

  for (const [name, env] of [
    ["a missing IDENTITY_DATABASE_URL", { DATABASE_URL: data }],
    [
      "mismatched endpoints",
      {
        DATABASE_URL: data,
        IDENTITY_DATABASE_URL: identity.replace("55432", "55433"),
      },
    ],
    [
      "a set PGOPTIONS",
      {
        DATABASE_URL: data,
        IDENTITY_DATABASE_URL: identity,
        PGOPTIONS: "-c role=recruitmentos_identity",
      },
    ],
  ] as const)
    it(`returns 2 without connecting for ${name}`, async () => {
      const { code, text } = await run(env);
      expect(code).toBe(2);
      expect(text).toMatch(/^Refused: /);
      expect(constructed).not.toHaveBeenCalled();
    });

  it("returns 1 with one generic line when a connection cannot be made", async () => {
    const { code, text } = await run({
      DATABASE_URL: data,
      IDENTITY_DATABASE_URL: identity,
    });
    expect(code).toBe(1);
    expect(constructed).toHaveBeenCalled();
    expect(text.split("\n")).toEqual([
      expect.stringMatching(/^Role evidence failed\./),
    ]);
  });
});

describe("db-role-evidence template drift", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  let marker: string;
  beforeAll(async () => {
    harness = await createSplitRoleDb();
    bridge.pg = harness.client;
    await harness.asSuperuser();
    marker = (
      await harness.client.query<{ id: string }>(
        "SELECT id::text FROM db_boundary.connection_marker",
      )
    ).rows[0].id;
  });
  afterAll(async () => {
    bridge.pg = null;
    await harness?.close();
  });

  type Accepted = { name: string; owner: string; reason: string }[];
  async function report() {
    const { code, text } = await run(
      { DATABASE_URL: data, IDENTITY_DATABASE_URL: identity },
      [marker],
    );
    const report = JSON.parse(text) as {
      data: { drift: string[]; accepted_platform_databases: Accepted };
      identity: { drift: string[]; accepted_platform_databases: Accepted };
      pass: boolean;
    };
    return {
      code,
      pass: report.pass,
      drift: { data: report.data.drift, identity: report.identity.drift },
      accepted: {
        data: report.data.accepted_platform_databases,
        identity: report.identity.accepted_platform_databases,
      },
    };
  }
  async function evidence() {
    const { code, pass, drift } = await report();
    return { code, pass, drift };
  }
  async function rerunTemplate() {
    await harness.asOwner();
    await harness.client.exec(await readRuntimeRoleTemplate());
  }
  const onDatabase = (statement: string) =>
    `DO $$ BEGIN EXECUTE format('${statement}', current_database()); END $$`;

  it("exits 0 when both roles match the template exactly", async () => {
    expect(await report()).toEqual({
      code: 0,
      pass: true,
      drift: { data: [], identity: [] },
      accepted: { data: [], identity: [] },
    });
  });

  const cases: {
    name: string;
    as: "owner" | "superuser";
    setup: string;
    cleanup?: string;
    data?: string[];
    identity?: string[];
  }[] = [
    {
      name: "an extra table privilege",
      as: "owner",
      setup: "GRANT DELETE ON app.records TO recruitmentos_data",
      data: ["extra DELETE on table app.records"],
    },
    {
      name: "a missing table privilege",
      as: "owner",
      setup: "REVOKE UPDATE ON app.records FROM recruitmentos_data",
      data: ["missing UPDATE on table app.records"],
    },
    {
      name: "TRUNCATE",
      as: "owner",
      setup: "GRANT TRUNCATE ON app.records TO recruitmentos_data",
      data: ["extra TRUNCATE on table app.records"],
    },
    {
      name: "SELECT on tenant_context.keys",
      as: "owner",
      setup: "GRANT SELECT ON tenant_context.keys TO recruitmentos_data",
      data: ["extra SELECT on table tenant_context.keys"],
    },
    {
      name: "SELECT on tenant_context.contexts",
      as: "owner",
      setup:
        "GRANT SELECT ON tenant_context.contexts TO recruitmentos_identity",
      identity: ["extra SELECT on table tenant_context.contexts"],
    },
    {
      name: "storage_ledger access",
      as: "owner",
      setup: `GRANT USAGE ON SCHEMA storage_ledger TO recruitmentos_data;
        GRANT SELECT ON storage_ledger.stores TO recruitmentos_data`,
      data: [
        "extra USAGE on schema storage_ledger",
        "extra SELECT on table storage_ledger.stores",
      ],
    },
    {
      name: "an extra column privilege",
      as: "owner",
      setup: "GRANT SELECT (id) ON app.records TO recruitmentos_identity",
      identity: ["extra SELECT on column app.records.id"],
    },
    {
      name: "an extra sequence privilege",
      as: "owner",
      setup: `CREATE SEQUENCE app.drift_probe;
        GRANT USAGE ON SEQUENCE app.drift_probe TO recruitmentos_data`,
      cleanup: "DROP SEQUENCE app.drift_probe",
      data: ["extra USAGE on sequence app.drift_probe"],
    },
    {
      name: "an extra function privilege",
      as: "owner",
      setup:
        "GRANT EXECUTE ON FUNCTION tenant_context.audit_token(text,text) TO recruitmentos_data",
      data: ["extra EXECUTE on function tenant_context.audit_token(text,text)"],
    },
    {
      name: "a missing function privilege",
      as: "owner",
      setup:
        "REVOKE EXECUTE ON FUNCTION tenant_context.acquire_blob_read(text) FROM recruitmentos_data",
      data: [
        "missing EXECUTE on function tenant_context.acquire_blob_read(text)",
      ],
    },
    {
      name: "an extra schema privilege",
      as: "owner",
      setup: "GRANT USAGE ON SCHEMA auth TO recruitmentos_data",
      data: ["extra USAGE on schema auth"],
    },
    {
      name: "a missing schema privilege",
      as: "owner",
      setup: "REVOKE USAGE ON SCHEMA app FROM recruitmentos_data",
      data: ["missing USAGE on schema app"],
    },
    {
      name: "CREATE on a protected schema",
      as: "owner",
      setup: "GRANT CREATE ON SCHEMA app TO recruitmentos_data",
      data: ["extra CREATE on schema app"],
    },
    {
      name: "CREATE on any other schema",
      as: "superuser",
      setup: `CREATE SCHEMA drift_probe;
        GRANT CREATE ON SCHEMA drift_probe TO recruitmentos_identity`,
      cleanup: "DROP SCHEMA drift_probe",
      identity: ["extra CREATE on schema drift_probe"],
    },
    {
      name: "database TEMPORARY",
      as: "owner",
      setup: onDatabase("GRANT TEMPORARY ON DATABASE %I TO recruitmentos_data"),
      data: ["extra TEMPORARY on the database"],
    },
    {
      name: "PUBLIC CONNECT",
      as: "owner",
      setup: onDatabase("GRANT CONNECT ON DATABASE %I TO PUBLIC"),
      data: ["PUBLIC holds databaseConnect"],
      identity: ["PUBLIC holds databaseConnect"],
    },
    {
      name: "PUBLIC USAGE on the public schema",
      as: "owner",
      setup: "GRANT USAGE ON SCHEMA public TO PUBLIC",
      data: ["extra USAGE on schema public", "PUBLIC holds publicSchemaUsage"],
      identity: [
        "extra USAGE on schema public",
        "PUBLIC holds publicSchemaUsage",
      ],
    },
    {
      name: "role attribute drift",
      as: "superuser",
      setup: "ALTER ROLE recruitmentos_data INHERIT",
      cleanup: "ALTER ROLE recruitmentos_data NOINHERIT",
      data: ["role attribute rolinherit is not false"],
    },
    {
      name: "role membership drift",
      as: "superuser",
      setup: `CREATE ROLE drift_parent NOLOGIN;
        GRANT drift_parent TO recruitmentos_identity`,
      cleanup: "DROP ROLE drift_parent",
      identity: ["member of role drift_parent"],
    },
    {
      name: "a default privilege for a runtime role",
      as: "owner",
      setup:
        "ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO recruitmentos_data",
      data: [
        "default privilege tenant_test_owner in app on new tables gives SELECT to recruitmentos_data",
      ],
    },
    {
      name: "PUBLIC EXECUTE on future functions",
      as: "owner",
      setup: "ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC",
      data: ["PUBLIC holds futureFunctionExecute"],
      identity: ["PUBLIC holds futureFunctionExecute"],
    },
    {
      name: "a table privilege WITH GRANT OPTION",
      as: "owner",
      setup:
        "GRANT SELECT ON app.records TO recruitmentos_data WITH GRANT OPTION",
      data: ["extra SELECT WITH GRANT OPTION on table app.records"],
    },
    {
      name: "a column privilege WITH GRANT OPTION",
      as: "owner",
      setup:
        "GRANT SELECT (id) ON app.records TO recruitmentos_data WITH GRANT OPTION",
      data: [
        "extra SELECT WITH GRANT OPTION on column id of table app.records",
      ],
    },
    {
      name: "a sequence privilege WITH GRANT OPTION",
      as: "owner",
      setup: `CREATE SEQUENCE app.drift_probe;
        GRANT USAGE ON SEQUENCE app.drift_probe TO recruitmentos_data WITH GRANT OPTION`,
      cleanup: "DROP SEQUENCE app.drift_probe",
      data: [
        "extra USAGE on sequence app.drift_probe",
        "extra USAGE WITH GRANT OPTION on sequence app.drift_probe",
      ],
    },
    {
      name: "a function privilege WITH GRANT OPTION",
      as: "owner",
      setup:
        "GRANT EXECUTE ON FUNCTION tenant_context.install(text,text) TO recruitmentos_identity WITH GRANT OPTION",
      identity: [
        "extra EXECUTE WITH GRANT OPTION on function tenant_context.install(text,text)",
      ],
    },
    {
      name: "a schema privilege WITH GRANT OPTION",
      as: "owner",
      setup:
        "GRANT USAGE ON SCHEMA db_boundary TO recruitmentos_data WITH GRANT OPTION",
      data: ["extra USAGE WITH GRANT OPTION on schema db_boundary"],
    },
    {
      name: "a database privilege WITH GRANT OPTION",
      as: "owner",
      setup: onDatabase(
        "GRANT CONNECT ON DATABASE %I TO recruitmentos_identity WITH GRANT OPTION",
      ),
      identity: ["extra CONNECT WITH GRANT OPTION on database postgres"],
    },
    {
      name: "SET on session_replication_role",
      as: "superuser",
      setup:
        "GRANT SET ON PARAMETER session_replication_role TO recruitmentos_data",
      cleanup:
        "REVOKE SET ON PARAMETER session_replication_role FROM recruitmentos_data",
      data: [
        "extra SET on parameter session_replication_role to recruitmentos_data",
      ],
    },
    {
      name: "ALTER SYSTEM on a parameter for PUBLIC",
      as: "superuser",
      setup: "GRANT ALTER SYSTEM ON PARAMETER work_mem TO PUBLIC",
      cleanup: "REVOKE ALTER SYSTEM ON PARAMETER work_mem FROM PUBLIC",
      data: ["extra ALTER SYSTEM on parameter work_mem to PUBLIC"],
      identity: ["extra ALTER SYSTEM on parameter work_mem to PUBLIC"],
    },
    {
      name: "a per-role setting",
      as: "superuser",
      setup: "ALTER ROLE recruitmentos_identity SET statement_timeout TO 5000",
      cleanup: "ALTER ROLE recruitmentos_identity RESET ALL",
      identity: ["role setting statement_timeout in every database"],
    },
    {
      name: "a per-role setting in this database",
      as: "superuser",
      setup: onDatabase(
        "ALTER ROLE recruitmentos_data IN DATABASE %I SET search_path TO app",
      ),
      cleanup: onDatabase(
        "ALTER ROLE recruitmentos_data IN DATABASE %I RESET ALL",
      ),
      data: ["role setting search_path in database postgres"],
    },
    {
      name: "USAGE on a type",
      as: "owner",
      setup: `CREATE TYPE app.drift_type AS ENUM ('fictional');
        GRANT USAGE ON TYPE app.drift_type TO recruitmentos_data`,
      cleanup: "DROP TYPE app.drift_type",
      data: ["extra USAGE on type app.drift_type to recruitmentos_data"],
    },
    {
      name: "USAGE on a language",
      as: "superuser",
      setup: "GRANT USAGE ON LANGUAGE plpgsql TO recruitmentos_identity",
      cleanup: "REVOKE USAGE ON LANGUAGE plpgsql FROM recruitmentos_identity",
      identity: ["extra USAGE on language plpgsql to recruitmentos_identity"],
    },
    {
      name: "USAGE on a foreign-data wrapper",
      as: "superuser",
      setup: `CREATE FOREIGN DATA WRAPPER drift_fdw;
        GRANT USAGE ON FOREIGN DATA WRAPPER drift_fdw TO recruitmentos_data`,
      cleanup: "DROP FOREIGN DATA WRAPPER drift_fdw",
      data: [
        "extra USAGE on foreign-data wrapper drift_fdw to recruitmentos_data",
      ],
    },
    {
      name: "PUBLIC USAGE on a foreign server",
      as: "superuser",
      setup: `CREATE FOREIGN DATA WRAPPER drift_fdw;
        CREATE SERVER drift_server FOREIGN DATA WRAPPER drift_fdw;
        GRANT USAGE ON FOREIGN SERVER drift_server TO PUBLIC`,
      cleanup: "DROP FOREIGN DATA WRAPPER drift_fdw CASCADE",
      data: ["extra USAGE on server drift_server to PUBLIC"],
      identity: ["extra USAGE on server drift_server to PUBLIC"],
    },
    {
      name: "PUBLIC CONNECT on another database",
      as: "superuser",
      setup: "GRANT CONNECT ON DATABASE template1 TO PUBLIC",
      cleanup: "REVOKE CONNECT ON DATABASE template1 FROM PUBLIC",
      data: ["can connect to database template1"],
      identity: ["can connect to database template1"],
    },
    {
      name: "a runtime role's CONNECT on another database",
      as: "superuser",
      setup: "GRANT CONNECT ON DATABASE template1 TO recruitmentos_identity",
      cleanup:
        "REVOKE CONNECT ON DATABASE template1 FROM recruitmentos_identity",
      identity: ["can connect to database template1"],
    },
  ];
  for (const drift of cases)
    it(`exits 1 on ${drift.name} and 0 after a template rerun`, async () => {
      await harness[drift.as === "owner" ? "asOwner" : "asSuperuser"]();
      await harness.client.exec(drift.setup);
      try {
        expect(await evidence()).toEqual({
          code: 1,
          pass: false,
          drift: { data: drift.data ?? [], identity: drift.identity ?? [] },
        });
      } finally {
        if (drift.cleanup) {
          await harness.asSuperuser();
          await harness.client.exec(drift.cleanup);
        }
        await rerunTemplate();
      }
      expect((await evidence()).code).toBe(0);
    });

  it("refuses to commit when the runner cannot close the public schema to PUBLIC", async () => {
    await harness.asSuperuser();
    const owner = (
      await harness.client.query<{ owner: string }>(
        "SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'public'",
      )
    ).rows[0].owner;
    await harness.client.exec(`
      ALTER SCHEMA public OWNER TO postgres;
      GRANT USAGE ON SCHEMA public TO PUBLIC;
    `);
    await harness.asOwner();
    await expect(
      harness.client.exec(await readRuntimeRoleTemplate()),
    ).rejects.toThrow(/PUBLIC still has database or public schema access/);
    await harness.client.exec("ROLLBACK");
    await harness.asSuperuser();
    await harness.client.exec(`ALTER SCHEMA public OWNER TO ${owner}`);
    await rerunTemplate();
    expect((await evidence()).code).toBe(0);
  });

  describe("platform-owned databases", () => {
    const platform = "fictional_platform";
    const platformOwner = "fictional_platform_owner";
    const accepted = [
      { name: platform, owner: platformOwner, reason: platformDatabaseReason },
    ];
    const connectDrift = [`can connect to database ${platform}`];
    // A separate fictional cluster database for the inspection connection, as the data role.
    let platformDataDir: Blob;
    beforeAll(async () => {
      const pg = new PGlite();
      await pg.exec(`CREATE ROLE ${splitRoles.data} LOGIN`);
      await pg.exec(`CREATE DATABASE ${platform}`);
      platformDataDir = await pg.dumpDataDir("none");
      await pg.close();
    });

    const cases: {
      name: string;
      owner?: string;
      grant?: string;
      /** SQL run in the inspected database; null leaves it unreachable. */
      contents: string | null;
      clients: number;
      expected: Awaited<ReturnType<typeof report>>;
    }[] = [
      {
        name: "accepts and reports a database owned by another role with no application schema",
        contents: "",
        clients: 3,
        expected: {
          code: 0,
          pass: true,
          drift: { data: [], identity: [] },
          accepted: { data: accepted, identity: accepted },
        },
      },
      {
        name: "rejects that database when it holds the app schema",
        contents: "CREATE SCHEMA app",
        clients: 3,
        expected: {
          code: 1,
          pass: false,
          drift: { data: connectDrift, identity: connectDrift },
          accepted: { data: [], identity: [] },
        },
      },
      {
        name: "rejects that database when it holds a migration ledger",
        contents:
          "CREATE TABLE public.recruitment_migrations (id integer PRIMARY KEY)",
        clients: 3,
        expected: {
          code: 1,
          pass: false,
          drift: { data: connectDrift, identity: connectDrift },
          accepted: { data: [], identity: [] },
        },
      },
      {
        name: "rejects a database owned by the application owner without inspecting it",
        owner: splitRoles.owner,
        contents: "",
        clients: 2,
        expected: {
          code: 1,
          pass: false,
          drift: { data: connectDrift, identity: connectDrift },
          accepted: { data: [], identity: [] },
        },
      },
      {
        name: "rejects it only for the data role when the data role holds CREATE there",
        grant: `GRANT CREATE ON DATABASE ${platform} TO ${splitRoles.data}`,
        contents: "",
        clients: 3,
        expected: {
          code: 1,
          pass: false,
          drift: { data: connectDrift, identity: [] },
          accepted: { data: [], identity: accepted },
        },
      },
      {
        name: "rejects it and still prints the report when it cannot be inspected",
        contents: null,
        clients: 3,
        expected: {
          code: 1,
          pass: false,
          drift: { data: connectDrift, identity: connectDrift },
          accepted: { data: [], identity: [] },
        },
      },
    ];
    for (const platformCase of cases)
      it(`${platformCase.name}, then exits 0 once it is dropped`, async () => {
        await harness.asSuperuser();
        await harness.client.exec(`CREATE ROLE ${platformOwner} NOLOGIN`);
        await harness.client.exec(
          `CREATE DATABASE ${platform} OWNER ${platformCase.owner ?? platformOwner}`,
        );
        if (platformCase.grant) await harness.client.exec(platformCase.grant);
        if (platformCase.contents !== null) {
          const inspected = new PGlite({
            loadDataDir: platformDataDir,
            database: platform,
          });
          if (platformCase.contents)
            await inspected.exec(platformCase.contents);
          bridge.databases.set(platform, inspected);
        }
        try {
          constructed.mockClear();
          expect(await report()).toEqual(platformCase.expected);
          // Two runtime clients plus at most one inspection, shared by both roles.
          expect(constructed).toHaveBeenCalledTimes(platformCase.clients);
        } finally {
          await bridge.databases.get(platform)?.close();
          bridge.databases.delete(platform);
          await harness.asSuperuser();
          await harness.client.exec(`DROP DATABASE ${platform}`);
          await harness.client.exec(`DROP ROLE ${platformOwner}`);
          await rerunTemplate();
        }
        expect((await evidence()).code).toBe(0);
      });
  });
});
