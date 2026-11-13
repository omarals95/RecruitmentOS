import { z } from "zod";
import { json, runApi } from "@/lib/api";
import { getWorkspacePerson } from "@/lib/admin-users";

export const runtime = "nodejs";
type Context = { params: Promise<{ user: string }> };
const userId = z.string().min(1).max(128);
const noQuery = z.object({}).strict();
/**
 * Company owners and company admins with the people area, signed in; others get 403
 * people_forbidden, and a person in no team of the workspace 404 user_not_found. One person's
 * profile, teams, company authority, two-step state, device count and events, never team data.
 */
export async function GET(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { user } = await ctx.params;
      return json({ data: await getWorkspacePerson(p, userId.parse(user)) });
    },
    { humanOnly: true },
  );
}
