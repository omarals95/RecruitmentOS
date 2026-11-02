import { json, runApi } from "@/lib/api";
import { listCandidateCvsPage, parseCvListQuery } from "@/lib/cvs";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return runApi(request, "cvs:read", async (principal) =>
    json(
      await listCandidateCvsPage(
        principal,
        id,
        parseCvListQuery(new URL(request.url).searchParams),
      ),
    ),
  );
}
