/**
 * The team detail tabs in order (architecture §14.2, without the tabs of later items); each key is
 * its `?tab=` value. Server pages read it, so it lives outside "use client".
 */
export const TEAM_DETAIL_TABS = [
  { key: "members", label: "Members" },
  { key: "settings", label: "Settings" },
  { key: "cv-storage", label: "CV storage" },
  { key: "speed", label: "Speed" },
  { key: "task-boards", label: "Task boards" },
  { key: "activity", label: "Activity" },
] as const;
export type TeamDetailTab = (typeof TEAM_DETAIL_TABS)[number]["key"];

/** The tab a `?tab=` value opens: Members for a missing or unknown key. */
export function teamDetailTab(value: unknown): TeamDetailTab {
  return TEAM_DETAIL_TABS.find((tab) => tab.key === value)?.key ?? "members";
}
