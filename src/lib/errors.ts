// No parameter properties: storage.ts imports this file under `node --test`, which only strips types.
export class ApiError extends Error {
  status: number;
  code: string;
  /** Set when a log line already names this error; the response then carries the same ID. */
  correlationId?: string;
  /** Seconds a 429 sends in Retry-After; 60 when unset. */
  retryAfter?: number;
  constructor(
    status: number,
    code: string,
    message: string,
    correlationId?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

/** Up to 8 schema issues as `path: message`, the message of a 400 invalid_input that names reasons. */
export function issueList(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string {
  return issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");
}
