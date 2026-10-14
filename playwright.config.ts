import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser checks (`pnpm e2e`). One spec today: /map-preview loads, draws the map, and a
 * screenshot of it lands in artifacts/ for a design review.
 *
 * It starts the app itself, so there is nothing to remember before running it, and it builds
 * first rather than using `next dev`. That is not fussiness: under the dev server MapLibre's
 * tile worker fails to load, so the pane renders an empty canvas and the screenshot shows no
 * map at all. The production build is about twenty seconds and draws the real thing.
 *
 * The run touches no database. The route is behind staff sign-in now, so the server is started
 * with `E2E_DEMO_ROLE`, the test-only synthetic session in src/domain/access/map-view.ts: a
 * role and nothing else, no user, no password, and refused outright whenever `VERCEL_ENV` is
 * set — which it is on every deployment. No credential of any kind is written down here.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Kept out of src/ so vitest, which collects src/**/*.test.ts, never tries to run these.
  testMatch: /.*\.spec\.ts$/,
  outputDir: "./artifacts/playwright",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: BASE_URL,
    // The map pane is 40% of a wide board (SURF-01), so review it at a board-sized window.
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm next build && pnpm next start --port ${PORT} --hostname 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // ADR-015: the app refuses to boot on anything but synthetic data.
      APP_DATA_CLASS: "SYNTHETIC",
      // ADR-014: the demo switch, which the synthetic session also requires.
      DEMO_MODE: "1",
      // The role the browser check signs in as.
      E2E_DEMO_ROLE: process.env.E2E_DEMO_ROLE ?? "DIRECTOR",
      /*
       * Auth.js wants a secret in its module scope even on a route that never reads a
       * session. Generated per run and thrown away: there is no account to sign into here,
       * and nothing a token minted with it could reach.
       */
      AUTH_SECRET: process.env.AUTH_SECRET ?? randomBytes(32).toString("hex"),
      // The server runs on 127.0.0.1, which Auth.js will not trust unless told to. Says so
      // once here instead of logging UntrustedHost on every readiness probe.
      AUTH_TRUST_HOST: "true",
    },
  },
});
