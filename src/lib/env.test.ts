import { describe, expect, it } from "vitest";
import { assertBootEnv, BootEnvError, isSyntheticDemo, uiSourceMode } from "./env";

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

describe("isSyntheticDemo / uiSourceMode", () => {
  it("marks a SYNTHETIC deployment as the simulated source mode", () => {
    expect(isSyntheticDemo({ APP_DATA_CLASS: "SYNTHETIC" })).toBe(true);
    expect(uiSourceMode({ APP_DATA_CLASS: "SYNTHETIC" })).toBe("SIMULATED");
  });

  // Anything else never boots (assertBootEnv), but the UI must not paint demo violet if it did.
  it.each([undefined, "", "synthetic", "LIVE"])("treats %s as not synthetic", (v) => {
    expect(isSyntheticDemo({ APP_DATA_CLASS: v })).toBe(false);
    expect(uiSourceMode({ APP_DATA_CLASS: v })).toBe("LIVE");
  });
});
