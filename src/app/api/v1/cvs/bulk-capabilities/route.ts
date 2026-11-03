import { json, runApi } from "@/lib/api";
import { requireScope } from "@/lib/permissions";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return runApi(request, "cvs:write", async (principal) => {
    requireScope(principal, "candidates:write");
    // Re-enable only after hosted tenant isolation and immutable CV storage are verified.
    return json({ data: { uploadsAvailable: false, aiAvailable: false } });
  });
}
