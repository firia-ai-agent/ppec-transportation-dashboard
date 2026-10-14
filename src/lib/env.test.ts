import { describe, expect, it } from "vitest";
import { assertBootEnv, BootEnvError, isDemoMode, isSyntheticDemo, showDemoLogins, uiSourceMode } from "./env";

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

describe("isDemoMode / showDemoLogins", () => {
  it("takes exactly \"1\" as on", () => {
    expect(isDemoMode({ DEMO_MODE: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", " 1"]) {
      expect(isDemoMode({ DEMO_MODE: v })).toBe(false);
    }
  });

  it("offers the demo logins only with both switches on", () => {
    expect(showDemoLogins({ DEMO_MODE: "1", APP_DATA_CLASS: "SYNTHETIC" })).toBe(true);
  });

  // Either half off hides them: a flag left on in a real-data build must show nothing.
  it.each([
    { DEMO_MODE: "0", APP_DATA_CLASS: "SYNTHETIC" },
    { APP_DATA_CLASS: "SYNTHETIC" },
    { DEMO_MODE: "1", APP_DATA_CLASS: "REAL" },
    { DEMO_MODE: "1" },
    {},
  ])("hides them for %o", (env) => {
    expect(showDemoLogins(env)).toBe(false);
  });
});
