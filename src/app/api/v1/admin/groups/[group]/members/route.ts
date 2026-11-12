import { z } from "zod";
import { groupMember } from "@/domain/groups";
import { json, readBody, runApi } from "@/lib/api";
import { addGroupMember, removeGroupMember } from "@/lib/groups";

export const runtime = "nodejs";
type Context = { params: Promise<{ group: string }> };
const groupId = z.uuid();
const noQuery = z.object({}).strict();
/**
 * Adds one direct member, {userId} or {childGroupId}. A group that grants something is changed only
 * by a company owner with a recent sign-in.
 */
export async function POST(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { group } = await ctx.params;
      const id = groupId.parse(group);
      const member = await readBody(request, groupMember, 1024);
      await addGroupMember(p, id, member);
      return json({ data: { added: true } }, 201);
    },
    { humanOnly: true },
  );
}
/** Removes one direct member, {userId} or {childGroupId}; 404 when it is not one. */
export async function DELETE(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { group } = await ctx.params;
      const id = groupId.parse(group);
      const member = await readBody(request, groupMember, 1024);
      await removeGroupMember(p, id, member);
      return json({ data: { removed: true } });
    },
    { humanOnly: true },
  );
}
