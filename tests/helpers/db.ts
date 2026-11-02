import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { applyMigrations, schema, setDbForTests, type AppDb } from "@/db";
import { member, organization, user } from "@/db/auth-schema";
import type { Principal } from "@/lib/principal";
import { roleScopes, type Role } from "@/lib/permissions";
export async function createTestDb() {
  const client = new PGlite();
  await applyMigrations(client);
  const db = drizzle(client, { schema }) as unknown as AppDb;
  setDbForTests(db);
  return { db, client, close: () => client.close() };
}
export async function seedIdentity(
  db: AppDb,
  options: {
    userId?: string;
    teamId?: string;
    role?: Role;
    emailVerified?: boolean;
  } = {},
) {
  const userId = options.userId ?? "test-owner";
  const teamId = options.teamId ?? "test-team";
  const role = options.role ?? "owner";
  await db
    .insert(user)
    .values({
      id: userId,
      name: "Fictional Test User",
      email: `${userId}@example.test`,
      emailVerified: options.emailVerified ?? true,
    })
    .onConflictDoNothing();
  await db
    .insert(organization)
    .values({
      id: teamId,
      name: "Fictional Test Team",
      slug: teamId,
      createdBy: userId,
    })
    .onConflictDoNothing();
  await db
    .insert(member)
    .values({ id: `${userId}:${teamId}`, organizationId: teamId, userId, role })
    .onConflictDoNothing();
  const principal: Principal = {
    userId,
    teamId,
    role,
    scopes: roleScopes(role),
    authType: "session",
  };
  return principal;
}
/** Switch to a nonowner/non-BYPASSRLS role to exercise real PostgreSQL policies. */
export async function enforceTestRls(db: AppDb) {
  for (const statement of [
    "CREATE ROLE recruitment_test_runtime NOLOGIN",
    "GRANT USAGE ON SCHEMA app,auth TO recruitment_test_runtime",
    "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA app,auth TO recruitment_test_runtime",
    "GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app,auth TO recruitment_test_runtime",
    "SET ROLE recruitment_test_runtime",
  ])
    await db.execute(sql.raw(statement));
}
