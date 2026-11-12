import { z } from "zod";
import { configKey } from "@/domain/config";
import { json, runApi } from "@/lib/api";
import { jobTitleUsage } from "@/lib/job-architecture";

export const runtime = "nodejs";
const usageQuery = z.object({ titleKey: configKey }).strict();
/**
 * Company owners and admins with organisation, signed in; others get 403 config_forbidden. Counts
 * only of the current positions, open vacancies and open offers using one job title. Not audited.
 */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { titleKey } = usageQuery.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      return json({ data: await jobTitleUsage(p, titleKey) });
    },
    { humanOnly: true },
  );
}
