import { z } from "zod";
import { runApi, readBody, json } from "@/lib/api";
import { getCandidateState, updateCandidateState } from "@/lib/records";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(req: Request, ctx: Context) {
  return runApi(req, "candidates:read", async (p) =>
    json({ data: await getCandidateState(p, (await ctx.params).id) }),
  );
}
export async function PATCH(req: Request, ctx: Context) {
  return runApi(req, "candidates:write", async (p) =>
    json({
      data: await updateCandidateState(
        p,
        (await ctx.params).id,
        await readBody(req, z.unknown()),
      ),
    }),
  );
}
