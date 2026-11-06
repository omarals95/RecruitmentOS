import { json, readBody, runApi } from "@/lib/api";
import { bulkItemSchema, createBulkItem } from "@/lib/bulk-intake";
import { requireScope } from "@/lib/permissions";

export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ batchId: string; itemId: string }> },
) {
  const { batchId, itemId } = await context.params;
  return runApi(request, "cvs:write", async (principal) => {
    requireScope(principal, "candidates:write");
    return json(
      {
        data: await createBulkItem(
          principal,
          batchId,
          itemId,
          await readBody(request, bulkItemSchema, 65536),
        ),
      },
      201,
    );
  });
}
