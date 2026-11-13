import { z } from "zod";
import { groupRoleGrant, groupRoleTeam } from "@/domain/groups";
import { json, readBody, runApi } from "@/lib/api";
import {
  grantGroupRole,
  listGroupRoleChoices,
  removeGroupRole,
} from "@/lib/groups";

export const runtime = "nodejs";
type Context = { params: Promise<{ group: string }> };
const groupId = z.uuid();
const noQuery = z.object({}).strict();
/**
 * Company owners, signed in; company admins with the people area get 403 group_owner_required and
 * everyone else 403 group_forbidden. What the group can be given: the current teams and the roles
 * that can be assigned, by name. Viewing never needs a recent sign-in.
 */
export async function GET(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { group } = await ctx.params;
      return json({
        data: await listGroupRoleChoices(p, groupId.parse(group)),
      });
    },
    { humanOnly: true },
  );
}
/**
 * Gives the group one configured role in one team, {teamId, roleObjectId}. A company owner with a
 * recent sign-in only; a change that gives someone two roles in one team is refused.
 */
export async function POST(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { group } = await ctx.params;
      const id = groupId.parse(group);
      const grant = await readBody(request, groupRoleGrant, 1024);
      await grantGroupRole(p, id, grant);
      return json({ data: { granted: true } }, 201);
    },
    { humanOnly: true },
  );
}
/** Removes the role the group gives in one team, {teamId}; 404 when it gives none there. */
export async function DELETE(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { group } = await ctx.params;
      const id = groupId.parse(group);
      const grant = await readBody(request, groupRoleTeam, 1024);
      await removeGroupRole(p, id, grant);
      return json({ data: { removed: true } });
    },
    { humanOnly: true },
  );
}
