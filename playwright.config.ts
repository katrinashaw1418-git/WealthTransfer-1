import { defineConfig } from "@playwright/test";

// Task #331 — Playwright config for the document-retention UI suite.
// Single chromium project; reuses the dev workflow's server on port 5000.
//
// JWT_SECRET is forced to the same fallback that server/auth.ts uses when
// the env var is unset ("amax-local-dev-only-secret"), so tokens minted
// inside the test process via signToken() validate against the running
// server's /api/auth/me. NODE_ENV/ALLOW_LOCAL_DEV_AUTH are also defaulted
// to keep server/auth.ts's module-init guard and the fixture-data guard
// happy when this config is loaded directly by the Playwright runner.

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "amax-local-dev-only-secret";
process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.ALLOW_LOCAL_DEV_AUTH =
  process.env.ALLOW_LOCAL_DEV_AUTH ?? "true";

const PORT = Number(process.env.PORT ?? 5000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      NODE_ENV: "development",
      ALLOW_LOCAL_DEV_AUTH: "true",
    },
  },
});
