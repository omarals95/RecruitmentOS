import { runApi, json } from "@/lib/api";
import { overview } from "@/lib/insights";
import { requireScope } from "@/lib/permissions";
export const runtime = "nodejs";
export async function GET(req: Request) {
  return runApi(req, "candidates:read", async (p) => {
    requireScope(p, "recruitment:read");
    return json(await overview(p));
  });
}
