import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "@neondatabase/serverless";
import type { ClientLike, PoolLike } from "./pool";
import type { SqlLike } from "./read-only";

/**
 * Property/fuzz proof for the preview read-only guard (DECISION-LEDGER #43), against real Postgres.
 *
 * The guard's whole job is to decide, from SQL text alone, whether a string is ONE statement that the
 * server will lex the way this app lexes it. Every bypass found so far has been a disagreement about
 * lexing, not about keywords: a `;` hidden in a literal or a comment (PR #20 blocker 3), a `$` inside
 * an identifier read as a dollar-quote opener (reviewer bypass 1), a `SET` that changes the lexing of
 * everything after it (reviewer bypass 2). So the property worth testing is not "this list of strings
 * is refused" but the invariant itself:
 *
 *     for ANY SQL string a caller sends through a preview path, no row is ever written.
 *
 * Below, {@link CASES} random SQL strings are generated from a fixed seed — a deterministic PRNG in
 * this file, no new dependency and no run-to-run variation, so a failure here is reproducible from the
 * seed alone — out of the lexical constructs that have done the hiding: `'…'` with `''` doubling,
 * `E'…'` with backslash escapes, `"…"` names, `$tag$`/`$$` dollar quotes, identifiers containing `$`,
 * `--` and nested block comments, SET/RESET/set_config/DO variants, and transaction-ending tails that
 * carry `INSERT INTO smuggle VALUES (1)` behind them. Each case is run through the guard on BOTH
 * statement paths (autocommit and transaction), on one real Postgres backend, and the table is checked
 * after every single one.
 *
 * Some cases are deliberately two calls, a session-state change followed by an exploit, because that
 * is the shape of the lexing attack: the SET and the statement it arms are separate statements.
 *
 * The fake wire mirrors the drivers' protocol choice exactly, as the suites in preview-read-only.test.ts
 * do: no parameters (or an empty array) means the SIMPLE query protocol, which executes every command
 * in the string. Without that, nothing here could ever write and the whole file would be vacuous.
 */
const h = vi.hoisted(() => ({ pool: undefined as PoolLike | Pool | undefined, sent: [] as string[] }));
vi.mock("./pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pool")>();
  return { ...actual, getPool: () => h.pool };
});

// (vi.mock is hoisted above this import, so exec.ts picks up the faked getPool.)
import { getNeonDb } from "./exec";

const text = (q: SqlLike) => (typeof q === "string" ? q : q.text);

/** How many random strings to generate. Each one is run on two paths, against real Postgres. */
const CASES = 2400;
/** The seed. Fixed, so the corpus is identical on every machine and every run. */
const SEED = 0x9e3779b9;

