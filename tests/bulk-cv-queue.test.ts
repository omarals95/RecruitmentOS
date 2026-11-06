import { describe, expect, it } from "vitest";
import {
  BULK_INTAKE_MAX_FILES,
  BULK_INTAKE_RECOVERY_HOURS,
} from "../src/domain/records";
import {
  canStartImport,
  capSelection,
  fileProblem,
  importSummary,
  sameQueue,
  stopsRun,
  uncertainRetryTooOld,
} from "../src/components/workspace/bulk-cv-queue";

const draft = (id: string, email = "", phone = "") => ({
  id,
  fields: { email, phone },
});

describe("bulk CV review safeguards", () => {
  it("does not create a candidate while upload capability is unavailable", () => {
    expect(canStartImport(false, true, true)).toBe(false);
    expect(canStartImport(true, true, true)).toBe(true);
  });

  it("requires explicit review and acknowledgement of possible duplicates", () => {
    expect(canStartImport(true, false, true)).toBe(false);
    expect(canStartImport(true, true, false)).toBe(false);
  });

  it("marks unsupported and oversized files for review", () => {
    expect(fileProblem("cv.exe", 100)).toMatch(/type/i);
    expect(fileProblem("cv.pdf", 10 * 1024 * 1024 + 1)).toMatch(/10 MiB/);
    expect(fileProblem("cv.pdf", 100)).toBe("");
  });
});

describe("bulk CV queue helpers", () => {
  it("keeps at most the batch limit of entries and reports how many were not added", () => {
    const files = Array.from({ length: 30 }, (_, index) => `cv-${index}.pdf`);
    expect(capSelection(0, files)).toEqual({ added: files, skipped: 0 });
    const capped = capSelection(BULK_INTAKE_MAX_FILES - 10, files);
    expect(capped.added).toEqual(files.slice(0, 10));
    expect(capped.skipped).toBe(20);
    expect(capSelection(BULK_INTAKE_MAX_FILES, files)).toEqual({
      added: [],
      skipped: 30,
    });
  });

  it("flags other drafts with the same email in any case or the same phone", () => {
    const entry = draft(
      "a",
      " Amira.Fictional@Example.test ",
      "+971 50 000 0000",
    );
    const queue = [
      entry,
      draft("b", "amira.fictional@example.test"),
      draft("c", "", "+971 50 000 0000"),
      draft("d", "other.fictional@example.test", "+971 50 111 1111"),
    ];
    expect(sameQueue(entry, queue).map((item) => item.id)).toEqual(["b", "c"]);
    expect(sameQueue(draft("e"), queue)).toEqual([]);
  });

  it("groups a mixed run into the five summary groups", () => {
    const summary = importSummary([
      { name: "imported-1.pdf", done: true, candidateId: "c1" },
      { name: "imported-2.pdf", done: true, candidateId: "c2" },
      { name: "pending.pdf", done: false, candidateId: "c3" },
      {
        name: "pending-after-abort.pdf",
        done: false,
        candidateId: "c4",
        result: "unknown",
      },
      { name: "not-reviewed.pdf", done: false },
      { name: "not-started.pdf", done: false },
      { name: "refused.pdf", done: false, result: "failed" },
      { name: "lost.pdf", done: false, result: "unknown" },
    ]);
    expect(
      summary.map(({ group, label, names }) => [group, label, names]),
    ).toEqual([
      ["imported", "Imported", ["imported-1.pdf", "imported-2.pdf"]],
      [
        "cv-pending",
        "Candidate created, CV pending",
        ["pending.pdf", "pending-after-abort.pdf"],
      ],
      ["not-imported", "Not imported", ["not-reviewed.pdf", "not-started.pdf"]],
      ["failed", "Failed", ["refused.pdf"]],
      ["unknown", "Outcome unknown", ["lost.pdf"]],
    ]);
    expect(importSummary([]).map((group) => group.names.length)).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });

  it("stops a run on lost session, permission or storage setup only", () => {
    expect(stopsRun({ status: 401, code: "unauthorized" })).toBe(true);
    expect(stopsRun({ status: 403, code: "scope_required" })).toBe(true);
    expect(stopsRun({ status: 503, code: "STORAGE_SETUP_REQUIRED" })).toBe(
      true,
    );
    expect(stopsRun({ status: 503, code: "STORAGE_UNAVAILABLE" })).toBe(false);
    expect(stopsRun({ status: 400, code: "bulk_review_required" })).toBe(false);
    expect(stopsRun({ status: 409, code: "bulk_duplicates_changed" })).toBe(
      false,
    );
  });

  it("refuses an uncertain retry once the window has passed since the batch start", () => {
    const window = BULK_INTAKE_RECOVERY_HOURS * 3_600_000;
    const batchStartedAt = Date.UTC(2030, 0, 1);
    // The entry itself started an hour after the batch; the batch start still decides.
    const uncertain = {
      submitted: '{"name":"Fictional Late"}',
      startedAt: batchStartedAt + 3_600_000,
    };
    const now = batchStartedAt + window;
    expect(uncertainRetryTooOld(uncertain, batchStartedAt, now)).toBe(true);
    expect(uncertainRetryTooOld(uncertain, batchStartedAt, now - 1)).toBe(
      false,
    );
    expect(
      uncertainRetryTooOld(
        { ...uncertain, candidateId: "fictional-candidate" },
        batchStartedAt,
        now + window,
      ),
    ).toBe(false);
  });
});
