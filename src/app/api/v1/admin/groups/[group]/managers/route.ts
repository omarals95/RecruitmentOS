import { z } from "zod";
import { groupPerson } from "@/domain/groups";
import { json, readBody, runApi } from "@/lib/api";
import { addGroupManager, removeGroupManager } from "@/lib/groups";

export const runtime = "nodejs";
type Context = { params: Promise<{ group: string }> };
const groupId = z.uuid();
const noQuery = z.object({}).strict();
/**
 * Names one delegated manager, {userId}, of a current group that grants nothing; a group that
 * grants something has none, for a company owner too.
 */
export async function POST(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { group } = await ctx.params;
      const id = groupId.parse(group);
      const manager = await readBody(request, groupPerson, 1024);
      await addGroupManager(p, id, manager);
      return json({ data: { added: true } }, 201);
    },
    { humanOnly: true },
  );
}
/**
 * Removes one delegated manager, {userId}; 404 when they are not one. A group that grants something
 * is changed only by a company owner with a recent sign-in.
 */
export async function DELETE(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { group } = await ctx.params;
      const id = groupId.parse(group);
      const manager = await readBody(request, groupPerson, 1024);
      await removeGroupManager(p, id, manager);
      return json({ data: { removed: true } });
    },
    { humanOnly: true },
  );
}
