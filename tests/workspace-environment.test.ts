import { describe, expect, it } from "vitest";
import { workspaceEnvironment } from "@/lib/workspace";

describe("export environment label", () => {
  it("trusts only VERCEL=1 with a known VERCEL_ENV", () => {
    expect(
      workspaceEnvironment({ VERCEL: "1", VERCEL_ENV: "production" }),
    ).toBe("Production");
    expect(workspaceEnvironment({ VERCEL: "1", VERCEL_ENV: "preview" })).toBe(
      "Preview",
    );
    expect(workspaceEnvironment({})).toBe("Local development");
    expect(workspaceEnvironment({ VERCEL_ENV: "production" })).toBe(
      "Local development",
    );
  });
});
