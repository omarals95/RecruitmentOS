import { json, runApi } from "@/lib/api";
import { requireScope } from "@/lib/permissions";
import { bootstrapTeam } from "@/lib/records";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      requireScope(p, "recruitment:write");
      return json({ data: await bootstrapTeam(p) });
    },
    { humanOnly: true },
  );
}
