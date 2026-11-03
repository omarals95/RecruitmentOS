import Link from "next/link";
import { getIdentityDb } from "@/db";
import { initialAdminClaim, organization, user } from "@/db/auth-schema";
import { AuthForm } from "@/components/auth/auth-form";
import { getAuthOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";
export default async function CreateAdmin() {
  const options = getAuthOptions();
  if (!options.configured || !options.bootstrapConfigured)
    return <AuthForm mode="create-admin" options={options} />;
  let available = false;
  try {
    const db = await getIdentityDb();
    const [claims, users, teams] = await Promise.all([
      db.select({ id: initialAdminClaim.id }).from(initialAdminClaim).limit(1),
      db.select({ id: user.id }).from(user).limit(1),
      db.select({ id: organization.id }).from(organization).limit(1),
    ]);
    available = !claims.length && !users.length && !teams.length;
  } catch {
    /* Do not open setup when the database cannot be checked. */
  }
  if (available) return <AuthForm mode="create-admin" options={options} />;
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <h1>Administrator setup unavailable</h1>
        <p>
          Setup is complete or cannot be checked. Sign in or contact your
          deployment administrator.
        </p>
        <Link href="/sign-in" className="button">
          Sign in
        </Link>
      </section>
    </main>
  );
}
