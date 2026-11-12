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
  /** Every query text sent to a database other than fictional_db, in order. */
  inspected: [] as string[],
  /** A query text that fails on such a database, as a refused setting would. */
  failing: null as string | null,
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
      if (this.database !== "fictional_db") {
        bridge.inspected.push(text.replace(/\s+/g, " ").trim());
        if (text === bridge.failing)
          throw new Error("fictional refused setting");
      }
      if (bridge.users.get(pg) !== this.user) {
        await pg.exec(`SET SESSION AUTHORIZATION ${this.user}`);
        bridge.users.set(pg, this.user);
      }
      return pg.query(text, params);
    }
  },
}));

import { sql } from "drizzle-orm";
import { applyMigrations, type TeamTx } from "../src/db";
import { withDeadlinesAndSnapshot } from "../src/db/deadlines";
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
import { installTenantContext } from "../src/lib/tenant-context";
import {
  createSplitRoleDb,
  readRuntimeRoleTemplate,
  seedIdentity,
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
  "bulk_intake_batches",
  "bulk_intake_items",
  // Record files under the upload guards and record scope; no runtime delete (0049).
  "record_files",
];
const authTables = [
  '"user"',
  "organization",
  "session",
  "account",
  "verification",
  "two_factor",
  "member",
  "invitation",
  "rate_limit",
  "api_tokens",
  "api_rate_limits",
];
/** Owner-only app tables: neither runtime role holds any privilege on them (0021, 0036, 0051). */
const ownerOnlyAppTables = [
  "app.candidate_erasures",
  "app.employee_erasures",
  "app.user_anonymisations",
];
/** Read-only for the data role and closed to the identity role (0028, 0047). */
const workspaceTables = [
  "workspaces",
  "workspace_teams",
  "workspace_admins",
  "workspace_users",
];
const workspaceWrites = [
  "INSERT INTO app.workspaces(id,name) VALUES (gen_random_uuid(),'Fictional Company')",
  "UPDATE app.workspaces SET name = 'Fictional Company'",
  "DELETE FROM app.workspaces",
  "INSERT INTO app.workspace_teams(team_id,workspace_id) VALUES ('fictional-team','00000000-0000-4000-a000-000000000001')",
  "UPDATE app.workspace_teams SET workspace_id = workspace_id",
  "DELETE FROM app.workspace_teams",
  "INSERT INTO app.workspace_admins(workspace_id,user_id,level) VALUES ('00000000-0000-4000-a000-000000000001','fictional','owner')",
  "UPDATE app.workspace_admins SET suspended_at = NULL",
  "DELETE FROM app.workspace_admins",
  "INSERT INTO app.workspace_users(workspace_id,user_id) VALUES ('00000000-0000-4000-a000-000000000001','fictional')",
  "UPDATE app.workspace_users SET deactivated_at = NULL, deactivated_by = NULL",
  "DELETE FROM app.workspace_users",
];
/** Written by the data role under company authority, closed to the identity role (0030). */
const configTables = ["config_objects", "config_versions", "config_layouts"];
/** Levels and units under allows_workspace; closure rows only from the owner's trigger (0033). */
const orgTables = ["org_levels", "org_units", "org_unit_closure"];
/** Positions, employees and their positions; no runtime delete (0034). */
const directoryTables = ["positions", "employees", "employee_positions"];
/** Salary brackets under Plan & pay access; no runtime delete (0048). */
const bracketTables = ["salary_bracket_versions", "salary_brackets"];
/** Company groups under the people area; effective rows only from the owner's trigger (0052). */
const groupTables = ["groups", "group_members", "group_managers"];
const deletable = [
  "candidate_states",
  "notification_reads",
  "idempotency",
  "bulk_intake_batches",
  "bulk_intake_items",
];
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
    // Speed samples are written and purged, never updated.
    "app.speed_samples": ["DELETE", "INSERT", "SELECT"],
    // One budget row per member and team, upserted, never deleted.
    "app.speed_sample_budgets": ["INSERT", "SELECT", "UPDATE"],
    // The company workspace tables are written only by the owner, its triggers and its helper (0028).
    "app.workspaces": ["SELECT"],
    "app.workspace_teams": ["SELECT"],
    "app.workspace_admins": ["SELECT"],
    // Deactivation is written only by tenant_context.set_user_active (0047).
    "app.workspace_users": ["SELECT"],
    // The configuration store, under allows_workspace and the immutability guard (0030).
    ...Object.fromEntries(
      configTables.map((table) => [
        `app.${table}`,
        ["DELETE", "INSERT", "SELECT", "UPDATE"],
      ]),
    ),
    // The organisation hierarchy: no runtime delete, and only reads of the closure (0033).
    "app.org_levels": ["INSERT", "SELECT", "UPDATE"],
    "app.org_units": ["INSERT", "SELECT", "UPDATE"],
    "app.org_unit_closure": ["SELECT"],
    // Positions, employees and their positions: no runtime delete (0034).
    ...Object.fromEntries(
      directoryTables.map((table) => [
        `app.${table}`,
        ["INSERT", "SELECT", "UPDATE"],
      ]),
    ),
    // Configured member roles, written only under company owner sessions (0035).
    "app.member_roles": ["DELETE", "INSERT", "SELECT", "UPDATE"],
    // Record assignments, written only through the two owner-run helpers (0037).
    "app.record_assignments": ["SELECT"],
    // Salary brackets under allows_plan and the immutability guard: no runtime delete (0048).
    ...Object.fromEntries(
      bracketTables.map((table) => [
        `app.${table}`,
        ["INSERT", "SELECT", "UPDATE"],
      ]),
    ),
    // Company groups: written under the people area and the guard, effective rows read only (0052).
    ...Object.fromEntries(
      groupTables.map((table) => [
        `app.${table}`,
        ["DELETE", "INSERT", "SELECT", "UPDATE"],
      ]),
    ),
    "app.group_effective_members": ["SELECT"],
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
    // DELETE only for the expired-row purge.
    "auth.oauth_clients": ["DELETE", "INSERT", "SELECT"],
    "auth.oauth_codes": ["DELETE", "INSERT", "SELECT", "UPDATE"],
    "auth.oauth_tokens": ["DELETE", "INSERT", "SELECT", "UPDATE"],
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
    // Both runtime roles run only the three-argument install (0029).
    expect(
      template.match(/^GRANT [^\r\n]*tenant_context\.install\b[^\r\n]*/gm),
    ).toEqual([
      "GRANT EXECUTE ON FUNCTION tenant_context.install(text, text, text[]) TO recruitmentos_data;",
      "GRANT EXECUTE ON FUNCTION tenant_context.install(text, text, text[]) TO recruitmentos_identity;",
    ]);
    for (const unreadable of [
      "GRANT SELECT ON ALL TABLES IN SCHEMA app TO recruitmentos_data;",
      "GRANT SELECT ON TABLE app.records TO fictional_other_role;",
      "GRANT USAGE ON FUNCTION tenant_context.install(text, text, text[]) TO recruitmentos_data;",
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
      expect(
        evidence.execute.filter((helper) =>
          helper.startsWith("tenant_context.install("),
        ),
        kind,
      ).toEqual(["tenant_context.install(text,text,text[])"]);
      // Only the data role may run the cross-team bulk intake purge, the erasure helper, the
      // two MCP CV helpers (0026), the two company workspace helpers (0028), the five
      // configuration store helpers (0030) and the public branding read (0053).
      for (const helper of [
        "tenant_context.allows_workspace(uuid,text,text)",
        "tenant_context.publish_config_version(uuid)",
        "tenant_context.retire_config_version(uuid)",
        "tenant_context.audit_config(uuid,text)",
        "tenant_context.config_history(uuid,timestamp with time zone,integer)",
        "tenant_context.purge_bulk_intake(uuid)",
        "tenant_context.erase_candidate(uuid,text,text)",
        "tenant_context.erase_employee(uuid,text,text)",
        "tenant_context.anonymise_user(text,text,text)",
        "tenant_context.set_mcp_cv_text_access(boolean)",
        "tenant_context.audit_mcp_cv_read(text,uuid)",
        "tenant_context.set_workspace_authority(text,text,text[],boolean)",
        "tenant_context.allows_workspace_admin(uuid,text)",
        "tenant_context.allows_plan(uuid,text)",
        "tenant_context.publish_bracket_version(uuid)",
        "tenant_context.published_bracket_version()",
        "tenant_context.job_title_usage(text)",
        "tenant_context.group_grants(uuid)",
        "tenant_context.computed_group_members(text)",
        "tenant_context.public_branding()",
      ])
        expect(evidence.execute.includes(helper), `${kind} ${helper}`).toBe(
          kind === "data",
        );
      for (const table of ownerOnlyAppTables)
        expect(
          evidence.tablePrivileges[table],
          `${kind} ${table}`,
        ).toBeUndefined();
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
    // Every app table is in the reviewed matrix, with exactly its privileges, or owner-only.
    for (const table of await tables("app")) {
      if (ownerOnlyAppTables.includes(table)) {
        expect(data.tablePrivileges[table], table).toBeUndefined();
        expect(identity.tablePrivileges[table], table).toBeUndefined();
        continue;
      }
      expect(Object.keys(expectedData.tablePrivileges), table).toContain(table);
      expect(data.tablePrivileges[table], table).toEqual(
        (expectedData.tablePrivileges as Record<string, string[]>)[table],
      );
    }
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
      ...[
        ...appTables,
        "speed_samples",
        "speed_sample_budgets",
        ...workspaceTables,
        ...configTables,
        ...orgTables,
        ...directoryTables,
        "member_roles",
        ...bracketTables,
      ].map((table) => `TRUNCATE app.${table}`),
      ...bracketTables.map((table) => `DELETE FROM app.${table}`),
      ...workspaceWrites,
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
      "SELECT * FROM storage_ledger.blob_reconciliation_claims",
      "DELETE FROM storage_ledger.blob_reconciliation_claims",
      "SELECT * FROM app.candidate_erasures",
      "INSERT INTO app.candidate_erasures(id,team_id,candidate_id,erased_by,erased_at) VALUES (gen_random_uuid(),'t',gen_random_uuid(),'u',now())",
      "TRUNCATE app.candidate_erasures",
      "SELECT * FROM app.employee_erasures",
      "TRUNCATE app.employee_erasures",
      "SELECT * FROM app.user_anonymisations",
      "TRUNCATE app.user_anonymisations",
      "DELETE FROM app.records",
      "DELETE FROM app.activity",
      "SELECT tenant_context.audit_token('fictional','token.created')",
      "SELECT tenant_context.audit_grant_reuse('fictional','refresh_token_reused')",
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
      "SELECT tenant_context.claim_blob_reconciliation('store_fictional0001')",
      "SELECT tenant_context.purge_bulk_intake(NULL)",
      "SELECT tenant_context.erase_candidate(gen_random_uuid(), 'Fictional', 'app')",
      "SELECT tenant_context.erase_employee(gen_random_uuid(), 'Fictional', 'app')",
      "SELECT tenant_context.anonymise_user('fictional', 'Fictional', 'app')",
      "SELECT tenant_context.set_mcp_cv_text_access(false)",
      "SELECT tenant_context.audit_mcp_cv_read('get_cv_text', gen_random_uuid())",
      "SELECT tenant_context.set_workspace_authority('fictional', 'admin', '{fields}', true)",
      "SELECT tenant_context.allows_workspace(gen_random_uuid(), 'read', 'fields')",
      "SELECT tenant_context.publish_config_version(gen_random_uuid())",
      "SELECT tenant_context.retire_config_version(gen_random_uuid())",
      "SELECT tenant_context.audit_config(gen_random_uuid(), 'config.published')",
      "SELECT * FROM tenant_context.config_history(NULL, NULL, 50)",
      ...workspaceTables.map((table) => `SELECT * FROM app.${table}`),
      ...workspaceWrites,
      ...[...configTables, ...orgTables, ...bracketTables].flatMap((table) => [
        `SELECT * FROM app.${table}`,
        `DELETE FROM app.${table}`,
      ]),
      "SELECT tenant_context.allows_plan(gen_random_uuid(), 'read')",
      "SELECT tenant_context.publish_bracket_version(gen_random_uuid())",
      "SELECT tenant_context.published_bracket_version()",
      "SELECT * FROM tenant_context.job_title_usage('fictional-title')",
      "SELECT * FROM app.candidate_erasures",
      "SELECT * FROM app.employee_erasures",
      "TRUNCATE app.employee_erasures",
      "SELECT * FROM app.user_anonymisations",
      "TRUNCATE app.user_anonymisations",
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

  it("denies the data role every change of a published configuration version (0030)", async () => {
    // A fictional company owner: the first seeded user creates the first team.
    const owner = await seedIdentity(await harness.asOwner(), {
      userId: "grants-config-owner",
      teamId: "grants-config-team",
    });
    const asCompanyOwner = <T>(work: (tx: TeamTx) => Promise<T>) =>
      harness.dataDb().then((db) =>
        withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
          await installTenantContext(tx, owner, snapshot);
          return work(tx);
        }),
      );
    const { objectId, versionId } = await asCompanyOwner(async (tx) => {
      const [object] = (
        await tx.execute<{ id: string }>(
          sql`insert into app.config_objects(workspace_id, type, key) select workspace_id, 'workflow', 'grants-probe' from app.workspace_teams where team_id = ${owner.teamId} returning id`,
        )
      ).rows;
      const [version] = (
        await tx.execute<{ id: string }>(
          sql`insert into app.config_versions(object_id, workspace_id, body) select id, workspace_id, '{"label":"Fictional probe"}' from app.config_objects where id = ${object.id}::uuid returning id`,
        )
      ).rows;
      await tx.execute(
        sql`update app.config_objects set draft_version_id = ${version.id}::uuid where id = ${object.id}::uuid`,
      );
      await tx.execute(
        sql`select tenant_context.publish_config_version(${version.id}::uuid)`,
      );
      return { objectId: object.id, versionId: version.id };
    });
    for (const statement of [
      `UPDATE app.config_versions SET body = '{"label":"Forged"}' WHERE id = '${versionId}'`,
      `UPDATE app.config_versions SET body_sha256 = repeat('0', 64) WHERE id = '${versionId}'`,
      `UPDATE app.config_versions SET number = 5 WHERE id = '${versionId}'`,
      `UPDATE app.config_versions SET object_id = gen_random_uuid() WHERE id = '${versionId}'`,
      `UPDATE app.config_versions SET state = 'retired' WHERE id = '${versionId}'`,
      `DELETE FROM app.config_versions WHERE id = '${versionId}'`,
      `DELETE FROM app.config_objects WHERE id = '${objectId}'`,
      `UPDATE app.config_objects SET current_version_id = NULL WHERE id = '${objectId}'`,
    ])
      await expect(
        asCompanyOwner((tx) => tx.execute(sql.raw(statement))),
        statement,
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    await harness.asSuperuser();
    expect(
      (
        await harness.client.query(
          "SELECT state, number FROM app.config_versions WHERE id = $1",
          [versionId],
        )
      ).rows,
    ).toEqual([{ state: "published", number: 1 }]);
  });

  it("denies the data role every closure write; only the owner's trigger writes it (0033)", async () => {
    // The same fictional company owner as the case above; seeding is idempotent.
    const owner = await seedIdentity(await harness.asOwner(), {
      userId: "grants-config-owner",
      teamId: "grants-config-team",
    });
    const asCompanyOwner = <T>(work: (tx: TeamTx) => Promise<T>) =>
      harness.dataDb().then((db) =>
        withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
          await installTenantContext(tx, owner, snapshot);
          return work(tx);
        }),
      );
    const unit = await asCompanyOwner(async (tx) => {
      await tx.execute(
        sql`insert into app.org_levels(workspace_id, name, depth) select workspace_id, 'Fictional level', 0 from app.workspace_teams where team_id = ${owner.teamId}`,
      );
      const { rows } = await tx.execute<{ id: string }>(
        sql`insert into app.org_units(workspace_id, level_id, name, code) select workspace_id, (select id from app.org_levels), 'Fictional unit', 'GRANTS-1' from app.workspace_teams where team_id = ${owner.teamId} returning id`,
      );
      return rows[0].id;
    });
    const closure = async () => {
      await harness.asSuperuser();
      return (
        await harness.client.query(
          "SELECT ancestor_id, descendant_id, depth FROM app.org_unit_closure",
        )
      ).rows;
    };
    expect(await closure()).toEqual([
      { ancestor_id: unit, descendant_id: unit, depth: 0 },
    ]);
    for (const statement of [
      `INSERT INTO app.org_unit_closure(workspace_id, ancestor_id, descendant_id, depth) SELECT workspace_id, id, id, 1 FROM app.org_units WHERE id = '${unit}'`,
      `UPDATE app.org_unit_closure SET depth = 3 WHERE descendant_id = '${unit}'`,
      `DELETE FROM app.org_unit_closure WHERE descendant_id = '${unit}'`,
      `DELETE FROM app.org_units WHERE id = '${unit}'`,
      "DELETE FROM app.org_levels",
    ])
      await expect(
        asCompanyOwner((tx) => tx.execute(sql.raw(statement))),
        statement,
      ).rejects.toMatchObject({
        cause: {
          code: "42501",
          message: expect.stringMatching(/permission denied/),
        },
      });
    expect(await closure()).toEqual([
      { ancestor_id: unit, descendant_id: unit, depth: 0 },
    ]);
  });

  it("denies both roles every write of app.group_effective_members; only the owner's trigger writes it (0052)", async () => {
    // The same fictional company owner as the cases above; seeding is idempotent.
    const owner = await seedIdentity(await harness.asOwner(), {
      userId: "grants-config-owner",
      teamId: "grants-config-team",
    });
    const asCompanyOwner = <T>(work: (tx: TeamTx) => Promise<T>) =>
      harness.dataDb().then((db) =>
        withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
          await installTenantContext(tx, owner, snapshot);
          return work(tx);
        }),
      );
    const group = await asCompanyOwner(async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(
        sql`insert into app.groups(workspace_id, name) select workspace_id, 'Fictional grants group' from app.workspace_teams where team_id = ${owner.teamId} returning id`,
      );
      await tx.execute(
        sql`insert into app.group_members(group_id, workspace_id, user_id) select ${rows[0].id}::uuid, workspace_id, ${owner.userId} from app.workspace_teams where team_id = ${owner.teamId}`,
      );
      return rows[0].id;
    });
    const effective = async () => {
      await harness.asSuperuser();
      return (
        await harness.client.query(
          "SELECT group_id, user_id FROM app.group_effective_members",
        )
      ).rows;
    };
    expect(await effective()).toEqual([
      { group_id: group, user_id: owner.userId },
    ]);
    const writes = [
      `INSERT INTO app.group_effective_members(workspace_id, group_id, user_id) SELECT workspace_id, id, 'grants-config-owner' FROM app.groups WHERE id = '${group}'`,
      `UPDATE app.group_effective_members SET user_id = user_id WHERE group_id = '${group}'`,
      `DELETE FROM app.group_effective_members WHERE group_id = '${group}'`,
      "TRUNCATE app.group_effective_members",
    ];
    for (const statement of writes)
      await expect(
        asCompanyOwner((tx) => tx.execute(sql.raw(statement))),
        statement,
      ).rejects.toMatchObject({
        cause: {
          code: "42501",
          message: expect.stringMatching(/permission denied/),
        },
      });
    await harness.identityDb();
    await expectDenied([
      ...writes,
      ...[
        "groups",
        "group_members",
        "group_managers",
        "group_effective_members",
      ].map((table) => `SELECT * FROM app.${table}`),
      "SELECT tenant_context.group_grants(gen_random_uuid())",
      "SELECT * FROM tenant_context.computed_group_members('all-members')",
    ]);
    expect(await effective()).toEqual([
      { group_id: group, user_id: owner.userId },
    ]);
  });

  it("grants the data role no directory DELETE or TRUNCATE and the identity role nothing on them (0034)", async () => {
    await harness.dataDb();
    await expectDenied(
      directoryTables.flatMap((table) => [
        `DELETE FROM app.${table}`,
        `TRUNCATE app.${table}`,
      ]),
    );
    await harness.identityDb();
    await expectDenied([
      ...directoryTables.flatMap((table) => [
        `SELECT * FROM app.${table}`,
        `INSERT INTO app.${table} DEFAULT VALUES`,
        `UPDATE app.${table} SET workspace_id = workspace_id`,
        `DELETE FROM app.${table}`,
      ]),
      "SELECT tenant_context.allows_directory(gen_random_uuid(), 'read')",
      "SELECT * FROM tenant_context.home_unit_changes(NULL, 50)",
    ]);
    await harness.asSuperuser();
    const helpers = [
      "tenant_context.allows_directory(uuid,text)",
      "tenant_context.home_unit_changes(timestamp with time zone,integer)",
    ];
    const triggers = [
      "app.guard_directory_row()",
      "app.guard_position_job_role()",
      "app.audit_directory_change()",
      "app.guard_scope_sources()",
      "app.maintain_org_closure()",
      "app.guard_org_archive()",
    ];
    const execute = async (grantee: string, fn: string) =>
      (
        await harness.client.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
          [grantee, fn],
        )
      ).rows[0].allowed;
    for (const fn of helpers) {
      expect(await execute(splitRoles.data, fn), fn).toBe(true);
      expect(await execute(splitRoles.identity, fn), fn).toBe(false);
      expect(await execute("public", fn), fn).toBe(false);
    }
    for (const fn of triggers)
      for (const grantee of [...roles, "public"])
        expect(await execute(grantee, fn), `${grantee} ${fn}`).toBe(false);
    // Owner-owned, with the fixed search_path, for every new or replaced function.
    expect(
      (
        await harness.client.query<{
          fn: string;
          owned: boolean;
          path: boolean;
        }>(
          `SELECT p.oid::regprocedure::text AS fn, p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
             'search_path=pg_catalog, pg_temp' = ANY(p.proconfig) AS path
           FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`,
          [[...helpers, ...triggers]],
        )
      ).rows.map((row) => row.owned && row.path),
    ).toEqual([...helpers, ...triggers].map(() => true));
  });

  it("grants the data role the member-role table and the owner-only read, the identity role nothing, and no trigger EXECUTE (0035)", async () => {
    await harness.dataDb();
    await expectDenied(["TRUNCATE app.member_roles"]);
    await harness.identityDb();
    await expectDenied([
      "SELECT * FROM app.member_roles",
      "INSERT INTO app.member_roles DEFAULT VALUES",
      "UPDATE app.member_roles SET user_id = user_id",
      "DELETE FROM app.member_roles",
      "SELECT * FROM tenant_context.role_assignment_changes(NULL, 50)",
    ]);
    await harness.asSuperuser();
    const helper =
      "tenant_context.role_assignment_changes(timestamp with time zone,integer)";
    const install = "tenant_context.install(text,text,text[])";
    const triggers = ["app.guard_member_role()", "app.audit_member_role()"];
    const execute = async (grantee: string, fn: string) =>
      (
        await harness.client.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
          [grantee, fn],
        )
      ).rows[0].allowed;
    expect(await execute(splitRoles.data, helper)).toBe(true);
    expect(await execute(splitRoles.identity, helper)).toBe(false);
    expect(await execute("public", helper)).toBe(false);
    for (const fn of triggers)
      for (const grantee of [...roles, "public"])
        expect(await execute(grantee, fn), `${grantee} ${fn}`).toBe(false);
    // Owner-owned, security definer, with the fixed search_path, for every new or replaced function.
    expect(
      (
        await harness.client.query<{
          owned: boolean;
          definer: boolean;
          path: boolean;
        }>(
          `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
             p.prosecdef AS definer, 'search_path=pg_catalog, pg_temp' = ANY(p.proconfig) AS path
           FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY p.oid::regprocedure::text`,
          [[helper, install, ...triggers]],
        )
      ).rows,
    ).toEqual(
      [helper, install, ...triggers].map(() => ({
        owned: true,
        definer: true,
        path: true,
      })),
    );
  });

  it("grants the data role the employee erasure helper only, no tombstone write, and refuses forged erasure activity (0036)", async () => {
    const writes = [
      "INSERT INTO app.employee_erasures(id,workspace_id,employee_id,erased_by,erased_at,erasure_source) VALUES (gen_random_uuid(),'00000000-0000-4000-a000-000000000001',gen_random_uuid(),'fictional',now(),'app')",
      "UPDATE app.employee_erasures SET erased_at = now()",
      "DELETE FROM app.employee_erasures",
      "TRUNCATE app.employee_erasures",
    ];
    for (const role of ["dataDb", "identityDb"] as const) {
      await harness[role]();
      await expectDenied(writes);
    }
    // The same fictional company owner as the cases above; seeding is idempotent.
    const owner = await seedIdentity(await harness.asOwner(), {
      userId: "grants-config-owner",
      teamId: "grants-config-team",
    });
    const forged = (kind: string, action: string, pointer: string) =>
      `INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary,metadata,employee_erasure_id) VALUES ('${owner.teamId}','${owner.userId}','session','${action}','${kind}','Forged','{}',${pointer})`;
    for (const statement of [
      forged("employee-erasure", "employee.erased", "NULL"),
      forged("employee-erasure", "employee.erased", "gen_random_uuid()"),
      forged("record", "record.updated", "gen_random_uuid()"),
      forged("directory", "directory.employee_updated", "gen_random_uuid()"),
    ])
      await expect(
        harness.dataDb().then((db) =>
          withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
            await installTenantContext(tx, owner, snapshot);
            return tx.execute(sql.raw(statement));
          }),
        ),
        statement,
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    await harness.asSuperuser();
    const helper = "tenant_context.erase_employee(uuid,text,text)";
    const execute = async (grantee: string, fn: string) =>
      (
        await harness.client.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
          [grantee, fn],
        )
      ).rows[0].allowed;
    expect(await execute(splitRoles.data, helper)).toBe(true);
    expect(await execute(splitRoles.identity, helper)).toBe(false);
    expect(await execute("public", helper)).toBe(false);
    for (const fn of [
      "app.audit_directory_change()",
      "app.prevent_activity_mutation()",
    ])
      for (const grantee of [...roles, "public"])
        expect(await execute(grantee, fn), `${grantee} ${fn}`).toBe(false);
    // Owner-owned with the fixed search_path; the helper and the audit are security definers, the
    // activity guard runs as the caller, so its owner check sees who changes the row.
    expect(
      (
        await harness.client.query<{
          fn: string;
          owned: boolean;
          definer: boolean;
          path: boolean;
        }>(
          `SELECT p.oid::regprocedure::text AS fn, p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
             p.prosecdef AS definer, 'search_path=pg_catalog, pg_temp' = ANY(p.proconfig) AS path
           FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`,
          [
            [
              helper,
              "app.audit_directory_change()",
              "app.prevent_activity_mutation()",
            ],
          ],
        )
      ).rows,
    ).toEqual([
      {
        fn: "app.audit_directory_change()",
        owned: true,
        definer: true,
        path: true,
      },
      {
        fn: "app.prevent_activity_mutation()",
        owned: true,
        definer: false,
        path: true,
      },
      { fn: helper, owned: true, definer: true, path: true },
    ]);
  });

  it("grants the data role SELECT, INSERT and UPDATE on record files with no DELETE or TRUNCATE, and the identity role nothing (0049)", async () => {
    await harness.asSuperuser();
    const granted = async (grantee: string) =>
      (
        await harness.client.query<{ privilege: string }>(
          `SELECT privilege_type AS privilege FROM information_schema.role_table_grants
           WHERE grantee = $1 AND table_schema = 'app' AND table_name = 'record_files' ORDER BY 1`,
          [grantee],
        )
      ).rows.map((row) => row.privilege);
    expect(await granted(splitRoles.data)).toEqual([
      "INSERT",
      "SELECT",
      "UPDATE",
    ]);
    expect(await granted(splitRoles.identity)).toEqual([]);
    expect(await granted("PUBLIC")).toEqual([]);
    await harness.dataDb();
    await expectDenied([
      "DELETE FROM app.record_files",
      "TRUNCATE app.record_files",
    ]);
    await harness.identityDb();
    await expectDenied([
      "SELECT * FROM app.record_files",
      "UPDATE app.record_files SET status = status",
      "DELETE FROM app.record_files",
    ]);
  });

  it("grants the data role the user anonymisation helper only, no tombstone access, and refuses forged anonymisation activity (0051)", async () => {
    const statements = [
      "SELECT * FROM app.user_anonymisations",
      "INSERT INTO app.user_anonymisations(id,workspace_id,user_id,anonymised_by,anonymised_at,erasure_source) VALUES (gen_random_uuid(),'00000000-0000-4000-a000-000000000001','fictional','fictional',now(),'app')",
      "UPDATE app.user_anonymisations SET anonymised_at = now()",
      "DELETE FROM app.user_anonymisations",
      "TRUNCATE app.user_anonymisations",
    ];
    for (const role of ["dataDb", "identityDb"] as const) {
      await harness[role]();
      await expectDenied(statements);
    }
    const owner = await seedIdentity(await harness.asOwner(), {
      userId: "grants-config-owner",
      teamId: "grants-config-team",
    });
    const forged = (kind: string, action: string, pointer: string) =>
      `INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary,metadata,user_anonymisation_id) VALUES ('${owner.teamId}','${owner.userId}','session','${action}','${kind}','Forged','{}',${pointer})`;
    for (const statement of [
      forged("user-anonymisation", "user.anonymised", "NULL"),
      forged("user-anonymisation", "user.anonymised", "gen_random_uuid()"),
      forged("record", "record.updated", "gen_random_uuid()"),
      forged("user-account", "user.deactivated", "gen_random_uuid()"),
      `UPDATE app.activity SET user_anonymisation_id = gen_random_uuid() WHERE team_id = '${owner.teamId}'`,
    ])
      await expect(
        harness.dataDb().then((db) =>
          withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
            await installTenantContext(tx, owner, snapshot);
            return tx.execute(sql.raw(statement));
          }),
        ),
        statement,
      ).rejects.toBeTruthy();
    await harness.asSuperuser();
    const helper = "tenant_context.anonymise_user(text,text,text)";
    const allowed = async (grantee: string) =>
      (
        await harness.client.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
          [grantee, helper],
        )
      ).rows[0].allowed;
    expect(await allowed(splitRoles.data)).toBe(true);
    expect(await allowed(splitRoles.identity)).toBe(false);
    expect(await allowed("public")).toBe(false);
    expect(
      (
        await harness.client.query(
          `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
             p.prosecdef AS definer, p.proconfig AS config
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
          [helper],
        )
      ).rows,
    ).toEqual([
      {
        owned: true,
        definer: true,
        config: ["search_path=pg_catalog, pg_temp"],
      },
    ]);
    for (const role of roles)
      expect(
        (
          await harness.client.query(
            "SELECT has_any_column_privilege($1, 'app.user_anonymisations', 'SELECT,INSERT,UPDATE,REFERENCES') AS any, has_table_privilege($1, 'app.user_anonymisations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS table",
            [role],
          )
        ).rows,
        role,
      ).toEqual([{ any: false, table: false }]);
  });

  it("grants the data role only reads of record assignments and the two helpers, the identity role nothing, and refuses forged assignment activity (0037)", async () => {
    const writes = [
      "INSERT INTO app.record_assignments(team_id,record_id,user_id,relation) VALUES ('fictional',gen_random_uuid(),'fictional','assignee')",
      "UPDATE app.record_assignments SET relation = relation",
      "DELETE FROM app.record_assignments",
      "TRUNCATE app.record_assignments",
    ];
    await harness.dataDb();
    await expectDenied(writes);
    await harness.identityDb();
    await expectDenied([
      "SELECT * FROM app.record_assignments",
      ...writes,
      "SELECT tenant_context.add_assignment(gen_random_uuid(), 'fictional', 'assignee')",
      "SELECT tenant_context.remove_assignment(gen_random_uuid(), 'fictional', 'assignee')",
    ]);
    // The same fictional company owner as the cases above; seeding is idempotent.
    const owner = await seedIdentity(await harness.asOwner(), {
      userId: "grants-config-owner",
      teamId: "grants-config-team",
    });
    for (const action of ["assignment.added", "assignment.removed"])
      await expect(
        harness.dataDb().then((db) =>
          withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
            await installTenantContext(tx, owner, snapshot);
            return tx.execute(
              sql.raw(
                `INSERT INTO app.activity(team_id,record_id,actor_id,actor_type,action,kind,summary,metadata) VALUES ('${owner.teamId}',gen_random_uuid(),'${owner.userId}','session','${action}','assignment','Forged','{}')`,
              ),
            );
          }),
        ),
        action,
      ).rejects.toMatchObject({ cause: { code: "42501" } });
    await harness.asSuperuser();
    const helpers = [
      "tenant_context.add_assignment(uuid,text,text)",
      "tenant_context.remove_assignment(uuid,text,text)",
    ];
    const internal = [
      "tenant_context.change_assignment(uuid,text,text,boolean)",
      "app.maintain_record_scope()",
    ];
    const execute = async (grantee: string, fn: string) =>
      (
        await harness.client.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
          [grantee, fn],
        )
      ).rows[0].allowed;
    for (const fn of helpers) {
      expect(await execute(splitRoles.data, fn), fn).toBe(true);
      expect(await execute(splitRoles.identity, fn), fn).toBe(false);
      expect(await execute("public", fn), fn).toBe(false);
    }
    for (const fn of internal)
      for (const grantee of [...roles, "public"])
        expect(await execute(grantee, fn), `${grantee} ${fn}`).toBe(false);
    expect(
      (
        await harness.client.query<{
          owned: boolean;
          definer: boolean;
          path: boolean;
        }>(
          `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
             p.prosecdef AS definer, 'search_path=pg_catalog, pg_temp' = ANY(p.proconfig) AS path
           FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[])`,
          [[...helpers, ...internal]],
        )
      ).rows,
    ).toEqual(
      [...helpers, ...internal].map(() => ({
        owned: true,
        definer: true,
        path: true,
      })),
    );
  });

  it("grants the data role EXECUTE on the five record-scope helpers, the identity role and PUBLIC none, with the table grants unchanged (0038)", async () => {
    await harness.asSuperuser();
    const helpers = [
      "tenant_context.scope_is_all()",
      "tenant_context.in_scope(text,text,uuid,uuid,uuid,uuid,uuid,text,uuid,uuid)",
      "tenant_context.record_in_scope(text,uuid)",
      "tenant_context.candidate_in_scope(text,uuid)",
      "tenant_context.context_actor_key()",
    ];
    expect(dataRoleHelpers).toEqual(expect.arrayContaining(helpers));
    expect(identityRoleHelpers).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/scope|actor_key/)]),
    );
    const execute = async (grantee: string, fn: string) =>
      (
        await harness.client.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
          [grantee, fn],
        )
      ).rows[0].allowed;
    for (const fn of helpers) {
      expect(await execute(splitRoles.data, fn), fn).toBe(true);
      expect(await execute(splitRoles.identity, fn), fn).toBe(false);
      expect(await execute("public", fn), fn).toBe(false);
    }
    expect(
      (
        await harness.client.query(
          `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
             p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS config
           FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[])`,
          [helpers],
        )
      ).rows,
    ).toEqual(
      helpers.map(() => ({
        owned: true,
        definer: true,
        volatility: "s",
        config: ["search_path=pg_catalog, pg_temp"],
      })),
    );
    // The five tables the new policies limit keep exactly their earlier grants.
    const tables = [
      "app.records",
      "app.activity",
      "app.uploads",
      "app.record_assignments",
      "app.idempotency",
    ];
    for (const table of tables) {
      const granted = async (grantee: string) =>
        (
          await harness.client.query<{ privilege: string }>(
            `SELECT privilege_type AS privilege FROM information_schema.role_table_grants
             WHERE grantee = $1 AND table_schema || '.' || table_name = $2 ORDER BY 1`,
            [grantee, table],
          )
        ).rows.map((row) => row.privilege);
      expect(await granted(splitRoles.data), table).toEqual(
        (expectedData.tablePrivileges as Record<string, string[]>)[table],
      );
      expect(await granted(splitRoles.identity), table).toEqual([]);
    }
  });

  it("grants the data role EXECUTE on the workspace team list, the identity role and PUBLIC none (0041)", async () => {
    await harness.identityDb();
    await expectDenied(["SELECT * FROM tenant_context.workspace_team_list()"]);
    await harness.asSuperuser();
    const helper = "tenant_context.workspace_team_list()";
    expect(dataRoleHelpers).toContain(helper);
    expect(identityRoleHelpers).not.toContain(helper);
    const execute = async (grantee: string) =>
      (
        await harness.client.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
          [grantee, helper],
        )
      ).rows[0].allowed;
    expect(await execute(splitRoles.data)).toBe(true);
    expect(await execute(splitRoles.identity)).toBe(false);
    expect(await execute("public")).toBe(false);
    expect(
      (
        await harness.client.query(
          `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
             p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS config
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
          [helper],
        )
      ).rows,
    ).toEqual([
      {
        owned: true,
        definer: true,
        volatility: "s",
        config: ["search_path=pg_catalog, pg_temp"],
      },
    ]);
  });

  it("grants the data role EXECUTE on the workspace people helper, the identity role and PUBLIC none (0042)", async () => {
    await harness.identityDb();
    await expectDenied([
      "SELECT * FROM tenant_context.workspace_people(NULL, NULL, NULL, NULL, NULL, NULL)",
    ]);
    await harness.asSuperuser();
    const helper =
      "tenant_context.workspace_people(text,text,text,text,text,text)";
    expect(dataRoleHelpers).toContain(helper);
    expect(identityRoleHelpers).not.toContain(helper);
    const execute = async (grantee: string) =>
      (
        await harness.client.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
          [grantee, helper],
        )
      ).rows[0].allowed;
    expect(await execute(splitRoles.data)).toBe(true);
    expect(await execute(splitRoles.identity)).toBe(false);
    expect(await execute("public")).toBe(false);
    expect(
      (
        await harness.client.query(
          `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
             p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS config
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
          [helper],
        )
      ).rows,
    ).toEqual([
      {
        owned: true,
        definer: true,
        volatility: "s",
        config: ["search_path=pg_catalog, pg_temp"],
      },
    ]);
  });

  it("grants the data role EXECUTE on the two team archive helpers, the identity role and PUBLIC none (0044)", async () => {
    await harness.identityDb();
    await expectDenied([
      "SELECT tenant_context.set_team_archived(NULL, NULL)",
      "SELECT * FROM tenant_context.member_archived_teams()",
    ]);
    await harness.asSuperuser();
    for (const [helper, volatility] of [
      ["tenant_context.set_team_archived(text,boolean)", "v"],
      ["tenant_context.member_archived_teams()", "s"],
    ]) {
      expect(dataRoleHelpers, helper).toContain(helper);
      expect(identityRoleHelpers, helper).not.toContain(helper);
      const execute = async (grantee: string) =>
        (
          await harness.client.query<{ allowed: boolean }>(
            "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
            [grantee, helper],
          )
        ).rows[0].allowed;
      expect(await execute(splitRoles.data), helper).toBe(true);
      expect(await execute(splitRoles.identity), helper).toBe(false);
      expect(await execute("public"), helper).toBe(false);
      expect(
        (
          await harness.client.query(
            `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
               p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS config
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
            [helper],
          )
        ).rows,
        helper,
      ).toEqual([
        {
          owned: true,
          definer: true,
          volatility,
          config: ["search_path=pg_catalog, pg_temp"],
        },
      ]);
    }
    // workspace_team_list was dropped and created again; the template grants it again.
    expect(
      (
        await harness.client.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1, 'tenant_context.workspace_team_list()', 'EXECUTE') AS allowed",
          [splitRoles.data],
        )
      ).rows[0].allowed,
    ).toBe(true);
    // No runtime role gains any write on app.workspace_teams.
    for (const role of [splitRoles.data, splitRoles.identity])
      for (const privilege of ["INSERT", "UPDATE", "DELETE"])
        expect(
          (
            await harness.client.query<{ allowed: boolean }>(
              "SELECT has_table_privilege($1, 'app.workspace_teams', $2) AS allowed",
              [role, privilege],
            )
          ).rows[0].allowed,
          `${role} ${privilege}`,
        ).toBe(false);
  });

  it("grants the data role EXECUTE on the workspace person helper, the identity role and PUBLIC none (0046)", async () => {
    await harness.identityDb();
    await expectDenied([
      "SELECT * FROM tenant_context.workspace_person('fictional-person')",
    ]);
    await harness.asSuperuser();
    const helper = "tenant_context.workspace_person(text)";
    expect(dataRoleHelpers).toContain(helper);
    expect(identityRoleHelpers).not.toContain(helper);
    const execute = async (grantee: string) =>
      (
        await harness.client.query<{ allowed: boolean }>(
          "SELECT has_function_privilege($1, $2, 'EXECUTE') AS allowed",
          [grantee, helper],
        )
      ).rows[0].allowed;
    expect(await execute(splitRoles.data)).toBe(true);
    expect(await execute(splitRoles.identity)).toBe(false);
    expect(await execute("public")).toBe(false);
    expect(
      (
        await harness.client.query(
          `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
             p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS config
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
          [helper],
        )
      ).rows,
    ).toEqual([
      {
        owned: true,
        definer: true,
        volatility: "s",
        config: ["search_path=pg_catalog, pg_temp"],
      },
    ]);
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
        "GRANT EXECUTE ON FUNCTION tenant_context.install(text,text,text[]) TO recruitmentos_identity WITH GRANT OPTION",
      identity: [
        "extra EXECUTE WITH GRANT OPTION on function tenant_context.install(text,text,text[])",
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

    it("pins search_path and a statement timeout inside the read-only inspection, and refuses the database if either fails", async () => {
      const setPath = "SET LOCAL search_path = pg_catalog, pg_temp";
      const setTimeout = "SET LOCAL statement_timeout = '5s'";
      for (const failing of [null, setPath, setTimeout]) {
        await harness.asSuperuser();
        await harness.client.exec(`CREATE ROLE ${platformOwner} NOLOGIN`);
        await harness.client.exec(
          `CREATE DATABASE ${platform} OWNER ${platformOwner}`,
        );
        bridge.databases.set(
          platform,
          new PGlite({ loadDataDir: platformDataDir, database: platform }),
        );
        bridge.inspected = [];
        bridge.failing = failing;
        try {
          const outcome = await report();
          if (failing === null) {
            expect(outcome).toEqual(cases[0].expected);
            expect(bridge.inspected).toEqual([
              "BEGIN TRANSACTION READ ONLY",
              setPath,
              setTimeout,
              expect.stringMatching(/^SELECT current_user::text = \$1 /),
              "ROLLBACK",
            ]);
          } else {
            expect(outcome, failing).toEqual(cases.at(-1)!.expected);
            expect(bridge.inspected, failing).toContain("ROLLBACK");
            expect(bridge.inspected.join("\n"), failing).not.toContain(
              "SELECT current_user",
            );
          }
        } finally {
          bridge.failing = null;
          await bridge.databases.get(platform)?.close();
          bridge.databases.delete(platform);
          await harness.asSuperuser();
          await harness.client.exec(`DROP DATABASE ${platform}`);
          await harness.client.exec(`DROP ROLE ${platformOwner}`);
          await rerunTemplate();
        }
      }
    });
  });
});
