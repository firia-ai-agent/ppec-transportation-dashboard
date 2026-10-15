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

/**
 * Every character this file reads as a gap between two tokens, as a regex class body: JS' own `\s`
 * — the server's ASCII whitespace plus most of {@link UNICODE_SPACE} — and the five UNICODE_SPACE
 * characters JS does not call whitespace at all: NEXT LINE (U+0085) and the zero-width four
 * (U+200B, U+200C, U+200D, U+2060). Written once and shared, so the multi-token keywords below
 * (`START TRANSACTION`, `PREPARE TRANSACTION`) and {@link trimSql} agree about where a token may
 * end: `START\u200BTRANSACTION` opens a transaction to everything above the server exactly as
 * `START\u00A0TRANSACTION` does, and a gap spelled `\s` would have matched only the second one.
 */
const GAP = String.raw`[\s\u0085\u200b-\u200d\u2060]`;
/** Leading and trailing {@link GAP} runs: what {@link trimSql} strips. */
const TRIM = new RegExp(`^${GAP}+|${GAP}+$`, "g");
/**
 * `stmt` without its leading and trailing gaps. Every keyword check in this file trims through this
 * helper rather than JS' `.trim()`, on every path — `statementsOf` for {@link isTransactionStart},
 * and {@link rewriteBeginReadOnly} for the string, the `{text}` and the `inTransaction` cases alike
 * — so all of them decide about the same statement.
 *
 * `.trim()` strips JS whitespace, which is most of {@link UNICODE_SPACE} but not all of it: not NEXT
 * LINE, and not the zero-width four, since none of those is whitespace to JS or to Unicode. Every
 * keyword regex here is anchored at `^` — `CALL`, `COMMIT`, `SET`, `BEGIN`, `DO`, `DISCARD`, the
 * allowlists — so one invisible character in front of a statement made every one of them miss, and
 * `\u200BCALL p()` went to the server unexamined while whatever strips or space-replaces that
 * character on the way (a console, a paste out of rendered HTML, a sanitiser) hands the server a
 * plain `CALL p()`.
 *
 * Trimming such a character is safe in a way that reading one as a gap *inside* a statement is not:
 * what the trim removes is only ever inspected, never sent, and dropping it can only make the guard
 * see MORE of a keyword — it refuses where it used to pass. Interior gaps go the other way, and are
 * refused rather than normalised: see {@link onlyPgSpace} and {@link readOnlyTxStart}.
 */
const trimSql = (stmt: string) => stmt.replace(TRIM, "");

/**
 * Opens a transaction: `BEGIN [TRANSACTION|WORK] [modes]` or `START TRANSACTION [modes]`. The gap
 * between `START` and `TRANSACTION` is {@link GAP} rather than `\s`, so `START\u200BTRANSACTION`
 * is recognised as the transaction start it is to everything but the server's own lexer — and then
 * refused by {@link readOnlyTxStart}, instead of being passed through unexamined.
 */
const TX_START = new RegExp(String.raw`^(?:BEGIN|START${GAP}+TRANSACTION)\b`, "i");
/**
 * Ends the current transaction, or hands it to two-phase commit: `COMMIT`, `END`, `ROLLBACK` and
 * `ABORT` — with or without the `WORK`/`TRANSACTION` noise word and with or without `AND [NO] CHAIN`
 * — plus `PREPARE TRANSACTION '...'`, `COMMIT PREPARED '...'` and `ROLLBACK PREPARED '...'`. All of
 * them start with one of these keywords, so the keyword alone is enough to catch every spelling; the
 * one form that begins this way and yet cannot end the transaction is excluded below. `PREPARE` is
 * held to its `TRANSACTION` by {@link GAP}, so `PREPARE\u200BTRANSACTION 'x'` is caught like the
 * `PREPARE\u00A0TRANSACTION 'x'` spelling beside it; the rest end at a regex `\b`, which every one of
 * these characters is already.
 */
const TX_END = new RegExp(String.raw`^(?:COMMIT|END|ROLLBACK|ABORT|PREPARE${GAP}+TRANSACTION)\b`, "i");
/**
 * `ROLLBACK [WORK|TRANSACTION] TO [SAVEPOINT] name`: it undoes work *inside* the transaction and
 * cannot end it, so a preview may send it (as may `SAVEPOINT name` and `RELEASE [SAVEPOINT] name`,
 * which do not start with a transaction-ending keyword at all). The match is anchored at both ends:
 * anything after the savepoint name falls back to the refusal above. A quoted savepoint name arrives
 * here as the word characters `scanPieces` kept of it, still inside its quotes.
 */
