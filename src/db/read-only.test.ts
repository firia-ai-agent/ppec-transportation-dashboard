import { describe, expect, it } from "vitest";
import {
  BEGIN_READ_ONLY,
  READ_ONLY_REASON,
  beginSql,
  isReadOnlyDbEnv,
  isTransactionStart,
  passThroughGuard,
  previewSkip,
  ReadOnlyRefusedError,
  readOnlyGuard,
  rewriteBeginReadOnly,
  rewriteBeginReadOnlyForEnv,
  sqlText,
  txGuardForEnv,
  type SqlLike,
} from "./read-only";

/** A fake wire: records what the guard sent, in order. The guard's own framing shows up here too. */
function fakeWire(failOn?: RegExp) {
  const sent: string[] = [];
  return {
    sent,
    send: async (q: SqlLike, params?: unknown[]) => {
      sent.push(sqlText(q));
      if (failOn?.test(sqlText(q))) throw new Error(`boom: ${sqlText(q)}`);
      return { rows: [{ q: sqlText(q), params }] };
    },
  };
}

/** Every spelling of a statement that ends, or can end, the transaction the guard is holding open. */
const TX_END_FORMS = [
  "COMMIT", "commit", "  Commit  ", "COMMIT;", "commit ;", "\tcommit\n",
  "COMMIT WORK", "commit transaction", "COMMIT AND CHAIN", "commit and no chain",
  "COMMIT WORK AND CHAIN", "commit transaction and no chain",
  "ROLLBACK", "rollback", "ROLLBACK WORK", "rollback transaction",
  "ROLLBACK AND CHAIN", "rollback work and no chain",
  "END", "end", "END WORK", "end transaction", "END AND CHAIN", "end work and no chain",
  "ABORT", "abort", "ABORT WORK", "abort transaction", "ABORT AND CHAIN",
  "PREPARE TRANSACTION 'ppec-1'", "prepare transaction 'ppec-1'",
  "COMMIT PREPARED 'ppec-1'", "commit prepared 'ppec-1'",
  "ROLLBACK PREPARED 'ppec-1'", "rollback prepared 'ppec-1'",
  "/* drizzle */ commit -- done\n", "commit /* and chain */", "COMMIT\n\n",
];
/**
 * Every space that is a space to Unicode, to a human and to the drivers, but not to Postgres' own
 * lexer, which treats only ASCII whitespace as a gap and every non-ASCII byte as identifier text
 * (`scan.l`: `space [ \t\n\r\f]`, `ident_cont [A-Za-z\200-\377_0-9$]`). Named, because the point of
 * the list is that each one is a space SOMEWHERE — in a paste, in an editor, in a client library
 * that normalises them — and the guard cannot know which reading reaches the server.
 */
const UNICODE_SPACES: ReadonlyArray<[string, string]> = [
  ["\v", "LINE TABULATION (U+000B)"],
  ["\f", "FORM FEED (U+000C)"],
  ["\u0085", "NEXT LINE (U+0085)"],
  ["\u00a0", "NO-BREAK SPACE (U+00A0)"],
  ["\u1680", "OGHAM SPACE MARK (U+1680)"],
  ["\u2000", "EN QUAD (U+2000)"],
  ["\u2001", "EM QUAD (U+2001)"],
  ["\u2002", "EN SPACE (U+2002)"],
  ["\u2003", "EM SPACE (U+2003)"],
  ["\u2004", "THREE-PER-EM SPACE (U+2004)"],
  ["\u2005", "FOUR-PER-EM SPACE (U+2005)"],
  ["\u2006", "SIX-PER-EM SPACE (U+2006)"],
  ["\u2007", "FIGURE SPACE (U+2007)"],
  ["\u2008", "PUNCTUATION SPACE (U+2008)"],
  ["\u2009", "THIN SPACE (U+2009)"],
  ["\u200a", "HAIR SPACE (U+200A)"],
  ["\u2028", "LINE SEPARATOR (U+2028)"],
  ["\u2029", "PARAGRAPH SEPARATOR (U+2029)"],
  ["\u202f", "NARROW NO-BREAK SPACE (U+202F)"],
  ["\u205f", "MEDIUM MATHEMATICAL SPACE (U+205F)"],
  ["\u3000", "IDEOGRAPHIC SPACE (U+3000)"],
  ["\ufeff", "ZERO WIDTH NO-BREAK SPACE / BOM (U+FEFF)"],
];
/**
 * `CALL` separated from its procedure name by one of those, in the shapes a caller would reach for.
 * Postgres reads `CALL\u00A0p()` as the single identifier `call p` — a syntax error, not a CALL — but
 * anything that normalises the space on the way (a driver, a pooler, a paste into a console) hands
 * the server a real `CALL`, so the guard refuses on either reading rather than betting on one.
 */
const CALL_UNICODE_SPACE_FORMS = UNICODE_SPACES.flatMap(([c]) => [
  `CALL${c}p()`,
  `call${c}ops.p()`,
  `cAlL${c}${c}p()`,
  `CALL${c}"ops"."p"()`,
  `CALL${c}p(); SELECT 1`,
  `/* x */ CALL${c}ops.commit_and_write()`,
  `CALL${c}`,
]);
/**
 * Every spelling of `CALL`. A procedure body can `COMMIT` — ending the guard's transaction from the
 * inside, where no rule in read-only.ts can see it — so the keyword is refused outright, like COMMIT.
 * Case, padding, newlines, leading and interleaved comments, and the procedure name (bare,
 * schema-qualified or quoted) are all free: only the first token decides.
 */
