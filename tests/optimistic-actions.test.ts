import { describe, expect, it } from "vitest";
import type { RecordDto } from "../src/domain/records";
import { createDataCache } from "../src/components/workspace/data-cache";
import {
  markNotificationsRead,
  moveRecord,
  saveFollowup,
  type FollowupState,
  type Requester,
} from "../src/components/workspace/optimistic";

// Fictional team and records only; the requester is a fake whose answers the test controls.
const A = { userId: "fictional-user", teamId: "fictional-team" };
class FakeError extends Error {
  constructor(public status: number) {
    super(`Fictional server answer ${status}.`);
  }
}
function record(
  kind: "task" | "application",
  version = 1,
  change: Partial<RecordDto> = {},
): RecordDto {
  return {
    id: `${kind}-1`,
    kind,
    version,
    bucketId: kind === "task" ? "bucket-todo" : null,
    data:
      kind === "task"
        ? { title: "Fictional follow-up call" }
        : { stage: "Sourced" },
    ...change,
  } as unknown as RecordDto;
}
/** Requests are recorded; each answer waits until the test settles it. */
function requester() {
  const calls: { path: string; method: string }[] = [];
  const answers: {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const request: Requester = <T>(path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? "GET" });
    return new Promise<T>((resolve, reject) =>
      answers.push({ resolve: resolve as (value: unknown) => void, reject }),
    );
  };
  return { request, calls, answers };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const listPath = "/api/v1/tasks?page=1";
const boardPath = "/api/v1/applications?vacancyId=v1#board";
function setup(kind: "task" | "application") {
  const cache = createDataCache(() => new Promise(() => {}));
  cache.setIdentity(A);
  const original = record(kind);
  if (kind === "task") {
    cache.set(A, listPath, { data: [original], pagination: { total: 1 } });
    cache.set(A, `/api/v1/tasks/${original.id}`, { data: original });
  } else
    cache.set(A, boardPath, {
      tooMany: false,
      rows: [original],
      total: 1,
      complete: true,
    });
  const read = () =>
    kind === "task"
      ? (cache.read(A, listPath) as { data: RecordDto[] }).data
      : (cache.read(A, boardPath) as { rows: RecordDto[] }).rows;
  return { cache, original, read };
}
const where = (row: RecordDto | undefined) =>
  row?.kind === "task" ? row.bucketId : (row?.data as { stage?: string }).stage;

describe.each([
  {
    kind: "task" as const,
    resource: "tasks" as const,
    from: "bucket-todo",
    target: "bucket-done",
  },
  {
    kind: "application" as const,
    resource: "applications" as const,
    from: "Sourced",
    target: "Screening",
  },
])("optimistic $resource move", ({ kind, resource, from, target }) => {
  const move = (cache: ReturnType<typeof setup>["cache"], r: Requester) =>
    moveRecord(cache, r, {
      teamId: A.teamId,
      resource,
      record: record(kind),
      target,
      label: `Moving Fictional record to ${target}`,
    });

  it("shows the move synchronously and marks the record pending", () => {
    const { cache, read } = setup(kind);
    const { request, calls } = requester();
    void move(cache, request);
    expect(where(read()[0])).toBe(target);
    expect(cache.pendingKeys().has(`${kind}-1`)).toBe(true);
    expect(calls).toEqual([
      { path: `/api/v1/${resource}/${kind}-1`, method: "PATCH" },
    ]);
  });

  it("keeps the server's record with its new version after one PATCH", async () => {
    const { cache, read } = setup(kind);
    const { request, calls, answers } = requester();
    const result = move(cache, request);
    const saved =
      kind === "task"
        ? record(kind, 2, { bucketId: target })
        : record(kind, 2, { data: { stage: target } } as never);
    answers[0].resolve({ data: saved });
    expect(await result).toEqual({ ok: true, value: saved });
    expect(read()[0]).toEqual(saved);
    expect(calls).toHaveLength(1);
    expect(cache.pendingKeys().size).toBe(0);
  });

  it.each([500, 409])(
    "puts the record back on a %i, names the action and rereads only that record",
    async (status) => {
      const { cache, read, original } = setup(kind);
      const { request, calls, answers } = requester();
      const result = move(cache, request);
      answers[0].reject(new FakeError(status));
      await settle();
      // The restore happens before the reread answers.
      expect(where(read()[0])).toBe(from);
      expect(calls[1]).toEqual({
        path: `/api/v1/${resource}/${kind}-1`,
        method: "GET",
      });
      const latest = { ...original, version: 3 };
      answers[1].resolve({ data: latest });
      const outcome = await result;
      expect(outcome).toMatchObject({
        ok: false,
        status,
        conflict: status === 409,
      });
      if (!outcome.ok) {
        expect(outcome.message).toContain(
          `Moving Fictional record to ${target}`,
        );
        expect(outcome.message).toContain("undone");
      }
      expect(read()[0]).toEqual(latest);
      expect(calls).toHaveLength(2);
      expect(cache.pendingKeys().size).toBe(0);
    },
  );

  it("removes the record from cached lists when the reread finds it gone", async () => {
    const { cache, read } = setup(kind);
    const { request, answers } = requester();
    const result = move(cache, request);
    answers[0].reject(new FakeError(409));
    await settle();
    answers[1].reject(new FakeError(404));
    await result;
    expect(read()).toEqual([]);
  });
});

