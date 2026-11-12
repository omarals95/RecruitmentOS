/**
 * The user detail tabs in order (architecture §14.3, without the tabs of later items); each key is
 * its `?tab=` value. Server pages read it, so it lives outside "use client".
 */
export const USER_DETAIL_TABS = [
  { key: "profile", label: "Profile" },
  { key: "teams", label: "Teams & roles" },
  { key: "groups", label: "Groups" },
  { key: "authority", label: "Company authority" },
  { key: "security", label: "Security" },
  { key: "activity", label: "Activity" },
] as const;
export type UserDetailTab = (typeof USER_DETAIL_TABS)[number]["key"];

/** The tab a `?tab=` value opens: Profile for a missing or unknown key. */
export function userDetailTab(value: unknown): UserDetailTab {
  return USER_DETAIL_TABS.find((tab) => tab.key === value)?.key ?? "profile";
}
