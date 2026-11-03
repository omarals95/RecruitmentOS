import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pools: [] as Array<{
    query: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    connectionString: string;
    ssl: unknown;
  }>,
  query: vi.fn(),
}));
vi.mock("pg", () => ({
  Pool: class {
    query = mocks.query;
    end = vi.fn(async () => undefined);
    connectionString: string;
    ssl: unknown;
    constructor(options: { connectionString: string; ssl?: unknown }) {
      this.connectionString = options.connectionString;
      this.ssl = options.ssl;
      mocks.pools.push(this);
    }
  },
}));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: () => ({}) }));

import { getDb } from "../src/db";

describe("database pool preflight", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.pools.length = 0;
    mocks.query.mockReset();
  });
  function configure() {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("DATABASE_MODE", "postgres");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://data:fake@example.test/neondb?sslmode=require",
    );
    vi.stubEnv(
      "IDENTITY_DATABASE_URL",
      "postgresql://identity:fake@example.test/neondb?sslmode=require",
    );
  }

  it("rejects PGOPTIONS before creating or connecting either pool", async () => {
    configure();
    vi.stubEnv("PGOPTIONS", "-c role=other");
    await expect(getDb()).rejects.toMatchObject({
      code: "unsafe_database_connections",
    });
    expect(mocks.pools).toHaveLength(0);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects a changed effective role before trusting role permissions", async () => {
    configure();
    vi.stubEnv("PGOPTIONS", "");
    vi.stubEnv("PGPORT", "6543");
    mocks.query.mockResolvedValue({
      rows: [
        {
          role: "restricted",
          sessionRole: "elevated_login",
          database: "neondb",
        },
      ],
    });
    await expect(getDb()).rejects.toMatchObject({
      code: "unsafe_database_role",
    });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(String(mocks.query.mock.calls[0][0])).toContain("session_user");
    expect(mocks.pools).toHaveLength(2);
    expect(
      mocks.pools.map((pool) => new URL(pool.connectionString).port),
    ).toEqual(["5432", "5432"]);
    expect(mocks.pools.every((pool) => pool.end.mock.calls.length === 1)).toBe(
      true,
    );
  });

  it("does not force remote TLS on bracketed IPv6 loopback for the paired pools", async () => {
    configure();
    vi.stubEnv("PGOPTIONS", "");
    vi.stubEnv("DATABASE_URL", "postgresql://data:fake@[::1]/neondb");
    vi.stubEnv(
      "IDENTITY_DATABASE_URL",
      "postgresql://identity:fake@[::1]/neondb",
    );
    mocks.query.mockResolvedValue({
      rows: [{ role: "restricted", sessionRole: "other", database: "neondb" }],
    });
    await expect(getDb()).rejects.toMatchObject({
      code: "unsafe_database_role",
    });
    expect(mocks.pools).toHaveLength(2);
    for (const pool of mocks.pools) {
      expect(pool.ssl).toBeUndefined();
      expect(new URL(pool.connectionString).searchParams.has("sslmode")).toBe(
        false,
      );
    }
  });

  it("does not force remote TLS on bracketed IPv6 loopback for the local single pool", async () => {
    configure();
    vi.stubEnv("IDENTITY_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", "postgresql://data:fake@[::1]/neondb");
    await expect(getDb()).resolves.toBeTruthy();
    expect(mocks.pools).toHaveLength(1);
    expect(mocks.pools[0].ssl).toBeUndefined();
    expect(
      new URL(mocks.pools[0].connectionString).searchParams.has("sslmode"),
    ).toBe(false);
  });
});
