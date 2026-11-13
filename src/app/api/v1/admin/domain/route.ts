import { z } from "zod";
import { json, runApi } from "@/lib/api";
import { readDomainSettings } from "@/lib/domain-settings";

export const runtime = "nodejs";
/**
 * Company owners, signed in; others get 403 domain_forbidden. The configured address from
 * BETTER_AUTH_URL only, read only; no query is accepted, so no address can be sent to the server.
 */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      z.object({})
        .strict()
        .parse(Object.fromEntries(new URL(request.url).searchParams));
      return json({ data: await readDomainSettings(p) });
    },
    { humanOnly: true },
  );
}
