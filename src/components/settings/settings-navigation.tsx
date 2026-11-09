import Link from "next/link";

export function SettingsNavigation({
  active,
  role,
}: {
  active: "profile" | "team" | "api-tokens" | "speed" | "about";
  /** Speed and the Admin portal link only for team owners and admins; About for everyone. */
  role?: string | null;
}) {
  const sections: [typeof active, string][] = [
    ["profile", "My profile"],
    ["team", "Team & access"],
    ["api-tokens", "API tokens"],
    ...(role === "owner" || role === "admin"
      ? [["speed", "Speed"] as [typeof active, string]]
      : []),
    ["about", "About"],
  ];
  return (
    <nav
      className="settings-nav"
      aria-label="Settings sections"
      style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}
    >
      {sections.map(([key, label]) => (
        <Link
          key={key}
          href={`/app/settings/${key}`}
          className={`button ${active === key ? "" : "secondary"}`}
          aria-current={active === key ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
      {(role === "owner" || role === "admin") && (
        <Link href="/app/admin" className="button secondary">
          Admin portal
        </Link>
      )}
    </nav>
  );
}
