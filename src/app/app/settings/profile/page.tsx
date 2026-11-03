import { getAuthOptions } from "@/lib/auth";
import { ProfileSettings } from "@/components/settings/profile-settings";
export default function ProfileSettingsPage() {
  const options = getAuthOptions();
  return (
    <ProfileSettings
      providers={{ google: options.google, microsoft: options.microsoft }}
    />
  );
}
