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
import { effectiveTokenScopes } from "@/lib/api-token-policy";
import {
  accessContext,
  authorize,
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
import { eq, sql } from "drizzle-orm";
import { records } from "@/db/schema";

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
    // The config store keeps the minimal role envelope until R2a-10.
    expect(configBodySchemas.role.safeParse({ label: "Role" }).success).toBe(
      true,
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
