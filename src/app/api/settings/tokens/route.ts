import { json, readBody, runApi } from "@/lib/api";
import { createToken, listTokens } from "@/lib/api-tokens";
import { tokenInputSchema } from "@/lib/api-token-policy";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) =>
      json({
        data: await listTokens(
          p,
          new URL(request.url).searchParams.get("all") === "true",
        ),
      }),
    { humanOnly: true },
  );
}
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const result = await createToken(
        p,
        await readBody(request, tokenInputSchema, 16384),
      );
      return json(result, 201);
    },
    { humanOnly: true },
  );
}
