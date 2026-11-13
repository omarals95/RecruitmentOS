import type { Metadata } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import { brandingCss } from "@/domain/branding";
import { publicBranding } from "@/lib/branding";
import "./globals.css";
export const metadata: Metadata = {
  title: { default: "RecruitmentOS", template: "%s · RecruitmentOS" },
  description:
    "A private workspace for recruitment teams, candidates and hiring workflows.",
  robots: { index: false, follow: false },
};
// The published branding is read per request, never at build time.
export const dynamic = "force-dynamic";
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const branding = await publicBranding();
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {branding && <style>{brandingCss(branding)}</style>}
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
