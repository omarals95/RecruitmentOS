import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-session", () => ({
  getSession: vi.fn(),
  getVerifiedSession: vi.fn(),
}));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: vi.fn(),
  getIdentityDb: vi.fn(),
}));
import { getDb, getIdentityDb } from "@/db";
import { getSession, getVerifiedSession } from "@/lib/auth-session";
import {
  formatBuildNumber,
  resolveBuildInfo,
  resolveCommit,
} from "@/lib/build-info";
import { versionDetails, versionLabel } from "@/lib/app-version";
import { GET } from "@/app/api/version/route";

const packageVersion = (
  JSON.parse(readFileSync("package.json", "utf8")) as { version: string }
).version;
const FULL_SHA = "f09caa4e0d1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a";
const FILE_SHA = "0123456789abcdef0123456789abcdef01234567";
const now = new Date("2026-11-08T14:30:59Z");

describe("build number", () => {
  it("formats the UTC time as YYYYMMDD.HHMM", () => {
    expect(formatBuildNumber(now)).toBe("20261108.1430");
    expect(formatBuildNumber(new Date("2026-11-08T18:30:00+04:00"))).toBe(
      "20261108.1430",
    );
  });
  it("zero-pads midnight and single-digit months and days", () => {
    expect(formatBuildNumber(new Date("2027-01-01T00:00:00Z"))).toBe(
      "20270101.0000",
    );
    expect(formatBuildNumber(new Date("2026-03-04T05:06:07Z"))).toBe(
      "20260304.0506",
    );
  });
});

describe("commit and build info resolution", () => {
  let root: string;
  let warn: ReturnType<typeof vi.spyOn>;
  const buildInfoFile = (contents: string) =>
    writeFileSync(join(root, "build-info.json"), contents);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "recruitmentos-build-info-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ version: "9.8.7" }),
    );
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it("prefers VERCEL_GIT_COMMIT_SHA, then build-info.json, then dev", () => {
    buildInfoFile(JSON.stringify({ commit: FILE_SHA }));
    expect(resolveCommit({ VERCEL_GIT_COMMIT_SHA: FULL_SHA }, root)).toBe(
      "f09caa4",
    );
    expect(resolveCommit({}, root)).toBe("0123456");
    rmSync(join(root, "build-info.json"));
    expect(resolveCommit({}, root)).toBe("dev");
    expect(warn).not.toHaveBeenCalled();
  });
  it("trims the env SHA and truncates to 7 lower-case characters", () => {
    expect(
      resolveCommit(
        { VERCEL_GIT_COMMIT_SHA: ` ${FULL_SHA.toUpperCase()}\n` },
        root,
      ),
    ).toBe("f09caa4");
    expect(resolveCommit({ VERCEL_GIT_COMMIT_SHA: "ABCDEF1" }, root)).toBe(
      "abcdef1",
    );
    buildInfoFile(JSON.stringify({ commit: FILE_SHA.toUpperCase() }));
    expect(resolveCommit({}, root)).toBe("0123456");
  });
  it("falls through an invalid env SHA to build-info.json and then to dev", () => {
    buildInfoFile(JSON.stringify({ commit: FILE_SHA }));
    for (const sha of [
      "",
      "abc123",
      "not-a-sha-value",
      "g09caa4",
      "a".repeat(41),
    ])
      expect(resolveCommit({ VERCEL_GIT_COMMIT_SHA: sha }, root)).toBe(
        "0123456",
      );
    rmSync(join(root, "build-info.json"));
    expect(resolveCommit({ VERCEL_GIT_COMMIT_SHA: "abc123" }, root)).toBe(
      "dev",
    );
  });
  it("ignores a malformed file or a non-string or non-hex commit with one warning that does not echo the file", () => {
    const canary = "fictional-canary-contents";
    for (const contents of [
      `{"commit": "${canary}"`,
      JSON.stringify({ commit: 1234567 }),
      JSON.stringify({ commit: canary }),
      JSON.stringify({ commit: "0123456789xyz" }),
      JSON.stringify({ commit: "012345" }),
      JSON.stringify({ sha: FILE_SHA }),
      "null",
    ]) {
      warn.mockClear();
      buildInfoFile(contents);
      expect(resolveCommit({}, root), contents).toBe("dev");
      expect(warn, contents).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain(join(root, "build-info.json"));
      expect(message).not.toContain(canary);
    }
  });
  it("is silent when build-info.json is missing", () => {
    expect(resolveCommit({}, root)).toBe("dev");
    expect(warn).not.toHaveBeenCalled();
  });
  it("returns the package version, build number, commit, environment and ISO build time", () => {
    expect(
      resolveBuildInfo({ VERCEL_GIT_COMMIT_SHA: FULL_SHA }, root, now),
    ).toEqual({
      version: "9.8.7",
      build: "20261108.1430",
      commit: "f09caa4",
      environment: "Local development",
      builtAt: "2026-11-08T14:30:59.000Z",
    });
  });
  it("labels Preview and Production only for VERCEL=1 with a known VERCEL_ENV", () => {
    const environment = (env: Record<string, string>) =>
      resolveBuildInfo(env, root, now).environment;
    expect(environment({ VERCEL: "1", VERCEL_ENV: "preview" })).toBe("Preview");
    expect(environment({ VERCEL: "1", VERCEL_ENV: "production" })).toBe(
      "Production",
    );
    expect(environment({ VERCEL: "1", VERCEL_ENV: "development" })).toBe(
      "Local development",
    );
    expect(environment({ VERCEL_ENV: "production" })).toBe("Local development");
    expect(environment({})).toBe("Local development");
  });
});

