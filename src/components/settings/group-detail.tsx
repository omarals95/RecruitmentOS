"use client";

import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type Ref,
} from "react";
import type { WorkspacePeople } from "@/lib/admin-users";
import type { MeAccess } from "@/lib/authz";
import type {
  GroupAuditRow,
  GroupChild,
  GroupDetail as GroupData,
  GroupList,
  GroupMembers,
  GroupRef,
  GroupReplacement,
  GroupRoleChoices,
  GroupUse,
} from "@/lib/groups";
import {
  ClientError,
  humanError,
  requestJson,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";
import { formatDate } from "@/components/workspace/helpers";
import {
  useConfirm,
  type ConfirmOptions,
} from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { tabKeys } from "@/components/ui/tab-keys";
import { AdminPortalView } from "./admin-portal";
import { NO_ACCESS } from "./admin-tabs";
import {
  REAUTH_CANCELLED,
  useFreshSession,
  type ReauthCancelled,
} from "./fresh-session-dialog";
import { GROUP_DETAIL_TABS, type GroupDetailTab } from "./group-detail-tabs";
import { groupStatuses, peopleCount, type GroupDraft } from "./groups-tab";
import { plainError } from "./roles-tab";

export type { GroupData, GroupDetailTab };

export interface GroupDetailProps {
  /** The group id in the URL; the server allowed the Groups page. */
  groupId: string;
  /** The caller's company level in the active team: only a company owner changes a granting group. */
  companyLevel: string | null;
  tab: GroupDetailTab;
}

export const GROUP_NOT_FOUND = "Group not found.";
export const AUDIT_LIMIT = 50;
export const GRANTING_OWNER =
  "Changes to this group need a recent sign-in, because it or a group it is in grants access.";
export const GRANTING_ADMIN =
  "Only a company owner can change this group, because it or a group it is in grants access.";
export const ARCHIVED_GROUP =
  "This group is archived. It keeps its members and cannot be changed.";
export const AUDIT_SCOPE =
  "Changes made from your current team, newest first. Changes made from another team are shown in that team.";
export const ARCHIVE_MESSAGE =
  "It keeps its members. An archived group cannot be changed or restored.";
export const NO_MANAGERS_GRANTING =
  "A group that grants access cannot have managers. Only a company owner can change its people.";
export const WHERE_USED_EMPTY = "Nothing uses this group.";
/** The heading of each source of Where used; a later item adds its own. */
export const USE_SOURCES: Record<GroupUse["source"], string> = {
  "parent-group": "Parent groups",
  "role-grant": "Role grants",
};
/** The archive dialog's choice that removes the group from a parent instead of replacing it. */
export const REMOVE_FROM_PARENT = "remove";
export const ROLES_HELP =
  "Everyone in this group, and in the groups inside it, who is a member of the team holds the role there. A role chosen for a person in the team's Members tab wins. A role never gives more than the person's team role allows.";
export const NO_ROLES = "This group gives no roles.";
export const ROLES_OWNER_ONLY = "Only a company owner can give a group a role.";

/** A direct member: a person or a child group. */
export type GroupMember = { userId: string } | { childGroupId: string };
/** One change of the group, sent as its route expects. */
export type GroupChange =
  | { kind: "rename"; draft: GroupDraft }
  | { kind: "archive"; replacements?: GroupReplacement[] }
  | { kind: "add"; member: GroupMember }
  | { kind: "remove"; member: GroupMember }
  | { kind: "add-manager"; userId: string }
  | { kind: "remove-manager"; userId: string }
  | { kind: "grant-role"; teamId: string; roleObjectId: string }
  | { kind: "remove-role"; teamId: string };
/** The Give a role form: the chosen team and role, "" for none. */
export type RoleGrantDraft = { teamId: string; roleObjectId: string };
export const NO_ROLE_GRANT: RoleGrantDraft = { teamId: "", roleObjectId: "" };
/**
 * The archive dialog of a group in use: per use (archiveKey), REMOVE_FROM_PARENT or the replacing
 * group's id ("" while unchosen), and the refusal it shows.
 */
export type ArchiveDraft = { choices: Record<string, string>; error: string };
/** The Add form: what kind of member, and the chosen person or group. */
export type AddDraft = {
  kind: "person" | "group";
  userId: string;
  childGroupId: string;
};
export const NO_ADD_DRAFT: AddDraft = {
  kind: "person",
  userId: "",
  childGroupId: "",
};
/** Active people for the person choices, page by page. */
export type PersonChoices = {
  rows: { userId: string; label: string }[];
  nextCursor: string | null;
  error: string;
};

/**
 * Admin > Groups > one group: the shell and sidebar of the active team, as on every admin page,
 * with the group's tabs beside it. A team switch remounts the detail.
 */
export function GroupDetailPortal(props: GroupDetailProps) {
  const { team } = useWorkspace();
  const result = useApi<{ data: MeAccess }>(team ? "/api/v1/me/access" : null);
  return (
    <AdminPortalView
      tab="groups"
      access={result.data?.data ?? null}
      denied={false}
      error={result.error}
      detail={<GroupDetail key={team?.id ?? "no-team"} {...props} />}
    />
  );
}

/**
 * One change: the request, which on 403 SESSION_NOT_FRESH opens "Confirm it's you" and retries
 * once. True once done; false when the re-authentication was cancelled, which sends nothing more.
 */
export async function sendGroupChange(
  teamId: string,
  groupId: string,
  change: GroupChange,
  withFreshSession: <T>(work: () => Promise<T>) => Promise<T | ReauthCancelled>,
): Promise<boolean> {
  const path = `/api/v1/admin/groups/${encodeURIComponent(groupId)}`;
  const send = () =>
    change.kind === "rename"
      ? requestJson(teamId, path, {
          method: "PATCH",
          body: JSON.stringify({
            name: change.draft.name,
            description: change.draft.description,
          }),
        })
      : change.kind === "archive"
        ? requestJson(teamId, path, {
            method: "PATCH",
            body: JSON.stringify(
              change.replacements
                ? { archived: true, replacements: change.replacements }
                : { archived: true },
            ),
          })
        : change.kind === "add-manager" || change.kind === "remove-manager"
          ? requestJson(teamId, `${path}/managers`, {
              method: change.kind === "add-manager" ? "POST" : "DELETE",
              body: JSON.stringify({ userId: change.userId }),
            })
          : change.kind === "grant-role" || change.kind === "remove-role"
            ? requestJson(teamId, `${path}/roles`, {
                method: change.kind === "grant-role" ? "POST" : "DELETE",
                body: JSON.stringify(
                  change.kind === "grant-role"
                    ? {
                        teamId: change.teamId,
                        roleObjectId: change.roleObjectId,
                      }
                    : { teamId: change.teamId },
                ),
              })
            : requestJson(teamId, `${path}/members`, {
                method: change.kind === "add" ? "POST" : "DELETE",
                body: JSON.stringify(change.member),
              });
  return (await withFreshSession(send)) !== REAUTH_CANCELLED;
}

type Loaded = { group: GroupData | null; error: string; status: number | null };

/** GET /api/v1/admin/groups/<id> for the active team, and every change of the group. */
export function GroupDetail({ groupId, companyLevel, tab }: GroupDetailProps) {
  const { team } = useWorkspace();
  const teamId = team?.id ?? null;
  const [run, setRun] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [rename, setRename] = useState<GroupDraft>({
    name: "",
    description: "",
  });
  const [add, setAdd] = useState<AddDraft>(NO_ADD_DRAFT);
  const [manager, setManager] = useState("");
  const [grant, setGrant] = useState<RoleGrantDraft>(NO_ROLE_GRANT);
  const [archiving, setArchiving] = useState<ArchiveDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState({ error: "", notice: "" });
  const { confirm, dialog } = useConfirm();
  const freshSession = useFreshSession();
  const outcomeRef = useRef<HTMLDivElement>(null);
  const [outcomeFocus, setOutcomeFocus] = useState(0);
  useEffect(() => {
    if (outcomeFocus) outcomeRef.current?.focus();
  }, [outcomeFocus]);

  useEffect(() => {
    if (!teamId) return;
    let active = true;
    requestJson<{ data: GroupData }>(
      teamId,
      `/api/v1/admin/groups/${encodeURIComponent(groupId)}`,
    )
      .then(({ data }) => {
        if (!active) return;
        setLoaded({ group: data, error: "", status: null });
        setRename({ name: data.name, description: data.description ?? "" });
      })
      .catch((e) => {
        if (active)
          setLoaded({
            group: null,
            error: humanError(e),
            status: e instanceof ClientError ? e.status : null,
          });
      });
    return () => {
      active = false;
    };
  }, [teamId, groupId, run]);

  const group = loaded?.group ?? null;
  const editable = !!group && canChange(group, companyLevel === "owner");
  const groups = useApi<GroupList>(
    teamId && editable ? "/api/v1/admin/groups" : null,
  );
  const people = usePersonChoices(teamId, editable);
  // Only a company owner gives a current group a role; viewing the choices never needs a recent sign-in.
  const roleChoices = useApi<{ data: GroupRoleChoices }>(
    teamId && companyLevel === "owner" && group?.status === "active"
      ? `/api/v1/admin/groups/${encodeURIComponent(groupId)}/roles`
      : null,
  );

  async function change(step: GroupChange, ask?: ConfirmOptions) {
    if (!teamId || !group || busy) return;
    setOutcome({ error: "", notice: "" });
    if (ask && !(await confirm(ask))) return;
    setBusy(true);
    let done: boolean;
    try {
      done = await sendGroupChange(
        teamId,
        group.id,
        step,
        freshSession.withFreshSession,
      );
      if (done) {
        setOutcome({ error: "", notice: changeNotice(step) });
        if (step.kind === "add") setAdd({ ...NO_ADD_DRAFT, kind: add.kind });
        if (step.kind === "add-manager") setManager("");
        if (step.kind === "grant-role") setGrant(NO_ROLE_GRANT);
        setRun((value) => value + 1);
        groups.refresh();
      }
    } catch (e) {
      // The forms keep what was chosen and typed.
      setOutcome({ error: plainError(e), notice: "" });
      done = true;
    } finally {
      setBusy(false);
    }
    if (done) setOutcomeFocus((count) => count + 1);
  }

  /** Archive with a choice for every use, from the dialog, which keeps the choices on a refusal. */
  async function archiveInUse() {
    if (!teamId || !group || !archiving || busy) return;
    const replacements = archiveReplacements(
      group.whereUsed,
      archiving.choices,
    );
    if (!replacements) return;
    setBusy(true);
    try {
      const done = await sendGroupChange(
        teamId,
        group.id,
        { kind: "archive", replacements },
        freshSession.withFreshSession,
      );
      if (done) {
        setArchiving(null);
        setOutcome({ error: "", notice: changeNotice({ kind: "archive" }) });
        setRun((value) => value + 1);
        groups.refresh();
        setOutcomeFocus((count) => count + 1);
      }
    } catch (e) {
      setArchiving((draft) => draft && { ...draft, error: plainError(e) });
      // Where used is read again, so the dialog lists what uses the group now.
      if (e instanceof ClientError && e.code === "group_uses_changed")
        setRun((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <p role="status">Loading this group…</p>;
  if (!group)
    return <GroupDetailRefusal status={loaded.status} error={loaded.error} />;
  const member = (target: GroupMember, name: string) => ({
    title: `Remove ${name}?`,
    message:
      "userId" in target
        ? `${name} is removed from ${group.name}. They stay in any nested group they are in.`
        : `${name} and its members are no longer part of ${group.name}. ${name} itself is kept.`,
    confirmLabel: "Remove",
    destructive: true,
  });
  return (
    <>
      <GroupDetailView
        group={group}
        tab={tab}
        companyOwner={companyLevel === "owner"}
        busy={busy}
        error={outcome.error}
        notice={outcome.notice}
        outcomeRef={outcomeRef}
        rename={rename}
        add={add}
        personChoices={people.choices}
        groupChoices={
          groups.data
            ? groupChoices(group, groups.data)
            : groups.error
              ? []
              : null
        }
        groupChoicesError={groups.error}
        onRename={setRename}
        onAdd={setAdd}
        onShowMorePeople={people.more}
        onSubmitRename={(event) => {
          event.preventDefault();
          void change({ kind: "rename", draft: rename });
        }}
        onArchive={() => {
          setOutcome({ error: "", notice: "" });
          if (group.whereUsed.length) setArchiving({ choices: {}, error: "" });
          else
            void change(
              { kind: "archive" },
              {
                title: `Archive ${group.name}?`,
                message: ARCHIVE_MESSAGE,
                confirmLabel: "Archive group",
                destructive: true,
              },
            );
        }}
        onSubmitAdd={(event) => {
          event.preventDefault();
          const target = addTarget(add);
          if (target) void change({ kind: "add", member: target });
        }}
        onRemove={(target, name) =>
          void change({ kind: "remove", member: target }, member(target, name))
        }
        manager={manager}
        onManager={setManager}
        onSubmitManager={(event) => {
          event.preventDefault();
          if (manager) void change({ kind: "add-manager", userId: manager });
        }}
        onRemoveManager={(userId, name) =>
          void change(
            { kind: "remove-manager", userId },
            {
              title: `Remove ${name} as a manager?`,
              message: `${name} can no longer add or remove the people in ${group.name}.`,
              confirmLabel: "Remove",
              destructive: true,
            },
          )
        }
        grant={grant}
        roleChoices={roleChoices.data?.data ?? null}
        roleChoicesError={roleChoices.error}
        onGrant={setGrant}
        onSubmitGrant={(event) => {
          event.preventDefault();
          if (grant.teamId && grant.roleObjectId)
            void change({ kind: "grant-role", ...grant });
        }}
        onRemoveRole={(teamId, role, teamName) =>
          void change(
            { kind: "remove-role", teamId },
            {
              title: `Remove ${role} in ${teamName}?`,
              message: removeRoleMessage(group.name, role, teamName),
              confirmLabel: "Remove",
              destructive: true,
            },
          )
        }
      />
      {archiving && (
        <ArchiveDialogView
          group={group}
          list={groups.data}
          listError={groups.error}
          draft={archiving}
          busy={busy}
          onChoose={(key, value) =>
            setArchiving(
              (draft) =>
                draft && {
                  ...draft,
                  choices: { ...draft.choices, [key]: value },
                },
            )
          }
          onCancel={() => setArchiving(null)}
          onConfirm={() => void archiveInUse()}
        />
      )}
      {freshSession.dialog}
      {dialog}
    </>
  );
}

const peoplePath = (cursor?: string) =>
  `/api/v1/admin/users?status=active${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
/** A person choice reads "name · email"; invited rows have no account and are left out. */
const toChoices = (page: WorkspacePeople) =>
  page.data.flatMap((row) =>
    row.userId
      ? [
          {
            userId: row.userId,
            label: `${row.name ?? row.email} · ${row.email}`,
          },
        ]
      : [],
  );

/** Active people from GET /api/v1/admin/users?status=active, 25 at a time. */
function usePersonChoices(teamId: string | null, enabled: boolean) {
  const [choices, setChoices] = useState<PersonChoices | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!teamId || !enabled) return;
    let active = true;
    requestJson<WorkspacePeople>(teamId, peoplePath())
      .then((page) => {
        if (active)
          setChoices({
            rows: toChoices(page),
            nextCursor: page.pagination.nextCursor,
            error: "",
          });
      })
      .catch((e) => {
        if (active)
          setChoices({ rows: [], nextCursor: null, error: humanError(e) });
      });
    return () => {
      active = false;
    };
  }, [teamId, enabled]);
  async function more() {
    const cursor = choices?.nextCursor;
    if (!teamId || !cursor || busy) return;
    setBusy(true);
    try {
      const page = await requestJson<WorkspacePeople>(
        teamId,
        peoplePath(cursor),
      );
      setChoices((list) => ({
        rows: [...(list?.rows ?? []), ...toChoices(page)],
        nextCursor: page.pagination.nextCursor,
        error: "",
      }));
    } catch (e) {
      setChoices((list) => ({
        rows: list?.rows ?? [],
        nextCursor: list?.nextCursor ?? null,
        error: humanError(e),
      }));
    } finally {
      setBusy(false);
    }
  }
  return { choices, more: () => void more() };
}

/** Whether the caller may change the group: never archived, and a granting one by a company owner only. */
export function canChange(
  group: Pick<GroupData, "status" | "grants">,
  companyOwner: boolean,
) {
  return group.status === "active" && (!group.grants || companyOwner);
}

/** Current groups other than this one and its direct child groups, by name. */
export function groupChoices(
  group: Pick<GroupData, "id" | "members">,
  list: GroupList,
): GroupRef[] {
  const children = new Set(group.members.groups.map((item) => item.id));
  return list.data
    .filter(
      (row) =>
        row.status === "active" && row.id !== group.id && !children.has(row.id),
    )
    .map(({ id, name }) => ({ id, name }));
}

/**
 * The groups that may replace this group in one parent: current groups other than it, the parent
 * and the parent's direct child groups, by name.
 */
export function replacementChoices(
  groupId: string,
  parentId: string,
  list: GroupList,
): GroupRef[] {
  const children = new Set(
    list.data
      .find((row) => row.id === parentId)
      ?.childGroups.map((item) => item.id),
  );
  return list.data
    .filter(
      (row) =>
        row.status === "active" &&
        row.id !== groupId &&
        row.id !== parentId &&
        !children.has(row.id),
    )
    .map(({ id, name }) => ({ id, name }));
}

/** The archive dialog's key for one use: the parent group's id, or team:<id> for a role grant. */
export const archiveKey = (use: GroupUse) =>
  use.source === "parent-group" ? use.group.id : `team:${use.team.id}`;

/** The archive body's replacements, one per use, or null while a use has no choice. */
export function archiveReplacements(
  uses: GroupUse[],
  choices: Record<string, string>,
): GroupReplacement[] | null {
  const replacements = uses.map((use): GroupReplacement | null => {
    const choice = choices[archiveKey(use)] ?? "";
    if (!choice) return null;
    const replacementGroupId = choice === REMOVE_FROM_PARENT ? null : choice;
    return use.source === "parent-group"
      ? { parentGroupId: use.group.id, replacementGroupId }
      : { teamId: use.team.id, replacementGroupId };
  });
  return replacements.every((item) => item !== null) ? replacements : null;
}

/** The current teams a group gives no role in yet, by name. */
export function grantTeamChoices(
  group: Pick<GroupData, "whereUsed">,
  choices: GroupRoleChoices,
) {
  const given = new Set(
    group.whereUsed.flatMap((use) =>
      use.source === "role-grant" ? [use.team.id] : [],
    ),
  );
  return choices.teams.filter((team) => !given.has(team.id));
}

/** What removing a group's role means, in the confirmation. */
export const removeRoleMessage = (group: string, role: string, team: string) =>
  `${group} no longer gives ${role} in ${team}. Its members keep any role chosen for them in that team.`;

/** The member the Add form names, or null when nothing is chosen. */
export function addTarget(draft: AddDraft): GroupMember | null {
  if (draft.kind === "person")
    return draft.userId ? { userId: draft.userId } : null;
  return draft.childGroupId ? { childGroupId: draft.childGroupId } : null;
}

function changeNotice(step: GroupChange) {
  return step.kind === "rename"
    ? "The name and description were saved."
    : step.kind === "archive"
      ? "The group was archived."
      : step.kind === "add"
        ? "Added to the group."
        : step.kind === "add-manager"
          ? "Added as a manager."
          : step.kind === "remove-manager"
            ? "Removed as a manager."
            : step.kind === "grant-role"
              ? "The group now gives this role."
              : step.kind === "remove-role"
                ? "The group no longer gives this role."
                : "Removed from the group.";
}

/** A group that did not load: the no-access sentence on 403, not found on 404, else the error. */
export function GroupDetailRefusal({
  status,
  error,
}: {
  status: number | null;
  error: string;
}) {
  return (
    <section className="panel">
      {status === 403 || status === 404 ? (
        <p>{status === 403 ? NO_ACCESS : GROUP_NOT_FOUND}</p>
      ) : (
        <p className="notice error" role="alert">
          Could not load this group. {error}
        </p>
      )}
    </section>
  );
}

/** The plain words for one audit row, with names; "Not recorded" for a name that cannot be found. */
export function groupAuditLabel(row: GroupAuditRow) {
  const target = row.target;
  const name =
    (target && "name" in target ? target.name : null) ?? "Not recorded";
  const kind = target?.kind;
  switch (row.action) {
    case "group.child_replaced": {
      const names = target?.kind === "replacement" ? target : null;
      return `Replaced ${names?.replaced ?? "Not recorded"} with ${names?.replacement ?? "Not recorded"} in ${names?.parent ?? "Not recorded"}`;
    }
    case "group.created":
      return "Created the group";
    case "group.renamed":
      return "Renamed or changed the description";
    case "group.archived":
      return "Archived the group";
    case "group.member_added":
      return `Added ${name}`;
    case "group.member_removed":
      return `Removed ${name}`;
    case "group.child_added":
      return kind === "parent" ? `Added to ${name}` : `Added group ${name}`;
    case "group.child_removed":
      return kind === "parent"
        ? `Removed from ${name}`
        : `Removed group ${name}`;
    case "group.manager_added":
      return `Added manager ${name}`;
    case "group.manager_removed":
      return `Removed manager ${name}`;
    case "group.role_granted":
    case "group.role_removed": {
      const names = target?.kind === "role" ? target : null;
      return `${row.action === "group.role_granted" ? "Gave" : "Removed"} the role ${names?.role ?? "Not recorded"} in ${names?.team ?? "Not recorded"}`;
    }
    default:
      return "Changed what the group grants";
  }
}

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The loaded group: name, description, the six tabs and the open tab's panel, and the rename and
 * archive controls for a caller who may change it.
 */
export function GroupDetailView({
  group,
  tab,
  companyOwner,
  busy = false,
  error = "",
  notice = "",
  outcomeRef,
  rename,
  add = NO_ADD_DRAFT,
  personChoices = null,
  groupChoices: groupOptions = null,
  groupChoicesError = "",
  manager = "",
  onRename = () => {},
  onAdd = () => {},
  onShowMorePeople = () => {},
  onSubmitRename = (event) => event.preventDefault(),
  onArchive = () => {},
  onSubmitAdd = (event) => event.preventDefault(),
  onRemove = () => {},
  onManager = () => {},
  onSubmitManager = (event) => event.preventDefault(),
  onRemoveManager = () => {},
  grant = NO_ROLE_GRANT,
  roleChoices = null,
  roleChoicesError = "",
  onGrant = () => {},
  onSubmitGrant = (event) => event.preventDefault(),
  onRemoveRole = () => {},
}: {
  group: GroupData;
  tab: GroupDetailTab;
  /** The caller is a company owner, who alone changes a group that grants something. */
  companyOwner: boolean;
  busy?: boolean;
  error?: string;
  notice?: string;
  outcomeRef?: Ref<HTMLDivElement>;
  rename?: GroupDraft;
  add?: AddDraft;
  /** Null while the people load. */
  personChoices?: PersonChoices | null;
  /** Null while the groups load. */
  groupChoices?: GroupRef[] | null;
  groupChoicesError?: string;
  /** The person the Add manager form names, "" for none. */
  manager?: string;
  onRename?: (draft: GroupDraft) => void;
  onAdd?: (draft: AddDraft) => void;
  onShowMorePeople?: () => void;
  onSubmitRename?: (event: FormEvent) => void;
  onArchive?: () => void;
  onSubmitAdd?: (event: FormEvent) => void;
  onRemove?: (member: GroupMember, name: string) => void;
  onManager?: (userId: string) => void;
  onSubmitManager?: (event: FormEvent) => void;
  onRemoveManager?: (userId: string, name: string) => void;
  /** The Give a role form. */
  grant?: RoleGrantDraft;
  /** Null while the choices load. */
  roleChoices?: GroupRoleChoices | null;
  roleChoicesError?: string;
  onGrant?: (draft: RoleGrantDraft) => void;
  onSubmitGrant?: (event: FormEvent) => void;
  onRemoveRole?: (teamId: string, role: string, team: string) => void;
}) {
  const [current, setCurrent] = useState(tab);
  const editable = canChange(group, companyOwner);
  return (
    <>
      <p>
        <Link href="/app/admin/groups">Back to Groups</Link>
      </p>
      <h2>{group.name}</h2>
      {group.description && <p className="muted">{group.description}</p>}
      {group.status === "archived" ? (
        <p>{ARCHIVED_GROUP}</p>
      ) : (
        group.grants && (
          <p className="muted">
            {companyOwner ? GRANTING_OWNER : GRANTING_ADMIN}
          </p>
        )
      )}
      {error ? (
        <div
          ref={outcomeRef}
          tabIndex={-1}
          className="notice error"
          role="alert"
        >
          {error}
        </div>
      ) : (
        notice && (
          <div
            ref={outcomeRef}
            tabIndex={-1}
            className="notice success"
            role="status"
          >
            {notice}
          </div>
        )
      )}
      <div
        className="tabs"
        role="tablist"
        aria-label="Group details"
        onKeyDown={tabKeys}
      >
        {GROUP_DETAIL_TABS.map((item) => (
          <button
            type="button"
            role="tab"
            id={`group-tab-${item.key}`}
            aria-controls={`group-panel-${item.key}`}
            tabIndex={current === item.key ? 0 : -1}
            aria-selected={current === item.key}
            key={item.key}
            onClick={() => setCurrent(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`group-panel-${current}`}
        aria-labelledby={`group-tab-${current}`}
        tabIndex={0}
        className="stack"
      >
        {current === "members" ? (
          <MembersTab
            group={group}
            editable={editable}
            busy={busy}
            add={add}
            personChoices={personChoices}
            groupChoices={groupOptions}
            groupChoicesError={groupChoicesError}
            onAdd={onAdd}
            onShowMorePeople={onShowMorePeople}
            onSubmitAdd={onSubmitAdd}
            onRemove={onRemove}
          />
        ) : current === "member-of" ? (
          <MemberOfTab group={group} />
        ) : current === "managers" ? (
          <ManagersTab
            group={group}
            editable={editable}
            busy={busy}
            manager={manager}
            personChoices={personChoices}
            onManager={onManager}
            onShowMorePeople={onShowMorePeople}
            onSubmitManager={onSubmitManager}
            onRemoveManager={onRemoveManager}
          />
        ) : current === "roles" ? (
          <RolesTab
            group={group}
            editable={group.status === "active" && companyOwner}
            companyOwner={companyOwner}
            busy={busy}
            grant={grant}
            choices={roleChoices}
            choicesError={roleChoicesError}
            onGrant={onGrant}
            onSubmitGrant={onSubmitGrant}
            onRemoveRole={onRemoveRole}
          />
        ) : current === "where-used" ? (
          <WhereUsedTab group={group} />
        ) : (
          <AuditTab rows={group.audit} />
        )}
      </div>
      {editable && rename && (
        <section className="panel stack">
          <h3>Name and description</h3>
          <p className="muted">
            Everything refers to the group itself, so renaming it changes
            nothing else.
          </p>
          <form
            className="stack"
            aria-label="Rename group"
            onSubmit={onSubmitRename}
          >
            <label className="field">
              <span>Name</span>
              <input
                required
                maxLength={120}
                value={rename.name}
                onChange={(e) => onRename({ ...rename, name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Description (optional)</span>
              <input
                maxLength={500}
                value={rename.description}
                onChange={(e) =>
                  onRename({ ...rename, description: e.target.value })
                }
              />
            </label>
            <div className="row">
              <button type="submit" className="button" disabled={busy}>
                Rename
              </button>
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={onArchive}
              >
                Archive group
              </button>
            </div>
          </form>
        </section>
      )}
    </>
  );
}

function MembersTab({
  group,
  editable,
  busy,
  add,
  personChoices,
  groupChoices: groupOptions,
  groupChoicesError,
  onAdd,
  onShowMorePeople,
  onSubmitAdd,
  onRemove,
}: {
  group: GroupData;
  editable: boolean;
  busy: boolean;
  add: AddDraft;
  personChoices: PersonChoices | null;
  groupChoices: GroupRef[] | null;
  groupChoicesError: string;
  onAdd: (draft: AddDraft) => void;
  onShowMorePeople: () => void;
  onSubmitAdd: (event: FormEvent) => void;
  onRemove: (member: GroupMember, name: string) => void;
}) {
  const { members } = group;
  const direct = new Set(members.people.map((item) => item.userId));
  const people = personChoices?.rows.filter((row) => !direct.has(row.userId));
  const empty = !members.people.length && !members.groups.length;
  return (
    <section className="panel stack">
      <h3>Members</h3>
      <p className="muted">
        {count(members.people.length, "direct person", "direct people")} ·{" "}
        {count(members.groups.length, "nested group", "nested groups")} ·{" "}
        {peopleCount(group.people)} in total
      </p>
      {empty ? (
        <p className="muted">No members yet. Add people, or add a group.</p>
      ) : (
        <>
          <MemberTree
            members={members}
            through={null}
            editable={editable}
            busy={busy}
            onRemove={onRemove}
          />
          <p className="muted">
            People and groups shown through a nested group are removed in that
            nested group.
          </p>
        </>
      )}
      {editable && (
        <form
          className="stack"
          aria-label="Add a member"
          onSubmit={onSubmitAdd}
        >
          <h3>Add</h3>
          <fieldset className="row">
            <legend>Add a</legend>
            {(["person", "group"] as const).map((kind) => (
              <label key={kind} className="checkbox-label">
                <input
                  type="radio"
                  name="group-add-kind"
                  value={kind}
                  checked={add.kind === kind}
                  onChange={() => onAdd({ ...add, kind })}
                />
                {kind === "person" ? "Person" : "Group"}
              </label>
            ))}
          </fieldset>
          {add.kind === "person" ? (
            <>
              <label className="field">
                <span>Person</span>
                <select
                  required
                  value={add.userId}
                  onChange={(e) => onAdd({ ...add, userId: e.target.value })}
                >
                  <option value="">
                    {people ? "Choose a person" : "Loading people…"}
                  </option>
                  {(people ?? []).map((row) => (
                    <option key={row.userId} value={row.userId}>
                      {row.label}
                    </option>
                  ))}
                </select>
              </label>
              {personChoices?.error && (
                <p className="notice error" role="alert">
                  Could not load the people. {personChoices.error}
                </p>
              )}
              {personChoices?.nextCursor && (
                <div className="row">
                  <button
                    type="button"
                    className="button secondary"
                    onClick={onShowMorePeople}
                  >
                    Show more people
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <label className="field">
                <span>Group</span>
                <select
                  required
                  value={add.childGroupId}
                  onChange={(e) =>
                    onAdd({ ...add, childGroupId: e.target.value })
                  }
                >
                  <option value="">
                    {groupOptions ? "Choose a group" : "Loading groups…"}
                  </option>
                  {(groupOptions ?? []).map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
              </label>
              {groupChoicesError && (
                <p className="notice error" role="alert">
                  Could not load the groups. {groupChoicesError}
                </p>
              )}
            </>
          )}
          <p className="muted">
            Groups nest at most 3 levels: a group, its groups and their groups.
            A group cannot contain itself or a group that contains it.
          </p>
          <div className="row">
            <button type="submit" className="button" disabled={busy}>
              Add
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/**
 * Direct people and direct child groups; below a child group, its people and groups are marked
 * through that child and have no Remove control.
 */
function MemberTree({
  members,
  through,
  editable,
  busy,
  onRemove,
}: {
  members: GroupMembers;
  /** The direct child group the members come through; null for direct members. */
  through: string | null;
  editable: boolean;
  busy: boolean;
  onRemove: (member: GroupMember, name: string) => void;
}) {
  const end = (member: GroupMember, name: string) =>
    through !== null ? (
      <span className="muted">Through {through}</span>
    ) : (
      editable && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          aria-label={`Remove ${name}`}
          onClick={() => onRemove(member, name)}
        >
          Remove
        </button>
      )
    );
  return (
    <ul className="group-tree">
      {members.people.map((person) => {
        const name = person.name ?? person.email ?? "Not recorded";
        return (
          <li key={person.userId} className="group-tree-row">
            <Link
              href={`/app/admin/users/${encodeURIComponent(person.userId)}`}
            >
              {name}
            </Link>
            {person.email && <span className="muted">{person.email}</span>}
            {end({ userId: person.userId }, name)}
          </li>
        );
      })}
      {members.groups.map((child: GroupChild) => (
        <li key={child.id}>
          <div className="group-tree-row">
            <Link href={`/app/admin/groups/${encodeURIComponent(child.id)}`}>
              {child.name}
            </Link>
            <span className="muted">
              Group{child.status === "archived" ? " · Archived" : ""}
            </span>
            {end({ childGroupId: child.id }, child.name)}
          </div>
          <details open>
            <summary>Members of {child.name}</summary>
            {child.people.length || child.groups.length ? (
              <MemberTree
                members={child}
                through={through ?? child.name}
                editable={editable}
                busy={busy}
                onRemove={onRemove}
              />
            ) : (
              <p className="muted">No members.</p>
            )}
          </details>
        </li>
      ))}
    </ul>
  );
}

function MemberOfTab({ group }: { group: GroupData }) {
  return (
    <section className="panel stack">
      <h3>Member of</h3>
      <p className="muted">
        Everyone in {group.name} also counts as a member of these groups.
      </p>
      {!group.memberOf.length ? (
        <p className="muted">Not in any other group.</p>
      ) : (
        <div className="records-panel">
          <div className="table-wrap">
            <table className="data-table compact">
              <caption className="sr-only">
                Groups that contain this group
              </caption>
              <thead>
                <tr>
                  <th>Group</th>
                  <th>How</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {group.memberOf.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Group">
                      <Link
                        href={`/app/admin/groups/${encodeURIComponent(row.id)}`}
                      >
                        {row.name}
                      </Link>
                    </td>
                    <td data-label="How">
                      {row.via === null ? "Directly" : `Through ${row.via}`}
                    </td>
                    <td data-label="Status">{groupStatuses[row.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The delegated managers, by name; Add manager for a group that grants nothing, and Remove for
 * anyone who may change the group. A group that grants something has none to add.
 */
function ManagersTab({
  group,
  editable,
  busy,
  manager,
  personChoices,
  onManager,
  onShowMorePeople,
  onSubmitManager,
  onRemoveManager,
}: {
  group: GroupData;
  editable: boolean;
  busy: boolean;
  manager: string;
  personChoices: PersonChoices | null;
  onManager: (userId: string) => void;
  onShowMorePeople: () => void;
  onSubmitManager: (event: FormEvent) => void;
  onRemoveManager: (userId: string, name: string) => void;
}) {
  const named = new Set(group.managers.map((item) => item.userId));
  const people = personChoices?.rows.filter((row) => !named.has(row.userId));
  return (
    <section className="panel stack">
      <h3>Managers</h3>
      {group.grants ? (
        <p className="muted">{NO_MANAGERS_GRANTING}</p>
      ) : (
        <p className="muted">
          Managers can add and remove the people in this group from{" "}
          <strong>Groups I manage</strong> in their personal settings. They
          cannot change anything else.
        </p>
      )}
      {!group.managers.length ? (
        <p className="muted">No managers.</p>
      ) : (
        <ul className="group-tree">
          {group.managers.map((person) => {
            const name = person.name ?? person.email ?? "Not recorded";
            return (
              <li key={person.userId} className="group-tree-row">
                <Link
                  href={`/app/admin/users/${encodeURIComponent(person.userId)}`}
                >
                  {name}
                </Link>
                {person.email && <span className="muted">{person.email}</span>}
                {editable && (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    aria-label={`Remove ${name} as a manager`}
                    onClick={() => onRemoveManager(person.userId, name)}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editable && !group.grants && (
        <form
          className="stack"
          aria-label="Add a manager"
          onSubmit={onSubmitManager}
        >
          <label className="field">
            <span>Person</span>
            <select
              required
              value={manager}
              onChange={(e) => onManager(e.target.value)}
            >
              <option value="">
                {people ? "Choose a person" : "Loading people…"}
              </option>
              {(people ?? []).map((row) => (
                <option key={row.userId} value={row.userId}>
                  {row.label}
                </option>
              ))}
            </select>
          </label>
          {personChoices?.error && (
            <p className="notice error" role="alert">
              Could not load the people. {personChoices.error}
            </p>
          )}
          {personChoices?.nextCursor && (
            <div className="row">
              <button
                type="button"
                className="button secondary"
                onClick={onShowMorePeople}
              >
                Show more people
              </button>
            </div>
          )}
          <div className="row">
            <button type="submit" className="button" disabled={busy}>
              Add manager
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/**
 * The roles the group gives, by team name, with Remove and the Give a role form for a company owner
 * on a current group; anyone else reads them only.
 */
function RolesTab({
  group,
  editable,
  companyOwner,
  busy,
  grant,
  choices,
  choicesError,
  onGrant,
  onSubmitGrant,
  onRemoveRole,
}: {
  group: GroupData;
  editable: boolean;
  companyOwner: boolean;
  busy: boolean;
  grant: RoleGrantDraft;
  choices: GroupRoleChoices | null;
  choicesError: string;
  onGrant: (draft: RoleGrantDraft) => void;
  onSubmitGrant: (event: FormEvent) => void;
  onRemoveRole: (teamId: string, role: string, team: string) => void;
}) {
  const grants = group.whereUsed.flatMap((use) =>
    use.source === "role-grant" ? [use] : [],
  );
  const teams = choices ? grantTeamChoices(group, choices) : null;
  return (
    <section className="panel stack">
      <h3>Roles</h3>
      <p className="muted">{ROLES_HELP}</p>
      {!companyOwner && <p className="muted">{ROLES_OWNER_ONLY}</p>}
      {!grants.length ? (
        <p className="muted">{NO_ROLES}</p>
      ) : (
        <div className="records-panel">
          <div className="table-wrap">
            <table className="data-table compact">
              <caption className="sr-only">
                Roles this group gives, by team
              </caption>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Team</th>
                  {editable && (
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {grants.map((use) => (
                  <tr key={use.team.id}>
                    <td data-label="Role">{use.role.name}</td>
                    <td data-label="Team">{use.team.name}</td>
                    {editable && (
                      <td data-label="Actions">
                        <button
                          type="button"
                          className="button secondary"
                          disabled={busy}
                          aria-label={`Remove ${use.role.name} in ${use.team.name}`}
                          onClick={() =>
                            onRemoveRole(
                              use.team.id,
                              use.role.name,
                              use.team.name,
                            )
                          }
                        >
                          Remove
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {editable && (
        <form
          className="stack"
          aria-label="Give a role"
          onSubmit={onSubmitGrant}
        >
          <h3>Give a role</h3>
          <label className="field">
            <span>Team</span>
            <select
              required
              value={grant.teamId}
              onChange={(e) => onGrant({ ...grant, teamId: e.target.value })}
            >
              <option value="">
                {teams ? "Choose a team" : "Loading teams…"}
              </option>
              {(teams ?? []).map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Role</span>
            <select
              required
              value={grant.roleObjectId}
              onChange={(e) =>
                onGrant({ ...grant, roleObjectId: e.target.value })
              }
            >
              <option value="">
                {choices ? "Choose a role" : "Loading roles…"}
              </option>
              {(choices?.roles ?? []).map((role) => (
                <option key={role.roleObjectId} value={role.roleObjectId}>
                  {role.name} ({role.membership})
                </option>
              ))}
            </select>
          </label>
          {choicesError && (
            <p className="notice error" role="alert">
              Could not load the teams and roles. {choicesError}
            </p>
          )}
          <div className="row">
            <button type="submit" className="button" disabled={busy}>
              Give role
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** Every current use of the group, one section per source that has any; read-only. */
function WhereUsedTab({ group }: { group: GroupData }) {
  const parents = group.whereUsed.flatMap((use) =>
    use.source === "parent-group" ? [use] : [],
  );
  const grants = group.whereUsed.flatMap((use) =>
    use.source === "role-grant" ? [use] : [],
  );
  const sections = (Object.keys(USE_SOURCES) as GroupUse["source"][]).filter(
    (source) => (source === "parent-group" ? parents : grants).length,
  );
  return (
    <section className="panel stack">
      <h3>Where used</h3>
      <p className="muted">
        Everything that refers to {group.name}. Check this before archiving it.
      </p>
      {!sections.length ? (
        <p className="muted">{WHERE_USED_EMPTY}</p>
      ) : (
        sections.map((source) => (
          <div key={source} className="stack">
            <h4>{USE_SOURCES[source]}</h4>
            <div className="records-panel">
              <div className="table-wrap">
                <table className="data-table compact">
                  <caption className="sr-only">
                    {USE_SOURCES[source]} that use this group
                  </caption>
                  {source === "parent-group" ? (
                    <>
                      <thead>
                        <tr>
                          <th>Group</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parents.map((use) => (
                          <tr key={use.group.id}>
                            <td data-label="Group">
                              <Link
                                href={`/app/admin/groups/${encodeURIComponent(use.group.id)}`}
                              >
                                {use.group.name}
                              </Link>
                            </td>
                            <td data-label="Status">
                              {groupStatuses[use.group.status]}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  ) : (
                    <>
                      <thead>
                        <tr>
                          <th>Role</th>
                          <th>Team</th>
                        </tr>
                      </thead>
                      <tbody>
                        {grants.map((use) => (
                          <tr key={use.team.id}>
                            <td data-label="Role">{use.role.name}</td>
                            <td data-label="Team">{use.team.name}</td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                </table>
              </div>
            </div>
          </div>
        ))
      )}
    </section>
  );
}

/**
 * Archiving a group in use: one labelled choice per parent group and per role grant, removal or a
 * replacement, none chosen at first; Archive group stays disabled until every use has one, and a
 * refusal shows here with the choices kept.
 */
export function ArchiveDialogView({
  group,
  list,
  listError,
  draft,
  busy,
  onChoose,
  onCancel,
  onConfirm,
}: {
  group: Pick<GroupData, "id" | "name" | "whereUsed">;
  /** Null while the groups load. */
  list: GroupList | null;
  listError: string;
  draft: ArchiveDraft;
  busy: boolean;
  /** The use's key (archiveKey) and the choice. */
  onChoose: (key: string, value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const description = useId();
  const ready = archiveReplacements(group.whereUsed, draft.choices) !== null;
  return (
    <Dialog
      title={`Archive ${group.name}?`}
      onClose={onCancel}
      busy={busy}
      describedBy={description}
    >
      <div className="dialog-body stack">
        <p id={description}>
          {group.name} is used below. Choose what replaces it in each place, or
          remove it. {ARCHIVE_MESSAGE}
        </p>
        {draft.error && (
          <p className="notice error" role="alert">
            {draft.error}
          </p>
        )}
        {listError && (
          <p className="notice error" role="alert">
            Could not load the groups. {listError}
          </p>
        )}
        {group.whereUsed.map((use) => {
          const key = archiveKey(use);
          const replacements = !list
            ? []
            : use.source === "parent-group"
              ? replacementChoices(group.id, use.group.id, list)
              : list.data
                  .filter(
                    (row) => row.status === "active" && row.id !== group.id,
                  )
                  .map(({ id, name }) => ({ id, name }));
          return (
            <label key={key} className="field">
              <span>
                {use.source === "parent-group"
                  ? `In ${use.group.name}`
                  : `Role grant: ${use.role.name} in ${use.team.name}`}
              </span>
              <select
                required
                value={draft.choices[key] ?? ""}
                disabled={busy}
                onChange={(e) => onChoose(key, e.target.value)}
              >
                <option value="">
                  {list ? "Choose what replaces it" : "Loading groups…"}
                </option>
                <option value={REMOVE_FROM_PARENT}>
                  {use.source === "parent-group"
                    ? `Remove from ${use.group.name}`
                    : "Remove the grant"}
                </option>
                {replacements.map((row) => (
                  <option key={row.id} value={row.id}>
                    Replace with {row.name}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
      <footer className="dialog-footer">
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button danger"
          disabled={busy || !ready}
          onClick={onConfirm}
        >
          Archive group
        </button>
      </footer>
    </Dialog>
  );
}

function AuditTab({ rows }: { rows: GroupAuditRow[] }) {
  return (
    <section className="panel stack">
      <h3>Audit</h3>
      <p className="muted">{AUDIT_SCOPE}</p>
      {!rows.length ? (
        <p className="muted">No changes recorded from your current team.</p>
      ) : (
        <>
          <div className="records-panel">
            <div className="table-wrap">
              <table className="data-table compact">
                <caption className="sr-only">Changes, newest first</caption>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={`${row.occurredAt}:${index}`}>
                      <td data-label="When">
                        {formatDate(row.occurredAt, true)}
                      </td>
                      <td data-label="Who">
                        {row.actorName ?? "Not recorded"}
                      </td>
                      <td data-label="Change">{groupAuditLabel(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {rows.length >= AUDIT_LIMIT && (
            <p className="muted">Showing the latest 50 changes.</p>
          )}
        </>
      )}
    </section>
  );
}
