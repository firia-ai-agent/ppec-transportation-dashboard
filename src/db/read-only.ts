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
 * Thrown on a preview when a statement cannot be made read-only by rewriting it, so the only safe
 * answer is to refuse to send it. Carries the statement (SQL text only, never parameters) for the log.
 */
export class ReadOnlyRefusedError extends Error {
  constructor(public readonly statement: string) {
    super(`${READ_ONLY_REASON}: refused a statement that could escape the read-only transaction: ${statement}`);
    this.name = "ReadOnlyRefusedError";
  }
}

/** Opens a transaction: `BEGIN [TRANSACTION|WORK] [modes]` or `START TRANSACTION [modes]`. */
const TX_START = /^(?:BEGIN|START\s+TRANSACTION)\b/i;
/** `SET TRANSACTION ...` / `SET LOCAL TRANSACTION ...`: transaction-scoped, but can ask for READ WRITE. */
const SET_TX = /^SET\s+(?:LOCAL\s+|SESSION\s+)?TRANSACTION\b/i;
/** `SET SESSION CHARACTERISTICS AS TRANSACTION ...`: session state, which previews must never set at all. */
const SET_TX_CHARACTERISTICS = /^SET\s+SESSION\s+CHARACTERISTICS\b/i;
/** A `SET` of the read-only GUCs themselves (plain or `default_`-prefixed): the same escape, respelled. */
const SET_READ_ONLY_GUC = /^SET\b[\s\S]*transaction_read_only\b/i;
const READ_WRITE = /\bREAD\s+WRITE\b/i;
/** The isolation levels of `ISOLATION LEVEL ...`, as token runs. */
const ISOLATION_LEVELS = [["SERIALIZABLE"], ["REPEATABLE", "READ"], ["READ", "COMMITTED"], ["READ", "UNCOMMITTED"]];

/**
 * The statements of `sql`, for inspection only — comments and quoted text are blanked first so a `;`,
 * a `begin` or a `read write` inside either cannot be mistaken for SQL. Never sent anywhere.
 */
function statementsOf(sql: string): string[] {
  const bare = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
  return bare.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** True for a `SET` a preview must not send: it would drop READ ONLY, or outlive the transaction. */
function isRefusedSet(stmt: string): boolean {
  if (SET_TX_CHARACTERISTICS.test(stmt) || SET_READ_ONLY_GUC.test(stmt)) return true;
  return SET_TX.test(stmt) && READ_WRITE.test(stmt);
}

/**
 * The transaction modes of a BEGIN/START TRANSACTION, minus any access mode (`READ WRITE`/`READ ONLY`,
 * which the caller re-adds as READ ONLY). Isolation level and [NOT] DEFERRABLE are preserved as written.
 * Anything this does not recognise throws: an unparsed mode list must never be sent as-is on a preview.
 */
function transactionModes(tokens: string[], stmt: string): string[] {
  const at = (i: number) => (tokens[i] ?? "").toUpperCase();
  const modes: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    if (at(i) === ",") { i += 1; continue; }
    if (at(i) === "READ" && (at(i + 1) === "ONLY" || at(i + 1) === "WRITE")) { i += 2; continue; }
    if (at(i) === "DEFERRABLE") { modes.push("DEFERRABLE"); i += 1; continue; }
    if (at(i) === "NOT" && at(i + 1) === "DEFERRABLE") { modes.push("NOT DEFERRABLE"); i += 2; continue; }
    if (at(i) === "ISOLATION" && at(i + 1) === "LEVEL") {
      const level = ISOLATION_LEVELS.find((l) => l.every((w, k) => at(i + 2 + k) === w));
      if (!level) throw new ReadOnlyRefusedError(stmt);
      modes.push(`ISOLATION LEVEL ${level.join(" ")}`);
      i += 2 + level.length;
      continue;
    }
    throw new ReadOnlyRefusedError(stmt);
  }
  return modes;
}

/** Rewrite one BEGIN/START TRANSACTION so it opens READ ONLY, keeping its other modes. */
function readOnlyTxStart(stmt: string): string {
  const tokens = stmt.replace(/,/g, " , ").trim().split(/\s+/);
  const at = (i: number) => (tokens[i] ?? "").toUpperCase();
  const head = at(0) === "START" ? ["START", "TRANSACTION"]
    : ["TRANSACTION", "WORK"].includes(at(1)) ? ["BEGIN", at(1)]
    : ["BEGIN"];
  const modes = transactionModes(tokens.slice(head.length), stmt);
  return `${head.join(" ")} ${[...modes, "READ ONLY"].join(", ")}`;
}

/**
 * Force one statement to be read-only, for every preview path that sends SQL (src/db/pool.ts and, through
 * it, the drizzle client; src/db/exec.ts). Previews share the one production database (DECISION-LEDGER
 * #43), so a preview must never end up in a writable transaction, however the SQL is spelled:
 *   - a transaction start — `BEGIN`, `BEGIN TRANSACTION`/`WORK`, `START TRANSACTION`, in any case, with any
 *     padding, commas or comments — is rewritten with its access mode replaced by `READ ONLY`, keeping
 *     ISOLATION LEVEL and [NOT] DEFERRABLE. Drizzle sends a bare `begin ` by default and
 *     `begin isolation level ... read write` when a caller asked for a mode; both come back READ ONLY.
 *     A mode list this cannot parse is refused rather than passed through.
 *   - `SET TRANSACTION ... READ WRITE`, any `SET SESSION CHARACTERISTICS ...` and any `SET` of the
 *     read-only GUCs are refused: they either undo READ ONLY or leave session state that would leak onto
 *     a PgBouncer backend production later borrows.
 *   - a string holding more than one statement is refused outright. Rewriting cannot make it safe: an
 *     early `COMMIT` ends the read-only transaction and leaves the rest writing in autocommit, so
 *     `begin; insert ...` and `commit; insert ...` alike are errors. No app query is multi-statement.
 *   - everything else — reads, COMMIT/ROLLBACK, SAVEPOINT, and writes the server itself refuses inside
 *     the read-only transaction — is returned untouched, object identity included.
 */
export function rewriteBeginReadOnly<Q extends SqlLike>(q: Q): Q {
  const sql = typeof q === "string" ? q : (q as { text: string }).text;
  if (typeof sql !== "string") return q;
  const stmts = statementsOf(sql);
  if (stmts.length === 0) return q;
  if (stmts.length > 1) throw new ReadOnlyRefusedError(sql);
  const [stmt] = stmts;
  if (isRefusedSet(stmt)) throw new ReadOnlyRefusedError(sql);
  if (!TX_START.test(stmt)) return q;
  const rewritten = readOnlyTxStart(stmt);
  if (typeof q === "string") return rewritten as Q;
  return { ...(q as object), text: rewritten } as Q;
}

/** `rewriteBeginReadOnly` on previews; off previews the query is passed through exactly as given. */
export function rewriteBeginReadOnlyForEnv<Q extends SqlLike>(env: Record<string, string | undefined>, q: Q): Q {
  return isReadOnlyDbEnv(env) ? rewriteBeginReadOnly(q) : q;
}

/** Body for a route that must not run on a preview, or null when the route may run. */
export function previewSkip(env: Record<string, string | undefined>): { skipped: string; reason: string } | null {
  return isReadOnlyDbEnv(env) ? { skipped: "preview read-only", reason: READ_ONLY_REASON } : null;
}
