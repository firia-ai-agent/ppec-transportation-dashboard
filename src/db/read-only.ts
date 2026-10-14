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
 * Because the mode lives in the transaction, the transaction's own lifetime is part of the guard: the
 * guard opens it and the guard closes it (`readOnlyGuard` below), and a caller cannot do either. A
 * caller-sent `COMMIT` would otherwise end the READ ONLY transaction and leave everything after it
 * running writable in autocommit, against production.
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

/** The SQL text of a query, in whichever of the two forms the driver was handed. */
export function sqlText(q: SqlLike): string {
  return typeof q === "string" ? q : (q as { text: string }).text;
}

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
/**
 * Ends the current transaction, or hands it to two-phase commit: `COMMIT`, `END`, `ROLLBACK` and
 * `ABORT` — with or without the `WORK`/`TRANSACTION` noise word and with or without `AND [NO] CHAIN`
 * — plus `PREPARE TRANSACTION '...'`, `COMMIT PREPARED '...'` and `ROLLBACK PREPARED '...'`. All of
 * them start with one of these keywords, so the keyword alone is enough to catch every spelling; the
 * one form that begins this way and yet cannot end the transaction is excluded below.
 */
const TX_END = /^(?:COMMIT|END|ROLLBACK|ABORT|PREPARE\s+TRANSACTION)\b/i;
/**
 * `ROLLBACK [WORK|TRANSACTION] TO [SAVEPOINT] name`: it undoes work *inside* the transaction and
 * cannot end it, so a preview may send it (as may `SAVEPOINT name` and `RELEASE [SAVEPOINT] name`,
 * which do not start with a transaction-ending keyword at all). The match is anchored at both ends:
 * anything after the savepoint name falls back to the refusal above.
 */
const ROLLBACK_TO_SAVEPOINT =
  /^ROLLBACK(?:\s+(?:WORK|TRANSACTION))?\s+TO(?:\s+SAVEPOINT)?\s+(?:[A-Za-z_][\w$]*|"")$/i;
/** `SET TRANSACTION ...` / `SET LOCAL TRANSACTION ...`: transaction-scoped, but can ask for READ WRITE. */
const SET_TX = /^SET\s+(?:LOCAL\s+|SESSION\s+)?TRANSACTION\b/i;
/** `SET SESSION CHARACTERISTICS AS TRANSACTION ...`: session state, which previews must never set at all. */
const SET_TX_CHARACTERISTICS = /^SET\s+SESSION\s+CHARACTERISTICS\b/i;
/** A `SET` of the read-only GUCs themselves (plain or `default_`-prefixed): the same escape, respelled. */
const SET_READ_ONLY_GUC = /^SET\b[\s\S]*transaction_read_only\b/i;
/** And the same escape once more, as a `RESET`: back to the session default, which is read-write. */
const RESET_READ_ONLY_GUC = /^RESET\s+(?:ALL\b|(?:default_)?transaction_read_only\b)/i;
/** `DISCARD [ALL|...]`: throws away connection state wholesale, which a preview must never do. */
const DISCARD = /^DISCARD\b/i;
const READ_WRITE = /\bREAD\s+WRITE\b/i;
/** The isolation levels of `ISOLATION LEVEL ...`, as token runs. */
const ISOLATION_LEVELS = [["SERIALIZABLE"], ["REPEATABLE", "READ"], ["READ", "COMMITTED"], ["READ", "UNCOMMITTED"]];

/**
 * The characters Postgres allows in an identifier or a dollar-quote tag: a letter or `_` first, then
 * letters, digits or `_`. A tag must start with a non-digit, which is what tells `$tag$` from a `$1`
 * parameter placeholder.
 */
const isTagChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);
const isTagStart = (c: string | undefined) => c !== undefined && /[A-Za-z_]/.test(c);

/**
 * The index just past the quoted run whose first *inner* character is `from`. `q` is the delimiter and
 * doubles to escape itself (`''`, `""`); with `backslash` a `\x` pair is skipped as well, which is how
 * an `E'...'` string quotes its own delimiter. -1 when the run is never closed.
 */
function endOfQuoted(sql: string, from: number, q: string, backslash: boolean): number {
  for (let i = from; i < sql.length; ) {
    if (backslash && sql[i] === "\\") { i += 2; continue; }
    if (sql[i] !== q) { i += 1; continue; }
    if (sql[i + 1] === q) { i += 2; continue; } // '' / "" : an escaped delimiter, not the end
    return i + 1;
  }
  return -1;
}

/**
 * The dollar-quote tag opening at `i` — `$$` or `$tag$` — or null when that `$` is something else: a
 * `$1` parameter placeholder, or a lone `$` in an operator or identifier.
 */