const ROLLBACK_TO_SAVEPOINT =
  /^ROLLBACK(?:\s+(?:WORK|TRANSACTION))?\s+TO(?:\s+SAVEPOINT)?\s+(?:[A-Za-z_][\w$]*|"[A-Za-z0-9_]*")$/i;
/**
 * Any `SET` or `RESET`, in any of its spellings: `SET x = y`, `SET SESSION x TO y`, `SET LOCAL x`,
 * `SET TRANSACTION …`, `SET SESSION CHARACTERISTICS AS TRANSACTION …`, `SET ROLE`, `RESET x`,
 * `RESET ALL`. Previews refuse all of them bar the narrow `SET LOCAL` allowlist below, because
 * changing GUCs is not only a way to drop READ ONLY (`transaction_read_only`,
 * `default_transaction_read_only`, `SET TRANSACTION READ WRITE`) — it is also a way to change how
 * the SQL that follows is *lexed*, and the lexing is what every other rule in this file rests on.
 * `SET standard_conforming_strings = off` makes `'\''` one string where this scanner reads two, so
 * `SELECT '\''; COMMIT; INSERT …; -- '` then reaches the server as three statements while the guard
 * sees one. A session `SET` would also outlive the statement on a PgBouncer backend production later
 * borrows, which DECISION-LEDGER #43 forbids on its own.
 */
const SET_OR_RESET = /^(?:SET|RESET)\b/i;
/**
 * The only GUC changes a preview may make: `SET LOCAL <name> = <value>` for one of these timeouts.
 * They are transaction-scoped (so nothing can leak onto a shared backend), they cannot affect lexing
 * or the access mode, and they are the ones an operator would reach for on a slow preview query.
 * `search_path` is deliberately NOT here: every query in this app names its schema (`ops.`,
 * `identity.`), so nothing needs it. The whole statement is matched, value included: an unrecognised
 * tail — another GUC, a function call, anything — falls through to the refusal.
 */
const SET_LOCAL_ALLOWED =
  /^SET\s+LOCAL\s+(?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout)(?:\s*=\s*|\s+TO\s+)(?:DEFAULT|''|[A-Za-z0-9_.+-]+)\s*$/i;
/**
 * `set_config(name, value, is_local)` — the function spelling of `SET`, which can appear anywhere an
 * expression can: `SELECT set_config('standard_conforming_strings','off',false)`,
 * `SELECT pg_catalog.set_config(…)`, `… FROM set_config(…)`. Matched anywhere in the statement, but
 * only outside literals and comments (`scanPieces` has already blanked those). The quoted spelling
 * `pg_catalog."set_config"(…)` calls the same function, which is why `scanPieces` keeps the *word*
 * characters of a quoted identifier instead of blanking it, and why this allows for a closing `"`
 * between the name and its `(`.
 */
const SET_CONFIG = /\bset_config"?\s*\(/i;
/**
 * `DO $$ … $$`: an anonymous code block. Its body is a literal to the lexer, so nothing in this file
 * can see what it does — and a plpgsql body can `PERFORM set_config(…)`, i.e. reach exactly the
 * escape above from inside a string this scanner must treat as opaque. No app query is a DO block.
 */
const DO_BLOCK = /^DO\b/i;
/** `DISCARD [ALL|...]`: throws away connection state wholesale, which a preview must never do. */
const DISCARD = /^DISCARD\b/i;
/**
 * `CALL proc(...)`: invokes a procedure — the one callable thing in Postgres that may run transaction
 * control of its own. A PL/pgSQL procedure body can `COMMIT` or `ROLLBACK`, which ends the READ ONLY
 * transaction the guard is holding and leaves everything after it writable in autocommit, and it can
 * `PERFORM set_config(...)` to change how the SQL after it is lexed. The body is not in the statement
 * text at all, so nothing in this file can see what it does — the same blind spot as `DO_BLOCK`, with
 * transaction control added. So a preview refuses `CALL` outright, exactly as it refuses `COMMIT`. No
 * app query is a `CALL`.
 *
 * `CALL` is always the statement's first token, so the first token is all this looks at, and that
 * covers every spelling of the rest: a schema-qualified or quoted procedure name, any arguments, any
 * padding or newlines. Case is free, and `scanPieces` has already turned leading and interleaved
 * comments into whitespace, so `CALL` prefixed by a block comment, `cAlL` with a comment glued between
 * it and the name, and `CALL` split from its name by a newline all arrive here as `CALL <name>(...)`.
 * The token has to END there too, by {@link endsKeyword}: `callback` and `call$a$` are single
 * identifiers that merely begin with those letters, so `SELECT 1 AS callback` still runs, as does a
 * `"call"` column — a quoted identifier keeps its quotes through `scanPieces` and so can never be
 * read as this keyword. A {@link UNICODE_SPACE} character ends it as well, even though Postgres
 * reads that one as identifier text: `CALL\u00A0p()`, `CALL\u2003p()` and `call\u3000ops.p()` are a
 * `CALL` to every eye but the server's lexer, and the guard refuses on either reading. The
 * zero-width members of that set do the same job while showing nothing at all: `CALL\u200Bp()` and
 * `call\u2060ops.p()` are refused too.
 */
