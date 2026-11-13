import { json, runApi } from "@/lib/api";
import { meAccess } from "@/lib/authz";
import { withTeam } from "@/lib/db-team";
import { planAccessFor } from "@/lib/pay-brackets";

export const runtime = "nodejs";
/**
 * Signed in only: the caller's own team role, company level, Plan & pay access answer and
 * authorize() answers.
 */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const [access, planAccess] = await withTeam(
        p,
        async (tx, state) => [state, await planAccessFor(tx, state)] as const,
      );
      return json({ data: meAccess(p, access, planAccess) });
    },
    { humanOnly: true },
  );
}
