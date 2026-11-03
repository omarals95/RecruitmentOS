import { runApi, json } from "@/lib/api";
import { overview } from "@/lib/insights";
export const runtime = "nodejs";
export async function GET(req: Request) {
  return runApi(req, undefined, async (p) => json(await overview(p)));
}
