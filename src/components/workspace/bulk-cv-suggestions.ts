import {
  AI_EXTRACTION_LIMITS,
  extractedCandidateFieldsSchema,
  type ExtractedCandidateFields,
} from "@/domain/cv-extraction";
import { ClientError, isAbortError, requestJson } from "./client";

type Field = keyof ExtractedCandidateFields;
export type ReviewFields = Record<Field, string>;
export type SuggestionDecision = "accepted" | "rejected" | "edited";
/** Where a draft's suggestions came from; the server checks it against its own job record. */
export type SuggestionProvenance = {
  requestId: string;
  sourceSha256: string;
  provider: string;
  model: string;
  extractedAt: string;
};
export type AiReview = SuggestionProvenance & {
  decisions: Partial<Record<Field, SuggestionDecision>>;
};
type ReviewEntry = {
  id: string;
  fields: ReviewFields;
  suggestions?: ExtractedCandidateFields;
  suggestionRequestId?: string;
  aiReview?: AiReview;
  checked: boolean;
  duplicatesReviewed: boolean;
  reviewed: boolean;
  done: boolean;
  submitted?: string;
};
export type SuggestionFailure =
  | "cancelled"
  | "timed_out"
  | "rate_limited"
  | "quota_exhausted"
  | "budget_exhausted"
  | "provider_failed"
  | "invalid_response"
  | "consent_required"
  | "disclosure_changed"
  | "file_too_large"
  | "unknown";

const noSuggestions = "No suggestions were added; you can continue manually.";
const mayHaveBeenSent =
  "The CV may already have reached the AI service, and trying again sends it again and counts against your team's AI limit.";
const failureMessages: Record<SuggestionFailure, string> = {
  cancelled: `AI suggestions were cancelled. ${noSuggestions}`,
  timed_out: `The AI service did not answer in time. ${noSuggestions} ${mayHaveBeenSent}`,
  rate_limited: `The AI service is limiting requests right now. ${noSuggestions} You can also try again later.`,
  quota_exhausted: `The AI service's usage quota is used up. ${noSuggestions}`,
  budget_exhausted: `Your team has used its ${AI_EXTRACTION_LIMITS.teamRequestsPer24Hours} AI requests for the last 24 hours. ${noSuggestions}`,
  provider_failed: `The AI service could not complete the request. ${noSuggestions} ${mayHaveBeenSent}`,
  invalid_response: `The AI service returned an answer that could not be used. ${noSuggestions}`,
  consent_required: `Allow AI suggestions before a CV is sent. ${noSuggestions}`,
  disclosure_changed: `The AI service or its terms changed. Review the new details and allow AI suggestions again. ${noSuggestions}`,
  file_too_large: `This CV is larger than ${AI_EXTRACTION_LIMITS.maxFileBytes / 1024 / 1024} MiB, so it cannot be sent for AI suggestions. ${noSuggestions}`,
  unknown: `The result of the AI request is unknown. ${noSuggestions} ${mayHaveBeenSent}`,
};
export function suggestionFailureMessage(outcome: SuggestionFailure) {
  return failureMessages[outcome];
}
const failureCodes: Record<string, SuggestionFailure> = {
  ai_cancelled: "cancelled",
  ai_timed_out: "timed_out",
  ai_rate_limited: "rate_limited",
  ai_quota_exhausted: "quota_exhausted",
  ai_budget_exhausted: "budget_exhausted",
  ai_provider_failed: "provider_failed",
  ai_invalid_response: "invalid_response",
  ai_consent_required: "consent_required",
  ai_disclosure_changed: "disclosure_changed",
  ai_file_too_large: "file_too_large",
};
/** A refusal before any request is sent, such as a file over the AI size limit. */
export class SuggestionRequestError extends Error {
  constructor(public readonly outcome: SuggestionFailure) {
    super(failureMessages[outcome]);
  }
}
/** The failure state for a suggestion request error; anything unrecognised is unknown. */
export function suggestionFailure(error: unknown): SuggestionFailure {
  if (error instanceof SuggestionRequestError) return error.outcome;
  if (isAbortError(error)) return "cancelled";
  if (error instanceof ClientError)
    return failureCodes[error.code] ?? "unknown";
  return "unknown";
}

export function hasPendingSuggestions(
  entry: Pick<ReviewEntry, "suggestions" | "suggestionRequestId">,
) {
  return (
    Boolean(entry.suggestionRequestId) ||
    Object.values(entry.suggestions ?? {}).some((value) => value != null)
  );
}

export function beginSuggestionRequest<T extends ReviewEntry>(
  items: T[],
  id: string,
  requestId: string,
): T[] {
  if (!requestId)
    throw new Error("A unique extraction request ID is required.");
  if (
    items.some(
      (item) =>
        item.id === id &&
        Object.values(item.suggestions ?? {}).some((value) => value != null),
    )
  )
    throw new Error(
      "Resolve existing suggestions before starting another extraction.",
    );
  if (items.some((item) => item.id === id && item.aiReview))
    throw new Error("This draft already has AI suggestions.");
  return items.map((item) =>
    item.id === id && !item.done && !item.submitted
      ? { ...item, suggestionRequestId: requestId, reviewed: false }
      : item,
  );
}

