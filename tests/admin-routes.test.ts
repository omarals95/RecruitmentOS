import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requests pick the pool by role, as on a split-role deployment: the identity role reads the
// membership, the data role runs withTeam. Only one PGlite role is active at a time.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
// The request a page sees: next/headers returns its headers, and the session lookup reads only the
// fictional session cookie, as Better Auth's cookie session does.
const request = vi.hoisted(() => ({
  headers: new Headers(),
  sessions: new Map<string, { userId: string; teamId: string | null }>(),
}));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));
vi.mock("@/lib/auth-session", () => ({
  getVerifiedSession: vi.fn(),
  getSession: vi.fn(async (headers: Headers) => {
    const cookie = /fictional-session=([^;]+)/.exec(
      headers.get("cookie") ?? "",
    )?.[1];
    const session = cookie ? request.sessions.get(cookie) : undefined;
    if (!session) return null;
    return {
      user: {
        id: session.userId,
        name: "Fictional Test User",
        email: `${session.userId}@example.test`,
        emailVerified: true,
        twoFactorEnabled: true,
      },
      session: { activeOrganizationId: session.teamId },
    };
  }),
}));
vi.mock("@/lib/api-tokens", async (original) => ({
  ...(await original<typeof import("@/lib/api-tokens")>()),
  authenticateApiToken: vi.fn(),
  authenticateOAuthAccessToken: vi.fn(),
}));
vi.mock("@/lib/db-team", async (original) => {
  const actual = await original<typeof import("@/lib/db-team")>();
  return { ...actual, withTeam: vi.fn(actual.withTeam) };
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
}));

import type { AppDb } from "@/db";
import { user } from "@/db/auth-schema";
import {
  AdminPortal,
  AdminPortalView,
} from "@/components/settings/admin-portal";
import {
  ADMIN_TABS,
  NO_ACCESS,
  isAdminTab,
  type AdminTabKey,
} from "@/components/settings/admin-tabs";
import { WorkspaceProvider } from "@/components/workspace/client";
import {
  authenticateApiToken,
  authenticateOAuthAccessToken,
} from "@/lib/api-tokens";
import { withTeam } from "@/lib/db-team";
import type { Principal } from "@/lib/principal";
import { createSplitRoleDb, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace with two fictional teams.
const COMPANY = "00000000-0000-4000-a000-000000000001";
const ADMIN_DIR = join(process.cwd(), "src/app/app/admin");
const KEYS = ADMIN_TABS.map((tab) => tab.key);
const TEAM_PAGES: AdminTabKey[] = [
  "members",
  "cv-storage",
  "speed",
  "task-boards",
  "tokens",
];
const workspace = {
  user: {
    id: "fictional-route-user",
    name: "Fictional Route User",
    email: "route-user@example.test",
    twoStepEnabled: true,
  },
  team: { id: "fictional-team", name: "Fictional Team", slug: "fictional" },
  role: "owner",
  environment: "Local development",
  canCreateTeam: true,
};

/** Every page.tsx under src/app/app/admin, relative to it, with forward slashes. */
function adminPages(dir = ADMIN_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? adminPages(join(dir, entry.name))
      : entry.name === "page.tsx"
        ? [relative(ADMIN_DIR, join(dir, entry.name)).replaceAll("\\", "/")]
        : [],
  );
}
/** The page key a page file serves: null for the home, every key for [tab]. */
function keysOf(page: string): (AdminTabKey | null)[] {
  if (page === "page.tsx") return [null];
  if (page === "[tab]/page.tsx") return KEYS;
  const first = page.split("/")[0];
  return isAdminTab(first) ? [first] : [];
}

type Caller =
  | { kind: "anonymous" }
  | { kind: "bearer" }
  | { kind: "session"; cookie: string };
type Outcome = "allowed" | "refused" | "sign-in" | "not-found";

type Page = (props: {
  params: Promise<Record<string, string>>;
}) => Promise<unknown>;

