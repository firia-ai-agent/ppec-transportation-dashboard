/**
 * Types for scripts/copy-maplibre-worker.mjs, so next.config.ts can import it under
 * `allowJs: false`. The script itself stays plain Node, because `pnpm dev` and `pnpm build`
 * still run it directly.
 */

/** File name of MapLibre's tile worker; part of the contract with `MAP_WORKER_URL`. */
export declare const MAP_WORKER_FILE: string;
/** Absolute path of the worker inside the installed `maplibre-gl`. */
export declare const MAP_WORKER_SOURCE: string;
/** Absolute path it is copied to, under `public/`. */
export declare const MAP_WORKER_DEST: string;
/** Copies the worker into `public/` and returns the destination path. */
export declare function copyMapWorker(): string;
