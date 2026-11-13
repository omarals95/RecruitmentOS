import {
  AdminPortal,
  AdminPortalView,
} from "@/components/settings/admin-portal";
import { adminTabs } from "@/components/settings/admin-tabs";
import { adminPageAccess } from "@/lib/admin-access";
export default async function AdminPage() {
  const access = await adminPageAccess();
  if (!access || !adminTabs(access).length)
    return <AdminPortalView tab={null} access={null} denied error="" />;
  return <AdminPortal tab={null} />;
}
