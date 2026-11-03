import { json, runApi } from "@/lib/api";
import { completeCvUpload } from "@/lib/cvs";

export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return runApi(request, "cvs:write", async (principal) =>
    json({ data: await completeCvUpload(principal, id) }),
  );
}
