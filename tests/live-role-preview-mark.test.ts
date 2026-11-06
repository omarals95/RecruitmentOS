import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { preflight, signerFor } from "../scripts/live-role-tests";
import { createSplitRoleDb, splitRoles } from "./helpers/db";

// The harness's preflight against one fictional PGlite with the split roles: only the exact
// approval comment on db_boundary, which only its owner can set, lets it reach a variant.
const refusal = {
  refusal: "The database is not marked as an approved Preview database.",
};
const mark = "recruitmentos-environment=preview";

/** One harness connection: switch to the role, then run the statement. */
function as(client: PGlite, role: string) {
  return {
    async query(text: string, params?: unknown[]) {
      await client.exec(`SET SESSION AUTHORIZATION ${role}`);
      const result = await client.query<Record<string, unknown>>(text, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? null };
    },
  };
}

describe("live role harness Preview approval mark", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  let database: string;
  const signer = signerFor(process.env.TENANT_CONTEXT_SIGNING_KEY!);
  const check = () =>
    preflight(
      {
        owner: as(harness.client, splitRoles.owner),
        data: as(harness.client, splitRoles.data),
        identity: as(harness.client, splitRoles.identity),
      },
      signer,
      database,
    );
  const comment = async (value: string | null) => {
    await harness.asOwner();
    await harness.client.query(
      value === null
        ? "COMMENT ON SCHEMA db_boundary IS NULL"
        : `COMMENT ON SCHEMA db_boundary IS '${value}'`,
    );
  };

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    database = (
      await harness.client.query<{ name: string }>(
        "SELECT current_database()::text AS name",
      )
    ).rows[0].name;
  });
  afterAll(async () => {
    await harness.close();
  });

  it("finds no mark on a freshly migrated database with the role template applied", async () => {
    await harness.asSuperuser();
    const { rows } = await harness.client.query<{ mark: string | null }>(
      "SELECT pg_catalog.obj_description('db_boundary'::regnamespace, 'pg_namespace') AS mark",
    );
    expect(rows).toEqual([{ mark: null }]);
  });

  it("refuses a database without the mark", async () => {
    await comment(null);
    expect(await check()).toEqual(refusal);
  });

  for (const value of [
    "recruitmentos-environment=production",
    "RecruitmentOS-Environment=Preview",
    "RECRUITMENTOS-ENVIRONMENT=PREVIEW",
    ` ${mark}`,
    `${mark} `,
    `${mark}\n`,
    "recruitmentos-environment = preview",
  ])
    it(`refuses the comment ${JSON.stringify(value)}`, async () => {
      await comment(value);
      expect(await check()).toEqual(refusal);
    });

  it("reaches the open variant with the exact mark set by the owner", async () => {
    await comment(mark);
    expect(await check()).toEqual({ variant: "open" });
  });

  it("does not let the data or identity role set or remove the mark", async () => {
    await comment(mark);
    for (const role of ["dataDb", "identityDb"] as const) {
      await harness[role]();
      for (const statement of [
        "COMMENT ON SCHEMA db_boundary IS 'recruitmentos-environment=preview'",
        "COMMENT ON SCHEMA db_boundary IS NULL",
      ])
        await expect(
          harness.client.query(statement),
          `${role}: ${statement}`,
        ).rejects.toMatchObject({ code: "42501" });
    }
    expect(await check()).toEqual({ variant: "open" });
  });
});