describe("optimistic follow-up save", () => {
  const path = "/api/v1/candidates/candidate-1/state";
  const saved: FollowupState = {
    version: 1,
    shortlisted: false,
    status: "New",
    note: "",
  };
  const draft: FollowupState = {
    ...saved,
    shortlisted: true,
    note: "Fictional private note",
  };
  function start() {
    const cache = createDataCache(() => new Promise(() => {}));
    cache.setIdentity(A);
    cache.set(A, path, { data: saved });
    const form: { draft: FollowupState; dirty: boolean }[] = [];
    const { request, calls, answers } = requester();
    const result = saveFollowup(cache, request, {
      identity: A,
      candidateId: "candidate-1",
      draft,
      form: (state) => form.push(state),
    });
    return { cache, form, calls, answers, result };
  }

  it("shows the draft saved at once and keeps the server's version", async () => {
    const { cache, form, calls, answers, result } = start();
    expect(cache.read(A, path)).toEqual({ data: draft });
    expect(form.at(-1)).toEqual({ draft, dirty: false });
    expect(cache.pendingKeys().has(path)).toBe(true);
    answers[0].resolve({ data: { ...draft, version: 2 } });
    expect((await result).ok).toBe(true);
    expect(cache.read(A, path)).toEqual({ data: { ...draft, version: 2 } });
    expect(calls).toHaveLength(1);
  });

  it.each([500, 409])(
    "keeps the draft marked unsaved on a %i and rereads only the saved state",
    async (status) => {
      const { cache, form, calls, answers, result } = start();
      answers[0].reject(new FakeError(status));
      await settle();
      expect(form.at(-1)).toEqual({ draft, dirty: true });
      expect(cache.read(A, path)).toEqual({ data: saved });
      expect(calls[1]).toEqual({ path, method: "GET" });
      answers[1].resolve({ data: { ...saved, version: 4 } });
      const outcome = await result;
      expect(outcome).toMatchObject({ ok: false, conflict: status === 409 });
      if (!outcome.ok) {
        expect(outcome.message).toContain("Your follow-up was not saved");
        expect(outcome.message).toContain("Your draft is kept");
      }
      expect(cache.read(A, path)).toEqual({ data: { ...saved, version: 4 } });
      expect(form.at(-1)?.draft).toEqual(draft);
      expect(calls).toHaveLength(2);
    },
  );
});

describe("optimistic notification mark-read", () => {
  const path = "/api/v1/notifications";
  const list = {
    data: [
      { key: "interview:1", read: false },
      { key: "task:2", read: false },
    ],
    unread: 2,
    unreadCount: 2,
  };
  function start() {
    const cache = createDataCache(() => new Promise(() => {}));
    cache.setIdentity(A);
    cache.set(A, path, list);
    const { request, calls, answers } = requester();
    const result = markNotificationsRead(cache, request, {
      identity: A,
      path,
      keys: ["interview:1"],
    });
    return { cache, calls, answers, result };
  }

  it("marks the reminder read at once and sends one POST", async () => {
    const { cache, calls, answers, result } = start();
    expect(cache.read(A, path)).toEqual({
      data: [
        { key: "interview:1", read: true },
        { key: "task:2", read: false },
      ],
      unread: 1,
      unreadCount: 1,
    });
    answers[0].resolve({ ok: true });
    expect((await result).ok).toBe(true);
    expect(calls).toEqual([{ path, method: "POST" }]);
  });

  it.each([500, 409])(
    "restores the unread reminder on a %i with a message and one reread",
    async (status) => {
      const { cache, calls, answers, result } = start();
      answers[0].reject(new FakeError(status));
      await settle();
      expect(cache.read(A, path)).toEqual(list);
      expect(calls[1]).toEqual({ path, method: "GET" });
      answers[1].resolve(list);
      const outcome = await result;
      expect(outcome).toMatchObject({ ok: false, status });
      if (!outcome.ok)
        expect(outcome.message).toContain(
          "Marking the reminder as read could not be saved, so it was undone.",
        );
      expect(calls).toHaveLength(2);
    },
  );
});
