import { json, runApi } from "@/lib/api";
import { getCvManifest } from "@/lib/cvs";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return runApi(request, "cvs:read", async (principal) =>
    json({ data: await getCvManifest(principal, id) }),
  );
}
