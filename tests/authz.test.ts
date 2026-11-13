import { and, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  ACTION_RESOURCES,
  ACTIONS,
  ADMIN_AREAS,
  GRANTABLE_ADMIN_AREAS,
  OWNER_ADMIN_AREAS,
  PAGE_KEYS,
  RECORD_RESOURCES,
  configKey,
  configBodySchemas,
  isOwnerTemplateBody,
  roleBodySchema,
  type Action,
  type RoleBody,
} from "@/domain/config";
import {
  ADMIN_ROLE,
  HIRING_MANAGER_ROLE,
  INTERVIEWER_ROLE,
  OWNER_ROLE,
  RECRUITER_ROLE,
  ROLE_TEMPLATES,
  VIEWER_ROLE,
  builtInRoleFor,
} from "@/domain/config-defaults";
import {
  RESOURCE_CONFIG,
  SENSITIVE_CANDIDATE_FIELDS,
  recordDataSchemas,
  resourceToKind,
  type RecordDto,
  type RecordKind,
  type ResourceName,
} from "@/domain/records";
import { EXPORT_RESOURCES, exportTable } from "@/domain/export";
import { effectiveTokenScopes } from "@/lib/api-token-policy";
import {
  accessContext,
  authorize,
  decide,
  hiddenKeys,
  redact,
  scopeFilter,
  type AccessContext,
  type AccessRequest,
} from "@/lib/authz";
import { ApiError } from "@/lib/errors";
import {
  API_TOKEN_SCOPES,
  MCP_SCOPES,
  SCOPES,
  roleScopes,
  type Role,
} from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import {
  INPUT_CHECKS,
  TOOLS,
  inputAllowed,
  toolAllowed,
} from "@/lib/mcp/tools";
import { eq, sql } from "drizzle-orm";
import { records } from "@/db/schema";
import { afterAll, beforeAll, vi } from "vitest";
import type { AppDb } from "@/db";
import { getVerifiedSession } from "@/lib/auth-session";
import { createConfigDraft } from "@/lib/config-store";
import * as authorityRoute from "@/app/api/v1/company-authority/route";
import * as memberRolesRoute from "@/app/api/v1/teams/member-roles/route";
import * as rolesRoute from "@/app/api/v1/roles/route";
import * as roleRoute from "@/app/api/v1/roles/[id]/route";
import * as publishRoute from "@/app/api/v1/roles/[id]/publish/route";
import { createSplitRoleDb, seedIdentity } from "./helpers/db";

// The escalation cases below run through the routes on a split-role PGlite: the identity role
// reads memberships, the data role runs withTeam. The pure cases above never reach the database.
const pools = vi.hoisted(() => ({ data: vi.fn(), identity: vi.fn() }));
vi.mock("@/db", async (original) => ({
  ...(await original<typeof import("@/db")>()),
  getDb: pools.data,
  getIdentityDb: pools.identity,
}));
vi.mock("@/lib/auth-session", () => ({ getVerifiedSession: vi.fn() }));

// Fictional ids only.
const TEAM = "10000000-0000-4000-8000-000000000001";
const USER = "20000000-0000-4000-8000-000000000002";
const WORKSPACE = "30000000-0000-4000-8000-000000000003";
const ROLES = ["owner", "admin", "recruiter", "viewer"] as const;
const FORGED = "superuser" as Role;
const RESOURCES = Object.keys(RESOURCE_CONFIG) as ResourceName[];
const KINDS = Object.keys(recordDataSchemas) as RecordKind[];

const subsets = <T>(list: readonly T[]): T[][] =>
  Array.from({ length: 2 ** list.length }, (_, mask) =>
    list.filter((_, index) => mask & (2 ** index)),
  );
const session = (role: Role): Principal => ({
  userId: USER,
  teamId: TEAM,
  role,
  scopes: roleScopes(role),
  authType: "session",
});
const token = (
  role: Role,
  stored: readonly string[],
  oauthClientId?: string,
): Principal => ({
  userId: USER,
  teamId: TEAM,
  role,
  scopes: effectiveTokenScopes(stored, role),
  authType: "token",
  tokenId: "40000000-0000-4000-8000-000000000004",
  ...(oauthClientId ? { oauthClientId } : {}),
});
/** The session, every API-token scope subset and every OAuth MCP scope subset of one role. */
const principalsOf = (role: Role): Principal[] => [
  session(role),
  ...subsets(API_TOKEN_SCOPES).map((stored) => token(role, stored)),
  ...subsets(MCP_SCOPES).map((stored) =>
    token(role, stored, "fictional-oauth-client"),
  ),
];
const accessOf = (
  p: Principal,
  overrides: Partial<AccessContext["access"]> = {},
): AccessContext["access"] => ({
  scopes: p.scopes,
  workspaceId: WORKSPACE,
  memberRole: p.role,
  companyLevel: null,
  companyAreas: [],
  versions: {},
  ...overrides,
});
const contextOf = (
  p: Principal,
  options: Parameters<typeof accessContext>[2] = {},
  overrides: Partial<AccessContext["access"]> = {},
) => accessContext(p, accessOf(p, overrides), options);
const outcome = (decide: () => unknown): string => {
  try {
    decide();
    return "allowed";
  } catch (error) {
    if (error instanceof ApiError) return `${error.status} ${error.code}`;
    throw error;
  }
};
const allowed = (ctx: AccessContext, request: AccessRequest) =>
  outcome(() => authorize(ctx, request)) === "allowed";
const forbidden = () =>
  new ApiError(403, "forbidden", "You do not have permission for this action.");

// Frozen oracles: verbatim copies of permission(), importPermission() and owned() as
// src/lib/records.ts had them before R2a-07 moved the records service onto the engine.
const knownRoles = new Set(["owner", "admin", "recruiter", "viewer"]);
function permission(p: Principal, resource: ResourceName, write = false) {
  const scope = `${resource === "candidates" ? "candidates" : "recruitment"}:${write ? "write" : "read"}`;
  if (
    !knownRoles.has(p.role) ||
    (write && p.role === "viewer") ||
    !p.scopes.includes(scope as Principal["scopes"][number])
  )
    throw new ApiError(
      403,
      "forbidden",
      "You do not have permission for this action.",
    );
}
function importPermission(p: Principal) {
  if (
    !["owner", "admin"].includes(p.role) ||
    !p.scopes.includes("imports:write")
  )
    throw new ApiError(
      403,
      "import_forbidden",
      "Legacy source fields require an owner or admin import token.",
    );
}
function owned(p: Principal, kind: RecordKind): SQL[] {
  return [
    eq(records.teamId, p.teamId),
    eq(records.kind, kind),
    ...(kind === "saved-view" ? [eq(records.privateOwnerId, p.userId)] : []),
    // Without candidates:read, comments on candidates do not exist for the caller.
    ...(kind === "comment" && !p.scopes.includes("candidates:read")
      ? [
          sql`exists(select 1 from ${records} parent where parent.team_id=${p.teamId} and parent.id=${records.parentRecordId} and parent.kind<>'candidate')`,
        ]
      : []),
  ];
}

/** Today's answer for one resource and action, from the functions records.ts uses now. */
function today(p: Principal, resource: ResourceName, action: Action) {
  switch (action) {
    case "view":
    case "export":
      return permission(p, resource);
    case "create":
    case "edit":
    case "transition":
    case "archive":
    case "approve":
    case "share-view":
      return permission(p, resource, true);
    case "comment":
      permission(p, "comments", true);
      // checkReferences: a candidate parent needs candidates:read and candidate write permission.
      if (resource === "candidates") {
        if (!p.scopes.includes("candidates:read")) throw forbidden();
        permission(p, "candidates", true);
      }
      return;
    case "import":
      return importPermission(p);
    case "erase":
      // eraseCandidate(): session owners only, and only candidates are erased.
      if (
        resource !== "candidates" ||
        p.role !== "owner" ||
        p.authType !== "session"
      )
        throw forbidden();
      return;
    case "admin":
      throw forbidden();
  }
}