function dollarTag(sql: string, i: number): string | null {
  if (sql[i] !== "$") return null;
  let j = i + 1;
  if (sql[j] !== "$") {
    if (!isTagStart(sql[j])) return null;
    while (isTagChar(sql[j])) j += 1;
    if (sql[j] !== "$") return null;
  }
  return sql.slice(i, j + 1);
}

/**
 * `sql` cut at its top-level `;`, for inspection only — never sent anywhere. ONE left-to-right pass,
 * because the lexical constructs below can hide each other and a pass that handled them in any fixed
 * order would be fooled by whichever it handled second: `SELECT '--'; COMMIT; INSERT …` hides a `--`
 * inside a string, `SELECT $$--$$; …` hides one inside a dollar quote, and `SELECT '/*'; … *` + `/`
 * hides a block-comment opener. Stripping comments before literals (as this once did) blanked the rest
 * of those strings and left a single harmless-looking statement, so the `COMMIT` that ends the
 * read-only transaction and the write after it both went to the server as one multi-statement string.
 *
 * In one pass, in Postgres' own precedence — whichever construct starts first wins — this handles:
 *   - `'...'` strings, where `''` is an escaped quote (a backslash is not an escape: modern Postgres
 *     has standard_conforming_strings on, so `'\'` is a complete string holding a backslash);
 *   - `E'...'`/`e'...'` strings, where both `''` and `\'` are escaped quotes;
 *   - `"..."` quoted identifiers, where `""` is an escaped quote;
 *   - `$$...$$` and `$tag$...$tag$` dollar quotes, which quote nothing at all inside themselves;
 *   - `--` line comments, to the next newline;
 *   - `/* ... *` + `/` block comments, which nest in Postgres and so nest here.
 * Each comment and each quoted run is replaced by neutral filler, so a `;`, a `begin`, a `commit` or a
 * `read write` written inside one cannot be read as SQL. An unterminated literal or comment means the
 * scan cannot know where the quoting ends, so it refuses: fail closed, never pass it through.
 *
 * The result is one entry per run between top-level semicolons, empties included (`pieces.length` is
 * therefore the semicolon count plus one), because where the semicolons are is itself part of the
 * guard: see `rewriteBeginReadOnly`.
 */
function scanPieces(sql: string): string[] {
  const refuse = (): never => { throw new ReadOnlyRefusedError(sql); };
  const pieces: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i + 2);
      cur += " ";
      i = nl === -1 ? sql.length : nl; // the newline itself stays: it is a separator, not comment text
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth += 1; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth -= 1; i += 2; }
        else i += 1;
      }
      if (depth > 0) refuse();
      cur += " ";
      continue;
    }
    if ((c === "E" || c === "e") && sql[i + 1] === "'" && !isTagChar(sql[i - 1])) {
      const end = endOfQuoted(sql, i + 2, "'", true);
      if (end === -1) refuse();
      cur += "''";
      i = end;
      continue;
    }
    const tag = dollarTag(sql, i);
    if (tag) {
      const close = sql.indexOf(tag, i + tag.length);
      if (close === -1) refuse();
      cur += "''";
      i = close + tag.length;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = endOfQuoted(sql, i + 1, c, false);
      if (end === -1) refuse();
      cur += c === "'" ? "''" : '""';
      i = end;
      continue;
    }
    if (c === ";") { pieces.push(cur); cur = ""; i += 1; continue; }
    cur += c;
    i += 1;
  }
  pieces.push(cur);
  return pieces;
}

/**
 * The statements of `sql`, for inspection only: `scanPieces` with the blank runs dropped. Refuses
 * (throws) the SQL it cannot scan, exactly as `scanPieces` does.
 */
