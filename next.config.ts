import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { NextConfig } from "next";
import { resolveBuildInfo } from "./src/lib/build-info";

/** The installed folders of a package and its runtime dependencies, nested installs included. */
function installedPackages(name: string, from: string, found: Set<string>) {
  for (let dir = from; ; dir = dirname(dir)) {
    const folder = join(dir, "node_modules", name);
    if (existsSync(join(folder, "package.json"))) {
      if (found.has(folder)) return found;
      found.add(folder);
      const { dependencies = {} } = JSON.parse(
        readFileSync(join(folder, "package.json"), "utf8"),
      );
      for (const dependency of Object.keys(dependencies))
        installedPackages(dependency, folder, found);
      return found;
    }
    if (dirname(dir) === dir) throw new Error(`${name} is not installed.`);
  }
}
// The CV text worker (src/lib/cv-text-worker.mjs) runs unbundled from the project root, so the
// MCP function's trace gets it and its two parsers, which no bundled code imports, by name.
const cvTextFiles = [
  "src/lib/cv-text-worker.mjs",
  ...[
    ...["unpdf", "mammoth"].reduce(
      (found, name) => installedPackages(name, process.cwd(), found),
      new Set<string>(),
    ),
  ].map(
    (folder) => `${relative(process.cwd(), folder).replaceAll("\\", "/")}/**/*`,
  ),
];

// next build evaluates this file in its build workers too; they inherit the first evaluation's
// time through the environment, so every page and route of one build shows one build number.
process.env.APP_BUILT_AT ??= new Date().toISOString();
const buildInfo = resolveBuildInfo(
  process.env,
  process.cwd(),
  new Date(process.env.APP_BUILT_AT),
);

const config: NextConfig = {
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: buildInfo.version,
    NEXT_PUBLIC_APP_BUILD: buildInfo.build,
    NEXT_PUBLIC_APP_COMMIT: buildInfo.commit,
    NEXT_PUBLIC_APP_ENVIRONMENT: buildInfo.environment,
    NEXT_PUBLIC_APP_BUILT_AT: buildInfo.builtAt,
  },
  serverExternalPackages: [
    "pg",
    "@electric-sql/pglite",
    "@electric-sql/pglite-socket",
  ],
  outputFileTracingIncludes: { "/api/mcp": cvTextFiles },
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
      {
        source: "/api/:path*",
        headers: [{ key: "X-App-Version", value: buildInfo.version }],
      },
    ];
  },
};
export default config;
