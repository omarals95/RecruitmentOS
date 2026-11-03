import { describe, expect, it } from "vitest";
import {
  canStartImport,
  fileProblem,
} from "../src/components/workspace/bulk-cv-queue";

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
