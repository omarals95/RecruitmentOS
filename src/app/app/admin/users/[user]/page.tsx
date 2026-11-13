import { AdminPortalView } from "@/components/settings/admin-portal";
import { adminTabs } from "@/components/settings/admin-tabs";
import { UserDetailPortal } from "@/components/settings/user-detail";
import { userDetailTab } from "@/components/settings/user-detail-tabs";
import { adminPageAccess } from "@/lib/admin-access";
export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ user: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await params;
  // A sub-page of Users: it opens for exactly the callers the Users page opens for.
  const access = await adminPageAccess();
  if (!access || !adminTabs(access).some((item) => item.key === "users"))
    return <AdminPortalView tab="users" access={null} denied error="" />;
  const { tab } = await searchParams;
  return (
    <UserDetailPortal
      userId={user}
      companyLevel={access.companyLevel}
      tab={userDetailTab(tab)}
    />
  );
}
