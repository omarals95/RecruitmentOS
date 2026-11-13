import { json, readBody, runApi } from "@/lib/api";
import { orgUnitPatch } from "@/domain/org";
import { archiveOrgUnit, moveOrgUnit, renameOrgUnit } from "@/lib/org";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
/** Exactly one of {name} (rename), {parentId} (move) or {archived: true} (archive). */
export async function PATCH(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { id } = await ctx.params;
      const body = await readBody(request, orgUnitPatch);
      return json({
        data:
          "name" in body
            ? await renameOrgUnit(p, id, body)
            : "parentId" in body
              ? await moveOrgUnit(p, id, body)
              : await archiveOrgUnit(p, id),
      });
    },
    { humanOnly: true },
  );
}
