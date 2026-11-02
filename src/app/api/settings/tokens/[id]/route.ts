import { json, runApi } from "@/lib/api";
import { revokeToken } from "@/lib/api-tokens";

export const runtime = "nodejs";
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { id } = await context.params;
      await revokeToken(p, id);
      return json({ data: { revoked: true } });
    },
    { humanOnly: true },
  );
}
