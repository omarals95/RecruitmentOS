import { json, readBody, runApi } from "@/lib/api";
import {
  consentInputSchema,
  consentView,
  recordConsent,
} from "@/lib/ai-extraction";
import { requireScope } from "@/lib/permissions";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return runApi(
    request,
    "cvs:write",
    async (principal) => {
      requireScope(principal, "candidates:write");
      return json({ data: await consentView(principal) });
    },
    { humanOnly: true },
  );
}
export async function POST(request: Request) {
  return runApi(
    request,
    "cvs:write",
    async (principal) => {
      requireScope(principal, "candidates:write");
      const input = await readBody(request, consentInputSchema, 4096);
      await recordConsent(principal, input.decision, input.disclosureVersion);
      return json({ data: await consentView(principal) });
    },
    { humanOnly: true },
  );
}
