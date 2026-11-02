import { runApi, json } from "@/lib/api";
import { analytics } from "@/lib/insights";
export const runtime = "nodejs";
export async function GET(req: Request) {
  return runApi(req, undefined, async (p) =>
    json(await analytics(p, new URL(req.url).searchParams)),
  );
}
