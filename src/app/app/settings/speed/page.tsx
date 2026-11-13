import { SpeedSettings } from "@/components/settings/speed-settings";
import { redirectToTeamTab } from "@/lib/admin-access";
export default async function SpeedSettingsPage() {
  await redirectToTeamTab("speed");
  return <SpeedSettings />;
}
