import { protectedResourceMetadata } from "@/lib/oauth";

export const runtime = "nodejs";
export function GET() {
  return protectedResourceMetadata();
}
