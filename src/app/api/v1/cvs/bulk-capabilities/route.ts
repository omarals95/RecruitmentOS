import { json, runApi } from "@/lib/api";
import { requireScope } from "@/lib/permissions";
import { storageConfigured } from "@/lib/storage";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return runApi(request, "cvs:write", async (principal) => {
    requireScope(principal, "candidates:write");
    // Bulk uploads follow single CV upload readiness: Blob and unknown providers stay false.
    // storageConfigured reads only the environment; it never contacts a provider.
    const configured = storageConfigured();
    return json({
      data: {
        uploadsAvailable: configured,
        aiAvailable: false,
        storageConfigured: configured,
      },
    });
  });
}
