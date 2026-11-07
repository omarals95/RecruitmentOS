import { spawn } from "node:child_process";
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

async function run(script: string) {
  const env: Record<string, string> = {
    DATABASE_MODE: "pglite",
    ALLOW_LOCAL_DB: "true",
    PGLITE_DATA_DIR: dataDir,
    TENANT_CONTEXT_SIGNING_KEY: process.env.TENANT_CONTEXT_SIGNING_KEY!,
    DEV_SEED_PASSWORD: "FictionalSeedPassword-0001",
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
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: root,
      // NODE_ENV stays unset, as with npm run db:migrate and db:seed.
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

async function expectExit(script: string, line: string) {
  const result = await run(script);
  expect(result.timedOut, `${script} still running after ${LIMIT_MS} ms`).toBe(
    false,
  );
  expect(result.code, result.stderr).toBe(0);
  // A boolean, so a failure never prints stdout.
  expect(result.stdout.includes(line), `${script} printed ${line}`).toBe(true);
}

describe("db:migrate and db:seed exit on their own", () => {
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
});
