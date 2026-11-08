import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setDbForTests, type AppDb, type TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import {
  configBodySchemas,
  configHelpText,
  configLabel,
  configOptionValue,
  CONFIG_TYPES,
  type ConfigType,
} from "@/domain/config";
import {
  archiveConfigObject,
  createConfigDraft,
  getConfigObject,
  listConfigHistory,
  publishConfigVersion,
  retireConfigVersion,
  saveConfigLayout,
  updateConfigDraft,
} from "@/lib/config-store";
import type { Principal } from "@/lib/principal";
import { installTenantContext } from "@/lib/tenant-context";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace with two fictional teams, and a second fictional
// workspace inserted by the owner for the isolation case (R2a-04, 0030).
const COMPANY = "00000000-0000-4000-a000-000000000001";
const OTHER = "00000000-0000-4000-a000-000000000002";
const TABLES = ["config_objects", "config_versions", "config_layouts"] as const;
const ACTIONS = [
  "config.draft_created",
  "config.published",
  "config.retired",
  "config.archived",
  "config.layout_changed",
];
// Right-to-left override, zero-width space and a bell control character, removed by cleaning.
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const BEL = String.fromCharCode(0x07);
const COMPANY_TYPES = CONFIG_TYPES.filter((type) => type !== "task-board");
type Harness = Awaited<ReturnType<typeof createSplitRoleDb>>;
type ConfigAudit = {
  id: string;
  team_id: string;
  actor_id: string;
  actor_type: string;
  token_id: string | null;
  record_id: string | null;
  action: string;
  summary: string;
  metadata: Record<string, unknown>;
};

/** One data-role transaction under the principal's verified context. */
function asContext<T>(
  harness: Harness,
  principal: Principal,
  work: (tx: TeamTx) => Promise<T>,
) {
  return harness.dataDb().then((db) =>
    withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
      await installTenantContext(tx, principal, snapshot);
      return work(tx);
    }),
  );
}

