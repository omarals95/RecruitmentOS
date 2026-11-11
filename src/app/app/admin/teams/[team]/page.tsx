import { AdminPortalView } from "@/components/settings/admin-portal";
import { NO_ACCESS, NOT_A_MEMBER } from "@/components/settings/admin-tabs";
import { TeamDetailPortal } from "@/components/settings/team-detail";
import { teamPageAccess } from "@/lib/admin-access";
export default async function TeamDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ team: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { team } = await params;
  const result = await teamPageAccess(team);
  if (result.state !== "allowed")
    return (
      <AdminPortalView
        tab="teams"
        access={null}
        denied
        error=""
        refusal={result.state === "not-a-member" ? NOT_A_MEMBER : NO_ACCESS}
      />
    );
  const { tab } = await searchParams;
  return (
    <TeamDetailPortal
      team={result.team}
      role={result.access.teamRole}
      companyLevel={result.access.companyLevel}
      tab={tab === "settings" ? "settings" : "members"}
    />
  );
}
