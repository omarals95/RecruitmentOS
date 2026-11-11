import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ADM-04 (job 075, IMP-001): the old team pages redirect to the current team's detail tabs. The
// harness is tests/admin-routes.test.ts's: split-role PGlite, the fictional session cookie and a
// redirect that throws its address.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
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
import { NO_ACCESS, OLD_TEAM_PAGES } from "@/components/settings/admin-tabs";
import { SpeedSettings } from "@/components/settings/speed-settings";
import { TeamSettings } from "@/components/settings/team-settings";
import { WorkspaceProvider } from "@/components/workspace/client";
import {
  authenticateApiToken,
  authenticateOAuthAccessToken,
} from "@/lib/api-tokens";
import { withTeam } from "@/lib/db-team";
import { getWorkspaceContext } from "@/lib/workspace";
import { createSplitRoleDb, seedIdentity } from "./helpers/db";

// Fictional data only: one company workspace with fictional teams A, B and C.
const COMPANY = "00000000-0000-4000-a000-000000000001";
const A = "redirect-team-a";
/** Each old address, its page file under src/app/app, its params and the tab it now opens. */
const ROUTES: [string, string, Record<string, string>, string][] = [
  ["/app/admin/members", "admin/[tab]/page.tsx", { tab: "members" }, "members"],
  [
    "/app/admin/cv-storage",
    "admin/[tab]/page.tsx",
    { tab: "cv-storage" },
    "cv-storage",
  ],
  ["/app/admin/speed", "admin/[tab]/page.tsx", { tab: "speed" }, "speed"],
  [
    "/app/admin/task-boards",
    "admin/[tab]/page.tsx",
    { tab: "task-boards" },
    "task-boards",
  ],
  ["/app/settings/team", "settings/team/page.tsx", {}, "members"],
  ["/app/settings/speed", "settings/speed/page.tsx", {}, "speed"],
];

type Caller = { kind: "anonymous" } | { kind: "bearer" } | { cookie: string };
type Result = { redirect: string } | { element: ReactElement };

function signedAs(caller: Caller) {
  request.headers = new Headers(
    "kind" in caller
      ? caller.kind === "bearer"
        ? { authorization: "Bearer fictional-admin-page-token" }
        : {}
      : { cookie: `fictional-session=${caller.cookie}` },
  );
}

/** Calls the page file's default export as Next would, for one caller. */
async function open(
  caller: Caller,
  file: string,
  params: Record<string, string>,
): Promise<Result> {
  signedAs(caller);
  const page = (
    (await import(/* @vite-ignore */ `@/app/app/${file}`)) as {
      default: (props: {
        params: Promise<Record<string, string>>;
      }) => Promise<unknown>;
    }
  ).default;
  try {
    const element = await page({ params: Promise.resolve(params) });
    expect(isValidElement(element)).toBe(true);
    return { element: element as ReactElement };
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith("redirect:"))
      return { redirect: message.slice("redirect:".length) };
    throw error;
  }
}

/** The element as the signed-in caller's workspace renders it. */
async function markupOf(caller: Caller, element: ReactElement) {
  signedAs(caller);
  const value = await getWorkspaceContext();
  return renderToStaticMarkup(
    createElement(WorkspaceProvider, { value, children: element }),
  );
}

