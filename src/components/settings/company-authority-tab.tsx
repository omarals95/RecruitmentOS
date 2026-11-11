"use client";

import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { authClient } from "@/lib/auth-client";
import type { CompanyAuthorityHolder } from "@/lib/company-authority";
import { GRANTABLE_ADMIN_AREAS } from "@/domain/config";
import {
  humanError,
  requestJson,
  useApi,
  useWorkspace,
} from "@/components/workspace/client";
import { formatDate } from "@/components/workspace/helpers";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { REAUTH_CANCELLED, useFreshSession } from "./fresh-session-dialog";
import { actionRow, box, checks, plainError, useFocusAfter } from "./roles-tab";

export type GrantableArea = (typeof GRANTABLE_ADMIN_AREAS)[number];
export type AuthorityGrant =
  | { userId: string; level: null }
  | {
      userId: string;
      level: "owner" | "admin";
      areas: GrantableArea[];
      planAccess: boolean;
    };
export type AuthorityLevel = "" | "owner" | "admin";
export interface TeamPerson {
  userId: string;
  name: string;
}

const LAST_OWNER =
  "The last company owner cannot be removed. Make someone else a company owner first.";
/** What Plan & pay access opens: the confidential figures exist only once they are built. */
const PLAN_PAY_HINT =
  "For confidential recruitment plan figures and salary brackets. Neither exists yet, so this opens nothing today. Only a company owner gives it, one person at a time.";
const areaLabels: Record<GrantableArea, string> = {
  fields: "Record fields",
  workflows: "Workflows",
  boards: "Boards",
  organisation: "Organisation",
  templates: "Templates",
  people: "People",
};
const areaHints: Partial<Record<GrantableArea, string>> = {
  people:
    "Shows the names and email addresses of everyone in every team of the company, with their teams and roles.",
};

/** Admin > Company authority: company owners and admins, for company owners only. */
export function CompanyAuthorityTab({
  onAccessChanged,
}: {
  onAccessChanged: () => void;
}) {
  const { team, user } = useWorkspace();
  const teamId = team?.id ?? null;
  const holders = useApi<{ data: CompanyAuthorityHolder[] }>(
    teamId ? "/api/v1/company-authority" : null,
  );
  const [members, setMembers] = useState<TeamPerson[] | null>(null);
  const [memberError, setMemberError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { confirm, dialog } = useConfirm();
  const freshSession = useFreshSession();
  const [noticeRef, focusNotice] = useFocusAfter<HTMLParagraphElement>();
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
            list.map((item) => ({ userId: item.userId, name: item.user.name })),
          );
      })
      .catch((e) => {
        if (active) setMemberError(humanError(e));
      });
    return () => {
      active = false;
    };
  }, [teamId]);
  async function submit(grant: AuthorityGrant, name: string) {
    if (
      grant.level === null &&
      !(await confirm({
        title: "Remove company authority?",
        message: `Remove ${name}'s company authority? They keep their team roles, but lose every company area and Plan & pay access.`,
        confirmLabel: "Remove authority",
        destructive: true,
      }))
    )
      return;
    if (busy || !teamId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await freshSession.withFreshSession(() =>
        requestJson<{ data: { changed: boolean } }>(
          teamId,
          "/api/v1/company-authority",
          { method: "POST", body: JSON.stringify(grant) },
        ),
      );
      // A cancelled re-authentication sent nothing: the form stays as it was, with no message.
      if (result === REAUTH_CANCELLED) return;
      // The row's button may be gone after the change, so focus moves to the outcome.
      focusNotice();
      setNotice(
        !result.data.changed
          ? "Nothing changed."
          : grant.level === null
            ? "Company authority removed."
            : "Company authority saved.",
      );
      if (result.data.changed && grant.userId === user.id) onAccessChanged();
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <CompanyAuthorityPanel
        holders={holders.data?.data ?? null}
        members={members}
        error={holders.error || memberError}
        actionError={error}
        notice={notice}
        noticeRef={noticeRef}
        busy={busy}
        currentUserId={user.id}
        onSubmit={(grant, name) => void submit(grant, name)}
      />
      {dialog}
      {freshSession.dialog}
    </>
  );
}

