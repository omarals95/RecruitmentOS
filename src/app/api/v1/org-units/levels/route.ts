import { json, readBody, runApi } from "@/lib/api";
import { orgLevelInput } from "@/domain/org";
import { createOrgLevel, listOrgLevels } from "@/lib/org";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => json({ data: await listOrgLevels(p) }),
    { humanOnly: true },
  );
}
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) =>
      json(
        {
          data: await createOrgLevel(p, await readBody(request, orgLevelInput)),
        },
        201,
      ),
    { humanOnly: true },
  );
}
