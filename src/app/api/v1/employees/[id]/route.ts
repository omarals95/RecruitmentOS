import { json, readBody, runApi } from "@/lib/api";
import { employeePatch } from "@/domain/directory";
import {
  archiveEmployee,
  linkEmployeeUser,
  updateEmployee,
} from "@/lib/directory";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
/** Exactly one of a facts update, {userId} (link, or null to unlink) or {archived: true}. */
export async function PATCH(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { id } = await ctx.params;
      const body = await readBody(request, employeePatch);
      return json({
        data:
          "userId" in body
            ? await linkEmployeeUser(p, id, body)
            : "archived" in body
              ? await archiveEmployee(p, id)
              : await updateEmployee(p, id, body),
      });
    },
    { humanOnly: true },
  );
}
