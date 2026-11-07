import { json, readBody, runApi } from "@/lib/api";
import { extractionJobSchema, runExtractionJob } from "@/lib/ai-extraction";
import { requireScope } from "@/lib/permissions";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return runApi(
    request,
    "cvs:write",
    async (principal) => {
      requireScope(principal, "candidates:write");
      return json({
        data: await runExtractionJob(
          principal,
          await readBody(request, extractionJobSchema, 4 * 1024 * 1024 + 8192),
          request.signal,
        ),
      });
    },
    { humanOnly: true },
  );
}
