import { json, runApi } from "@/lib/api";
import { listBulkBatches, parseBulkBatchQuery } from "@/lib/bulk-intake";
import { requireScope } from "@/lib/permissions";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return runApi(request, "cvs:write", async (principal) => {
    requireScope(principal, "candidates:write");
    return json(
      await listBulkBatches(
        principal,
        parseBulkBatchQuery(new URL(request.url).searchParams),
      ),
    );
  });
}
