/**
 * The Admin portal tabs that exist today, in order. Team tabs follow the team role; History follows
 * company authority and Roles & permissions the company owner level only (D1), so a team role never
 * yields either and company authority never yields a team tab. A tab is added here only when its
 * feature exists.
 */
export const ADMIN_TABS = [
  { key: "members", label: "Members", level: "team" },
  { key: "cv-storage", label: "CV storage", level: "team" },
  { key: "speed", label: "Speed", level: "team" },
  { key: "tokens", label: "API tokens", level: "team" },
  { key: "roles", label: "Roles & permissions", level: "owner" },
  { key: "history", label: "History", level: "company" },
] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];
export type AdminTabKey = AdminTab["key"];

export function isAdminTab(key: string): key is AdminTabKey {
  return ADMIN_TABS.some((tab) => tab.key === key);
}

/** The tabs the caller may open, from GET /api/v1/me/access's teamRole and companyLevel only. */
export function adminTabs({
  teamRole,
  companyLevel,
}: {
  teamRole: string | null;
  companyLevel: string | null;
}): AdminTab[] {
  const team = teamRole === "owner" || teamRole === "admin";
  const company = companyLevel === "owner" || companyLevel === "admin";
  return ADMIN_TABS.filter((tab) =>
    tab.level === "team"
      ? team
      : tab.level === "owner"
        ? companyLevel === "owner"
        : company,
  );
}
