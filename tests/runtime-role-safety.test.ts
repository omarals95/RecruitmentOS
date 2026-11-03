import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db";
import { runtimeRoleSafetyQuery } from "../src/db/runtime-role";

describe("database runtime role safety", () => {
  it("rejects direct, inherited and PUBLIC execution of server-file helpers", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await pg.exec(`
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
});
