import { z } from "zod";
import { json, readBody, runApi } from "@/lib/api";
import { assignMemberRole, listMemberRoles } from "@/lib/member-roles";

export const runtime = "nodejs";
const assignmentSchema = z
  .object({
    userId: z.string().min(1).max(128),
    roleObjectId: z.uuid().nullable(),
  })
  .strict();
/** Company owners, signed in; others get 403 role_assignment_forbidden. */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => json({ data: await listMemberRoles(p) }),
    { humanOnly: true },
  );
}
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const input = await readBody(request, assignmentSchema, 1024);
      return json({ data: await assignMemberRole(p, input, request.headers) });
    },
    { humanOnly: true, freshSession: true },
  );
}
