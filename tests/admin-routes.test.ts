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
import { CONFIGURABLE_KINDS, type ConfigurableKind } from "@/domain/config";
import { DEFAULT_KIND_SCHEMAS } from "@/domain/config-defaults";
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
import { FieldDetailPortal } from "@/components/settings/field-detail";
import { fieldDetailTab } from "@/components/settings/field-detail-tabs";
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
import { requireVerifiedIdentity } from "@/lib/auth-policy";
import { getVerifiedSession } from "@/lib/auth-session";
import { withTeam } from "@/lib/db-team";
import type { Principal } from "@/lib/principal";
import {
  GET as listFields,
  POST as createField,
} from "@/app/api/v1/admin/fields/route";
import { PUT as editDraft } from "@/app/api/v1/admin/fields/drafts/[versionId]/route";
import { POST as publishDraft } from "@/app/api/v1/admin/fields/drafts/[versionId]/publish/route";
import { GET as fieldUsageRoute } from "@/app/api/v1/admin/fields/usage/route";
import { createRecord } from "@/lib/records";
import { createSplitRoleDb, seedIdentity } from "./helpers/db";
import { customField, kindBody } from "./helpers/kind-schemas";

// Fictional data only: one company workspace with two fictional teams.
const COMPANY = "00000000-0000-4000-a000-000000000001";
const DETAIL = "teams/[team]/page.tsx";
const USER_DETAIL = "users/[user]/page.tsx";
const GROUP_DETAIL = "groups/[group]/page.tsx";
const FIELD_DETAIL = "fields/[kind]/[field]/page.tsx";
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
              : page === FIELD_DETAIL
                ? { kind: "candidate", field: "name" }
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
  if (result.type === FieldDetailPortal) {
    // The kind and field in the URL and the caller's company level; the field loads in the browser.
    expect(result.props).toEqual({
      kind: "candidate",
      fieldKey: "name",
      companyLevel: expect.stringMatching(/^(owner|admin)$/),
      // An unknown key opens Contexts & options.
      tab: fieldDetailTab(tab),
    });
    expect(markup).toContain("<h1>Admin portal</h1>");
    expect(markup).toContain('<p role="status">Loading this field…</p>');
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
  /** Each signed-in caller with a team, for the API routes. */
  const principals: Record<string, Principal> = {};
  const signIn = (name: string, p: Principal | { userId: string }) => {
    if ("teamId" in p) principals[name] = p;
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
    allowed["company admin"] = [null, "teams", "fields", "screens", "history"];
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
      "fields",
      "screens",
      "domain",
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

  // R2b-09 (job 094): Fields is a company owner page, and a page of the company admin with fields.
  it("opens Fields for company owners and the company admin with fields only (R2b-09)", async () => {
    for (const [name, outcome] of [
      ["company admin", "allowed"],
      ["company owner and team owner", "allowed"],
      ["company owner as recruiter", "allowed"],
      ["team owner", "refused"],
      ["team A owner", "refused"],
      ["team admin", "refused"],
      ["recruiter", "refused"],
      ["viewer", "refused"],
      ["company admin with organisation", "refused"],
      ["company admin with people", "refused"],
      ["company admin with no area", "refused"],
      ["no team", "refused"],
      ["anonymous", "sign-in"],
      ["bearer", "sign-in"],
    ] as const)
      expect(await open(callers[name], "[tab]/page.tsx", "fields"), name).toBe(
        outcome,
      );
    expect(authenticateApiToken).not.toHaveBeenCalled();
    expect(authenticateOAuthAccessToken).not.toHaveBeenCalled();
  });

  // R2b-10 (job 102): Screens is a company owner page, and a page of the company admin with fields.
  it("opens Screens for company owners and the company admin with fields only (R2b-10)", async () => {
    for (const [name, outcome] of [
      ["company admin", "allowed"],
      ["company owner and team owner", "allowed"],
      ["company owner as recruiter", "allowed"],
      ["team owner", "refused"],
      ["team A owner", "refused"],
      ["team admin", "refused"],
      ["recruiter", "refused"],
      ["viewer", "refused"],
      ["company admin with organisation", "refused"],
      ["company admin with people", "refused"],
      ["company admin with no area", "refused"],
      ["no team", "refused"],
      ["anonymous", "sign-in"],
      ["bearer", "sign-in"],
    ] as const)
      expect(await open(callers[name], "[tab]/page.tsx", "screens"), name).toBe(
        outcome,
      );
    expect(authenticateApiToken).not.toHaveBeenCalled();
    expect(authenticateOAuthAccessToken).not.toHaveBeenCalled();
  });

  // ADM-29 (job 100): a field's detail page is a sub-page of Fields and opens for exactly its
  // callers, on every tab, through one access check in the active team.
  it("opens field detail for company owners and the company admin with fields only, on every tab (ADM-29)", async () => {
    for (const tab of [undefined, "contexts", "where-used", "general"])
      for (const [name, outcome] of [
        ["company admin", "allowed"],
        ["company owner and team owner", "allowed"],
        ["company owner as recruiter", "allowed"],
        ["team owner", "refused"],
        ["team A owner", "refused"],
        ["team admin", "refused"],
        ["recruiter", "refused"],
        ["viewer", "refused"],
        ["company admin with organisation", "refused"],
        ["company admin with people", "refused"],
        ["company admin with no area", "refused"],
        ["no team", "refused"],
        ["anonymous", "sign-in"],
        ["bearer", "sign-in"],
      ] as const) {
        vi.mocked(withTeam).mockClear();
        const label = `${name} ?tab=${tab ?? ""}`;
        expect(
          await open(callers[name], FIELD_DETAIL, "fields", undefined, tab),
          label,
        ).toBe(outcome);
        expect(withTeam, label).toHaveBeenCalledTimes(
          outcome === "sign-in" || name === "no team" ? 0 : 1,
        );
      }
    expect(authenticateApiToken).not.toHaveBeenCalled();
    expect(authenticateOAuthAccessToken).not.toHaveBeenCalled();
  });

  // ADM-40 (job 098): Domain is a company owner page only (D20), whatever the team role or areas.
  it("opens Domain for company owners only (ADM-40)", async () => {
    for (const [name, outcome] of [
      ["company owner and team owner", "allowed"],
      ["company owner as recruiter", "allowed"],
      ["team owner", "refused"],
      ["team A owner", "refused"],
      ["team admin", "refused"],
      ["recruiter", "refused"],
      ["viewer", "refused"],
      ["company admin", "refused"],
      ["company admin with organisation", "refused"],
      ["company admin with people", "refused"],
      ["company admin with no area", "refused"],
      ["no team", "refused"],
      ["anonymous", "sign-in"],
      ["bearer", "sign-in"],
    ] as const)
      expect(await open(callers[name], "[tab]/page.tsx", "domain"), name).toBe(
        outcome,
      );
    expect(authenticateApiToken).not.toHaveBeenCalled();
    expect(authenticateOAuthAccessToken).not.toHaveBeenCalled();
  });

  // R2b-09 (job 094): the Fields page's four routes answer each caller as the spec's matrix says.
  describe("Fields routes (R2b-09)", () => {
    const ORIGIN = "http://localhost:3000";
    const UNKNOWN = "00000000-0000-4000-8000-0000000000f9";
    type Answer = {
      status: number;
      body: { data?: unknown; error?: { code: string } };
    };
    /** One request through a route handler as a signed-in caller, a Bearer token or nobody. */
    async function call(
      name: string,
      handler: (request: Request, ctx: never) => Promise<Response>,
      path: string,
      init: { method?: string; body?: unknown; versionId?: string } = {},
    ): Promise<Answer> {
      const p = principals[name];
      vi.mocked(getVerifiedSession).mockImplementation(async () =>
        p
          ? ({
              user: { id: p.userId, twoFactorEnabled: true },
              session: {
                activeOrganizationId: p.teamId,
                createdAt: new Date(),
              },
            } as never)
          : (requireVerifiedIdentity(null) as never),
      );
      const response = await handler(
        new Request(`${ORIGIN}${path}`, {
          method: init.method ?? "GET",
          headers: {
            origin: ORIGIN,
            ...(p ? { "x-team-id": p.teamId } : {}),
            ...(name === "bearer"
              ? { authorization: "Bearer fictional-fields-token" }
              : {}),
            ...(init.body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        }),
        {
          params: Promise.resolve({ versionId: init.versionId ?? UNKNOWN }),
        } as never,
      );
      return { status: response.status, body: await response.json() };
    }
    const body = (kind: ConfigurableKind) => DEFAULT_KIND_SCHEMAS[kind].body;
    const routes = (versionId: string, kind: ConfigurableKind) => [
      () => call(nameOf.current, listFields as never, "/api/v1/admin/fields"),
      () =>
        call(nameOf.current, createField as never, "/api/v1/admin/fields", {
          method: "POST",
          body: { kind, body: body(kind) },
        }),
      () =>
        call(
          nameOf.current,
          editDraft as never,
          `/api/v1/admin/fields/drafts/${versionId}`,
          { method: "PUT", body: { body: body(kind) }, versionId },
        ),
      () =>
        call(
          nameOf.current,
          publishDraft as never,
          `/api/v1/admin/fields/drafts/${versionId}/publish`,
          { method: "POST", versionId },
        ),
    ];
    const nameOf = { current: "" };

    it("answers 401 without credentials, 403 session_required to a token, 403 config_forbidden without company authority or fields, and 2xx to a company owner and the company admin with fields", async () => {
      // Each allowed caller's own draft: the owner's candidate and the admin's checklist.
      nameOf.current = "company owner and team owner";
      const ownerDraft = await routes(UNKNOWN, "candidate")[1]();
      nameOf.current = "company admin";
      const adminDraft = await routes(UNKNOWN, "checklist")[1]();
      for (const draft of [ownerDraft, adminDraft])
        expect(draft.status).toBe(201);
      const ownerVersion = (ownerDraft.body.data as { versionId: string })
        .versionId;
      const adminVersion = (adminDraft.body.data as { versionId: string })
        .versionId;
      for (const [name, status, code] of [
        ["anonymous", 401, "UNAUTHENTICATED"],
        ["bearer", 403, "session_required"],
        ["team owner", 403, "config_forbidden"],
        ["team admin", 403, "config_forbidden"],
        ["company admin with no area", 403, "config_forbidden"],
        ["company admin with organisation", 403, "config_forbidden"],
        ["company admin with people", 403, "config_forbidden"],
      ] as const) {
        nameOf.current = name;
        for (const [index, route] of routes(ownerVersion, "task").entries()) {
          const answer = await route();
          expect(answer.status, `${name} route ${index}`).toBe(status);
          expect(answer.body.error?.code, `${name} route ${index}`).toBe(code);
        }
      }
      expect(authenticateApiToken).not.toHaveBeenCalled();
      for (const [name, versionId, kind] of [
        ["company owner and team owner", ownerVersion, "candidate"],
        ["company admin", adminVersion, "checklist"],
      ] as const) {
        nameOf.current = name;
        const [list, , edit, publish] = routes(versionId, kind);
        const listed = await list();
        expect(listed.status, name).toBe(200);
        const kinds = listed.body.data as {
          kind: string;
          current: { number: number | null };
          draft: { versionId: string } | null;
        }[];
        expect(kinds.map((item) => item.kind)).toEqual([...CONFIGURABLE_KINDS]);
        expect(kinds.find((item) => item.kind === kind)).toMatchObject({
          current: { number: null },
          draft: { versionId },
        });
        expect((await edit()).status, name).toBe(200);
        expect((await publish()).body, name).toEqual({
          data: { versionId, number: 1 },
        });
      }
      nameOf.current = "company admin";
      const after = (await routes(UNKNOWN, "candidate")[0]()).body.data as {
        kind: string;
        current: { number: number | null };
      }[];
      expect(after.map((item) => [item.kind, item.current.number])).toEqual(
        CONFIGURABLE_KINDS.map((kind) => [
          kind,
          kind === "candidate" || kind === "checklist" ? 1 : null,
        ]),
      );
    });

    it("refuses a kind that is not configurable and a body of another kind with invalid_input", async () => {
      nameOf.current = "company owner and team owner";
      for (const input of [
        { kind: "comment", body: body("candidate") },
        { kind: "offer", body: body("interview") },
      ]) {
        const answer = await call(
          nameOf.current,
          createField as never,
          "/api/v1/admin/fields",
          { method: "POST", body: input },
        );
        expect(answer.status, input.kind).toBe(400);
        expect(answer.body.error?.code, input.kind).toBe("invalid_input");
      }
    });

    // ADM-29 (job 100): option edits and the usage count follow the same matrix.
    it("refuses option edits and the usage count to everyone but a company owner and the company admin with fields, and counts only published custom fields", async () => {
      const owner = "company owner and team owner";
      const level = customField("Fictional route level", "dropdown", {
        options: [
          { id: "fictional-yes", label: "Fictional yes" },
          { id: "fictional-no", label: "Fictional no" },
        ],
      });
      const published = kindBody("candidate", [level]);
      nameOf.current = owner;
      const created = await call(
        owner,
        createField as never,
        "/api/v1/admin/fields",
        {
          method: "POST",
          body: { kind: "candidate", body: published },
        },
      );
      const first = (created.body.data as { versionId: string }).versionId;
      expect((await routes(first, "candidate")[3]()).body.data).toMatchObject({
        number: 2,
      });
      await createRecord(principals[owner], "candidates", {
        data: {
          name: "Fictional Route Holder",
          customValues: { [level.key]: "fictional-yes" },
        },
      });
      // An option renamed and one disabled, in a new draft that only the two writers may change.
      const renamed = structuredClone(published);
      Object.assign(
        renamed.fields.find((field) => field.key === level.key)!,
        {
          options: [
            { id: "fictional-yes", label: "Fictional yes renamed" },
            { id: "fictional-no", label: "Fictional no", disabled: true },
          ],
        },
      );
      const draft = (
        (
          await call(owner, createField as never, "/api/v1/admin/fields", {
            method: "POST",
            body: { kind: "candidate", body: published },
          })
        ).body.data as { versionId: string }
      ).versionId;
      const usage = (query: string) => `/api/v1/admin/fields/usage?${query}`;
      const counted = usage(`kind=candidate&fieldId=${level.key}`);
      for (const [name, status, code] of [
        ["anonymous", 401, "UNAUTHENTICATED"],
        ["bearer", 403, "session_required"],
        ["team owner", 403, "config_forbidden"],
        ["team A owner", 403, "config_forbidden"],
        ["team admin", 403, "config_forbidden"],
        ["company admin with no area", 403, "config_forbidden"],
        ["company admin with organisation", 403, "config_forbidden"],
        ["company admin with people", 403, "config_forbidden"],
      ] as const) {
        for (const answer of [
          await call(
            name,
            editDraft as never,
            `/api/v1/admin/fields/drafts/${draft}`,
            { method: "PUT", body: { body: renamed }, versionId: draft },
          ),
          await call(name, fieldUsageRoute as never, counted),
        ]) {
          expect(answer.status, name).toBe(status);
          expect(answer.body.error?.code, name).toBe(code);
        }
      }
      expect(authenticateApiToken).not.toHaveBeenCalled();
      for (const [query, status, code] of [
        ["kind=comment&fieldId=" + level.key, 400, "invalid_input"],
        ["kind=candidate&fieldId=not-a-uuid", 400, "invalid_input"],
        ["kind=candidate", 400, "invalid_input"],
        [
          `kind=candidate&fieldId=${level.key}&team=route-team-a`,
          400,
          "invalid_input",
        ],
        [`kind=candidate&fieldId=${UNKNOWN}`, 404, "not_found"],
        [`kind=vacancy&fieldId=${level.key}`, 404, "not_found"],
      ] as const) {
        const answer = await call(
          owner,
          fieldUsageRoute as never,
          usage(query),
        );
        expect(answer.status, query).toBe(status);
        expect(answer.body.error?.code, query).toBe(code);
      }
      for (const name of [owner, "company admin"])
        expect(
          await call(name, fieldUsageRoute as never, counted),
          name,
        ).toEqual({
          status: 200,
          body: { data: { count: 1 } },
        });
      // The company admin with fields renames and disables, and publishes.
      const edited = await call(
        "company admin",
        editDraft as never,
        `/api/v1/admin/fields/drafts/${draft}`,
        { method: "PUT", body: { body: renamed }, versionId: draft },
      );
      expect(edited.status).toBe(200);
      nameOf.current = "company admin";
      expect((await routes(draft, "candidate")[3]()).body.data).toMatchObject({
        number: 3,
      });
      expect(await call(owner, fieldUsageRoute as never, counted)).toEqual({
        status: 200,
        body: { data: { count: 1 } },
      });
    });
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