const CALL_FORMS = [
  "CALL p()", "call p()", "Call p()", "cAlL p()", "CALL P()",
  "  CALL p()  ", "CALL   p()", "CALL\tp()", "CALL\np()", "CALL\n p()", "CALL\r\np()",
  "CALL p();", "call p() ;  ", "CALL p()\n",
  "/* x */ CALL p()", "cAlL/**/p()", "CALL/**/p()", "CALL /* c */ p()",
  "-- lead\nCALL p()", "-- lead\rCALL p()", "/* /* nested */ */ CALL p()", "CALL p() -- tail\n",
  "CALL ops.p()", "call public.refresh_rollup()", "CALL ops.p(1, 'x')",
  'CALL "p"()', 'CALL ops."my proc"()', 'CALL "ops"."p"()', 'call "P"(1)',
  "CALL p('a;b--c/*d')", "CALL p($$;--$$)", "CALL p(E'\\';--')",
  "CALL", "call", "CALL\n",
  // The keyword cut off from its name by a space the server does not read as one.
  ...CALL_UNICODE_SPACE_FORMS,
];
/**
 * The word `call` where it is NOT that keyword: inside a literal, inside a quoted identifier, inside a
 * comment, or as part of a longer name. `$` and every non-ASCII character continue an identifier in
 * Postgres, so `call$a$` and `callé` are each ONE name — which is why the keyword's end is checked
 * against Postgres' `ident_cont` and not against a regex `\b`. (The one non-ASCII class that DOES end
 * it is the Unicode spaces above: see the fail-closed test below.)
 */
const CALL_NON_FORMS = [
  "SELECT 'call'", "SELECT 'CALL p()'", "select 'call' AS c", "SELECT length('call')",
  "SELECT 1 AS callback", "SELECT callback()", "SELECT ops.call_log()",
  'SELECT "call" FROM t', 'SELECT "call" AS "CALL" FROM "calls"', 'SELECT 1 AS "CALL"',
  "-- CALL p()\nSELECT 1", "/* CALL p() */ SELECT 1", "SELECT $$CALL p()$$", "SELECT $tag$CALL$tag$",
  // Statement-initial, and still not the keyword: a longer identifier, or a quoted one.
  "callback", "callback()", "calls", "CALLBACK p()", "call$a$", "call$a$()", "callé", "call1",
  '"call"()', '"CALL" p()',
  // A Unicode space ends the CALL keyword; it does not make every statement that contains one a
  // CALL. These still run, exactly as they did before the keyword boundary learned about NBSP.
  "SELECT\u00a01 AS callback", "SELECT 1 AS callback\u00a0x", "SELECT 'CALL\u00a0p()'",
  'SELECT "CALL\u00a0p" FROM t', "SELECT $$CALL\u00a0p()$$", "-- CALL\u00a0p()\nSELECT 1",
];
/** Savepoint work: it rolls back or forgets part of the transaction, but cannot end it. */
const SAVEPOINT_FORMS = [
  "SAVEPOINT sp1", "savepoint sp1",
  "RELEASE SAVEPOINT sp1", "release savepoint sp1", "release sp1",
  "ROLLBACK TO SAVEPOINT sp1", "rollback to savepoint sp1", "rollback to sp1",
  "ROLLBACK TRANSACTION TO SAVEPOINT sp1", "rollback work to savepoint sp1",
  'rollback to savepoint "my sp"',
];

