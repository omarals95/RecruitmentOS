import { failedResourceState } from "./resource-state";

/**
 * In-memory stale-while-revalidate cache for workspace reads, keyed by user, team and path. It is
 * never persisted (no storage, cookie or service worker), holds at most `maxEntries` entries and
 * is cleared on every identity change, team switch and sign-out.
 */
export interface CacheIdentity {
  userId: string;
  teamId: string;
}
export interface CacheSnapshot<T = unknown> {
  data: T | null;
  error: string;
  status?: number;
  loading: boolean;
  refreshing: boolean;
}
/** A custom loader for entries that are not one GET, such as the whole-vacancy board. */
export type Loader = (signal: AbortSignal) => Promise<unknown>;
type Fetcher = (
  teamId: string,
  path: string,
  signal: AbortSignal,
) => Promise<unknown>;
interface Entry {
  key: string;
  identity: CacheIdentity;
  path: string;
  data: unknown;
  hasData: boolean;
  error: string;
  status?: number;
  request?: AbortController;
  /** Records patched while the request was in flight, reapplied over its (older) response. */
  patches: Map<string, RecordLike>;
  load?: Loader;
  listeners: Set<() => void>;
  snapshot: CacheSnapshot;
}
interface RecordLike {
  id: string;
  kind: string;
  version?: number;
}
/** A cached copy with a higher version is newer than the patch and is kept. */
const newer = (record: RecordLike) => (existing: RecordLike) =>
  (existing.version ?? 0) > (record.version ?? 0) ? existing : record;

export const DISABLED_SNAPSHOT: CacheSnapshot = Object.freeze({
  data: null,
  error: "",
  loading: false,
  refreshing: false,
});
export const LOADING_SNAPSHOT: CacheSnapshot = Object.freeze({
  data: null,
  error: "",
  loading: true,
  refreshing: false,
});
/** Summary reads that any write can change. */
const LIVE_RESOURCES = [
  "overview",
  "analytics",
  "activity",
  "notifications",
  "search",
];

