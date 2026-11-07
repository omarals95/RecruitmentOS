import { json, runApi } from "@/lib/api";
import { speedSummary } from "@/lib/speed-log";

export const runtime = "nodejs";
/** Owners and admins of the team, signed in; others get 403 speed_log_forbidden. */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => json({ data: await speedSummary(p) }),
    { humanOnly: true },
  );
}
