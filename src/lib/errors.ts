// No parameter properties: storage.ts imports this file under `node --test`, which only strips types.
export class ApiError extends Error {
  status: number;
  code: string;
  /** Set when a log line already names this error; the response then carries the same ID. */
  correlationId?: string;
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
