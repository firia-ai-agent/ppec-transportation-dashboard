import { describe, expect, it } from "vitest";
import { pageOutcome } from "@/auth/access";
import { ARRIVAL_PARAM } from "@/domain/plan/arrival";
import { rampReplan } from "@/ui/copy";
import { onwardLinks } from "./onward";

/**
 * Which onward links a role is offered, and the rule that it is the access table that decides.
 *
 * Vera's prod walk (2026-10-17) opened /ramp-ipad as the front desk and found both links under
 * the re-plan panel. The front desk's row opens neither screen, so both answered 403 — a tap
 * that ends on "This isn't part of your role" after a ramp check, which leaves the person
 * holding the iPad with no way of knowing whether the check survived.
 *
 * The assertion that matters is the pair below: what the front desk is offered, and what the
 * director is. The third one is the one that keeps it true — the answer is read off the table
 * rather than from a list of roles written beside the links, so adding a role to Plan routes
 * cannot leave this behind.
 */
const FINDING = "V1.1WC%2F3A.3-4...";

describe("the two screens a ramp check can be carried to", () => {
  it("offers the front desk neither, because their row opens neither", () => {
    expect(onwardLinks("FRONT_DESK", FINDING)).toEqual([]);
    for (const page of ["/plan-routes", "/today"]) {
      expect(pageOutcome({ kind: "STAFF", role: "FRONT_DESK" }, page), page).toBe("NO_ACCESS");
    }
  });

  it("offers a director both, with the finding on each address", () => {
    const links = onwardLinks("DIRECTOR", FINDING);
    expect(links.map((link) => link.label)).toEqual([rampReplan.openPlan, rampReplan.openBoard]);
    expect(links[0].href).toBe(`/plan-routes?${ARRIVAL_PARAM}=${encodeURIComponent(FINDING)}`);
    expect(links[1].href).toBe(`/today?${ARRIVAL_PARAM}=${encodeURIComponent(FINDING)}`);
  });

  it("offers a coordinator both as well: they are who the panel says decides", () => {
    expect(onwardLinks("COORDINATOR", FINDING)).toHaveLength(2);
  });

  it("offers a session with no membership nothing at all", () => {
    expect(onwardLinks(null, FINDING)).toEqual([]);
  });

  /**
   * One table, not two. Every link offered is a page that role's row really opens, and every
   * page the row opens is offered — so the panel cannot drift from the guard in either
   * direction, and a hidden link is still never the thing that denies anybody (hiding ≠
   * denying: /plan-routes and /today check the server themselves).
   */
  it("agrees with the access table for every role, both ways round", () => {
    for (const role of ["DIRECTOR", "COORDINATOR", "FRONT_DESK"] as const) {
      const offered = onwardLinks(role, FINDING).map((link) => link.href.split("?")[0]);
      for (const page of ["/plan-routes", "/today"]) {
        const allowed = pageOutcome({ kind: "STAFF", role }, page) === "ALLOW";
        expect(offered.includes(page), `${role} ${page}`).toBe(allowed);
      }
    }
  });
});
