import { json } from "@/lib/api";
import { appVersion } from "@/lib/app-version";

/** Public: the build facts only, with no session, token or database read. */
export function GET() {
  const { version, build, commit, environment } = appVersion();
  return json({ version, build, commit, environment });
}
