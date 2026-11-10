import { z } from "zod";
import { configHelpText } from "@/domain/config";
import { json, readBody, runApi } from "@/lib/api";
import { archiveConfigObject, updateConfigDraft } from "@/lib/config-store";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
const editSchema = z
  .object({ body: z.unknown(), note: configHelpText.optional() })
  .strict();
/** Replaces a task-board draft's body; id is the draft's version id. */
export async function PUT(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { id } = await ctx.params;
      const input = await readBody(request, editSchema, 524_288);
      await updateConfigDraft(p, id, input, { type: "task-board" });
      return json({ data: { versionId: id } });
    },
    { humanOnly: true },
  );
}
/** Retires a task board for good; id is the board's object id. */
export async function DELETE(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { id } = await ctx.params;
      await archiveConfigObject(p, id, { type: "task-board" });
      return json({ data: { id } });
    },
    { humanOnly: true },
  );
}
