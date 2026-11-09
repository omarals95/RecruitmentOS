import { json, runApi } from "@/lib/api";
import {
  dryRunOrgImport,
  parseWorkbook,
  readWorkbookBytes,
} from "@/lib/org-import";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) =>
      json({
        data: await dryRunOrgImport(
          p,
          await parseWorkbook(await readWorkbookBytes(request)),
        ),
      }),
    { humanOnly: true },
  );
}
