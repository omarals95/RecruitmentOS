import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db";
import { runtimeRoleSafetyQuery } from "../src/db/runtime-role";

// The runtime role template closes the database and the public schema to PUBLIC.
const closedToPublic = `
  REVOKE ALL ON SCHEMA public FROM PUBLIC;
  DO $$ BEGIN EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()); END $$;
`;

describe("database runtime role safety", () => {
  it("rejects direct, inherited and PUBLIC execution of server-file helpers", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await pg.exec(`
        ${closedToPublic}
        CREATE ROLE file_safe NOLOGIN;
        CREATE ROLE file_direct NOLOGIN;
        CREATE ROLE file_parent NOLOGIN;
        CREATE ROLE file_child NOLOGIN NOINHERIT;
        CREATE ROLE file_directory NOLOGIN;
        CREATE ROLE file_public NOLOGIN;
        GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO file_direct;
        GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_binary_file(text,bigint,bigint) TO file_parent;
        GRANT file_parent TO file_child;
        GRANT EXECUTE ON FUNCTION pg_catalog.pg_ls_dir(text) TO file_directory;
      `);
      async function unsafe(role: string): Promise<boolean> {
        await pg.exec(`SET ROLE ${role}`);
        const result = await pg.query<{ unsafe: boolean }>(
          runtimeRoleSafetyQuery,
        );
        await pg.exec("RESET ROLE");
        return result.rows[0]?.unsafe ?? true;
      }
      expect(await unsafe("file_safe")).toBe(false);
      for (const role of ["file_direct", "file_child", "file_directory"])
        expect(await unsafe(role), role).toBe(true);
      await pg.exec(
        "GRANT EXECUTE ON FUNCTION pg_catalog.lo_import(text) TO PUBLIC",
      );
      expect(await unsafe("file_public")).toBe(true);
    } finally {
      await pg.close();
    }
  });
  it("rejects direct and inherited privileged roles, schema owners, and create privileges", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await pg.exec(`
        ${closedToPublic}
        CREATE ROLE guarded_safe NOLOGIN;
        CREATE ROLE guarded_creator NOLOGIN CREATEROLE;
        CREATE ROLE guarded_createdb NOLOGIN CREATEDB;
        CREATE ROLE guarded_replicator NOLOGIN REPLICATION;
        CREATE ROLE guarded_inherited NOLOGIN NOINHERIT;
        GRANT guarded_creator TO guarded_inherited;
        CREATE ROLE guarded_reader NOLOGIN;
        GRANT pg_read_all_data TO guarded_reader;
        CREATE ROLE guarded_writer NOLOGIN;
        GRANT pg_write_all_data TO guarded_writer;
        CREATE ROLE neon_superuser NOLOGIN;
        CREATE ROLE guarded_neon NOLOGIN NOINHERIT;
        GRANT neon_superuser TO guarded_neon;
        CREATE ROLE guarded_object_owner NOLOGIN;
        CREATE TABLE auth.runtime_guard_probe (id integer);
        ALTER TABLE auth.runtime_guard_probe OWNER TO guarded_object_owner;
        CREATE ROLE guarded_function_owner NOLOGIN;
        CREATE FUNCTION auth.runtime_guard_probe() RETURNS integer LANGUAGE SQL AS 'SELECT 1';
        ALTER FUNCTION auth.runtime_guard_probe() OWNER TO guarded_function_owner;
        CREATE ROLE guarded_schema_create NOLOGIN;
        GRANT CREATE ON SCHEMA auth TO guarded_schema_create;
        CREATE ROLE guarded_schema_owner NOLOGIN;
        ALTER SCHEMA auth OWNER TO guarded_schema_owner;
        CREATE ROLE guarded_database_create NOLOGIN;
      `);
      const name = await pg.query<{ name: string }>(
        "SELECT current_database() AS name",
      );
      const quoted = '"' + name.rows[0].name.replaceAll('"', '""') + '"';
      await pg.exec(
        `GRANT CREATE ON DATABASE ${quoted} TO guarded_database_create`,
      );
      async function unsafe(role: string): Promise<boolean> {
        await pg.exec(`SET ROLE ${role}`);
        const result = await pg.query<{ unsafe: boolean }>(
          runtimeRoleSafetyQuery,
        );
        await pg.exec("RESET ROLE");
        return result.rows[0]?.unsafe ?? true;
      }
      expect(await unsafe("guarded_safe")).toBe(false);
      for (const role of [
        "guarded_creator",
        "guarded_createdb",
        "guarded_replicator",
        "guarded_inherited",
        "guarded_reader",
        "guarded_writer",
        "guarded_neon",
        "guarded_object_owner",
        "guarded_function_owner",
        "guarded_schema_create",
        "guarded_schema_owner",
        "guarded_database_create",
      ])
        expect(await unsafe(role), role).toBe(true);
    } finally {
      await pg.close();
    }
  });

  it("rejects direct, SET ROLE, column-only and PUBLIC access to the setup marker", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await pg.exec(`
        ${closedToPublic}
        CREATE ROLE guard_direct NOLOGIN;
        GRANT DELETE ON auth.initial_admin_claim TO guard_direct;
        CREATE ROLE guard_update NOLOGIN;
        GRANT UPDATE ON auth.initial_admin_claim TO guard_update;
        CREATE ROLE guard_parent NOLOGIN;
        GRANT INSERT ON auth.initial_admin_claim TO guard_parent;
        CREATE ROLE guard_child NOLOGIN NOINHERIT;
        GRANT guard_parent TO guard_child;
        CREATE ROLE guard_column NOLOGIN;
        GRANT UPDATE(completed_at) ON auth.initial_admin_claim TO guard_column;
        CREATE ROLE guard_public NOLOGIN;
      `);
      async function unsafe(role: string): Promise<boolean> {
        await pg.exec(`SET ROLE ${role}`);
        const result = await pg.query<{ unsafe: boolean }>(
          runtimeRoleSafetyQuery,
        );
        await pg.exec("RESET ROLE");
        return result.rows[0]?.unsafe ?? true;
      }
      expect(await unsafe("guard_public")).toBe(false);
      for (const role of [
        "guard_direct",
        "guard_update",
        "guard_child",
        "guard_column",
      ])
        expect(await unsafe(role), role).toBe(true);
      await pg.exec(
        "GRANT UPDATE(user_id) ON auth.initial_admin_claim TO PUBLIC",
      );
      expect(await unsafe("guard_public")).toBe(true);
    } finally {
      await pg.close();
    }
  });

  it("fails closed when the marker table or schema is missing", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(
        "CREATE ROLE guard_unmigrated NOLOGIN; SET ROLE guard_unmigrated",
      );
      const result = await pg.query<{ unsafe: boolean }>(
        runtimeRoleSafetyQuery,
      );
      expect(result.rows[0]?.unsafe).toBe(true);
    } finally {
      await pg.close();
    }
  });

  it("fails closed when the app schema is missing even if the auth marker exists", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`
        CREATE SCHEMA auth;
        CREATE TABLE auth.initial_admin_claim (id boolean PRIMARY KEY);
        CREATE ROLE guard_missing_app NOLOGIN;
        SET ROLE guard_missing_app;
      `);
      const result = await pg.query<{ unsafe: boolean }>(
        runtimeRoleSafetyQuery,
      );
      expect(result.rows[0]?.unsafe).toBe(true);
    } finally {
      await pg.close();
    }
  });

  it("rejects owners, CREATE holders and object owners in the tenant_context, db_boundary and storage_ledger schemas", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await pg.exec(`${closedToPublic} CREATE ROLE schema_guard_safe NOLOGIN`);
      const unsafeRoles: string[] = [];
      for (const schema of [
        "tenant_context",
        "db_boundary",
        "storage_ledger",
      ]) {
        const role = (kind: string) => `${schema}_${kind}`;
        await pg.exec(`
          CREATE ROLE ${role("owner")} NOLOGIN;
          CREATE ROLE ${role("create")} NOLOGIN;
          GRANT CREATE ON SCHEMA ${schema} TO ${role("create")};
          CREATE ROLE ${role("parent")} NOLOGIN;
          GRANT CREATE ON SCHEMA ${schema} TO ${role("parent")};
          CREATE ROLE ${role("child")} NOLOGIN NOINHERIT;
          GRANT ${role("parent")} TO ${role("child")};
          CREATE ROLE ${role("relation")} NOLOGIN;
          CREATE TABLE ${schema}.runtime_guard_probe (id integer);
          ALTER TABLE ${schema}.runtime_guard_probe OWNER TO ${role("relation")};
          CREATE ROLE ${role("function")} NOLOGIN;
          CREATE FUNCTION ${schema}.runtime_guard_probe() RETURNS integer LANGUAGE SQL AS 'SELECT 1';
          ALTER FUNCTION ${schema}.runtime_guard_probe() OWNER TO ${role("function")};
          ALTER SCHEMA ${schema} OWNER TO ${role("owner")};
        `);
        unsafeRoles.push(
          ...["owner", "create", "child", "relation", "function"].map(role),
        );
      }
      async function unsafe(role: string): Promise<boolean> {
        await pg.exec(`SET ROLE ${role}`);
        const result = await pg.query<{ unsafe: boolean }>(
          runtimeRoleSafetyQuery,
        );
        await pg.exec("RESET ROLE");
        return result.rows[0]?.unsafe ?? true;
      }
      expect(await unsafe("schema_guard_safe")).toBe(false);
      for (const role of unsafeRoles)
        expect(await unsafe(role), role).toBe(true);
      await pg.exec("GRANT CREATE ON SCHEMA db_boundary TO PUBLIC");
      expect(await unsafe("schema_guard_safe")).toBe(true);
    } finally {
      await pg.close();
    }
  });

  it("fails closed when any one of the tenant_context, db_boundary or storage_ledger schemas is missing", async () => {
    const schemas = ["app", "tenant_context", "db_boundary", "storage_ledger"];
    for (const missing of [null, ...schemas.slice(1)]) {
      const pg = new PGlite();
      try {
        await pg.exec(`
          CREATE SCHEMA auth;
          CREATE TABLE auth.initial_admin_claim (id boolean PRIMARY KEY);
          ${schemas
            .filter((schema) => schema !== missing)
            .map((schema) => `CREATE SCHEMA ${schema};`)
            .join(" ")}
          ${closedToPublic}
          CREATE ROLE guard_missing_schema NOLOGIN;
          SET ROLE guard_missing_schema;
        `);
        const result = await pg.query<{ unsafe: boolean }>(
          runtimeRoleSafetyQuery,
        );
        expect(result.rows[0]?.unsafe, String(missing)).toBe(missing !== null);
      } finally {
        await pg.close();
      }
    }
  });

  it("rejects PUBLIC CONNECT, and database TEMPORARY or public schema access held directly, through a member role or by PUBLIC", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      const name = await pg.query<{ name: string }>(
        "SELECT current_database() AS name",
      );
      const database = '"' + name.rows[0].name.replaceAll('"', '""') + '"';
      await pg.exec(`
        ${closedToPublic}
        CREATE ROLE public_guard_safe NOLOGIN;
        CREATE ROLE public_guard_temporary NOLOGIN;
        GRANT TEMPORARY ON DATABASE ${database} TO public_guard_temporary;
        CREATE ROLE public_guard_temporary_parent NOLOGIN;
        GRANT TEMPORARY ON DATABASE ${database} TO public_guard_temporary_parent;
        CREATE ROLE public_guard_temporary_child NOLOGIN NOINHERIT;
        GRANT public_guard_temporary_parent TO public_guard_temporary_child;
        CREATE ROLE public_guard_usage NOLOGIN;
        GRANT USAGE ON SCHEMA public TO public_guard_usage;
        CREATE ROLE public_guard_create NOLOGIN;
        GRANT CREATE ON SCHEMA public TO public_guard_create;
        CREATE ROLE public_guard_schema_parent NOLOGIN;
        GRANT USAGE ON SCHEMA public TO public_guard_schema_parent;
        CREATE ROLE public_guard_schema_child NOLOGIN NOINHERIT;
        GRANT public_guard_schema_parent TO public_guard_schema_child;
      `);
      async function unsafe(role: string): Promise<boolean> {
        await pg.exec(`SET ROLE ${role}`);
        const result = await pg.query<{ unsafe: boolean }>(
          runtimeRoleSafetyQuery,
        );
        await pg.exec("RESET ROLE");
        return result.rows[0]?.unsafe ?? true;
      }
      expect(await unsafe("public_guard_safe")).toBe(false);
      for (const role of [
        "public_guard_temporary",
        "public_guard_temporary_child",
        "public_guard_usage",
        "public_guard_create",
        "public_guard_schema_child",
      ])
        expect(await unsafe(role), role).toBe(true);
      for (const [grant, revoke] of [
        [
          `GRANT CONNECT ON DATABASE ${database} TO PUBLIC`,
          `REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`,
        ],
        [
          `GRANT TEMPORARY ON DATABASE ${database} TO PUBLIC`,
          `REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC`,
        ],
        [
          "GRANT USAGE ON SCHEMA public TO PUBLIC",
          "REVOKE USAGE ON SCHEMA public FROM PUBLIC",
        ],
      ]) {
        await pg.exec(grant);
        expect(await unsafe("public_guard_safe"), grant).toBe(true);
        await pg.exec(revoke);
        expect(await unsafe("public_guard_safe"), revoke).toBe(false);
      }
    } finally {
      await pg.close();
    }
  });

  it("rejects the owner of the current database and a NOINHERIT member of it, even with its database privileges revoked", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      const name = await pg.query<{ name: string }>(
        "SELECT current_database() AS name",
      );
      const database = '"' + name.rows[0].name.replaceAll('"', '""') + '"';
      await pg.exec(`
        ${closedToPublic}
        CREATE ROLE database_owner_probe NOLOGIN;
        CREATE ROLE database_owner_member NOLOGIN NOINHERIT;
        GRANT database_owner_probe TO database_owner_member;
        CREATE ROLE database_owner_unrelated NOLOGIN;
        ALTER DATABASE ${database} OWNER TO database_owner_probe;
        -- Without pg_database_owner on the public schema, only the owner clause catches this role.
        ALTER SCHEMA public OWNER TO CURRENT_USER;
        SET ROLE database_owner_probe;
        REVOKE ALL ON DATABASE ${database} FROM database_owner_probe;
        RESET ROLE;
      `);
      async function unsafe(role: string): Promise<boolean> {
        await pg.exec(`SET ROLE ${role}`);
        const result = await pg.query<{ unsafe: boolean }>(
          runtimeRoleSafetyQuery,
        );
        await pg.exec("RESET ROLE");
        return result.rows[0]?.unsafe ?? true;
      }
      const privileges = await pg.query<{ create: boolean; temp: boolean }>(
        `SELECT has_database_privilege('database_owner_probe', current_database(), 'CREATE') AS create,
          has_database_privilege('database_owner_probe', current_database(), 'TEMPORARY') AS temp`,
      );
      expect(privileges.rows).toEqual([{ create: false, temp: false }]);
      expect(await unsafe("database_owner_unrelated")).toBe(false);
      for (const role of ["database_owner_probe", "database_owner_member"])
        expect(await unsafe(role), role).toBe(true);
    } finally {
      await pg.close();
    }
  });

  it("rejects any table, column, sequence, function, schema or database privilege held WITH GRANT OPTION, directly or through a member role", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      const name = await pg.query<{ name: string }>(
        "SELECT current_database() AS name",
      );
      const database = '"' + name.rows[0].name.replaceAll('"', '""') + '"';
      await pg.exec(`
        ${closedToPublic}
        CREATE SEQUENCE app.grant_option_probe;
        CREATE ROLE grant_option_plain NOLOGIN;
        GRANT SELECT ON app.records TO grant_option_plain;
        GRANT SELECT (id) ON app.activity TO grant_option_plain;
        GRANT USAGE ON SEQUENCE app.grant_option_probe TO grant_option_plain;
        GRANT EXECUTE ON FUNCTION tenant_context.install(text,text) TO grant_option_plain;
        GRANT USAGE ON SCHEMA app TO grant_option_plain;
        GRANT CONNECT ON DATABASE ${database} TO grant_option_plain;
        CREATE ROLE grant_option_table NOLOGIN;
        GRANT SELECT ON app.records TO grant_option_table WITH GRANT OPTION;
        CREATE ROLE grant_option_column NOLOGIN;
        GRANT SELECT (id) ON app.activity TO grant_option_column WITH GRANT OPTION;
        CREATE ROLE grant_option_sequence NOLOGIN;
        GRANT USAGE ON SEQUENCE app.grant_option_probe TO grant_option_sequence WITH GRANT OPTION;
        CREATE ROLE grant_option_function NOLOGIN;
        GRANT EXECUTE ON FUNCTION tenant_context.install(text,text) TO grant_option_function WITH GRANT OPTION;
        CREATE ROLE grant_option_schema NOLOGIN;
        GRANT USAGE ON SCHEMA app TO grant_option_schema WITH GRANT OPTION;
        CREATE ROLE grant_option_database NOLOGIN;
        GRANT CONNECT ON DATABASE ${database} TO grant_option_database WITH GRANT OPTION;
        CREATE ROLE grant_option_parent NOLOGIN;
        GRANT SELECT ON app.records TO grant_option_parent WITH GRANT OPTION;
        CREATE ROLE grant_option_child NOLOGIN NOINHERIT;
        GRANT grant_option_parent TO grant_option_child;
      `);
      async function unsafe(role: string): Promise<boolean> {
        await pg.exec(`SET ROLE ${role}`);
        const result = await pg.query<{ unsafe: boolean }>(
          runtimeRoleSafetyQuery,
        );
        await pg.exec("RESET ROLE");
        return result.rows[0]?.unsafe ?? true;
      }
      expect(await unsafe("grant_option_plain")).toBe(false);
      for (const role of [
        "grant_option_table",
        "grant_option_column",
        "grant_option_sequence",
        "grant_option_function",
        "grant_option_schema",
        "grant_option_database",
        "grant_option_child",
      ])
        expect(await unsafe(role), role).toBe(true);
    } finally {
      await pg.close();
    }
  });
});
