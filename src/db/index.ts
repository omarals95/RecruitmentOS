import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as app from "./schema";
import * as auth from "./auth-schema";
import { ApiError } from "../lib/errors";
import { installTenantContextKey } from "../lib/tenant-context";
import { runtimeRoleSafetyQuery } from "./runtime-role";
import { assertStorageSchema } from "./storage-schema";
import {
  dataRoleBoundaryQuery,
  identityRoleBoundaryQuery,
  isLoopbackHost,
  markerRoleBoundaryQuery,
  prepareConnectionTargets,
  verifyPoolPair,
} from "./connection-boundary";
import type { Pool } from "pg";
export const schema = { ...app, ...auth };
export type AppDb = NodePgDatabase<typeof schema>;
export type TeamTx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];
let singleton: Promise<AppDb> | undefined;
let identityPair: Promise<{ data: AppDb; identity: AppDb }> | undefined;
let testDatabase: Promise<AppDb> | undefined;
function hostedOrProduction() {
  return process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
}
export function getDb(): Promise<AppDb> {
  if (testDatabase) return testDatabase;
  if (hostedOrProduction() || process.env.IDENTITY_DATABASE_URL)
    return getDbPair().then((pair) => pair.data);
  if (!singleton)
    singleton = createDb().catch((error) => {
      singleton = undefined;
      throw error;
    });
  return singleton;
}
export function getIdentityDb(): Promise<AppDb> {
  if (testDatabase) return testDatabase;
  if (hostedOrProduction() || process.env.IDENTITY_DATABASE_URL)
    return getDbPair().then((pair) => pair.identity);
  return getDb();
}

function getDbPair(): Promise<{ data: AppDb; identity: AppDb }> {
  if (!identityPair)
    identityPair = createDbPair().catch((error) => {
      identityPair = undefined;
      throw error;
    });
  return identityPair;
}

