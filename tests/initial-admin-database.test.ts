import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const authSql = () =>
  readFile(new URL("../drizzle/0000_auth.sql", import.meta.url), "utf8");
const setupSql = () =>
  readFile(
    new URL("../drizzle/0003_initial_admin.sql", import.meta.url),
    "utf8",
  );
describe("initial administrator database guard", () => {
  it("marks an existing deployment initialized and prevents reopening after deletion", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(await authSql());
      await pg.query(
        `INSERT INTO auth."user" (id,name,email) VALUES ('existing','Existing','existing@example.test')`,
      );
      await pg.exec(await setupSql());
      expect(
        (await pg.query("SELECT id FROM auth.initial_admin_claim")).rows,
      ).toHaveLength(1);
      await pg.query(`DELETE FROM auth."user" WHERE id='existing'`);
      await expect(
        pg.query(
          `INSERT INTO auth."user" (id,name,email,initial_admin) VALUES ('new','New','new@example.test',true)`,
        ),
      ).rejects.toThrow();
      expect(
        (await pg.query("SELECT id FROM auth.initial_admin_claim")).rows,
      ).toHaveLength(1);
    } finally {
      await pg.close();
    }
  });
  it("serializes first claims and rolls a claim back with its user", async () => {
    const pg = new PGlite();
    try {
      await pg.exec((await authSql()) + "\n" + (await setupSql()));
      await pg.exec(
        `BEGIN; INSERT INTO auth."user" (id,name,email,initial_admin) VALUES ('rollback','Rollback','rollback@example.test',true); ROLLBACK;`,
      );
      expect(
        (await pg.query("SELECT id FROM auth.initial_admin_claim")).rows,
      ).toHaveLength(0);
      const requests = ["one", "two"].map((id) =>
        pg.query(
          `INSERT INTO auth."user" (id,name,email,initial_admin) VALUES ($1,$1,$2,true)`,
          [id, `${id}@example.test`],
        ),
      );
      const results = await Promise.allSettled(requests);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        (await pg.query("SELECT id FROM auth.initial_admin_claim")).rows,
      ).toHaveLength(1);
      expect(
        (await pg.query(`SELECT id FROM auth."user" WHERE initial_admin=true`))
          .rows,
      ).toHaveLength(1);
      await expect(
        pg.query(
          `INSERT INTO auth."user" (id,name,email) VALUES('ordinary','Ordinary','ordinary@example.test')`,
        ),
      ).rejects.toThrow();
      const claimant = (
        await pg.query<{ id: string }>(
          `UPDATE auth."user" SET email_verified=true WHERE initial_admin=true RETURNING id`,
        )
      ).rows[0].id;
      await expect(
        pg.query(
          `INSERT INTO auth."user" (id,name,email) VALUES('ordinary','Ordinary','ordinary@example.test')`,
        ),
      ).rejects.toThrow();
      await pg.query(
        `INSERT INTO auth.organization(id,name,slug,created_by) VALUES('initial-team','Team','initial-team',$1)`,
        [claimant],
      );
      await pg.query(
        `INSERT INTO auth.member(id,organization_id,user_id,role) VALUES('initial-member','initial-team',$1,'owner')`,
        [claimant],
      );
      expect(
        (
          await pg.query<{ completed_at: Date | null }>(
            `SELECT completed_at FROM auth.initial_admin_claim`,
          )
        ).rows[0].completed_at,
      ).toBeTruthy();
      await pg.query(
        `INSERT INTO auth."user" (id,name,email) VALUES('ordinary','Ordinary','ordinary@example.test')`,
      );
    } finally {
      await pg.close();
    }
  });
});
