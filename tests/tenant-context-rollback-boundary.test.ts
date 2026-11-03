// Synthetic characterization only. These tests document limitations, not a production design.
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
  await pg.exec("SET ROLE tenant_proof_runtime; BEGIN");
  const { rows } = await pg.query<{ pid: number; xid: string }>(
    "SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid",
  );
  return { pg, binding: rows[0] };
}

function signedClaim(binding: { pid: number; xid: string }, team: string) {
  const payload = JSON.stringify({
    aud: "synthetic-proof",
    ...binding,
    team,
    actor: "synthetic-actor",
    read: true,
    write: true,
    exp: Date.now() + 30000,
  });
  const signature = createHmac("sha256", "test-key-for-synthetic-proof-only")
    .update(payload)
    .digest("hex");
  return { payload, signature };
}

async function install(
  pg: PGlite,
  claim: { payload: string; signature: string },
) {
  await pg.query("SELECT tenant_proof.install($1,$2)", [
    claim.payload,
    claim.signature,
  ]);
}

describe("synthetic savepoint authorization boundaries", () => {
  it("rolls back the first database write before the same claim is installed again", async () => {
    const { pg, binding } = await setup();
    try {
      const claim = signedClaim(binding, "team-a");
      await pg.exec("SAVEPOINT before_install");
      await install(pg, claim);
      await pg.exec(
        "INSERT INTO tenant_proof.records VALUES ('team-a','synthetic-write')",
      );
      await pg.exec("ROLLBACK TO SAVEPOINT before_install");
      await install(pg, claim);
      await pg.exec(
        "INSERT INTO tenant_proof.records VALUES ('team-a','synthetic-write')",
      );
      await pg.exec("COMMIT; RESET ROLE");
      const { rows } = await pg.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM tenant_proof.records WHERE body='synthetic-write'",
      );
      expect(rows[0].count).toBe(1);
    } finally {
      await pg.close();
    }
  });

  it("shows rollback cannot undo a simulated capability issued before commit", async () => {
    const { pg, binding } = await setup();
    try {
      const claim = signedClaim(binding, "team-a");
      const issued: string[] = [];
      await pg.exec("SAVEPOINT before_install");
      await install(pg, claim);
      issued.push("fictional-capability-1");
      await pg.exec("ROLLBACK TO SAVEPOINT before_install");
      await install(pg, claim);
      issued.push("fictional-capability-2");
      await pg.exec("ROLLBACK");
      expect(issued).toHaveLength(2);
    } finally {
      await pg.close();
    }
  });

  it("shows conflicting valid claims can change tenant after savepoint rollback", async () => {
    const { pg, binding } = await setup();
    try {
      await pg.exec("SAVEPOINT before_install");
      await install(pg, signedClaim(binding, "team-a"));
      expect(
        (await pg.query("SELECT body FROM tenant_proof.records")).rows,
      ).toEqual([{ body: "A" }]);
      await pg.exec("ROLLBACK TO SAVEPOINT before_install");
      await install(pg, signedClaim(binding, "team-b"));
      expect(
        (await pg.query("SELECT body FROM tenant_proof.records")).rows,
      ).toEqual([{ body: "B" }]);
    } finally {
      await pg.close();
    }
  });
});
