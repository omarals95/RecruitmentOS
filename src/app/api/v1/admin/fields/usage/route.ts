import { z } from "zod";
import { CONFIGURABLE_KINDS } from "@/domain/config";
import { json, runApi } from "@/lib/api";
import { fieldUsage } from "@/lib/config-store";

export const runtime = "nodejs";
const usageQuery = z
  .object({ kind: z.enum(CONFIGURABLE_KINDS), fieldId: z.uuid() })
  .strict();
/**
 * Company owners and admins with fields, signed in; others get 403 config_forbidden. A count only of
 * the records of every team holding a value of one custom field in force. Not audited.
 */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { kind, fieldId } = usageQuery.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      return json({ data: await fieldUsage(p, kind, fieldId) });
    },
    { humanOnly: true },
  );
}
