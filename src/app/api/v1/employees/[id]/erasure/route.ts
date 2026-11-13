import { z } from "zod";
import { json, readBody, runApi } from "@/lib/api";
import { eraseEmployee } from "@/lib/employee-erasure";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
/** The company owner check comes before the body is validated, in eraseEmployee. */
export async function POST(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) =>
      json({
        data: await eraseEmployee(
          p,
          (await ctx.params).id,
          await readBody(request, z.unknown()),
          request.headers.get("idempotency-key") ?? undefined,
        ),
      }),
    { humanOnly: true },
  );
}
