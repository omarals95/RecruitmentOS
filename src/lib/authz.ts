import { eq, sql, type SQL } from "drizzle-orm";
import { recordAssignments, records } from "@/db/schema";
import { ApiError } from "@/lib/errors";
import {
  ROLE_UNAVAILABLE,
  SCOPES,
  roleScopes,
  teamArchived,
  type Role,
  type Scope,
} from "@/lib/permissions";
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
    Partial<
      Pick<
        TenantAccess,
        | "roleVersionId"
        | "documents"
        | "recordScope"
        | "homeUnits"
        | "teamArchived"
      >
    >;
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
 * 403 in today's words. Synchronous and pure. The records service, insights, exports and the MCP
 * tools decide through it.
 */
export function authorize(
  ctx: AccessContext,
  request: AccessRequest,
): AccessDecision {
  if (!allows(ctx, request)) {
    // An archived team stores no write scope: every refused change says why.
    if (
      ctx.access.teamArchived &&
      !(READ_ACTIONS as readonly string[]).includes(request.action)
    )
      throw teamArchived();
    const refusal =
      request.action === "import" ? importForbidden() : forbidden();
    // An assigned role install could not use: the same refusal, in plain words.
    if (ctx.access.roleVersionId === null)
      throw new ApiError(refusal.status, refusal.code, ROLE_UNAVAILABLE);
    throw refusal;
  }
  const kind = kindOf(request);
  const group = kind && RECORD_KIND_GROUPS[kind];
  const fields: AccessDecision["fields"] = {};
  if (kind) {
    const editable =
      request.action === "edit" || allows(ctx, { ...request, action: "edit" });
    const rules = ctx.role!.fields[kind as keyof RoleBody["fields"]] ?? {};
    const customHidden = customValuesHiddenByDefault(kind, rules);
    for (const key of Object.keys(recordDataSchemas[kind].shape)) {
      const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
      // An explicit edit rule still needs edit access to the record: layers only remove access.
      fields[key] =
        rule === "hidden" ||
        rule === "hidden-unless-approver" ||
        (key === "customValues" && customHidden)
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

/**
 * GET /api/v1/me/access and the admin pages: the team role, company level, the team's archived state
 * and accessMap().
 */
export type MeAccess = AccessMap & {
  teamRole: string | null;
  companyLevel: "owner" | "admin" | null;
  teamArchived: boolean;
};
export function meAccess(
  principal: Principal,
  access: AccessContext["access"],
): MeAccess {
  return {
    teamRole: principal.role,
    companyLevel: access.companyLevel,
    teamArchived: access.teamArchived ?? false,
    ...accessMap(accessContext(principal, access)),
  };
}

const PIPELINE_KINDS: readonly RecordKind[] = [
  "application",
  "interview",
  "offer",
  "onboarding",
  "checklist",
];
/** Kinds with a record-scope rule; every other kind is always in scope (architecture §3.5). */
const SCOPED_KINDS: readonly RecordKind[] = [
  "vacancy",
  ...PIPELINE_KINDS,
  "candidate",
  "task",
  "comment",
];

/**
 * The record scope per group from the access state install returned. An access state without one
 * (never one install returned) takes the role it names; null fails closed.
 */
function recordScopeOf(ctx: AccessContext): RoleBody["recordScope"] | null {
  const { access } = ctx;
  if (access.recordScope !== undefined) return access.recordScope;
  return assignedRole(ctx.principal, access)?.recordScope ?? null;
}

/**
 * The record-scope rule of one kind for the row named `row` (a table alias), or null when every row
 * of the kind is in scope: architecture §3.5 for unit and assigned principals, from the context's
 * home units and the caller's user id. "Under a home unit" is a closure probe; "an assignment" is any
 * relation of the caller on the record. Nested rows take aliases derived from `row`, so a rule never
 * shadows the row it tests.
 *
 * With `once`, for statements over many rows, the row's id is tested against the ids in scope
 * (scopedIds), which PostgreSQL computes once per statement; a candidate's against the candidates of
 * its applications in scope. A comment still walks to its parent per row. Without it each row probes
 * the closure, the assignments and its parents itself, which is cheaper for a few records.
 */
function scopeRule(
  ctx: AccessContext,
  scopes: RoleBody["recordScope"],
  kind: RecordKind,
  row: string,
  once = false,
): SQL | null {
  const { principal: p } = ctx;
  const homeUnits = ctx.access.homeUnits ?? [];
  const column = (name: string) => sql.raw(`${row}.${name}`);
  if (once && kind !== "comment") {
    const ids =
      kind === "candidate"
        ? scopedIds(
            ctx,
            { ...scopes, pipeline: scopes.candidates },
            "application",
            "candidate_id",
          )
        : scopedIds(ctx, scopes, kind);
    return ids && sql`${column("id")}=any(array(${ids}))`;
  }
  const assignedOn = (...columns: string[]) =>
    sql`exists(select 1 from ${recordAssignments} ra where ra.team_id=${p.teamId} and ra.user_id=${p.userId} and ra.record_id in (${sql.join(columns.map(column), sql`,`)}))`;
  // A unit principal with no home units reaches records only through assignments and the creator.
  const underHome = homeUnits.length
    ? sql`exists(select 1 from app.org_unit_closure c where c.ancestor_id=any(${sql.param(homeUnits)}::uuid[]) and c.descendant_id=${column("org_unit_id")})`
    : null;
  const pipeline = (scope: RecordScope, own: SQL) =>
    scope === "all"
      ? null
      : scope === "unit" && underHome
        ? sql`(${underHome} or ${own})`
        : own;
  const linked = (target: RecordKind, reference: string) => {
    const alias = `${row}_${target === "vacancy" ? "v" : "c"}`;
    const rule = scopeRule(ctx, scopes, target, alias);
    return sql`exists(select 1 from ${records} ${sql.raw(alias)} where ${sql.raw(alias)}.team_id=${p.teamId} and ${sql.raw(alias)}.kind=${target} and ${sql.raw(alias)}.id=${column(reference)}${rule ? sql` and ${rule}` : sql``})`;
  };
  switch (kind) {
    case "vacancy":
      return pipeline(scopes.pipeline, assignedOn("id"));
    case "application":
    case "interview":
    case "offer":
    case "onboarding":
    case "checklist":
      return pipeline(
        scopes.pipeline,
        assignedOn("id", "scope_application_id", "scope_vacancy_id"),
      );
    case "candidate": {
      // An application of the candidate in scope under the application rule, with this group's scope.
      const alias = `${row}_a`;
      const rule = scopeRule(
        ctx,
        { ...scopes, pipeline: scopes.candidates },
        "application",
        alias,
      );
      return rule
        ? sql`exists(select 1 from ${records} ${sql.raw(alias)} where ${sql.raw(alias)}.team_id=${p.teamId} and ${sql.raw(alias)}.kind='application' and ${sql.raw(alias)}.candidate_id=${column("id")} and ${rule})`
        : null;
    }
    case "task": {
      if (scopes.tasks === "all") return null;
      const own = sql`${column("created_by")}=${p.userId} or ${assignedOn("id")}`;
      return scopes.tasks === "assigned"
        ? sql`(${own})`
        : sql`(${own} or ${linked("candidate", "candidate_id")} or ${linked("vacancy", "vacancy_id")})`;
    }
    case "comment": {
      // The nearest parent that is not a comment, under its own kind's rule. The cycle clause ends a
      // loop of comments re-pointed into each other, as tenant_context.in_scope does (0038).
      const alias = `${row}_p`;
      const parent = anyKindRule(ctx, scopes, alias, once);
      return parent
        ? sql`exists(with recursive up(id, kind, parent_record_id) as (select x.id, x.kind, x.parent_record_id from ${records} x where x.team_id=${p.teamId} and x.id=${column("parent_record_id")} union all select x.id, x.kind, x.parent_record_id from up join ${records} x on x.team_id=${p.teamId} and x.id=up.parent_record_id where up.kind='comment') cycle id set looped using path select 1 from up join ${records} ${sql.raw(alias)} on ${sql.raw(alias)}.team_id=${p.teamId} and ${sql.raw(alias)}.id=up.id where up.kind<>'comment' and not up.looped and ${parent})`
        : null;
    }
    default:
      return null;
  }
}

/**
 * The team's records of `kind` in the caller's scope as one uncorrelated select of their ids (or,
 * with `output`, of their candidates), or null when every row of the kind is in scope: scopeRule's
 * rule as a union of branches, each the rows whose one column is in one set (the caller's assigned
 * records, the units under their home units or another kind's records in scope). Each branch's test
 * is `= any(array(...))`, which is leakproof and cheap enough for PostgreSQL to apply before the
 * record-scope policy (0038), so the policy helper runs only for rows in scope. Comments have no set:
 * scopeRule walks to a comment's parent per row.
 */
function scopedIds(
  ctx: AccessContext,
  scopes: RoleBody["recordScope"],
  kind: RecordKind,
  output: "id" | "candidate_id" = "id",
): SQL | null {
  const { principal: p } = ctx;
  const homeUnits = ctx.access.homeUnits ?? [];
  const assigned = sql`select ra.record_id from ${recordAssignments} ra where ra.team_id=${p.teamId} and ra.user_id=${p.userId}`;
  // A unit principal with no home units reaches records only through assignments and the creator.
  const underHome = homeUnits.length
    ? sql`select c.descendant_id from app.org_unit_closure c where c.ancestor_id=any(${sql.param(homeUnits)}::uuid[])`
    : null;
  // No set holds a null. A row whose column is null is left out before its set is computed, so a
  // set only rows of another shape need is never read.
  const notNull = (name: string) =>
    name === "id" ? sql`` : sql` and s.${sql.raw(name)} is not null`;
  const rows = (test: SQL) =>
    sql`select s.${sql.raw(output)} from ${records} s where s.team_id=${p.teamId} and s.kind=${kind}${notNull(output)} and ${test}`;
  const inSet = (name: string, set: SQL) =>
    rows(
      sql`s.${sql.raw(name)} is not null and s.${sql.raw(name)}=any(array(${set}))`,
    );
  const union = (branches: SQL[]) => sql.join(branches, sql` union all `);
  const pipeline = (scope: RecordScope, columns: string[]) =>
    scope === "all"
      ? null
      : union([
          ...(scope === "unit" && underHome
            ? [inSet("org_unit_id", underHome)]
            : []),
          ...columns.map((name) => inSet(name, assigned)),
        ]);
  switch (kind) {
    case "vacancy":
      return pipeline(scopes.pipeline, ["id"]);
    case "application":
    case "interview":
    case "offer":
    case "onboarding":
    case "checklist":
      return pipeline(scopes.pipeline, [
        "id",
        "scope_application_id",
        "scope_vacancy_id",
      ]);
    case "candidate": {
      const candidates = scopedIds(
        ctx,
        { ...scopes, pipeline: scopes.candidates },
        "application",
        "candidate_id",
      );
      return candidates && inSet("id", candidates);
    }
    case "task": {
      if (scopes.tasks === "all") return null;
      // A linked kind whose every row is in scope needs only the linked row to exist in the team.
      const linked = (target: RecordKind, reference: string) => {
        const ids = scopedIds(ctx, scopes, target);
        return ids
          ? inSet(reference, ids)
          : rows(
              sql`exists(select 1 from ${records} t where t.team_id=${p.teamId} and t.kind=${target} and t.id=s.${sql.raw(reference)})`,
            );
      };
      return union([
        rows(sql`s.created_by=${p.userId}`),
        inSet("id", assigned),
        ...(scopes.tasks === "unit"
          ? [
              linked("candidate", "candidate_id"),
              linked("vacancy", "vacancy_id"),
            ]
          : []),
      ]);
    }
    default:
      return null;
  }
}

/** The rule for a row of any kind: its own kind's rule, or null when no kind is limited. */
function anyKindRule(
  ctx: AccessContext,
  scopes: RoleBody["recordScope"],
  row: string,
  once = false,
): SQL | null {
  const rules = SCOPED_KINDS.filter((kind) => kind !== "comment").flatMap(
    (kind) => {
      const rule = scopeRule(ctx, scopes, kind, row, once);
      return rule ? [{ kind, rule }] : [];
    },
  );
  if (!rules.length) return null;
  const kind = sql.raw(`${row}.kind`);
  return sql`(${kind} not in (${sql.join(
    rules.map((item) => sql`${item.kind}`),
    sql`,`,
  )}) or ${sql.join(
    rules.map((item) => sql`(${kind}=${item.kind} and ${item.rule})`),
    sql` or `,
  )})`;
}

/** How a rule tests its sets: `once` per statement, for statements over many rows (see scopeRule). */
export type ScopeShape = { once?: boolean };

/**
 * Whether the row named `row` (a table alias) of `kind` is in the caller's record scope, or null when
 * every row of the kind is. A context without a usable record scope sees nothing.
 */
export function recordScopeRule(
  ctx: AccessContext,
  kind: RecordKind,
  row: string,
  { once = false }: ScopeShape = {},
): SQL | null {
  const scopes = recordScopeOf(ctx);
  return scopes ? scopeRule(ctx, scopes, kind, row, once) : sql`false`;
}

/**
 * The same for a record of any kind, for statements that do not know the kind: the row's own kind
 * decides, and comments follow their parent. Null when no group is limited.
 */
export function anyRecordScopeRule(
  ctx: AccessContext,
  row: string,
): SQL | null {
  const scopes = recordScopeOf(ctx);
  if (!scopes) return sql`false`;
  const rule = anyKindRule(ctx, scopes, row);
  const comment = scopeRule(ctx, scopes, "comment", row);
  return rule && comment
    ? sql`((${sql.raw(`${row}.kind`)}<>'comment' and ${rule}) or (${sql.raw(`${row}.kind`)}='comment' and ${comment}))`
    : rule;
}

/**
 * For statements over rows that name a record (the activity feed and the stage history): a row whose
 * record id is null keeps today's rules, and any other only when its record exists in the team and is
 * in the caller's scope for its kind. Null for a caller whose record scope is all in every group.
 */
export function recordIdInScope(ctx: AccessContext, recordId: SQL): SQL | null {
  const rule = anyRecordScopeRule(ctx, "scoped");
  return rule
    ? sql`(${recordId} is null or exists(select 1 from ${records} scoped where scoped.team_id=${ctx.principal.teamId} and scoped.id=${recordId} and ${rule}))`
    : null;
}

/**
 * Team and kind, saved views for their private owner and candidate comments only with
 * candidates:read, plus the record-scope rule of architecture §3.5 inside the same statement, with
 * its sets computed once per statement when `shape.once` is set (see scopeRule).
 */
export function scopeFilter(
  ctx: AccessContext,
  kind: RecordKind,
  shape: ScopeShape = {},
): SQL[] {
  const { principal: p } = ctx;
  const rule = recordScopeRule(ctx, kind, "records", shape);
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
    ...(rule ? [rule] : []),
  ];
}

function fieldRules(role: RoleBody, kind: RecordKind): Record<string, string> {
  return kind === "saved-view"
    ? {}
    : (role.fields[kind as keyof RoleBody["fields"]] ?? {});
}

/**
 * Fails closed on a non-task kind's customValues (R2b-02): until custom fields have definitions and
 * rules of their own (R2b-04), a role that hides any field of the kind and names no rule for
 * customValues hides every custom value, so a role published before the key existed keeps hiding
 * what it hid. Tasks keep their per-field rules.
 */
function customValuesHiddenByDefault(
  kind: RecordKind,
  rules: Record<string, string>,
): boolean {
  return (
    kind !== "task" &&
    Object.hasOwn(recordDataSchemas[kind].shape, "customValues") &&
    !Object.hasOwn(rules, "customValues") &&
    Object.values(rules).some(
      (rule) => rule === "hidden" || rule === "hidden-unless-approver",
    )
  );
}

/**
 * The keys of one kind the caller may not see: data keys, custom field ids and top-level keys whose
 * rule is hidden or hidden-unless-approver, a non-task customValues hidden by default, plus
 * SENSITIVE_CANDIDATE_FIELDS for an MCP candidate. Every output that leaves fields out, redact()
 * included, takes them from here.
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
  if (customValuesHiddenByDefault(kind, rules)) hidden.add("customValues");
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
