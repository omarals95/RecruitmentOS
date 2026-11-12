import { z } from "zod";
import { json, readBody, runApi } from "@/lib/api";
import { anonymiseUser } from "@/lib/user-anonymisation";

export const runtime = "nodejs";
type Context = { params: Promise<{ user: string }> };
const userId = z.string().min(1).max(128);
const noQuery = z.object({}).strict();
/**
 * Company owners only, signed in recently, never on themselves. Permanently anonymises the person
 * after the typed name matches; a retry answers the earlier anonymisation. The company owner check
 * comes before the body is validated, in anonymiseUser.
 */
export async function POST(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { user } = await ctx.params;
      const target = userId.parse(user);
      return json({
        data: await anonymiseUser(
          p,
          target,
          await readBody(request, z.unknown(), 1024),
          request.headers.get("idempotency-key") ?? undefined,
        ),
      });
    },
    { humanOnly: true, freshSession: true },
  );
}