const dialect = new PgDialect();
const render = (filters: SQL[]) => dialect.sqlToQuery(and(...filters)!);

const body = (overrides: Record<string, unknown>) => ({
  ...structuredClone(RECRUITER_ROLE.body),
  ...overrides,
});
const refused = (value: unknown) =>
  expect(roleBodySchema.safeParse(value).success).toBe(false);

describe("authorize equivalence with today's checks", () => {
  for (const role of [...ROLES, FORGED])
    it(`matches permission(), importPermission() and the erasure rule for ${role}`, () => {
      let cases = 0;
      for (const p of principalsOf(role)) {
        const ctx = contextOf(p);
        for (const resource of RESOURCES)
          for (const action of ACTIONS) {
            const expected = outcome(() => today(p, resource, action));
            const actual = outcome(() => authorize(ctx, { resource, action }));
            if (actual !== expected)
              expect({ p, resource, action, actual }).toEqual({
                p,
                resource,
                action,
                actual: expected,
              });
            cases++;
          }
      }
      expect(cases).toBe((1 + 128 + 64) * RESOURCES.length * ACTIONS.length);
    });

  it("mirrors the owner-only and owner-or-admin team rules for sessions and tokens", () => {
    for (const role of [...ROLES, FORGED])
      for (const p of principalsOf(role)) {
        const ctx = contextOf(p);
        const isSession = p.authType === "session";
        expect(
          allowed(ctx, { resource: "two-step-reset", action: "admin" }),
        ).toBe(p.role === "owner" && isSession);
        expect(allowed(ctx, { resource: "teams", action: "admin" })).toBe(
          p.role === "owner" && isSession,
        );
        // The storage-settings routes are humanOnly: owner or admin sessions only.
        expect(
          allowed(ctx, { resource: "storage-settings", action: "admin" }),
        ).toBe((p.role === "owner" || p.role === "admin") && isSession);
        expect(allowed(ctx, { resource: "candidates", action: "erase" })).toBe(
          p.role === "owner" && isSession,
        );
        for (const resource of ["two-step-reset", "teams", "storage-settings"])
          for (const action of ACTIONS.filter((a) => a !== "admin"))
            expect(
              allowed(ctx, { resource: resource as "teams", action }),
            ).toBe(false);
      }
  });

  it("gives the directory to owner and admin sessions only and plans to nobody", () => {
    for (const role of [...ROLES, FORGED])
      for (const p of principalsOf(role)) {
        const ctx = contextOf(p);
        const manager =
          p.authType === "session" &&
          (p.role === "owner" || p.role === "admin");
        for (const action of ["view", "create", "edit", "archive"] as const)
          expect(allowed(ctx, { resource: "directory", action })).toBe(manager);
        for (const action of ACTIONS)
          expect(allowed(ctx, { resource: "plans", action })).toBe(false);
      }
  });

  it("keeps today's effective scopes for every built-in template", () => {
    for (const role of ROLES) {
      expect(contextOf(session(role)).scopes).toEqual(roleScopes(role));
      for (const stored of subsets(API_TOKEN_SCOPES))
        expect(contextOf(token(role, stored)).scopes).toEqual(
          SCOPES.filter((scope) =>
            effectiveTokenScopes(stored, role).includes(scope),
          ),
        );
    }
    expect(contextOf(session(FORGED)).scopes).toEqual([]);
    expect(contextOf(session(FORGED)).role).toBeNull();
  });

  it("renders scopeFilter exactly as owned() for every kind, role and scope set", () => {
    for (const role of ROLES)
      for (const p of principalsOf(role))
        for (const kind of KINDS) {
          const expected = render(owned(p, kind));
          expect(render(scopeFilter(contextOf(p), kind))).toEqual(expected);
          // The record-scope slot adds nothing yet, for the unit and assigned templates too.
          for (const template of [HIRING_MANAGER_ROLE, INTERVIEWER_ROLE])
            if (template.body.membership === role)
              expect(
                render(
                  scopeFilter(contextOf(p, { role: template.body }), kind),
                ),
              ).toEqual(expected);
        }
    const withRead = render(
      scopeFilter(contextOf(token("owner", ["recruitment:read"])), "comment"),
    );
    expect(withRead.sql).toContain("parent.kind<>'candidate'");
  });
});

