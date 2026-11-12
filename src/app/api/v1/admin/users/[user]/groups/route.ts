import { z } from "zod";
import { json, runApi } from "@/lib/api";
import { listUserGroups } from "@/lib/groups";

export const runtime = "nodejs";
type Context = { params: Promise<{ user: string }> };
const userId = z.string().min(1).max(128);
const noQuery = z.object({}).strict();
/**
 * Company owners and company admins with the people area, signed in; others get 403
 * people_forbidden. The company groups the person is in, directly or through nesting.
 */
export async function GET(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { user } = await ctx.params;
      return json({ data: await listUserGroups(p, userId.parse(user)) });
    },
    { humanOnly: true },
  );
}
