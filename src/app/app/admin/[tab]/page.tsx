import { notFound } from "next/navigation";
import {
  AdminPortal,
  AdminPortalView,
} from "@/components/settings/admin-portal";
import {
  adminTabs,
  isAdminTab,
  oldTeamPage,
} from "@/components/settings/admin-tabs";
import { adminPageAccess, redirectToTeamTab } from "@/lib/admin-access";
export default async function AdminTabPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;
  const moved = oldTeamPage(tab);
  if (moved) {
    await redirectToTeamTab(moved);
    return <AdminPortalView tab={null} access={null} denied error="" />;
  }
  if (!isAdminTab(tab)) notFound();
  const access = await adminPageAccess();
  if (!access || !adminTabs(access).some((item) => item.key === tab))
    return <AdminPortalView tab={tab} access={null} denied error="" />;
  return <AdminPortal tab={tab} />;
}
