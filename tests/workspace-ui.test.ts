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
  analyticsExportMetadata,
  analyticsRange,
  checklistProgress,
  describeFilters,
  exportFilename,
  exportMetadata,
  exportSummary,
  initials,
  isFiltered,
  referenceText,
  roleDifferences,
  roleSnapshot,
  dataOf,
  loadAllPages,
} from "../src/components/workspace/helpers";
import {
  calendarCells,
  calendarDays,
  calendarMoreLabel,
  interviewsOnDay,
} from "../src/components/workspace/calendar";
import {
  csvChunks,
  describeExportQuery,
  exportTable,
} from "../src/domain/export";
import { screenDefinitions } from "../src/components/workspace/records-screen";
import { cvImportState } from "../src/components/workspace/bulk-cv-import";
import {
  recordMutation,
  personalStateMutation,
  customValueDefaults,
} from "../src/components/workspace/mutation";
import { createRecordSchemas, type RecordDto } from "../src/domain/records";
import { DEFAULT_KIND_SCHEMAS } from "../src/domain/config-defaults";
import { contactBody, customField, kindBody } from "./helpers/kind-schemas";
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
    // An ordinary U+0020 space separates the code and amount; no U+00A0 or U+202F.
    expect(formatMoney("50000", "AED")).toBe("AED 50,000.00");
    expect(/[\u00a0\u202f]/.test(formatMoney("50000", "AED"))).toBe(false);
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
  const defaults = {
    status: "",
    category: "",
    categories: [] as string[],
    skills: [] as string[],
    certifications: [] as string[],
    shortlisted: false,
    reviewStatus: "",
    emirate: "",
    degree: "",
    education: "",
    minYears: "",
    maxYears: "",
    vacancy: "",
    archived: false,
  };
  it("counts active phone filters, not search or sorting", () => {
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
  it("counts each new candidate filter control once", () => {
    expect(
      activeFilterCount({ ...defaults, certifications: ["PMP", "CPA"] }),
    ).toBe(1);
    expect(activeFilterCount({ ...defaults, education: "Fictional" })).toBe(1);
    expect(activeFilterCount({ ...defaults, minYears: "3" })).toBe(1);
    expect(activeFilterCount({ ...defaults, maxYears: "5" })).toBe(1);
    expect(
      activeFilterCount({ ...defaults, minYears: "3", maxYears: "5" }),
    ).toBe(1);
    expect(
      activeFilterCount({
        ...defaults,
        certifications: ["PMP"],
        education: "Fictional",
        minYears: "0",
        maxYears: "5",
      }),
    ).toBe(3);
  });
  it("treats every user filter as filtered, but not forced screen constraints", () => {
    for (const filters of [
      { ...defaults, skills: ["SQL"] },
      { ...defaults, degree: "Bachelor" },
      { ...defaults, archived: true },
      { ...defaults, certifications: ["PMP"] },
      { ...defaults, minYears: "3" },
      { ...defaults, maxYears: "5" },
    ])
      expect(isFiltered("", filters)).toBe(true);
    expect(isFiltered("python", defaults)).toBe(true);
    // My shortlist forces the shortlist; Source review forces needsReview outside the filters.
    expect(isFiltered("", { ...defaults, shortlisted: true }, true)).toBe(
      false,
    );
    expect(isFiltered("", defaults)).toBe(false);
    expect(isFiltered("  ", defaults)).toBe(false);
  });
  it("describes applied filters for export labels", () => {
    expect(describeFilters("", defaults)).toBe("None");
    expect(
      describeFilters(
        "python",
        { ...defaults, skills: ["SQL", "Excel"], archived: true },
        "Follow-up status",
      ),
    ).toBe('Search: "python"; Skills: SQL, Excel; Include archived');
    expect(
      describeFilters("", {
        ...defaults,
        certifications: ["PMP"],
        education: "Fictional University",
        minYears: "3",
        maxYears: "5",
      }),
    ).toBe(
      'Certifications: PMP; Education contains: "Fictional University"; Stated experience: 3 to 5 years',
    );
    expect(
      describeFilters("", { ...defaults, shortlisted: true }, "", true),
    ).toBe("None");
  });
  it("labels a linked parent without ever showing its record ID", () => {
    const id = "6df3687a-9244-4917-8fdb-d5d8d083f2db";
    const person = {
      id,
      kind: "candidate",
      label: null,
      data: { name: "Fictional Person" },
      archivedAt: "2026-11-01T00:00:00.000Z",
    } as unknown as RecordDto;
    const labels = [
      referenceText({ data: person, loading: false }),
      referenceText({ data: { ...person, archivedAt: null }, loading: false }),
      referenceText({ data: null, loading: false, status: 404 }),
      referenceText({ data: null, loading: false, status: 403 }),
      referenceText({ data: null, loading: false, status: 500 }),
      referenceText({ data: null, loading: false }),
      referenceText({ data: null, loading: true }),
      referenceText({
        data: { ...person, data: {} } as unknown as RecordDto,
        loading: false,
      }),
    ];
    expect(labels).toEqual([
      "Fictional Person (archived)",
      "Fictional Person",
      "Unavailable record",
      "Unavailable record",
      "Could not load record",
      "Could not load record",
      "Loading…",
      "Untitled candidate (archived)",
    ]);
    for (const label of labels) expect(label).not.toContain(id.slice(0, 8));
  });
  it("keeps the HTTP status of a failed resource for its label", () => {
    const failed = failedResourceState(
      null,
      "team-a/candidate-a",
      0,
      Object.assign(new Error("Not found"), { status: 404 }),
    );
    expect(resourceSnapshot(failed, failed.key, 0, true).status).toBe(404);
  });
  it("copies exactly the role snapshot keys into a new skills array", () => {
    const role = {
      title: "Fictional Analyst",
      department: "Finance",
      location: "Dubai",
      employmentType: "Full-time",
      workMode: "Hybrid",
      description: "Fictional description",
      requirements: "Fictional requirements",
      skills: ["SQL", "Excel"],
      extra: "never copied",
    };
    const snapshot = roleSnapshot(role);
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        "title",
        "department",
        "location",
        "employmentType",
        "workMode",
        "description",
        "requirements",
        "skills",
      ].sort(),
    );
    expect(snapshot.skills).toEqual(["SQL", "Excel"]);
    snapshot.skills.push("Mutated");
    expect(role.skills).toEqual(["SQL", "Excel"]);
  });
  it("counts checklist progress over non-archived items only", () => {
    const item = (status: string, archivedAt: string | null = null) =>
      ({ data: { status }, archivedAt }) as unknown as RecordDto;
    expect(checklistProgress([])).toEqual({ done: 0, total: 0 });
    expect(
      checklistProgress([item("Complete"), item("Waived"), item("Pending")]),
    ).toEqual({ done: 2, total: 3 });
    expect(
      checklistProgress([
        item("Complete", "2026-11-01T00:00:00.000Z"),
        item("Pending"),
      ]),
    ).toEqual({ done: 0, total: 1 });
  });
  it("states the analytics range and timezone", () => {
    expect(analyticsRange("2026-10-06", "2026-11-04")).toBe(
      "Showing observed activity from 6 Oct 2026 to 4 Nov 2026 · Asia/Dubai (UTC+4)",
    );
  });
});
describe("labelled exports", () => {
  const now = new Date("2026-11-05T09:07:00.000Z"); // 13:07 in Dubai.
  it("writes the metadata rows in order above the header row", () => {
    const metadata = exportMetadata({
      title: "Candidates",
      now,
      environment: "Local development",
      filters: "=HYPERLINK(1)",
      written: 2,
      total: 2,
    });
    expect(metadata).toEqual([
      ["RecruitmentOS export", "Candidates"],
      ["Exported at", "5 Nov 2026, 13:07 (Asia/Dubai)"],
      ["Environment", "Local development"],
      ["Filters", "=HYPERLINK(1)"],
      ["Rows", "2"],
      [
        "Data protection",
        "This file contains personal data from RecruitmentOS. Store and share it only as your team's data-protection rules allow.",
      ],
      [],
    ]);
    const lines = csvText(["Record ID", "Name"], [["id-1", "A"]], metadata)
      .slice(1)
      .split("\r\n");
    expect(lines[3]).toBe('"Filters","\'=HYPERLINK(1)"');
    expect(lines[6]).toBe("");
    expect(lines[7]).toBe('"Record ID","Name"');
  });
  it("reports a changed total instead of hiding it", () => {
    const changed = exportMetadata({
      title: "Candidates",
      now,
      environment: "Preview",
      filters: "None",
      written: 12,
      total: 13,
    });
    expect(changed[4]).toEqual([
      "Rows",
      "12 (the matching records changed during the export; 13 matched when it finished)",
    ]);
    expect(exportSummary(12, 13)).toMatchObject({ changed: true });
    expect(exportSummary(12, 13).notice).toContain(
      "the matching records changed during the export; 13 matched when it finished",
    );
    expect(exportSummary(4, 4)).toEqual({
      changed: false,
      rows: "4",
      notice:
        "Exported 4 records matching the current filters. The file contains personal data; store and share it with care.",
    });
  });
  it("names files with the Dubai date and time and labels analytics ranges", () => {
    expect(exportFilename("candidates", now)).toBe(
      "RecruitmentOS-candidates-2026-11-05-1307.csv",
    );
    expect(exportFilename("tasks", new Date("2026-11-05T21:30:00.000Z"))).toBe(
      "RecruitmentOS-tasks-2026-11-06-0130.csv",
    );
    expect(
      analyticsExportMetadata({
        title: "Hiring analytics",
        from: "2026-10-06",
        to: "2026-11-04",
        now,
        environment: "Production",
      }),
    ).toEqual([
      ["RecruitmentOS export", "Hiring analytics"],
      ["Date range", "6 Oct 2026 to 4 Nov 2026"],
      ["Timezone", "Asia/Dubai (UTC+4)"],
      ["Exported at", "5 Nov 2026, 13:07 (Asia/Dubai)"],
      ["Environment", "Production"],
      [],
    ]);
  });
});
describe("calendar cells and view agreement", () => {
  const interview = (id: string, startAt: string) =>
    ({
      id,
      kind: "interview",
      data: { title: id, startAt },
    }) as unknown as RecordDto;
  // Dubai is UTC+4: 19:59:59Z is 23:59:59 on 17 Nov, 20:00:00Z is midnight on 18 Nov.
  const busy = Array.from({ length: 22 }, (_, n) =>
    interview(
      `busy-${String(n).padStart(2, "0")}`,
      `2026-11-18T${String(4 + Math.floor(n / 2)).padStart(2, "0")}:${n % 2 ? "30" : "00"}:00.000Z`,
    ),
  );
  const events = [
    ...busy,
    interview("busy-midnight", "2026-11-17T20:00:00.000Z"),
    interview("before-midnight", "2026-11-17T19:59:59.000Z"),
    ...[2, 5, 9, 14, 21, 26, 30].map((day) =>
      interview(
        `spread-${day}`,
        `2026-11-${String(day).padStart(2, "0")}T06:00:00.000Z`,
      ),
    ),
    interview("next-month", "2026-12-03T06:00:00.000Z"),
  ];
  it("puts every event in exactly one cell and counts what is not shown", () => {
    for (const view of ["month", "week", "day"] as const) {
      const days = calendarDays("2026-11-18", view);
      const cells = calendarCells(events, days, view);
      const seen = new Map<string, string>();
      for (const cell of cells) {
        const all = interviewsOnDay(events, cell.day);
        expect(cell.shown.length + cell.hidden, `${view} ${cell.day}`).toBe(
          all.length,
        );
        expect(cell.shown).toEqual(all.slice(0, cell.shown.length));
        for (const record of all) {
          expect(seen.has(record.id), `${view} ${record.id}`).toBe(false);
          seen.set(record.id, cell.day);
        }
      }
      for (const record of events) {
        const day = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Dubai",
        }).format(new Date(String(dataOf(record).startAt)));
        expect(seen.get(record.id), `${view} ${record.id}`).toBe(
          days.includes(day) ? day : undefined,
        );
      }
    }
    const busyCell = (view: "month" | "week" | "day") =>
      calendarCells(events, calendarDays("2026-11-18", view), view).find(
        (cell) => cell.day === "2026-11-18",
      )!;
    expect(interviewsOnDay(events, "2026-11-18")).toHaveLength(23);
    expect(busyCell("week")).toMatchObject({ hidden: 3 });
    expect(busyCell("week").shown).toHaveLength(20);
    expect(busyCell("month")).toMatchObject({ hidden: 20 });
    expect(busyCell("month").shown).toHaveLength(3);
    expect(busyCell("day")).toMatchObject({ hidden: 0 });
    expect(busyCell("day").shown).toHaveLength(23);
    expect(busyCell("day").shown[0].id).toBe("busy-midnight");
  });
  it("names each +N more button with its visible text and its day", () => {
    expect(calendarMoreLabel(3, "2026-11-18")).toBe(
      "+3 more interviews on 18 Nov 2026",
    );
    expect(calendarMoreLabel(20, "2026-12-05")).toBe(
      "+20 more interviews on 5 Dec 2026",
    );
  });
  it("gives the list view the same Dubai date as the cell holding each event", () => {
    const cells = calendarCells(
      events,
      calendarDays("2026-11-18", "month"),
      "month",
    );
    for (const cell of cells)
      for (const record of interviewsOnDay(events, cell.day))
        expect(
          formatField(
            { key: "startAt", type: "datetime-local" },
            dataOf(record),
          ).split(", ")[0],
          record.id,
        ).toBe(formatDate(cell.day));
    expect(
      cells.find((cell) =>
        interviewsOnDay(events, cell.day).some(
          (record) => record.id === "before-midnight",
        ),
      )?.day,
    ).toBe("2026-11-17");
  });
});
describe("reviewed role refresh", () => {
  const role = {
    title: "Fictional Analyst",
    department: "Finance",
    location: "Dubai",
    employmentType: "Full-time",
    workMode: "Hybrid",
    description: "Fictional description",
    requirements: "Fictional requirements",
    skills: ["SQL", "Excel"],
  };
  it("lists only the differing snapshot fields with their labels", () => {
    expect(roleDifferences({ ...role, openings: 3 }, role)).toEqual([]);
    expect(
      roleDifferences(
        { ...role, status: "Open" },
        {
          ...role,
          title: "Fictional Senior Analyst",
          requirements: "Fictional new requirements",
          extra: "never compared",
        },
      ),
    ).toEqual([
      {
        key: "title",
        label: "Title",
        vacancy: "Fictional Analyst",
        role: "Fictional Senior Analyst",
      },
      {
        key: "requirements",
        label: "Requirements",
        vacancy: "Fictional requirements",
        role: "Fictional new requirements",
      },
    ]);
  });
  it("treats reordered skills as a difference", () => {
    expect(
      roleDifferences(role, { ...role, skills: ["Excel", "SQL"] }),
    ).toEqual([
      {
        key: "skills",
        label: "Skills",
        vacancy: ["SQL", "Excel"],
        role: ["Excel", "SQL"],
      },
    ]);
  });
});
describe("whole-list loading", () => {
  const row = (id: string) => ({ id }) as unknown as RecordDto;
  const page = (ids: string[], number: number, total: number) => ({
    data: ids.map(row),
    pagination: {
      page: number,
      pageSize: 100,
      total,
      totalPages: Math.ceil(total / 100),
    },
  });
  it("combines pages and drops rows repeated across pages", async () => {
    const pages = [
      page(["a", "b"], 1, 250),
      page(["b", "c"], 2, 250),
      page(["d"], 3, 250),
    ];
    const fetched: number[] = [];
    const result = await loadAllPages(async (number) => {
      fetched.push(number);
      return pages[number - 1];
    }, 1000);
    expect(fetched).toEqual([1, 2, 3]);
    expect(result).toMatchObject({ tooMany: false, total: 250 });
    expect(result.tooMany ? [] : result.rows.map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
  it("stops after the first page when the total exceeds the limit", async () => {
    const fetched: number[] = [];
    expect(
      await loadAllPages(async (number) => {
        fetched.push(number);
        return page(["a"], number, 1001);
      }, 1000),
    ).toEqual({ tooMany: true, total: 1001 });
    expect(fetched).toEqual([1]);
  });
  it("reports an incomplete list when the last total differs from the unique rows", async () => {
    const pages = [page(["a", "b"], 1, 101), page(["c", "d"], 2, 102)];
    expect(
      await loadAllPages(async (number) => pages[number - 1], 1000),
    ).toMatchObject({ tooMany: false, total: 102, complete: false });
    expect(
      await loadAllPages(async () => page(["a", "b"], 1, 2), 1000),
    ).toMatchObject({ tooMany: false, total: 2, complete: true });
  });
});
describe("server export file", () => {
  it("streams exactly the text csvText builds", () => {
    const headers = ["Record ID", "Name"];
    const rows = Array.from({ length: 1203 }, (_, n) => [`id-${n}`, `=n${n}`]);
    const metadata = [["RecruitmentOS export", "Candidates"], []];
    const chunks = [...csvChunks(headers, rows, metadata, 500)];
    expect(chunks).toHaveLength(4);
    expect(chunks.join("")).toBe(csvText(headers, rows, metadata));
    expect([...csvChunks(headers, [], metadata)].join("")).toBe(
      csvText(headers, [], metadata),
    );
  });
  it("describes every applied export filter in the list screen's words", () => {
    expect(describeExportQuery("candidates", new URLSearchParams())).toBe(
      "None",
    );
    expect(
      describeExportQuery(
        "candidates",
        new URLSearchParams({
          search: "",
          sort: "name",
          direction: "asc",
          status: "Contacted",
          skills: JSON.stringify(["SQL"]),
          shortlisted: "true",
          needsReview: "true",
          reviewStatus: "Needs review",
          includeArchived: "true",
        }),
      ),
    ).toBe(
      "Follow-up status: Contacted; Skills: SQL; My shortlist only; Review status: Needs review; Include archived; Needs source review",
    );
    expect(
      describeExportQuery(
        "applications",
        new URLSearchParams({
          stage: "Screening",
          vacancyId: "00000000-0000-4000-8000-000000000001",
        }),
      ),
    ).toBe(
      "Stage: Screening; Vacancy ID: 00000000-0000-4000-8000-000000000001",
    );
    expect(
      describeExportQuery(
        "interviews",
        new URLSearchParams({
          status: "Scheduled",
          startFrom: "2026-11-01T00:00:00+04:00",
          shortlisted: "false",
        }),
      ),
    ).toBe(
      "Status: Scheduled; startFrom: 2026-11-01T00:00:00+04:00; shortlisted: false",
    );
  });
  it("writes the record ID, every field label and the timestamps", () => {
    const record = {
      id: "id-1",
      data: { title: "Fictional role", skills: ["SQL"] },
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-02T00:00:00.000Z",
    } as unknown as RecordDto;
    const table = exportTable("job-roles", [record]);
    expect(table.headers[0]).toBe("Record ID");
    expect(table.headers.slice(-2)).toEqual(["Created at", "Updated at"]);
    expect(table.headers).toContain("Title");
    expect(table.rows[0][0]).toBe("id-1");
    expect(table.rows[0][1]).toBe("Fictional role");
    expect(table.rows[0].slice(-2)).toEqual([
      "2026-11-01T00:00:00.000Z",
      "2026-11-02T00:00:00.000Z",
    ]);
  });
});

// R2b-07 (job 090): the editor never sends a field its screen does not show.
describe("screen-driven record payloads", () => {
  const candidate = {
    id: "00000000-0000-4000-8000-000000000991",
    kind: "candidate",
    data: {
      name: "Fictional Candidate",
      email: "candidate@example.test",
      employer: "Fictional Employer",
    },
    version: 4,
  } as RecordDto;
  it("leaves a hidden system field out of a create and an edit", () => {
    const values = {
      name: "Fictional Candidate",
      email: "candidate@example.test",
      phone: "+971 50 000 0003",
      employer: "Fictional Employer",
    };
    for (const record of [undefined, candidate]) {
      const payload = recordMutation(
        "candidates",
        values,
        {},
        record,
        contactBody(),
      );
      expect(payload.data).not.toHaveProperty("employer");
      expect(payload.data).toMatchObject({
        name: "Fictional Candidate",
        email: "candidate@example.test",
        phone: "+971 50 000 0003",
      });
      expect(payload.data).not.toHaveProperty("rawSource");
    }
    // The default screens send every editable field, as before.
    expect(recordMutation("candidates", values, {}, candidate).data).toEqual(
      recordMutation(
        "candidates",
        values,
        {},
        candidate,
        DEFAULT_KIND_SCHEMAS.candidate.body,
      ).data,
    );
    expect(
      recordMutation("candidates", values, {}, candidate).data,
    ).toHaveProperty("employer", "Fictional Employer");
  });
  it("leaves a task's hidden central custom values out, keeping team task-field and shown keys", () => {
    const hidden = customField("Fictional hidden", "short-text");
    const shown = customField("Fictional shown", "short-text");
    const team = "00000000-0000-4000-8000-000000000992";
    const body = kindBody("task", [hidden, shown]);
    const edit = body.screens.find((screen) => screen.action === "edit")!;
    edit.groups[0].fields.find(({ key }) => key === hidden.key)!.hidden = true;
    const task = {
      id: "00000000-0000-4000-8000-000000000993",
      kind: "task",
      data: { title: "Fictional task" },
      version: 1,
    } as RecordDto;
    const values = {
      title: "Fictional task",
      customValues: { [hidden.key]: "Kept", [shown.key]: "Sent", [team]: 3 },
    };
    expect(
      recordMutation("tasks", values, {}, task, body).data.customValues,
    ).toEqual({ [shown.key]: "Sent", [team]: 3 });
    // On create the field is shown, so it is sent.
    expect(
      recordMutation("tasks", values, {}, undefined, body).data.customValues,
    ).toEqual(values.customValues);
    // A screen that does not show customValues sends none.
    edit.groups[0].fields = edit.groups[0].fields.filter(
      ({ key }) => key !== "customValues",
    );
    expect(
      recordMutation("tasks", values, {}, task, body).data,
    ).not.toHaveProperty("customValues");
  });
});
