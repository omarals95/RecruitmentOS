import { AuthForm } from "@/components/auth/auth-form";
import { getAuthOptions } from "@/lib/auth";
export default async function VerifyEmail({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  return (
    <AuthForm
      mode="verify-email"
      options={getAuthOptions()}
      initialError={(await searchParams).error}
    />
  );
}
