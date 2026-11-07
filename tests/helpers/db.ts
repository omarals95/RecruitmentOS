import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { applyMigrations, schema, setDbForTests, type AppDb } from "@/db";
import {
  apiTokens,
  initialAdminClaim,
  member,
  organization,
  user,
} from "@/db/auth-schema";
import { dataRoleHelpers, identityRoleHelpers } from "@/db/connection-boundary";
import type { Principal } from "@/lib/principal";
import { roleScopes, type Role } from "@/lib/permissions";
import { installTenantContextKey } from "@/lib/tenant-context";
import { readRuntimeRoleTemplate } from "../../scripts/runtime-role-template";
export async function createTestDb() {
  const client = new PGlite();
  await applyMigrations(client);
  await installTenantContextKey(client);
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
  const claim = await db
    .select({ id: initialAdminClaim.id })
    .from(initialAdminClaim)
    .limit(1);
  await db
    .insert(user)
    .values({
      id: userId,
      name: "Fictional Test User",
      email: `${userId}@example.test`,
      emailVerified: options.emailVerified ?? true,
      initialAdmin: claim.length === 0,
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
/** Token principals are rechecked against a real token row when their context is installed. */
export async function seedApiToken(
  db: AppDb,
  principal: Principal,
  scopes: Principal["scopes"] = principal.scopes,
  tokenId: string = randomUUID(),
): Promise<Principal> {
  await db.insert(apiTokens).values({
    id: tokenId,
    teamId: principal.teamId,
    userId: principal.userId,
    name: "Fictional test token",
    tokenHash: randomUUID().replaceAll("-", "").repeat(2),
    prefix: "ros_live_fiction",
    scopes,
    expiresAt: sql`current_timestamp + interval '1 day'`,
  });
  return { ...principal, scopes, authType: "token", tokenId };
}
/** Switch to a nonowner/non-BYPASSRLS role to exercise real PostgreSQL policies. */
export async function enforceTestRls(db: AppDb) {
  for (const statement of [
    "CREATE ROLE recruitment_test_runtime NOLOGIN",
    "GRANT USAGE ON SCHEMA app,auth,tenant_context,db_boundary TO recruitment_test_runtime",
    "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA app,auth TO recruitment_test_runtime",
    "REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON auth.initial_admin_claim FROM recruitment_test_runtime",
    "GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA app,auth TO recruitment_test_runtime",
    "GRANT SELECT ON db_boundary.connection_marker,db_boundary.storage_schema TO recruitment_test_runtime",
    `GRANT EXECUTE ON FUNCTION ${[...new Set([...dataRoleHelpers, ...identityRoleHelpers])].join(",")} TO recruitment_test_runtime`,
    "SET ROLE recruitment_test_runtime",
  ])
    await db.execute(sql.raw(statement));
}

export const splitRoles = {
  owner: "tenant_test_owner",
  data: "recruitmentos_data",
  identity: "recruitmentos_identity",
} as const;
/** infrastructure/postgres-split-runtime-roles.sql, read unmodified by the loader the evidence script uses. */
export { readRuntimeRoleTemplate };
/**
 * One PGlite with a nonsuperuser, non-BYPASSRLS migration owner and the data and identity
 * roles provisioned by the runtime role template. Route pools with dataDb/identityDb.
 */
export async function createSplitRoleDb() {
  const client = new PGlite();
  // Only what Neon's database owner has: CREATEROLE and the database itself.
  await client.exec(`
    CREATE ROLE ${splitRoles.owner} NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
    DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO ${splitRoles.owner}', current_database()); END $$;
    -- The runbook's operator step: no other database is open to PUBLIC.
    REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
    SET SESSION AUTHORIZATION ${splitRoles.owner};
  `);
  await applyMigrations(client);
  await installTenantContextKey(client);
  await client.exec(await readRuntimeRoleTemplate());
  const db = drizzle(client, { schema }) as unknown as AppDb;
  const as = async (role: keyof typeof splitRoles) => {
    await client.exec(`SET SESSION AUTHORIZATION ${splitRoles[role]}`);
    return db;
  };
  return {
    db,
    client,
    /** The owner is subject to FORCE RLS; seed recruitment data through the application. */
    asOwner: () => as("owner"),
    /** PGlite's bootstrap superuser bypasses RLS; use it only to inspect outcomes. */
    asSuperuser: async () => {
      await client.exec("SET SESSION AUTHORIZATION postgres");
      return db;
    },
    dataDb: () => as("data"),
    identityDb: () => as("identity"),
    close: () => client.close(),
  };
}
