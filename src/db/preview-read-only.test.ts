import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { ClientLike, PoolLike } from "./pool";
import type { SqlLike } from "./read-only";

/**
 * End-to-end proof against real Postgres (PGlite): on a preview a write fails in the server, in both the
 * transaction and the autocommit path, while reads still work — and off previews nothing changes and the
 * string "READ ONLY" is never sent. Only getPool() is faked (PGlite stands in for the Neon pool); the
 * read-only plumbing under test is the real one.
 */
const h = vi.hoisted(() => ({ pool: undefined as PoolLike | undefined, sent: [] as string[] }));
vi.mock("./pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pool")>();
  return { ...actual, getPool: () => h.pool };
});

// (vi.mock is hoisted above these imports, so exec.ts picks up the faked getPool.)
import { getNeonDb } from "./exec";
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
