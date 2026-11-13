import { json, readBody, runApi } from "@/lib/api";
import {
  companyAuthorityInput,
  listCompanyAuthority,
  setCompanyAuthority,
} from "@/lib/company-authority";

export const runtime = "nodejs";
/** Company owners, signed in; others get 403 authority_forbidden. */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => json({ data: await listCompanyAuthority(p) }),
    { humanOnly: true },
  );
}
/** One grant, change or removal through tenant_context.set_workspace_authority. */
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const input = await readBody(request, companyAuthorityInput, 1024);
      return json({ data: await setCompanyAuthority(p, input) });
    },
    { humanOnly: true, freshSession: true },
  );
}
