import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aiReviewPayload,
  beginSuggestionRequest,
  cancelSuggestionRequest,
  editDraftField,
  stageSuggestions,
  requestCvSuggestions,
  resolveSuggestion,
  hasPendingSuggestions,
  suggestionFailure,
  suggestionFailureMessage,
  type AiReview,
  type SuggestionFailure,
} from "../src/components/workspace/bulk-cv-suggestions";
import { ClientError } from "../src/components/workspace/client";
import {
  AI_EXTRACTION_LIMITS,
  type ExtractedCandidateFields,
} from "../src/domain/cv-extraction";

const makeEntry = (id: string) => ({
  id,
  fields: {
    name: "Recruiter entry",
    email: "",
    phone: "",
    jobTitle: "",
    employer: "",
    university: "",
    degreeName: "",
    major: "",
    skills: "",
    certifications: "",
  },
  suggestions: undefined as ExtractedCandidateFields | undefined,
  suggestionRequestId: undefined as string | undefined,
  aiReview: undefined as AiReview | undefined,
  checked: true,
  duplicatesReviewed: true,
  reviewed: true,
  done: false,
});
// Fictional provenance for a fake extraction job.
const provenance = (requestId: string) => ({
  requestId,
  sourceSha256: "a".repeat(64),
  provider: "Fictional Extraction Service",
  model: "fictional-model-1",
  extractedAt: "2030-01-01T09:00:00.000Z",
});

