import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The real scripts run as one Node process each against a fresh fictional PGlite directory, so a
// database left open shows up as a child that never exits. Stdout carries the fictional password
// and is never printed.
const root = fileURLToPath(new URL("..", import.meta.url));
const LIMIT_MS = 60_000;
let dataDir: string;

async function run(script: string, args: string[] = []) {
  const env: Record<string, string> = {
    DATABASE_MODE: "pglite",
    ALLOW_LOCAL_DB: "true",
    PGLITE_DATA_DIR: dataDir,
    TENANT_CONTEXT_SIGNING_KEY: process.env.TENANT_CONTEXT_SIGNING_KEY!,
    DEV_SEED_PASSWORD: "FictionalSeedPassword-0001",
    // The seed encrypts the fictional owner's authenticator key with it.
    BETTER_AUTH_SECRET: "fictional-scripts-exit-secret-0123456789",
    IDENTITY_DATABASE_URL: "",
    DATABASE_URL: "",
  };
  // Only what Node needs from the OS; nothing else from the developer environment.
  for (const name of ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", script, ...args],
      {
        cwd: root,
        // NODE_ENV stays unset, as with npm run db:migrate and db:seed.
        env: env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      timedOut = false;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, LIMIT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function expectExit(
  script: string,
  line: string,
  args: string[] = [],
  code = 0,
) {
  const result = await run(script, args);
  expect(result.timedOut, `${script} still running after ${LIMIT_MS} ms`).toBe(
    false,
  );
  expect(result.code, result.stderr).toBe(code);
  // A boolean, so a failure never prints stdout.
  expect(result.stdout.includes(line), `${script} printed ${line}`).toBe(true);
}

describe("db:migrate, db:seed, erase:candidate and two-step:reset exit on their own", () => {
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "recruitmentos-scripts-exit-"));
  });

  afterAll(async () => {
    await rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500,
    });
  });

  it(
    "migrates a fresh database and exits",
    () =>
      expectExit("scripts/migrate.ts", "Local PostgreSQL migrations applied."),
    LIMIT_MS + 30_000,
  );

  it(
    "migrates an existing database and exits",
    () =>
      expectExit("scripts/migrate.ts", "Local PostgreSQL migrations applied."),
    LIMIT_MS + 30_000,
  );

  it(
    "seeds the fictional account and exits",
    () =>
      expectExit("scripts/seed-local.ts", "Fictional local workspace ready."),
    LIMIT_MS + 30_000,
  );

  it(
    "finds the existing fictional account and exits",
    () =>
      expectExit(
        "scripts/seed-local.ts",
        "Fictional seed account already exists. No records changed.",
      ),
    LIMIT_MS + 30_000,
  );

  it(
    "refuses to erase an unknown candidate for the seed owner and exits 1",
    async () => {
      const result = await run("scripts/erase-candidate.ts", [
        "--team",
        "fictional-studio",
        "--candidate",
        randomUUID(),
        "--owner",
        "recruiter@example.test",
        "--confirm-name",
        "Fictional Nobody",
      ]);
      expect(result.timedOut, "erase-candidate still running").toBe(false);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(
        "Candidate not found in this team. Nothing was changed.",
      );
    },
    LIMIT_MS + 30_000,
  );

  it(
    "resets the fictional owner's two-step sign-in and exits",
    () =>
      expectExit(
        "scripts/reset-two-step.ts",
        "Two-step sign-in was reset for 1 account.",
        ["--email", "recruiter@example.test", "--confirm"],
      ),
    LIMIT_MS + 30_000,
  );

  it(
    "reports an unknown address and exits with 1",
    () =>
      expectExit(
        "scripts/reset-two-step.ts",
        "No account matched.",
        ["--email", "nobody@example.test", "--confirm"],
        1,
      ),
    LIMIT_MS + 30_000,
  );
});