describe("escalation guards (architecture §11.6)", () => {
  it("accepts a body inside its membership ceiling", () => {
    expect(roleBodySchema.safeParse(body({})).success).toBe(true);
  });

  it("refuses scopes and actions outside each membership ceiling, and membership owner", () => {
    for (const membership of ["admin", "recruiter", "viewer"] as const)
      for (const scope of SCOPES.filter(
        (s) => !roleScopes(membership).includes(s),
      ))
        refused(body({ membership, scopes: [scope], actions: {} }));
    const viewer = { membership: "viewer", scopes: roleScopes("viewer") };
    for (const action of ACTIONS.filter((a) => a !== "view" && a !== "export"))
      refused(body({ ...viewer, actions: { vacancies: [action] } }));
    refused(body({ actions: { candidates: ["import"] } }));
    for (const membership of ["admin", "recruiter"] as const) {
      const ceiling = { membership, scopes: roleScopes(membership) };
      refused(body({ ...ceiling, actions: { candidates: ["erase"] } }));
      refused(body({ ...ceiling, actions: { "two-step-reset": ["admin"] } }));
      refused(body({ ...ceiling, actions: { teams: ["admin"] } }));
      refused(body({ ...ceiling, actions: { plans: ["view"] } }));
    }
    refused(body({ actions: { "storage-settings": ["admin"] } }));
    refused(body({ actions: { directory: ["create"] } }));
    refused(body({ membership: "owner", scopes: roleScopes("owner") }));
    expect(
      roleBodySchema.safeParse({ ...OWNER_ROLE.body, membership: "admin" })
        .success,
    ).toBe(false);
  });

  it("keeps an unparsed body with widened scopes inside the ceiling", () => {
    const widened = {
      ...structuredClone(RECRUITER_ROLE.body),
      scopes: [...SCOPES],
      actions: Object.fromEntries(
        ACTION_RESOURCES.map((resource) => [resource, [...ACTIONS]]),
      ),
    } as RoleBody;
    const recruiter = contextOf(session("recruiter"), { role: widened });
    expect(recruiter.scopes).toEqual(roleScopes("recruiter"));
    for (const resource of RECORD_RESOURCES)
      expect(allowed(recruiter, { resource, action: "import" })).toBe(false);
    expect(allowed(recruiter, { resource: "directory", action: "view" })).toBe(
      false,
    );
    expect(
      allowed(recruiter, { resource: "candidates", action: "erase" }),
    ).toBe(false);
    const viewer = contextOf(session("viewer"), {
      role: { ...widened, membership: "admin" },
    });
    expect(viewer.scopes).toEqual(roleScopes("viewer"));
    for (const resource of RESOURCES)
      for (const action of ACTIONS.filter(
        (a) => a !== "view" && a !== "export",
      ))
        expect(allowed(viewer, { resource, action })).toBe(false);
    // A stale member.role narrows a wider team role, as the database does.
    const stale = contextOf(session("admin"), {}, { memberRole: "viewer" });
    expect(stale.scopes).toEqual(roleScopes("viewer"));
    expect(allowed(stale, { resource: "vacancies", action: "edit" })).toBe(
      false,
    );
  });

  it("refuses bodies with company-area or plan-access keys", () => {
    for (const key of [
      "areas",
      "adminAreas",
      "companyAreas",
      "companyLevel",
      "planAccess",
      "plan_access",
    ]) {
      refused(body({ [key]: ["roles"] }));
      refused(body({ actions: { [key]: ["admin"] } }));
    }
    for (const area of ADMIN_AREAS)
      refused(body({ actions: { [area]: ["admin"] } }));
    refused(body({ actions: { plans: ["view"] } }));
    for (const membership of ["admin", "recruiter", "viewer"] as const)
      for (const action of ACTIONS)
        refused(
          body({
            membership,
            scopes: roleScopes(membership),
            actions: { plans: [action] },
          }),
        );
  });

  it("refuses every company action to team owners and admins without company authority", () => {
    for (const role of ROLES)
      for (const p of principalsOf(role)) {
        const ctx = contextOf(p, {}, { companyLevel: null, companyAreas: [] });
        for (const adminArea of ADMIN_AREAS)
          for (const action of ACTIONS)
            expect(allowed(ctx, { adminArea, action })).toBe(false);
      }
  });

  it("refuses every company action to token and OAuth contexts, even a company owner's", () => {
    for (const role of ROLES)
      for (const p of principalsOf(role).filter(
        (q) => q.authType === "token",
      )) {
        const ctx = contextOf(p, {}, { companyLevel: "owner" });
        for (const adminArea of ADMIN_AREAS)
          for (const action of ["view", "edit", "admin"] as const)
            expect(allowed(ctx, { adminArea, action })).toBe(false);
      }
  });

  it("limits a company admin to the areas held, never the owner-only areas", () => {
    for (const role of ROLES) {
      const fieldsOnly = contextOf(
        session(role),
        {},
        { companyLevel: "admin", companyAreas: ["fields"] },
      );
      for (const adminArea of ADMIN_AREAS)
        expect(allowed(fieldsOnly, { adminArea, action: "edit" })).toBe(
          adminArea === "fields",
        );
      const forged = contextOf(
        session(role),
        {},
        { companyLevel: "admin", companyAreas: [...ADMIN_AREAS] },
      );
      for (const adminArea of GRANTABLE_ADMIN_AREAS)
        expect(allowed(forged, { adminArea, action: "edit" })).toBe(true);
      for (const adminArea of OWNER_ADMIN_AREAS)
        expect(allowed(forged, { adminArea, action: "edit" })).toBe(false);
    }
  });

  // ADM-40 (job 098): Domain is company owner only and never grantable (D20).
  it("allows the domain area only to a company owner session, never to a company admin or a token", () => {
    expect(OWNER_ADMIN_AREAS).toContain("domain");
    expect(GRANTABLE_ADMIN_AREAS).not.toContain("domain");
    for (const role of ROLES) {
      for (const [level, areas, expected] of [
        ["owner", [], true],
        ["admin", [...ADMIN_AREAS], false],
        [null, [], false],
      ] as const)
        for (const action of ["view", "edit", "admin"] as const)
          expect(
            allowed(
              contextOf(
                session(role),
                {},
                { companyLevel: level, companyAreas: [...areas] },
              ),
              { adminArea: "domain", action },
            ),
            `${role} ${level} ${action}`,
          ).toBe(expected);
      for (const p of principalsOf(role).filter((q) => q.authType === "token"))
        expect(
          allowed(contextOf(p, {}, { companyLevel: "owner" }), {
            adminArea: "domain",
            action: "view",
          }),
        ).toBe(false);
    }
  });

  it("allows a company owner session every area, whatever the team role", () => {
    for (const role of ROLES) {
      const ctx = contextOf(session(role), {}, { companyLevel: "owner" });
      for (const adminArea of ADMIN_AREAS)
        expect(authorize(ctx, { adminArea, action: "edit" })).toEqual({
          scope: { recordScope: "all" },
          fields: {},
        });
      expect(
        allowed(ctx, { adminArea: "billing" as "roles", action: "edit" }),
      ).toBe(false);
    }
    const forgedRole = contextOf(
      session(FORGED),
      {},
      { companyLevel: "owner" },
    );
    expect(allowed(forgedRole, { adminArea: "fields", action: "edit" })).toBe(
      false,
    );
  });

  it("refuses a company request that also names a resource or record", () => {
    const fieldsAdmin = contextOf(
      session("owner"),
      {},
      { companyLevel: "admin", companyAreas: ["fields"] },
    );
    const companyOwner = contextOf(
      session("owner"),
      {},
      { companyLevel: "owner" },
    );
    for (const ctx of [fieldsAdmin, companyOwner]) {
      expect(allowed(ctx, { adminArea: "fields", action: "edit" })).toBe(true);
      for (const action of ACTIONS) {
        expect(
          allowed(ctx, { adminArea: "fields", resource: "candidates", action }),
        ).toBe(false);
        expect(
          allowed(ctx, {
            adminArea: "fields",
            record: { kind: "candidate", typeId: null },
            action,
          }),
        ).toBe(false);
      }
    }
  });
});

describe("private per-user state", () => {
  const names = [
    "candidateStates",
    "candidate-states",
    "candidateState",
    "savedViews",
    "saved-views",
    "views",
    "saved-view",
    "notificationReads",
    "notification-reads",
    "notifications",
    "shortlist",
  ];

  it("refuses bodies naming candidate states, private views or notification reads", () => {
    for (const name of names) {
      refused(body({ [name]: ["view"] }));
      refused(body({ actions: { [name]: ["view"] } }));
      refused(body({ fields: { [name]: { name: "read" } } }));
      refused(body({ fields: { candidate: { [name]: "hidden" } } }));
      refused(body({ pages: ["home", name] }));
      refused(
        body({
          recordScope: { ...RECRUITER_ROLE.body.recordScope, [name]: "all" },
        }),
      );
    }
  });

  it("keeps the saved-view private-owner predicate for every template and an all-action owner body", () => {
    const everything: RoleBody = {
      ...structuredClone(OWNER_ROLE.body),
      actions: Object.fromEntries(
        ACTION_RESOURCES.map((resource) => [resource, [...ACTIONS]]),
      ),
    };
    const roles: [Role, RoleBody][] = [
      ...ROLE_TEMPLATES.map(
        (template) =>
          [template.body.membership, template.body] as [Role, RoleBody],
      ),
      ["owner", everything],
    ];
    for (const [role, roleBody] of roles) {
      const ctx = contextOf(session(role), { role: roleBody });
      const filter = render(scopeFilter(ctx, "saved-view"));
      expect(filter).toEqual(render(owned(session(role), "saved-view")));
      expect(filter.sql).toContain('"private_owner_id" = $');
      expect(filter.params).toContain(USER);
    }
  });

  it("refuses forged resources for candidate states and notification reads", () => {
    const forgedBody = {
      ...structuredClone(OWNER_ROLE.body),
      actions: {
        ...OWNER_ROLE.body.actions,
        "candidate-states": [...ACTIONS],
        "notification-reads": [...ACTIONS],
      },
    } as RoleBody;
    for (const roleBody of [...ROLE_TEMPLATES.map((t) => t.body), forgedBody]) {
      const ctx = contextOf(session("owner"), { role: roleBody });
      for (const resource of ["candidate-states", "notification-reads"])
        for (const action of ACTIONS)
          expect(
            allowed(ctx, { resource: resource as ResourceName, action }),
          ).toBe(false);
    }
    expect(
      allowed(contextOf(session("owner")), {
        page: "shortlist" as "home",
        resource: "candidates",
        action: "view",
      }),
    ).toBe(false);
  });
});

