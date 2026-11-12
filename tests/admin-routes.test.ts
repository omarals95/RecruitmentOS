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
  NOT_A_MEMBER,
  isAdminTab,
  type AdminTabKey,
} from "@/components/settings/admin-tabs";
import { GroupDetailPortal } from "@/components/settings/group-detail";
import { groupDetailTab } from "@/components/settings/group-detail-tabs";
import { TeamDetailPortal } from "@/components/settings/team-detail";
import { UserDetailPortal } from "@/components/settings/user-detail";
import { userDetailTab } from "@/components/settings/user-detail-tabs";
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
const DETAIL = "teams/[team]/page.tsx";
const USER_DETAIL = "users/[user]/page.tsx";
const GROUP_DETAIL = "groups/[group]/page.tsx";
const FICTIONAL_GROUP = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const ADMIN_DIR = join(process.cwd(), "src/app/app/admin");
const KEYS = ADMIN_TABS.map((tab) => tab.key);
// The four old team pages redirect to team detail tabs (tests/admin-redirects.test.ts).
const TEAM_PAGES: AdminTabKey[] = ["tokens"];
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
type Outcome = "allowed" | "refused" | "not-a-member" | "sign-in" | "not-found";

type Page = (props: {
  params: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string>>;
}) => Promise<unknown>;

/**
 * Calls the page file's default export as Next would, for one caller and one key; the team detail
 * page gets `team` (team A unless named) as its params, the user detail page `user` (the recruiter
 * unless named), the group detail page `group` (a fictional id unless named), and `tab`, when
 * named, as `?tab=`.
 */
