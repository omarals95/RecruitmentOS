import { json, readBody, runApi } from "@/lib/api";
import {
  createSalaryBracketDraft,
  getSalaryBrackets,
  salaryBracketInput,
} from "@/lib/pay-brackets";

export const runtime = "nodejs";
/** Plan & pay access holders with plans:read: the current published version and the newest draft. */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => json({ data: await getSalaryBrackets(p) }),
    { humanOnly: true },
  );
}
/** A new draft with one bracket per grade of the published job architecture. */
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const input = await readBody(request, salaryBracketInput, 65_536);
      return json({ data: await createSalaryBracketDraft(p, input) }, 201);
    },
    { humanOnly: true },
  );
}
