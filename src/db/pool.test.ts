import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "@neondatabase/serverless";
import { autocommitQuery, readOnlyPool, readOnlyQuery, type ClientLike, type PoolLike } from "./pool";
import { BEGIN_READ_ONLY, type SqlLike } from "./read-only";

const text = (q: SqlLike) => (typeof q === "string" ? q : q.text);

/** Fake pool that records every statement, so the tests can assert on the exact SQL sent. */
function fakePool(failOn?: RegExp) {
  const sent: string[] = [];
  let open = 0;
  const client: ClientLike = {
    query: async (q, params) => {
      sent.push(text(q));
      if (failOn?.test(text(q))) throw new Error(`boom: ${text(q)}`);
      return { rows: [{ q: text(q), params }] };
    },
    release: () => { open -= 1; },
  };
  const pool: PoolLike = {
    query: async (q, params) => { sent.push(text(q)); return { rows: [{ q: text(q), params }] }; },
    connect: async () => { open += 1; return client; },
  };
  return { pool, sent, checkedOut: () => open };
}

const withEnv = (v: string | undefined) => { process.env.VERCEL_ENV = v; };
afterEach(() => { delete process.env.VERCEL_ENV; });

describe("readOnlyQuery", () => {
  it("runs the statement inside its own read-only transaction and releases the client", async () => {
    const { pool, sent, checkedOut } = fakePool();
    const r = await readOnlyQuery(pool, "SELECT 1", [7]);
    expect(sent).toEqual([BEGIN_READ_ONLY, "SELECT 1", "COMMIT"]);
    expect(r.rows).toEqual([{ q: "SELECT 1", params: [7] }]);
    expect(checkedOut()).toBe(0);
  });

  it("refuses a statement that would escape the transaction, before checking a client out", async () => {
    for (const stmt of ["begin; insert into t values (1)", "SET TRANSACTION READ WRITE", "commit; select 1"]) {
      const { pool, sent, checkedOut } = fakePool();
      await expect(readOnlyQuery(pool, stmt)).rejects.toThrow(/DECISION-LEDGER #43/);
      expect(sent, stmt).toEqual([]);
      expect(checkedOut(), stmt).toBe(0);
    }
  });

  it("opens READ ONLY even when the caller's own statement is a transaction start", async () => {
    const { pool, sent } = fakePool();
    await readOnlyQuery(pool, "begin isolation level serializable read write");
    expect(sent).toEqual([BEGIN_READ_ONLY, "BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY", "COMMIT"]);
  });

  it("rolls back and releases when the statement fails", async () => {
    const { pool, sent, checkedOut } = fakePool(/INSERT/);
    await expect(readOnlyQuery(pool, "INSERT INTO t VALUES (1)")).rejects.toThrow("boom");
    expect(sent).toEqual([BEGIN_READ_ONLY, "INSERT INTO t VALUES (1)", "ROLLBACK"]);
    expect(checkedOut()).toBe(0);
  });
});

describe("autocommitQuery", () => {
  it("wraps each query in a read-only transaction on previews", async () => {
    withEnv("preview");
    const { pool, sent } = fakePool();
    await autocommitQuery(pool, "UPDATE t SET a = 1");
    expect(sent).toEqual([BEGIN_READ_ONLY, "UPDATE t SET a = 1", "COMMIT"]);
  });

  it("goes straight to pool.query off previews, sending no extra statement", async () => {
    for (const env of ["production", "development", undefined]) {
      withEnv(env);
      const { pool, sent, checkedOut } = fakePool();
      const r = await autocommitQuery(pool, "UPDATE t SET a = 1", [1]);
      expect(sent).toEqual(["UPDATE t SET a = 1"]);
      expect(sent.join(" ")).not.toMatch(/READ ONLY/i);
      expect(r.rows).toEqual([{ q: "UPDATE t SET a = 1", params: [1] }]);
      expect(checkedOut()).toBe(0); // no client pinned per query
    }
  });
});

describe("readOnlyPool (the drizzle view)", () => {
  it("keeps the pool's prototype, so drizzle still recognises it as a Pool", () => {
    class FakePoolClass { query() {} connect() {} }
    const ro = readOnlyPool(new FakePoolClass() as unknown as Pool);
    expect(ro).toBeInstanceOf(FakePoolClass);
  });

  it("wraps autocommit queries, including the config-object form drizzle sends", async () => {
    const { pool, sent } = fakePool();
    const ro = readOnlyPool(pool as unknown as Pool);
    await ro.query({ text: "SELECT 1", rowMode: "array" } as never);
    expect(sent).toEqual([BEGIN_READ_ONLY, "SELECT 1", "COMMIT"]);
  });

  it("rewrites the bare BEGIN of a drizzle transaction and passes everything else through", async () => {
    const { pool, sent, checkedOut } = fakePool();
    const ro = readOnlyPool(pool as unknown as Pool);
    const c = await ro.connect();
    await c.query("begin " as never);
    await c.query({ text: "begin " } as never);
    await c.query("INSERT INTO t VALUES (1)" as never);
    await c.query("commit" as never);
    c.release();
    expect(sent).toEqual([BEGIN_READ_ONLY, BEGIN_READ_ONLY, "INSERT INTO t VALUES (1)", "commit"]);
    expect(checkedOut()).toBe(0);
  });

  it.each([
    ["begin ", BEGIN_READ_ONLY],
    ["BEGIN", BEGIN_READ_ONLY],
    ["begin read write", BEGIN_READ_ONLY],
    ["BEGIN TRANSACTION", "BEGIN TRANSACTION READ ONLY"],
    ["begin work read write", "BEGIN WORK READ ONLY"],
    ["START TRANSACTION", "START TRANSACTION READ ONLY"],
    ["  start   transaction   read   write  ", "START TRANSACTION READ ONLY"],
    ["begin isolation level serializable", "BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY"],
    ["begin isolation level serializable read write", "BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY"],
    ["BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ WRITE, NOT DEFERRABLE",
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, NOT DEFERRABLE, READ ONLY"],
  ])("sends %j as %j, whatever form the transaction was opened in", async (opened, expected) => {
    const { pool, sent } = fakePool();
    const ro = readOnlyPool(pool as unknown as Pool);
    const c = await ro.connect();
    await c.query(opened as never);
    await c.query({ text: opened, rowMode: "array" } as never);
    c.release();
    expect(sent).toEqual([expected, expected]);
    expect(sent.join(" | ")).not.toMatch(/READ\s+WRITE/i);
  });

  it.each([
    "SET TRANSACTION READ WRITE",
    "set session characteristics as transaction read write",
    "SET transaction_read_only = off",
    "begin; insert into t values (1)",
    "commit; insert into t values (1)",
    "begin isolation level bogus",
  ])("refuses %j without sending anything", async (stmt) => {
    const { pool, sent } = fakePool();
    const ro = readOnlyPool(pool as unknown as Pool);
    const c = await ro.connect();
    expect(() => c.query(stmt as never)).toThrow(/DECISION-LEDGER #43/);
    c.release();
    expect(sent).toEqual([]);
  });
});

describe("getDb (drizzle) wiring", () => {
  it("hands drizzle the read-only view on previews and the pool itself elsewhere", async () => {
    process.env.DATABASE_URL = "postgres://u:p@localhost/db"; // never connected: drizzle() is lazy
    const { getPool } = await import("./pool");
    const { getDb } = await import("./client");
    withEnv("preview");
    expect(getDb().$client).not.toBe(getPool());
    expect(getDb().$client).toBeInstanceOf(Pool); // drizzle only checks a client out for a tx if this holds
    withEnv("production");
    expect(getDb().$client).toBe(getPool());
    delete process.env.DATABASE_URL;
  });
});

describe("no session-level state is set anywhere (the bug this hotfix removes)", () => {
  const root = join(__dirname, "..", "..");
  const banned = [/SET SESSION/i, /default_transaction_read_only/, /options:/];

  it("src/db/pool.ts and src/auth/client-exec.ts mention none of the session-state spellings", () => {
    for (const f of ["src/db/pool.ts", "src/auth/client-exec.ts"]) {
      const src = readFileSync(join(root, f), "utf8");
      for (const re of banned) expect(src, `${f} must not contain ${re}`).not.toMatch(re);
    }
  });

  it("no source file under src/ or scripts/ sets session state (comments aside)", () => {
    const files = ["src", "scripts"].flatMap((d) =>
      (readdirSync(join(root, d), { recursive: true, encoding: "utf8" }) as string[])
        .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !/\.test\./.test(f))
        .map((f) => join(d, f)));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const code = readFileSync(join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const re of [/SET SESSION/i, /default_transaction_read_only/]) {
        expect(code, `${f} must not contain ${re}`).not.toMatch(re);
      }
    }
  });
});
