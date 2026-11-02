import { AuthForm } from "@/components/auth/auth-form";
import { getAuthOptions } from "@/lib/auth";
export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const query = await searchParams;
  return (
    <AuthForm
      mode="sign-in"
      options={getAuthOptions()}
      next={query.next}
      initialError={query.error}
    />
  );
}
