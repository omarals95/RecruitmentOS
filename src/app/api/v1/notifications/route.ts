import { z } from "zod";
import { runApi, json, readBody } from "@/lib/api";
import { notifications, markNotifications } from "@/lib/insights";
export const runtime = "nodejs";
export async function GET(req: Request) {
  return runApi(req, "recruitment:read", async (p) =>
    json(await notifications(p)),
  );
}
export async function POST(req: Request) {
  return runApi(req, "recruitment:read", async (p) => {
    const body = await readBody(
      req,
      z.object({ keys: z.array(z.string().min(1).max(300)).max(500) }).strict(),
    );
    return json(await markNotifications(p, body.keys));
  });
}
