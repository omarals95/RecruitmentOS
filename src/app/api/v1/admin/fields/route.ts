import { z } from "zod";
import { CONFIGURABLE_KINDS, configHelpText } from "@/domain/config";
import { json, readBody, runApi } from "@/lib/api";
import { createConfigDraft, listKindSchemas } from "@/lib/config-store";

export const runtime = "nodejs";
const draftSchema = z
  .object({
    kind: z.enum(CONFIGURABLE_KINDS),
    body: z.unknown(),
    note: configHelpText.optional(),
  })
  .strict();
/** Company owners and admins with fields: every configurable kind's schema in force and draft. */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => json({ data: await listKindSchemas(p) }),
    { humanOnly: true },
  );
}
/** A new draft of one kind's schema; the strict body schema and the store's checks decide. */
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { kind, body, note } = await readBody(
        request,
        draftSchema,
        524_288,
      );
      return json(
        {
          data: await createConfigDraft(p, {
            type: "kind-schema",
            key: kind,
            body,
            note,
          }),
        },
        201,
      );
    },
    { humanOnly: true },
  );
}
