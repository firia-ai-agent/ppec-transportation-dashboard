/**
 * Preview fail-safe for the single-DB directive (DECISION-LEDGER #43): PPEC has exactly ONE database
 * (Neon `main`), and preview deployments get production's DATABASE_URL. So on previews every DB session
 * is opened read-only in Postgres itself (`default_transaction_read_only=on` as a startup option, with
 * `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` as a belt-and-braces fallback for drivers or
 * proxies that drop the startup option). A write from a preview then fails in the server, not just in
 * app code. Pure module: no env reads of its own, no I/O, so it is unit-testable.
 */

/** Reason string shared by the build steps, the runtime pool and the skipped routes. */
export const READ_ONLY_REASON =
  "preview read-only: previews share the one production DB (single-DB directive, DECISION-LEDGER #43)";

/** Postgres startup parameter: every transaction in the session starts read-only. */
export const READ_ONLY_STARTUP_OPTIONS = "-c default_transaction_read_only=on";

/** Fallback for drivers without an `options` config: run once per connection. */
export const READ_ONLY_SESSION_SQL = "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY";

/** True when this environment must never write to the shared DB: Vercel previews. */
export function isReadOnlyDbEnv(env: Record<string, string | undefined>): boolean {
  return env.VERCEL_ENV === "preview";
}

/** Connection config fragment to spread into a pg/Neon Client or Pool config. Empty off previews. */
export function dbSessionOptions(env: Record<string, string | undefined>): { options?: string } {
  return isReadOnlyDbEnv(env) ? { options: READ_ONLY_STARTUP_OPTIONS } : {};
}

/** Body for a route that must not run on a preview, or null when the route may run. */
export function previewSkip(env: Record<string, string | undefined>): { skipped: string; reason: string } | null {
  return isReadOnlyDbEnv(env) ? { skipped: "preview read-only", reason: READ_ONLY_REASON } : null;
}
