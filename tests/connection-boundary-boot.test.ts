import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDb } from "../src/db";
import {
  dataRoleBoundaryQuery,
  identityRoleBoundaryQuery,
  markerRoleBoundaryQuery,
} from "../src/db/connection-boundary";
import { runtimeRoleSafetyQuery } from "../src/db/runtime-role";

type PoolName = "data" | "identity";
type QueryKind =
  | "principal"
  | "safety"
  | "markerBoundary"
  | "dataBoundary"
  | "identityBoundary"
  | "marker"
  | "member"
  | "storage";
type Rows = (pool: PoolName, kind: QueryKind) => unknown[] | undefined;

const mocks = vi.hoisted(() => ({
  pools: [] as Array<{
    name: string;
    connectionString: string;
    ssl: unknown;
    kinds: string[];
    end: ReturnType<typeof vi.fn>;
  }>,
  rows: undefined as
    | undefined
    | ((pool: string, query: string) => { kind: string; rows: unknown[] }),
  attach: vi.fn(),
}));
vi.mock("pg", () => ({
  Pool: class {
    name: string;
    connectionString: string;
    ssl: unknown;
    kinds: string[] = [];
    end = vi.fn(async () => undefined);
    on = vi.fn();
    constructor(options: { connectionString: string; ssl?: unknown }) {
      this.connectionString = options.connectionString;
      this.ssl = options.ssl;
      this.name = new URL(options.connectionString).username;
      mocks.pools.push(this);
    }
    async query(query: string) {
      const result = mocks.rows!(this.name, query);
      this.kinds.push(result.kind);
      return { rows: result.rows };
    }
  },
}));
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: (pool: unknown) => ({ pool }),
}));
vi.mock("@vercel/functions", () => ({ attachDatabasePool: mocks.attach }));

const marker = "0f6c3a52-8d1e-4b7a-9c2f-3e5d7a1b9c40";
let override: Rows | undefined;
function kindOf(query: string): QueryKind {
  if (query === runtimeRoleSafetyQuery) return "safety";
  if (query === markerRoleBoundaryQuery) return "markerBoundary";
  if (query === dataRoleBoundaryQuery) return "dataBoundary";
  if (query === identityRoleBoundaryQuery) return "identityBoundary";
  if (query.includes("session_user")) return "principal";
  if (query.includes("FROM db_boundary.connection_marker")) return "marker";
  if (query.includes("pg_has_role(current_user, $1")) return "member";
  if (query.includes("db_boundary.storage_schema")) return "storage";
  throw new Error("Unexpected startup query.");
}
// A correct split-role database: distinct logins, every check safe, one shared marker.
function baselineRows(pool: PoolName, kind: QueryKind): unknown[] {
  if (kind === "principal")
    return [{ role: pool, sessionRole: pool, database: "neondb" }];
  if (kind === "marker") return [{ marker }];
  if (kind === "member") return [{ member: false }];
  if (kind === "storage") return [{ version: 34 }];
  return [{ unsafe: false }];
}
mocks.rows = (pool, query) => {
  const kind = kindOf(query);
  const name = pool as PoolName;
  return {
    kind,
    rows: override?.(name, kind) ?? baselineRows(name, kind),
  };
};

const variants = [
  { label: "NODE_ENV=production", nodeEnv: "production", vercel: "" },
  { label: "VERCEL=1", nodeEnv: "development", vercel: "1" },
] as const;
function hosted(variant: (typeof variants)[number]) {
  vi.stubEnv("NODE_ENV", variant.nodeEnv);
  vi.stubEnv("VERCEL", variant.vercel);
  vi.stubEnv("DATABASE_MODE", "postgres");
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://data:fake@example.test/neondb?sslmode=require",
  );
  vi.stubEnv(
    "IDENTITY_DATABASE_URL",
    "postgresql://identity:fake@example.test/neondb?sslmode=require",
  );
  vi.stubEnv(
    "TENANT_CONTEXT_SIGNING_KEY",
    "FictionalTenantContextTestKeyOnly0123456789A",
  );
  for (const name of [
    "ALLOW_LOCAL_DB",
    "DEV_MAIL_MODE",
    "DEV_SEED_PASSWORD",
    "PGOPTIONS",
    "ALLOW_UNSAFE_TENANT_ISOLATION",
  ])
    vi.stubEnv(name, "");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  mocks.pools.length = 0;
  mocks.attach.mockReset();
  override = undefined;
});

