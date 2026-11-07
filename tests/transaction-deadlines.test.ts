import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TeamTx } from "../src/db";
import {
  DEADLINES_SQL,
  STATEMENT_TIMEOUT_MS,
  TRANSACTION_TIMEOUT_MS,
} from "../src/db/deadlines";
import { authenticateApiToken, createToken } from "../src/lib/api-tokens";
import { resetAuthPurgeThrottle } from "../src/lib/auth-purge";
import { withTeam } from "../src/lib/db-team";
import type { Principal } from "../src/lib/principal";
import { createTestDb, seedIdentity } from "./helpers/db";
import { CLIENT_IP, stubLocalAuthReadiness } from "./helpers/readiness";

const APP_VALUES = { statement: "10s", transaction: "20s" };
const settingsSql = sql`select current_setting('statement_timeout') as statement, current_setting('transaction_timeout') as transaction`;
const read = async (tx: Pick<TeamTx, "execute">) =>
  (await tx.execute<{ statement: string; transaction: string }>(settingsSql))
    .rows[0];

const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}
const filesMatching = (pattern: RegExp) =>
  sourceFiles(srcRoot)
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => `src/${relative(srcRoot, file).split(sep).join("/")}`);

describe("per-transaction database deadlines", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  let owner: Principal;
  let before: { statement: string; transaction: string };
  /** Settings outside any transaction on the same database. */
  const outside = async () =>
    (
      await fixture.client.query<{ statement: string; transaction: string }>(
        "select current_setting('statement_timeout') as statement, current_setting('transaction_timeout') as transaction",
      )
    ).rows[0];

  beforeAll(async () => {
    fixture = await createTestDb();
    owner = await seedIdentity(fixture.db, {
      userId: "deadline-owner",
      teamId: "deadline-team",
    });
    before = await outside();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await fixture?.close();
  });

  it("builds one transaction-local statement from the constants", () => {
    expect(STATEMENT_TIMEOUT_MS).toBe(10000);
    expect(TRANSACTION_TIMEOUT_MS).toBe(20000);
    expect(DEADLINES_SQL).toBe(
      "select set_config('statement_timeout', '10000', true), set_config('transaction_timeout', '20000', true)",
    );
  });

  it("sets both deadlines inside withTeam and resets them after commit and after an error", async () => {
    // The pre-test values differ from the app values, so a leak would be seen.
    expect(before).not.toEqual(APP_VALUES);
    expect(await withTeam(owner, read)).toEqual(APP_VALUES);
    expect(await outside()).toEqual(before);
    let inside: unknown;
    await expect(
      withTeam(owner, async (tx) => {
        inside = await read(tx);
        throw new Error("Fictional failure inside the transaction.");
      }),
    ).rejects.toThrow("Fictional failure");
    expect(inside).toEqual(APP_VALUES);
    expect(await outside()).toEqual(before);
  });

  it("sets both deadlines inside identity-pool token and purge transactions", async () => {
    stubLocalAuthReadiness();
    resetAuthPurgeThrottle();
    // Observe each transaction's settings after its work, inside the same transaction.
    const original = fixture.db.transaction.bind(fixture.db);
    const observed: unknown[] = [];
    const spy = vi
      .spyOn(fixture.db, "transaction")
      .mockImplementation((work, config) =>
        original(async (tx) => {
          const result = await work(tx);
          observed.push(await read(tx));
          return result;
        }, config),
      );
    try {
      const created = await createToken(owner, {
        name: "Fictional deadline token",
        scopes: ["candidates:read"],
      });
      expect(
        (await authenticateApiToken(created.token, CLIENT_IP)).userId,
      ).toBe(owner.userId);
    } finally {
      spy.mockRestore();
    }
    // Token creation, authentication, then the purge's rate-limit and OAuth transactions.
    expect(observed).toEqual([APP_VALUES, APP_VALUES, APP_VALUES, APP_VALUES]);
    expect(await outside()).toEqual(before);
  });

  it("opens every application transaction through withDeadlines", () => {
    expect(filesMatching(/\.transaction\(/)).toEqual(["src/db/deadlines.ts"]);
    expect(filesMatching(/statement_timeout|transaction_timeout/)).toEqual([
      "src/db/deadlines.ts",
    ]);
  });
});
