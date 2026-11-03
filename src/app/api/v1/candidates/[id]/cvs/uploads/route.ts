import { json, readBody, runApi } from "@/lib/api";
import { beginCvUpload, cvUploadSchema } from "@/lib/cvs";

export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return runApi(request, "cvs:write", async (principal) =>
    json(
      await beginCvUpload(
        principal,
        id,
        await readBody(request, cvUploadSchema, 8192),
      ),
      201,
    ),
  );
}
