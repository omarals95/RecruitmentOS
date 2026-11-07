import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: [
    "pg",
    "@electric-sql/pglite",
    "@electric-sql/pglite-socket",
  ],
  async headers() {
    // Same normalisation as storage.ts; headers() is evaluated at build time, so an unset provider
    // allows no upload host. Set CV_STORAGE_PROVIDER=blob before every hosted build.
    const provider =
      process.env.CV_STORAGE_PROVIDER?.trim().toLowerCase() ?? "";
    const uploadHosts =
      provider === "s3"
        ? " https://*.s3.amazonaws.com https://*.s3.*.amazonaws.com https://s3.*.amazonaws.com"
        : provider === "blob" || provider === "vercel-blob"
          ? " https://vercel.com/api/blob/"
          : "";
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            // connect-src lists only the configured provider's upload hosts: the path-scoped Blob
            // API entry for blob, the S3 hosts only for the legacy s3 option, and none otherwise.
            value: `default-src 'self'; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'${uploadHosts}${process.env.NODE_ENV === "development" ? " ws://localhost:* ws://127.0.0.1:*" : ""}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'${process.env.NODE_ENV === "production" ? "; upgrade-insecure-requests" : ""}`,
          },
        ],
      },
    ];
  },
};
export default config;
