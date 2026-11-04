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

// The evidence script must refuse before it ever builds a database client.
const constructed = vi.hoisted(() => vi.fn());
vi.mock("pg", () => ({
  Client: class {
    constructor() {
      constructed();
      throw new Error(
        "fictional driver failure for postgresql://recruitmentos_data:fictional-data-secret@127.0.0.1:55432/fictional_db",
      );
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
} from "../scripts/db-role-evidence";
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
    "auth.initial_admin_claim": ["SELECT"],
    "db_boundary.connection_marker": ["SELECT"],
  },
  schemas: { app: false, auth: true, tenant_context: true, db_boundary: true },
  helpers: identityRoleHelpers,
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
    return collectRoleEvidence(harness.client, kind);
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

  it("grants exactly the reviewed matrix, reported by the evidence collector", async () => {
    for (const [kind, expected] of [
      ["data", expectedData],
      ["identity", expectedIdentity],
    ] as const) {
      const { evidence } = await collect(kind);
      expect(evidence.currentUser).toBe(splitRoles[kind]);
      expect(evidence.sessionMatchesCurrentUser).toBe(true);
      expect(evidence.attributes).toEqual({
        rolcanlogin: true,
        rolsuper: false,
        rolinherit: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
      });
      expect(evidence.memberOf).toEqual([]);
      expect(evidence.databasePrivileges).toMatchObject({
        connect: true,
        create: false,
      });
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
      expect(evidence.schemaPrivileges.public.create).toBe(false);
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
      runtimeRoleSafe: true,
      markerBoundarySafe: true,
      roleBoundarySafe: true,
      storageSchemaCurrent: true,
    });
    expect(identity.evidence.checks).toEqual({
      sessionMatchesCurrentUser: true,
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

describe("db-role-evidence configuration refusals", () => {
  const data =
    "postgresql://recruitmentos_data:fictional-data-secret@127.0.0.1:55432/fictional_db";
  const identity =
    "postgresql://recruitmentos_identity:fictional-identity-secret@127.0.0.1:55432/fictional_db";
  afterEach(() => {
    vi.restoreAllMocks();
    constructed.mockClear();
  });

  async function run(env: Record<string, string | undefined>) {
    const output: string[] = [];
    const capture = (...args: unknown[]) => void output.push(args.join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    const code = await main(env);
    const text = output.join("\n");
    for (const secret of [
      "fictional-data-secret",
      "fictional-identity-secret",
      "postgresql://",
      "127.0.0.1",
      "55432",
      "fictional driver failure",
    ])
      expect(text).not.toContain(secret);
    return { code, text };
  }

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
