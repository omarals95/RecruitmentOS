import { z } from "zod";
import { runApi, readBody, json } from "@/lib/api";
import { bulkApplications } from "@/lib/records";
export const runtime = "nodejs";
export async function POST(req: Request) {
  return runApi(req, "recruitment:write", async (p) =>
    json(
      await bulkApplications(
        p,
        // The service parses the body, so the field rules see only the fields it sent.
        await readBody(req, z.unknown()),
        req.headers.get("idempotency-key") ?? undefined,
      ),
    ),
  );
}
