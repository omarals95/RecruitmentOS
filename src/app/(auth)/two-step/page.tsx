import { TwoStepCode } from "@/components/auth/two-step";
import { safeNext } from "@/lib/safe-next";
export default async function TwoStep({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  return <TwoStepCode next={safeNext((await searchParams).next)} />;
}
