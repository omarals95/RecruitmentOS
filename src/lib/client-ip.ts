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
