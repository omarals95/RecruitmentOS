import { eq, sql, type SQL } from "drizzle-orm";
import { records } from "@/db/schema";
import { ApiError } from "@/lib/errors";
import { SCOPES, roleScopes, type Role, type Scope } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import type { TenantAccess } from "@/lib/tenant-context";
import {
  ACTION_RESOURCES,
  ACTIONS,
  ADMIN_AREAS,
  GRANTABLE_ADMIN_AREAS,
  PAGE_KEYS,
  READ_ACTIONS,
  RECORD_RESOURCES,
  TEAM_ADMIN_RESOURCES,
  TOP_LEVEL_FIELD_KEYS,
  roleBodySchema,
  type Action,
  type ActionResource,
  type AdminArea,
  type PageKey,
  type RecordScope,
  type RoleBody,
} from "@/domain/config";
import { builtInRoleFor } from "@/domain/config-defaults";
import {
  SENSITIVE_CANDIDATE_FIELDS,
  recordDataSchemas,
  resourceToKind,
  type RecordDto,
  type RecordKind,
  type ResourceName,
} from "@/domain/records";

/**
 * The Principal, the access state tenant_context.install returned for this transaction and the
 * caller's role body. scopes is the intersection of every layer, computed once by accessContext().
 * An access state built without roleVersionId (never one install returned) keeps the built-in
 * template of principal.role.
 */
export type AccessContext = {
  principal: Principal;
  access: Pick<
    TenantAccess,
    | "scopes"
    | "workspaceId"
    | "memberRole"
    | "companyLevel"
    | "companyAreas"
    | "versions"
  > &
    Partial<Pick<TenantAccess, "roleVersionId" | "documents">>;
  /**
   * Null for a team role outside the four known roles, or an assigned role install or the strict
   * schema could not use: every request is then refused.
   */
  role: RoleBody | null;
  scopes: Scope[];
  channel?: "mcp";
};
export type AccessRequest = {
  page?: PageKey;
  resource?: ResourceName | ActionResource;
  action: Action;
  record?: { kind: RecordKind; typeId: string | null; status?: string };
  adminArea?: AdminArea;
};
export type AccessDecision = {
  scope: { recordScope: RecordScope };
  fields: Record<string, "hidden" | "read" | "edit">;
};

const knownRoles: readonly string[] = ["owner", "admin", "recruiter", "viewer"];
const known = (role: string): role is Role => knownRoles.includes(role);
const forbidden = () =>
  new ApiError(403, "forbidden", "You do not have permission for this action.");
// The records service's import refusal, in the words it has always used.
const importForbidden = () =>
  new ApiError(
    403,
    "import_forbidden",
    "Legacy source fields require an owner or admin import token.",
  );
const RECORD_KIND_GROUPS: Partial<
  Record<RecordKind, keyof RoleBody["recordScope"]>
> = {
  vacancy: "pipeline",
  application: "pipeline",
  interview: "pipeline",
  offer: "pipeline",
  onboarding: "pipeline",
  checklist: "pipeline",
  candidate: "candidates",
  task: "tasks",
};

/**
 * The role the access state names, with no statement: the built-in template of member.role for its
 * fixed version id, else the verified document of that version parsed with the strict role schema.
 * A null or unknown id, or a body the schema refuses, is no role.
 */
function assignedRole(
  principal: Principal,
  access: AccessContext["access"],
): RoleBody | null {
  const { roleVersionId, documents = {} } = access;
  if (roleVersionId === undefined)
    return known(principal.role) ? builtInRoleFor(principal.role).body : null;
  if (roleVersionId === null || !known(access.memberRole)) return null;
  const template = builtInRoleFor(access.memberRole);
  if (roleVersionId === template.versionId) return template.body;
  const document = Object.hasOwn(documents, roleVersionId)
    ? documents[roleVersionId]
    : undefined;
  if (document?.type !== "role") return null;
  const parsed = roleBodySchema.safeParse(document.body);
  return parsed.success ? parsed.data : null;
}

/**
 * The context for one transaction. Effective scopes are the intersection of the team role, the
 * stored membership, the role body's membership and scopes, the principal's scopes (a token's
 * stored scopes as effectiveTokenScopes() intersected them) and the scopes install verified.
 * Connection limits (architecture §8) are a later layer.
 */
export function accessContext(
  principal: Principal,
  access: AccessContext["access"],
  options: { role?: RoleBody; channel?: "mcp" } = {},
): AccessContext {
  const role = options.role ?? assignedRole(principal, access);
  const scopes =
    role &&
    known(principal.role) &&
    known(access.memberRole) &&
    known(role.membership)
      ? SCOPES.filter((scope) =>
          [
            roleScopes(principal.role),
            roleScopes(access.memberRole),
            roleScopes(role.membership),
            role.scopes,
            principal.scopes,
            access.scopes,
          ].every((layer) => layer.includes(scope)),
        )
      : [];
  return {
    principal,
    access,
    role,
    scopes,
    ...(options.channel ? { channel: options.channel } : {}),
  };
}

