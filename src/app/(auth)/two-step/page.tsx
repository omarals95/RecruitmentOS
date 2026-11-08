import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { TwoStepCode } from "@/components/auth/two-step";
import { safeNext } from "@/lib/safe-next";
export default async function TwoStep({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNext((await searchParams).next);
  // Without a pending challenge (Better Auth's signed two_factor cookie) a code cannot be checked.
  if (
    !(await cookies())
      .getAll()
      .some((cookie) => cookie.name.endsWith("better-auth.two_factor"))
  )
    redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  return <TwoStepCode next={next} />;
}
