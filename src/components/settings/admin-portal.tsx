"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import type { AccessMap } from "@/lib/authz";
import {
  humanError,
  requestJson,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";
import { formatDate } from "@/components/workspace/helpers";
import { adminTabs, type AdminTabKey } from "./admin-tabs";
import { DirectoryTab } from "./directory-tab";
import { OrganisationTab } from "./organisation-tab";
import { RolesTab } from "./roles-tab";
import { TaskBoardsTab } from "./task-boards-tab";

/** GET /api/v1/me/access. */
export type MeAccess = AccessMap & {
  teamRole: string | null;
  companyLevel: "owner" | "admin" | null;
};
export interface ConfigHistoryRow {
  occurredAt: string;
  action: string;
  objectType: string;
  objectKey: string;
  versionNumber: number | null;
  fromVersionNumber: number | null;
  actorName: string | null;
}
interface ConfigHistoryPage {
  data: ConfigHistoryRow[];
  pagination: { pageSize: number; hasMore: boolean; nextBefore: string | null };
}
export interface AccessChange {
  occurredAt: string;
  kind: "role-assignment" | "home-units";
  action: string;
  affectedUserIds: string[];
  roleName: string | null;
  actorName: string | null;
}
export interface AccessChanges {
  data: AccessChange[];
  truncated: boolean;
}

export const NO_ACCESS = "You do not have access to this page";
const HISTORY_PAGE_SIZE = 25;
const historyPath = (before?: string) =>
  `/api/v1/config-history?pageSize=${HISTORY_PAGE_SIZE}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
const historyActions: Record<string, string> = {
  "config.draft_created": "Draft created",
  "config.published": "Published",
  "config.retired": "Retired",
  "config.archived": "Archived",
  "config.layout_changed": "Layout changed",
};
const objectTypes: Record<string, string> = {
  "kind-schema": "Record fields",
  workflow: "Workflow",
  board: "Board",
  role: "Role",
  template: "Template",
  "task-board": "Task board",
};
const accessActions: Record<string, string> = {
  "role.assigned": "Role assigned",
  "role.cleared": "Role cleared",
  "scope.home_units_changed": "Home units changed",
};
const plain = (labels: Record<string, string>, value: string) =>
  Object.hasOwn(labels, value) ? labels[value] : value;
type TeamTabKey = Exclude<
  AdminTabKey,
  "roles" | "organisation" | "directory" | "history" | "task-boards"
>;
const teamPanels: Record<
  TeamTabKey,
  { title: string; text: string; href: string; link: string }
> = {
  members: {
    title: "Members",
    text: "Invite people to this team, set each member's team role and remove members.",
    href: "/app/settings/team",
    link: "Open Team & access",
  },
  "cv-storage": {
    title: "CV storage",
    text: "Set this team's CV storage limit and upload rate limit, and whether connected AI apps can read CV contents.",
    href: "/app/settings/team#cv-storage",
    link: "Open CV storage settings",
  },
  speed: {
    title: "Speed",
    text: "See how long common actions and API requests take for this team.",
    href: "/app/settings/speed",
    link: "Open Speed",
  },
  tokens: {
    title: "API tokens",
    text: "Create and revoke your API tokens for AI tools and integrations in this team.",
    href: "/app/settings/api-tokens",
    link: "Open API tokens",
  },
};

/** The one Admin portal: the caller's tabs from GET /api/v1/me/access, and the current tab. */
export function AdminPortal({ tab }: { tab: AdminTabKey | null }) {
  const { team } = useWorkspace();
  const router = useRouter();
  const result = useApi<{ data: MeAccess }>(team ? "/api/v1/me/access" : null);
  const access = result.data?.data ?? null;
  const first = access ? adminTabs(access)[0]?.key : undefined;
  useEffect(() => {
    if (tab === null && first) router.replace(`/app/admin/${first}`);
  }, [tab, first, router]);
  return (
    <AdminPortalView
      key={team?.id ?? "no-team"}
      tab={tab}
      access={access}
      denied={!team || result.status === 403}
      error={result.error}
      onAccessChanged={result.refresh}
    />
  );
}

export function AdminPortalView({
  tab,
  access,
  denied,
  error,
  onAccessChanged = () => {},
}: {
  tab: AdminTabKey | null;
  access: MeAccess | null;
  denied: boolean;
  error: string;
  /** Reloads the caller's access after a change to their own company authority. */
  onAccessChanged?: () => void;
}) {
  const tabs = access ? adminTabs(access) : [];
  const current = tabs.find((item) => item.key === tab);
  return (
    <div className="stack settings-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Workspace settings</p>
          <h1>Admin portal</h1>
          <p className="muted">
            The team and company settings you manage, in one place.
          </p>
        </div>
        <ShieldCheck size={28} aria-hidden="true" />
      </header>
      {denied ? (
        <NoAccess />
      ) : error ? (
        <p className="notice error" role="alert">
          Could not load your access. {error}
        </p>
      ) : !access ? (
        <p role="status">Loading…</p>
      ) : !tabs.length || (tab !== null && !current) ? (
        <NoAccess />
      ) : !current ? (
        <p role="status">Loading…</p>
      ) : (
        <>
          <nav
            className="settings-nav"
            aria-label="Admin portal sections"
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              marginBottom: 24,
            }}
          >
            {tabs.map((item) => (
              <Link
                key={item.key}
                href={`/app/admin/${item.key}`}
                className={`button ${item.key === current.key ? "" : "secondary"}`}
                aria-current={item.key === current.key ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          {current.key === "history" ? (
            <>
              <ConfigHistory />
              {access.companyLevel === "owner" && <RecentAccessChanges />}
            </>
          ) : current.key === "roles" ? (
            <RolesTab onAccessChanged={onAccessChanged} />
          ) : current.key === "organisation" ? (
            <OrganisationTab access={access} />
          ) : current.key === "directory" ? (
            <DirectoryTab access={access} />
          ) : current.key === "task-boards" ? (
            <TaskBoardsTab />
          ) : (
            <TeamPanel tab={current.key} />
          )}
        </>
      )}
    </div>
  );
}

function NoAccess() {
  return (
    <section className="panel">
      <p>{NO_ACCESS}</p>
    </section>
  );
}

/** Team tabs link to the existing settings pages, which keep their own guards. */
function TeamPanel({ tab }: { tab: TeamTabKey }) {
  const panel = teamPanels[tab];
  return (
    <section className="panel">
      <h2>{panel.title}</h2>
      <p>{panel.text}</p>
      <Link href={panel.href} className="button">
        {panel.link}
      </Link>
    </section>
  );
}

function ConfigHistory() {
  const { team } = useWorkspace();
  const first = useApi<ConfigHistoryPage>(team ? historyPath() : null);
  const [older, setOlder] = useState<ConfigHistoryPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [moreError, setMoreError] = useState("");
  const pages = first.data ? [first.data, ...older] : [];
  const last = pages.at(-1);
  async function showOlder() {
    const before = last?.pagination.nextBefore;
    if (!team || !before) return;
    setBusy(true);
    setMoreError("");
    try {
      const page = await requestJson<ConfigHistoryPage>(
        team.id,
        historyPath(before),
      );
      setOlder((list) => [...list, page]);
    } catch (e) {
      setMoreError(humanError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ConfigHistoryPanel
      rows={first.data ? pages.flatMap((page) => page.data) : null}
      hasMore={!!last?.pagination.hasMore}
      error={first.error}
      moreError={moreError}
      busy={busy}
      onShowOlder={showOlder}
    />
  );
}

export function ConfigHistoryPanel({
  rows,
  hasMore,
  error,
  moreError = "",
  busy = false,
  onShowOlder = () => {},
}: {
  rows: ConfigHistoryRow[] | null;
  hasMore: boolean;
  error: string;
  moreError?: string;
  busy?: boolean;
  onShowOlder?: () => void;
}) {
  return (
    <section className="panel stack">
      <h2>Configuration history</h2>
      <p className="muted">
        Company configuration changes made in any team of the workspace, newest
        first. Only times, names and version numbers are shown, never the
        configuration itself.
      </p>
      {error ? (
        <p className="notice error" role="alert">
          Could not load the configuration history. {error}
        </p>
      ) : !rows ? (
        <p role="status">Loading configuration history…</p>
      ) : !rows.length ? (
        <p className="muted">
          No configuration changes have been recorded yet.
        </p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <caption className="sr-only">
                Configuration changes, newest first
              </caption>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Change</th>
                  <th>Configuration</th>
                  <th>Version</th>
                  <th>Changed by</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.occurredAt}:${index}`}>
                    <td data-label="Time">
                      {formatDate(row.occurredAt, true)}
                    </td>
                    <td data-label="Change">
                      {plain(historyActions, row.action)}
                    </td>
                    <td data-label="Configuration">
                      {plain(objectTypes, row.objectType)}: {row.objectKey}
                    </td>
                    <td data-label="Version">
                      {row.versionNumber === null
                        ? "Not numbered"
                        : `Version ${row.versionNumber}${row.fromVersionNumber === null ? "" : ` from version ${row.fromVersionNumber}`}`}
                    </td>
                    <td data-label="Changed by">
                      {row.actorName ?? "Not recorded"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {moreError && (
            <p className="notice error" role="alert">
              Could not load older changes. {moreError}
            </p>
          )}
          {hasMore && (
            <div className="row">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={onShowOlder}
              >
                Show older changes
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Company owners only: names come from the current team's member list, never a raw user id. */
function RecentAccessChanges() {
  const { team } = useWorkspace();
  const teamId = team?.id;
  const changes = useApi<AccessChanges>(
    teamId ? "/api/v1/access-changes" : null,
  );
  const [members, setMembers] = useState<Map<string, string> | null>(null);
  const [memberError, setMemberError] = useState("");
  useEffect(() => {
    if (!teamId) return;
    let active = true;
    authClient.organization
      .getFullOrganization({ query: { organizationId: teamId } })
      .then((result) => {
        if (result.error)
          throw new Error(
            result.error.message || "The team's members could not be loaded.",
          );
        const list = (result.data?.members ?? []) as {
          userId: string;
          user: { name: string };
        }[];
        if (active)
          setMembers(
            new Map(list.map((item) => [item.userId, item.user.name])),
          );
      })
      .catch((e) => {
        if (active) setMemberError(humanError(e));
      });
    return () => {
      active = false;
    };
  }, [teamId]);
  return (
    <AccessChangesPanel
      changes={members ? changes.data : null}
      members={members ?? new Map()}
      error={changes.error || memberError}
    />
  );
}

export function AccessChangesPanel({
  changes,
  members,
  error,
}: {
  changes: AccessChanges | null;
  /** The current team's members: user id to name. */
  members: ReadonlyMap<string, string>;
  error: string;
}) {
  const affected = (ids: string[]) =>
    ids.length
      ? ids
          .map((id) => members.get(id) ?? "A member of another team")
          .join(", ")
      : "Not recorded";
  return (
    <section className="panel stack">
      <h2>Recent access changes (last 7 days)</h2>
      <p className="muted">
        Role assignments and home-unit changes in every team of the workspace,
        newest first. Only company owners see this list.
      </p>
      {error ? (
        <p className="notice error" role="alert">
          Could not load the recent access changes. {error}
        </p>
      ) : !changes ? (
        <p role="status">Loading recent access changes…</p>
      ) : !changes.data.length ? (
        <p className="muted">No access changes in the last 7 days.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="sr-only">
              Access changes in the last 7 days, newest first
            </caption>
            <thead>
              <tr>
                <th>Time</th>
                <th>Change</th>
                <th>Members affected</th>
                <th>Role</th>
                <th>Changed by</th>
              </tr>
            </thead>
            <tbody>
              {changes.data.map((row, index) => (
                <tr key={`${row.occurredAt}:${index}`}>
                  <td data-label="Time">{formatDate(row.occurredAt, true)}</td>
                  <td data-label="Change">
                    {plain(accessActions, row.action)}
                  </td>
                  <td data-label="Members affected">
                    {affected(row.affectedUserIds)}
                  </td>
                  <td data-label="Role">
                    {row.roleName ??
                      (row.kind === "home-units"
                        ? "Not applicable"
                        : "Not recorded")}
                  </td>
                  <td data-label="Changed by">
                    {row.actorName ?? "Not recorded"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {changes?.truncated && (
        <p className="muted">
          Only the latest changes are shown; older changes from the last 7 days
          are not listed.
        </p>
      )}
    </section>
  );
}