/** Level, areas and Plan & pay access in standard controls, offering only grants the helper accepts. */
export function AuthorityFields({
  level,
  areas,
  planAccess,
  lastOwner,
  disabled = false,
  onChange,
}: {
  level: AuthorityLevel;
  areas: GrantableArea[];
  planAccess: boolean;
  lastOwner: boolean;
  disabled?: boolean;
  onChange: (next: {
    level: AuthorityLevel;
    areas: GrantableArea[];
    planAccess: boolean;
  }) => void;
}) {
  const hint = useId();
  return (
    <>
      <label className="field">
        <span>Company level</span>
        <select
          value={level}
          disabled={disabled}
          aria-describedby={lastOwner ? hint : undefined}
          onChange={(e) =>
            onChange({
              level: e.target.value as AuthorityLevel,
              areas: e.target.value === "admin" ? areas : [],
              planAccess: e.target.value ? planAccess : false,
            })
          }
        >
          <option value="" disabled={lastOwner}>
            No company authority
          </option>
          <option value="admin" disabled={lastOwner}>
            Company admin
          </option>
          <option value="owner">Company owner</option>
        </select>
        {lastOwner && (
          <small id={hint} className="muted">
            {LAST_OWNER}
          </small>
        )}
      </label>
      {level === "admin" && (
        <fieldset style={box} disabled={disabled}>
          <legend>Areas</legend>
          <div style={checks}>
            {GRANTABLE_ADMIN_AREAS.map((area) => {
              const areaHint = areaHints[area];
              const checkbox = (
                <label key={area} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={areas.includes(area)}
                    aria-describedby={areaHint ? `${hint}-${area}` : undefined}
                    onChange={(e) =>
                      onChange({
                        level,
                        planAccess,
                        areas: GRANTABLE_ADMIN_AREAS.filter((item) =>
                          item === area
                            ? e.target.checked
                            : areas.includes(item),
                        ),
                      })
                    }
                  />
                  {areaLabels[area]}
                </label>
              );
              // An area with a description takes its own line, the description under its checkbox.
              return areaHint ? (
                <div key={area} style={{ flexBasis: "100%" }}>
                  {checkbox}
                  <small id={`${hint}-${area}`} className="muted">
                    {areaHint}
                  </small>
                </div>
              ) : (
                checkbox
              );
            })}
          </div>
        </fieldset>
      )}
      {level !== "" && (
        <div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              role="switch"
              checked={planAccess}
              disabled={disabled}
              aria-describedby={`${hint}-plan`}
              onChange={(e) =>
                onChange({ level, areas, planAccess: e.target.checked })
              }
            />
            Plan & pay access
          </label>
          <small id={`${hint}-plan`} className="muted">
            {PLAN_PAY_HINT}
          </small>
        </div>
      )}
    </>
  );
}

const areasText = (holder: CompanyAuthorityHolder) =>
  holder.level === "owner"
    ? "All areas"
    : holder.areas.length
      ? holder.areas
          .map((area) =>
            Object.hasOwn(areaLabels, area)
              ? areaLabels[area as GrantableArea]
              : area,
          )
          .join(", ")
      : "No areas";
const grantOf = (holder: CompanyAuthorityHolder): AuthorityGrant => ({
  userId: holder.userId,
  level: holder.level,
  areas:
    holder.level === "owner"
      ? []
      : GRANTABLE_ADMIN_AREAS.filter((area) => holder.areas.includes(area)),
  planAccess: holder.planAccess,
});

