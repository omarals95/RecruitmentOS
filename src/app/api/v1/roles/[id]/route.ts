import { z } from "zod";
import { configHelpText } from "@/domain/config";
import { json, readBody, runApi } from "@/lib/api";
import { updateConfigDraft } from "@/lib/config-store";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
const editSchema = z
  .object({ body: z.unknown(), note: configHelpText.optional() })
  .strict();
/** Replaces a role draft's body; a version of another configuration type is not found. */
export async function PUT(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { id } = await ctx.params;
      const input = await readBody(request, editSchema, 524_288);
      await updateConfigDraft(p, id, input, { type: "role" });
      return json({ data: { versionId: id } });
    },
    { humanOnly: true },
  );
}
