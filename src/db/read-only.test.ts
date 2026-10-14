import { describe, expect, it } from "vitest";
import {
  BEGIN_READ_ONLY,
  READ_ONLY_REASON,
  beginSql,
  isReadOnlyDbEnv,
  previewSkip,
  ReadOnlyRefusedError,
  rewriteBeginReadOnly,
  rewriteBeginReadOnlyForEnv,
} from "./read-only";

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
        "COMMIT", "ROLLBACK", "END", "SELECT 1", "BEGINNING", "savepoint sp1",
        "release savepoint sp1", "rollback to savepoint sp1", "INSERT INTO t VALUES (1)", "",
      ]) {
        expect(rewriteBeginReadOnly(s), s).toBe(s);
      }
      const cfg = { text: "SELECT 1" };
      expect(rewriteBeginReadOnly(cfg)).toBe(cfg);
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