/** mulberry32: a tiny, fast, well-distributed 32-bit PRNG. Deterministic from `seed`. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The corpus, built once from {@link SEED}. Every list below is drawn from with the same PRNG. */
function corpus(): string[][] {
  const rnd = prng(SEED);
  const int = (n: number) => Math.floor(rnd() * n) % n;
  const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)];
  const maybe = (p: number) => rnd() < p;

  /** Text that goes INSIDE a literal, a comment or a quoted name: the characters that do the hiding. */
  const INNER = [
    "", " ", ";", "--", "/*", "*/", "'", '"', "\\", "\\'", "''", '""', "$$", "$a$", "\n",
    "; COMMIT; INSERT INTO smuggle VALUES (1)", "; commit;", "COMMIT", "a;b--c/*d", "x", "1",
    "; SET standard_conforming_strings = off", "e'", "E'\\'", "$tag$", "; ROLLBACK;", "*/ COMMIT; /*",
    "\r", "\r\n", "\rCOMMIT; INSERT INTO smuggle VALUES (1)", "\n-- ",
  ];
  const inner = () => {
    let s = "";
    for (let i = int(3) + 1; i > 0; i -= 1) s += pick(INNER);
    return s;
  };
  /** Dollar-quote tags, and identifier stems to glue a `$` onto. */
  const TAGS = ["", "a", "tag", "a1_b", "_x", "é", "A", "x"];
  const STEMS = ["x", "y", "a1", "_x", "é", "col", "X"];

  /** One lexical chunk: a literal, a name, a comment, or a bare identifier that contains a `$`. */
  const CHUNKS: (() => string)[] = [
    () => `'${inner()}'`,
    () => `'${inner()}''${inner()}'`,
    () => `${maybe(0.5) ? "E" : "e"}'${inner()}'`,
    () => `"${inner()}"`,
    () => { const t = pick(TAGS); return `$${t}$${inner()}$${t}$`; },
    () => { const t = pick(TAGS); return `$${t}$${inner()}`; }, // sometimes unterminated: fail closed
    () => `$$${inner()}$$`,
    // An identifier whose `$` the server reads as part of the NAME, not as a quote opener, with the
    // matching second one that a scanner reading them as a quote pair would swallow everything between.
    () => `${pick(STEMS)}$${pick(TAGS)}$`,
    () => `-- ${inner()}\n`,
    () => `/* ${inner()} */`,
    () => `/* /* ${inner()} */ ${inner()} */`,
    () => `/* ${inner()}`, // unterminated block comment: fail closed
    () => pick(["1", "2", "$1", "length(", ")", "||", ",", " AS n", "*", "count(*)", "now()"]),
    () => pick(["", " ", "\n", "\t", "  "]),
  ];
  /** How a generated statement starts. */
  const HEADS = [
    "SELECT ", "select 1 as ", "SELECT 1 AS ", "SELECT length(", "select ", "WITH c AS (SELECT ",
    "", "-- lead\nSELECT ", "/* lead */ SELECT ", "SELECT * FROM (SELECT ",
  ];
  /** What is smuggled behind the chunks. Every one of these writes if the string is split wrong. */
  const TAILS = [
    "; COMMIT; INSERT INTO smuggle VALUES (1)",
    "; commit; insert into smuggle values (1)",
    "; COMMIT; INSERT INTO smuggle VALUES (1); -- '",
    "; ROLLBACK; INSERT INTO smuggle VALUES (1)",
    "; END; INSERT INTO smuggle VALUES (1)",
    "; ABORT; INSERT INTO smuggle VALUES (1)",
    "; COMMIT AND CHAIN; INSERT INTO smuggle VALUES (1)",
    "COMMIT; INSERT INTO smuggle VALUES (1)",
    "; INSERT INTO smuggle VALUES (1)",
    "; BEGIN READ WRITE; INSERT INTO smuggle VALUES (1)",
    "; COMMIT; INSERT INTO smuggle VALUES (1); SELECT 1 AS y$a$",
    "; COMMIT; INSERT INTO smuggle VALUES (1); SELECT 1 AS y$$",
    "; COMMIT; INSERT INTO smuggle VALUES (1); SELECT $$x",
    "; COMMIT; INSERT INTO smuggle VALUES (1) /* done */",
    "; COMMIT; INSERT INTO smuggle VALUES (1) -- done\n",
    "",
    "",
  ];
  /** Session/lexing state changes, as a first call that would arm the statement after it. */
  const STATE = [
    "SET standard_conforming_strings = off",
    "set standard_conforming_strings to off",
    "SET SESSION standard_conforming_strings = off",
    "SET LOCAL standard_conforming_strings = off",
    "RESET standard_conforming_strings",
    "SET backslash_quote = on",
    "SET escape_string_warning = off",
    "RESET ALL",
    "SET search_path TO ops",
    "SET TRANSACTION READ WRITE",
    "SET LOCAL transaction_read_only = off",
    "SET LOCAL statement_timeout = '5s'", // allowlisted: this one is expected to run
    "SELECT set_config('standard_conforming_strings','off',false)",
    'SELECT pg_catalog."set_config"(\'standard_conforming_strings\',\'off\',false)',
    "SELECT * FROM set_config('standard_conforming_strings','off',false)",
    "DO $$ BEGIN PERFORM set_config('standard_conforming_strings','off',false); END $$",
    "DISCARD ALL",
  ];
  /** The exploits that a lexing change arms: harmless while the lexing is the standard one. */
  const ARMED = [
    "SELECT '\\''; COMMIT; INSERT INTO smuggle VALUES (1); -- '",
    "SELECT '\\'; COMMIT; INSERT INTO smuggle VALUES (1); -- '",
    "select '\\''; commit; insert into smuggle values (1); -- '",
    "SELECT 'a\\''; COMMIT; INSERT INTO smuggle VALUES (1); -- '",
    "SELECT $$x$$ || '\\''; COMMIT; INSERT INTO smuggle VALUES (1); -- '",
  ];

  /**
   * Coherent attack shapes, randomised. Pure soup is mostly invalid SQL, which the server rejects as a
   * whole — so a share of the corpus is built to PARSE, because a string only writes if the server
   * actually runs it. Each template is the shape of a known escape with its tag, keyword, case,
   * padding and comments drawn fresh: the point is that the *shape* is refused, not one spelling of it.
   */
  const TX_ENDS = ["COMMIT", "commit", "END", "end", "ROLLBACK", "rollback", "ABORT",
    "COMMIT WORK", "commit and chain", "COMMIT TRANSACTION"];
  // `\r` is in here deliberately: Postgres ends a `--` comment at a bare CR as well as at a newline.
  const pad = () => pick(["", " ", "  ", "\n", "\t", " /* c */ ", " -- c\n", "\n-- c\n",
    "\r", " -- c\r", " -- c\r\n", "\r\n"]);
  const sel = () => pick(["SELECT", "select", "SeLeCt", "/* q */ SELECT", "-- q\nSELECT"]);
  const write = () => `INSERT INTO smuggle VALUES (1)`;
  const TEMPLATES: (() => string)[] = [
    // The `$` inside an identifier (reviewer bypass 1): `x$a$` is ONE name to the server, so the `;`
    // after it is top-level — and the matching `y$a$` at the end is what a scanner that reads the pair
    // as a dollar quote would swallow everything between.
    () => {
      const t = pick(TAGS);
      return `${sel()} 1 AS ${pick(STEMS)}$${t}$;${pad()}${pick(TX_ENDS)};${pad()}${write()};${pad()}`
        + `${sel()} 1 AS ${pick(STEMS)}$${t}$`;
    },
    () => {
      const t = pick(TAGS);
      return `${sel()} ${pick(STEMS)}$${t}$ FROM t;${pad()}${pick(TX_ENDS)};${pad()}${write()};`
        + `${pad()}${sel()} 1 AS ${pick(STEMS)}$${t}$`;
    },
    // The same trick against the E-string rule: in `x$E'…'` the `E` is the tail of the identifier
    // `x$E`, so `'\\'` is a complete plain string and the `;` after it is top-level.
    () => `${sel()} 1 AS ${pick(STEMS)}$E'\\';${pad()}${pick(TX_ENDS)};${pad()}${write()};${pad()}-- '`,
    // A `;` inside a literal, a quoted name or a comment (PR #20 blocker 3), in every container.
    () => `${sel()} '${pick(INNER)}';${pad()}${pick(TX_ENDS)};${pad()}${write()}`,
    () => `${sel()} ${pick(["E", "e"])}'\\'${pick(INNER)}';${pad()}${pick(TX_ENDS)};${pad()}${write()}`,
    () => { const t = pick(TAGS); return `${sel()} $${t}$${pick(INNER)}$${t}$;${pad()}${pick(TX_ENDS)};${pad()}${write()}`; },
    () => `${sel()} 1 AS "${pick(INNER)}";${pad()}${pick(TX_ENDS)};${pad()}${write()}`,
    () => `${sel()} 1 /* /* ${pick(INNER)} */ ${pick(INNER)} */;${pad()}${pick(TX_ENDS)};${pad()}${write()}`,
    // No hiding at all: a plain second statement, and a transaction start that must come back READ ONLY.
    () => `${sel()} 1;${pad()}${write()}`,
    () => `${sel()} 1;${pick([" -- c\r", "--\r", " -- x\r"])}${pick(TX_ENDS)};${pad()}${write()}`,
    () => `${sel()} 1${pick([" -- c\r", "--\r"])}${pick(TX_ENDS)};${pad()}${write()}`,
    () => `BEGIN READ WRITE;${pad()}${write()}`,
    () => `${pick(TX_ENDS)};${pad()}${write()}`,
  ];

  const cases: string[][] = [];
  while (cases.length < CASES) {
    if (maybe(1 / 6)) {
      // The two-call shape: change state, then send the statement that change would arm.
      cases.push([pick(STATE), pick(ARMED)]);
      continue;
    }
    if (maybe(0.4)) { cases.push([pick(TEMPLATES)()]); continue; }
    let sql = pick(HEADS);
    for (let i = int(4) + 1; i > 0; i -= 1) sql += CHUNKS[int(CHUNKS.length)]();
    sql += pick(TAILS);
    cases.push([sql]);
  }
  return cases;
}

