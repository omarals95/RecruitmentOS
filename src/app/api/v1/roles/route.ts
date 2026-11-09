import { z } from "zod";
import { configHelpText, configKey } from "@/domain/config";
import { json, readBody, runApi } from "@/lib/api";
import { createConfigDraft, listConfigObjects } from "@/lib/config-store";

export const runtime = "nodejs";
const draftSchema = z
  .object({
    key: configKey,
    body: z.unknown(),
    note: configHelpText.optional(),
  })
  .strict();
/** Company owners, signed in; others get 403 config_forbidden. The company's non-archived roles. */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => json({ data: await listConfigObjects(p, "role") }),
    { humanOnly: true },
  );
}
/** A new role, or a new draft of an existing role with the same key; the strict role schema decides. */
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { key, body, note } = await readBody(request, draftSchema, 524_288);
      return json(
        { data: await createConfigDraft(p, { type: "role", key, body, note }) },
        201,
      );
    },
    { humanOnly: true },
  );
}
