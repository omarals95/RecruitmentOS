import { json, readBody, runApi } from "@/lib/api";
import {
  salaryBracketInput,
  updateSalaryBracketDraft,
} from "@/lib/pay-brackets";

export const runtime = "nodejs";
type Context = { params: Promise<{ versionId: string }> };
/** Replaces a draft's settings and figures; its grade codes stay the same. */
export async function PUT(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { versionId } = await ctx.params;
      const input = await readBody(request, salaryBracketInput, 65_536);
      return json({
        data: await updateSalaryBracketDraft(p, versionId, input),
      });
    },
    { humanOnly: true },
  );
}
