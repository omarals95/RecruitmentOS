import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { describe, expect, it } from "vitest";

async function setup(write = true) {
  const pg = new PGlite({ extensions: { pgcrypto } });
  await pg.exec("CREATE EXTENSION pgcrypto");
  await pg.exec(
    await readFile("tests/fixtures/tenant-context-proof.sql", "utf8"),
  );
  await pg.exec(
    await readFile("tests/fixtures/tenant-context-personal-proof.sql", "utf8"),
  );
  await pg.exec("SET ROLE tenant_proof_runtime; BEGIN");
  const info = await pg.query<{ pid: number; xid: string }>(
    "SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid",
  );
  const claim = JSON.stringify({
    aud: "synthetic-proof",
    ...info.rows[0],
    team: "team-a",
    actor: "actor-a",
    read: true,
    write,
    exp: Date.now() + 30000,
  });
  const signature = createHmac("sha256", "test-key-for-synthetic-proof-only")
    .update(claim)
    .digest("hex");
  await pg.query("SELECT tenant_proof.install($1,$2)", [claim, signature]);
  return pg;
}

describe("test-only signed personal-row isolation", () => {
  it("does not expose another actor's private row in the same team", async () => {
    const pg = await setup();
    try {
      await pg.exec("SELECT set_config('app.user_id','actor-b',true)");
      const rows = await pg.query<{ body: string }>(
        "SELECT body FROM tenant_proof.personal_records ORDER BY body",
      );
      expect(rows.rows).toEqual([{ body: "A-private" }]);
    } finally {
      await pg.close();
    }
  });
  it("does not update another actor's private row or change its owner", async () => {
    const pg = await setup();
    try {
      const other = await pg.query(
        "UPDATE tenant_proof.personal_records SET body='forged' WHERE owner_id='actor-b' RETURNING body",
      );
      expect(other.rows).toEqual([]);
      await expect(
        pg.query(
          "UPDATE tenant_proof.personal_records SET owner_id='actor-b' WHERE owner_id='actor-a'",
        ),
      ).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });
  it("refuses to insert a row for a different owner", async () => {
    const pg = await setup();
    try {
      await expect(
        pg.query(
          "INSERT INTO tenant_proof.personal_records VALUES ('team-a','actor-b','forged')",
        ),
      ).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });
  it("refuses to move the verified actor's row to another team", async () => {
    const pg = await setup();
    try {
      await expect(
        pg.query(
          "UPDATE tenant_proof.personal_records SET team_id='team-b' WHERE owner_id='actor-a'",
        ),
      ).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });
  it("denies updates to the same actor's row in another team", async () => {
    const pg = await setup();
    try {
      const result = await pg.query(
        "UPDATE tenant_proof.personal_records SET body='forged' WHERE team_id='team-b' AND owner_id='actor-a' RETURNING body",
      );
      expect(result.rows).toEqual([]);
    } finally {
      await pg.close();
    }
  });
  it("denies inserts for the same actor in another team", async () => {
    const pg = await setup();
    try {
      await expect(
        pg.query(
          "INSERT INTO tenant_proof.personal_records VALUES ('team-b','actor-a','forged')",
        ),
      ).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });
  it("allows the verified actor to update and insert their own private rows", async () => {
    const pg = await setup();
    try {
      const updated = await pg.query(
        "UPDATE tenant_proof.personal_records SET body='updated' WHERE owner_id='actor-a' RETURNING body",
      );
      expect(updated.rows).toEqual([{ body: "updated" }]);
      const inserted = await pg.query(
        "INSERT INTO tenant_proof.personal_records VALUES ('team-a','actor-a','new') RETURNING body",
      );
      expect(inserted.rows).toEqual([{ body: "new" }]);
    } finally {
      await pg.close();
    }
  });
  it("denies writes to the verified actor when the claim is read-only", async () => {
    const pg = await setup(false);
    try {
      const updated = await pg.query(
        "UPDATE tenant_proof.personal_records SET body='forged' WHERE owner_id='actor-a' RETURNING body",
      );
      expect(updated.rows).toEqual([]);
      await expect(
        pg.query(
          "INSERT INTO tenant_proof.personal_records VALUES ('team-a','actor-a','forged')",
        ),
      ).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });
});