/** `/api/v1/<resource>/...?...` gives `<resource>`. */
export function resourceOf(path: string): string {
  return path.split(/[?#]/)[0].split("/")[3] ?? "";
}
/** A list read has no record segment: `/api/v1/<resource>?...`. */
function isList(path: string) {
  return path.split(/[?#]/)[0].split("/").length === 4;
}
export function isRecordDto(value: unknown): value is RecordLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RecordLike).id === "string" &&
    typeof (value as RecordLike).kind === "string"
  );
}

/** The record list or detail shapes the workspace caches: `{data: []}`, `{data: {}}`, `{rows: []}` or `[]`. */
function replaceIn(
  data: unknown,
  id: string,
  change: (record: RecordLike) => RecordLike | null,
): unknown {
  const list = (items: unknown[]) => {
    let changed = false;
    const next: unknown[] = [];
    for (const item of items) {
      if (isRecordDto(item) && item.id === id) {
        changed = true;
        const replaced = change(item);
        if (replaced) next.push(replaced);
      } else next.push(item);
    }
    return changed ? next : undefined;
  };
  if (Array.isArray(data)) return list(data);
  if (typeof data !== "object" || data === null) return undefined;
  const body = data as {
    data?: unknown;
    rows?: unknown;
    pagination?: { total: number };
  };
  if (Array.isArray(body.data)) {
    const next = list(body.data);
    if (!next) return undefined;
    const removed = body.data.length - next.length;
    return {
      ...body,
      data: next,
      ...(removed && body.pagination
        ? {
            pagination: {
              ...body.pagination,
              total: body.pagination.total - removed,
            },
          }
        : {}),
    };
  }
  if (Array.isArray(body.rows)) {
    const next = list(body.rows);
    return next ? { ...body, rows: next } : undefined;
  }
  if (isRecordDto(body.data) && body.data.id === id) {
    const replaced = change(body.data);
    return replaced ? { ...body, data: replaced } : null;
  }
  return undefined;
}

export function createDataCache(fetcher: Fetcher, maxEntries = 200) {
  const entries = new Map<string, Entry>();
  let current: CacheIdentity | null = null;
  const pending = new Set<string>();
  let pendingSnapshot: ReadonlySet<string> = new Set();
  const pendingListeners = new Set<() => void>();

  const keyOf = (identity: CacheIdentity, path: string) =>
    JSON.stringify([identity.userId, identity.teamId, path]);
  function snapshotOf(entry: Entry): CacheSnapshot {
    const inFlight = !!entry.request;
    return {
      data: entry.hasData ? entry.data : null,
      error: inFlight ? "" : entry.error,
      status: inFlight ? undefined : entry.status,
      loading: !entry.hasData && (inFlight || !entry.error),
      refreshing: entry.hasData && inFlight,
    };
  }
  function update(entry: Entry) {
    entry.snapshot = snapshotOf(entry);
    for (const listener of [...entry.listeners]) listener();
  }
  function abort(entry: Entry) {
    const request = entry.request;
    entry.request = undefined;
    entry.patches.clear();
    request?.abort();
  }
  function remove(entry: Entry) {
    abort(entry);
    entries.delete(entry.key);
    entry.hasData = false;
    entry.data = null;
    entry.error = "";
    entry.status = undefined;
    update(entry);
  }
  /** Most recently used last; above the cap the oldest entry nobody shows goes first. */
  function touch(entry: Entry) {
    entries.delete(entry.key);
    entries.set(entry.key, entry);
    while (entries.size > maxEntries) {
      const all = [...entries.values()];
      remove(all.find((item) => !item.listeners.size) ?? all[0]);
    }
  }
  function ensure(identity: CacheIdentity, path: string, load?: Loader) {
    const key = keyOf(identity, path);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        key,
        identity,
        path,
        data: null,
        hasData: false,
        error: "",
        listeners: new Set(),
        patches: new Map(),
        snapshot: LOADING_SNAPSHOT,
      };
      entry.snapshot = snapshotOf(entry);
      entries.set(key, entry);
      touch(entry);
    }
    if (load) entry.load = load;
    return entry;
  }
  /** Shares the request in flight unless `force`, which replaces it (for example after a write). */
  function revalidate(
    identity: CacheIdentity,
    path: string,
    force = false,
  ): Promise<void> {
    const entry = ensure(identity, path);
    if (entry.request && !force) return Promise.resolve();
    abort(entry);
    const controller = new AbortController();
    entry.request = controller;
    update(entry);
    const load =
      entry.load ??
      ((signal: AbortSignal) => fetcher(identity.teamId, path, signal));
    let started: Promise<unknown>;
    try {
      started = load(controller.signal);
    } catch (error) {
      started = Promise.reject(error);
    }
    return started.then(
      (value) => {
        // A replaced, aborted or removed request never overwrites newer data.
        if (entries.get(entry.key) !== entry || entry.request !== controller)
          return;
        entry.request = undefined;
        let data = value;
        for (const record of entry.patches.values())
          data = replaceIn(data, record.id, newer(record)) ?? data;
        entry.patches.clear();
        entry.data = data;
        entry.hasData = true;
        entry.error = "";
        entry.status = undefined;
        update(entry);
      },
      (error: unknown) => {
        if (entries.get(entry.key) !== entry || entry.request !== controller)
          return;
        entry.request = undefined;
        entry.patches.clear();
        const failed = failedResourceState(
          entry.hasData
            ? { key: entry.key, revision: 0, data: entry.data, error: "" }
            : null,
          entry.key,
          0,
          error,
        );
        entry.hasData = entry.hasData && failed.data !== null;
        entry.data = entry.hasData ? entry.data : null;
        entry.error = failed.error;
        entry.status = failed.status;
        update(entry);
      },
    );
  }
  const sameScope = (entry: Entry, teamId: string) =>
    entry.identity.teamId === teamId &&
    (!current || entry.identity.userId === current.userId);
  function patchRecord(teamId: string, record: RecordLike): Set<string> {
    const patched = new Set<string>();
    for (const entry of entries.values()) {
      if (!sameScope(entry, teamId)) continue;
      if (entry.request) entry.patches.set(record.id, record);
      if (!entry.hasData) continue;
      const next = replaceIn(entry.data, record.id, newer(record));
      if (next === undefined || next === null) continue;
      entry.data = next;
      patched.add(entry.key);
      update(entry);
    }
    return patched;
  }
  function notifyPending() {
    pendingSnapshot = new Set(pending);
    for (const listener of [...pendingListeners]) listener();
  }

  return {
    /** Keeps only the given identity's entries; every other entry is dropped and its request aborted. */
    setIdentity(identity: CacheIdentity | null) {
      if (
        current?.userId === identity?.userId &&
        current?.teamId === identity?.teamId
      )
        return;
      current = identity;
      for (const entry of [...entries.values()])
        if (
          !identity ||
          entry.identity.userId !== identity.userId ||
          entry.identity.teamId !== identity.teamId
        )
          remove(entry);
    },
    /** Drops every entry and aborts every request, for a team switch or sign-out. */
    clear() {
      current = null;
      for (const entry of [...entries.values()]) remove(entry);
      pending.clear();
      notifyPending();
    },
    subscribe(
      identity: CacheIdentity,
      path: string,
      listener: () => void,
      load?: Loader,
    ) {
      const entry = ensure(identity, path, load);
      entry.listeners.add(listener);
      touch(entry);
      void revalidate(identity, path);
      return () => {
        entry.listeners.delete(listener);
        // The last viewer left (or its key changed): a late response is no longer wanted.
        if (!entry.listeners.size && entry.request) {
          abort(entry);
          update(entry);
        }
      };
    },
    getSnapshot(identity: CacheIdentity, path: string): CacheSnapshot {
      return entries.get(keyOf(identity, path))?.snapshot ?? LOADING_SNAPSHOT;
    },
    has(identity: CacheIdentity, path: string) {
      return !!entries.get(keyOf(identity, path))?.hasData;
    },
    read(identity: CacheIdentity, path: string): unknown {
      const entry = entries.get(keyOf(identity, path));
      return entry?.hasData ? entry.data : null;
    },
    set(identity: CacheIdentity, path: string, data: unknown) {
      const entry = ensure(identity, path);
      abort(entry);
      entry.data = data;
      entry.hasData = true;
      entry.error = "";
      entry.status = undefined;
      touch(entry);
      update(entry);
    },
    revalidate,
    /** Loads a path nobody shows yet, unless it is cached or already loading. */
    prefetch(identity: CacheIdentity, path: string): Promise<void> {
      const entry = ensure(identity, path);
      if (entry.hasData || entry.request) return Promise.resolve();
      return revalidate(identity, path);
    },
    patchRecord,
    /** A record the server no longer returns leaves every cached list; its detail reads as not found. */
    removeRecord(teamId: string, id: string) {
      for (const entry of entries.values()) {
        if (!sameScope(entry, teamId) || !entry.hasData) continue;
        const next = replaceIn(entry.data, id, () => null);
        if (next === undefined) continue;
        if (next === null) {
          entry.hasData = false;
          entry.data = null;
          entry.error = "The record was not found.";
          entry.status = 404;
        } else entry.data = next;
        update(entry);
      }
    },
    /**
     * After a successful write: a returned record is patched into every entry that holds it, and
     * those are not refetched. Shown lists of the written resource and shown summaries revalidate
     * in the background; the rest revalidate when they are next shown.
     */
    afterWrite(teamId: string, path: string, body: unknown) {
      const data = (body as { data?: unknown } | null)?.data;
      const patched = isRecordDto(data)
        ? patchRecord(teamId, data)
        : new Set<string>();
      const resource = resourceOf(path);
      for (const entry of [...entries.values()]) {
        if (
          patched.has(entry.key) ||
          !entry.listeners.size ||
          !sameScope(entry, teamId)
        )
          continue;
        const own = resourceOf(entry.path);
        if (
          (own === resource && isList(entry.path)) ||
          LIVE_RESOURCES.includes(own)
        )
          void revalidate(entry.identity, entry.path, true);
      }
    },
    setPending(key: string, on: boolean) {
      if (on === pending.has(key)) return;
      if (on) pending.add(key);
      else pending.delete(key);
      notifyPending();
    },
    subscribePending(listener: () => void) {
      pendingListeners.add(listener);
      return () => {
        pendingListeners.delete(listener);
      };
    },
    pendingKeys: (): ReadonlySet<string> => pendingSnapshot,
    size: () => entries.size,
  };
}
export type DataCache = ReturnType<typeof createDataCache>;
