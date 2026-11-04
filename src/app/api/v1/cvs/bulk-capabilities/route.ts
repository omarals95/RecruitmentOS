import { json, runApi } from "@/lib/api";
import { requireScope } from "@/lib/permissions";
import { storageConfigured } from "@/lib/storage";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return runApi(request, "cvs:write", async (principal) => {
    requireScope(principal, "candidates:write");
    // Re-enable only after hosted tenant isolation and immutable CV storage are verified.
    // storageConfigured reads only the environment; it never contacts a provider.
    return json({
      data: {
        uploadsAvailable: false,
        aiAvailable: false,
        storageConfigured: storageConfigured(),
      },
    });
  });
}
