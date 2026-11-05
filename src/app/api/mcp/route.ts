import { handleMcpRequest } from "@/lib/mcp/server";

export const runtime = "nodejs";
// Only POST: Next.js answers GET, PUT, PATCH and DELETE with 405.
export async function POST(request: Request) {
  return handleMcpRequest(request);
}
