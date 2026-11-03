import { AuthForm } from "@/components/auth/auth-form";
import { getAuthOptions } from "@/lib/auth";
export default function ForgotPassword() {
  return <AuthForm mode="forgot-password" options={getAuthOptions()} />;
}
