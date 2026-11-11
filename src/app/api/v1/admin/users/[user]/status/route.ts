import { z } from "zod";
import { json, readBody, runApi } from "@/lib/api";
import { setUserActive } from "@/lib/user-account";

export const runtime = "nodejs";
type Context = { params: Promise<{ user: string }> };
const userId = z.string().min(1).max(128);
const noQuery = z.object({}).strict();
const statusSchema = z.object({ active: z.boolean() }).strict();
/**
 * Company owners and company admins with the people area, signed in recently; only a company owner
 * changes someone with company authority. Deactivates or reactivates the person for the whole
 * company; changed is false for a repeat.
 */
export async function PUT(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { user } = await ctx.params;
      const target = userId.parse(user);
      const { active } = await readBody(request, statusSchema, 1024);
      return json({ data: await setUserActive(p, target, active) });
    },
    { humanOnly: true, freshSession: true },
  );
}
