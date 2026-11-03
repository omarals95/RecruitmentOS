import Link from "next/link";

export function SettingsNavigation({
  active,
}: {
  active: "profile" | "team" | "api-tokens";
}) {
  return (
    <nav
      className="settings-nav"
      aria-label="Settings sections"
      style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}
    >
      {(
        [
          ["profile", "My profile"],
          ["team", "Team & access"],
          ["api-tokens", "API tokens"],
        ] as const
      ).map(([key, label]) => (
        <Link
          key={key}
          href={`/app/settings/${key}`}
          className={`button ${active === key ? "" : "secondary"}`}
          aria-current={active === key ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
