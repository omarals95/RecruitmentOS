import { describe, it, expect } from "vitest";
import {
  csvText,
  safeCsvCell,
  toDubaiInput,
  fromDubaiInput,
  formatDate,
  formatMoney,
  formatNumber,
  formatField,
  commentAuthor,
  activeFilterCount,
  initials,
} from "../src/components/workspace/helpers";
import {
  calendarDays,
  interviewsOnDay,
} from "../src/components/workspace/calendar";
import { screenDefinitions } from "../src/components/workspace/records-screen";
import { cvImportState } from "../src/components/workspace/bulk-cv-import";
import {
  recordMutation,
  personalStateMutation,
  customValueDefaults,
} from "../src/components/workspace/mutation";
import { createRecordSchemas, type RecordDto } from "../src/domain/records";
import {
  aggregateSeries,
  seriesLabel,
} from "../src/components/workspace/metrics";
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
describe("one date and number format", () => {
  it("formats money, counts and dates the same way everywhere", () => {
    // Intl keeps the currency code and amount together with a no-break space.
    expect(formatMoney("50000", "AED")).toBe("AED 50,000.00");
    expect(formatMoney("50000", "AED").replace(" ", " ")).toBe("AED 50,000.00");
    expect(formatMoney(null, "AED")).toBe("Not recorded");
    expect(formatMoney("", "AED")).toBe("Not recorded");
    expect(formatNumber(12345)).toBe("12,345");
    expect(formatDate("2026-11-05")).toBe("5 Nov 2026");
  });
  it("formats record facts by field type instead of showing ISO values", () => {
    const offer = {
      amount: "1250.5",
      currency: "USD",
      expiryDate: "2026-11-05",
    };
    expect(formatField({ key: "amount", type: "text" }, offer)).toBe(
      "US$1,250.50",
    );
    expect(formatField({ key: "expiryDate", type: "date" }, offer)).toBe(
      "5 Nov 2026",
    );
    expect(
      formatField(
        { key: "startAt", type: "datetime-local" },
        { startAt: "2026-11-01T20:30:00.000Z" },
      ),
    ).toBe("2 Nov 2026, 00:30");
    expect(
      formatField({ key: "openings", type: "number" }, { openings: 1200 }),
    ).toBe("1,200");
    expect(formatField({ key: "title", type: "text" }, {})).toBe(
      "Not recorded",
    );
  });
  it("labels analytics periods with the shared date format and short months", () => {
    expect(seriesLabel("2026-11-05", "day")).toBe("5 Nov 2026");
    expect(seriesLabel("2026-11-02", "week")).toBe("2 Nov 2026");
    expect(seriesLabel("2026-11", "month")).toBe("Nov 2026");
  });
});
describe("calendar order", () => {
  const interview = (id: string, startAt: string) =>
    ({
      id,
      kind: "interview",
      data: { title: id, startAt },
    }) as unknown as RecordDto;
  it("lists one Dubai day by start time, not creation order, with ties by ID", () => {
    const events = [
      interview("c-three", "2026-11-05T11:00:00.000Z"), // 15:00 Dubai
      interview("b-one", "2026-11-05T05:00:00.000Z"), // 09:00 Dubai
      interview("d-two", "2026-11-05T08:00:00.000Z"), // 12:00 Dubai
      interview("e-other-day", "2026-11-06T05:00:00.000Z"),
      interview("a-two-tie", "2026-11-05T08:00:00.000Z"), // 12:00 Dubai
    ];
    expect(interviewsOnDay(events, "2026-11-05").map((row) => row.id)).toEqual([
      "b-one",
      "a-two-tie",
      "d-two",
      "c-three",
    ]);
    expect(events[0].id).toBe("c-three");
  });
});
describe("workspace labels and states", () => {
  it("names the vacancies screen for every status it lists", () => {
    expect(screenDefinitions.vacancies.title).toBe("Vacancies");
  });
  it("shows a comment author name or an honest fallback, never a user ID", () => {
    const comment = (
      data: Record<string, unknown>,
      authorName?: string | null,
    ) =>
      ({
        id: "comment",
        kind: "comment",
        createdBy: "fictional-user-id-123",
        data: { body: "Fictional", ...data },
        authorName,
      }) as unknown as RecordDto;
    const labels = [
      commentAuthor(comment({ legacyAuthorLabel: "Source Person" })),
      commentAuthor(comment({}, "Fictional Owner")),
      commentAuthor(comment({}, null)),
      commentAuthor(comment({})),
    ];
    expect(labels).toEqual([
      "Source Person · imported label",
      "Fictional Owner",
      "Author not recorded",
      "Author not recorded",
    ]);
    for (const label of labels)
      expect(label).not.toContain("fictional-user-id");
  });
  it("maps the CV import capability to exactly one state", () => {
    const data = (storageConfigured: boolean, uploadsAvailable: boolean) => ({
      data: { storageConfigured, uploadsAvailable },
    });
    expect(cvImportState({ data: null, error: "" })).toBe("checking");
    expect(cvImportState({ data: data(false, false), error: "" })).toBe(
      "not-set-up",
    );
    expect(cvImportState({ data: data(true, false), error: "" })).toBe(
      "unavailable",
    );
    expect(cvImportState({ data: null, error: "Network unavailable" })).toBe(
      "error",
    );
    expect(cvImportState({ data: data(true, true), error: "" })).toBe("ready");
  });
  it("counts active phone filters, not search or sorting", () => {
    const defaults = {
      status: "",
      category: "",
      categories: [] as string[],
      skills: [] as string[],
      shortlisted: false,
      reviewStatus: "",
      emirate: "",
      degree: "",
      vacancy: "",
      archived: false,
    };
    expect(activeFilterCount(defaults)).toBe(0);
    expect(activeFilterCount({ ...defaults, shortlisted: true }, true)).toBe(0);
    expect(
      activeFilterCount({
        ...defaults,
        status: "Contacted",
        categories: ["Engineering", "Operations"],
        skills: ["Cloud"],
        archived: true,
      }),
    ).toBe(4);
  });
});
