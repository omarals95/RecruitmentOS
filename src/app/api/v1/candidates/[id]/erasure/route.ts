import { z } from "zod";
import { json, readBody, runApi } from "@/lib/api";
import { eraseCandidate } from "@/lib/candidate-erasure";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
/** The owner check comes before the body is validated, in eraseCandidate. */
export async function POST(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) =>
      json({
        data: await eraseCandidate(
          p,
          (await ctx.params).id,
          await readBody(request, z.unknown()),
        ),
      }),
    { humanOnly: true },
  );
}
