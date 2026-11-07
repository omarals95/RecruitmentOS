"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Bell,
  BriefcaseBusiness,
  CalendarDays,
  CheckCheck,
  Command,
  FileCheck2,
  FolderSearch,
  House,
  KanbanSquare,
  Layers3,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Search,
  Settings,
  ShieldCheck,
  Star,
  Sun,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useTheme, type Theme } from "@/components/theme-provider";
import { Dialog } from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  abortTeamRequests,
  hasUnsavedWork,
  hasWritesInFlight,
  setSwitchNotice,
  useApi,
  useDebounced,
  useSwitchNotice,
  useWorkspace,
  WorkspaceProvider,
  type WorkspaceIdentity,
} from "./client";
import { initials } from "./helpers";
import { NOTIFICATIONS_PATH } from "./tab-requests";

export const navigation: {
  label: string;
  href: string;
  icon: LucideIcon;
  group: string;
}[] = [
  { label: "Overview", href: "/app", icon: House, group: "Workspace" },
  {
    label: "Candidates",
    href: "/app/candidates",
    icon: Users,
    group: "Talent",
  },
  {
    label: "My shortlist",
    href: "/app/shortlist",
    icon: Star,
    group: "Talent",
  },
  {
    label: "Vacancies",
    href: "/app/vacancies",
    icon: BriefcaseBusiness,
    group: "Recruitment",
  },
  {
    label: "Job roles",
    href: "/app/roles",
    icon: Layers3,
    group: "Recruitment",
  },
  {
    label: "Applications",
    href: "/app/pipeline",
    icon: KanbanSquare,
    group: "Recruitment",
  },
  {
    label: "Recruitment tasks",
    href: "/app/tasks",
    icon: CheckCheck,
    group: "Recruitment",
  },
  {
    label: "Interviews",
    href: "/app/interviews",
    icon: CalendarDays,
    group: "Recruitment",
  },
  {
    label: "Offers",
    href: "/app/offers",
    icon: FileCheck2,
    group: "Recruitment",
  },
  {
    label: "Onboarding",
    href: "/app/onboarding",
    icon: ShieldCheck,
    group: "Recruitment",
  },
  {
    label: "Analytics",
    href: "/app/analytics",
    icon: BarChart3,
    group: "Intelligence",
  },
  {
    label: "Talent insights",
    href: "/app/insights",
    icon: BarChart3,
    group: "Intelligence",
  },
  {
    label: "Source review",
    href: "/app/source-review",
    icon: FolderSearch,
    group: "Intelligence",
  },
  {
    label: "Activity",
    href: "/app/activity",
    icon: Activity,
    group: "Workspace tools",
  },
  {
    label: "Notifications",
    href: "/app/notifications",
    icon: Bell,
    group: "Workspace tools",
  },
  {
    label: "Team & settings",
    href: "/app/settings/team",
    icon: Settings,
    group: "Workspace tools",
  },
];
export function Brand() {
  return (
    <span className="brand">
      <span className="brand-symbol" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>
        Recruitment<span className="brand-os">OS</span>
      </span>
    </span>
  );
}
export function WorkspaceShell({
  identity,
  children,
}: {
  identity: WorkspaceIdentity;
  children: React.ReactNode;
}) {
  return (
    <WorkspaceProvider key={identity.team?.id || "no-team"} value={identity}>
      <Shell>{children}</Shell>
    </WorkspaceProvider>
  );
}
function Shell({ children }: { children: React.ReactNode }) {
  const { user, team, role } = useWorkspace();
  const pathname = usePathname();
  const router = useRouter();
  const [mobile, setMobile] = useState(false);
  const [search, setSearch] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const switchNotice = useSwitchNotice();
  const { theme, setTheme } = useTheme();
  const notifications = useApi<{
    data?: { read: boolean }[];
    notifications?: { read: boolean }[];
    unreadCount?: number;
  }>(NOTIFICATIONS_PATH);
  const unread =
    notifications.data?.unreadCount ??
    (
      notifications.data?.data ||
      notifications.data?.notifications ||
      []
    ).filter((item) => !item.read).length;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch((value) => !value);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const current =
    navigation.find((item) => item.href === pathname) ||
    navigation.find(
      (item) => pathname.startsWith(`${item.href}/`) && item.href !== "/app",
    );
  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {mobile && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        className={`workspace-sidebar ${mobile ? "is-open" : ""}`}
        aria-label="Main navigation"
      >
        <Link
          href="/app"
          className="brand-link"
          aria-label="RecruitmentOS home"
        >
          <Brand />
        </Link>
        <TeamSwitcher />
        <nav onClick={() => setMobile(false)}>
          {navigation.map((item, index) => {
            const Icon = item.icon;
            return (
              <div key={item.href}>
                {(index === 0 ||
                  navigation[index - 1].group !== item.group) && (
                  <p className="nav-group">{item.group}</p>
                )}
                <Link
                  className={`nav-link ${pathname === item.href || (item.href !== "/app" && pathname.startsWith(item.href + "/")) ? "active" : ""}`}
                  href={item.href}
                  aria-current={pathname === item.href ? "page" : undefined}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span>{item.label}</span>
                  {item.href === "/app/notifications" && unread > 0 && (
                    <span className="nav-count">{unread}</span>
                  )}
                </Link>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-protection">
            <ShieldCheck size={18} aria-hidden="true" />
            <div>
              Private team workspace
              <small>CV access is permission controlled</small>
            </div>
          </div>
          <Link href="/app/settings/profile" className="user-button">
            <span className="avatar">{initials(user.name)}</span>
            <span>
              <strong>{user.name}</strong>
              <small>{role || "No active team"}</small>
            </span>
            <Settings size={16} aria-hidden="true" />
          </Link>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            aria-expanded={mobile}
            onClick={() => setMobile((value) => !value)}
          >
            <Menu size={21} />
          </button>
          <div className="breadcrumbs">
            <span>{team?.name || "Your workspace"}</span>
            <span aria-hidden="true">/</span>
            <strong>{current?.label || "Settings"}</strong>
          </div>
          <div className="topbar-actions">
            <button
              className="search-launcher"
              aria-label="Search your workspace"
              onClick={() => setSearch(true)}
            >
              <Search size={17} aria-hidden="true" />
              <span>Search your workspace</span>
              <kbd>⌘ K</kbd>
            </button>
            <label className="theme-picker" title="Color theme">
              <span className="sr-only">Color theme</span>
              {theme === "dark" ? (
                <Moon size={17} aria-hidden="true" />
              ) : theme === "light" ? (
                <Sun size={17} aria-hidden="true" />
              ) : (
                <Monitor size={17} aria-hidden="true" />
              )}
              <select
                aria-label="Color theme"
                value={theme}
                onChange={(event) => setTheme(event.target.value as Theme)}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <Link
              className="icon-button notification-link"
              href="/app/notifications"
              aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
            >
              <Bell size={20} />
              {unread > 0 && <span className="notification-dot" />}
            </Link>
            <button
              className="icon-button"
              aria-label="Sign out"
              disabled={signingOut}
              onClick={async () => {
                setSigningOut(true);
                setAccountError("");
                try {
                  const result = await authClient.signOut();
                  if (result.error)
                    throw new Error(
                      result.error.message || "Unable to sign out",
                    );
                  router.push("/sign-in");
                  router.refresh();
                } catch (e) {
                  setAccountError(
                    e instanceof Error
                      ? e.message
                      : "Unable to sign out. Please try again.",
                  );
                } finally {
                  setSigningOut(false);
                }
              }}
            >
              <LogOut size={19} />
            </button>
          </div>
        </header>
        <main id="main-content" className="workspace-main">
          {team && switchNotice?.toTeamId === team.id && (
            <div
              className="notice"
              role="status"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginBottom: 16,
              }}
            >
              <span>
                Switched to {team.name}. Unsaved changes in{" "}
                {switchNotice.fromTeam} were discarded. A save that was in
                progress may or may not have completed; review{" "}
                {switchNotice.fromTeam} before redoing it.
              </span>
              <button
                className="icon-button"
                aria-label="Dismiss notification"
                onClick={() => setSwitchNotice(null)}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {accountError && (
            <p className="notice error" role="alert">
              {accountError}
            </p>
          )}
          {children}
        </main>
        <footer className="workspace-footer">
          <span>RecruitmentOS · Your team&apos;s recruitment workspace</span>
          <span>Dates and times: Asia/Dubai (UTC+4)</span>
        </footer>
      </div>
      {search && <GlobalSearch onClose={() => setSearch(false)} />}
    </div>
  );
}
function TeamSwitcher() {
  const { team } = useWorkspace();
  const router = useRouter();
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();
  useEffect(() => {
    authClient.organization
      .list()
      .then((result) => {
        if (result.data) setTeams(result.data);
      })
      .catch(() => {});
  }, []);
  return (
    <div className="team-switcher">
      <span className="team-mark" aria-hidden="true">
        {initials(team?.name || "Team")}
      </span>
      <label>
        <span className="sr-only">Active team</span>
        <select
          aria-label="Active team"
          value={team?.id || ""}
          disabled={busy || !teams.length}
          onChange={async (event) => {
            const next = event.target.value;
            const pending =
              !!team && (hasUnsavedWork(team.id) || hasWritesInFlight(team.id));
            if (
              team &&
              pending &&
              !(await confirm({
                title: "Switch team?",
                message: `Unsaved changes in ${team.name} will be discarded. A save that is still in progress may or may not complete; check ${team.name} before redoing it.`,
                confirmLabel: "Switch team",
                cancelLabel: `Stay in ${team.name}`,
                destructive: true,
              }))
            )
              return;
            setBusy(true);
            setError("");
            try {
              const result = await authClient.organization.setActive({
                organizationId: next,
              });
              if (result.error)
                throw new Error(result.error.message || "Cannot switch team");
              if (team) {
                // Only after the server switched: drop the old team's work.
                const discarded =
                  pending ||
                  hasUnsavedWork(team.id) ||
                  hasWritesInFlight(team.id);
                setSwitchNotice(
                  discarded ? { fromTeam: team.name, toTeamId: next } : null,
                );
                abortTeamRequests(team.id);
              }
              router.refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Cannot switch team");
            } finally {
              setBusy(false);
            }
          }}
        >
          {!team && <option value="">Create or join a team</option>}
          {teams.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
          {team && !teams.some((item) => item.id === team.id) && (
            <option value={team.id}>{team.name}</option>
          )}
        </select>
        <small>{busy ? "Switching…" : "Recruitment workspace"}</small>
      </label>
      {error && <p role="alert">{error}</p>}
      {dialog}
    </div>
  );
}
interface SearchResult {
  id: string;
  title: string;
  subtitle: string;
  url: string;
}
function GlobalSearch({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query);
  const result = useApi<{
    groups: { type: string; label: string; results: SearchResult[] }[];
    total: number;
    limited?: boolean;
  }>(
    debounced.trim()
      ? `/api/v1/search?q=${encodeURIComponent(debounced)}`
      : null,
  );
  return (
    <Dialog title="Search workspace" onClose={onClose} wide>
      <div className="dialog-body">
        <div className="search-field">
          <Search size={20} aria-hidden="true" />
          <input
            autoFocus
            aria-label="Search names, skills, vacancies and tasks"
            placeholder="Search names, skills, vacancies and tasks…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <p className="muted">
          Search factual candidate details and your team&apos;s recruitment
          records.
        </p>
        {result.loading && debounced && <p role="status">Searching…</p>}
        {result.error && (
          <p className="notice error" role="alert">
            {result.error}
          </p>
        )}
        {result.data?.groups.map((group) => (
          <section className="search-group" key={group.type}>
            <h3>{group.label}</h3>
            {group.results.map((item) => (
              <Link
                href={item.url}
                key={item.id}
                className="search-result"
                onClick={onClose}
              >
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.subtitle}</small>
                </span>
                <ArrowRight size={18} aria-hidden="true" />
              </Link>
            ))}
          </section>
        ))}
        {result.data?.total === 0 && (
          <div className="empty-state compact">
            <Search size={26} aria-hidden="true" />
            <h3>No matching records</h3>
            <p>Try another name, skill or keyword.</p>
          </div>
        )}
        {!debounced && (
          <div className="empty-state compact">
            <Command size={28} aria-hidden="true" />
            <p>Your next candidate, role or task is a search away.</p>
          </div>
        )}
      </div>
      <footer className="dialog-footer">
        <span className="muted">Escape to close</span>
        <button className="button secondary" onClick={onClose}>
          <X size={16} aria-hidden="true" />
          Close
        </button>
      </footer>
    </Dialog>
  );
}
