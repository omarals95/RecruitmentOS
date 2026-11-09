import { eq, sql, type SQL } from "drizzle-orm";
import { records } from "@/db/schema";
import { ApiError } from "@/lib/errors";
import { SCOPES, roleScopes, type Role, type Scope } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";
import type { TenantAccess } from "@/lib/tenant-context";
import {
  ADMIN_AREAS,
  GRANTABLE_ADMIN_AREAS,
  READ_ACTIONS,
  TEAM_ADMIN_RESOURCES,
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
  >;
  /** Null for a team role outside the four known roles: every request is then refused. */
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
// Today's importPermission() response, so call sites can swap without changing it.
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
  const role =
    options.role ??
    (known(principal.role) ? builtInRoleFor(principal.role).body : null);
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
 * 403 in today's words. Synchronous and pure; nothing calls it yet (R2a-07 to R2a-09).
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

// The record-scope step: every role reads all records of its team until R2a-18 adds unit and
// assigned predicates.
const recordScopePredicates = (_ctx: AccessContext, _kind: RecordKind) =>
  [] as SQL[];

/** Today's owned() predicates, unchanged, plus the record-scope step. */
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

/**
 * A copy of the row without the fields the caller may not see, in data and data.customValues;
 * with explicit read rules for the kind, readOnlyFields names the read-only fields present. MCP
 * results never carry SENSITIVE_CANDIDATE_FIELDS.
 */
export function redact<T extends RecordDto>(
  ctx: AccessContext,
  row: T,
): T & { readOnlyFields?: string[] } {
  if (!ctx.role) throw forbidden();
  const rules: Record<string, string> =
    row.kind === "saved-view"
      ? {}
      : (ctx.role.fields[row.kind as keyof RoleBody["fields"]] ?? {});
  const hidden = new Set(
    Object.keys(rules).filter(
      (key) =>
        rules[key] === "hidden" || rules[key] === "hidden-unless-approver",
    ),
  );
  if (ctx.channel === "mcp" && row.kind === "candidate")
    for (const key of SENSITIVE_CANDIDATE_FIELDS) hidden.add(key);
  const readOnly = Object.keys(rules).filter((key) => rules[key] === "read");
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row.data))
    if (!hidden.has(key)) data[key] = value;
  const customValues = data.customValues;
  if (customValues && typeof customValues === "object")
    data.customValues = Object.fromEntries(
      Object.entries(customValues).filter(([key]) => !hidden.has(key)),
    );
  return {
    ...row,
    data: data as T["data"],
    ...(readOnly.length
      ? {
          readOnlyFields: readOnly
            .filter((key) => Object.hasOwn(data, key))
            .sort(),
        }
      : {}),
  };
}
