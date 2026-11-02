import Link from "next/link";
export default function NotFound() {
  return (
    <main style={{ padding: "3rem", maxWidth: 640, margin: "auto" }}>
      <h1>Page not found</h1>
      <p>This page may have moved, or the address is incomplete.</p>
      <Link href="/app">Open your workspace</Link>
    </main>
  );
}
