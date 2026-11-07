/** A same-origin path after sign-in: the workspace, an invitation or the app connection page. */
export function safeNext(value?: string) {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return "/app";
  const url = new URL(value, "https://recruitment.invalid");
  return url.origin === "https://recruitment.invalid" &&
    (url.pathname === "/app" ||
      url.pathname.startsWith("/app/") ||
      url.pathname === "/accept-invitation" ||
      url.pathname === "/oauth/authorize")
    ? `${url.pathname}${url.search}`
    : "/app";
}
