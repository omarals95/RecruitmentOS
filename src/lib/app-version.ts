import type { BuildInfo } from "./build-info";

/**
 * The build facts next.config.ts inlines into server and client bundles. The references stay
 * literal so Next can replace them; an unset value ("unknown") happens only outside a Next build.
 */
export function appVersion(): BuildInfo {
  return {
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown",
    build: process.env.NEXT_PUBLIC_APP_BUILD ?? "unknown",
    commit: process.env.NEXT_PUBLIC_APP_COMMIT ?? "unknown",
    environment: process.env.NEXT_PUBLIC_APP_ENVIRONMENT ?? "unknown",
    builtAt: process.env.NEXT_PUBLIC_APP_BUILT_AT ?? "unknown",
  };
}

/** Version 1.0.0 (build 20261108.1430) */
export function versionLabel(): string {
  const { version, build } = appVersion();
  return `Version ${version} (build ${build})`;
}

/** An ISO build time as YYYY-MM-DD HH:MM UTC. */
export function formatBuildTime(builtAt: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(builtAt)
    ? `${builtAt.slice(0, 10)} ${builtAt.slice(11, 16)} UTC`
    : builtAt;
}

/** The three lines Copy details puts on the clipboard for a bug report; nothing about the user. */
export function versionDetails(): string {
  const { version, build, commit, environment, builtAt } = appVersion();
  return [
    `RecruitmentOS ${version} (build ${build}, ${commit})`,
    `Environment: ${environment}`,
    `Build time: ${formatBuildTime(builtAt)}`,
  ].join("\n");
}
