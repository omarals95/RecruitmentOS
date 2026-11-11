import { z } from "zod";
import { json, runApi } from "@/lib/api";
import { clearSignInLockout } from "@/lib/user-account";

export const runtime = "nodejs";
type Context = { params: Promise<{ user: string }> };
const userId = z.string().min(1).max(128);
const noQuery = z.object({}).strict();
/**
 * Company owners and company admins with the people area, signed in recently; only a company owner
 * changes someone with company authority. Clears the person's sign-in backoff; no body is read.
 */
export async function POST(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { user } = await ctx.params;
      return json({ data: await clearSignInLockout(p, userId.parse(user)) });
    },
    { humanOnly: true, freshSession: true },
  );
}
