import { vi } from "vitest";

/** A fictional documentation-range client address for direct token calls. */
export const CLIENT_IP = "192.0.2.10";
export const HOSTED_ORIGIN = "https://recruitment.example.test";

// Real local readiness settings; production code has no test-only bypass of the token gate.
export function stubLocalAuthReadiness() {
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
  vi.stubEnv("BETTER_AUTH_SECRET", "fictional-valid-test-secret-0123456789");
  vi.stubEnv("DATABASE_MODE", "pglite");
  vi.stubEnv("ALLOW_LOCAL_DB", "true");
  vi.stubEnv("DEV_MAIL_MODE", "console");
}

/** Every hosted readiness setting, fictional and pointing at no reachable service. */
export const hostedReadyEnv: Record<string, string | undefined> = {
  NODE_ENV: "production",
  VERCEL: "1",
  BETTER_AUTH_URL: HOSTED_ORIGIN,
  BETTER_AUTH_SECRET: "fictional-hosted-auth-secret-0123456789abcdef",
  DATABASE_URL:
    "postgres://fictional_data:fictional-data-password@db.example.test:5432/recruitment?sslmode=require",
  IDENTITY_DATABASE_URL:
    "postgres://fictional_identity:fictional-identity-password@db.example.test:5432/recruitment?sslmode=require",
  TENANT_CONTEXT_SIGNING_KEY: "FictionalTenantContextTestKeyOnly0123456789A",
  RESEND_API_KEY: "re_fictional_test_key_only",
  EMAIL_FROM: "RecruitmentOS <no-reply@example.test>",
  DATABASE_MODE: undefined,
  ALLOW_LOCAL_DB: undefined,
  DEV_MAIL_MODE: undefined,
  DEV_SEED_PASSWORD: undefined,
  PGOPTIONS: undefined,
};

export function stubHostedReadiness(
  overrides: Record<string, string | undefined> = {},
) {
  for (const [name, value] of Object.entries({
    ...hostedReadyEnv,
    ...overrides,
  }))
    vi.stubEnv(name, value);
}
