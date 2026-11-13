import { runApi } from "@/lib/api";
import { getCvChunk, parseCvChunkQuery } from "@/lib/cvs";
import { requireScope } from "@/lib/permissions";
import { attachmentDisposition } from "@/lib/storage";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return runApi(request, "cvs:read", async (principal) => {
    // The scope refusal comes before query validation; getCvChunk checks it again.
    requireScope(principal, "candidates:read");
    const chunk = await getCvChunk(
      principal,
      id,
      parseCvChunkQuery(new URL(request.url).searchParams),
    );
    // Every X-CV-* value comes from the validated row, never from the provider.
    return new Response(new Uint8Array(chunk.bytes), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": attachmentDisposition(chunk.originalName),
        "Content-Length": String(chunk.bytes.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-CV-Upload-Id": chunk.uploadId,
        "X-CV-Chunk-Index": String(chunk.index),
        "X-CV-Chunk-Offset": String(chunk.offset),
        "X-CV-Size-Bytes": String(chunk.sizeBytes),
        "X-CV-SHA256": chunk.sha256,
      },
    });
  });
}
