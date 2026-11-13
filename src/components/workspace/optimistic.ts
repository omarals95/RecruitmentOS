import type { RecordDto, ResourceName } from "@/domain/records";
import type { CacheIdentity, DataCache } from "./data-cache";
import { personalStateMutation } from "./mutation";

/**
 * Optimistic quick actions: the change is applied to every cached copy synchronously, sent in the
 * background, replaced by the server's answer on success, and on failure restored, explained and
 * followed by one reread of only the changed record.
 */
export type Requester = <T>(path: string, init?: RequestInit) => Promise<T>;
export type OptimisticResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: number;
      /** A 409: someone else changed the record first. */
      conflict: boolean;
      message: string;
      error: unknown;
    };
interface Action<T> {
  /** Marks the record pending, so its control stays disabled until the write settles. */
  pendingKey: string;
  /** What the person did, for example "Moving Fictional task to Done". */
  label: string;
  apply(): void;
  restore(): void;
  send(): Promise<T>;
  settle(value: T): void;
  reread: { path: string; found(body: unknown): void; missing(): void };
  /** Replaces the default "was undone" message, for forms that keep their draft. */
  message?: (reason: string) => string;
}

const statusOf = (error: unknown) =>
  error && typeof error === "object" && "status" in error
    ? Number(error.status)
    : 0;
