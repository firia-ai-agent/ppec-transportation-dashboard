import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser checks (`pnpm e2e`). Three specs: the Today board and its drawer, the map preview,
 * and the screen set a design review reads at both review widths. Every screenshot they take
 * lands in artifacts/ (gitignored) — `pnpm e2e` is the command that regenerates the whole set,
 * and README "Browser check" lists what it writes.
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
  // The seeded-database spec starts its own throwaway Postgres (playwright.db.config.ts).
  testIgnore: /health-tab-data\.spec\.ts$/,
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
       * Opens the board's date override (`dateOverrideAllowed` in src/domain/board/day.ts), so
       * the AT-10 and AT-13 checks can read the finished day. Gated the same way as the session
       * above and refused outright whenever `VERCEL_ENV` is set, so no deployment has it: the
       * console has no date switcher, and `?date=` is read here and nowhere else.
       */
      E2E_DATE_OVERRIDE: "1",
      /*
       * Auth.js wants a secret in its module scope even on a route that never reads a
       * session. Generated per run and thrown away: there is no account to sign into here,
       * and nothing a token minted with it could reach.
       */
      AUTH_SECRET: process.env.AUTH_SECRET ?? randomBytes(32).toString("hex"),
      // The server runs on 127.0.0.1, which Auth.js will not trust unless told to. Says so
      // once here instead of logging UntrustedHost on every readiness probe.
      AUTH_TRUST_HOST: "true",
      /*
       * Passed through, with no default, so that a run can choose which of the two states the
       * Family texts screen is in — and the default (neither set) is the one where no model can
       * be reached, which is the state every other spec already expects.
       *
       * `modelReach()` is a pure environment read: with `AGENT_DEMO_DATA_ONLY=true` and a
       * non-empty key it answers "a model would answer", which is what makes the proposal card
       * render (Firia's gate 5 — no model, no card). Nothing in a browser check drives a turn, so
       * no call is made and no key is needed; a placeholder is enough, and none is written here.
       */
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "",
      AGENT_DEMO_DATA_ONLY: process.env.AGENT_DEMO_DATA_ONLY ?? "",
    },
  },
});
