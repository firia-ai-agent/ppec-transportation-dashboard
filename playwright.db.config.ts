import { defineConfig, devices } from "@playwright/test";

/**
 * The Health tab against a throwaway local Postgres (e2e/db-server.ts).
 *
 * Kept off playwright.config.ts so `pnpm e2e` stays the run with no database. This one builds
 * the app, creates the database, and signs in as the seeded director and coordinator.
 */
const PORT = 3101;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /health-tab-data\.spec\.ts$/,
  outputDir: "./artifacts/playwright-db",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm next build && pnpm exec tsx e2e/db-server.ts",
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      E2E_PORT: String(PORT),
      APP_DATA_CLASS: "SYNTHETIC",
      DEMO_MODE: "1",
      AUTH_TRUST_HOST: "true",
    },
  },
});