describe("version label and details text", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("reads the inlined values, and unknown outside a Next build", () => {
    expect(versionLabel()).toBe("Version unknown (build unknown)");
    vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "1.0.0");
    vi.stubEnv("NEXT_PUBLIC_APP_BUILD", "20261108.1430");
    vi.stubEnv("NEXT_PUBLIC_APP_COMMIT", "f09caa4");
    vi.stubEnv("NEXT_PUBLIC_APP_ENVIRONMENT", "Preview");
    vi.stubEnv("NEXT_PUBLIC_APP_BUILT_AT", "2026-11-08T14:30:59.000Z");
    expect(versionLabel()).toBe("Version 1.0.0 (build 20261108.1430)");
    expect(versionDetails()).toBe(
      [
        "RecruitmentOS 1.0.0 (build 20261108.1430, f09caa4)",
        "Environment: Preview",
        "Build time: 2026-11-08 14:30 UTC",
      ].join("\n"),
    );
  });
});

describe("next.config build values", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("exposes exactly the five NEXT_PUBLIC_APP_* values with the package version", async () => {
    const { default: config } = await import("../next.config");
    expect(Object.keys(config.env!).sort()).toEqual([
      "NEXT_PUBLIC_APP_BUILD",
      "NEXT_PUBLIC_APP_BUILT_AT",
      "NEXT_PUBLIC_APP_COMMIT",
      "NEXT_PUBLIC_APP_ENVIRONMENT",
      "NEXT_PUBLIC_APP_VERSION",
    ]);
    expect(config.env!.NEXT_PUBLIC_APP_VERSION).toBe(packageVersion);
    expect(config.env!.NEXT_PUBLIC_APP_BUILD).toMatch(/^\d{8}\.\d{4}$/);
    expect(config.env!.NEXT_PUBLIC_APP_BUILD).toBe(
      formatBuildNumber(new Date(config.env!.NEXT_PUBLIC_APP_BUILT_AT!)),
    );
  });
  it("adds X-App-Version to API responses after the unchanged first rule", async () => {
    const { default: config } = await import("../next.config");
    const rules = await config.headers!();
    expect(rules).toHaveLength(2);
    expect(rules[0].source).toBe("/(.*)");
    expect(rules[0].headers.map((header) => header.key)).not.toContain(
      "X-App-Version",
    );
    expect(rules[1]).toEqual({
      source: "/api/:path*",
      headers: [{ key: "X-App-Version", value: packageVersion }],
    });
  });
  it("reuses the first evaluation's build time in later evaluations", async () => {
    const { default: first } = await import("../next.config");
    vi.resetModules();
    const { default: second } = await import("../next.config");
    expect(second).not.toBe(first);
    expect(second.env).toEqual(first.env);
  });
});

describe("GET /api/version", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("returns exactly four strings with no-store, without a cookie, session, token or database", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "build",
      "commit",
      "environment",
      "version",
    ]);
    for (const value of Object.values(body))
      expect(typeof value).toBe("string");
    expect(getSession).not.toHaveBeenCalled();
    expect(getVerifiedSession).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
    expect(getIdentityDb).not.toHaveBeenCalled();
  });
  it("exposes no secret in the body, the build values or the details text", async () => {
    const canaries = {
      BETTER_AUTH_SECRET: "fictional-canary-auth-secret",
      DATABASE_URL: "postgres://fictional-canary-user@example.test/canary",
      TENANT_CONTEXT_SIGNING_KEY: "fictional-canary-signing-key",
      RESEND_API_KEY: "re_fictional_canary_key",
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_fictional_canary",
      OPENAI_API_KEY: "sk-fictional-canary",
    };
    for (const [name, value] of Object.entries(canaries))
      vi.stubEnv(name, value);
    vi.resetModules();
    const { default: config } = await import("../next.config");
    // Simulate the build inlining the values the config produced.
    for (const [name, value] of Object.entries(config.env!))
      vi.stubEnv(name, value);
    const body = await GET().text();
    const values = JSON.stringify([config.env, await config.headers!()]);
    for (const value of Object.values(canaries)) {
      expect(body).not.toContain(value);
      expect(values).not.toContain(value);
      expect(versionDetails()).not.toContain(value);
    }
    expect(JSON.parse(body)).toEqual({
      version: packageVersion,
      build: config.env!.NEXT_PUBLIC_APP_BUILD,
      commit: config.env!.NEXT_PUBLIC_APP_COMMIT,
      environment: config.env!.NEXT_PUBLIC_APP_ENVIRONMENT,
    });
  });
});
