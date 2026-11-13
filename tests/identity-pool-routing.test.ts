import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({
  identity: vi.fn(),
  data: vi.fn(),
}));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getIdentityDb: route.identity,
  getDb: route.data,
}));
vi.mock("@/lib/auth-session", () => ({
  getVerifiedSession: vi.fn(async () => ({
    user: { id: "fictional-user", emailVerified: true, twoFactorEnabled: true },
    session: { activeOrganizationId: "fictional-team" },
  })),
  getSession: vi.fn(async () => ({
    user: {
      id: "fictional-user",
      name: "Fictional User",
      email: "fictional@example.test",
      emailVerified: true,
    },
    session: { activeOrganizationId: "fictional-team" },
  })),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("Unexpected redirect");
  },
}));

import { applyMigrations, schema, type AppDb } from "@/db";
import { getAuth, getAuthOptions } from "@/lib/auth";
import { requirePrincipal } from "@/lib/principal";
import { installTenantContextKey } from "@/lib/tenant-context";
import { getWorkspaceContext } from "@/lib/workspace";
import CreateAdmin from "../src/app/(auth)/create-admin/page";
import { stubHostedReadiness } from "./helpers/readiness";

describe("identity-only operations use the identity pool", () => {
  const pg = new PGlite();
  let db: AppDb;
  beforeAll(async () => {
    await applyMigrations(pg);
    await installTenantContextKey(pg);
    // A recruiter without two-step or company authority: the two-step gate's company authority
    // lookup runs, and must use the identity pool too.
    await pg.exec(`
      INSERT INTO auth."user"(id,name,email,email_verified,initial_admin)
        VALUES('fictional-user','Fictional User','fictional@example.test',true,true);
      INSERT INTO auth.organization(id,name,slug,created_by)
        VALUES('fictional-team','Fictional Team','fictional-team','fictional-user');
      INSERT INTO auth.member(id,organization_id,user_id,role)
        VALUES('fictional-member','fictional-team','fictional-user','recruiter');
      DELETE FROM app.workspace_admins WHERE user_id='fictional-user';
    `);
    db = drizzle(pg, { schema }) as unknown as AppDb;
    route.identity.mockImplementation(async () => db);
    route.data.mockImplementation(async () => {
      throw new Error("Data pool must not be used for identity operations");
    });
    vi.stubEnv("DATABASE_MODE", "pglite");
    vi.stubEnv("ALLOW_LOCAL_DB", "true");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("BETTER_AUTH_SECRET", "fictional-valid-test-secret-0123456789");
    vi.stubEnv("BOOTSTRAP_OWNER_EMAIL", "owner@example.test");
    vi.stubEnv(
      "BOOTSTRAP_SETUP_TOKEN",
      "fictional-bootstrap-secret-0123456789abcdefghi",
    );
    vi.stubEnv("DEV_MAIL_MODE", "console");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await pg.close();
  });

  it("constructs Better Auth using the identity connection", async () => {
    expect(await getAuth()).toBeTruthy();
    expect(route.identity).toHaveBeenCalled();
    expect(route.data).not.toHaveBeenCalled();
  });

  it("resolves the selected team membership with the identity connection", async () => {
    const principal = await requirePrincipal(
      new Request("http://localhost:3000", {
        headers: { "x-team-id": "fictional-team" },
      }),
      "cvs:read",
    );
    expect(principal).toMatchObject({
      userId: "fictional-user",
      teamId: "fictional-team",
      role: "recruiter",
    });
    expect(route.data).not.toHaveBeenCalled();
  });

  it("loads the workspace without opening the data pool", async () => {
    expect((await getWorkspaceContext()).team?.id).toBe("fictional-team");
    expect(route.data).not.toHaveBeenCalled();
  });

  it("loads bootstrap status without opening the data pool", async () => {
    expect(await CreateAdmin()).toBeTruthy();
    expect(route.data).not.toHaveBeenCalled();
  });

  it("reports hosted sign-in ready on the Vercel production runtime", () => {
    stubHostedReadiness();
    expect(getAuthOptions().configured).toBe(true);
    stubHostedReadiness({ IDENTITY_DATABASE_URL: undefined });
    expect(getAuthOptions().configured).toBe(false);
    stubHostedReadiness({ BETTER_AUTH_URL: "http://localhost:3000" });
    expect(getAuthOptions().configured).toBe(false);
    stubHostedReadiness({ DATABASE_MODE: "pglite", ALLOW_LOCAL_DB: "true" });
    expect(getAuthOptions().configured).toBe(false);
  });

  it("reports hosted sign-in unavailable outside the Vercel production runtime", () => {
    stubHostedReadiness({ NODE_ENV: "development" });
    expect(getAuthOptions().configured).toBe(false);
    stubHostedReadiness({ VERCEL: undefined });
    expect(getAuthOptions().configured).toBe(false);
  });
});
