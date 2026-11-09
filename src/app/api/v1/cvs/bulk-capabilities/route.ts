import { extractionProvider } from "@/lib/ai-provider";
import { json, runApi } from "@/lib/api";
import { withTeam } from "@/lib/db-team";
import { requireScope } from "@/lib/permissions";
import { storageConfigured } from "@/lib/storage";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return runApi(request, "cvs:write", async (principal) => {
    requireScope(principal, "candidates:write");
    // Only the context install: the scopes checked above must be ones install stored for the member.
    return withTeam(principal, async () => {
      // Bulk uploads follow single CV upload readiness: Blob only when hosted, unknown providers false.
      // storageConfigured reads only the environment; it never contacts a provider.
      const configured = storageConfigured();
      return json({
        data: {
          uploadsAvailable: configured,
          // True only with an approved extraction provider; none is configured in this build.
          aiAvailable: extractionProvider() !== null,
          storageConfigured: configured,
        },
      });
    });
  });
}
