import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requests pick the pool by role, as on a split-role deployment. The token lookup is a spy, so a
// Bearer request can show it is refused before any token is looked at.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));
vi.mock("@/lib/api-tokens", async (original) => {
  const actual = await original<typeof import("@/lib/api-tokens")>();
  return {
    ...actual,
    authenticateApiToken: vi.fn(actual.authenticateApiToken),
    authenticateOAuthAccessToken: vi.fn(actual.authenticateOAuthAccessToken),
  };
});

import type { AppDb } from "@/db";
import type { RoleBody } from "@/domain/config";
import { VIEWER_ROLE } from "@/domain/config-defaults";
import {
  authenticateApiToken,
  authenticateOAuthAccessToken,
} from "@/lib/api-tokens";
import { SESSION_FRESH_AGE_SECONDS } from "@/lib/auth-policy";
import { getVerifiedSession } from "@/lib/auth-session";
import { createConfigDraft, publishConfigVersion } from "@/lib/config-store";
import { ApiError } from "@/lib/errors";
import { requireFreshSession } from "@/lib/fresh-session";
import type { Principal } from "@/lib/principal";
import * as authorityRoute from "@/app/api/v1/company-authority/route";
import * as memberRolesRoute from "@/app/api/v1/teams/member-roles/route";
import { POST as resetRoute } from "@/app/api/v1/teams/two-step-reset/route";
import { GET as rolesRoute } from "@/app/api/v1/roles/route";
import { POST as publishRoute } from "@/app/api/v1/roles/[id]/publish/route";
import { createSplitRoleDb, seedIdentity } from "./helpers/db";
import { stubLocalAuthReadiness } from "./helpers/readiness";

// Fictional data only: one company with one fictional team (ADM-06).
const ORIGIN = "http://localhost:3000";
const MINUTE_MS = 60 * 1000;
const NOW = Date.UTC(2026, 10, 11, 9, 0, 0);
const STALE =
  "This change needs a recent sign-in. Confirm your password and two-step code, then try again.";

describe("requireFreshSession", () => {
  const session = (sessionCreatedAt?: Date): Principal => ({
    userId: "fictional-user",
    teamId: "fictional-team",
    role: "owner",
    scopes: [],
    authType: "session",
    sessionCreatedAt,
  });
  const refusal = (work: () => void) => {
    try {
      work();
    } catch (error) {
      return error as ApiError;
    }
    return null;
  };

  it("keeps the fresh age at Better Auth's 15 minutes", () => {
    expect(SESSION_FRESH_AGE_SECONDS).toBe(900);
  });

  it("passes a session younger than 15 minutes and refuses one that age or older, or without a start time", () => {
    pools.data.mockClear();
    pools.identity.mockClear();
    expect(
      refusal(() =>
        requireFreshSession(
          session(new Date(NOW - 14 * MINUTE_MS - 59 * 1000)),
          NOW,
        ),
      ),
    ).toBeNull();
    for (const createdAt of [
      new Date(NOW - 15 * MINUTE_MS),
      new Date(NOW - 16 * MINUTE_MS),
      new Date(NOW - 8 * 24 * 60 * MINUTE_MS),
      undefined,
      new Date("not a date"),
    ]) {
      const error = refusal(() => requireFreshSession(session(createdAt), NOW));
      expect(error, String(createdAt)).toBeInstanceOf(ApiError);
      expect(error, String(createdAt)).toMatchObject({
        status: 403,
        code: "SESSION_NOT_FRESH",
        message: STALE,
      });
    }
    const token = refusal(() =>
      requireFreshSession(
        {
          ...session(new Date(NOW)),
          authType: "token",
          tokenId: "fictional-token",
        },
        NOW,
      ),
    );
    expect(token).toMatchObject({
      status: 403,
      code: "session_required",
      message: "Sign in to manage accounts, teams and API tokens.",
    });
    // No database statement: neither pool was asked for.
    expect(pools.data).not.toHaveBeenCalled();
    expect(pools.identity).not.toHaveBeenCalled();
  });
});

