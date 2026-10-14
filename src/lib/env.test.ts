import { describe, expect, it } from "vitest";
import { assertBootEnv, BootEnvError } from "./env";

describe("assertBootEnv", () => {
  it("accepts SYNTHETIC", () => {
    expect(assertBootEnv({ APP_DATA_CLASS: "SYNTHETIC" }).APP_DATA_CLASS).toBe("SYNTHETIC");
  });
  it.each([undefined, "", "synthetic", "REAL", "PHI"])("refuses %s", (v) => {
    expect(() => assertBootEnv({ APP_DATA_CLASS: v })).toThrow(BootEnvError);
  });
  it("does not echo values in the error", () => {
    try {
      assertBootEnv({ APP_DATA_CLASS: "secret-looking-value" });
    } catch (e) {
      expect(String(e)).not.toContain("secret-looking-value");
    }
  });
});
