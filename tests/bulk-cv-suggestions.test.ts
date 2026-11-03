import { describe, expect, it } from "vitest";
import {
  beginSuggestionRequest,
  cancelSuggestionRequest,
  stageSuggestions,
  resolveSuggestion,
  hasPendingSuggestions,
} from "../src/components/workspace/bulk-cv-suggestions";
import type { ExtractedCandidateFields } from "../src/domain/cv-extraction";

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
  checked: true,
  duplicatesReviewed: true,
  reviewed: true,
  done: false,
});

describe("reviewing extracted CV suggestions", () => {
  it("stages suggestions without overwriting recruiter data, then accepts or rejects each field explicitly", () => {
    const staged = stageSuggestions(
      beginSuggestionRequest([makeEntry("one")], "one", "request"),
      "one",
      "request",
      { name: "Extracted name", skills: ["Python", "SQL"] },
    );
    expect(staged[0].fields.name).toBe("Recruiter entry");
    expect(staged[0].reviewed).toBe(false);
    expect(hasPendingSuggestions(staged[0])).toBe(true);
    const accepted = resolveSuggestion(staged, "one", "name", true);
    expect(accepted[0].fields.name).toBe("Extracted name");
    expect(accepted[0].fields.skills).toBe("");
    const rejected = resolveSuggestion(accepted, "one", "skills", false);
    expect(rejected[0].fields.skills).toBe("");
    expect(hasPendingSuggestions(rejected[0])).toBe(false);
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
    );
    const resolved = resolveSuggestion(staged, "one", "email", true);
    expect(resolved[0]).toMatchObject({
      checked: false,
      duplicatesReviewed: false,
      reviewed: false,
    });
    expect(resolved[1].duplicatesReviewed).toBe(false);
  });

  it("rejects malformed or sensitive fields and does not modify submitted drafts", () => {
    const pending = beginSuggestionRequest(
      [makeEntry("one")],
      "one",
      "request",
    );
    expect(() =>
      stageSuggestions(pending, "one", "request", { gender: "unknown" }),
    ).toThrow();
    expect(() =>
      stageSuggestions(pending, "one", "request", { name: 42 }),
    ).toThrow();
    expect(() =>
      stageSuggestions(pending, "one", "request", { skills: ["one, two"] }),
    ).toThrow();
    const locked = [{ ...makeEntry("one"), submitted: "{}" }];
    expect(stageSuggestions(locked, "one", "request", { name: "New" })).toEqual(
      locked,
    );
  });

  it("ignores stale results and never treats unknown as a value to apply", () => {
    const first = beginSuggestionRequest([makeEntry("one")], "one", "old");
    expect(hasPendingSuggestions(first[0])).toBe(true);
    const latest = beginSuggestionRequest(first, "one", "new");
    expect(cancelSuggestionRequest(latest, "one", "old")).toEqual(latest);
    expect(stageSuggestions(latest, "one", "old", { name: "Stale" })).toEqual(
      latest,
    );
    const received = stageSuggestions(latest, "one", "new", {
      name: null,
      email: "test@example.test",
    });
    const ignored = resolveSuggestion(received, "one", "name", true);
    expect(ignored[0].fields.name).toBe("Recruiter entry");
    expect(hasPendingSuggestions(ignored[0])).toBe(true);
    expect(() => beginSuggestionRequest(ignored, "one", "third")).toThrow();
  });

  it("unblocks a failed or cancelled in-flight request without clearing a newer request", () => {
    const pending = beginSuggestionRequest(
      [makeEntry("one")],
      "one",
      "request",
    );
    const cancelled = cancelSuggestionRequest(pending, "one", "request");
    expect(hasPendingSuggestions(cancelled[0])).toBe(false);
    expect(
      stageSuggestions(cancelled, "one", "request", { name: "Late" }),
    ).toEqual(cancelled);
  });
});
