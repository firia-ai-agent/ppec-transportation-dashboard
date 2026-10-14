import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "@neondatabase/serverless";
import { sql as drizzleSql } from "drizzle-orm";
import type { ClientLike, PoolLike } from "./pool";
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
 * PgBouncer transaction mode, simulated explicitly (DECISION-LEDGER #43/#44).
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
  /** Postgres refused the write. Drizzle wraps driver errors, so the server's words may be in a cause. */
  const expectRefusedReadOnly = async (p: PromiseLike<unknown>) => {
    const err: unknown = await p.then(() => undefined, (e: unknown) => e ?? new Error("rejected with no error"));
    expect(err, "expected the write to be refused").toBeInstanceOf(Error);
    const chain: string[] = [];
    for (let e: unknown = err; e instanceof Error; e = e.cause) chain.push(e.message);
    expect(chain.join(" <- ")).toMatch(/read-only transaction/);
  };

  it("(a) a preview write is refused on every pooled path: tx, autocommit, drizzle query and drizzle tx", async () => {
    const statements = await asEnv("preview", async () => {
      await expectRefusedReadOnly(getNeonDb().tx((tx) => tx.query("INSERT INTO shared VALUES (1)", [])));
      await expectRefusedReadOnly(getNeonDb().query("INSERT INTO shared VALUES (2)", []));
      await expectRefusedReadOnly(getDb().execute(drizzleSql`INSERT INTO shared VALUES (3)`));
      await expectRefusedReadOnly(getDb().transaction((tx) => tx.execute(drizzleSql`INSERT INTO shared VALUES (4)`)));
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
