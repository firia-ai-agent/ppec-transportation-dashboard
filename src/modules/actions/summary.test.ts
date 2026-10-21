import { describe, expect, it } from "vitest";
import { actionSummaries, confirmCopy } from "@/ui/copy";
import { staffActionDecline, staffActionSummary } from "./summary";

/**
 * WHAT A CONFIRM CARD SAYS, AND WHAT REFUSING IT SAYS (Vera).
 *
 * Two complaints, one file, because they are the same rule read twice: a card must name the change
 * it is asking for. "Move a child on the afternoon plan and save it." names nobody, and "Don't"
 * names nothing. The names themselves come off the board (`confirm-cards.ts cardNames`); what is
 * held here is that the sentence uses them when it has them and falls back whole when it has not.
 */
describe("a move card names the child and the van", () => {
  const args = { date: "2026-10-20", leg: "PM", child_token: "c-1", van_id: "v-3" };

  it("says who moves and where, in the first name and the van's own name", () => {
    expect(staffActionSummary("move_child", args, { child: "Noah", van: "Van 3" })).toBe(
      "Move Noah to Van 3, afternoon.",
    );
    expect(staffActionSummary("move_child", { ...args, leg: "AM" }, { child: "Ava", van: "Van 1" })).toBe(
      "Move Ava to Van 1, morning.",
    );
  });

  /** Half a name is worse than none: a card nobody can be named on keeps the line it always had. */
  it.each([
    ["no van", { child: "Noah", van: null }],
    ["no child", { child: null, van: "Van 3" }],
    ["neither", {}],
  ])("falls back to the plain line with %s", (_case, names) => {
    expect(staffActionSummary("move_child", args, names)).toBe(actionSummaries.moveChild.replace("{leg}", "afternoon"));
    expect(staffActionSummary("move_child", args, names)).not.toContain("undefined");
  });

  it("leaves every other tool's line exactly as it was", () => {
    expect(staffActionSummary("auto_plan", args, { child: "Noah", van: "Van 3" })).toBe(
      actionSummaries.autoPlan.replace("{leg}", "afternoon"),
    );
    expect(staffActionSummary("restart_demo_day", {}, { child: "Noah", van: "Van 3" })).toBe(actionSummaries.restart);
  });
});

describe("Don't says what it is declining", () => {
  it("is the card's own verb, never a bare word", () => {
    expect(staffActionDecline("move_child")).toBe("Don't move");
    expect(staffActionDecline("auto_plan")).toBe("Don't re-plan");
    expect(staffActionDecline("save_plan")).toBe("Don't save");
    expect(staffActionDecline("restart_demo_day")).toBe("Don't restart");
  });

  it("still says what it refuses for a tool it does not know", () => {
    expect(staffActionDecline("something_new")).toBe(confirmCopy.dont.generic);
    expect(staffActionDecline("")).toBe(confirmCopy.dont.generic);
  });

  /** The complaint itself: no label on this button is the word "Don't" and nothing else. */
  it("leaves no bare Don't anywhere in the copy it draws from", () => {
    for (const [tool, label] of Object.entries(confirmCopy.dont)) {
      expect(label, tool).toMatch(/^Don't \S/);
      expect(label, tool).not.toBe("Don't");
    }
    expect(confirmCopy).not.toHaveProperty("dontDo");
  });
});
