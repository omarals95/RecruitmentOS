import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { describe, expect, it } from "vitest";

// Fictional test-only key. No application, cloud, or real identity is used.
const key = "synthetic-audit-proof-key-only";
type Claim = {
  aud: string;
  pid: number;
  xid: string;
  team: string;
  actor: string;
  session: string;
  operation: "create" | "revoke";
  token: string;
  request: string;
  scope: string;
  exp: number;
};
async function setup() {
  const pg = new PGlite({ extensions: { pgcrypto } });
  await pg.exec("CREATE EXTENSION pgcrypto");
  await pg.exec(
    await readFile("tests/fixtures/identity-audit-proof.sql", "utf8"),
  );
  await pg.exec("SET ROLE audit_proof_caller");
  return pg;
}
async function claimFor(
  pg: PGlite,
  overrides: Partial<Claim> = {},
): Promise<Claim> {
  const context = await pg.query<{ pid: number; xid: string }>(
    "SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid",
  );
  return {
    aud: "synthetic-audit-proof",
    ...context.rows[0],
    team: "team-a",
    actor: "actor-a",
    session: "session-a",
    operation: "create",
    token: "token-a",
    request: "request-a",
    scope: "token:manage",
    exp: Date.now() + 30_000,
    ...overrides,
  };
}
function signature(payload: string): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}
async function command(
  pg: PGlite,
  claim: Claim,
  signed = signature(JSON.stringify(claim)),
) {
  return pg.query<{ applied: boolean }>(
    "SELECT audit_proof.change_token($1,$2) AS applied",
    [JSON.stringify(claim), signed],
  );
}

