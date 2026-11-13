"use client";

import { useEffect, useRef, useState, type FormEvent, type Ref } from "react";
import { UsersRound } from "lucide-react";
import type { ManagedGroup } from "@/lib/groups";
import {
  requestJson,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { plainError } from "./roles-tab";
import { SettingsNavigation, useAdminPortalLink } from "./settings-navigation";

export const NO_MANAGED_GROUPS = "You do not manage any groups.";
export const MANAGED_GRANTING =
  "Only a company owner can change this group now, because it or a group it is in grants access.";

/** A manager's change: {email} adds that person, {userId} removes them. */
export function sendManagedChange(
  teamId: string,
  groupId: string,
  change: { email: string } | { userId: string },
) {
  return requestJson(
    teamId,
    `/api/v1/me/groups/${encodeURIComponent(groupId)}/members`,
    {
      method: "email" in change ? "POST" : "DELETE",
      body: JSON.stringify(change),
    },
  );
}

/**
 * Personal settings > Groups I manage, for any signed-in member: the current groups of the
 * current team's company they manage (GET /api/v1/me/groups), adding a person by email and
 * removing one. A group that grants something is read-only. Nothing here needs a recent sign-in,
 * since a manager never changes a group that grants something.
 */
export function ManagedGroups() {
  const { team } = useWorkspace();
  const adminPortal = useAdminPortalLink();
  const result = useApi<{ data: ManagedGroup[] }>(
    team ? "/api/v1/me/groups" : null,
  );
  const groups = result.data?.data ?? null;
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState({ error: "", notice: "" });
  const { confirm, dialog } = useConfirm();
  const outcomeRef = useRef<HTMLDivElement>(null);
  const [outcomeFocus, setOutcomeFocus] = useState(0);
  useEffect(() => {
    if (outcomeFocus) outcomeRef.current?.focus();
  }, [outcomeFocus]);

  /** One change: its outcome or refusal in plain words, focused; a refusal keeps the email typed. */
  async function send(
    groupId: string,
    change: { email: string } | { userId: string },
    notice: string,
  ) {
    if (!team || busy) return;
    setBusy(true);
    setOutcome({ error: "", notice: "" });
    try {
      await sendManagedChange(team.id, groupId, change);
      if ("email" in change) setEmails((all) => ({ ...all, [groupId]: "" }));
      setOutcome({ error: "", notice });
      result.refresh();
    } catch (e) {
      setOutcome({ error: plainError(e), notice: "" });
    } finally {
      setBusy(false);
    }
    setOutcomeFocus((count) => count + 1);
  }

  return (
    <div className="stack settings-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Workspace settings</p>
          <h1>Groups I manage</h1>
          <p className="muted">
            Add and remove the people in the company groups you manage. You
            cannot change anything else about them.
          </p>
        </div>
        <UsersRound size={28} aria-hidden="true" />
      </header>
      <SettingsNavigation
        active="groups"
        adminPortal={adminPortal}
        managedGroups={!result.error && !!groups?.length}
      />
      <ManagedGroupsView
        groups={groups}
        error={result.error}
        busy={busy}
        emails={emails}
        outcome={outcome}
        outcomeRef={outcomeRef}
        onEmail={(groupId, email) =>
          setEmails((all) => ({ ...all, [groupId]: email }))
        }
        onAdd={(event, group) => {
          event.preventDefault();
          const email = (emails[group.id] ?? "").trim();
          if (email) void send(group.id, { email }, "Added to the group.");
        }}
        onRemove={async (group, userId, name) => {
          if (
            await confirm({
              title: `Remove ${name}?`,
              message: `${name} is removed from ${group.name}.`,
              confirmLabel: "Remove",
              destructive: true,
            })
          )
            void send(group.id, { userId }, "Removed from the group.");
        }}
      />
      {dialog}
    </div>
  );
}

/** The managed groups as panels: name, description, direct people with Remove, and Add a person. */
export function ManagedGroupsView({
  groups,
  error,
  busy = false,
  emails = {},
  outcome = { error: "", notice: "" },
  outcomeRef,
  onEmail = () => {},
  onAdd = (event) => event.preventDefault(),
  onRemove = () => {},
}: {
  /** Null while the groups load. */
  groups: ManagedGroup[] | null;
  error: string;
  busy?: boolean;
  /** The email typed in each group's Add a person form, by group id. */
  emails?: Record<string, string>;
  outcome?: { error: string; notice: string };
  outcomeRef?: Ref<HTMLDivElement>;
  onEmail?: (groupId: string, email: string) => void;
  onAdd?: (event: FormEvent, group: ManagedGroup) => void;
  onRemove?: (group: ManagedGroup, userId: string, name: string) => void;
}) {
  if (error)
    return (
      <p className="notice error" role="alert">
        Could not load your groups. {error}
      </p>
    );
  if (!groups) return <p role="status">Loading your groups…</p>;
  if (!groups.length)
    return (
      <section className="panel">
        <p>{NO_MANAGED_GROUPS}</p>
      </section>
    );
  return (
    <>
      {outcome.error ? (
        <div
          ref={outcomeRef}
          tabIndex={-1}
          className="notice error"
          role="alert"
        >
          {outcome.error}
        </div>
      ) : (
        outcome.notice && (
          <div
            ref={outcomeRef}
            tabIndex={-1}
            className="notice success"
            role="status"
          >
            {outcome.notice}
          </div>
        )
      )}
      {groups.map((group) => (
        <section key={group.id} className="panel stack">
          <h2>{group.name}</h2>
          {group.description && <p className="muted">{group.description}</p>}
          {group.grants && <p className="muted">{MANAGED_GRANTING}</p>}
          {!group.people.length ? (
            <p className="muted">No people in this group yet.</p>
          ) : (
            <ul className="group-tree">
              {group.people.map((person) => {
                const name = person.name ?? person.email ?? "Not recorded";
                return (
                  <li key={person.userId} className="group-tree-row">
                    <span>{name}</span>
                    {person.email && (
                      <span className="muted">{person.email}</span>
                    )}
                    {!group.grants && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        aria-label={`Remove ${name} from ${group.name}`}
                        onClick={() => onRemove(group, person.userId, name)}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {!group.grants && (
            <form
              className="stack"
              aria-label={`Add a person to ${group.name}`}
              onSubmit={(event) => onAdd(event, group)}
            >
              <h3>Add a person</h3>
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  required
                  maxLength={254}
                  autoComplete="off"
                  value={emails[group.id] ?? ""}
                  onChange={(e) => onEmail(group.id, e.target.value)}
                />
              </label>
              <p className="muted">
                They must already be in a team of your company.
              </p>
              <div className="row">
                <button type="submit" className="button" disabled={busy}>
                  Add
                </button>
              </div>
            </form>
          )}
        </section>
      ))}
    </>
  );
}
