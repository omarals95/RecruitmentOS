import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { describe, expect, it } from "vitest";

const syntheticKey = "test-key-for-synthetic-proof-only";
type Claim = {
  aud: string;
  pid: number;
  xid: string;
  team: string;
  actor: string;
  read: boolean;
  write: boolean;
  exp: number;
};
function signature(body: string): string {
  return createHmac("sha256", syntheticKey).update(body).digest("hex");
}
async function setup() {
  const pg = new PGlite({ extensions: { pgcrypto } });
  await pg.exec("CREATE EXTENSION pgcrypto");
  await pg.exec(
    await readFile("tests/fixtures/tenant-context-proof.sql", "utf8"),
  );
  await pg.exec("SET ROLE tenant_proof_runtime");
  return pg;
}
async function claimFor(
  pg: PGlite,
  overrides: Partial<Claim> = {},
): Promise<Claim> {
  const info = await pg.query<{ pid: number; xid: string }>(
    "SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid",
  );
  return {
    aud: "synthetic-proof",
    ...info.rows[0],
    team: "team-a",
    actor: "actor-a",
    read: true,
    write: false,
    exp: Date.now() + 30000,
    ...overrides,
  };
}
async function install(
  pg: PGlite,
  claim: Claim,
  sig = signature(JSON.stringify(claim)),
) {
  await pg.query("SELECT tenant_proof.install($1,$2)", [
    JSON.stringify(claim),
    sig,
  ]);
}

describe("test-only signed tenant context proof", () => {
  it("fails closed without verified context, even with caller-selected GUCs", async () => {
    const pg = await setup();
    try {
      await pg.exec("BEGIN; SELECT set_config('app.team_id','team-b',true)");
      expect(
        (await pg.query("SELECT body FROM tenant_proof.records")).rows,
      ).toEqual([]);
    } finally {
      await pg.close();
    }
  });
  it("rejects changing a caller-set team and protects the signing key", async () => {
    const pg = await setup();
    try {
      await pg.exec("BEGIN");
      await install(pg, await claimFor(pg));
      await pg.exec(
        "SELECT set_config('app.team_id','team-b',true), set_config('app.user_id','victim',true)",
      );
      expect(
        (
          await pg.query<{ body: string }>(
            "SELECT body FROM tenant_proof.records",
          )
        ).rows.map((r) => r.body),
      ).toEqual(["A"]);
      await pg.exec("SAVEPOINT denied_context");
      await expect(
        pg.query("SELECT * FROM tenant_proof.contexts"),
      ).rejects.toThrow();
      await pg.exec("ROLLBACK TO SAVEPOINT denied_context");
      await expect(
        pg.query("SELECT * FROM tenant_proof.keys"),
      ).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });
  it("denies a read-only claim permission to update", async () => {
    const pg = await setup();
    try {
      await pg.exec("BEGIN");
      await install(pg, await claimFor(pg));
      const result = await pg.query(
        "UPDATE tenant_proof.records SET body='changed' WHERE team_id='team-a' RETURNING body",
      );
      expect(result.rows).toEqual([]);
    } finally {
      await pg.close();
    }
  });
  it("rejects a changed, expired or cross-transaction assertion", async () => {
    const pg = await setup();
    try {
      await pg.exec("BEGIN");
      const first = await claimFor(pg);
      const sig = signature(JSON.stringify(first));
      await expect(
        install(pg, { ...first, team: "team-b" }, sig),
      ).rejects.toThrow();
      await pg.exec("ROLLBACK; BEGIN");
      await expect(
        install(pg, await claimFor(pg, { exp: Date.now() - 1000 })),
      ).rejects.toThrow();
      await pg.exec("ROLLBACK; BEGIN");
      await expect(install(pg, first, sig)).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });
  it("rejects a validly signed claim for a different backend", async () => {
    const pg = await setup();
    try {
      await pg.exec("BEGIN");
      const claim = await claimFor(pg);
      await expect(
        install(pg, { ...claim, pid: claim.pid + 1 }),
      ).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });
  it("rechecks expiration after installing a claim", async () => {
    const pg = await setup();
    try {
      await pg.exec("BEGIN");
      await install(pg, await claimFor(pg, { exp: Date.now() + 2000 }));
      expect(
        (await pg.query("SELECT body FROM tenant_proof.records")).rows,
      ).toEqual([{ body: "A" }]);
      await pg.exec("SELECT pg_sleep(2.1)");
      expect(
        (await pg.query("SELECT body FROM tenant_proof.records")).rows,
      ).toEqual([]);
    } finally {
      await pg.close();
    }
  });
  it("rejects reuse in the same transaction and permits one scoped write", async () => {
    const pg = await setup();
    try {
      await pg.exec("BEGIN");
      const first = await claimFor(pg, { write: true });
      await install(pg, first);
      const result = await pg.query(
        "UPDATE tenant_proof.records SET body='new' WHERE team_id='team-a' RETURNING body",
      );
      expect(result.rows).toEqual([{ body: "new" }]);
      await expect(install(pg, first)).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });

  it("enforces the signed tenant on writes as well as reads", async () => {
    const pg = await setup();
    try {
      await pg.exec("BEGIN");
      await install(pg, await claimFor(pg, { write: true }));
      await expect(
        pg.query(
          "INSERT INTO tenant_proof.records(team_id,body) VALUES('team-b','forged')",
        ),
      ).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });

  it("characterizes the unresolved savepoint rollback replay gap", async () => {
    const pg = await setup();
    try {
      await pg.exec("BEGIN; SAVEPOINT before_install");
      const claim = await claimFor(pg, { write: true });
      await install(pg, claim);
      await pg.exec("ROLLBACK TO SAVEPOINT before_install");
      // A same-transaction rollback erases the marker, so this is not one-use protection.
      await install(pg, claim);
      const result = await pg.query("SELECT body FROM tenant_proof.records");
      expect(result.rows).toEqual([{ body: "A" }]);
    } finally {
      await pg.close();
    }
  });
});
