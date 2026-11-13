import Link from "next/link";
import type { MeAccess } from "@/lib/authz";
import type { ManagedGroup } from "@/lib/groups";
import { useApi, useWorkspace } from "@/components/workspace/client";
import { adminTabs } from "./admin-tabs";

export type SettingsSection = "profile" | "api-tokens" | "about" | "groups";
const SECTIONS: [SettingsSection, string][] = [
  ["profile", "My profile"],
  ["api-tokens", "API tokens"],
  ["about", "About"],
];

/** The rule /app/admin applies: the caller's access state lists at least one admin page. */
export function canOpenAdminPortal(access: MeAccess | null) {
  return !!access && adminTabs(access).length > 0;
}

/**
 * Whether the settings navigation shows the Admin portal link, from GET /api/v1/me/access (never
 * member.role): hidden while it loads or fails, and without a team.
 */
export function useAdminPortalLink() {
  const { team } = useWorkspace();
  const result = useApi<{ data: MeAccess }>(team ? "/api/v1/me/access" : null);
  return canOpenAdminPortal(result.error ? null : (result.data?.data ?? null));
}

/**
 * Whether the settings navigation shows Groups I manage, from GET /api/v1/me/groups: only when it
 * lists at least one group of the current team's company; hidden while it loads or fails, and
 * without a team.
 */
export function useManagedGroupsLink() {
  const { team } = useWorkspace();
  const result = useApi<{ data: ManagedGroup[] }>(
    team ? "/api/v1/me/groups" : null,
  );
  return !result.error && !!result.data?.data.length;
}

/**
 * Personal settings only: My profile, API tokens and About, for every role, and Groups I manage
 * for a delegated group manager.
 */
export function SettingsNavigation({
  active,
  adminPortal,
  managedGroups,
}: {
  /** None on the Team & access and Speed pages, which are no section of personal settings. */
  active?: SettingsSection;
  /** From useAdminPortalLink. */
  adminPortal: boolean;
  /** From useManagedGroupsLink. */
  managedGroups: boolean;
}) {
  return (
    <nav
      className="settings-nav"
      aria-label="Settings sections"
      style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}
    >
      {[
        ...SECTIONS,
        ...(managedGroups
          ? [["groups", "Groups I manage"] as [SettingsSection, string]]
          : []),
      ].map(([key, label]) => (
        <Link
          key={key}
          href={`/app/settings/${key}`}
          className={`button ${active === key ? "" : "secondary"}`}
          aria-current={active === key ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
      {adminPortal && (
        <Link href="/app/admin" className="button secondary">
          Admin portal
        </Link>
      )}
    </nav>
  );
}