describe("built-in role templates", () => {
  it("freezes every template, so no caller can widen one in place", () => {
    const frozen = (value: unknown): boolean =>
      !value ||
      typeof value !== "object" ||
      (Object.isFrozen(value) && Object.values(value).every(frozen));
    for (const template of ROLE_TEMPLATES) expect(frozen(template)).toBe(true);
    const ctx = contextOf(session("recruiter"));
    expect(() => ctx.role!.scopes.push("imports:write")).toThrow(TypeError);
    expect(() => {
      ctx.role!.actions.candidates!.push("import");
    }).toThrow(TypeError);
    expect(() => {
      (ctx.role!.actions as Record<string, string[]>).directory = ["edit"];
    }).toThrow(TypeError);
    expect(RECRUITER_ROLE.body.scopes).toEqual(roleScopes("recruiter"));
    expect(contextOf(session("recruiter")).scopes).toEqual(
      roleScopes("recruiter"),
    );
  });

  it("has six fixed keys and version ids", () => {
    expect(
      ROLE_TEMPLATES.map(({ key, versionId, version }) => [
        key,
        versionId,
        version,
      ]),
    ).toEqual([
      ["owner", "00000000-0000-4000-8000-000000000101", 1],
      ["admin", "00000000-0000-4000-8000-000000000102", 1],
      ["recruiter", "00000000-0000-4000-8000-000000000103", 1],
      ["viewer", "00000000-0000-4000-8000-000000000104", 1],
      ["hiring-manager", "00000000-0000-4000-8000-000000000105", 1],
      ["interviewer", "00000000-0000-4000-8000-000000000106", 1],
    ]);
    for (const template of ROLE_TEMPLATES)
      expect(configKey.safeParse(template.key).success).toBe(true);
    expect(new Set(ROLE_TEMPLATES.map((t) => t.versionId)).size).toBe(6);
    expect(ROLES.map((role) => builtInRoleFor(role))).toEqual([
      OWNER_ROLE,
      ADMIN_ROLE,
      RECRUITER_ROLE,
      VIEWER_ROLE,
    ]);
    // The config store takes real role bodies since R2a-10, never the envelope or the Owner template.
    expect(configBodySchemas.role).toBe(roleBodySchema);
    expect(configBodySchemas.role.safeParse({ label: "Role" }).success).toBe(
      false,
    );
    expect(configBodySchemas.role.safeParse(RECRUITER_ROLE.body).success).toBe(
      true,
    );
    expect(configBodySchemas.role.safeParse(OWNER_ROLE.body).success).toBe(
      false,
    );
  });

  it("passes the strict schema, and the Owner template only its own check", () => {
    for (const template of ROLE_TEMPLATES.slice(1)) {
      const parsed = roleBodySchema.safeParse(template.body);
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.data).toEqual(template.body);
      expect(isOwnerTemplateBody(template.body)).toBe(false);
    }
    expect(isOwnerTemplateBody(OWNER_ROLE.body)).toBe(true);
    expect(roleBodySchema.safeParse(OWNER_ROLE.body).success).toBe(false);
    expect(
      isOwnerTemplateBody({
        ...OWNER_ROLE.body,
        actions: { ...OWNER_ROLE.body.actions, plans: ["view"] },
      }),
    ).toBe(false);
  });

  it("gives the four team roles today's scopes, every page, no field rule and record scope all", () => {
    for (const role of ROLES) {
      const { body: template } = builtInRoleFor(role);
      expect(template.membership).toBe(role);
      expect(template.scopes).toEqual(roleScopes(role));
      expect(template.pages).toEqual([...PAGE_KEYS]);
      expect(template.fields).toEqual({});
      expect(template.recordScope).toEqual({
        pipeline: "all",
        candidates: "all",
        tasks: "all",
      });
      expect(template.actions.plans).toBeUndefined();
      expect(template.actions.directory).toEqual(
        role === "owner" || role === "admin"
          ? ["view", "create", "edit", "archive"]
          : undefined,
      );
    }
    expect(OWNER_ROLE.body.actions.candidates).toContain("erase");
    expect(ADMIN_ROLE.body.actions.candidates).not.toContain("erase");
    expect(ADMIN_ROLE.body.actions["storage-settings"]).toEqual(["admin"]);
    expect(ADMIN_ROLE.body.actions.teams).toBeUndefined();
    expect(RECRUITER_ROLE.body.actions.candidates).not.toContain("import");
  });

  it("defines the hiring manager", () => {
    const { body: hm } = HIRING_MANAGER_ROLE;
    expect(hm.membership).toBe("recruiter");
    expect(hm.scopes).toEqual(roleScopes("recruiter"));
    expect(hm.pages).toEqual([
      "home",
      "vacancies",
      "applications",
      "interviews",
      "approvals",
    ]);
    expect(hm.recordScope).toEqual({
      pipeline: "unit",
      candidates: "unit",
      tasks: "unit",
    });
    expect(hm.actions).toEqual({
      candidates: ["view", "comment"],
      "job-roles": ["view"],
      vacancies: ["view", "edit", "transition", "comment"],
      applications: ["view", "create", "edit", "transition", "comment"],
      interviews: ["view", "create", "edit", "comment"],
      offers: ["view", "approve"],
      comments: ["view", "create"],
    });
    for (const actions of Object.values(hm.actions))
      for (const action of ["export", "erase", "import", "admin"] as const)
        expect(actions).not.toContain(action);
    expect(hm.fields).toEqual({
      offer: { amount: "hidden-unless-approver" },
      candidate: {
        email: "read",
        phone: "read",
        explicitGender: "hidden",
        nationalServiceStatus: "hidden",
      },
    });
    const ctx = contextOf(session("recruiter"), { role: hm });
    const candidate = authorize(ctx, {
      resource: "candidates",
      action: "view",
    });
    expect(candidate.scope).toEqual({ recordScope: "unit" });
    expect(candidate.fields.email).toBe("read");
    expect(candidate.fields.explicitGender).toBe("hidden");
    expect(candidate.fields.name).toBe("read");
    const offer = authorize(ctx, { resource: "offers", action: "view" });
    expect(offer.fields.amount).toBe("hidden");
    expect(offer.fields.status).toBe("read");
    expect(
      authorize(ctx, {
        page: "vacancies",
        resource: "vacancies",
        action: "edit",
      }).fields.title,
    ).toBe("edit");
    expect(allowed(ctx, { resource: "candidates", action: "export" })).toBe(
      false,
    );
    expect(allowed(ctx, { page: "candidates", action: "view" })).toBe(false);
  });

  it("defines the interviewer", () => {
    const { body: interviewer } = INTERVIEWER_ROLE;
    expect(interviewer.membership).toBe("viewer");
    expect(interviewer.scopes).toEqual(roleScopes("viewer"));
    expect(interviewer.pages).toEqual(["home", "interviews"]);
    expect(interviewer.recordScope).toEqual({
      pipeline: "assigned",
      candidates: "assigned",
      tasks: "assigned",
    });
    expect(interviewer.actions).toEqual({
      interviews: ["view"],
      candidates: ["view"],
    });
    const visible = Object.keys(recordDataSchemas.candidate.shape).filter(
      (key) => interviewer.fields.candidate?.[key] !== "hidden",
    );
    expect(visible).toEqual(["name", "jobTitle"]);
    for (const key of SENSITIVE_CANDIDATE_FIELDS)
      expect(interviewer.fields.candidate?.[key]).toBe("hidden");
    expect(interviewer.scopes).toContain("cvs:read");
    const ctx = contextOf(session("viewer"), { role: interviewer });
    expect(
      authorize(ctx, {
        page: "interviews",
        resource: "interviews",
        action: "view",
      }).scope,
    ).toEqual({ recordScope: "assigned" });
    expect(allowed(ctx, { resource: "vacancies", action: "view" })).toBe(false);
  });

  it("answers field rules from the request's kind", () => {
    const owner = contextOf(session("owner"));
    expect(
      Object.values(
        authorize(owner, { resource: "vacancies", action: "view" }).fields,
      ),
    ).toEqual(Object.keys(recordDataSchemas.vacancy.shape).map(() => "edit"));
    const viewer = contextOf(session("viewer"));
    expect(
      new Set(
        Object.values(
          authorize(viewer, {
            resource: "tasks",
            action: "view",
            record: { kind: "task", typeId: null },
          }).fields,
        ),
      ),
    ).toEqual(new Set(["read"]));
    expect(authorize(owner, { resource: "directory", action: "view" })).toEqual(
      { scope: { recordScope: "all" }, fields: {} },
    );
  });
});

