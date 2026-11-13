import { createHash, createHmac, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { setDbForTests, type AppDb, type TeamTx } from "@/db";
import { withDeadlinesAndSnapshot } from "@/db/deadlines";
import {
  CONFIGURABLE_KINDS,
  configBodySchemas,
  configHelpText,
  configLabel,
  configOptionValue,
  CONFIG_TYPES,
  kindSchemaBodySchema,
  type ConfigType,
  type ConfigurableKind,
  type KindSchemaBody,
} from "@/domain/config";
import type { CustomField } from "@/domain/field-types";
import { exportTable } from "@/domain/export";
import { kindSchemaChanges } from "@/domain/kind-schema-changes";
import {
  archiveConfigObject,
  CONFIG_CACHE_BYTES,
  ConfigBodyCache,
  createConfigDraft,
  currentConfigBody,
  getConfigObject,
  kindSchemaFor,
  listConfigHistory,
  listKindSchemas,
  publishConfigVersion,
  retireConfigVersion,
  saveConfigLayout,
  updateConfigDraft,
  type ConfigDocumentRow,
} from "@/lib/config-store";
import {
  DEFAULT_KIND_SCHEMAS,
  HIRING_MANAGER_ROLE,
  RECRUITER_ROLE,
} from "@/domain/config-defaults";
import { SCOPES } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import { createRecord, getRecord, updateRecord } from "@/lib/records";
import { installTenantContext, type TenantAccess } from "@/lib/tenant-context";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";
import { contactBody, customField, kindBody } from "./helpers/kind-schemas";

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
  /** Each team's fixture bucket, the one column of its task-board fixtures (R2a-21). */
  const buckets: Record<string, string> = {};
  const draft = (
    p: Principal,
    type: ConfigType,
    key: string,
    label = `Fictional ${key}`,
  ) =>
    run(() =>
      createConfigDraft(p, {
        type,
        key,
        body:
          type === "task-board"
            ? { name: label, columns: [buckets[p.teamId]] }
            : type === "kind-schema"
              ? kindBody(key as ConfigurableKind, [])
              : { label },
      }),
    );

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
    for (const p of [owner, ownerB])
      buckets[p.teamId] = (
        await run(() =>
          createRecord(p, "buckets", {
            data: { name: "Fictional config to do" },
          }),
        )
      ).id;
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
        "workflow",
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
      const role = await run(() =>
        createConfigDraft(owner, {
          type: "role",
          key: "hiring-manager",
          body: HIRING_MANAGER_ROLE.body,
        }),
      );
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

  describe("configuration versions through install (R2a-05, 0032)", () => {
    type Fixture = { objectId: string; versionId: string };
    type DirectAccess = Omit<TenantAccess, "documents"> & {
      documents: ConfigDocumentRow[];
    };
    let own: Fixture, archived: Fixture, draftOnly: Fixture;
    let retired: Fixture, current: Fixture, teamBoard: Fixture;
    let foreign: Fixture;
    const authority = (access: Record<string, unknown>) =>
      Object.fromEntries(
        [
          "scopes",
          "workspaceId",
          "memberRole",
          "companyLevel",
          "companyAreas",
        ].map((key) => [key, access[key]]),
      );

    /** One data-role install with the given cache, as withTeam runs it. */
    const installWith = (p: Principal, cache: ConfigBodyCache) =>
      harness
        .dataDb()
        .then((db) =>
          withDeadlinesAndSnapshot(db, (tx, snapshot) =>
            installTenantContext(tx, p, snapshot, cache),
          ),
        );
    /** A direct data-role install, signed as installTenantContext signs, with a forged hint. */
    const directInstall = (p: Principal, hint: (string | null)[]) =>
      harness.dataDb().then((db) =>
        withDeadlinesAndSnapshot(db, async (tx, snapshot) => {
          const key = Buffer.from(
            process.env.TENANT_CONTEXT_SIGNING_KEY!,
            "base64url",
          );
          const payload = JSON.stringify({
            aud: "recruitmentos-tenant-context-v1",
            kid: createHash("sha256").update(key).digest("hex").slice(0, 16),
            env: snapshot.env,
            pid: Number(snapshot.pid),
            xid: snapshot.xid,
            team: p.teamId,
            actor: p.userId,
            auth: p.authType,
            token: p.authType === "token" ? (p.tokenId ?? null) : null,
            scopes: SCOPES.filter((scope) => p.scopes.includes(scope)),
            exp: Number(snapshot.now) + 60_000,
          });
          const signature = createHmac("sha256", key)
            .update(payload)
            .digest("hex");
          const { rows } = await tx.execute<{ access: DirectAccess }>(
            sql`select tenant_context.install(${payload}, ${signature}, ${sql.param(hint)}::text[]) as access`,
          );
          return rows[0].access;
        }),
      );
    const published = async (p: Principal, type: ConfigType, key: string) => {
      const fixture = await draft(p, type, key);
      await run(() => publishConfigVersion(p, fixture.versionId));
      return fixture;
    };
    /** The current published versions of a workspace and team, read as the superuser. */
    const expected = async (workspace: string, team: string) =>
      Object.fromEntries(
        (
          await look<{ object: string; version: string }>(
            `SELECT o.id::text AS object, v.id::text AS version FROM app.config_objects o
             JOIN app.config_versions v ON v.id = o.current_version_id AND v.state = 'published'
             WHERE o.workspace_id = $1 AND o.archived_at IS NULL AND (o.team_id IS NULL OR o.team_id = $2)`,
            [workspace, team],
          )
        ).map((row) => [row.object, row.version]),
      );

    beforeAll(async () => {
      own = await published(owner, "workflow", "hint-workflow");
      archived = await published(owner, "board", "hint-archived");
      await run(() => archiveConfigObject(owner, archived.objectId));
      draftOnly = await draft(owner, "template", "hint-draft");
      retired = await published(owner, "template", "hint-retired");
      current = await published(owner, "template", "hint-retired");
      await run(() => retireConfigVersion(owner, retired.versionId));
      teamBoard = await published(ownerB, "task-board", "hint-board");
      // The other workspace's published object, written by the owner as the migration owner would.
      await harness.asOwner();
      const objectId = (
        await harness.client.query<{ id: string }>(
          `INSERT INTO app.config_objects(workspace_id, type, key, created_by) VALUES ('${OTHER}', 'workflow', 'hint-foreign', 'cfg-owner-x') RETURNING id`,
        )
      ).rows[0].id;
      const versionId = (
        await harness.client.query<{ id: string }>(
          `INSERT INTO app.config_versions(object_id, workspace_id, state, number, body, published_at) VALUES ('${objectId}', '${OTHER}', 'published', 1, '{"label":"Fictional foreign published workflow"}', now()) RETURNING id`,
        )
      ).rows[0].id;
      await harness.client.query(
        `UPDATE app.config_objects SET current_version_id = '${versionId}' WHERE id = '${objectId}'`,
      );
      foreign = { objectId, versionId };
    });

    it("returns the current versions of the workspace and the context's own team, with verified bodies", async () => {
      const access = await installWith(owner, new ConfigBodyCache());
      expect(access.versions).toEqual(await expected(COMPANY, owner.teamId));
      expect(access.versions[own.objectId]).toBe(own.versionId);
      expect(access.versions[current.objectId]).toBe(current.versionId);
      for (const absent of [archived, draftOnly, teamBoard, foreign])
        expect(access.versions).not.toHaveProperty(absent.objectId);
      const ids = Object.values(access.versions);
      for (const absent of [retired, draftOnly, teamBoard, foreign])
        expect(ids).not.toContain(absent.versionId);
      expect(Object.keys(access.documents).sort()).toEqual([...ids].sort());
      for (const [objectId, versionId] of Object.entries(access.versions)) {
        const stored = await version(versionId);
        expect(access.documents[versionId]).toMatchObject({
          versionId,
          objectId,
          number: stored.number,
          bodySha256: stored.body_sha256,
          body: stored.body,
        });
      }
      expect(access.documents[own.versionId]).toEqual({
        versionId: own.versionId,
        objectId: own.objectId,
        type: "workflow",
        key: "hint-workflow",
        number: 1,
        bodySha256: (await version(own.versionId)).body_sha256,
        body: { label: "Fictional hint-workflow" },
      });
      // Team B sees its own board and not team A's; the other workspace sees only its own object.
      const teamB = await installWith(ownerB, new ConfigBodyCache());
      expect(teamB.versions).toEqual(await expected(COMPANY, ownerB.teamId));
      expect(teamB.versions[teamBoard.objectId]).toBe(teamBoard.versionId);
      const other = await installWith(ownerX, new ConfigBodyCache());
      expect(other.versions).toEqual({
        [foreign.objectId]: foreign.versionId,
      });
      expect(Object.keys(other.documents)).toEqual([foreign.versionId]);
    });

    it("never returns another workspace's or team's version for a forged hint, and changes no authority", async () => {
      const empty = await directInstall(owner, []);
      const forged = await directInstall(owner, [
        foreign.versionId,
        teamBoard.versionId,
        retired.versionId,
        draftOnly.versionId,
        "fictional-not-a-uuid",
        null,
        own.versionId,
        own.versionId,
      ]);
      for (const result of [empty, forged]) {
        const text = JSON.stringify(result);
        for (const hidden of [
          foreign.versionId,
          foreign.objectId,
          teamBoard.versionId,
          teamBoard.objectId,
          "Fictional foreign published workflow",
          "Fictional hint-board",
        ])
          expect(text).not.toContain(hidden);
      }
      expect(authority(forged)).toEqual(authority(empty));
      expect(authority(empty)).toEqual({
        scopes: owner.scopes,
        workspaceId: COMPANY,
        memberRole: "owner",
        companyLevel: "owner",
        companyAreas: [],
      });
      expect(forged.versions).toEqual(empty.versions);
      // Only the caller's own current version leaves documents; the list stays ordered by id.
      const listed = (result: DirectAccess) =>
        result.documents.map((document) => document.versionId);
      expect(listed(empty)).toEqual(Object.values(empty.versions).sort());
      expect(listed(forged)).toEqual(
        listed(empty).filter((id) => id !== own.versionId),
      );
      // The body is the stored text, so its hash checks byte for byte.
      for (const document of empty.documents)
        expect(
          createHash("sha256").update(document.body, "utf8").digest("hex"),
        ).toBe(document.bodySha256);
      // A token context, and the other workspace's context naming this workspace's version.
      const token = await directInstall(ownerToken, [foreign.versionId]);
      expect(token.versions).toEqual(empty.versions);
      expect(await directInstall(ownerX, [own.versionId])).toMatchObject({
        workspaceId: OTHER,
        versions: { [foreign.objectId]: foreign.versionId },
      });
    });

    it("shows a publish to the next install of two independent caches", async () => {
      const [first, second] = [new ConfigBodyCache(), new ConfigBodyCache()];
      const v1 = await published(owner, "workflow", "hint-visible");
      for (const cache of [first, second]) {
        await installWith(owner, cache);
        expect(cache.ids()).toContain(v1.versionId);
      }
      const v2 = await draft(
        owner,
        "workflow",
        "hint-visible",
        "Fictional visible workflow 2",
      );
      expect(await run(() => publishConfigVersion(owner, v2.versionId))).toBe(
        2,
      );
      const add = vi.spyOn(second, "add");
      for (const cache of [first, second]) {
        const access = await installWith(owner, cache);
        expect(access.versions[v1.objectId]).toBe(v2.versionId);
        expect(access.documents[v2.versionId].body).toEqual({
          label: "Fictional visible workflow 2",
        });
        expect(access.documents).not.toHaveProperty(v1.versionId);
        expect(cache.ids()).toContain(v2.versionId);
      }
      // The second cache had not named version 2 in its hint, so the response carried its body.
      expect(add).toHaveBeenCalledTimes(1);
      expect(add.mock.calls[0].map((row) => row.versionId)).toEqual([
        v2.versionId,
      ]);
    });

    it("asks again for an evicted body and still serves the whole set", async () => {
      const cache = new ConfigBodyCache(64);
      const add = vi.spyOn(cache, "add");
      const first = await installWith(owner, cache);
      const ids = Object.values(first.versions);
      expect(ids.length).toBeGreaterThan(1);
      expect(cache.bytes).toBeLessThanOrEqual(64);
      expect(cache.ids().length).toBeLessThan(ids.length);
      const evicted = ids.filter((id) => !cache.ids().includes(id));
      const second = await installWith(owner, cache);
      expect(second.versions).toEqual(first.versions);
      expect(second.documents).toEqual(first.documents);
      expect(add.mock.calls[1].map((row) => row.versionId)).toEqual(
        expect.arrayContaining(evicted),
      );
    });

    it("gives a company owner's token context the same versions and still refuses every write", async () => {
      const session = await installWith(owner, new ConfigBodyCache());
      const token = await installWith(ownerToken, new ConfigBodyCache());
      expect(token.versions).toEqual(session.versions);
      expect(token.documents).toEqual(session.documents);
      const pending = await draft(owner, "workflow", "hint-workflow");
      for (const call of [
        () =>
          createConfigDraft(ownerToken, {
            type: "workflow",
            key: "hint-token",
            body: { label: "Denied" },
          }),
        () =>
          updateConfigDraft(ownerToken, pending.versionId, {
            body: { label: "Denied" },
          }),
        () => publishConfigVersion(ownerToken, pending.versionId),
        () => retireConfigVersion(ownerToken, retired.versionId),
        () => archiveConfigObject(ownerToken, own.objectId),
        () => saveConfigLayout(ownerToken, pending.versionId, { nodes: [] }),
      ])
        await expect(run<unknown>(call)).rejects.toMatchObject({
          status: 403,
          code: "config_forbidden",
        });
    });

    it("reads the current body from the access state without a statement", async () => {
      const access = await installWith(owner, new ConfigBodyCache());
      const teamB = await installWith(ownerB, new ConfigBodyCache());
      const query = vi.spyOn(harness.client, "query");
      const exec = vi.spyOn(harness.client, "exec");
      try {
        expect(currentConfigBody(access, "workflow", "hint-workflow")).toEqual({
          versionId: own.versionId,
          number: 1,
          body: { label: "Fictional hint-workflow" },
        });
        expect(
          currentConfigBody(access, "template", "hint-retired"),
        ).toMatchObject({ versionId: current.versionId, number: 2 });
        expect(currentConfigBody(access, "board", "hint-archived")).toBeNull();
        expect(currentConfigBody(access, "template", "hint-draft")).toBeNull();
        expect(
          currentConfigBody(access, "task-board", "hint-board"),
        ).toBeNull();
        expect(
          currentConfigBody(teamB, "task-board", "hint-board"),
        ).toMatchObject({ versionId: teamBoard.versionId });
        expect(query).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
      } finally {
        query.mockRestore();
        exec.mockRestore();
      }
    });
  });

  // R2b-09 (job 094): kind schemas written through the store as the Fields page writes them.
  describe("kind schemas through the Fields page (R2b-09)", () => {
    type Field = KindSchemaBody["fields"][number];
    const installed = () =>
      harness
        .dataDb()
        .then((db) =>
          withDeadlinesAndSnapshot(db, (tx, snapshot) =>
            installTenantContext(tx, owner, snapshot, new ConfigBodyCache()),
          ),
        );
    const inForce = async (kind: ConfigurableKind) =>
      structuredClone(kindSchemaFor(await installed(), kind).body);
    const fieldOf = (body: KindSchemaBody, key: string) =>
      body.fields.find((field) => field.key === key) as Field;
    /** Every screen of the body without the key's entries. */
    const unlisted = (body: KindSchemaBody, key: string) => {
      for (const screen of body.screens)
        for (const group of screen.groups)
          group.fields = group.fields.filter((entry) => entry.key !== key);
    };
    const save = (p: Principal, kind: ConfigurableKind, body: unknown) => () =>
      createConfigDraft(p, { type: "kind-schema", key: kind, body });
    /** Runs the call and expects its refusal, with no config row or config audit row changed. */
    async function refusedWith(
      call: () => Promise<unknown>,
      status: number,
      code: string,
      message: string | RegExp,
    ) {
      const before = [await snapshot(), await audits()];
      await expect(run<unknown>(call)).rejects.toMatchObject({
        status,
        code,
        message:
          typeof message === "string"
            ? expect.stringContaining(message)
            : expect.stringMatching(message),
      });
      expect([await snapshot(), await audits()]).toEqual(before);
    }
    /** The candidate draft a migration owner could write through SQL, never checked by the store. */
    async function sqlDraft(body: unknown) {
      await harness.asOwner();
      const [version] = (
        await harness.client.query<{ id: string }>(
          `INSERT INTO app.config_versions(object_id, workspace_id, body) SELECT id, workspace_id, $1::jsonb FROM app.config_objects WHERE workspace_id = '${COMPANY}' AND type = 'kind-schema' AND key = 'candidate' RETURNING id`,
          [JSON.stringify(body)],
        )
      ).rows;
      await harness.client.query(
        `UPDATE app.config_objects SET draft_version_id = $1 WHERE workspace_id = '${COMPANY}' AND type = 'kind-schema' AND key = 'candidate'`,
        [version.id],
      );
      return version.id;
    }
    async function dropDraft(versionId: string) {
      await harness.asOwner();
      await harness.client.query(
        `UPDATE app.config_objects SET draft_version_id = NULL WHERE draft_version_id = $1`,
        [versionId],
      );
      await harness.client.query(
        `DELETE FROM app.config_versions WHERE id = $1`,
        [versionId],
      );
    }
    const notice = customField("Fictional notice note", "short-text", {
      help: "Fictional notice help",
      min: 2,
      max: 40,
      pattern: "[A-Za-z ]+",
      default: "Fictional default",
    });

    it("drafts, renames, regroups, reorders, publishes and archives a custom field as a company admin with fields", async () => {
      const body = await inForce("candidate");
      body.fields.push(notice);
      for (const screen of body.screens)
        screen.groups[0].fields.push({ key: notice.key });
      const { versionId } = await run(save(fieldsAdmin, "candidate", body));
      // Renamed, moved into its own group and the first two fields swapped, on every screen.
      const edited = structuredClone(body);
      fieldOf(edited, notice.key).label = "Fictional notice period note";
      unlisted(edited, notice.key);
      for (const screen of edited.screens) {
        const [first, second, ...rest] = screen.groups[0].fields;
        screen.groups[0].fields = [second, first, ...rest];
        screen.groups.push({
          label: "Fictional notice group",
          fields: [{ key: notice.key }],
        });
      }
      await run(() =>
        updateConfigDraft(fieldsAdmin, versionId, { body: edited }),
      );
      expect(
        await run(() => publishConfigVersion(fieldsAdmin, versionId)),
      ).toBe(2);
      const published = kindSchemaFor(await installed(), "candidate");
      expect(published).toMatchObject({ versionId, number: 2 });
      expect(published.body).toEqual(edited);
      expect(fieldOf(published.body, notice.key)).toEqual({
        ...notice,
        label: "Fictional notice period note",
      });
      const history = await run(() =>
        listConfigHistory(owner, { pageSize: 100 }),
      );
      for (const [action, versionNumber] of [
        ["config.draft_created", null],
        ["config.published", 2],
      ] as const)
        expect(history).toContainEqual(
          expect.objectContaining({
            action,
            objectType: "kind-schema",
            objectKey: "candidate",
            versionNumber,
          }),
        );
      // Archived in a new draft and published: the definition stays, marked archived.
      const archived = structuredClone(published.body);
      Object.assign(fieldOf(archived, notice.key), { archived: true });
      const next = await run(save(fieldsAdmin, "candidate", archived));
      expect(
        await run(() => publishConfigVersion(fieldsAdmin, next.versionId)),
      ).toBe(3);
      expect(fieldOf(await inForce("candidate"), notice.key)).toEqual({
        ...notice,
        label: "Fictional notice period note",
        archived: true,
      });
      // A draft that drops the custom field's key is refused, naming it.
      const dropped = await inForce("candidate");
      dropped.fields = dropped.fields.filter(
        (field) => field.key !== notice.key,
      );
      unlisted(dropped, notice.key);
      for (const screen of dropped.screens)
        screen.groups = screen.groups.filter((group) => group.fields.length);
      await refusedWith(
        save(fieldsAdmin, "candidate", dropped),
        400,
        "invalid_input",
        `${notice.key}: a field cannot be removed; archive it instead.`,
      );
    });

    it("lists the nine kinds with their schema in force and draft in one statement beyond install", async () => {
      const statements = async (call: () => Promise<unknown>) => {
        const query = vi.spyOn(harness.client, "query");
        const exec = vi.spyOn(harness.client, "exec");
        try {
          await run(call);
          return query.mock.calls.length + exec.mock.calls.length;
        } finally {
          query.mockRestore();
          exec.mockRestore();
        }
      };
      await run(() => listKindSchemas(fieldsAdmin));
      const one = await statements(() =>
        getConfigObject(fieldsAdmin, "kind-schema", "candidate"),
      );
      expect(await statements(() => listKindSchemas(fieldsAdmin))).toBe(one);
      const pending = await run(
        save(
          owner,
          "task",
          kindBody("task", [customField("Fictional task note", "number")]),
        ),
      );
      const listed = await run(() => listKindSchemas(fieldsAdmin));
      expect(listed.map((item) => item.kind)).toEqual([...CONFIGURABLE_KINDS]);
      expect(listed[0]).toMatchObject({
        kind: "candidate",
        current: { number: 3, body: await inForce("candidate") },
        draft: null,
      });
      expect(listed.find((item) => item.kind === "vacancy")).toEqual({
        kind: "vacancy",
        current: {
          versionId: DEFAULT_KIND_SCHEMAS.vacancy.versionId,
          number: null,
          body: DEFAULT_KIND_SCHEMAS.vacancy.body,
        },
        draft: null,
      });
      expect(listed.find((item) => item.kind === "task")?.draft).toMatchObject({
        versionId: pending.versionId,
        note: null,
      });
      for (const p of [ownerB, adminA, recruiterA, ownerToken])
        await expect(
          run(() => listKindSchemas(p)),
          p.userId,
        ).rejects.toMatchObject({ status: 403, code: "config_forbidden" });
      await dropDraft(pending.versionId);
    });

    it("refuses removing, retyping, loosening or archiving a system field, and accepts relabelling, help, required and regrouping (FLD-033)", async () => {
      const base = await inForce("candidate");
      const change = (edit: (body: KindSchemaBody) => void) => {
        const body = structuredClone(base);
        edit(body);
        return body;
      };
      const employerRequired = contactBody();
      Object.assign(fieldOf(employerRequired, "employer"), { required: true });
      for (const [body, message] of [
        [
          change((body) => {
            body.fields = body.fields.filter(
              (field) => field.key !== "employer",
            );
            unlisted(body, "employer");
          }),
          "employer: a field cannot be removed; archive it instead.",
        ],
        [
          change((body) =>
            Object.assign(fieldOf(body, "employer"), { type: "textarea" }),
          ),
          /fields\.\d+\.type: A system field keeps its type\./,
        ],
        [
          change((body) =>
            Object.assign(fieldOf(body, "name"), { required: false }),
          ),
          /fields\.0\.required: A required field stays required\./,
        ],
        [
          change((body) =>
            Object.assign(fieldOf(body, "employer"), { archived: true }),
          ),
          /fields\.\d+: Unrecognized key: "archived"/,
        ],
        [
          employerRequired,
          /screens\.0\.groups\.1\.fields\.2\.hidden: A create screen shows every required system field\./,
        ],
      ] as const)
        await refusedWith(
          save(fieldsAdmin, "candidate", body),
          400,
          "invalid_input",
          message,
        );
      const accepted = change((body) => {
        Object.assign(fieldOf(body, "employer"), {
          label: "Fictional employer label",
          help: "Fictional employer help",
          required: true,
        });
        unlisted(body, "employer");
        for (const screen of body.screens)
          screen.groups.push({
            label: "Fictional work group",
            fields: [{ key: "employer" }],
          });
      });
      const { versionId } = await run(save(fieldsAdmin, "candidate", accepted));
      expect(
        await run(() => publishConfigVersion(fieldsAdmin, versionId)),
      ).toBe(4);
      const now = await inForce("candidate");
      expect(fieldOf(now, "employer")).toMatchObject({
        system: true,
        label: "Fictional employer label",
        help: "Fictional employer help",
        type: "text",
        required: true,
      });
      expect(now.screens.map((screen) => screen.groups.at(-1))).toEqual(
        now.screens.map(() => ({
          label: "Fictional work group",
          fields: [{ key: "employer" }],
        })),
      );
    });

    it("checks a draft again at publish, and keeps custom fields off a create screen's mandatory fields at save and publish", async () => {
      const base = await inForce("candidate");
      // Written as the owner through SQL: name hidden on the create screen.
      const broken = structuredClone(base);
      for (const group of broken.screens.find(
        (screen) => screen.action === "create",
      )!.groups)
        for (const entry of group.fields)
          if (entry.key === "name") entry.hidden = true;
      const brokenId = await sqlDraft(broken);
      await refusedWith(
        () => publishConfigVersion(owner, brokenId),
        400,
        "invalid_input",
        /screens\.0\.groups\.0\.fields\.\d+\.hidden: A create screen shows every required system field\./,
      );
      await dropDraft(brokenId);
      const start = customField("Fictional start note", "short-text");
      const withStart = (
        field: Record<string, unknown>,
        entry: Record<string, unknown> = {},
      ) => {
        const body = structuredClone(base);
        body.fields.push({ ...start, ...field } as Field);
        for (const screen of body.screens)
          screen.groups[0].fields.push({
            key: start.key,
            ...(screen.action === "create" ? entry : {}),
          });
        return body;
      };
      const reason = `${start.key}: custom fields cannot be required on a create screen yet.`;
      const required = withStart({ required: true });
      for (const body of [required, withStart({}, { mandatory: true })])
        await refusedWith(
          save(fieldsAdmin, "candidate", body),
          400,
          "invalid_input",
          reason,
        );
      const requiredId = await sqlDraft(required);
      await refusedWith(
        () => publishConfigVersion(owner, requiredId),
        400,
        "invalid_input",
        reason,
      );
      await dropDraft(requiredId);
      // Hidden on create, or archived, it is not mandatory there.
      for (const body of [
        withStart({ required: true }, { hidden: true }),
        withStart({ required: true, archived: true }),
      ]) {
        const { versionId } = await run(save(fieldsAdmin, "candidate", body));
        await dropDraft(versionId);
      }
    });

    it("lets only a company owner mark a field sensitive or remove the mark, at save and at publish", async () => {
      const secret = customField("Fictional offer secret", "short-text");
      const marked = { ...secret, sensitive: true } as unknown as CustomField;
      const forbidden =
        "Only a company owner can mark a field sensitive or remove the mark.";
      await refusedWith(
        save(fieldsAdmin, "offer", kindBody("offer", [marked])),
        403,
        "config_forbidden",
        forbidden,
      );
      const first = await run(
        save(owner, "offer", kindBody("offer", [marked])),
      );
      expect(
        await run(() => publishConfigVersion(owner, first.versionId)),
      ).toBe(1);
      expect(fieldOf(await inForce("offer"), secret.key)).toMatchObject({
        sensitive: true,
      });
      await refusedWith(
        save(fieldsAdmin, "offer", kindBody("offer", [secret])),
        403,
        "config_forbidden",
        forbidden,
      );
      // The owner drafts a second sensitive field; the admin cannot publish that draft.
      const second = {
        ...customField("Fictional second secret", "number"),
        sensitive: true,
      } as unknown as CustomField;
      const draftBody = kindBody("offer", [marked, second]);
      const pending = await run(save(owner, "offer", draftBody));
      await refusedWith(
        () => publishConfigVersion(fieldsAdmin, pending.versionId),
        403,
        "config_forbidden",
        forbidden,
      );
      // The admin edits that draft without touching the marks, but cannot unmark in it.
      const renamed = structuredClone(draftBody);
      fieldOf(renamed, second.key).label = "Fictional renamed secret";
      await run(() =>
        updateConfigDraft(fieldsAdmin, pending.versionId, { body: renamed }),
      );
      const unmarked = structuredClone(renamed);
      Object.assign(fieldOf(unmarked, second.key), { sensitive: false });
      await refusedWith(
        () =>
          updateConfigDraft(fieldsAdmin, pending.versionId, {
            body: unmarked,
          }),
        403,
        "config_forbidden",
        forbidden,
      );
      expect(
        await run(() => publishConfigVersion(owner, pending.versionId)),
      ).toBe(2);
      expect(fieldOf(await inForce("offer"), second.key)).toMatchObject({
        label: "Fictional renamed secret",
        sensitive: true,
      });
      // A sensitive candidate field stays sensitive, whoever writes the draft.
      const gender = await inForce("candidate");
      Object.assign(fieldOf(gender, "explicitGender"), { sensitive: false });
      expect(kindSchemaBodySchema.safeParse(gender).success).toBe(false);
      await refusedWith(
        save(owner, "candidate", gender),
        400,
        "invalid_input",
        /fields\.\d+\.sensitive: A sensitive field stays sensitive\./,
      );
      expect(
        Object.values(DEFAULT_KIND_SCHEMAS).flatMap(({ key, body }) =>
          body.fields
            .filter((field) => field.sensitive)
            .map((field) => `${key}.${field.key}`),
        ),
      ).toEqual([
        "candidate.nationalServiceStatus",
        "candidate.explicitGender",
      ]);
    });

    // R2b-09 (job 096): the publish re-check reads the body it publishes under a row lock.
    it("locks a kind schema draft after the write check and never publishes a mark the admin changed", async () => {
      /** The statements the call's transactions send to the PGlite client, in order. */
      const statements = async (call: () => Promise<unknown>) => {
        const texts: string[] = [];
        const transaction = harness.client.transaction.bind(harness.client);
        const spy = vi
          .spyOn(harness.client, "transaction")
          .mockImplementation((work) =>
            transaction((tx) =>
              work(
                new Proxy(tx, {
                  get: (target, key) => {
                    const value = Reflect.get(target, key);
                    return key === "query" || key === "exec"
                      ? (text: string, ...rest: unknown[]) => {
                          texts.push(text);
                          return value.call(target, text, ...rest);
                        }
                      : value;
                  },
                }),
              ),
            ),
          );
        try {
          await run(call);
          return texts;
        } finally {
          spy.mockRestore();
        }
      };
      const lock =
        /^select body, state from app\.config_versions where id = .+ for update$/;
      const first = await run(
        save(owner, "interview", kindBody("interview", [])),
      );
      const texts = await statements(() =>
        publishConfigVersion(owner, first.versionId),
      );
      const found = texts.findIndex((text) =>
        text.includes("from app.config_versions v join app.config_objects o"),
      );
      const locked = texts.findIndex((text) => lock.test(text));
      const published = texts.findIndex((text) =>
        text.includes("tenant_context.publish_config_version"),
      );
      expect(found).toBeGreaterThanOrEqual(0);
      expect(locked).toBeGreaterThan(found);
      expect(published).toBeGreaterThan(locked);
      expect((await version(first.versionId)).state).toBe("published");

      // The admin publishes the owner's draft while the owner marks a field in it.
      const note = customField("Fictional race note", "short-text");
      const pending = await run(
        save(owner, "interview", kindBody("interview", [note])),
      );
      // Neither a team admin nor a company admin without fields locks or publishes it.
      await harness.asOwner();
      await harness.client.exec(
        `INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${COMPANY}','cfg-recruiter-a','admin','{organisation}')`,
      );
      try {
        for (const p of [adminA, recruiterA]) {
          const before = [await snapshot(), await audits()];
          const refusal = await statements(() =>
            expect(
              publishConfigVersion(p, pending.versionId),
            ).rejects.toMatchObject({ status: 403, code: "config_forbidden" }),
          );
          expect(
            refusal.some((text) => lock.test(text)),
            p.userId,
          ).toBe(false);
          expect([await snapshot(), await audits()]).toEqual(before);
        }
      } finally {
        await harness.asOwner();
        await harness.client.exec(
          `DELETE FROM app.workspace_admins WHERE user_id = 'cfg-recruiter-a'`,
        );
      }
      await harness.dataDb();
      const [publish, update] = await Promise.allSettled([
        publishConfigVersion(fieldsAdmin, pending.versionId),
        updateConfigDraft(owner, pending.versionId, {
          body: kindBody("interview", [
            { ...note, sensitive: true } as unknown as CustomField,
          ]),
        }),
      ]);
      if (publish.status === "fulfilled") {
        expect(update).toMatchObject({
          status: "rejected",
          reason: { status: 409, code: "config_state_conflict" },
        });
      } else {
        expect(publish.reason).toMatchObject({
          status: 403,
          code: "config_forbidden",
        });
        expect(update.status).toBe("fulfilled");
        await dropDraft(pending.versionId);
      }
      const marked = await look<{ count: number }>(
        `SELECT count(*)::int AS count FROM app.config_versions v JOIN app.config_objects o ON o.id = v.object_id WHERE o.workspace_id = '${COMPANY}' AND o.type = 'kind-schema' AND o.key = 'interview' AND v.state <> 'draft' AND v.body::text LIKE '%"sensitive": true%'`,
      );
      expect(marked).toEqual([{ count: 0 }]);
    });

    it("refuses a kind schema whose kind is not its key", async () => {
      await refusedWith(
        save(owner, "checklist", kindBody("task", [])),
        400,
        "invalid_input",
        "kind: a kind schema's kind is its key, checklist.",
      );
    });

    // ADM-29 (job 100): a field's context is its kind and optionally some of its types, never a
    // team; options change by id, and stored values keep their option ids.
    describe("field contexts and options (ADM-29)", () => {
      const TYPE = "00000000-0000-4000-a000-0000000000c1";
      const options = [
        { id: "fictional-low", label: "Fictional low" },
        { id: "fictional-mid", label: "Fictional mid" },
        { id: "fictional-high", label: "Fictional high" },
      ];
      const level = customField("Fictional context level", "dropdown", {
        options,
      });
      const typed = customField("Fictional typed note", "short-text", {
        types: [TYPE],
      });
      const candidates = async () =>
        (
          await look<{ n: number }>(
            "SELECT count(*)::int AS n FROM app.records WHERE kind = 'candidate'",
          )
        )[0].n;
      const stored = async (recordId: string) =>
        (
          await look<{ data: string }>(
            "SELECT data::text AS data FROM app.records WHERE id = $1",
            [recordId],
          )
        )[0].data;
      /** The candidate in force with the level field's options replaced. */
      const withLevel = async (
        next: Record<string, unknown>[],
        extra: Record<string, unknown> = {},
      ) => {
        const body = await inForce("candidate");
        Object.assign(fieldOf(body, level.key), { options: next, ...extra });
        return body;
      };
      // The candidate in force makes employer required (see the system field case above).
      const create = (
        p: Principal,
        name: string,
        values: Record<string, unknown>,
      ) =>
        run(() =>
          createRecord(p, "candidates", {
            data: {
              name,
              employer: "Fictional Employer",
              customValues: values,
            },
          }),
        );
      let first = "";
      let second = "";
      let auditFrom = 0;

      it("saves and publishes a field limited to a record type, and refuses a team, a second context and a duplicate type", async () => {
        auditFrom = (await audits()).length;
        const body = await inForce("candidate");
        body.fields.push(level, typed);
        for (const screen of body.screens)
          screen.groups[0].fields.push({ key: level.key }, { key: typed.key });
        const { versionId } = await run(save(fieldsAdmin, "candidate", body));
        expect(
          await run(() => publishConfigVersion(fieldsAdmin, versionId)),
        ).toBe(5);
        const now = await inForce("candidate");
        expect(fieldOf(now, typed.key)).toEqual(typed);
        expect(fieldOf(now, level.key)).not.toHaveProperty("types");
        const base = await inForce("candidate");
        const change = (edit: (body: KindSchemaBody) => void) => {
          const copy = structuredClone(base);
          edit(copy);
          return copy;
        };
        for (const [body, message] of [
          [
            change((copy) =>
              Object.assign(fieldOf(copy, typed.key), { types: [TYPE, TYPE] }),
            ),
            /fields\.\d+\.types: A record type can be listed only once\./,
          ],
          [
            change((copy) =>
              Object.assign(fieldOf(copy, "employer"), { types: [TYPE] }),
            ),
            /fields\.\d+: Unrecognized key: "types"/,
          ],
          ...["team", "teamId", "teams", "contexts"].map(
            (key) =>
              [
                change((copy) =>
                  Object.assign(fieldOf(copy, level.key), {
                    [key]: key === "teams" || key === "contexts" ? [] : "x",
                  }),
                ),
                new RegExp(`fields\\.\\d+: Unrecognized key: "${key}"`),
              ] as const,
          ),
          [
            change((copy) =>
              copy.fields.push({ ...level, label: "Fictional second context" }),
            ),
            /fields\.\d+\.key: Field keys must be unique\./,
          ],
        ] as const)
          await refusedWith(
            save(fieldsAdmin, "candidate", body),
            400,
            "invalid_input",
            message,
          );
        // Records have no type until R2b-11, so a type-limited field takes no new value.
        const count = await candidates();
        await expect(
          create(owner, "Fictional Typed Candidate", {
            [typed.key]: "Fictional typed value",
          }),
        ).rejects.toMatchObject({
          status: 400,
          code: "invalid_custom_value",
          message: `${typed.label} does not apply to this record type.`,
        });
        expect(await candidates()).toBe(count);
      });

      it("adds, renames, reorders and disables options by id, keeping every stored value, and refuses removing one", async () => {
        first = (
          await create(owner, "Fictional Option Holder", {
            [level.key]: "fictional-mid",
          })
        ).id;
        second = (
          await create(owner, "Fictional Disabled Holder", {
            [level.key]: "fictional-high",
          })
        ).id;
        const before = await stored(first);
        // Added, renamed, the last option moved first and disabled: one draft, one publish.
        const edited = [
          { id: "fictional-high", label: "Fictional high", disabled: true },
          { id: "fictional-low", label: "Fictional low" },
          { id: "fictional-mid", label: "Fictional middle" },
          { id: "fictional-new", label: "Fictional new" },
        ];
        const { versionId } = await run(
          save(fieldsAdmin, "candidate", await withLevel(edited)),
        );
        // Removing an option, or changing its id, is refused at save.
        const removed = `${level.key}: an option cannot be removed; disable it instead.`;
        for (const next of [
          edited.slice(1),
          [{ ...edited[0], id: "fictional-top" }, ...edited.slice(1)],
        ]) {
          const body = await withLevel(next);
          await refusedWith(
            () => updateConfigDraft(fieldsAdmin, versionId, { body }),
            400,
            "invalid_input",
            removed,
          );
        }
        expect(
          await run(() => publishConfigVersion(fieldsAdmin, versionId)),
        ).toBe(6);
        expect(fieldOf(await inForce("candidate"), level.key)).toMatchObject({
          options: edited,
        });
        // The record created before the rename holds the same id, byte for byte.
        expect(await stored(first)).toBe(before);
        expect(
          (await run(() => getRecord(owner, "candidates", first))).data,
        ).toMatchObject({ customValues: { [level.key]: "fictional-mid" } });
        // And at publish, for a draft the owner wrote through SQL.
        const sqlId = await sqlDraft(await withLevel(edited.slice(0, 3)));
        await refusedWith(
          () => publishConfigVersion(owner, sqlId),
          400,
          "invalid_input",
          removed,
        );
        await dropDraft(sqlId);
        // A disabled option is no default.
        await refusedWith(
          save(
            fieldsAdmin,
            "candidate",
            await withLevel(edited, { default: "fictional-high" }),
          ),
          400,
          "invalid_input",
          /fields\.\d+\.default: The default cannot be a disabled option\./,
        );
      });

      it("refuses a disabled option on new values, keeps it on records that hold it, and exports its id", async () => {
        const offered =
          "Fictional context level no longer offers Fictional high.";
        const count = await candidates();
        await expect(
          create(owner, "Fictional New Holder", {
            [level.key]: "fictional-high",
          }),
        ).rejects.toMatchObject({
          status: 400,
          code: "invalid_custom_value",
          message: offered,
        });
        expect(await candidates()).toBe(count);
        const firstBefore = await stored(first);
        await expect(
          run(() =>
            updateRecord(owner, "candidates", first, {
              version: 1,
              data: { customValues: { [level.key]: "fictional-high" } },
            }),
          ),
        ).rejects.toMatchObject({
          status: 400,
          code: "invalid_custom_value",
          message: offered,
        });
        expect(await stored(first)).toBe(firstBefore);
        // The record that held it before it was disabled: another field, then the same value again.
        const phone = await run(() =>
          updateRecord(owner, "candidates", second, {
            version: 1,
            data: { phone: "+971 50 222 2222" },
          }),
        );
        expect(phone.data).toMatchObject({
          customValues: { [level.key]: "fictional-high" },
        });
        await run(() =>
          updateRecord(owner, "candidates", second, {
            version: phone.version,
            data: { customValues: { [level.key]: "fictional-high" } },
          }),
        );
        const got = await run(() => getRecord(owner, "candidates", second));
        expect(got.data).toMatchObject({
          customValues: { [level.key]: "fictional-high" },
        });
        const body = await inForce("candidate");
        const table = exportTable("candidates", [got], new Set(), body);
        expect(table.rows[0][table.headers.indexOf(level.label)]).toBe(
          "fictional-high",
        );
        // An enabled option, renamed or new, is accepted on create and edit.
        await create(owner, "Fictional New Option Holder", {
          [level.key]: "fictional-new",
        });
        const moved = await run(() =>
          updateRecord(owner, "candidates", first, {
            version: 1,
            data: { customValues: { [level.key]: "fictional-low" } },
          }),
        );
        expect(moved.data).toMatchObject({
          customValues: { [level.key]: "fictional-low" },
        });
      });

      it("refuses an option change to team owners, team admins and company admins without fields", async () => {
        const current = fieldOf(
          await inForce("candidate"),
          level.key,
        ) as Extract<Field, { type: "dropdown" }>;
        const next = await withLevel(
          current.options.map((option) => ({
            ...option,
            label: `${option.label} renamed`,
          })),
        );
        const { versionId } = await run(save(owner, "candidate", next));
        await harness.asOwner();
        await harness.client.exec(
          `INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES ('${COMPANY}','cfg-recruiter-a','admin','{organisation}')`,
        );
        try {
          for (const p of [ownerB, adminA, recruiterA])
            await refusedWith(
              () => updateConfigDraft(p, versionId, { body: next }),
              403,
              "config_forbidden",
              "You do not have company authority to change this configuration.",
            );
        } finally {
          await harness.asOwner();
          await harness.client.exec(
            `DELETE FROM app.workspace_admins WHERE user_id = 'cfg-recruiter-a'`,
          );
        }
        await dropDraft(versionId);
      });

      it("audits the context and option changes only as draft_created and published, with ids and numbers", async () => {
        const rows = (await audits()).slice(auditFrom);
        expect([...new Set(rows.map((row) => row.action))].sort()).toEqual([
          "config.draft_created",
          "config.published",
        ]);
        for (const row of rows) {
          expect(Object.keys(row.metadata).sort()).toEqual([
            "fromVersionId",
            "key",
            "number",
            "objectId",
            "type",
            "versionId",
            "workspaceId",
          ]);
          const text = JSON.stringify(row);
          for (const label of [
            ...options.map((option) => option.label),
            "Fictional middle",
            "Fictional new",
            level.label,
            typed.label,
            "Fictional Option Holder",
          ])
            expect(text).not.toContain(label);
        }
      });
    });
  });

  describe("the kind schema in force (R2b-01)", () => {
    it("returns a published kind schema, else the compiled default, and refuses an invalid one, without a statement", async () => {
      const empty = (access: TenantAccess): TenantAccess => ({
        ...access,
        versions: {},
        documents: {},
      });
      const before = await harness
        .dataDb()
        .then((db) =>
          withDeadlinesAndSnapshot(db, (tx, snapshot) =>
            installTenantContext(tx, owner, snapshot, new ConfigBodyCache()),
          ),
        );
      const compiled = kindSchemaFor(empty(before), "job-role");
      const body = structuredClone(compiled.body);
      body.fields[1].label = "Fictional business unit";
      // The workspace's published job-role kind schema, written by the owner as an admin writer would.
      await harness.asOwner();
      const objectId = (
        await harness.client.query<{ id: string }>(
          `INSERT INTO app.config_objects(workspace_id, type, key, created_by) VALUES ('${COMPANY}', 'kind-schema', 'job-role', 'cfg-owner') RETURNING id`,
        )
      ).rows[0].id;
      const versionId = (
        await harness.client.query<{ id: string }>(
          `INSERT INTO app.config_versions(object_id, workspace_id, state, number, body, published_at) VALUES ($1, '${COMPANY}', 'published', 1, $2::jsonb, now()) RETURNING id`,
          [objectId, JSON.stringify(body)],
        )
      ).rows[0].id;
      await harness.client.query(
        `UPDATE app.config_objects SET current_version_id = '${versionId}' WHERE id = '${objectId}'`,
      );
      // An envelope body published as candidate's next version, as an admin writer could before
      // R2b-09; it is no kind schema.
      const envelope = (
        await harness.client.query<{ id: string; object: string }>(
          `INSERT INTO app.config_versions(object_id, workspace_id, state, number, body, published_at) SELECT o.id, o.workspace_id, 'published', (SELECT max(number) + 1 FROM app.config_versions WHERE object_id = o.id), '{"label":"Fictional candidate"}'::jsonb, now() FROM app.config_objects o WHERE o.workspace_id = '${COMPANY}' AND o.type = 'kind-schema' AND o.key = 'candidate' RETURNING id, object_id AS object`,
        )
      ).rows[0];
      await harness.client.query(
        `UPDATE app.config_objects SET current_version_id = '${envelope.id}' WHERE id = '${envelope.object}'`,
      );
      const access = await harness
        .dataDb()
        .then((db) =>
          withDeadlinesAndSnapshot(db, (tx, snapshot) =>
            installTenantContext(tx, owner, snapshot, new ConfigBodyCache()),
          ),
        );
      const query = vi.spyOn(harness.client, "query");
      const exec = vi.spyOn(harness.client, "exec");
      try {
        const jobRole = kindSchemaFor(access, "job-role");
        expect(jobRole).toEqual({ versionId, number: 1, body });
        expect(jobRole.versionId).not.toBe(compiled.versionId);
        expect(jobRole.body.fields[1]).toMatchObject({
          key: "department",
          label: "Fictional business unit",
        });
        expect(kindSchemaFor(access, "vacancy")).toEqual({
          versionId: "00000000-0000-4000-8000-000000000203",
          number: 1,
          body: kindSchemaFor(empty(access), "vacancy").body,
        });
        // The envelope body published for candidate above is no kind schema.
        expect(currentConfigBody(access, "kind-schema", "candidate")).not.toBe(
          null,
        );
        expect(() => kindSchemaFor(access, "candidate")).toThrow(Error);
        expect(query).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
      } finally {
        query.mockRestore();
        exec.mockRestore();
      }
    });
  });
});

