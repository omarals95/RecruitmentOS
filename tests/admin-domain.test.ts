import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Requests pick the pool by role, as on a split-role deployment: the identity role reads the
// membership, the data role runs withTeam. Only one PGlite role is active at a time.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));

import { GRANTABLE_ADMIN_AREAS } from "@/domain/config";
import { requireVerifiedIdentity } from "@/lib/auth-policy";
import { getVerifiedSession } from "@/lib/auth-session";
import { listActivity } from "@/lib/insights";
import type { Principal } from "@/lib/principal";
import { GET as domainRoute } from "@/app/api/v1/admin/domain/route";
import { createSplitRoleDb, seedApiToken, seedIdentity } from "./helpers/db";

// ADM-40 (job 098): fictional people and addresses only, two teams in one company workspace.
const COMPANY = "00000000-0000-4000-a000-000000000001";
const FIRST = "https://recruitment.example.test";
const SECOND = "https://careers.example.test";
const ATTACKER = "attacker.example.test";
type Caller = Principal | "anonymous" | "bearer";
type DomainRow = {
  team_id: string;
  actor_id: string;
  actor_type: string;
  token_id: string | null;
  record_id: string | null;
  action: string;
  summary: string;
  metadata: Record<string, string>;
};

describe("GET /api/v1/admin/domain under the split runtime roles", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  let owner: Principal, ownerInB: Principal, secondOwner: Principal;
  let companyAdmin: Principal, teamOwnerB: Principal, recruiter: Principal;

  const superuser = async (text: string, params: unknown[] = []) => {
    await harness.asSuperuser();
    return (await harness.client.query(text, params)).rows;
  };
  /** Every domain row, oldest first, read as the superuser. */
  const domainRows = async () =>
    (await superuser(
      "SELECT team_id, actor_id, actor_type, token_id, record_id, action, summary, metadata FROM app.activity WHERE kind = 'domain' ORDER BY created_at, id",
    )) as DomainRow[];
  async function get(
    as: Caller,
    path = "/api/v1/admin/domain",
    headers: Record<string, string> = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; text: string; body: any }> {
    if (as === "anonymous")
      // The real refusal of a request without a session.
      vi.mocked(getVerifiedSession).mockImplementation((async () =>
        requireVerifiedIdentity(null)) as never);
    else if (as !== "bearer")
      vi.mocked(getVerifiedSession).mockResolvedValue({
        user: { id: as.userId, twoFactorEnabled: true },
        session: { activeOrganizationId: as.teamId, createdAt: new Date() },
      } as never);
    const response = await domainRoute(
      new Request(`${FIRST}${path}`, {
        headers: {
          ...(as === "bearer"
            ? { authorization: "Bearer fictional-domain-token" }
            : as === "anonymous"
              ? {}
              : { "x-team-id": as.teamId }),
          ...headers,
        },
      }),
    );
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  }
  /** One open as a caller with BETTER_AUTH_URL set to a value (unset for undefined). */
  const open = (as: Caller, value: string | undefined) => {
    vi.stubEnv("BETTER_AUTH_URL", value);
    return get(as);
  };

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, {
      userId: "domain-owner",
      teamId: "domain-team-a",
    });
    recruiter = await seedIdentity(db, {
      userId: "domain-recruiter",
      teamId: "domain-team-a",
      role: "recruiter",
    });
    // A newly created team: its owner holds no company authority.
    teamOwnerB = await seedIdentity(db, {
      userId: "domain-owner-b",
      teamId: "domain-team-b",
    });
    // The company owner also works in team B as a recruiter.
    ownerInB = await seedIdentity(db, {
      userId: owner.userId,
      teamId: teamOwnerB.teamId,
      role: "recruiter",
    });
    secondOwner = await seedIdentity(db, {
      userId: "domain-second-owner",
      teamId: teamOwnerB.teamId,
      role: "recruiter",
    });
    companyAdmin = await seedIdentity(db, {
      userId: "domain-company-admin",
      teamId: "domain-team-a",
      role: "recruiter",
    });
    await superuser(
      `INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','${secondOwner.userId}','owner','{}'),
        ('${COMPANY}','${companyAdmin.userId}','admin','{${GRANTABLE_ADMIN_AREAS.join(",")}}')`,
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterAll(async () => harness?.close());

  it("records the address once per change for the whole workspace, whichever team or company owner opens it", async () => {
    expect(await domainRows()).toEqual([]);
    const first = await open(owner, FIRST);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      data: {
        address: { origin: FIRST, https: true, originOnly: true, valid: true },
      },
    });
    const baseline = {
      team_id: owner.teamId,
      actor_id: owner.userId,
      actor_type: "session",
      token_id: null,
      record_id: null,
      action: "domain.url_recorded",
      summary: `Recorded the web address ${FIRST}`,
      metadata: { workspaceId: COMPANY, to: FIRST },
    };
    expect(await domainRows()).toEqual([baseline]);
    // A second open, the same owner in the other team and another company owner write nothing.
    for (const p of [owner, ownerInB, secondOwner])
      expect((await open(p, FIRST)).status, p.userId).toBe(200);
    expect(await domainRows()).toEqual([baseline]);

    expect((await open(owner, SECOND)).status).toBe(200);
    const changed = {
      ...baseline,
      action: "domain.url_changed",
      summary: `Changed the web address from ${FIRST} to ${SECOND}`,
      metadata: { workspaceId: COMPANY, from: FIRST, to: SECOND },
    };
    expect(await domainRows()).toEqual([baseline, changed]);
    for (const p of [owner, ownerInB, secondOwner])
      expect((await open(p, SECOND)).status, p.userId).toBe(200);
    expect(await domainRows()).toEqual([baseline, changed]);

    // Changing back, first seen by the second owner in team B: one more row, written in team B.
    expect((await open(secondOwner, FIRST)).status).toBe(200);
    const back = {
      ...baseline,
      team_id: secondOwner.teamId,
      actor_id: secondOwner.userId,
      action: "domain.url_changed",
      summary: `Changed the web address from ${SECOND} to ${FIRST}`,
      metadata: { workspaceId: COMPANY, from: SECOND, to: FIRST },
    };
    expect(await domainRows()).toEqual([baseline, changed, back]);
    for (const p of [owner, ownerInB, secondOwner])
      expect((await open(p, FIRST)).status, p.userId).toBe(200);
    expect(await domainRows()).toHaveLength(3);
  });

  it("answers 401 anonymous, 403 session_required to a Bearer token and 403 domain_forbidden to everyone but a company owner, writing nothing", async () => {
    vi.stubEnv("BETTER_AUTH_URL", SECOND);
    const before = await domainRows();
    pools.data.mockClear();
    const anonymous = await get("anonymous");
    expect(anonymous.status).toBe(401);
    const bearer = await get("bearer");
    expect(bearer.status).toBe(403);
    expect(bearer.body.error.code).toBe("session_required");
    expect(pools.data).not.toHaveBeenCalled();
    for (const p of [companyAdmin, teamOwnerB, recruiter]) {
      const { status, body, text } = await get(p);
      expect(status, p.userId).toBe(403);
      expect(body.error.code, p.userId).toBe("domain_forbidden");
      expect(text, p.userId).not.toContain(SECOND);
    }
    expect(await domainRows()).toEqual(before);
    for (const p of [owner, ownerInB, secondOwner]) {
      const { status, body } = await get(p);
      expect(status, p.userId).toBe(200);
      expect(Object.keys(body.data)).toEqual(["address"]);
      expect(Object.keys(body.data.address).sort()).toEqual([
        "https",
        "origin",
        "originOnly",
        "valid",
      ]);
    }
    // The owners' opens recorded the change from the last test's address once.
    expect(await domainRows()).toHaveLength(before.length + 1);
  });

  it("checks the address without returning the raw value, and writes nothing for one sign-in refuses", async () => {
    const before = await domainRows();
    const cases: [string | undefined, Record<string, unknown>, boolean][] = [
      [
        FIRST,
        { origin: FIRST, https: true, originOnly: true, valid: true },
        false,
      ],
      [
        `${FIRST}/`,
        { origin: FIRST, https: true, originOnly: false, valid: true },
        false,
      ],
      [
        `${FIRST}/app`,
        { origin: FIRST, https: true, originOnly: false, valid: false },
        false,
      ],
      [
        "https://fictional-user:fictional-secret@recruitment.example.test",
        { origin: FIRST, https: true, originOnly: false, valid: false },
        false,
      ],
      [
        "http://recruitment.example.test",
        {
          origin: "http://recruitment.example.test",
          https: false,
          originOnly: true,
          valid: false,
        },
        true,
      ],
      [
        undefined,
        { origin: null, https: false, originOnly: false, valid: false },
        false,
      ],
      [
        "not a web address",
        { origin: null, https: false, originOnly: false, valid: false },
        false,
      ],
    ];
    // The last open of the earlier tests left SECOND recorded; settle on FIRST first.
    await open(owner, FIRST);
    const settled = await domainRows();
    for (const [value, address, hosted] of cases) {
      if (hosted) vi.stubEnv("VERCEL", "1");
      const { status, body, text } = await open(owner, value);
      expect(status, value).toBe(200);
      expect(body, value).toEqual({ data: { address } });
      for (const raw of ["/app", "fictional-secret", "fictional-user"])
        expect(text, value).not.toContain(raw);
      vi.unstubAllEnvs();
    }
    expect(settled).toHaveLength(before.length + 1);
    expect(await domainRows()).toEqual(settled);
  });

  it("makes no outgoing request, reads no Host or forwarding header, and refuses a query with no row written", async () => {
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    vi.stubEnv("BETTER_AUTH_URL", FIRST);
    const before = await domainRows();
    const plain = await get(owner);
    const forged = await get(owner, undefined, {
      host: ATTACKER,
      "x-forwarded-host": ATTACKER,
      "x-forwarded-proto": "http",
    });
    for (const response of [plain, forged]) {
      expect(response.status).toBe(200);
      expect(response.body.data.address.origin).toBe(FIRST);
      expect(response.text).not.toContain(ATTACKER);
    }
    for (const path of [
      `/api/v1/admin/domain?address=${encodeURIComponent(`https://${ATTACKER}`)}`,
      "/api/v1/admin/domain?check=1",
    ]) {
      vi.stubEnv("BETTER_AUTH_URL", SECOND);
      const { status, body } = await get(owner, path);
      expect(status, path).toBe(400);
      expect(body.error.code, path).toBe("invalid_input");
    }
    expect(await domainRows()).toEqual(before);
    expect(fetched).not.toHaveBeenCalled();
  });

  it("shows domain rows in the feed of the writing team to company sessions only, never to a member without company authority or a token", async () => {
    const run = async (p: Principal) => {
      await harness.dataDb();
      return (
        await listActivity({ ...p }, new URLSearchParams("pageSize=100"))
      ).data.filter((row) => row.kind === "domain");
    };
    const all = await domainRows();
    const inA = all.filter((row) => row.team_id === owner.teamId);
    const inB = all.filter((row) => row.team_id === teamOwnerB.teamId);
    expect(inA.length).toBeGreaterThan(0);
    expect(inB.length).toBeGreaterThan(0);
    expect((await run(owner)).map((row) => row.summary).sort()).toEqual(
      inA.map((row) => row.summary).sort(),
    );
    expect((await run(companyAdmin)).length).toBe(inA.length);
    expect((await run(ownerInB)).map((row) => row.summary).sort()).toEqual(
      inB.map((row) => row.summary).sort(),
    );
    expect(await run(recruiter)).toEqual([]);
    expect(await run(teamOwnerB)).toEqual([]);
    const token = await seedApiToken(await harness.asOwner(), owner);
    expect(await run(token)).toEqual([]);
  });
});