describe("redact", () => {
  const row = <K extends RecordKind>(
    kind: K,
    data: Record<string, unknown>,
  ): RecordDto<K> => ({
    id: "50000000-0000-4000-8000-000000000005",
    kind,
    data: recordDataSchemas[kind].parse(data) as RecordDto<K>["data"],
    version: 1,
    legacyId: null,
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-01T08:00:00.000Z",
    archivedAt: null,
    createdBy: USER,
    privateOwnerId: null,
    candidateId: null,
    vacancyId: null,
    applicationId: null,
    onboardingId: null,
    bucketId: null,
    jobRoleId: null,
    parentRecordId: null,
  });
  const CUSTOM_HIDDEN = "60000000-0000-4000-8000-000000000006";
  const CUSTOM_VISIBLE = "70000000-0000-4000-8000-000000000007";
  const candidate = row("candidate", {
    name: "Fictional Candidate",
    email: "fictional.candidate@example.test",
    phone: "+971 50 000 0000",
    jobTitle: "Fictional Analyst",
    explicitGender: "Fictional",
    nationalServiceStatus: "Fictional",
  });
  const offer = row("offer", { title: "Fictional offer", amount: "12000" });
  const task = row("task", {
    title: "Fictional task",
    customValues: { [CUSTOM_HIDDEN]: "secret", [CUSTOM_VISIBLE]: 3 },
  });
  const rows = [candidate, offer, task, row("vacancy", { title: "Fictional" })];

  it("returns deep-equal rows for the four team roles", () => {
    for (const role of ROLES)
      for (const input of rows) {
        const output = redact(contextOf(session(role)), input);
        expect(output).toEqual(input);
        expect(output).not.toBe(input);
        expect(Object.hasOwn(output, "readOnlyFields")).toBe(false);
      }
  });

  it("hides fields and marks read-only ones for the hiring manager", () => {
    const ctx = contextOf(session("recruiter"), {
      role: HIRING_MANAGER_ROLE.body,
    });
    const output = redact(ctx, candidate);
    for (const key of SENSITIVE_CANDIDATE_FIELDS)
      expect(Object.hasOwn(output.data, key)).toBe(false);
    expect(output.data.email).toBe(candidate.data.email);
    expect(output.readOnlyFields).toEqual(["email", "phone"]);
    const offerOutput = redact(ctx, offer);
    expect(Object.hasOwn(offerOutput.data, "amount")).toBe(false);
    expect(offerOutput.data.title).toBe("Fictional offer");
    expect(Object.hasOwn(offerOutput, "readOnlyFields")).toBe(false);
  });

  it("keeps only the name and job title for the interviewer", () => {
    const ctx = contextOf(session("viewer"), { role: INTERVIEWER_ROLE.body });
    expect(redact(ctx, candidate).data).toEqual({
      name: "Fictional Candidate",
      jobTitle: "Fictional Analyst",
    });
  });

  it("removes a hidden custom value", () => {
    const ctx = contextOf(session("recruiter"), {
      role: body({
        fields: { task: { [CUSTOM_HIDDEN]: "hidden" } },
      }) as RoleBody,
    });
    expect(redact(ctx, task).data.customValues).toEqual({
      [CUSTOM_VISIBLE]: 3,
    });
  });

  it("removes the sensitive fields from MCP results, even for the owner", () => {
    const output = redact(
      contextOf(session("owner"), { channel: "mcp" }),
      candidate,
    );
    for (const key of SENSITIVE_CANDIDATE_FIELDS)
      expect(Object.hasOwn(output.data, key)).toBe(false);
    expect(output.data.name).toBe("Fictional Candidate");
  });

  it("does not mutate its input or the context", () => {
    const ctx = contextOf(session("recruiter"), {
      role: HIRING_MANAGER_ROLE.body,
      channel: "mcp",
    });
    const before = structuredClone({ ctx, rows });
    for (const input of rows) redact(ctx, input);
    authorize(ctx, { resource: "applications", action: "view" });
    scopeFilter(ctx, "comment");
    expect({ ctx, rows }).toEqual(before);
    expect(HIRING_MANAGER_ROLE.body.fields.candidate?.email).toBe("read");
  });

  // Job 048 follow-up b (R2a-10): field rules reach the top-level keys and the source fields.
  it("removes hidden top-level keys and candidate source fields, and lists read ones", () => {
    const imported = {
      ...candidate,
      data: recordDataSchemas.candidate.parse({
        ...candidate.data,
        rawSource: { folder: "Fictional folder" },
        evidence: [{ quote: "Fictional evidence" }],
        sourceReviews: [{ note: "Fictional review" }],
      }) as RecordDto<"candidate">["data"],
      legacyId: "fictional-legacy-1",
      importMeta: { batch: "fictional-batch" },
      label: "Fictional Candidate",
    };
    const application = {
      ...row("application", { stage: "Sourced" }),
      legacyId: "fictional-legacy-2",
      candidateLabel: "Fictional Candidate",
      vacancyLabel: "Fictional vacancy",
    };
    const keys = (value: object) => Object.keys(value).sort();
    for (const key of [
      "importMeta",
      "legacyId",
      "label",
      "rawSource",
      "evidence",
      "sourceReviews",
    ]) {
      const role = body({ fields: { candidate: { [key]: "hidden" } } });
      expect(roleBodySchema.safeParse(role).success, key).toBe(true);
      const ctx = contextOf(session("recruiter"), { role: role as RoleBody });
      const output = redact(ctx, imported);
      expect(
        Object.hasOwn(output, key) || Object.hasOwn(output.data, key),
        key,
      ).toBe(false);
      expect([...keys(output), ...keys(output.data)].sort(), key).toEqual(
        [...keys(imported), ...keys(imported.data)]
          .filter((name) => name !== key)
          .sort(),
      );
      const read = redact(
        contextOf(session("recruiter"), {
          role: body({ fields: { candidate: { [key]: "read" } } }) as RoleBody,
        }),
        imported,
      );
      expect(read.readOnlyFields, key).toEqual([key]);
      expect({ ...read, readOnlyFields: undefined }, key).toEqual({
        ...imported,
        readOnlyFields: undefined,
      });
    }
    for (const key of ["candidateLabel", "vacancyLabel"]) {
      const role = body({ fields: { application: { [key]: "hidden" } } });
      expect(roleBodySchema.safeParse(role).success, key).toBe(true);
      const output = redact(
        contextOf(session("recruiter"), { role: role as RoleBody }),
        application,
      );
      expect(Object.hasOwn(output, key), key).toBe(false);
      expect(keys(output), key).toEqual(
        keys(application).filter((name) => name !== key),
      );
      expect(
        redact(
          contextOf(session("recruiter"), {
            role: body({
              fields: { application: { [key]: "read" } },
            }) as RoleBody,
          }),
          application,
        ).readOnlyFields,
        key,
      ).toEqual([key]);
    }
    // A read rule for a key the row does not carry lists nothing.
    expect(
      redact(
        contextOf(session("recruiter"), {
          role: body({
            fields: { candidate: { importMeta: "read" } },
          }) as RoleBody,
        }),
        candidate,
      ).readOnlyFields,
    ).toEqual([]);
    // The built-in templates keep every key.
    for (const role of ROLES)
      expect(redact(contextOf(session(role)), imported)).toEqual(imported);
    refused(body({ fields: { candidate: { unknownTopLevel: "hidden" } } }));
  });
});

