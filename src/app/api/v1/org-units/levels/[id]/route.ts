import { json, readBody, runApi } from "@/lib/api";
import { orgLevelPatch } from "@/domain/org";
import { archiveOrgLevel, renameOrgLevel } from "@/lib/org";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
/** Exactly one of {name} (rename) or {archived: true} (archive). */
export async function PATCH(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { id } = await ctx.params;
      const body = await readBody(request, orgLevelPatch);
      return json({
        data:
          "name" in body
            ? await renameOrgLevel(p, id, body)
            : await archiveOrgLevel(p, id),
      });
    },
    { humanOnly: true },
  );
}
