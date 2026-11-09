import { json, runApi } from "@/lib/api";
import {
  dryRunOrgImport,
  parseWorkbook,
  readWorkbookBytes,
  requireImportCaller,
} from "@/lib/org-import";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      await requireImportCaller(p, "dry-run");
      return json({
        data: await dryRunOrgImport(
          p,
          await parseWorkbook(await readWorkbookBytes(request)),
        ),
      });
    },
    { humanOnly: true },
  );
}
