"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createDataCache,
  DISABLED_SNAPSHOT,
  LOADING_SNAPSHOT,
  type CacheIdentity,
  type CacheSnapshot,
  type Loader,
} from "./data-cache";
import type { Requester } from "./optimistic";
import { speedLog, startSpeedLog } from "./speed-log";

export interface WorkspaceIdentity {
  user: { id: string; name: string; email: string };
  team: { id: string; name: string; slug: string } | null;
  role: string | null;
  environment: string;
  canCreateTeam: boolean;
}
const WorkspaceContext = createContext<WorkspaceIdentity | null>(null);
export function WorkspaceProvider({
  value,
  children,
}: {
  value: WorkspaceIdentity;
  children: ReactNode;
}) {
  const userId = value.user.id;
  const teamId = value.team?.id ?? null;
  // Children subscribe first; then everything cached for another user or team is dropped.
  useEffect(() => {
    dataCache.setIdentity(teamId ? { userId, teamId } : null);
    startSpeedLog()?.setTeam(teamId);
  }, [userId, teamId]);
  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Workspace context is missing");
  return value;
}
export class ClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
/** A non-GET request, except the read-only duplicate lookup POST. */
function isWrite(path: string, method?: string) {
  return (
    !!method &&
    method.toUpperCase() !== "GET" &&
    path !== "/api/v1/candidates/duplicates"
  );
}
// In-flight requests per team, so a team switch can abort them.
const inFlight = new Map<
  string,
  Set<{ controller: AbortController; write: boolean }>
