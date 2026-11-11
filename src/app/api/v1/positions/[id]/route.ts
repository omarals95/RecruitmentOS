import { json, readBody, runApi } from "@/lib/api";
import { positionPatch } from "@/domain/directory";
import { archivePosition, movePosition, updatePosition } from "@/lib/directory";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
/**
 * Exactly one of a facts update ({title, isManager, jobRoleId, jobTitleKey}), {orgUnitId} (move) or
 * {archived: true}.
 */
export async function PATCH(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { id } = await ctx.params;
      const body = await readBody(request, positionPatch);
      return json({
        data:
          "orgUnitId" in body
            ? await movePosition(p, id, body)
            : "archived" in body
              ? await archivePosition(p, id)
              : await updatePosition(p, id, body),
      });
    },
    { humanOnly: true },
  );
}
