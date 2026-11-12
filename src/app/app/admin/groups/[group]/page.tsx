import { AdminPortalView } from "@/components/settings/admin-portal";
import { adminTabs } from "@/components/settings/admin-tabs";
import { GroupDetailPortal } from "@/components/settings/group-detail";
import { groupDetailTab } from "@/components/settings/group-detail-tabs";
import { adminPageAccess } from "@/lib/admin-access";
export default async function GroupDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ group: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { group } = await params;
  // A sub-page of Groups: it opens for exactly the callers the Groups page opens for.
  const access = await adminPageAccess();
  if (!access || !adminTabs(access).some((item) => item.key === "groups"))
    return <AdminPortalView tab="groups" access={null} denied error="" />;
  const { tab } = await searchParams;
  return (
    <GroupDetailPortal
      groupId={group}
      companyLevel={access.companyLevel}
      tab={groupDetailTab(tab)}
    />
  );
}
