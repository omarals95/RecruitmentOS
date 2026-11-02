import { getAuth, getAuthOptions } from "./auth";
import { requireVerifiedIdentity } from "./auth-policy";
import { ApiError } from "./errors";

export async function getSession(headers: Headers) {
  if (!getAuthOptions().configured) return null;
  return (await getAuth()).api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
}

export async function getVerifiedSession(headers: Headers) {
  if (!getAuthOptions().configured)
    throw new ApiError(
      503,
      "AUTH_NOT_CONFIGURED",
      "Authentication setup is required.",
    );
  return requireVerifiedIdentity(await getSession(headers));
}
