import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/app",
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import { navigation } from "../src/components/workspace/shell";
import { SPEED_TABS } from "../src/domain/speed";
import {
  BUCKETS_PATH,
  OVERVIEW_PATH,
  PREFETCH_TABS,
  calendarDays,
  defaultListQuery,
  interviewRangePath,
  listPath,
  listSearchParams,
  prefetchTabs,
  screenDefinitions,
  tabRequests,
  viewsPath,
} from "../src/components/workspace/tab-requests";

const TODAY = "2026-11-07";

describe("first-load requests of the main tabs", () => {
  it("lists every navigation tab except settings", () => {
    expect(Object.keys(tabRequests(TODAY)).sort()).toEqual(
      navigation
        .map((item) => item.href)
        .filter((href) => !href.startsWith("/app/settings"))
        .sort(),
    );
  });

  it("times every navigation tab except settings in the speed log", () => {
    expect(
      navigation
        .map((item) => item.href)
        .filter((href) => !href.startsWith("/app/settings"))
        .map((href) => (href === "/app" ? "overview" : href.slice(5))),
    ).toEqual([...SPEED_TABS]);
  });

  it("builds the prefetched tabs' paths with the screens' own default builders", () => {
    const screen = (section: string) =>
      listPath(
        screenDefinitions[section].resource,
        listSearchParams(section, defaultListQuery(section)),
      );
    const all = tabRequests(TODAY);
    expect(all["/app"]).toEqual([OVERVIEW_PATH]);
    expect(all["/app/candidates"]).toEqual([
      screen("candidates"),
      viewsPath("candidates"),
    ]);
    expect(all["/app/pipeline"]).toEqual([
      screen("pipeline"),
      viewsPath("applications"),
    ]);
    expect(all["/app/tasks"]).toEqual([screen("tasks"), BUCKETS_PATH]);
    expect(all["/app/vacancies"]).toEqual([screen("vacancies")]);
    expect(all["/app/interviews"]).toEqual([
      interviewRangePath(calendarDays(TODAY, "month"), 1),
    ]);
    // The exact strings the Tasks and Candidates screens request first.
    expect(all["/app/tasks"]).toEqual([
      "/api/v1/tasks?page=1&pageSize=25&search=&sort=updatedAt&direction=asc",
      "/api/v1/buckets?pageSize=100&sort=position&direction=asc",
    ]);
    expect(all["/app/candidates"][0]).toBe(
      "/api/v1/candidates?page=1&pageSize=25&search=&sort=name&direction=asc",
    );
    expect(PREFETCH_TABS).toEqual([
      "/app",
      "/app/candidates",
      "/app/pipeline",
      "/app/tasks",
      "/app/vacancies",
    ]);
  });

  it("prefetches at most 2 requests at a time and skips cached keys", async () => {
    const cached = new Set([BUCKETS_PATH]);
    const started: string[] = [];
    let running = 0;
    let most = 0;
    await prefetchTabs(
      async (path) => {
        started.push(path);
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running--;
        cached.add(path);
      },
      (path) => cached.has(path),
      TODAY,
    );
    const all = tabRequests(TODAY);
    const expected = [
      ...new Set(PREFETCH_TABS.flatMap((tab) => all[tab])),
    ].filter((path) => path !== BUCKETS_PATH);
    expect(started).toEqual(expected);
    expect(most).toBe(2);
    expect(started).not.toContain(BUCKETS_PATH);
  });
});
