import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { describe, expect, it } from "vitest";

async function setup() {
  const pg = new PGlite({ extensions: { pgcrypto } });
  await pg.exec("CREATE EXTENSION pgcrypto");
  await pg.exec(
    await readFile("tests/fixtures/tenant-context-proof.sql", "utf8"),
  );
  await pg.exec(
    await readFile("tests/fixtures/activity-name-proof.sql", "utf8"),
  );
  await pg.exec("SET ROLE tenant_proof_runtime; BEGIN");
  return pg;
}

async function install(
  pg: PGlite,
  options: {
    team?: string;
    actor?: string;
    read?: boolean;
    candidates?: boolean;
    expiresAt?: number;
  } = {},
) {
  const info = (
    await pg.query<{ pid: number; xid: string }>(
      "SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid",
    )
  ).rows[0];
  const claim = JSON.stringify({
    aud: "synthetic-activity",
    ...info,
    team: options.team ?? "team-a",
    actor: options.actor ?? "actor-a",
    read: options.read ?? true,
    candidates: options.candidates ?? false,
    exp: options.expiresAt ?? Date.now() + 30000,
  });
  const signature = createHmac("sha256", "test-key-for-synthetic-proof-only")
    .update(claim)
    .digest("hex");
  await pg.query("SELECT tenant_proof.install_activity($1,$2)", [
    claim,
    signature,
  ]);
}

async function lookup(pg: PGlite, id: number) {
  return (
    await pg.query<{ name: string | null }>(
      "SELECT tenant_proof.activity_actor_name($1) AS name",
      [id],
    )
  ).rows[0].name;
}

