import { notFound } from "next/navigation";
import {
  AdminPortal,
  AdminPortalView,
} from "@/components/settings/admin-portal";
import { adminTabs, isAdminTab } from "@/components/settings/admin-tabs";
import { adminPageAccess } from "@/lib/admin-access";
export default async function AdminTabPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;
  if (!isAdminTab(tab)) notFound();
  const access = await adminPageAccess();
  if (!access || !adminTabs(access).some((item) => item.key === tab))
    return <AdminPortalView tab={tab} access={null} denied error="" />;
  return <AdminPortal tab={tab} />;
}