/** Calls the page file's default export as Next would, for one caller and one key. */
async function open(
  caller: Caller,
  page: string,
  key: AdminTabKey | "fictional" | null,
): Promise<Outcome> {
  request.headers = new Headers(
    caller.kind === "bearer"
      ? { authorization: "Bearer fictional-admin-page-token" }
      : caller.kind === "session"
        ? { cookie: `fictional-session=${caller.cookie}` }
        : {},
  );
  const render = (
    (await import(/* @vite-ignore */ `@/app/app/admin/${page}`)) as {
      default: Page;
    }
  ).default;
  let element: unknown;
  try {
    const params: Record<string, string> =
      page.startsWith("[tab]/") && key !== null ? { tab: key } : {};
    element = await render({ params: Promise.resolve(params) });
  } catch (error) {
    const message = (error as Error).message;
    if (message === "redirect:/sign-in") return "sign-in";
    if (message === "notFound") return "not-found";
    throw error;
  }
  expect(isValidElement(element)).toBe(true);
  const result = element as ReactElement<Record<string, unknown>>;
  const markup = renderToStaticMarkup(
    createElement(WorkspaceProvider, { value: workspace, children: result }),
  );
  if (result.type === AdminPortal) {
    expect(result.props).toEqual({ tab: key });
    expect(markup).not.toContain(NO_ACCESS);
    return "allowed";
  }
  // Refused: the plain no-access state, with no sidebar and no tab content mounted.
  expect(result.type).toBe(AdminPortalView);
  expect(result.props).toMatchObject({ access: null, denied: true });
  expect(markup).toContain("<h1>Admin portal</h1>");
  expect(markup).toContain(`<p>${NO_ACCESS}</p>`);
  expect(markup).not.toContain("Admin portal sections");
  expect(markup).not.toMatch(/<nav|<h2|role="status"/);
  return "refused";
}

describe("admin page files", () => {
  it("serves every page under src/app/app/admin from the page table", () => {
    const pages = adminPages();
    expect(pages).toContain("page.tsx");
    expect(pages).toContain("[tab]/page.tsx");
    for (const page of pages)
      expect(
        keysOf(page).length,
        `src/app/app/admin/${page} is not in the page table`,
      ).toBeGreaterThan(0);
  });
});