export function cancelSuggestionRequest<T extends ReviewEntry>(
  items: T[],
  id: string,
  requestId: string,
  outcome: SuggestionFailure = "cancelled",
): T[] {
  return items.map((item) =>
    item.id === id && item.suggestionRequestId === requestId
      ? {
          ...item,
          suggestionRequestId: undefined,
          error: suggestionFailureMessage(outcome),
        }
      : item,
  );
}

export function stageSuggestions<T extends ReviewEntry>(
  items: T[],
  id: string,
  requestId: string,
  input: unknown,
  provenance: SuggestionProvenance,
): T[] {
  if (
    !items.some(
      (item) =>
        item.id === id &&
        !item.done &&
        !item.submitted &&
        item.suggestionRequestId === requestId,
    )
  )
    return items;
  const suggestions = extractedCandidateFieldsSchema.parse(input);
  if (
    [...(suggestions.skills ?? []), ...(suggestions.certifications ?? [])].some(
      (tag) => tag.includes(","),
    )
  ) {
    throw new Error(
      "Suggested skills and certifications must not contain commas.",
    );
  }
  return items.map((item) =>
    item.id === id &&
    !item.done &&
    !item.submitted &&
    item.suggestionRequestId === requestId
      ? {
          ...item,
          suggestions,
          suggestionRequestId: undefined,
          aiReview: { ...provenance, decisions: {} },
          reviewed: false,
        }
      : item,
  );
}

export function resolveSuggestion<T extends ReviewEntry>(
  items: T[],
  id: string,
  field: Field,
  accept: boolean,
): T[] {
  const current = items.find((item) => item.id === id);
  const value = current?.suggestions?.[field];
  if (!current || current.done || current.submitted || value == null)
    return items;
  const text = Array.isArray(value) ? value.join(", ") : value;
  const contactChanged =
    accept &&
    (field === "email" || field === "phone") &&
    current.fields[field] !== text;
  const suggestions = { ...current.suggestions };
  delete suggestions[field];
  return items.map((item) => {
    if (item.id === id) {
      return {
        ...item,
        suggestionRequestId: undefined,
        fields: accept ? { ...item.fields, [field]: text } : item.fields,
        suggestions,
        aiReview: item.aiReview && {
          ...item.aiReview,
          decisions: {
            ...item.aiReview.decisions,
            [field]: accept ? "accepted" : "rejected",
          },
        },
        reviewed: false,
        checked: contactChanged ? false : item.checked,
        duplicatesReviewed: contactChanged ? false : item.duplicatesReviewed,
      };
    }
    return contactChanged && !item.done && !item.submitted
      ? { ...item, duplicatesReviewed: false }
      : item;
  });
}

/**
 * A human edit to one draft field. It drops any in-flight suggestion result, resets the checks,
 * and turns an accepted suggestion for the field into an edited one; a rejection stays rejected.
 */
export function editDraftField<T extends ReviewEntry>(
  items: T[],
  id: string,
  field: Field,
  value: string,
): T[] {
  return items.map((item) => {
    if (item.id === id) {
      const decisions = item.aiReview?.decisions;
      return {
        ...item,
        fields: { ...item.fields, [field]: value },
        suggestionRequestId: undefined,
        checked: false,
        duplicatesReviewed: false,
        reviewed: false,
        aiReview:
          item.aiReview && decisions?.[field] === "accepted"
            ? {
                ...item.aiReview,
                decisions: { ...decisions, [field]: "edited" },
              }
            : item.aiReview,
      };
    }
    return (field === "email" || field === "phone") &&
      !item.submitted &&
      !item.done
      ? { ...item, duplicatesReviewed: false }
      : item;
  });
}

/** The item body's aiReview: the job's request ID and one decision per resolved suggestion. */
export function aiReviewPayload(entry: Pick<ReviewEntry, "aiReview">) {
  return entry.aiReview
    ? {
        requestId: entry.aiReview.requestId,
        decisions: entry.aiReview.decisions,
      }
    : undefined;
}

export type SuggestionResult = {
  requestId: string;
  status: "succeeded";
  suggestions: ExtractedCandidateFields;
  provenance: SuggestionProvenance;
};
function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
/**
 * Sends one selected CV file, its digest and nothing from the draft for AI suggestions. A file
 * over the AI size limit is refused here, before any request.
 */
export async function requestCvSuggestions({
  teamId,
  file,
  requestId,
  disclosureVersion,
  signal,
}: {
  teamId: string;
  file: File;
  requestId: string;
  disclosureVersion: string;
  signal?: AbortSignal;
}): Promise<SuggestionResult> {
  if (file.size > AI_EXTRACTION_LIMITS.maxFileBytes)
    throw new SuggestionRequestError("file_too_large");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const response = await requestJson<{ data: SuggestionResult }>(
    teamId,
    "/api/v1/extraction-jobs",
    {
      method: "POST",
      signal,
      body: JSON.stringify({
        requestId,
        disclosureVersion,
        file: {
          originalName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          sha256,
        },
        content: base64(bytes),
      }),
    },
  );
  return response.data;
}
