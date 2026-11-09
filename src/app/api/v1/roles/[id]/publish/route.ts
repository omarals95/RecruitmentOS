import { json, runApi } from "@/lib/api";
import { publishConfigVersion } from "@/lib/config-store";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
/** Publishes a role draft; a version of another configuration type is not found. */
export async function POST(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { id } = await ctx.params;
      const number = await publishConfigVersion(p, id, { type: "role" });
      return json({ data: { versionId: id, number } });
    },
    { humanOnly: true },
  );
}
