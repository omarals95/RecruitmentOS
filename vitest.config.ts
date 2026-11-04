import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 60000,
    exclude: [
      "node_modules/**",
      ".next/**",
      "tmp/**",
      "tests/storage*.test.ts",
    ],
    maxWorkers: 2,
    // Fictional test-only signing key; tests that need it unset stub it away.
    env: {
      TENANT_CONTEXT_SIGNING_KEY:
        "FictionalTenantContextTestKeyOnly0123456789A",
    },
  },
});
