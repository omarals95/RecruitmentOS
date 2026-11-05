import { z } from "zod";
import { json, readBody, runApi } from "@/lib/api";
import { findCandidateDuplicates } from "@/lib/records";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return runApi(request, "candidates:read", async (principal) =>
    json(
      await findCandidateDuplicates(
        principal,
        await readBody(request, z.unknown(), 4096),
      ),
    ),
  );
}
