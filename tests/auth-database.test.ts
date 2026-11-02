import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("auth database invariants", () => {
  const db = new PGlite();
  beforeAll(async () => {
    await db.exec(
      await readFile(
        new URL("../drizzle/0000_auth.sql", import.meta.url),
        "utf8",
      ),
    );
    await db.exec(
      `INSERT INTO auth."user"(id,name,email,email_verified) VALUES('owner','Owner','owner@example.test',true),('other','Other','other@example.test',true); INSERT INTO auth.organization(id,name,slug,created_by) VALUES('team','Team','team','owner'); INSERT INTO auth.member(id,organization_id,user_id,role) VALUES('owner-member','team','owner','owner');`,
    );
  });
  afterAll(async () => db.close());
  it("prevents deleting and demoting the last owner", async () => {
    await expect(
      db.exec("DELETE FROM auth.member WHERE id='owner-member'"),
    ).rejects.toThrow("retain at least one owner");
    await expect(
      db.exec("UPDATE auth.member SET role='viewer' WHERE id='owner-member'"),
    ).rejects.toThrow("retain at least one owner");
    expect(
      (await db.query("SELECT role FROM auth.member WHERE id='owner-member'"))
        .rows,
    ).toEqual([{ role: "owner" }]);
  });
  it("allows an owner transition once another owner exists", async () => {
    await db.exec(
      "INSERT INTO auth.member(id,organization_id,user_id,role) VALUES('second-owner','team','other','owner'); UPDATE auth.member SET role='recruiter' WHERE id='owner-member';",
    );
    expect(
      (await db.query("SELECT role FROM auth.member WHERE id='owner-member'"))
        .rows,
    ).toEqual([{ role: "recruiter" }]);
  });
  it("enforces a creator's team cap in the database", async () => {
    for (let i = 2; i <= 5; i++)
      await db.query(
        "INSERT INTO auth.organization(id,name,slug,created_by) VALUES($1,$1,$1,'owner')",
        [`team-${i}`],
      );
    await expect(
      db.exec(
        "INSERT INTO auth.organization(id,name,slug,created_by) VALUES('sixth','Sixth','sixth','owner')",
      ),
    ).rejects.toThrow("at most five teams");
  });
  it("rejects unknown roles and case-variant duplicate emails", async () => {
    await expect(
      db.exec(
        "UPDATE auth.member SET role='owner,admin' WHERE id='owner-member'",
      ),
    ).rejects.toThrow();
    await expect(
      db.exec(
        `INSERT INTO auth."user"(id,name,email) VALUES('duplicate','Duplicate','OWNER@example.test')`,
      ),
    ).rejects.toThrow();
  });
});
