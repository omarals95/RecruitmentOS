/**
 * The group detail tabs in order (architecture §14.3, without the tabs of later items); each key is
 * its `?tab=` value. Server pages read it, so it lives outside "use client".
 */
export const GROUP_DETAIL_TABS = [
  { key: "members", label: "Members" },
  { key: "member-of", label: "Member of" },
  { key: "audit", label: "Audit" },
] as const;
export type GroupDetailTab = (typeof GROUP_DETAIL_TABS)[number]["key"];

/** The tab a `?tab=` value opens: Members for a missing or unknown key. */
export function groupDetailTab(value: unknown): GroupDetailTab {
  return GROUP_DETAIL_TABS.find((tab) => tab.key === value)?.key ?? "members";
}
