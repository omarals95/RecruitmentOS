import { randomBytes, randomUUID } from "node:crypto";
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
import { hashToken } from "../src/lib/api-token-policy";
import type { Scope } from "../src/lib/permissions";
import type { Principal } from "../src/lib/principal";
import { POST as tokenRoute } from "../src/app/oauth/token/route";
import { createSplitRoleDb, seedIdentity, splitRoles } from "./helpers/db";
import { CLIENT_IP, stubLocalAuthReadiness } from "./helpers/readiness";

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
    stubLocalAuthReadiness();
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
  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness?.close();
  });

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
    expect((await authenticateApiToken(created.token, CLIENT_IP)).userId).toBe(
      "recruiter-a",
    );
    await revokeToken(owner, created.data.id);
    await revokeToken(owner, created.data.id);
    await expect(
      authenticateApiToken(created.token, CLIENT_IP),
    ).rejects.toMatchObject({
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
      expect((await authenticateApiToken(kept.token, CLIENT_IP)).userId).toBe(
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
      "SELECT tenant_context.audit_grant_reuse('00000000-0000-4000-8000-000000000000','refresh_token_reused')",
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

  it("refuses the directory and plan scopes for every role like an unknown scope, writing nothing", async () => {
    const before = await counts();
    const refusal = (scopes: Scope[]) =>
      createToken(owner, { name: "Fictional ceiling token", scopes }).then(
        () => expect.unreachable(),
        (error: unknown) => error,
      );
    const unknown = await refusal(["admin:all" as Scope]);
    expect(unknown).toMatchObject({
      status: 400,
      code: "invalid_token_request",
    });
    for (const p of [recruiterA, viewer, owner])
      for (const scope of [
        "directory:read",
        "directory:write",
        "plans:read",
        "plans:write",
      ] as const)
        await expect(
          createToken(p, {
            name: "Fictional ceiling token",
            scopes: [scope],
          }),
          `${p.role} ${scope}`,
        ).rejects.toEqual(unknown);
    expect(await counts()).toEqual(before);
  });

  describe("reuse revocation audit", () => {
    const REASONS = {
      code: "authorization_code_reused",
      refresh: "refresh_token_reused",
    } as const;
    /** A fictional grant row, optionally of an OAuth client, with used or unused credentials. */
    async function seedGrant(options: {
      client?: boolean;
      code?: "used" | "unused";
      refresh?: "used" | "unused";
    }) {
      await harness.asOwner();
      const id = randomUUID();
      const clientId = `ros_client_${randomBytes(16).toString("base64url")}`;
      if (options.client !== false)
        await harness.client.query(
          `INSERT INTO auth.oauth_clients(id,name,redirect_uris) VALUES($1,'Fictional Reuse App','["https://claude.ai/api/mcp/auth_callback"]')`,
          [clientId],
        );
      await harness.client.query(
        `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at,oauth_client_id)
          VALUES($1,'team','recruiter-a','Fictional grant',$2,'ros_oat_fiction','["candidates:read"]',now()+interval '1 day',$3)`,
        [
          id,
          randomBytes(32).toString("hex"),
          options.client === false ? null : clientId,
        ],
      );
      const code = randomBytes(32).toString("base64url");
      if (options.code)
        await harness.client.query(
          `INSERT INTO auth.oauth_codes(code_hash,grant_id,client_id,redirect_uri,code_challenge,expires_at,used_at)
            VALUES($1,$2,$3,'https://claude.ai/api/mcp/auth_callback',$4,now()+interval '2 minutes',$5)`,
          [
            hashToken(code),
            id,
            clientId,
            "c".repeat(43),
            options.code === "used" ? new Date() : null,
          ],
        );
      if (options.refresh)
        await harness.client.query(
          `INSERT INTO auth.oauth_tokens(grant_id,kind,token_hash,audience,expires_at,used_at)
            VALUES($1,'refresh',$2,'http://localhost:3000/api/mcp',now()+interval '1 day',$3)`,
          [
            id,
            randomBytes(32).toString("hex"),
            options.refresh === "used" ? new Date() : null,
          ],
        );
      return { id, clientId, code };
    }
    /** Runs the statements in one identity-role transaction. */
    async function asIdentity(statements: [string, unknown[]][]) {
      await harness.identityDb();
      await harness.client.transaction(async (tx) => {
        for (const [text, params] of statements) await tx.query(text, params);
      });
    }
    const revoke = (id: string): [string, unknown[]] => [
      "UPDATE auth.api_tokens SET revoked_at=current_timestamp WHERE id=$1",
      [id],
    ];
    const audit = (id: string, reason: string): [string, unknown[]] => [
      "SELECT tenant_context.audit_grant_reuse($1,$2)",
      [id, reason],
    ];
    async function revocations(id: string) {
      await harness.asSuperuser();
      return (
        await harness.client.query<Record<string, unknown>>(
          "SELECT team_id,actor_id,actor_type,token_id,kind,action,summary,metadata FROM app.activity WHERE action='token.revoked' AND metadata->>'tokenId'=$1",
          [id],
        )
      ).rows;
    }
    async function refused(statements: [string, unknown[]][], id: string) {
      const before = (await counts()).revokes;
      await expect(asIdentity(statements)).rejects.toMatchObject({
        code: "42501",
      });
      expect((await counts()).revokes).toBe(before);
      expect(await revocations(id)).toEqual([]);
    }

    it("writes one row from the grant for a grant revoked in this transaction", async () => {
      for (const kind of ["code", "refresh"] as const) {
        const grant = await seedGrant({ [kind]: "used" });
        await asIdentity([revoke(grant.id), audit(grant.id, REASONS[kind])]);
        await harness.asSuperuser();
        const { rows } = await harness.client.query<{ prefix: string }>(
          "SELECT prefix FROM auth.api_tokens WHERE id=$1",
          [grant.id],
        );
        expect(await revocations(grant.id)).toEqual([
          {
            team_id: "team",
            actor_id: "recruiter-a",
            actor_type: "token",
            token_id: grant.id,
            kind: "api-token",
            action: "token.revoked",
            summary: "Revoked an OAuth connection after a reused credential",
            metadata: {
              tokenId: grant.id,
              prefix: rows[0].prefix,
              reason: REASONS[kind],
            },
          },
        ]);
        // At most once, in this transaction or a later one.
        const before = (await counts()).revokes;
        for (const statements of [
          [revoke(grant.id), audit(grant.id, REASONS[kind])],
          [audit(grant.id, REASONS[kind])],
        ])
          await expect(asIdentity(statements)).rejects.toMatchObject({
            code: "42501",
          });
        expect((await counts()).revokes).toBe(before);
      }
      const twice = await seedGrant({ code: "used" });
      await refused(
        [
          revoke(twice.id),
          audit(twice.id, REASONS.code),
          audit(twice.id, REASONS.code),
        ],
        twice.id,
      );
    });

    it("refuses unknown reasons, API tokens, live or earlier revoked grants and unused credentials", async () => {
      const used = await seedGrant({ code: "used", refresh: "used" });
      for (const reason of ["token_leaked", "", "Authorization_code_reused"])
        await refused([revoke(used.id), audit(used.id, reason)], used.id);
      await refused(
        [
          revoke(used.id),
          ["SELECT tenant_context.audit_grant_reuse($1,NULL)", [used.id]],
        ],
        used.id,
      );
      const apiToken = await seedGrant({ client: false });
      await refused(
        [revoke(apiToken.id), audit(apiToken.id, REASONS.code)],
        apiToken.id,
      );
      await refused([audit(used.id, REASONS.code)], used.id);
      await asIdentity([revoke(used.id)]);
      await refused([audit(used.id, REASONS.code)], used.id);
      for (const [options, reason] of [
        [{ refresh: "used" }, REASONS.code],
        [{ code: "unused", refresh: "used" }, REASONS.code],
        [{ code: "used" }, REASONS.refresh],
        [{ code: "used", refresh: "unused" }, REASONS.refresh],
      ] as const) {
        const grant = await seedGrant(options);
        await refused([revoke(grant.id), audit(grant.id, reason)], grant.id);
      }
      await refused(
        [revoke(randomUUID()), audit(randomUUID(), REASONS.code)],
        randomUUID(),
      );
    });

    it("lets no runtime role insert the row directly and only the identity role run the helper", async () => {
      const grant = await seedGrant({ code: "used" });
      const forged = `INSERT INTO app.activity(team_id,actor_id,actor_type,token_id,action,kind,summary,metadata)
        VALUES('team','recruiter-a','token','${grant.id}','token.revoked','api-token','Forged',jsonb_build_object('tokenId','${grant.id}'))`;
      for (const role of ["dataDb", "identityDb"] as const) {
        await harness[role]();
        await expect(harness.client.query(forged), role).rejects.toMatchObject({
          code: "42501",
        });
      }
      await harness.dataDb();
      await expect(
        harness.client.query("SELECT tenant_context.audit_grant_reuse($1,$2)", [
          grant.id,
          REASONS.code,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await revocations(grant.id)).toEqual([]);
      await harness.asSuperuser();
      const { rows } = await harness.client.query<Record<string, boolean>>(
        `SELECT has_function_privilege('${splitRoles.identity}','tenant_context.audit_grant_reuse(text,text)','EXECUTE') AS identity,
          has_function_privilege('${splitRoles.data}','tenant_context.audit_grant_reuse(text,text)','EXECUTE') AS data`,
      );
      expect(rows[0]).toEqual({ identity: true, data: false });
    });

    it("audits a replayed code through the token endpoint under the identity role", async () => {
      const grant = await seedGrant({ code: "used" });
      const redeem = () =>
        tokenRoute(
          new Request("http://localhost:3000/oauth/token", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-forwarded-for": CLIENT_IP,
            },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: grant.clientId,
              code: grant.code,
              redirect_uri: "https://claude.ai/api/mcp/auth_callback",
              code_verifier: randomBytes(32).toString("base64url"),
            }).toString(),
          }),
        );
      for (let n = 0; n < 2; n++) {
        const response = await redeem();
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe("invalid_grant");
        expect(await revocations(grant.id)).toEqual([
          expect.objectContaining({
            actor_type: "token",
            metadata: expect.objectContaining({ reason: REASONS.code }),
          }),
        ]);
      }
      expect(pools.data).not.toHaveBeenCalled();
    });
  });
});
