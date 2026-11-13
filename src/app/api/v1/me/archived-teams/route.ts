import { z } from "zod";
import { json, runApi } from "@/lib/api";
import { memberArchivedTeams } from "@/lib/team-archive";

export const runtime = "nodejs";
/** Signed in only: the ids of the archived teams the caller is a member of. Not audited. */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      z.object({})
        .strict()
        .parse(Object.fromEntries(new URL(request.url).searchParams));
      return json({ data: { teamIds: await memberArchivedTeams(p) } });
    },
    { humanOnly: true },
  );
}
