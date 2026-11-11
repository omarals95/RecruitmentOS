import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getSession } from "./auth-session";
import { getAuthOptions } from "./auth";
import { canCreateTeam, twoStepSetupRequired } from "./auth-policy";
import { getIdentityDb } from "@/db";
import { member, organization } from "@/db/auth-schema";
import { parseRole, type Role } from "./permissions";
import { workspaceEnvironment } from "./build-info";
export { workspaceEnvironment };
export interface WorkspaceContext {
  user: { id: string; name: string; email: string; twoStepEnabled: boolean };
  team: { id: string; name: string; slug: string } | null;
  role: Role | null;
  environment: string;
  canCreateTeam: boolean;
}
export async function getWorkspaceContext(): Promise<WorkspaceContext> {
  return (await readWorkspace()).context;
}
/** getWorkspaceContext, and the signed-in user's membership of one team: null when not a member. */
export async function getTeamWorkspaceContext(teamId: string): Promise<
  WorkspaceContext & {
    member: { team: { id: string; name: string }; role: Role } | null;
  }
> {
  const { context, memberships } = await readWorkspace();
  const found = memberships.find((m) => m.team.id === teamId);
  return {
    ...context,
    member: found
      ? {
          team: { id: found.team.id, name: found.team.name },
          role: parseRole(found.role),
        }
      : null,
  };
}
async function readWorkspace() {
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
  if (
    twoStepSetupRequired(
      identity.user.twoFactorEnabled,
      memberships.map((m) => m.role),
    )
  )
    redirect("/two-step-setup?next=/app");
  const active =
    memberships.find(
      (m) => m.team.id === identity.session.activeOrganizationId,
    ) ?? memberships[0];
  const context: WorkspaceContext = {
    user: {
      id: identity.user.id,
      name: identity.user.name,
      email: identity.user.email,
      twoStepEnabled: Boolean(identity.user.twoFactorEnabled),
    },
    team: active
      ? { id: active.team.id, name: active.team.name, slug: active.team.slug }
      : null,
    role: active ? parseRole(active.role) : null,
    environment: workspaceEnvironment(process.env),
    canCreateTeam: canCreateTeam(
      identity.user,
      memberships.map((m) => m.role),
    ),
  };
  return { context, memberships };
}