/** Company authority from the access state and a session; a team role never supplies it. */
function companyAllows(ctx: AccessContext, area: string): boolean {
  const { principal, access } = ctx;
  if (
    principal.authType !== "session" ||
    !(ADMIN_AREAS as readonly string[]).includes(area)
  )
    return false;
  if (access.companyLevel === "owner") return true;
  return (
    access.companyLevel === "admin" &&
    (GRANTABLE_ADMIN_AREAS as readonly string[]).includes(area) &&
    access.companyAreas.includes(area)
  );
}

function allows(ctx: AccessContext, request: AccessRequest): boolean {
  const { principal, access, role, scopes } = ctx;
  const { page, resource, action, adminArea } = request;
  if (!role || !known(principal.role) || !known(access.memberRole))
    return false;
  if (page !== undefined && !role.pages.includes(page)) return false;
  // A company request names only its area: a resource or record with it would skip their rules.
  if (adminArea !== undefined)
    return (
      resource === undefined &&
      request.record === undefined &&
      companyAllows(ctx, adminArea)
    );
  if (resource === undefined) return false;
  // Private saved views keep today's rule only: no role body can name them.
  if (
    resource !== "views" &&
    !(
      Object.hasOwn(role.actions, resource) &&
      role.actions[resource as ActionResource]?.includes(action)
    )
  )
    return false;
  const has = (scope: Scope) => scopes.includes(scope);
  const write = !(READ_ACTIONS as readonly string[]).includes(action);
  if (
    write &&
    [principal.role, access.memberRole, role.membership].includes("viewer")
  )
    return false;
  const session = principal.authType === "session";
  if (Object.hasOwn(resourceToKind, resource)) {
    const group = resource === "candidates" ? "candidates" : "recruitment";
    switch (action) {
      case "view":
      case "export":
        return has(`${group}:read`);
      case "create":
      case "edit":
      case "transition":
      case "archive":
      case "approve":
      case "share-view":
        return has(`${group}:write`);
      case "comment":
        // The comment is a recruitment record; on a candidate it is candidate data too.
        return (
          has(`${group}:write`) &&
          has("recruitment:write") &&
          (resource !== "candidates" || has("candidates:read"))
        );
      case "import":
        return (
          (principal.role === "owner" || principal.role === "admin") &&
          has("imports:write")
        );
      case "erase":
        return (
          resource === "candidates" &&
          principal.role === "owner" &&
          session &&
          has("candidates:write")
        );
      default:
        return false;
    }
  }
  // Session only, as the routes are today (humanOnly): no token or OAuth grant manages the team.
  if ((TEAM_ADMIN_RESOURCES as readonly string[]).includes(resource))
    return (
      action === "admin" &&
      session &&
      (resource === "storage-settings"
        ? principal.role === "owner" || principal.role === "admin"
        : principal.role === "owner")
    );
  if (resource === "directory")
    return write ? has("directory:write") && session : has("directory:read");
  // Plans need a per-person grant the access state does not carry yet (R2d-12).
  return false;
}

function kindOf(request: AccessRequest): RecordKind | null {
  const kind =
    request.record?.kind ??
    (request.resource !== undefined &&
    Object.hasOwn(resourceToKind, request.resource)
      ? resourceToKind[request.resource as ResourceName]
      : undefined);
  return kind !== undefined && Object.hasOwn(recordDataSchemas, kind)
    ? kind
    : null;
}

/**
 * The one authorization decision: the record scope and field rules for an allowed request, or a
 * 403 in today's words. Synchronous and pure. The records service, insights and exports decide
 * through it; MCP moves onto it in R2a-09.
 */
export function authorize(
  ctx: AccessContext,
  request: AccessRequest,
): AccessDecision {
  if (!allows(ctx, request))
    throw request.action === "import" ? importForbidden() : forbidden();
  const kind = kindOf(request);
  const group = kind && RECORD_KIND_GROUPS[kind];
  const fields: AccessDecision["fields"] = {};
  if (kind) {
    const editable =
      request.action === "edit" || allows(ctx, { ...request, action: "edit" });
    const rules = ctx.role!.fields[kind as keyof RoleBody["fields"]] ?? {};
    for (const key of Object.keys(recordDataSchemas[kind].shape)) {
      const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
      // An explicit edit rule still needs edit access to the record: layers only remove access.
      fields[key] =
        rule === "hidden" || rule === "hidden-unless-approver"
          ? "hidden"
          : rule === "read" || !editable
            ? "read"
            : "edit";
    }
  }
  return {
    scope: { recordScope: group ? ctx.role!.recordScope[group] : "all" },
    fields,
  };
}

/** authorize() without the throw: the decision, or null where authorize() refuses with a 403. */
export function decide(
  ctx: AccessContext,
  request: AccessRequest,
): AccessDecision | null {
  try {
    return authorize(ctx, request);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return null;
    throw error;
  }
}

/** The caller's own answers for the UI (GET /api/v1/me/access). */
export type AccessMap = {
  role: Pick<RoleBody, "name" | "membership"> | null;
  scopes: Scope[];
  pages: PageKey[];
  actions: Partial<Record<ActionResource, Action[]>>;
  fields: Partial<Record<RecordKind, AccessDecision["fields"]>>;
  adminAreas: AdminArea[];
};

