import { z } from "zod";
import { json, readBody, runApi } from "@/lib/api";
import { resetMemberTwoStep } from "@/lib/two-step";

export const runtime = "nodejs";
const resetSchema = z.object({ userId: z.string().min(1).max(128) }).strict();
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { userId } = await readBody(request, resetSchema, 1024);
      await resetMemberTwoStep(p, userId);
      return json({ data: { reset: true } });
    },
    { humanOnly: true, freshSession: true },
  );
}
