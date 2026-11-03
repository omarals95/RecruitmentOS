import { describe, it, expect } from "vitest";
import {
  csvText,
  safeCsvCell,
  toDubaiInput,
  fromDubaiInput,
  formatDate,
  initials,
} from "../src/components/workspace/helpers";
import { calendarDays } from "../src/components/workspace/calendar";
import {
  recordMutation,
  personalStateMutation,
  customValueDefaults,
} from "../src/components/workspace/mutation";
import { createRecordSchemas, type RecordDto } from "../src/domain/records";
import { aggregateSeries } from "../src/components/workspace/metrics";
import {
  resourceSnapshot,
  failedResourceState,
} from "../src/components/workspace/resource-state";

describe("recruiter exports and dates", () => {
  it("neutralizes spreadsheet formulas and keeps commas, quotes and line breaks inside CSV cells", () => {
    expect(safeCsvCell(' =HYPERLINK("https://example.invalid")')).toBe(
      '"\' =HYPERLINK(""https://example.invalid"")"',
    );
    expect(safeCsvCell("+971500000000")).toBe('"\'+971500000000"');
    expect(safeCsvCell('a,"b"\nnext')).toBe('"a,""b""\nnext"');
    expect(
      csvText(["Name", "Skills"], [["Candidate, One", ["Security", "Cloud"]]]),
    ).toContain('"Candidate, One","Security; Cloud"');
  });
  it("round-trips Dubai interview entry across the UTC day boundary", () => {
    expect(fromDubaiInput("2026-11-02T00:30")).toBe("2026-11-01T20:30:00.000Z");
    expect(toDubaiInput("2026-11-01T20:30:00.000Z")).toBe("2026-11-02T00:30");
    expect(formatDate("2026-11-01T20:30:00.000Z", true)).toContain(
      "2 Nov 2026",
    );
  });
  it("does not manufacture initials for an absent name", () => {
    expect(initials("")).toBe("?");
    expect(initials("Candidate Example")).toBe("CE");
  });
});
describe("recruiter mutation boundaries", () => {
  it("keeps same-resource data mounted during refresh, but never across a team or path change", () => {
    const data = { id: "candidate", version: 1 };
    const previous = {
      key: "team-a/candidate-a",
      revision: 0,
      data,
      error: "",
    };
    expect(resourceSnapshot(previous, previous.key, 1, true)).toEqual({
      data,
      error: "",
      loading: false,
      refreshing: true,
    });
    expect(resourceSnapshot(previous, "team-b/candidate-a", 1, true)).toEqual({
      data: null,
      error: "",
      loading: true,
      refreshing: false,
    });
    expect(
      resourceSnapshot(previous, "team-a/candidate-b", 1, true).data,
    ).toBeNull();
    const failed = failedResourceState(
      previous,
      previous.key,
      1,
      new Error("Network unavailable"),
    );
    expect(resourceSnapshot(failed, previous.key, 1, true)).toEqual({
      data,
      error: "Network unavailable",
      loading: false,
      refreshing: false,
    });
    const forbidden = failedResourceState(
      previous,
      previous.key,
      1,
      Object.assign(new Error("Access denied"), { status: 403 }),
    );
    expect(forbidden.data).toBeNull();
  });
  it("creates candidate payloads without source metadata reintroduced by validation defaults", () => {
    const payload = recordMutation(
      "candidates",
      { name: "Candidate One", skills: "Cloud, Security, " },
      {},
    );
    expect(createRecordSchemas.candidate.safeParse(payload).success).toBe(true);
    expect(payload.data).toMatchObject({
      name: "Candidate One",
      skills: ["Cloud", "Security"],
    });
    expect(payload.data).not.toHaveProperty("rawSource");
    expect(payload.data).not.toHaveProperty("evidence");
    expect(payload.data).not.toHaveProperty("sourceReviews");
  });
  it("never reflects server-owned state properties into a normal follow-up save", () => {
    const received = {
      version: 2,
      shortlisted: true,
      status: "Contacted",
      note: "Call next week",
      candidateId: "candidate",
      updatedAt: "now",
      importMeta: { sourceFile: "private.xlsx" },
    };
    expect(personalStateMutation(received)).toEqual({
      version: 2,
      shortlisted: true,
      status: "Contacted",
      note: "Call next week",
    });
  });
  it("persists untouched visible checkbox and dropdown defaults and keeps existing values", () => {
    const fields = [
      { id: "a", data: { type: "Checkbox" } },
      { id: "b", data: { type: "Dropdown", options: ["One", "Two"] } },
      { id: "c", data: { type: "Number" } },
    ] as RecordDto<"task-field">[];
    expect(customValueDefaults({ c: -2 }, fields)).toEqual({
      a: false,
      b: "One",
      c: -2,
    });
    expect(customValueDefaults({ a: true, b: "Two" }, fields)).toEqual({
      a: true,
      b: "Two",
    });
  });
});
describe("interview calendar boundaries", () => {
  it("aggregates observed counts without changing their totals across week and month boundaries", () => {
    const rows = [
      { date: "2026-10-31", applications: 2, hired: 1 },
      { date: "2026-11-01", applications: 3, hired: 0 },
      { date: "2026-11-02", applications: 1, hired: 2 },
    ];
    expect(aggregateSeries(rows, "week")).toEqual([
      { date: "2026-10-26", applications: 5, hired: 1 },
      { date: "2026-11-02", applications: 1, hired: 2 },
    ]);
    expect(aggregateSeries(rows, "month")).toEqual([
      { date: "2026-10", applications: 2, hired: 1 },
      { date: "2026-11", applications: 4, hired: 2 },
    ]);
  });
  it("provides a full Monday-first month that includes leading and trailing dates", () => {
    const days = calendarDays("2026-11-02", "month");
    expect(days).toHaveLength(42);
    expect(days[0]).toBe("2026-10-26");
    expect(days[41]).toBe("2026-12-06");
    expect(new Set(days).size).toBe(42);
  });
  it("keeps Sunday in the same Monday-first week and handles a leap day", () => {
    expect(calendarDays("2028-02-29", "week")).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
      "2028-03-02",
      "2028-03-03",
      "2028-03-04",
      "2028-03-05",
    ]);
    expect(calendarDays("2026-11-01", "week")[0]).toBe("2026-10-26");
    expect(calendarDays("2026-11-01", "day")).toEqual(["2026-11-01"]);
  });
});
