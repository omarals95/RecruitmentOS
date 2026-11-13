import { json, runApi } from "@/lib/api";
import { getAuth } from "@/lib/auth";
import {
  applyQuery,
  readWorkbookBytes,
  requireSameFile,
} from "@/lib/org-import";
import {
  applyUserImport,
  parseUserWorkbook,
  requireUserImportCaller,
} from "@/lib/user-import";

export const runtime = "nodejs";
/** Bulk invite apply (ADM-15): a recent sign-in, the same file the dry run checked. */
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { sha256, group } = applyQuery(new URL(request.url).searchParams);
      await requireUserImportCaller(p, group);
      const bytes = await readWorkbookBytes(request);
      requireSameFile(bytes, sha256);
      return json({
        data: await applyUserImport(
          p,
          await parseUserWorkbook(bytes),
          group,
          await getAuth(),
          request.headers,
        ),
      });
    },
    { humanOnly: true, freshSession: true },
  );
}