describe("preview read-only guard: property fuzz against real Postgres (DECISION-LEDGER #43)", () => {
  let backend: PGlite;
  /** The backend's own default `search_path`, captured before any case runs. */
  let searchPath: string;

  beforeAll(async () => {
    backend = new PGlite();
    await backend.exec("CREATE TABLE smuggle (id int)");
    const run = async (q: SqlLike, params?: unknown[]) => {
      h.sent.push(text(q));
      if (params && params.length > 0) {
        return { rows: (await backend.query(text(q), params)).rows as unknown[] };
      }
      const results = await backend.exec(text(q)); // simple protocol: every command in the string runs
      return { rows: (results[results.length - 1]?.rows ?? []) as unknown[] };
    };
    const client: ClientLike = { query: run, release: () => {} };
    const p = Object.create(Pool.prototype) as Pool;
    Object.assign(p, { query: run, connect: async () => client });
    h.pool = p;
    searchPath = (await backend.query<Record<string, string>>("SHOW search_path")).rows[0].search_path;
    process.env.VERCEL_ENV = "preview";
  }, 60_000);

  afterAll(() => { delete process.env.VERCEL_ENV; });

  it(`writes nothing for ${CASES} random SQL strings, on the autocommit and transaction paths`, async () => {
    const CORPUS = corpus();
    expect(CORPUS).toHaveLength(CASES);
    const rows = async () =>
      (await backend.query<{ n: number }>("SELECT count(*)::int n FROM smuggle")).rows[0].n;

    /** Send one case's statements in order, on one path, swallowing refusals and server errors alike. */
    const paths: { name: string; run: (stmts: string[]) => Promise<void> }[] = [
      {
        name: "autocommit",
        run: async (stmts) => {
          for (const s of stmts) await getNeonDb().query(s, []).then(() => {}, () => {});
        },
      },
      {
        name: "transaction",
        run: async (stmts) => {
          await getNeonDb().tx(async (tx) => {
            for (const s of stmts) await tx.query(s, []).then(() => {}, () => {});
          }).catch(() => {});
        },
      },
    ];

    let ran = 0; // statements the guard let through that the server then accepted
    for (const [i, stmts] of CORPUS.entries()) {
      for (const path of paths) {
        h.sent.length = 0; // the corpus is large: keep the transcript to the case being run
        await path.run(stmts);
        ran += h.sent.filter((s) => !/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(s)).length;
        // The invariant, checked after every single case on every path: nothing was written.
        const n = await rows().catch(async () => {
          await backend.exec("ROLLBACK").catch(() => {});
          return rows();
        });
        expect(n, `case ${i} on the ${path.name} path (seed ${SEED}): ${JSON.stringify(stmts)}`).toBe(0);
      }
    }

    // The corpus has teeth: a good share of it really did reach the server, so the invariant above was
    // tested against Postgres and not just against the guard's refusals.
    expect(ran).toBeGreaterThan(100);
    // And no case changed the lexing the guard assumes, or the access mode, on the shared backend.
    const guc = async (name: string) =>
      (await backend.query<Record<string, string>>(`SHOW ${name}`)).rows[0][name];
    expect(await guc("standard_conforming_strings")).toBe("on");
    expect(await guc("transaction_read_only")).toBe("off");
    expect(await guc("statement_timeout")).toBe("0");
    expect(await guc("search_path")).toBe(searchPath);
  }, 120_000);

  /**
   * The control for the test above, and the thing that keeps it honest: the same corpus, sent to its
   * own backend with NO guard in front of it, writes rows. A corpus of strings Postgres rejects as
   * syntax errors would pass the invariant for the wrong reason forever; this says how many of these
   * strings really are a `COMMIT` plus a write that the server will run, given the chance.
   */
  it("the corpus has teeth: unguarded, those same strings write rows", async () => {
    const raw = new PGlite();
    try {
      await raw.exec("CREATE TABLE smuggle (id int)");
      const rows = async () =>
        (await raw.query<{ n: number }>("SELECT count(*)::int n FROM smuggle")).rows[0].n;
      let wrote = 0;
      for (const stmts of corpus()) {
        await raw.exec("BEGIN READ ONLY").catch(() => {});
        for (const s of stmts) await raw.exec(s).catch(() => {});
        await raw.exec("ROLLBACK").catch(() => {});
        if ((await rows().catch(() => 0)) > 0) {
          wrote += 1;
          await raw.exec("DELETE FROM smuggle").catch(() => {});
        }
        // The raw run really does change session state (that is the point of the SET cases), so put
        // the backend back the way it was before the next case.
        await raw.exec("RESET ALL").catch(() => {});
      }
      expect(wrote).toBeGreaterThan(100);
    } finally {
      await raw.close();
    }
  }, 180_000);
});
