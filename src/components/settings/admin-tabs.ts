import type { AccessMap } from "@/lib/authz";

/** The plain refusal on every admin page; server pages import it, so it lives outside "use client". */
export const NO_ACCESS = "You do not have access to this page";
/** The team detail page for a company owner or admin outside that team: no team data at all (TST-005). */
export const NOT_A_MEMBER = "You are not a member of this team";

/** The Admin portal sidebar groups, in order (architecture §14.1). */
export const ADMIN_GROUPS = [
  "Overview",
  "People",
  "Access",
  "Configuration",
  "Look & feel",
  "Communication",
  "Integrations",
  "Monitoring",
] as const;
export type AdminGroup = (typeof ADMIN_GROUPS)[number];

/**
 * The Admin portal pages that exist today, one row per page, ordered by group. Team pages follow the
 * team role; History follows company authority, Roles & permissions the company owner level only
 * (D1), Organisation a company owner or a company admin with the organisation area, and Directory
 * the role's directory view action, so a team role never yields any of them and company authority
 * never yields a team page. Teams is the one page that both open (architecture §14.1 "Who sees
 * it"): a team owner or admin lists their own teams, and a company owner or admin also sees every
 * other team by name only, never its data. A page is added here only when its feature exists.
 */
export const ADMIN_TABS = [
  {
    key: "teams",
    label: "Teams",
    level: "teams",
    group: "People",
    description:
      "See the teams you manage and create a team; company owners and admins also see every other team by name.",
  },
  {
    key: "members",
    label: "Members",
    level: "team",
    group: "People",
    description:
      "Invite people to this team, set each member's team role and remove members.",
  },
  {
    key: "cv-storage",
    label: "CV storage",
    level: "team",
    group: "People",
    description:
      "Set this team's CV storage limit and upload rate limit, and whether connected AI apps can read CV contents.",
  },
  {
    key: "speed",
    label: "Speed",
    level: "team",
    group: "People",
    description:
      "See how long common actions and API requests take for this team.",
  },
  {
    key: "task-boards",
    label: "Task boards",
    level: "team",
    group: "People",
    description:
      "Choose which of this team's buckets each task board shows as its columns.",
  },
  {
    key: "organisation",
    label: "Organisation",
    level: "organisation",
    group: "People",
    description:
      "Set up the company's levels, units and positions, and see the org chart.",
  },
  {
    key: "directory",
    label: "Directory",
    level: "directory",
    group: "People",
    description:
      "Find employees by name or employee number and keep their records up to date.",
  },
  {
    key: "roles",
    label: "Roles & permissions",
    level: "owner",
    group: "Access",
    description:
      "Create and publish the roles that narrow what members can do, and choose who holds company authority.",
  },
  {
    key: "tokens",
    label: "API tokens",
    level: "team",
    group: "Integrations",
    description:
      "Create and revoke your API tokens for AI tools and integrations in this team.",
  },
  {
    key: "history",
    label: "History",
    level: "company",
    group: "Monitoring",
    description:
      "See the company configuration changes made in any team of the workspace.",
  },
] as const satisfies readonly {
  key: string;
  label: string;
  level: "team" | "teams" | "owner" | "organisation" | "directory" | "company";
  group: AdminGroup;
  description: string;
}[];
export type AdminTab = (typeof ADMIN_TABS)[number];
export type AdminTabKey = AdminTab["key"];

export function isAdminTab(key: string): key is AdminTabKey {
  return ADMIN_TABS.some((tab) => tab.key === key);
}

/**
 * The pages the caller may open, in table order, from GET /api/v1/me/access: teamRole,
 * companyLevel, and the company areas and directory actions of the access state (never
 * member.role).
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
    teams: team || company,
    owner: companyLevel === "owner",
    organisation:
      companyLevel === "owner" ||
      (companyLevel === "admin" && adminAreas.includes("organisation")),
    directory: !!actions.directory?.includes("view"),
    company,
  };
  return ADMIN_TABS.filter((tab) => shown[tab.level]);
}
