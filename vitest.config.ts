import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 60000,
    exclude: ["node_modules/**", ".next/**", "tests/storage*.test.ts"],
    maxWorkers: 2,
  },
});
