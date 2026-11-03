import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as app from "./schema";
import * as auth from "./auth-schema";
import { ApiError } from "../lib/errors";
import { runtimeRoleSafetyQuery } from "./runtime-role";
export const schema = { ...app, ...auth };
export type AppDb = NodePgDatabase<typeof schema>;
export type TeamTx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];
let singleton: Promise<AppDb> | undefined;
export function getDb(): Promise<AppDb> {
  if (!singleton)
    singleton = createDb().catch((error) => {
      singleton = undefined;
      throw error;
    });
  return singleton;
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
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!local) url.searchParams.set("sslmode", "verify-full");
  const pool = new Pool({
    connectionString: url.toString(),
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    allowExitOnIdle: true,
    ...(!local ? { ssl: { rejectUnauthorized: true } } : {}),
  });
  if (process.env.NODE_ENV === "production") {
    try {
      const result = await pool.query<{ unsafe: boolean }>(
        runtimeRoleSafetyQuery,
      );
      if (result.rows[0]?.unsafe !== false)
        throw new ApiError(
          503,
          "unsafe_database_role",
          "Configure a restricted database runtime role without ownership or elevated privileges.",
        );
    } catch (error) {
      await pool.end();
      throw error;
    }
  }
  if (process.env.VERCEL) {
    const { attachDatabasePool } = await import("@vercel/functions");
    attachDatabasePool(pool);
  }
  return drizzle(pool, { schema });
}
export async function applyMigrations(client: {
  exec: (query: string) => Promise<unknown>;
}) {
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await client.exec(
    "CREATE TABLE IF NOT EXISTS public.recruitment_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const files = (await readdir(join(process.cwd(), "drizzle")))
    .filter((f) => /^\d{4}.*\.sql$/.test(f))
    .sort();
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
  if (process.env.VITEST !== "true")
    throw new Error("Test database injection is disabled");
  singleton = Promise.resolve(db);
}
