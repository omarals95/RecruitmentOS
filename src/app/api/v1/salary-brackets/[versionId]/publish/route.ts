import { json, runApi } from "@/lib/api";
import { publishSalaryBracketVersion } from "@/lib/pay-brackets";

export const runtime = "nodejs";
type Context = { params: Promise<{ versionId: string }> };
/** Publishes a draft as the next version; a recent sign-in is required (ADM-06). */
export async function POST(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { versionId } = await ctx.params;
      return json({ data: await publishSalaryBracketVersion(p, versionId) });
    },
    { humanOnly: true, freshSession: true },
  );
}
