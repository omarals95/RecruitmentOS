import { z } from "zod";
import { json, readBody, runApi } from "@/lib/api";
import { setTeamArchived } from "@/lib/team-archive";

export const runtime = "nodejs";
const archiveSchema = z.object({ archived: z.boolean() }).strict();
/** Signed-in owners of the team only: archives or restores it; changed is false for a repeat. */
export async function PUT(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { archived } = await readBody(request, archiveSchema, 1024);
      return json({ data: await setTeamArchived(p, archived) });
    },
    { humanOnly: true },
  );
}
