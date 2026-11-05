import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortTeamRequests,
  hasWritesInFlight,
  humanError,
  requestJson,
} from "../src/components/workspace/client";

/** A fetch that only settles when its signal aborts, like a slow server. */
function pendingFetch() {
  const fetch = vi.fn(
    (_path: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal!;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("team-scoped request aborts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("reports and aborts a team's writes without touching another team", async () => {
    pendingFetch();
    const write = requestJson("team-a", "/api/v1/candidates/fictional", {
      method: "PATCH",
      body: JSON.stringify({ version: 1, data: { name: "Fictional" } }),
    });
    const other = requestJson("team-b", "/api/v1/tasks/fictional", {
      method: "PATCH",
      body: JSON.stringify({ version: 1 }),
    });
    expect(hasWritesInFlight("team-a")).toBe(true);
    expect(hasWritesInFlight("team-b")).toBe(true);
    abortTeamRequests("team-a");
    await expect(write).rejects.toMatchObject({ name: "AbortError" });
    expect(humanError(await write.catch((error: unknown) => error))).toBe("");
    expect(hasWritesInFlight("team-a")).toBe(false);
    expect(hasWritesInFlight("team-b")).toBe(true);
    let settled = false;
    void other.finally(() => (settled = true)).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    abortTeamRequests("team-b");
    await expect(other).rejects.toMatchObject({ name: "AbortError" });
    expect(hasWritesInFlight("team-b")).toBe(false);
  });
  it("still aborts through the caller's own signal", async () => {
    pendingFetch();
    const controller = new AbortController();
    const request = requestJson("team-c", "/api/v1/views", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ data: {} }),
    });
    expect(hasWritesInFlight("team-c")).toBe(true);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(hasWritesInFlight("team-c")).toBe(false);
  });
  it("does not count reads or the duplicate lookup as writes in flight", async () => {
    pendingFetch();
    const lookup = requestJson("team-d", "/api/v1/candidates/duplicates", {
      method: "POST",
      body: JSON.stringify({ email: "fictional@example.test" }),
    });
    const read = requestJson("team-d", "/api/v1/candidates");
    expect(hasWritesInFlight("team-d")).toBe(false);
    abortTeamRequests("team-d");
    await expect(lookup).rejects.toMatchObject({ name: "AbortError" });
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
  });
});
