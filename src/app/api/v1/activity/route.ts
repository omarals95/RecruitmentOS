import { runApi, json } from "@/lib/api";
import { listActivity } from "@/lib/insights";
export const runtime = "nodejs";
export async function GET(req: Request) {
  return runApi(req, "recruitment:read", async (p) =>
    json(await listActivity(p, new URL(req.url).searchParams)),
  );
}
