import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { vanColourToken, vanColourVar } from "./vans";

/** Veri #82 S1: `var(--color-van1)` was never defined; tokens.ts emits `--van-1/2/3`. */
describe("vanColourVar", () => {
  it("maps a van token to the --van-N property tokens.ts emits", () => {
    expect(vanColourVar(vanColourToken(1))).toBe("var(--van-1)");
    expect(vanColourVar(vanColourToken(2))).toBe("var(--van-2)");
    expect(vanColourVar(vanColourToken(3))).toBe("var(--van-3)");
  });
  it("keeps a chrome fallback as a --color-* property", () => {
    expect(vanColourVar(vanColourToken(99))).toBe("var(--color-ink-muted)");
  });
  it("no component builds the undefined --color-vanN name", () => {
    for (const file of [
      "src/app/ramp-ipad/arrival/VanArrival.tsx",
      "src/app/plan-routes/board/VanColumn.tsx",
    ]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/var\(--color-\$\{[^}]*colourToken\}/);
    }
  });
});
