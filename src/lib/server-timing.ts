import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request database round trips and wall time for the Server-Timing header. Only a count and
 * durations are kept: no query text, parameter or result is ever stored.
 */
interface Timing {
  roundTrips: number;
  dbMs: number;
}
const storage = new AsyncLocalStorage<Timing>();

/** Runs work with a fresh counter; `finish` reads it once the response exists. */
export function runWithServerTiming<T>(
  work: (finish: () => string) => Promise<T>,
): Promise<T> {
  const timing: Timing = { roundTrips: 0, dbMs: 0 };
  const start = performance.now();
  return storage.run(timing, () =>
    work(
      () =>
        `total;dur=${(performance.now() - start).toFixed(1)}, db;dur=${timing.dbMs.toFixed(1)}, dbrt;desc="${timing.roundTrips}"`,
    ),
  );
}

/** Counts one awaited statement or batch; outside a request nothing is recorded. */
function measure<T>(timing: Timing | undefined, work: () => T): T {
  if (!timing) return work();
  timing.roundTrips++;
  const start = performance.now();
  const done = () => {
    timing.dbMs += performance.now() - start;
  };
  const result = work();
  if (result && typeof (result as { then?: unknown }).then === "function")
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        done();
        return value;
      },
      (error: unknown) => {
        done();
        throw error;
      },
    ) as T;
  done();
  return result;
}

type Method = (...args: unknown[]) => unknown;
function wrap(target: object, name: string) {
  const original = (target as Record<string, Method>)[name];
  if (typeof original !== "function") return;
  (target as Record<string, Method>)[name] = function (
    this: unknown,
    ...args: unknown[]
  ) {
    const timing = storage.getStore();
    const last = args[args.length - 1];
    // pg-pool's own query passes a callback; time the statement until it fires.
    if (timing && typeof last === "function") {
      timing.roundTrips++;
      const start = performance.now();
      args[args.length - 1] = (...results: unknown[]) => {
        timing.dbMs += performance.now() - start;
        return (last as Method)(...results);
      };
      return original.apply(this, args);
    }
    return measure(timing, () => original.apply(this, args));
  };
}

/** A checked-out pg client: every query, including the pool's own and BEGIN/COMMIT, is one round trip. */
export function countPgClientRoundTrips<T extends object>(client: T): T {
  wrap(client, "query");
  return client;
}

/**
 * A PGlite client: query and exec are one round trip each, and a transaction counts its own BEGIN
 * and COMMIT or ROLLBACK plus every statement sent through its transaction object.
 */
export function countPgliteRoundTrips<T extends object>(client: T): T {
  wrap(client, "query");
  wrap(client, "exec");
  const original = (client as Record<string, Method>).transaction;
  if (typeof original !== "function") return client;
  (client as Record<string, Method>).transaction = function (
    this: unknown,
    callback: unknown,
  ) {
    const timing = storage.getStore();
    if (!timing) return original.call(this, callback);
    timing.roundTrips++;
    let mark = performance.now();
    const finished = () => {
      timing.dbMs += performance.now() - mark;
    };
    return (
      original.call(this, async (tx: object) => {
        finished();
        wrap(tx, "query");
        wrap(tx, "exec");
        try {
          return await (callback as (tx: object) => Promise<unknown>)(tx);
        } finally {
          timing.roundTrips++;
          mark = performance.now();
        }
      }) as Promise<unknown>
    ).then(
      (value) => {
        finished();
        return value;
      },
      (error: unknown) => {
        finished();
        throw error;
      },
    );
  };
  return client;
}