function statementsOf(sql: string): string[] {
  return scanPieces(sql).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** True for a mode change a preview must not send: it would drop READ ONLY, or outlive the transaction. */
function isRefusedModeChange(stmt: string): boolean {
  if (SET_TX_CHARACTERISTICS.test(stmt) || SET_READ_ONLY_GUC.test(stmt)) return true;
  if (RESET_READ_ONLY_GUC.test(stmt) || DISCARD.test(stmt)) return true;
  return SET_TX.test(stmt) && READ_WRITE.test(stmt);
}

/** True for a statement that could end the transaction the guard is holding open. */
function isRefusedTxEnd(stmt: string): boolean {
  return TX_END.test(stmt) && !ROLLBACK_TO_SAVEPOINT.test(stmt);
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
 * True when `sql` is a single statement that opens a transaction. Comments and quoted text are ignored
 * (`scanPieces`), and SQL that cannot be scanned at all is refused rather than answered — the same
 * refusal `rewriteBeginReadOnly` raises for it a moment later on every path that asks this.
 */
export function isTransactionStart(sql: string): boolean {
  const stmts = statementsOf(sql);
  return stmts.length === 1 && TX_START.test(stmts[0]);
}

/** What the guard already knows about the connection a statement is headed for. */
export interface GuardState {
  /** True when a READ ONLY transaction the guard opened is already open on that connection. */
  inTransaction?: boolean;
}

/**
 * Force one statement to be read-only, for every preview path that sends SQL (src/db/pool.ts and, through
 * it, the drizzle client; src/db/exec.ts). Previews share the one production database (DECISION-LEDGER
 * #43), so a preview must never end up in a writable transaction, however the SQL is spelled:
 *   - a transaction start — `BEGIN`, `BEGIN TRANSACTION`/`WORK`, `START TRANSACTION`, in any case, with any
 *     padding, commas or comments — is rewritten with its access mode replaced by `READ ONLY`, keeping
 *     ISOLATION LEVEL and [NOT] DEFERRABLE. Drizzle sends a bare `begin ` by default and
 *     `begin isolation level ... read write` when a caller asked for a mode; both come back READ ONLY.
 *     A mode list this cannot parse is refused rather than passed through. With `inTransaction` the
 *     start is refused outright: a second BEGIN inside an open transaction is at best ignored with a
 *     warning and at worst a re-negotiation of the modes that are the only thing guarding the DB.
 *   - every transaction-ending statement is refused: `COMMIT`, `ROLLBACK`, `END`, `ABORT` in any case or
 *     spacing, with `WORK`/`TRANSACTION` and with `AND [NO] CHAIN`, plus `PREPARE TRANSACTION '...'`,
 *     `COMMIT PREPARED '...'` and `ROLLBACK PREPARED '...'`. Ending the transaction removes READ ONLY,
 *     which is the whole guard, and leaves whatever the caller sends next running writable in
 *     autocommit. `SAVEPOINT`, `RELEASE [SAVEPOINT]` and `ROLLBACK TO [SAVEPOINT]` stay allowed:
 *     they work inside the transaction and cannot end it. The COMMIT/ROLLBACK that really do close a
 *     preview transaction are the guard's own (`readOnlyGuard`), which never pass through here.
 *   - `SET TRANSACTION ... READ WRITE`, any `SET SESSION CHARACTERISTICS ...`, any `SET`/`RESET` of the
 *     read-only GUCs and any `DISCARD` are refused: they either undo READ ONLY or leave connection state
 *     that would leak onto a PgBouncer backend production later borrows.
 *   - a string holding more than one statement is refused outright. Rewriting cannot make it safe: an
 *     early `COMMIT` ends the read-only transaction and leaves the rest writing in autocommit, so
 *     `begin; insert ...` and `commit; insert ...` alike are errors. No app query is multi-statement.
 *     Concretely: every `;` outside a literal or a comment is refused, except one trailing `;`
 *     followed by nothing but whitespace and comments. Where the literals and comments are is decided
 *     by `scanPieces`, one left-to-right pass, so a `;` hidden in `'--'`, `$$--$$`, `E'\'--'`, `"--"`
 *     or `'/*'` is not a statement separator and a `;` after them still is.
 *   - SQL that cannot be scanned at all — an unterminated string, identifier, dollar quote or block
 *     comment — is refused: where the quoting ends is exactly what decides everything above.
 *   - everything else — reads, SAVEPOINT, and writes the server itself refuses inside the read-only
 *     transaction — is returned untouched, object identity included.
 */
export function rewriteBeginReadOnly<Q extends SqlLike>(q: Q, state: GuardState = {}): Q {
  const sql = typeof q === "string" ? q : (q as { text: string }).text;
  if (typeof sql !== "string") return q;
  const pieces = scanPieces(sql);
  // Exactly one statement may ever reach the server. Any `;` outside a literal or a comment, bar a
  // single trailing one with nothing but whitespace and comments after it, introduces a second
  // statement — and the first of two could be the `COMMIT` that ends the read-only transaction, which
  // would leave the second writing in autocommit. No app query is multi-statement, so refuse.
  if (pieces.length > 2 || (pieces.length === 2 && pieces[1].trim() !== "")) {
    throw new ReadOnlyRefusedError(sql);
  }
  const stmts = pieces.map((s) => s.trim()).filter((s) => s.length > 0);
  if (stmts.length === 0) return q;
  const [stmt] = stmts;
  if (isRefusedModeChange(stmt) || isRefusedTxEnd(stmt)) throw new ReadOnlyRefusedError(sql);
  if (!TX_START.test(stmt)) return q;
  if (state.inTransaction) throw new ReadOnlyRefusedError(sql);
  const rewritten = readOnlyTxStart(stmt);
  if (typeof q === "string") return rewritten as Q;
  return { ...(q as object), text: rewritten } as Q;
}

/** `rewriteBeginReadOnly` on previews; off previews the query is passed through exactly as given. */
export function rewriteBeginReadOnlyForEnv<Q extends SqlLike>(
  env: Record<string, string | undefined>, q: Q, state: GuardState = {},
): Q {
  return isReadOnlyDbEnv(env) ? rewriteBeginReadOnly(q, state) : q;
}

/** Puts SQL on the wire with nothing in front of it: one client's own `query`. Never handed to a caller. */
export type RawQuery = (sql: SqlLike, params?: unknown[]) => Promise<{ rows: unknown[] }>;

/**
 * One connection's transaction framing, deliberately split in two.
 *
 * `query` is the only half a caller ever receives. `begin`/`commit`/`rollback` belong to the plumbing
 * that built the guard and cannot be reached by sending SQL through `query`. That split is what makes a
 * caller-sent COMMIT refusable at all: the guard never has to recognise its own COMMIT in the statement
 * stream, because its own COMMIT does not travel in that stream.
 */
export interface TxGuard {
  /** The caller-facing path. On previews: rewrite what can be made read-only, refuse what cannot. */
  query: RawQuery;
  /** Open this connection's transaction. The guard's own statement, not a caller's. */
  begin(): Promise<void>;
  /** Close it. A no-op on previews once it is already closed. */
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** True while a transaction this guard opened is still open (previews only; always false otherwise). */
  readonly open: boolean;
}

/**
 * Off previews: no guard at all. Every statement, the framing included, is exactly what the plumbing
 * and the caller asked for — production behaviour is untouched by any of this.
 */
export function passThroughGuard(send: RawQuery): TxGuard {
  return {
    query: send,
    open: false,
    async begin() { await send("BEGIN"); },
    async commit() { await send("COMMIT"); },
    async rollback() { await send("ROLLBACK"); },
  };
}

/**
 * On previews: the guard owns the transaction on this connection, start to finish.
 *
 * Callers reach `query` only, which refuses every statement that could end or re-negotiate the
 * transaction (see `rewriteBeginReadOnly`) — nothing is sent, so the READ ONLY transaction is still
 * open afterwards and the next write is still refused by Postgres. A statement that arrives while no
 * transaction is open gets one of its own (`BEGIN READ ONLY … COMMIT`), so no preview statement can
 * ever run in autocommit, where it would be writable against the production database.
 *
 * A transaction start from the caller is the one statement that opens the guard's transaction: it is
 * sent as its rewritten READ ONLY self, so a caller (drizzle, in practice) still gets the isolation
 * level it asked for. Its matching COMMIT is refused like any other, and the plumbing that built the
 * guard closes the transaction instead — in src/db/pool.ts, when the client is released.
 */
export function readOnlyGuard(send: RawQuery): TxGuard {
  let open = false;
  const end = async (how: "COMMIT" | "ROLLBACK") => {
    if (!open) return;
    open = false; // Before the await: the transaction is over even if the COMMIT itself reports an error.
    await send(how);
  };
  /** One statement in a transaction of its own, for when the guard is holding none open. */
  const alone = async (q: SqlLike, params?: unknown[]) => {
    await send(BEGIN_READ_ONLY);
    open = true;
    try {
      const r = await send(q, params);
      await end("COMMIT");
      return r;
    } catch (e) {
      await end("ROLLBACK").catch(() => {});
      throw e;
    }
  };
  return {
    get open() { return open; },
    async begin() { await send(BEGIN_READ_ONLY); open = true; },
    commit: () => end("COMMIT"),
    rollback: () => end("ROLLBACK"),
    // Not `async`: a refusal throws synchronously, before anything can be sent or awaited.
    query(q, params) {
      const start = isTransactionStart(sqlText(q));
      const rewritten = rewriteBeginReadOnly(q, { inTransaction: open });
      if (start) return send(rewritten, params).then((r) => { open = true; return r; });
      return open ? send(rewritten, params) : alone(rewritten, params);
    },
  };
}

/** The guard for one connection in this environment: read-only on previews, pass-through elsewhere. */
export function txGuardForEnv(env: Record<string, string | undefined>, send: RawQuery): TxGuard {
  return isReadOnlyDbEnv(env) ? readOnlyGuard(send) : passThroughGuard(send);
}

/** Body for a route that must not run on a preview, or null when the route may run. */
export function previewSkip(env: Record<string, string | undefined>): { skipped: string; reason: string } | null {
  return isReadOnlyDbEnv(env) ? { skipped: "preview read-only", reason: READ_ONLY_REASON } : null;
}
