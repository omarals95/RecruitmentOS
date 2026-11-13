import { z } from "zod";
import { groupPatch } from "@/domain/groups";
import { json, readBody, runApi } from "@/lib/api";
import { archiveGroup, getGroup, renameGroup } from "@/lib/groups";

export const runtime = "nodejs";
type Context = { params: Promise<{ group: string }> };
const groupId = z.uuid();
const noQuery = z.object({}).strict();
/**
 * Company owners and company admins with the people area, signed in; others get 403
 * people_forbidden, and an unknown group or another company's 404 not_found. The group, its
 * members tree, the groups it is in and its audit rows from the current team.
 */
export async function GET(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { group } = await ctx.params;
      return json({ data: await getGroup(p, groupId.parse(group)) });
    },
    { humanOnly: true },
  );
}
/**
 * Exactly one of {name, description?} (rename) or {archived: true, replacements?} (archive, with a
 * replacement or null for each group that uses it). A group that grants something is changed only
 * by a company owner with a recent sign-in.
 */
export async function PATCH(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { group } = await ctx.params;
      const id = groupId.parse(group);
      // At most 200 replacements of two ids each.
      const body = await readBody(request, groupPatch, 32 * 1024);
      return json({
        data:
          "archived" in body
            ? await archiveGroup(p, id, body.replacements)
            : await renameGroup(
                p,
                id,
                // A description left out stays; an empty one (null once parsed) clears it.
                body.description === undefined
                  ? { name: body.name }
                  : { name: body.name, description: body.description ?? "" },
              ),
      });
    },
    { humanOnly: true },
  );
}
