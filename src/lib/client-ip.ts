import { createHmac } from "node:crypto";
import { getIPFromHeader } from "@better-auth/core/utils/ip";

/** On Vercel only the proxy-set header counts; x-forwarded-for is trusted only for local development and tests. */
export function clientIpHeader(): string {
  return process.env.VERCEL === "1"
    ? "x-vercel-forwarded-for"
    : "x-forwarded-for";
}

/** A single valid address (IPv6 collapsed to /64), or null when missing, listed or invalid. */
export function clientIp(headers: Headers): string | null {
  const value = headers.get(clientIpHeader());
  return value === null ? null : getIPFromHeader(value);
}

/**
 * Base64url HMAC-SHA256 of a value under a key derived from the secret with a fixed label, so
 * rate-limit rows never hold a client address. Rotating the secret only resets the counters.
 */
export function keyedRateLimitHash(value: string, secret: string): string {
  const key = createHmac("sha256", secret)
    .update("recruitmentos:rate-limit-key:v1")
    .digest();
  return createHmac("sha256", key).update(value).digest("base64url");
}

/** The auth.api_rate_limits key of an address's per-email sign-in backoff, under the same keyed hash. */
export function signInBackoffKey(email: string, secret: string): string {
  return `sign-in-email:${keyedRateLimitHash(email.trim().toLowerCase(), secret)}`;
}

/** The stored rate-limit identity of a client address, or `no-client-ip` without one. */
export function rateLimitClientKey(ip: string | null, secret: string): string {
  return ip === null ? "no-client-ip" : keyedRateLimitHash(ip, secret);
}
