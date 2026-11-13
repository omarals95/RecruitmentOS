import { AdminPortalView } from "@/components/settings/admin-portal";
import { adminTabs } from "@/components/settings/admin-tabs";
import { FieldDetailPortal } from "@/components/settings/field-detail";
import { fieldDetailTab } from "@/components/settings/field-detail-tabs";
import { adminPageAccess } from "@/lib/admin-access";
export default async function FieldDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string; field: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { kind, field } = await params;
  // A sub-page of Fields: it opens for exactly the callers the Fields page opens for.
  const access = await adminPageAccess();
  if (!access || !adminTabs(access).some((item) => item.key === "fields"))
    return <AdminPortalView tab="fields" access={null} denied error="" />;
  const { tab } = await searchParams;
  return (
    <FieldDetailPortal
      kind={kind}
      fieldKey={field}
      companyLevel={access.companyLevel}
      tab={fieldDetailTab(tab)}
    />
  );
}
