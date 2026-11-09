import { runApi, json } from "@/lib/api";
import { analytics } from "@/lib/insights";
import { requireScope } from "@/lib/permissions";
export const runtime = "nodejs";
export async function GET(req: Request) {
  return runApi(req, "candidates:read", async (p) => {
    requireScope(p, "recruitment:read");
    return json(await analytics(p, new URL(req.url).searchParams));
  });
}
