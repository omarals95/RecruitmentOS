import { z } from "zod";
import { ApiError } from "./errors";
import { requirePrincipal, type Principal } from "./principal";
import type { Scope } from "./permissions";
export { ApiError } from "./errors";
export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export function checkOrigin(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (request.headers.has("authorization")) return;
  let expected: string;
  try {
    expected = new URL(process.env.BETTER_AUTH_URL || "http://localhost:3000")
      .origin;
  } catch {
    throw new ApiError(
      503,
      "auth_not_configured",
      "The application URL is not configured.",
    );
  }
  if (request.headers.get("origin") !== expected)
    throw new ApiError(
      403,
      "invalid_origin",
      "This request must come from the application.",
    );
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "none"].includes(fetchSite))
    throw new ApiError(
      403,
      "invalid_origin",
      "Cross-site writes are not allowed.",
    );
}
export async function readBody<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes = 262144,
): Promise<T> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new ApiError(415, "json_required", "Send application/json.");
  const bytes = await readLimitedBytes(request, maxBytes);
  if (!bytes)
    throw new ApiError(400, "invalid_json", "A JSON body is required.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(
      400,
      "invalid_json",
      "The request contains invalid JSON.",
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      "invalid_input",
      parsed.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
        .join("; "),
    );
  return parsed.data;
}
/** Streams at most maxBytes; a larger declared or observed body is refused with 413. Null without a body. */
export async function readLimitedBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const size = request.headers.get("content-length");
  if (size && (!/^\d+$/.test(size) || Number(size) > maxBytes))
    throw new ApiError(413, "body_too_large", "The request is too large.");
  const reader = request.body?.getReader();
  if (!reader) return null;
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "body_too_large", "The request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
/** Every error body and X-Correlation-Id header share one fresh ID for support reports. */
export function errorJson(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  const correlationId = crypto.randomUUID();
  const response = json({ error: { code, message, correlationId } }, status);
  response.headers.set("X-Correlation-Id", correlationId);
  for (const [name, value] of Object.entries(headers))
    response.headers.set(name, value);
  return response;
}
export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError)
    return errorJson(
      error.status,
      error.code,
      error.message,
      error.status === 429 ? { "Retry-After": "60" } : {},
    );
  const dbError =
    (error as { cause?: { code?: string }; code?: string })?.cause ??
    (error as { code?: string });
  if (dbError?.code === "23505")
    return errorJson(
      409,
      "duplicate",
      "A record with these unique details already exists.",
    );
  if (dbError?.code === "23503" || dbError?.code === "23514")
    return errorJson(
      409,
      "constraint",
      "This change conflicts with a linked record or a required workflow rule.",
    );
  if (error instanceof z.ZodError)
    return errorJson(400, "invalid_input", "Check the supplied fields.");
  const response = errorJson(
    500,
    "internal_error",
    "The request could not be completed. Refresh the record before retrying a save.",
  );
  // Log only a safe category; messages, stacks and request data can hold record contents.
  const sqlState =
    typeof dbError?.code === "string" && /^[0-9A-Z]{5}$/.test(dbError.code)
      ? ` sqlstate=${dbError.code}`
      : "";
  const category =
    (error as { constructor?: { name?: string } } | null)?.constructor?.name ||
    typeof error;
  console.error(
    `internal_error correlationId=${response.headers.get("X-Correlation-Id")} category=${category}${sqlState}`,
  );
  return response;
}
export async function runApi(
  request: Request,
  scope: Scope | undefined,
  handler: (principal: Principal) => Promise<Response>,
  options?: { humanOnly?: boolean },
): Promise<Response> {
  try {
    checkOrigin(request);
    return await handler(
      await requirePrincipal(request, scope, options?.humanOnly),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
