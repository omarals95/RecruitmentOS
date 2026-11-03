import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getSession } from "./auth-session";
import { getAuthOptions } from "./auth";
import { getIdentityDb } from "@/db";
import { member, organization } from "@/db/auth-schema";
import { parseRole, type Role } from "./permissions";
export interface WorkspaceContext {
  user: { id: string; name: string; email: string };
  team: { id: string; name: string; slug: string } | null;
  role: Role | null;
}
export async function getWorkspaceContext(): Promise<WorkspaceContext> {
  if (!getAuthOptions().configured) throw new Error("SETUP_REQUIRED");
  const identity = await getSession(await headers());
  if (!identity) redirect("/sign-in");
  if (!identity.user.emailVerified) redirect("/verify-email");
  const db = await getIdentityDb();
  const memberships = await db
    .select({ team: organization, role: member.role })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, identity.user.id));
  const active =
    memberships.find(
      (m) => m.team.id === identity.session.activeOrganizationId,
    ) ?? memberships[0];
  return {
    user: {
      id: identity.user.id,
      name: identity.user.name,
      email: identity.user.email,
    },
    team: active
      ? { id: active.team.id, name: active.team.name, slug: active.team.slug }
      : null,
    role: active ? parseRole(active.role) : null,
  };
}
