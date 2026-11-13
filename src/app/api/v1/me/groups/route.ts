import { z } from "zod";
import { json, runApi } from "@/lib/api";
import { listManagedGroups } from "@/lib/groups";

export const runtime = "nodejs";
const noQuery = z.object({}).strict();
/**
 * Signed in only: the current groups of the current team's company you manage, each with its direct
 * people only; an empty list when you manage none. Viewing never needs a recent sign-in.
 */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      return json({ data: await listManagedGroups(p) });
    },
    { humanOnly: true },
  );
}
