import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));
// Routes get the fake Blob gateway through the storage module; nothing else builds one.
const configured = vi.hoisted(() => ({
  current: undefined as undefined | { binding: unknown; gateway: unknown },
}));
vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...original,
    storageConfigured: () => true,
    resolveStorageBinding: () => {
      if (!configured.current)
        throw new original.StorageConfigurationError("No fake storage.");
      return configured.current.binding;
    },
    getStorage: async () => configured.current?.gateway,
  };
});

import { getVerifiedSession } from "@/lib/auth-session";
import { createToken } from "@/lib/api-tokens";
import { bulkItemSchema, createBulkItem } from "@/lib/bulk-intake";
import { activity, uploads } from "@/db/schema";
import { beginCvUpload, completeCvUpload } from "@/lib/cvs";
import { withTeam } from "@/lib/db-team";
import { createRecord } from "@/lib/records";
import type { Principal } from "@/lib/principal";
import { GET, PUT } from "@/app/api/v1/teams/storage-settings/route";
import { POST as reserveRoute } from "@/app/api/v1/candidates/[id]/cvs/uploads/route";
import { POST as bulkUploadRoute } from "@/app/api/v1/cvs/bulk-batches/[batchId]/items/[itemId]/upload/route";
import {
  createTestDb,
  enforceTestRls,
  seedApiToken,
  seedIdentity,
} from "./helpers/db";
import { stubLocalAuthReadiness } from "./helpers/readiness";
import { blobBinding, fakeBlob } from "./helpers/fake-blob";

// Fictional teams, people and synthetic PDF bytes only; the fake Blob client stores nothing remote.
const ORIGIN = "http://localhost:3000";
const quotaMessage =
  "The CV storage limit has been reached, including pending uploads and files waiting for cleanup. Ask a team owner or admin to review the team's storage settings.";
function fictionalPdf(size: number) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) % 251;
  bytes.write("%PDF-1.7\nfictional settings CV\n");
  return bytes;
}
const metadata = (sizeBytes = 1000) => ({
  originalName: "fictional-cv.pdf",
  mimeType: "application/pdf",
  sizeBytes,
  clientUploadId: randomUUID(),
});
const off = { maxBytes: null, maxFiles: null, uploadRequestsPerMinute: null };
/** The CV contents setting, sent with every save; on unless a test turns it off. */
const cvText = { mcpCvTextEnabled: true };

