/**
 * Put MapLibre's tile worker where the browser can fetch it.
 *
 * MapLibre spawns a web worker to decode vector tiles, and with no `config.WORKER_URL` it
 * derives the worker's URL from `import.meta.url` of its own bundle. Under Next's bundler
 * that resolves to a chunk path with no sibling worker file, so the worker 404s, the map
 * reports "Worker failed to load", and the pane renders an empty canvas — the basemap, the
 * routes and the trucks all silently absent.
 *
 * So the worker is copied out of the installed package into public/ and
 * src/components/map/style.ts points `config.WORKER_URL` at it. Copied rather than committed:
 * a vendored half-megabyte of someone else's minified JavaScript goes stale the first time
 * maplibre-gl is upgraded, and this way the file in public/ is always the one the lockfile
 * pins. The copy is gitignored and `pnpm dev` / `pnpm build` run this first.
 *
 * The worker bundle has no imports of its own (asserted below), so one file is the whole job.
 */
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The file name is part of the contract with style.ts; keep the two in step. */
export const MAP_WORKER_FILE = "maplibre-gl-worker.mjs";
export const MAP_WORKER_SOURCE = require.resolve(`maplibre-gl/dist/${MAP_WORKER_FILE}`);
export const MAP_WORKER_DEST = path.join(ROOT, "public", MAP_WORKER_FILE);

export function copyMapWorker() {
  const source = readFileSync(MAP_WORKER_SOURCE, "utf8");
  // A worker loaded as a classic script cannot resolve a bare or relative import, and the
  // fallback path in maplibre does exactly that. If a future version splits the bundle, this
  // fails loudly here instead of producing a blank map in a browser.
  if (/^\s*import[\s{*'"]/m.test(source)) {
    throw new Error(`${MAP_WORKER_FILE} now has imports of its own; copy its chunks too`);
  }
  mkdirSync(path.dirname(MAP_WORKER_DEST), { recursive: true });
  copyFileSync(MAP_WORKER_SOURCE, MAP_WORKER_DEST);
  return MAP_WORKER_DEST;
}

// `node scripts/copy-maplibre-worker.mjs`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  copyMapWorker();
}
