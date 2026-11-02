import { runApi, json } from "@/lib/api";
import { searchWorkspace } from "@/lib/insights";
export const runtime = "nodejs";
export async function GET(req: Request) {
  return runApi(req, undefined, async (p) =>
    json(
      await searchWorkspace(p, new URL(req.url).searchParams.get("q") || ""),
    ),
  );
}
