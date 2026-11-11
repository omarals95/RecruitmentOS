import { json, runApi } from "@/lib/api";
import { publishConfigVersion } from "@/lib/config-store";

export const runtime = "nodejs";
type Context = { params: Promise<{ versionId: string }> };
/** Publishes the job architecture draft; a version of another configuration type is not found. */
export async function POST(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { versionId } = await ctx.params;
      const number = await publishConfigVersion(p, versionId, {
        type: "job-architecture",
      });
      return json({ data: { versionId, number } });
    },
    { humanOnly: true },
  );
}
