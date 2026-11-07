import "./load-env";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { closeDb, getDb, type AppDb } from "../src/db";
import { isLoopbackHost } from "../src/db/connection-boundary";

/**
 * Owner-run recovery for an account that lost its authenticator and backup codes, typically the
 * last owner. In one owner transaction: the same deletions and update as tenant_context.reset_two_step,
 * plus one audit row per team the user belongs to. Returns whether an account matched.
 */
export async function resetTwoStepByEmail(
  db: AppDb,
  email: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [target] = (
      await tx.execute<{ id: string }>(
        sql`SELECT id FROM auth."user" WHERE email = ${email.trim().toLowerCase()} FOR UPDATE`,
      )
    ).rows;
    if (!target) return false;
    await tx.execute(
      sql`DELETE FROM auth.two_factor WHERE user_id = ${target.id}`,
    );
    await tx.execute(
      sql`UPDATE auth."user" SET two_factor_enabled = false, updated_at = now() WHERE id = ${target.id}`,
    );
    await tx.execute(
      sql`DELETE FROM auth.session WHERE user_id = ${target.id}`,
    );
    await tx.execute(
      sql`DELETE FROM auth.verification WHERE (identifier LIKE 'trust-device-%' OR identifier LIKE '2fa-%') AND value = ${target.id}`,
    );
    await tx.execute(
      sql`INSERT INTO app.activity(team_id, actor_id, actor_type, action, kind, summary, metadata)
        SELECT m.organization_id, m.user_id, 'session', 'two_step.reset', 'account-security',
          'Two-step sign-in reset by the database owner',
          jsonb_build_object('targetUserId', m.user_id, 'method', 'owner-script')
        FROM auth.member m WHERE m.user_id = ${target.id}`,
    );
    return true;
  });
}

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<number> {
  const email = argument("--email");
  if (!email || email.startsWith("--") || !process.argv.includes("--confirm")) {
    console.error(
      "Usage: npm run two-step:reset -- --email <address> --confirm. This removes the account's authenticator, backup codes, sessions and trusted devices.",
    );
    return 1;
  }
  let matched: boolean;
  if (
    process.env.DATABASE_MODE === "pglite" &&
    process.env.ALLOW_LOCAL_DB === "true"
  ) {
    try {
      matched = await resetTwoStepByEmail(await getDb(), email);
    } finally {
      // An open PGlite client keeps the process alive after the work is done.
      await closeDb();
    }
  } else {
    if (!process.env.MIGRATION_DATABASE_URL)
      throw new Error(
        "Set MIGRATION_DATABASE_URL to the owner connection. The application runtime uses a separate DATABASE_URL.",
      );
    const url = new URL(process.env.MIGRATION_DATABASE_URL);
    if (!isLoopbackHost(url.hostname))
      url.searchParams.set("sslmode", "verify-full");
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      matched = await resetTwoStepByEmail(
        drizzle(client) as unknown as AppDb,
        email,
      );
    } finally {
      await client.end();
    }
  }
  console.log(
    matched
      ? "Two-step sign-in was reset for 1 account."
      : "No account matched.",
  );
  return matched ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error(
        "Two-step reset failed. Check the owner connection and database setup; credentials are never printed.",
      );
      process.exitCode = 1;
    });
