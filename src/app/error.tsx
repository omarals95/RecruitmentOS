"use client";
import Link from "next/link";
export default function ErrorPage({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <main style={{ padding: "3rem", maxWidth: 640, margin: "auto" }}>
      <h1>We couldn’t load this page</h1>
      <p>
        Your saved records are unchanged. Try loading the page again. If this
        continues, ask your team administrator to check the deployment
        configuration.
      </p>
      <button onClick={reset}>Try again</button>{" "}
      <Link href="/app">Return to workspace</Link>
    </main>
  );
}
