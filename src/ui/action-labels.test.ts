import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ONE LINE PER ACTION LABEL (Vera). The confirm card and the agent panel draw Approve, the links and
 * Don't from the Family texts card rules; at 1440 in the side-by-side For you layout "Don't move"
 * broke to two lines. Each label holds its line and its width; the action row wraps as a whole.
 */
const CSS = readFileSync(path.resolve(__dirname, "../app/(app)/family-texts/texts.module.css"), "utf8");

function block(selector: string): string {
  const re = new RegExp(`(^|\\n)([^{}]*[^\\w-])?\\.${selector}(?![\\w-])[^{}]*\\{([^}]*)\\}`, "g");
  return [...CSS.matchAll(re)].map((m) => m[3]).join("\n");
}

describe("confirm-card and agent-panel action labels", () => {
  for (const cls of ["primary", "secondary", "quiet"]) {
    it(`.${cls} does not wrap or shrink`, () => {
      const rules = block(cls);
      expect(rules).toMatch(/white-space:\s*nowrap/);
      expect(rules).toMatch(/flex-shrink:\s*0/);
    });
  }
  it("the action row wraps as a whole", () => {
    expect(block("actions")).toMatch(/flex-wrap:\s*wrap/);
  });
});
