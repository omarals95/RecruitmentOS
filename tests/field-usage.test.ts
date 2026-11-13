import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setDbForTests, type AppDb, type TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import { fieldUsage } from "@/lib/config-store";
import type { Principal } from "@/lib/principal";
import { installTenantContext } from "@/lib/tenant-context";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";
import {
  customField,
  insertKindSchema,
  kindBody,
} from "./helpers/kind-schemas";

// Field usage (ADM-29, job 100): a fictional company with three teams, the third archived, and a
// team of another fictional workspace. Only the company's own records of the kind that hold a value
// of a published custom field count; the helper returns that one number and nothing else.
const COMPANY = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000002";
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type Row = Record<string, unknown>;

describe("field usage under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, fieldsAdmin: Principal, orgAdmin: Principal;
  let teamAdmin: Principal, teamOwnerB: Principal, recruiter: Principal;
  let ownerToken: Principal;
  const note = customField("Fictional usage note", "short-text");
  const level = customField("Fictional usage level", "dropdown", {
    options: [{ id: "fictional-high", label: "Fictional high" }],
  });
  const roleNote = customField("Fictional role note", "short-text");
  const draftOnly = customField("Fictional draft note", "short-text");
  const taskField = randomUUID();
  const value = "Fictional counted value";
  const id = (n: number) =>
    `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
  const usageSql = (kind: string, field: string) =>
    `SELECT tenant_context.field_usage('${kind}', '${field}'::uuid) AS count`;
  const look = async <T = Row>(text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  const sqlAs = (principal: Principal, statement: string) =>
    harness.dataDb().then((db) =>
      withDeadlinesAndSnapshot(db, async (tx: TeamTx, snapshot) => {
        await installTenantContext(tx, principal, snapshot);
        return (await tx.execute(sql.raw(statement))).rows as Row[];
      }),
    );
  /** Service calls run on the data role, like a request. */
  const run = async <T>(work: () => Promise<T>) => {
    await harness.dataDb();
    return work();
  };
  const activityCount = async () =>
    (
      await look<{ n: number }>("SELECT count(*)::int AS n FROM app.activity")
    )[0].n;

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    const db: AppDb = await harness.asOwner();
    owner = await seedIdentity(db, { userId: "fu-owner", teamId: "fu-team-a" });
    teamAdmin = await seedIdentity(db, {
      userId: "fu-team-admin",
      teamId: "fu-team-a",
      role: "admin",
    });
    recruiter = await seedIdentity(db, {
      userId: "fu-recruiter",
      teamId: "fu-team-a",
      role: "recruiter",
    });
    teamOwnerB = await seedIdentity(db, {
      userId: "fu-owner-b",
      teamId: "fu-team-b",
    });
    fieldsAdmin = await seedIdentity(db, {
      userId: "fu-fields-admin",
      teamId: "fu-team-b",
      role: "recruiter",
    });
    orgAdmin = await seedIdentity(db, {
      userId: "fu-org-admin",
      teamId: "fu-team-b",
      role: "recruiter",
    });
    await seedIdentity(db, { userId: "fu-owner-c", teamId: "fu-team-c" });
    await seedIdentity(db, { userId: "fu-owner-x", teamId: "fu-team-x" });
    ownerToken = await seedApiToken(db, owner);
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','fu-fields-admin','admin','{fields}'),
        ('${COMPANY}','fu-org-admin','admin','{organisation}');
      INSERT INTO app.workspaces(id,name) VALUES ('${OTHER}','Fictional Other Company');
      UPDATE app.workspace_teams SET workspace_id = '${OTHER}' WHERE team_id = 'fu-team-x';
      UPDATE app.workspace_teams SET archived_at = now(), archived_by = 'fu-owner' WHERE team_id = 'fu-team-c';
    `);
    // The published candidate and job-role schemas, and a candidate draft adding a field.
    await insertKindSchema(
      harness.client,
      "fu-owner",
      kindBody("candidate", [note, level]),
    );
    await insertKindSchema(
      harness.client,
      "fu-owner",
      kindBody("job-role", [roleNote]),
    );
    await insertKindSchema(
      harness.client,
      "fu-owner",
      kindBody("candidate", [note, level, draftOnly]),
      { draft: true },
    );
    const candidate = (values: Row) =>
      JSON.stringify({
        name: "Fictional Usage Candidate",
        customValues: values,
      });
    await harness.asSuperuser();
    await harness.client.exec(`
      INSERT INTO app.records(id,team_id,kind,data,created_by,archived_at) VALUES
        ('${id(1)}','fu-team-a','candidate','${candidate({ [note.key]: value, [draftOnly.key]: value })}','fu-owner',NULL),
        ('${id(2)}','fu-team-a','candidate','${candidate({ [note.key]: value })}','fu-owner',now()),
        ('${id(3)}','fu-team-a','candidate','${candidate({ [note.key]: null })}','fu-owner',NULL),
        ('${id(4)}','fu-team-a','candidate','${candidate({ [note.key]: "" })}','fu-owner',NULL),
        ('${id(5)}','fu-team-a','candidate','${candidate({ [note.key]: [] })}','fu-owner',NULL),
        ('${id(6)}','fu-team-a','candidate','${candidate({ [level.key]: "fictional-high" })}','fu-owner',NULL),
        ('${id(7)}','fu-team-b','candidate','${candidate({ [note.key]: value })}','fu-owner-b',NULL),
        ('${id(8)}','fu-team-c','candidate','${candidate({ [note.key]: value })}','fu-owner-c',NULL),
        ('${id(9)}','fu-team-x','candidate','${candidate({ [note.key]: value })}','fu-owner-x',NULL),
        ('${id(10)}','fu-team-a','job-role','${JSON.stringify({ title: "Fictional Usage Role", customValues: { [note.key]: value, [roleNote.key]: value } })}','fu-owner',NULL),
        ('${id(11)}','fu-team-a','task-field','${JSON.stringify({ name: "Fictional task field", type: "Text", required: false, options: [] })}','fu-owner',NULL),
        ('${id(13)}','fu-team-a','bucket','{"name":"Fictional usage bucket"}','fu-owner',NULL);
      INSERT INTO app.records(id,team_id,kind,data,created_by,bucket_id) VALUES
        ('${id(12)}','fu-team-a','task','${JSON.stringify({ title: "Fictional Usage Task", customValues: { [taskField]: value, [id(11)]: value } })}','fu-owner','${id(13)}');
    `);
    setDbForTests(harness.db);
  });
  afterAll(async () => harness?.close());

  it("counts the company's records holding a value, archived records and teams included, for owners and admins with fields", async () => {
    const before = await activityCount();
    for (const p of [owner, fieldsAdmin]) {
      // Team A's value and archived record, team B and archived team C; never null, "", [] or a
      // missing key, another kind or another workspace.
      const rows = await sqlAs(p, usageSql("candidate", note.key));
      expect(rows, p.userId).toEqual([{ count: 4 }]);
      expect(Object.keys(rows[0])).toEqual(["count"]);
      const text = JSON.stringify(rows);
      for (const leaked of [
        value,
        id(1),
        id(7),
        "fu-team-a",
        "fu-team-b",
        "Fictional Test Team",
      ])
        expect(text, `${p.userId} ${leaked}`).not.toContain(leaked);
      expect(
        await sqlAs(p, usageSql("candidate", level.key)),
        p.userId,
      ).toEqual([{ count: 1 }]);
      expect(await sqlAs(p, usageSql("job-role", roleNote.key))).toEqual([
        { count: 1 },
      ]);
      // A team task field, an unpublished uuid, a draft-only field and another kind's field are 0.
      for (const [kind, field] of [
        ["task", taskField],
        ["task", id(11)],
        ["candidate", randomUUID()],
        ["candidate", draftOnly.key],
        ["candidate", roleNote.key],
        ["job-role", note.key],
        ["vacancy", note.key],
      ])
        expect(
          await sqlAs(p, usageSql(kind, field)),
          `${p.userId} ${kind} ${field}`,
        ).toEqual([{ count: 0 }]);
    }
    expect(await run(() => fieldUsage(owner, "candidate", note.key))).toEqual({
      count: 4,
    });
    expect(
      await run(() => fieldUsage(fieldsAdmin, "candidate", level.key)),
    ).toEqual({ count: 1 });
    expect(await activityCount()).toBe(before);
  });

  it("refuses every other context with 42501, and a null argument or an unknown kind with 22023", async () => {
    const before = await activityCount();
    const statement = usageSql("candidate", note.key);
    for (const p of [teamOwnerB, teamAdmin, orgAdmin, recruiter, ownerToken])
      await expect(sqlAs(p, statement), p.userId).rejects.toMatchObject({
        cause: { code: "42501" },
      });
    // No context at all.
    const db = await harness.dataDb();
    await expect(db.execute(sql.raw(statement))).rejects.toMatchObject({
      cause: { code: "42501" },
    });
    for (const call of [
      `SELECT tenant_context.field_usage(NULL, '${note.key}'::uuid)`,
      "SELECT tenant_context.field_usage('candidate', NULL)",
      usageSql("comment", note.key),
      usageSql("saved-view", note.key),
    ])
      await expect(sqlAs(owner, call), call).rejects.toMatchObject({
        cause: { code: "22023" },
      });
    for (const p of [teamOwnerB, teamAdmin, orgAdmin, recruiter, ownerToken])
      await expect(
        run(() => fieldUsage(p, "candidate", note.key)),
        p.userId,
      ).rejects.toMatchObject({ status: 403, code: "config_forbidden" });
    // A uuid that is no custom field in force is not found, before any helper call.
    for (const field of [randomUUID(), draftOnly.key, roleNote.key])
      await expect(
        run(() => fieldUsage(owner, "candidate", field)),
        field,
      ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await activityCount()).toBe(before);
  });

  it("is owner-run, SECURITY DEFINER, STABLE, returns one integer, has a fixed search_path and no PUBLIC EXECUTE", async () => {
    expect(
      await look(
        `SELECT p.proowner = (SELECT nspowner FROM pg_namespace WHERE nspname = 'tenant_context') AS owned,
           p.prosecdef AS definer, p.provolatile AS volatility, p.proconfig AS config,
           p.prorettype = 'integer'::regtype AS integer, p.proretset AS set,
           has_function_privilege('public', p.oid, 'EXECUTE') AS public,
           has_function_privilege('recruitmentos_data', p.oid, 'EXECUTE') AS data,
           has_function_privilege('recruitmentos_identity', p.oid, 'EXECUTE') AS identity
         FROM pg_proc p WHERE p.oid = 'tenant_context.field_usage(text,uuid)'::regprocedure`,
      ),
    ).toEqual([
      {
        owned: true,
        definer: true,
        volatility: "s",
        config: ["search_path=pg_catalog, pg_temp"],
        integer: true,
        set: false,
        public: false,
        data: true,
        identity: false,
      },
    ]);
  });
});