const CALL = /^CALL/i;
/** The isolation levels of `ISOLATION LEVEL ...`, as token runs. */
const ISOLATION_LEVELS = [["SERIALIZABLE"], ["REPEATABLE", "READ"], ["READ", "COMMITTED"], ["READ", "UNCOMMITTED"]];

/**
 * The character classes of Postgres' own lexer (src/backend/parser/scan.l), which this scanner has to
 * agree with exactly — where it is more generous than the lexer, text the server reads as SQL gets
 * read here as quoted data, and a `;` hides in the gap.
 *
 * `ident_start [A-Za-z\200-\377_]`, `ident_cont [A-Za-z\200-\377_0-9\$]`: an identifier may *contain*
 * `$`, which is why `x$a$` is one identifier to the server and not `x` followed by a dollar quote
 * (see `dollarTag`). `\200-\377` is every non-ASCII byte, so in a UTF-8 source every non-ASCII
 * character — accented letters, non-Latin scripts — is an identifier character too.
 *
 * `dolq_start [A-Za-z\200-\377_]`, `dolq_cont [A-Za-z\200-\377_0-9]`: a dollar-quote tag is the same
 * minus `$` (the `$` is the delimiter). A tag must start with a non-digit, which is what tells
 * `$tag$` from a `$1` parameter placeholder.
 */
const isNonAscii = (c: string) => c.charCodeAt(0) >= 0x80;
const isTagChar = (c: string | undefined) => c !== undefined && (/[A-Za-z0-9_]/.test(c) || isNonAscii(c));
const isTagStart = (c: string | undefined) => c !== undefined && (/[A-Za-z_]/.test(c) || isNonAscii(c));
/** `ident_cont`: a character that continues an identifier, so a token cannot start at it. */
const isIdentCont = (c: string | undefined) => c !== undefined && (isTagChar(c) || c === "$");

/**
 * Every character that is a space to Unicode, to a human and to the drivers, but NOT to Postgres'
 * lexer: NBSP (U+00A0), OGHAM SPACE MARK (U+1680), the U+2000–U+200A family (en space, em space,
 * thin space, hair space …), LINE and PARAGRAPH SEPARATOR (U+2028, U+2029), NARROW NO-BREAK SPACE
 * (U+202F), MEDIUM MATHEMATICAL SPACE (U+205F), IDEOGRAPHIC SPACE (U+3000) and the BOM / ZERO WIDTH
 * NO-BREAK SPACE (U+FEFF) — i.e. all of JS' own `\s` but the plain ASCII space, tab, newline and
 * carriage return — plus NEXT LINE (U+0085), whitespace to Unicode though not to JS, and `\v` and
 * `\f`, which are ASCII but which not every Postgres `space` class has included.
 *
 * And four that are zero-width rather than space-shaped: ZERO WIDTH SPACE (U+200B), ZERO WIDTH
 * NON-JOINER (U+200C), ZERO WIDTH JOINER (U+200D) and WORD JOINER (U+2060). These are format
 * characters (Unicode `Cf`, default-ignorable), so they are whitespace to neither JS' `\s` nor
 * Unicode's `White_Space` — but they are invisible, one is *named* a space, and the code that
 * handles text on the way here handles them as one: editors, consoles, copy-paste out of rendered
 * HTML and the sanitisers that strip or space-replace invisible characters. `CALL\u200Bp()` shows
 * no gap at all to a human, which makes it worse than NBSP rather than better — whatever reads it
 * decides on its own whether a token ends there. The BOM (U+FEFF) is the same kind of character and
 * was already here only because JS happens to call it a space.
 *
 * The server's `space` is `[ \t\n\r\f]` while its `ident_cont` is `[A-Za-z\200-\377_0-9\$]`, so
 * every non-ASCII character here *continues an identifier* there instead of separating two tokens:
 * `CALL\u00A0p()` is ONE identifier (`call p`) to Postgres and a `CALL` with odd padding to a human,
 * a client library or anything on the way that normalises spaces. Which of those two readings a
 * given driver, pooler or paste produces is not knowable from this file, so the guard fails closed
 * and refuses on either — see {@link endsKeyword} and {@link onlyPgSpace}.
 */
