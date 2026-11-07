import { useEffect, useRef, useState } from "react";
import {
  SPEED_MAX_MS,
  SPEED_MAX_SAMPLES,
  isSpeedAction,
  isSpeedRouteName,
  type SpeedAction,
} from "@/domain/speed";
import { routePattern } from "@/lib/route-pattern";

/**
 * The built-in speed log's browser side: click-to-saved and open-to-ready durations for fixed
 * action names, and one in five API responses as `<METHOD> <pattern>` with its Server-Timing
 * total and db time. Nothing else is recorded. At most 50 samples wait in memory, and one send
 * per 10 seconds per browser goes out, coordinated across tabs by one stored timestamp.
 */
export interface SpeedSample {
  kind: "action" | "route";
  name: string;
  durationMs: number;
  dbMs?: number;
}
export interface SpeedLogDeps {
  /** Wall-clock milliseconds, comparable across tabs. */
  now(): number;
  random(): number;
  lastSent: { read(): number; write(value: number): void };
  send(teamId: string, samples: SpeedSample[], keepalive: boolean): void;
}
export const SEND_INTERVAL_MS = 10_000;
export const ROUTE_SAMPLE_RATE = 0.2;
const API_PREFIX = "/api/v1";

const whole = (ms: number) =>
  Math.min(SPEED_MAX_MS, Math.max(0, Math.round(ms)));
/** `total;dur=…, db;dur=…` from runApi; anything else gives null. */
export function parseServerTiming(
  header: string | null,
): { total: number; db: number } | null {
  const match =
    /^total;dur=(\d+(?:\.\d+)?), db;dur=(\d+(?:\.\d+)?), dbrt;desc="\d+"$/.exec(
      header ?? "",
    );
  return match ? { total: Number(match[1]), db: Number(match[2]) } : null;
}

export function createSpeedLog(deps: SpeedLogDeps) {
  let buffer: SpeedSample[] = [];
  let teamId: string | null = null;
  const push = (sample: SpeedSample) => {
    if (teamId && buffer.length < SPEED_MAX_SAMPLES) buffer.push(sample);
  };
  return {
    /** A different team starts an empty buffer, so no sample is sent under another team. */
    setTeam(next: string | null) {
      if (next === teamId) return;
      buffer = [];
      teamId = next;
    },
    clear() {
      buffer = [];
    },
    action(name: string, durationMs: number) {
      if (isSpeedAction(name))
        push({ kind: "action", name, durationMs: whole(durationMs) });
    },
    route(method: string, path: string, serverTiming: string | null) {
      if (deps.random() >= ROUTE_SAMPLE_RATE) return;
      const timing = parseServerTiming(serverTiming);
      // The fixed /api/v1 prefix stays; every segment after it goes through the shared normaliser.
      const pathname = path.split(/[?#]/)[0];
      if (!pathname.startsWith(API_PREFIX)) return;
      const name = `${method.toUpperCase()} ${API_PREFIX}${routePattern(pathname.slice(API_PREFIX.length))}`;
      if (timing && isSpeedRouteName(name))
        push({
          kind: "route",
          name,
          durationMs: whole(timing.total),
          dbMs: whole(timing.db),
        });
    },
    /** Sends the buffer when 10 seconds have passed since any tab's last send. */
    flush(keepalive = false): boolean {
      if (!teamId || !buffer.length) return false;
      const now = deps.now();
      if (now - deps.lastSent.read() < SEND_INTERVAL_MS) return false;
      deps.lastSent.write(now);
      const samples = buffer;
      buffer = [];
      deps.send(teamId, samples, keepalive);
      return true;
    },
    size: () => buffer.length,
  };
}
export type SpeedLog = ReturnType<typeof createSpeedLog>;

/** Its own request: never through requestJson, so it refreshes no view and samples no route. */
export function sendSpeedSamples(
  teamId: string,
  samples: SpeedSample[],
  keepalive: boolean,
) {
  void fetch("/api/v1/speed-samples", {
    method: "POST",
    keepalive,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-Team-Id": teamId },
    body: JSON.stringify({ samples }),
  }).catch(() => undefined);
}

/** Holds only a number: the time of this browser's last send. */
const LAST_SENT_KEY = "recruitmentos:speed-log-sent";
let browserLog: SpeedLog | null = null;
/** The browser's log once a workspace started it; null on the server and outside the app. */
export function speedLog(): SpeedLog | null {
  return browserLog;
}
/** Started by the workspace with its team; the send timer and pagehide flush start here once. */
export function startSpeedLog(): SpeedLog | null {
  if (typeof window === "undefined") return null;
  if (!browserLog) {
    const log = createSpeedLog({
      now: () => Date.now(),
      random: Math.random,
      lastSent: {
        read: () => {
          try {
            return Number(window.localStorage.getItem(LAST_SENT_KEY)) || 0;
          } catch {
            return 0;
          }
        },
        write: (value) => {
          try {
            window.localStorage.setItem(LAST_SENT_KEY, String(value));
          } catch {
            // Without storage each tab keeps its own 10-second spacing.
          }
        },
      },
      send: sendSpeedSamples,
    });
    window.setInterval(() => log.flush(), SEND_INTERVAL_MS);
    window.addEventListener("pagehide", () => log.flush(true));
    browserLog = log;
  }
  return browserLog;
}

let navigationStart: number | null = null;
/** A main navigation click starts the next screen's open-to-ready timing. */
export function markNavigation() {
  navigationStart = performance.now();
}
/** Records `name` once, from the navigation click (or first render) to the first data shown. */
export function useReadyTiming(name: SpeedAction | null, ready: boolean) {
  const [start] = useState(() =>
    navigationStart !== null && performance.now() - navigationStart < 10_000
      ? navigationStart
      : performance.now(),
  );
  const recorded = useRef(false);
  useEffect(() => {
    if (!name || !ready || recorded.current) return;
    recorded.current = true;
    navigationStart = null;
    speedLog()?.action(name, performance.now() - start);
  }, [name, ready, start]);
}
/** Click-to-saved: call when the click happens, then call the result once saved. */
export function startSpeedTimer(name: SpeedAction): () => void {
  const start = performance.now();
  return () => speedLog()?.action(name, performance.now() - start);
}
