import { describe, expect, it } from "vitest";
import { canOpenPage, pageRow, rolesWhoCanOpen, ROLE_LADDER } from "@/auth/access";
import { stepItems, stepsFor } from "./step-strip";

describe("Today's step strip", () => {
  it("lists the day's three steps in order, each pointing at a real page", () => {
    expect(stepItems.map((s) => s.href)).toEqual(["/ramp-ipad", "/plan-routes", "/live-map"]);
    for (const item of stepItems) expect(pageRow(item.href)).toBeDefined();
  });

  it.each(ROLE_LADDER)("%s is only ever linked to a screen its role can open", (role) => {
    for (const step of stepsFor(role)) {
      const allowed = rolesWhoCanOpen(step.href).includes(role);
      expect(canOpenPage({ kind: "STAFF", role }, step.href)).toBe(allowed);
      // A link is shown exactly where the access table opens the page; never a dead link.
      expect(step.linked).toBe(allowed);
    }
  });

  it("gives the front desk links to Ramp iPad and Live map only", () => {
    const linked = stepsFor("FRONT_DESK").filter((s) => s.linked).map((s) => s.href);
    expect(linked).toEqual(["/ramp-ipad", "/live-map"]);
  });

  it("links nothing for a caller with no role", () => {
    expect(stepsFor(null).some((s) => s.linked)).toBe(false);
  });
});
