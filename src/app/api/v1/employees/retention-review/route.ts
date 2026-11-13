import { json, runApi } from "@/lib/api";
import { listRetentionReview } from "@/lib/directory";

export const runtime = "nodejs";
/** Company owners only: employees whose status has been left for 12 months or more. */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) =>
      json(
        await listRetentionReview(
          p,
          Object.fromEntries(new URL(request.url).searchParams),
        ),
      ),
    { humanOnly: true },
  );
}
