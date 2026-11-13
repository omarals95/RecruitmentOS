import { json, runApi } from "@/lib/api";
import {
  applyOrgImport,
  applyQuery,
  parseWorkbook,
  readWorkbookBytes,
  requireImportCaller,
  requireSameFile,
} from "@/lib/org-import";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { sha256, group } = applyQuery(new URL(request.url).searchParams);
      await requireImportCaller(p, group);
      const bytes = await readWorkbookBytes(request);
      requireSameFile(bytes, sha256);
      return json({
        data: await applyOrgImport(p, await parseWorkbook(bytes), group),
      });
    },
    { humanOnly: true },
  );
}
