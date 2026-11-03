import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";
import { ApiError } from "@/lib/errors";
import { boundedAuthRequest } from "@/lib/auth-policy";

export const runtime = "nodejs";
async function handle(request: Request) {
  try {
    const handlers = toNextJsHandler(await getAuth());
    return request.method === "GET"
      ? handlers.GET(request)
      : handlers.POST(await boundedAuthRequest(request));
  } catch (error) {
    return Response.json(
      {
        error: {
          code: error instanceof ApiError ? error.code : "AUTH_UNAVAILABLE",
          message:
            error instanceof ApiError
              ? error.message
              : "Sign-in is temporarily unavailable.",
        },
      },
      {
        status: error instanceof ApiError ? error.status : 503,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
export const GET = handle;
export const POST = handle;
