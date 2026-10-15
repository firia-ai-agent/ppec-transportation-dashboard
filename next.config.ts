import type { NextConfig } from "next";
import { assertBootEnv } from "./src/lib/env";
import { copyMapWorker } from "./scripts/copy-maplibre-worker.mjs";

// Fail the build/boot closed if the data class is not SYNTHETIC (ADR-015).
assertBootEnv(process.env);

/*
 * Put MapLibre's tile worker in public/ before anything is built or served.
 *
 * It used to be a step in the `build` and `dev` npm scripts, which meant the map only worked
 * when the build happened to be started through one of those two scripts. Anything that calls
 * `next build` directly skips it — the hosting platform's own Next.js preset does, and so did
 * our Playwright config — and because the file is gitignored (it is half a megabyte of someone
 * else's minified JavaScript, kept in step with the lockfile rather than vendored) there is no
 * copy in the checkout to fall back on. The worker then 404s, MapLibre reports "Worker failed
 * to load", and the pane renders an empty canvas: no basemap, no routes, no trucks, and no
 * error on screen either, because the style fetch itself succeeded.
 *
 * next.config.ts is evaluated by every one of those entry points, so putting the copy here
 * makes the worker's presence a property of the build rather than of the command that started
 * it. It is a file copy out of node_modules: idempotent, and about a millisecond.
 */
copyMapWorker();

// `agentRules` writes an AGENTS.md into the repo root on every dev start and build. This
// project keeps its agent-facing docs in docs/, so the generated file is only noise.
/*
 * `experimental.authInterrupts` is what makes `forbidden()` work (src/auth/page-guard.ts). It is
 * the only supported way for a *page* to answer with a real 403 and still render a page of our
 * own: without it the role guard could only redirect or render a 200, and "denied" would be
 * indistinguishable from "fine" to anything but a human eye. The flag enables the `forbidden()`
 * / `unauthorized()` interrupts and their `forbidden.tsx` boundaries; it changes nothing else.
 */
const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  experimental: { authInterrupts: true },
};
export default nextConfig;