describe("preview read-only fail-safe (DECISION-LEDGER #43)", () => {
  it("treats only VERCEL_ENV=preview as read-only", () => {
    expect(isReadOnlyDbEnv({ VERCEL_ENV: "preview" })).toBe(true);
    for (const v of ["production", "development", "Preview", "", undefined]) {
      expect(isReadOnlyDbEnv({ VERCEL_ENV: v })).toBe(false);
    }
    expect(isReadOnlyDbEnv({})).toBe(false);
  });

  it("opens transactions READ ONLY on previews and plain BEGIN everywhere else", () => {
    expect(BEGIN_READ_ONLY).toBe("BEGIN READ ONLY");
    expect(beginSql({ VERCEL_ENV: "preview" })).toBe(BEGIN_READ_ONLY);
    for (const v of ["production", "development", undefined]) expect(beginSql({ VERCEL_ENV: v })).toBe("BEGIN");
    expect(beginSql({})).toBe("BEGIN");
  });

  it("sets no session-level state: the module exports only transaction-scoped SQL", () => {
    const sql = [
      BEGIN_READ_ONLY,
      beginSql({ VERCEL_ENV: "preview" }),
      ...["begin ", "begin work read write", "start transaction isolation level serializable, read write"]
        .map((s) => rewriteBeginReadOnly(s)),
    ].join(" ");
    expect(sql).not.toMatch(/SET SESSION/i);
    expect(sql).not.toMatch(/\bSET\b/i);
    expect(sql).not.toMatch(/default_transaction_read_only/i);
  });

  describe("rewriteBeginReadOnly", () => {
    it("rewrites a bare BEGIN, however it is spelled or padded", () => {
      for (const s of ["BEGIN", "begin", "  begin  ", "\nBegin\t", "begin ", "BEGIN;", "begin ;"]) {
        expect(rewriteBeginReadOnly(s)).toBe(BEGIN_READ_ONLY);
      }
    });

    it("rewrites BEGIN TRANSACTION, BEGIN WORK and START TRANSACTION, keeping the keyword", () => {
      expect(rewriteBeginReadOnly("BEGIN TRANSACTION")).toBe("BEGIN TRANSACTION READ ONLY");
      expect(rewriteBeginReadOnly("begin work")).toBe("BEGIN WORK READ ONLY");
      expect(rewriteBeginReadOnly("  start   transaction  ")).toBe("START TRANSACTION READ ONLY");
      expect(rewriteBeginReadOnly("Start\nTransaction")).toBe("START TRANSACTION READ ONLY");
    });

    it("strips READ WRITE and forces READ ONLY", () => {
      expect(rewriteBeginReadOnly("BEGIN READ WRITE")).toBe(BEGIN_READ_ONLY);
      expect(rewriteBeginReadOnly("begin read write")).toBe(BEGIN_READ_ONLY);
      expect(rewriteBeginReadOnly("BEGIN TRANSACTION READ WRITE")).toBe("BEGIN TRANSACTION READ ONLY");
      expect(rewriteBeginReadOnly("start transaction read write")).toBe("START TRANSACTION READ ONLY");
      expect(rewriteBeginReadOnly("begin work read  write")).toBe("BEGIN WORK READ ONLY");
    });

    it("keeps the isolation level while forcing READ ONLY", () => {
      expect(rewriteBeginReadOnly("begin isolation level serializable"))
        .toBe("BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY");
      expect(rewriteBeginReadOnly("BEGIN ISOLATION LEVEL REPEATABLE READ"))
        .toBe("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      expect(rewriteBeginReadOnly("start transaction isolation level read committed"))
        .toBe("START TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY");
      expect(rewriteBeginReadOnly("begin transaction isolation level read uncommitted"))
        .toBe("BEGIN TRANSACTION ISOLATION LEVEL READ UNCOMMITTED, READ ONLY");
    });

    it("keeps mixed modes — commas, DEFERRABLE, NOT DEFERRABLE — in order, access mode last", () => {
      expect(rewriteBeginReadOnly("begin isolation level serializable, read write, deferrable"))
        .toBe("BEGIN ISOLATION LEVEL SERIALIZABLE, DEFERRABLE, READ ONLY");
      expect(rewriteBeginReadOnly("BEGIN READ WRITE ISOLATION LEVEL SERIALIZABLE NOT DEFERRABLE"))
        .toBe("BEGIN ISOLATION LEVEL SERIALIZABLE, NOT DEFERRABLE, READ ONLY");
      expect(rewriteBeginReadOnly("  start transaction  ISOLATION LEVEL repeatable read ,  read write  "))
        .toBe("START TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    });

    it("is idempotent: a BEGIN that is already READ ONLY comes back unchanged in meaning", () => {
      expect(rewriteBeginReadOnly("BEGIN READ ONLY")).toBe(BEGIN_READ_ONLY);
      expect(rewriteBeginReadOnly(rewriteBeginReadOnly("begin isolation level serializable read write")))
        .toBe("BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY");
    });

    it("ignores comments and quoted text when deciding, and never sends a writable transaction", () => {
      expect(rewriteBeginReadOnly("/* drizzle */ begin -- go\n")).toBe(BEGIN_READ_ONLY);
      expect(rewriteBeginReadOnly("begin /* read write */")).toBe(BEGIN_READ_ONLY);
      // A `begin` or a `;` inside a literal is data, not SQL: the statement passes through untouched.
      for (const s of ["SELECT 'begin; read write'", 'SELECT "begin", 1', "SELECT $$begin; insert$$"]) {
        expect(rewriteBeginReadOnly(s)).toBe(s);
      }
    });

    it("rewrites the SQL inside a query config object, keeping its other fields", () => {
      expect(rewriteBeginReadOnly({ text: "begin ", rowMode: "array" }))
        .toEqual({ text: BEGIN_READ_ONLY, rowMode: "array" });
      expect(rewriteBeginReadOnly({ text: "begin isolation level serializable read write", rowMode: "array" }))
        .toEqual({ text: "BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY", rowMode: "array" });
    });

    it("every transaction-start form it accepts ends up READ ONLY and never READ WRITE", () => {
      const forms = [
        "begin", "BEGIN ", "begin work", "BEGIN TRANSACTION", "start transaction",
        "begin read write", "BEGIN WORK READ WRITE", "start transaction read write",
        "begin isolation level serializable", "begin isolation level serializable read write",
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ WRITE, NOT DEFERRABLE",
        "  Start   Transaction   Read   Write  ", "begin deferrable read write",
      ];
      for (const s of forms) {
        const out = rewriteBeginReadOnly(s);
        expect(out, s).toMatch(/\bREAD ONLY$/);
        expect(out, s).not.toMatch(/READ\s+WRITE/i);
      }
    });

    it("refuses a SET that would drop READ ONLY or set state outliving the transaction", () => {
      for (const s of [
        "SET TRANSACTION READ WRITE",
        "set transaction read write",
        "  set   transaction   isolation level serializable, read write ",
        "SET LOCAL TRANSACTION READ WRITE",
        "set session characteristics as transaction read write",
        "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
        "SET transaction_read_only = off",
        "set default_transaction_read_only to off",
      ]) {
        expect(() => rewriteBeginReadOnly(s), s).toThrow(ReadOnlyRefusedError);
        expect(() => rewriteBeginReadOnly({ text: s }), s).toThrow(/DECISION-LEDGER #43/);
      }
    });

    /**
     * Every other SET and RESET too (hotfix PR #20, reviewer bypass 2). A GUC change is not only a way
     * to drop READ ONLY: `SET standard_conforming_strings = off` changes how the SQL *after* it is
     * lexed, so `SELECT '\''; COMMIT; INSERT …; -- '` becomes three statements on the server while the
     * scanner here — which assumes the modern, standard-conforming lexing — still reads one. The
     * lexing is what every rule in read-only.ts rests on, so previews may not touch it at all. And a
     * session-level SET would outlive the statement on a PgBouncer backend production later borrows.
     */
    it("refuses every other SET and RESET, including the ones that change how SQL is lexed", () => {
      for (const s of [
        "SET standard_conforming_strings = off",
        "set standard_conforming_strings to off",
        "SET LOCAL standard_conforming_strings = off",
        "SET SESSION standard_conforming_strings = off",
        "RESET standard_conforming_strings",
        "SET backslash_quote = on",
        "SET escape_string_warning = off",
        "SET search_path TO ops",
        "set local search_path to ops",
        "RESET search_path",
        "SET ROLE migrator",
        "RESET ROLE",
        "SET TIME ZONE 'UTC'",
        "SET TRANSACTION READ ONLY",
        "set local transaction isolation level serializable",
        "SET LOCAL transaction_read_only = off",
        "SET LOCAL default_transaction_read_only = off",
        "SET LOCAL statement_timeout = '5s', lock_timeout = '1s'",
        "SET LOCAL statement_timeout = (SELECT 1)",
        "SET LOCAL statement_timeoutx = 1",
        "SET statement_timeout = '5s'",
        "set local statement_timeout = '5s' ; -- trailing is fine, but this is not a SET LOCAL\nSET x = 1",
      ]) {
        expect(() => rewriteBeginReadOnly(s), s).toThrow(ReadOnlyRefusedError);
        expect(() => rewriteBeginReadOnly({ text: s }), s).toThrow(/DECISION-LEDGER #43/);
      }
    });

    /**
     * `set_config(name, value, is_local)` is `SET` spelled as a function, so it can hide anywhere an
     * expression can — and inside a `DO` block it hides inside a literal this scanner cannot see into.
     * Both are refused; no app query uses either.
     */
    it("refuses set_config() anywhere in the statement, and any DO block", () => {
      for (const s of [
        "SELECT set_config('standard_conforming_strings', 'off', false)",
        "select SET_CONFIG('standard_conforming_strings','off',false)",
        "SELECT pg_catalog.set_config('standard_conforming_strings','off',false)",
        'SELECT pg_catalog."set_config"(\'standard_conforming_strings\',\'off\',false)',
        "SELECT set_config ( 'x', 'y', false )",
        "SELECT 1 FROM set_config('x','y',false)",
        "WITH c AS (SELECT set_config('x','y',false)) SELECT * FROM c",
        "SELECT CASE WHEN true THEN set_config('x','y',false) END",
        "DO $$ BEGIN PERFORM set_config('standard_conforming_strings','off',false); END $$",
        "do $do$ begin perform 1; end $do$",
      ]) {
        expect(() => rewriteBeginReadOnly(s), s).toThrow(ReadOnlyRefusedError);
      }
      // A literal that merely mentions it is data, not a call, and a column of that name is not one either.
      expect(rewriteBeginReadOnly("SELECT 'set_config('")).toBe("SELECT 'set_config('");
      expect(rewriteBeginReadOnly("SELECT setting FROM pg_settings WHERE name = 'statement_timeout'"))
        .toBe("SELECT setting FROM pg_settings WHERE name = 'statement_timeout'");
    });

    it("leaves the allowlisted SET LOCAL timeouts alone, and nothing else", () => {
      for (const s of [
        "SET LOCAL statement_timeout = '5s'",
        "set local statement_timeout = '5s'",
        "SET LOCAL statement_timeout TO 5000",
        "SET LOCAL statement_timeout = DEFAULT",
        "SET LOCAL lock_timeout = '1s'",
        "SET LOCAL idle_in_transaction_session_timeout = 0",
        "SET LOCAL statement_timeout = '5s' ;",
      ]) {
        expect(rewriteBeginReadOnly(s), s).toBe(s);
      }
    });

    it("refuses a multi-statement string: one COMMIT in it would end the read-only transaction", () => {
      for (const s of [
        "begin; insert into t values (1)",
        "BEGIN; INSERT INTO t VALUES (1); COMMIT",
        "commit; insert into t values (1)",
        "select 1; begin read write",
        "SELECT 1; SELECT 2",
        "commit; begin",
      ]) {
        expect(() => rewriteBeginReadOnly(s), s).toThrow(ReadOnlyRefusedError);
      }
    });

    it("refuses a `;` hidden in a literal or a comment: one pass, so neither can hide the other", () => {
      // Each of these is a second (and third) statement behind a `;` that a splitter which strips
      // comments before literals reads as part of a comment. The drivers send an unparameterised
      // string through the simple query protocol, which runs every command in it, so the `COMMIT`
      // would end the read-only transaction and the `INSERT` would write (hotfix PR #20 blocker 3).
      for (const s of [
        "SELECT '--'; COMMIT; INSERT INTO t VALUES (1)",
        "SELECT '/*'; COMMIT; INSERT INTO t VALUES (1)",
        "SELECT $$--$$; COMMIT; INSERT INTO t VALUES (1)",
        "SELECT '/*'; COMMIT; INSERT INTO t VALUES (1) /* done */",
        "SELECT E'\\'--'; COMMIT; INSERT INTO t VALUES (1)",
        "select e'\\'--'; commit; insert into t values (1)",
        "SELECT E'--''--'; COMMIT; INSERT INTO t VALUES (1)",
        'SELECT 1 AS "--"; COMMIT; INSERT INTO t VALUES (1)',
        'SELECT 1 AS "/*"; COMMIT; INSERT INTO t VALUES (1)',
        'SELECT 1 AS "a""--"; COMMIT; INSERT INTO t VALUES (1)',
        "SELECT $tag$--$tag$; COMMIT; INSERT INTO t VALUES (1)",
        "SELECT $tag$/*$tag$; COMMIT; INSERT INTO t VALUES (1)",
        "SELECT $a1_b$--$a1_b$; COMMIT; INSERT INTO t VALUES (1)",
        "SELECT 1 /* /* nested */ */; COMMIT; INSERT INTO t VALUES (1)",
        "-- lead\nSELECT '--'; COMMIT; INSERT INTO t VALUES (1)",
        "/* lead */ SELECT $$--$$; COMMIT; INSERT INTO t VALUES (1)",
        "select '--'\n; commit\n; insert into t values (1)",
        "SELECT '--' -- tail\n; COMMIT; INSERT INTO t VALUES (1)",
        "SELECT '--'; INSERT INTO t VALUES (1)",
      ]) {
        expect(() => rewriteBeginReadOnly(s), s).toThrow(ReadOnlyRefusedError);
      }
    });

    /**
     * A bare `\r` ends a `--` comment in Postgres (`non_newline [^\n\r]` in scan.l), so a comment that
     * this scanner ran to the next `\n` had already ended on the server — and everything between the
     * `\r` and the `\n` was SQL there and comment here. `SELECT 1; -- x\rCOMMIT; INSERT …` looked like
     * one statement with a trailing comment while the server ran all three.
     */
    it("ends a `--` comment at a bare CR, as Postgres does", () => {
      for (const s of [
        "SELECT 1; -- x\rCOMMIT; INSERT INTO t VALUES (1)",
        "SELECT 1; --\rCOMMIT; INSERT INTO t VALUES (1)",
        "SELECT 1 -- x\rCOMMIT; INSERT INTO t VALUES (1)",
        "-- lead\rSELECT 1; COMMIT; INSERT INTO t VALUES (1)",
        "SELECT 1 -- x\r; COMMIT; INSERT INTO t VALUES (1)",
        "-- x\rCOMMIT",
        "-- x\rcommit work",
        "-- x\rSET standard_conforming_strings = off",
      ]) {
        expect(() => rewriteBeginReadOnly(s), JSON.stringify(s)).toThrow(ReadOnlyRefusedError);
      }
      // A comment really is still a comment: CR or LF, the statement before it passes through.
      expect(rewriteBeginReadOnly("SELECT 1 -- x\r")).toBe("SELECT 1 -- x\r");
      expect(rewriteBeginReadOnly("SELECT 1; -- x\r")).toBe("SELECT 1; -- x\r");
      expect(rewriteBeginReadOnly("-- x\rSELECT 1")).toBe("-- x\rSELECT 1");
      expect(rewriteBeginReadOnly("begin -- go\r")).toBe(BEGIN_READ_ONLY);
    });

    /**
     * A `$` inside an identifier is NOT a dollar-quote opener (hotfix PR #20, reviewer bypass 1).
     * `$` is an identifier character in Postgres and its lexer takes the longest match, so in
     * `SELECT 1 AS x$a$` the whole `x$a$` is one identifier — the column alias — and no quoting starts
     * there. Reading it as a `$a$` opener made the scanner swallow everything up to the next `$a$`,
     * which is why `… x$a$; COMMIT; INSERT …; … y$a$` looked like one statement with a quoted middle
     * while the server ran all four and the INSERT wrote.
     */
    it("refuses a `;` hidden by a `$` inside an identifier: that is not a dollar quote", () => {
      for (const s of [
        "SELECT 1 AS x$a$; COMMIT; INSERT INTO t VALUES (1); SELECT 1 AS y$a$",
        "SELECT 1 AS x$$; COMMIT; INSERT INTO t VALUES (1); SELECT 1 AS y$$",
        "select 1 as x$a$; commit; insert into t values (1); select 1 as y$a$",
        "SELECT 1 AS a1$tag$; COMMIT; INSERT INTO t VALUES (1); SELECT 1 AS b1$tag$",
        "SELECT 1 AS _x$a$; COMMIT; INSERT INTO t VALUES (1); SELECT 1 AS _y$a$",
        // A digit, a `_` and a non-ASCII letter all continue an identifier, so none of them can be
        // followed by a dollar-quote opener either.
        "SELECT 1 AS x1$$; COMMIT; INSERT INTO t VALUES (1); SELECT 1 AS y1$$",
        "SELECT 1 AS é$a$; COMMIT; INSERT INTO t VALUES (1); SELECT 1 AS ü$a$",
        // The same `$`-in-identifier trick with the E-string rule: in `x$E'…'` the `E` is the tail of
        // the identifier `x$E`, so the `'…'` after it is a plain string where `\'` is a backslash
        // followed by the closing quote — not an escaped quote that runs on past the `;`.
        "SELECT 1 AS x$E'\\'; COMMIT; INSERT INTO t VALUES (1); -- '",
      ]) {
        expect(() => rewriteBeginReadOnly(s), s).toThrow(ReadOnlyRefusedError);
      }
    });

    it("still reads a real dollar quote, and a `$` in an identifier, as Postgres does", () => {
      for (const s of [
        // Real dollar quotes: a token can start where these do, so the `;` in them is data.
        "SELECT $$a;b$$",
        "SELECT $tag$a;b$tag$",
        "SELECT ($$a;b$$)",
        "SELECT 'x'||$$a;b$$",
        "SELECT $é$a;b$é$",
        // An identifier containing `$`, on its own: one statement, passed through untouched.
        "SELECT 1 AS x$a$",
        "SELECT x$a$ FROM t",
        "SELECT $1::int AS n",
      ]) {
        expect(rewriteBeginReadOnly(s), s).toBe(s);
      }
    });

    it("refuses the reviewer's cases: a re-opened nested comment, and `\\'` inside an E-string", () => {
      // Verbatim as the preview suite runs them against real Postgres. Two ways to make the scan
      // disagree with the server about where a construct ends:
      //   - `/* /* */ still comment */` — Postgres nests, so the first `*/` only drops to depth 1 and
      //     `still comment` is still comment; a scan that ended the comment there would read the rest
      //     as SQL and could take the `;` that follows for part of it.
      //   - `E'\'; COMMIT; --'` — `\'` is an escaped quote in an E-string, so the COMMIT and the `--`
      //     sit *inside* the literal (its contents are `'; COMMIT; --`) and it ends at the quote after
      //     `--`; the `;` after that one is top-level and starts the INSERT, which the server runs as
      //     a second command in the same simple query. Stripping `--` first blanked the rest of the
      //     line and left one innocent-looking statement with the INSERT still in it.
      for (const s of [
        "SELECT 1 /* /* */ still comment */; COMMIT; INSERT INTO smuggle VALUES (1)",
        "/* /* */ still comment */ COMMIT; INSERT INTO smuggle VALUES (1)",
        "SELECT E'\\'; COMMIT; --'; INSERT INTO smuggle VALUES (1)",
        "SELECT E'\\'; COMMIT; --';\nINSERT INTO smuggle VALUES (1)",
      ]) {
        expect(() => rewriteBeginReadOnly(s), s).toThrow(ReadOnlyRefusedError);
      }
      // The same quoting without the smuggled `;` is one harmless statement, and stays untouched:
      // the refusals above are about the second statement, not about the comment or the literal.
      for (const s of [
        "SELECT 1 /* /* */ still comment */",
        "/* /* */ still comment */ SELECT 1",
        "SELECT E'\\'; COMMIT; --'",
      ]) {
        expect(rewriteBeginReadOnly(s), s).toBe(s);
      }
    });

    it("allows one trailing `;` and nothing else: only one statement may ever run", () => {
      for (const s of ["SELECT 1;", "SELECT 1 ; ", "SELECT 1; -- done\n", "SELECT 1; /* done */"]) {
        expect(rewriteBeginReadOnly(s), s).toBe(s);
      }
      expect(rewriteBeginReadOnly("begin;")).toMatch(/\bREAD ONLY$/);
      // An empty extra statement is still an extra `;`, and a leading one is a `;` with SQL after it.
      for (const s of ["SELECT 1;;", "SELECT 1; ;", "; SELECT 1", "SELECT 1; SELECT 2;"]) {
        expect(() => rewriteBeginReadOnly(s), s).toThrow(ReadOnlyRefusedError);
      }
    });

    it("leaves a single statement alone however much quoting it carries", () => {
      for (const s of [
        "SELECT 'a;b--c/*d'", "SELECT $$;--/*$$", "SELECT $tag$;--/*$tag$", "SELECT E'\\';--'",
        'SELECT 1 AS "a;b--c"', 'SELECT 1 AS "a""b;c"', "SELECT '--' -- tail\n",
        "/* lead */ SELECT 1 /* mid */", "SELECT 1 /* /* nested */ */",
        "SELECT $1::int, $2 FROM t", "SELECT $$x$$ || $1", "INSERT INTO t VALUES ($1) -- ;COMMIT\n",
      ]) {
        expect(rewriteBeginReadOnly(s), s).toBe(s);
      }
    });

    it("refuses SQL whose quoting never closes: where it ends is what decides everything else", () => {
      for (const s of [
        "SELECT 'unterminated", 'SELECT "unterminated', "SELECT E'unterminated",
        "SELECT $$unterminated", "SELECT $tag$unterminated$tag", "SELECT 1 /* unterminated",
        "SELECT 1 /* /* unterminated */", "SELECT 'a' || 'b",
      ]) {
        expect(() => rewriteBeginReadOnly(s), s).toThrow(ReadOnlyRefusedError);
      }
    });

    it("refuses a transaction-start whose modes it cannot parse, rather than sending it as written", () => {
      for (const s of ["begin isolation level bogus", "BEGIN SOMETHING ELSE", "start transaction read"]) {
        expect(() => rewriteBeginReadOnly(s), s).toThrow(ReadOnlyRefusedError);
      }
    });

    it("leaves every other statement alone, object identity included", () => {
      for (const s of [
        "SELECT 1", "BEGINNING", "PREPARE p AS SELECT 1", "EXECUTE p",
        ...SAVEPOINT_FORMS, "INSERT INTO t VALUES (1)", "",
      ]) {
        expect(rewriteBeginReadOnly(s), s).toBe(s);
      }
      const cfg = { text: "SELECT 1" };
      expect(rewriteBeginReadOnly(cfg)).toBe(cfg);
    });

    it("refuses every transaction-ending form: ending the transaction is ending the guard", () => {
      for (const s of TX_END_FORMS) {
        expect(() => rewriteBeginReadOnly(s), s).toThrow(ReadOnlyRefusedError);
        expect(() => rewriteBeginReadOnly({ text: s }), s).toThrow(/DECISION-LEDGER #43/);
        // Refused whether or not a transaction is open: there is no context in which a caller may end one.
        expect(() => rewriteBeginReadOnly(s, { inTransaction: true }), s).toThrow(ReadOnlyRefusedError);
      }
    });

    it("refuses every CALL form: a procedure body can COMMIT where no rule here can see it", () => {
      for (const s of CALL_FORMS) {
        expect(() => rewriteBeginReadOnly(s), s).toThrow(ReadOnlyRefusedError);
        expect(() => rewriteBeginReadOnly({ text: s }), s).toThrow(/DECISION-LEDGER #43/);
        // Refused whether or not a transaction is open: there is no context in which a CALL is safe.
        expect(() => rewriteBeginReadOnly(s, { inTransaction: true }), s).toThrow(ReadOnlyRefusedError);
        // And off previews it is passed through exactly as written: production behaviour is untouched.
        expect(rewriteBeginReadOnlyForEnv({ VERCEL_ENV: "production" }, s), s).toBe(s);
      }
    });

    it("refuses CALL separated from its procedure by a non-ASCII space, whichever way it lexes", () => {
      // Postgres reads `CALL\u00A0p()` as the one identifier `call p` (a syntax error), because every
      // non-ASCII byte continues an identifier there; a driver, a pooler or a paste that normalises
      // the space hands it a real CALL. The guard cannot know which, so it refuses either way.
      for (const [c, name] of UNICODE_SPACES) {
        for (const s of [`CALL${c}p()`, `call${c}ops.p()`, `CALL${c}${c}p()`]) {
          expect(() => rewriteBeginReadOnly(s), name).toThrow(ReadOnlyRefusedError);
          expect(() => rewriteBeginReadOnly({ text: s }), name).toThrow(/DECISION-LEDGER #43/);
          expect(() => rewriteBeginReadOnly(s, { inTransaction: true }), name).toThrow(ReadOnlyRefusedError);
          // Off previews nothing changes: production still sends exactly what it was given.
          expect(rewriteBeginReadOnlyForEnv({ VERCEL_ENV: "production" }, s), name).toBe(s);
        }
      }
      // Fail closed includes the cases Postgres would read as a plain identifier: `call\u00A0back` is
      // one name to the server and refused here, while `callback` — the name an app really does use —
      // keeps running (CALL_NON_FORMS).
      expect(() => rewriteBeginReadOnly("call\u00a0back")).toThrow(ReadOnlyRefusedError);
      expect(rewriteBeginReadOnly("callback")).toBe("callback");
    });

    it("spells out the whole Unicode space list, so none of them is forgotten", () => {
      // Derived from JS' own `\s`, minus the plain ASCII run Postgres agrees is whitespace: that is
      // every space a driver, an editor or a paste can produce which the server reads as identifier
      // text instead. A new one cannot appear in the language without this list — and the guard's —
      // being updated to match. U+0085 is in the list and not in `\s`: Unicode calls it whitespace,
      // JS does not, and the guard follows Unicode because the drivers and the humans do.
      const jsSpaces = [...Array(0x10000).keys()]
        .map((c) => String.fromCharCode(c))
        .filter((c) => /\s/.test(c) && !/^[ \t\n\r]$/.test(c));
      expect(jsSpaces).toHaveLength(21);
      expect(new Set(UNICODE_SPACES.map(([c]) => c))).toEqual(new Set([...jsSpaces, "\u0085"]));
    });

    it("leaves the word `call` alone in a literal, a quoted name, a comment or a longer identifier", () => {
      for (const s of CALL_NON_FORMS) {
        expect(rewriteBeginReadOnly(s), s).toBe(s); // untouched, object identity included
        expect(rewriteBeginReadOnly(s, { inTransaction: true }), s).toBe(s);
      }
    });

    it("never lets a non-ASCII space carry a statement past an allowlist", () => {
      // The savepoint and `SET LOCAL <timeout>` allowlists are exceptions to a refusal, and they
      // spell their gaps `\s` — which in JS matches NBSP too. A statement whose gaps are not the
      // server's own whitespace is not the statement the allowlist describes, so it stays refused.
      for (const [c, name] of UNICODE_SPACES) {
        for (const s of [
          `ROLLBACK${c}TO SAVEPOINT sp1`,
          `ROLLBACK TO${c}SAVEPOINT sp1`,
          `rollback${c}to${c}sp1`,
          `SET${c}LOCAL statement_timeout = '5s'`,
          `SET LOCAL${c}statement_timeout = '5s'`,
          `set local statement_timeout${c}= '5s'`,
        ]) {
          expect(() => rewriteBeginReadOnly(s), `${name}: ${s}`).toThrow(ReadOnlyRefusedError);
        }
      }
      // …and the ASCII spellings of both are still allowed, unchanged.
      expect(rewriteBeginReadOnly("ROLLBACK TO SAVEPOINT sp1")).toBe("ROLLBACK TO SAVEPOINT sp1");
      expect(rewriteBeginReadOnly("SET LOCAL statement_timeout = '5s'")).toBe(
        "SET LOCAL statement_timeout = '5s'",
      );
    });

    it("refuses a CALL hidden among other statements, from either side of the `;`", () => {
      for (const s of [
        "SELECT 1; CALL p()", "select 1; call p()", "CALL p(); SELECT 1",
        "SELECT 1;\nCALL ops.p()", "SELECT '--'; CALL p()", "CALL p(); CALL p()",
        "SELECT 1 AS x$a$; CALL p(); SELECT 1 AS y$a$",
      ]) {
        expect(() => rewriteBeginReadOnly(s), s).toThrow(ReadOnlyRefusedError);
      }
    });

    it("allows savepoint work, which cannot end the transaction", () => {
      for (const s of SAVEPOINT_FORMS) {
        expect(rewriteBeginReadOnly(s), s).toBe(s);
        expect(rewriteBeginReadOnly(s, { inTransaction: true }), s).toBe(s);
      }
    });

    it("refuses a ROLLBACK TO that is not purely a savepoint rollback", () => {
      for (const s of ["rollback to savepoint sp1 and chain", "ROLLBACK TO", "rollback and chain to sp1"]) {
        expect(() => rewriteBeginReadOnly(s), s).toThrow(ReadOnlyRefusedError);
      }
    });

    it("refuses a transaction start inside an already-open guarded transaction", () => {
      for (const s of ["begin", "BEGIN READ ONLY", "begin work", "START TRANSACTION",
        "begin isolation level serializable", "BEGIN TRANSACTION READ WRITE"]) {
        expect(rewriteBeginReadOnly(s), s).toMatch(/\bREAD ONLY$/); // fine with none open
        expect(() => rewriteBeginReadOnly(s, { inTransaction: true }), s).toThrow(ReadOnlyRefusedError);
      }
    });

    it("refuses a RESET of the read-only mode, and any DISCARD", () => {
      for (const s of [
        "RESET ALL", "reset all",
        "RESET transaction_read_only", "reset default_transaction_read_only",
        "DISCARD ALL", "discard all", "DISCARD SEQUENCES",
      ]) {
        expect(() => rewriteBeginReadOnly(s), s).toThrow(ReadOnlyRefusedError);
      }
      // Any other RESET is refused too: see the SET/RESET tests above.
      expect(() => rewriteBeginReadOnly("RESET search_path")).toThrow(ReadOnlyRefusedError);
    });

    it("the refusal names the directive and carries the SQL, never any parameter", () => {
      const err = (() => { try { rewriteBeginReadOnly("begin; insert into t values ($1)"); } catch (e) { return e; } })();
      expect(err).toBeInstanceOf(ReadOnlyRefusedError);
      expect((err as ReadOnlyRefusedError).statement).toBe("begin; insert into t values ($1)");
      expect((err as Error).message).toContain("DECISION-LEDGER #43");
      expect((err as Error).message).not.toContain("://");
    });
  });

  describe("rewriteBeginReadOnlyForEnv", () => {
    it("rewrites on previews only", () => {
      expect(rewriteBeginReadOnlyForEnv({ VERCEL_ENV: "preview" }, "begin read write")).toBe(BEGIN_READ_ONLY);
      expect(() => rewriteBeginReadOnlyForEnv({ VERCEL_ENV: "preview" }, "begin; insert into t values (1)"))
        .toThrow(ReadOnlyRefusedError);
    });

    it("passes everything through untouched off previews", () => {
      for (const env of ["production", "development", undefined]) {
        for (const s of ["begin", "BEGIN READ WRITE", "begin isolation level serializable read write",
          "SET TRANSACTION READ WRITE", "begin; insert into t values (1)"]) {
          expect(rewriteBeginReadOnlyForEnv({ VERCEL_ENV: env }, s), s).toBe(s);
        }
      }
    });
  });

  describe("isTransactionStart", () => {
    it("sees a transaction start through case, padding and comments only", () => {
      for (const s of ["begin", "BEGIN ", "  begin transaction ", "/* drizzle */ begin -- go\n",
        "START TRANSACTION", "begin isolation level serializable"]) {
        expect(isTransactionStart(s), s).toBe(true);
      }
      for (const s of ["COMMIT", "SELECT 1", "BEGINNING", "SELECT 'begin'", "begin; select 1", ""]) {
        expect(isTransactionStart(s), s).toBe(false);
      }
    });
  });

  describe("readOnlyGuard", () => {
    it("opens and closes the transaction through its own path, not the caller's", async () => {
      const { sent, send } = fakeWire();
      const g = readOnlyGuard(send);
      expect(g.open).toBe(false);
      await g.begin();
      expect(g.open).toBe(true);
      await g.query("SELECT 1");
      await g.commit();
      expect(g.open).toBe(false);
      expect(sent).toEqual([BEGIN_READ_ONLY, "SELECT 1", "COMMIT"]);
    });

    it("refuses every transaction-ending form a caller sends, with nothing reaching the wire", async () => {
      for (const stmt of TX_END_FORMS) {
        const { sent, send } = fakeWire();
        const g = readOnlyGuard(send);
        await g.begin();
        expect(() => g.query(stmt), stmt).toThrow(/DECISION-LEDGER #43/);
        expect(sent, stmt).toEqual([BEGIN_READ_ONLY]); // the refusal is synchronous: nothing was sent
        expect(g.open, stmt).toBe(true); // ... and the read-only transaction is still open
        await g.commit();
        expect(sent, stmt).toEqual([BEGIN_READ_ONLY, "COMMIT"]);
      }
    });

    it("refuses a second transaction start while its own transaction is open", async () => {
      const { sent, send } = fakeWire();
      const g = readOnlyGuard(send);
      await g.begin();
      for (const stmt of ["begin", "START TRANSACTION", "begin isolation level serializable read write"]) {
        expect(() => g.query(stmt), stmt).toThrow(/DECISION-LEDGER #43/);
      }
      expect(sent).toEqual([BEGIN_READ_ONLY]);
    });

    it("opens READ ONLY for the caller's own transaction start when none is open yet", async () => {
      const { sent, send } = fakeWire();
      const g = readOnlyGuard(send);
      await g.query("begin isolation level serializable read write");
      expect(g.open).toBe(true);
      expect(sent).toEqual(["BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY"]);
    });

    it("gives a statement its own read-only transaction when none is open, so none runs in autocommit", async () => {
      const { sent, send } = fakeWire();
      const g = readOnlyGuard(send);
      await g.query("INSERT INTO t VALUES (1)");
      expect(sent).toEqual([BEGIN_READ_ONLY, "INSERT INTO t VALUES (1)", "COMMIT"]);
      expect(g.open).toBe(false);
    });

    it("rolls that one back when it fails", async () => {
      const { sent, send } = fakeWire(/INSERT/);
      const g = readOnlyGuard(send);
      await expect(g.query("INSERT INTO t VALUES (1)")).rejects.toThrow("boom");
      expect(sent).toEqual([BEGIN_READ_ONLY, "INSERT INTO t VALUES (1)", "ROLLBACK"]);
      expect(g.open).toBe(false);
    });

    it("closes at most once, so a double close sends no stray COMMIT", async () => {
      const { sent, send } = fakeWire();
      const g = readOnlyGuard(send);
      await g.begin();
      await g.commit();
      await g.commit();
      await g.rollback();
      expect(sent).toEqual([BEGIN_READ_ONLY, "COMMIT"]);
    });
  });

  describe("passThroughGuard (everywhere but previews)", () => {
    it("sends the plain framing and every caller statement exactly as written", async () => {
      const { sent, send } = fakeWire();
      const g = passThroughGuard(send);
      await g.begin();
      await g.query("BEGIN READ WRITE");
      await g.query("SET TRANSACTION READ WRITE");
      await g.query("INSERT INTO t VALUES (1)");
      await g.query("COMMIT");
      await g.commit();
      await g.rollback();
      expect(sent).toEqual([
        "BEGIN", "BEGIN READ WRITE", "SET TRANSACTION READ WRITE", "INSERT INTO t VALUES (1)",
        "COMMIT", "COMMIT", "ROLLBACK",
      ]);
      expect(sent.join(" | ")).not.toMatch(/READ ONLY/i);
    });
  });

  describe("txGuardForEnv", () => {
    it("guards on previews and passes through everywhere else", async () => {
      const preview = fakeWire();
      const gp = txGuardForEnv({ VERCEL_ENV: "preview" }, preview.send);
      await gp.begin();
      expect(() => gp.query("COMMIT")).toThrow(/DECISION-LEDGER #43/);
      expect(preview.sent).toEqual([BEGIN_READ_ONLY]);

      for (const env of ["production", "development", undefined]) {
        const other = fakeWire();
        const g = txGuardForEnv({ VERCEL_ENV: env }, other.send);
        await g.begin();
        await g.query("COMMIT");
        await g.query("begin read write");
        expect(other.sent, String(env)).toEqual(["BEGIN", "COMMIT", "begin read write"]);
      }
    });
  });

  it("gives routes a skip body on previews and null elsewhere", () => {
    expect(previewSkip({ VERCEL_ENV: "preview" })).toEqual({ skipped: "preview read-only", reason: READ_ONLY_REASON });
    expect(previewSkip({ VERCEL_ENV: "production" })).toBeNull();
    expect(previewSkip({})).toBeNull();
  });

  it("the reason cites the single-DB directive and leaks no URL", () => {
    expect(READ_ONLY_REASON).toContain("DECISION-LEDGER #43");
    expect(READ_ONLY_REASON).not.toContain("://");
  });
});
