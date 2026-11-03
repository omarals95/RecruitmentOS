import { AuthForm } from "@/components/auth/auth-form";
import { getAuthOptions } from "@/lib/auth";
export default async function ResetPassword({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const query = await searchParams;
  return (
    <AuthForm
      mode="reset-password"
      options={getAuthOptions()}
      token={query.token}
      initialError={query.error}
    />
  );
}
