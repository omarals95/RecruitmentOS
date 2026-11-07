import { afterEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({ Pool: vi.fn() }));
vi.mock("pg", () => ({ Pool: pg.Pool, default: { Pool: pg.Pool } }));

import { getAuthOptions } from "@/lib/auth";
import {
  HOSTED_ORIGIN,
  hostedReadyEnv,
  stubHostedReadiness,
  stubLocalAuthReadiness,
} from "./helpers/readiness";

const dataUrl = hostedReadyEnv.DATABASE_URL!;
const identityUrl = hostedReadyEnv.IDENTITY_DATABASE_URL!;

describe("hosted sign-in readiness", () => {
  const network = vi.fn(async () => {
    throw new Error("Readiness must not contact any service.");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is ready on the Vercel production runtime with every hosted setting", () => {
    vi.stubGlobal("fetch", network);
    stubHostedReadiness();
    const options = getAuthOptions();
    expect(options.configured).toBe(true);
    expect(pg.Pool).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    const shown = JSON.stringify(options);
    for (const name of [
      "BETTER_AUTH_SECRET",
      "DATABASE_URL",
      "IDENTITY_DATABASE_URL",
      "TENANT_CONTEXT_SIGNING_KEY",
      "RESEND_API_KEY",
    ])
      expect(shown).not.toContain(hostedReadyEnv[name]);
  });

  it.each<[string, Record<string, string | undefined>]>([
    ["NODE_ENV is not production", { NODE_ENV: "development" }],
    ["VERCEL is unset", { VERCEL: undefined }],
    ["VERCEL is not exactly 1", { VERCEL: "true" }],
    [
      "BETTER_AUTH_URL is plain http",
      { BETTER_AUTH_URL: "http://recruitment.example.test" },
    ],
    [
      "BETTER_AUTH_URL is http localhost",
      { BETTER_AUTH_URL: "http://localhost:3000" },
    ],
    ["BETTER_AUTH_URL has a path", { BETTER_AUTH_URL: `${HOSTED_ORIGIN}/app` }],
    [
      "BETTER_AUTH_URL has a query",
      { BETTER_AUTH_URL: `${HOSTED_ORIGIN}/?next=1` },
    ],
    [
      "BETTER_AUTH_URL has a fragment",
      { BETTER_AUTH_URL: `${HOSTED_ORIGIN}/#top` },
    ],
    [
      "BETTER_AUTH_URL has credentials",
      { BETTER_AUTH_URL: "https://user:pass@recruitment.example.test" },
    ],
    ["BETTER_AUTH_URL is missing", { BETTER_AUTH_URL: undefined }],
    [
      "BETTER_AUTH_SECRET is unusable",
      { BETTER_AUTH_SECRET: "replace-with-a-long-random-secret-value-0123" },
    ],
    ["BETTER_AUTH_SECRET is too short", { BETTER_AUTH_SECRET: "short" }],
    ["DATABASE_URL is missing", { DATABASE_URL: undefined }],
    ["IDENTITY_DATABASE_URL is missing", { IDENTITY_DATABASE_URL: undefined }],
    [
      "the database endpoints differ",
      {
        IDENTITY_DATABASE_URL: identityUrl.replace(
          "db.example.test",
          "other-db.example.test",
        ),
      },
    ],
    [
      "the databases differ",
      { IDENTITY_DATABASE_URL: identityUrl.replace("/recruitment", "/other") },
    ],
    [
      "a database URL has an unsupported parameter",
      { DATABASE_URL: `${dataUrl}&application_name=fictional` },
    ],
    [
      "a database URL repeats sslmode",
      { DATABASE_URL: `${dataUrl}&sslmode=require` },
    ],
    [
      "a database URL has no password",
      {
        IDENTITY_DATABASE_URL: identityUrl.replace(
          ":fictional-identity-password",
          "",
        ),
      },
    ],
    ["PGOPTIONS is set", { PGOPTIONS: "-c search_path=public" }],
    ["DATABASE_MODE is pglite", { DATABASE_MODE: "pglite" }],
    ["ALLOW_LOCAL_DB is true", { ALLOW_LOCAL_DB: "true" }],
    ["DEV_MAIL_MODE is console", { DEV_MAIL_MODE: "console" }],
    ["DEV_SEED_PASSWORD is set", { DEV_SEED_PASSWORD: "fictional-seed" }],
    [
      "TENANT_CONTEXT_SIGNING_KEY is missing",
      { TENANT_CONTEXT_SIGNING_KEY: undefined },
    ],
    [
      "TENANT_CONTEXT_SIGNING_KEY is malformed",
      { TENANT_CONTEXT_SIGNING_KEY: "too-short" },
    ],
    [
      "TENANT_CONTEXT_SIGNING_KEY is not canonical base64url",
      {
        TENANT_CONTEXT_SIGNING_KEY:
          "FictionalTenantContextTestKeyOnly012345678B",
      },
    ],
    ["RESEND_API_KEY is missing", { RESEND_API_KEY: undefined }],
    ["EMAIL_FROM is missing", { EMAIL_FROM: undefined }],
  ])("is unavailable when %s", (_, overrides) => {
    vi.stubGlobal("fetch", network);
    stubHostedReadiness(overrides);
    expect(getAuthOptions().configured).toBe(false);
    expect(pg.Pool).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it("ignores ALLOW_UNSAFE_TENANT_ISOLATION", () => {
    stubHostedReadiness({ ALLOW_UNSAFE_TENANT_ISOLATION: "true" });
    expect(getAuthOptions().configured).toBe(true);
    stubHostedReadiness({
      ALLOW_UNSAFE_TENANT_ISOLATION: "true",
      IDENTITY_DATABASE_URL: undefined,
    });
    expect(getAuthOptions().configured).toBe(false);
  });
});

describe("local sign-in readiness is unchanged", () => {
  afterEach(() => vi.unstubAllEnvs());
  const local = () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("IDENTITY_DATABASE_URL", undefined);
    vi.stubEnv("RESEND_API_KEY", undefined);
    vi.stubEnv("EMAIL_FROM", undefined);
    stubLocalAuthReadiness();
  };

  it("accepts http localhost, PGlite and console mail", () => {
    local();
    expect(getAuthOptions().configured).toBe(true);
    vi.stubEnv("BETTER_AUTH_URL", "http://127.0.0.1:3000");
    expect(getAuthOptions().configured).toBe(true);
  });

  it("accepts a single DATABASE_URL without an identity URL", () => {
    local();
    vi.stubEnv("DATABASE_MODE", undefined);
    vi.stubEnv("ALLOW_LOCAL_DB", undefined);
    vi.stubEnv("DATABASE_URL", "postgres://fictional@localhost/recruitment");
    expect(getAuthOptions().configured).toBe(true);
  });

  it("still needs a usable secret, a database and mail", () => {
    local();
    vi.stubEnv("BETTER_AUTH_SECRET", undefined);
    expect(getAuthOptions().configured).toBe(false);
    local();
    vi.stubEnv("ALLOW_LOCAL_DB", undefined);
    expect(getAuthOptions().configured).toBe(false);
    local();
    vi.stubEnv("DEV_MAIL_MODE", undefined);
    expect(getAuthOptions().configured).toBe(false);
    local();
    vi.stubEnv("BETTER_AUTH_URL", "http://recruitment.example.test");
    expect(getAuthOptions().configured).toBe(false);
  });
});
