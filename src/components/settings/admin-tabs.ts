/**
 * The Admin portal tabs that exist today, in order. Team tabs follow the team role; History follows
 * company authority, and Roles & permissions and Employees the company owner level only (D1), so a
 * team role never yields any of them and company authority never yields a team tab. A tab is added
 * here only when its feature exists; Employees holds employee erasure and the retention review
 * until the Organisation tab (R2a-16) takes them.
 */
export const ADMIN_TABS = [
  { key: "members", label: "Members", level: "team" },
  { key: "cv-storage", label: "CV storage", level: "team" },
  { key: "speed", label: "Speed", level: "team" },
  { key: "tokens", label: "API tokens", level: "team" },
  { key: "roles", label: "Roles & permissions", level: "owner" },
  { key: "employees", label: "Employees", level: "owner" },
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