describe("reviewing extracted CV suggestions", () => {
  it("stages suggestions without overwriting recruiter data, then accepts or rejects each field explicitly", () => {
    const staged = stageSuggestions(
      beginSuggestionRequest([makeEntry("one")], "one", "request"),
      "one",
      "request",
      { name: "Extracted name", skills: ["Python", "SQL"] },
      provenance("request"),
    );
    expect(staged[0].fields.name).toBe("Recruiter entry");
    expect(staged[0].reviewed).toBe(false);
    expect(staged[0].aiReview).toEqual({
      ...provenance("request"),
      decisions: {},
    });
    expect(hasPendingSuggestions(staged[0])).toBe(true);
    const accepted = resolveSuggestion(staged, "one", "name", true);
    expect(accepted[0].fields.name).toBe("Extracted name");
    expect(accepted[0].fields.skills).toBe("");
    const rejected = resolveSuggestion(accepted, "one", "skills", false);
    expect(rejected[0].fields.skills).toBe("");
    expect(hasPendingSuggestions(rejected[0])).toBe(false);
    expect(rejected[0].aiReview?.decisions).toEqual({
      name: "accepted",
      skills: "rejected",
    });
    expect(aiReviewPayload(rejected[0])).toEqual({
      requestId: "request",
      decisions: { name: "accepted", skills: "rejected" },
    });
    expect(aiReviewPayload(makeEntry("two"))).toBeUndefined();
  });

  it("turns an edited accepted suggestion into edited and keeps a rejection rejected", () => {
    const staged = stageSuggestions(
      beginSuggestionRequest([makeEntry("one")], "one", "request"),
      "one",
      "request",
      { name: "Extracted name", jobTitle: "Extracted title" },
      provenance("request"),
    );
    const resolved = resolveSuggestion(
      resolveSuggestion(staged, "one", "name", true),
      "one",
      "jobTitle",
      false,
    );
    const edited = editDraftField(
      editDraftField(resolved, "one", "name", "Recruiter fix"),
      "one",
      "jobTitle",
      "Recruiter title",
    );
    expect(edited[0].fields).toMatchObject({
      name: "Recruiter fix",
      jobTitle: "Recruiter title",
    });
    expect(edited[0].aiReview?.decisions).toEqual({
      name: "edited",
      jobTitle: "rejected",
    });
    expect(edited[0]).toMatchObject({
      checked: false,
      duplicatesReviewed: false,
      reviewed: false,
    });
    // One successful extraction per draft.
    expect(() => beginSuggestionRequest(edited, "one", "again")).toThrow();
  });

  it("invalidates duplicate checks for accepted contact changes and acknowledgment on other drafts", () => {
    const staged = stageSuggestions(
      beginSuggestionRequest(
        [makeEntry("one"), makeEntry("two")],
        "one",
        "request",
      ),
      "one",
      "request",
      { email: "synthetic@example.test" },
      provenance("request"),
    );
    const resolved = resolveSuggestion(staged, "one", "email", true);
    expect(resolved[0]).toMatchObject({
      checked: false,
      duplicatesReviewed: false,
      reviewed: false,
    });
    expect(resolved[1].duplicatesReviewed).toBe(false);
    const typed = editDraftField(
      [makeEntry("one"), makeEntry("two")],
      "one",
      "phone",
      "+971 50 000 0000",
    );
    expect(typed[1].duplicatesReviewed).toBe(false);
  });

  it("rejects malformed or sensitive fields and does not modify submitted drafts", () => {
    const pending = beginSuggestionRequest(
      [makeEntry("one")],
      "one",
      "request",
    );
    expect(() =>
      stageSuggestions(
        pending,
        "one",
        "request",
        { gender: "unknown" },
        provenance("request"),
      ),
    ).toThrow();
    expect(() =>
      stageSuggestions(
        pending,
        "one",
        "request",
        { name: 42 },
        provenance("request"),
      ),
    ).toThrow();
    expect(() =>
      stageSuggestions(
        pending,
        "one",
        "request",
        { skills: ["one, two"] },
        provenance("request"),
      ),
    ).toThrow();
    const locked = [{ ...makeEntry("one"), submitted: "{}" }];
    expect(
      stageSuggestions(
        locked,
        "one",
        "request",
        { name: "New" },
        provenance("request"),
      ),
    ).toEqual(locked);
  });

  it("ignores stale results and never treats unknown as a value to apply", () => {
    const first = beginSuggestionRequest([makeEntry("one")], "one", "old");
    expect(hasPendingSuggestions(first[0])).toBe(true);
    const latest = beginSuggestionRequest(first, "one", "new");
    expect(cancelSuggestionRequest(latest, "one", "old")).toEqual(latest);
    expect(
      stageSuggestions(
        latest,
        "one",
        "old",
        { name: "Stale" },
        provenance("old"),
      ),
    ).toEqual(latest);
    const received = stageSuggestions(
      latest,
      "one",
      "new",
      { name: null, email: "test@example.test" },
      provenance("new"),
    );
    const ignored = resolveSuggestion(received, "one", "name", true);
    expect(ignored[0].fields.name).toBe("Recruiter entry");
    expect(hasPendingSuggestions(ignored[0])).toBe(true);
    expect(() => beginSuggestionRequest(ignored, "one", "third")).toThrow();
  });

  it("drops a result after a human edit and never overwrites it", () => {
    const pending = beginSuggestionRequest(
      [makeEntry("one")],
      "one",
      "request",
    );
    const typed = editDraftField(pending, "one", "name", "Typed by recruiter");
    expect(hasPendingSuggestions(typed[0])).toBe(false);
    const late = stageSuggestions(
      typed,
      "one",
      "request",
      { name: "Late extraction" },
      provenance("request"),
    );
    expect(late).toEqual(typed);
    expect(late[0].fields.name).toBe("Typed by recruiter");
    expect(late[0].aiReview).toBeUndefined();
  });

  it("unblocks a failed or cancelled in-flight request without clearing a newer request", () => {
    const pending = beginSuggestionRequest(
      [makeEntry("one")],
      "one",
      "request",
    );
    const cancelled = cancelSuggestionRequest(pending, "one", "request");
    expect(hasPendingSuggestions(cancelled[0])).toBe(false);
    expect(cancelled[0]).toMatchObject({
      error: suggestionFailureMessage("cancelled"),
    });
    expect(
      stageSuggestions(
        cancelled,
        "one",
        "request",
        { name: "Late" },
        provenance("request"),
      ),
    ).toEqual(cancelled);
    const failed = cancelSuggestionRequest(
      beginSuggestionRequest(cancelled, "one", "retry"),
      "one",
      "retry",
      "provider_failed",
    );
    expect(failed[0]).toMatchObject({
      error: suggestionFailureMessage("provider_failed"),
    });
    expect(hasPendingSuggestions(failed[0])).toBe(false);
  });

  it("gives every failure its own message, saying nothing was added and work can continue manually", () => {
    const outcomes: SuggestionFailure[] = [
      "cancelled",
      "timed_out",
      "rate_limited",
      "quota_exhausted",
      "budget_exhausted",
      "provider_failed",
      "invalid_response",
      "consent_required",
      "disclosure_changed",
      "file_too_large",
      "unknown",
    ];
    const messages = outcomes.map(suggestionFailureMessage);
    expect(new Set(messages).size).toBe(outcomes.length);
    for (const message of messages) {
      expect(message).toContain("No suggestions were added");
      expect(message).toContain("continue manually");
    }
    for (const outcome of ["timed_out", "provider_failed", "unknown"] as const)
      expect(suggestionFailureMessage(outcome)).toMatch(
        /may already have reached the AI service.*counts against your team's AI limit/,
      );
    for (const outcome of outcomes.filter(
      (item) => !["timed_out", "provider_failed", "unknown"].includes(item),
    ))
      expect(suggestionFailureMessage(outcome)).not.toContain(
        "may already have reached",
      );
    expect(
      suggestionFailure(new ClientError(429, "ai_budget_exhausted", "x")),
    ).toBe("budget_exhausted");
    expect(suggestionFailure(new ClientError(504, "ai_timed_out", "x"))).toBe(
      "timed_out",
    );
    expect(suggestionFailure(new ClientError(500, "internal_error", "x"))).toBe(
      "unknown",
    );
    expect(suggestionFailure(new DOMException("Aborted", "AbortError"))).toBe(
      "cancelled",
    );
  });
});

