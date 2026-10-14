import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // The Playwright specs in e2e/ need a browser, not a vitest worker. `include` already
    // excludes them; this says so out loud, so a future `include` widening cannot pick
    // them up by accident.
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
    testTimeout: 30_000,
  },
});
