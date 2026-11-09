import { ApiError } from "../lib/errors";

/** WHATWG URL retains brackets in the hostname for IPv6 literals. */
export function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
    hostname.toLowerCase(),
  );
}

/** Reviewed tenant-context helpers each runtime role may execute, by exact signature. */
export const dataRoleHelpers = [
  "tenant_context.install(text,text,text[])",
  "tenant_context.allows(text,text,text)",
  "tenant_context.allows_activity(text,text,text,text)",
  "tenant_context.allows_event(text,text,text,uuid)",
  "tenant_context.activity_actor_name(uuid)",
  "tenant_context.lock_storage_allocation(text,text,text)",
  "tenant_context.acquire_blob_read(text)",
  "tenant_context.release_blob_read(uuid)",
  "tenant_context.audit_mcp_call(text,text)",
  "tenant_context.audit_export(text,integer,text[])",
  "tenant_context.purge_bulk_intake(uuid)",
  "tenant_context.set_storage_limits(bigint,integer,integer)",
  "tenant_context.release_blob_charge(text,uuid)",
  "tenant_context.claim_blob_reconciliation(text)",
  "tenant_context.erase_candidate(uuid,text,text)",
  "tenant_context.set_mcp_cv_text_access(boolean)",
  "tenant_context.audit_mcp_cv_read(text,uuid)",
  "tenant_context.set_workspace_authority(text,text,text[],boolean)",
  "tenant_context.allows_workspace_admin(uuid,text)",
  "tenant_context.allows_workspace(uuid,text,text)",
  "tenant_context.publish_config_version(uuid)",
  "tenant_context.retire_config_version(uuid)",
  "tenant_context.audit_config(uuid,text)",
  "tenant_context.config_history(uuid,timestamp with time zone,integer)",
  "tenant_context.allows_directory(uuid,text)",
  "tenant_context.home_unit_changes(timestamp with time zone,integer)",
];
export const identityRoleHelpers = [
  "tenant_context.install(text,text,text[])",
  "tenant_context.audit_token(text,text)",
  "tenant_context.audit_grant_reuse(text,text)",
  "tenant_context.reset_two_step(text)",
];

// Indirect privileged access is forbidden except the allowlisted, owner-controlled helpers
// with the exact fixed search_path (pg_temp last).
function indirectPrivilegeQuery(allowed: readonly string[]) {
  // Match catalog columns; name lookups would fail without schema USAGE.
  const signatures = allowed
    .map((signature) => {
      // Catalog spelling: a type name may hold spaces (timestamp with time zone).
      const [, name, args] = /^tenant_context\.(\w+)\(([\w, [\]]*)\)$/.exec(
        signature,
      )!;
      return `('${name}','${args.replaceAll(",", ", ")}')`;
    })
    .join(",");
  return `
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN pg_catalog.pg_roles r
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND p.prosecdef AND pg_catalog.pg_has_role(current_user,r.oid,'MEMBER')
      AND pg_catalog.has_schema_privilege(r.oid,n.oid,'USAGE')
      AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')
      AND NOT COALESCE(n.nspname='tenant_context' AND p.proowner=n.nspowner
        AND (p.proname::text, pg_catalog.oidvectortypes(p.proargtypes)) IN (${signatures})
        AND 'search_path=pg_catalog, pg_temp' = ANY(p.proconfig), false))
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN pg_catalog.pg_roles r
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND c.relkind IN ('v','m','f') AND pg_catalog.pg_has_role(current_user,r.oid,'MEMBER')
      AND (pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE')
        OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE')))
`;
}

/** Both roles may read, but neither may replace or assume ownership of the marker. */
export const markerRoleBoundaryQuery = `
  SELECT NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='db_boundary' AND c.relname='connection_marker' AND c.relkind IN ('r','p')
      AND pg_catalog.has_schema_privilege(current_user, n.oid, 'USAGE')
      AND pg_catalog.has_table_privilege(current_user, c.oid, 'SELECT')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
        WHERE pg_catalog.pg_has_role(current_user,r.oid,'MEMBER')
          AND (pg_catalog.pg_has_role(r.oid,n.nspowner,'MEMBER')
            OR pg_catalog.pg_has_role(r.oid,c.relowner,'MEMBER')
            OR pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE')
            OR pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES')))
  ) AS unsafe
`;

