import { z } from "zod";
import { configKey } from "@/domain/config";
import { json, runApi } from "@/lib/api";
import { listWorkspacePeople } from "@/lib/admin-users";

export const runtime = "nodejs";
const cursorPart = z
  .string()
  .max(1024)
  .refine((value) => !value.includes("\u0000"));
// nextCursor of the previous page: base64url of the JSON array [sortKey, rowKey].
const cursor = z
  .string()
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/)
  .transform((value) => {
    try {
      return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    } catch {
      return null;
    }
  })
  .pipe(z.tuple([cursorPart, cursorPart]));
const peopleQuery = z
  .object({
    team: z
      .string()
      .max(70)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    status: z.enum(["active", "invited", "deactivated"]).optional(),
    level: z.enum(["owner", "admin", "none"]).optional(),
    role: configKey.optional(),
    cursor: cursor.optional(),
  })
  .strict();
/**
 * Company owners and company admins with the people area, signed in; others get 403
 * people_forbidden. Names, emails, teams and roles only, never team data.
 */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      const query = peopleQuery.parse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      return json(await listWorkspacePeople(p, query));
    },
    { humanOnly: true },
  );
}
