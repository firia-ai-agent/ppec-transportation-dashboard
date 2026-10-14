/**
 * The MapLibre worker copy (scripts/copy-maplibre-worker.mjs).
 *
 * Without it the map pane draws an empty canvas in a browser and every unit test still
 * passes, because the failure is in the bundler's idea of where a worker lives. So the
 * contract gets asserted here: the file that lands in public/ is byte-for-byte the one the
 * lockfile pins, and its name is the one src/components/map/style.ts points the map at.
 */
import { readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  copyMapWorker,
  MAP_WORKER_DEST,
  MAP_WORKER_FILE,
  MAP_WORKER_SOURCE,
} from "./copy-maplibre-worker.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STYLE_TS = path.resolve(ROOT, "src", "components", "map", "style.ts");

describe("copyMapWorker", () => {
  it("copies the installed worker into public/, byte for byte", () => {
    rmSync(MAP_WORKER_DEST, { force: true });
    const written = copyMapWorker();
    expect(written).toBe(MAP_WORKER_DEST);
    expect(statSync(MAP_WORKER_DEST).isFile()).toBe(true);
    expect(readFileSync(MAP_WORKER_DEST)).toEqual(readFileSync(MAP_WORKER_SOURCE));
  });

  it("is idempotent, so running it before every dev start and build is free", () => {
    copyMapWorker();
    const once = readFileSync(MAP_WORKER_DEST);
    copyMapWorker();
    expect(readFileSync(MAP_WORKER_DEST)).toEqual(once);
  });

  it("takes the worker from the installed maplibre-gl, not from a copy of our own", () => {
    expect(MAP_WORKER_SOURCE).toContain(path.join("node_modules", "maplibre-gl", "dist"));
    expect(path.basename(MAP_WORKER_SOURCE)).toBe(MAP_WORKER_FILE);
  });

  it("serves it at the path the map is told to fetch", () => {
    // One contract, two files: the name here and `MAP_WORKER_URL` there.
    expect(readFileSync(STYLE_TS, "utf8")).toContain(`export const MAP_WORKER_URL = "/${MAP_WORKER_FILE}"`);
    expect(MAP_WORKER_DEST.endsWith(path.join("public", MAP_WORKER_FILE))).toBe(true);
  });

  it("is run by the build itself, not by the npm script that happens to start it", () => {
    /*
     * The blank map. The copy used to live only in the `build` and `dev` npm scripts, so the
     * worker landed in public/ only when the build was started through one of those two —
     * and the hosting platform's Next.js preset calls `next build` directly, as did our own
     * Playwright config. The file is gitignored, so there was no copy in the checkout to fall
     * back on: the worker 404'd, MapLibre reported "Worker failed to load", and the pane drew
     * an empty canvas with no error on it, because the style fetch had succeeded.
     *
     * next.config.ts is evaluated by every entry point there is, so that is where the copy
     * belongs. This asserts it is still called from there, and that it is called at module
     * scope rather than inside a config hook that a given command might not reach.
     */
    const config = readFileSync(path.resolve(ROOT, "next.config.ts"), "utf8");
    expect(config).toMatch(/from "\.\/scripts\/copy-maplibre-worker\.mjs"/);
    expect(config).toMatch(/^copyMapWorker\(\);$/m);
  });

  it("refuses a worker bundle that has imports one file cannot satisfy", () => {
    // Guards the upgrade that splits the worker into chunks: better a loud failure in the
    // build than a blank map pane nobody notices until a demo.
    expect(/^\s*import[\s{*'"]/m.test(readFileSync(MAP_WORKER_SOURCE, "utf8"))).toBe(false);
  });
});
