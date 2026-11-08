import { ApiError } from "./errors";
export const SCOPES = [
  "candidates:read",
  "candidates:write",
  "recruitment:read",
  "recruitment:write",
  "cvs:read",
  "cvs:write",
  "imports:write",
  "directory:read",
  "directory:write",
  "plans:read",
  "plans:write",
] as const;
export type Scope = (typeof SCOPES)[number];
/** Scopes an API token may hold; the directory and plan scopes are membership ceilings only. */
export const API_TOKEN_SCOPES = [
  "candidates:read",
  "candidates:write",
  "recruitment:read",
  "recruitment:write",
  "cvs:read",
  "cvs:write",
  "imports:write",
] as const satisfies readonly Scope[];
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];
/**
 * Scopes an OAuth client may request for the MCP endpoint. cvs:read shares CV contents and cvs:write
 * uploads CVs; legacy imports (imports:write) are never offered.
 */
export const MCP_SCOPES = [
  "candidates:read",
  "recruitment:read",
  "cvs:read",
  "candidates:write",
  "recruitment:write",
  "cvs:write",
] as const satisfies readonly Scope[];
export type McpScope = (typeof MCP_SCOPES)[number];
export type Role = "owner" | "admin" | "recruiter" | "viewer";
export function parseRole(value: string): Role {
  if (["owner", "admin", "recruiter", "viewer"].includes(value))
    return value as Role;
  throw new ApiError(403, "unknown_role", "Your team role is not supported.");
}
/** Explicit lists, so a scope appended to SCOPES never reaches recruiters or viewers. */
const RECRUITER_SCOPES: readonly Scope[] = [
  "candidates:read",
  "candidates:write",
  "recruitment:read",
  "recruitment:write",
  "cvs:read",
  "cvs:write",
];
const VIEWER_SCOPES: readonly Scope[] = [
  "candidates:read",
  "recruitment:read",
  "cvs:read",
];
export function roleScopes(role: Role): Scope[] {
  return role === "owner" || role === "admin"
    ? [...SCOPES]
    : role === "recruiter"
      ? [...RECRUITER_SCOPES]
      : [...VIEWER_SCOPES];
}
export const getRoleScopes = roleScopes;
export function requireScope(p: { scopes: readonly string[] }, scope: Scope) {
  if (!p.scopes.includes(scope))
    throw new ApiError(
      403,
      "scope_required",
      `Permission ${scope} is required.`,
    );
}