describe("test-only signed identity audit proof", () => {
  it("creates and revokes a token together with their audit events", async () => {
    const pg = await setup();
    try {
      await pg.exec("BEGIN");
      expect((await command(pg, await claimFor(pg))).rows).toEqual([
        { applied: true },
      ]);
      await pg.exec("COMMIT; BEGIN");
      expect(
        (
          await command(
            pg,
            await claimFor(pg, { operation: "revoke", request: "request-b" }),
          )
        ).rows,
      ).toEqual([{ applied: true }]);
      await pg.exec("COMMIT; RESET ROLE");
      expect(
        (await pg.query("SELECT id, revoked FROM audit_proof.tokens")).rows,
      ).toEqual([{ id: "token-a", revoked: true }]);
      expect(
        (
          await pg.query(
            "SELECT action FROM audit_proof.events ORDER BY action",
          )
        ).rows,
      ).toEqual([{ action: "create" }, { action: "revoke" }]);
    } finally {
      await pg.close();
    }
  });

  it("rejects caller-selected team context and changed signed fields", async () => {
    const pg = await setup();
    try {
      await pg.exec(
        "BEGIN; SELECT set_config('app.team_id','team-b',true),set_config('app.user_id','actor-b',true)",
      );
      const original = await claimFor(pg);
      await expect(
        command(
          pg,
          { ...original, team: "team-b", actor: "actor-b" },
          signature(JSON.stringify(original)),
        ),
      ).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });

  it("derives event identity from signed claims rather than caller-set context", async () => {
    const pg = await setup();
    try {
      await pg.exec(
        "BEGIN; SELECT set_config('app.team_id','team-b',true),set_config('app.user_id','actor-b',true)",
      );
      await command(pg, await claimFor(pg));
      await pg.exec("COMMIT; RESET ROLE");
      expect(
        (await pg.query("SELECT team,actor,action FROM audit_proof.events"))
          .rows,
      ).toEqual([{ team: "team-a", actor: "actor-a", action: "create" }]);
    } finally {
      await pg.close();
    }
  });

  it("rejects absent membership, wrong scope and expired claims", async () => {
    for (const change of [
      { team: "team-b" },
      { scope: "token:read" },
      { exp: Date.now() - 1_000 },
    ]) {
      const pg = await setup();
      try {
        await pg.exec("BEGIN");
        await expect(command(pg, await claimFor(pg, change))).rejects.toThrow();
      } finally {
        await pg.close();
      }
    }
  });

  it("rejects direct access to protected tables and keys", async () => {
    const pg = await setup();
    try {
      for (const table of ["tokens", "events", "keys", "members", "sessions"]) {
        await expect(
          pg.query(`SELECT * FROM audit_proof.${table}`),
        ).rejects.toThrow();
      }
    } finally {
      await pg.close();
    }
  });

  it("rejects execution by the synthetic data role", async () => {
    const pg = await setup();
    try {
      await pg.exec("RESET ROLE; SET ROLE audit_proof_data; BEGIN");
      await expect(command(pg, await claimFor(pg))).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });

  it("rejects a revoked session and removed team membership", async () => {
    for (const sql of [
      "UPDATE audit_proof.sessions SET active=false WHERE id='session-a'",
      "UPDATE audit_proof.members SET active=false WHERE team='team-a' AND actor='actor-a'",
    ]) {
      const pg = await setup();
      try {
        await pg.exec(`RESET ROLE; ${sql}; SET ROLE audit_proof_caller; BEGIN`);
        await expect(command(pg, await claimFor(pg))).rejects.toThrow();
      } finally {
        await pg.close();
      }
    }
  });

  it("rejects a claim that expires after authorization locks are acquired", async () => {
    const pg = await setup();
    try {
      await pg.exec(
        "RESET ROLE; UPDATE audit_proof.test_delay SET seconds=1.5; SET ROLE audit_proof_caller; BEGIN",
      );
      const claim = await claimFor(pg, { exp: Date.now() + 1000 });
      await expect(command(pg, claim)).rejects.toThrow(
        /expired after authorization/i,
      );
      await pg.exec("ROLLBACK; RESET ROLE");
      expect(
        (await pg.query("SELECT count(*)::int AS n FROM audit_proof.tokens"))
          .rows,
      ).toEqual([{ n: 0 }]);
      expect(
        (await pg.query("SELECT count(*)::int AS n FROM audit_proof.events"))
          .rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      await pg.close();
    }
  });

  it("rejects revocation of a different team's token", async () => {
    const pg = await setup();
    try {
      await pg.exec("BEGIN");
      await command(pg, await claimFor(pg));
      await pg.exec("COMMIT; BEGIN");
      await expect(
        command(
          pg,
          await claimFor(pg, {
            team: "team-b",
            actor: "actor-b",
            session: "session-b",
            operation: "revoke",
            request: "request-b",
          }),
        ),
      ).rejects.toThrow();
      await pg.exec("ROLLBACK; RESET ROLE");
      expect(
        (await pg.query("SELECT revoked FROM audit_proof.tokens")).rows,
      ).toEqual([{ revoked: false }]);
      expect(
        (await pg.query("SELECT count(*)::int AS n FROM audit_proof.events"))
          .rows,
      ).toEqual([{ n: 1 }]);
    } finally {
      await pg.close();
    }
  });

  it("allows a team admin to revoke another member's token but denies a recruiter", async () => {
    const pg = await setup();
    try {
      await pg.exec("BEGIN");
      await command(pg, await claimFor(pg));
      await pg.exec("COMMIT; BEGIN");
      await expect(
        command(
          pg,
          await claimFor(pg, {
            actor: "actor-c",
            session: "session-c",
            operation: "revoke",
            request: "request-c",
          }),
        ),
      ).rejects.toThrow();
      await pg.exec("ROLLBACK; BEGIN");
      const result = await command(
        pg,
        await claimFor(pg, {
          actor: "actor-d",
          session: "session-d",
          operation: "revoke",
          request: "request-d",
        }),
      );
      expect(result.rows).toEqual([{ applied: true }]);
      await pg.exec("COMMIT; RESET ROLE");
      expect(
        (
          await pg.query(
            "SELECT actor,action FROM audit_proof.events ORDER BY action",
          )
        ).rows,
      ).toEqual([
        { actor: "actor-a", action: "create" },
        { actor: "actor-d", action: "revoke" },
      ]);
    } finally {
      await pg.close();
    }
  });

  it("characterizes that rollback to a savepoint permits reusing the claim", async () => {
    const pg = await setup();
    try {
      await pg.exec("BEGIN; SAVEPOINT before_command");
      const claim = await claimFor(pg);
      await command(pg, claim);
      await pg.exec("ROLLBACK TO SAVEPOINT before_command");
      // The database transaction rolled back both writes, including request uniqueness.
      // Strict one-use claims need a separately committed authority or stronger design.
      expect((await command(pg, claim)).rows).toEqual([{ applied: true }]);
    } finally {
      await pg.close();
    }
  });

  it("rolls back token creation and audit when audit insertion fails", async () => {
    const pg = await setup();
    try {
      await pg.exec(
        "RESET ROLE; ALTER TABLE audit_proof.events ADD CONSTRAINT reject_synthetic_event CHECK(false) NOT VALID; SET ROLE audit_proof_caller; BEGIN",
      );
      await expect(command(pg, await claimFor(pg))).rejects.toThrow();
      await pg.exec("ROLLBACK; RESET ROLE");
      expect(
        (await pg.query("SELECT count(*)::int AS n FROM audit_proof.tokens"))
          .rows,
      ).toEqual([{ n: 0 }]);
      expect(
        (await pg.query("SELECT count(*)::int AS n FROM audit_proof.events"))
          .rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      await pg.close();
    }
  });

  it("rolls back revocation if its audit insertion fails", async () => {
    const pg = await setup();
    try {
      await pg.exec("BEGIN");
      await command(pg, await claimFor(pg));
      await pg.exec(
        "COMMIT; RESET ROLE; ALTER TABLE audit_proof.events ADD CONSTRAINT reject_revoke CHECK(action <> 'revoke') NOT VALID; SET ROLE audit_proof_caller; BEGIN",
      );
      await expect(
        command(
          pg,
          await claimFor(pg, { operation: "revoke", request: "request-b" }),
        ),
      ).rejects.toThrow();
      await pg.exec("ROLLBACK; RESET ROLE");
      expect(
        (await pg.query("SELECT revoked FROM audit_proof.tokens")).rows,
      ).toEqual([{ revoked: false }]);
      expect(
        (await pg.query("SELECT action FROM audit_proof.events")).rows,
      ).toEqual([{ action: "create" }]);
    } finally {
      await pg.close();
    }
  });

  it("rejects a signed command bound to a different transaction or backend", async () => {
    for (const change of [{ pid: -1 }, { xid: "0" }]) {
      const pg = await setup();
      try {
        await pg.exec("BEGIN");
        await expect(command(pg, await claimFor(pg, change))).rejects.toThrow();
      } finally {
        await pg.close();
      }
    }
  });

  it("rolls back both token and audit on an outer transaction rollback", async () => {
    const pg = await setup();
    try {
      await pg.exec("BEGIN");
      await command(pg, await claimFor(pg));
      await pg.exec("ROLLBACK; RESET ROLE");
      expect(
        (await pg.query("SELECT count(*)::int AS n FROM audit_proof.tokens"))
          .rows,
      ).toEqual([{ n: 0 }]);
      expect(
        (await pg.query("SELECT count(*)::int AS n FROM audit_proof.events"))
          .rows,
      ).toEqual([{ n: 0 }]);
    } finally {
      await pg.close();
    }
  });
});
