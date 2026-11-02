"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import {
  failedResourceState,
  resourceSnapshot,
  type ResourceState,
} from "./resource-state";

export interface WorkspaceIdentity {
  user: { id: string; name: string; email: string };
  team: { id: string; name: string; slug: string } | null;
  role: string | null;
}
const WorkspaceContext = createContext<WorkspaceIdentity | null>(null);
export function WorkspaceProvider({
  value,
  children,
}: {
  value: WorkspaceIdentity;
  children: ReactNode;
}) {
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
export async function requestJson<T>(
  teamId: string | null,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (teamId) headers.set("X-Team-Id", teamId);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ClientError(
      response.status,
      "invalid_response",
      response.ok
        ? "The server returned an unreadable response."
        : "The request could not be completed.",
    );
  }
  if (!response.ok) {
    const error = body as {
      error?: { message?: string; code?: string } | string;
      message?: string;
    };
    throw new ClientError(
      response.status,
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
  if (
    typeof window !== "undefined" &&
    init.method &&
    init.method.toUpperCase() !== "GET"
  )
    window.dispatchEvent(
      new CustomEvent("recruitmentos:data-changed", {
        detail: { teamId, path },
      }),
    );
  return body as T;
}
export function useApi<T>(path: string | null) {
  const { team } = useWorkspace();
  const [state, setState] = useState<ResourceState<T> | null>(null);
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([team?.id || "", path || ""]);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (
        event as CustomEvent<{ teamId: string | null; path: string }>
      ).detail;
      if (detail.teamId !== team?.id || !path) return;
      const changedResource = detail.path.split("/")[3];
      const currentResource = path.split("/")[3]?.split("?")[0];
      if (
        currentResource === changedResource ||
        [
          "overview",
          "analytics",
          "activity",
          "notifications",
          "search",
        ].includes(currentResource)
      )
        refresh();
    };
    window.addEventListener("recruitmentos:data-changed", onChange);
    return () =>
      window.removeEventListener("recruitmentos:data-changed", onChange);
  }, [team, path, refresh]);
  useEffect(() => {
    let active = true;
    if (!path || !team) return;
    requestJson<T>(team.id, path)
      .then((value) => {
        if (active) setState({ key, revision, data: value, error: "" });
      })
      .catch((error: unknown) => {
        if (active)
          setState((previous) =>
            failedResourceState(previous, key, revision, error),
          );
      });
    return () => {
      active = false;
    };
  }, [team, path, key, revision]);
  const setData = (data: T | null) =>
    setState({ key, revision, data, error: "" });
  return {
    ...resourceSnapshot(state, key, revision, !!path && !!team),
    refresh,
    setData,
  };
}
export function useDebounced<T>(value: T, delay = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
export function humanError(error: unknown) {
  if (error instanceof ClientError && error.status === 409)
    return `${error.message} Your draft is retained. Close this editor to refresh the record before trying again.`;
  if (error instanceof ClientError && error.status === 429)
    return `${error.message} Wait a moment before retrying. Your draft is retained.`;
  return error instanceof Error
    ? error.message
    : "The request could not be completed. Your draft is retained.";
}