describe("the four sensitive admin changes need a recent sign-in, on the split runtime roles", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  let owner: Principal, viewer: Principal, member: Principal;
  let candidate: Principal;
  let role: { objectId: string; versionId: string };
  let draft: string;

  /** Raw reads as the PGlite superuser, which bypasses RLS; only to arrange or inspect. */
  const look = async <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ) => {
    await harness.asSuperuser();
    return (await harness.client.query<T>(text, params)).rows;
  };
  const activityCount = async () =>
    (
      await look<{ count: number }>(
        "SELECT count(*)::int AS count FROM app.activity",
      )
    )[0].count;
  /** Everything a guarded change could write: the draft, role rows, authority and two-step state. */
  const snapshot = async () => ({
    configs: await look(
      "SELECT id, current_version_id, draft_version_id FROM app.config_objects ORDER BY id",
    ),
    memberRoles: await look(
      "SELECT team_id, user_id, role_object_id FROM app.member_roles ORDER BY team_id, user_id",
    ),
    teamRoles: await look("SELECT id, role FROM auth.member ORDER BY id"),
    authority: await look(
      "SELECT user_id, level, areas, plan_access FROM app.workspace_admins ORDER BY user_id",
    ),
    twoStep: await look(
      `SELECT u.id, u.two_factor_enabled, count(t.user_id)::int AS secrets FROM auth."user" u LEFT JOIN auth.two_factor t ON t.user_id = u.id GROUP BY u.id ORDER BY u.id`,
    ),
    activity: await activityCount(),
  });
  const signIn = (p: Principal, createdAt: Date) =>
    vi.mocked(getVerifiedSession).mockResolvedValue({
      user: { id: p.userId, emailVerified: true, twoFactorEnabled: true },
      session: { activeOrganizationId: p.teamId, createdAt },
    } as never);
  const fresh = () => new Date();
  const stale = () => new Date(Date.now() - 16 * MINUTE_MS);
  type As = Date | "bearer";
  /** One request through a route handler, as the owner with a session of that age or a token. */
  async function call(
    handler: (request: Request, context: never) => Promise<Response>,
    as: As,
    method: string,
    path: string,
    options: { body?: unknown; params?: Record<string, string> } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; body: any }> {
    if (as !== "bearer") signIn(owner, as);
    const response = await handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          origin: ORIGIN,
          ...(options.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...(as === "bearer"
            ? { authorization: "Bearer ros_live_fictional_fresh_session" }
            : { "x-team-id": owner.teamId }),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
      { params: Promise.resolve(options.params ?? {}) } as never,
    );
    return { status: response.status, body: await response.json() };
  }
  const changes = () =>
    [
      {
        name: "role publish",
        send: (as: As) =>
          call(publishRoute, as, "POST", `/api/v1/roles/${draft}/publish`, {
            params: { id: draft },
          }),
        expected: () => ({ data: { versionId: draft, number: 1 } }),
      },
      {
        name: "member role assignment",
        send: (as: As) =>
          call(
            memberRolesRoute.POST,
            as,
            "POST",
            "/api/v1/teams/member-roles",
            { body: { userId: viewer.userId, roleObjectId: role.objectId } },
          ),
        expected: () => ({
          data: {
            userId: viewer.userId,
            roleObjectId: role.objectId,
            roleVersionId: role.versionId,
            membership: "viewer",
          },
        }),
      },
      {
        name: "company authority grant",
        send: (as: As) =>
          call(authorityRoute.POST, as, "POST", "/api/v1/company-authority", {
            body: {
              userId: candidate.userId,
              level: "admin",
              areas: ["fields"],
              planAccess: false,
            },
          }),
        expected: () => ({ data: { changed: true } }),
      },
      {
        name: "two-step reset",
        send: (as: As) =>
          call(resetRoute, as, "POST", "/api/v1/teams/two-step-reset", {
            body: { userId: member.userId },
          }),
        expected: () => ({ data: { reset: true } }),
      },
    ] as const;

  beforeAll(async () => {
    stubLocalAuthReadiness();
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, { userId: "fs-owner", teamId: "fs-team" });
    viewer = await seedIdentity(db, {
      userId: "fs-viewer",
      teamId: "fs-team",
      role: "viewer",
    });
    member = await seedIdentity(db, {
      userId: "fs-member",
      teamId: "fs-team",
      role: "recruiter",
    });
    candidate = await seedIdentity(db, {
      userId: "fs-candidate-admin",
      teamId: "fs-team",
      role: "recruiter",
    });
    await look(
      `INSERT INTO auth.two_factor(user_id, secret, backup_codes) VALUES ('fs-member', 'fictional-encrypted-secret', 'fictional-encrypted-codes')`,
    );
    const body = structuredClone({
      ...(VIEWER_ROLE.body as RoleBody),
      name: "Fictional fresh-session viewer",
    });
    await harness.dataDb();
    const published = await createConfigDraft(owner, {
      type: "role",
      key: "fictional-fresh-viewer",
      body,
    });
    await harness.dataDb();
    await publishConfigVersion(owner, published.versionId);
    role = published;
    await harness.dataDb();
    draft = (
      await createConfigDraft(owner, {
        type: "role",
        key: "fictional-fresh-draft",
        body: { ...body, name: "Fictional fresh-session draft" },
      })
    ).versionId;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness?.close();
  });

  it("refuses a stale session with 403 SESSION_NOT_FRESH on each change and changes nothing", async () => {
    for (const change of changes()) {
      const before = await snapshot();
      const response = await change.send(stale());
      expect(response.status, change.name).toBe(403);
      expect(response.body.error, change.name).toMatchObject({
        code: "SESSION_NOT_FRESH",
        message: STALE,
      });
      expect(typeof response.body.error.correlationId, change.name).toBe(
        "string",
      );
      expect(await snapshot(), change.name).toEqual(before);
    }
    // The draft is still a draft, nobody holds the role, the grant and the two-step state are as seeded.
    const after = await snapshot();
    expect(
      after.configs.find(
        (row) =>
          (row as { draft_version_id: string }).draft_version_id === draft,
      ),
    ).toMatchObject({ draft_version_id: draft, current_version_id: null });
    expect(after.memberRoles).toEqual([]);
    expect(after.authority).not.toContainEqual(
      expect.objectContaining({ user_id: candidate.userId }),
    );
    expect(after.twoStep).toContainEqual({
      id: member.userId,
      two_factor_enabled: true,
      secrets: 1,
    });
  });

  it("refuses a Bearer token with 403 session_required before any token lookup", async () => {
    for (const change of changes()) {
      vi.mocked(authenticateApiToken).mockClear();
      vi.mocked(authenticateOAuthAccessToken).mockClear();
      vi.mocked(getVerifiedSession).mockClear();
      const before = await snapshot();
      const response = await change.send("bearer");
      expect(response.status, change.name).toBe(403);
      expect(response.body.error.code, change.name).toBe("session_required");
      expect(authenticateApiToken, change.name).not.toHaveBeenCalled();
      expect(authenticateOAuthAccessToken, change.name).not.toHaveBeenCalled();
      expect(getVerifiedSession, change.name).not.toHaveBeenCalled();
      expect(await snapshot(), change.name).toEqual(before);
    }
  });

  it("never refuses a read for a stale session", async () => {
    for (const [handler, path] of [
      [authorityRoute.GET, "/api/v1/company-authority"],
      [memberRolesRoute.GET, "/api/v1/teams/member-roles"],
      [rolesRoute, "/api/v1/roles"],
    ] as const) {
      const response = await call(handler, stale(), "GET", path);
      expect(response.status, path).toBe(200);
    }
  });

  it("lets a fresh session make each change exactly as before", async () => {
    for (const change of changes()) {
      const before = await activityCount();
      const response = await change.send(fresh());
      expect(response, change.name).toEqual({
        status: 200,
        body: change.expected(),
      });
      expect(await activityCount(), change.name).toBeGreaterThan(before);
    }
    const after = await snapshot();
    expect(
      after.configs.find(
        (row) =>
          (row as { current_version_id: string }).current_version_id === draft,
      ),
    ).toMatchObject({ draft_version_id: null });
    expect(after.memberRoles).toEqual([
      {
        team_id: owner.teamId,
        user_id: viewer.userId,
        role_object_id: role.objectId,
      },
    ]);
    expect(after.authority).toContainEqual({
      user_id: candidate.userId,
      level: "admin",
      areas: ["fields"],
      plan_access: false,
    });
    expect(after.twoStep).toContainEqual({
      id: member.userId,
      two_factor_enabled: false,
      secrets: 0,
    });
  });
});