describe("the role the access state names (R2a-10)", () => {
  const VERSION = "80000000-0000-4000-8000-000000000008";
  const OBJECT = "90000000-0000-4000-8000-000000000009";
  const documents = (value: unknown, type = "role") =>
    ({
      [VERSION]: {
        versionId: VERSION,
        objectId: OBJECT,
        type,
        key: "fictional-role",
        number: 1,
        bodySha256: "0".repeat(64),
        body: value,
      },
    }) as NonNullable<AccessContext["access"]["documents"]>;
  const narrowed = body({
    name: "Fictional narrowed recruiter",
    scopes: ["candidates:read", "recruitment:read"],
  });

  it("gives the built-in template for its fixed id and the parsed body of an assigned version", () => {
    for (const role of ROLES) {
      const { versionId, body: template } = builtInRoleFor(role);
      const ctx = contextOf(session(role), {}, { roleVersionId: versionId });
      expect(ctx.role, role).toBe(template);
      expect(ctx.scopes, role).toEqual(roleScopes(role));
    }
    const ctx = contextOf(
      session("recruiter"),
      {},
      { roleVersionId: VERSION, documents: documents(narrowed) },
    );
    expect(ctx.role).toEqual(narrowed);
    expect(ctx.scopes).toEqual(["candidates:read", "recruitment:read"]);
    expect(
      authorize(ctx, { resource: "candidates", action: "view" }),
    ).toMatchObject({ scope: { recordScope: "all" } });
    expect(() =>
      authorize(ctx, { resource: "candidates", action: "edit" }),
    ).toThrow(ApiError);
  });

  it("gives no role for a null, unknown or unusable version, so every request is refused", () => {
    const cases: [string | null, AccessContext["access"]["documents"]][] = [
      [null, documents(narrowed)],
      ["a0000000-0000-4000-8000-00000000000a", documents(narrowed)],
      [VERSION, documents({ ...narrowed, scopes: ["imports:write"] })],
      [VERSION, documents({ ...narrowed, membership: "owner" })],
      [VERSION, documents({ label: "Fictional envelope" })],
      [VERSION, documents(narrowed, "workflow")],
      [VERSION, {}],
      [HIRING_MANAGER_ROLE.versionId, {}],
      [builtInRoleFor("admin").versionId, {}],
    ];
    for (const [roleVersionId, held] of cases) {
      const label = `${roleVersionId} ${JSON.stringify(held).slice(0, 80)}`;
      const ctx = contextOf(
        session("recruiter"),
        {},
        { roleVersionId, documents: held },
      );
      expect(ctx.role, label).toBeNull();
      expect(ctx.scopes, label).toEqual([]);
      expect(
        () => authorize(ctx, { resource: "candidates", action: "view" }),
        label,
      ).toThrow(ApiError);
      expect(() => redact(ctx, {} as RecordDto), label).toThrow(ApiError);
    }
  });
});

// Insights, search, notifications and exports leave out what redact leaves out (R2a-08).
describe("outputs on the engine (R2a-08)", () => {
  const CUSTOM = "a1000000-0000-4000-8000-0000000000a1";
  const withRules = body({
    name: "Fictional redacted recruiter",
    fields: {
      candidate: {
        email: "hidden",
        residenceEmirate: "hidden-unless-approver",
        phone: "read",
      },
      task: { title: "hidden", [CUSTOM]: "hidden" },
      application: { stage: "hidden", candidateLabel: "hidden" },
    },
  }) as RoleBody;
  const contexts = (): AccessContext[] => [
    ...ROLES.map((role) => contextOf(session(role))),
    ...ROLES.map((role) => contextOf(session(role), { channel: "mcp" })),
    contextOf(session("recruiter"), { role: withRules }),
    contextOf(session("recruiter"), { role: withRules, channel: "mcp" }),
    contextOf(session("recruiter"), { role: HIRING_MANAGER_ROLE.body }),
    contextOf(token("recruiter", ["recruitment:read"])),
  ];
  const record = (kind: RecordKind, data: Record<string, unknown>) =>
    ({
      id: "b1000000-0000-4000-8000-0000000000b1",
      kind,
      data,
      version: 1,
      legacyId: "fictional-legacy",
      createdAt: "2026-11-01T08:00:00.000Z",
      updatedAt: "2026-11-02T08:00:00.000Z",
      archivedAt: null,
      createdBy: USER,
      privateOwnerId: null,
      candidateId: null,
      vacancyId: null,
      applicationId: null,
      onboardingId: null,
      bucketId: null,
      jobRoleId: null,
      parentRecordId: null,
      label: "Fictional label",
      candidateLabel: "Fictional Candidate",
    }) as RecordDto;
  /** Every schema key of the kind with a fictional value, plus a custom value for tasks. */
  const full = (kind: RecordKind) =>
    record(kind, {
      ...Object.fromEntries(
        Object.keys(recordDataSchemas[kind].shape).map((key) => [
          key,
          `Fictional ${key}`,
        ]),
      ),
      customValues: { [CUSTOM]: "Fictional secret", other: 1 },
    });

  it("hides nothing for the four team roles and only the sensitive candidate fields over MCP", () => {
    for (const role of ROLES)
      for (const kind of KINDS) {
        expect(hiddenKeys(contextOf(session(role)), kind), kind).toEqual(
          new Set(),
        );
        expect(
          hiddenKeys(contextOf(session(role), { channel: "mcp" }), kind),
          kind,
        ).toEqual(
          kind === "candidate"
            ? new Set(SENSITIVE_CANDIDATE_FIELDS)
            : new Set(),
        );
      }
  });

  it("returns the hidden and hidden-unless-approver keys of a role body", () => {
    expect(roleBodySchema.safeParse(withRules).success).toBe(true);
    const ctx = contextOf(session("recruiter"), { role: withRules });
    expect(hiddenKeys(ctx, "candidate")).toEqual(
      new Set(["email", "residenceEmirate", "customValues"]),
    );
    expect(hiddenKeys(ctx, "task")).toEqual(new Set(["title", CUSTOM]));
    expect(hiddenKeys(ctx, "application")).toEqual(
      new Set(["stage", "candidateLabel", "customValues"]),
    );
    expect(hiddenKeys(ctx, "vacancy")).toEqual(new Set());
    expect(
      hiddenKeys(
        contextOf(session("recruiter"), { role: withRules, channel: "mcp" }),
        "candidate",
      ),
    ).toEqual(
      new Set([
        "email",
        "residenceEmirate",
        "customValues",
        ...SENSITIVE_CANDIDATE_FIELDS,
      ]),
    );
    expect(() => hiddenKeys(contextOf(session(FORGED)), "candidate")).toThrow(
      ApiError,
    );
  });

  it("hides a non-task customValues for a role that hides any field of the kind and names no rule for it (R2b-02)", () => {
    // The interviewer template as published before customValues existed: no rule for the key.
    const { customValues: _added, ...candidate } =
      INTERVIEWER_ROLE.body.fields.candidate ?? {};
    const earlier = {
      ...structuredClone(INTERVIEWER_ROLE.body),
      fields: { candidate },
    } as RoleBody;
    expect(roleBodySchema.safeParse(earlier).success).toBe(true);
    const ctx = contextOf(session("viewer"), { role: earlier });
    expect(hiddenKeys(ctx, "candidate").has("customValues")).toBe(true);
    const stored = record("candidate", {
      name: "Fictional Interviewed Person",
      jobTitle: "Fictional analyst",
      email: "interviewed@example.test",
      customValues: { [CUSTOM]: "Fictional secret" },
    });
    expect(redact(ctx, stored).data).toEqual({
      name: "Fictional Interviewed Person",
      jobTitle: "Fictional analyst",
    });
    expect(
      authorize(ctx, { resource: "candidates", action: "view" }).fields
        .customValues,
    ).toBe("hidden");
    // Kinds with no hidden rule, and an explicit rule for the key, keep the values visible.
    expect(hiddenKeys(ctx, "vacancy").has("customValues")).toBe(false);
    const explicit = contextOf(session("viewer"), {
      role: {
        ...earlier,
        fields: { candidate: { ...candidate, customValues: "read" } },
      } as RoleBody,
    });
    expect(hiddenKeys(explicit, "candidate").has("customValues")).toBe(false);
    expect(redact(explicit, stored).data).toMatchObject({
      customValues: { [CUSTOM]: "Fictional secret" },
    });
    expect(
      authorize(explicit, { resource: "candidates", action: "view" }).fields
        .customValues,
    ).toBe("read");
    // Tasks keep their per-field rules: a hidden title hides no other custom value.
    expect(
      hiddenKeys(contextOf(session("recruiter"), { role: withRules }), "task"),
    ).toEqual(new Set(["title", CUSTOM]));
  });

  it("agrees with redact on data, custom values and top-level keys", () => {
    for (const ctx of contexts())
      for (const kind of KINDS) {
        const input = full(kind);
        const hidden = hiddenKeys(ctx, kind);
        const output = redact(ctx, input);
        const label = `${ctx.role?.name} ${ctx.channel} ${kind}`;
        for (const key of Object.keys(input.data))
          expect(Object.hasOwn(output.data, key), `${label} ${key}`).toBe(
            !hidden.has(key),
          );
        expect(
          Object.hasOwn(
            (output.data as { customValues?: object }).customValues ?? {},
            CUSTOM,
          ),
          label,
        ).toBe(!hidden.has(CUSTOM) && !hidden.has("customValues"));
        for (const key of ["legacyId", "label", "candidateLabel"])
          expect(Object.hasOwn(output, key), `${label} ${key}`).toBe(
            !hidden.has(key),
          );
      }
  });

  it("decides as authorize does, with null for a refusal", () => {
    for (const ctx of [
      ...contexts(),
      contextOf(session(FORGED)),
      contextOf(session("viewer"), { role: INTERVIEWER_ROLE.body }),
    ])
      for (const resource of ACTION_RESOURCES)
        for (const action of ACTIONS)
          for (const page of [undefined, "home", "candidates"] as const) {
            const request: AccessRequest = { page, resource, action };
            let expected: unknown = null;
            try {
              expected = authorize(ctx, request);
            } catch (error) {
              expect(error).toBeInstanceOf(ApiError);
              expect((error as ApiError).status).toBe(403);
            }
            expect(
              decide(ctx, request),
              `${ctx.role?.name} ${resource} ${action} ${page}`,
            ).toEqual(expected);
          }
  });

  // A task's assignees are a field but never a column (R2a-20), so task export headers stay as
  // they were.
  const exportFields = (resource: ResourceName) =>
    RESOURCE_CONFIG[resource].fields.filter(
      (field) => field.key !== "assigneeIds",
    );
  // A frozen copy of exportTable() before R2a-08 limited its columns.
  function todayTable(resource: ResourceName, rows: RecordDto[]) {
    const fields = exportFields(resource);
    return {
      headers: [
        "Record ID",
        ...fields.map((field) => field.label),
        "Created at",
        "Updated at",
      ],
      rows: rows.map((row) => [
        row.id,
        ...fields.map(
          (field) => (row.data as Record<string, unknown>)[field.key],
        ),
        row.createdAt,
        row.updatedAt,
      ]),
    };
  }

  it("keeps today's export table without hidden keys and leaves out exactly the hidden columns", () => {
    for (const resource of EXPORT_RESOURCES) {
      const rows = [full(resourceToKind[resource])];
      const today = todayTable(resource, rows);
      expect(exportTable(resource, rows), resource).toEqual(today);
      expect(exportTable(resource, rows, new Set()), resource).toEqual(today);
      const fields = exportFields(resource);
      const hidden = new Set(
        [fields[0], fields[fields.length - 1]].map((field) => field.key),
      );
      const kept = (_: unknown, index: number) =>
        index === 0 ||
        index > fields.length ||
        !hidden.has(fields[index - 1].key);
      const table = exportTable(resource, rows, hidden);
      expect(table.headers, resource).toEqual(today.headers.filter(kept));
      expect(table.rows, resource).toEqual(
        today.rows.map((row) => row.filter(kept)),
      );
      expect(hidden.size, resource).toBe(2);
      expect(table.headers.length, resource).toBe(today.headers.length - 2);
    }
    expect(exportTable("tasks", [full("task")]).headers).toEqual([
      "Record ID",
      "Title",
      "Context",
      "Owner",
      "Due Date",
      "Priority",
      "Description",
      "Custom task values",
      "Created at",
      "Updated at",
    ]);
  });
});

