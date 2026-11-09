import type { AccessMap } from "@/lib/authz";

/**
 * The Admin portal tabs that exist today, in order. Team tabs follow the team role; History follows
 * company authority, Roles & permissions the company owner level only (D1), Organisation a company
 * owner or a company admin with the organisation area, and Directory the role's directory view
 * action, so a team role never yields any of them and company authority never yields a team tab. A
 * tab is added here only when its feature exists.
 */
export const ADMIN_TABS = [
  { key: "members", label: "Members", level: "team" },
  { key: "cv-storage", label: "CV storage", level: "team" },
  { key: "speed", label: "Speed", level: "team" },
  { key: "tokens", label: "API tokens", level: "team" },
  { key: "roles", label: "Roles & permissions", level: "owner" },
  { key: "organisation", label: "Organisation", level: "organisation" },
  { key: "directory", label: "Directory", level: "directory" },
  { key: "history", label: "History", level: "company" },
] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];
export type AdminTabKey = AdminTab["key"];

export function isAdminTab(key: string): key is AdminTabKey {
  return ADMIN_TABS.some((tab) => tab.key === key);
}

/**
 * The tabs the caller may open, from GET /api/v1/me/access: teamRole, companyLevel, and the company
 * areas and directory actions of the access state (never member.role).
 */
export function adminTabs({
  teamRole,
  companyLevel,
  adminAreas = [],
  actions = {},
}: {
  teamRole: string | null;
  companyLevel: string | null;
  adminAreas?: AccessMap["adminAreas"];
  actions?: AccessMap["actions"];
}): AdminTab[] {
  const team = teamRole === "owner" || teamRole === "admin";
  const company = companyLevel === "owner" || companyLevel === "admin";
  const shown: Record<AdminTab["level"], boolean> = {
    team,
    owner: companyLevel === "owner",
    organisation:
      companyLevel === "owner" ||
      (companyLevel === "admin" && adminAreas.includes("organisation")),
    directory: !!actions.directory?.includes("view"),
    company,
  };
  return ADMIN_TABS.filter((tab) => shown[tab.level]);
}
