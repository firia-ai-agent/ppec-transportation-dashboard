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

/**
 * A `;` hidden inside a literal or a comment, proved against real Postgres on every preview path
 * (hotfix PR #20 blocker 3). Before the fix the statement splitter stripped `--` and block comments
 * BEFORE it handled quoted text, so a `--`, a `/*` or a `$$` written inside a string blanked the rest
 * of the line and left one innocent-looking statement: `SELECT '--'; COMMIT; INSERT …`,
 * `SELECT $$--$$; COMMIT; INSERT …` and `SELECT E'\'--'; COMMIT; INSERT …` all went to the server
 * whole.
 *
 * That is a real write, not a theoretical one, because of how the drivers choose a protocol: pg and
 * @neondatabase/serverless both send the SQL through the SIMPLE query protocol when there are no
 * parameters OR the parameter array is empty (`requiresPreparation()` ends in `values.length > 0`),
 * and a simple query runs EVERY command in the string. The app's own calls pass `[]`. So the smuggled
 * `COMMIT` ends the guard's `BEGIN READ ONLY` and the `INSERT` after it runs in a fresh, writable
 * implicit transaction — against the one production database. The fake wire below mirrors that
 * protocol choice exactly (empty/absent params → PGlite's multi-command `exec`), so every test here
 * really does write a row without the fix.
 */
