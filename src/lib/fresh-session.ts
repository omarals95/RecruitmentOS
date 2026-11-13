import { SESSION_FRESH_AGE_SECONDS } from "./auth-policy";
import { ApiError } from "./errors";
import type { Principal } from "./principal";

/**
 * The shared re-authentication check for sensitive admin changes (ADM-06): only a browser session
 * younger than Better Auth's freshAge passes, measured from the session's creation with Better
 * Auth's own `>=`. A missing or invalid start time fails closed. It runs no database statement and
 * adds to `authorize()` and the database checks without replacing them. Routes use it through
 * `runApi(..., { humanOnly: true, freshSession: true })`; later items (granting groups, domain,
 * mail, deactivation, anonymisation) reuse it the same way.
 */
export function requireFreshSession(principal: Principal, now = Date.now()) {
  if (principal.authType !== "session")
    throw new ApiError(
      403,
      "session_required",
      "Sign in to manage accounts, teams and API tokens.",
    );
  const createdAt = principal.sessionCreatedAt?.getTime();
  if (
    createdAt === undefined ||
    !Number.isFinite(createdAt) ||
    now - createdAt >= SESSION_FRESH_AGE_SECONDS * 1000
  )
    throw new ApiError(
      403,
      "SESSION_NOT_FRESH",
      "This change needs a recent sign-in. Confirm your password and two-step code, then try again.",
    );
}