// The MCP dispatcher decides each tool and per-input check on the engine (R2a-09).
describe("MCP tools on the engine (R2a-09)", () => {
  const tool = (name: string) => TOOLS.find((item) => item.name === name)!;
  /** Every built-in team role with each MCP scope subset as an API token, over MCP. */
  const tokenContexts = () =>
    ROLES.flatMap((role) =>
      subsets(MCP_SCOPES).map((stored) => {
        const p = token(role, stored);
        return { p, ctx: contextOf(p, { channel: "mcp" }) };
      }),
    );
  // The tools each per-input check runs in; it is reached only once the tool is allowed.
  const CHECKED: Record<keyof typeof INPUT_CHECKS, string[]> = {
    archiveCandidate: ["archive_record", "restore_record"],
    vacancyCvTexts: ["get_cv_texts"],
    newCandidateUpload: ["upload_cv"],
    taskCustomValues: ["update_task"],
    candidateComment: ["add_comment"],
  };

  it("has 59 tools, each with its scopes and an access declaration", () => {
    expect(TOOLS).toHaveLength(59);
    expect(new Set(TOOLS.map((item) => item.name)).size).toBe(59);
    for (const definition of TOOLS) {
      expect(definition.scopes.length, definition.name).toBeGreaterThan(0);
      expect(Array.isArray(definition.access), definition.name).toBe(true);
    }
  });

  it("decides every tool as today's scope check for the four team roles and every MCP scope subset", () => {
    let cases = 0;
    for (const { p, ctx } of tokenContexts())
      for (const definition of TOOLS) {
        const expected = definition.scopes.every((scope) =>
          p.scopes.includes(scope),
        );
        if (toolAllowed(ctx, definition) !== expected)
          expect({ p, tool: definition.name }).toEqual({
            p,
            tool: `${definition.name} ${expected}`,
          });
        cases++;
      }
    expect(cases).toBe(ROLES.length * 64 * 59);
  });

  it("decides the five per-input checks as today's requireScope wherever the tool runs", () => {
    let cases = 0;
    for (const { p, ctx } of tokenContexts())
      for (const [key, check] of Object.entries(INPUT_CHECKS)) {
        for (const name of CHECKED[key as keyof typeof INPUT_CHECKS]) {
          if (!toolAllowed(ctx, tool(name))) continue;
          // Without candidates:read a candidate parent reads as missing before the check.
          if (
            key === "candidateComment" &&
            !p.scopes.includes("candidates:read")
          )
            continue;
          expect(inputAllowed(ctx, check), `${p.role} ${p.scopes} ${key}`).toBe(
            p.scopes.includes(check.scope),
          );
          cases++;
        }
      }
    expect(cases).toBeGreaterThan(0);
  });

  it("names only record resources and no company area or directory, plan or admin page", () => {
    const requests: AccessRequest[] = [
      ...TOOLS.flatMap((definition) => definition.access.flat()),
      ...Object.values(INPUT_CHECKS).flatMap(
        (check): AccessRequest[] => check.requests,
      ),
    ];
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(Object.keys(resourceToKind)).toContain(request.resource);
      expect(request.adminArea).toBeUndefined();
      expect(["directory", "plan", "admin"]).not.toContain(request.page);
    }
  });

  it("follows a configured role's actions and pages", () => {
    const vacancyViewer = contextOf(session("recruiter"), {
      channel: "mcp",
      role: body({
        actions: {
          ...structuredClone(RECRUITER_ROLE.body.actions),
          vacancies: ["view", "export"],
        },
      }) as RoleBody,
    });
    expect(toolAllowed(vacancyViewer, tool("list_vacancies"))).toBe(true);
    expect(toolAllowed(vacancyViewer, tool("create_vacancy"))).toBe(false);
    expect(toolAllowed(vacancyViewer, tool("update_vacancy"))).toBe(false);
    // Archive and restore need edit on every pipeline resource they take.
    expect(toolAllowed(vacancyViewer, tool("archive_record"))).toBe(false);
    const noActivity = contextOf(session("recruiter"), {
      channel: "mcp",
      role: body({
        pages: RECRUITER_ROLE.body.pages.filter((page) => page !== "activity"),
      }) as RoleBody,
    });
    expect(toolAllowed(noActivity, tool("list_activity"))).toBe(false);
    expect(toolAllowed(noActivity, tool("get_overview"))).toBe(true);
    expect(
      toolAllowed(contextOf(session("recruiter")), tool("list_activity")),
    ).toBe(true);
  });
});

