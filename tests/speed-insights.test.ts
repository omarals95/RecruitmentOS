import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import config from "../next.config";
import {
  routePattern,
  scrubSpeedEvent,
  speedInsightsSampleRate,
} from "../src/lib/route-pattern";

const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

describe("Vercel Speed Insights reporting", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("drops the query string, the fragment and every id-like path segment", () => {
    expect(
      scrubSpeedEvent({
        type: "vital",
        url: "https://x.test/app/candidates/3f2c9a1e-0d4b-4c6e-9f00-1a2b3c4d5e6f?tab=cvs#top",
        route: "/app/candidates/[id]",
      }),
    ).toEqual({
      type: "vital",
      url: "https://x.test/app/candidates/[id]",
      route: "/app/candidates/[id]",
    });
    expect(scrubSpeedEvent({ type: "vital", url: "/app/tasks" })).toEqual({
      type: "vital",
      url: "/app/tasks",
    });
    for (const segment of [
      "task2",
      "Fictional",
      "a".repeat(42),
      "sam.sample",
      "%20name",
    ])
      expect(routePattern(`/app/${segment}`), segment).toBe("/app/[id]");
    expect(routePattern(`/app/${"a".repeat(41)}`)).toBe(
      `/app/${"a".repeat(41)}`,
    );
    expect(routePattern("/app/source-review")).toBe("/app/source-review");
  });

  it("uses a sample rate from 0 to 1 and 1 for anything else", () => {
    for (const value of [undefined, "", "abc", "-1", "2", "NaN"])
      expect(speedInsightsSampleRate(value), String(value)).toBe(1);
    expect(speedInsightsSampleRate("0.25")).toBe(0.25);
    expect(speedInsightsSampleRate("0")).toBe(0);
    expect(speedInsightsSampleRate("1")).toBe(1);
  });

  it("is rendered only by the signed-in app layout and the landing page", () => {
    const importers = sourceFiles(srcRoot)
      .filter((file) =>
        /from "@\/components\/speed-insights"/.test(readFileSync(file, "utf8")),
      )
      .map((file) => `src/${relative(srcRoot, file).split(sep).join("/")}`)
      .sort();
    expect(importers).toEqual(["src/app/app/layout.tsx", "src/app/page.tsx"]);
    const wrapper = readFileSync(
      join(srcRoot, "components/speed-insights.tsx"),
      "utf8",
    );
    expect(wrapper).toContain('process.env.NODE_ENV !== "production"');
    for (const forbidden of ["dsn", "endpoint", "scriptSrc", "debug"])
      expect(wrapper).not.toMatch(new RegExp(`\\b${forbidden}=`));
  });

  it("adds no Vercel script or vitals host to any CSP directive", async () => {
    for (const provider of [undefined, "blob", "s3"]) {
      vi.stubEnv("CV_STORAGE_PROVIDER", provider);
      const [rule] = await config.headers!();
      const value = rule.headers.find(
        (header) => header.key === "Content-Security-Policy",
      )!.value;
      expect(value).not.toMatch(/vercel-scripts|vitals\.vercel/);
      expect(value).toMatch(/script-src 'self' 'unsafe-inline';/);
    }
  });
});
