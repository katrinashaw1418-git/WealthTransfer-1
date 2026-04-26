import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "shared/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    // Test files share the dev Postgres database (creating platform-side
    // accounts, seeding users, etc.). The vitest option that actually
    // serializes file execution is `fileParallelism`, NOT `fileParallel` —
    // the latter is silently ignored, which previously let two files race
    // on `accounts_user_currency_type_uidx` when they both tried to create
    // the platform suspense account for the same currency. See Task #51.
    fileParallelism: false,
  },
});