describe("preview: a `;` hidden in a literal or comment cannot smuggle a second statement (real Postgres)", () => {
  let backend: PGlite;
  let outerPool: PoolLike | Pool | undefined;

  /** The exact strings from the review, plus the variants that hide a `;` the same way. */
  const SMUGGLED = [
    // The three from the review, verbatim.
    "SELECT '--'; COMMIT; INSERT INTO smuggle VALUES (1)",
    "SELECT '/*'; COMMIT; INSERT INTO smuggle VALUES (1)",
    "SELECT $$--$$; COMMIT; INSERT INTO smuggle VALUES (1)",
    // The reviewer's four, verbatim. A nested block comment whose first `*/` only drops a level, so
    // `still comment` is still inside the comment and the `;` after the real close is top-level: a
    // scan that stopped at the first `*/` would read `still comment */` as SQL and mis-split here.
    "SELECT 1 /* /* */ still comment */; COMMIT; INSERT INTO smuggle VALUES (1)",
    "/* /* */ still comment */ COMMIT; INSERT INTO smuggle VALUES (1)",
    // `\'` inside an E'...' string is an escaped quote, so the COMMIT and the `--` are both *inside*
    // the literal (its contents are `'; COMMIT; --`); it ends at the quote after `--`, and the `;`
    // after that one starts the INSERT. Here the escape is the second statement, not a lost READ ONLY:
    // a splitter that stripped `--` before literals blanked the rest of the line and saw one innocent
    // statement, and the INSERT then rode along in the same string — in autocommit (off a preview, or
    // had the guard's framing moved) that writes, and the boundary is the only thing standing in front.
    "SELECT E'\\'; COMMIT; --'; INSERT INTO smuggle VALUES (1)",
    "SELECT E'\\'; COMMIT; --';\nINSERT INTO smuggle VALUES (1)",
    // `/*` in a string, with a `*/` later on so the old block-comment strip really did span the SQL.
    "SELECT '/*'; COMMIT; INSERT INTO smuggle VALUES (1) /* done */",
    // E'...' strings: `\'` is an escaped quote there, so the string runs on past the `--`.
    "SELECT E'\\'--'; COMMIT; INSERT INTO smuggle VALUES (1)",
    "select e'\\'--'; commit; insert into smuggle values (1)",
    "SELECT E'--''--'; COMMIT; INSERT INTO smuggle VALUES (1)",
    // Quoted identifiers.
    'SELECT 1 AS "--"; COMMIT; INSERT INTO smuggle VALUES (1)',
    'SELECT 1 AS "/*"; COMMIT; INSERT INTO smuggle VALUES (1)',
    'SELECT 1 AS "a""--"; COMMIT; INSERT INTO smuggle VALUES (1)',
    // Dollar quotes, tagged and untagged.
    "SELECT $tag$--$tag$; COMMIT; INSERT INTO smuggle VALUES (1)",
    "SELECT $tag$/*$tag$; COMMIT; INSERT INTO smuggle VALUES (1)",
    "SELECT $$/*$$; COMMIT; INSERT INTO smuggle VALUES (1)",
    "SELECT $a1_b$--$a1_b$; COMMIT; INSERT INTO smuggle VALUES (1)",
    // A bare `\r` ends a `--` comment on the server (`non_newline [^\n\r]` in scan.l), so a scan that
    // ran the comment on to the next `\n` read the smuggled statements as comment text: the guard saw
    // `SELECT 1` plus a trailing comment, and the server ran all three.
    "SELECT 1; -- x\rCOMMIT; INSERT INTO smuggle VALUES (1)",
    "SELECT 1; --\rCOMMIT; INSERT INTO smuggle VALUES (1)",
    "SELECT 1 -- x\rCOMMIT; INSERT INTO smuggle VALUES (1)",
    "SELECT '--' -- tail\r; COMMIT; INSERT INTO smuggle VALUES (1)",
    // A `$` INSIDE AN IDENTIFIER is not a dollar-quote opener (reviewer bypass 1 on head 9ffe8d1).
    // `$` is an identifier character and Postgres' lexer takes the longest match, so `x$a$` here is
    // one identifier — the column alias — and the `;` after it is a top-level statement separator.
    // Reading that `$a$` as an opener swallowed everything up to the next `$a$`, so the guard saw a
    // single statement with a quoted middle while the server ran all four: the COMMIT ended the
    // guard's READ ONLY transaction and the INSERT wrote a row to the shared production database.
    "SELECT 1 AS x$a$; COMMIT; INSERT INTO smuggle VALUES (1); SELECT 1 AS y$a$",
    "SELECT 1 AS x$$; COMMIT; INSERT INTO smuggle VALUES (1); SELECT 1 AS y$$",
    "select 1 as x$a$; commit; insert into smuggle values (1); select 1 as y$a$",
    "SELECT 1 AS x$a$; ROLLBACK; INSERT INTO smuggle VALUES (1); SELECT 1 AS y$a$",
    "SELECT 1 AS x$tag$; COMMIT; INSERT INTO smuggle VALUES (1); SELECT 1 AS y$tag$",
    // A digit, a `_` and a non-ASCII letter continue an identifier just as a letter does.
    "SELECT 1 AS x1$$; COMMIT; INSERT INTO smuggle VALUES (1); SELECT 1 AS y1$$",
    "SELECT 1 AS _x$a$; COMMIT; INSERT INTO smuggle VALUES (1); SELECT 1 AS _y$a$",
    "SELECT 1 AS é$a$; COMMIT; INSERT INTO smuggle VALUES (1); SELECT 1 AS ü$a$",
    // The same trick against the E-string rule: in `x$E'…'` the `E` is the tail of the identifier
    // `x$E`, so `'\'` is a complete plain string (a backslash) and the `;` after it is top-level.
    "SELECT 1 AS x$E'\\'; COMMIT; INSERT INTO smuggle VALUES (1); -- '",
    // Nested block comments: Postgres nests them, so the first `*/` does not end the comment.
    "SELECT 1 /* /* nested */ */; COMMIT; INSERT INTO smuggle VALUES (1)",
    "/* /* x */ */ SELECT 1; COMMIT; INSERT INTO smuggle VALUES (1)",
    // Leading comments, lowercase, and newlines instead of spaces.
    "-- lead\nSELECT '--'; COMMIT; INSERT INTO smuggle VALUES (1)",
    "/* lead */ SELECT $$--$$; COMMIT; INSERT INTO smuggle VALUES (1)",
    "select '--'\n; commit\n; insert into smuggle values (1)",
    "SELECT '--' -- tail\n; COMMIT; INSERT INTO smuggle VALUES (1)",
    // No COMMIT needed to be refused: a second statement is refused on its own.
    "SELECT '--'; INSERT INTO smuggle VALUES (1)",
    "SELECT '--'; begin read write; INSERT INTO smuggle VALUES (1)",
    // An empty extra statement is still an extra `;`: only a single trailing one is allowed.
    "SELECT 1;; COMMIT",
    "; SELECT 1",
    // Unterminated quoting: the scan cannot know where the literal ends, so it refuses (fail closed).
    "SELECT 'unterminated",
    'SELECT "unterminated',
    "SELECT E'unterminated",
    "SELECT $$unterminated",
    "SELECT $tag$unterminated$tag",
    "SELECT 1 /* unterminated",
    "SELECT 1 /* /* unterminated */",
  ];

  beforeAll(async () => {
    backend = new PGlite();
    await backend.exec("CREATE TABLE smuggle (id int)");
    const run = async (q: SqlLike, params?: unknown[]) => {
      h.sent.push(text(q));
      // The drivers' own protocol choice: parameters → extended protocol (one command); no parameters
      // or an empty array → simple protocol, which executes every command in the string.
      if (params && params.length > 0) {
        return { rows: (await backend.query(text(q), params)).rows as unknown[] };
      }
      const results = await backend.exec(text(q));
      return { rows: (results[results.length - 1]?.rows ?? []) as unknown[] };
    };
    const client: ClientLike = { query: run, release: () => {} };
    const p = Object.create(Pool.prototype) as Pool;
    Object.assign(p, { query: run, connect: async () => client });
    outerPool = h.pool;
    h.pool = p;
  }, 60_000);

  afterAll(() => { h.pool = outerPool; });
  beforeEach(() => { process.env.VERCEL_ENV = "preview"; });
  afterEach(async () => { await backend.exec("ROLLBACK").catch(() => {}); });

  const rows = async () =>
    (await backend.query<{ n: number }>("SELECT count(*)::int n FROM smuggle")).rows[0].n;
  /** The app refused it — whether it threw synchronously (a checked-out client) or rejected (a pool path). */
  const refusedByApp = async (call: () => unknown, what: string) => {
    let sync: unknown;
    let out: unknown;
    try { out = call(); } catch (e) { sync = e ?? new Error("threw with no error"); }
    if (sync !== undefined) {
      expect(sync, what).toBeInstanceOf(Error);
      expect((sync as Error).message, what).toMatch(/DECISION-LEDGER #43/);
      return;
    }
    await expectRefusedByApp(out as PromiseLike<unknown>);
  };

  it.each(SMUGGLED)("%j is refused on the autocommit path, and writes nothing", async (stmt) => {
    const from = h.sent.length;
    await refusedByApp(() => getNeonDb().query(stmt, []), stmt);
    expect(h.sent.slice(from), stmt).toEqual([]); // refused before a client was even checked out
    expect(await rows(), stmt).toBe(0);
  });

  it.each(SMUGGLED)("%j is refused inside getNeonDb().tx, and writes nothing", async (stmt) => {
    const from = h.sent.length;
    await getNeonDb().tx(async (tx) => {
      await refusedByApp(() => tx.query(stmt, []), stmt);
      // The guard's READ ONLY transaction was never ended, so a write still cannot happen in it.
      await expectRefusedReadOnly(tx.query("INSERT INTO smuggle VALUES (99)", []));
    });
    expect(h.sent.slice(from)[0], stmt).toBe(BEGIN_READ_ONLY);
    expect(h.sent.slice(from).join(" | "), stmt).not.toMatch(/smuggle VALUES \(1\)/);
    expect(await rows(), stmt).toBe(0);
  });

  it.each(SMUGGLED)("%j is refused through drizzle (getDb().execute), and writes nothing", async (stmt) => {
    const from = h.sent.length;
    await refusedByApp(() => getDb().execute(drizzleSql.raw(stmt)), stmt);
    expect(h.sent.slice(from), stmt).toEqual([]);
    expect(await rows(), stmt).toBe(0);
  });

  it.each(SMUGGLED)("%j is refused on the read-only pool's own query(), and writes nothing", async (stmt) => {
    const from = h.sent.length;
    await refusedByApp(() => readOnlyPool(h.pool as Pool).query(stmt as never), stmt);
    expect(h.sent.slice(from), stmt).toEqual([]);
    expect(await rows(), stmt).toBe(0);
  });

  it.each(SMUGGLED)("%j is refused on a checked-out client with no transaction open, and writes nothing", async (stmt) => {
    const c = await readOnlyPool(h.pool as Pool).connect();
    const from = h.sent.length;
    await refusedByApp(() => c.query(stmt as never), stmt);
    expect(h.sent.slice(from), stmt).toEqual([]); // not even the guard's own BEGIN was needed
    c.release();
    expect(await rows(), stmt).toBe(0);
  });

  it.each(SMUGGLED)("%j is refused on a checked-out client inside the guarded transaction, and writes nothing", async (stmt) => {
    const c = await readOnlyPool(h.pool as Pool).connect();
    await c.query("begin " as never); // drizzle's own opener: the guard's transaction is now open
    const from = h.sent.length;
    await refusedByApp(() => c.query(stmt as never), stmt);
    expect(h.sent.slice(from), stmt).toEqual([]);
    // Still inside the guard's READ ONLY transaction: the smuggled COMMIT never reached the server.
    await expectRefusedReadOnly(c.query("INSERT INTO smuggle VALUES (99)" as never));
    c.release();
    expect(await rows(), stmt).toBe(0);
    expect((await backend.query<Record<string, string>>("SHOW transaction_read_only")).rows[0]
      .transaction_read_only, stmt).toBe("off"); // and nothing leaked onto the connection
  });

  it("the fake wire really would have written: the same smuggling lands when nothing guards it", async () => {
    // The control for everything above. This is the pre-fix behaviour, reproduced directly on the
    // backend: a simple-protocol multi-command string ends the read-only transaction and writes.
    await backend.exec(BEGIN_READ_ONLY);
    await backend.exec("SELECT '--'; COMMIT; INSERT INTO smuggle VALUES (1)");
    expect(await rows()).toBe(1);
    await backend.exec("DELETE FROM smuggle");
  });

  it("a legitimate single statement still runs, trailing semicolon and literals included", async () => {
    for (const [stmt, want] of [
      ["SELECT 1 AS n;", 1],
      ["SELECT 1 AS n ;  ", 1],
      ["SELECT 1 AS n; -- done\n", 1],
      ["SELECT 1 AS n; /* done */", 1],
      ["/* lead */ SELECT 1 AS n -- tail\n;", 1],
      ["SELECT length('a;b--c/*d') AS n", 9],
      ["SELECT length($$;--/*$$) AS n", 5],
      ["SELECT length($tag$;--/*$tag$) AS n", 5],
      ["SELECT length(E'\\';--') AS n", 4],
      ['SELECT "a;b--c" AS n FROM (SELECT 1 AS "a;b--c") s', 1],
      ["SELECT length('/* not a comment */') AS n", 19],
      ["SELECT length('--') AS n;", 2],
    ] as [string, number][]) {
      const r = await getNeonDb().query<{ n: number }>(stmt, []);
      expect(r.rows, stmt).toEqual([{ n: want }]);
      // The same statement through the other preview paths.
      expect((await getNeonDb().tx((tx) => tx.query<{ n: number }>(stmt, []))).rows, stmt).toEqual([{ n: want }]);
      expect((await getDb().execute(drizzleSql.raw(stmt))).rows, stmt).toEqual([{ n: want }]);
    }
    // A `$1` placeholder is a parameter, not a dollar quote: it must not be read as one.
    expect((await getNeonDb().query<{ n: number }>("SELECT $1::int AS n", [7])).rows).toEqual([{ n: 7 }]);
    expect(await rows()).toBe(0);
  });

  it("the read-only wrapper still commits cleanly, and leaves the connection as it found it", async () => {
    const from = h.sent.length;
    const r = await getNeonDb().query<{ n: number }>("SELECT 1 AS n;", []);
    expect(r.rows).toEqual([{ n: 1 }]);
    // Opened READ ONLY by the guard, COMMITted by the guard, with the caller's statement in between.
    expect(h.sent.slice(from)).toEqual([BEGIN_READ_ONLY, "SELECT 1 AS n;", "COMMIT"]);
    expect((await backend.query<Record<string, string>>("SHOW transaction_read_only")).rows[0]
      .transaction_read_only).toBe("off");
    // A transaction the guard opened and closed, with a read in it, commits the same way.
    const from2 = h.sent.length;
    expect((await getNeonDb().tx((tx) => tx.query<{ n: number }>("SELECT 2 AS n", []))).rows).toEqual([{ n: 2 }]);
    expect(h.sent.slice(from2)).toEqual([BEGIN_READ_ONLY, "SELECT 2 AS n", "COMMIT"]);
    expect(await rows()).toBe(0);
  });
});

/**
 * Session state a preview must never change, proved against real Postgres on every preview path
 * (hotfix PR #20, reviewer bypass 2).
 *
 * Everything in read-only.ts rests on lexing one statement the way the server lexes it — and the
 * server's lexing is itself configurable. `SET standard_conforming_strings = off` makes `\'` an
 * escaped quote again, so after it
 *
 *     SELECT '\''; COMMIT; INSERT INTO smuggle VALUES (1); -- '
 *
 * is THREE statements on the server (`'\''` is one string holding a quote, then the `;` is top-level)
 * while the scanner here still reads one long literal and passes the whole thing through. The COMMIT
 * then ends the guard's READ ONLY transaction and the INSERT writes, exactly as the reviewer showed.
 * The SET and the exploit are two separate calls, which is why the session-level SET matters: it
 * outlives the statement that sent it — on this very connection, and (DECISION-LEDGER #43) on a
 * PgBouncer backend production later borrows.
 *
 * So previews refuse every SET and RESET bar a short `SET LOCAL <timeout>` allowlist, every
 * `set_config(…)` call however it is spelled, every `DO` block (its body is a literal this scanner
 * cannot see into, and a plpgsql body can PERFORM set_config) and every DISCARD. Below: each of those
 * refused on all six preview paths, the reviewer's two-call sequence on all six, the allowlisted
 * `SET LOCAL` still working, and the control that proves the sequence really does write without the fix.
 */
describe("preview: a caller cannot change session state, so it cannot change the lexing (real Postgres)", () => {
  let backend: PGlite;
  let outerPool: PoolLike | Pool | undefined;

  /** `SET standard_conforming_strings = off`, the one that re-arms the escape below. */
  const SCS_OFF = "SET standard_conforming_strings = off";
  /** The reviewer's exploit: three statements once `\'` is an escaped quote again, one before that. */
  const AFTER_SCS_OFF = "SELECT '\\''; COMMIT; INSERT INTO smuggle VALUES (1); -- '";

  /** Every way a caller could ask for session (or lexing) state, in the spellings that matter. */
  const SESSION_STATE = [
    SCS_OFF,
    "set standard_conforming_strings to off",
    "SET SESSION standard_conforming_strings = off",
    "SET LOCAL standard_conforming_strings = off",
    "RESET standard_conforming_strings",
    "SET backslash_quote = on",
    "SET escape_string_warning = off",
    "SET search_path TO ops",
    "RESET search_path",
    "RESET ALL",
    "SET ROLE migrator",
    "SET TIME ZONE 'UTC'",
    "SET TRANSACTION READ ONLY",
    "set local transaction isolation level serializable",
    "SET LOCAL transaction_read_only = off",
    "SET LOCAL default_transaction_read_only = off",
    "SET LOCAL statement_timeout = '5s', lock_timeout = '1s'", // not the allowlisted single-GUC form
    "SET statement_timeout = '5s'", // session-scoped, so refused even though the GUC is allowlisted
    "SELECT set_config('standard_conforming_strings', 'off', false)",
    "select SET_CONFIG('standard_conforming_strings','off',false)",
    "SELECT pg_catalog.set_config('standard_conforming_strings','off',false)",
    'SELECT pg_catalog."set_config"(\'standard_conforming_strings\',\'off\',false)',
    "SELECT * FROM set_config('standard_conforming_strings','off',false)",
    "DO $$ BEGIN PERFORM set_config('standard_conforming_strings','off',false); END $$",
    "DISCARD ALL",
  ];

  beforeAll(async () => {
    backend = new PGlite();
    await backend.exec("CREATE TABLE smuggle (id int)");
    const run = async (q: SqlLike, params?: unknown[]) => {
      h.sent.push(text(q));
      // The drivers' own protocol choice, as in the smuggling suite above: no parameters (or an empty
      // array) means the simple query protocol, which runs every command in the string.
      if (params && params.length > 0) {
        return { rows: (await backend.query(text(q), params)).rows as unknown[] };
      }
      const results = await backend.exec(text(q));
      return { rows: (results[results.length - 1]?.rows ?? []) as unknown[] };
    };
    const client: ClientLike = { query: run, release: () => {} };
    const p = Object.create(Pool.prototype) as Pool;
    Object.assign(p, { query: run, connect: async () => client });
    outerPool = h.pool;
    h.pool = p;
  }, 60_000);

  afterAll(() => { h.pool = outerPool; });
  beforeEach(() => { process.env.VERCEL_ENV = "preview"; });
  afterEach(async () => { await backend.exec("ROLLBACK").catch(() => {}); });

  const rows = async () =>
    (await backend.query<{ n: number }>("SELECT count(*)::int n FROM smuggle")).rows[0].n;
  /** A GUC read off the backend itself, out of band — not through the pool. */
  const show = async (name: string) =>
    (await backend.query<Record<string, string>>(`SHOW ${name}`)).rows[0][name];

  type Verdict = "refused" | "ran";
  /** Did the app refuse this before sending it? Drizzle wraps errors, so walk the cause chain. */
  const verdict = async (call: () => unknown): Promise<Verdict> => {
    try {
      const out = call();
      if (typeof (out as PromiseLike<unknown> | undefined)?.then === "function") await out;
      return "ran";
    } catch (e) {
      for (let c: unknown = e; c instanceof Error; c = c.cause) {
        if (/DECISION-LEDGER #43/.test(c.message)) return "refused";
      }
      return "ran"; // an error from the server is not a refusal by the app
    }
  };
  /** Feed `stmts` through one path, in order, on one connection, and report what happened to each. */
  const feed = async (send: (s: string) => unknown, stmts: string[]) => {
    const out: Verdict[] = [];
    for (const s of stmts) out.push(await verdict(() => send(s)));
    return out;
  };

  /** Every preview path that puts SQL on the wire, as a runner for a SEQUENCE of statements. */
  const PATHS: { name: string; run: (stmts: string[]) => Promise<Verdict[]> }[] = [
    {
      name: "the autocommit path (getNeonDb().query)",
      run: (stmts) => feed((s) => getNeonDb().query(s, []), stmts),
    },
    {
      name: "getNeonDb().tx",
      run: async (stmts) => getNeonDb().tx((tx) => feed((s) => tx.query(s, []), stmts)),
    },
    {
      name: "drizzle (getDb().execute)",
      run: (stmts) => feed((s) => getDb().execute(drizzleSql.raw(s)), stmts),
    },
    {
      name: "the read-only pool's own query()",
      run: (stmts) => feed((s) => readOnlyPool(h.pool as Pool).query(s as never), stmts),
    },
    {
      name: "a checked-out client with no transaction open",
      run: async (stmts) => {
        const c = await readOnlyPool(h.pool as Pool).connect();
        try { return await feed((s) => c.query(s as never), stmts); } finally { c.release(); }
      },
    },
    {
      name: "a checked-out client inside the guarded transaction",
      run: async (stmts) => {
        const c = await readOnlyPool(h.pool as Pool).connect();
        await c.query("begin " as never); // drizzle's own opener: the guard's transaction is now open
        try { return await feed((s) => c.query(s as never), stmts); } finally { c.release(); }
      },
    },
  ];

  it.each(PATHS)("every SET, RESET, set_config and DO is refused on $name", async ({ run }) => {
    for (const stmt of SESSION_STATE) {
      const from = h.sent.length;
      expect(await run([stmt]), stmt).toEqual(["refused"]);
      expect(h.sent.slice(from), stmt).not.toContain(stmt); // nothing left the app
      expect(await rows(), stmt).toBe(0);
    }
    // The lexing the scanner assumes is still the lexing the server uses.
    expect(await show("standard_conforming_strings")).toBe("on");
    expect(await show("transaction_read_only")).toBe("off");
  });

  it.each(PATHS)("the reviewer's SET-then-smuggle sequence writes nothing on $name", async ({ run }) => {
    const from = h.sent.length;
    const [set, exploit] = await run([SCS_OFF, AFTER_SCS_OFF]);
    expect(set).toBe("refused"); // the SET never reached the server…
    expect(h.sent.slice(from)).not.toContain(SCS_OFF);
    expect(await show("standard_conforming_strings")).toBe("on");
    // …so `\'` is still not an escape, the exploit is still one harmless string literal, and the
    // COMMIT and INSERT written inside it are data. (It runs; it just cannot do anything.)
    expect(exploit).toBe("ran");
    expect(h.sent.slice(from).join(" | ")).not.toMatch(/^INSERT INTO smuggle/m);
    expect(await rows()).toBe(0);
  });

  it("the allowlisted SET LOCAL timeouts still work, on every path, and do not outlive the transaction", async () => {
    for (const { name, run } of PATHS) {
      const stmt = "SET LOCAL statement_timeout = '5s'";
      const from = h.sent.length;
      expect(await run([stmt]), name).toEqual(["ran"]);
      expect(h.sent.slice(from), name).toContain(stmt); // it really was sent
      // SET LOCAL is transaction-scoped, and the guard's transaction is over by now (or rolled back
      // on release), so nothing is left on the backend PgBouncer hands on.
      expect(await show("statement_timeout"), name).toBe("0");
      expect(await rows(), name).toBe(0);
    }
  });

  it("the app's own read-only wrapper is untouched: reads still work on every path", async () => {
    expect((await getNeonDb().query<{ n: number }>("SELECT 1 AS n", [])).rows).toEqual([{ n: 1 }]);
    expect((await getNeonDb().tx((tx) => tx.query<{ n: number }>("SELECT 2 AS n", []))).rows).toEqual([{ n: 2 }]);
    expect((await getDb().execute(drizzleSql`SELECT 3 AS n`)).rows).toEqual([{ n: 3 }]);
    const viaPool = await (readOnlyPool(h.pool as Pool).query("SELECT 4 AS n" as never) as Promise<{ rows: unknown[] }>);
    expect(viaPool.rows).toEqual([{ n: 4 }]);
    // A query that merely mentions a GUC, or reads one, is not a SET.
    expect((await getNeonDb().query<{ n: string }>("SELECT current_setting('standard_conforming_strings') AS n", []))
      .rows).toEqual([{ n: "on" }]);
    expect((await getNeonDb().query<{ n: number }>("SELECT length('set_config(') AS n", [])).rows)
      .toEqual([{ n: 11 }]);
    expect(await rows()).toBe(0);
  });

  it("the control: with standard_conforming_strings off, that very sequence does write", async () => {
    // The pre-fix behaviour, reproduced directly on the backend — the proof that refusing the SET is
    // what stops the exploit, not some accident of the fake wire.
    await backend.exec(SCS_OFF);
    await backend.exec(BEGIN_READ_ONLY);
    await backend.exec(AFTER_SCS_OFF);
    expect(await rows()).toBe(1);
    await backend.exec("DELETE FROM smuggle");
    await backend.exec("RESET standard_conforming_strings");
    expect(await show("standard_conforming_strings")).toBe("on");
  });
});