async function open(
  caller: Caller,
  page: string,
  key: AdminTabKey | "fictional" | null,
  team = "route-team-a",
  tab?: string,
  user = "route-recruiter",
  group = FICTIONAL_GROUP,
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
      page.startsWith("[tab]/") && key !== null
        ? { tab: key }
        : page === DETAIL
          ? { team }
          : page === USER_DETAIL
            ? { user }
            : page === GROUP_DETAIL
              ? { group }
              : {};
    const search: Record<string, string> = tab === undefined ? {} : { tab };
    element = await render({
      params: Promise.resolve(params),
      searchParams: Promise.resolve(search),
    });
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
  if (result.type === TeamDetailPortal) {
    // The team in the URL, as the server read it; the page sends nothing about any other team.
    expect(result.props).toMatchObject({
      team: { id: team, name: "Fictional Test Team" },
      tab: tab ?? "members",
    });
    expect(["owner", "admin"]).toContain(result.props.role);
    expect(markup).toContain("<h2>Fictional Test Team</h2>");
    expect(markup).not.toContain(NO_ACCESS);
    expect(markup).not.toContain(NOT_A_MEMBER);
    return "allowed";
  }
  if (result.type === UserDetailPortal) {
    // The person in the URL and the caller's company level; the person loads in the browser.
    expect(result.props).toEqual({
      userId: user,
      companyLevel: expect.stringMatching(/^(owner|admin)$/),
      // An unknown key opens Profile.
      tab: userDetailTab(tab),
    });
    expect(markup).toContain("<h1>Admin portal</h1>");
    expect(markup).toContain('<p role="status">Loading this person…</p>');
    expect(markup).not.toContain(NO_ACCESS);
    return "allowed";
  }
  if (result.type === GroupDetailPortal) {
    // The group in the URL and the caller's company level; the group loads in the browser.
    expect(result.props).toEqual({
      groupId: group,
      companyLevel: expect.stringMatching(/^(owner|admin)$/),
      // An unknown key opens Members.
      tab: groupDetailTab(tab),
    });
    expect(markup).toContain("<h1>Admin portal</h1>");
    expect(markup).toContain('<p role="status">Loading this group…</p>');
    expect(markup).not.toContain(NO_ACCESS);
    return "allowed";
  }
  // Refused or not a member: one plain sentence, with no sidebar and no tab or team content.
  expect(result.type).toBe(AdminPortalView);
  expect(result.props).toMatchObject({ access: null, denied: true });
  expect(markup).toContain("<h1>Admin portal</h1>");
  expect(markup).not.toContain("Admin portal sections");
  expect(markup).not.toMatch(/<nav|<h2|role="status"/);
  expect(markup).not.toContain("Fictional Test");
  expect(markup).not.toContain("@example.test");
  if (markup.includes(`<p>${NOT_A_MEMBER}</p>`)) {
    expect(page).toBe(DETAIL);
    expect(markup).not.toContain(NO_ACCESS);
    return "not-a-member";
  }
  expect(markup).toContain(`<p>${NO_ACCESS}</p>`);
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
    const viewer = await seedIdentity(db, {
      userId: "route-viewer",
      teamId: "route-team-a",
      role: "viewer",
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
    // A second owner of team A, without company authority.
    const teamAOwner = await seedIdentity(db, {
      userId: "route-owner-a2",
      teamId: "route-team-a",
    });
    // Team C: its owner is the only member, so the company owner is not in it.
    await seedIdentity(db, { userId: "route-owner-c", teamId: "route-team-c" });
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
    const peopleAdmin = await seedIdentity(db, {
      userId: "route-people-admin",
      teamId: "route-team-b",
      role: "recruiter",
    });
    const noAreaAdmin = await seedIdentity(db, {
      userId: "route-no-area-admin",
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
        ('${COMPANY}','route-organisation-admin','admin','{organisation}'),
        ('${COMPANY}','route-people-admin','admin','{people}'),
        ('${COMPANY}','route-no-area-admin','admin','{}')`,
    );
    callers.anonymous = { kind: "anonymous" };
    callers.bearer = { kind: "bearer" };
    signIn("team owner", teamOwner);
    signIn("team A owner", teamAOwner);
    signIn("team admin", teamAdmin);
    signIn("recruiter", recruiter);
    signIn("viewer", viewer);
    signIn("company admin", companyAdmin);
    signIn("company admin with organisation", organisationAdmin);
    signIn("company admin with people", peopleAdmin);
    signIn("company admin with no area", noAreaAdmin);
    signIn("company owner and team owner", owner);
    signIn("company owner as recruiter", ownerAsRecruiter);
    signIn("no team", { userId: "route-no-team" });
    const teamPages = [
      null,
      "teams" as const,
      ...TEAM_PAGES,
      "directory" as const,
    ];
    allowed["team owner"] = teamPages;
    allowed["team admin"] = teamPages;
    allowed.recruiter = [];
    allowed.viewer = [];
    allowed["company admin"] = [null, "teams", "history"];
    allowed["company admin with organisation"] = [
      null,
      "teams",
      "organisation",
      "history",
    ];
    allowed["company admin with people"] = [
      null,
      "users",
      "groups",
      "teams",
      "history",
    ];
    allowed["company admin with no area"] = [null, "teams", "history"];
    allowed["company owner and team owner"] = [null, ...KEYS];
    allowed["company owner as recruiter"] = [
      null,
      "users",
      "groups",
      "teams",
      "company-authority",
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

  /** The team detail page on team A for each caller of the page table; see the matrix below. */
  const onTeamA: Record<string, Outcome> = {
    "team owner": "refused",
    "team admin": "allowed",
    recruiter: "refused",
    viewer: "refused",
    "company admin": "not-a-member",
    "company admin with organisation": "not-a-member",
    "company admin with people": "not-a-member",
    "company admin with no area": "not-a-member",
    "company owner and team owner": "allowed",
    "company owner as recruiter": "allowed",
    "no team": "refused",
  };

  it("opens exactly the pages each signed-in caller holds, and the no-access state everywhere else", async () => {
    for (const [name, keys] of Object.entries(allowed))
      for (const page of adminPages())
        for (const key of keysOf(page)) {
          vi.mocked(withTeam).mockClear();
          const outcome = await open(callers[name], page, key);
          const label = `${name} on ${page} ${key ?? "home"}`;
          expect(outcome, label).toBe(
            page === DETAIL
              ? onTeamA[name]
              : keys.includes(key)
                ? "allowed"
                : "refused",
          );
          // One access check through authorize() for the active team, none without a team.
          expect(withTeam, label).toHaveBeenCalledTimes(
            name === "no team" ? 0 : 1,
          );
        }
    expect(authenticateApiToken).not.toHaveBeenCalled();
  });

  it("opens Teams for team owners and admins and for company owners and admins only (ADM-02)", async () => {
    for (const [name, outcome] of [
      ["team owner", "allowed"],
      ["team admin", "allowed"],
      ["company admin", "allowed"],
      ["company admin with organisation", "allowed"],
      ["company owner and team owner", "allowed"],
      ["company owner as recruiter", "allowed"],
      ["recruiter", "refused"],
      ["viewer", "refused"],
      ["no team", "refused"],
      ["anonymous", "sign-in"],
      ["bearer", "sign-in"],
    ] as const)
      expect(await open(callers[name], "[tab]/page.tsx", "teams"), name).toBe(
        outcome,
      );
  });

  it("opens Users for company owners and the company admin with people only (ADM-07)", async () => {
    for (const [name, outcome] of [
      ["company owner and team owner", "allowed"],
      ["company owner as recruiter", "allowed"],
      ["company admin with people", "allowed"],
      ["company admin", "refused"],
      ["company admin with organisation", "refused"],
      ["team owner", "refused"],
      ["team A owner", "refused"],
      ["team admin", "refused"],
      ["recruiter", "refused"],
      ["viewer", "refused"],
      ["no team", "refused"],
      ["anonymous", "sign-in"],
      ["bearer", "sign-in"],
    ] as const)
      expect(await open(callers[name], "[tab]/page.tsx", "users"), name).toBe(
        outcome,
      );
  });

  // ADM-16 (job 077): Company authority is a company owner page only (D20), whatever the team role.
  it("opens Company authority for company owners only (ADM-16)", async () => {
    for (const [name, outcome] of [
      ["company owner and team owner", "allowed"],
      ["company owner as recruiter", "allowed"],
      ["team owner", "refused"],
      ["team A owner", "refused"],
      ["team admin", "refused"],
      ["recruiter", "refused"],
      ["viewer", "refused"],
      ["company admin with no area", "refused"],
      ["company admin", "refused"],
      ["company admin with organisation", "refused"],
      ["company admin with people", "refused"],
      ["no team", "refused"],
      ["anonymous", "sign-in"],
      ["bearer", "sign-in"],
    ] as const)
      expect(
        await open(callers[name], "[tab]/page.tsx", "company-authority"),
        name,
      ).toBe(outcome);
    expect(authenticateApiToken).not.toHaveBeenCalled();
    expect(authenticateOAuthAccessToken).not.toHaveBeenCalled();
  });

  // ADM-08 (job 076): the user detail page is a sub-page of Users and opens for exactly its callers,
  // through one access check in the active team, whoever the person in the URL is.
  it("opens user detail for company owners and the company admin with people only, on every tab (ADM-08)", async () => {
    for (const tab of [
      undefined,
      "profile",
      "teams",
      "authority",
      "security",
      "activity",
      "groups",
    ])
      for (const [name, outcome] of [
        ["company owner and team owner", "allowed"],
        ["company owner as recruiter", "allowed"],
        ["company admin with people", "allowed"],
        ["company admin with no area", "refused"],
        ["company admin", "refused"],
        ["company admin with organisation", "refused"],
        ["team owner", "refused"],
        ["team A owner", "refused"],
        ["team admin", "refused"],
        ["recruiter", "refused"],
        ["viewer", "refused"],
        ["no team", "refused"],
        ["anonymous", "sign-in"],
        ["bearer", "sign-in"],
      ] as const)
        for (const user of [
          "route-recruiter",
          "route-owner-c",
          "fictional-made-up-user",
        ]) {
          vi.mocked(withTeam).mockClear();
          const label = `${name} on ${user} ?tab=${tab ?? ""}`;
          expect(
            await open(
              callers[name],
              USER_DETAIL,
              "users",
              undefined,
              tab,
              user,
            ),
            label,
          ).toBe(outcome);
          expect(withTeam, label).toHaveBeenCalledTimes(
            outcome === "sign-in" || name === "no team" ? 0 : 1,
          );
        }
    expect(authenticateApiToken).not.toHaveBeenCalled();
    expect(authenticateOAuthAccessToken).not.toHaveBeenCalled();
  });

  // ADM-12 (job 095): Groups and its detail page open for exactly the callers of Users, on every tab,
  // through one access check in the active team, whatever the group in the URL is.
  it("opens Groups and group detail for company owners and the company admin with people only, on every tab (ADM-12)", async () => {
    const callersAndOutcomes = [
      ["company owner and team owner", "allowed"],
      ["company owner as recruiter", "allowed"],
      ["company admin with people", "allowed"],
      ["company admin with no area", "refused"],
      ["company admin", "refused"],
      ["company admin with organisation", "refused"],
      ["team owner", "refused"],
      ["team A owner", "refused"],
      ["team admin", "refused"],
      ["recruiter", "refused"],
      ["viewer", "refused"],
      ["no team", "refused"],
      ["anonymous", "sign-in"],
      ["bearer", "sign-in"],
    ] as const;
    for (const [name, outcome] of callersAndOutcomes)
      expect(await open(callers[name], "[tab]/page.tsx", "groups"), name).toBe(
        outcome,
      );
    for (const tab of [
      undefined,
      "members",
      "member-of",
      "audit",
      "where-used",
      "approval",
    ])
      for (const [name, outcome] of callersAndOutcomes)
        for (const group of [FICTIONAL_GROUP, "not-a-uuid"]) {
          vi.mocked(withTeam).mockClear();
          const label = `${name} on ${group} ?tab=${tab ?? ""}`;
          expect(
            await open(
              callers[name],
              GROUP_DETAIL,
              "groups",
              undefined,
              tab,
              undefined,
              group,
            ),
            label,
          ).toBe(outcome);
          expect(withTeam, label).toHaveBeenCalledTimes(
            outcome === "sign-in" || name === "no team" ? 0 : 1,
          );
        }
    expect(authenticateApiToken).not.toHaveBeenCalled();
    expect(authenticateOAuthAccessToken).not.toHaveBeenCalled();
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

  // ADM-03: the team detail page opens only through the team role in that team (architecture
  // §14.2); company authority outside the team gets the plain not-a-member state (TST-005).
  // ADM-04 (job 075): every tab, the new ones included, opens through the same one check.
  it("opens team detail for the team's owners and admins only, and tells company authority outside the team it is not a member, on every tab", async () => {
    // Caller, team in the URL, outcome, and the team its one access check ran in.
    const A = "route-team-a";
    const B = "route-team-b";
    for (const tab of [
      undefined,
      "members",
      "settings",
      "cv-storage",
      "speed",
      "task-boards",
      "activity",
      // ADM-05 (job 078): Archive, shown to owners and admins alike.
      "archive",
    ])
      for (const [name, team, outcome, checked] of [
        ["anonymous", A, "sign-in", null],
        ["bearer", A, "sign-in", null],
        ["team A owner", A, "allowed", A],
        ["team admin", A, "allowed", A],
        ["company owner and team owner", A, "allowed", A],
        ["team owner", A, "refused", B],
        ["recruiter", A, "refused", A],
        ["viewer", A, "refused", A],
        ["company owner as recruiter", B, "refused", B],
        ["company admin", A, "not-a-member", B],
        ["company admin with organisation", A, "not-a-member", B],
        ["company owner and team owner", "route-team-c", "not-a-member", A],
        ["no team", A, "refused", null],
        [
          "company owner and team owner",
          "fictional-made-up-team",
          "not-a-member",
          A,
        ],
        ["team owner", "fictional-made-up-team", "refused", B],
      ] as const) {
        vi.mocked(withTeam).mockClear();
        const label = `${name} on ${team} ?tab=${tab ?? ""}`;
        expect(
          await open(callers[name], DETAIL, "teams", team, tab),
          label,
        ).toBe(outcome);
        // A member is checked in the team of the URL, anyone else in their active team.
        expect(withTeam, label).toHaveBeenCalledTimes(checked ? 1 : 0);
        if (checked)
          expect(vi.mocked(withTeam).mock.calls[0][0], label).toMatchObject({
            teamId: checked,
            authType: "session",
          });
      }
    expect(authenticateApiToken).not.toHaveBeenCalled();
    expect(authenticateOAuthAccessToken).not.toHaveBeenCalled();
  });

  it("answers an unknown key with not found", async () => {
    for (const name of ["company owner and team owner", "recruiter"])
      expect(
        await open(callers[name], "[tab]/page.tsx", "fictional"),
        name,
      ).toBe("not-found");
  });
});
