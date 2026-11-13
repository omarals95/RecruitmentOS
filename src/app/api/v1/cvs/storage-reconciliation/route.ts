import { json, runApi } from "@/lib/api";
import { runStorageReconciliation } from "@/lib/blob-reconcile";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return runApi(request, "cvs:write", async (p) =>
    json({ data: await runStorageReconciliation(p) }),
  );
}
