/**
 * The built-in speed log records only these fixed action names and API route patterns, with
 * durations. No record id, name, content, query value or user detail is ever part of a sample.
 */
export const SPEED_TABS = [
  "overview",
  "candidates",
  "shortlist",
  "vacancies",
  "roles",
  "pipeline",
  "tasks",
  "interviews",
  "offers",
  "onboarding",
  "analytics",
  "insights",
  "source-review",
  "activity",
  "notifications",
] as const;
export type SpeedTab = (typeof SPEED_TABS)[number];
export const SPEED_ACTIONS = [
  "task.move",
  "application.stage",
  ...SPEED_TABS.map((tab) => `tab.${tab}` as const),
  "candidate.open",
  "candidate.save",
  "interview.schedule",
] as const;
export type SpeedAction = (typeof SPEED_ACTIONS)[number];
/** `<METHOD> <pattern>` where the pattern holds only plain lowercase words and `[id]`. */
export const SPEED_ROUTE_NAME =
  /^(GET|POST|PATCH|PUT|DELETE) \/api\/v1(\/([a-z][a-z-]{0,40}|\[id\]))*$/;
export const SPEED_ROUTE_MAX_LENGTH = 80;
export const SPEED_MAX_MS = 600_000;
export const SPEED_MAX_SAMPLES = 50;
export const SPEED_MAX_BODY_BYTES = 16_384;
export const SPEED_RETENTION_DAYS = 30;
/** Samples stored per clock hour; the rest of a post is dropped and the post still answers 202. */
export const SPEED_USER_HOURLY_ROWS = 120;
export const SPEED_TEAM_HOURLY_ROWS = 1000;

export function isSpeedAction(name: string): name is SpeedAction {
  return (SPEED_ACTIONS as readonly string[]).includes(name);
}
export function isSpeedRouteName(name: string): boolean {
  return name.length <= SPEED_ROUTE_MAX_LENGTH && SPEED_ROUTE_NAME.test(name);
}
