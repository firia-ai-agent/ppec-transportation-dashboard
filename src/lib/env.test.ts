import { describe, expect, it } from "vitest";
// The positron URL is written in exactly one place (ADR-008); the test reads it from
// there rather than repeating the literal.
import { DEFAULT_MAP_STYLE_URL } from "@/components/map/style";
import { assertBootEnv, BootEnvError, isSyntheticDemo, uiSourceMode } from "./env";

describe("assertBootEnv", () => {
  it("accepts SYNTHETIC", () => {
    expect(assertBootEnv({ APP_DATA_CLASS: "SYNTHETIC" }).APP_DATA_CLASS).toBe("SYNTHETIC");
  });
  it.each([undefined, "", "synthetic", "REAL", "PHI"])("refuses %s", (v) => {
    expect(() => assertBootEnv({ APP_DATA_CLASS: v })).toThrow(BootEnvError);
  });
  it("treats NEXT_PUBLIC_MAP_TILE_URL as optional (ADR-008 default applies when unset)", () => {
    expect(assertBootEnv({ APP_DATA_CLASS: "SYNTHETIC" }).NEXT_PUBLIC_MAP_TILE_URL).toBeUndefined();
    expect(
      assertBootEnv({
        APP_DATA_CLASS: "SYNTHETIC",
        NEXT_PUBLIC_MAP_TILE_URL: DEFAULT_MAP_STYLE_URL,
      }).NEXT_PUBLIC_MAP_TILE_URL,
    ).toBe(DEFAULT_MAP_STYLE_URL);
  });
  it("refuses a malformed map style URL", () => {
    expect(() =>
      assertBootEnv({ APP_DATA_CLASS: "SYNTHETIC", NEXT_PUBLIC_MAP_TILE_URL: "not-a-url" }),
    ).toThrow(BootEnvError);
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