describe("admin pages check access on the server (TST-002)", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  const callers: Record<string, Caller> = {};
  /** The keys each signed-in caller may open; null is the Admin home. */
  const allowed: Record<string, (AdminTabKey | null)[]> = {};
  const signIn = (name: string, p: Principal | { userId: string }) => {
    request.sessions.set(name, {
      userId: p.userId,
      teamId: "teamId" in p ? p.teamId : null,
    });
    callers[name] = { kind: "session", cookie: name };
  };

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    vi.stubEnv("DATABASE_MODE", "pglite");
    vi.stubEnv("ALLOW_LOCAL_DB", "true");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("BETTER_AUTH_SECRET", "fictional-valid-test-secret-0123456789");
    vi.stubEnv("DEV_MAIL_MODE", "console");
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    const owner = await seedIdentity(db, {
      userId: "route-owner",
      teamId: "route-team-a",
    });
    const teamAdmin = await seedIdentity(db, {
      userId: "route-team-admin",
      teamId: "route-team-a",
      role: "admin",
    });
    const recruiter = await seedIdentity(db, {
      userId: "route-recruiter",
      teamId: "route-team-a",
      role: "recruiter",
    });
    // A newly created team: its owner holds no company authority.
    const teamOwner = await seedIdentity(db, {
      userId: "route-owner-b",
      teamId: "route-team-b",
    });
    // The company owner also works in team B as a recruiter.
    const ownerAsRecruiter = await seedIdentity(db, {
      userId: "route-owner",
      teamId: "route-team-b",
      role: "recruiter",
    });
    const companyAdmin = await seedIdentity(db, {
      userId: "route-company-admin",
      teamId: "route-team-b",
      role: "recruiter",
    });
    const organisationAdmin = await seedIdentity(db, {
      userId: "route-organisation-admin",
      teamId: "route-team-b",
      role: "recruiter",
    });
    await db.insert(user).values({
      id: "route-no-team",
      name: "Fictional Test User",
      email: "route-no-team@example.test",
      emailVerified: true,
      twoFactorEnabled: true,
    });
    await harness.client.exec(
      `INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','route-company-admin','admin','{fields}'),
        ('${COMPANY}','route-organisation-admin','admin','{organisation}')`,
    );
    callers.anonymous = { kind: "anonymous" };
    callers.bearer = { kind: "bearer" };
    signIn("team owner", teamOwner);
    signIn("team admin", teamAdmin);
    signIn("recruiter", recruiter);
    signIn("company admin", companyAdmin);
    signIn("company admin with organisation", organisationAdmin);
    signIn("company owner and team owner", owner);
    signIn("company owner as recruiter", ownerAsRecruiter);
    signIn("no team", { userId: "route-no-team" });
    const teamPages = [null, ...TEAM_PAGES, "directory" as const];
    allowed["team owner"] = teamPages;
    allowed["team admin"] = teamPages;
    allowed.recruiter = [];
    allowed["company admin"] = [null, "history"];
    allowed["company admin with organisation"] = [
      null,
      "organisation",
      "history",
    ];
    allowed["company owner and team owner"] = [null, ...KEYS];
    allowed["company owner as recruiter"] = [
      null,
      "roles",
      "organisation",
      "history",
    ];
    allowed["no team"] = [];
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness?.close();
  });

  it("sends an anonymous caller and a Bearer token alone to sign-in, never authenticating the token", async () => {
    for (const page of adminPages())
      for (const key of keysOf(page))
        for (const name of ["anonymous", "bearer"]) {
          vi.mocked(withTeam).mockClear();
          const outcome = await open(callers[name], page, key);
          expect(outcome, `${name} on ${page} ${key}`).toBe("sign-in");
          expect(withTeam).not.toHaveBeenCalled();
        }
    expect(authenticateApiToken).not.toHaveBeenCalled();
    expect(authenticateOAuthAccessToken).not.toHaveBeenCalled();
  });

  it("opens exactly the pages each signed-in caller holds, and the no-access state everywhere else", async () => {
    for (const [name, keys] of Object.entries(allowed))
      for (const page of adminPages())
        for (const key of keysOf(page)) {
          vi.mocked(withTeam).mockClear();
          const outcome = await open(callers[name], page, key);
          const label = `${name} on ${page} ${key ?? "home"}`;
          expect(outcome, label).toBe(
            keys.includes(key) ? "allowed" : "refused",
          );
          // One access check through authorize() for the active team, none without a team.
          expect(withTeam, label).toHaveBeenCalledTimes(
            name === "no team" ? 0 : 1,
          );
        }
    expect(authenticateApiToken).not.toHaveBeenCalled();
  });

  it("gives every page to a company owner who is team owner, and no team page or Directory to a company owner as recruiter", async () => {
    const owner = callers["company owner and team owner"];
    expect(await open(owner, "page.tsx", null)).toBe("allowed");
    for (const key of KEYS)
      expect(await open(owner, "[tab]/page.tsx", key), key).toBe("allowed");
    for (const key of [...TEAM_PAGES, "directory" as const])
      expect(
        await open(
          callers["company owner as recruiter"],
          "[tab]/page.tsx",
          key,
        ),
        key,
      ).toBe("refused");
  });

  it("answers an unknown key with not found", async () => {
    for (const name of ["company owner and team owner", "recruiter"])
      expect(
        await open(callers[name], "[tab]/page.tsx", "fictional"),
        name,
      ).toBe("not-found");
  });
});
