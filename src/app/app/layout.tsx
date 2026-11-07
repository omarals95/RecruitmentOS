import { redirect } from "next/navigation";
import Link from "next/link";
import { getWorkspaceContext } from "@/lib/workspace";
import { WorkspaceShell } from "@/components/workspace/shell";
import { SpeedInsightsReporter } from "@/components/speed-insights";

export const dynamic = "force-dynamic";
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let context;
  try {
    context = await getWorkspaceContext();
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    return (
      <main className="setup-page">
        <h1>Workspace setup is required</h1>
        <p>
          RecruitmentOS needs its database and authentication environment
          configured before you can sign in.
        </p>
        <p className="muted">
          Ask the deployment administrator to follow the setup guide. No
          candidate data has been loaded.
        </p>
        <Link className="button" href="/">
          Back to home
        </Link>
      </main>
    );
  }
  if (!context?.user) redirect("/sign-in");
  return (
    <>
      <WorkspaceShell identity={context}>{children}</WorkspaceShell>
      <SpeedInsightsReporter />
    </>
  );
}
