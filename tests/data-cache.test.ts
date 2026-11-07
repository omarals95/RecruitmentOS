import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataCache } from "../src/components/workspace/data-cache";

// Fictional identities and records only. The fetcher is a fake that never touches the network.
const A = { userId: "fictional-user", teamId: "fictional-team-a" };
const B = { userId: "fictional-user", teamId: "fictional-team-b" };
const task = (id: string, version: number, bucketId = "bucket-1") => ({
  id,
  kind: "task",
  version,
  bucketId,
  data: { title: `Fictional task ${id}` },
});
const list = (...rows: ReturnType<typeof task>[]) => ({
  data: rows,
  pagination: { page: 1, pageSize: 25, total: rows.length, totalPages: 1 },
});
class FakeError extends Error {
  constructor(public status: number) {
    super(`Fictional failure ${status}`);
  }
}
/** Each call waits until the test answers it; abort only flags the signal, like a late network reply. */
function harness(maxEntries?: number) {
  const calls: {
    teamId: string;
    path: string;
    signal: AbortSignal;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const cache = createDataCache(
    (teamId, path, signal) =>
      new Promise((resolve, reject) =>
        calls.push({ teamId, path, signal, resolve, reject }),
      ),
    maxEntries,
  );
  return { cache, calls };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("workspace data cache", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("gives a second subscriber the cached data at once while one background request runs", async () => {
    const { cache, calls } = harness();
    cache.subscribe(A, "/api/v1/tasks?page=1", () => {});
    expect(cache.getSnapshot(A, "/api/v1/tasks?page=1")).toMatchObject({
      loading: true,
      data: null,
    });
    calls[0].resolve(list(task("t1", 1)));
    await settle();
    cache.subscribe(A, "/api/v1/tasks?page=1", () => {});
    const snapshot = cache.getSnapshot(A, "/api/v1/tasks?page=1");
    expect(snapshot.loading).toBe(false);
    expect(snapshot.refreshing).toBe(true);
    expect(snapshot.data).toEqual(list(task("t1", 1)));
    expect(calls).toHaveLength(2);
  });

  it("shares one request between concurrent reads of one key", () => {
    const { cache, calls } = harness();
    cache.subscribe(A, "/api/v1/candidates?page=1", () => {});
    cache.subscribe(A, "/api/v1/candidates?page=1", () => {});
    void cache.prefetch(A, "/api/v1/candidates?page=1");
    void cache.revalidate(A, "/api/v1/candidates?page=1");
    expect(calls).toHaveLength(1);
  });

  it("aborts on a key change or the last unsubscribe, and a late response never overwrites newer data", async () => {
    const { cache, calls } = harness();
    const first = cache.subscribe(A, "/api/v1/tasks?search=a", () => {});
    // A filter change: the old key's last subscriber leaves, the new key subscribes.
    first();
    cache.subscribe(A, "/api/v1/tasks?search=ab", () => {});
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].resolve(list(task("stale", 1)));
    await settle();
    expect(cache.has(A, "/api/v1/tasks?search=a")).toBe(false);

    calls[1].resolve(list(task("t1", 1)));
    await settle();
    void cache.revalidate(A, "/api/v1/tasks?search=ab", true);
    void cache.revalidate(A, "/api/v1/tasks?search=ab", true);
    expect(calls[2].signal.aborted).toBe(true);
    calls[3].resolve(list(task("t1", 3)));
    await settle();
    calls[2].resolve(list(task("t1", 2)));
    await settle();
    expect(cache.read(A, "/api/v1/tasks?search=ab")).toEqual(
      list(task("t1", 3)),
    );
  });

  it("deletes an entry on a 403 or 404 revalidation and keeps it on other errors", async () => {
    const { cache, calls } = harness();
    for (const [index, status] of [403, 404].entries()) {
      const path = `/api/v1/tasks/t${index}`;
      cache.set(A, path, { data: task(`t${index}`, 1) });
      void cache.revalidate(A, path);
      calls[index].reject(new FakeError(status));
      await settle();
      expect(cache.getSnapshot(A, path)).toMatchObject({
        data: null,
        status,
        error: `Fictional failure ${status}`,
        loading: false,
      });
      expect(cache.has(A, path)).toBe(false);
    }
    cache.set(A, "/api/v1/tasks/t9", { data: task("t9", 1) });
    void cache.revalidate(A, "/api/v1/tasks/t9");
    calls[2].reject(new FakeError(500));
    await settle();
    expect(cache.getSnapshot(A, "/api/v1/tasks/t9")).toMatchObject({
      data: { data: task("t9", 1) },
      status: 500,
    });
  });

  it("patches a written record into every entry holding it and revalidates only shown summaries and other lists", async () => {
    const { cache, calls } = harness();
    cache.setIdentity(A);
    const paths = {
      board: "/api/v1/tasks?page=1",
      detail: "/api/v1/tasks/t1",
      other: "/api/v1/tasks?page=2",
      overview: "/api/v1/overview",
      hidden: "/api/v1/activity?page=1",
      buckets: "/api/v1/buckets?pageSize=100",
    };
    const shown = [paths.board, paths.detail, paths.other, paths.overview];
    for (const path of [...shown, paths.buckets])
      cache.subscribe(A, path, () => {});
    calls[0].resolve(list(task("t1", 1), task("t2", 1)));
    calls[1].resolve({ data: task("t1", 1) });
    calls[2].resolve(list(task("t3", 1)));
    calls[3].resolve({ counts: {} });
    calls[4].resolve(list());
    cache.set(A, paths.hidden, { data: [] });
    await settle();
    expect(calls).toHaveLength(5);

    const saved = task("t1", 2, "bucket-2");
    cache.afterWrite(A.teamId, "/api/v1/tasks/t1", { data: saved });
    expect(
      (cache.read(A, paths.board) as ReturnType<typeof list>).data[0],
    ).toEqual(saved);
    expect(cache.read(A, paths.detail)).toEqual({ data: saved });
    // Only the other tasks list and the shown overview are read again, once each.
    expect(calls.slice(5).map((call) => call.path)).toEqual([
      paths.other,
      paths.overview,
    ]);
  });

  it("drops every entry of the old identity on a change or an explicit clear and aborts its requests", async () => {
    const { cache, calls } = harness();
    cache.setIdentity(A);
    cache.set(A, "/api/v1/candidates?page=1", list());
    cache.subscribe(A, "/api/v1/tasks?page=1", () => {});
    cache.setIdentity(B);
    expect(calls[0].signal.aborted).toBe(true);
    expect(cache.has(A, "/api/v1/candidates?page=1")).toBe(false);
    expect(cache.getSnapshot(A, "/api/v1/tasks?page=1").data).toBeNull();
    calls[0].resolve(list(task("a-task", 1)));
    await settle();
    expect(cache.has(A, "/api/v1/tasks?page=1")).toBe(false);

    cache.setIdentity({ userId: "other-fictional-user", teamId: B.teamId });
    cache.set(B, "/api/v1/tasks?page=1", list());
    cache.subscribe(B, "/api/v1/overview", () => {});
    cache.clear();
    expect(calls[1].signal.aborted).toBe(true);
    expect(cache.has(B, "/api/v1/tasks?page=1")).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("evicts the least recently used entry when the 201st is added", () => {
    const { cache } = harness();
    for (let index = 0; index < 200; index++)
      cache.set(A, `/api/v1/tasks?page=${index}`, list());
    // Reading an entry back does not count; setting the first one again does.
    cache.set(A, "/api/v1/tasks?page=0", list());
    cache.set(A, "/api/v1/tasks?page=200", list());
    expect(cache.size()).toBe(200);
    expect(cache.has(A, "/api/v1/tasks?page=0")).toBe(true);
    expect(cache.has(A, "/api/v1/tasks?page=1")).toBe(false);
    expect(cache.has(A, "/api/v1/tasks?page=200")).toBe(true);
  });

  it("never touches localStorage, sessionStorage or indexedDB", async () => {
    const forbidden = () =>
      new Proxy(
        {},
        {
          get() {
            throw new Error("Persistent browser storage must not be used.");
          },
        },
      );
    vi.stubGlobal("localStorage", forbidden());
    vi.stubGlobal("sessionStorage", forbidden());
    vi.stubGlobal("indexedDB", forbidden());
    const { cache, calls } = harness(3);
    cache.setIdentity(A);
    const stop = cache.subscribe(A, "/api/v1/tasks?page=1", () => {});
    calls[0].resolve(list(task("t1", 1)));
    await settle();
    cache.afterWrite(A.teamId, "/api/v1/tasks/t1", { data: task("t1", 2) });
    cache.removeRecord(A.teamId, "t1");
    for (let index = 0; index < 5; index++)
      cache.set(A, `/api/v1/views?page=${index}`, list());
    stop();
    cache.setPending("t1", true);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
