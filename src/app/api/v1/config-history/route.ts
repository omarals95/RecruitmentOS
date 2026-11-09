import { z } from "zod";
import { json, runApi } from "@/lib/api";
import { listConfigHistory } from "@/lib/config-store";

export const runtime = "nodejs";
const historyQuery = z
  .object({
    before: z.iso.datetime({ offset: true }).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
/** Company owners and admins, signed in; others get 403 config_forbidden. */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { before, pageSize } = historyQuery.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      const data = await listConfigHistory(p, {
        before: before === undefined ? undefined : new Date(before),
        pageSize,
      });
      const hasMore = data.length === pageSize;
      return json({
        data,
        pagination: {
          pageSize,
          hasMore,
          nextBefore: hasMore
            ? new Date(data[data.length - 1].occurredAt).toISOString()
            : null,
        },
      });
    },
    { humanOnly: true },
  );
}
