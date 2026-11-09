import { json, readBody, runApi } from "@/lib/api";
import { positionInput } from "@/domain/directory";
import { createPosition, listPositions } from "@/lib/directory";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) =>
      json(
        await listPositions(
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
        {
          data: await createPosition(p, await readBody(request, positionInput)),
        },
        201,
      ),
    { humanOnly: true },
  );
}
