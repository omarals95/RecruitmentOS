import { json, readBody, runApi } from "@/lib/api";
import { employeePositionsInput } from "@/domain/directory";
import { setEmployeePositions } from "@/lib/directory";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
/** Replaces the employee's current positions with {positions: [{positionId, primary}]}. */
export async function PUT(request: Request, ctx: Context) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { id } = await ctx.params;
      return json({
        data: await setEmployeePositions(
          p,
          id,
          await readBody(request, employeePositionsInput),
        ),
      });
    },
    { humanOnly: true },
  );
}
