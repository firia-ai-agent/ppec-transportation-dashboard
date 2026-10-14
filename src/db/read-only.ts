/**
 * Preview fail-safe for the single-DB directive (DECISION-LEDGER #43): PPEC has exactly ONE database
 * (Neon `main`), and preview deployments get production's DATABASE_URL.
 *
 * Read-only is enforced PER TRANSACTION, never per session. The pooled DATABASE_URL goes through
 * PgBouncer in transaction mode with one server pool per user+database, and previews and production
 * share that role, database and endpoint. Session-level state a preview sets (a `SET SESSION
 * CHARACTERISTICS ...`, or the `-c default_transaction_read_only=on` startup option) can therefore
 * outlive the preview's query on a server backend that production later borrows, making production
 * writes fail intermittently — and it does not reliably cover the preview's own later transactions
 * either, since the next one may land on a different backend. So previews open `BEGIN READ ONLY`
 * and set nothing: the mode lives and dies with one transaction, whichever backend runs it.
 *
 * Pure module: no env reads of its own, no I/O, so it is unit-testable. The plumbing that uses it
 * lives in src/db/pool.ts (autocommit queries + the drizzle pool view) and src/db/exec.ts (tx).
 */

/** Reason string shared by the build steps, the runtime pool and the skipped routes. */
export const READ_ONLY_REASON =
  "preview read-only: previews share the one production DB (single-DB directive, DECISION-LEDGER #43)";

/** How a transaction is opened on a preview. Transaction-scoped: nothing survives the COMMIT. */
export const BEGIN_READ_ONLY = "BEGIN READ ONLY";

/** A query as the pg/Neon drivers accept it: raw SQL, or a config object carrying the SQL in `text`. */
export type SqlLike = string | { text: string };

/** True when this environment must never write to the shared DB: Vercel previews. */
export function isReadOnlyDbEnv(env: Record<string, string | undefined>): boolean {
  return env.VERCEL_ENV === "preview";
}

/** The statement that opens a transaction in this environment. Plain `BEGIN` everywhere but previews. */
export function beginSql(env: Record<string, string | undefined>): string {
  return isReadOnlyDbEnv(env) ? BEGIN_READ_ONLY : "BEGIN";
}

/**
 * Rewrite a bare BEGIN to BEGIN READ ONLY; anything else passes through untouched. Used on the preview
 * side of the drizzle client, which opens its transactions by sending the text `"begin "` (drizzle builds
 * `begin <transaction config>` and the config is empty), hence the trim and the case-insensitive compare.
 * A BEGIN that already carries transaction modes is left alone: drizzle only produces one when the caller
 * asked for a specific mode, and we must not silently contradict it.
 */
export function rewriteBeginReadOnly<Q extends SqlLike>(q: Q): Q {
  const isBareBegin = (s: unknown) => typeof s === "string" && s.trim().toUpperCase() === "BEGIN";
  if (typeof q === "string") return (isBareBegin(q) ? BEGIN_READ_ONLY : q) as Q;
  const cfg = q as { text: string };
  return (isBareBegin(cfg.text) ? { ...cfg, text: BEGIN_READ_ONLY } : q) as Q;
}

/** Body for a route that must not run on a preview, or null when the route may run. */
export function previewSkip(env: Record<string, string | undefined>): { skipped: string; reason: string } | null {
  return isReadOnlyDbEnv(env) ? { skipped: "preview read-only", reason: READ_ONLY_REASON } : null;
}
