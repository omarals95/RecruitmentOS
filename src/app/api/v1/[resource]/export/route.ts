import { runApi } from "@/lib/api";
import { exportRecords } from "@/lib/records";
import { attachmentDisposition } from "@/lib/storage";
import { workspaceEnvironment } from "@/lib/workspace";
import { RESOURCE_CONFIG } from "@/domain/records";
import {
  csvChunks,
  describeExportQuery,
  exportFilename,
  exportMetadata,
  exportTable,
} from "@/domain/export";
export const runtime = "nodejs";
type Context = { params: Promise<{ resource: string }> };
/** POST without a body, so the origin check applies and a cross-site link cannot write an audit row. */
export async function POST(req: Request, ctx: Context) {
  return runApi(req, undefined, async (p) => {
    const query = new URL(req.url).searchParams;
    // The audit row is committed before any byte is sent; a failed audit sends no file.
    const result = await exportRecords(p, (await ctx.params).resource, query);
    const now = new Date();
    const { headers, rows } = exportTable(
      result.resource,
      result.rows,
      result.hidden,
    );
    const chunks = csvChunks(
      headers,
      rows,
      exportMetadata({
        title: RESOURCE_CONFIG[result.resource].label,
        now,
        environment: workspaceEnvironment(process.env),
        filters: describeExportQuery(result.resource, query),
        written: result.total,
        total: result.total,
      }),
    );
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": attachmentDisposition(
            exportFilename(result.resource, now),
          ),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Export-Rows": String(result.total),
        },
      },
    );
  });
}
