import { registerClient } from "@/lib/oauth";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return registerClient(request);
}
