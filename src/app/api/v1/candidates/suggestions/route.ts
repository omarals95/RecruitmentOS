import { json, runApi } from "@/lib/api";
import { candidateSuggestions } from "@/lib/records";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return runApi(request, "candidates:read", async (principal) =>
    json({
      data: await candidateSuggestions(
        principal,
        new URL(request.url).searchParams,
      ),
    }),
  );
}