const aborted = (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  "name" in error &&
  error.name === "AbortError";
const reasonOf = (error: unknown) =>
  error instanceof Error && error.message
    ? error.message
    : "The request could not be completed.";
export function undoneMessage(label: string, error: unknown): string {
  return `${label} could not be saved, so it was undone. ${reasonOf(error)}`;
}

/** Not async: apply runs and the request starts in the same tick as the call. */
export function runOptimistic<T>(
  cache: Pick<DataCache, "setPending">,
  request: Requester,
  action: Action<T>,
): Promise<OptimisticResult<T>> {
  cache.setPending(action.pendingKey, true);
  action.apply();
  let sent: Promise<T>;
  try {
    sent = action.send();
  } catch (error) {
    sent = Promise.reject(error);
  }
  return sent
    .then(
      (value): OptimisticResult<T> => {
        action.settle(value);
        return { ok: true, value };
      },
      async (error: unknown): Promise<OptimisticResult<T>> => {
        action.restore();
        const status = statusOf(error);
        // A team switch aborts the request; the old team's records are gone, so nothing is reread.
        if (!aborted(error))
          try {
            action.reread.found(await request(action.reread.path));
          } catch (reread) {
            if (statusOf(reread) === 404) action.reread.missing();
          }
        return {
          ok: false,
          status,
          conflict: status === 409,
          message: aborted(error)
            ? ""
            : action.message
              ? action.message(reasonOf(error))
              : undoneMessage(action.label, error),
          error,
        };
      },
    )
    .finally(() => cache.setPending(action.pendingKey, false));
}

/**
 * A PATCH of one record. `next` is the record as it should look; `local` mirrors each state into
 * copies a screen keeps outside the cache (null when the reread finds it gone).
 */
export function updateRecord(
  cache: Pick<DataCache, "setPending" | "patchRecord" | "removeRecord">,
  request: Requester,
  input: {
    teamId: string;
    resource: ResourceName;
    record: RecordDto;
    next: RecordDto;
    body: Record<string, unknown>;
    label: string;
    local?: (record: RecordDto | null) => void;
  },
): Promise<OptimisticResult<RecordDto>> {
  const { teamId, record, local } = input;
  const path = `/api/v1/${input.resource}/${record.id}`;
  const show = (value: RecordDto) => {
    cache.patchRecord(teamId, value);
    local?.(value);
  };
  return runOptimistic(cache, request, {
    pendingKey: record.id,
    label: input.label,
    apply: () => show(input.next),
    restore: () => show(record),
    send: () =>
      request<{ data: RecordDto }>(path, {
        method: "PATCH",
        body: JSON.stringify(input.body),
      }).then((response) => response.data),
    settle: show,
    reread: {
      path,
      found: (body) => show((body as { data: RecordDto }).data),
      missing: () => {
        cache.removeRecord(teamId, record.id);
        local?.(null);
      },
    },
  });
}
/** The board move: a task to another bucket or an application to another stage. */
export function moveRecord(
  cache: Pick<DataCache, "setPending" | "patchRecord" | "removeRecord">,
  request: Requester,
  input: {
    teamId: string;
    resource: "tasks" | "applications";
    record: RecordDto;
    target: string;
    label: string;
  },
) {
  const { record, target } = input;
  return updateRecord(cache, request, {
    ...input,
    next:
      input.resource === "tasks"
        ? { ...record, bucketId: target }
        : ({
            ...record,
            data: { ...record.data, stage: target },
          } as RecordDto),
    body:
      input.resource === "tasks"
        ? { version: record.version, bucketId: target }
        : { version: record.version, data: { stage: target } },
  });
}

export interface NotificationList {
  data: { key: string; read: boolean }[];
  unread: number;
  unreadCount?: number;
}
export function markedRead<T extends NotificationList>(
  list: T,
  keys: string[],
): T {
  const data = list.data.map((item) =>
    keys.includes(item.key) ? { ...item, read: true } : item,
  );
  const unread = data.filter((item) => !item.read).length;
  return {
    ...list,
    data,
    unread,
    ...(list.unreadCount === undefined ? {} : { unreadCount: unread }),
  };
}
/** Mark read: every shown copy of the notification list changes at once. */
export function markNotificationsRead(
  cache: Pick<DataCache, "setPending" | "read" | "set">,
  request: Requester,
  input: { identity: CacheIdentity; path: string; keys: string[] },
): Promise<OptimisticResult<unknown>> {
  const { identity, path, keys } = input;
  const previous = cache.read(identity, path) as NotificationList | null;
  return runOptimistic(cache, request, {
    pendingKey: path,
    label:
      keys.length === 1
        ? "Marking the reminder as read"
        : "Marking reminders as read",
    apply: () => {
      if (previous) cache.set(identity, path, markedRead(previous, keys));
    },
    restore: () => {
      if (previous) cache.set(identity, path, previous);
    },
    send: () =>
      request(path, { method: "POST", body: JSON.stringify({ keys }) }),
    // requestJson revalidates the shown list in the background after the write.
    settle: () => undefined,
    reread: {
      path,
      found: (body) => cache.set(identity, path, body),
      missing: () => undefined,
    },
  });
}

export interface FollowupState {
  version: number;
  shortlisted: boolean;
  status: string;
  note: string;
}
/**
 * Saves the private follow-up. The form shows it saved at once; on failure the draft stays, marked
 * unsaved, with the message.
 */
export function saveFollowup(
  cache: Pick<DataCache, "setPending" | "read" | "set">,
  request: Requester,
  input: {
    identity: CacheIdentity;
    candidateId: string;
    draft: FollowupState;
    form: (state: { draft: FollowupState; dirty: boolean }) => void;
  },
): Promise<OptimisticResult<FollowupState>> {
  const { identity, draft, form } = input;
  const path = `/api/v1/candidates/${input.candidateId}/state`;
  const previous = cache.read(identity, path);
  return runOptimistic(cache, request, {
    pendingKey: path,
    label: "Your follow-up",
    message: (reason) =>
      `Your follow-up was not saved. ${reason} Your draft is kept, so you can try again.`,
    apply: () => {
      cache.set(identity, path, { data: draft });
      form({ draft, dirty: false });
    },
    restore: () => {
      if (previous) cache.set(identity, path, previous);
      form({ draft, dirty: true });
    },
    send: () =>
      request<{ data: FollowupState }>(path, {
        method: "PATCH",
        body: JSON.stringify(personalStateMutation(draft)),
      }).then((response) => response.data),
    settle: (value) => {
      cache.set(identity, path, { data: value });
      form({ draft: value, dirty: false });
    },
    // The reread updates the saved copy only; the unsaved draft is kept.
    reread: {
      path,
      found: (body) => cache.set(identity, path, body),
      missing: () => undefined,
    },
  });
}
