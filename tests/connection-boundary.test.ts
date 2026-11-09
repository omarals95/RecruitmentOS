import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../src/db";
import {
  dataRoleBoundaryQuery,
  dataRoleHelpers,
  identityRoleBoundaryQuery,
  identityRoleHelpers,
  markerRoleBoundaryQuery,
  isLoopbackHost,
  prepareConnectionTargets,
  verifyConnectionTargets,
  verifyPoolPair,
} from "../src/db/connection-boundary";
import { createSplitRoleDb, splitRoles } from "./helpers/db";

describe("database identity separation", () => {
  it("recognizes parsed IPv6 and IPv4 loopback hosts without trusting lookalike hosts", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      new URL("postgresql://u:p@[::1]/db").hostname,
    ])
      expect(isLoopbackHost(host), host).toBe(true);
    for (const host of [
      "localhost.example.test",
      "127.0.0.2",
      "[::2]",
      "::1.example.test",
    ])
      expect(isLoopbackHost(host), host).toBe(false);
  });
  it("rejects data roles able to access identity tables through direct, inherited, column or public grants", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await pg.exec(`CREATE ROLE boundary_safe NOLOGIN;
        CREATE ROLE boundary_schema NOLOGIN; GRANT USAGE ON SCHEMA auth TO boundary_schema;
        CREATE ROLE boundary_write NOLOGIN; GRANT UPDATE ON auth.api_tokens TO boundary_write;
        CREATE ROLE boundary_column NOLOGIN; GRANT SELECT(token) ON auth.session TO boundary_column;
        CREATE ROLE boundary_parent NOLOGIN; GRANT INSERT ON auth.member TO boundary_parent;
        CREATE ROLE boundary_child NOLOGIN NOINHERIT; GRANT boundary_parent TO boundary_child;
        CREATE ROLE boundary_public NOLOGIN;`);
      async function unsafe(role: string) {
        await pg.exec(`SET ROLE ${role}`);
        const result = await pg.query<{ unsafe: boolean }>(
          dataRoleBoundaryQuery,
        );
        await pg.exec("RESET ROLE");
        return result.rows[0].unsafe;
      }
      expect(await unsafe("boundary_safe")).toBe(false);
      for (const role of [
        "boundary_schema",
        "boundary_write",
        "boundary_column",
        "boundary_child",
      ])
        expect(await unsafe(role), role).toBe(true);
      await pg.exec("GRANT SELECT(password) ON auth.account TO PUBLIC");
      expect(await unsafe("boundary_public")).toBe(true);
    } finally {
      await pg.close();
    }
  });

  it("rejects identity roles with direct, inherited, column or public access to recruitment tables", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await pg.exec(`CREATE ROLE identity_safe NOLOGIN;
        CREATE ROLE identity_read NOLOGIN; GRANT SELECT ON app.records TO identity_read;
        CREATE ROLE identity_column NOLOGIN; GRANT SELECT(data) ON app.records TO identity_column;
        CREATE ROLE identity_parent NOLOGIN; GRANT INSERT ON app.activity TO identity_parent;
        CREATE ROLE identity_child NOLOGIN NOINHERIT; GRANT identity_parent TO identity_child;
        CREATE ROLE identity_public NOLOGIN;`);
      async function unsafe(role: string) {
        await pg.exec(`SET ROLE ${role}`);
        const result = await pg.query<{ unsafe: boolean }>(
          identityRoleBoundaryQuery,
        );
        await pg.exec("RESET ROLE");
        return result.rows[0].unsafe;
      }
      expect(await unsafe("identity_safe")).toBe(false);
      for (const role of ["identity_read", "identity_column", "identity_child"])
        expect(await unsafe(role), role).toBe(true);
      await pg.exec("GRANT SELECT ON app.uploads TO PUBLIC");
      expect(await unsafe("identity_public")).toBe(true);
    } finally {
      await pg.close();
    }
  });

  it("rejects indirectly accessible definer functions and owner-privileged views", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await pg.exec(`CREATE SCHEMA unsafe_helper;
        CREATE ROLE helper_function NOLOGIN;
        CREATE ROLE helper_view NOLOGIN;
        CREATE ROLE helper_foreign NOLOGIN;
        GRANT USAGE ON SCHEMA unsafe_helper TO helper_function,helper_view,helper_foreign;
        CREATE FUNCTION unsafe_helper.read_secret() RETURNS text LANGUAGE SQL SECURITY DEFINER AS $$ SELECT token FROM auth.session LIMIT 1 $$;
        REVOKE EXECUTE ON FUNCTION unsafe_helper.read_secret() FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION unsafe_helper.read_secret() TO helper_function;
        CREATE VIEW unsafe_helper.read_records AS SELECT data FROM app.records;
        GRANT SELECT ON unsafe_helper.read_records TO helper_view;
        CREATE FOREIGN DATA WRAPPER boundary_fdw;
        CREATE SERVER boundary_server FOREIGN DATA WRAPPER boundary_fdw;
        CREATE FOREIGN TABLE unsafe_helper.remote_records(id text) SERVER boundary_server;
        GRANT SELECT ON unsafe_helper.remote_records TO helper_foreign;`);
      for (const [role, query] of [
        ["helper_function", dataRoleBoundaryQuery],
        ["helper_view", identityRoleBoundaryQuery],
        ["helper_foreign", identityRoleBoundaryQuery],
      ] as const) {
        await pg.exec(`SET ROLE ${role}`);
        const result = await pg.query<{ unsafe: boolean }>(query);
        expect(result.rows[0].unsafe, role).toBe(true);
        await pg.exec("RESET ROLE");
      }
      await pg.exec(`CREATE ROLE helper_identity NOLOGIN;
        GRANT USAGE ON SCHEMA auth TO helper_identity;
        GRANT EXECUTE ON FUNCTION auth.complete_initial_admin() TO helper_identity;
        SET ROLE helper_identity;`);
      expect(
        (await pg.query<{ unsafe: boolean }>(identityRoleBoundaryQuery)).rows[0]
          .unsafe,
      ).toBe(true);
      await pg.exec("RESET ROLE");
    } finally {
      await pg.close();
    }
  });

  it("allows only the exact tenant-context helpers each split role needs", async () => {
    const harness = await createSplitRoleDb();
    try {
      async function unsafe(role: "data" | "identity") {
        await harness[role === "data" ? "dataDb" : "identityDb"]();
        const result = await harness.client.query<{ unsafe: boolean }>(
          role === "data" ? dataRoleBoundaryQuery : identityRoleBoundaryQuery,
        );
        return result.rows[0].unsafe;
      }
      expect(await unsafe("data")).toBe(false);
      expect(await unsafe("identity")).toBe(false);
      // One install overload, three arguments, allowlisted for both roles (0029).
      for (const helpers of [dataRoleHelpers, identityRoleHelpers])
        expect(
          helpers.filter((helper) =>
            helper.startsWith("tenant_context.install("),
          ),
        ).toEqual(["tenant_context.install(text,text,text[])"]);
      await harness.asSuperuser();
      expect(
        (
          await harness.client.query<{ args: string }>(
            "SELECT pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'tenant_context' AND p.proname = 'install'",
          )
        ).rows,
      ).toEqual([{ args: "payload text, signature text, cached text[]" }]);
      // A multi-word type is matched in catalog spelling (0030): the granted history helper passes,
      // a same-name overload with another argument type does not.
      expect(dataRoleHelpers).toContain(
        "tenant_context.config_history(uuid,timestamp with time zone,integer)",
      );
      expect(
        (
          await harness.client.query<{ args: string }>(
            "SELECT pg_catalog.oidvectortypes(p.proargtypes) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'tenant_context' AND p.proname = 'config_history'",
          )
        ).rows,
      ).toEqual([{ args: "uuid, timestamp with time zone, integer" }]);
      await harness.asOwner();
      await harness.client.exec(`
        CREATE FUNCTION tenant_context.config_history(uuid, timestamp without time zone, integer) RETURNS text
          LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 'extra' $$;
        REVOKE ALL ON FUNCTION tenant_context.config_history(uuid, timestamp without time zone, integer) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION tenant_context.config_history(uuid, timestamp without time zone, integer) TO ${splitRoles.data};`);
      expect(await unsafe("data")).toBe(true);
      await harness.asOwner();
      await harness.client.exec(
        "DROP FUNCTION tenant_context.config_history(uuid, timestamp without time zone, integer)",
      );
      expect(await unsafe("data")).toBe(false);
      await harness.asOwner();
      await harness.client.exec(`
        CREATE FUNCTION tenant_context.extra_helper() RETURNS text LANGUAGE sql
          SECURITY DEFINER SET search_path = pg_catalog AS $$ SELECT 'extra' $$;
        REVOKE ALL ON FUNCTION tenant_context.extra_helper() FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION tenant_context.extra_helper() TO ${splitRoles.data};`);
      expect(await unsafe("data")).toBe(true);
      await harness.asOwner();
      await harness.client.exec("DROP FUNCTION tenant_context.extra_helper()");
      expect(await unsafe("data")).toBe(false);
      await harness.asOwner();
      await harness.client.exec(
        `GRANT EXECUTE ON FUNCTION tenant_context.audit_token(text,text) TO ${splitRoles.data}`,
      );
      expect(await unsafe("data")).toBe(true);
      await harness.asOwner();
      await harness.client.exec(
        `REVOKE EXECUTE ON FUNCTION tenant_context.audit_token(text,text) FROM ${splitRoles.data};
        GRANT EXECUTE ON FUNCTION tenant_context.audit_grant_reuse(text,text) TO ${splitRoles.data}`,
      );
      expect(await unsafe("data")).toBe(true);
      await harness.asOwner();
      await harness.client.exec(
        `REVOKE EXECUTE ON FUNCTION tenant_context.audit_grant_reuse(text,text) FROM ${splitRoles.data};
        GRANT EXECUTE ON FUNCTION tenant_context.allows(text,text,text) TO ${splitRoles.identity}`,
      );
      expect(await unsafe("data")).toBe(false);
      expect(await unsafe("identity")).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("allows the data role the five record-scope helpers, with and without arguments, and never the identity role (0038)", async () => {
    const helpers = [
      "tenant_context.scope_is_all()",
      "tenant_context.in_scope(text,text,uuid,uuid,uuid,uuid,uuid,text,uuid,uuid)",
      "tenant_context.record_in_scope(text,uuid)",
      "tenant_context.candidate_in_scope(text,uuid)",
      "tenant_context.context_actor_key()",
    ];
    expect(dataRoleHelpers.slice(-5)).toEqual(helpers);
    for (const helper of helpers)
      expect(identityRoleHelpers).not.toContain(helper);
    const harness = await createSplitRoleDb();
    try {
      const unsafe = async (role: "data" | "identity") => {
        await harness[role === "data" ? "dataDb" : "identityDb"]();
        return (
          await harness.client.query<{ unsafe: boolean }>(
            role === "data" ? dataRoleBoundaryQuery : identityRoleBoundaryQuery,
          )
        ).rows[0].unsafe;
      };
      expect(await unsafe("data")).toBe(false);
      for (const helper of [
        "scope_is_all()",
        "in_scope(text,text,uuid,uuid,uuid,uuid,uuid,text,uuid,uuid)",
      ]) {
        await harness.asOwner();
        await harness.client.exec(
          `GRANT EXECUTE ON FUNCTION tenant_context.${helper} TO ${splitRoles.identity}`,
        );
        expect(await unsafe("identity"), helper).toBe(true);
        await harness.asOwner();
        await harness.client.exec(
          `REVOKE EXECUTE ON FUNCTION tenant_context.${helper} FROM ${splitRoles.identity}`,
        );
        expect(await unsafe("identity"), helper).toBe(false);
      }
    } finally {
      await harness.close();
    }
  });

  it("requires both connections to the same explicit database endpoint without query overrides", () => {
    const data =
      "postgresql://data:fake@example.test:5432/neondb?sslmode=require";
    const identity =
      "postgresql://identity:fake@example.test:5432/neondb?sslmode=require";
    expect(() => verifyConnectionTargets(data, identity)).not.toThrow();
    for (const bad of [
      "postgresql://identity:fake@other.test:5432/neondb",
      "postgresql://identity:fake@example.test:5432/other",
      "postgresql://identity:fake@example.test:5432/neondb?host=other.test",
      "postgresql://identity:fake@example.test:5432/neondb?dbname=other",
      "postgresql://identity:fake@example.test:5432/neondb?user=other",
      "postgresql://identity:fake@example.test:5432/neondb?service=other",
    ])
      expect(() => verifyConnectionTargets(data, bad), bad).toThrow();
  });

  it("allows verified TLS modes but rejects file and unsupported binding overrides", () => {
    const data =
      "postgresql://data:fake@example.test:5432/neondb?sslmode=require";
    const identity =
      "postgresql://identity:fake@example.test:5432/neondb?sslmode=verify-full";
    expect(() => verifyConnectionTargets(data, identity)).not.toThrow();
    for (const query of [
      "sslcert=NONEXISTENT",
      "sslkey=NONEXISTENT",
      "sslrootcert=NONEXISTENT",
      "SSLROOTCERT=NONEXISTENT",
      "ssl=false",
      "sslmode=no-verify",
      "sslmode=disable",
      "sslmode=require&sslmode=disable",
      "channel_binding=require",
      "channel_binding=disable",
      "application_name=custom",
    ]) {
      const bad = `postgresql://identity:fake@example.test:5432/neondb?${query}`;
      expect(() => verifyConnectionTargets(data, bad), query).toThrow();
      expect(() => verifyConnectionTargets(bad, identity), query).toThrow();
    }
  });

  it("rejects matching encoded socket hosts rather than treating them as network endpoints", () => {
    for (const host of ["%2Ftmp", "%2ftmp"]) {
      const data = `postgresql://data:fake@${host}:5432/neondb?sslmode=require`;
      const identity = `postgresql://identity:fake@${host}:5432/neondb?sslmode=require`;
      expect(() => verifyConnectionTargets(data, identity), host).toThrow();
    }
  });

  it("eliminates PGPORT fallback and rejects startup options for both connections", () => {
    const data = "postgresql://data:fake@example.test/neondb?sslmode=require";
    const identity =
      "postgresql://identity:fake@example.test:5432/neondb?sslmode=require";
    vi.stubEnv("PGPORT", "6543");
    try {
      const targets = prepareConnectionTargets(data, identity, {});
      const actualPort = (connectionString: string) =>
        (
          new Client({ connectionString }) as unknown as {
            connectionParameters: { port: number };
          }
        ).connectionParameters.port;
      expect(actualPort(targets.dataUrl)).toBe(5432);
      expect(actualPort(targets.identityUrl)).toBe(5432);
      expect(() =>
        prepareConnectionTargets(data, identity, {
          PGOPTIONS: "-c role=other",
        }),
      ).toThrow();
      expect(() =>
        prepareConnectionTargets(data, identity, {
          PGOPTIONS: "-c search_path=other",
        }),
      ).toThrow();
      expect(() =>
        prepareConnectionTargets(data, identity, { PGOPTIONS: "" }),
      ).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("creates an owner-controlled singleton database marker without public access", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      const present = await pg.query<{ present: boolean }>(
        "SELECT to_regclass('db_boundary.connection_marker') IS NOT NULL AS present",
      );
      expect(present.rows[0].present).toBe(true);
      const marker = await pg.query<{ id: string }>(
        "SELECT id::text FROM db_boundary.connection_marker",
      );
      expect(marker.rows).toHaveLength(1);
      expect(marker.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
      await pg.exec(
        "CREATE ROLE marker_reader NOLOGIN; GRANT USAGE ON SCHEMA db_boundary TO marker_reader; GRANT SELECT ON db_boundary.connection_marker TO marker_reader; SET ROLE marker_reader",
      );
      const fromReader = await pg.query<{ id: string }>(
        "SELECT id::text FROM db_boundary.connection_marker",
      );
      expect(fromReader.rows[0].id).toBe(marker.rows[0].id);
      await expect(
        pg.exec(
          "UPDATE db_boundary.connection_marker SET id=gen_random_uuid()",
        ),
      ).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });

  it("rejects marker writers, owners, inherited grants and missing read access", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await pg.exec(`CREATE ROLE marker_safe NOLOGIN;
        CREATE ROLE marker_writer NOLOGIN;
        CREATE ROLE marker_column NOLOGIN;
        CREATE ROLE marker_parent NOLOGIN;
        CREATE ROLE marker_child NOLOGIN NOINHERIT;
        CREATE ROLE marker_no_read NOLOGIN;
        GRANT USAGE ON SCHEMA db_boundary TO marker_safe,marker_writer,marker_column,marker_child;
        GRANT SELECT ON db_boundary.connection_marker TO marker_safe,marker_writer,marker_column,marker_child;
        GRANT UPDATE ON db_boundary.connection_marker TO marker_writer;
        GRANT UPDATE(id) ON db_boundary.connection_marker TO marker_column;
        GRANT INSERT ON db_boundary.connection_marker TO marker_parent;
        GRANT marker_parent TO marker_child;`);
      async function unsafe(role: string) {
        await pg.exec(`SET ROLE ${role}`);
        const result = await pg.query<{ unsafe: boolean }>(
          markerRoleBoundaryQuery,
        );
        await pg.exec("RESET ROLE");
        return result.rows[0].unsafe;
      }
      expect(await unsafe("marker_safe")).toBe(false);
      for (const role of [
        "marker_writer",
        "marker_column",
        "marker_child",
        "marker_no_read",
      ])
        expect(await unsafe(role), role).toBe(true);
      await pg.exec("GRANT CREATE ON SCHEMA db_boundary TO marker_safe");
      expect(await unsafe("marker_safe")).toBe(true);
      await pg.exec(
        "CREATE ROLE marker_owner NOLOGIN; ALTER TABLE db_boundary.connection_marker OWNER TO marker_owner; GRANT USAGE ON SCHEMA db_boundary TO marker_owner",
      );
      expect(await unsafe("marker_owner")).toBe(true);
    } finally {
      await pg.close();
    }
  });

  it("rejects pools that are identical, cross-assumable or backed by different database markers", () => {
    const data = {
      role: "data",
      sessionRole: "data",
      database: "neondb",
      marker: "12345678-1234-4123-8123-123456789abc",
      canAssumeOther: false,
    };
    const identity = { ...data, role: "identity", sessionRole: "identity" };
    expect(() => verifyPoolPair(data, identity)).not.toThrow();
    for (const invalid of [
      { ...identity, role: "data" },
      { ...identity, database: "other" },
      { ...identity, marker: "12345678-1234-4123-8123-123456789abd" },
      { ...identity, marker: "" },
      { ...identity, canAssumeOther: true },
      { ...identity, sessionRole: "elevated_login" },
      { ...identity, sessionRole: "" },
    ])
      expect(() => verifyPoolPair(data, invalid)).toThrow();
    expect(() =>
      verifyPoolPair({ ...data, canAssumeOther: true }, identity),
    ).toThrow();
    expect(() =>
      verifyPoolPair({ ...data, sessionRole: "elevated_login" }, identity),
    ).toThrow();
  });
});
