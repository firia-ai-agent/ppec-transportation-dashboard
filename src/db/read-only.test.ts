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

    it("leaves a harmless SET alone, including SET TRANSACTION READ ONLY", () => {
      for (const s of ["SET TRANSACTION READ ONLY", "set local transaction isolation level serializable", "SET search_path TO ops"]) {
        expect(rewriteBeginReadOnly(s)).toBe(s);
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
      expect(rewriteBeginReadOnly("RESET search_path")).toBe("RESET search_path");
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
