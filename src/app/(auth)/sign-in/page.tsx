import { AuthForm } from "@/components/auth/auth-form";
import { getAuthOptions } from "@/lib/auth";
import { publicBranding } from "@/lib/branding";
export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const query = await searchParams;
  // Only the public token set: the published sign-in message, nothing else (BRD-011).
  const branding = await publicBranding();
  return (
    <AuthForm
      mode="sign-in"
      options={getAuthOptions()}
      next={query.next}
      initialError={query.error}
      signInMessage={branding?.signInMessage}
    />
  );
}