const UNICODE_SPACE = new Set([
  "\v", "\f", "\u0085", "\u00a0", "\u1680",
  "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005",
  "\u2006", "\u2007", "\u2008", "\u2009", "\u200a",
  "\u200b", "\u200c", "\u200d", "\u2060",
  "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff",
]);
const isUnicodeSpace = (c: string | undefined) => c !== undefined && UNICODE_SPACE.has(c);

/**
 * True when a refused keyword really ends at `c`: the character neither continues an identifier
 * (Postgres' `ident_cont`, so `callback` and `call$a$` are names that merely start with the letters)
 * nor is one of the {@link UNICODE_SPACE} characters that continue one on the server while reading
 * as a gap everywhere else. The end of the statement ends a keyword too (`c === undefined`).
 *
 * The other refused keywords are matched with a regex `\b`, which ends them at every one of these
 * characters already (JS `\w` is ASCII, so NBSP is a word boundary to it): `COMMIT\u00A0x` and
 * `SET\u00A0LOCAL …` are refused with no help from here. `CALL` is the one whose boundary is checked
 * by hand, because it is the one that must ALSO not fire at the `$` of `call$a$` or the `é` of
 * `callé` — see {@link isRefusedCall} — and `onlyPgSpace` keeps the two allowlists honest about the
 * same characters from the other side.
 */
const endsKeyword = (c: string | undefined) => !isIdentCont(c) || isUnicodeSpace(c);

/**
 * True when every space in `stmt` is one the server itself reads as a gap between two tokens.
 *
 * The allowlists below (`ROLLBACK_TO_SAVEPOINT`, `SET_LOCAL_ALLOWED`) spell their gaps `\s`, which in
 * JS matches NBSP and most of {@link UNICODE_SPACE} as well — characters that are identifier text
 * to Postgres. `SET\u00A0LOCAL\u00A0statement_timeout = '5s'` would satisfy the allowlist regex while
 * being something else entirely on the wire, so an allowlist is only ever consulted for a statement
 * whose gaps are ASCII: anything else falls through to the refusal it was an exception to. (The
 * zero-width four are not JS `\s`, so no allowlist regex can match a gap spelled with one in the
 * first place; this check rejects them anyway rather than leaving that to the regexes.)
 */
const onlyPgSpace = (stmt: string) => ![...stmt].some(isUnicodeSpace);

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
 * `$1` parameter placeholder, a lone `$` in an operator, or a `$` *inside an identifier*.
 *
 * That last case is the one worth spelling out. `$` is an identifier character in Postgres
 * (`ident_cont`, above), and the lexer takes the longest match, so in `SELECT 1 AS x$a$` the whole
 * `x$a$` is ONE identifier — the column alias — and no dollar quote is opened at all. Reading that
 * `$a$` as a dollar-quote opener (as this once did) made
 * `SELECT 1 AS x$a$; COMMIT; INSERT INTO smuggle VALUES (1); SELECT 1 AS y$a$` look like a single
 * statement whose middle was quoted data, while the server ran all four — the `COMMIT` ending the
 * guard's READ ONLY transaction and the `INSERT` writing to the one production database. So a dollar
 * quote can only open where a token can start: when the character before the `$` does not continue an
 * identifier. Erring the other way is safe: text the server quotes but this scanner reads as SQL can
 * only ever make it see MORE statements, and more statements means a refusal.
 */
