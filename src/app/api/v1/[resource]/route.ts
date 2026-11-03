import { z } from "zod";
import { runApi, readBody, json } from "@/lib/api";
import { listRecords, createRecord } from "@/lib/records";
import { resourceToKind, type ResourceName } from "@/domain/records";
import { ApiError } from "@/lib/errors";
export const runtime = "nodejs";
function resource(value: string): ResourceName {
  if (!Object.hasOwn(resourceToKind, value))
    throw new ApiError(404, "not_found", "Unknown resource.");
  return value as ResourceName;
}
type Context = { params: Promise<{ resource: string }> };
export async function GET(req: Request, ctx: Context) {
  return runApi(req, undefined, async (p) =>
    json(
      await listRecords(
        p,
        resource((await ctx.params).resource),
        new URL(req.url).searchParams,
      ),
    ),
  );
}
export async function POST(req: Request, ctx: Context) {
  return runApi(req, undefined, async (p) =>
    json(
      {
        data: await createRecord(
          p,
          resource((await ctx.params).resource),
          await readBody(req, z.unknown()),
          req.headers.get("idempotency-key") ?? undefined,
        ),
      },
      201,
    ),
  );
}
