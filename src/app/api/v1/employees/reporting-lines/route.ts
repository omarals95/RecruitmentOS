import { json, runApi } from "@/lib/api";
import { listReportingLines } from "@/lib/directory";

export const runtime = "nodejs";
/** One level of the org tree by people: the roots, or the people reporting to managerId. */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) =>
      json(
        await listReportingLines(
          p,
          Object.fromEntries(new URL(request.url).searchParams),
        ),
      ),
    { humanOnly: true },
  );
}
