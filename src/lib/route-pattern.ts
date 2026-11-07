/**
 * Route patterns for speed reporting: a path segment that is not a plain lowercase word becomes
 * `[id]`, so no record id, name or other value leaves the browser. Shared by Speed Insights and
 * the built-in speed log.
 */
const WORD = /^[a-z][a-z-]{0,40}$/;

export function routePattern(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => (segment === "" || WORD.test(segment) ? segment : "[id]"))
    .join("/");
}

/** A URL or path without its query string and fragment, with id-like segments replaced. */
export function scrubUrl(value: string): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if (!absolute) return routePattern(value.split(/[?#]/)[0]);
  const url = new URL(value);
  return `${url.origin}${routePattern(url.pathname)}`;
}

/** Speed Insights beforeSend: only the scrubbed URL and route pattern are reported. */
export function scrubSpeedEvent<
  T extends { url: string; route?: string | null },
>(event: T): T {
  return {
    ...event,
    url: scrubUrl(event.url),
    ...(event.route ? { route: scrubUrl(event.route) } : {}),
  };
}

/** NEXT_PUBLIC_SPEED_INSIGHTS_SAMPLE_RATE: a number from 0 to 1, otherwise 1. */
export function speedInsightsSampleRate(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 1;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 1;
}