function dollarTag(sql: string, i: number): string | null {
  if (sql[i] !== "$" || isIdentCont(sql[i - 1])) return null;
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
 *   - `--` line comments, to the end of the line — which Postgres ends at `\r` as well as at `\n`;
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
      // To the end of the LINE, and Postgres ends a line at `\r` as well as at `\n`
      // (`non_newline [^\n\r]` in scan.l). Scanning only to the next `\n` read a bare-CR line ending
      // as part of the comment, so `SELECT 1; -- x\rCOMMIT; INSERT …` looked like one statement with a
      // trailing comment while the server ran all three — the COMMIT ending the guard's READ ONLY
      // transaction and the INSERT writing.
      let nl = i + 2;
      while (nl < sql.length && sql[nl] !== "\n" && sql[nl] !== "\r") nl += 1;
      cur += " ";
      i = nl; // the line ending itself stays: it is a separator, not comment text
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
    // `E'…'`, but only where a token can start: in `x$E'…'` the `E` is the tail of the identifier
    // `x$E` and the `'…'` after it is a plain string, where `\'` is NOT an escaped quote.
    if ((c === "E" || c === "e") && sql[i + 1] === "'" && !isIdentCont(sql[i - 1])) {
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
      // A string becomes empty filler; a quoted IDENTIFIER keeps its word characters, because a
      // quoted identifier still names something — `pg_catalog."set_config"(…)` calls set_config just
      // as the bare spelling does, and `SET_CONFIG` below has to be able to see it. Everything that
      // could be read as SQL (`;`, `--`, `/*`, quotes, operators) is dropped, so the name cannot act.
      cur += c === "'" ? "''" : `"${sql.slice(i + 1, end - 1).replace(/[^A-Za-z0-9_]/g, "")}"`;
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
  return scanPieces(sql).map(trimSql).filter((s) => s.length > 0);
}

/**
 * True for a state change a preview must not send: it would drop READ ONLY, change how the SQL after
 * it is lexed, or outlive the transaction on a backend production later borrows. That is every `SET`
 * and every `RESET` bar the `SET LOCAL` timeouts of `SET_LOCAL_ALLOWED`, every `set_config(…)` call,
 * every `DO` block (whose body this scanner cannot see into) and every `DISCARD`.
 */
function isRefusedModeChange(stmt: string): boolean {
  if (SET_CONFIG.test(stmt) || DO_BLOCK.test(stmt) || DISCARD.test(stmt)) return true;
  return SET_OR_RESET.test(stmt) && !(onlyPgSpace(stmt) && SET_LOCAL_ALLOWED.test(stmt));
}

/** True for a statement that could end the transaction the guard is holding open. */
function isRefusedTxEnd(stmt: string): boolean {
  return TX_END.test(stmt) && !(onlyPgSpace(stmt) && ROLLBACK_TO_SAVEPOINT.test(stmt));
}

/**
 * True for a `CALL` statement, whose procedure body could end that transaction from the inside (see
 * {@link CALL}). Where the keyword ends is {@link endsKeyword} rather than a regex `\b`, because the
 * two disagree in both directions, exactly where it matters:
 *   - JS `\w` is `[A-Za-z0-9_]`, so `\b` would end the keyword at the `$` of `call$a$` and at the `é`
 *     of `callé`, while Postgres reads each of those as ONE identifier — a name that merely starts
 *     with those letters, not the keyword — so those must keep running;
 *   - `isIdentCont` alone would NOT end it at the NBSP of `CALL\u00A0p()`, because every non-ASCII
 *     character continues an identifier on the server. That is the fail-open half: a space a human,
 *     a driver or a paste reads as a gap would have hidden the keyword. Every
 *     {@link UNICODE_SPACE} character therefore ends it, and the statement is refused whichever way
 *     the server would have lexed it.
 */
function isRefusedCall(stmt: string): boolean {
  return CALL.test(stmt) && endsKeyword(stmt[4]);
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

/**
 * Rewrite one BEGIN/START TRANSACTION so it opens READ ONLY, keeping its other modes.
 *
 * A gap this file reads as one and the server does not — any {@link UNICODE_SPACE} character —
 * is refused here rather than rewritten, for the reason the two allowlists refuse one
 * ({@link onlyPgSpace}): `START\u200BTRANSACTION READ WRITE` and
 * `BEGIN ISOLATION\u2060LEVEL SERIALIZABLE` open a transaction to every layer above the server
 * and are one long identifier to the server itself, so which modes the statement even carries
 * depends on who reads it — and one of the readings is a writable transaction against production.
 * Leading and trailing gaps are already gone by now ({@link trimSql}) and are safe to drop, because
 * nothing of the statement rides on them; an interior one decides what the tokens are, so it fails
 * closed instead.
 */
function readOnlyTxStart(stmt: string): string {
  if (!onlyPgSpace(stmt)) throw new ReadOnlyRefusedError(stmt);
  const tokens = trimSql(stmt.replace(/,/g, " , ")).split(/\s+/);
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
 *     A start whose own keywords are held apart by a space the server does not read as one —
 *     `START\u200BTRANSACTION READ WRITE`, `BEGIN ISOLATION\u2060LEVEL SERIALIZABLE` — is refused
 *     rather than rewritten: what its mode list says depends on who is reading the gap.
 *   - every transaction-ending statement is refused: `COMMIT`, `ROLLBACK`, `END`, `ABORT` in any case or
 *     spacing, with `WORK`/`TRANSACTION` and with `AND [NO] CHAIN`, plus `PREPARE TRANSACTION '...'`,
 *     `COMMIT PREPARED '...'` and `ROLLBACK PREPARED '...'`. Ending the transaction removes READ ONLY,
 *     which is the whole guard, and leaves whatever the caller sends next running writable in
 *     autocommit. `SAVEPOINT`, `RELEASE [SAVEPOINT]` and `ROLLBACK TO [SAVEPOINT]` stay allowed:
 *     they work inside the transaction and cannot end it. The COMMIT/ROLLBACK that really do close a
 *     preview transaction are the guard's own (`readOnlyGuard`), which never pass through here.
 *   - every `CALL` is refused. A procedure is the one thing a caller can invoke that may run its own
 *     transaction control: a PL/pgSQL body can `COMMIT` — ending the guard's transaction from the
 *     inside — or `PERFORM set_config(...)`, and the body is not in the statement text for this file
 *     to inspect. Any case, any padding or newlines, comments before or between the tokens, and any
 *     procedure name (schema-qualified or quoted) — and the padding may be any Unicode space, NBSP,
 *     U+2003 and the zero-width U+200B–U+200D and U+2060 included, every one of which the server
 *     would read as part of a name rather than as a gap. The
 *     word `call` inside a literal, inside a quoted identifier, or as part of a longer name
 *     (`callback`, `callé`) is not this keyword and still runs.
 *   - every `SET` and every `RESET` is refused — `SET TRANSACTION ... READ WRITE`,
 *     `SET SESSION CHARACTERISTICS ...` and the read-only GUCs among them — bar `SET LOCAL <timeout>`
 *     for the three timeouts of `SET_LOCAL_ALLOWED`, and so is every `set_config(...)` call, every `DO`
 *     block and every `DISCARD`. They either undo READ ONLY, or leave connection state that would leak
 *     onto a PgBouncer backend production later borrows, or — `standard_conforming_strings` is the
 *     example — change how the SQL after them is lexed, and the lexing is what every rule here rests on.
 *   - a string holding more than one statement is refused outright. Rewriting cannot make it safe: an
 *     early `COMMIT` ends the read-only transaction and leaves the rest writing in autocommit, so
 *     `begin; insert ...` and `commit; insert ...` alike are errors. No app query is multi-statement.
 *     Concretely: every `;` outside a literal or a comment is refused, except one trailing `;`
 *     followed by nothing but whitespace and comments. Where the literals and comments are is decided
 *     by `scanPieces`, one left-to-right pass, so a `;` hidden in `'--'`, `$$--$$`, `E'\'--'`, `"--"`
 *     or `'/*'` is not a statement separator and a `;` after them still is.
 *   - SQL that cannot be scanned at all — an unterminated string, identifier, dollar quote or block
 *     comment — is refused: where the quoting ends is exactly what decides everything above.
 *   - leading and trailing padding is stripped before any of the above, and it may be any
 *     {@link UNICODE_SPACE} character — the invisible U+200B, U+200C, U+200D, U+2060 and the BOM
 *     included, none of which JS' own `.trim()` removes (see {@link trimSql}). Every check here is
 *     anchored at the statement's first character, so `\u200BCALL p()`, `\u200BCOMMIT` and
 *     `\uFEFFSET x = 1` are the statements they look like to a human and are refused as such, on
 *     all three paths (a string, a `{text}` config, and either value of `inTransaction`); the same
 *     padding after a statement, or around its trailing `;`, is likewise not a second statement.
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
  if (pieces.length > 2 || (pieces.length === 2 && trimSql(pieces[1]) !== "")) {
    throw new ReadOnlyRefusedError(sql);
  }
  const stmts = pieces.map(trimSql).filter((s) => s.length > 0);
  if (stmts.length === 0) return q;
  const [stmt] = stmts;
  if (isRefusedModeChange(stmt) || isRefusedTxEnd(stmt) || isRefusedCall(stmt)) {
    throw new ReadOnlyRefusedError(sql);
  }
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
