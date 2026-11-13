import { json, runApi } from "@/lib/api";
import { readWorkbookBytes } from "@/lib/org-import";
import {
  dryRunUserImport,
  parseUserWorkbook,
  requireUserImportCaller,
} from "@/lib/user-import";

export const runtime = "nodejs";
/** Bulk invite check (ADM-15): never needs a recent sign-in and writes nothing. */
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      await requireUserImportCaller(p, "dry-run");
      return json({
        data: await dryRunUserImport(
          p,
          await parseUserWorkbook(await readWorkbookBytes(request)),
        ),
      });
    },
    { humanOnly: true },
  );
}
