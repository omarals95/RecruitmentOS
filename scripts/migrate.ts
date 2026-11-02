import "./load-env";
import { Client } from "pg";
import { applyMigrations, getDb } from "../src/db";
async function main() {
  if (process.env.DATABASE_MODE === "pglite") {
    await getDb();
    console.log("Local PostgreSQL migrations applied.");
    return;
  }
  if (!process.env.MIGRATION_DATABASE_URL)
    throw new Error(
      "Set MIGRATION_DATABASE_URL to the owner connection. The application runtime uses a separate DATABASE_URL.",
    );
  if (
    process.env.NODE_ENV === "production" &&
    process.env.MIGRATION_DATABASE_URL === process.env.DATABASE_URL
  )
    throw new Error(
      "Migration and runtime credentials must be separate in production.",
    );
  const url = new URL(process.env.MIGRATION_DATABASE_URL);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname))
    url.searchParams.set("sslmode", "verify-full");
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(
      "SELECT pg_advisory_lock(hashtextextended('recruitmentos:migrations',0))",
    );
    await applyMigrations({ exec: async (query) => client.query(query) });
    console.log("PostgreSQL migrations applied.");
  } finally {
    await client.end();
  }
}
main().catch(() => {
  console.error(
    "Migration failed. Check the migration connection and database setup; credentials are never printed.",
  );
  process.exitCode = 1;
});
