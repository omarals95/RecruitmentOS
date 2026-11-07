import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getIdentityDb } from "@/db";
import { member } from "@/db/auth-schema";
import { TwoStepSetup } from "@/components/auth/two-step";
import { getAuthOptions } from "@/lib/auth";
import { twoStepSetupRequired } from "@/lib/auth-policy";
import { getSession } from "@/lib/auth-session";
import { safeNext } from "@/lib/safe-next";

export const dynamic = "force-dynamic";
export default async function TwoStepSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNext((await searchParams).next);
  if (!getAuthOptions().configured) redirect("/sign-in");
  const identity = await getSession(await headers());
  if (!identity) redirect("/sign-in");
  if (!identity.user.emailVerified) redirect("/verify-email");
  if (identity.user.twoFactorEnabled) redirect(next);
  const db = await getIdentityDb();
  const memberships = await db
    .select({ role: member.role })
    .from(member)
    .where(eq(member.userId, identity.user.id));
  return (
    <TwoStepSetup
      email={identity.user.email}
      required={twoStepSetupRequired(
        false,
        memberships.map((row) => row.role),
      )}
      next={next}
    />
  );
}
