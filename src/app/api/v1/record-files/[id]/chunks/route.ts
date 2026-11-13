import { runApi } from "@/lib/api";
import { parseCvChunkQuery } from "@/lib/cvs";
import { getRecordFileChunk } from "@/lib/record-files";
import { attachmentDisposition } from "@/lib/storage";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return runApi(request, "cvs:read", async (principal) => {
    const chunk = await getRecordFileChunk(
      principal,
      id,
      parseCvChunkQuery(new URL(request.url).searchParams),
    );
    // The CV chunk route's headers, every value from the validated row; never an inline disposition.
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
