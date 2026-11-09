import { json, readBody, runApi } from "@/lib/api";
import { orgUnitInput } from "@/domain/org";
import { createOrgUnit, listOrgUnits } from "@/lib/org";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) =>
      json(
        await listOrgUnits(
          p,
          Object.fromEntries(new URL(request.url).searchParams),
        ),
      ),
    { humanOnly: true },
  );
}
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) =>
      json(
        { data: await createOrgUnit(p, await readBody(request, orgUnitInput)) },
        201,
      ),
    { humanOnly: true },
  );
}
