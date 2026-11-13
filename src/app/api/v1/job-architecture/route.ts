import { z } from "zod";
import { JOB_ARCHITECTURE_KEY, configHelpText } from "@/domain/config";
import { json, readBody, runApi } from "@/lib/api";
import { createConfigDraft } from "@/lib/config-store";
import { getJobArchitecture } from "@/lib/job-architecture";

export const runtime = "nodejs";
const draftSchema = z
  .object({ body: z.unknown(), note: configHelpText.optional() })
  .strict();
/** Every member: the published job architecture, and the draft for those who may write it. */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => json({ data: await getJobArchitecture(p) }),
    { humanOnly: true },
  );
}
/** A new draft of the company's one job architecture; the strict body schema decides. */
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { body, note } = await readBody(request, draftSchema, 524_288);
      return json(
        {
          data: await createConfigDraft(p, {
            type: "job-architecture",
            key: JOB_ARCHITECTURE_KEY,
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
