import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "@neondatabase/serverless";
import { sql as drizzleSql } from "drizzle-orm";
import { readOnlyPool, type ClientLike, type PoolLike } from "./pool";
import { BEGIN_READ_ONLY, type SqlLike } from "./read-only";

/**
 * End-to-end proof against real Postgres (PGlite): on a preview a write fails in the server, in both the
 * transaction and the autocommit path, while reads still work — and off previews nothing changes and the
 * string "READ ONLY" is never sent. Only getPool() is faked (PGlite stands in for the Neon pool); the
 * read-only plumbing under test is the real one.
 */
const h = vi.hoisted(() => ({ pool: undefined as PoolLike | Pool | undefined, sent: [] as string[] }));
vi.mock("./pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pool")>();
  return { ...actual, getPool: () => h.pool };
});

// (vi.mock is hoisted above these imports, so exec.ts and client.ts pick up the faked getPool.)
import { getNeonDb } from "./exec";
import { getDb } from "./client";
import { withClientExec } from "@/auth/client-exec";

const text = (q: SqlLike) => (typeof q === "string" ? q : q.text);
let pg: PGlite;

/** `p` rejected, with `why` somewhere in the error chain. Drizzle wraps errors, so walk the causes. */
const expectRejected = async (p: PromiseLike<unknown>, why: RegExp, what: string) => {
  const err: unknown = await p.then(() => undefined, (e: unknown) => e ?? new Error("rejected with no error"));
  expect(err, `expected ${what}`).toBeInstanceOf(Error);
  const chain: string[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) chain.push(e.message);
  expect(chain.join(" <- "), what).toMatch(why);
};
/** Postgres itself refused the write, because the transaction it ran in is READ ONLY. */
const expectRefusedReadOnly = (p: PromiseLike<unknown>) =>
  // `in a read-only transaction` is Postgres' own wording; the app's refusal says "escape the
  // read-only transaction", so this cannot be satisfied by an app-side refusal by accident.
  expectRejected(p, /in a read-only transaction/, "the write to be refused by the server");
/** The app refused the statement before sending it, because it could not be made read-only. */
const expectRefusedByApp = (p: PromiseLike<unknown>) =>
  expectRejected(p, /DECISION-LEDGER #43/, "the statement to be refused by the app");

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec("CREATE TABLE t (id int primary key)");
  const run = async (q: SqlLike, params?: unknown[]) => {
    h.sent.push(text(q));
    return { rows: (await pg.query(text(q), params as unknown[] | undefined)).rows as unknown[] };
  };
  const client: ClientLike = { query: run, release: () => {} };
  h.pool = { query: run, connect: async () => client };
}, 60_000);

beforeEach(() => { h.sent.length = 0; });
afterEach(async () => { delete process.env.VERCEL_ENV; await pg.query("ROLLBACK").catch(() => {}); });

