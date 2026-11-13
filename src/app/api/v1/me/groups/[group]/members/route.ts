import { z } from "zod";
import { groupPerson, managedMemberEmail } from "@/domain/groups";
import { json, readBody, runApi } from "@/lib/api";
import { addManagedMember, removeManagedMember } from "@/lib/groups";

export const runtime = "nodejs";
type Context = { params: Promise<{ group: string }> };
const groupId = z.uuid();
const noQuery = z.object({}).strict();
/**
 * A delegated manager adds a person, {email}, to a current group they manage that grants nothing;
 * an unknown email and a person in no team of the company get the same 404.
 */
export async function POST(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { group } = await ctx.params;
      const id = groupId.parse(group);
      const input = await readBody(request, managedMemberEmail, 1024);
      await addManagedMember(p, id, input);
      return json({ data: { added: true } }, 201);
    },
    { humanOnly: true },
  );
}
/** A delegated manager removes a direct person, {userId}; 404 when they are not one. */
export async function DELETE(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      const { group } = await ctx.params;
      const id = groupId.parse(group);
      const member = await readBody(request, groupPerson, 1024);
      await removeManagedMember(p, id, member);
      return json({ data: { removed: true } });
    },
    { humanOnly: true },
  );
}
