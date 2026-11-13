import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";
import { errorJson } from "@/lib/api";
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
    return error instanceof ApiError
      ? errorJson(error.status, error.code, error.message)
      : errorJson(
          503,
          "AUTH_UNAVAILABLE",
          "Sign-in is temporarily unavailable.",
        );
  }
}
export const GET = handle;
export const POST = handle;
