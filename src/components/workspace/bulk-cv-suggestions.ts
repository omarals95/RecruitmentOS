import {
  extractedCandidateFieldsSchema,
  type ExtractedCandidateFields,
} from "@/domain/cv-extraction";

type Field = keyof ExtractedCandidateFields;
export type ReviewFields = Record<Field, string>;
type ReviewEntry = {
  id: string;
  fields: ReviewFields;
  suggestions?: ExtractedCandidateFields;
  suggestionRequestId?: string;
  checked: boolean;
  duplicatesReviewed: boolean;
  reviewed: boolean;
  done: boolean;
  submitted?: string;
};

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
  outcome: "failed" | "cancelled" = "cancelled",
): T[] {
  return items.map((item) =>
    item.id === id && item.suggestionRequestId === requestId
      ? {
          ...item,
          suggestionRequestId: undefined,
          error:
            outcome === "failed"
              ? "Extraction failed. No suggestions were added; retry or continue manually."
              : "Extraction was cancelled. No suggestions were added.",
        }
      : item,
  );
}

export function stageSuggestions<T extends ReviewEntry>(
  items: T[],
  id: string,
  requestId: string,
  input: unknown,
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