/** Holders of company authority, and a form to grant, change or remove it. */
export function CompanyAuthorityPanel({
  holders,
  members,
  error,
  actionError = "",
  notice = "",
  noticeRef,
  busy = false,
  currentUserId,
  onSubmit = () => {},
}: {
  holders: CompanyAuthorityHolder[] | null;
  /** The current team's members. */
  members: TeamPerson[] | null;
  error: string;
  actionError?: string;
  notice?: string;
  noticeRef?: RefObject<HTMLParagraphElement | null>;
  busy?: boolean;
  currentUserId: string;
  onSubmit?: (grant: AuthorityGrant, name: string) => void;
}) {
  const [person, setPerson] = useState("");
  const [choice, setChoice] = useState<{
    level: AuthorityLevel;
    areas: GrantableArea[];
    planAccess: boolean;
  }>({ level: "", areas: [], planAccess: false });
  const activeOwners = (holders ?? []).filter(
    (holder) => holder.level === "owner" && !holder.suspended,
  );
  const lastOwnerId = activeOwners.length === 1 ? activeOwners[0].userId : null;
  const nameOf = (holder: { name: string | null }) =>
    holder.name ?? "Name not recorded";
  const people = new Map<string, string>();
  for (const member of members ?? []) people.set(member.userId, member.name);
  for (const holder of holders ?? [])
    if (!people.has(holder.userId)) people.set(holder.userId, nameOf(holder));
  const options = [...people.entries()].sort((a, b) =>
    a[1].localeCompare(b[1]),
  );
  function choosePerson(userId: string) {
    setPerson(userId);
    const holder = holders?.find((item) => item.userId === userId);
    const grant = holder ? grantOf(holder) : null;
    setChoice(
      grant?.level
        ? {
            level: grant.level,
            areas: grant.areas,
            planAccess: grant.planAccess,
          }
        : { level: "", areas: [], planAccess: false },
    );
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!person) return;
    onSubmit(
      choice.level === ""
        ? { userId: person, level: null }
        : {
            userId: person,
            level: choice.level,
            areas: choice.level === "admin" ? choice.areas : [],
            planAccess: choice.planAccess,
          },
      people.get(person) ?? "this person",
    );
  }
  return (
    <section className="panel stack">
      <h2>Company authority</h2>
      <p className="muted">
        Company owners manage roles, company authority and every company area.
        Company admins manage only the areas they are given. Only company owners
        see this page, and every change is recorded in the activity of your
        team.
      </p>
      <p className="muted">
        Company owners and admins must use two-step sign-in. Someone shown with
        two-step Off is asked to set it up at their next sign-in, and cannot be
        given a level until they do.
      </p>
      {actionError && (
        <p className="notice error" role="alert">
          {actionError}
        </p>
      )}
      {notice && (
        <p
          ref={noticeRef}
          tabIndex={-1}
          className="notice success"
          role="status"
        >
          {notice}
        </p>
      )}
      {error ? (
        <p className="notice error" role="alert">
          Could not load company authority. {error}
        </p>
      ) : !holders || !members ? (
        <p role="status">Loading company authority…</p>
      ) : (
        <>
          {/* The record screens' phone layout: one labelled card per holder at 720 px and below. */}
          <div className="records-panel">
            <div className="table-wrap">
              <table className="data-table compact">
                <caption className="sr-only">Company owners and admins</caption>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Level</th>
                    <th>Areas</th>
                    <th>Plan & pay access</th>
                    <th>Two-step</th>
                    <th>Since</th>
                    <th>Status</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {holders.map((holder) => {
                    const last = holder.userId === lastOwnerId;
                    return (
                      <tr key={holder.userId}>
                        <td data-label="Name">
                          {nameOf(holder)}
                          {holder.userId === currentUserId && " (you)"}
                        </td>
                        <td data-label="Level">
                          {holder.level === "owner"
                            ? "Company owner"
                            : "Company admin"}
                        </td>
                        <td data-label="Areas">{areasText(holder)}</td>
                        <td data-label="Plan & pay access">
                          {holder.planAccess ? "Yes" : "No"}
                        </td>
                        <td data-label="Two-step">
                          {holder.twoStep ? "On" : "Off"}
                        </td>
                        <td data-label="Since">{formatDate(holder.since)}</td>
                        <td data-label="Status">
                          {holder.suspended
                            ? "Suspended: left every team of this company"
                            : "Active"}
                        </td>
                        <td data-label="Actions">
                          <div className="row" style={actionRow}>
                            {holder.suspended && (
                              <button
                                type="button"
                                className="button secondary"
                                disabled={busy}
                                onClick={() =>
                                  onSubmit(grantOf(holder), nameOf(holder))
                                }
                              >
                                Restore authority
                              </button>
                            )}
                            <button
                              type="button"
                              className="button secondary"
                              disabled={busy || last}
                              onClick={() =>
                                onSubmit(
                                  { userId: holder.userId, level: null },
                                  nameOf(holder),
                                )
                              }
                            >
                              Remove
                            </button>
                          </div>
                          {last && (
                            <small className="muted">{LAST_OWNER}</small>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <form className="stack" style={box} onSubmit={submit}>
            <h3>Grant or change company authority</h3>
            <label className="field">
              <span>Person</span>
              <select
                value={person}
                disabled={busy}
                onChange={(e) => choosePerson(e.target.value)}
              >
                <option value="">Choose a person</option>
                {options.map(([userId, name]) => (
                  <option key={userId} value={userId}>
                    {name}
                    {userId === currentUserId ? " (you)" : ""}
                  </option>
                ))}
              </select>
              <small className="muted">
                Members of this team and everyone who already holds company
                authority.
              </small>
            </label>
            {person && (
              <AuthorityFields
                {...choice}
                lastOwner={person === lastOwnerId}
                disabled={busy}
                onChange={setChoice}
              />
            )}
            <div>
              <button
                type="submit"
                className="button"
                disabled={busy || !person}
              >
                Save company authority
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
