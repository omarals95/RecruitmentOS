import { AuthForm } from "@/components/auth/auth-form";
import { getAuthOptions } from "@/lib/auth";
export default async function SignUp({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  return (
    <AuthForm
      mode="sign-up"
      options={getAuthOptions()}
      next={(await searchParams).next}
    />
  );
}
