"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type Ref } from "react";
import type { WorkspacePeople } from "@/lib/admin-users";
import type { MeAccess } from "@/lib/authz";
import type {
  GroupAuditRow,
  GroupChild,
  GroupDetail as GroupData,
  GroupList,
  GroupMembers,
  GroupRef,
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
  "It keeps its members and stays in the groups it is in. An archived group cannot be changed or restored.";

/** A direct member: a person or a child group. */
export type GroupMember = { userId: string } | { childGroupId: string };
/** One change of the group, sent as its route expects. */
export type GroupChange =
  | { kind: "rename"; draft: GroupDraft }
  | { kind: "archive" }
  | { kind: "add"; member: GroupMember }
  | { kind: "remove"; member: GroupMember };
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
            body: JSON.stringify({ archived: true }),
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
        onArchive={() =>
          void change(
            { kind: "archive" },
            {
              title: `Archive ${group.name}?`,
              message: ARCHIVE_MESSAGE,
              confirmLabel: "Archive group",
              destructive: true,
            },
          )
        }
        onSubmitAdd={(event) => {
          event.preventDefault();
          const target = addTarget(add);
          if (target) void change({ kind: "add", member: target });
        }}
        onRemove={(target, name) =>
          void change({ kind: "remove", member: target }, member(target, name))
        }
      />
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
  const name = row.target?.name ?? "Not recorded";
  const kind = row.target?.kind;
  switch (row.action) {
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
    default:
      return "Changed what the group grants";
  }
}

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The loaded group: name, description, the three tabs and the open tab's panel, and the rename and
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
  onRename = () => {},
  onAdd = () => {},
  onShowMorePeople = () => {},
  onSubmitRename = (event) => event.preventDefault(),
  onArchive = () => {},
  onSubmitAdd = (event) => event.preventDefault(),
  onRemove = () => {},
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
  onRename?: (draft: GroupDraft) => void;
  onAdd?: (draft: AddDraft) => void;
  onShowMorePeople?: () => void;
  onSubmitRename?: (event: FormEvent) => void;
  onArchive?: () => void;
  onSubmitAdd?: (event: FormEvent) => void;
  onRemove?: (member: GroupMember, name: string) => void;
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
