import { json, runApi } from "@/lib/api";
import { completeRecordFileUpload } from "@/lib/record-files";

export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return runApi(request, "cvs:write", async (principal) =>
    json({ data: await completeRecordFileUpload(principal, id) }),
  );
}
