import { notFound } from "next/navigation";
import { AdminPortal } from "@/components/settings/admin-portal";
import { isAdminTab } from "@/components/settings/admin-tabs";
export default async function AdminTabPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;
  if (!isAdminTab(tab)) notFound();
  return <AdminPortal tab={tab} />;
}
