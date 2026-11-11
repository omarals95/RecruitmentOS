import { json, readBody, runApi } from "@/lib/api";
import {
  beginRecordFileUpload,
  recordFileUploadSchema,
} from "@/lib/record-files";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return runApi(request, "cvs:write", async (principal) =>
    json(
      await beginRecordFileUpload(
        principal,
        await readBody(request, recordFileUploadSchema, 8192),
      ),
      201,
    ),
  );
}
