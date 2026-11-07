import { z } from "zod";
import { json, readBody, runApi } from "@/lib/api";
import { decideConsent } from "@/lib/oauth";

export const runtime = "nodejs";
const param = (max: number) => z.string().max(max).optional();
const consentSchema = z
  .object({
    response_type: param(20),
    client_id: param(64),
    redirect_uri: param(2000),
    code_challenge: param(128),
    code_challenge_method: param(10),
    state: param(1000),
    scope: param(500),
    resource: param(2000),
    scopes: z.array(z.string().max(40)).max(10),
    decision: z.enum(["approve", "deny"]),
  })
  .strict();

// Cookie-only consent decision; X-Team-Id selects the team the grant belongs to.
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const { scopes, decision, ...params } = await readBody(
        request,
        consentSchema,
        16384,
      );
      return json({
        data: {
          redirectTo: await decideConsent(p, { params, scopes, decision }),
        },
      });
    },
    { humanOnly: true },
  );
}
