"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type Ref } from "react";
import type { Group, GroupList, GroupListRow } from "@/lib/groups";
import {
  requestJson,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";
import { NO_ACCESS } from "./admin-tabs";
import { plainError } from "./roles-tab";

export type { GroupList, GroupListRow };
export const GROUPS_HELP = "Groups decide who; teams hold the data.";
export const COMPUTED_READ_ONLY =
  "Computed groups are worked out from company authority and team membership, so they cannot be changed here.";
export const groupStatuses: Record<GroupListRow["status"], string> = {
  active: "Active",
  archived: "Archived",
};
export type GroupDraft = { name: string; description: string };
export const peopleCount = (count: number) =>
  `${count} ${count === 1 ? "person" : "people"}`;

/** Admin > Groups: GET /api/v1/admin/groups, and Create group. */
export function GroupsTab() {
  const { team } = useWorkspace();
  const teamId = team?.id ?? null;
  const list = useApi<GroupList>(teamId ? "/api/v1/admin/groups" : null);
  const [draft, setDraft] = useState<GroupDraft>({ name: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState({ error: "", notice: "" });
  const outcomeRef = useRef<HTMLDivElement>(null);
  const [outcomeFocus, setOutcomeFocus] = useState(0);
  // The outcome replaces the last one, so focus moves to it and a screen reader reads it.
  useEffect(() => {
    if (outcomeFocus) outcomeRef.current?.focus();
  }, [outcomeFocus]);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!teamId || busy) return;
    setBusy(true);
    setOutcome({ error: "", notice: "" });
    try {
      const { data } = await requestJson<{ data: Group }>(
        teamId,
        "/api/v1/admin/groups",
        { method: "POST", body: JSON.stringify(createBody(draft)) },
      );
      setDraft({ name: "", description: "" });
      setOutcome({ error: "", notice: `${data.name} was created.` });
      list.refresh();
    } catch (e) {
      // The form keeps what was typed.
      setOutcome({ error: plainError(e), notice: "" });
    } finally {
      setBusy(false);
      setOutcomeFocus((count) => count + 1);
    }
  }
  return (
    <GroupsPanel
      list={list.data}
      error={list.error}
      denied={list.status === 403}
      draft={draft}
      busy={busy}
      createError={outcome.error}
      notice={outcome.notice}
      outcomeRef={outcomeRef}
      onDraft={setDraft}
      onCreate={(event) => void create(event)}
    />
  );
}

/** The Create group body: the name, and the description only when one is typed. */
export function createBody(draft: GroupDraft) {
  return draft.description.trim()
    ? { name: draft.name, description: draft.description }
    : { name: draft.name };
}

/**
 * The Groups page: the help text, Create group, the company groups by name with their people,
 * nesting and status, and the computed groups, which are read only.
 */
export function GroupsPanel({
  list,
  error,
  denied = false,
  draft,
  busy = false,
  createError = "",
  notice = "",
  outcomeRef,
  onDraft = () => {},
  onCreate = (event) => event.preventDefault(),
}: {
  /** Null while it loads or after it failed. */
  list: GroupList | null;
  error: string;
  /** The route refused the caller (403). */
  denied?: boolean;
  draft: GroupDraft;
  busy?: boolean;
  createError?: string;
  notice?: string;
  outcomeRef?: Ref<HTMLDivElement>;
  onDraft?: (draft: GroupDraft) => void;
  onCreate?: (event: FormEvent) => void;
}) {
  if (denied)
    return (
      <section className="panel stack">
        <h2>Groups</h2>
        <p>{NO_ACCESS}</p>
      </section>
    );
  return (
    <>
      <section className="panel stack">
        <h2>Groups</h2>
        <p>
          <strong>{GROUPS_HELP}</strong>
        </p>
        <p className="muted">
          Company groups hold people from any team and other groups, nested at
          most 3 levels. They never hold records.
        </p>
        {error ? (
          <p className="notice error" role="alert">
            Could not load the groups. {error}
          </p>
        ) : !list ? (
          <p role="status">Loading groups…</p>
        ) : !list.data.length ? (
          <p className="muted">There are no groups yet.</p>
        ) : (
          <div className="records-panel">
            <div className="table-wrap">
              <table className="data-table compact">
                <caption className="sr-only">Company groups, by name</caption>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Description</th>
                    <th>Members</th>
                    <th>Member of</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.map((row) => (
                    <tr key={row.id}>
                      <td data-label="Name">
                        <Link
                          href={`/app/admin/groups/${encodeURIComponent(row.id)}`}
                        >
                          {row.name}
                        </Link>
                      </td>
                      <td data-label="Description">
                        {row.description ?? "None"}
                      </td>
                      <td data-label="Members">
                        <div>
                          {peopleCount(row.people)} · {row.directPeople} direct
                        </div>
                        {row.childGroups.length > 0 && (
                          <div className="muted">
                            Includes:{" "}
                            {row.childGroups
                              .map((item) => item.name)
                              .join(", ")}
                          </div>
                        )}
                      </td>
                      <td data-label="Member of">
                        {row.parentGroups.length
                          ? row.parentGroups.map((item) => item.name).join(", ")
                          : "None"}
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
      <CreateGroupPanel
        draft={draft}
        busy={busy}
        error={createError}
        notice={notice}
        outcomeRef={outcomeRef}
        onDraft={onDraft}
        onCreate={onCreate}
      />
      {list && <ComputedGroupsPanel computed={list.computed} />}
    </>
  );
}

function CreateGroupPanel({
  draft,
  busy,
  error,
  notice,
  outcomeRef,
  onDraft,
  onCreate,
}: {
  draft: GroupDraft;
  busy: boolean;
  error: string;
  notice: string;
  outcomeRef?: Ref<HTMLDivElement>;
  onDraft: (draft: GroupDraft) => void;
  onCreate: (event: FormEvent) => void;
}) {
  return (
    <section className="panel stack">
      <h2>Create group</h2>
      <form className="stack" onSubmit={onCreate}>
        <label className="field">
          <span>Name</span>
          <input
            required
            maxLength={120}
            value={draft.name}
            onChange={(e) => onDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Description (optional)</span>
          <input
            maxLength={500}
            value={draft.description}
            onChange={(e) => onDraft({ ...draft, description: e.target.value })}
          />
        </label>
        <div className="row">
          <button type="submit" className="button" disabled={busy}>
            {busy ? "Creating group…" : "Create group"}
          </button>
        </div>
      </form>
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
    </section>
  );
}

/** Text only: no link, button or form control for a computed group. */
function ComputedGroupsPanel({
  computed,
}: {
  computed: GroupList["computed"];
}) {
  return (
    <section className="panel stack">
      <h2>Computed groups</h2>
      <p className="muted">{COMPUTED_READ_ONLY}</p>
      <div className="records-panel">
        <div className="table-wrap">
          <table className="data-table compact">
            <caption className="sr-only">Computed groups</caption>
            <thead>
              <tr>
                <th>Name</th>
                <th>People</th>
              </tr>
            </thead>
            <tbody>
              {computed.map((row) => (
                <tr key={row.key}>
                  <td data-label="Name">{row.name}</td>
                  <td data-label="People">{peopleCount(row.people)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
