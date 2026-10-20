import { describe, expect, it } from "vitest";
import { slotWords } from "./actions";

describe("get_child says what a family agreed (ledger #84)", () => {
  it("names the approved range, and how far outside it the plan is", () => {
    const slots = [{ start: "16:50", end: "17:20" }];
    expect(slotWords(slots, 17 * 60)).toMatch(/^, agreed 4:50.*5:20/);
    expect(slotWords(slots, 17 * 60)).not.toContain("outside");
    expect(slotWords(slots, 17 * 60 + 40)).toContain("20 min outside it");
  });

  it("says nothing when nothing was agreed", () => {
    expect(slotWords(undefined, 17 * 60)).toBe("");
    expect(slotWords([], 17 * 60)).toBe("");
  });
});
