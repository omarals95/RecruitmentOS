import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db";
import { readRuntimeRoleTemplate } from "./helpers/db";

describe("initial administrator runtime privileges", () => {
  it("never grants direct marker write privileges while applying the runtime template", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      const template = await readRuntimeRoleTemplate();
      for (let run = 0; run < 2; run++) {
        await pg.exec(template);
        for (const role of ["recruitmentos_data", "recruitmentos_identity"]) {
          const result = await pg.query<{ can_write: boolean }>(
            `SELECT has_table_privilege($1,'auth.initial_admin_claim','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
              OR has_any_column_privilege($1,'auth.initial_admin_claim','INSERT,UPDATE,REFERENCES') AS can_write`,
            [role],
          );
          expect(result.rows[0].can_write, role).toBe(false);
        }
      }
    } finally {
      await pg.close();
    }
  });
  it("revokes legacy table and column write grants during migration", async () => {
    const pg = new PGlite();
    try {
      for (const file of ["0000_auth.sql", "0003_initial_admin.sql"]) {
        await pg.exec(
          await readFile(
            new URL(`../drizzle/${file}`, import.meta.url),
            "utf8",
          ),
        );
      }
      await pg.exec(`
        CREATE ROLE old_runtime NOLOGIN;
        GRANT USAGE ON SCHEMA auth TO old_runtime;
        GRANT SELECT,DELETE ON auth.initial_admin_claim TO old_runtime;
        GRANT UPDATE(completed_at) ON auth.initial_admin_claim TO old_runtime;
        GRANT UPDATE(user_id) ON auth.initial_admin_claim TO PUBLIC;
        CREATE ROLE column_only NOLOGIN;
        GRANT USAGE ON SCHEMA auth TO column_only;
        GRANT UPDATE(completed_at) ON auth.initial_admin_claim TO column_only;
        CREATE ROLE inherited_runtime NOLOGIN INHERIT;
        GRANT old_runtime TO inherited_runtime;
      `);
      await pg.exec(
        await readFile(
          new URL(
            "../drizzle/0004_protect_initial_admin_claim.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      for (const role of ["old_runtime", "inherited_runtime", "column_only"]) {
        const result = await pg.query<{ allowed: boolean }>(
          `SELECT has_column_privilege($1, 'auth.initial_admin_claim', 'completed_at', 'UPDATE') AS allowed`,
          [role],
        );
        expect(result.rows[0].allowed).toBe(false);
      }
      await pg.exec("SET ROLE old_runtime");
      await expect(
        pg.query(`UPDATE auth.initial_admin_claim SET completed_at=NULL`),
      ).rejects.toThrow(/permission denied/i);
      await pg.exec("RESET ROLE; SET ROLE inherited_runtime");
      await expect(
        pg.query(`DELETE FROM auth.initial_admin_claim`),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        pg.query(`UPDATE auth.initial_admin_claim SET user_id=NULL`),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        pg.query(`DELETE FROM auth.initial_admin_claim`),
      ).rejects.toThrow(/permission denied/i);
      await pg.exec("RESET ROLE; SET ROLE column_only");
      await expect(
        pg.query(`UPDATE auth.initial_admin_claim SET completed_at=NULL`),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await pg.close();
    }
  });
  it("allows the verified owner flow but denies direct claim mutation", async () => {
    const pg = new PGlite();
    try {
      await applyMigrations(pg);
      await pg.exec(await readRuntimeRoleTemplate());
      await pg.exec("SET ROLE recruitmentos_identity");
      await pg.query(
        `INSERT INTO auth."user" (id,name,email,initial_admin) VALUES ('owner','Owner','owner@example.test',true)`,
      );
      await pg.query(
        `UPDATE auth."user" SET email_verified=true WHERE id='owner'`,
      );
      await pg.query(
        `INSERT INTO auth.organization(id,name,slug,created_by) VALUES('team','Team','team','owner')`,
      );
      await pg.query(
        `INSERT INTO auth.member(id,organization_id,user_id,role) VALUES('member','team','owner','owner')`,
      );
      expect(
        (
          await pg.query<{ completed_at: Date | null }>(
            `SELECT completed_at FROM auth.initial_admin_claim`,
          )
        ).rows[0].completed_at,
      ).toBeTruthy();
      await expect(
        pg.query(`UPDATE auth.initial_admin_claim SET completed_at=NULL`),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        pg.query(`DELETE FROM auth.initial_admin_claim`),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        pg.query(`INSERT INTO auth.initial_admin_claim(id) VALUES(true)`),
      ).rejects.toThrow(/permission denied/i);
      await pg.query(`DELETE FROM auth.organization WHERE id='team'`);
      await pg.query(`DELETE FROM auth."user" WHERE id='owner'`);
      await expect(
        pg.query(
          `INSERT INTO auth."user" (id,name,email,initial_admin) VALUES ('second','Second','second@example.test',true)`,
        ),
      ).rejects.toThrow();
      expect(
        (await pg.query(`SELECT id FROM auth.initial_admin_claim`)).rows,
      ).toHaveLength(1);
    } finally {
      await pg.close();
    }
  });
});
