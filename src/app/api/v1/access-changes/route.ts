import { z } from "zod";
import { json, runApi } from "@/lib/api";
import { listHomeUnitChanges } from "@/lib/directory";
import { listRoleAssignmentChanges } from "@/lib/member-roles";

export const runtime = "nodejs";
const PAGE = 100;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Company owners, signed in; others get 403 role_assignment_forbidden. Role assignments and
 * home-unit changes of the last seven days, newest first; truncated when a full page of either kind
 * still ends inside the seven days.
 */
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      z.object({})
        .strict()
        .parse(Object.fromEntries(new URL(request.url).searchParams));
      const roles = await listRoleAssignmentChanges(p, { pageSize: PAGE });
      const homeUnits = await listHomeUnitChanges(p, { pageSize: PAGE });
      const since = Date.now() - WEEK_MS;
      const time = (value: string) => new Date(value).getTime();
      const recent = (row: { occurredAt: string }) =>
        time(row.occurredAt) >= since;
      const data = [
        ...roles.map((row) => ({
          occurredAt: row.occurredAt,
          kind: "role-assignment" as const,
          action: row.action,
          affectedUserIds: [row.affectedUserId],
          roleName: row.roleName,
          actorName: row.actorName,
        })),
        ...homeUnits.map((row) => ({
          occurredAt: row.occurredAt,
          kind: "home-units" as const,
          action: row.action,
          affectedUserIds: row.affectedUserIds,
          roleName: null,
          actorName: row.actorName,
        })),
      ]
        .filter(recent)
        .sort((a, b) => time(b.occurredAt) - time(a.occurredAt));
      const truncated = [roles, homeUnits].some(
        (rows) => rows.length === PAGE && recent(rows[rows.length - 1]),
      );
      return json({ data, truncated });
    },
    { humanOnly: true },
  );
}