describe("versioned configuration store under the split runtime roles", () => {
  let harness: Harness;
  let owner: Principal, ownerInB: Principal, adminA: Principal;
  let recruiterA: Principal, ownerB: Principal, fieldsAdmin: Principal;
  let ownerX: Principal, ownerToken: Principal;

  /** Raw reads as the PGlite superuser, which bypasses RLS; only to inspect outcomes. */
  const look = async <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  const audits = () =>
    look<ConfigAudit>(
      "SELECT id, team_id, actor_id, actor_type, token_id, record_id, action, summary, metadata FROM app.activity WHERE kind = 'config' ORDER BY created_at, id",
    );
  /** Service calls run on the data role, like a request. */
  const run = async <T>(work: () => Promise<T>) => {
    await harness.dataDb();
    return work();
  };
  const sqlAs = (principal: Principal, statement: string) =>
    asContext(harness, principal, async (tx) => {
      const { rows } = await tx.execute(sql.raw(statement));
      return rows;
    });
  /** Runs the call and expects one SQLSTATE, with no config row or config audit row changed. */
  async function refused(call: () => Promise<unknown>, code: string) {
    const before = [await snapshot(), await audits()];
    await expect(call()).rejects.toMatchObject({ cause: { code } });
    expect([await snapshot(), await audits()]).toEqual(before);
  }
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        TABLES.map(async (table) => [
          table,
          await look(`SELECT * FROM app.${table} ORDER BY 1`),
        ]),
      ),
    );
  const version = async (id: string) =>
    (
      await look<{
        state: string;
        number: number | null;
        body: unknown;
        body_text: string;
        body_sha256: string;
        created_by: string | null;
        published_by: string | null;
      }>(
        "SELECT state, number, body, body::text AS body_text, body_sha256, created_by, published_by FROM app.config_versions WHERE id = $1",
        [id],
      )
    )[0];
  const object = async (id: string) =>
    (
      await look<{
        current_version_id: string | null;
        draft_version_id: string | null;
        archived_at: Date | null;
        created_by: string | null;
        team_id: string | null;
      }>(
        "SELECT current_version_id, draft_version_id, archived_at, created_by, team_id FROM app.config_objects WHERE id = $1",
        [id],
      )
    )[0];
  const draft = (
    p: Principal,
    type: ConfigType,
    key: string,
    label = `Fictional ${key}`,
  ) => run(() => createConfigDraft(p, { type, key, body: { label } }));

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, {
      userId: "cfg-owner",
      teamId: "cfg-team-a",
    });
    adminA = await seedIdentity(db, {
      userId: "cfg-admin-a",
      teamId: "cfg-team-a",
      role: "admin",
    });
    recruiterA = await seedIdentity(db, {
      userId: "cfg-recruiter-a",
      teamId: "cfg-team-a",
      role: "recruiter",
    });
    ownerB = await seedIdentity(db, {
      userId: "cfg-owner-b",
      teamId: "cfg-team-b",
    });
    ownerInB = await seedIdentity(db, {
      userId: "cfg-owner",
      teamId: "cfg-team-b",
      role: "recruiter",
    });
    fieldsAdmin = await seedIdentity(db, {
      userId: "cfg-fields-admin",
      teamId: "cfg-team-b",
      role: "recruiter",
    });
    ownerX = await seedIdentity(db, {
      userId: "cfg-owner-x",
      teamId: "cfg-team-x",
    });
    ownerToken = await seedApiToken(db, owner);
    // Company authority and the second workspace are owner-written; no team is created after this.
    await harness.client.exec(`
      INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${COMPANY}','cfg-fields-admin','admin','{fields}');
      INSERT INTO app.workspaces(id,name) VALUES ('${OTHER}','Fictional Other Company');
      UPDATE app.workspace_teams SET workspace_id = '${OTHER}' WHERE team_id = 'cfg-team-x';
    `);
    setDbForTests(harness.db);
  });
  afterAll(async () => harness?.close());

  it("forces row-level security on the three tables", async () => {
    expect(
      await look(
        "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid IN ('app.config_objects'::regclass, 'app.config_versions'::regclass, 'app.config_layouts'::regclass) ORDER BY relname",
      ),
    ).toEqual(
      ["config_layouts", "config_objects", "config_versions"].map(
        (relname) => ({
          relname,
          relrowsecurity: true,
          relforcerowsecurity: true,
        }),
      ),
    );
  });

  describe("lifecycle, immutability and audit", () => {
    let objectId: string, v1: string, v2: string;

    it("creates, edits, publishes twice and retires version 1", async () => {
      ({ objectId, versionId: v1 } = await draft(
        owner,
        "workflow",
        "application",
        `  Fictional${ZWSP} application workflow${RLO} `,
      ));
      expect((await version(v1)).body).toEqual({
        label: "Fictional application workflow",
      });
      await run(() =>
        updateConfigDraft(owner, v1, {
          body: {
            label: "Fictional application workflow",
            help: "Fictional help",
          },
          note: "First fictional version",
        }),
      );
      expect(await run(() => publishConfigVersion(owner, v1))).toBe(1);
      expect((await object(objectId)).draft_version_id).toBeNull();
      ({ versionId: v2 } = await draft(
        owner,
        "workflow",
        "application",
        "Fictional application workflow 2",
      ));
      expect((await object(objectId)).draft_version_id).toBe(v2);
      expect(await run(() => publishConfigVersion(owner, v2))).toBe(2);
      expect(await object(objectId)).toMatchObject({
        current_version_id: v2,
        draft_version_id: null,
        created_by: "cfg-owner",
      });
      await run(() => retireConfigVersion(owner, v1));
      const [first, second] = [await version(v1), await version(v2)];
      expect(first).toMatchObject({
        state: "retired",
        number: 1,
        body: {
          label: "Fictional application workflow",
          help: "Fictional help",
        },
        created_by: "cfg-owner",
        published_by: "cfg-owner",
      });
      expect(second).toMatchObject({ state: "published", number: 2 });
      for (const row of [first, second])
        expect(row.body_sha256).toBe(
          createHash("sha256").update(row.body_text, "utf8").digest("hex"),
        );
      const read = await run(() =>
        getConfigObject(owner, "workflow", "application"),
      );
      expect(read).toMatchObject({
        id: objectId,
        type: "workflow",
        key: "application",
        archivedAt: null,
        current: { id: v2, number: 2, state: "published" },
        draft: null,
      });
    });

    it("refuses retiring the current version and publishing a version twice", async () => {
      for (const call of [
        () => retireConfigVersion(owner, v2),
        () => publishConfigVersion(owner, v1),
        () => publishConfigVersion(owner, v2),
        () => updateConfigDraft(owner, v2, { body: { label: "Changed" } }),
      ])
        await expect(run<unknown>(call)).rejects.toMatchObject({
          status: 409,
          code: "config_state_conflict",
        });
    });

    it("refuses every change of a published or retired version by the data role", async () => {
      const statements = [
        `UPDATE app.config_versions SET body = '{"label":"Forged"}' WHERE id = '${v2}'`,
        `UPDATE app.config_versions SET body_sha256 = repeat('0', 64) WHERE id = '${v2}'`,
        `UPDATE app.config_versions SET number = 7 WHERE id = '${v2}'`,
        `UPDATE app.config_versions SET object_id = gen_random_uuid() WHERE id = '${v2}'`,
        `UPDATE app.config_versions SET note = 'Forged' WHERE id = '${v1}'`,
        `UPDATE app.config_versions SET state = 'retired' WHERE id = '${v2}'`,
        `UPDATE app.config_versions SET state = 'published' WHERE id = '${v1}'`,
        `DELETE FROM app.config_versions WHERE id = '${v2}'`,
        `DELETE FROM app.config_versions WHERE id = '${v1}'`,
        `DELETE FROM app.config_objects WHERE id = '${objectId}'`,
        `UPDATE app.config_objects SET current_version_id = '${v1}' WHERE id = '${objectId}'`,
        `INSERT INTO app.config_versions(object_id, workspace_id, state, number, body, body_sha256) VALUES ('${objectId}', '${COMPANY}', 'published', 9, '{"label":"Forged"}', repeat('0', 64))`,
      ];
      for (const statement of statements)
        await refused(() => sqlAs(owner, statement), "42501");
    });

    it("still lets a draft be edited and deleted, but not moved to published by the data role", async () => {
      const { versionId: v3 } = await draft(owner, "workflow", "application");
      await refused(
        () =>
          sqlAs(
            owner,
            `UPDATE app.config_versions SET state = 'published', number = 3 WHERE id = '${v3}'`,
          ),
        "42501",
      );
      await refused(
        () =>
          sqlAs(
            owner,
            `UPDATE app.config_objects SET draft_version_id = '${v2}' WHERE id = '${objectId}'`,
          ),
        "42501",
      );
      expect(
        await sqlAs(
          owner,
          `UPDATE app.config_versions SET body = '{"label":"Fictional edited draft"}', body_sha256 = repeat('0', 64) WHERE id = '${v3}' RETURNING id`,
        ),
      ).toHaveLength(1);
      const edited = await version(v3);
      expect(edited.body_sha256).toBe(
        createHash("sha256").update(edited.body_text, "utf8").digest("hex"),
      );
      expect(
        await asContext(harness, owner, async (tx) => {
          await tx.execute(
            sql.raw(
              `UPDATE app.config_objects SET draft_version_id = NULL WHERE id = '${objectId}'`,
            ),
          );
          return (
            await tx.execute(
              sql.raw(
                `DELETE FROM app.config_versions WHERE id = '${v3}' RETURNING id`,
              ),
            )
          ).rows;
        }),
      ).toHaveLength(1);
      expect(await version(v3)).toBeUndefined();
    });

    it("refuses a body over 512 KiB in the database (54000) and in the service (413)", async () => {
      const big = "x".repeat(524_288);
      const { objectId: sized, versionId: small } = await draft(
        owner,
        "kind-schema",
        "size-probe",
      );
      await refused(
        () =>
          sqlAs(
            owner,
            `UPDATE app.config_versions SET body = jsonb_build_object('label', repeat('x', 524288)) WHERE id = '${small}'`,
          ),
        "54000",
      );
      await refused(
        () =>
          asContext(harness, owner, async (tx) => {
            await tx.execute(
              sql.raw(`DELETE FROM app.config_versions WHERE id = '${small}'`),
            );
            await tx.execute(
              sql.raw(
                `INSERT INTO app.config_versions(object_id, workspace_id, body) VALUES ('${sized}', '${COMPANY}', jsonb_build_object('label', repeat('x', 524288)))`,
              ),
            );
          }),
        "54000",
      );
      for (const call of [
        () =>
          createConfigDraft(owner, {
            type: "kind-schema",
            key: "size-probe-2",
            body: { label: big },
          }),
        () => updateConfigDraft(owner, small, { body: { label: big } }),
        () => saveConfigLayout(owner, small, { nodes: big }),
      ])
        await expect(run<unknown>(call)).rejects.toMatchObject({
          status: 413,
          code: "config_too_large",
        });
    });
  });

  describe("configuration audit", () => {
    /** Exactly one new config row for the call, returned. */
    async function audited(call: () => Promise<unknown>) {
      const before = new Set((await audits()).map((row) => row.id));
      await run(call);
      const added = (await audits()).filter((row) => !before.has(row.id));
      expect(added).toHaveLength(1);
      return added[0];
    }
    const keys = [
      "fromVersionId",
      "key",
      "number",
      "objectId",
      "type",
      "versionId",
      "workspaceId",
    ];

    it("writes exactly one metadata-only row for each kind of change", async () => {
      const label = "Fictional secret board label";
      const marker = "fictional-layout-marker";
      let v1 = "";
      const created = await audited(async () => {
        v1 = (
          await createConfigDraft(owner, {
            type: "board",
            key: "audit-board",
            body: { label },
          })
        ).versionId;
      });
      const objectId = created.metadata.objectId as string;
      const layout = await audited(() =>
        saveConfigLayout(owner, v1, { nodes: [{ id: marker, x: 1 }] }),
      );
      const published = await audited(() => publishConfigVersion(owner, v1));
      let v2 = "";
      const second = await audited(async () => {
        v2 = (
          await createConfigDraft(owner, {
            type: "board",
            key: "audit-board",
            body: { label },
          })
        ).versionId;
      });
      const publishedAgain = await audited(() =>
        publishConfigVersion(owner, v2),
      );
      const retired = await audited(() => retireConfigVersion(owner, v1));
      const archived = await audited(() =>
        archiveConfigObject(owner, objectId),
      );
      const rows = [
        created,
        layout,
        published,
        second,
        publishedAgain,
        retired,
        archived,
      ];
      expect(rows.map((row) => row.action)).toEqual([
        "config.draft_created",
        "config.layout_changed",
        "config.published",
        "config.draft_created",
        "config.published",
        "config.retired",
        "config.archived",
      ]);
      const base = { workspaceId: COMPANY, objectId, type: "board" };
      expect(rows.map((row) => row.metadata)).toEqual([
        {
          ...base,
          key: "audit-board",
          versionId: v1,
          number: null,
          fromVersionId: null,
        },
        {
          ...base,
          key: "audit-board",
          versionId: v1,
          number: null,
          fromVersionId: null,
        },
        {
          ...base,
          key: "audit-board",
          versionId: v1,
          number: 1,
          fromVersionId: null,
        },
        {
          ...base,
          key: "audit-board",
          versionId: v2,
          number: null,
          fromVersionId: v1,
        },
        {
          ...base,
          key: "audit-board",
          versionId: v2,
          number: 2,
          fromVersionId: v1,
        },
        {
          ...base,
          key: "audit-board",
          versionId: v1,
          number: 1,
          fromVersionId: null,
        },
        {
          ...base,
          key: "audit-board",
          versionId: v2,
          number: 2,
          fromVersionId: null,
        },
      ]);
      for (const row of rows) {
        expect(Object.keys(row.metadata).sort()).toEqual(keys);
        expect(row).toMatchObject({
          team_id: "cfg-team-a",
          actor_id: "cfg-owner",
          actor_type: "session",
          token_id: null,
          record_id: null,
        });
        expect(JSON.stringify(row)).not.toContain(label);
        expect(JSON.stringify(row)).not.toContain(marker);
      }
      // An archived object takes no new draft.
      await expect(
        run(() =>
          createConfigDraft(owner, {
            type: "board",
            key: "audit-board",
            body: { label },
          }),
        ),
      ).rejects.toMatchObject({ status: 409, code: "config_state_conflict" });
    });

    it("refuses a duplicate, a mismatched and an unknown action and adds no row", async () => {
      const read = await run(() =>
        getConfigObject(owner, "workflow", "application"),
      );
      const published = read!.current!.id;
      const { versionId: pending } = await draft(
        owner,
        "workflow",
        "application",
      );
      const call = (versionId: string, action: string) => () =>
        sqlAs(
          owner,
          `SELECT tenant_context.audit_config('${versionId}', '${action}')`,
        );
      await refused(call(published, "config.published"), "RQ007");
      await refused(call(pending, "config.published"), "RQ007");
      await refused(call(pending, "config.draft_created"), "RQ007");
      await refused(call(published, "config.archived"), "RQ007");
      await refused(call(published, "config.layout_changed"), "RQ007");
      await refused(call(published, "config.bogus"), "22023");
      await expect(
        run(() =>
          createConfigDraft(owner, {
            type: "workflow",
            key: "application",
            body: { label: "Second draft" },
          }),
        ),
      ).rejects.toMatchObject({ status: 409, code: "config_draft_exists" });
    });

    it("refuses a direct data-role insert of a config activity row for every action", async () => {
      for (const action of ACTIONS)
        await refused(
          () =>
            sqlAs(
              owner,
              `INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary,metadata) VALUES ('cfg-team-a','cfg-owner','session','${action}','config','Forged','{}')`,
            ),
          "42501",
        );
    });
  });

  describe("tenancy and company authority", () => {
    let otherObject: string;

    beforeAll(async () => {
      // The owner writes the other workspace's rows directly, as the migration owner would.
      await harness.asOwner();
      otherObject = (
        await harness.client.query<{ id: string }>(
          `INSERT INTO app.config_objects(workspace_id, type, key, created_by) VALUES ('${OTHER}', 'workflow', 'other-workflow', 'cfg-owner-x') RETURNING id`,
        )
      ).rows[0].id;
      const otherVersion = (
        await harness.client.query<{ id: string }>(
          `INSERT INTO app.config_versions(object_id, workspace_id, body, created_by) VALUES ('${otherObject}', '${OTHER}', '{"label":"Fictional other company workflow"}', 'cfg-owner-x') RETURNING id`,
        )
      ).rows[0].id;
      await harness.client.query(
        `INSERT INTO app.config_layouts(version_id, workspace_id, layout) VALUES ('${otherVersion}', '${OTHER}', '{"nodes":[]}')`,
      );
    });

    const visible = (principal: Principal) =>
      asContext(harness, principal, async (tx) =>
        Object.fromEntries(
          await Promise.all(
            TABLES.map(async (table) => [
              table,
              (
                await tx.execute<{ workspace_id: string }>(
                  sql.raw(`SELECT workspace_id FROM app.${table}`),
                )
              ).rows.map((row) => row.workspace_id),
            ]),
          ),
        ),
      );

    it("keeps each workspace's rows from the other workspace's contexts", async () => {
      const other = await visible(ownerX);
      const company = await visible(owner);
      expect(other).toEqual({
        config_objects: [OTHER],
        config_versions: [OTHER],
        config_layouts: [OTHER],
      });
      for (const table of TABLES) {
        expect(company[table].length, table).toBeGreaterThan(0);
        expect(
          company[table].every((id: string) => id === COMPANY),
          table,
        ).toBe(true);
      }
      await refused(
        () =>
          sqlAs(
            ownerX,
            `INSERT INTO app.config_objects(workspace_id, type, key) VALUES ('${COMPANY}', 'workflow', 'planted')`,
          ),
        "42501",
      );
      expect(
        await sqlAs(
          owner,
          `UPDATE app.config_objects SET archived_at = now() WHERE id = '${otherObject}' RETURNING id`,
        ),
      ).toEqual([]);
      expect(
        await run(() => getConfigObject(ownerX, "workflow", "application")),
      ).toBeNull();
    });

    it("refuses every company write by a team owner or admin without company authority", async () => {
      const { objectId, versionId: published } = await draft(
        owner,
        "template",
        "offer-letter",
      );
      await run(() => publishConfigVersion(owner, published));
      const { versionId: pending } = await draft(
        owner,
        "template",
        "offer-letter",
      );
      for (const p of [ownerB, adminA, ownerToken]) {
        for (const type of COMPANY_TYPES)
          await expect(
            run(() =>
              createConfigDraft(p, {
                type,
                key: "denied",
                body: { label: "Denied" },
              }),
            ),
            `${p.userId} ${type}`,
          ).rejects.toMatchObject({ status: 403, code: "config_forbidden" });
        for (const call of [
          () => updateConfigDraft(p, pending, { body: { label: "Denied" } }),
          () => publishConfigVersion(p, pending),
          () => retireConfigVersion(p, published),
          () => archiveConfigObject(p, objectId),
          () => saveConfigLayout(p, pending, { nodes: [] }),
        ])
          await expect(run<unknown>(call), p.userId).rejects.toMatchObject({
            status: 403,
            code: "config_forbidden",
          });
        for (const type of COMPANY_TYPES)
          await refused(
            () =>
              sqlAs(
                p,
                `INSERT INTO app.config_objects(workspace_id, type, key) VALUES ('${COMPANY}', '${type}', 'denied')`,
              ),
            "42501",
          );
        for (const statement of [
          `INSERT INTO app.config_versions(object_id, workspace_id, body) VALUES ('${objectId}', '${COMPANY}', '{"label":"Denied"}')`,
          `INSERT INTO app.config_layouts(version_id, workspace_id, layout) VALUES ('${pending}', '${COMPANY}', '{}')`,
          `SELECT tenant_context.publish_config_version('${pending}')`,
          `SELECT tenant_context.retire_config_version('${published}')`,
          `SELECT tenant_context.audit_config('${pending}', 'config.draft_created')`,
        ])
          await refused(() => sqlAs(p, statement), "42501");
        for (const statement of [
          `UPDATE app.config_objects SET archived_at = now() WHERE id = '${objectId}' RETURNING id`,
          `UPDATE app.config_versions SET note = 'Denied' WHERE id = '${pending}' RETURNING id`,
          `UPDATE app.config_layouts SET layout = '{}' RETURNING version_id`,
          `DELETE FROM app.config_versions WHERE id = '${pending}' RETURNING id`,
          `DELETE FROM app.config_layouts RETURNING version_id`,
        ])
          expect(await sqlAs(p, statement), `${p.userId} ${statement}`).toEqual(
            [],
          );
      }
    });

    it("lets a company admin write only the areas granted, and only a company owner write roles", async () => {
      const { versionId } = await draft(
        fieldsAdmin,
        "kind-schema",
        "candidate",
      );
      expect(
        await run(() => publishConfigVersion(fieldsAdmin, versionId)),
      ).toBe(1);
      for (const type of ["workflow", "board", "template", "role"] as const)
        await expect(
          run(() =>
            createConfigDraft(fieldsAdmin, {
              type,
              key: "admin-denied",
              body: { label: "Denied" },
            }),
          ),
          type,
        ).rejects.toMatchObject({ status: 403, code: "config_forbidden" });
      await refused(
        () =>
          sqlAs(
            fieldsAdmin,
            `INSERT INTO app.config_objects(workspace_id, type, key) VALUES ('${COMPANY}', 'role', 'admin-denied')`,
          ),
        "42501",
      );
      const role = await draft(owner, "role", "hiring-manager");
      expect(await run(() => publishConfigVersion(owner, role.versionId))).toBe(
        1,
      );
    });

    it("keeps task boards with their own team's owners and admins", async () => {
      const { objectId, versionId } = await draft(
        adminA,
        "task-board",
        "sprint",
      );
      expect(await run(() => publishConfigVersion(adminA, versionId))).toBe(1);
      expect((await object(objectId)).team_id).toBe("cfg-team-a");
      const { versionId: pending } = await draft(
        adminA,
        "task-board",
        "sprint",
      );
      expect(
        await run(() => getConfigObject(owner, "task-board", "sprint")),
      ).toMatchObject({ id: objectId, current: { number: 1 } });
      // A recruiter of the team, and the team owner over an API token.
      for (const p of [recruiterA, ownerToken]) {
        await expect(
          run(() => publishConfigVersion(p, pending)),
        ).rejects.toMatchObject({ status: 403, code: "config_forbidden" });
        expect(
          await sqlAs(
            p,
            `UPDATE app.config_versions SET note = 'Denied' WHERE id = '${pending}' RETURNING id`,
          ),
        ).toEqual([]);
        await refused(
          () =>
            sqlAs(
              p,
              `SELECT tenant_context.publish_config_version('${pending}')`,
            ),
          "42501",
        );
      }
      // Team B's owner, and the company owner working in team B, read and write none of it.
      for (const p of [ownerB, ownerInB]) {
        for (const statement of [
          `SELECT id FROM app.config_objects WHERE id = '${objectId}'`,
          `SELECT id FROM app.config_versions WHERE object_id = '${objectId}'`,
          `UPDATE app.config_objects SET archived_at = now() WHERE id = '${objectId}' RETURNING id`,
          `UPDATE app.config_versions SET note = 'Denied' WHERE id = '${pending}' RETURNING id`,
        ])
          expect(await sqlAs(p, statement), `${p.userId} ${statement}`).toEqual(
            [],
          );
        await refused(
          () =>
            sqlAs(
              p,
              `INSERT INTO app.config_versions(object_id, workspace_id, body) VALUES ('${objectId}', '${COMPANY}', '{"label":"Denied"}')`,
            ),
          "42501",
        );
        await refused(
          () =>
            sqlAs(
              p,
              `SELECT tenant_context.publish_config_version('${pending}')`,
            ),
          "42501",
        );
        expect(
          await run(() => getConfigObject(p, "task-board", "sprint")),
        ).toBeNull();
      }
      // Team B's own board is its owner's, beside team A's under the same key.
      const teamB = await draft(ownerB, "task-board", "sprint");
      expect(
        await run(() => publishConfigVersion(ownerB, teamB.versionId)),
      ).toBe(1);
      expect((await object(teamB.objectId)).team_id).toBe("cfg-team-b");
    });
  });

  describe("configuration history", () => {
    const columns = [
      "action",
      "actor_name",
      "from_version_number",
      "object_key",
      "object_type",
      "occurred_at",
      "version_number",
    ];
    const history = (p: Principal, pageSize = 100) =>
      asContext(
        harness,
        p,
        async (tx) =>
          (
            await tx.execute<Record<string, unknown>>(
              sql`select * from tenant_context.config_history(null, null, ${pageSize}::integer)`,
            )
          ).rows,
      );

    it("returns every team's company events to company owners and admins, without other teams' task boards", async () => {
      const ownerRows = await history(owner);
      const adminRows = await history(fieldsAdmin);
      const boards = (rows: Record<string, unknown>[]) =>
        rows.filter((row) => row.object_type === "task-board");
      // The company admin's team B kind schema and the owner's team A objects, in both.
      for (const rows of [ownerRows, adminRows]) {
        expect(rows.some((row) => row.object_key === "candidate")).toBe(true);
        expect(rows.some((row) => row.object_key === "application")).toBe(true);
      }
      // Task-board events only of the reader's own team: team A's for the owner, team B's for the admin.
      expect(boards(ownerRows).length).toBeGreaterThan(0);
      expect(boards(adminRows).length).toBeGreaterThan(0);
      const boardAudits = (
        await look<{ team_id: string; n: number }>(
          "SELECT team_id, count(*)::int AS n FROM app.activity WHERE kind = 'config' AND metadata->>'type' = 'task-board' GROUP BY team_id ORDER BY team_id",
        )
      ).map((row) => [row.team_id, row.n]);
      expect(boardAudits).toEqual([
        ["cfg-team-a", boards(ownerRows).length],
        ["cfg-team-b", boards(adminRows).length],
      ]);
      const total = (
        await look<{ n: number }>(
          "SELECT count(*)::int AS n FROM app.activity WHERE kind = 'config'",
        )
      )[0].n;
      expect(ownerRows.length + boards(adminRows).length).toBe(total);
      // Newest first, and the service returns the same rows.
      const times = ownerRows.map((row) => String(row.occurred_at));
      expect([...times].sort().reverse()).toEqual(times);
      const listed = await run(() =>
        listConfigHistory(owner, { pageSize: 100 }),
      );
      expect(listed.map((row) => [row.action, row.objectKey])).toEqual(
        ownerRows.map((row) => [row.action, row.object_key]),
      );
      expect(await run(() => listConfigHistory(owner))).toHaveLength(
        Math.min(50, ownerRows.length),
      );
      const page = await run(() =>
        listConfigHistory(owner, {
          before: new Date(String(ownerRows[2].occurred_at)),
          pageSize: 2,
        }),
      );
      expect(page.map((row) => row.occurredAt)).toEqual(
        ownerRows.slice(3, 5).map((row) => row.occurred_at),
      );
    });

    it("returns only time, action, type, key, version numbers and the actor's name", async () => {
      const rows = await history(owner);
      expect(rows.length).toBeGreaterThan(0);
      const ids = new Set(
        (
          await look<{ id: string }>(
            `SELECT id FROM auth.organization UNION SELECT id FROM auth."user"
             UNION SELECT id::text FROM app.config_objects UNION SELECT id::text FROM app.config_versions
             UNION SELECT id::text FROM auth.api_tokens UNION SELECT body::text FROM app.config_versions
             UNION SELECT body->>'label' FROM app.config_versions`,
          )
        ).map((row) => row.id),
      );
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(columns);
        for (const value of Object.values(row))
          expect(ids.has(String(value)), String(value)).toBe(false);
      }
      const application = rows.filter(
        (row) => row.object_key === "application",
      );
      expect(
        application
          .filter((row) => row.action === "config.published")
          .map((row) => [row.version_number, row.from_version_number]),
      ).toEqual([
        [2, 1],
        [1, null],
      ]);
      expect(
        application.every((row) => row.actor_name === "Fictional Test User"),
      ).toBe(true);
    });

    it("refuses a team owner without company authority, a recruiter, a token and an invalid page size", async () => {
      for (const p of [ownerB, recruiterA, ownerToken]) {
        await expect(history(p), p.userId).rejects.toMatchObject({
          cause: { code: "42501" },
        });
        await expect(run(() => listConfigHistory(p))).rejects.toMatchObject({
          status: 403,
          code: "config_forbidden",
        });
      }
      for (const size of [0, 101])
        await expect(history(owner, size)).rejects.toMatchObject({
          cause: { code: "22023" },
        });
      await expect(
        run(() => listConfigHistory(owner, { pageSize: 0 })),
      ).rejects.toBeInstanceOf(z.ZodError);
    });
  });
});

