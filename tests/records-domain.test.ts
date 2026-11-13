import { describe, expect, it } from "vitest";
import {
  bulkApplicationsSchema,
  candidateStateSchema,
  daySchema,
  dubaiToday,
  matchesSearch,
  recordDataSchemas,
  resourceToKind,
  reviewStatusValue,
  REVIEW_STATUSES,
  RESOURCE_CONFIG,
  systemFieldKeys,
  updateRecordSchemas,
  type RecordKind,
} from "../src/domain/records";

describe("recruitment domain", () => {
  it("preserves unknown candidate facts and source metadata without deriving protected attributes", () => {
    const value = recordDataSchemas.candidate.parse({
      name: "  Fictional Person  ",
      rawSource: { "Old source column": "original wording" },
    });
    expect(value.name).toBe("Fictional Person");
    expect(value.yearsExperience).toBeNull();
    expect(value.explicitGender).toBe("");
    expect(value.nationalServiceStatus).toBe("");
    expect(value.residenceEmirate).toBe("");
    expect(value.rawSource["Old source column"]).toBe("original wording");
    expect(
      recordDataSchemas.candidate.safeParse({
        name: "Person",
        suitabilityScore: 99,
      }).success,
    ).toBe(false);
  });
  it("marks completion explicitly on buckets and shows it as a checkbox", () => {
    expect(
      recordDataSchemas.bucket.parse({ name: "Done", completed: true })
        .completed,
    ).toBe(true);
    expect(recordDataSchemas.bucket.parse({ name: "To do" }).completed).toBe(
      false,
    );
    expect(
      recordDataSchemas.bucket.safeParse({ name: "Done", completed: "yes" })
        .success,
    ).toBe(false);
    expect(
      RESOURCE_CONFIG.buckets.fields.find((field) => field.key === "completed"),
    ).toMatchObject({ type: "checkbox", label: "Counts as completed" });
  });
  it("keeps review status to two controlled values and maps legacy text", () => {
    expect(REVIEW_STATUSES).toEqual(["Needs review", "Reviewed"]);
    expect(
      recordDataSchemas.candidate.parse({ name: "Fictional Person" })
        .reviewStatus,
    ).toBe("Needs review");
    expect(
      recordDataSchemas.candidate.safeParse({
        name: "Fictional Person",
        reviewStatus: "Pending HR",
      }).success,
    ).toBe(false);
    const view = (reviewStatus: string) =>
      recordDataSchemas["saved-view"].safeParse({
        name: "Fictional view",
        area: "directory",
        query: { reviewStatus },
      }).success;
    expect(view("")).toBe(true);
    expect(view("Reviewed")).toBe(true);
    expect(view("Verified")).toBe(false);
    expect(reviewStatusValue(" Completed ")).toBe("Reviewed");
    expect(reviewStatusValue("verified")).toBe("Reviewed");
    expect(reviewStatusValue("Pending HR")).toBe("Needs review");
    expect(reviewStatusValue("")).toBe("Needs review");
    expect(
      RESOURCE_CONFIG.candidates.fields.find(
        (field) => field.key === "reviewStatus",
      ),
    ).toMatchObject({ type: "select", options: REVIEW_STATUSES });
  });
  it("validates real calendar dates, supported meeting URLs and bounded amounts", () => {
    expect(daySchema.safeParse("2024-02-29").success).toBe(true);
    expect(daySchema.safeParse("2025-02-29").success).toBe(false);
    expect(daySchema.safeParse("2025-04-31").success).toBe(false);
    expect(
      recordDataSchemas.interview.safeParse({
        title: "Interview",
        startAt: "2026-01-01T09:00:00+04:00",
        meetingUrl: "javascript:alert(1)",
      }).success,
    ).toBe(false);
    expect(
      recordDataSchemas.interview.parse({
        title: "Interview",
        startAt: "2026-01-01T09:00:00+04:00",
      }).startAt,
    ).toBe("2026-01-01T05:00:00.000Z");
    expect(
      recordDataSchemas.offer.safeParse({ title: "Offer", amount: "-1" })
        .success,
    ).toBe(false);
    expect(
      recordDataSchemas.offer.safeParse({
        title: "Offer",
        amount: "1000000000.01",
      }).success,
    ).toBe(false);
    const openings = (value: unknown) =>
      recordDataSchemas.vacancy.safeParse({ title: "Vacancy", openings: value })
        .success;
    expect(openings(1)).toBe(true);
    expect(openings(10000)).toBe(true);
    for (const value of [0, -1, 1.5, 10001, "2"])
      expect(openings(value), String(value)).toBe(false);
    expect(
      recordDataSchemas.vacancy.safeParse({
        title: "Vacancy",
        targetDate: "2026-02-30",
      }).success,
    ).toBe(false);
  });
  it("searches factual values with quoted phrases and exclusions, never JSON field names", () => {
    const value = {
      skills: ["Security operations", "TypeScript"],
      employer: "Fictional Labs",
    };
    expect(matchesSearch(value, '"security operations" type -python')).toBe(
      true,
    );
    expect(matchesSearch(value, "security -typescript")).toBe(false);
    expect(matchesSearch(value, "employer")).toBe(false);
    expect(matchesSearch(value, '"Fictional Labs"')).toBe(true);
  });
  it("uses Dubai dates at the UTC day boundary", () => {
    expect(dubaiToday(new Date("2026-01-31T22:00:00Z"))).toBe("2026-02-01");
  });
  it("never applies create defaults to omitted PATCH properties", () => {
    expect(
      updateRecordSchemas["task-field"].parse({
        version: 1,
        data: { options: ["Pending"] },
      }),
    ).toEqual({ version: 1, data: { options: ["Pending"] } });
    expect(
      updateRecordSchemas.application.parse({
        version: 3,
        data: { notes: "New note" },
      }),
    ).toEqual({ version: 3, data: { notes: "New note" } });
    expect(
      updateRecordSchemas.candidate.parse({
        version: 3,
        data: { phone: "123" },
      }),
    ).toEqual({ version: 3, data: { phone: "123" } });
  });
  it("rejects unchecked view filters, forged personal state actors and oversized bulk assignment", () => {
    expect(
      recordDataSchemas["saved-view"].safeParse({
        name: "My view",
        area: "directory",
        query: { sql: "DROP TABLE" },
      }).success,
    ).toBe(false);
    expect(
      candidateStateSchema.safeParse({
        version: 1,
        note: "note",
        userId: "someone-else",
      }).success,
    ).toBe(false);
    expect(candidateStateSchema.safeParse({ version: 0 }).success).toBe(false);
    const view = (query: Record<string, unknown>) =>
      recordDataSchemas["saved-view"].safeParse({
        name: "Fictional view",
        area: "directory",
        query,
      });
    expect(
      view({
        certifications: ["Fictional certificate"],
        education: "Fictional University",
        minYearsExperience: 3,
        maxYearsExperience: 5,
      }).success,
    ).toBe(true);
    expect(view({ minYearsExperience: 101 }).success).toBe(false);
    expect(view({ maxYearsExperience: -1 }).success).toBe(false);
    expect(
      bulkApplicationsSchema.safeParse({
        candidateIds: Array(501).fill("6df3687a-9244-4917-8fdb-d5d8d083f2db"),
        vacancyId: "6df3687a-9244-4917-8fdb-d5d8d083f2db",
      }).success,
    ).toBe(false);
  });
  it("provides complete reusable form metadata for each supported resource", () => {
    expect(Object.keys(resourceToKind)).toHaveLength(13);
    for (const [resource, kind] of Object.entries(resourceToKind)) {
      const config = RESOURCE_CONFIG[resource as keyof typeof RESOURCE_CONFIG];
      expect(config.kind).toBe(kind);
      expect(config.fields.map((field) => field.key)).toEqual(
        systemFieldKeys(kind),
      );
    }
  });
  it("takes optional custom values in the bounded task shape on the eight configurable kinds (R2b-02)", () => {
    const field = "6df3687a-9244-4917-8fdb-d5d8d083f2db";
    const other = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
    const minimal: Partial<Record<RecordKind, Record<string, unknown>>> = {
      candidate: { name: "Fictional Person" },
      "job-role": { title: "Fictional role" },
      vacancy: { title: "Fictional vacancy" },
      application: {},
      interview: {
        title: "Fictional interview",
        startAt: "2026-01-01T09:00:00Z",
      },
      offer: { title: "Fictional offer" },
      onboarding: {},
      checklist: { title: "Fictional item" },
    };
    const accepted = {
      [field]: "x".repeat(4000),
      [other]: 42.5,
      "11111111-2222-4333-8444-555555555555": true,
      "21111111-2222-4333-8444-555555555555": null,
    };
    const refused = [
      { "not-a-uuid": "Fictional value" },
      { [field]: { nested: "Fictional value" } },
      { [field]: ["Fictional value"] },
      { [field]: "x".repeat(4001) },
      { [field]: Number.POSITIVE_INFINITY },
      { [field]: Number.NaN },
    ];
    for (const [name, data] of Object.entries(minimal)) {
      const kind = name as RecordKind;
      const schema = recordDataSchemas[kind];
      const parsed = schema.parse({ ...data, customValues: accepted }) as {
        customValues?: unknown;
      };
      expect(parsed.customValues, kind).toEqual(accepted);
      expect(Object.keys(schema.parse(data) as object), kind).not.toContain(
        "customValues",
      );
      for (const customValues of refused) {
        expect(
          schema.safeParse({ ...data, customValues }).success,
          `${kind} ${JSON.stringify(Object.values(customValues))}`,
        ).toBe(false);
        expect(
          updateRecordSchemas[kind].safeParse({
            version: 1,
            data: { customValues },
          }).success,
          kind,
        ).toBe(false);
      }
      expect(
        updateRecordSchemas[kind].parse({
          version: 1,
          data: { customValues: { [field]: "Fictional value" } },
        }),
      ).toEqual({
        version: 1,
        data: { customValues: { [field]: "Fictional value" } },
      });
    }
    // Tasks keep their default; the four other kinds still refuse the key.
    expect(
      recordDataSchemas.task.parse({ title: "Fictional task" }).customValues,
    ).toEqual({});
    expect(
      recordDataSchemas.task.safeParse({
        title: "Fictional task",
        customValues: { [field]: "x".repeat(4001) },
      }).success,
    ).toBe(false);
    for (const [kind, data] of [
      ["bucket", { name: "Fictional bucket" }],
      ["task-field", { name: "Fictional field" }],
      ["saved-view", { name: "Fictional view", area: "directory", query: {} }],
      ["comment", { body: "Fictional comment" }],
    ] as const)
      expect(
        recordDataSchemas[kind].safeParse({
          ...data,
          customValues: { [field]: "Fictional value" },
        }).success,
        kind,
      ).toBe(false);
  });
  it("lists today's system field keys, without customValues for every kind but task", () => {
    for (const kind of Object.values(resourceToKind)) {
      const keys = Object.keys(recordDataSchemas[kind].shape);
      expect(systemFieldKeys(kind), kind).toEqual(
        kind === "task" ? keys : keys.filter((key) => key !== "customValues"),
      );
      expect(systemFieldKeys(kind).includes("customValues"), kind).toBe(
        kind === "task",
      );
    }
    expect(Object.keys(recordDataSchemas.candidate.shape).at(-1)).toBe(
      "customValues",
    );
  });
  it("rejects deep or non-JSON source structures before recursive parsing or hashing", () => {
    let deep: unknown = "value";
    for (let index = 0; index < 100; index++) deep = { nested: deep };
    expect(
      recordDataSchemas.candidate.safeParse({
        name: "Fictional Person",
        rawSource: { deep },
      }).success,
    ).toBe(false);
    expect(
      recordDataSchemas.candidate.safeParse({
        name: "Fictional Person",
        rawSource: { date: new Date() },
      }).success,
    ).toBe(false);
    expect(
      recordDataSchemas.candidate.safeParse({
        name: "Fictional Person",
        rawSource: { oversized: "界".repeat(70000) },
      }).success,
    ).toBe(false);
  });
});
