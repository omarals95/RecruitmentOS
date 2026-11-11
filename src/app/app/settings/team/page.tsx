import { TeamSettings } from "@/components/settings/team-settings";
import { redirectToTeamTab } from "@/lib/admin-access";
export default async function TeamSettingsPage() {
  await redirectToTeamTab("members");
  return <TeamSettings />;
}