describe("old team pages redirect to the current team's detail tabs (IMP-001)", () => {
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  const callers: Record<string, Caller> = {
    anonymous: { kind: "anonymous" },
    bearer: { kind: "bearer" },
  };
  const signIn = (name: string, userId: string, teamId: string | null) => {
    request.sessions.set(name, { userId, teamId });
    callers[name] = { cookie: name };
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
    await seedIdentity(db, { userId: "redirect-owner", teamId: A });
    // The company owner is a recruiter in team B, their current team there.
    await seedIdentity(db, {
      userId: "redirect-owner",
      teamId: "redirect-team-b",
      role: "recruiter",
    });
    // A team owner and a team admin of team A, each also administering another team.
    await seedIdentity(db, { userId: "redirect-team-owner", teamId: A });
    await seedIdentity(db, {
      userId: "redirect-team-owner",
      teamId: "redirect-team-c",
      role: "admin",
    });
    await seedIdentity(db, {
      userId: "redirect-team-admin",
      teamId: A,
      role: "admin",
    });
    await seedIdentity(db, {
      userId: "redirect-team-admin",
      teamId: "redirect-team-c",
    });
    await seedIdentity(db, {
      userId: "redirect-recruiter",
      teamId: A,
      role: "recruiter",
    });
    await seedIdentity(db, {
      userId: "redirect-viewer",
      teamId: A,
      role: "viewer",
    });
    // A company admin whose team role is viewer.
    await seedIdentity(db, {
      userId: "redirect-company-admin",
      teamId: "redirect-team-b",
      role: "viewer",
    });
    await harness.client.exec(
      `INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas) VALUES
        ('${COMPANY}','redirect-company-admin','admin','{people,organisation}')`,
    );
    await db.insert(user).values({
      id: "redirect-no-team",
      name: "Fictional Test User",
      email: "redirect-no-team@example.test",
      emailVerified: true,
      twoFactorEnabled: true,
    });
    signIn("company owner and team owner", "redirect-owner", A);
    signIn("company owner as recruiter", "redirect-owner", "redirect-team-b");
    signIn("team owner", "redirect-team-owner", A);
    signIn("team admin", "redirect-team-admin", A);
    signIn("recruiter", "redirect-recruiter", A);
    signIn("viewer", "redirect-viewer", A);
    signIn(
      "company admin as viewer",
      "redirect-company-admin",
      "redirect-team-b",
    );
    signIn("no team", "redirect-no-team", null);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness?.close();
  });

  it("maps the four old admin keys to their same-named tabs", () => {
    expect(OLD_TEAM_PAGES).toEqual({
      members: "members",
      "cv-storage": "cv-storage",
      speed: "speed",
      "task-boards": "task-boards",
    });
  });

  it("sends an owner or admin of the current team to exactly that tab, also when they administer another team", async () => {
    for (const name of [
      "company owner and team owner",
      "team owner",
      "team admin",
    ])
      for (const [path, file, params, tab] of ROUTES) {
        vi.mocked(withTeam).mockClear();
        const label = `${name} on ${path}`;
        expect(await open(callers[name], file, params), label).toEqual({
          redirect: `/app/admin/teams/${A}?tab=${tab}`,
        });
        // The team detail page's own check, as the session user in the current team.
        expect(withTeam, label).toHaveBeenCalledTimes(1);
        expect(vi.mocked(withTeam).mock.calls[0][0], label).toMatchObject({
          teamId: A,
          authType: "session",
        });
      }
  });

  it("sends an anonymous caller and a Bearer token alone to sign-in, never authenticating the token", async () => {
    for (const name of ["anonymous", "bearer"])
      for (const [path, file, params] of ROUTES) {
        vi.mocked(withTeam).mockClear();
        expect(
          await open(callers[name], file, params),
          `${name} ${path}`,
        ).toEqual({ redirect: "/sign-in" });
        expect(withTeam).not.toHaveBeenCalled();
      }
    expect(authenticateApiToken).not.toHaveBeenCalled();
    expect(authenticateOAuthAccessToken).not.toHaveBeenCalled();
  });

  const refused = [
    "recruiter",
    "viewer",
    "company owner as recruiter",
    "company admin as viewer",
    "no team",
  ];

  it("gives everyone else the no-access state on the old admin pages, without a redirect", async () => {
    for (const name of refused)
      for (const [path, file, params] of ROUTES.filter(([route]) =>
        route.startsWith("/app/admin/"),
      )) {
        const label = `${name} on ${path}`;
        const result = await open(callers[name], file, params);
        expect(result, label).not.toHaveProperty("redirect");
        const { element } = result as { element: ReactElement };
        expect(element.type, label).toBe(AdminPortalView);
        expect(element.props, label).toMatchObject({
          access: null,
          denied: true,
        });
        const markup = await markupOf(callers[name], element);
        expect(markup, label).toContain("<h1>Admin portal</h1>");
        expect(markup, label).toContain(`<p>${NO_ACCESS}</p>`);
        expect(markup, label).not.toMatch(/<nav|<h2|role="status"/);
      }
  });

  it("gives everyone else the speed refusal on /app/settings/speed, without a redirect", async () => {
    for (const name of refused) {
      const result = await open(callers[name], "settings/speed/page.tsx", {});
      expect(result, name).not.toHaveProperty("redirect");
      const { element } = result as { element: ReactElement };
      expect(element.type, name).toBe(SpeedSettings);
      const markup = await markupOf(callers[name], element);
      expect(markup, name).toContain(
        "Only team owners and admins can view speed timings.",
      );
      expect(markup, name).not.toMatch(/<table|<input|<select|<button/);
    }
  });

  it("gives everyone else Team & access without rename, Prepare task board or CV storage, and Create a team only when they may", async () => {
    for (const name of refused) {
      const result = await open(callers[name], "settings/team/page.tsx", {});
      expect(result, name).not.toHaveProperty("redirect");
      const { element } = result as { element: ReactElement };
      expect(element.type, name).toBe(TeamSettings);
      const markup = await markupOf(callers[name], element);
      expect(markup, name).toContain("<h1>Team &amp; access</h1>");
      expect(markup, name).toContain("<h2>Your teams</h2>");
      for (const text of [
        "Save team name",
        "Prepare task board",
        "CV storage",
        "application limits",
      ])
        expect(markup, `${name}: ${text}`).not.toContain(text);
      // The initial administrator may create a team; nobody else here owns one.
      expect(markup.includes("Create a team</h2>"), name).toBe(
        name === "company owner as recruiter",
      );
      expect(markup.includes("<h2>Members</h2>"), name).toBe(
        name !== "no team",
      );
    }
  });

  it("keeps API tokens and History where they are, with no redirect", async () => {
    for (const [name, key, outcome] of [
      ["team owner", "tokens", "allowed"],
      ["team admin", "tokens", "allowed"],
      ["recruiter", "tokens", "refused"],
      ["company owner as recruiter", "tokens", "refused"],
      ["company owner and team owner", "history", "allowed"],
      ["company owner as recruiter", "history", "allowed"],
      ["team owner", "history", "refused"],
      ["viewer", "history", "refused"],
    ] as const) {
      const label = `${name} on ${key}`;
      const result = await open(callers[name], "admin/[tab]/page.tsx", {
        tab: key,
      });
      expect(result, label).not.toHaveProperty("redirect");
      const { element } = result as { element: ReactElement };
      if (outcome === "allowed") {
        expect(element.type, label).toBe(AdminPortal);
        expect(element.props, label).toEqual({ tab: key });
      } else {
        expect(element.type, label).toBe(AdminPortalView);
        expect(element.props, label).toMatchObject({
          tab: key,
          access: null,
          denied: true,
        });
      }
    }
    for (const name of ["anonymous", "bearer"])
      for (const key of ["tokens", "history"])
        expect(
          await open(callers[name], "admin/[tab]/page.tsx", { tab: key }),
          `${name} on ${key}`,
        ).toEqual({ redirect: "/sign-in" });
  });
});
