import { DrizzleQueryError, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getIdentityDb, type TeamTx } from "@/db";
import { user } from "@/db/auth-schema";
import { GRANTABLE_ADMIN_AREAS } from "@/domain/config";
import { withTeam } from "./db-team";
import { ApiError } from "./errors";
import type { Principal } from "./principal";
import type { TenantAccess } from "./tenant-context";

export type CompanyAuthorityHolder = {
  userId: string;
  name: string | null;
  level: "owner" | "admin";
  areas: string[];
  planAccess: boolean;
  suspended: boolean;
};

const authorityForbidden = () =>
  new ApiError(
    403,
    "authority_forbidden",
    "Only a company owner can manage company authority.",
  );
const userId = z.string().min(1).max(128);
/** A removal, an owner grant (no areas) or an admin grant with grantable areas; nothing else. */
export const companyAuthorityInput = z.union([
  z.object({ userId, level: z.null() }).strict(),
  z
    .object({
      userId,
      level: z.literal("owner"),
      areas: z.array(z.enum(GRANTABLE_ADMIN_AREAS)).length(0),
      planAccess: z.boolean(),
    })
    .strict(),
  z
    .object({
      userId,
      level: z.literal("admin"),
      areas: z
        .array(z.enum(GRANTABLE_ADMIN_AREAS))
        .max(GRANTABLE_ADMIN_AREAS.length)
        .refine(
          (areas) => new Set(areas).size === areas.length,
          "Areas must be unique.",
        ),
      planAccess: z.boolean(),
    })
    .strict(),
]);
export type CompanyAuthorityInput = z.infer<typeof companyAuthorityInput>;

/** One withTeam transaction; the helper stays authoritative and its refusals map to API errors. */
async function inAuthority<T>(
  p: Principal,
  work: (tx: TeamTx, access: TenantAccess) => Promise<T>,
): Promise<T> {
  try {
    return await withTeam(p, work);
  } catch (error) {
    const code = (
      (error instanceof DrizzleQueryError ? error.cause : error) as
        { code?: unknown } | undefined
    )?.code;
    if (code === "42501") throw authorityForbidden();
    if (code === "22023")
      throw new ApiError(
        400,
        "invalid_input",
        "This grant is not allowed. Choose a level, the areas a company admin may hold and plan access.",
      );
    if (code === "RQ005")
      throw new ApiError(
        409,
        "last_company_owner",
        "The last company owner cannot be removed or demoted. Make someone else a company owner first.",
      );
    if (code === "RQ006")
      throw new ApiError(
        409,
        "not_in_company",
        "This person is not a member of any team in this company. Invite them to a team first.",
      );
    throw error;
  }
}

/**
 * Company owners, signed in: every company owner and admin of the workspace, suspended ones
 * included, with their display names; owners first, then by name.
 */
export async function listCompanyAuthority(
  p: Principal,
): Promise<CompanyAuthorityHolder[]> {
  const rows = await inAuthority(p, async (tx, access) => {
    if (p.authType !== "session" || access.companyLevel !== "owner")
      throw authorityForbidden();
    return (
      await tx.execute<Omit<CompanyAuthorityHolder, "name">>(
        sql`select user_id as "userId", level, areas, plan_access as "planAccess", suspended_at is not null as suspended from app.workspace_admins where workspace_id = ${access.workspaceId}::uuid`,
      )
    ).rows;
  });
  if (!rows.length) return [];
  const db = await getIdentityDb();
  const names = new Map(
    (
      await db
        .select({ id: user.id, name: user.name })
        .from(user)
        .where(
          inArray(
            user.id,
            rows.map((row) => row.userId),
          ),
        )
    ).map((row) => [row.id, row.name]),
  );
  return rows
    .map((row) => ({ ...row, name: names.get(row.userId) ?? null }))
    .sort(
      (a, b) =>
        Number(a.level !== "owner") - Number(b.level !== "owner") ||
        (a.name ?? "").localeCompare(b.name ?? ""),
    );
}

/**
 * A company owner, signed in, grants, changes or removes one person's company level, areas and
 * plan access through tenant_context.set_workspace_authority, which audits every change and returns
 * false when nothing changes. Re-granting a suspended row clears the suspension.
 */
export async function setCompanyAuthority(
  p: Principal,
  input: CompanyAuthorityInput,
): Promise<{ changed: boolean }> {
  const grant = companyAuthorityInput.parse(input);
  return inAuthority(p, async (tx, access) => {
    if (p.authType !== "session" || access.companyLevel !== "owner")
      throw authorityForbidden();
    const { rows } = await tx.execute<{ changed: boolean }>(
      grant.level === null
        ? sql`select tenant_context.set_workspace_authority(${grant.userId}, null, null, null) as changed`
        : sql`select tenant_context.set_workspace_authority(${grant.userId}, ${grant.level}, ${sql.param(grant.areas)}::text[], ${grant.planAccess}) as changed`,
    );
    return { changed: rows[0].changed };
  });
}
