import { describe, expect, it } from "vitest";
import {
  bulkApplicationsSchema,
  candidateStateSchema,
  daySchema,
  dubaiToday,
  matchesSearch,
  recordDataSchemas,
  resourceToKind,
  RESOURCE_CONFIG,
  updateRecordSchemas,
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
        Object.keys(recordDataSchemas[kind].shape),
      );
    }
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
