import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));

import {
  authenticateApiToken,
  createToken,
  revokeToken,
} from "../src/lib/api-tokens";
import type { Principal } from "../src/lib/principal";
import { createSplitRoleDb, seedIdentity, splitRoles } from "./helpers/db";

describe("token create/revoke and audit in one identity-role transaction", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  let owner: Principal, recruiterA: Principal, recruiterB: Principal;
  let viewer: Principal;
  async function counts() {
    await harness.asSuperuser();
    const { rows } = await harness.client.query<{
      tokens: number;
      revoked: number;
      created: number;
      revokes: number;
    }>(`SELECT (SELECT count(*)::int FROM auth.api_tokens) AS tokens,
      (SELECT count(*)::int FROM auth.api_tokens WHERE revoked_at IS NOT NULL) AS revoked,
      (SELECT count(*)::int FROM app.activity WHERE action='token.created') AS created,
      (SELECT count(*)::int FROM app.activity WHERE action='token.revoked') AS revokes`);
    return rows[0];
  }
  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.identity.mockImplementation(harness.identityDb);
    pools.data.mockRejectedValue(
      new Error("Token management must not use the data pool."),
    );
    const db = await harness.asOwner();
    owner = await seedIdentity(db, { userId: "owner", teamId: "team" });
    recruiterA = await seedIdentity(db, {
      userId: "recruiter-a",
      teamId: "team",
      role: "recruiter",
    });
    recruiterB = await seedIdentity(db, {
      userId: "recruiter-b",
      teamId: "team",
      role: "recruiter",
    });
    viewer = await seedIdentity(db, {
      userId: "viewer",
      teamId: "team",
      role: "viewer",
    });
  });
  afterAll(async () => harness?.close());

  it("creates and revokes under the identity role with exactly one audit event each", async () => {
    const created = await createToken(recruiterA, {
      name: "Synthetic token",
      scopes: ["candidates:read"],
    });
    expect(await counts()).toEqual({
      tokens: 1,
      revoked: 0,
      created: 1,
      revokes: 0,
    });
    await expect(
      revokeToken(recruiterB, created.data.id),
    ).rejects.toMatchObject({ status: 404 });
    expect((await authenticateApiToken(created.token)).userId).toBe(
      "recruiter-a",
    );
    await revokeToken(owner, created.data.id);
    await revokeToken(owner, created.data.id);
    await expect(authenticateApiToken(created.token)).rejects.toMatchObject({
      status: 401,
    });
    expect(await counts()).toEqual({
      tokens: 1,
      revoked: 1,
      created: 1,
      revokes: 1,
    });
    const viewerToken = await createToken(viewer, {
      name: "Read-only synthetic token",
      scopes: ["recruitment:read"],
    });
    await revokeToken(viewer, viewerToken.data.id);
    await harness.asSuperuser();
    const events = await harness.client.query<{
      action: string;
      actor_id: string;
      team_id: string;
      summary: string;
      metadata: Record<string, unknown>;
    }>(
      "SELECT action,actor_id,team_id,summary,metadata FROM app.activity ORDER BY created_at,action",
    );
    expect(events.rows).toEqual([
      {
        action: "token.created",
        actor_id: "recruiter-a",
        team_id: "team",
        summary: "Created an API token",
        metadata: {
          tokenId: created.data.id,
          prefix: created.data.prefix,
          scopes: ["candidates:read"],
        },
      },
      {
        action: "token.revoked",
        actor_id: "owner",
        team_id: "team",
        summary: "Revoked an API token",
        metadata: { tokenId: created.data.id, prefix: created.data.prefix },
      },
      expect.objectContaining({ action: "token.created", actor_id: "viewer" }),
      expect.objectContaining({ action: "token.revoked", actor_id: "viewer" }),
    ]);
    const all = await harness.client.query("SELECT * FROM app.activity");
    expect(JSON.stringify(all.rows)).not.toContain(created.token);
    expect(JSON.stringify(all.rows)).not.toContain(viewerToken.token);
    expect(pools.data).not.toHaveBeenCalled();
  });

  it("rolls back token changes when the identity role cannot run the audit helper", async () => {
    const kept = await createToken(recruiterA, {
      name: "Kept synthetic token",
      scopes: ["candidates:read"],
    });
    const before = await counts();
    await harness.asOwner();
    await harness.client.exec(
      `REVOKE EXECUTE ON FUNCTION tenant_context.audit_token(text,text) FROM ${splitRoles.identity}`,
    );
    try {
      await expect(
        createToken(recruiterA, {
          name: "Unaudited token",
          scopes: ["candidates:read"],
        }),
      ).rejects.toMatchObject({ cause: { code: "42501" } });
      await expect(revokeToken(owner, kept.data.id)).rejects.toMatchObject({
        cause: { code: "42501" },
      });
      expect(await counts()).toEqual(before);
      expect((await authenticateApiToken(kept.token)).userId).toBe(
        "recruiter-a",
      );
    } finally {
      await harness.asOwner();
      await harness.client.exec(
        `GRANT EXECUTE ON FUNCTION tenant_context.audit_token(text,text) TO ${splitRoles.identity}`,
      );
    }
  });

  it("denies the data role token rows and the token-audit helper", async () => {
    await harness.dataDb();
    for (const statement of [
      "SELECT id FROM auth.api_tokens",
      "SELECT tenant_context.audit_token('00000000-0000-4000-8000-000000000000','token.created')",
    ])
      await expect(
        harness.client.query(statement),
        statement,
      ).rejects.toMatchObject({ code: "42501" });
    await harness.identityDb();
    await expect(
      harness.client.query(
        "INSERT INTO app.activity(team_id,actor_id,actor_type,action,kind,summary) VALUES('team','owner','session','token.created','api-token','Forged')",
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
