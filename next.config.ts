import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: [
    "pg",
    "@electric-sql/pglite",
    "@electric-sql/pglite-socket",
  ],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://*.s3.amazonaws.com https://*.s3.*.amazonaws.com https://s3.*.amazonaws.com${process.env.NODE_ENV === "development" ? " ws://localhost:* ws://127.0.0.1:*" : ""}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'${process.env.NODE_ENV === "production" ? "; upgrade-insecure-requests" : ""}`,
          },
        ],
      },
    ];
  },
};
export default config;
