import { z } from "zod";
import { runApi, readBody, json } from "@/lib/api";
import { getRecord, updateRecord } from "@/lib/records";
import { resourceToKind, type ResourceName } from "@/domain/records";
import { ApiError } from "@/lib/errors";
export const runtime = "nodejs";
function resource(value: string): ResourceName {
  if (!Object.hasOwn(resourceToKind, value))
    throw new ApiError(404, "not_found", "Unknown resource.");
  return value as ResourceName;
}
type Context = { params: Promise<{ resource: string; id: string }> };
export async function GET(req: Request, ctx: Context) {
  return runApi(req, undefined, async (p) => {
    const params = await ctx.params;
    return json({
      data: await getRecord(p, resource(params.resource), params.id),
    });
  });
}
export async function PATCH(req: Request, ctx: Context) {
  return runApi(req, undefined, async (p) => {
    const params = await ctx.params;
    return json({
      data: await updateRecord(
        p,
        resource(params.resource),
        params.id,
        await readBody(req, z.unknown()),
      ),
    });
  });
}
