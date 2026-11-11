"use client";

import { useEffect, useId, useState } from "react";
import type { MeAccess } from "@/lib/authz";
import type { JobArchitecture } from "@/lib/job-architecture";
import type { SalaryBracketVersion } from "@/lib/pay-brackets";
import { humanError } from "@/components/workspace/client";
import type { Requester } from "@/components/workspace/optimistic";
import {
  COVER_LABELS,
  PER_PERIOD,
  filsToAed,
  gradesInOrder,
  loadJobArchitecture,
  loadSalaryBrackets,
} from "./job-architecture-panel";

export interface JobTitleChoices {
  current: JobArchitecture | null;
  /** The published bracket version, for Plan & pay access holders only; null otherwise or when none. */
  brackets: SalaryBracketVersion | null;
}
/** A holder whose load found no published bracket version. */
export const NO_BRACKETS = "none";
export const UNPUBLISHED_TITLE = "(not in the published job architecture)";

/**
 * The published job titles and, only for Plan & pay access with plans:read, the published salary
 * bracket version; without the grant the brackets are never requested. Both stay in the picker's
 * own state, never in the URL, storage or the workspace data cache.
 */
export async function loadJobTitleChoices(
  request: Requester,
  access: Pick<MeAccess, "planAccess">,
): Promise<JobTitleChoices> {
  const [architecture, brackets] = await Promise.all([
    loadJobArchitecture(request),
    loadSalaryBrackets(request, access),
  ]);
  return {
    current: architecture.current,
    brackets: brackets?.current ?? null,
  };
}

/** "AED 12,345 to AED 18,000 a month, midpoint AED 15,000.50 · basic salary only · version 2". */
const bracketText = (
  version: SalaryBracketVersion,
  bracket: SalaryBracketVersion["brackets"][number],
) =>
  `Salary bracket: AED ${filsToAed(bracket.minimumFils)} to AED ${filsToAed(bracket.maximumFils)} ${PER_PERIOD[version.payPeriod].replace(/^AED /, "")}, midpoint AED ${filsToAed(bracket.midpointFils)} · ${COVER_LABELS[version.covers].toLowerCase()} · version ${version.number}`;

/**
 * A job title from the published job architecture, with the chosen title's grade and, only when
 * `brackets` is passed in, its salary bracket. A saved key that is no longer published stays
 * selected and is named as such; the server refuses it on a change.
 */
export function JobTitlePickerView({
  current,
  brackets = null,
  value,
  allowNone,
  readOnly = false,
  disabled = false,
  error = "",
  onChange = () => {},
}: {
  current: JobArchitecture | null;
  /** Holders only: the published version, or NO_BRACKETS when none is published. */
  brackets?: SalaryBracketVersion | typeof NO_BRACKETS | null;
  value: string;
  allowNone: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  /** A refusal of the chosen title, shown under the select. */
  error?: string;
  onChange?: (key: string) => void;
}) {
  const id = useId();
  if (!current)
    return (
      <div className="field">
        <p className="muted">
          No job architecture is published yet, so no job title can be chosen.
        </p>
        {value && (
          <p>
            <span className="muted">Job title:</span> {value}
          </p>
        )}
      </div>
    );
  const titles = [...current.body.titles].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const title = titles.find((item) => item.key === value) ?? null;
  const grade = title
    ? gradesInOrder(current.body).find((item) => item.code === title.gradeCode)
    : undefined;
  const bracket =
    title && brackets && brackets !== NO_BRACKETS
      ? brackets.brackets.find((item) => item.gradeCode === title.gradeCode)
      : undefined;
  const details = (
    <div
      id={`${id}-details`}
      aria-live="polite"
      className="stack"
      style={{ gap: 4 }}
    >
      {title ? (
        <>
          <p className="small-text">
            {`Grade: ${title.gradeCode} · ${grade?.name ?? ""}`}
          </p>
          {brackets && (
            <p className="small-text">
              {brackets === NO_BRACKETS
                ? "No salary brackets are published yet."
                : bracket
                  ? bracketText(brackets, bracket)
                  : "No salary bracket for this grade."}
            </p>
          )}
        </>
      ) : (
        !value && <p className="small-text">No job title chosen.</p>
      )}
    </div>
  );
  if (readOnly)
    return (
      <div className="field">
        {value && (
          <p>
            <span className="muted">Job title:</span>{" "}
            {title ? title.name : `${value} ${UNPUBLISHED_TITLE}`}
          </p>
        )}
        {details}
      </div>
    );
  return (
    <div className="field">
      <label htmlFor={id}>Job title</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-invalid={!!error}
        aria-describedby={`${id}-details${error ? ` ${id}-error` : ""}`}
        onChange={(event) => onChange(event.target.value)}
      >
        {allowNone && <option value="">No job title</option>}
        {value && !title && (
          <option value={value}>{`${value} ${UNPUBLISHED_TITLE}`}</option>
        )}
        {titles.map((item) => (
          <option key={item.key} value={item.key}>
            {`${item.name} · ${item.gradeCode}`}
          </option>
        ))}
      </select>
      {details}
      {error && (
        <span id={`${id}-error`} className="field-error">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * The picker for the position form and the vacancy editor. It waits for the caller's access, then
 * loads the choices once per requester and grant answer, into its own state only.
 */
export function JobTitlePicker({
  request,
  access,
  value,
  onChange,
  allowNone,
  readOnly = false,
  disabled = false,
  error = "",
}: {
  request: Requester;
  access: Pick<MeAccess, "planAccess"> | null | undefined;
  value: string;
  onChange: (key: string) => void;
  allowNone: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  error?: string;
}) {
  const holder = access ? access.planAccess.read : null;
  const [choices, setChoices] = useState<JobTitleChoices | null>(null);
  const [loadError, setLoadError] = useState("");
  // Another team or another grant answer starts again with nothing held.
  const [loadedFor, setLoadedFor] = useState(() => ({ request, holder }));
  if (loadedFor.request !== request || loadedFor.holder !== holder) {
    setLoadedFor({ request, holder });
    setChoices(null);
    setLoadError("");
  }
  useEffect(() => {
    if (holder === null) return;
    let active = true;
    // Only the read answer decides whether brackets are requested.
    loadJobTitleChoices(request, { planAccess: { read: holder, write: false } })
      .then((found) => {
        if (active) setChoices(found);
      })
      .catch((e) => {
        if (active) setLoadError(humanError(e));
      });
    return () => {
      active = false;
    };
  }, [request, holder]);
  if (loadError)
    return (
      <p className="notice error" role="alert">
        Could not load the job titles. {loadError}
      </p>
    );
  if (!choices) return <p role="status">Loading job titles…</p>;
  return (
    <JobTitlePickerView
      current={choices.current}
      brackets={holder ? (choices.brackets ?? NO_BRACKETS) : null}
      value={value}
      allowNone={allowNone}
      readOnly={readOnly}
      disabled={disabled}
      error={error}
      onChange={onChange}
    />
  );
}