type PoolState = {
  role: string;
  sessionRole: string;
  database: string;
  marker: string;
  canAssumeOther: unknown;
};
/** Same database name alone is not enough to bind two pools. */
export function verifyPoolPair(data: PoolState, identity: PoolState): void {
  const marker =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (
    !data ||
    !identity ||
    typeof data.role !== "string" ||
    !data.role ||
    typeof identity.role !== "string" ||
    !identity.role ||
    data.sessionRole !== data.role ||
    identity.sessionRole !== identity.role ||
    data.role === identity.role ||
    typeof data.database !== "string" ||
    !data.database ||
    data.database !== identity.database ||
    typeof data.marker !== "string" ||
    !marker.test(data.marker) ||
    data.marker !== identity.marker ||
    data.canAssumeOther !== false ||
    identity.canAssumeOther !== false
  )
    throw new ApiError(
      503,
      "unsafe_database_connections",
      "Configure distinct non-assumable identity and data roles on the same database.",
    );
}

/** Freeze the effective port and reject libpq session overrides before pg reads environment fallbacks. */
export function prepareConnectionTargets(
  dataUrl: string,
  identityUrl: string,
  env: Record<string, string | undefined> = process.env,
): { dataUrl: string; identityUrl: string } {
  verifyConnectionTargets(dataUrl, identityUrl);
  if (env.PGOPTIONS)
    throw new ApiError(
      503,
      "unsafe_database_connections",
      "Database startup options are not supported.",
    );
  function withExplicitPort(value: string) {
    const url = new URL(value);
    if (!url.port) url.port = "5432";
    return url.toString();
  }
  return {
    dataUrl: withExplicitPort(dataUrl),
    identityUrl: withExplicitPort(identityUrl),
  };
}

/** Role membership is checked even with NOINHERIT because SET ROLE may be allowed. */
export const dataRoleBoundaryQuery = `
  SELECT (
    ${indirectPrivilegeQuery(dataRoleHelpers)}
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n CROSS JOIN pg_catalog.pg_roles r
      WHERE n.nspname = 'auth'
        AND pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
        AND pg_catalog.has_schema_privilege(r.oid, n.oid, 'USAGE,CREATE'))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN pg_catalog.pg_roles r
      WHERE n.nspname = 'auth' AND c.relkind IN ('r','p','v','m','f')
        AND pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
        AND (pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN pg_catalog.pg_roles r
      WHERE n.nspname = 'auth' AND c.relkind = 'S'
        AND pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
        AND pg_catalog.has_sequence_privilege(r.oid, c.oid, 'USAGE,SELECT,UPDATE'))
  ) AS unsafe
`;

/** Identity mutations must not carry direct access to recruitment records or audit. */
export const identityRoleBoundaryQuery = `
  SELECT (
    ${indirectPrivilegeQuery(identityRoleHelpers)}
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN pg_catalog.pg_roles r
      WHERE n.nspname = 'app' AND c.relkind IN ('r','p','v','m','f')
        AND pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
        AND (pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN pg_catalog.pg_roles r
      WHERE n.nspname = 'app' AND c.relkind = 'S'
        AND pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
        AND pg_catalog.has_sequence_privilege(r.oid, c.oid, 'USAGE,SELECT,UPDATE'))
  ) AS unsafe
`;

/** Do not let libpq overrides silently redirect one of the two connections. */
export function verifyConnectionTargets(
  dataUrl: string,
  identityUrl: string,
): void {
  try {
    const urls = [new URL(dataUrl), new URL(identityUrl)];
    const targets = urls.map((url) => {
      // node-postgres does not enforce channel_binding=require from a URI.
      // Reject it and every other unsupported, repeated or local-file option
      // before node-postgres parses the connection string.
      const seen = new Set<string>();
      for (const [key, value] of url.searchParams) {
        if (seen.has(key)) throw new Error();
        seen.add(key);
        if (key === "sslmode" && ["require", "verify-full"].includes(value))
          continue;
        throw new Error();
      }
      if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        !url.hostname ||
        url.hostname.includes("%") ||
        !url.username ||
        !url.password ||
        url.hash
      )
        throw new Error();
      const database = decodeURIComponent(url.pathname.slice(1));
      if (!database || database.includes("/") || database.includes("\0"))
        throw new Error();
      return `${url.hostname.toLowerCase()}:${url.port || "5432"}/${database}`;
    });
    if (targets[0] !== targets[1]) throw new Error();
  } catch {
    throw new ApiError(
      503,
      "unsafe_database_connections",
      "Configure separate identity and data credentials for the same database endpoint.",
    );
  }
}