describe("performance", () => {
  it("decides in well under a millisecond", () => {
    const ctx = contextOf(session("recruiter"), {
      role: HIRING_MANAGER_ROLE.body,
    });
    const request: AccessRequest = {
      page: "applications",
      resource: "applications",
      action: "view",
    };
    for (let i = 0; i < 1000; i++) authorize(ctx, request);
    const start = performance.now();
    for (let i = 0; i < 10000; i++) authorize(ctx, request);
    expect((performance.now() - start) / 10000).toBeLessThan(0.1);
  });
});

it("lists every record resource except private saved views", () => {
  expect([...RECORD_RESOURCES].sort()).toEqual(
    (Object.keys(resourceToKind) as string[])
      .filter((resource) => resource !== "views")
      .sort(),
  );
  expect(ACTION_RESOURCES).not.toContain("views");
  expect(PAGE_KEYS).not.toContain("shortlist" as never);
  expect(PAGE_KEYS).not.toContain("notifications" as never);
});

// R2a-12 (job 056): editing, publishing, assigning and granting are company-owner only, through
// the API. Fictional people and teams only.
describe("escalation through the Roles & permissions routes", () => {
  const ORIGIN = "http://localhost:3000";
  const COMPANY = "00000000-0000-4000-a000-000000000001";
  let harness: Awaited<ReturnType<typeof createSplitRoleDb>>;
  let owner: Principal, memberA: Principal;
  let companyAdmin: Principal, teamOwnerB: Principal, memberB: Principal;
  let draft: { objectId: string; versionId: string };

  /** Every row an escalation could write: roles, assignments, authority and audit rows. */
  const stored = async () => {
    await harness.asSuperuser();
    const read = async (text: string) =>
      (await harness.client.query(text)).rows;
    return [
      await read(
        "SELECT id, key, current_version_id, draft_version_id, archived_at FROM app.config_objects ORDER BY id",
      ),
      await read(
        "SELECT id, state, body, number FROM app.config_versions ORDER BY id",
      ),
      await read("SELECT * FROM app.member_roles ORDER BY team_id, user_id"),
      await read(
        "SELECT user_id, level, areas, plan_access, suspended_at FROM app.workspace_admins ORDER BY user_id",
      ),
      await read("SELECT id FROM app.activity ORDER BY id"),
      await read("SELECT id, role FROM auth.member ORDER BY id"),
    ];
  };
  async function call(
    handler: (request: Request, context: never) => Promise<Response>,
    p: Principal,
    method: string,
    path: string,
    body?: unknown,
    params: Record<string, string> = {},
  ) {
    vi.mocked(getVerifiedSession).mockResolvedValue({
      user: { id: p.userId, twoFactorEnabled: true },
      session: { activeOrganizationId: p.teamId, createdAt: new Date() },
    } as never);
    const response = await handler(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          origin: ORIGIN,
          "x-team-id": p.teamId,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve(params) } as never,
    );
    return {
      status: response.status,
      code: ((await response.json()) as { error?: { code: string } }).error
        ?.code,
    };
  }

  beforeAll(async () => {
    harness = await createSplitRoleDb();
    pools.data.mockImplementation(harness.dataDb);
    pools.identity.mockImplementation(harness.identityDb);
    const db: AppDb = await harness.asOwner();
    // The first seeded user is the initial administrator; their first team makes them company owner.
    owner = await seedIdentity(db, {
      userId: "esc-owner",
      teamId: "esc-team-a",
    });
    memberA = await seedIdentity(db, {
      userId: "esc-member-a",
      teamId: "esc-team-a",
      role: "viewer",
    });
    // A company admin holding every grantable area, and team A admin.
    companyAdmin = await seedIdentity(db, {
      userId: "esc-company-admin",
      teamId: "esc-team-a",
      role: "admin",
    });
    await harness.client.exec(
      `INSERT INTO app.workspace_admins(workspace_id,user_id,level,areas,plan_access) VALUES ('${COMPANY}','esc-company-admin','admin','{fields,workflows,boards,organisation,templates}',true)`,
    );
    // A team created later: its owner holds no company authority.
    teamOwnerB = await seedIdentity(db, {
      userId: "esc-owner-b",
      teamId: "esc-team-b",
    });
    memberB = await seedIdentity(db, {
      userId: "esc-member-b",
      teamId: "esc-team-b",
      role: "viewer",
    });
    await harness.dataDb();
    draft = await createConfigDraft(owner, {
      type: "role",
      key: "esc-role",
      body: { ...structuredClone(VIEWER_ROLE.body), name: "Fictional role" },
    });
  });
  afterAll(async () => harness?.close());

  it("refuses a company admin and a team-B owner listing, creating, editing, publishing, assigning or granting, storing nothing", async () => {
    const viewer = structuredClone({
      ...(VIEWER_ROLE.body as RoleBody),
      name: "Fictional escalation",
    });
    const before = await stored();
    for (const [p, target] of [
      [companyAdmin, memberA],
      [teamOwnerB, memberB],
    ] as const) {
      const cases: [
        () => Promise<{ status: number; code?: string }>,
        string,
        string,
      ][] = [
        [
          () => call(rolesRoute.GET, p, "GET", "/api/v1/roles"),
          "config_forbidden",
          "list roles",
        ],
        [
          () =>
            call(rolesRoute.POST, p, "POST", "/api/v1/roles", {
              key: "esc-new",
              body: viewer,
            }),
          "config_forbidden",
          "create a role",
        ],
        [
          () =>
            call(
              roleRoute.PUT,
              p,
              "PUT",
              `/api/v1/roles/${draft.versionId}`,
              { body: viewer },
              { id: draft.versionId },
            ),
          "config_forbidden",
          "edit a role",
        ],
        [
          () =>
            call(
              publishRoute.POST,
              p,
              "POST",
              `/api/v1/roles/${draft.versionId}/publish`,
              undefined,
              { id: draft.versionId },
            ),
          "config_forbidden",
          "publish a role",
        ],
        [
          () =>
            call(memberRolesRoute.GET, p, "GET", "/api/v1/teams/member-roles"),
          "role_assignment_forbidden",
          "list member roles",
        ],
        [
          () =>
            call(
              memberRolesRoute.POST,
              p,
              "POST",
              "/api/v1/teams/member-roles",
              {
                userId: target.userId,
                roleObjectId: draft.objectId,
              },
            ),
          "role_assignment_forbidden",
          "assign a role",
        ],
        [
          () =>
            call(
              memberRolesRoute.POST,
              p,
              "POST",
              "/api/v1/teams/member-roles",
              {
                userId: target.userId,
                roleObjectId: null,
              },
            ),
          "role_assignment_forbidden",
          "clear a role",
        ],
        [
          () => call(authorityRoute.GET, p, "GET", "/api/v1/company-authority"),
          "authority_forbidden",
          "list company authority",
        ],
        [
          () =>
            call(authorityRoute.POST, p, "POST", "/api/v1/company-authority", {
              userId: p.userId,
              level: "owner",
              areas: [],
              planAccess: true,
            }),
          "authority_forbidden",
          "grant themselves company owner",
        ],
        [
          () =>
            call(authorityRoute.POST, p, "POST", "/api/v1/company-authority", {
              userId: owner.userId,
              level: null,
            }),
          "authority_forbidden",
          "remove the company owner",
        ],
      ];
      for (const [request, code, label] of cases)
        expect(await request(), `${p.userId}: ${label}`).toEqual({
          status: 403,
          code,
        });
    }
    expect(await stored()).toEqual(before);
  });
});