describe("test-only activity actor name accessor", () => {
  it("requires verified context and does not accept caller-selected team/actor settings", async () => {
    const pg = await setup();
    try {
      await pg.exec(
        "SELECT set_config('app.team_id','team-a',true),set_config('app.user_id','actor-a',true)",
      );
      expect(await lookup(pg, 1)).toBeNull();
      await install(pg);
      await pg.exec(
        "SELECT set_config('app.team_id','team-b',true),set_config('app.user_id','actor-b',true)",
      );
      expect(await lookup(pg, 1)).toBe("Historical Actor");
      expect(await lookup(pg, 3)).toBeNull();
    } finally {
      await pg.close();
    }
  });

  it("checks visibility of the actual activity row, including personal and candidate scopes", async () => {
    const pg = await setup();
    try {
      await install(pg);
      expect(await lookup(pg, 4)).toBeNull();
      expect(await lookup(pg, 5)).toBeNull();
      expect(await lookup(pg, 6)).toBeNull();
      expect(await lookup(pg, 7)).toBe("Current Actor");
      expect(await lookup(pg, 999)).toBeNull();
      await expect(
        pg.query("SELECT * FROM tenant_proof.identities"),
      ).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });

  it("allows candidate actor names only with the candidate-read claim", async () => {
    const pg = await setup();
    try {
      await install(pg, { candidates: true });
      expect(await lookup(pg, 6)).toBe("Other Actor");
    } finally {
      await pg.close();
    }
  });

  it("does not expose names without the recruitment-read claim", async () => {
    const pg = await setup();
    try {
      await install(pg, { read: false, candidates: true });
      expect(await lookup(pg, 1)).toBeNull();
      expect(await lookup(pg, 6)).toBeNull();
      expect(
        (await pg.query("SELECT id FROM tenant_proof.activity")).rows,
      ).toEqual([]);
    } finally {
      await pg.close();
    }
  });

  it("rejects a candidate scope changed after signing", async () => {
    const pg = await setup();
    try {
      const info = (
        await pg.query<{ pid: number; xid: string }>(
          "SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid",
        )
      ).rows[0];
      const claim = {
        aud: "synthetic-activity",
        ...info,
        team: "team-a",
        actor: "actor-a",
        read: true,
        candidates: false,
        exp: Date.now() + 30000,
      };
      const signature = createHmac(
        "sha256",
        "test-key-for-synthetic-proof-only",
      )
        .update(JSON.stringify(claim))
        .digest("hex");
      await expect(
        pg.query("SELECT tenant_proof.install_activity($1,$2)", [
          JSON.stringify({ ...claim, candidates: true }),
          signature,
        ]),
      ).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });

  it("rejects an expired signed claim", async () => {
    const pg = await setup();
    try {
      const info = (
        await pg.query<{ pid: number; xid: string }>(
          "SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid",
        )
      ).rows[0];
      const claim = JSON.stringify({
        aud: "synthetic-activity",
        ...info,
        team: "team-a",
        actor: "actor-a",
        read: true,
        candidates: true,
        exp: Date.now() - 1000,
      });
      const signature = createHmac(
        "sha256",
        "test-key-for-synthetic-proof-only",
      )
        .update(claim)
        .digest("hex");
      await expect(
        pg.query("SELECT tenant_proof.install_activity($1,$2)", [
          claim,
          signature,
        ]),
      ).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });

  it("keeps former-actor search filtering before counts and pagination", async () => {
    const pg = await setup();
    try {
      await install(pg);
      const count = await pg.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM tenant_proof.activity a WHERE strpos(lower(concat_ws(' ',a.summary,tenant_proof.activity_actor_name(a.id))),lower($1))>0",
        ["Historical Actor"],
      );
      const page = await pg.query<{ id: number; name: string }>(
        "SELECT a.id,tenant_proof.activity_actor_name(a.id) AS name FROM tenant_proof.activity a WHERE strpos(lower(concat_ws(' ',a.summary,tenant_proof.activity_actor_name(a.id))),lower($1))>0 ORDER BY a.created_at DESC,a.id DESC LIMIT 1 OFFSET $2",
        ["Historical Actor", 0],
      );
      const page2 = await pg.query<{ id: number; name: string }>(
        "SELECT a.id,tenant_proof.activity_actor_name(a.id) AS name FROM tenant_proof.activity a WHERE strpos(lower(concat_ws(' ',a.summary,tenant_proof.activity_actor_name(a.id))),lower($1))>0 ORDER BY a.created_at DESC,a.id DESC LIMIT 1 OFFSET $2",
        ["Historical Actor", 1],
      );
      expect(count.rows).toEqual([{ total: 2 }]);
      expect(page.rows).toEqual([{ id: 2, name: "Historical Actor" }]);
      expect(page2.rows).toEqual([{ id: 1, name: "Historical Actor" }]);
    } finally {
      await pg.close();
    }
  });

  it("characterizes volatile accessor snapshots when an actor name changes within a statement", async () => {
    const pg = await setup();
    try {
      // These synthetic grants and the mutator exist only to compare snapshots in this test.
      await pg.exec(`
        RESET ROLE;
        GRANT SELECT ON tenant_proof.identities TO tenant_proof_runtime;
        CREATE FUNCTION tenant_proof.rename_fixture() RETURNS integer
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
        BEGIN
          UPDATE tenant_proof.identities SET name='Renamed Actor' WHERE id='former';
          RETURN 1;
        END $$;
        REVOKE ALL ON FUNCTION tenant_proof.rename_fixture() FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION tenant_proof.rename_fixture() TO tenant_proof_runtime;
        SET ROLE tenant_proof_runtime;
      `);
      await install(pg);
      const result = await pg.query<{
        joined_name: string;
        accessor_name: string;
      }>(`
        WITH base AS MATERIALIZED (
          SELECT a.id, i.name AS joined_name
          FROM tenant_proof.activity a
          JOIN tenant_proof.identities i ON i.id=a.actor_id
          WHERE a.id=1
        ), changed AS MATERIALIZED (
          SELECT tenant_proof.rename_fixture() AS done FROM base
        )
        SELECT base.joined_name, tenant_proof.activity_actor_name(base.id) AS accessor_name
        FROM base JOIN changed ON changed.done=1
      `);
      expect(result.rows).toEqual([
        { joined_name: "Historical Actor", accessor_name: "Renamed Actor" },
      ]);
    } finally {
      await pg.close();
    }
  });

  it("characterizes a stable test accessor using the outer statement snapshot", async () => {
    const pg = await setup();
    try {
      await pg.exec(`
        RESET ROLE;
        GRANT SELECT ON tenant_proof.identities TO tenant_proof_runtime;
        CREATE FUNCTION tenant_proof.rename_fixture() RETURNS integer
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
        BEGIN
          UPDATE tenant_proof.identities SET name='Renamed Actor' WHERE id='former';
          RETURN 1;
        END $$;
        CREATE FUNCTION tenant_proof.snapshot_actor_name(event_id integer) RETURNS text
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
          SELECT i.name FROM tenant_proof.activity a
          LEFT JOIN tenant_proof.identities i ON i.id=a.actor_id
          WHERE a.id=event_id AND tenant_proof.activity_visible(a.team_id,a.actor_id,a.action,a.kind)
        $$;
        REVOKE ALL ON FUNCTION tenant_proof.rename_fixture(), tenant_proof.snapshot_actor_name(integer) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION tenant_proof.rename_fixture(), tenant_proof.snapshot_actor_name(integer) TO tenant_proof_runtime;
        SET ROLE tenant_proof_runtime;
      `);
      await install(pg);
      const result = await pg.query<{
        joined_name: string;
        accessor_name: string;
      }>(`
        WITH base AS MATERIALIZED (
          SELECT a.id, i.name AS joined_name
          FROM tenant_proof.activity a
          JOIN tenant_proof.identities i ON i.id=a.actor_id
          WHERE a.id=1
        ), changed AS MATERIALIZED (
          SELECT tenant_proof.rename_fixture() AS done FROM base
        )
        SELECT base.joined_name, tenant_proof.snapshot_actor_name(base.id) AS accessor_name
        FROM base JOIN changed ON changed.done=1
      `);
      expect(result.rows).toEqual([
        { joined_name: "Historical Actor", accessor_name: "Historical Actor" },
      ]);
    } finally {
      await pg.close();
    }
  });

  it("characterizes a wall-clock expiry changing a nominally stable accessor within one statement", async () => {
    const pg = await setup();
    try {
      await pg.exec(`
        RESET ROLE;
        CREATE FUNCTION tenant_proof.snapshot_actor_name(event_id integer) RETURNS text
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
          SELECT i.name FROM tenant_proof.activity a
          LEFT JOIN tenant_proof.identities i ON i.id=a.actor_id
          WHERE a.id=event_id AND tenant_proof.activity_visible(a.team_id,a.actor_id,a.action,a.kind)
        $$;
        REVOKE ALL ON FUNCTION tenant_proof.snapshot_actor_name(integer) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION tenant_proof.snapshot_actor_name(integer) TO tenant_proof_runtime;
        SET ROLE tenant_proof_runtime;
      `);
      await install(pg, { expiresAt: Date.now() + 5000 });
      const result = await pg.query<{ before: string; after: string | null }>(`
        WITH first AS MATERIALIZED (
          SELECT tenant_proof.snapshot_actor_name(1) AS before
        ), pause AS MATERIALIZED (
          SELECT pg_sleep(5.5) FROM first
        )
        SELECT first.before, tenant_proof.snapshot_actor_name(1) AS after
        FROM first CROSS JOIN pause
      `);
      expect(result.rows).toEqual([
        { before: "Historical Actor", after: null },
      ]);
    } finally {
      await pg.close();
    }
  }, 15000);
});
