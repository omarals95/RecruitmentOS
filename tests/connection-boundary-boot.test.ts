import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDb } from "../src/db";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
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
  it("refuses a production data pool when the distinct identity connection is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_MODE", "postgres");
    vi.stubEnv("DATABASE_URL", "postgresql://data:fake@example.test/neondb");
    vi.stubEnv("IDENTITY_DATABASE_URL", "");
    const { getDb } = await import("../src/db");
    await expect(getDb()).rejects.toMatchObject({
      code: "unsafe_database_connections",
    });
  });

  it("injects one synthetic PGlite database into both pools for existing tests", async () => {
    const db = await import("../src/db");
    const synthetic = {} as AppDb;
    db.setDbForTests(synthetic);
    expect(await db.getDb()).toBe(synthetic);
    expect(await db.getIdentityDb()).toBe(synthetic);
  });

  it("keeps production closed while trusted tenant RLS and dependent workflows are unfinished", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_MODE", "postgres");
    vi.stubEnv("DATABASE_URL", "postgresql://data:fake@example.test/neondb");
    vi.stubEnv(
      "IDENTITY_DATABASE_URL",
      "postgresql://identity:fake@example.test/neondb",
    );
    vi.stubEnv("ALLOW_UNSAFE_TENANT_ISOLATION", "true");
    const { getDb, getIdentityDb } = await import("../src/db");
    await expect(getDb()).rejects.toMatchObject({
      code: "tenant_isolation_pending",
    });
    await expect(getIdentityDb()).rejects.toMatchObject({
      code: "tenant_isolation_pending",
    });
  });

  it("keeps a hosted deployment closed even if its NODE_ENV is mislabeled", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("DATABASE_MODE", "postgres");
    vi.stubEnv("DATABASE_URL", "postgresql://data:fake@example.test/neondb");
    vi.stubEnv(
      "IDENTITY_DATABASE_URL",
      "postgresql://identity:fake@example.test/neondb",
    );
    const { getDb, getIdentityDb } = await import("../src/db");
    await expect(getDb()).rejects.toMatchObject({
      code: "tenant_isolation_pending",
    });
    await expect(getIdentityDb()).rejects.toMatchObject({
      code: "tenant_isolation_pending",
    });
  });
});
