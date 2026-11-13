// Read by next.config.ts at build time through a relative import, so this file imports only Node
// built-ins: no Next, React, database or @/ aliases.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildInfo {
  version: string;
  build: string;
  commit: string;
  environment: string;
  builtAt: string;
}

const COMMIT = /^[0-9a-f]{7,40}$/i;

/** The UTC build number, YYYYMMDD.HHMM. */
export function formatBuildNumber(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}.${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
}

/** Export label from the same signals resolveStorageBinding trusts; off Vercel is local. */
export function workspaceEnvironment(
  env: Record<string, string | undefined>,
): string {
  if (env.VERCEL === "1" && env.VERCEL_ENV === "production")
    return "Production";
  if (env.VERCEL === "1" && env.VERCEL_ENV === "preview") return "Preview";
  return "Local development";
}

/**
 * The short commit: VERCEL_GIT_COMMIT_SHA, then the commit in build-info.json (written by the
 * owner's CLI deploy script), then "dev". A bad file is ignored with a warning that never echoes it.
 */
export function resolveCommit(
  env: Record<string, string | undefined>,
  root: string,
): string {
  const fromEnv = env.VERCEL_GIT_COMMIT_SHA?.trim() ?? "";
  if (COMMIT.test(fromEnv)) return fromEnv.slice(0, 7).toLowerCase();
  const file = join(root, "build-info.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn(`Ignoring ${file}: it could not be read.`);
    return "dev";
  }
  let commit: unknown;
  try {
    commit = (JSON.parse(text) as { commit?: unknown } | null)?.commit;
  } catch {
    console.warn(`Ignoring ${file}: it is not valid JSON.`);
    return "dev";
  }
  if (typeof commit === "string" && COMMIT.test(commit))
    return commit.slice(0, 7).toLowerCase();
  console.warn(
    `Ignoring ${file}: its commit is not 7 to 40 hexadecimal characters.`,
  );
  return "dev";
}

/** Version, build number, commit, environment and build time for one build. */
export function resolveBuildInfo(
  env: Record<string, string | undefined>,
  root: string,
  now: Date,
): BuildInfo {
  const { version } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as { version: string };
  return {
    version,
    build: formatBuildNumber(now),
    commit: resolveCommit(env, root),
    environment: workspaceEnvironment(env),
    builtAt: now.toISOString(),
  };
}
