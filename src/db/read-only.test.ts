import { describe, expect, it } from "vitest";
import {
  BEGIN_READ_ONLY,
  READ_ONLY_REASON,
  beginSql,
  isReadOnlyDbEnv,
  previewSkip,
  rewriteBeginReadOnly,
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
    const sql = [BEGIN_READ_ONLY, beginSql({ VERCEL_ENV: "preview" }), rewriteBeginReadOnly("begin ")].join(" ");
    expect(sql).not.toMatch(/SET SESSION/i);
    expect(sql).not.toMatch(/default_transaction_read_only/i);
  });

  describe("rewriteBeginReadOnly", () => {
    it("rewrites a bare BEGIN, however it is spelled or padded", () => {
      for (const s of ["BEGIN", "begin", "  begin  ", "\nBegin\t", "begin "]) {
        expect(rewriteBeginReadOnly(s)).toBe(BEGIN_READ_ONLY);
      }
    });
    it("rewrites the SQL inside a query config object, keeping its other fields", () => {
      expect(rewriteBeginReadOnly({ text: "begin ", rowMode: "array" })).toEqual({ text: BEGIN_READ_ONLY, rowMode: "array" });
    });
    it("leaves every other statement alone, including a BEGIN that already has modes", () => {
      for (const s of [
        "COMMIT", "ROLLBACK", "SELECT 1", "BEGIN READ ONLY", "begin isolation level serializable",
        "BEGINNING", "begin; select 1", "savepoint sp1", "",
      ]) {
        expect(rewriteBeginReadOnly(s)).toBe(s);
      }
      const cfg = { text: "SELECT 1" };
      expect(rewriteBeginReadOnly(cfg)).toBe(cfg);
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
