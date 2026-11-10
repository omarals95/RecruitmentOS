import { z } from "zod";
import { json, runApi } from "@/lib/api";
import { listAdminTeams } from "@/lib/admin-teams";

export const runtime = "nodejs";
/**
 * Owners and admins of the active team, and company owners and admins, signed in; others get 403
 * teams_forbidden. Other teams carry name, slug and created date only.
 */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      z.object({})
        .strict()
        .parse(Object.fromEntries(new URL(request.url).searchParams));
      return json({ data: await listAdminTeams(p) });
    },
    { humanOnly: true },
  );
}