describe("configuration body schemas", () => {
  it("cleans and bounds labels, help text and option values", () => {
    expect(configLabel.parse(`  Fictional${RLO} label${ZWSP}${BEL} `)).toBe(
      "Fictional label",
    );
    expect(configLabel.parse(`${"a".repeat(120)}${ZWSP}`)).toHaveLength(120);
    expect(configLabel.safeParse("a".repeat(121)).success).toBe(false);
    expect(configLabel.safeParse(` ${ZWSP} `).success).toBe(false);
    expect(configHelpText.parse("")).toBe("");
    expect(configHelpText.safeParse("a".repeat(500)).success).toBe(true);
    expect(configHelpText.safeParse("a".repeat(501)).success).toBe(false);
    expect(configOptionValue.safeParse("a".repeat(200)).success).toBe(true);
    expect(configOptionValue.safeParse("a".repeat(201)).success).toBe(false);
  });

  it("refuses any key beyond the envelope, so no record id or value is stored", () => {
    for (const type of CONFIG_TYPES) {
      expect(configBodySchemas[type].parse({ label: " Fictional " })).toEqual({
        label: "Fictional",
      });
      expect(
        configBodySchemas[type].safeParse({
          label: "Fictional",
          recordId: "00000000-0000-4000-a000-000000000009",
        }).success,
      ).toBe(false);
    }
  });
});
