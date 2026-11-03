import { AuthForm } from "@/components/auth/auth-form";
import { getAuthOptions } from "@/lib/auth";
export default async function AcceptInvitation({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  return (
    <AuthForm
      mode="accept-invitation"
      options={getAuthOptions()}
      invitationId={(await searchParams).id}
    />
  );
}