describe("VERCEL_ENV=preview (DECISION-LEDGER #43)", () => {
  beforeEach(() => { process.env.VERCEL_ENV = "preview"; });

  it("a write inside getNeonDb().tx is rejected by Postgres", async () => {
    await expect(getNeonDb().tx((tx) => tx.query("INSERT INTO t VALUES (1)", [])))
      .rejects.toThrow(/read-only transaction/);
    expect(h.sent[0]).toBe("BEGIN READ ONLY");
    expect(h.sent).toContain("ROLLBACK");
  });

  it("an autocommit write is rejected by Postgres too", async () => {
    await expect(getNeonDb().query("INSERT INTO t VALUES (2)", [])).rejects.toThrow(/read-only transaction/);
    expect(h.sent).toEqual(["BEGIN READ ONLY", "INSERT INTO t VALUES (2)", "ROLLBACK"]);
  });

  it("nothing a preview tried leaked into the table", async () => {
    const r = await pg.query<{ n: number }>("SELECT count(*)::int n FROM t");
    expect(r.rows[0].n).toBe(0);
  });

  it("reads still work, autocommit and in a transaction", async () => {
    expect((await getNeonDb().query<{ n: number }>("SELECT 1 n", [])).rows).toEqual([{ n: 1 }]);
    const inTx = await getNeonDb().tx((tx) => tx.query<{ n: number }>("SELECT 2 n", []));
    expect(inTx.rows).toEqual([{ n: 2 }]);
  });

  it("the read-only mode never outlives the transaction: the next statement on that connection is unaffected", async () => {
    await getNeonDb().query("SELECT 1", []);
    await pg.query("INSERT INTO t VALUES (99)"); // same connection, plain autocommit: still writable
    expect((await pg.query<{ n: number }>("SELECT count(*)::int n FROM t WHERE id = 99")).rows[0].n).toBe(1);
    await pg.query("DELETE FROM t WHERE id = 99");
  });

  it("withClientExec (scripts) refuses before it opens a connection", async () => {
    let ran = false;
    await expect(withClientExec("postgres://unused/db", async () => { ran = true; }))
      .rejects.toThrow(/DECISION-LEDGER #43/);
    expect(ran).toBe(false);
  });
});

describe("VERCEL_ENV=production: behaviour is exactly unchanged", () => {
  beforeEach(() => { process.env.VERCEL_ENV = "production"; });

  it("writes work in a transaction and in autocommit, and no READ ONLY is ever sent", async () => {
    await getNeonDb().tx((tx) => tx.query("INSERT INTO t VALUES (10)", []));
    await getNeonDb().query("INSERT INTO t VALUES (11)", []);
    const r = await pg.query<{ n: number }>("SELECT count(*)::int n FROM t WHERE id IN (10, 11)");
    expect(r.rows[0].n).toBe(2);
    expect(h.sent.join(" | ")).not.toMatch(/READ ONLY/i);
    expect(h.sent[0]).toBe("BEGIN");
  });

  it("autocommit queries go straight to the pool: no BEGIN, no COMMIT", async () => {
    await getNeonDb().query("SELECT 1", []);
    expect(h.sent).toEqual(["SELECT 1"]);
  });
});

/**
 * PgBouncer transaction mode, simulated explicitly (DECISION-LEDGER #43/#55).
 *
 * The pooled DATABASE_URL goes through PgBouncer in transaction mode: unrelated clients take turns on
 * the SAME server backend, one transaction at a time, and previews and production share one role,
 * database and endpoint — so a preview's transaction and production's next transaction really can land
 * on the same backend seconds apart. Everything below therefore runs against ONE PGlite backend handed
 * out by a fake Pool from both connect() and query(), and proves:
 *   (a) a preview write is refused on every pooled path — getNeonDb().tx, getNeonDb().query, drizzle;
 *   (b) nothing leaks: after preview activity the backend still reports transaction_read_only = off and
 *       default_transaction_read_only = off, and the very next production client writes on it;
 *   (c) production writes work through that same pooled path and are never sent a READ ONLY or a SET.
 */
describe("PgBouncer transaction mode: previews and production take turns on one server backend", () => {
  let backend: PGlite;
  let outerPool: PoolLike | Pool | undefined;
  let checkedOut = 0;

  beforeAll(async () => {
    backend = new PGlite();
    await backend.exec("CREATE TABLE shared (id int primary key)");
    const run = async (q: SqlLike, params?: unknown[]) => {
      h.sent.push(text(q));
      return { rows: (await backend.query(text(q), params as unknown[] | undefined)).rows as unknown[] };
    };
    // One backend for everybody: every checked-out "client" and every pool.query() is the same session,
    // exactly as PgBouncer reuses a server connection across clients.
    const client: ClientLike = { query: run, release: () => { checkedOut -= 1; } };
    // Object.create(Pool.prototype) rather than a literal: drizzle's neon-serverless session only checks a
    // client out for a transaction when what it was handed is `instanceof Pool` (see readOnlyPool).
    const bouncer = Object.create(Pool.prototype) as Pool;
    Object.assign(bouncer, { query: run, connect: async () => { checkedOut += 1; return client; } });
    outerPool = h.pool;
    h.pool = bouncer;
  }, 60_000);

  afterAll(() => { h.pool = outerPool; });
  afterEach(async () => { await backend.query("ROLLBACK").catch(() => {}); });

  /** Run `fn` as one deployment and return only the SQL that reached the backend while it ran. */
  const asEnv = async (env: string, fn: () => Promise<void>) => {
    process.env.VERCEL_ENV = env;
    const from = h.sent.length;
    await fn();
    return h.sent.slice(from);
  };
  /** Read a GUC off the backend itself, out of band — not through the pool. */
  const show = async (name: string) =>
    (await backend.query<Record<string, string>>(`SHOW ${name}`)).rows[0][name];
  const ids = async () =>
    (await backend.query<{ id: number }>("SELECT id FROM shared ORDER BY id")).rows.map((r) => r.id);
  it("(a) a preview write is refused on every pooled path: tx, autocommit, drizzle query and drizzle tx", async () => {
    const statements = await asEnv("preview", async () => {
      await expectRefusedReadOnly(getNeonDb().tx((tx) => tx.query("INSERT INTO shared VALUES (1)", [])));
      await expectRefusedReadOnly(getNeonDb().query("INSERT INTO shared VALUES (2)", []));
      await expectRefusedReadOnly(getDb().execute(drizzleSql`INSERT INTO shared VALUES (3)`));
      // A drizzle transaction opens READ ONLY, the server refuses the write inside it, and then
      // drizzle's own `rollback` — a caller-sent transaction end — is refused by the app as well.
      await expectRefusedByApp(getDb().transaction((tx) => tx.execute(drizzleSql`INSERT INTO shared VALUES (4)`)));
    });
    // Four writes, four transactions, each one opened READ ONLY on the shared backend.
    expect(statements.filter((s) => s === BEGIN_READ_ONLY)).toHaveLength(4);
    expect(await ids()).toEqual([]);
    expect(checkedOut).toBe(0); // every client went back to the pool
  });

  it("(b) the backend goes back to the pool clean, and the next production client writes on it", async () => {
    const statements = await asEnv("preview", async () => {
      await getNeonDb().query("SELECT 1", []);
      await expectRefusedReadOnly(getNeonDb().query("INSERT INTO shared VALUES (5)", []));
      await getDb().execute(drizzleSql`SELECT 1`);
    });
    expect(statements).toContain(BEGIN_READ_ONLY);
    // Nothing the preview did is still set on the server connection PgBouncer now hands on.
    expect(await show("transaction_read_only")).toBe("off");
    expect(await show("default_transaction_read_only")).toBe("off");
    expect(checkedOut).toBe(0);

    process.env.VERCEL_ENV = "production";
    await getNeonDb().query("INSERT INTO shared VALUES (6)", []);
    expect(await ids()).toEqual([6]);
  });

  it("(b) a freshly imported module graph writes on that same backend once VERCEL_ENV flips", async () => {
    await asEnv("preview", async () => {
      await expectRefusedReadOnly(getNeonDb().query("INSERT INTO shared VALUES (7)", []));
    });
    // Read-only is decided per call, not at import time — but prove it on a fresh module graph too,
    // so a future module-level `isReadOnlyDbEnv(process.env)` cache would fail here.
    vi.resetModules();
    process.env.VERCEL_ENV = "production";
    const { getNeonDb: freshNeonDb } = await import("./exec");
    const { getDb: freshDb } = await import("./client");
    const statements = await asEnv("production", async () => {
      await freshNeonDb().query("INSERT INTO shared VALUES (8)", []);
      await freshDb().execute(drizzleSql`INSERT INTO shared VALUES (9)`);
    });
    // Exactly the two writes reached the backend: no BEGIN, no COMMIT, nothing extra.
    expect(statements).toEqual(["INSERT INTO shared VALUES (8)", "INSERT INTO shared VALUES (9)"]);
    expect(await ids()).toEqual([6, 8, 9]);
    expect(await show("default_transaction_read_only")).toBe("off");
  });

  it("(c) interleaved rounds: production keeps writing, and is never sent a READ ONLY or a SET", async () => {
    for (const round of [10, 20]) {
      const preview = await asEnv("preview", async () => {
        await expectRefusedReadOnly(getNeonDb().tx((tx) => tx.query(`INSERT INTO shared VALUES (${round})`, [])));
        expect((await getNeonDb().query<{ n: number }>("SELECT 1 n", [])).rows).toEqual([{ n: 1 }]);
      });
      expect(preview).toContain(BEGIN_READ_ONLY);

      const production = await asEnv("production", async () => {
        await getNeonDb().tx((tx) => tx.query(`INSERT INTO shared VALUES (${round + 1})`, []));
        await getNeonDb().query(`INSERT INTO shared VALUES (${round + 2})`, []);
        await getDb().execute(drizzleSql`INSERT INTO shared VALUES (${round + 3})`);
        await getDb().transaction((tx) => tx.execute(drizzleSql`INSERT INTO shared VALUES (${round + 4})`));
      });
      expect(production).toContain("BEGIN"); // the transactional path really ran, so the two below bite
      expect(production.join(" | ")).not.toMatch(/READ ONLY/i);
      expect(production.join(" | ")).not.toMatch(/\bSET\b/i);
      expect(await show("transaction_read_only")).toBe("off");
      expect(checkedOut).toBe(0);
    }
    // Two full preview→production turns on one backend: every production write landed, no preview one did.
    expect(await ids()).toEqual([6, 8, 9, 11, 12, 13, 14, 21, 22, 23, 24]);
  });
});

/**
 * Every spelling of a transaction start, proved against real Postgres on the preview path
 * (hotfix PR #20 blocker 1). Before the fix only a bare `BEGIN` was rewritten, so
 * `BEGIN ISOLATION LEVEL …`, `BEGIN READ WRITE`, `BEGIN TRANSACTION`/`WORK` and `START TRANSACTION`
 * opened a writable transaction on the shared production database. Each case below opens a transaction
 * in one of those forms through the real preview plumbing and proves the server refuses the write
 * inside it — and that the forms which cannot be rewritten never reach the server at all.
 */
describe("preview: every transaction-start form ends up READ ONLY (real Postgres)", () => {
  let backend: PGlite;
  let outerPool: PoolLike | Pool | undefined;

  beforeAll(async () => {
    backend = new PGlite();
    await backend.exec("CREATE TABLE forms (id int primary key)");
    const run = async (q: SqlLike, params?: unknown[]) => {
      h.sent.push(text(q));
      return { rows: (await backend.query(text(q), params as unknown[] | undefined)).rows as unknown[] };
    };
    const client: ClientLike = { query: run, release: () => {} };
    // Object.create(Pool.prototype): drizzle only checks a client out for a transaction when what it
    // was handed is `instanceof Pool` (see readOnlyPool).
    const p = Object.create(Pool.prototype) as Pool;
    Object.assign(p, { query: run, connect: async () => client });
    outerPool = h.pool;
    h.pool = p;
  }, 60_000);

  afterAll(() => { h.pool = outerPool; });
  beforeEach(() => { process.env.VERCEL_ENV = "preview"; });
  afterEach(async () => { await backend.query("ROLLBACK").catch(() => {}); });

  const rows = async () => (await backend.query<{ n: number }>("SELECT count(*)::int n FROM forms")).rows[0].n;

  it.each([
    "begin ",
    "BEGIN",
    "begin read write",
    "BEGIN TRANSACTION",
    "begin transaction read write",
    "BEGIN WORK",
    "begin work read write",
    "START TRANSACTION",
    "start transaction read write",
    "begin isolation level serializable",
    "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE",
    "begin isolation level repeatable read, read write",
    "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE, NOT DEFERRABLE",
    "  Start   Transaction   Read   Write  ",
    "begin /* drizzle */ read write",
  ])("%j: the write inside it is refused by Postgres", async (form) => {
    const ro = readOnlyPool(h.pool as Pool);
    const c = await ro.connect();
    const from = h.sent.length;
    await c.query(form as never);
    // What actually reached the server is a READ ONLY transaction start, never a READ WRITE one.
    expect(h.sent.slice(from)).toHaveLength(1);
    expect(h.sent[from]).toMatch(/\bREAD ONLY$/);
    expect(h.sent[from]).not.toMatch(/READ\s+WRITE/i);
    await expect(c.query("INSERT INTO forms VALUES (1)" as never)).rejects.toThrow(/read-only transaction/);
    // The caller cannot end it; releasing the client is what closes the guard's transaction.
    expect(() => c.query("ROLLBACK" as never)).toThrow(/DECISION-LEDGER #43/);
    c.release();
    expect(await rows()).toBe(0);
  });

  it.each([
    "SET TRANSACTION READ WRITE",
    "set transaction isolation level serializable, read write",
    "SET LOCAL TRANSACTION READ WRITE",
    "set session characteristics as transaction read write",
    "SET transaction_read_only = off",
    "begin; insert into forms values (2)",
    "BEGIN READ ONLY; COMMIT; INSERT INTO forms VALUES (2)",
    "commit; insert into forms values (2)",
    "begin isolation level bogus",
  ])("%j is refused before any SQL leaves the app", async (stmt) => {
    const ro = readOnlyPool(h.pool as Pool);
    const c = await ro.connect();
    const from = h.sent.length;
    expect(() => c.query(stmt as never)).toThrow(/DECISION-LEDGER #43/);
    c.release();
    expect(h.sent.slice(from)).toEqual([]);
    expect(await rows()).toBe(0);
  });

  it("drizzle's own configured transaction opens READ ONLY, so its write is refused", async () => {
    // drizzle builds `begin isolation level serializable read write not deferrable` for this config.
    for (const config of [
      { accessMode: "read write" } as const,
      { isolationLevel: "serializable", accessMode: "read write", deferrable: false } as const,
      { isolationLevel: "repeatable read" } as const,
    ]) {
      const from = h.sent.length;
      // The server refuses the write inside it; drizzle then sends its own `rollback`, which the app
      // refuses like any other caller-sent transaction end — so that is the error that comes back.
      await expectRefusedByApp(
        getDb().transaction((tx) => tx.execute(drizzleSql`INSERT INTO forms VALUES (3)`), config),
      );
      const opened = h.sent.slice(from).find((s) => /^(?:BEGIN|START)/i.test(s));
      expect(opened, JSON.stringify(config)).toMatch(/\bREAD ONLY$/);
      expect(h.sent.slice(from).join(" | "), JSON.stringify(config)).not.toMatch(/READ\s+WRITE/i);
      expect(await rows()).toBe(0);
    }
  });

  it("drizzle's setTransaction('read write') inside a transaction is refused by the app", async () => {
    // drizzle turns this config into `set transaction read write`, which would undo the READ ONLY.
    await expectRefusedByApp(getDb().transaction(async (tx) => {
      await tx.setTransaction({ accessMode: "read write" });
      await tx.execute(drizzleSql`INSERT INTO forms VALUES (4)`);
    }));
    expect(h.sent.join(" | ")).not.toMatch(/READ\s+WRITE/i);
    expect(await rows()).toBe(0);
  });

  it("getNeonDb().tx refuses a nested escape and still rolls back", async () => {
    const from = h.sent.length;
    await expectRefusedByApp(getNeonDb().tx((tx) => tx.query("COMMIT; INSERT INTO forms VALUES (5)", [])));
    expect(h.sent.slice(from)[0]).toBe(BEGIN_READ_ONLY);
    expect(h.sent.slice(from)).toContain("ROLLBACK");
    expect(h.sent.slice(from).join(" | ")).not.toMatch(/INSERT/i);
    expect(await rows()).toBe(0);
  });

  it("a nested transaction start inside getNeonDb().tx is refused, not re-negotiated", async () => {
    for (const nested of [
      "BEGIN", "begin ", "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE", "START TRANSACTION",
      "begin read only",
    ]) {
      const from = h.sent.length;
      await expectRefusedByApp(getNeonDb().tx((tx) => tx.query(nested, [])));
      // Only the guard's own BEGIN and its ROLLBACK reached the server.
      expect(h.sent.slice(from), nested).toEqual([BEGIN_READ_ONLY, "ROLLBACK"]);
      expect(await rows()).toBe(0);
    }
  });

  it("off previews every one of those forms is sent exactly as written", async () => {
    process.env.VERCEL_ENV = "production";
    const forms = [
      "BEGIN READ WRITE", "begin isolation level serializable read write", "START TRANSACTION READ WRITE",
      "SET TRANSACTION READ WRITE", "begin work",
    ];
    const from = h.sent.length;
    for (const form of forms) {
      await getNeonDb().tx(async (tx) => { await tx.query(form, []); await tx.query("ROLLBACK", []); });
    }
    expect(h.sent.slice(from).filter((s) => forms.includes(s))).toEqual(forms);
    expect(h.sent.slice(from).join(" | ")).not.toMatch(/READ ONLY/i);
    // The writable transaction production asked for really is writable.
    await getNeonDb().tx((tx) => tx.query("INSERT INTO forms VALUES (6)", []));
    expect(await rows()).toBe(1);
    await backend.query("DELETE FROM forms");
  });
});

/**
 * Every spelling of a transaction-ending statement, proved against real Postgres on the preview path
 * (hotfix PR #20 blocker 2). Before the fix a caller-sent `COMMIT` went straight through: it ended the
 * guarded READ ONLY transaction, and the next statement ran in autocommit — writable, against the one
 * production database. Each case below sends one such statement through a preview path that has the
 * guard's transaction open, and proves
 *   (a) the app refuses it and nothing reaches the server, and
 *   (b) the guarded transaction is therefore still open and still READ ONLY, so the write that follows
 *       in that same flow is refused by Postgres itself.
 * The last test is the control: off previews that very sequence is passed through and the write lands.
 */
describe("preview: a caller cannot end the guarded transaction (real Postgres)", () => {
  let backend: PGlite;
  let outerPool: PoolLike | Pool | undefined;

  /** The statements that end a transaction, or hand it to two-phase commit, in every spelling. */
  const TX_END_FORMS = [
    "COMMIT", "commit", "  Commit  ", "commit ;", "\tcommit\n",
    "COMMIT WORK", "commit transaction", "COMMIT AND CHAIN", "commit work and no chain",
    "/* drizzle */ commit -- done\n",
    "ROLLBACK", "rollback", "ROLLBACK WORK", "rollback transaction", "rollback and chain",
    "END", "end", "END WORK", "end transaction", "END AND CHAIN",
    "ABORT", "abort", "ABORT WORK", "abort transaction", "ABORT AND CHAIN",
    "PREPARE TRANSACTION 'ppec-1'", "prepare transaction 'ppec-1'",
    "COMMIT PREPARED 'ppec-1'", "commit prepared 'ppec-1'",
    "ROLLBACK PREPARED 'ppec-1'", "rollback prepared 'ppec-1'",
  ];

  beforeAll(async () => {
    backend = new PGlite();
    await backend.exec("CREATE TABLE control (id int primary key)");
    const run = async (q: SqlLike, params?: unknown[]) => {
      h.sent.push(text(q));
      return { rows: (await backend.query(text(q), params as unknown[] | undefined)).rows as unknown[] };
    };
    const client: ClientLike = { query: run, release: () => {} };
    const p = Object.create(Pool.prototype) as Pool;
    Object.assign(p, { query: run, connect: async () => client });
    outerPool = h.pool;
    h.pool = p;
  }, 60_000);

  afterAll(() => { h.pool = outerPool; });
  beforeEach(() => { process.env.VERCEL_ENV = "preview"; });
  afterEach(async () => { await backend.query("ROLLBACK").catch(() => {}); });

  const rows = async () => (await backend.query<{ n: number }>("SELECT count(*)::int n FROM control")).rows[0].n;

  it.each(TX_END_FORMS)("%j on a checked-out client: refused, and the next write is still refused", async (stmt) => {
    const ro = readOnlyPool(h.pool as Pool);
    const c = await ro.connect();
    await c.query("begin " as never); // drizzle's own opener: the guard opens READ ONLY
    const from = h.sent.length;
    expect(() => c.query(stmt as never), stmt).toThrow(/DECISION-LEDGER #43/);
    expect(h.sent.slice(from), stmt).toEqual([]); // (a) nothing left the app
    // (b) the transaction was never ended, so the write is still inside it and the server refuses it.
    await expectRefusedReadOnly(c.query("INSERT INTO control VALUES (1)" as never));
    c.release();
    expect(await rows(), stmt).toBe(0);
  });

  it.each(TX_END_FORMS)("%j inside getNeonDb().tx: refused, and the next write is still refused", async (stmt) => {
    const from = h.sent.length;
    await getNeonDb().tx(async (tx) => {
      await expectRefusedByApp(tx.query(stmt, [])); // (a)
      await expectRefusedReadOnly(tx.query("INSERT INTO control VALUES (2)", [])); // (b)
    });
    // The guard opened the transaction and the guard closed it: no caller statement in between.
    expect(h.sent.slice(from)[0], stmt).toBe(BEGIN_READ_ONLY);
    expect(h.sent.slice(from).slice(1), stmt).toEqual(["INSERT INTO control VALUES (2)", "COMMIT"]);
    expect(await rows(), stmt).toBe(0);
  });

  it.each(TX_END_FORMS)("%j through the autocommit path: refused before a client is checked out", async (stmt) => {
    const from = h.sent.length;
    await expectRefusedByApp(getNeonDb().query(stmt, []));
    expect(h.sent.slice(from), stmt).toEqual([]);
    expect(await rows(), stmt).toBe(0);
  });

  it("savepoint work still runs inside the guarded transaction, and still cannot write", async () => {
    const ro = readOnlyPool(h.pool as Pool);
    const c = await ro.connect();
    await c.query("begin " as never);
    await c.query("savepoint sp1" as never);
    await expectRefusedReadOnly(c.query("INSERT INTO control VALUES (3)" as never));
    await c.query("rollback to savepoint sp1" as never); // recovers the aborted transaction
    await c.query("release savepoint sp1" as never);
    const read = await (c.query("SELECT 1 n" as never) as Promise<{ rows: unknown[] }>);
    expect(read.rows).toEqual([{ n: 1 }]);
    c.release();
    expect(await rows()).toBe(0);
  });

  it("a statement sent with no transaction open gets its own, so it is never writable", async () => {
    const ro = readOnlyPool(h.pool as Pool);
    const c = await ro.connect();
    const from = h.sent.length;
    await expectRefusedReadOnly(c.query("INSERT INTO control VALUES (4)" as never));
    expect(h.sent.slice(from)).toEqual([BEGIN_READ_ONLY, "INSERT INTO control VALUES (4)", "ROLLBACK"]);
    c.release();
    expect(await rows()).toBe(0);
  });

  it("a drizzle transaction cannot complete on a preview: its own `commit` is a caller-sent one", async () => {
    // Deliberate, and the price of refusing rather than guessing: drizzle frames its transactions with
    // `begin`/`commit` through the very client wrapper a caller's raw COMMIT goes through, so its close
    // is refused too. Previews read through getDb().execute (its own read-only transaction) or
    // getNeonDb().tx, where the guard — not the caller — owns the framing. Nothing is left open on the
    // backend either: releasing the client rolls the guard's transaction back.
    const from = h.sent.length;
    await expectRefusedByApp(getDb().transaction((tx) => tx.execute(drizzleSql`SELECT 1`)));
    expect(h.sent.slice(from)).toEqual([BEGIN_READ_ONLY, "SELECT 1", "ROLLBACK"]);
    expect((await backend.query<Record<string, string>>("SHOW transaction_read_only")).rows[0]
      .transaction_read_only).toBe("off");
    // The preview-safe paths still read.
    expect((await getNeonDb().tx((tx) => tx.query<{ n: number }>("SELECT 2 n", []))).rows).toEqual([{ n: 2 }]);
    expect((await getDb().execute(drizzleSql`SELECT 3 n`)).rows).toEqual([{ n: 3 }]);
  });

  it("off previews the same sequence is passed through, COMMIT included, and the write lands", async () => {
    process.env.VERCEL_ENV = "production";
    const from = h.sent.length;
    await getNeonDb().tx(async (tx) => {
      await tx.query("COMMIT", []); // exactly the escape previews now refuse
      await tx.query("INSERT INTO control VALUES (5)", []);
    });
    expect(h.sent.slice(from, from + 3)).toEqual(["BEGIN", "COMMIT", "INSERT INTO control VALUES (5)"]);
    expect(h.sent.slice(from).join(" | ")).not.toMatch(/READ ONLY/i);
    expect(await rows()).toBe(1);
    await backend.query("DELETE FROM control");
  });
});
