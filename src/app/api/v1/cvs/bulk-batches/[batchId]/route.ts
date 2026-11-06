import { json, runApi } from "@/lib/api";
import { getBulkBatch } from "@/lib/bulk-intake";
import { requireScope } from "@/lib/permissions";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
) {
  const { batchId } = await context.params;
  return runApi(request, "cvs:write", async (principal) => {
    requireScope(principal, "candidates:write");
    return json({ data: await getBulkBatch(principal, batchId) });
  });
}