async function createDbPair(): Promise<{ data: AppDb; identity: AppDb }> {
  if (process.env.DATABASE_MODE === "pglite")
    throw new ApiError(
      503,
      "local_db_disabled",
      "Local database mode is not available for isolated production pools.",
    );
  const dataUrl = process.env.DATABASE_URL;
  const identityUrl = process.env.IDENTITY_DATABASE_URL;
  if (!dataUrl || !identityUrl)
    throw new ApiError(
      503,
      "unsafe_database_connections",
      "Configure separate database connections for recruitment data and identity.",
    );
  const targets = prepareConnectionTargets(dataUrl, identityUrl);
  // Remove only after trusted tenant policies and identity workflows pass end-to-end review.
  if (hostedOrProduction())
    throw new ApiError(
      503,
      "tenant_isolation_pending",
      "The database identity boundary is not ready for deployment.",
    );
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  function makePool(connectionString: string) {
    const url = new URL(connectionString);
    const local = isLoopbackHost(url.hostname);
    if (!local) url.searchParams.set("sslmode", "verify-full");
    return new Pool({
      connectionString: url.toString(),
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
      allowExitOnIdle: true,
      ...(!local ? { ssl: { rejectUnauthorized: true } } : {}),
    });
  }
  const dataPool = makePool(targets.dataUrl);
  const identityPool = makePool(targets.identityUrl);
  try {
    async function inspect(pool: Pool, boundaryQuery: string) {
      const principal = await pool.query<{
        role: string;
        sessionRole: string;
        database: string;
      }>(
        'SELECT current_user::text AS role, session_user::text AS "sessionRole", current_database()::text AS database',
      );
      if (
        principal.rows.length !== 1 ||
        !principal.rows[0].role ||
        principal.rows[0].role !== principal.rows[0].sessionRole
      )
        throw new ApiError(
          503,
          "unsafe_database_role",
          "The session login must match the effective database role.",
        );
      for (const query of [
        runtimeRoleSafetyQuery,
        markerRoleBoundaryQuery,
        boundaryQuery,
      ]) {
        const safety = await pool.query<{ unsafe: boolean }>(query);
        if (safety.rows.length !== 1 || safety.rows[0].unsafe !== false)
          throw new ApiError(
            503,
            "unsafe_database_role",
            "A database role violates the configured identity boundary.",
          );
      }
      const marker = await pool.query<{ marker: string }>(
        "SELECT id::text AS marker FROM db_boundary.connection_marker",
      );
      if (principal.rows.length !== 1 || marker.rows.length !== 1)
        throw new ApiError(
          503,
          "unsafe_database_connections",
          "The database connection identity marker is unavailable.",
        );
      return { ...principal.rows[0], marker: marker.rows[0].marker };
    }
    const data = await inspect(dataPool, dataRoleBoundaryQuery);
    const identity = await inspect(identityPool, identityRoleBoundaryQuery);
    const dataMembership = await dataPool.query<{ member: boolean }>(
      "SELECT pg_catalog.pg_has_role(current_user, $1::text, 'MEMBER') AS member",
      [identity.role],
    );
    const identityMembership = await identityPool.query<{ member: boolean }>(
      "SELECT pg_catalog.pg_has_role(current_user, $1::text, 'MEMBER') AS member",
      [data.role],
    );
    verifyPoolPair(
      { ...data, canAssumeOther: dataMembership.rows[0]?.member },
      { ...identity, canAssumeOther: identityMembership.rows[0]?.member },
    );
    await assertStorageSchema(dataPool);
    if (process.env.VERCEL) {
      const { attachDatabasePool } = await import("@vercel/functions");
      attachDatabasePool(dataPool);
      attachDatabasePool(identityPool);
    }
    return {
      data: drizzle(dataPool, { schema }),
      identity: drizzle(identityPool, { schema }),
    };
  } catch (error) {
    await Promise.allSettled([dataPool.end(), identityPool.end()]);
    throw error;
  }
}
async function createDb(): Promise<AppDb> {
  if (process.env.DATABASE_MODE === "pglite") {
    if (
      process.env.NODE_ENV === "production" ||
      process.env.ALLOW_LOCAL_DB !== "true"
    )
      throw new ApiError(
        503,
        "local_db_disabled",
        "Local database mode must be explicitly enabled for development.",
      );
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { resolve } = await import("node:path");
    const client = new PGlite(
      resolve(process.cwd(), process.env.PGLITE_DATA_DIR || ".local/database"),
    );
    await applyMigrations(client);
    // The PGlite process is the owner here; other databases get the key from db:migrate.
    await installTenantContextKey(client);
    await assertStorageSchema(client);
    return drizzle(client, { schema }) as unknown as AppDb;
  }
  if (!process.env.DATABASE_URL)
    throw new ApiError(
      503,
      "database_not_configured",
      "The database connection is not configured.",
    );
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const url = new URL(process.env.DATABASE_URL);
  const local = isLoopbackHost(url.hostname);
  if (!local) url.searchParams.set("sslmode", "verify-full");
  const pool = new Pool({
    connectionString: url.toString(),
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: true,
    ...(!local ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  try {
    if (process.env.NODE_ENV === "production") {
      const result = await pool.query<{ unsafe: boolean }>(
        runtimeRoleSafetyQuery,
      );
      if (result.rows[0]?.unsafe !== false)
        throw new ApiError(
          503,
          "unsafe_database_role",
          "Configure a restricted database runtime role without ownership or elevated privileges.",
        );
    }
    await assertStorageSchema(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  if (process.env.VERCEL) {
    const { attachDatabasePool } = await import("@vercel/functions");
    attachDatabasePool(pool);
  }
  return drizzle(pool, { schema });
}
/** `through` (tests only) stops after the named file; production callers apply every file. */
export async function applyMigrations(
  client: {
    exec: (query: string) => Promise<unknown>;
  },
  through?: string,
) {
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await client.exec(
    "CREATE TABLE IF NOT EXISTS public.recruitment_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const all = (await readdir(join(process.cwd(), "drizzle")))
    .filter((f) => /^\d{4}.*\.sql$/.test(f))
    .sort();
  if (through !== undefined && !all.includes(through))
    throw new Error("Unknown migration file.");
  const files =
    through === undefined ? all : all.slice(0, all.indexOf(through) + 1);
  // The adapter only needs exec; a transactional DO block avoids applying an already tracked migration.
  for (const file of files) {
    const body = await readFile(join(process.cwd(), "drizzle", file), "utf8");
    const safe = file.replaceAll("'", "''");
    await client.exec(
      `DO $migration$ BEGIN IF NOT EXISTS(SELECT 1 FROM public.recruitment_migrations WHERE name='${safe}') THEN ${body} INSERT INTO public.recruitment_migrations(name) VALUES('${safe}'); END IF; END $migration$;`,
    );
  }
}
/** Test injection is disabled outside Vitest; never used by production entry points. */
export function setDbForTests(db: AppDb) {
  if (process.env.VITEST !== "true" || hostedOrProduction())
    throw new Error("Test database injection is disabled");
  testDatabase = Promise.resolve(db);
}
