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

const STYLE_TS = path.resolve(import.meta.dirname, "..", "src", "components", "map", "style.ts");

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

  it("refuses a worker bundle that has imports one file cannot satisfy", () => {
    // Guards the upgrade that splits the worker into chunks: better a loud failure in the
    // build than a blank map pane nobody notices until a demo.
    expect(/^\s*import[\s{*'"]/m.test(readFileSync(MAP_WORKER_SOURCE, "utf8"))).toBe(false);
  });
});