describe("requesting CV suggestions", () => {
  afterEach(() => vi.unstubAllGlobals());
  const bytes = Buffer.from("%PDF-1.7\nfictional CV for suggestions\n");

  it("sends the selected file with its digest and no draft values", async () => {
    const result = {
      requestId: "00000000-0000-4000-8000-0000000000e1",
      status: "succeeded",
      suggestions: { name: "Fictional" },
      provenance: provenance("00000000-0000-4000-8000-0000000000e1"),
    };
    const fetch = vi.fn(async () => Response.json({ data: result }));
    vi.stubGlobal("fetch", fetch);
    const file = new File([bytes], "fictional-cv.pdf", {
      type: "application/pdf",
    });
    expect(
      await requestCvSuggestions({
        teamId: "fictional-team",
        file,
        requestId: result.requestId,
        disclosureVersion: "b".repeat(64),
      }),
    ).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [path, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(path).toBe("/api/v1/extraction-jobs");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("X-Team-Id")).toBe("fictional-team");
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(
      ["content", "disclosureVersion", "file", "requestId"].sort(),
    );
    expect(body.file).toEqual({
      originalName: "fictional-cv.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(Buffer.from(body.content, "base64").equals(bytes)).toBe(true);
    expect(String(init.body)).not.toContain("Recruiter entry");
  });

  it("refuses a file over the AI size limit without any request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const file = new File(
      [new Uint8Array(AI_EXTRACTION_LIMITS.maxFileBytes + 1)],
      "fictional-large-cv.pdf",
      { type: "application/pdf" },
    );
    const error = await requestCvSuggestions({
      teamId: "fictional-team",
      file,
      requestId: "00000000-0000-4000-8000-0000000000e2",
      disclosureVersion: "b".repeat(64),
    }).catch((caught: unknown) => caught);
    expect(suggestionFailure(error)).toBe("file_too_large");
    expect(fetch).not.toHaveBeenCalled();
  });
});