/**
 * Every answer of authorize() the screens need to hide what the server would refuse, with no
 * statement, no id and no configuration body: the role's name, membership and pages, the scopes,
 * the allowed actions per resource, the field rules of each record kind the caller may view and the
 * company areas.
 */
export function accessMap(ctx: AccessContext): AccessMap {
  const actions: AccessMap["actions"] = {};
  for (const resource of ACTION_RESOURCES) {
    const allowed = ACTIONS.filter((action) =>
      decide(ctx, { resource, action }),
    );
    if (allowed.length) actions[resource] = allowed;
  }
  const fields: AccessMap["fields"] = {};
  for (const resource of RECORD_RESOURCES) {
    const decision = decide(ctx, { resource, action: "view" });
    if (decision) fields[resourceToKind[resource]] = decision.fields;
  }
  const { role } = ctx;
  return {
    role: role ? { name: role.name, membership: role.membership } : null,
    scopes: ctx.scopes,
    pages: role ? PAGE_KEYS.filter((page) => role.pages.includes(page)) : [],
    actions,
    fields,
    adminAreas: ADMIN_AREAS.filter((adminArea) =>
      decide(ctx, { action: "admin", adminArea }),
    ),
  };
}

// The record-scope step: every role reads all records of its team until R2a-18 adds unit and
// assigned predicates.
const recordScopePredicates = (_ctx: AccessContext, _kind: RecordKind) =>
  [] as SQL[];

/**
 * Team and kind, saved views for their private owner and candidate comments only with
 * candidates:read, plus the record-scope step.
 */
export function scopeFilter(ctx: AccessContext, kind: RecordKind): SQL[] {
  const { principal: p } = ctx;
  return [
    eq(records.teamId, p.teamId),
    eq(records.kind, kind),
    // A saved view is private to its owner, whatever the role says.
    ...(kind === "saved-view" ? [eq(records.privateOwnerId, p.userId)] : []),
    // Without candidates:read, comments on candidates do not exist for the caller.
    ...(kind === "comment" && !ctx.scopes.includes("candidates:read")
      ? [
          sql`exists(select 1 from ${records} parent where parent.team_id=${p.teamId} and parent.id=${records.parentRecordId} and parent.kind<>'candidate')`,
        ]
      : []),
    ...recordScopePredicates(ctx, kind),
  ];
}

function fieldRules(role: RoleBody, kind: RecordKind): Record<string, string> {
  return kind === "saved-view"
    ? {}
    : (role.fields[kind as keyof RoleBody["fields"]] ?? {});
}

/**
 * The keys of one kind the caller may not see: data keys, custom field ids and top-level keys whose
 * rule is hidden or hidden-unless-approver, plus SENSITIVE_CANDIDATE_FIELDS for an MCP candidate.
 * Every output that leaves fields out, redact() included, takes them from here.
 */
export function hiddenKeys(ctx: AccessContext, kind: RecordKind): Set<string> {
  if (!ctx.role) throw forbidden();
  const rules = fieldRules(ctx.role, kind);
  const hidden = new Set(
    Object.keys(rules).filter(
      (key) =>
        rules[key] === "hidden" || rules[key] === "hidden-unless-approver",
    ),
  );
  if (ctx.channel === "mcp" && kind === "candidate")
    for (const key of SENSITIVE_CANDIDATE_FIELDS) hidden.add(key);
  return hidden;
}

/**
 * A copy of the row without the fields the caller may not see, in data and data.customValues, and
 * without hidden top-level keys (importMeta, legacyId and the decorated labels); with explicit read
 * rules for the kind, readOnlyFields names the read-only fields and keys present. MCP results never
 * carry SENSITIVE_CANDIDATE_FIELDS.
 */
export function redact<T extends RecordDto>(
  ctx: AccessContext,
  row: T,
): T & { readOnlyFields?: string[] } {
  if (!ctx.role) throw forbidden();
  const rules = fieldRules(ctx.role, row.kind);
  const hidden = hiddenKeys(ctx, row.kind);
  const readOnly = Object.keys(rules).filter((key) => rules[key] === "read");
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row.data))
    if (!hidden.has(key)) data[key] = value;
  const customValues = data.customValues;
  if (customValues && typeof customValues === "object")
    data.customValues = Object.fromEntries(
      Object.entries(customValues).filter(([key]) => !hidden.has(key)),
    );
  const visible: T = { ...row, data: data as T["data"] };
  for (const key of TOP_LEVEL_FIELD_KEYS)
    if (hidden.has(key)) Reflect.deleteProperty(visible, key);
  const present = (key: string) =>
    Object.hasOwn(data, key) ||
    ((TOP_LEVEL_FIELD_KEYS as readonly string[]).includes(key) &&
      Object.hasOwn(visible, key));
  return {
    ...visible,
    ...(readOnly.length
      ? { readOnlyFields: readOnly.filter(present).sort() }
      : {}),
  };
}
