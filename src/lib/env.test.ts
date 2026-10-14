import { describe, expect, it } from "vitest";
import { assertBootEnv, BootEnvError } from "./env";

describe("assertBootEnv", () => {
  it("accepts SYNTHETIC", () => {
    expect(assertBootEnv({ APP_DATA_CLASS: "SYNTHETIC" }).APP_DATA_CLASS).toBe("SYNTHETIC");
  });
  it.each([undefined, "", "synthetic", "REAL", "PHI"])("refuses %s", (v) => {
    expect(() => assertBootEnv({ APP_DATA_CLASS: v })).toThrow(BootEnvError);
  });
  it("treats NEXT_PUBLIC_MAP_STYLE_URL as optional (ADR-008 default applies when unset)", () => {
    expect(assertBootEnv({ APP_DATA_CLASS: "SYNTHETIC" }).NEXT_PUBLIC_MAP_STYLE_URL).toBeUndefined();
    expect(
      assertBootEnv({
        APP_DATA_CLASS: "SYNTHETIC",
        NEXT_PUBLIC_MAP_STYLE_URL: "https://tiles.openfreemap.org/styles/positron",
      }).NEXT_PUBLIC_MAP_STYLE_URL,
    ).toBe("https://tiles.openfreemap.org/styles/positron");
  });
  it("refuses a malformed map style URL", () => {
    expect(() =>
      assertBootEnv({ APP_DATA_CLASS: "SYNTHETIC", NEXT_PUBLIC_MAP_STYLE_URL: "not-a-url" }),
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
