"use client";

import { useEffect, useId, useState } from "react";
import { z } from "zod";
import { CANDIDATE_DUPLICATE_LIMIT } from "@/domain/records";
import { humanError, requestJson, useDebounced } from "./client";

export type DuplicateMatch = {
  id: string;
  name: string;
  email: string;
  phone: string;
  matches: string[];
};
export type DuplicateLookup =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "error"; message: string }
  | { status: "result"; matches: DuplicateMatch[]; limited: boolean };

const emailSchema = z.email().max(320);

/** Contact details complete enough for an exact duplicate lookup, or null. */
export function duplicateQuery(
  email: unknown,
  phone: unknown,
): { email?: string; phone?: string } | null {
  const query: { email?: string; phone?: string } = {};
  const trimmedEmail = typeof email === "string" ? email.trim() : "";
  if (emailSchema.safeParse(trimmedEmail).success) query.email = trimmedEmail;
  const trimmedPhone = typeof phone === "string" ? phone.trim() : "";
  if (trimmedPhone.replace(/\D/g, "").length >= 7) query.phone = trimmedPhone;
  return query.email || query.phone ? query : null;
}

const queryKey = (email: unknown, phone: unknown) => {
  const query = duplicateQuery(email, phone);
  return query ? JSON.stringify(query) : "";
};

/** Looks up possible duplicates as contact details are typed; never blocks saving. */
export function useDuplicateLookup(
  teamId: string | null,
  enabled: boolean,
  email: unknown,
  phone: unknown,
): DuplicateLookup {
  const active = enabled && !!teamId;
  const current = active ? queryKey(email, phone) : "";
  const debouncedEmail = useDebounced(email);
  const debouncedPhone = useDebounced(phone);
  const settled = active ? queryKey(debouncedEmail, debouncedPhone) : "";
  const [result, setResult] = useState<{
    key: string;
    lookup: DuplicateLookup;
  } | null>(null);
  useEffect(() => {
    if (!settled || !teamId) return;
    // Aborting on a query change or unmount drops any older lookup's result.
    const controller = new AbortController();
    requestJson<{ data: DuplicateMatch[]; limited: boolean }>(
      teamId,
      "/api/v1/candidates/duplicates",
      { method: "POST", signal: controller.signal, body: settled },
    )
      .then((response) => {
        if (!controller.signal.aborted)
          setResult({
            key: settled,
            lookup: {
              status: "result",
              matches: response.data,
              limited: response.limited,
            },
          });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            key: settled,
            lookup: { status: "error", message: humanError(error) },
          });
      });
    return () => controller.abort();
  }, [teamId, settled]);
  if (!current) return { status: "idle" };
  return result?.key === current ? result.lookup : { status: "checking" };
}

export function DuplicateWarning({
  lookup,
  excludeId,
}: {
  lookup: DuplicateLookup;
  excludeId?: string;
}) {
  const headingId = useId();
  const others = excludeId ? "other " : "";
  const matches =
    lookup.status === "result"
      ? lookup.matches.filter((match) => match.id !== excludeId)
      : [];
  let tone = "muted small-text";
  let summary: string;
  if (lookup.status === "idle")
    summary =
      "Possible duplicates are checked once a complete email or a phone number with at least seven digits is entered.";
  else if (lookup.status === "checking")
    summary = "Checking for possible duplicates…";
  else if (lookup.status === "error") {
    tone = "notice error";
    summary = `Possible duplicates could not be checked. ${lookup.message} You can still save this candidate.`;
  } else if (lookup.limited) {
    tone = "notice";
    summary = `More than ${CANDIDATE_DUPLICATE_LIMIT} possible matches share this email or phone. Review them before saving: only some are listed here, so search the Candidates directory for this email or phone to see the rest. Nothing is merged or blocked automatically.`;
  } else if (matches.length) {
    tone = "notice";
    summary = `${matches.length} ${others}team ${matches.length === 1 ? "candidate shares" : "candidates share"} this email or phone. Review ${matches.length === 1 ? "it" : "them"} before saving. Nothing is merged or blocked automatically.`;
  } else {
    tone = "notice";
    summary = `No ${others}team candidate has this exact email or phone. This does not prove the candidate is new: the same person may be recorded with different contact details.`;
  }
  return (
    <section className="field full-width" aria-labelledby={headingId}>
      <h3 id={headingId} className="small-text">
        Possible duplicates
      </h3>
      <div className={tone}>
        <p role="status">{summary}</p>
        {matches.length > 0 && (
          <ul>
            {matches.map((match) => (
              <li key={match.id}>
                <a
                  href={`/app/candidates/${encodeURIComponent(match.id)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {match.name.trim() || "Unnamed candidate"}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>{" "}
                — {match.matches.join(" and ")} match
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