describe("configuration body cache", () => {
  /** A fictional document row whose hash matches its body text. */
  const row = (body: string): ConfigDocumentRow => ({
    versionId: randomUUID(),
    objectId: randomUUID(),
    type: "workflow",
    key: "fictional",
    number: 1,
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    body,
  });
  /** A body of exactly this many UTF-8 bytes. */
  const sized = (bytes: number) =>
    JSON.stringify({ label: "x".repeat(bytes - 12) });

  it("keys entries by version id and checks the hash and shape of every body on entry", () => {
    const cache = new ConfigBodyCache();
    const good = row('{"label": "Fictional"}');
    expect(cache.add(good)[0]).toMatchObject({
      versionId: good.versionId,
      body: { label: "Fictional" },
    });
    expect(cache.ids()).toEqual([good.versionId]);
    expect(cache.entries().get(good.versionId)?.body).toEqual({
      label: "Fictional",
    });
    const before = cache.bytes;
    for (const bad of [
      { ...row('{"label": "Fictional"}'), bodySha256: "0".repeat(64) },
      { ...row('{"label": "Fictional"}'), body: '{"label": "Forged"}' },
      row('["Fictional"]'),
      row("null"),
      row("not json"),
    ]) {
      expect(() => cache.add(bad)).toThrow();
      // One bad row refuses the whole batch, so the good row beside it is not stored either.
      const beside = row('{"label": "Fictional beside"}');
      expect(() => cache.add(beside, bad)).toThrow();
      expect(cache.ids()).toEqual([good.versionId]);
      expect(cache.bytes).toBe(before);
    }
  });

  it("stays at or under 8 MiB while about 500 KiB bodies are added past it", () => {
    const cache = new ConfigBodyCache();
    expect(cache.cap).toBe(CONFIG_CACHE_BYTES);
    expect(CONFIG_CACHE_BYTES).toBe(8_388_608);
    const added: string[] = [];
    for (let index = 0; index < 24; index++) {
      const entry = row(sized(512_000));
      cache.add(entry);
      added.push(entry.versionId);
      expect(cache.bytes).toBeLessThanOrEqual(CONFIG_CACHE_BYTES);
    }
    // 16 bodies of 512,000 bytes fit; the eight least recently used went first.
    expect(cache.ids()).toEqual(added.slice(8));
    expect(cache.bytes).toBe(16 * 512_000);
    // A body larger than the cap is returned but never stored.
    const huge = row(sized(CONFIG_CACHE_BYTES + 1));
    expect(cache.add(huge)).toHaveLength(1);
    expect(cache.ids()).not.toContain(huge.versionId);
    expect(cache.bytes).toBe(16 * 512_000);
  });

  it("evicts the least recently used entry first; a used entry survives", () => {
    const cache = new ConfigBodyCache(300);
    const [a, b, c, d] = [1, 2, 3, 4].map(() => row(sized(100)));
    cache.add(a, b, c);
    cache.use(a.versionId);
    cache.add(d);
    expect(cache.ids()).toEqual([c.versionId, a.versionId, d.versionId]);
    expect(cache.bytes).toBe(300);
    cache.use(b.versionId);
    expect(cache.ids()).not.toContain(b.versionId);
    cache.clear();
    expect([cache.ids(), cache.bytes]).toEqual([[], 0]);
  });

  it("fails the install closed and caches nothing for a bad hash, a missing body or another object's body", async () => {
    const principal: Principal = {
      userId: "cfg-fake-owner",
      teamId: "cfg-fake-team",
      role: "owner",
      scopes: [],
      authType: "session",
    };
    const snapshot = { pid: 1, xid: "1", env: randomUUID(), now: "0" };
    /** A transaction whose one statement returns this install result. */
    const returning = (versions: object, documents: ConfigDocumentRow[]) =>
      ({
        execute: () =>
          Promise.resolve({
            rows: [
              {
                access: {
                  scopes: [],
                  workspaceId: COMPANY,
                  memberRole: "owner",
                  companyLevel: null,
                  companyAreas: [],
                  versions,
                  documents,
                },
              },
            ],
          }),
      }) as unknown as TeamTx;
    const good = row('{"label": "Fictional"}');
    const held = row('{"label": "Fictional held"}');
    const bad = row('{"label": "Fictional bad"}');
    const cases: [object, ConfigDocumentRow[]][] = [
      // A body that does not match its hash, beside a good one.
      [
        { [good.objectId]: good.versionId, [bad.objectId]: bad.versionId },
        [good, { ...bad, bodySha256: "0".repeat(64) }],
      ],
      // A current version with no body from the response or the cache.
      [
        { [good.objectId]: good.versionId, [randomUUID()]: randomUUID() },
        [good],
      ],
      // A body of another object under this object's version.
      [{ [randomUUID()]: good.versionId }, [good]],
      // A cached body of another object.
      [{ [randomUUID()]: held.versionId }, []],
    ];
    for (const [versions, documents] of cases) {
      const cache = new ConfigBodyCache();
      cache.add(held);
      await expect(
        installTenantContext(
          returning(versions, documents),
          principal,
          snapshot,
          cache,
        ),
      ).rejects.toThrow(Error);
      expect(cache.ids()).toEqual([held.versionId]);
    }
    // The same set, complete and verified, is served from the response and the cache.
    const cache = new ConfigBodyCache();
    cache.add(held);
    const access = await installTenantContext(
      returning(
        { [good.objectId]: good.versionId, [held.objectId]: held.versionId },
        [good],
      ),
      principal,
      snapshot,
      cache,
    );
    expect(Object.keys(access.documents).sort()).toEqual(
      [good.versionId, held.versionId].sort(),
    );
    // Adding and using both count as use: the held entry was used last.
    expect(cache.ids()).toEqual([good.versionId, held.versionId]);
  });

  it("freezes cached bodies so no caller can change them", () => {
    const cache = new ConfigBodyCache();
    const entry = row(
      '{"label": "Fictional", "nested": {"options": ["Fictional option"]}}',
    );
    const [document] = cache.add(entry);
    const body = document.body as {
      label: string;
      nested: { options: string[] };
    };
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(body.nested.options)).toBe(true);
    expect(() => {
      body.label = "Changed";
    }).toThrow(TypeError);
    expect(() => body.nested.options.push("Changed")).toThrow(TypeError);
    expect(cache.entries().get(entry.versionId)?.body).toEqual({
      label: "Fictional",
      nested: { options: ["Fictional option"] },
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
    // Kind schemas, roles, task boards, the job architecture (job-architecture.test.ts) and
    // branding (branding.test.ts) have their own bodies.
    for (const type of CONFIG_TYPES.filter(
      (type) =>
        type !== "kind-schema" &&
        type !== "role" &&
        type !== "task-board" &&
        type !== "job-architecture" &&
        type !== "branding",
    )) {
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
    // A kind schema body is strict on every level, with its own fixture body (R2b-09).
    expect(
      configBodySchemas["kind-schema"].parse(kindBody("checklist", [])),
    ).toEqual(kindBody("checklist", []));
    expect(
      configBodySchemas["kind-schema"].safeParse({
        ...kindBody("checklist", []),
        recordId: "00000000-0000-4000-a000-000000000009",
      }).success,
    ).toBe(false);
    // A task-board body is strict too, with its own fixture body (R2a-21).
    const board = {
      name: " Fictional ",
      columns: ["00000000-0000-4000-a000-000000000008"],
    };
    expect(configBodySchemas["task-board"].parse(board)).toEqual({
      ...board,
      name: "Fictional",
    });
    expect(
      configBodySchemas["task-board"].safeParse({
        ...board,
        recordId: "00000000-0000-4000-a000-000000000009",
      }).success,
    ).toBe(false);
    // A role body is strict on every level too (R2a-10).
    expect(
      configBodySchemas.role.parse({
        ...RECRUITER_ROLE.body,
        name: " Fictional ",
      }),
    ).toEqual({ ...RECRUITER_ROLE.body, name: "Fictional" });
    expect(
      configBodySchemas.role.safeParse({
        ...RECRUITER_ROLE.body,
        recordId: "00000000-0000-4000-a000-000000000009",
      }).success,
    ).toBe(false);
  });
});

// R2b-09 (job 094): the publish summary, pure.
describe("kind schema changes", () => {
  const a = customField("Fictional first note", "short-text");
  const b = customField("Fictional second note", "number");
  const c = customField("Fictional third note", "date");
  const e = customField("Fictional fifth note", "checkbox");
  const f = customField("Fictional sixth note", "email");
  const d = customField("Fictional added note", "url");
  const before = kindBody("task", [a, b, c, e, f]);
  const fieldOf = (body: KindSchemaBody, key: string) =>
    body.fields.find((field) => field.key === key)!;
  const ref = (field: { key: string; label: string }) => ({
    key: field.key,
    label: field.label,
  });

  it("lists each changed field under every category that applies, in body order", () => {
    const after = structuredClone(before);
    Object.assign(fieldOf(after, a.key), {
      label: "Fictional renamed note",
      help: "Fictional help",
    });
    Object.assign(fieldOf(after, b.key), { archived: true });
    Object.assign(fieldOf(after, e.key), { sensitive: true });
    Object.assign(fieldOf(after, "dueDate"), { required: true });
    const edit = after.screens.find((screen) => screen.action === "edit")!;
    edit.groups[0].fields = edit.groups[0].fields.filter(
      (entry) => entry.key !== c.key,
    );
    edit.groups.push({ label: "Fictional group", fields: [{ key: c.key }] });
    for (const entry of edit.groups[0].fields)
      if (entry.key === f.key) entry.mandatory = true;
    after.fields.push(d);
    for (const screen of after.screens)
      screen.groups[0].fields.push({ key: d.key });
    expect(kindSchemaChanges(before, after)).toEqual({
      added: [ref(d)],
      renamed: [{ key: a.key, label: "Fictional renamed note" }],
      archived: [ref(b)],
      regrouped: [ref(c)],
      madeMandatory: [ref(fieldOf(after, "dueDate")), ref(f)],
      madeSensitive: [ref(e)],
      other: [{ key: a.key, label: "Fictional renamed note" }],
    });
  });

  it("names a changed order, a removed mark, a field made optional and a field taken off a screen as other", () => {
    const marked = structuredClone(before);
    Object.assign(fieldOf(marked, e.key), { sensitive: true });
    for (const entry of marked.screens[0].groups[0].fields)
      if (entry.key === f.key) entry.mandatory = true;
    const after = structuredClone(marked);
    Object.assign(fieldOf(after, e.key), { sensitive: false });
    for (const entry of after.screens[0].groups[0].fields)
      if (entry.key === f.key) entry.mandatory = false;
    const view = after.screens.find((screen) => screen.action === "view")!;
    view.groups[0].fields = view.groups[0].fields.filter(
      (entry) => entry.key !== b.key,
    );
    const fields = after.screens[1].groups[0].fields;
    const [x, y] = [
      fields.findIndex((entry) => entry.key === "title"),
      fields.findIndex((entry) => entry.key === "context"),
    ];
    [fields[x], fields[y]] = [fields[y], fields[x]];
    expect(kindSchemaChanges(marked, after)).toEqual({
      added: [],
      renamed: [],
      archived: [],
      regrouped: [],
      madeMandatory: [],
      madeSensitive: [],
      other: [
        ref(fieldOf(after, "title")),
        ref(fieldOf(after, "context")),
        ref(b),
        ref(e),
        ref(f),
      ],
    });
  });

  it("gives all-empty lists for identical bodies", () => {
    expect(kindSchemaChanges(before, structuredClone(before))).toEqual({
      added: [],
      renamed: [],
      archived: [],
      regrouped: [],
      madeMandatory: [],
      madeSensitive: [],
      other: [],
    });
  });
});
