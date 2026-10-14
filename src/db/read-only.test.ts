import { describe, expect, it } from "vitest";
import {
  READ_ONLY_REASON,
  READ_ONLY_SESSION_SQL,
  READ_ONLY_STARTUP_OPTIONS,
  dbSessionOptions,
  isReadOnlyDbEnv,
  previewSkip,
} from "./read-only";

describe("preview read-only fail-safe (DECISION-LEDGER #43)", () => {
  it("treats only VERCEL_ENV=preview as read-only", () => {
    expect(isReadOnlyDbEnv({ VERCEL_ENV: "preview" })).toBe(true);
    for (const v of ["production", "development", "Preview", "", undefined]) {
      expect(isReadOnlyDbEnv({ VERCEL_ENV: v })).toBe(false);
    }
    expect(isReadOnlyDbEnv({})).toBe(false);
  });

  it("adds the Postgres startup option on previews only", () => {
    expect(dbSessionOptions({ VERCEL_ENV: "preview" })).toEqual({ options: "-c default_transaction_read_only=on" });
    expect(dbSessionOptions({ VERCEL_ENV: "preview" }).options).toBe(READ_ONLY_STARTUP_OPTIONS);
    expect(dbSessionOptions({ VERCEL_ENV: "production" })).toEqual({});
    expect(dbSessionOptions({})).toEqual({});
    // spreading off-preview must not set `options` at all (undefined would clear nothing but is still noise)
    expect("options" in dbSessionOptions({ VERCEL_ENV: "production" })).toBe(false);
  });

  it("the fallback statement makes the whole session read-only", () => {
    expect(READ_ONLY_SESSION_SQL).toBe("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
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