describe("team CV storage settings and upload rate limit", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal, admin: Principal, recruiter: Principal;
  let viewer: Principal, fresh: Principal, quota: Principal, rate: Principal;
  /** Raw SQL through the PGlite owner, outside the runtime role and its policies. */
  async function asOwner<T = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    await fixture.client.exec("RESET ROLE");
    try {
      return (await fixture.client.query<T>(query, params)).rows;
    } finally {
      await fixture.client.exec("SET ROLE recruitment_test_runtime");
    }
  }
  async function settings(
    method: "GET" | "PUT",
    p: Principal,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    vi.mocked(getVerifiedSession).mockResolvedValue({
      user: { id: p.userId, twoFactorEnabled: true },
      session: { activeOrganizationId: p.teamId },
    } as never);
    const response = await (method === "GET" ? GET : PUT)(
      new Request(`${ORIGIN}/api/v1/teams/storage-settings`, {
        method,
        headers: {
          origin: ORIGIN,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: response.status, body: await response.json() };
  }
  const auditRows = (teamId: string) =>
    asOwner<{
      actor_id: string;
      actor_type: string;
      action: string;
      summary: string;
      metadata: unknown;
    }>(
      "SELECT actor_id, actor_type, action, summary, metadata FROM app.activity WHERE team_id=$1 AND kind='storage-settings' ORDER BY created_at, id",
      [teamId],
    );
  async function bearer(p: Principal) {
    return (
      await createToken(p, {
        name: `Fictional storage ${randomUUID().slice(0, 8)}`,
        scopes: [
          "candidates:read",
          "candidates:write",
          "cvs:read",
          "cvs:write",
        ],
      })
    ).token;
  }
  const reserve = async (token: string, candidateId: string, body: unknown) => {
    const response = await reserveRoute(
      new Request(`${ORIGIN}/api/v1/candidates/${candidateId}/cvs/uploads`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: candidateId }) },
    );
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      body: await response.json(),
    };
  };

  beforeAll(async () => {
    stubLocalAuthReadiness();
    vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db, {
      userId: "storage-owner",
      teamId: "storage-team",
    });
    admin = await seedIdentity(fixture.db, {
      userId: "storage-admin",
      teamId: "storage-team",
      role: "admin",
    });
    recruiter = await seedIdentity(fixture.db, {
      userId: "storage-recruiter",
      teamId: "storage-team",
      role: "recruiter",
    });
    viewer = await seedIdentity(fixture.db, {
      userId: "storage-viewer",
      teamId: "storage-team",
      role: "viewer",
    });
    fresh = await seedIdentity(fixture.db, {
      userId: "storage-fresh-owner",
      teamId: "storage-fresh-team",
    });
    quota = await seedIdentity(fixture.db, {
      userId: "storage-quota-owner",
      teamId: "storage-quota-team",
    });
    rate = await seedIdentity(fixture.db, {
      userId: "storage-rate-owner",
      teamId: "storage-rate-team",
    });
    await enforceTestRls(fixture.db);
    configured.current = { binding: blobBinding, gateway: fakeBlob().gateway };
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await fixture?.close();
  });

  it("reads nulls and zero usage for a team that never reserved storage", async () => {
    expect(await settings("GET", fresh)).toEqual({
      status: 200,
      body: {
        data: {
          ...off,
          ...cvText,
          usage: {
            usedBytes: 0,
            usedFiles: 0,
            reservedBytes: 0,
            reservedFiles: 0,
            retainedBytes: 0,
            retainedFiles: 0,
          },
        },
      },
    });
  });

  it("lets an owner and an admin set a limit, then turn it off, with one audit row per change", async () => {
    const before = (await auditRows(owner.teamId)).length;
    const limit = {
      maxBytes: 500_000_000,
      maxFiles: 100,
      uploadRequestsPerMinute: 30,
    };
    const set = await settings("PUT", owner, { ...limit, ...cvText });
    expect(set.status).toBe(200);
    expect(set.body.data).toMatchObject(limit);
    expect((await settings("GET", admin)).body.data).toMatchObject(limit);
    // An unchanged PUT writes no row.
    expect((await settings("PUT", admin, { ...limit, ...cvText })).status).toBe(
      200,
    );
    const changed = { ...limit, maxBytes: 1_500_000_000 };
    expect(
      (await settings("PUT", admin, { ...changed, ...cvText })).body.data,
    ).toMatchObject(changed);
    const cleared = await settings("PUT", admin, { ...off, ...cvText });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject(off);
    const rows = (await auditRows(owner.teamId)).slice(before);
    expect(rows).toEqual([
      {
        actor_id: owner.userId,
        actor_type: "session",
        action: "storage.settings_updated",
        summary: "Updated CV storage settings",
        metadata: { before: off, after: limit },
      },
      {
        actor_id: admin.userId,
        actor_type: "session",
        action: "storage.settings_updated",
        summary: "Updated CV storage settings",
        metadata: { before: limit, after: changed },
      },
      {
        actor_id: admin.userId,
        actor_type: "session",
        action: "storage.settings_updated",
        summary: "Updated CV storage settings",
        metadata: { before: changed, after: off },
      },
    ]);
    expect((await settings("PUT", owner, { ...off, ...cvText })).status).toBe(
      200,
    );
    expect(await auditRows(owner.teamId)).toHaveLength(before + 3);
  });

  it("turns connected AI apps' CV text access off and on, auditing each change only", async () => {
    expect((await settings("GET", fresh)).body.data.mcpCvTextEnabled).toBe(
      true,
    );
    const before = (await auditRows(owner.teamId)).length;
    const turnedOff = await settings("PUT", owner, {
      ...off,
      mcpCvTextEnabled: false,
    });
    expect(turnedOff.status).toBe(200);
    expect(turnedOff.body.data.mcpCvTextEnabled).toBe(false);
    expect((await settings("GET", admin)).body.data.mcpCvTextEnabled).toBe(
      false,
    );
    // Unchanged: no row from either helper.
    expect(
      (await settings("PUT", admin, { ...off, mcpCvTextEnabled: false }))
        .status,
    ).toBe(200);
    // Only the limits change: one row, from the limits helper.
    const limit = {
      maxBytes: 3_000_000,
      maxFiles: 3,
      uploadRequestsPerMinute: null,
    };
    expect(
      (await settings("PUT", admin, { ...limit, mcpCvTextEnabled: false }))
        .status,
    ).toBe(200);
    // Both change in one save: one row each, in the same transaction.
    expect(
      (await settings("PUT", admin, { ...off, ...cvText })).body.data,
    ).toMatchObject({ ...off, ...cvText });
    for (const p of [recruiter, viewer]) {
      const refused = await settings("PUT", p, {
        ...off,
        mcpCvTextEnabled: false,
      });
      expect(refused.status, p.role).toBe(403);
      expect(refused.body.error.code).toBe("storage_settings_forbidden");
    }
    const setting = {
      actor_type: "session",
      action: "storage.settings_updated",
      summary: "Changed whether connected AI apps can read CV contents",
    };
    const limits = {
      actor_type: "session",
      action: "storage.settings_updated",
      summary: "Updated CV storage settings",
    };
    const rows = (await auditRows(owner.teamId)).slice(before);
    expect(rows.slice(0, 2)).toEqual([
      {
        ...setting,
        actor_id: owner.userId,
        metadata: {
          before: { mcpCvTextEnabled: true },
          after: { mcpCvTextEnabled: false },
        },
      },
      {
        ...limits,
        actor_id: admin.userId,
        metadata: { before: off, after: limit },
      },
    ]);
    // Written in one transaction, so they share a time and come in either order.
    expect(rows.slice(2)).toHaveLength(2);
    expect(rows.slice(2)).toEqual(
      expect.arrayContaining([
        {
          ...limits,
          actor_id: admin.userId,
          metadata: { before: limit, after: off },
        },
        {
          ...setting,
          actor_id: admin.userId,
          metadata: {
            before: { mcpCvTextEnabled: false },
            after: { mcpCvTextEnabled: true },
          },
        },
      ]),
    );
  });

  it("refuses recruiters, viewers and Bearer tokens", async () => {
    const limit = {
      maxBytes: 2_000_000,
      maxFiles: 2,
      uploadRequestsPerMinute: 1,
    };
    for (const p of [recruiter, viewer]) {
      for (const [method, body] of [
        ["GET", undefined],
        ["PUT", { ...limit, ...cvText }],
      ] as const) {
        const refused = await settings(method, p, body);
        expect(refused.status, `${p.role} ${method}`).toBe(403);
        expect(refused.body.error).toMatchObject({
          code: "storage_settings_forbidden",
          message:
            "Only team owners and admins can view or change CV storage settings.",
        });
      }
    }
    for (const method of ["GET", "PUT"] as const) {
      const token = await settings(
        method,
        owner,
        method === "PUT" ? { ...limit, ...cvText } : undefined,
        {
          authorization: "Bearer fictional-storage-token",
        },
      );
      expect(token.status).toBe(403);
      expect(token.body.error.code).toBe("session_required");
    }
    expect((await settings("GET", owner)).body.data).toMatchObject(off);
  });

  it("refuses one-sided limits, out-of-range values and unknown keys", async () => {
    const before = (await auditRows(owner.teamId)).length;
    const valid = {
      maxBytes: 2_000_000,
      maxFiles: 2,
      uploadRequestsPerMinute: 10,
      ...cvText,
    };
    const { mcpCvTextEnabled: _setting, ...withoutSetting } = valid;
    for (const body of [
      { ...valid, maxFiles: null },
      { ...valid, maxBytes: null },
      { ...valid, maxBytes: 999_999 },
      { ...valid, maxBytes: 10_000_000_000_001 },
      { ...valid, maxBytes: 1_500_000.5 },
      { ...valid, maxFiles: 0 },
      { ...valid, maxFiles: 1_000_001 },
      { ...valid, uploadRequestsPerMinute: 0 },
      { ...valid, uploadRequestsPerMinute: 601 },
      { ...valid, unexpected: true },
      { maxBytes: null, maxFiles: null },
      withoutSetting,
      { ...valid, mcpCvTextEnabled: null },
      { ...valid, mcpCvTextEnabled: "false" },
    ]) {
      const refused = await settings("PUT", owner, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.body.error.code).toBe("invalid_input");
    }
    for (const body of [
      { ...valid, maxBytes: 1_000_000, maxFiles: 1 },
      { ...valid, maxBytes: 10_000_000_000_000, maxFiles: 1_000_000 },
      { ...valid, uploadRequestsPerMinute: 600 },
      { ...valid, uploadRequestsPerMinute: 1 },
    ])
      expect((await settings("PUT", owner, body)).status).toBe(200);
    expect((await settings("PUT", owner, { ...off, ...cvText })).status).toBe(
      200,
    );
    expect(await auditRows(owner.teamId)).toHaveLength(before + 5);
  });

  it("accepts a limit below usage, then refuses new reservations while existing uploads still complete", async () => {
    const fake = fakeBlob();
    const candidate = (
      await createRecord(quota, "candidates", {
        data: { name: "Fictional Quota Candidate" },
      })
    ).id;
    const done = await beginCvUpload(
      quota,
      candidate,
      metadata(),
      fake.gateway,
    );
    const waiting = await beginCvUpload(
      quota,
      candidate,
      metadata(),
      fake.gateway,
    );
    for (const id of [done.data.id, waiting.data.id]) {
      const [{ object_key }] = await asOwner<{ object_key: string }>(
        "SELECT object_key FROM app.uploads WHERE id=$1",
        [id],
      );
      fake.objects.set(object_key, {
        bytes: fictionalPdf(1000),
        mimeType: "application/pdf",
      });
    }
    expect(
      (await completeCvUpload(quota, done.data.id, fake.gateway)).status,
    ).toBe("ready");
    const below = await settings("PUT", quota, {
      maxBytes: 1_000_000,
      maxFiles: 1,
      uploadRequestsPerMinute: null,
      ...cvText,
    });
    expect(below.status).toBe(200);
    expect(below.body.data).toMatchObject({
      maxBytes: 1_000_000,
      maxFiles: 1,
      usage: {
        usedFiles: 1,
        reservedFiles: 1,
        usedBytes: 1000,
        reservedBytes: 1000,
      },
    });
    await expect(
      beginCvUpload(quota, candidate, metadata(), fake.gateway),
    ).rejects.toMatchObject({
      status: 409,
      code: "STORAGE_QUOTA_EXCEEDED",
      message: quotaMessage,
    });
    expect(
      (await completeCvUpload(quota, waiting.data.id, fake.gateway)).status,
    ).toBe("ready");
    expect((await settings("GET", quota)).body.data.usage).toMatchObject({
      usedFiles: 2,
      reservedFiles: 0,
      usedBytes: 2000,
    });
    // Turning the limit off lets the store budget decide again.
    expect((await settings("PUT", quota, { ...off, ...cvText })).status).toBe(
      200,
    );
    expect(
      (await beginCvUpload(quota, candidate, metadata(), fake.gateway)).data
        .status,
    ).toBe("pending");
  });

  it("returns 429 with Retry-After over the team's upload rate, never for a replay, and again after a minute", async () => {
    const token = await bearer(rate);
    const candidate = (
      await createRecord(rate, "candidates", {
        data: { name: "Fictional Rate Candidate" },
      })
    ).id;
    // With the limit off nothing is refused.
    for (let n = 0; n < 3; n++)
      expect((await reserve(token, candidate, metadata())).status).toBe(201);
    await asOwner(
      "UPDATE app.uploads SET created_at = created_at - interval '61 seconds' WHERE team_id=$1",
      [rate.teamId],
    );
    expect(
      (
        await settings("PUT", rate, {
          maxBytes: null,
          maxFiles: null,
          uploadRequestsPerMinute: 2,
          ...cvText,
        })
      ).status,
    ).toBe(200);
    const first = metadata();
    expect((await reserve(token, candidate, first)).status).toBe(201);
    expect((await reserve(token, candidate, metadata())).status).toBe(201);
    const limited = await reserve(token, candidate, metadata());
    expect(limited).toMatchObject({
      status: 429,
      retryAfter: "60",
      body: {
        error: {
          code: "CV_UPLOAD_RATE_LIMITED",
          message:
            "Your team allows 2 new CV uploads per minute. Wait a minute, then try again.",
        },
      },
    });
    // A replay of an existing reservation is not refused.
    expect((await reserve(token, candidate, first)).status).toBe(201);

    // The bulk item upload POST reserves through the same check.
    const batchId = randomUUID(),
      itemId = randomUUID();
    await createBulkItem(
      rate,
      batchId,
      itemId,
      bulkItemSchema.parse({
        file: {
          originalName: "fictional-cv.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1000,
        },
        data: { name: "Fictional Bulk Rate Candidate" },
        factsReviewed: true,
        duplicatesReviewed: true,
      }),
    );
    const bulk = await bulkUploadRoute(
      new Request(
        `${ORIGIN}/api/v1/cvs/bulk-batches/${batchId}/items/${itemId}/upload`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ),
      { params: Promise.resolve({ batchId, itemId }) },
    );
    expect(bulk.status).toBe(429);
    expect(bulk.headers.get("retry-after")).toBe("60");
    expect((await bulk.json()).error.code).toBe("CV_UPLOAD_RATE_LIMITED");

    await asOwner(
      "UPDATE app.uploads SET created_at = created_at - interval '61 seconds' WHERE team_id=$1",
      [rate.teamId],
    );
    expect((await reserve(token, candidate, metadata())).status).toBe(201);
    expect((await settings("PUT", rate, { ...off, ...cvText })).status).toBe(
      200,
    );
  });

  describe("storage helpers under the restricted runtime role", () => {
    const code = (expected: string) => ({ cause: { code: expected } });
    const limits = (
      p: Principal,
      bytes: number | null,
      files: number | null,
      perMinute: number | null,
    ) =>
      withTeam(p, async (tx) => {
        const { rows } = await tx.execute<{ changed: boolean }>(
          sql`select tenant_context.set_storage_limits(${bytes}::bigint, ${files}::integer, ${perMinute}::integer) as changed`,
        );
        return rows[0].changed;
      });
    const release = (p: Principal, id: string) =>
      withTeam(p, async (tx) => {
        const { rows } = await tx.execute<{ released: boolean }>(
          sql`select tenant_context.release_blob_charge(${blobBinding.store}, ${id}::uuid) as released`,
        );
        return rows[0].released;
      });

    it("runs set_storage_limits only for owner and admin sessions, with valid values, and audits only changes", async () => {
      for (const p of [
        recruiter,
        viewer,
        await seedApiToken(fixture.db, owner),
      ])
        await expect(
          limits(p, null, null, 5),
          p.authType,
        ).rejects.toMatchObject(code("42501"));
      await expect(
        fixture.client.query(
          "SELECT tenant_context.set_storage_limits(NULL, NULL, NULL)",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      for (const [bytes, files, perMinute] of [
        [2_000_000, null, null],
        [null, 2, null],
        [999_999, 2, null],
        [10_000_000_000_001, 2, null],
        [2_000_000, 0, null],
        [2_000_000, 1_000_001, null],
        [null, null, 0],
        [null, null, 601],
      ])
        await expect(
          limits(owner, bytes, files, perMinute),
          JSON.stringify([bytes, files, perMinute]),
        ).rejects.toMatchObject(code("22023"));
      const before = (await auditRows(owner.teamId)).length;
      expect(await limits(admin, 2_000_000, 2, null)).toBe(true);
      expect(await limits(owner, 2_000_000, 2, null)).toBe(false);
      expect(await auditRows(owner.teamId)).toHaveLength(before + 1);
      expect(await limits(owner, null, null, null)).toBe(true);
      expect(await auditRows(owner.teamId)).toHaveLength(before + 2);
    });

    it("runs set_mcp_cv_text_access only for owner and admin sessions, with a value, and audits only changes", async () => {
      const access = (p: Principal, enabled: boolean | null) =>
        withTeam(p, async (tx) => {
          const { rows } = await tx.execute<{ changed: boolean }>(
            sql`select tenant_context.set_mcp_cv_text_access(${enabled}::boolean) as changed`,
          );
          return rows[0].changed;
        });
      for (const p of [
        recruiter,
        viewer,
        await seedApiToken(fixture.db, owner),
      ])
        await expect(access(p, false), p.authType).rejects.toMatchObject(
          code("42501"),
        );
      await expect(
        fixture.client.query(
          "SELECT tenant_context.set_mcp_cv_text_access(false)",
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(access(owner, null)).rejects.toMatchObject(code("22023"));
      const before = (await auditRows(owner.teamId)).length;
      expect(await access(admin, true)).toBe(false);
      expect(await auditRows(owner.teamId)).toHaveLength(before);
      expect(await access(admin, false)).toBe(true);
      expect(await access(owner, true)).toBe(true);
      expect(await auditRows(owner.teamId)).toHaveLength(before + 2);
      // A team without a storage row gets one, set as asked.
      const team = await seedIdentity(fixture.db, {
        userId: "storage-cvtext-owner",
        teamId: "storage-cvtext-team",
      });
      expect(await access(team, false)).toBe(true);
      expect(
        await asOwner(
          "SELECT mcp_cv_text_enabled FROM app.storage_usage WHERE team_id=$1",
          [team.teamId],
        ),
      ).toEqual([{ mcp_cv_text_enabled: false }]);
    });

    it("refuses direct blob_deleted_at writes and storage-settings audit rows from the runtime role", async () => {
      const fake = fakeBlob();
      const candidate = (
        await createRecord(owner, "candidates", {
          data: { name: "Fictional Guard Candidate" },
        })
      ).id;
      const { data } = await beginCvUpload(
        owner,
        candidate,
        metadata(),
        fake.gateway,
      );
      await asOwner("UPDATE app.uploads SET status='rejected' WHERE id=$1", [
        data.id,
      ]);
      await expect(
        withTeam(owner, (tx) =>
          tx
            .update(uploads)
            .set({ blobDeletedAt: new Date() })
            .where(eq(uploads.id, data.id)),
        ),
      ).rejects.toMatchObject({
        cause: { code: "23514", message: "Upload reference is immutable" },
      });
      await expect(
        withTeam(owner, (tx) =>
          tx.insert(activity).values({
            id: randomUUID(),
            teamId: owner.teamId,
            actorId: owner.userId,
            actorType: "session",
            action: "storage.settings_updated",
            kind: "storage-settings",
            summary: "Updated CV storage settings",
            metadata: {},
          }),
        ),
      ).rejects.toMatchObject(code("42501"));
    });

    it("releases a Blob charge only for the team's own rejected upload, 10 minutes after expiry, once", async () => {
      const fake = fakeBlob();
      const reserve = async (p: Principal) => {
        const candidate = (
          await createRecord(p, "candidates", {
            data: { name: "Fictional Release Candidate" },
          })
        ).id;
        const { data } = await beginCvUpload(
          p,
          candidate,
          metadata(),
          fake.gateway,
        );
        return data.id;
      };
      const expire = (id: string, status: string, minutes: number) =>
        asOwner(
          "UPDATE app.uploads SET status=$2, expires_at=now()-make_interval(mins=>$3) WHERE id=$1",
          [id, status, minutes],
        );
      const foreign = await reserve(fresh);
      await expire(foreign, "rejected", 20);
      const recent = await reserve(owner);
      await expire(recent, "rejected", 5);
      const done = await reserve(owner);
      const [{ object_key }] = await asOwner<{ object_key: string }>(
        "SELECT object_key FROM app.uploads WHERE id=$1",
        [done],
      );
      fake.objects.set(object_key, {
        bytes: fictionalPdf(1000),
        mimeType: "application/pdf",
      });
      await completeCvUpload(owner, done, fake.gateway);
      await asOwner(
        "UPDATE app.uploads SET expires_at=now()-interval '1 hour' WHERE id=$1",
        [done],
      );
      const eligible = await reserve(owner);
      await expire(eligible, "rejected", 11);
      for (const id of [foreign, recent, done, randomUUID()])
        expect(await release(owner, id)).toBe(false);
      await expect(
        release({ ...owner, scopes: ["cvs:read"] }, eligible),
      ).rejects.toMatchObject(code("42501"));
      await expect(
        fixture.client.query(
          `SELECT tenant_context.release_blob_charge('store_fictional', '${eligible}')`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await release(owner, eligible)).toBe(true);
      expect(await release(owner, eligible)).toBe(false);
    });
  });
});
