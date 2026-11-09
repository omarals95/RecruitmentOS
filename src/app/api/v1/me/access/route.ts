import { json, runApi } from "@/lib/api";
import { accessContext, accessMap } from "@/lib/authz";
import { withTeam } from "@/lib/db-team";

export const runtime = "nodejs";
/** Signed in only: the caller's own team role, company level and authorize() answers. */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const access = await withTeam(p, async (_tx, state) => state);
      return json({
        data: {
          teamRole: p.role,
          companyLevel: access.companyLevel,
          ...accessMap(accessContext(p, access)),
        },
      });
    },
    { humanOnly: true },
  );
}