>();
export function isAbortError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}
function errorFromBody(status: number, body: unknown) {
  const error = (body ?? {}) as {
    error?: { message?: string; code?: string } | string;
    message?: string;
  };
  return new ClientError(
    status,
    typeof error.error === "object"
      ? error.error.code || "request_failed"
      : "request_failed",
    typeof error.error === "object"
      ? error.error.message || "The request could not be completed."
      : typeof error.error === "string"
        ? error.error
        : error.message || "The request could not be completed.",
  );
}
export async function requestJson<T>(
  teamId: string | null,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (teamId) headers.set("X-Team-Id", teamId);
  if (init.body) headers.set("Content-Type", "application/json");
  const controller = new AbortController();
  const signal = init.signal
    ? AbortSignal.any([controller.signal, init.signal])
    : controller.signal;
  const entry = { controller, write: isWrite(path, init.method) };
  if (teamId)
    inFlight.set(teamId, (inFlight.get(teamId) ?? new Set()).add(entry));
  try {
    const response = await fetch(path, {
      ...init,
      signal,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
    // One in five responses gives a route timing: method, path pattern and Server-Timing only.
    if (teamId)
      speedLog()?.route(
        init.method ?? "GET",
        path,
        response.headers.get("server-timing"),
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ClientError(
        response.status,
        "invalid_response",
        response.ok
          ? "The server returned an unreadable response."
          : "The request could not be completed.",
      );
    }
    if (!response.ok) throw errorFromBody(response.status, body);
    // The duplicate lookup is a read-only POST, so it must not refresh open views.
    if (teamId && entry.write) dataCache.afterWrite(teamId, path, body);
    if (typeof window !== "undefined" && entry.write)
      window.dispatchEvent(
        new CustomEvent("recruitmentos:data-changed", {
          detail: { teamId, path },
        }),
      );
    return body as T;
  } finally {
    if (teamId) {
      const entries = inFlight.get(teamId);
      entries?.delete(entry);
      if (entries?.size === 0) inFlight.delete(teamId);
    }
  }
}
/**
 * POSTs a record export and returns the file. A team switch aborts it like any team request, but
 * it is not a write: it never blocks a switch or refreshes open views.
 */
export async function requestExport(
  teamId: string,
  path: string,
): Promise<{ blob: Blob; filename: string; rows: number }> {
  const controller = new AbortController();
  const entry = { controller, write: false };
  inFlight.set(teamId, (inFlight.get(teamId) ?? new Set()).add(entry));
  try {
    const response = await fetch(path, {
      method: "POST",
      signal: controller.signal,
      headers: { "X-Team-Id": teamId },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new ClientError(
          response.status,
          "invalid_response",
          "The request could not be completed.",
        );
      }
      throw errorFromBody(response.status, body);
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const filename = encoded
      ? decodeURIComponent(encoded)
      : /filename="([^"]+)"/i.exec(disposition)?.[1];
    const count = response.headers.get("x-export-rows") ?? "";
    const rows = /^\d{1,6}$/.test(count) ? Number(count) : -1;
    if (!filename || rows < 0)
      throw new ClientError(
        response.status,
        "invalid_response",
        "The server returned an unreadable response.",
      );
    return { blob: await response.blob(), filename, rows };
  } finally {
    const entries = inFlight.get(teamId);
    entries?.delete(entry);
    if (entries?.size === 0) inFlight.delete(teamId);
  }
}
/** Aborts every in-flight requestJson or requestExport call started for this team. */
export function abortTeamRequests(teamId: string) {
  const entries = inFlight.get(teamId);
  inFlight.delete(teamId);
  for (const entry of entries ?? []) entry.controller.abort();
}
export function hasWritesInFlight(teamId: string) {
  return [...(inFlight.get(teamId) ?? [])].some((entry) => entry.write);
}
// Components holding unsaved work, counted per team.
const unsaved = new Map<string, number>();
export function hasUnsavedWork(teamId: string) {
  return (unsaved.get(teamId) ?? 0) > 0;
}
/** Registers unsaved work for the current team while `active` holds. */
export function useUnsavedWork(active: boolean) {
  const { team } = useWorkspace();
  const teamId = team?.id;
  useEffect(() => {
    if (!active || !teamId) return;
    unsaved.set(teamId, (unsaved.get(teamId) ?? 0) + 1);
    return () => {
      const left = (unsaved.get(teamId) ?? 1) - 1;
      if (left > 0) unsaved.set(teamId, left);
      else unsaved.delete(teamId);
    };
  }, [active, teamId]);
}
/** Kept in module state so it survives the team-keyed remount. */
export interface SwitchNotice {
  fromTeam: string;
  toTeamId: string;
}
let switchNotice: SwitchNotice | null = null;
const noticeListeners = new Set<() => void>();
export function setSwitchNotice(value: SwitchNotice | null) {
  switchNotice = value;
  for (const listener of noticeListeners) listener();
}
function subscribeSwitchNotice(listener: () => void) {
  noticeListeners.add(listener);
  return () => {
    noticeListeners.delete(listener);
  };
}
export function useSwitchNotice() {
  return useSyncExternalStore(
    subscribeSwitchNotice,
    () => switchNotice,
    () => null,
  );
}
/** Every workspace read: one in-memory cache for this browser tab, keyed by user, team and path. */
export const dataCache = createDataCache((teamId, path, signal) =>
  requestJson(teamId, path, { signal }),
);
/** requestJson for one team, in the shape the optimistic actions take. */
export function teamRequester(teamId: string): Requester {
  return <T,>(path: string, init?: RequestInit) =>
    requestJson<T>(teamId, path, init);
}
/** Team switch and sign-out: nothing cached for one team may be shown in another. */
export function clearWorkspaceCache() {
  dataCache.clear();
  speedLog()?.clear();
}
/**
 * Cached data at once (refreshing in the background), or loading without it. `load` replaces the
 * single GET for reads such as the whole-vacancy board; keep it stable with useCallback.
 */
export function useCachedQuery<T>(path: string | null, load?: Loader) {
  const { user, team } = useWorkspace();
  const userId = user.id;
  const teamId = team?.id;
  const enabled = !!path && !!teamId;
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled
        ? dataCache.subscribe(
            { userId, teamId: teamId! },
            path!,
            listener,
            load,
          )
        : () => {},
    [enabled, userId, teamId, path, load],
  );
  const getSnapshot = useCallback(
    () =>
      enabled
        ? dataCache.getSnapshot({ userId, teamId: teamId! }, path!)
        : DISABLED_SNAPSHOT,
    [enabled, userId, teamId, path],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () =>
    enabled ? LOADING_SNAPSHOT : DISABLED_SNAPSHOT,
  ) as CacheSnapshot<T>;
  const refresh = useCallback(() => {
    if (enabled)
      void dataCache.revalidate({ userId, teamId: teamId! }, path!, true);
  }, [enabled, userId, teamId, path]);
  const setData = useCallback(
    (data: T | null) => {
      if (enabled) dataCache.set({ userId, teamId: teamId! }, path!, data);
    },
    [enabled, userId, teamId, path],
  );
  return { ...snapshot, refresh, setData };
}
export function useApi<T>(path: string | null) {
  return useCachedQuery<T>(path);
}
/** The signed-in user and active team, for cache calls outside a hook. */
export function useCacheIdentity(): CacheIdentity | null {
  const { user, team } = useWorkspace();
  return team ? { userId: user.id, teamId: team.id } : null;
}
const NO_PENDING: ReadonlySet<string> = new Set();
/** Records whose quick action is still saving; their controls stay disabled. */
export function usePendingKeys(): ReadonlySet<string> {
  return useSyncExternalStore(
    dataCache.subscribePending,
    dataCache.pendingKeys,
    () => NO_PENDING,
  );
}
export function useDebounced<T>(value: T, delay = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
/** An aborted request is never an error to show, so it gives an empty message. */
export function humanError(error: unknown) {
  if (isAbortError(error)) return "";
  if (error instanceof ClientError && error.status === 409)
    return `${error.message} Your draft is retained. Close this editor to refresh the record before trying again.`;
  if (error instanceof ClientError && error.status === 429)
    return `${error.message} Wait a moment before retrying. Your draft is retained.`;
  return error instanceof Error
    ? error.message
    : "The request could not be completed. Your draft is retained.";
}