describe("database connection startup", () => {
  it("forbids test-database injection in hosted and production processes", async () => {
    vi.stubEnv("VITEST", "true");
    vi.stubEnv("NODE_ENV", "production");
    const db = await import("../src/db");
    expect(() => db.setDbForTests({} as AppDb)).toThrow();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "1");
    expect(() => db.setDbForTests({} as AppDb)).toThrow();
  });

  it("injects one synthetic PGlite database into both pools for existing tests", async () => {
    const db = await import("../src/db");
    const synthetic = {} as AppDb;
    db.setDbForTests(synthetic);
    expect(await db.getDb()).toBe(synthetic);
    expect(await db.getIdentityDb()).toBe(synthetic);
  });
});

describe.each(variants)("hosted database startup ($label)", (variant) => {
  async function expectStarts() {
    const { getDb, getIdentityDb } = await import("../src/db");
    const data = await getDb();
    const identity = await getIdentityDb();
    expect(mocks.pools.map((pool) => pool.name)).toEqual(["data", "identity"]);
    const [dataPool, identityPool] = mocks.pools;
    expect(data).toEqual({ pool: dataPool });
    expect(identity).toEqual({ pool: identityPool });
    for (const pool of mocks.pools) {
      const url = new URL(pool.connectionString);
      expect(url.searchParams.get("sslmode")).toBe("verify-full");
      expect(url.hostname).toBe("example.test");
      expect(pool.ssl).toEqual({ rejectUnauthorized: true });
      expect(pool.end).not.toHaveBeenCalled();
    }
    expect(dataPool.kinds).toEqual([
      "principal",
      "safety",
      "markerBoundary",
      "dataBoundary",
      "marker",
      "member",
      "storage",
    ]);
    expect(identityPool.kinds).toEqual([
      "principal",
      "safety",
      "markerBoundary",
      "identityBoundary",
      "marker",
      "member",
    ]);
    if (variant.vercel) {
      expect(mocks.attach).toHaveBeenCalledTimes(2);
      expect(mocks.attach).toHaveBeenNthCalledWith(1, dataPool);
      expect(mocks.attach).toHaveBeenNthCalledWith(2, identityPool);
    } else expect(mocks.attach).not.toHaveBeenCalled();
  }

  it("starts a correct split-role configuration with two verify-full pools", async () => {
    hosted(variant);
    await expectStarts();
  });

  it("gives ALLOW_UNSAFE_TENANT_ISOLATION no effect on startup or refusals", async () => {
    hosted(variant);
    vi.stubEnv("ALLOW_UNSAFE_TENANT_ISOLATION", "true");
    await expectStarts();
    vi.resetModules();
    mocks.pools.length = 0;
    vi.stubEnv("DEV_MAIL_MODE", "console");
    const { getDb } = await import("../src/db");
    await expect(getDb()).rejects.toMatchObject({
      status: 503,
      code: "development_setting_refused",
    });
    expect(mocks.pools).toHaveLength(0);
  });

  // Requirement 2: refused before any pool is constructed.
  for (const [label, name, value, code] of [
    ["DATABASE_MODE=pglite", "DATABASE_MODE", "pglite", "local_db_disabled"],
    ["ALLOW_LOCAL_DB=true", "ALLOW_LOCAL_DB", "true", "local_db_disabled"],
    [
      "DEV_MAIL_MODE=console",
      "DEV_MAIL_MODE",
      "console",
      "development_setting_refused",
    ],
    [
      "a DEV_SEED_PASSWORD",
      "DEV_SEED_PASSWORD",
      "FictionalSeedPassword-1",
      "development_setting_refused",
    ],
    [
      "a missing TENANT_CONTEXT_SIGNING_KEY",
      "TENANT_CONTEXT_SIGNING_KEY",
      "",
      "tenant_context_unavailable",
    ],
    [
      "a malformed TENANT_CONTEXT_SIGNING_KEY",
      "TENANT_CONTEXT_SIGNING_KEY",
      "fictional+short/key",
      "tenant_context_unavailable",
    ],
  ] as const)
    it(`refuses ${label} before creating any pool`, async () => {
      hosted(variant);
      vi.stubEnv(name, value);
      const { getDb, getIdentityDb } = await import("../src/db");
      for (const get of [getDb, getIdentityDb]) {
        const error = await get().catch((caught: unknown) => caught);
        expect(error).toMatchObject({ status: 503, code });
        if (value) expect((error as Error).message).not.toContain(value);
      }
      expect(mocks.pools).toHaveLength(0);
      expect(mocks.attach).not.toHaveBeenCalled();
    });

  // Each case changes one thing from the baseline; every pool that was created is ended.
  const refusals: Array<{
    label: string;
    code: string;
    pools: number;
    env?: Record<string, string>;
    rows?: Rows;
  }> = [
    {
      label: "a missing IDENTITY_DATABASE_URL",
      code: "unsafe_database_connections",
      pools: 0,
      env: { IDENTITY_DATABASE_URL: "" },
    },
    {
      label: "a missing DATABASE_URL",
      code: "unsafe_database_connections",
      pools: 0,
      env: { DATABASE_URL: "" },
    },
    {
      label: "different hosts in the two URLs",
      code: "unsafe_database_connections",
      pools: 0,
      env: {
        IDENTITY_DATABASE_URL:
          "postgresql://identity:fake@other.example.test/neondb?sslmode=require",
      },
    },
    {
      label: "different databases in the two URLs",
      code: "unsafe_database_connections",
      pools: 0,
      env: {
        IDENTITY_DATABASE_URL:
          "postgresql://identity:fake@example.test/otherdb?sslmode=require",
      },
    },
    {
      label: "an unsupported channel_binding URL parameter",
      code: "unsafe_database_connections",
      pools: 0,
      env: {
        DATABASE_URL:
          "postgresql://data:fake@example.test/neondb?sslmode=require&channel_binding=require",
      },
    },
    {
      label: "a non-empty PGOPTIONS",
      code: "unsafe_database_connections",
      pools: 0,
      env: { PGOPTIONS: "-c role=other" },
    },
    {
      label: "a session login that differs from the effective role",
      code: "unsafe_database_role",
      pools: 2,
      rows: (pool, kind) =>
        pool === "data" && kind === "principal"
          ? [
              {
                role: "data",
                sessionRole: "elevated_login",
                database: "neondb",
              },
            ]
          : undefined,
    },
    ...(
      [
        ["the runtime role safety query", "data", "safety"],
        ["the marker boundary query", "identity", "markerBoundary"],
        ["the data role boundary query", "data", "dataBoundary"],
        ["the identity role boundary query", "identity", "identityBoundary"],
      ] as const
    ).map(([query, unsafePool, unsafeKind]) => ({
      label: `an unsafe result from ${query}`,
      code: "unsafe_database_role",
      pools: 2,
      rows: ((pool, kind) =>
        pool === unsafePool && kind === unsafeKind
          ? [{ unsafe: true }]
          : undefined) as Rows,
    })),
    {
      label: "a missing connection marker row",
      code: "unsafe_database_connections",
      pools: 2,
      rows: (pool, kind) =>
        pool === "identity" && kind === "marker" ? [] : undefined,
    },
    {
      label: "both pools reporting the same effective role",
      code: "unsafe_database_connections",
      pools: 2,
      rows: (pool, kind) =>
        pool === "identity" && kind === "principal"
          ? [{ role: "data", sessionRole: "data", database: "neondb" }]
          : undefined,
    },
    {
      label: "mismatched connection markers",
      code: "unsafe_database_connections",
      pools: 2,
      rows: (pool, kind) =>
        pool === "identity" && kind === "marker"
          ? [{ marker: "7b2e9d14-3c6a-4f85-b1d0-6a9e2c4f8b13" }]
          : undefined,
    },
    {
      label: "a role able to assume the other",
      code: "unsafe_database_connections",
      pools: 2,
      rows: (pool, kind) =>
        pool === "data" && kind === "member" ? [{ member: true }] : undefined,
    },
    {
      label: "a missing storage schema version",
      code: "storage_schema_mismatch",
      pools: 2,
      rows: (_pool, kind) => (kind === "storage" ? [] : undefined),
    },
    {
      label: "a wrong storage schema version",
      code: "storage_schema_mismatch",
      pools: 2,
      rows: (_pool, kind) =>
        kind === "storage" ? [{ version: 1 }] : undefined,
    },
  ];
  for (const refusal of refusals)
    it(`refuses ${refusal.label} and ends every created pool`, async () => {
      hosted(variant);
      for (const [name, value] of Object.entries(refusal.env ?? {}))
        vi.stubEnv(name, value);
      override = refusal.rows;
      const { getDb, getIdentityDb } = await import("../src/db");
      for (const get of [getDb, getIdentityDb]) {
        mocks.pools.length = 0;
        await expect(get()).rejects.toMatchObject({
          status: 503,
          code: refusal.code,
        });
        expect(mocks.pools).toHaveLength(refusal.pools);
        for (const pool of mocks.pools)
          expect(pool.end).toHaveBeenCalledTimes(1);
      }
      expect(mocks.attach).not.toHaveBeenCalled();
    });
});
