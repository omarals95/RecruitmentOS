import { z } from "zod";
import { groupInput } from "@/domain/groups";
import { json, readBody, runApi } from "@/lib/api";
import { createGroup, listGroups } from "@/lib/groups";

export const runtime = "nodejs";
const noQuery = z.object({}).strict();
/**
 * Company owners and company admins with the people area, signed in; others get 403
 * people_forbidden. Every company group with its counts and direct links, and the computed groups
 * with their people counts; no person's name or email.
 */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      return json(await listGroups(p));
    },
    { humanOnly: true },
  );
}
/** Creates a group that grants nothing; others get 403 group_forbidden. */
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      noQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
      // An empty description is none.
      const { name, description } = await readBody(request, groupInput, 4096);
      return json(
        {
          data: await createGroup(
            p,
            description ? { name, description } : { name },
          ),
        },
        201,
      );
    },
    { humanOnly: true },
  );
}
